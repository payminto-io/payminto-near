import { hexToBytes } from "@noble/hashes/utils.js";
import { FunctionCallError, Near, NearError, TransactionBuilder } from "near-kit";
import type { WalletTx } from "./actions.ts";
import { claimArgs } from "./actions.ts";
import { assertAccountId, assertId32, isAccountId, isId32, isSig64, publicKeyToString } from "./bytes.ts";
import type { PublicKey } from "./types.ts";
import type { Chain } from "./chain.ts";
import { ChainError, MAX_CLAIMS, MAX_PAYOUT_ACCOUNTS, hubErrorOf } from "./constants.ts";
import type { AccountId, Batch, Budget, Id32, Network, Payment, ReceiptFields, SettleArgs, TxHash, TxState } from "./types.ts";

export type NearRpcChainOptions = {
  hub: AccountId;
  token: AccountId;
  network: Network;
  rpcUrl: string;
  operator: AccountId;
  /**
   * The operator's function-call key, `ed25519:<base58>`, limited to `settle_batch` and `payout`. Absent means a
   * read-only client (verifiers, MCP proofs): every view works and `settle` and `payout` reject with `NearRpcError`
   * of kind `read_only` before anything is signed.
   */
  operatorKey?: string;
  /** Deadline for one view or status call, in milliseconds. Default 15 000. */
  readTimeoutMs?: number;
  /** Deadline for signing, sending and reaching final finality, in milliseconds. Default 60 000. */
  writeTimeoutMs?: number;
};

/**
 * What went wrong below the hub's own rules. Hub refusals are `ChainError` instead.
 *
 * - `read_only`: the client has no operator key; nothing was signed.
 * - `rejected`: the network refused the transaction before execution (bad nonce, missing key, exhausted key gas, balance), or
 *   it failed for a reason that is not a hub code. It is final: the hub state did not change.
 * - `failed`: the transaction executed and failed with a panic that is not a hub code, for example out of gas.
 * - `timeout`: the deadline passed. When `outcomeUnknown` is true the transaction may still land.
 * - `unavailable`: the RPC could not be reached or answered with a server error.
 * - `invalid_response`: the RPC or the hub answered with something this client does not understand.
 *
 * When `outcomeUnknown` is true, never sign a new transaction for the same intent without first reading the chain:
 * `txState(txHash)`, or `batch(batchId, operator)` for a settlement. A second `settle` of the same batch id is still safe,
 * because the hub refuses it with `BATCH_EXISTS`.
 */
export type NearRpcErrorKind = "read_only" | "rejected" | "failed" | "timeout" | "unavailable" | "invalid_response";

export class NearRpcError extends Error {
  readonly kind: NearRpcErrorKind;
  readonly txHash: TxHash | undefined;
  /** True when a transaction was sent and its result is not known. */
  readonly outcomeUnknown: boolean;
  constructor(kind: NearRpcErrorKind, message: string, o: { txHash?: TxHash; outcomeUnknown?: boolean; cause?: unknown } = {}) {
    super(`${kind}: ${message}`, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "NearRpcError";
    this.kind = kind;
    this.txHash = o.txHash;
    this.outcomeUnknown = o.outcomeUnknown ?? false;
  }
}

/** Every read the client makes waits for a block that cannot be reverted. */
const FINAL = { finality: "final" } as const;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_WRITE_TIMEOUT_MS = 60_000;
const MAX_TGAS = 300;

const networkIdOf = (n: Network): string => n.slice("near:".length);

/** Gas for `settle_batch`, measured at about 0.9 Tgas per claim plus a base, with headroom for deep tries. */
export const settleGasTgas = (claims: number): number => Math.min(MAX_TGAS, 30 + 2 * claims);
/**
 * What the hub itself requires before it starts a payout, in Tgas: 26 per account (15 static for the transfer, 8 static
 * for the callback, 3 for creating the two receipts) plus 10. `PAYOUT_ACCOUNT_GAS` and `BASE_GAS` in the contract.
 */
export const payoutGasNeededTgas = (accounts: number): number => 10 + 26 * accounts;
/**
 * Gas for `payout`: what the hub requires, plus what the call burns before the hub counts (about 1.5 Tgas) and 2 Tgas
 * of headroom per account, capped at the 300 Tgas one transaction can carry. Ten accounts get 300 against a
 * requirement of 270, and the least that works on sandbox is 272.
 */
export const payoutGasTgas = (accounts: number): number => Math.min(MAX_TGAS, payoutGasNeededTgas(accounts) + 10 + 2 * accounts);

type RawBudget = {
  owner: string;
  settler: string;
  agent_pk: string;
  cap: string;
  spent: string;
  escrow: string;
  valid_until: string;
  revoked_at: string | null;
  payees: string[];
  policy_hash: string;
  storage_reserve_bytes?: string;
};
type RawBatch = { root: string; settler: string; gross: string; net: string; at: string };
type RawPayment = { id: string; merchant: string; amount: string; payer: string; at: string };

/**
 * The `Chain` seam over NEAR JSON-RPC, built on near-kit.
 *
 * Reads use final finality. Writes are signed once and sent once, then wait for final execution: this client never
 * re-signs or resends on its own, so an ambiguous failure surfaces as `NearRpcError` with `outcomeUnknown` and the tx
 * hash. Hub panics map onto `ChainError` by `HUB_ERRORS` code.
 */
export class NearRpcChain implements Chain {
  readonly hub: AccountId;
  readonly token: AccountId;
  readonly network: Network;
  readonly operator: AccountId;
  readonly rpcUrl: string;
  readonly readOnly: boolean;

  readonly #reader: Near;
  readonly #writer: Near | null;
  readonly #readTimeoutMs: number;
  readonly #writeTimeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: NearRpcChainOptions) {
    for (const [what, v] of [["hub", o.hub], ["token", o.token], ["operator", o.operator]] as const) assertAccountId(v, what);
    this.hub = o.hub;
    this.token = o.token;
    this.network = o.network;
    this.operator = o.operator;
    this.rpcUrl = o.rpcUrl;
    this.#readTimeoutMs = o.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.#writeTimeoutMs = o.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    const network = { rpcUrl: o.rpcUrl, networkId: networkIdOf(o.network) };
    // Reads are idempotent, so a short backoff on transient RPC errors is harmless.
    this.#reader = new Near({ network, retryConfig: { maxRetries: 2, initialDelayMs: 250 } });
    // Writes never retry inside near-kit, so one call of `settle` or `payout` sends at most one transaction.
    this.#writer = o.operatorKey
      ? new Near({ network, keyStore: { [o.operator]: o.operatorKey }, retryConfig: { maxRetries: 0, initialDelayMs: 0 } })
      : null;
    this.readOnly = this.#writer === null;
  }

  // ---- reads ----

  async budget(id: Id32): Promise<Budget | null> {
    assertId32(id, "budget id");
    const raw = await this.#view<RawBudget | null>(this.hub, "budget", { budget_id: id });
    if (raw === null || raw === undefined) return null;
    return parseBudget(id, raw);
  }

  async settledOf(budgetId: Id32, payee: AccountId): Promise<bigint> {
    assertId32(budgetId, "budget id");
    assertAccountId(payee, "payee");
    return this.#u128(await this.#view(this.hub, "settled_of", { budget_id: budgetId, payee }), "settled_of");
  }

  async creditOf(account: AccountId): Promise<bigint> {
    assertAccountId(account, "account");
    return this.#u128(await this.#view(this.hub, "credit_of", { account }), "credit_of");
  }

  async balanceOf(account: AccountId): Promise<bigint> {
    assertAccountId(account, "account");
    return this.#u128(await this.#view(this.token, "ft_balance_of", { account_id: account }), "ft_balance_of");
  }

  async batch(id: Id32, settler: AccountId): Promise<Batch | null> {
    assertId32(id, "batch id");
    assertAccountId(settler, "settler");
    const raw = await this.#view<RawBatch | null>(this.hub, "batch", { settler, batch_id: id });
    if (raw === null || raw === undefined) return null;
    if (!isId32(raw.root) || !isAccountId(raw.settler)) throw invalid("batch", raw);
    return { root: raw.root, settler: raw.settler, gross: this.#u128(raw.gross, "gross"), net: this.#u128(raw.net, "net"), at: this.#u128(raw.at, "at") };
  }

  async payments(ids: readonly Id32[]): Promise<Array<Payment | null>> {
    ids.forEach((id) => assertId32(id, "payment id"));
    if (ids.length === 0) return [];
    const rows = await this.#view<Array<RawPayment | null>>(this.hub, "payments", { ids: [...ids] });
    if (!Array.isArray(rows) || rows.length !== ids.length) throw invalid("payments", rows);
    return rows.map((p, i) => {
      if (p === null) return null;
      if (p.id !== ids[i] || !isAccountId(p.merchant) || !isAccountId(p.payer)) throw invalid("payment", p);
      return { id: p.id, merchant: p.merchant, amount: this.#u128(p.amount, "amount"), payer: p.payer, at: this.#u128(p.at, "at") };
    });
  }

  async isRegistered(account: AccountId): Promise<boolean> {
    assertAccountId(account, "account");
    const balance = await this.#view<unknown>(this.token, "storage_balance_of", { account_id: account });
    return balance !== null && balance !== undefined;
  }

  async verifyReceipt(batchId: Id32, settler: AccountId, fields: ReceiptFields, proof: readonly Id32[]): Promise<boolean> {
    assertId32(batchId, "batch id");
    assertAccountId(settler, "settler");
    proof.forEach((p) => assertId32(p, "proof node"));
    const result = await this.#view<boolean>(this.hub, "verify_receipt", { settler, batch_id: batchId, fields: receiptFieldsArgs(fields), proof: [...proof] });
    if (typeof result !== "boolean") throw invalid("verify_receipt", result);
    return result;
  }

  async receiptKeys(settler: AccountId): Promise<PublicKey[]> {
    assertAccountId(settler, "settler");
    const keys = await this.#view<unknown>(this.hub, "receipt_keys", { settler });
    if (!Array.isArray(keys) || !keys.every(isId32)) throw invalid("receipt_keys", keys);
    return keys.map((k) => publicKeyToString(hexToBytes(k)));
  }

  async storageOf(account: AccountId): Promise<bigint> {
    assertAccountId(account, "account");
    return this.#u128(await this.#view(this.hub, "storage_of", { account }), "storage_of");
  }

  /** The settler whose storage balance pays for payments accepted under checkout terms, or null. Not part of `Chain`. */
  async checkoutSettler(): Promise<AccountId | null> {
    const settler = await this.#view<unknown>(this.hub, "checkout_settler", {});
    if (settler === null || settler === undefined) return null;
    if (!isAccountId(settler)) throw invalid("checkout_settler", settler);
    return settler;
  }

  /** Whether `account` is on the hub's settler allowlist. Not part of `Chain`. */
  async isSettler(account: AccountId): Promise<boolean> {
    assertAccountId(account, "account");
    return (await this.#view<boolean>(this.hub, "is_settler", { account })) === true;
  }

  /** The hub's deployment parameters, and the admin `propose_admin` named, if any. Not part of `Chain`. */
  async config(): Promise<{ admin: AccountId; pendingAdmin: AccountId | null; token: AccountId; network: string }> {
    const c = await this.#view<{ admin: string; pending_admin?: string | null; token: string; network: string }>(this.hub, "config", {});
    if (!c || !isAccountId(c.admin) || !isAccountId(c.token) || typeof c.network !== "string") throw invalid("config", c);
    const pending = c.pending_admin ?? null;
    if (pending !== null && !isAccountId(pending)) throw invalid("config", c);
    return { admin: c.admin, pendingAdmin: pending, token: c.token, network: c.network };
  }

  /** The hub's liability totals, for the solvency check against `balanceOf(hub)`. Not part of `Chain`. */
  async totals(): Promise<{ escrow: bigint; credits: bigint; inFlight: bigint }> {
    const t = await this.#view<{ escrow: string; credits: string; in_flight: string }>(this.hub, "totals", {});
    if (!t) throw invalid("totals", t);
    return { escrow: this.#u128(t.escrow, "escrow"), credits: this.#u128(t.credits, "credits"), inFlight: this.#u128(t.in_flight, "in_flight") };
  }

  /**
   * Status of a transaction sent by `sender` (default: the operator), read without waiting.
   * `final` means the outcome is final and successful; a hub refusal is `failed` with the hub code as `error`.
   */
  async txState(hash: TxHash, sender: AccountId = this.operator): Promise<TxState> {
    assertAccountId(sender, "sender");
    let raw: { final_execution_status?: string; status?: unknown };
    try {
      raw = await withTimeout(
        this.#reader.rpc.call("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" }),
        this.#readTimeoutMs,
        () => new NearRpcError("timeout", `tx_status ${hash}`),
      );
    } catch (err) {
      if (err instanceof NearError && /UNKNOWN_TRANSACTION|doesn't exist|does not exist/i.test(err.message)) return { status: "unknown" };
      throw toRpcError(err, { sent: false });
    }
    const failure = failureOf(raw.status);
    if (failure !== null) return { status: "failed", error: hubErrorOf(failure) ?? failure };
    if (raw.final_execution_status === "FINAL") return { status: "final" };
    return { status: "pending" };
  }

  // ---- writes ----

  /**
   * Calls `settle_batch` as the operator and resolves once the outcome is final.
   * Safe to retry: a replayed batch id is refused with `ChainError("BATCH_EXISTS")`, and `batch(batchId, operator)`
   * shows the first result. An error with `outcomeUnknown` means: read that batch before doing anything else.
   */
  async settle(a: SettleArgs): Promise<TxHash> {
    assertId32(a.batchId, "batch id");
    assertId32(a.root, "root");
    if (a.claims.length > MAX_CLAIMS) throw new ChainError("TOO_MANY_CLAIMS", `${a.claims.length} > ${MAX_CLAIMS}`);
    const args = {
      batch_id: a.batchId,
      root: a.root,
      claims: a.claims.map(claimArgs),
      expected_net: a.expectedNet.map((e) => ({ account: e.account, debit: e.debit.toString(), credit: e.credit.toString() })),
    };
    return this.#call("settle_batch", args, settleGasTgas(a.claims.length));
  }

  /** Calls `payout` as the operator. Repeating it is harmless: a paid credit is zero, so nothing is sent twice. */
  async payout(accounts: readonly AccountId[]): Promise<TxHash> {
    accounts.forEach((acct) => assertAccountId(acct, "account"));
    if (accounts.length > MAX_PAYOUT_ACCOUNTS) throw new ChainError("TOO_MANY_ACCOUNTS", `${accounts.length} > ${MAX_PAYOUT_ACCOUNTS}`);
    return this.#call("payout", { accounts: [...accounts] }, payoutGasTgas(accounts.length));
  }

  // ---- internals ----

  /** Operator writes are serialized, so their nonces are taken in order and one failure never races another send. */
  #call(method: string, args: Record<string, unknown>, tgas: number): Promise<TxHash> {
    const writer = this.#writer;
    if (!writer) return Promise.reject(new NearRpcError("read_only", `${method} needs an operator key`));
    const run = this.#queue.then(() => sendOnce(writer, this.operator, { receiverId: this.hub, actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: (BigInt(tgas) * 10n ** 12n).toString(), deposit: "0" } }] }, this.#writeTimeoutMs));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #view<T>(contract: AccountId, method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return (await withTimeout(this.#reader.view<T>(contract, method, args, FINAL), this.#readTimeoutMs, () => new NearRpcError("timeout", `view ${contract}.${method}`))) as T;
    } catch (err) {
      throw toRpcError(err, { sent: false });
    }
  }

  #u128(v: unknown, what: string): bigint {
    if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw invalid(what, v);
    return BigInt(v);
  }
}

/**
 * Signs and sends a wallet transaction from `signer` with the keys configured on `near`, exactly once, and waits for
 * final execution. Used by the operator writes above, by the deploy script, and by tests that act as owners through
 * the pure action builders. Hub panics become `ChainError`; everything else becomes `NearRpcError`.
 */
export function sendWalletTx(near: Near, signer: AccountId, tx: WalletTx, timeoutMs = DEFAULT_WRITE_TIMEOUT_MS): Promise<TxHash> {
  return sendOnce(near, signer, tx, timeoutMs);
}

function sendOnce(near: Near, signer: AccountId, tx: WalletTx, timeoutMs: number): Promise<TxHash> {
  return sendBuiltOnce(
    near,
    signer,
    (builder) => {
      let b = builder;
      for (const a of tx.actions) {
        b = b.functionCall(tx.receiverId, a.params.methodName, a.params.args, { gas: a.params.gas as `${number}`, attachedDeposit: BigInt(a.params.deposit) });
      }
      return b;
    },
    describe(tx),
    timeoutMs,
  );
}

/**
 * Builds a transaction from `signer` with near-kit's builder, signs it once, sends those exact bytes once, and waits
 * for final execution. It never re-signs: near-kit's own `send()` re-signs with a new nonce after a nonce error, which
 * could submit the same intent twice. Any failure is mapped as in `sendWalletTx`.
 */
export async function sendBuiltOnce(
  near: Near,
  signer: AccountId,
  build: (builder: TransactionBuilder) => TransactionBuilder,
  label: string,
  timeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
): Promise<TxHash> {
  let hash: TxHash | undefined;
  let sent = false;
  let publicKey: string | undefined;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    const signed = await withTimeout(build(near.transaction(signer)).sign(), left(), () => new NearRpcError("timeout", `signing ${label}`));
    hash = signed.getHash() ?? undefined;
    const bytes = signed.serialize();
    publicKey = signerPublicKeyOf(bytes);
    sent = true;
    await withTimeout(near.rpc.sendTransaction(bytes, "FINAL"), left(), () => new NearRpcError("timeout", `${label} did not reach final execution`, { txHash: hash, outcomeUnknown: true }));
    if (!hash) throw new NearRpcError("invalid_response", "signed transaction has no hash", { outcomeUnknown: true });
    return hash;
  } catch (err) {
    if (err instanceof NearError && err.code === "INVALID_NONCE" && publicKey) forgetNonce(signer, publicKey);
    throw toRpcError(err, { sent, txHash: hash });
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

/**
 * The signing key of a Borsh `SignedTransaction` (V0): `signer_id` (u32 length and bytes), then the public key as a
 * key-type byte and 32 bytes. Returns undefined for any other layout rather than guessing.
 */
function signerPublicKeyOf(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const at = 4 + len;
  if (len > 64 || bytes.length < at + 33 || bytes[at] !== 0) return undefined;
  return publicKeyToString(bytes.slice(at + 1, at + 33));
}

function describe(tx: WalletTx): string {
  return `${tx.receiverId}.${tx.actions.map((a) => a.params.methodName).join("+")}`;
}

const RETRYABLE_CODES = new Set(["NETWORK_ERROR", "INTERNAL_ERROR", "UNAVAILABLE_SHARD", "NOT_SYNCED", "UNKNOWN_BLOCK"]);
const REJECTED_CODES = new Set([
  "INVALID_NONCE",
  "INVALID_TRANSACTION",
  "ACCESS_KEY_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "INSUFFICIENT_BALANCE",
  "SIGNATURE_ERROR",
  "INVALID_KEY",
  "INVALID_ACCOUNT",
  "INVALID_ACCOUNT_ID",
  "NO_CONTRACT_CODE",
  "PARSE_ERROR",
]);

/** Maps anything thrown below the seam onto `ChainError` (hub refusals) or `NearRpcError`. */
function toRpcError(err: unknown, ctx: { sent: boolean; txHash?: TxHash }): Error {
  if (err instanceof ChainError) return err;
  if (err instanceof NearRpcError) return err;
  const detail = ctx.txHash ? `tx ${ctx.txHash}` : undefined;
  if (err instanceof FunctionCallError) {
    const text = err.panic ?? err.message;
    const code = hubErrorOf(text);
    if (code) return new ChainError(code, detail);
    return new NearRpcError("failed", text, { txHash: ctx.txHash, cause: err });
  }
  if (err instanceof NearError) {
    if (err.code === "CONTRACT_EXECUTION_ERROR") {
      const text = `${err.message} ${JSON.stringify(err.data ?? (err as { details?: unknown }).details ?? "")}`;
      const code = hubErrorOf(text.slice(text.indexOf("Smart contract panicked:")));
      if (code) return new ChainError(code, detail);
      return new NearRpcError("failed", err.message, { txHash: ctx.txHash, cause: err });
    }
    if (err.code === "TIMEOUT_ERROR" || err.code === "TRANSACTION_TIMEOUT") {
      return new NearRpcError("timeout", err.message, { txHash: ctx.txHash, outcomeUnknown: ctx.sent, cause: err });
    }
    if (REJECTED_CODES.has(err.code)) {
      // A view of a missing account or contract is a deployment mismatch, not a refused transaction.
      return new NearRpcError(ctx.sent || ctx.txHash ? "rejected" : "invalid_response", err.message, { txHash: ctx.txHash, cause: err });
    }
    if (RETRYABLE_CODES.has(err.code)) {
      return new NearRpcError("unavailable", err.message, { txHash: ctx.txHash, outcomeUnknown: ctx.sent, cause: err });
    }
    return new NearRpcError("unavailable", `${err.code}: ${err.message}`, { txHash: ctx.txHash, outcomeUnknown: ctx.sent, cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new NearRpcError("unavailable", message, { txHash: ctx.txHash, outcomeUnknown: ctx.sent, cause: err });
}

function failureOf(status: unknown): string | null {
  if (typeof status !== "object" || status === null || !("Failure" in status)) return null;
  const failure = (status as { Failure: unknown }).Failure;
  const text = JSON.stringify(failure);
  const m = /Smart contract panicked: ([^"\\]*)/.exec(text);
  return m ? `Smart contract panicked: ${m[1]}` : text;
}

function invalid(what: string, value: unknown): NearRpcError {
  return new NearRpcError("invalid_response", `unexpected ${what}: ${JSON.stringify(value)?.slice(0, 200)}`);
}

function parseBudget(id: Id32, raw: RawBudget): Budget {
  const u = (v: unknown, what: string): bigint => {
    if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw invalid(what, v);
    return BigInt(v);
  };
  if (!isAccountId(raw.owner) || !isAccountId(raw.settler) || !isId32(raw.agent_pk) || !isId32(raw.policy_hash) || !Array.isArray(raw.payees) || !raw.payees.every(isAccountId)) {
    throw invalid("budget", raw);
  }
  return {
    id,
    owner: raw.owner,
    agentPk: publicKeyToString(hexToBytes(raw.agent_pk)),
    settler: raw.settler,
    cap: u(raw.cap, "cap"),
    spent: u(raw.spent, "spent"),
    escrow: u(raw.escrow, "escrow"),
    validUntil: u(raw.valid_until, "valid_until"),
    revokedAt: raw.revoked_at === null ? null : u(raw.revoked_at, "revoked_at"),
    payees: [...raw.payees],
    policyHash: raw.policy_hash,
    ...(raw.storage_reserve_bytes === undefined ? {} : { storageReserveBytes: u(raw.storage_reserve_bytes, "storage_reserve_bytes") }),
  };
}

/** JSON shape of `ReceiptFields` in `verify_receipt`. */
export function receiptFieldsArgs(f: ReceiptFields): Record<string, unknown> {
  assertId32(f.callId, "callId");
  assertId32(f.budgetId, "budgetId");
  assertId32(f.requestHash, "requestHash");
  assertAccountId(f.payee, "payee");
  if (!isSig64(f.voucherSig)) throw new Error("voucherSig must be a Sig64");
  return {
    call_id: f.callId,
    budget_id: f.budgetId,
    payee: f.payee,
    amount: f.amount.toString(),
    cumulative: f.cumulative.toString(),
    request_hash: f.requestHash,
    timestamp_ms: f.timestampMs.toString(),
    voucher_sig: f.voucherSig,
  };
}

/** Rejects with `onTimeout()` after `ms`. The underlying request is not cancelled: near-kit offers no abort signal. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
