import { base64 } from "@scure/base";
import { assertAccountId, assertId32, isAccountId, isId32, isSig64 } from "./bytes.ts";
import { hubErrorOf } from "./constants.ts";
import { hashPair, receiptLeaf } from "./merkle.ts";
import type { AccountId, Batch, Id32, Network, Payment, ReceiptFields, TxHash, TxState } from "./types.ts";

/**
 * A read-only NEAR client for browsers: plain `fetch` JSON-RPC, final finality, no keys and no Node built-ins.
 * It answers the reads a proof needs (a batch root, hub payments, `verify_receipt`, a transaction's status) and
 * reports the block each answer came from, so a page can show exactly what it read and from where.
 *
 * `NearRpcChain` in `./node` stays the client for servers that also write.
 */

/** Public RPC endpoints per network. A page should let its own config override these. */
export const PUBLIC_RPC_URLS: Readonly<Record<Network, string | null>> = {
  "near:testnet": "https://rpc.testnet.near.org",
  "near:mainnet": "https://rpc.mainnet.near.org",
  "near:sandbox": null,
};

/**
 * - `timeout`: no answer before the deadline; the request was aborted.
 * - `unavailable`: the RPC could not be reached, rate limited the request, or answered with a server error.
 * - `not_found`: the contract account does not exist on this network, or the transaction is unknown to this RPC.
 * - `contract_error`: the view ran and the contract panicked; `hubCode` names the hub's code when it is one.
 * - `invalid_response`: the RPC or the contract answered with something this reader does not understand.
 */
export type NearReadErrorKind = "timeout" | "unavailable" | "not_found" | "contract_error" | "invalid_response";

export class NearReadError extends Error {
  readonly kind: NearReadErrorKind;
  /** What was being read, for example `hub.payminto.testnet.batch`. */
  readonly what: string;
  readonly hubCode: string | null;
  constructor(kind: NearReadErrorKind, what: string, message: string, o: { hubCode?: string | null; cause?: unknown } = {}) {
    super(`${kind}: ${what}: ${message}`, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "NearReadError";
    this.kind = kind;
    this.what = what;
    this.hubCode = o.hubCode ?? null;
  }
}

/** A view result and the final block it was read at. */
export type ReadAt<T> = { value: T; blockHeight: number; blockHash: string };

export type NearReaderOptions = {
  rpcUrl: string;
  hub: AccountId;
  /** Deadline for one request, in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Defaults to the global `fetch`. Tests and demos pass their own. */
  fetch?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const U128 = /^(0|[1-9][0-9]*)$/;

type RpcError = { name?: string; cause?: { name?: string; info?: Record<string, unknown> }; code?: number; message?: string; data?: unknown };
type RpcEnvelope = { result?: unknown; error?: RpcError };
type CallResult = { result?: number[]; error?: string; block_height?: number; block_hash?: string; logs?: string[] };

export class NearReader {
  readonly rpcUrl: string;
  readonly hub: AccountId;
  readonly timeoutMs: number;
  readonly #fetch: typeof fetch;
  #id = 0;

  constructor(o: NearReaderOptions) {
    assertAccountId(o.hub, "hub");
    try {
      new URL(o.rpcUrl);
    } catch {
      throw new Error(`rpcUrl must be a URL, got ${o.rpcUrl}`);
    }
    this.rpcUrl = o.rpcUrl;
    this.hub = o.hub;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = o.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("no fetch available");
    // Bound so a browser's window.fetch is never called with another `this`.
    this.#fetch = f.bind(globalThis);
  }

  /** Calls a view method at final finality and parses its JSON return value. */
  async view<T>(contract: AccountId, method: string, args: Record<string, unknown>): Promise<ReadAt<T>> {
    const what = `${contract}.${method}`;
    const raw = await this.#rpc(what, "query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
    });
    const r = raw as CallResult;
    if (typeof r !== "object" || r === null) throw new NearReadError("invalid_response", what, "empty result");
    // Older nodes report a contract panic inside a successful envelope.
    if (typeof r.error === "string") throw contractError(what, r.error);
    if (!Array.isArray(r.result) || typeof r.block_height !== "number" || typeof r.block_hash !== "string") throw new NearReadError("invalid_response", what, "missing result bytes or block");
    let value: T;
    try {
      value = JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
    } catch (cause) {
      throw new NearReadError("invalid_response", what, "the view did not return JSON", { cause });
    }
    return { value, blockHeight: r.block_height, blockHash: r.block_hash };
  }

  /** The hub's record of the batch `settler` settled under `id`, or null when the hub has none. */
  async batch(id: Id32, settler: AccountId): Promise<ReadAt<Batch | null>> {
    assertId32(id, "batch id");
    assertAccountId(settler, "settler");
    const r = await this.view<RawBatch | null>(this.hub, "batch", { settler, batch_id: id });
    return { ...r, value: r.value === null ? null : parseBatch(r.value) };
  }

  /** Aligned with `ids`; null for a payment the hub has not recorded. */
  async payments(ids: readonly Id32[]): Promise<ReadAt<Array<Payment | null>>> {
    ids.forEach((id) => assertId32(id, "payment id"));
    const r = await this.view<Array<RawPayment | null>>(this.hub, "payments", { ids: [...ids] });
    const rows = r.value;
    if (!Array.isArray(rows) || rows.length !== ids.length) throw invalid("payments", rows);
    return { ...r, value: rows.map((p, i) => (p === null ? null : parsePayment(ids[i]!, p))) };
  }

  /**
   * The hub's own `verify_receipt` for the batch `settler` settled under `batchId`: it rebuilds the leaf from the
   * fields and walks the proof to the stored root.
   */
  async verifyReceipt(batchId: Id32, settler: AccountId, fields: ReceiptFields, proof: readonly Id32[]): Promise<ReadAt<boolean>> {
    assertId32(batchId, "batch id");
    assertAccountId(settler, "settler");
    proof.forEach((p) => assertId32(p, "proof node"));
    const r = await this.view<boolean>(this.hub, "verify_receipt", { settler, batch_id: batchId, fields: receiptFieldsJson(fields), proof: [...proof] });
    if (typeof r.value !== "boolean") throw invalid("verify_receipt", r.value);
    return r;
  }

  /**
   * Status of a transaction signed by `sender`, read without waiting. `final` means final and successful; a failure
   * carries the hub code when the hub refused. An RPC that has never seen the hash answers `unknown`.
   */
  async txState(hash: TxHash, sender: AccountId): Promise<TxState> {
    assertAccountId(sender, "sender");
    let raw: { final_execution_status?: string; status?: unknown };
    try {
      raw = (await this.#rpc(`tx ${hash}`, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" })) as typeof raw;
    } catch (err) {
      if (err instanceof NearReadError && err.kind === "not_found") return { status: "unknown" };
      throw err;
    }
    if (typeof raw !== "object" || raw === null) throw new NearReadError("invalid_response", `tx ${hash}`, "empty result");
    const failure = failureOf(raw.status);
    if (failure !== null) return { status: "failed", error: hubErrorOf(failure) ?? failure };
    if (raw.final_execution_status === "FINAL") return { status: "final" };
    return { status: "pending" };
  }

  /**
   * The NEP-141 transfers a transaction made, from the `ft_transfer` events of its successful receipts. NEAR RPC finds a
   * transaction only by its hash and its signer's account, so each candidate sender is tried in turn; the first that
   * knows it answers. `unknown` when none does, `pending` before it is final.
   */
  async txTransfers(hash: TxHash, senders: readonly AccountId[]): Promise<TxTransfers> {
    senders.forEach((s) => assertAccountId(s, "sender"));
    for (const sender of senders) {
      let raw: { final_execution_status?: string; status?: unknown; receipts_outcome?: unknown };
      try {
        raw = (await this.#rpc(`tx ${hash}`, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" })) as typeof raw;
      } catch (err) {
        if (err instanceof NearReadError && err.kind === "not_found") continue;
        throw err;
      }
      if (typeof raw !== "object" || raw === null) throw new NearReadError("invalid_response", `tx ${hash}`, "empty result");
      const failure = failureOf(raw.status);
      if (failure !== null) return { status: "failed", error: failure };
      if (raw.final_execution_status !== "FINAL") return { status: "pending" };
      return { status: "final", sender, transfers: nep141Transfers(Array.isArray(raw.receipts_outcome) ? (raw.receipts_outcome as ReceiptOutcome[]) : []) };
    }
    return { status: "unknown" };
  }

  async #rpc(what: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `payminto-${++this.#id}`, method, params }),
        signal: ctrl.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) throw new NearReadError("timeout", what, `no answer from ${this.rpcUrl} within ${this.timeoutMs} ms`, { cause });
      throw new NearReadError("unavailable", what, `could not reach ${this.rpcUrl}`, { cause });
    }
    let body: RpcEnvelope;
    try {
      body = (await res.json()) as RpcEnvelope;
    } catch (cause) {
      if (ctrl.signal.aborted) throw new NearReadError("timeout", what, `no answer from ${this.rpcUrl} within ${this.timeoutMs} ms`, { cause });
      throw new NearReadError(res.ok ? "invalid_response" : "unavailable", what, `HTTP ${res.status} with no JSON body`, { cause });
    } finally {
      clearTimeout(timer);
    }
    if (body && typeof body === "object" && body.error) throw rpcError(what, body.error);
    if (!res.ok) throw new NearReadError("unavailable", what, res.status === 429 ? "the RPC is rate limiting requests" : `HTTP ${res.status}`);
    if (!body || typeof body !== "object" || !("result" in body)) throw new NearReadError("invalid_response", what, "no result in the RPC answer");
    return body.result;
  }
}

// ---- NEP-141 transfers of a transaction ----

/** One NEP-141 `ft_transfer` event: `token` is the contract that emitted it. */
export type Nep141Transfer = { token: AccountId; from: AccountId; to: AccountId; amount: bigint };

/** `NearReader.txTransfers`: `sender` is the account NEAR RPC found the transaction by. */
export type TxTransfers = { status: "final"; sender: AccountId; transfers: Nep141Transfer[] } | { status: "failed"; error: string } | { status: "pending" } | { status: "unknown" };

/** The parts of a receipt outcome in a NEAR `tx` answer that carry events. */
export type ReceiptOutcome = { id?: string; outcome?: { executor_id?: string; logs?: string[]; status?: Record<string, unknown> } };

/**
 * NEP-141 transfers in the logs of the receipts that succeeded. A receipt that failed keeps the logs it wrote before
 * failing, so its events are ignored: they never moved anything.
 */
export function nep141Transfers(outcomes: readonly ReceiptOutcome[]): Nep141Transfer[] {
  const out: Nep141Transfer[] = [];
  for (const o of outcomes) {
    const status = o.outcome?.status ?? {};
    if (!("SuccessValue" in status) && !("SuccessReceiptId" in status)) continue;
    const token = o.outcome?.executor_id;
    if (!token) continue;
    for (const log of o.outcome?.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let ev: { standard?: unknown; event?: unknown; data?: unknown };
      try {
        ev = JSON.parse(log.slice("EVENT_JSON:".length)) as typeof ev;
      } catch {
        continue;
      }
      if (ev.standard !== "nep141" || ev.event !== "ft_transfer" || !Array.isArray(ev.data)) continue;
      for (const d of ev.data as Array<Record<string, unknown>>) {
        if (typeof d.new_owner_id !== "string" || typeof d.old_owner_id !== "string" || typeof d.amount !== "string" || !U128.test(d.amount)) continue;
        out.push({ token, from: d.old_owner_id, to: d.new_owner_id, amount: BigInt(d.amount) });
      }
    }
  }
  return out;
}

// ---- proof of one Call against the hub ----

export type ReceiptCheck = {
  rpcUrl: string;
  hub: AccountId;
  network: Network;
  batchId: Id32;
  /** The settler whose batch this is. Batch ids belong to their settler. */
  settler: AccountId;
  /** Final block the batch was read at. */
  blockHeight: number;
  /** The root the hub stores for the batch, or null when the hub has no such batch. */
  storedRoot: Id32 | null;
  /** The leaf rebuilt here from the receipt fields. */
  leaf: Id32;
  /** The root reached by walking the proof from that leaf. */
  recomputedRoot: Id32;
  rootMatches: boolean;
  /** The hub's own `verify_receipt`; null when the hub has no such batch. */
  hubVerified: boolean | null;
  /** Both the browser's recomputation and the hub agree. */
  verified: boolean;
};

/** Walks a sorted-pair Merkle proof from `leaf` and returns the root it reaches. */
export function rootFromProof(leaf: Id32, proof: readonly Id32[]): Id32 {
  assertId32(leaf, "leaf");
  return proof.reduce<Id32>((node, sibling) => hashPair(node, sibling), leaf);
}

/**
 * Proves one Call against NEAR: reads the batch root the hub stores for `settler` and `batchId`, rebuilds the leaf and
 * the root here from the receipt fields and proof, and asks the hub's `verify_receipt` too. Verified only when both
 * agree. The settler is the receipt's Budget's settler, because `settle_batch` takes only Budgets that name the caller.
 */
export async function checkReceiptOnChain(
  reader: NearReader,
  a: { network: Network; batchId: Id32; settler: AccountId; fields: ReceiptFields; proof: readonly Id32[] },
): Promise<ReceiptCheck> {
  const leaf = receiptLeaf(reader.hub, a.network, a.batchId, a.fields);
  const recomputedRoot = rootFromProof(leaf, a.proof);
  const batch = await reader.batch(a.batchId, a.settler);
  const storedRoot = batch.value?.root ?? null;
  const rootMatches = storedRoot !== null && storedRoot === recomputedRoot;
  const hubVerified = batch.value === null ? null : (await reader.verifyReceipt(a.batchId, a.settler, a.fields, a.proof)).value;
  return {
    rpcUrl: reader.rpcUrl,
    hub: reader.hub,
    network: a.network,
    batchId: a.batchId,
    settler: a.settler,
    blockHeight: batch.blockHeight,
    storedRoot,
    leaf,
    recomputedRoot,
    rootMatches,
    hubVerified,
    verified: rootMatches && hubVerified === true,
  };
}

// ---- parsing ----

type RawBatch = { root: string; settler: string; gross: string; net: string; at: string };
type RawPayment = { id: string; merchant: string; amount: string; payer: string; at: string };

function u128(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !U128.test(v)) throw invalid(what, v);
  return BigInt(v);
}

function parseBatch(raw: RawBatch): Batch {
  if (typeof raw !== "object" || raw === null || !isId32(raw.root) || !isAccountId(raw.settler)) throw invalid("batch", raw);
  return { root: raw.root, settler: raw.settler, gross: u128(raw.gross, "gross"), net: u128(raw.net, "net"), at: u128(raw.at, "at") };
}

function parsePayment(id: Id32, p: RawPayment): Payment {
  if (typeof p !== "object" || p.id !== id || !isAccountId(p.merchant) || !isAccountId(p.payer)) throw invalid("payment", p);
  return { id, merchant: p.merchant, amount: u128(p.amount, "amount"), payer: p.payer, at: u128(p.at, "at") };
}

/** JSON shape of `ReceiptFields` in `verify_receipt`; equal to `receiptFieldsArgs` in `./node`. */
export function receiptFieldsJson(f: ReceiptFields): Record<string, unknown> {
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

function invalid(what: string, value: unknown): NearReadError {
  return new NearReadError("invalid_response", what, `unexpected value ${JSON.stringify(value)?.slice(0, 160)}`);
}

function contractError(what: string, text: string): NearReadError {
  const at = text.indexOf("Smart contract panicked:");
  const code = hubErrorOf(at >= 0 ? text.slice(at) : text);
  return new NearReadError("contract_error", what, code ?? text.slice(0, 240), { hubCode: code });
}

function rpcError(what: string, e: RpcError): NearReadError {
  const cause = e.cause?.name ?? "";
  const detail = typeof e.data === "string" ? e.data : (e.message ?? cause);
  if (cause === "CONTRACT_EXECUTION_ERROR") {
    const vm = e.cause?.info?.["vm_error"];
    return contractError(what, typeof vm === "string" ? vm : detail);
  }
  if (cause === "UNKNOWN_ACCOUNT" || cause === "NO_CONTRACT_CODE" || cause === "UNKNOWN_TRANSACTION") return new NearReadError("not_found", what, detail);
  if (cause === "TIMEOUT_ERROR") return new NearReadError("timeout", what, detail);
  if (cause === "UNKNOWN_BLOCK" || cause === "NOT_SYNCED_YET" || cause === "INTERNAL_ERROR" || e.name === "INTERNAL_ERROR") return new NearReadError("unavailable", what, detail);
  return new NearReadError("invalid_response", what, `${cause || e.name || "RPC error"}: ${detail}`);
}

function failureOf(status: unknown): string | null {
  if (typeof status !== "object" || status === null || !("Failure" in status)) return null;
  const text = JSON.stringify((status as { Failure: unknown }).Failure);
  const m = /Smart contract panicked: ([^"\\]*)/.exec(text);
  return m ? `Smart contract panicked: ${m[1]}` : text;
}
