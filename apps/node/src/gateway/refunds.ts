import { erc20Abi, getAddress, isAddressEqual, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { newRefundId, type PaymentTerms, type TransferAuthorization } from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { nowIso } from "../store.ts";
import { refundJson, type ModelContext, type PaymentRow, type RefundRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";
import type { GatewayRails } from "./rails.ts";
import type { AuthorizationRelay } from "./relay.ts";
import type { WebhookService } from "./webhooks.ts";

/**
 * Non-custodial refunds (GATEWAY.md sections 6 and 14.2): the payout wallet pays them, either by signing a
 * ReceiveWithAuthorization to the PaymentRouter (terms: refundRef, payout = `to`, no fee) that the node relays, or by
 * sending a plain transfer. The node only tracks them and verifies on chain that the
 * transfer is from the payout, to `to`, for exactly `amount`, and confirmed. Fees are not returned on refunds.
 */
export class RefundService {
  readonly #db: Database;
  readonly #chain: ChainClient;
  readonly #ctx: ModelContext;
  readonly #payments: PaymentService;
  readonly #relay: AuthorizationRelay;
  readonly #webhooks: WebhookService;
  readonly #rails: GatewayRails;
  readonly #log: Logger;

  constructor(o: {
    db: Database;
    chain: ChainClient;
    ctx: ModelContext;
    payments: PaymentService;
    relay: AuthorizationRelay;
    webhooks: WebhookService;
    rails: GatewayRails;
    log: Logger;
  }) {
    this.#rails = o.rails;
    this.#db = o.db;
    this.#chain = o.chain;
    this.#ctx = o.ctx;
    this.#payments = o.payments;
    this.#relay = o.relay;
    this.#webhooks = o.webhooks;
    this.#log = o.log;
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
    b: { paymentId: string; amount: bigint; reason?: string | null; to?: Address; note?: string | null },
    who: { requestedBy?: string | null; needsApproval?: boolean } = {},
  ): RefundRow {
    return this.#db.tx(() => {
      const p = this.#payments.get(merchantId, b.paymentId);
      const to = b.to ?? p.payer;
      if (!to) throw new ApiError(400, "NO_REFUND_ADDRESS", "the payment has no payer yet; pass `to`");
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
        getAddress(to),
        b.note ?? null,
        who.needsApproval ? "requested" : "not_required",
        who.requestedBy ?? null,
        at,
        at,
      );
      return this.get(merchantId, id);
    });
  }

  /** An Admin approves a Staff request; only then can the payout wallet's signature be submitted. */
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

  /** What the payout wallet signs for a gasless refund (the dashboard builds its typed data from this). */
  authorizationFor(r: RefundRow) {
    const terms = this.#rails.refundTerms(r.id, r.to_addr);
    return { router: this.#rails.router, terms: { ...terms, fee: terms.fee.toString() }, to: this.#rails.router, value: r.amount, nonce: this.#rails.termsNonce(terms) };
  }

  /** `{authorization}`: relays the payout's signed router authorization. `{txHash}`: verifies a transfer the payout sent. */
  async submit(
    merchantId: string,
    id: string,
    b: { authorization?: TransferAuthorization & { signature: Hex }; terms?: PaymentTerms; txHash?: Hex },
  ): Promise<RefundRow> {
    const r = this.get(merchantId, id);
    if (r.status !== "pending") throw new ApiError(409, "REFUND_NOT_PENDING", `refund is ${r.status}`);
    if (r.tx_hash) throw new ApiError(409, "REFUND_SUBMITTED", "refund was already submitted; it settles once confirmed");
    if (r.approval === "requested") throw new ApiError(409, "REFUND_APPROVAL_REQUIRED", "an Admin of this business must approve this refund request first");
    const p = this.#payments.row(r.payment_id)!;
    let receipt: TransactionReceipt | null;
    let method: "authorization" | "transfer";
    if (b.authorization) {
      const { signature, ...m } = b.authorization;
      if (!isAddressEqual(m.from, p.payout)) throw new ApiError(400, "REFUND_FROM_MISMATCH", "the authorization must come from the payout wallet");
      const terms = this.#rails.refundTerms(r.id, r.to_addr);
      if (
        b.terms &&
        (b.terms.paymentRef.toLowerCase() !== terms.paymentRef.toLowerCase() ||
          !isAddressEqual(b.terms.payout, terms.payout) ||
          !isAddressEqual(b.terms.feeRecipient, terms.feeRecipient) ||
          b.terms.fee !== terms.fee)
      ) {
        throw new ApiError(400, "REFUND_TERMS_MISMATCH", "terms must be the refund's terms: refundRef, payout = to, no fee");
      }
      if (!isAddressEqual(m.to, this.#rails.router)) throw new ApiError(400, "REFUND_TO_MISMATCH", "the authorization must be a ReceiveWithAuthorization to the PaymentRouter");
      if (m.value !== BigInt(r.amount)) throw new ApiError(400, "REFUND_AMOUNT_MISMATCH", "the authorization is for a different amount");
      if (m.nonce.toLowerCase() !== this.#rails.termsNonce(terms).toLowerCase()) {
        throw new ApiError(400, "REFUND_NONCE_MISMATCH", "nonce must be paymentTermsNonce of the refund terms (refundRef, to, no fee)");
      }
      const out = await this.#relay.relay("receive", this.#rails.routerCall(terms, m, signature), m, signature, BigInt(p.created_block), (hash) =>
        this.#recordTx(r.id, hash, "authorization"),
      );
      receipt = out.receipt;
      method = "authorization";
    } else if (b.txHash) {
      const other = this.#db.get<{ id: string }>("SELECT id FROM refunds WHERE tx_hash = ? AND id != ?", b.txHash.toLowerCase(), r.id);
      if (other) throw new ApiError(409, "REFUND_TX_USED", "this transaction already settles another refund");
      receipt = await this.#chain.receiptOf(b.txHash);
      if (!receipt) throw new ApiError(404, "TX_NOT_FOUND", "the transaction is not on chain (yet); submit again once it is mined");
      method = "transfer";
    } else {
      throw new ApiError(400, "VALIDATION_ERROR", "pass authorization or txHash");
    }
    if (!this.#matches(receipt, p.payout, r)) {
      if (method === "transfer") throw new ApiError(400, "REFUND_TRANSFER_MISMATCH", "the transaction has no transfer from the payout to `to` for exactly `amount`");
      this.#fail(r, "the relayed transaction carries no matching transfer");
      return this.get(merchantId, id);
    }
    this.#recordTx(r.id, receipt.transactionHash, method);
    await this.#confirm(this.get(merchantId, id), receipt);
    return this.get(merchantId, id);
  }

  #recordTx(id: string, hash: Hex, method: "authorization" | "transfer") {
    this.#db.run("UPDATE refunds SET tx_hash = ?, method = ?, updated_at = ? WHERE id = ?", hash.toLowerCase(), method, nowIso(), id);
  }

  /** A direct Transfer(payout, to, amount), or the router's PaymentRouted for this refund's terms. */
  #matches(receipt: TransactionReceipt, payout: Address, r: RefundRow): boolean {
    if (receipt.status !== "success") return false;
    const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => isAddressEqual(l.address, this.#chain.token)) });
    if (logs.some((l) => isAddressEqual(l.args.from, payout) && isAddressEqual(l.args.to, r.to_addr) && l.args.value === BigInt(r.amount))) return true;
    const routed = this.#rails.routedOf(receipt, this.#rails.refundTerms(r.id, r.to_addr).paymentRef, payout);
    return !!routed && isAddressEqual(routed.payout, r.to_addr) && routed.value === BigInt(r.amount) && routed.fee === 0n;
  }

  #fail(r: RefundRow, reason: string) {
    this.#db.tx(() => {
      this.#db.run("UPDATE refunds SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", reason, nowIso(), r.id);
      const row = this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!;
      this.#webhooks.emit(r.merchant_id, "refund.failed", r.id, r.payment_id, this.json(row));
    });
  }

  /** Succeeds the refund once its block is at or below the finality head; otherwise the worker retries. */
  async #confirm(r: RefundRow, receipt: TransactionReceipt): Promise<void> {
    const head = await this.#chain.headOf();
    if (receipt.blockNumber > head) return;
    this.#db.tx(() => {
      const cur = this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!;
      if (cur.status !== "pending") return;
      this.#db.run("UPDATE refunds SET status = 'succeeded', updated_at = ? WHERE id = ?", nowIso(), r.id);
      const total = this.#db.get<{ s: string }>("SELECT bigsum(amount) AS s FROM refunds WHERE payment_id = ? AND status = 'succeeded'", r.payment_id)!.s;
      this.#db.run("UPDATE payments SET amount_refunded = ?, updated_at = ? WHERE id = ?", total, nowIso(), r.payment_id);
      const row = this.#db.get<RefundRow>("SELECT * FROM refunds WHERE id = ?", r.id)!;
      this.#webhooks.emit(r.merchant_id, "refund.succeeded", r.id, r.payment_id, this.json(row));
    });
  }

  /** Worker: submitted refunds waiting for finality, re-proved against the chain (a reorg can remove the transfer). */
  async tick(): Promise<void> {
    const rows = this.#db.all<RefundRow>("SELECT * FROM refunds WHERE status = 'pending' AND tx_hash IS NOT NULL LIMIT 50");
    for (const r of rows) {
      try {
        const receipt = await this.#chain.receiptOf(r.tx_hash!);
        if (!receipt) continue; // reorged out or not yet indexed: wait (a payout transfer may be re-included)
        const p = this.#payments.row(r.payment_id)!;
        if (!this.#matches(receipt, p.payout, r)) this.#fail(r, "the transaction no longer carries the matching transfer");
        else await this.#confirm(r, receipt);
      } catch (err) {
        this.#log.warn("refund confirmation check failed", { refundId: r.id, err });
      }
    }
  }
}
