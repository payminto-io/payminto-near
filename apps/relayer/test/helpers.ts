import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keypairFromSeed, publicKeyBytes, type PublicKey } from "@payminto/chain";
import { gasless } from "@payminto/near-addons";
import type { Hono } from "hono";
import { createRelayerApp } from "../src/app.ts";
import type { RelayerAppConfig } from "../src/config.ts";
import { FakeRelayChain } from "../src/fake.ts";
import type { GasLedgerStore } from "../src/gas-budget.ts";
import { createLogger } from "../src/logger.ts";

export const HUB = "hub.payminto.testnet";
export const RELAYER = "relayer.payminto.testnet";
export const OWNER = "alice.testnet";
export const BUDGET = "ab".repeat(32);
export const HEIGHT = 1_000n;
export const TGAS = 1_000_000_000_000n;

/** Test keys only: fixed seeds that exist nowhere but in this file. */
export const OWNER_SEED = new Uint8Array(32).fill(7);
export const OWNER_KEY = keypairFromSeed(OWNER_SEED);
export const OTHER_SEED = new Uint8Array(32).fill(8);
export const OTHER_KEY = keypairFromSeed(OTHER_SEED);

export const appConfig = (over: Partial<RelayerAppConfig> = {}): RelayerAppConfig => ({
  network: "near:testnet",
  relayer: RELAYER,
  hub: HUB,
  methods: [...gasless.DEFAULT_RELAY_METHODS],
  maxGasTgas: 300,
  maxTtlBlocks: 600,
  expiryMarginBlocks: 5,
  dailyGasBudgetTgas: 3_000,
  rateLimit: { ip: { perMin: 0, burst: 1 }, sender: { perMin: 0, burst: 1 } },
  maxPending: 16,
  maxBodyBytes: 16_384,
  trustProxyHops: 0,
  corsOrigins: ["http://localhost:3000"],
  lowBalanceYocto: 5n * 10n ** 23n,
  ...over,
});

type Delegate = gasless.DelegateAction;

/** A valid gasless revoke by the owner: nonce 5, valid for 120 blocks past the fake chain's height. */
export const revoke = (over: Partial<Delegate> = {}): Delegate => ({
  ...gasless.revokeBudgetDelegate({ owner: OWNER, hub: HUB, budgetId: BUDGET, publicKey: OWNER_KEY.publicKey, nonce: 5n, maxBlockHeight: HEIGHT + 120n }),
  ...over,
});

export const call = (methodName: string, over: Partial<gasless.DelegateFunctionCall> = {}): gasless.DelegateFunctionCall => ({
  type: "FunctionCall",
  methodName,
  args: new TextEncoder().encode("{}"),
  gas: 30n * TGAS,
  deposit: 0n,
  ...over,
});

/** The `/relay` body for a delegate signed with the add-on's signer. */
export const bodyOf = (d: Delegate, seed: Uint8Array = OWNER_SEED): { signedDelegate: string } => gasless.relayRequestBody(gasless.signDelegate(d, seed));

/** A body whose signature was made by `seed` even though the delegate names another key. */
export const bodySignedBy = (d: Delegate, seed: Uint8Array): { signedDelegate: string } =>
  gasless.relayRequestBody({ delegateAction: d, signature: ed25519.sign(gasless.delegateHash(d), seed) });

// ---- raw Borsh, for delegates the add-on's encoder refuses to build ----

const le = (v: bigint, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  let x = v;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
const u32 = (n: number): Uint8Array => le(BigInt(n), 4);
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const vec = (b: Uint8Array): Uint8Array => cat(u32(b.length), b);
const str = (s: string): Uint8Array => vec(new TextEncoder().encode(s));
const key = (pk: PublicKey): Uint8Array => cat(Uint8Array.of(0), publicKeyBytes(pk));

/** nearcore `Action` Borsh by enum index: every kind a NEP-366 delegate may carry. */
export const rawAction = {
  createAccount: (): Uint8Array => Uint8Array.of(0),
  deployContract: (code: Uint8Array): Uint8Array => cat(Uint8Array.of(1), vec(code)),
  functionCall: (method: string, args: string, gas: bigint, deposit: bigint): Uint8Array => cat(Uint8Array.of(2), str(method), str(args), le(gas, 8), le(deposit, 16)),
  transfer: (deposit: bigint): Uint8Array => cat(Uint8Array.of(3), le(deposit, 16)),
  stake: (amount: bigint, pk: PublicKey): Uint8Array => cat(Uint8Array.of(4), le(amount, 16), key(pk)),
  addFullAccessKey: (pk: PublicKey): Uint8Array => cat(Uint8Array.of(5), key(pk), le(0n, 8), Uint8Array.of(1)),
  deleteKey: (pk: PublicKey): Uint8Array => cat(Uint8Array.of(6), key(pk)),
  deleteAccount: (beneficiary: string): Uint8Array => cat(Uint8Array.of(7), str(beneficiary)),
};

/** A correctly signed `SignedDelegateAction` built byte by byte, so it can hold any action kind. Returns the `/relay` body. */
export function rawBody(o: { sender?: string; receiver?: string; actions: Uint8Array[]; nonce?: bigint; maxBlockHeight?: bigint; seed?: Uint8Array }): { signedDelegate: string } {
  const seed = o.seed ?? OWNER_SEED;
  const delegate = cat(
    str(o.sender ?? OWNER),
    str(o.receiver ?? HUB),
    u32(o.actions.length),
    ...o.actions,
    le(o.nonce ?? 5n, 8),
    le(o.maxBlockHeight ?? HEIGHT + 120n, 8),
    key(keypairFromSeed(seed).publicKey),
  );
  const signature = ed25519.sign(sha256(cat(u32(gasless.DELEGATE_ACTION_PREFIX), delegate)), seed);
  return { signedDelegate: Buffer.from(cat(delegate, Uint8Array.of(0), signature)).toString("base64") };
}

export const bytesOf = (body: { signedDelegate: string }): Uint8Array => new Uint8Array(Buffer.from(body.signedDelegate, "base64"));

// ---- the app under test ----

export type ErrorBody = { error: { code: string; message: string; outcomeUnknown?: boolean; txHash?: string; retryAfterSec?: number } };

export type Harness = {
  app: Hono;
  chain: FakeRelayChain;
  /** Every structured log line the app wrote. */
  logs: string[];
  /** The wall clock the app sees, in milliseconds. Tests move it. */
  clock: { ms: number };
  post(body: unknown, opts?: { ip?: string; raw?: string }): Promise<Response>;
};

/** The relayer app over a fake chain where the owner's key is on the owner's account with nonce 4. */
export function harness(over: Partial<RelayerAppConfig> = {}, deps: { gasLedger?: GasLedgerStore; chain?: FakeRelayChain } = {}): Harness {
  const chain = deps.chain ?? new FakeRelayChain().addKey(OWNER, OWNER_KEY.publicKey, 4n);
  chain.height = HEIGHT;
  const logs: string[] = [];
  const clock = { ms: Date.UTC(2026, 10, 10, 12, 0, 0) };
  const app = createRelayerApp(appConfig(over), {
    chain,
    logger: createLogger({ level: "debug", sink: (line) => logs.push(line) }),
    now: () => clock.ms,
    ...(deps.gasLedger ? { gasLedger: deps.gasLedger } : {}),
  });
  const post: Harness["post"] = async (body, opts = {}) =>
    app.request("/relay", {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}) },
      body: opts.raw ?? JSON.stringify(body),
    });
  return { app, chain, logs, clock, post };
}

export const errorOf = async (res: Response): Promise<ErrorBody["error"]> => ((await res.json()) as ErrorBody).error;
