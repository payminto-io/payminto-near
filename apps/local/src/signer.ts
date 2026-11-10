/**
 * The local signer: a development tool that stands in for a browser wallet, because no wallet extension can connect
 * to a NEAR node on 127.0.0.1.
 *
 * DEVELOPMENT ONLY. It holds the full-access keys of the local test accounts and signs whatever a caller with the
 * run's token asks for. That is acceptable for exactly one reason: those keys exist only on a throwaway local chain.
 * So the service is built to be useless anywhere else:
 *   - it binds to 127.0.0.1 and answers only requests addressed to a loopback host;
 *   - every request needs the per-run random token, and a browser request needs the dashboard's origin;
 *   - every signing request must name the network `near:sandbox`, and the service refuses to start unless the RPC it
 *     signs against is on loopback and reports the sandbox chain id;
 *   - it signs function calls only: no key changes, no deploys, no account deletion, no plain transfers;
 *   - one log line per signature with the account, the receiver and the methods, and never any key material.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { isAccountId, type AccountId, type WalletTx } from "@payminto/protocol";
import { NETWORK, SANDBOX_CHAIN_ID } from "./config.ts";

/** A NEAR FinalExecutionOutcome as the RPC returns it: what a wallet hands back to a page. */
export type Outcome = Record<string, unknown>;

export type SignedMessage = { accountId: AccountId; publicKey: string; signature: string };
export type MessageInput = { message: string; recipient: string; nonce: Uint8Array };
export type SignedDelegate = { accountId: AccountId; publicKey: string; receiverId: AccountId; signedDelegate: string; maxBlockHeight: string; nonce: string };

export type SignerAccount = { accountId: AccountId; role: string; does: string; publicKey: string };
export type Balances = { near: string; usdc: string };

/** Everything that touches a key or the chain. The HTTP layer below never sees a secret. */
export interface SignerBackend {
  /** The RPC this backend signs against. */
  readonly rpcUrl: string;
  chainId(): Promise<string>;
  accounts(): SignerAccount[];
  balances(account: AccountId): Promise<Balances>;
  signAndSend(account: AccountId, tx: WalletTx): Promise<Outcome>;
  signMessage(account: AccountId, input: MessageInput): Promise<SignedMessage>;
  signDelegate(account: AccountId, tx: WalletTx, blockHeightOffset: number): Promise<SignedDelegate>;
}

export type SignerOptions = {
  backend: SignerBackend;
  /** The per-run random token. */
  token: string;
  /** Browser origins that may call, for example http://localhost:3210. */
  allowedOrigins: readonly string[];
  /** One line per signature and per refusal. Never receives key material. */
  log: (line: string) => void;
};

export class SignerRefusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 422;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 422, code: string, message: string) {
    super(message);
    this.name = "SignerRefusal";
    this.status = status;
    this.code = code;
  }
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && LOOPBACK_HOST.test(u.host);
  } catch {
    return false;
  }
}

/** Refuses to build a signer for anything but a sandbox on this machine. Called before the service listens. */
export async function assertSandboxOnly(backend: SignerBackend): Promise<void> {
  if (!isLoopbackUrl(backend.rpcUrl)) throw new Error(`The local signer only signs for a NEAR node on this machine; ${backend.rpcUrl} is not a loopback http address.`);
  const chain = await backend.chainId();
  if (chain !== SANDBOX_CHAIN_ID) throw new Error(`The local signer only signs for a near-sandbox node (chain id ${SANDBOX_CHAIN_ID}); the node at ${backend.rpcUrl} reports ${chain}.`);
}

const MAX_TRANSACTIONS = 10;
const UINT = /^\d{1,40}$/;

/** Checks one wallet transaction. Only function calls are signed. */
export function parseWalletTx(v: unknown): WalletTx {
  const bad = (why: string) => new SignerRefusal(400, "BAD_TRANSACTION", why);
  if (!v || typeof v !== "object") throw bad("a transaction must be an object");
  const t = v as { receiverId?: unknown; actions?: unknown };
  if (!isAccountId(t.receiverId)) throw bad("receiverId must be a NEAR account id");
  if (!Array.isArray(t.actions) || t.actions.length === 0 || t.actions.length > 10) throw bad("actions must hold 1 to 10 actions");
  const actions = t.actions.map((a: unknown) => {
    const x = a as { type?: unknown; params?: { methodName?: unknown; args?: unknown; gas?: unknown; deposit?: unknown } } | null;
    if (!x || x.type !== "FunctionCall") throw bad("the local signer signs function calls only");
    const p = x.params;
    if (!p || typeof p.methodName !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(p.methodName)) throw bad("methodName must be a contract method name");
    if (!p.args || typeof p.args !== "object" || Array.isArray(p.args)) throw bad("args must be a JSON object");
    if (typeof p.gas !== "string" || !UINT.test(p.gas)) throw bad("gas must be a decimal string");
    if (typeof p.deposit !== "string" || !UINT.test(p.deposit)) throw bad("deposit must be a decimal string of yoctoNEAR");
    return { type: "FunctionCall" as const, params: { methodName: p.methodName, args: p.args as Record<string, unknown>, gas: p.gas, deposit: p.deposit } };
  });
  return { receiverId: t.receiverId, actions };
}

const methodsOf = (tx: WalletTx) => tx.actions.map((a) => a.params.methodName).join(",");

function outcomeSummary(o: Outcome): { hash: string; ok: boolean } {
  const tx = o.transaction as { hash?: string } | undefined;
  const status = o.status;
  const failed = !!status && typeof status === "object" && "Failure" in (status as object);
  return { hash: tx?.hash ?? "unknown", ok: !failed };
}

/** The signer's HTTP API. Pure of keys: `backend` does the signing. */
export function createSignerApp(o: SignerOptions): Hono {
  const app = new Hono();
  const tokenBytes = Buffer.from(o.token);
  const known = () => new Map(o.backend.accounts().map((a) => [a.accountId, a]));

  const cors = (c: Context) => {
    const origin = c.req.header("origin");
    if (origin && o.allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Headers", "authorization, content-type");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Max-Age", "600");
    }
  };

  app.onError((err, c) => {
    cors(c);
    if (err instanceof SignerRefusal) {
      o.log(`refused ${c.req.method} ${c.req.path}: ${err.code} ${err.message}`);
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    o.log(`failed ${c.req.method} ${c.req.path}: ${message}`);
    return c.json({ error: { code: "SIGNER_FAILED", message } }, 500);
  });

  app.use("*", async (c, next) => {
    // A page on another site can make this browser send requests here; the Host and Origin checks stop it before the
    // token is even looked at (DNS rebinding points a foreign name at 127.0.0.1, and its Host header gives it away).
    if (!LOOPBACK_HOST.test(c.req.header("host") ?? "")) throw new SignerRefusal(403, "NOT_LOOPBACK", "the local signer answers only on 127.0.0.1");
    const origin = c.req.header("origin");
    if (origin !== undefined && !o.allowedOrigins.includes(origin)) throw new SignerRefusal(403, "ORIGIN_NOT_ALLOWED", "this origin may not use the local signer");
    cors(c);
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    return next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "payminto-local-signer", development_only: true, network: NETWORK }));

  app.use("/v1/*", async (c, next) => {
    const sent = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const given = Buffer.from(sent ?? "");
    if (given.length !== tokenBytes.length || !timingSafeEqual(given, tokenBytes)) throw new SignerRefusal(401, "BAD_TOKEN", "missing or wrong signer token for this run");
    return next();
  });

  const json = async (c: Context): Promise<Record<string, unknown>> => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") throw new SignerRefusal(400, "BAD_REQUEST", "the body must be a JSON object");
    // The caller says which network it believes it is on. Anything but the sandbox is refused, so a dashboard that
    // points at testnet or mainnet can never get a signature here, whatever else is misconfigured.
    if (b.network !== NETWORK) throw new SignerRefusal(403, "WRONG_NETWORK", `the local signer signs for ${NETWORK} only, not ${String(b.network)}`);
    return b;
  };
  const accountOf = (b: Record<string, unknown>): AccountId => {
    if (!isAccountId(b.accountId) || !known().has(b.accountId)) throw new SignerRefusal(404, "UNKNOWN_ACCOUNT", `${String(b.accountId)} is not one of the local test accounts`);
    return b.accountId;
  };

  app.get("/v1/accounts", async (c) => {
    const accounts = await Promise.all(o.backend.accounts().map(async (a) => ({ ...a, balances: await o.backend.balances(a.accountId) })));
    return c.json({ development_only: true, network: NETWORK, chain_id: SANDBOX_CHAIN_ID, rpc_url: o.backend.rpcUrl, accounts });
  });

  app.post("/v1/sign-and-send", async (c) => {
    const b = await json(c);
    const account = accountOf(b);
    if (!Array.isArray(b.transactions) || b.transactions.length === 0 || b.transactions.length > MAX_TRANSACTIONS) throw new SignerRefusal(400, "BAD_REQUEST", `transactions must hold 1 to ${MAX_TRANSACTIONS} transactions`);
    const txs = b.transactions.map(parseWalletTx);
    const outcomes: Outcome[] = [];
    // In order, and stopping at the first failure, as a wallet does: a later transaction usually depends on an earlier one.
    for (const tx of txs) {
      const outcome = await o.backend.signAndSend(account, tx);
      const s = outcomeSummary(outcome);
      o.log(`signed transaction account=${account} receiver=${tx.receiverId} methods=${methodsOf(tx)} tx=${s.hash} result=${s.ok ? "ok" : "failed"}`);
      outcomes.push(outcome);
      if (!s.ok) break;
    }
    return c.json({ outcomes });
  });

  app.post("/v1/sign-message", async (c) => {
    const b = await json(c);
    const account = accountOf(b);
    if (typeof b.message !== "string" || b.message.length === 0 || b.message.length > 4096) throw new SignerRefusal(400, "BAD_REQUEST", "message must be 1 to 4096 characters");
    if (typeof b.recipient !== "string" || b.recipient.length === 0 || b.recipient.length > 256) throw new SignerRefusal(400, "BAD_REQUEST", "recipient must be 1 to 256 characters");
    const nonce = typeof b.nonce === "string" ? Buffer.from(b.nonce, "base64") : Buffer.alloc(0);
    if (nonce.length !== 32) throw new SignerRefusal(400, "BAD_REQUEST", "nonce must be 32 bytes in base64");
    const signed = await o.backend.signMessage(account, { message: b.message, recipient: b.recipient, nonce: new Uint8Array(nonce) });
    o.log(`signed message account=${account} receiver=${b.recipient} methods=NEP-413 chars=${b.message.length}`);
    return c.json(signed);
  });

  app.post("/v1/sign-delegate", async (c) => {
    const b = await json(c);
    const account = accountOf(b);
    const tx = parseWalletTx(b.transaction);
    const offset = b.blockHeightOffset === undefined ? 200 : Number(b.blockHeightOffset);
    if (!Number.isInteger(offset) || offset < 1 || offset > 10_000) throw new SignerRefusal(400, "BAD_REQUEST", "blockHeightOffset must be a whole number from 1 to 10000");
    const signed = await o.backend.signDelegate(account, tx, offset);
    o.log(`signed delegate account=${account} receiver=${tx.receiverId} methods=${methodsOf(tx)} valid_until_block=${signed.maxBlockHeight}`);
    return c.json(signed);
  });

  app.all("*", () => {
    throw new SignerRefusal(404, "NOT_FOUND", "no such signer route");
  });
  return app;
}
