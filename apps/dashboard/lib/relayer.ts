/**
 * Client for the Payminto relayer, the service that wraps an owner's signed delegate action (NEP-366) in its own
 * transaction and pays the gas. Two routes: `GET /info` and `POST /relay`. Nothing here signs; the wallet does.
 *
 * The relayer is a convenience, not an authority: the page checks its `/info` against this server's hub before a
 * wallet is asked to sign, and reads the transaction from NEAR afterwards instead of trusting the relayer's word.
 */
import { z } from "zod";
import { isAccountId, type AccountId, type Network, type WalletTx } from "@payminto/protocol";
import { MOCK_MODE, RELAYER_URL } from "./config";

const accountSchema = z.string().refine(isAccountId, "not a NEAR account id");

export const relayerInfoSchema = z.object({
  relayer: accountSchema,
  hub: accountSchema,
  network: z.string().min(1),
  methods: z.array(z.string()),
  maxGasTgas: z.number().positive(),
});
export type RelayerInfo = z.infer<typeof relayerInfoSchema>;

export const relayReceiptSchema = z.object({
  txHash: z.string().min(1),
  sender: accountSchema,
  receiver: accountSchema,
  methods: z.array(z.string()),
});
export type RelayReceipt = z.infer<typeof relayReceiptSchema>;

const relayErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    /** Set when a transaction was signed: on CALL_FAILED, on NONCE_USED for a repeat, and on RPC_FAILED when one was sent. */
    txHash: z.string().min(1).optional(),
    /** On RPC_FAILED: true when a transaction was sent and may still land. */
    outcomeUnknown: z.boolean().optional(),
    /** On RATE_LIMITED: how long to wait. */
    retryAfterSec: z.number().nonnegative().optional(),
  }),
});

/** The relayer's own codes (apps/relayer/README.md, "HTTP API"), plus two for answers it never gave. */
export type RelayErrorCode =
  | "MALFORMED"
  | "NOT_SPONSORED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "NONCE_USED"
  | "PAYLOAD_TOO_LARGE"
  | "CALL_FAILED"
  | "RATE_LIMITED"
  | "RPC_FAILED"
  | "UNREACHABLE"
  | "BAD_RESPONSE";

const KNOWN: readonly RelayErrorCode[] = ["MALFORMED", "NOT_SPONSORED", "BAD_SIGNATURE", "EXPIRED", "NONCE_USED", "PAYLOAD_TOO_LARGE", "CALL_FAILED", "RATE_LIMITED", "RPC_FAILED"];

export type RelayErrorDetail = { txHash?: string; outcomeUnknown?: boolean; retryAfterSec?: number };

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly status: number | null;
  /** The transaction the relayer signed, when it signed one. */
  readonly txHash: string | null;
  /** True when a transaction was sent and nobody knows yet whether it landed. Never retry blindly on this. */
  readonly outcomeUnknown: boolean;
  readonly retryAfterSec: number | null;
  constructor(code: RelayErrorCode, message: string, status: number | null = null, options: { cause?: unknown } & RelayErrorDetail = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RelayError";
    this.code = code;
    this.status = status;
    this.txHash = options.txHash ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.retryAfterSec = options.retryAfterSec ?? null;
  }
}

/** "about 40 seconds", "about 5 minutes", "about 3 hours". */
function waitText(sec: number): string {
  if (sec < 90) return `about ${Math.max(1, Math.round(sec))} seconds`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} minutes`;
  return `about ${Math.round(sec / 3600)} hours`;
}

const OWN_GAS = "You can still do this from a wallet that holds NEAR for gas, with the button beside this one.";

/**
 * What happened and what to do next, for each way the relayer can refuse before a transaction exists. Every sentence
 * is safe to show as it is. CALL_FAILED, a repeated NONCE_USED and an unknown RPC_FAILED carry a transaction and are
 * handled by the flow itself, because their answer is on the hub, not in these words.
 */
export function relayErrorText(e: RelayError): string {
  switch (e.code) {
    case "NOT_SPONSORED":
      return `The relayer does not pay for this action. Nothing was sent. ${OWN_GAS}`;
    case "BAD_SIGNATURE":
      return `The relayer refused the signature: it does not verify, or your wallet signed with a key that is not on your account or may not make this call. Nothing was sent. Reconnect your wallet and sign again. ${OWN_GAS}`;
    case "EXPIRED":
      return "The signature expired before the relayer could send it. Nothing was sent. Sign again and it goes out at once.";
    case "NONCE_USED":
      return "Your wallet's key was used for another transaction in the meantime, so this signature is no longer valid. Nothing was sent. Sign again.";
    case "MALFORMED":
    case "PAYLOAD_TOO_LARGE":
      return `The relayer could not read the signed action. Nothing was sent. Sign again, and if it repeats: ${OWN_GAS}`;
    case "RATE_LIMITED":
      return `The relayer is not taking this request now: it limits requests, and stops for the day once its gas budget is spent. Nothing was sent.${e.retryAfterSec !== null ? ` It asks you to wait ${waitText(e.retryAfterSec)}.` : ""} ${OWN_GAS}`;
    case "RPC_FAILED":
      return "The relayer could not reach NEAR, and it sent nothing. Try again in a moment.";
    case "CALL_FAILED":
      return "NEAR ran the relayer's transaction and the hub refused the call. Nothing changed on the hub.";
    case "UNREACHABLE":
      return `The relayer is not answering. Nothing was sent. Try again, or: ${OWN_GAS}`;
    case "BAD_RESPONSE":
      return "The relayer answered with something this page does not understand, so it is not known whether it sent anything. Check the Budget before trying again.";
  }
}

/** The subset of `fetch` the client needs, so tests and the demo pass their own. */
export type RelayerFetch = (url: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const INFO_TIMEOUT_MS = 8_000;
/** A relay answers once its transaction is final, and the relayer holds the connection for up to 60 seconds. */
const RELAY_TIMEOUT_MS = 70_000;

export class RelayerClient {
  readonly url: string;
  /** True for the in-browser demo relayer of mock mode, which reaches no network. */
  readonly demo: boolean;
  readonly #fetch: RelayerFetch;

  constructor(url: string, o: { fetch?: RelayerFetch; demo?: boolean } = {}) {
    this.url = url.replace(/\/+$/, "");
    this.demo = o.demo ?? false;
    this.#fetch = o.fetch ?? ((u, init) => globalThis.fetch(u, init));
  }

  /** The address without its scheme, for a line of text. */
  get host(): string {
    return this.demo ? "the demo relayer in this browser" : this.url.replace(/^https?:\/\//, "");
  }

  async #request(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.#fetch(`${this.url}${path}`, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (cause) {
      // A relay that timed out may have been sent: only a request that never left is known to have done nothing.
      throw new RelayError("UNREACHABLE", ctrl.signal.aborted ? `No answer from the relayer within ${timeoutMs / 1000} seconds.` : "The relayer could not be reached.", null, { cause, outcomeUnknown: ctrl.signal.aborted && method === "POST" });
    } finally {
      clearTimeout(timer);
    }
  }

  #fail(status: number, json: unknown): RelayError {
    const parsed = relayErrorSchema.safeParse(json);
    if (parsed.success) {
      const code = (KNOWN as readonly string[]).includes(parsed.data.error.code) ? (parsed.data.error.code as RelayErrorCode) : "BAD_RESPONSE";
      const { txHash, outcomeUnknown, retryAfterSec } = parsed.data.error;
      return new RelayError(code, parsed.data.error.message ?? parsed.data.error.code, status, { txHash, outcomeUnknown, retryAfterSec });
    }
    return new RelayError(status >= 500 ? "UNREACHABLE" : "BAD_RESPONSE", `The relayer answered HTTP ${status}.`, status);
  }

  /** `GET /info`: who the relayer is, the one hub it sponsors, and the methods it pays for. */
  async info(): Promise<RelayerInfo> {
    const { status, json } = await this.#request("GET", "/info", undefined, INFO_TIMEOUT_MS);
    if (status !== 200) throw this.#fail(status, json);
    const parsed = relayerInfoSchema.safeParse(json);
    if (!parsed.success) throw new RelayError("BAD_RESPONSE", "The relayer's /info is not in the expected shape.", status);
    return parsed.data;
  }

  /**
   * `POST /relay` with a base64 Borsh SignedDelegateAction. Resolves once the relayer's transaction is final and the
   * hub ran the call, which normally takes a few seconds and may take up to a minute.
   */
  async relay(signedDelegate: string): Promise<RelayReceipt> {
    const { status, json } = await this.#request("POST", "/relay", { signedDelegate }, RELAY_TIMEOUT_MS);
    if (status !== 200) throw this.#fail(status, json);
    const parsed = relayReceiptSchema.safeParse(json);
    if (!parsed.success) throw new RelayError("BAD_RESPONSE", "The relayer's answer is not in the expected shape.", status);
    return parsed.data;
  }
}

let override: RelayerClient | null | undefined;

/** Tests and mock mode install their own relayer here; `undefined` restores the configured one. */
export function setRelayer(client: RelayerClient | null | undefined): void {
  override = client;
}

let configured: RelayerClient | null | undefined;

/** The relayer this dashboard was built with, or null when the gasless path is off. */
export function relayer(): RelayerClient | null {
  if (override !== undefined) return override;
  // Mock mode never talks to a real relayer; its own is installed with the demo wallet.
  if (MOCK_MODE) return null;
  configured ??= RELAYER_URL ? new RelayerClient(RELAYER_URL) : null;
  return configured;
}

const TGAS = 1_000_000_000_000n;

/** "near:testnet" and "testnet" name the same network. */
const bareNetwork = (n: string): string => n.replace(/^near:/, "");

/**
 * Why this relayer cannot carry this transaction for this server, or null when it can. Pure, and run before a wallet
 * is asked to sign anything: a relayer for another hub, another network or another method is refused here, and so is
 * anything that attaches a deposit.
 */
export function relayRefusal(info: RelayerInfo, node: { hub: AccountId; network: Network }, tx: WalletTx): string | null {
  if (info.hub !== node.hub) return `The relayer sponsors the hub ${info.hub}, not this server's hub ${node.hub}. Nothing can be sent through it from here.`;
  if (bareNetwork(info.network) !== bareNetwork(node.network)) return `The relayer is on ${bareNetwork(info.network)} and this server is on ${bareNetwork(node.network)}.`;
  if (tx.receiverId !== node.hub) return "Only calls to this server's hub can be sent without gas.";
  if (tx.actions.length !== 1) return "Only a single call can be sent without gas.";
  for (const a of tx.actions) {
    if (a.params.deposit !== "0") return "This action attaches a deposit, and the relayer only pays for calls that carry none.";
    if (!info.methods.includes(a.params.methodName)) return `The relayer does not pay for ${a.params.methodName}.`;
    if (BigInt(a.params.gas) > BigInt(Math.floor(info.maxGasTgas)) * TGAS) return `This call asks for more gas than the relayer pays for (${info.maxGasTgas} Tgas).`;
  }
  return null;
}
