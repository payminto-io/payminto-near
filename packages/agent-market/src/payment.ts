/**
 * The paying step for a market quote, as the market's caller playbook defines it: one NEP-366 signed delegate action,
 * an `ft_transfer` on the quoted asset to the market's treasury, carried in the `X-PAYMENT` header. A relayer on the
 * market's side pays the gas, and the market submits the transfer only when the agent delivers.
 *
 * This module holds no key. It builds the unsigned delegate, hands the 32 bytes to sign to a callback the caller
 * provides, checks the signature that comes back, and builds the header. Sending the paid request is a separate
 * function that must be called on purpose. The payment goes to the market, through the market's own process: Payminto
 * does not settle, hold or route it.
 *
 * Encoding, from nearcore `core/primitives/src/action/delegate.rs`:
 *
 *   DelegateAction { sender_id: String, receiver_id: String, actions: Vec<NonDelegateAction>, nonce: u64,
 *                    max_block_height: u64, public_key: PublicKey }
 *   SignedDelegateAction { delegate_action: DelegateAction, signature: Signature }
 *
 * A function call action is the enum index 2, then { method_name: String, args: Vec<u8>, gas: u64, deposit: u128 }.
 * A public key and a signature are a key-type byte (ED25519 = 0), then 32 or 64 bytes. The signer signs sha256 of the
 * NEP-461 message: the u32 tag 2^30 + 366, then the DelegateAction Borsh.
 */
import { isAccountId, isPublicKey, publicKeyBytes, sha256Hex, toHex, verifyDigest, type AccountId, type PublicKey } from "@payminto/protocol";
import type { MarketClient } from "./client.ts";
import { FT_TRANSFER_DEPOSIT, FT_TRANSFER_GAS, MAX_LIST_RESPONSE_BYTES, PAID_CALL_TIMEOUT_MS } from "./constants.ts";
import { MarketError, Secret } from "./errors.ts";
import { parseJson, parseWith } from "./http.ts";
import type { ExactOption, Quote, QuoteDecision } from "./quote.ts";
import { rpcErrorSchema, taskSchema, type Task } from "./schemas.ts";
import { z } from "zod";

export const HEADER_PAYMENT = "X-PAYMENT";
/** NEP-461: on-chain signable messages are tagged 2^30 + the NEP number. */
export const DELEGATE_ACTION_PREFIX = 2 ** 30 + 366;
const ACTION_FUNCTION_CALL = 2;
const KEY_ED25519 = 0;

export type FunctionCall = { type: "FunctionCall"; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };

export type DelegateAction = {
  /** The payer: the account whose key signs. */
  senderId: AccountId;
  /** The token contract the transfer is called on. */
  receiverId: AccountId;
  actions: FunctionCall[];
  /** One more than the current nonce of `publicKey` on `senderId`. */
  nonce: bigint;
  /** The delegate is valid only while the chain is below this height. */
  maxBlockHeight: bigint;
  publicKey: PublicKey;
};

export type SignedDelegate = { delegateAction: DelegateAction; signature: Uint8Array };

// ------------------------------------------------------------------------------------------------- Borsh

function le(value: bigint, bytes: number, what: string): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new MarketError("INVALID_ARGUMENT", `${what} does not fit in ${bytes * 8} bits`);
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const vec = (b: Uint8Array): Uint8Array[] => [le(BigInt(b.length), 4, "length"), b];
const str = (s: string): Uint8Array[] => vec(new TextEncoder().encode(s));

function delegateParts(d: DelegateAction): Uint8Array[] {
  if (!isAccountId(d.senderId) || !isAccountId(d.receiverId)) throw new MarketError("INVALID_ARGUMENT", "the delegate's sender and receiver must be NEAR account ids");
  const parts = [...str(d.senderId), ...str(d.receiverId), le(BigInt(d.actions.length), 4, "action count")];
  for (const a of d.actions) parts.push(Uint8Array.of(ACTION_FUNCTION_CALL), ...str(a.methodName), ...vec(a.args), le(a.gas, 8, "gas"), le(a.deposit, 16, "deposit"));
  parts.push(le(d.nonce, 8, "nonce"), le(d.maxBlockHeight, 8, "max block height"), Uint8Array.of(KEY_ED25519), publicKeyBytes(d.publicKey));
  return parts;
}

/** Borsh of the DelegateAction alone. */
export const encodeDelegateAction = (d: DelegateAction): Uint8Array => concat(delegateParts(d));

/** The NEP-461 signable message: the u32 tag 2^30 + 366, then the DelegateAction Borsh. */
export const delegateSigningPayload = (d: DelegateAction): Uint8Array => concat([le(BigInt(DELEGATE_ACTION_PREFIX), 4, "tag"), ...delegateParts(d)]);

/** The 32 bytes the payer's key signs, as lowercase hex. */
export const delegateHash = (d: DelegateAction): string => sha256Hex(delegateSigningPayload(d));

/** Borsh of SignedDelegateAction: what near-api-js calls `encodeSignedDelegate`, and what the market reads from the header. */
export function encodeSignedDelegate(s: SignedDelegate): Uint8Array {
  if (s.signature.length !== 64) throw new MarketError("SIGNATURE_INVALID", "an ed25519 signature is 64 bytes");
  return concat([...delegateParts(s.delegateAction), Uint8Array.of(KEY_ED25519), s.signature]);
}

/** Checks the signature against the delegate's own public key, as the chain does. Never throws. */
export function verifySignedDelegate(s: SignedDelegate): boolean {
  try {
    return s.signature.length === 64 && verifyDigest(s.delegateAction.publicKey, delegateHash(s.delegateAction), toHex(s.signature));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------- the payment

export type Payer = { accountId: AccountId; publicKey: PublicKey };

/** Where the payer's key stands on chain, read by the caller from an RPC `view_access_key` and the latest block. */
export type ChainState = {
  /** The current nonce of the payer's access key. The delegate uses the next one. */
  accessKeyNonce: bigint;
  /** The latest block height. The delegate stays valid for `maxTimeoutSeconds` blocks past it. */
  blockHeight: bigint;
};

const transferArgs = (o: ExactOption): Uint8Array => new TextEncoder().encode(JSON.stringify({ receiver_id: o.requirement.payTo, amount: o.requirement.amount }));

/**
 * The unsigned delegate for one quoted row: `ft_transfer` of `amount` to `payTo` on `asset`, 30 Tgas, a deposit of 1
 * yoctoNEAR, valid for `maxTimeoutSeconds` blocks (one block is about one second). Pure.
 */
export function exactPaymentDelegate(option: ExactOption, payer: Payer, chain: ChainState): DelegateAction {
  const r = option.requirement;
  if (!r.network.startsWith("near:")) throw new MarketError("INVALID_ARGUMENT", `a delegate transfer pays on NEAR; this row is on ${r.network}`);
  if (!isAccountId(r.asset) || !isAccountId(r.payTo)) throw new MarketError("INVALID_ARGUMENT", "the quoted asset and payee must be NEAR account ids");
  if (!isAccountId(payer.accountId) || !isPublicKey(payer.publicKey)) throw new MarketError("INVALID_ARGUMENT", "the payer needs a NEAR account id and an ed25519 public key");
  if (payer.accountId === r.payTo) throw new MarketError("INVALID_ARGUMENT", "the payer is the payee");
  if (chain.accessKeyNonce < 0n || chain.blockHeight <= 0n) throw new MarketError("INVALID_ARGUMENT", "the access key nonce and the block height must be read from the chain");
  return {
    senderId: payer.accountId,
    receiverId: r.asset,
    actions: [{ type: "FunctionCall", methodName: "ft_transfer", args: transferArgs(option), gas: FT_TRANSFER_GAS, deposit: FT_TRANSFER_DEPOSIT }],
    nonce: chain.accessKeyNonce + 1n,
    maxBlockHeight: chain.blockHeight + BigInt(r.maxTimeoutSeconds),
    publicKey: payer.publicKey,
  };
}

/** True when the delegate is exactly the transfer the row asks for: nothing more, nothing else, nobody else. */
export function delegatePaysOption(d: DelegateAction, option: ExactOption): boolean {
  const a = d.actions[0];
  return (
    d.actions.length === 1 &&
    a !== undefined &&
    d.receiverId === option.requirement.asset &&
    a.methodName === "ft_transfer" &&
    toHex(a.args) === toHex(transferArgs(option)) &&
    a.gas === FT_TRANSFER_GAS &&
    a.deposit === FT_TRANSFER_DEPOSIT
  );
}

/**
 * The `X-PAYMENT` header value: base64 of `{ x402Version: 2, accepted, payload: { signedDelegateAction } }`, where
 * `accepted` is the row exactly as the market sent it and `signedDelegateAction` is base64 of the Borsh
 * SignedDelegateAction. Refuses a delegate that is not the row's own transfer, and a signature that does not verify.
 */
export function xPaymentHeader(option: ExactOption, signed: SignedDelegate): string {
  if (!delegatePaysOption(signed.delegateAction, option)) throw new MarketError("INVALID_ARGUMENT", "the signed delegate is not the transfer this quote asks for");
  if (!verifySignedDelegate(signed)) throw new MarketError("SIGNATURE_INVALID", "the signature does not verify against the payer's public key");
  const payload = { signedDelegateAction: Buffer.from(encodeSignedDelegate(signed)).toString("base64") };
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: option.accepted, payload }), "utf8").toString("base64");
}

/**
 * Signs nothing itself: it is given the 32-byte hash (and the delegate, to show the person what they approve) and
 * returns the 64-byte ed25519 signature made with the payer's key, wherever that key lives.
 */
export type DelegateSigner = (input: { hash: Uint8Array; delegate: DelegateAction }) => Promise<Uint8Array> | Uint8Array;

export type ExactPayment = {
  handle: string;
  option: ExactOption;
  signedDelegate: SignedDelegate;
  /** The `X-PAYMENT` value. It is a cheque for the quoted amount, so it is wrapped and never printed. */
  header: Secret;
};

export type BuildExactPaymentInput = {
  /** An `allow` from `checkQuote`. A refusal cannot be paid, and one decision pays once. */
  decision: QuoteDecision;
  payer: Payer;
  chain: ChainState;
  sign: DelegateSigner;
};

const paidDecisions = new WeakSet<object>();

/**
 * Builds the payment for an allowed quote: the unsigned delegate, one call to `sign`, a check of the signature, and
 * the header. It sends nothing. It refuses a decision that is not `allow`, and a decision that already produced a
 * payment, so one policy check cannot back two cheques.
 */
export async function buildExactPayment(input: BuildExactPaymentInput): Promise<ExactPayment> {
  const { decision } = input;
  if (decision.decision !== "allow") throw new MarketError("INVALID_ARGUMENT", `this quote was refused by rule ${decision.refusal.rule}; a refused quote is never paid`);
  if (paidDecisions.has(decision)) throw new MarketError("INVALID_ARGUMENT", "this decision already produced a payment; ask for a new quote and check it again");
  const delegate = exactPaymentDelegate(decision.option, input.payer, input.chain);
  const hash = Uint8Array.from(Buffer.from(delegateHash(delegate), "hex"));
  const signature = await input.sign({ hash, delegate });
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new MarketError("SIGNATURE_INVALID", "the signer must return a 64-byte ed25519 signature");
  const signedDelegate: SignedDelegate = { delegateAction: delegate, signature };
  const header = new Secret(xPaymentHeader(decision.option, signedDelegate));
  paidDecisions.add(decision);
  return { handle: decision.handle, option: decision.option, signedDelegate, header };
}

// ------------------------------------------------------------------------------------------------- sending

const sendResultSchema = z.object({ result: z.object({ task: taskSchema }) });
const getResultSchema = z.object({ result: taskSchema });

export type SendPaidInput = {
  client: MarketClient;
  /** The quote that was checked. Its request is repeated byte for byte, as the market requires. */
  quote: Quote;
  payment: ExactPayment;
  /** Must be the literal `true`: this spends real USDC on NEAR mainnet once the agent delivers. */
  confirmMainnetPayment: true;
  signal?: AbortSignal;
};

function rpcFailure(json: unknown, what: string): MarketError | null {
  const rpc = rpcErrorSchema.safeParse(json);
  if (!rpc.success) return null;
  const { code, message } = rpc.data.error;
  return new MarketError(code === -32603 || code === -32004 ? "AGENT_UNAVAILABLE" : "RPC_ERROR", `${what} was refused with JSON-RPC ${code}: ${message.replace(/[^\x20-\x7e]+/g, " ").slice(0, 200)}`, { rpcCode: code });
}

/**
 * Sends the quoted request again with the `X-PAYMENT` header. This is the only function in the package that can lead
 * to money moving, and it moves through the market: the market verifies the header, holds it while the agent works,
 * and submits the transfer to its own treasury when the agent delivers. Nothing is retried here.
 *
 * On FACILITATOR_UNAVAILABLE or TIMEOUT, call it again with the same payment: a header settles at most once.
 * Keep `task.id` from the answer; it is the only credential for reading the result with `getTask`.
 */
export async function sendPaidMessage(input: SendPaidInput): Promise<Task> {
  if (input.confirmMainnetPayment !== true) throw new MarketError("INVALID_ARGUMENT", "confirmMainnetPayment must be true to send a paid request");
  const { client, quote, payment } = input;
  if (payment.handle !== quote.handle || quote.endpoint !== client.a2aEndpoint(quote.handle) || !quote.options.includes(payment.option)) {
    throw new MarketError("INVALID_ARGUMENT", "the payment was not built for this quote");
  }
  const what = `the paid call to ${quote.handle}`;
  const res = await client.http.send({
    url: quote.endpoint,
    method: "POST",
    headers: { [HEADER_PAYMENT]: payment.header.reveal() },
    json: quote.request,
    timeoutMs: PAID_CALL_TIMEOUT_MS,
    maxBytes: MAX_LIST_RESPONSE_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (res.status === 402) throw new MarketError("PAYMENT_REFUSED", `${what} was refused at the payment step`, { status: 402 });
  if (res.status === 502) throw new MarketError("FACILITATOR_UNAVAILABLE", `${what} could not reach the payment facilitator`, { status: 502 });
  if (res.status === 429) throw new MarketError("RATE_LIMITED", `${what} was rate limited`, { status: 429, retryAfterSeconds: 60 });
  if (res.status !== 200) throw new MarketError(res.status >= 500 ? "SERVER" : "HTTP", `${what} answered HTTP ${res.status}`, { status: res.status });
  const json = parseJson(res.text, what, 200);
  const failure = rpcFailure(json, what);
  if (failure) throw failure;
  return parseWith(sendResultSchema, json, what).result.task;
}

/** `GetTask`: reads a task by its id. Free, and needs no payment header. Poll every 10 seconds while it is working. */
export async function getTask(client: MarketClient, handle: string, taskId: string, signal?: AbortSignal): Promise<Task> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)) throw new MarketError("INVALID_ARGUMENT", "not a task id");
  const what = `the task read on ${handle}`;
  const res = await client.http.send({
    url: client.a2aEndpoint(handle),
    method: "POST",
    json: { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: taskId, historyLength: 0 } },
    timeoutMs: client.timeoutMs,
    maxBytes: MAX_LIST_RESPONSE_BYTES,
    ...(signal ? { signal } : {}),
  });
  if (res.status !== 200) throw new MarketError(res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "SERVER" : "HTTP", `${what} answered HTTP ${res.status}`, { status: res.status });
  const json = parseJson(res.text, what, 200);
  const failure = rpcFailure(json, what);
  if (failure) throw failure;
  return parseWith(getResultSchema, json, what).result;
}
