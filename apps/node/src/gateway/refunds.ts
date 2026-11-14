import { newRefundId, refundTransferTx, type AccountId, type WalletTx } from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { TxReader } from "../near-rpc.ts";
import { nowIso } from "../store.ts";
import { isOriginTxHash, ORIGIN_CHAINS, originExplorerUrl, refundJson, type CreditRow, type ModelContext, type PaymentRow, type RefundRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";
import type { WebhookService } from "./webhooks.ts";

/** A submitted refund transaction the chain still does not know after this long is failed: it was never sent or it expired. */
export const REFUND_UNKNOWN_TTL_SEC = 2 * 86_400;

export const REFUND_MANUAL_REQUIRED_MESSAGE =
  "This payment came from another chain through NEAR Intents. Send the refund from your own wallet on that chain, then record it here.";

/** Where an any-chain payment came from, for its refund: the chain, the token, the buyer's full refund address, the deposit. */
export type AnyChainRefundTarget = {
  chain: string;
  chain_name: string;
  /** The token the buyer paid with, on `chain`. */
  symbol: string;
  /**
   * The buyer's full refund address on `chain`: business data, never shown on the public checkout. Null when the buyer
   * gave none (the one-screen checkout): the business asks the buyer where to send it.
   */
  refund_to: string | null;
  deposit_tx: { hash: string; explorer_url: string | null } | null;
};

/** `manual` on POST /v1/refunds: the business already sent the refund from its own wallet on the payment's origin chain. */
export type ManualRefundInput = { paymentId: string; amount: bigint; reason?: string | null; note?: string | null; chain: string; txHash: string };

/**
 * Non-custodial refunds: the merchant's payout account sends the refund itself, an `ft_transfer` of the token to `to`
 * (the node prepares it as `transfer`). The merchant submits the transaction hash, and the node checks it on chain
 * before the refund succeeds. With a transaction reader (NEAR RPC) the node reads the transaction: signed by the
 * payment's payout account, sent to the token, carrying one `ft_transfer` to `to` of exactly the amount, successful at
 * final finality. Without one (the in-memory test chain) it can check only `Chain.txState`, and the refund says so in
 * `verification`. Fees are not returned on refunds.
 *
 * A payment that came from another chain (method `oneclick`) cannot be refunded with a NEAR transfer: the buyer has no
 * NEAR account. The business sends the refund from its own wallet on the origin chain and records it here (`manual`);
 * the node moves nothing, reads nothing, and books it as succeeded like a checked refund.
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
      this.#assertNearRefundable(p);
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

  /**
   * Where a payment that came from another chain was paid from (its confirmed any-chain quote), or null for a payment
   * paid on NEAR. Read from the quote the payment's credit names, so it works with INTENTS_CHECKOUT off too.
   */
  anyChainTarget(p: PaymentRow): AnyChainRefundTarget | null {
    if (p.method !== "oneclick") return null;
    const credit = this.#db.get<Pick<CreditRow, "intents_quote_id">>(
      "SELECT intents_quote_id FROM payment_credits WHERE payment_id = ? AND method = 'oneclick' AND intents_quote_id IS NOT NULL ORDER BY (status = 'confirmed') DESC, id LIMIT 1",
      p.id,
    );
    const q = credit?.intents_quote_id
      ? this.#db.get<{ origin_chain: string; origin_symbol: string; refund_to: string; refund_type: string; origin_txs: string }>(
          "SELECT origin_chain, origin_symbol, refund_to, refund_type, origin_txs FROM intents_quotes WHERE id = ?",
          credit.intents_quote_id,
        )
      : undefined;
    if (!q) return null;
    const tx = (JSON.parse(q.origin_txs) as Array<{ hash: string; explorerUrl?: string }>)[0];
    return {
      chain: q.origin_chain,
      chain_name: ORIGIN_CHAINS[q.origin_chain]?.name ?? q.origin_chain,
      symbol: q.origin_symbol,
      // An INTENTS quote's refund_to is the business's own account, never the buyer's.
      refund_to: q.refund_type === "INTENTS" ? null : q.refund_to,
      deposit_tx: tx ? { hash: tx.hash, explorer_url: tx.explorerUrl || originExplorerUrl(q.origin_chain, tx.hash) } : null,
    };
  }

  /** 409 REFUND_MANUAL_REQUIRED for a payment that came from another chain: it is refunded on that chain, by hand. */
  #assertNearRefundable(p: PaymentRow): void {
    if (p.method !== "oneclick") return;
    const target = this.anyChainTarget(p);
    const max = this.refundable(p);
    throw new ApiError(409, "REFUND_MANUAL_REQUIRED", REFUND_MANUAL_REQUIRED_MESSAGE, {
      chain: target?.chain ?? null,
      chain_name: target?.chain_name ?? null,
      symbol: target?.symbol ?? null,
      refund_to: target?.refund_to ?? null,
      deposit_tx: target?.deposit_tx ?? null,
      refundable: (max > 0n ? max : 0n).toString(),
    });
  }

  /**
   * Records a refund the business already sent from its own wallet on the payment's origin chain: allowed only for a
   * payment that came from another chain, on that chain, with a transaction hash of that chain's format, within what
   * is refundable. It is succeeded at once (the node cannot read the origin chain), `verification` is `manual`, and
   * it fires `refund.succeeded` like a checked refund. `by` is who recorded it.
   */
  recordManual(merchantId: string, b: ManualRefundInput, by: string | null): RefundRow {
    const id = this.#db.tx(() => {
      const p = this.#payments.get(merchantId, b.paymentId);
      if (p.method !== "oneclick") {
        throw new ApiError(409, "MANUAL_REFUND_NOT_ALLOWED", "Only a payment that came from another chain is refunded by hand. Refund this one with a NEAR transfer (leave out `manual`).");
      }
      const target = this.anyChainTarget(p);
      if (!target) throw new ApiError(409, "MANUAL_REFUND_NOT_ALLOWED", "The payment's any-chain deposit was not found, so its origin chain is unknown.");
      if (b.chain !== target.chain) {
        throw new ApiError(400, "MANUAL_REFUND_CHAIN_MISMATCH", `This payment came from ${target.chain_name} (${target.chain}); record the refund you sent on ${target.chain_name}.`, { chain: target.chain, chain_name: target.chain_name });
      }
      if (!isOriginTxHash(b.chain, b.txHash)) {
        const format = ORIGIN_CHAINS[b.chain]?.format === "solana" ? "a base58 signature of 64 to 88 characters" : "0x followed by 64 hex characters";
        throw new ApiError(400, "INVALID_TX_HASH", `tx_hash must be a ${target.chain_name} transaction hash: ${format}`);
      }
      if (b.amount <= 0n) throw new ApiError(400, "VALIDATION_ERROR", "amount must be positive");
      const max = this.refundable(p);
      if (b.amount > max) throw new ApiError(400, "REFUND_EXCEEDS_PAID", `at most ${max > 0n ? max : 0n} can be refunded`, { refundable: (max > 0n ? max : 0n).toString() });
      // EVM hashes are hex, so case does not matter; a Solana signature is kept exactly as given.
      const hash = ORIGIN_CHAINS[b.chain]?.format === "evm" ? b.txHash.toLowerCase() : b.txHash;
      if (this.#db.get("SELECT 1 FROM refunds WHERE manual_chain = ? AND lower(manual_tx_hash) = lower(?)", b.chain, hash)) {
        throw new ApiError(409, "TX_ALREADY_USED", "this transaction is already the record of another refund");
      }
      const rid = newRefundId();
      const at = nowIso();
      this.#db.run(
        `INSERT INTO refunds (id, merchant_id, payment_id, amount, reason, to_addr, status, method, verification, note, approval, requested_by,
                              manual_chain, manual_tx_hash, recorded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 'manual', 'manual', ?, 'not_required', ?, ?, ?, ?, ?, ?)`,
        rid,
        merchantId,
        p.id,
        b.amount.toString(),
        b.reason ?? null,
        `${target.chain}:${target.refund_to ?? "unknown"}`,
        b.note ?? null,
        by,
        b.chain,
        hash,
        by,
        at,
        at,
      );
      this.#booked(this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", rid)!);
      return rid;
    });
    this.#payments.notify(b.paymentId);
    return this.get(merchantId, id);
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
    if (r.status !== "pending" || r.tx_hash || r.approval === "requested" || r.method === "manual") return null;
    // A refund to an address on another chain (an any-chain payment) cannot be an ft_transfer on NEAR.
    if (r.to_addr.includes(":")) return null;
    return refundTransferTx(this.#chain.token, r.to_addr, BigInt(r.amount), r.id);
  }

  /** Records the merchant's refund transaction and checks it at once; the worker keeps checking until it is final. */
  async submit(merchantId: string, id: string, b: { txHash: string }): Promise<RefundRow> {
    const r = this.get(merchantId, id);
    if (r.status !== "pending") throw new ApiError(409, "REFUND_NOT_PENDING", `refund is ${r.status}`);
    if (r.tx_hash) throw new ApiError(409, "REFUND_SUBMITTED", "refund was already submitted; it settles once confirmed");
    if (r.approval === "requested") throw new ApiError(409, "REFUND_APPROVAL_REQUIRED", "an Admin of this business must approve this refund request first");
    this.#assertNearRefundable(this.#payments.get(merchantId, r.payment_id));
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
      this.#booked(this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!);
    });
    this.#payments.notify(r.payment_id);
  }

  /** A refund just succeeded: the payment's refunded total moves and `refund.succeeded` goes out, in the caller's transaction. */
  #booked(r: RefundRow): void {
    const total = this.#db.get<{ s: string }>("SELECT bigsum(amount) AS s FROM refunds WHERE payment_id = ? AND status = 'succeeded'", r.payment_id)!.s;
    this.#db.run("UPDATE payments SET amount_refunded = ?, updated_at = ? WHERE id = ?", total, nowIso(), r.payment_id);
    this.#webhooks.emit(r.merchant_id, "refund.succeeded", r.id, r.payment_id, this.json(r));
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
