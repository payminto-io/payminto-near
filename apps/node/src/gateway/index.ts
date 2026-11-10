import { createHash } from "node:crypto";
import {
  canonicalOrder,
  isLivemode,
  isTerminalPaymentStatus,
  linkUrl,
  MIN_EXPIRES_IN_SECONDS,
  networkFor,
  PAYOUT_PROOF_MAX_AGE_SECONDS,
  SCHEME,
  verifyPayoutProofSignature,
  X402_VERSION,
  type AccountId,
  type CheckoutView,
  type CheckoutWallet,
  type Id32,
  type Network,
  type PaymentMethod,
  type PaymentProof,
  type PayoutProof,
} from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { GatewayConfig } from "../config.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { AccessKeyReader, TxReader } from "../near-rpc.ts";
import type { PayoutService } from "../payouts.ts";
import { receiptVerifiedOnchain } from "../proofs.ts";
import { receiptFieldsOf, type SettlementService } from "../settlement.ts";
import { nowIso, type CallRow, type ProviderRow } from "../store.ts";
import { callIdOf, type DenialNotice, type VoucherInput, type VoucherService } from "../vouchers.ts";
import { WalletRail, type CheckoutRail } from "./checkout.ts";
import { ApiKeyService, Idempotency } from "./keys.ts";
import { LinkService } from "./links.ts";
import { MerchantService, type MerchantRow, type PayoutProofRecord } from "./merchants.ts";
import { isoOf, refusalJson, type CreditRow, type LinkRow, type ModelContext, type PaymentRow } from "./model.ts";
import { PaymentService } from "./payments.ts";
import { RefundService } from "./refunds.ts";
import { Screening } from "./screening.ts";
import { PaymentWatcher } from "./watcher.ts";
import { WebhookService, type WebhookSender } from "./webhooks.ts";
import { IntentsRail, IntentsService, IntentsWatcher, type IntentsKit } from "./intents.ts";
import type { IntentsChainReader } from "./intents-rpc.ts";
// Types only: erased at runtime, so the core still loads @payminto/near-addons only through server.ts's dynamic import.
import type { FetchLike as OneClickFetch } from "@payminto/near-addons/intents";
import type { PaymentRequiredV2, VoucherRequirement } from "./x402-wire.ts";

const MAX_X402_TIMEOUT_SEC = 300;

export type GatewayDeps = {
  config: GatewayConfig;
  network: Network;
  db: Database;
  chain: ChainClient;
  vouchers: VoucherService;
  settlement: SettlementService;
  payouts: PayoutService;
  log: Logger;
  token: { address: AccountId; symbol: string; decimals: number };
  /** Public URL of this node (voucher requirements and receipt proof links name it). */
  publicUrl: string;
  /** NEAR RPC reads the `Chain` seam does not carry; null on the in-memory test chain. */
  accessKeys: AccessKeyReader | null;
  txs: TxReader | null;
  /**
   * The any-chain checkout, when INTENTS_CHECKOUT is not off: @payminto/near-addons/intents as loaded by server.ts with a
   * dynamic import, and the NEAR reader of the chain the USDC lands on.
   */
  intents?: { kit: IntentsKit; reader: IntentsChainReader; fetch?: OneClickFetch } | null;
  /** Test seams. */
  clock?: () => number;
  webhookSender?: WebhookSender;
};

/**
 * Payminto Gateway inside the clearing node: merchants and fees, payments and their state machine, the NEAR checkout
 * rail (node-signed terms paid by the shopper's wallet through the hub), vouchers, refunds the merchant sends itself,
 * webhooks, screening, proofs and the service directory.
 */
export class Gateway {
  readonly config: GatewayConfig;
  readonly ctx: ModelContext;
  readonly network: Network;
  readonly db: Database;
  readonly chain: ChainClient;
  readonly log: Logger;
  readonly token: { address: AccountId; symbol: string; decimals: number };
  readonly merchants: MerchantService;
  readonly webhooks: WebhookService;
  readonly payments: PaymentService;
  readonly links: LinkService;
  readonly refunds: RefundService;
  readonly screening: Screening;
  readonly keys: ApiKeyService;
  readonly idempotency: Idempotency;
  readonly watcher: PaymentWatcher;
  readonly wallet: WalletRail;
  /** Checkout rails by method. The wallet rail is built in; the add-ons layer may register more (any-chain checkout). */
  readonly rails = new Map<string, CheckoutRail>();
  /** The any-chain checkout (`oneclick`); null with INTENTS_CHECKOUT=off. */
  readonly intents: IntentsService | null;
  readonly intentsWatcher: IntentsWatcher | null;
  readonly accessKeys: AccessKeyReader | null;
  readonly #vouchers: VoucherService;
  readonly #payouts: PayoutService;
  readonly #publicUrl: string;
  readonly #clock: () => number;
  readonly #timers: NodeJS.Timeout[] = [];
  #stopped = false;

  private constructor(d: GatewayDeps) {
    this.config = d.config;
    this.network = d.network;
    this.db = d.db;
    this.chain = d.chain;
    this.log = d.log;
    this.token = d.token;
    this.accessKeys = d.accessKeys;
    this.#vouchers = d.vouchers;
    this.#payouts = d.payouts;
    this.#publicUrl = d.publicUrl;
    this.#clock = d.clock ?? (() => Math.floor(Date.now() / 1000));
    this.ctx = { network: d.network, livemode: isLivemode(d.network), hub: d.chain.hub, token: d.token.address, checkoutBaseUrl: d.config.checkoutBaseUrl };
    this.wallet = new WalletRail(d.chain);
    this.rails.set(this.wallet.method, this.wallet);
    this.merchants = new MerchantService({ db: d.db, ctx: this.ctx, checkoutKey: d.chain.nodeKey });
    this.webhooks = new WebhookService({ db: d.db, ctx: this.ctx, log: d.log.child({ component: "webhooks" }), allowPrivate: d.config.webhookAllowPrivate, clock: d.clock, send: d.webhookSender });
    this.payments = new PaymentService({ db: d.db, ctx: this.ctx, merchants: this.merchants, webhooks: this.webhooks, clock: d.clock, ttlSec: d.config.checkoutTtlSec });
    this.links = new LinkService(d.db, this.ctx);
    this.refunds = new RefundService({ db: d.db, chain: d.chain, ctx: this.ctx, payments: this.payments, webhooks: this.webhooks, txs: d.txs, log: d.log.child({ component: "refunds" }), clock: d.clock });
    this.screening = new Screening({ db: d.db, clock: d.clock });
    this.keys = new ApiKeyService(d.db, this.ctx.livemode);
    this.idempotency = new Idempotency(d.db, d.clock);
    if (d.config.intents && d.intents) {
      this.intents = new IntentsService({
        config: d.config.intents,
        kit: d.intents.kit,
        reader: d.intents.reader,
        ...(d.intents.fetch ? { fetch: d.intents.fetch } : {}),
        db: d.db,
        payments: this.payments,
        merchants: this.merchants,
        webhooks: this.webhooks,
        log: d.log.child({ component: "intents" }),
        hub: d.chain.hub,
        clock: this.#clock,
      });
      this.intentsWatcher = new IntentsWatcher(this.intents, d.log.child({ component: "intents" }));
      this.rails.set("oneclick", new IntentsRail(this.intents));
      this.merchants.listIntentsMethod();
      const intents = this.intents;
      this.payments.intentsOf = (id) => intents.paymentIntents(id);
      this.payments.intentsSummaries = (ids) => intents.summaries(ids);
    } else {
      this.intents = null;
      this.intentsWatcher = null;
    }
    this.watcher = new PaymentWatcher({
      db: d.db,
      chain: d.chain,
      payments: this.payments,
      log: d.log.child({ component: "checkout" }),
      onRecorded: (p, merchant, payer) => {
        // The hub credited the merchant: queue its payout in the same transaction.
        this.#payouts.enqueue(merchant);
        // The payer is known only now, so a blocked payer can only be recorded for the business to refund.
        if (this.screening.denied(p.merchant_id, payer)) this.screening.record({ merchantId: p.merchant_id, stage: "wallet", payout: p.payout, payer, paymentId: p.id, linkId: p.link_id, amount: BigInt(p.amount_due) }, "PAYER_DENIED", { payer });
      },
    });
    d.settlement.confirmHooks.push((b) => this.#onBatchConfirmed(b));
    d.settlement.sellerSettledHooks.push((s) => this.#onSellerSettled(s));
  }

  /** Seeds the platform, the zero fee plan and the default merchant. */
  static async create(d: GatewayDeps): Promise<Gateway> {
    const g = new Gateway(d);
    const seeded = g.merchants.seed({ platformName: d.config.platformName, feeRecipient: d.config.feeRecipient, seedPayout: d.config.seedPayout });
    if (seeded.seedPayoutIgnored) d.log.warn("GATEWAY_PAYOUT_ACCOUNT only seeds the first merchant; change payouts with POST /v1/merchants/{id}/payout", {});
    return g;
  }

  // ------------------------------------------------------------------ workers

  start(intervals: { watchMs: number }) {
    const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
      let busy = false;
      const t = setInterval(() => {
        if (busy || this.#stopped) return;
        busy = true;
        fn()
          .catch((err) => this.log.warn(`${name} failed`, { err }))
          .finally(() => {
            busy = false;
          });
      }, ms);
      t.unref();
      this.#timers.push(t);
    };
    every(intervals.watchMs, "checkout watcher", () => this.watcher.tick());
    const intentsWatcher = this.intentsWatcher;
    if (intentsWatcher) every(Math.min(intervals.watchMs, 5_000), "any-chain watcher", () => intentsWatcher.tick());
    every(1_000, "webhooks", () => this.webhooks.tick());
    every(5_000, "payment expiry", async () => this.payments.expireDue());
    every(5_000, "refund confirmation", () => this.refunds.tick());
    every(3_600_000, "idempotency prune", async () => this.idempotency.prune());
    this.webhooks.onDue(() => void this.webhooks.tick().catch((err) => this.log.warn("webhooks failed", { err })));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.webhooks.onDue(null);
    await Promise.allSettled([this.watcher.tick(), this.webhooks.tick(), ...(this.intentsWatcher ? [this.intentsWatcher.tick()] : [])].map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 10_000).unref())])));
  }

  now(): number {
    return this.#clock();
  }

  // ------------------------------------------------------------------ payout proofs

  /**
   * Checks a NEP-413 payout proof: signed within PAYOUT_PROOF_MAX_AGE_SECONDS, over the message bound to this merchant
   * (or "new"), this network and this hub, by a key that is a full-access key of the payout account right now. The key
   * check is a chain read (view_access_key); without a reader the node cannot check it and refuses the proof.
   */
  async verifyPayoutProof(merchantId: string, proof: PayoutProof): Promise<PayoutProofRecord> {
    const age = this.now() - proof.timestamp;
    if (age > PAYOUT_PROOF_MAX_AGE_SECONDS || age < -60) throw new ApiError(400, "PAYOUT_PROOF_EXPIRED", `the signed timestamp must be within ${PAYOUT_PROOF_MAX_AGE_SECONDS}s`);
    if (!verifyPayoutProofSignature(proof, merchantId, { network: this.network, hub: this.chain.hub })) {
      throw new ApiError(400, "PAYOUT_PROOF_INVALID", "the signature does not match the payout proof message for this merchant and node");
    }
    if (!this.accessKeys) throw new ApiError(503, "PAYOUT_PROOF_UNAVAILABLE", "this node has no NEAR RPC to check the signing key; set the payout with GATEWAY_PAYOUT_ACCOUNT instead");
    const kind = await this.accessKeys.accessKey(proof.payout, proof.public_key).catch((err: unknown) => {
      this.log.warn("view_access_key failed", { account: proof.payout, err });
      throw new ApiError(503, "CHAIN_UNAVAILABLE", "could not read the account's keys from NEAR; try again");
    });
    if (kind !== "full_access") {
      throw new ApiError(400, "PAYOUT_PROOF_INVALID", kind === "function_call" ? "the signing key is a function-call key; sign with a full-access key of the payout account" : "the signing key is not a key of the payout account");
    }
    return { signature: proof.signature, publicKey: proof.public_key, signedAt: proof.timestamp };
  }

  // ------------------------------------------------------------------ public views

  /** Methods a person can use on the hosted page right now (agents pay through x402). */
  #personMethods(p: PaymentRow, m: MerchantRow): PaymentMethod[] {
    if (isTerminalPaymentStatus(p.status) || this.#clock() >= p.expires_unix || m.status !== "active") return [];
    if (BigInt(p.amount_due) - BigInt(p.amount_paid) <= 0n) return [];
    const methods: PaymentMethod[] = [];
    const quoted = p.quote_method === "wallet" || (p.quote_method === null && this.#quotes(m, BigInt(p.amount), "wallet")) || (p.status === "open" && p.amount_paid === "0" && this.#quotes(m, BigInt(p.amount), "wallet"));
    if (quoted && this.payments.credits(p.id).length === 0) methods.push("wallet");
    // The any-chain rail is an add-on, so `oneclick` is not a core PaymentMethod; the wire carries it all the same.
    if (this.intents?.availability(p, m).available) methods.push("oneclick" as PaymentMethod);
    return methods;
  }

  /** True when a payment quoted without a method already has the wallet quote's amounts (no wallet surcharge). */
  #walletQuoteIs(m: MerchantRow, p: PaymentRow): boolean {
    try {
      const q = this.payments.quote(m, BigInt(p.amount), "wallet");
      return q.amount_due.toString() === p.amount_due && q.fee_total.toString() === p.fee_total;
    } catch {
      return false;
    }
  }

  #quotes(m: MerchantRow, amount: bigint, method: PaymentMethod): boolean {
    try {
      this.payments.quote(m, amount, method);
      return true;
    } catch {
      return false;
    }
  }

  /** CheckoutView (protocol type) plus dashboard extras. Never metadata, email, name, fees or API data. */
  checkoutView(p: PaymentRow): CheckoutView & Record<string, unknown> {
    const m = this.merchants.merchant(p.merchant_id);
    const remaining = BigInt(p.amount_due) - BigInt(p.amount_paid);
    const methods = this.#personMethods(p, m);
    const credits = this.payments.credits(p.id);
    const lastConfirmed = [...credits].reverse().find((c) => c.status === "confirmed" && c.tx_hash) ?? null;
    // The wallet terms are for the amount due at the wallet quote; a payment quoted for vouchers is re-quoted first.
    let wallet: CheckoutWallet | null = null;
    if (methods.includes("wallet") && (p.quote_method === "wallet" || (p.quote_method === null && this.#walletQuoteIs(m, p)))) wallet = this.wallet.offer(p);
    const link = p.link_id ? this.db.get<LinkRow>("SELECT * FROM payment_links WHERE id = ?", p.link_id) : undefined;
    return {
      id: p.id,
      livemode: this.ctx.livemode,
      status: p.status,
      late: p.late === 1,
      merchant: { id: m.id, name: m.name, support_email: m.support_email, brand_color: m.brand_color, logo_url: m.logo_url },
      description: p.description,
      reference: p.reference,
      amount: p.amount,
      surcharge: p.surcharge,
      amount_due: p.amount_due,
      amount_paid: p.amount_paid,
      amount_remaining: (remaining > 0n ? remaining : 0n).toString(),
      network: this.network,
      hub: this.chain.hub,
      token: this.token,
      method: p.quote_method as PaymentMethod | null,
      methods,
      wallet,
      // The any-chain checkout: null when INTENTS_CHECKOUT is off.
      intents: this.intents ? this.intents.checkout(p) : null,
      success_url: p.success_url,
      tx_hash: lastConfirmed?.tx_hash ?? p.wallet_tx_hash ?? null,
      order_hash: p.order_hash,
      expires_at: p.expires_at,
      created_at: p.created_at,
      // Dashboard extras.
      link: link ? { slug: link.slug, active: link.active === 1 } : null,
      paid_at: p.paid_at,
      payer: p.payer,
      payout: p.payout,
      checkout_id: p.checkout_id,
    };
  }

  publicLink(l: LinkRow) {
    const m = this.merchants.merchant(l.merchant_id);
    return {
      slug: l.slug,
      livemode: this.ctx.livemode,
      title: l.title,
      description: l.description,
      amount: l.amount,
      min_amount: l.min_amount,
      max_amount: l.max_amount,
      collect_email: l.collect_email === 1,
      collect_name: l.collect_name === 1,
      active: l.active === 1 && m.status === "active" && m.payout_set !== 0 && !(l.expires_at && Date.parse(l.expires_at) <= Date.now()),
      expires_at: l.expires_at ?? null,
      methods: this.#publicMethods(m, l),
      // Whether "Any chain" is offered on this link; null when the node does not run the any-chain checkout.
      intents: this.intents ? this.intents.linkOffer(m, l.amount === null ? null : BigInt(l.amount)) : null,
      merchant: { id: m.id, name: m.name, support_email: m.support_email, brand_color: m.brand_color, logo_url: m.logo_url },
      network: this.network,
      token: this.token,
      url: linkUrl(this.ctx.checkoutBaseUrl, l.slug),
    };
  }

  /** What a customer pays on top of the price per enabled method: only the customer-borne method fee. */
  #publicMethods(m: MerchantRow, l: LinkRow) {
    return this.merchants
      .methods(m.id)
      .filter((r) => r.enabled === 1 && (r.method === "wallet" || r.method === "voucher" || (r.method === "oneclick" && !!this.intents?.verified(m))))
      .map((r) => {
        const customer = r.bearer === "customer";
        let quote: { amount: string; surcharge: string; amount_due: string } | null = null;
        if (l.amount !== null) {
          try {
            const q = this.payments.quote(m, BigInt(l.amount), r.method as PaymentMethod);
            quote = { amount: q.amount.toString(), surcharge: q.surcharge.toString(), amount_due: q.amount_due.toString() };
          } catch {
            quote = null; // outside this method's limits: the method is not offered for this amount
          }
        }
        return { method: r.method, enabled: true, surcharge_bps: customer ? r.fee_bps : 0, surcharge_fixed: customer ? r.fee_fixed : "0", quote };
      });
  }

  #assertPayable(p: PaymentRow) {
    const m = this.merchants.merchant(p.merchant_id);
    if (m.status !== "active") throw new ApiError(403, "MERCHANT_SUSPENDED", "this merchant is suspended");
    if (isTerminalPaymentStatus(p.status) || this.#clock() >= p.expires_unix) throw new ApiError(409, "PAYMENT_NOT_PAYABLE", `payment is ${p.status === "open" ? "expired" : p.status}`);
    if (p.status === "processing") throw new ApiError(409, "PAYMENT_PROCESSING", "a payment for this checkout is already being confirmed");
  }

  /**
   * The checkout page's wallet reported its transaction: keep the hash for the success screen and ask the hub now
   * instead of waiting for the next poll. The hash is never evidence: only the hub's record of the checkout id is.
   */
  async walletSent(p: PaymentRow, txHash: string | null): Promise<PaymentRow> {
    if (txHash) this.payments.setWalletTxHash(p.id, txHash);
    await this.watcher.check(this.payments.row(p.id)!).catch((err) => this.log.warn("checkout check failed; the watcher retries", { paymentId: p.id, err }));
    return this.payments.row(p.id)!;
  }

  // ------------------------------------------------------------------ vouchers

  /** The voucher payees of a payment's amounts: the merchant net, plus the platform fee when there is one. */
  voucherSplit(m: MerchantRow, q: { net_amount: bigint; fee_total: bigint }): Array<{ provider: ProviderRow; amount: bigint }> {
    const out = [{ provider: this.merchants.provider(m.id), amount: q.net_amount }];
    if (q.fee_total > 0n) {
      const fee = this.merchants.feeProvider();
      if (!fee) throw new ApiError(409, "FEE_RECIPIENT_REQUIRED", "fees need PLATFORM_FEE_ACCOUNT");
      out.push({ provider: fee, amount: q.fee_total });
    }
    return out.filter((s) => s.amount > 0n);
  }

  /**
   * Accepts the vouchers that pay a payment: one per split (merchant net, platform fee). All are checked against the
   * agent's Budget policy like any clearing call and booked in one BEGIN IMMEDIATE transaction with their payment
   * credits, or none is. A retry of the same vouchers returns the receipts already issued. The payment is processing
   * until the clearing batch that settles the calls is confirmed.
   */
  async payVouchers(p: PaymentRow, vouchers: VoucherInput[]) {
    const callIds = vouchers.map((v) => callIdOf(v));
    const replay = this.#voucherReplay(p, callIds, vouchers);
    // Stored receipts go back only to whoever holds the agent's signatures over exactly these vouchers.
    if (replay && vouchers.every((v) => this.#vouchers.isSignedByAgent(v))) return replay;
    // Before anything is checked or recorded for the payer (screening decisions name the Budget owner): vouchers the
    // Budget's agent key did not sign are nobody's payment, and get the plain error.
    for (const v of vouchers) this.#vouchers.signedBudget(v);
    this.#assertPayable(p);
    if (p.quote_method !== "voucher") {
      if (p.status === "open" && p.amount_paid === "0" && this.payments.credits(p.id).length === 0) p = this.payments.requote(p, "voucher");
      else if (!this.merchants.method(p.merchant_id, "voucher").enabled) throw new ApiError(409, "METHOD_DISABLED", "voucher payments are disabled for this merchant");
    }
    if (BigInt(p.amount_paid) !== 0n || this.payments.credits(p.id).length > 0) throw new ApiError(409, "PAYMENT_PARTIALLY_PAID", "voucher payments need an untouched payment");
    const m = this.merchants.merchant(p.merchant_id);
    const split = this.voucherSplit(m, { net_amount: BigInt(p.net_amount), fee_total: BigInt(p.fee_total) });
    if (vouchers.length !== split.length) throw new ApiError(402, "VOUCHER_MISSING", `exactly ${split.length} voucher(s) are required, one per split`);
    const items = split.map((s) => {
      const v = vouchers.find((x) => x.payee === s.provider.payee);
      if (!v) throw new ApiError(402, "VOUCHER_MISSING", `a voucher to ${s.provider.payee} for ${s.amount} is required`);
      if (v.amount !== s.amount) throw new ApiError(402, "AMOUNT_MISMATCH", `the voucher to ${s.provider.payee} must be for exactly ${s.amount}`);
      return { provider: { ...s.provider, price_atomic: s.amount.toString() }, voucher: v };
    });
    if (new Set(items.map((i) => i.voucher.budgetId)).size !== 1) throw new ApiError(402, "BUDGET_MISMATCH", "all vouchers of a payment must come from one budget");
    const owner = this.#ownerOf(vouchers[0]!);
    if (owner) this.screening.check({ stage: "voucher", merchantId: m.id, payout: p.payout, payer: owner, paymentId: p.id, linkId: p.link_id, amount: BigInt(p.amount_due) });
    const out = await this.#vouchers.acceptAll(items, {
      onAccepted: (ids) => {
        const cur = this.payments.row(p.id)!;
        if (isTerminalPaymentStatus(cur.status) || this.#clock() >= cur.expires_unix || this.payments.credits(p.id).length > 0) {
          throw new ApiError(409, "PAYMENT_NOT_PAYABLE", `payment is ${cur.status}`);
        }
        ids.forEach((callId, i) =>
          this.payments.addCredit({ paymentId: p.id, method: "voucher", payer: owner, amount: items[i]!.voucher.amount, txHash: null, callId, status: "pending", mayBeLate: false }),
        );
      },
    });
    if (!out.ok) return { ok: false as const, denial: out.denial };
    return { ok: true as const, receipts: out.results, payer: owner, payment: this.payments.row(p.id)! };
  }

  /** The draft an unpaid x402 request on a link uses: reused for the same requester while it lives, else created. */
  async draftFor(l: LinkRow, m: MerchantRow, amount: bigint, requester: string): Promise<PaymentRow> {
    const key = createHash("sha256").update(`${l.id}\n${requester}`).digest("hex");
    const found = this.payments.findDraft(l.id, key, amount, "voucher");
    // A draft quoted before the business's fees changed would ask for other vouchers than the requirement offered now.
    const q = this.payments.quote(m, amount, "voucher");
    if (found && found.amount_due === q.amount_due.toString() && found.fee_total === q.fee_total.toString()) return found;
    return this.payments.create(m, { amount, method: "voucher", link_id: l.id, description: l.title, success_url: l.success_url, expires_in: MIN_EXPIRES_IN_SECONDS }, { draftKey: key });
  }

  /** True when this payment already accepted every one of these vouchers (an idempotent retry). */
  acceptedVouchers(paymentId: string, vouchers: VoucherInput[]): boolean {
    return vouchers.length > 0 && vouchers.every((v) => !!this.db.get("SELECT 1 FROM payment_credits WHERE call_id = ? AND payment_id = ?", callIdOf(v), paymentId));
  }

  /** The payment of this link that already accepted these vouchers, for an idempotent retry. */
  paymentForVouchers(linkId: string, vouchers: VoucherInput[]): PaymentRow | undefined {
    return this.db.get<PaymentRow>("SELECT p.* FROM payments p JOIN payment_credits c ON c.payment_id = p.id WHERE c.call_id = ? AND p.link_id = ?", callIdOf(vouchers[0]!), linkId);
  }

  /** The receipts of vouchers this payment already accepted, when every presented voucher is one of them (same amount). */
  #voucherReplay(p: PaymentRow, callIds: Id32[], vouchers: VoucherInput[]) {
    const rows = callIds.map((id) => this.db.get<CallRow>("SELECT c.* FROM calls c JOIN payment_credits pc ON pc.call_id = c.call_id WHERE c.call_id = ? AND pc.payment_id = ?", id, p.id));
    if (rows.length === 0 || rows.some((r, i) => !r || BigInt(r.amount) !== vouchers[i]!.amount)) return null;
    const receipts = (rows as CallRow[]).map((c) => ({
      ok: true as const,
      receipt: {
        callId: c.call_id,
        budgetId: c.budget_id,
        payee: c.payee,
        amount: c.amount,
        cumulative: c.cumulative,
        requestHash: c.request_hash,
        timestamp: c.timestamp,
        voucherSig: c.agent_signature,
        digest: c.leaf,
        nodeSignature: c.node_signature,
        node: this.chain.nodeKey,
      },
      position: this.#vouchers.positionJson(c.budget_id, c.payee),
    }));
    return { ok: true as const, receipts, payer: this.#ownerOf(vouchers[0]!), payment: this.payments.row(p.id)! };
  }

  /** The Budget owner: the account that pays for a voucher. */
  #ownerOf(v: VoucherInput): AccountId | null {
    return this.db.get<{ owner: AccountId }>("SELECT owner FROM budgets WHERE id = ?", v.budgetId)?.owner ?? null;
  }

  /**
   * Decision 8: every refusal goes out as a `budget.refused` webhook, inside the transaction that records it, to the
   * platform's alert endpoints and to the business whose payment or paid skill was refused. Nothing is written when no
   * endpoint subscribes, so a node without alert endpoints keeps no copy of every refusal.
   */
  refused(n: DenialNotice): void {
    const object = refusalJson(n);
    const merchant = this.db.get<{ id: string }>("SELECT id FROM merchants WHERE provider_id = ? UNION SELECT merchant_id AS id FROM agents WHERE provider_id = ? LIMIT 1", n.provider.id, n.provider.id);
    for (const scope of [null, merchant?.id ?? undefined]) {
      if (scope === undefined || !this.webhooks.hasSubscribers(scope, "budget.refused")) continue;
      this.webhooks.emit(scope, "budget.refused", n.denial.id, null, object);
    }
  }

  /** Settlement hook, inside the booking transaction: voucher credits of the batch's calls are now confirmed. */
  #onBatchConfirmed(b: { seq: number; batchId: Id32; txHash: string | null }) {
    const credits = this.db.all<CreditRow>("SELECT pc.* FROM payment_credits pc JOIN calls c ON c.call_id = pc.call_id WHERE c.batch_seq = ? AND pc.status = 'pending'", b.seq);
    for (const c of credits) this.payments.confirmCredit(c.id, { txHash: b.txHash, batchId: b.batchId });
  }

  /**
   * Settlement hook, inside the booking transaction: the payee settled these calls itself on the hub (`settle_own`), so
   * their voucher credits are confirmed too. They carry no batch and no transaction: the hub's settled position is
   * the evidence, and the payment proof says so by leaving both empty.
   */
  #onSellerSettled(s: { callIds: Id32[] }) {
    for (const callId of s.callIds) {
      for (const c of this.db.all<CreditRow>("SELECT * FROM payment_credits WHERE call_id = ? AND status = 'pending'", callId)) this.payments.confirmCredit(c.id);
    }
  }

  // ------------------------------------------------------------------ x402 requirements

  /**
   * PAYMENT-REQUIRED for a payment's amounts: one `payminto-voucher` entry, with `extra.splits` when a platform fee
   * makes it two payees. Offered only while nothing has been paid (vouchers pay the whole amount due).
   */
  requirements(o: { merchant: MerchantRow; amount: bigint; payment: PaymentRow | null; resource: string; description: string; error?: string }): PaymentRequiredV2 {
    const accepts: VoucherRequirement[] = [];
    const ttl = o.payment ? Math.max(1, Math.min(MAX_X402_TIMEOUT_SEC, o.payment.expires_unix - this.#clock())) : MAX_X402_TIMEOUT_SEC;
    try {
      if (!o.payment || BigInt(o.payment.amount_paid) === 0n) {
        const q = this.payments.quote(o.merchant, o.amount, "voucher");
        const split = this.voucherSplit(o.merchant, q);
        const total = split.reduce((s, x) => s + x.amount, 0n);
        accepts.push({
          scheme: SCHEME,
          network: this.network,
          amount: total.toString(),
          asset: this.token.address,
          payTo: split[0]!.provider.payee,
          maxTimeoutSeconds: ttl,
          extra: {
            clearingHub: this.chain.hub,
            clearingNode: this.#publicUrl,
            providerId: split[0]!.provider.id,
            tokenSymbol: this.token.symbol,
            tokenDecimals: this.token.decimals,
            ...(split.length > 1 ? { splits: split.map((s) => ({ payTo: s.provider.payee, amount: s.amount.toString(), providerId: s.provider.id })) } : {}),
          },
        });
      }
    } catch {
      // Vouchers are not available for this merchant or amount.
    }
    return { x402Version: X402_VERSION, ...(o.error ? { error: o.error } : {}), resource: { url: o.resource, description: o.description }, accepts };
  }

  // ------------------------------------------------------------------ proofs and orders

  /** The canonical order JSON, the exact bytes order_hash is sha256 of. Carries no metadata. */
  order(p: PaymentRow): string {
    return canonicalOrder(this.payments.order(p));
  }

  /**
   * The payment proof, built from chain evidence read now: the hub's own record of a wallet payment's checkout id, and
   * for each voucher credit the hub's verification of the call's Merkle proof against the batch root it stores.
   */
  async proof(p: PaymentRow): Promise<PaymentProof> {
    if (p.status !== "paid" && p.status !== "overpaid") throw new ApiError(409, "NOT_PAID", `a proof exists only for paid payments (status is ${p.status})`);
    const credits = this.payments.credits(p.id).filter((c) => c.status === "confirmed");
    const wallet = credits.filter((c) => c.method === "wallet" && c.checkout_id);
    const records = wallet.length ? await this.chain.chain.payments(wallet.map((c) => c.checkout_id!)).catch(() => null) : [];
    const out: PaymentProof["credits"] = [];
    for (const c of credits) {
      if (c.method === "wallet" && c.checkout_id) {
        const r = records === null ? undefined : (records[wallet.indexOf(c)] ?? null);
        out.push({
          method: "wallet",
          amount: c.amount,
          payer: c.payer,
          checkout_id: c.checkout_id,
          tx_hash: c.tx_hash ?? p.wallet_tx_hash ?? null,
          hub_record: r ? { merchant: r.merchant, amount: r.amount.toString(), payer: r.payer, at_ms: r.at.toString() } : null,
          verified: r === undefined ? null : r !== null && r.merchant === p.payout && r.amount.toString() === c.amount,
        });
      } else if (c.method === "voucher" && c.call_id) {
        const call = this.db.get<CallRow>("SELECT * FROM calls WHERE call_id = ?", c.call_id);
        const batch = call?.batch_seq != null ? this.db.get<{ batch_id: Id32; status: string; tx_hash: string | null }>("SELECT batch_id, status, tx_hash FROM batches WHERE seq = ?", call.batch_seq) : undefined;
        let verified: boolean | null = null;
        if (call && batch?.status === "confirmed") {
          const fields = receiptFieldsOf(call);
          verified = await receiptVerifiedOnchain(
            this.chain.chain,
            this.chain.operator,
            this.chain.nodeKey,
            batch.batch_id,
            fields,
            { callId: call.call_id, budgetId: call.budget_id, payee: call.payee, amount: fields.amount, cumulative: fields.cumulative, requestHash: call.request_hash, timestamp: BigInt(call.timestamp), voucherSig: call.agent_signature },
            call.node_signature,
            call.proof ? (JSON.parse(call.proof) as Id32[]) : [],
          );
        }
        out.push({
          method: "voucher",
          amount: c.amount,
          payer: c.payer,
          call_id: c.call_id,
          batch_id: batch?.batch_id ?? null,
          tx_hash: batch?.tx_hash ?? null,
          receipt_proof_url: `${this.#publicUrl}/v1/receipts/${c.call_id}/proof`,
          verified,
        });
      } else if (c.method === "oneclick" && c.intents_quote_id && this.intents) {
        // Paid from another chain: the NEAR delivery transaction, read again now, is the evidence.
        const credit = await this.intents.proofCredit(c);
        if (credit) out.push(credit);
      }
    }
    return {
      payment_id: p.id,
      livemode: this.ctx.livemode,
      status: p.status,
      network: this.network,
      hub: this.chain.hub,
      token: this.token,
      payout: p.payout,
      amount_due: p.amount_due,
      amount_paid: p.amount_paid,
      order_hash: p.order_hash,
      paid_at: p.paid_at,
      checked_at: nowIso(),
      credits: out,
    };
  }

  // ------------------------------------------------------------------ service directory

  directory() {
    const net = networkFor(this.network);
    const links = this.links.listed().map((l) => {
      const m = this.merchants.merchant(l.merchant_id);
      const price = BigInt(l.amount ?? l.min_amount!);
      return {
        type: "link" as const,
        id: l.id,
        merchant: { id: m.id, name: m.name },
        title: l.title,
        description: l.description,
        price: l.amount !== null ? { amount: l.amount } : { min_amount: l.min_amount, max_amount: l.max_amount },
        token: this.token,
        network: this.network,
        schemes: this.#quotes(m, price, "voucher") ? [SCHEME] : [],
        pay_url: linkUrl(this.ctx.checkoutBaseUrl, l.slug),
      };
    });
    const endpoints = this.db
      // Skills of merchant AI agents are listed while their agent is active (docs/AGENTS.md section 4).
      .all<ProviderRow>(
        "SELECT * FROM providers WHERE category != 'gateway' AND id NOT IN (SELECT provider_id FROM agents WHERE provider_id IS NOT NULL AND (status != 'active' OR deleted_at IS NOT NULL)) ORDER BY created_at, id",
      )
      .map((p) => ({
        type: "endpoint" as const,
        id: p.id,
        title: p.name,
        description: p.description,
        category: p.category,
        price: { amount: p.price_atomic },
        payee: p.payee,
        token: this.token,
        network: this.network,
        schemes: [SCHEME],
        pay_url: p.resource,
      }));
    return {
      version: 1,
      node: { url: this.#publicUrl, network: net.network, hub: this.chain.hub, checkout_base_url: this.ctx.checkoutBaseUrl },
      platform: { name: this.merchants.platformRow()?.name ?? this.config.platformName },
      generated_at: isoOf(this.#clock()),
      services: [...links, ...endpoints],
    };
  }

  // ------------------------------------------------------------------ overview

  overview(merchantId: string) {
    const since = isoOf(this.#clock() - 30 * 86_400);
    const rows = this.db.all<{ status: string; n: number; paid: string }>(
      "SELECT status, COUNT(*) AS n, bigsum(amount_paid) AS paid FROM payments WHERE merchant_id = ? AND draft = 0 AND created_at >= ? GROUP BY status",
      merchantId,
      since,
    );
    const counts: Record<string, number> = {};
    let payments = 0;
    let volume = 0n;
    for (const r of rows) {
      counts[r.status] = r.n;
      payments += r.n;
      volume += BigInt(r.paid);
    }
    const won = (counts.paid ?? 0) + (counts.overpaid ?? 0);
    const terminal = won + (counts.underpaid ?? 0) + (counts.expired ?? 0) + (counts.canceled ?? 0);
    const byDay = new Map(
      this.db
        .all<{ d: string; volume: string; n: number }>(
          "SELECT substr(created_at, 1, 10) AS d, bigsum(amount_paid) AS volume, COUNT(*) AS n FROM payments WHERE merchant_id = ? AND draft = 0 AND created_at >= ? GROUP BY d",
          merchantId,
          since,
        )
        .map((r) => [r.d, r]),
    );
    const today = Math.floor(this.#clock() / 86_400) * 86_400;
    const days = Array.from({ length: 30 }, (_, i) => {
      const d = isoOf(today - (29 - i) * 86_400).slice(0, 10);
      const r = byDay.get(d);
      return { day: d, volume: r?.volume ?? "0", count: r?.n ?? 0 };
    });
    return { volume: volume.toString(), payments, counts, conversion: terminal === 0 ? 0 : won / terminal, days };
  }
}
