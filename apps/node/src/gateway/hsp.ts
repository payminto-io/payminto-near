import { getAddress, isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  HSP_CURRENCY,
  HSP_PAYMENT_STATUSES,
  hspAgenticTypedData,
  hspUsdAmount,
  isHspInFlight,
  type CheckoutHsp,
  type HspAvailability,
  type HspEip712Json,
  type HspPaymentStatus,
  type PaymentMethod,
} from "@payminto/protocol";
import type { HspMethodConfig } from "../config.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { nowIso } from "../store.ts";
import { HspError, type HspAgenticClient, type HspNetwork, type HspPrepared, type HspToken } from "../hsp/agentic.ts";
import { errMessage } from "../hsp/port.ts";
import { hspJson, isoOf, type PaymentRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";

/** A prepare_payment quote as stored (migration 010). */
export type HspQuoteRow = {
  id: number;
  payment_id: string;
  flow_id: string;
  payer: Address;
  protocol: string;
  pay_to: Address;
  token_total_raw: string;
  cart_hash: string;
  eip712: string;
  payment_payload: string;
  payment_mandate_contents: string;
  quote_expires_at: string;
  quote_expires_unix: number;
  status: "prepared" | "submitting" | "submitted" | "expired" | "failed";
  signature: Hex | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** What the payer gets back from prepare: the EIP-712 data to sign, exactly as HSP returned it. */
export type HspPrepareResult = {
  payment_id: string;
  flow_id: string;
  payment_request_id: string | null;
  protocol: string;
  eip712: HspEip712Json;
  token_total_raw: string;
  quote_expires_at: string;
  recipient: Address;
  payer: Address;
};

/** What the rail borrows from the gateway. */
export type HspRailHooks = {
  /** Refuses a payment nobody can pay now (terminal, expired, suspended merchant, money in flight). */
  assertPayable(p: PaymentRow): void;
  /** Re-quotes an untouched payment for HSP (its fees and forwarder). */
  requote(p: PaymentRow, method: PaymentMethod): PaymentRow;
  /** Intake screening of the payer and payout (section 13.1). */
  screen(p: PaymentRow, payer: Address): Promise<void>;
};

/** An unavailable HSP is re-checked on use at most this often. */
const RECHECK_SEC = 60;
/** A submission HSP never confirmed is given up this long after its quote expired, so the payer can try again. */
const UNCONFIRMED_GRACE_SEC = 600;

const MESSAGES: Record<NonNullable<HspAvailability["reason"]>, string> = {
  not_allowlisted: "Waiting for HSP access: HashKey has not allowlisted this server yet.",
  network_mismatch: "HSP does not support this server's network.",
  token_mismatch: "HSP does not support this server's token on this network.",
  unreachable: "HSP is not answering right now.",
  tools_missing: "The HSP server does not offer every tool this server needs.",
  error: "HSP could not be checked.",
};

/**
 * The HSP payment method (docs/GATEWAY.md section 17). One more way into the payment's fee-splitting forwarder:
 * the node creates one HSP order per payment (pay_to = the forwarder), hands the payer HSP's EIP-712 data, submits the
 * signature through finalize_payment and submit_payment, and polls query_payment. The HSP gateway broadcasts the
 * transfer; the deposit watcher sees it land in the forwarder and only that makes the payment paid, so fees, webhooks,
 * refunds and reports work exactly as for any deposit. HSP being unreachable never stops the node.
 */
export class HspRail {
  readonly #db: Database;
  readonly #payments: PaymentService;
  readonly #client: HspAgenticClient;
  readonly #config: HspMethodConfig;
  readonly #chainId: number;
  readonly #token: { address: Address; decimals: number };
  readonly #log: Logger;
  readonly #clock: () => number;
  readonly #hooks: HspRailHooks;
  #availability: HspAvailability = { state: "checking", reason: null, message: null, checked_at: null, network: null, protocol: null };
  #match: { network: HspNetwork; token: HspToken } | null = null;
  #checking: Promise<HspAvailability> | null = null;
  #checkedUnix = 0;
  readonly #ordering = new Map<string, Promise<PaymentRow>>();
  #polling: Promise<void> | null = null;

  constructor(o: {
    db: Database;
    payments: PaymentService;
    client: HspAgenticClient;
    config: HspMethodConfig;
    chainId: number;
    token: { address: Address; decimals: number };
    log: Logger;
    clock?: () => number;
    hooks: HspRailHooks;
  }) {
    this.#db = o.db;
    this.#payments = o.payments;
    this.#client = o.client;
    this.#config = o.config;
    this.#chainId = o.chainId;
    this.#token = o.token;
    this.#log = o.log;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
    this.#hooks = o.hooks;
  }

  get merchantName(): string {
    return this.#config.merchantName;
  }

  get pollIntervalMs(): number {
    return this.#config.pollIntervalMs;
  }

  // ------------------------------------------------------------------ availability

  availability(): HspAvailability {
    return { ...this.#availability };
  }

  /** Null when HSP can take payments now, else plain words for why not (PaymentService refuses the method with it). */
  unavailable(): string | null {
    return this.#availability.state === "available" ? null : (this.#availability.message ?? "HSP is being checked.");
  }

  /**
   * health, the eight tools, then get_chain_config: the method is on only when HSP lists this node's chain id and
   * token. Never throws; the outcome is the availability.
   */
  check(): Promise<HspAvailability> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #check(): Promise<HspAvailability> {
    const at = this.#clock();
    const set = (a: Omit<HspAvailability, "checked_at">) => {
      this.#checkedUnix = at;
      this.#availability = { ...a, checked_at: isoOf(at) };
      return this.availability();
    };
    const down = (reason: NonNullable<HspAvailability["reason"]>, detail: string) => {
      this.#match = null;
      if (this.#availability.reason !== reason) this.#log.warn("HSP payment method unavailable", { reason, detail });
      return set({ state: "unavailable", reason, message: MESSAGES[reason], network: null, protocol: null });
    };
    try {
      await this.#client.health();
      await this.#client.tools();
      const networks = await this.#client.getChainConfig();
      const network = networks.find((n) => n.chain_id === this.#chainId);
      if (!network) return down("network_mismatch", `HSP lists chain ids ${networks.map((n) => n.chain_id).join(", ") || "none"}, this node runs ${this.#chainId}`);
      const token = network.tokens.find((t) => isAddressEqual(t.address, this.#token.address));
      if (!token) return down("token_mismatch", `HSP lists no token ${this.#token.address} on ${network.network}`);
      if (token.decimals !== this.#token.decimals) return down("token_mismatch", `HSP says ${token.decimals} decimals, the token has ${this.#token.decimals}`);
      this.#match = { network, token };
      if (this.#availability.state !== "available") this.#log.info("HSP payment method available", { network: network.network, protocol: token.payment_protocol });
      return set({ state: "available", reason: null, message: null, network: network.network, protocol: token.payment_protocol });
    } catch (err) {
      const kind = err instanceof HspError ? err.kind : "error";
      const reason = kind === "not_allowlisted" || kind === "unreachable" || kind === "tools_missing" ? kind : "error";
      return down(reason, errMessage(err));
    }
  }

  /** Lazily re-checks a stale unavailable state, then refuses cleanly when HSP still cannot be used. */
  async #ready(): Promise<{ network: HspNetwork; token: HspToken }> {
    if (this.#availability.state !== "available" && (this.#checkedUnix === 0 || this.#clock() - this.#checkedUnix >= RECHECK_SEC)) await this.check();
    if (this.#availability.state !== "available" || !this.#match) {
      throw new ApiError(503, "HSP_UNAVAILABLE", this.unavailable()!, { reason: this.#availability.reason });
    }
    return this.#match;
  }

  /** The HSP part of the public checkout view. */
  checkout(p: PaymentRow): CheckoutHsp {
    return {
      availability: this.#availability.state,
      message: this.unavailable(),
      status: p.hsp_status,
      status_reason: p.hsp_status_reason,
      tx_hash: p.hsp_tx_hash,
      attribution_verified: p.hsp_attribution_verified === 1,
    };
  }

  // ------------------------------------------------------------------ order, prepare, submit

  /**
   * The cart mandate for a payment: id = the payment id, expiry = the payment's, amount in USD equal to the amount due
   * (the node's token is a USD stablecoin, so one token is quoted as one dollar), one x402 v2 method on the network and
   * token get_chain_config matched. No merchant_authorization: HSP's MCP server signs for the team.
   */
  cartMandate(p: PaymentRow, match: { network: HspNetwork; token: HspToken }, label: string): Record<string, unknown> {
    return {
      contents: {
        id: p.id,
        cart_expiry: p.expires_at,
        payment_request: {
          method_data: [{ supported_methods: ["https://www.x402.org/"], data: { x402Version: 2, network: match.network.network, token: match.token.address } }],
          details: {
            id: p.id,
            total: { label, amount: { currency: HSP_CURRENCY, value: hspUsdAmount(BigInt(p.amount_due), this.#token.decimals) } },
          },
        },
      },
    };
  }

  /** One HSP order per payment: created once, reused on every retry (concurrent callers share one create_order). */
  async #ensureOrder(p: PaymentRow, match: { network: HspNetwork; token: HspToken }, label: string): Promise<PaymentRow> {
    if (p.hsp_flow_id) return p;
    const inflight = this.#ordering.get(p.id);
    if (inflight) return inflight;
    const run = (async () => {
      const order = await this.#client
        .createOrder({ merchantName: this.#config.merchantName, payTo: p.deposit_address, cartMandate: this.cartMandate(p, match, label) })
        .catch((err) => {
          throw hspApiError(err, "create_order");
        });
      const at = nowIso();
      this.#db.run(
        `UPDATE payments SET hsp_flow_id = ?, hsp_payment_request_id = ?, hsp_payment_url = ?, hsp_status = 'order-created', hsp_updated_at = ?, updated_at = ?
         WHERE id = ? AND hsp_flow_id IS NULL`,
        order.flow_id,
        order.payment_request_id ?? null,
        order.payment_url ?? null,
        at,
        at,
        p.id,
      );
      return this.#payments.row(p.id)!;
    })().finally(() => this.#ordering.delete(p.id));
    this.#ordering.set(p.id, run);
    return run;
  }

  /**
   * prepare: locks an HSP quote for `payer` (5 minutes) and returns the EIP-712 data the payer signs. The quote is
   * refused unless it pays exactly the amount due, from this payer, into this payment's forwarder, in this token.
   */
  async prepare(paymentId: string, payer: Address, label: string): Promise<HspPrepareResult> {
    payer = getAddress(payer);
    const match = await this.#ready();
    let p = this.#row(paymentId);
    this.#assertOpenForHsp(p);
    p = this.#hooks.requote(p, "hsp");
    await this.#hooks.screen(p, payer);
    p = await this.#ensureOrder(p, match, label);
    const prepared = await this.#client.preparePayment({ flowId: p.hsp_flow_id!, payer, protocol: match.token.payment_protocol }).catch((err) => {
      throw hspApiError(err, "prepare_payment");
    });
    this.#checkQuote(p, payer, match, prepared);
    const at = nowIso();
    const quote = this.#db.tx(() => {
      // Only the newest quote of a payment can be submitted.
      this.#db.run("UPDATE hsp_quotes SET status = 'expired', updated_at = ? WHERE payment_id = ? AND status = 'prepared'", at, p.id);
      const id = this.#db.run(
        `INSERT INTO hsp_quotes (payment_id, flow_id, payer, protocol, pay_to, token_total_raw, cart_hash, eip712, payment_payload, payment_mandate_contents,
                                 quote_expires_at, quote_expires_unix, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        p.id,
        p.hsp_flow_id,
        payer,
        match.token.payment_protocol,
        prepared.pay_to,
        prepared.token_total_raw,
        prepared.cart_hash,
        JSON.stringify(prepared.eip712),
        JSON.stringify(prepared.payment_payload ?? null),
        JSON.stringify(prepared.payment_mandate_contents ?? null),
        isoOf(prepared.quote_expires_at),
        prepared.quote_expires_at,
        at,
        at,
      ).lastInsertRowid;
      return this.#db.get<HspQuoteRow>("SELECT * FROM hsp_quotes WHERE id = ?", id)!;
    });
    return {
      payment_id: p.id,
      flow_id: p.hsp_flow_id!,
      payment_request_id: prepared.payment_request_id ?? p.hsp_payment_request_id,
      protocol: quote.protocol,
      eip712: prepared.eip712 as HspEip712Json,
      token_total_raw: quote.token_total_raw,
      quote_expires_at: quote.quote_expires_at,
      recipient: quote.pay_to,
      payer,
    };
  }

  /** HSP's quote must be exactly this payment: payer, forwarder, amount due, chain and token. */
  #checkQuote(p: PaymentRow, payer: Address, match: { network: HspNetwork; token: HspToken }, q: HspPrepared) {
    const bad = (why: string) => {
      this.#log.warn("HSP quote refused", { paymentId: p.id, why });
      return new ApiError(502, "HSP_QUOTE_MISMATCH", `HSP returned a quote that does not match this payment: ${why}`);
    };
    if (!isAddressEqual(q.payer, payer)) throw bad("payer");
    if (!isAddressEqual(q.pay_to, p.deposit_address)) throw bad("recipient is not this payment's forwarder (the order may be for an earlier quote)");
    if (q.token_total_raw !== p.amount_due) throw bad(`amount ${q.token_total_raw} is not the amount due ${p.amount_due}`);
    if (q.quote_expires_at <= this.#clock()) throw bad("the quote is already expired");
    const e = q.eip712;
    const chainId = e.domain.chainId === undefined ? null : Number(e.domain.chainId);
    if (chainId !== this.#chainId) throw bad("chain id");
    const m = e.message as Record<string, unknown>;
    if (match.token.payment_protocol === "eip3009") {
      if (e.primaryType !== "TransferWithAuthorization") throw bad(`primary type ${e.primaryType}`);
      if (typeof e.domain.verifyingContract !== "string" || !isAddressEqual(e.domain.verifyingContract as Address, this.#token.address)) throw bad("token");
      if (!sameAddress(m.from, payer) || !sameAddress(m.to, p.deposit_address) || String(m.value) !== p.amount_due) throw bad("signed transfer");
    } else {
      const permitted = (m.permitted ?? {}) as Record<string, unknown>;
      if (!sameAddress(permitted.token, this.#token.address) || String(permitted.amount) !== p.amount_due) throw bad("permitted token or amount");
    }
  }

  /**
   * submit: finalize_payment then submit_payment with the signature over the quote this payer prepared. A signature is
   * submitted once: the same signature again returns the current status, an expired quote must be prepared and signed
   * again (error 30043 included), and an uncertain submission is queried, never resent.
   */
  async submit(paymentId: string, payer: Address, signature: Hex) {
    payer = getAddress(payer);
    const p = this.#row(paymentId);
    const q = this.#db.get<HspQuoteRow>("SELECT * FROM hsp_quotes WHERE payment_id = ? AND payer = ? ORDER BY id DESC LIMIT 1", p.id, payer);
    if (!q) throw new ApiError(409, "HSP_NOT_PREPARED", "prepare this HSP payment first");
    if (q.status === "submitted" || q.status === "submitting") {
      if (q.signature?.toLowerCase() === signature.toLowerCase()) return this.#result(this.#row(p.id));
      throw new ApiError(409, "HSP_ALREADY_SUBMITTED", "an HSP payment for this checkout was already submitted");
    }
    if (isHspInFlight(p.hsp_status)) throw new ApiError(409, "HSP_ALREADY_SUBMITTED", "an HSP payment for this checkout was already submitted");
    if (q.status !== "prepared") throw new ApiError(409, "HSP_QUOTE_EXPIRED", "this HSP quote is no longer valid; prepare and sign again");
    // The payment must still be exactly what was quoted: same forwarder, same amount, nothing paid since, same payer.
    if (!isAddressEqual(q.pay_to, p.deposit_address) || q.token_total_raw !== p.amount_due || p.amount_paid !== "0" || q.flow_id !== p.hsp_flow_id) {
      this.#expire(q, "payment changed since the quote");
      throw new ApiError(409, "HSP_QUOTE_MISMATCH", "the payment changed since this quote; prepare and sign again");
    }
    this.#hooks.assertPayable(p);
    if (this.#clock() >= q.quote_expires_unix) {
      this.#expire(q, "quote expired");
      throw new ApiError(409, "HSP_QUOTE_EXPIRED", "the HSP quote expired; prepare and sign again");
    }
    const eip712 = JSON.parse(q.eip712) as HspEip712Json;
    const signer = await recoverTypedDataAddress({ ...(hspAgenticTypedData(eip712) as Parameters<typeof recoverTypedDataAddress>[0]), signature }).catch(() => null);
    if (!signer || !isAddressEqual(signer, payer)) throw new ApiError(400, "BAD_SIGNATURE", "the signature does not recover to the payer over the prepared HSP data");
    await this.#hooks.screen(p, payer);
    const claimed = this.#db.run("UPDATE hsp_quotes SET status = 'submitting', signature = ?, updated_at = ? WHERE id = ? AND status = 'prepared'", signature, nowIso(), q.id);
    if (claimed.changes === 0) throw new ApiError(409, "HSP_SUBMIT_IN_PROGRESS", "this HSP payment is being submitted");

    let status: HspPaymentStatus = "payment-submitted";
    let reason: string | null = null;
    try {
      const { paymentMandateJson } = await this.#client.finalizePayment({
        signature,
        paymentPayload: JSON.parse(q.payment_payload),
        paymentMandateContents: JSON.parse(q.payment_mandate_contents),
        cartHash: q.cart_hash,
      });
      const out = await this.#client.submitPayment({ paymentMandateJson });
      status = asStatus(out.status) ?? "payment-submitted";
    } catch (err) {
      if (err instanceof HspError && err.kind === "requote") {
        this.#expire(q, err.message);
        throw new ApiError(409, "HSP_QUOTE_EXPIRED", "the HSP quote expired; prepare and sign again", { hsp_code: err.code });
      }
      if (err instanceof HspError && err.kind === "unreachable") {
        // The submission may have gone through: ask HSP before anything else, and never send this signature again.
        const known = await this.#client.queryPayment({ flowId: q.flow_id, expectedMerchantName: this.#config.merchantName }).catch(() => null);
        status = known?.status ?? "payment-submitted";
        reason = known ? known.statusReason : "submission not confirmed by HSP yet";
        this.#log.warn("HSP submission uncertain; tracking it by query_payment", { paymentId: p.id, flowId: q.flow_id, known: known?.status ?? null });
      } else {
        this.#db.run("UPDATE hsp_quotes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", errMessage(err).slice(0, 300), nowIso(), q.id);
        throw hspApiError(err, "submit_payment");
      }
    }
    const at = nowIso();
    this.#db.tx(() => {
      this.#db.run("UPDATE hsp_quotes SET status = 'submitted', updated_at = ? WHERE id = ?", at, q.id);
      this.#db.run(
        `UPDATE payments SET hsp_status = ?, hsp_status_reason = ?, hsp_payer = ?, hsp_submitted_at = ?, hsp_updated_at = ?, hsp_next_poll_unix = ?, updated_at = ? WHERE id = ?`,
        status,
        reason,
        payer,
        at,
        at,
        this.#clock(),
        at,
        p.id,
      );
      // A signed, submitted payment is a real payment attempt: a draft becomes visible (payment.created).
      if (p.draft) this.#payments.promote(p.id);
      this.#payments.notify(p.id);
    });
    return this.#result(this.#row(p.id));
  }

  #result(p: PaymentRow) {
    return { payment: p, hsp: hspJson(p) };
  }

  #expire(q: HspQuoteRow, why: string) {
    this.#db.run("UPDATE hsp_quotes SET status = 'expired', error = ?, updated_at = ? WHERE id = ? AND status IN ('prepared', 'submitting')", why.slice(0, 300), nowIso(), q.id);
  }

  #assertOpenForHsp(p: PaymentRow) {
    this.#hooks.assertPayable(p);
    if (isHspInFlight(p.hsp_status)) throw new ApiError(409, "HSP_ALREADY_SUBMITTED", "an HSP payment for this checkout was already submitted");
    if (p.amount_paid !== "0" || this.#payments.credits(p.id).length > 0) throw new ApiError(409, "PAYMENT_PARTIALLY_PAID", "HSP payments need an untouched payment");
  }

  #row(id: string): PaymentRow {
    const p = this.#payments.row(id);
    if (!p) throw new ApiError(404, "NOT_FOUND", "payment not found");
    return p;
  }

  // ------------------------------------------------------------------ poller

  /**
   * Polls query_payment for every payment in flight, each at most once per HSP_POLL_INTERVAL_MS, and re-checks an
   * unavailable HSP once a minute. Stores HSP's status next to the payment; never changes the payment's state.
   */
  tick(): Promise<void> {
    this.#polling ??= this.#tick().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  async #tick(): Promise<void> {
    if (this.#availability.state !== "available" && this.#clock() - this.#checkedUnix >= RECHECK_SEC) await this.check();
    const now = this.#clock();
    const live = HSP_PAYMENT_STATUSES.filter((s) => isHspInFlight(s));
    const due = this.#db.all<PaymentRow>(
      `SELECT * FROM payments WHERE hsp_status IN (${live.map(() => "?").join(", ")}) AND (hsp_next_poll_unix IS NULL OR hsp_next_poll_unix <= ?)
       ORDER BY hsp_next_poll_unix LIMIT 50`,
      ...live,
      now,
    );
    const next = now + Math.ceil(this.#config.pollIntervalMs / 1000);
    for (const p of due) {
      try {
        const q = await this.#client.queryPayment({ flowId: p.hsp_flow_id!, expectedMerchantName: this.#config.merchantName });
        this.#store(p, { status: q.status, reason: q.statusReason, tx: q.txHash ?? p.hsp_tx_hash, attributed: q.attributionVerified, next: isHspInFlight(q.status) ? next : null });
      } catch (err) {
        if (this.#unconfirmedTooLong(p)) {
          this.#store(p, { status: "payment-failed", reason: "HSP never confirmed the submission; try again", tx: p.hsp_tx_hash, attributed: false, next: null });
          continue;
        }
        this.#db.run("UPDATE payments SET hsp_next_poll_unix = ? WHERE id = ?", next, p.id);
        this.#log.warn("HSP query_payment failed; retrying", { paymentId: p.id, flowId: p.hsp_flow_id, err: errMessage(err) });
      }
    }
  }

  /** A submission HSP has no record of, long after its quote expired. */
  #unconfirmedTooLong(p: PaymentRow): boolean {
    if (p.hsp_status !== "payment-submitted" || p.hsp_status_reason !== "submission not confirmed by HSP yet") return false;
    const q = this.#db.get<{ quote_expires_unix: number }>("SELECT quote_expires_unix FROM hsp_quotes WHERE payment_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1", p.id);
    return !!q && this.#clock() > q.quote_expires_unix + UNCONFIRMED_GRACE_SEC;
  }

  #store(p: PaymentRow, s: { status: HspPaymentStatus; reason: string | null; tx: Hex | null; attributed: boolean; next: number | null }) {
    const changed =
      s.status !== p.hsp_status || (s.reason ?? null) !== p.hsp_status_reason || (s.tx ?? null) !== p.hsp_tx_hash || (s.attributed ? 1 : 0) !== p.hsp_attribution_verified;
    const at = nowIso();
    this.#db.run(
      `UPDATE payments SET hsp_status = ?, hsp_status_reason = ?, hsp_tx_hash = ?, hsp_attribution_verified = ?, hsp_next_poll_unix = ?,
                           hsp_updated_at = CASE WHEN ? THEN ? ELSE hsp_updated_at END WHERE id = ?`,
      s.status,
      s.reason ?? null,
      s.tx ?? null,
      s.attributed ? 1 : 0,
      s.next,
      changed ? 1 : 0,
      at,
      p.id,
    );
    if (changed) {
      if (s.status === "payment-failed") this.#log.warn("HSP payment failed", { paymentId: p.id, flowId: p.hsp_flow_id, reason: s.reason });
      this.#payments.notify(p.id);
    }
  }

  async close(): Promise<void> {
    await this.#polling?.catch(() => {});
    await this.#client.close();
  }
}

const asStatus = (s: string): HspPaymentStatus | null => ((HSP_PAYMENT_STATUSES as readonly string[]).includes(s) ? (s as HspPaymentStatus) : null);

const sameAddress = (a: unknown, b: Address) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && isAddressEqual(a as Address, b);

/** An HspError as the API error the payer sees. */
function hspApiError(err: unknown, tool: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof HspError) {
    if (err.kind === "not_allowlisted") return new ApiError(503, "HSP_UNAVAILABLE", MESSAGES.not_allowlisted, { reason: "not_allowlisted" });
    if (err.kind === "unreachable") return new ApiError(503, "HSP_UNAVAILABLE", MESSAGES.unreachable, { reason: "unreachable" });
    if (err.kind === "requote") return new ApiError(409, "HSP_QUOTE_EXPIRED", "the HSP quote expired; prepare and sign again", { hsp_code: err.code });
    return new ApiError(502, "HSP_ERROR", `HSP ${tool} failed: ${err.message}`, err.code !== null ? { hsp_code: err.code } : undefined);
  }
  return new ApiError(502, "HSP_ERROR", `HSP ${tool} failed: ${errMessage(err)}`);
}
