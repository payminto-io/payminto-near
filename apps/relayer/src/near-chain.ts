import { hubErrorOf, isPublicKey, type AccountId, type PublicKey } from "@payminto/chain";
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  decodeSignedDelegateAction,
  encodeSignedDelegateAction,
  FunctionCallError,
  Near,
  NearError,
  parseKey,
  TransactionBuilder,
} from "near-kit";
import { SubmitError, type KeyPermission, type RelayChain, type SenderKey } from "./chain.ts";
import type { RelayerNetwork } from "./config.ts";

export type NearRelayChainOptions = {
  rpcUrl: string;
  network: RelayerNetwork;
  relayer: AccountId;
  /** The relayer account's full-access secret key, `ed25519:<base58>`. */
  relayerKey: string;
  /** Deadline for one read, in milliseconds. Default 15 000. */
  readTimeoutMs?: number;
  /** Deadline for signing, sending and reaching final execution, in milliseconds. Default 60 000. */
  sendTimeoutMs?: number;
};

const networkIdOf = (n: RelayerNetwork): string => (n === "near:sandbox" ? "localnet" : "testnet");

/** Protocol errors a delegate can fail with once its transaction runs, by what the client should hear. */
const NONCE_ERRORS = /DelegateActionInvalidNonce/;
const EXPIRY_ERRORS = /DelegateActionExpired/;
const KEY_ERRORS = /DelegateActionAccessKeyError|DelegateActionInvalidSignature|DelegateActionNonceTooLarge|DelegateActionSenderDoesNotMatchTxReceiver/;

/** near-kit error codes that mean the network refused a transaction for good, before it ran. */
const REFUSED_CODES = new Set([
  "INVALID_NONCE",
  "INVALID_TRANSACTION",
  "ACCESS_KEY_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "INSUFFICIENT_BALANCE",
  "SIGNATURE_ERROR",
  "INVALID_KEY",
  "INVALID_ACCOUNT",
  "INVALID_ACCOUNT_ID",
  "PARSE_ERROR",
]);

/**
 * `RelayChain` over NEAR JSON-RPC, built on near-kit 0.20.2.
 *
 * A submission is `near.transaction(relayer).signedDelegateAction(decoded)`: near-kit sets the receiver to the
 * delegate's sender and adds the one `Action::Delegate`. It is signed once with the relayer's key (`.sign()`), those
 * exact bytes are sent once (`near.rpc.sendTransaction(bytes, "FINAL")`), and the result is read from the execution
 * outcome. Nothing here retries a send, near-kit's own retries are switched off for the writer, and near-kit's
 * `.send()`, which re-signs with a new nonce after a nonce error, is never used.
 *
 * A meta transaction reports success at the top level even when the inner call fails: the delegate receipt did its job
 * by forwarding the call. So the outcome of the hub call is read from its own receipt, not from the transaction status.
 */
export class NearRelayChain implements RelayChain {
  readonly relayer: AccountId;
  /** The public half of the relayer's key, for the startup check. */
  readonly relayerPublicKey: PublicKey;
  readonly #reader: Near;
  readonly #writer: Near;
  readonly #readTimeoutMs: number;
  readonly #sendTimeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: NearRelayChainOptions) {
    this.relayer = o.relayer;
    this.relayerPublicKey = publicKeyOfSecret(o.relayerKey);
    this.#readTimeoutMs = o.readTimeoutMs ?? 15_000;
    this.#sendTimeoutMs = o.sendTimeoutMs ?? 60_000;
    const network = { rpcUrl: o.rpcUrl, networkId: networkIdOf(o.network) };
    // Reads are idempotent, so a short backoff on transient RPC errors is harmless.
    this.#reader = new Near({ network, retryConfig: { maxRetries: 2, initialDelayMs: 250 } });
    // Writes never retry inside near-kit, so one submission sends at most one transaction.
    this.#writer = new Near({ network, keyStore: { [o.relayer]: o.relayerKey }, retryConfig: { maxRetries: 0, initialDelayMs: 0 } });
  }

  async chainId(): Promise<string> {
    const status = await withTimeout(this.#reader.rpc.call<{ chain_id?: unknown }>("status", []), this.#readTimeoutMs, () => new Error(`status timed out after ${this.#readTimeoutMs} ms`));
    if (typeof status?.chain_id !== "string") throw new Error("the RPC status has no chain_id");
    return status.chain_id;
  }

  async blockHeight(): Promise<bigint> {
    // The newest block, not the final one: a delegate about to expire should be refused, not relayed too late.
    const block = await withTimeout(
      this.#reader.rpc.call<{ header?: { height?: unknown } }>("block", { finality: "optimistic" }),
      this.#readTimeoutMs,
      () => new Error(`block timed out after ${this.#readTimeoutMs} ms`),
    );
    const height = block?.header?.height;
    if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) throw new Error("the RPC block has no height");
    return BigInt(height);
  }

  async accessKey(account: AccountId, publicKey: PublicKey): Promise<SenderKey | null> {
    try {
      const key = await withTimeout(
        this.#reader.rpc.getAccessKey(account, publicKey, { finality: "optimistic" }),
        this.#readTimeoutMs,
        () => new Error(`view_access_key timed out after ${this.#readTimeoutMs} ms`),
      );
      return { nonce: BigInt(key.nonce), permission: permissionOf(key.permission) };
    } catch (err) {
      if (err instanceof AccessKeyDoesNotExistError || err instanceof AccountDoesNotExistError) return null;
      // near-kit 0.20.2 has no typed error for the UNKNOWN_ACCESS_KEY cause current nodes answer with; it surfaces as a
      // generic NearError that names the cause in brackets.
      if (err instanceof NearError && /\[UNKNOWN_ACCESS_KEY\]/.test(err.message)) return null;
      throw err;
    }
  }

  async balance(account: AccountId): Promise<bigint> {
    const view = await withTimeout(this.#reader.rpc.getAccount(account, { finality: "final" }), this.#readTimeoutMs, () => new Error(`view_account timed out after ${this.#readTimeoutMs} ms`));
    return BigInt(view.amount);
  }

  /** Submissions are serialized, so the relayer's nonces are taken in order and one failure never races another send. */
  submitDelegate(signedDelegate: Uint8Array): Promise<string> {
    const run = this.#queue.then(() => this.#submit(signedDelegate));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #submit(bytes: Uint8Array): Promise<string> {
    let decoded: ReturnType<typeof decodeSignedDelegateAction>;
    try {
      decoded = decodeSignedDelegateAction(bytes);
      // What the policy approved is these exact bytes. If near-kit would put anything else on chain, send nothing.
      const again = encodeSignedDelegateAction(decoded, "bytes");
      if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) throw new Error("near-kit re-encodes this delegate differently");
    } catch (err) {
      throw new SubmitError("not_sent", `the delegate could not be wrapped: ${err instanceof Error ? err.message : String(err)}`);
    }
    const delegate = decoded.signedDelegate.delegateAction;

    let txHash: string | undefined;
    let sent = false;
    const deadline = Date.now() + this.#sendTimeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    try {
      const signed = await withTimeout(this.#writer.transaction(this.relayer).signedDelegateAction(decoded).sign(), left(), () => new SubmitError("not_sent", "signing timed out: the RPC did not answer"));
      txHash = signed.getHash() ?? undefined;
      const txBytes = signed.serialize();
      sent = true;
      const outcome = await withTimeout(
        this.#writer.rpc.sendTransaction(txBytes, "FINAL"),
        left(),
        () => new SubmitError("unknown", `no final result within ${this.#sendTimeoutMs} ms`, txHash),
      );
      if (!txHash) throw new SubmitError("unknown", "the signed transaction has no hash");
      const failure = relayFailureOf(outcome, delegate.receiverId);
      if (failure !== null) throw classifyFailure(failure, txHash);
      return txHash;
    } catch (err) {
      if (err instanceof SubmitError) throw err;
      if (err instanceof NearError && err.code === "INVALID_NONCE") forgetNonce(this.relayer, this.relayerPublicKey);
      throw submitErrorOf(err, { sent, txHash });
    }
  }
}

type OutcomeWithId = { id?: unknown; outcome?: { executor_id?: unknown; status?: unknown; receipt_ids?: unknown } };
type FinalOutcome = { status?: unknown; transaction_outcome?: OutcomeWithId; receipts_outcome?: OutcomeWithId[] };

const failureIn = (status: unknown): string | null => {
  if (typeof status !== "object" || status === null || !("Failure" in status)) return null;
  try {
    return JSON.stringify((status as { Failure: unknown }).Failure);
  } catch {
    return "Failure";
  }
};

/**
 * Whether a relayed delegate did what the owner signed, read from the final execution outcome. Returns the failure as
 * JSON text, or null when the hub ran the call.
 *
 * The chain of receipts is: the relayer's transaction, then the delegate receipt on the sender's account, then the
 * function call on the receiver. The first two are judged here. Receipts the hub creates afterwards (a token transfer
 * inside `payout`, a callback) belong to the hub, which handles their failures itself, so they are not read as a
 * failure of the relayed call.
 */
export function relayFailureOf(outcome: unknown, receiver: string): string | null {
  const o = (outcome ?? {}) as FinalOutcome;
  const top = failureIn(o.status);
  if (top !== null) return top;
  const receipts = Array.isArray(o.receipts_outcome) ? o.receipts_outcome : [];
  const byId = new Map(receipts.map((r) => [r.id, r] as const));
  const first = o.transaction_outcome?.outcome?.receipt_ids;
  const delegateReceipt = Array.isArray(first) ? byId.get(first[0]) : undefined;
  if (!delegateReceipt) {
    // Not the shape this code expects. Fail closed: any failed receipt counts.
    for (const r of receipts) {
      const f = failureIn(r.outcome?.status);
      if (f !== null) return f;
    }
    return null;
  }
  const delegateFailure = failureIn(delegateReceipt.outcome?.status);
  if (delegateFailure !== null) return delegateFailure;
  const children = Array.isArray(delegateReceipt.outcome?.receipt_ids) ? delegateReceipt.outcome.receipt_ids : [];
  for (const id of children) {
    const child = byId.get(id);
    if (child?.outcome?.executor_id !== receiver) continue;
    const f = failureIn(child.outcome.status);
    if (f !== null) return f;
  }
  return null;
}

/** A failure of a transaction that ran, by what the client should hear. */
function classifyFailure(text: string, txHash: string | undefined): SubmitError {
  if (NONCE_ERRORS.test(text)) return new SubmitError("nonce_used", "DelegateActionInvalidNonce", txHash);
  if (EXPIRY_ERRORS.test(text)) return new SubmitError("expired", "DelegateActionExpired", txHash);
  const keyError = KEY_ERRORS.exec(text);
  if (keyError) return new SubmitError("key_error", keyError[0], txHash);
  const panic = /Smart contract panicked: ([^"\\]*)/.exec(text);
  if (panic) return new SubmitError("call_failed", hubErrorOf(panic[0]) ?? panic[0], txHash);
  return new SubmitError("call_failed", text.slice(0, 200), txHash);
}

/**
 * Everything signing and sending can throw, as what the relayer knows about the transaction afterwards.
 * `sent` is true once the bytes were handed to the RPC: from then on, anything that is not a definite refusal means the
 * transaction may still land.
 */
export function submitErrorOf(err: unknown, ctx: { sent: boolean; txHash?: string | undefined }): SubmitError {
  if (err instanceof SubmitError) return err;
  const message = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
  if (err instanceof FunctionCallError) {
    // The transaction ran and a contract panicked.
    const panic = err.panic ?? err.message;
    return new SubmitError("call_failed", hubErrorOf(panic) ?? panic.slice(0, 200), ctx.txHash);
  }
  if (err instanceof NearError) {
    if (!ctx.sent) return new SubmitError("not_sent", message);
    const text = `${message} ${detailText(err)}`;
    // An action error means the transaction was included and ran.
    if (/ActionError|DelegateAction/.test(text)) return classifyFailure(text, ctx.txHash);
    if (REFUSED_CODES.has(err.code)) return new SubmitError("rejected", message, ctx.txHash);
    return new SubmitError("unknown", message, ctx.txHash);
  }
  // Not a shape this code knows. Once sent, assume the worst: it may still land.
  return new SubmitError(ctx.sent ? "unknown" : "not_sent", message, ctx.txHash);
}

function detailText(err: NearError): string {
  try {
    return JSON.stringify(err.data ?? (err as { details?: unknown }).details ?? "");
  } catch {
    return "";
  }
}

/**
 * near-kit caches the next nonce per key for the whole process and offers no public reset. After a nonce rejection the
 * cache is stale (another process used the key), so drop it and let the next transaction read the chain again.
 */
function forgetNonce(signer: AccountId, publicKey: string): void {
  const manager = (TransactionBuilder as unknown as { nonceManager?: { invalidate?: (a: string, k: string) => void } }).nonceManager;
  manager?.invalidate?.(signer, publicKey);
}

/** The public key of an `ed25519:<base58>` secret key. The error never contains the key. */
export function publicKeyOfSecret(secret: string): PublicKey {
  let publicKey: string;
  try {
    publicKey = parseKey(secret).publicKey.toString();
  } catch {
    throw new Error("not a valid NEAR ed25519 secret key");
  }
  if (!isPublicKey(publicKey)) throw new Error("not an ed25519 key");
  return publicKey;
}

function permissionOf(p: unknown): KeyPermission {
  if (p === "FullAccess") return { kind: "full_access" };
  if (typeof p === "object" && p !== null) {
    const fc = (p as { FunctionCall?: { receiver_id?: unknown; method_names?: unknown } }).FunctionCall;
    if (fc && typeof fc.receiver_id === "string" && Array.isArray(fc.method_names) && fc.method_names.every((m) => typeof m === "string")) {
      return { kind: "function_call", receiverId: fc.receiver_id, methodNames: fc.method_names as string[] };
    }
    return { kind: "other", name: Object.keys(p)[0] ?? "unknown" };
  }
  return { kind: "other", name: "unknown" };
}

/** Rejects with `onTimeout()` after `ms`. The underlying request is not cancelled: near-kit offers no abort signal. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
