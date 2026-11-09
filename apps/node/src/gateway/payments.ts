import { getAddress, type Address, type Hex } from "viem";
import {
  computeFees,
  isTerminalPaymentStatus,
  lineItemsTotal,
  metadataHash,
  newPaymentId,
  orderHash,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type FeeBreakdown,
  type LineItem,
  type OrderCommitment,
  type PaymentMethod,
  type PaymentStatus,
} from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { nowIso } from "../store.ts";
import type { MerchantRow, MerchantService } from "./merchants.ts";
import { creditJson, isoOf, paymentJson, refundJson, type CreditRow, type ModelContext, type PaymentJson, type PaymentRow, type RefundRow } from "./model.ts";
import type { GatewayRails, PaymentBinding } from "./rails.ts";
import type { WebhookService } from "./webhooks.ts";

/** Deposits, wallet and x402 exact pay the payment's forwarder, which is flushed once they are confirmed. */
const paysForwarder = (m: PaymentMethod) => m === "deposit" || m === "wallet" || m === "x402";

/** Terminal payments stay in the deposit watcher's set this long, for late deposits. */
export const LATE_WINDOW_SEC = 7 * 86_400;

/**
 * The payment state machine (GATEWAY.md section 4) as a pure function of the confirmed total, the number of
 * pending credits and whether the payment is past its expiry.
 */
export function nextStatus(s: { status: PaymentStatus; due: bigint; confirmed: bigint; pending: number; expired: boolean }): PaymentStatus {
  if (s.confirmed > s.due) return "overpaid";
  if (s.confirmed === s.due) return "paid";
  if (isTerminalPaymentStatus(s.status)) {
    // Late money moves expired and canceled payments; underpaid stays underpaid until the total reaches the amount due.
    if (s.status === "expired" || s.status === "canceled") return s.confirmed > 0n ? "underpaid" : s.status;
    return s.status;
  }
  // Money in flight holds expiry until it is confirmed or dropped.
  if (s.pending > 0) return "processing";
  if (s.expired) return s.confirmed > 0n ? "underpaid" : "expired";
  return s.confirmed > 0n ? "partially_paid" : "open";
}

export type CreatePaymentInput = {
  amount: bigint;
  method?: PaymentMethod | null;
  description?: string | null;
  reference?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  metadata?: Record<string, string>;
  line_items?: LineItem[];
  success_url?: string | null;
  expires_in?: number;
  link_id?: string | null;
};

export type NewCredit = {
  paymentId: string;
  method: PaymentMethod;
  payer: Address | null;
  amount: bigint;
  txHash: Hex | null;
  logIndex: number | null;
  blockNumber: number | null;
  blockHash: Hex | null;
  callId?: Hex | null;
  status: "pending" | "confirmed";
  /** Only deposits can be late: authorizations are refused after expiry and are valid only until it on chain. */
  mayBeLate: boolean;
};

/** A forwarder of an earlier quote of a payment (migration 006). */
export type PreviousForwarder = {
  address: Address;
  payment_id: string;
  quote_method: PaymentMethod | null;
  surcharge: string;
  amount_due: string;
  platform_fee: string;
  method_fee: string;
  fee_total: string;
  net_amount: string;
  fee_recipient: Address | null;
  created_at: string;
};

export type PaymentFilters = { status?: PaymentStatus[]; method?: PaymentMethod[]; link_id?: string; email?: string; q?: string; refunded?: boolean; limit: number; cursor?: number };

type Listener = (p: PaymentRow) => void;

export class PaymentService {
  readonly #db: Database;
  readonly #ctx: ModelContext;
  readonly #rails: GatewayRails;
  readonly #merchants: MerchantService;
  readonly #webhooks: WebhookService;
  readonly #head: () => Promise<bigint>;
  readonly #clock: () => number;
  readonly #ttlSec: number;
  readonly #attest: boolean;
  readonly #unavailable: (method: PaymentMethod) => string | null;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(o: {
    db: Database;
    ctx: ModelContext;
    rails: GatewayRails;
    merchants: MerchantService;
    webhooks: WebhookService;
    /** Current chain head, recorded on the payment as the start of AuthorizationUsed lookups. */
    head: () => Promise<bigint>;
    clock?: () => number;
    ttlSec: number;
    /** EAS attestation of paid payments is on (EAS_ATTEST=true). */
    attest: boolean;
    /** Why a method that depends on outside access (HSP) cannot take payments now; null when it can. */
    unavailable?: (method: PaymentMethod) => string | null;
  }) {
    this.#db = o.db;
    this.#ctx = o.ctx;
    this.#rails = o.rails;
    this.#merchants = o.merchants;
    this.#webhooks = o.webhooks;
    this.#head = o.head;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
    this.#ttlSec = o.ttlSec;
    this.#attest = o.attest;
    this.#unavailable = o.unavailable ?? (() => null);
  }

  get rails(): GatewayRails {
    return this.#rails;
  }

  now(): number {
    return this.#clock();
  }

  json(r: PaymentRow): PaymentJson {
    return paymentJson(r, this.#ctx);
  }

  termsOf(p: Pick<PaymentRow, "id" | "payout" | "fee_recipient" | "fee_total" | "amount_due">): PaymentBinding {
    return { paymentId: p.id, payout: p.payout, feeRecipient: p.fee_recipient, fee: BigInt(p.fee_total), amountDue: BigInt(p.amount_due) };
  }

  /** SSE: called after every committed change of the payment. */
  subscribe(paymentId: string, fn: Listener): () => void {
    let set = this.#listeners.get(paymentId);
    if (!set) this.#listeners.set(paymentId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#listeners.delete(paymentId);
    };
  }

  /** Tells SSE subscribers about a change that is not a state change (the HSP status), after the commit. */
  notify(paymentId: string): void {
    this.#changed(paymentId);
  }

  #changed(paymentId: string) {
    this.#db.afterCommit(() => {
      const set = this.#listeners.get(paymentId);
      if (!set) return;
      const row = this.row(paymentId);
      if (!row) return;
      for (const l of set) {
        try {
          l(row);
        } catch {
          // A broken subscriber must never break the writer.
        }
      }
    });
  }

  // ------------------------------------------------------------------ quotes and fees

  /** Methods that can carry this payment: enabled for the merchant, within its limits, and able to take the fee. */
  feasibleMethods(m: MerchantRow, amount: bigint): PaymentMethod[] {
    return PAYMENT_METHODS.filter((method) => {
      try {
        this.quote(m, amount, method);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Fee breakdown for `amount` paid by `method` (null: chosen at checkout). Throws ApiError when it cannot be paid so. */
  quote(m: MerchantRow, amount: bigint, method: PaymentMethod | null): FeeBreakdown<bigint> {
    const plan = this.#merchants.feePlan(m.fee_plan_id);
    let terms = null;
    if (method) {
      const row = this.#merchants.method(m.id, method);
      if (!row.enabled) throw new ApiError(409, "METHOD_DISABLED", `${method} payments are disabled for this merchant`);
      const why = this.#unavailable(method);
      if (why) throw new ApiError(409, "METHOD_UNAVAILABLE", why);
      if (row.min_amount !== null && amount < BigInt(row.min_amount)) throw new ApiError(400, "AMOUNT_TOO_SMALL", `${method} needs at least ${row.min_amount}`);
      if (row.max_amount !== null && amount > BigInt(row.max_amount)) throw new ApiError(400, "AMOUNT_TOO_LARGE", `${method} allows at most ${row.max_amount}`);
      terms = row;
    }
    const q = computeFees({ amount, plan, method: terms });
    if (q.fee_total > 0n && !this.#merchants.platformRow()?.fee_recipient) {
      throw new ApiError(409, "FEE_RECIPIENT_REQUIRED", "fees need PLATFORM_FEE_ADDRESS");
    }
    return q;
  }

  // ------------------------------------------------------------------ create and read

  /**
   * `draftKey` creates a draft (section 15): a payment an unpaid x402 request needs for its forwarder, invisible to the
   * merchant (no listing, no webhooks, no stats) until its first credit or valid signature promotes it.
   */
  async create(m: MerchantRow, b: CreatePaymentInput, o: { draftKey?: string } = {}): Promise<PaymentRow> {
    if (m.status !== "active") throw new ApiError(403, "MERCHANT_SUSPENDED", "this merchant is suspended");
    if (m.payout_set === 0) throw new ApiError(409, "PAYOUT_REQUIRED", "this business has no payout wallet yet; an Admin must prove one first");
    const method = b.method ?? null;
    const q = this.quote(m, b.amount, method);
    if (!method && this.feasibleMethods(m, b.amount).length === 0) {
      throw new ApiError(409, "NO_PAYMENT_METHOD", "no enabled payment method can take this payment");
    }
    const items = b.line_items ?? [];
    if (items.length && lineItemsTotal(items) !== b.amount) throw new ApiError(400, "LINE_ITEMS_MISMATCH", "line_items must add up to amount");
    const metadata = b.metadata ?? {};
    const id = newPaymentId();
    const platform = this.#merchants.platformRow()!;
    const feeRecipient = q.fee_total > 0n ? platform.fee_recipient : null;
    const deposit = this.#rails.deposit({ paymentId: id, payout: m.payout, feeRecipient, fee: q.fee_total, amountDue: q.amount_due });
    const now = this.#clock();
    const ttl = b.expires_in ?? this.#ttlSec;
    const createdBlock = Number(await this.#head());
    const hash = orderHash({
      payment_id: id,
      amount: b.amount.toString(),
      token: this.#ctx.token,
      payout: m.payout,
      reference: b.reference ?? null,
      description: b.description ?? null,
      line_items: items,
      metadata_hash: metadataHash(metadata),
    });
    const at = isoOf(now);
    this.#db.tx(() => {
      this.#db.run(
        `INSERT INTO payments (id, merchant_id, status, amount, quote_method, surcharge, amount_due, platform_fee, method_fee, fee_total, net_amount,
                               fee_recipient, deposit_address, deposit_salt, payout, description, reference, customer_email, customer_name, metadata,
                               line_items, order_hash, link_id, success_url, created_block, expires_at, expires_unix, draft, draft_key, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        m.id,
        q.amount.toString(),
        method,
        q.surcharge.toString(),
        q.amount_due.toString(),
        q.platform_fee.toString(),
        q.method_fee.toString(),
        q.fee_total.toString(),
        q.net_amount.toString(),
        feeRecipient,
        deposit.address,
        deposit.salt,
        m.payout,
        b.description ?? null,
        b.reference ?? null,
        b.customer_email ?? null,
        b.customer_name ?? null,
        JSON.stringify(metadata),
        JSON.stringify(items),
        hash,
        b.link_id ?? null,
        b.success_url ?? null,
        createdBlock,
        isoOf(now + ttl),
        now + ttl,
        o.draftKey ? 1 : 0,
        o.draftKey ?? null,
        at,
        at,
      );
      const row = this.row(id)!;
      if (!o.draftKey) this.#webhooks.emit(m.id, "payment.created", id, id, this.json(row));
    });
    return this.row(id)!;
  }

  /** A live draft of this link for this requester, reusable while at least a minute of it is left. */
  findDraft(linkId: string, draftKey: string, amount: bigint, method: PaymentMethod): PaymentRow | undefined {
    return this.#db.get<PaymentRow>(
      `SELECT * FROM payments WHERE draft = 1 AND link_id = ? AND draft_key = ? AND amount = ? AND quote_method = ? AND status = 'open' AND expires_unix > ?
       ORDER BY created_at DESC LIMIT 1`,
      linkId,
      draftKey,
      amount.toString(),
      method,
      this.#clock() + 60,
    );
  }

  /** Turns a draft into a normal payment: from here on it is listed, counted and announced (payment.created). */
  promote(id: string): PaymentRow {
    return this.#db.tx(() => {
      const p = this.row(id)!;
      if (!p.draft) return p;
      this.#db.run("UPDATE payments SET draft = 0, draft_key = NULL, updated_at = ? WHERE id = ?", nowIso(), id);
      const row = this.row(id)!;
      this.#webhooks.emit(p.merchant_id, "payment.created", id, id, this.json(row));
      return row;
    });
  }

  /** Deletes expired drafts nothing ever paid (they were never visible, so nothing refers to them). */
  collectDrafts(): number {
    return this.#db.tx(() => {
      const ids = this.#db
        .all<{ id: string }>(
          "SELECT id FROM payments WHERE draft = 1 AND expires_unix <= ? AND NOT EXISTS (SELECT 1 FROM payment_credits c WHERE c.payment_id = payments.id) LIMIT 1000",
          this.#clock(),
        )
        .map((r) => r.id);
      for (const id of ids) {
        this.#db.run("DELETE FROM payment_relays WHERE payment_id = ?", id);
        this.#db.run("DELETE FROM payment_forwarders WHERE payment_id = ?", id);
        this.#db.run("DELETE FROM payments WHERE id = ?", id);
      }
      return ids.length;
    });
  }

  /** Re-quotes an untouched open payment for the method a person picked at checkout. */
  requote(p: PaymentRow, method: PaymentMethod): PaymentRow {
    if (p.quote_method === method) return p;
    const m = this.#merchants.merchant(p.merchant_id);
    const q = this.quote(m, BigInt(p.amount), method);
    return this.#db.tx(() => {
      const cur = this.row(p.id)!;
      const credits = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payment_credits WHERE payment_id = ?", p.id)!.n;
      if (cur.status !== "open" || credits > 0) throw new ApiError(409, "PAYMENT_NOT_OPEN", "the method can only change while the payment is open and unpaid");
      const feeRecipient = q.fee_total > 0n ? this.#merchants.platformRow()!.fee_recipient : null;
      const deposit = this.#rails.deposit({ paymentId: p.id, payout: p.payout, feeRecipient, fee: q.fee_total, amountDue: q.amount_due });
      // The checkout may already have shown the current forwarder: keep it watched, with its terms, in case money is on its way.
      if (deposit.address !== cur.deposit_address) this.#rememberForwarder(cur);
      this.#db.run(
        `UPDATE payments SET quote_method = ?, surcharge = ?, amount_due = ?, platform_fee = ?, method_fee = ?, fee_total = ?, net_amount = ?,
                             fee_recipient = ?, deposit_address = ?, deposit_salt = ?, updated_at = ? WHERE id = ?`,
        method,
        q.surcharge.toString(),
        q.amount_due.toString(),
        q.platform_fee.toString(),
        q.method_fee.toString(),
        q.fee_total.toString(),
        q.net_amount.toString(),
        feeRecipient,
        deposit.address,
        deposit.salt,
        nowIso(),
        p.id,
      );
      this.#changed(p.id);
      return this.row(p.id)!;
    });
  }

  row(id: string): PaymentRow | undefined {
    return this.#db.get<PaymentRow>("SELECT * FROM payments WHERE id = ?", id);
  }

  /** Forwarders the payment was quoted with before a re-quote moved it, with the terms each is bound to. */
  previousForwarders(paymentId: string): PreviousForwarder[] {
    return this.#db.all<PreviousForwarder>("SELECT * FROM payment_forwarders WHERE payment_id = ?", paymentId);
  }

  /**
   * Money reached a forwarder of an earlier quote. On a payment nothing has paid yet that quote is the one the payer
   * accepted, so it becomes the payment's quote again; otherwise the credit simply counts (the forwarder pays only the
   * payout, with its own fee terms). Runs inside the watcher's transaction, before the credit.
   */
  restoreForwarder(paymentId: string, address: string): void {
    this.#db.tx(() => {
      const f = this.#db.get<PreviousForwarder>("SELECT * FROM payment_forwarders WHERE address = ? AND payment_id = ?", address, paymentId);
      const cur = this.row(paymentId);
      if (!f || !cur || cur.deposit_address === f.address) return;
      if (this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payment_credits WHERE payment_id = ?", paymentId)!.n > 0) return;
      this.#rememberForwarder(cur);
      this.#db.run(
        `UPDATE payments SET quote_method = ?, surcharge = ?, amount_due = ?, platform_fee = ?, method_fee = ?, fee_total = ?, net_amount = ?,
                             fee_recipient = ?, deposit_address = ?, updated_at = ? WHERE id = ?`,
        f.quote_method,
        f.surcharge,
        f.amount_due,
        f.platform_fee,
        f.method_fee,
        f.fee_total,
        f.net_amount,
        f.fee_recipient,
        f.address,
        nowIso(),
        cur.id,
      );
      this.#changed(cur.id);
    });
  }

  /** Keeps the payment's current forwarder watched, with its terms, before its quote moves to another one. */
  #rememberForwarder(cur: PaymentRow): void {
    this.#db.run(
      `INSERT OR IGNORE INTO payment_forwarders (address, payment_id, quote_method, surcharge, amount_due, platform_fee, method_fee, fee_total, net_amount, fee_recipient, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cur.deposit_address,
      cur.id,
      cur.quote_method,
      cur.surcharge,
      cur.amount_due,
      cur.platform_fee,
      cur.method_fee,
      cur.fee_total,
      cur.net_amount,
      cur.fee_recipient,
      nowIso(),
    );
  }

  /** A merchant's payment; 404 for another merchant's (ids do not leak across merchants) and for drafts. */
  get(merchantId: string, id: string): PaymentRow {
    const r = this.row(id);
    if (!r || r.merchant_id !== merchantId || r.draft) throw new ApiError(404, "NOT_FOUND", "payment not found");
    return r;
  }

  credits(paymentId: string): CreditRow[] {
    return this.#db.all<CreditRow>("SELECT * FROM payment_credits WHERE payment_id = ? ORDER BY id", paymentId);
  }

  detail(merchantId: string, id: string) {
    const p = this.get(merchantId, id);
    return {
      ...this.json(p),
      credits: this.credits(p.id).map(creditJson),
      refunds: this.#db.all<RefundRow>("SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at", p.id).map((r) => refundJson(r, this.#ctx)),
      events: this.#webhooks.timeline(p.id),
    };
  }

  /**
   * A page of payments of one business, several, or all (null). The status counts (the dashboard's tabs) respect every
   * filter except status and refunded, which are the tabs themselves.
   */
  list(merchantIds: string | readonly string[] | null, f: PaymentFilters) {
    const ids = typeof merchantIds === "string" ? [merchantIds] : merchantIds;
    const base: string[] = ["draft = 0"];
    const params: Array<string | number> = [];
    if (ids) (base.push(`merchant_id IN (${ids.map(() => "?").join(", ") || "NULL"})`), params.push(...ids));
    if (f.link_id) (base.push("link_id = ?"), params.push(f.link_id));
    // The method shown on the payment (quoted, else the one that paid); counts are within this filter too.
    if (f.method?.length) (base.push(`COALESCE(quote_method, method) IN (${f.method.map(() => "?").join(", ")})`), params.push(...f.method));
    if (f.email) (base.push("lower(customer_email) = ?"), params.push(f.email.toLowerCase()));
    if (f.q) {
      base.push("(id = ? OR reference = ? OR lower(payer) = ? OR deposit_address = ? COLLATE NOCASE OR lower(customer_email) = ?)");
      params.push(f.q, f.q, f.q.toLowerCase(), f.q, f.q.toLowerCase());
    }
    const where = [...base];
    const pageParams = [...params];
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => "?").join(", ")})`);
      pageParams.push(...f.status);
    }
    if (f.refunded !== undefined) where.push(f.refunded ? "amount_refunded != '0'" : "amount_refunded = '0'");
    if (f.cursor !== undefined) (where.push("rowid < ?"), pageParams.push(f.cursor));
    const rows = this.#db.all<PaymentRow & { rid: number }>(
      `SELECT rowid AS rid, * FROM payments WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
      ...pageParams,
      f.limit + 1,
    );
    const page = rows.slice(0, f.limit);
    const counts: Record<string, number> = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0]));
    for (const c of this.#db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM payments WHERE ${base.join(" AND ")} GROUP BY status`, ...params)) {
      counts[c.status] = c.n;
    }
    counts.refunded = this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payments WHERE ${base.join(" AND ")} AND amount_refunded != '0'`, ...params)!.n;
    counts.all = Object.entries(counts).filter(([k]) => k !== "refunded").reduce((a, [, n]) => a + n, 0);
    return {
      items: page.map((r) => {
        const { rid: _rid, ...row } = r;
        return this.json(row);
      }),
      next_cursor: rows.length > f.limit && page.length ? String(page[page.length - 1]!.rid) : null,
      counts,
    };
  }

  // ------------------------------------------------------------------ credits and the state machine

  /** Records a credit (a replay of the same tx_hash and log_index, or call_id, is a no-op) and recomputes. */
  addCredit(c: NewCredit): { credit: CreditRow; inserted: boolean } {
    return this.#db.tx(() => {
      const existing = c.callId
        ? this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE call_id = ?", c.callId)
        : this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE tx_hash = ? AND log_index = ?", c.txHash, c.logIndex);
      if (existing) return { credit: existing, inserted: false };
      // Money reaching a draft makes it a real payment, announced before its credit.
      const p = this.promote(c.paymentId);
      const now = this.#clock();
      const late = c.mayBeLate && p.status !== "paid" && p.status !== "overpaid" && (now >= p.expires_unix || isTerminalPaymentStatus(p.status));
      const at = nowIso();
      const { lastInsertRowid } = this.#db.run(
        `INSERT INTO payment_credits (payment_id, method, payer, amount, tx_hash, log_index, block_number, block_hash, call_id, status, late, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.paymentId,
        c.method,
        c.payer ? getAddress(c.payer) : null,
        c.amount.toString(),
        c.txHash,
        c.logIndex,
        c.blockNumber,
        c.blockHash,
        c.callId ?? null,
        c.status,
        late ? 1 : 0,
        at,
        c.status === "confirmed" ? at : null,
      );
      if (c.status === "confirmed" && paysForwarder(c.method)) this.#flushLater(c.paymentId);
      this.recompute(c.paymentId);
      return { credit: this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE id = ?", lastInsertRowid)!, inserted: true };
    });
  }

  confirmCredit(creditId: number, patch: { txHash?: Hex | null; blockNumber?: number | null; blockHash?: Hex | null; batchId?: Hex | null } = {}): void {
    this.#db.tx(() => {
      const c = this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE id = ?", creditId);
      if (!c || c.status === "confirmed") return;
      this.#db.run(
        `UPDATE payment_credits SET status = 'confirmed', confirmed_at = ?, tx_hash = COALESCE(?, tx_hash), block_number = COALESCE(?, block_number),
                                    block_hash = COALESCE(?, block_hash), batch_id = COALESCE(?, batch_id) WHERE id = ?`,
        nowIso(),
        patch.txHash ?? null,
        patch.blockNumber ?? null,
        patch.blockHash ?? null,
        patch.batchId ?? null,
        creditId,
      );
      if (paysForwarder(c.method)) this.#flushLater(c.payment_id);
      this.recompute(c.payment_id);
    });
  }

  /** A pending credit whose block was reorged out (or whose relay never landed). Confirmed credits are never dropped. */
  dropCredit(creditId: number): void {
    this.#db.tx(() => {
      const c = this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE id = ?", creditId);
      if (!c || c.status !== "pending") return;
      this.#db.run("DELETE FROM payment_credits WHERE id = ?", creditId);
      this.recompute(c.payment_id);
    });
  }

  #flushLater(paymentId: string) {
    this.#db.run("UPDATE payments SET flush_status = 'pending', flush_next_unix = ?, flush_attempts = 0 WHERE id = ?", this.#clock(), paymentId);
  }

  /**
   * The locked step: sums confirmed credits, picks the state, and writes amount_paid, the status and the webhook outbox
   * row in one BEGIN IMMEDIATE transaction (joining the caller's when there is one).
   */
  recompute(paymentId: string): PaymentRow {
    return this.#db.tx(() => {
      const p = this.row(paymentId)!;
      const agg = this.#db.get<{ confirmed: string; pending: number; late: number }>(
        `SELECT bigsum(CASE WHEN status = 'confirmed' THEN amount END) AS confirmed,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(MAX(CASE WHEN status = 'confirmed' THEN late ELSE 0 END), 0) AS late
         FROM payment_credits WHERE payment_id = ?`,
        paymentId,
      )!;
      const first = this.#db.get<{ payer: Address | null; method: PaymentMethod }>("SELECT payer, method FROM payment_credits WHERE payment_id = ? ORDER BY id LIMIT 1", paymentId);
      const now = this.#clock();
      const confirmed = BigInt(agg.confirmed);
      const status = nextStatus({ status: p.status, due: BigInt(p.amount_due), confirmed, pending: agg.pending, expired: now >= p.expires_unix });
      const at = nowIso();
      const paidNow = (status === "paid" || status === "overpaid") && !p.paid_at;
      const terminalNow = isTerminalPaymentStatus(status) && !p.closed_at;
      const changed =
        status !== p.status || agg.confirmed !== p.amount_paid || (first?.payer ?? null) !== p.payer || (first?.method ?? null) !== p.method || agg.late !== p.late;
      if (!changed) return p;
      this.#db.run(
        `UPDATE payments SET status = ?, amount_paid = ?, payer = ?, method = ?, late = ?, paid_at = COALESCE(paid_at, ?), closed_at = COALESCE(closed_at, ?),
                             attest_status = CASE WHEN ? AND attest_status = 'none' THEN 'pending' ELSE attest_status END, updated_at = ?
         WHERE id = ?`,
        status,
        agg.confirmed,
        first?.payer ?? null,
        first?.method ?? null,
        agg.late,
        paidNow ? at : null,
        terminalNow ? at : null,
        this.#attest && (status === "paid" || status === "overpaid") ? 1 : 0,
        at,
        paymentId,
      );
      const row = this.row(paymentId)!;
      // `open` has no event: a payment back at open after a reorg drop is announced by its next real state.
      if (status !== p.status && status !== "open" && !row.draft) this.#webhooks.emit(p.merchant_id, `payment.${status}`, p.id, p.id, this.json(row));
      this.#changed(paymentId);
      return row;
    });
  }

  cancel(merchantId: string, id: string): PaymentRow {
    return this.#db.tx(() => {
      const p = this.get(merchantId, id);
      if (p.status !== "open") throw new ApiError(409, "PAYMENT_NOT_OPEN", `only open payments can be canceled (status is ${p.status})`);
      const at = nowIso();
      this.#db.run("UPDATE payments SET status = 'canceled', canceled_at = ?, closed_at = ?, updated_at = ? WHERE id = ?", at, at, at, id);
      const row = this.row(id)!;
      this.#webhooks.emit(p.merchant_id, "payment.canceled", id, id, this.json(row));
      this.#changed(id);
      return row;
    });
  }

  /** Expiry worker: recomputes every live payment whose expiry has passed. */
  expireDue(): number {
    this.collectDrafts();
    const due = this.#db.all<{ id: string }>(
      "SELECT id FROM payments WHERE status IN ('open', 'partially_paid', 'processing') AND expires_unix <= ? AND draft = 0 LIMIT 500",
      this.#clock(),
    );
    for (const { id } of due) this.recompute(id);
    return due.length;
  }

  setEmail(id: string, email: string): PaymentRow {
    return this.#db.tx(() => {
      const p = this.row(id);
      if (!p) throw new ApiError(404, "NOT_FOUND", "payment not found");
      if (p.status !== "open") throw new ApiError(409, "PAYMENT_NOT_OPEN", "a receipt email can only be added while the payment is open");
      // Public route: it may add an email, never replace one (the merchant's or an earlier payer's).
      if (p.customer_email) throw new ApiError(409, "EMAIL_ALREADY_SET", "this payment already has a receipt email");
      this.#db.run("UPDATE payments SET customer_email = ?, updated_at = ? WHERE id = ?", email, nowIso(), id);
      return this.row(id)!;
    });
  }

  /** Forwarders the deposit watcher scans: live payments, and terminal ones for LATE_WINDOW_SEC (late deposits). */
  watched(): Map<string, PaymentRow> {
    const since = isoOf(this.#clock() - LATE_WINDOW_SEC);
    const rows = this.#db.all<PaymentRow>(
      `SELECT * FROM payments WHERE status IN ('open', 'processing', 'partially_paid') OR closed_at > ?
       OR id IN (SELECT payment_id FROM payment_credits WHERE status = 'pending' AND method = 'deposit')`,
      since,
    );
    const out = new Map(rows.map((r) => [r.deposit_address.toLowerCase(), r]));
    // Forwarders of earlier quotes stay watched as long as their payment is: a payer may have sent to the one shown.
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const f of this.#db.all<{ address: string; payment_id: string }>("SELECT address, payment_id FROM payment_forwarders")) {
      const p = byId.get(f.payment_id);
      if (p && !out.has(f.address.toLowerCase())) out.set(f.address.toLowerCase(), p);
    }
    return out;
  }

  /** The order a payment commits to (section 13.2): metadata only as its hash, since it is merchant-private. */
  order(p: PaymentRow): OrderCommitment {
    return {
      payment_id: p.id,
      amount: p.amount,
      token: this.#ctx.token,
      payout: p.payout,
      reference: p.reference,
      description: p.description,
      line_items: JSON.parse(p.line_items) as LineItem[],
      metadata_hash: metadataHash(JSON.parse(p.metadata) as Record<string, string>),
    };
  }
}
