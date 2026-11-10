import { newRefundId, refundTransferTx, type AccountId, type WalletTx } from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { TxReader } from "../near-rpc.ts";
import { nowIso } from "../store.ts";
import { refundJson, type ModelContext, type PaymentRow, type RefundRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";
import type { WebhookService } from "./webhooks.ts";

/** A submitted refund transaction the chain still does not know after this long is failed: it was never sent or it expired. */
export const REFUND_UNKNOWN_TTL_SEC = 2 * 86_400;

/**
 * Non-custodial refunds: the merchant's payout account sends the refund itself, an `ft_transfer` of the token to `to`
 * (the node prepares it as `transfer`). The merchant submits the transaction hash, and the node checks it on chain
 * before the refund succeeds. With a transaction reader (NEAR RPC) the node reads the transaction: signed by the
 * payment's payout account, sent to the token, carrying one `ft_transfer` to `to` of exactly the amount, successful at
 * final finality. Without one (the in-memory test chain) it can check only `Chain.txState`, and the refund says so in
 * `verification`. Fees are not returned on refunds.
 */
export class RefundService {
  readonly #db: Database;
  readonly #chain: ChainClient;
  readonly #ctx: ModelContext;
  readonly #payments: PaymentService;
  readonly #webhooks: WebhookService;
  readonly #txs: TxReader | null;
  readonly #log: Logger;
  readonly #clock: () => number;

  constructor(o: { db: Database; chain: ChainClient; ctx: ModelContext; payments: PaymentService; webhooks: WebhookService; txs: TxReader | null; log: Logger; clock?: () => number }) {
    this.#db = o.db;
    this.#chain = o.chain;
    this.#ctx = o.ctx;
    this.#payments = o.payments;
    this.#webhooks = o.webhooks;
    this.#txs = o.txs;
    this.#log = o.log;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  json(r: RefundRow) {
    return refundJson(r, this.#ctx);
  }

  get(merchantId: string, id: string): RefundRow {
    const r = this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ? AND merchant_id = ?", id, merchantId);
    if (!r) throw new ApiError(404, "NOT_FOUND", "refund not found");
    return r;
  }

  list(merchantIds: string | readonly string[] | null, f: { payment_id?: string; limit: number; cursor?: number }) {
    const ids = typeof merchantIds === "string" ? [merchantIds] : merchantIds;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (ids) (where.push(`merchant_id IN (${ids.map(() => "?").join(", ") || "NULL"})`), params.push(...ids));
    if (f.payment_id) (where.push("payment_id = ?"), params.push(f.payment_id));
    if (f.cursor !== undefined) (where.push("rowid < ?"), params.push(f.cursor));
    const rows = this.#db.all<RefundRow & { rid: number }>(
      `SELECT rowid AS rid, * FROM refunds ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`,
      ...params,
      f.limit + 1,
    );
    const page = rows.slice(0, f.limit);
    return { items: page.map((r) => this.json(r)), next_cursor: rows.length > f.limit && page.length ? String(page[page.length - 1]!.rid) : null };
  }

  /** The amount still refundable: paid, minus succeeded refunds, minus pending ones (so two pending cannot overdraw). */
  refundable(p: PaymentRow): bigint {
    const open = this.#db.get<{ s: string }>("SELECT bigsum(amount) AS s FROM refunds WHERE payment_id = ? AND status = 'pending'", p.id)!.s;
    return BigInt(p.amount_paid) - BigInt(p.amount_refunded) - BigInt(open);
  }

  create(
    merchantId: string,
    b: { paymentId: string; amount: bigint; reason?: string | null; to?: AccountId; note?: string | null },
    who: { requestedBy?: string | null; needsApproval?: boolean } = {},
  ): RefundRow {
    return this.#db.tx(() => {
      const p = this.#payments.get(merchantId, b.paymentId);
      const to = b.to ?? p.payer;
      if (!to) throw new ApiError(400, "NO_REFUND_ACCOUNT", "the payment has no payer yet; pass `to`");
      if (b.amount <= 0n) throw new ApiError(400, "VALIDATION_ERROR", "amount must be positive");
      const max = this.refundable(p);
      if (b.amount > max) throw new ApiError(400, "REFUND_EXCEEDS_PAID", `at most ${max > 0n ? max : 0n} can be refunded`, { refundable: (max > 0n ? max : 0n).toString() });
      const id = newRefundId();
      const at = nowIso();
      this.#db.run(
        `INSERT INTO refunds (id, merchant_id, payment_id, amount, reason, to_addr, status, note, approval, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        id,
        merchantId,
        p.id,
        b.amount.toString(),
        b.reason ?? null,
        to,
        b.note ?? null,
        who.needsApproval ? "requested" : "not_required",
        who.requestedBy ?? null,
        at,
        at,
      );
      return this.get(merchantId, id);
    });
  }

  /** An Admin approves a Staff request; only then can the merchant's refund transaction be submitted. */
  approve(merchantId: string, id: string, by: string | null): RefundRow {
    return this.#db.tx(() => {
      const r = this.get(merchantId, id);
      if (r.approval !== "requested") throw new ApiError(409, "REFUND_NOT_REQUESTED", "this refund is not waiting for approval");
      if (r.status !== "pending") throw new ApiError(409, "REFUND_NOT_CANCELABLE", "only a pending refund can be approved");
      this.#db.run("UPDATE refunds SET approval = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?", by, nowIso(), nowIso(), id);
      return this.get(merchantId, id);
    });
  }

  setNote(merchantId: string, id: string, note: string | null): RefundRow {
    this.get(merchantId, id);
    this.#db.run("UPDATE refunds SET note = ?, updated_at = ? WHERE id = ?", note, nowIso(), id);
    return this.get(merchantId, id);
  }

  cancel(merchantId: string, id: string): RefundRow {
    return this.#db.tx(() => {
      const r = this.get(merchantId, id);
      if (r.status !== "pending" || r.tx_hash) throw new ApiError(409, "REFUND_NOT_CANCELABLE", "only a pending refund that was not submitted can be canceled");
      this.#db.run("UPDATE refunds SET status = 'canceled', updated_at = ? WHERE id = ?", nowIso(), id);
      return this.get(merchantId, id);
    });
  }

  /** The transaction the merchant's payout account sends: an `ft_transfer` of the amount to `to`. Null once it cannot be sent. */
  transferFor(r: RefundRow): WalletTx | null {
    if (r.status !== "pending" || r.tx_hash || r.approval === "requested") return null;
    return refundTransferTx(this.#chain.token, r.to_addr, BigInt(r.amount), r.id);
  }

  /** Records the merchant's refund transaction and checks it at once; the worker keeps checking until it is final. */
  async submit(merchantId: string, id: string, b: { txHash: string }): Promise<RefundRow> {
    const r = this.get(merchantId, id);
    if (r.status !== "pending") throw new ApiError(409, "REFUND_NOT_PENDING", `refund is ${r.status}`);
    if (r.tx_hash) throw new ApiError(409, "REFUND_SUBMITTED", "refund was already submitted; it settles once confirmed");
    if (r.approval === "requested") throw new ApiError(409, "REFUND_APPROVAL_REQUIRED", "an Admin of this business must approve this refund request first");
    if (this.#db.get("SELECT 1 FROM refunds WHERE tx_hash = ?", b.txHash)) throw new ApiError(409, "TX_ALREADY_USED", "this transaction is already the proof of another refund");
    this.#db.run("UPDATE refunds SET tx_hash = ?, method = 'transfer', submitted_unix = ?, updated_at = ? WHERE id = ?", b.txHash, this.#clock(), nowIso(), id);
    await this.#check(this.get(merchantId, id)).catch((err) => this.#log.warn("refund check failed; the worker retries", { refundId: id, err }));
    return this.get(merchantId, id);
  }

  async #check(r: RefundRow): Promise<void> {
    const p = this.#payments.row(r.payment_id)!;
    if (this.#txs) {
      const t = await this.#txs.transfers(r.tx_hash!, p.payout);
      if (t.status === "failed") return this.#fail(r, `the refund transaction failed: ${t.error}`);
      if (t.status !== "final") return this.#expireIfStale(r);
      if (t.signer !== p.payout) return this.#fail(r, `the transaction was signed by ${t.signer}, not the payout account ${p.payout}`);
      const match = t.transfers.some((x) => x.token === this.#chain.token && x.receiverId === r.to_addr && x.amount === BigInt(r.amount));
      if (!match) return this.#fail(r, `the transaction carries no ft_transfer of ${r.amount} ${this.#chain.token} to ${r.to_addr}`);
      return this.#succeed(r, "transfer_checked");
    }
    const s = await this.#chain.chain.txState(r.tx_hash!);
    if (s.status === "failed") return this.#fail(r, `the refund transaction failed: ${s.error}`);
    if (s.status !== "final") return this.#expireIfStale(r);
    this.#succeed(r, "finality_only");
  }

  #expireIfStale(r: RefundRow): void {
    if (r.submitted_unix !== null && this.#clock() - r.submitted_unix > REFUND_UNKNOWN_TTL_SEC) this.#fail(r, "the refund transaction never became final");
  }

  #fail(r: RefundRow, reason: string): void {
    this.#db.tx(() => {
      const cur = this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!;
      if (cur.status !== "pending") return;
      this.#db.run("UPDATE refunds SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", reason, nowIso(), r.id);
      this.#webhooks.emit(r.merchant_id, "refund.failed", r.id, r.payment_id, this.json(this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!));
    });
  }

  #succeed(r: RefundRow, verification: "transfer_checked" | "finality_only"): void {
    this.#db.tx(() => {
      const cur = this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!;
      if (cur.status !== "pending") return;
      this.#db.run("UPDATE refunds SET status = 'succeeded', verification = ?, updated_at = ? WHERE id = ?", verification, nowIso(), r.id);
      const total = this.#db.get<{ s: string }>("SELECT bigsum(amount) AS s FROM refunds WHERE payment_id = ? AND status = 'succeeded'", r.payment_id)!.s;
      this.#db.run("UPDATE payments SET amount_refunded = ?, updated_at = ? WHERE id = ?", total, nowIso(), r.payment_id);
      this.#webhooks.emit(r.merchant_id, "refund.succeeded", r.id, r.payment_id, this.json(this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!));
    });
    this.#payments.notify(r.payment_id);
  }

  /** Worker: submitted refunds waiting for finality. */
  async tick(): Promise<void> {
    for (const r of this.#db.all<RefundRow>("SELECT * FROM refunds WHERE status = 'pending' AND tx_hash IS NOT NULL LIMIT 50")) {
      try {
        await this.#check(r);
      } catch (err) {
        this.#log.warn("refund confirmation check failed", { refundId: r.id, err });
      }
    }
  }
}
