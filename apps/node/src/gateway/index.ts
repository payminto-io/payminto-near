import { createHash } from "node:crypto";
import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  toBytes,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  canonicalOrder,
  checkoutTransferTemplate,
  depositFactoryAbi,
  depositTermsArg,
  eip3009Abi,
  erc20TransferUri,
  HSP_SCHEME,
  isHspInFlight,
  isLivemode,
  isTerminalPaymentStatus,
  linkUrl,
  MIN_EXPIRES_IN_SECONDS,
  networkFor,
  readForwarderImplementation,
  tokenDomainSeparator,
  SCHEME,
  X402_VERSION,
  type CheckoutView,
  type HspRequirement,
  type PaymentMethod,
  type PaymentRequirement,
  type TokenDomain,
  type TransferAuthorization,
  walletTransferAuthorization,
} from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { GatewayConfig } from "../config.ts";
import type { Database } from "../db/database.ts";
import type { BatchAttester } from "../eas.ts";
import { PAYMENT_SCHEMA, schemaUid } from "../eas.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { McpHspAgenticClient, type HspAgenticClient } from "../hsp/agentic.ts";
import type { SettlementService } from "../settlement.ts";
import { nowIso, type CallRow, type ProviderRow } from "../store.ts";
import { callIdOf, type VoucherInput, type VoucherService } from "../vouchers.ts";
import { ApiKeyService, Idempotency } from "./keys.ts";
import { LinkService } from "./links.ts";
import { MerchantService, type MerchantRow } from "./merchants.ts";
import { isoOf, type CreditRow, type LinkRow, type ModelContext, type PaymentRow } from "./model.ts";
import { PaymentService } from "./payments.ts";
import { HspRail } from "./hsp.ts";
import { GatewayRails } from "./rails.ts";
import { RefundService } from "./refunds.ts";
import { AuthorizationRelay, type AuthorizationKind } from "./relay.ts";
import { Screening, type ScreeningStage } from "./screening.ts";
import { chainTransferSource, DepositWatcher, Flusher, type TransferSource } from "./watcher.ts";
import { WebhookService, type WebhookSender } from "./webhooks.ts";

/** Standard x402 `exact` (EIP-3009) requirement, listed next to payminto-voucher in PAYMENT-REQUIRED. */
export type ExactRequirement = {
  scheme: "exact";
  network: `eip155:${number}`;
  amount: string;
  asset: Address;
  payTo: Address;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the token, as x402 exact clients expect, plus the payment the forwarder belongs to. */
  extra: { name: string; version: string; paymentId: string };
};

export type X402PaymentRequired = {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<ExactRequirement | PaymentRequirement | HspRequirement>;
};

export type ExactPayload = { from: Address; authorization: TransferAuthorization; signature: Hex };

export type VoucherPayload = VoucherInput;

const MAX_X402_TIMEOUT_SEC = 300;

export type GatewayDeps = {
  config: GatewayConfig;
  chainId: number;
  db: Database;
  chain: ChainClient;
  vouchers: VoucherService;
  settlement: SettlementService;
  attester: BatchAttester | null;
  log: Logger;
  /** eip712 is the token's own domain, as ChainClient.tokenMeta verified it on chain; chains.ts when absent. */
  token: { address: Address; symbol: string; decimals: number; eip712?: { name: string; version: string } };
  /** Public URL of this node (x402 voucher requirements name it). */
  publicUrl: string;
  /** Test seams. */
  clock?: () => number;
  transferSource?: TransferSource;
  webhookSender?: WebhookSender;
  /** HSP Agentic Payment client (tests inject one); default the MCP client for config.hsp.mcpUrl. */
  hspClient?: HspAgenticClient;
};

/**
 * Payminto Gateway inside the Clearing Node (docs/GATEWAY.md): merchants and fees, payments and their state machine,
 * EIP-3009 relay, deposit forwarders, vouchers, refunds, webhooks, screening, proofs and the service directory.
 */
export class Gateway {
  readonly config: GatewayConfig;
  readonly ctx: ModelContext;
  readonly chainId: number;
  readonly db: Database;
  readonly chain: ChainClient;
  readonly log: Logger;
  readonly token: { address: Address; symbol: string; decimals: number };
  readonly domain: TokenDomain;
  readonly merchants: MerchantService;
  readonly webhooks: WebhookService;
  readonly payments: PaymentService;
  readonly links: LinkService;
  readonly refunds: RefundService;
  readonly relay: AuthorizationRelay;
  readonly screening: Screening;
  readonly keys: ApiKeyService;
  readonly idempotency: Idempotency;
  readonly watcher: DepositWatcher;
  readonly flusher: Flusher;
  readonly rails: GatewayRails;
  /** HSP payment method (section 17); null when HSP_MCP_URL is unset. */
  readonly hsp: HspRail | null;
  readonly #vouchers: VoucherService;
  readonly #attester: BatchAttester | null;
  readonly #publicUrl: string;
  readonly #clock: () => number;
  readonly #relaying = new Set<string>();
  readonly #timers: NodeJS.Timeout[] = [];
  #stopped = false;

  private constructor(d: GatewayDeps, implementation: Address) {
    this.config = d.config;
    this.chainId = d.chainId;
    this.db = d.db;
    this.chain = d.chain;
    this.log = d.log;
    this.token = d.token;
    this.#vouchers = d.vouchers;
    this.#attester = d.attester;
    this.#publicUrl = d.publicUrl;
    this.#clock = d.clock ?? (() => Math.floor(Date.now() / 1000));
    const livemode = isLivemode(d.chainId);
    this.ctx = { chainId: d.chainId, livemode, token: d.token.address, checkoutBaseUrl: d.config.checkoutBaseUrl };
    const net = networkFor(d.chainId);
    // Always the token's own EIP-712 domain (USDC.e is "Bridged USDC"), never hard-coded.
    const eip712 = d.token.eip712 ?? net.token.eip712;
    this.domain = { name: eip712.name, version: eip712.version, chainId: d.chainId, verifyingContract: d.token.address };
    this.rails = new GatewayRails({ chainId: d.chainId, token: d.token.address, factory: d.config.depositFactory, implementation, router: d.config.paymentRouter });
    this.merchants = new MerchantService({ db: d.db, ctx: this.ctx, factory: d.config.depositFactory, router: d.config.paymentRouter });
    this.webhooks = new WebhookService({ db: d.db, ctx: this.ctx, log: d.log.child({ component: "webhooks" }), allowPrivate: d.config.webhookAllowPrivate, clock: d.clock, send: d.webhookSender });
    this.payments = new PaymentService({
      db: d.db,
      ctx: this.ctx,
      rails: this.rails,
      merchants: this.merchants,
      webhooks: this.webhooks,
      head: () => d.chain.public.getBlockNumber({ cacheTime: 0 }),
      clock: d.clock,
      ttlSec: d.config.checkoutTtlSec,
      attest: d.attester !== null,
      unavailable: (method) => (method === "hsp" ? (this.hsp ? this.hsp.unavailable() : "HSP is not set up on this server.") : null),
    });
    this.links = new LinkService(d.db, this.ctx);
    this.relay = new AuthorizationRelay(d.chain, this.domain);
    this.refunds = new RefundService({
      db: d.db,
      chain: d.chain,
      ctx: this.ctx,
      payments: this.payments,
      relay: this.relay,
      webhooks: this.webhooks,
      rails: this.rails,
      log: d.log.child({ component: "refunds" }),
    });
    this.screening = new Screening({ db: d.db, chain: d.chain, minPayerNonce: d.config.screenMinPayerNonce, clock: d.clock });
    this.keys = new ApiKeyService(d.db, livemode);
    this.idempotency = new Idempotency(d.db, d.clock);
    this.watcher = new DepositWatcher({
      db: d.db,
      payments: this.payments,
      source: d.transferSource ?? chainTransferSource(d.chain),
      startBlock: d.config.depositFactoryBlock,
      log: d.log.child({ component: "deposits" }),
    });
    this.hsp = d.config.hsp
      ? new HspRail({
          db: d.db,
          payments: this.payments,
          client: d.hspClient ?? new McpHspAgenticClient({ url: d.config.hsp.mcpUrl }),
          config: d.config.hsp,
          chainId: d.chainId,
          token: d.token,
          log: d.log.child({ component: "hsp" }),
          clock: d.clock,
          hooks: {
            assertPayable: (p) => this.#assertPayable(p),
            requote: (p, method) => this.#requote(p, method),
            screen: (p, payer) => this.screen("hsp", { merchantId: p.merchant_id, payout: p.payout, payer, paymentId: p.id, amount: BigInt(p.amount_due) }),
          },
        })
      : null;
    this.flusher = new Flusher({ db: d.db, chain: d.chain, payments: this.payments, log: d.log.child({ component: "flush" }), clock: d.clock });
    d.settlement.confirmHooks.push((b) => this.#onBatchConfirmed(b));
  }

  /**
   * Checks the chain agrees with the configuration before any payment is taken: the factory and router exist, the
   * factory predicts the same forwarders off chain as on chain, and the token's DOMAIN_SEPARATOR is the chains.ts domain
   * (otherwise every signature would fail). Then seeds the platform, fee plans and the default merchant.
   */
  static async create(d: GatewayDeps): Promise<Gateway> {
    const { chain, config } = d;
    if (!(await chain.isContract(config.depositFactory))) throw new Error(`No contract at DEPOSIT_FACTORY_ADDRESS ${config.depositFactory} on chain ${d.chainId}`);
    if (!(await chain.isContract(config.paymentRouter))) throw new Error(`No contract at PAYMENT_ROUTER_ADDRESS ${config.paymentRouter} on chain ${d.chainId}`);
    const onchainImpl = await readForwarderImplementation(chain.public, config.depositFactory);
    if (config.forwarderImplementation && !isAddressEqual(config.forwarderImplementation, onchainImpl)) {
      throw new Error(`deployments depositForwarderImplementation ${config.forwarderImplementation} differs from DepositFactory.implementation() ${onchainImpl}`);
    }
    const g = new Gateway(d, onchainImpl);
    const binding = { paymentId: "pay_probe", payout: "0x0000000000000000000000000000000000000001" as Address, feeRecipient: null, fee: 0n, amountDue: 1n };
    const probe = g.rails.deposit(binding);
    const onchain = await chain.public.readContract({
      address: config.depositFactory,
      abi: depositFactoryAbi,
      functionName: "addressOf",
      args: [depositTermsArg(g.rails.depositTerms(binding)), probe.salt],
    });
    if (!isAddressEqual(onchain, probe.address)) throw new Error("DepositFactory.addressOf disagrees with the off-chain forwarder prediction");
    const separator = await chain.public.readContract({ address: d.token.address, abi: domainSeparatorAbi, functionName: "DOMAIN_SEPARATOR" }).catch(() => null);
    if (separator !== null && separator.toLowerCase() !== tokenDomainSeparator(d.chainId, d.token.address, g.domain).toLowerCase()) {
      throw new Error(`token ${d.token.address} EIP-712 domain differs from ${g.domain.name} v${g.domain.version}; EIP-3009 signatures would fail`);
    }
    const seeded = g.merchants.seed({ platformName: config.platformName, feeRecipient: config.feeRecipient, seedPayout: config.seedPayout });
    if (seeded.seedPayoutIgnored) d.log.warn("GATEWAY_PAYOUT_ADDRESS only seeds the first merchant; change payouts with POST /v1/merchants/{id}/payout", {});
    // HSP availability is checked in the background: an unreachable HSP never delays or stops the node.
    void g.hsp?.check();
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
    every(intervals.watchMs, "deposit watcher", () => this.watcher.tick());
    every(5_000, "flush", () => this.flusher.tick());
    every(1_000, "webhooks", () => this.webhooks.tick());
    every(2_000, "relay credits", () => this.trackRelays());
    every(5_000, "payment expiry", async () => this.payments.expireDue());
    every(5_000, "refund confirmation", () => this.refunds.tick());
    every(10_000, "payment attestations", () => this.attestDue());
    every(3_600_000, "idempotency prune", async () => this.idempotency.prune());
    // Each payment is queried at most once per HSP_POLL_INTERVAL_MS; the timer only bounds how late that can be.
    if (this.hsp) every(Math.min(this.hsp.pollIntervalMs, 5_000), "hsp poll", () => this.hsp!.tick());
    this.webhooks.onDue(() => void this.webhooks.tick().catch((err) => this.log.warn("webhooks failed", { err })));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.webhooks.onDue(null);
    await Promise.allSettled([this.watcher.tick(), this.webhooks.tick(), this.hsp?.close() ?? Promise.resolve()].map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 10_000).unref())])));
  }

  now(): number {
    return this.#clock();
  }

  // ------------------------------------------------------------------ public views

  /** Methods a person can use on the hosted page right now (agent methods are offered through x402). */
  #personMethods(p: PaymentRow, m: MerchantRow): PaymentMethod[] {
    if (isTerminalPaymentStatus(p.status) || this.#clock() >= p.expires_unix || m.status !== "active") return [];
    // An HSP payment on its way holds the checkout until it lands or fails.
    if (isHspInFlight(p.hsp_status)) return [];
    const remaining = BigInt(p.amount_due) - BigInt(p.amount_paid);
    if (remaining <= 0n) return [];
    const untouched = p.amount_paid === "0" && p.status === "open";
    return (["wallet", "deposit", "hsp"] as const).filter((method) => {
      if (method === "hsp" && (!this.hsp || !untouched)) return false;
      if (p.quote_method) return p.quote_method === method || (p.status === "open" && this.#quotes(m, BigInt(p.amount), method));
      return this.#quotes(m, BigInt(p.amount), method);
    });
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
  async checkoutView(p: PaymentRow): Promise<CheckoutView & Record<string, unknown>> {
    const m = this.merchants.merchant(p.merchant_id);
    const remaining = BigInt(p.amount_due) - BigInt(p.amount_paid);
    const left = remaining > 0n ? remaining : 0n;
    const methods = this.#personMethods(p, m);
    const credits = this.payments.credits(p.id);
    const lastConfirmed = [...credits].reverse().find((c) => c.status === "confirmed" && c.tx_hash) ?? null;
    const pending = credits.find((c) => c.status === "pending" && c.block_number !== null) ?? null;
    let confirmations: { current: number; required: number } | null = null;
    if (pending) {
      const [latest, final] = await Promise.all([this.chain.public.getBlockNumber({ cacheTime: 0 }), this.chain.headOf()]).catch(() => [null, null] as const);
      if (latest !== null && final !== null) {
        // The depth the finality head lags behind, measured now: the number of blocks this credit still has to wait out.
        const required = Number(latest - final) + 1;
        confirmations = { current: Math.max(0, Number(latest) - pending.block_number! + 1), required: Math.max(1, required) };
      }
    }
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
      amount_remaining: left.toString(),
      chain_id: this.chainId,
      token: this.token,
      deposit_address: p.deposit_address,
      deposit_uri: erc20TransferUri({ token: this.token.address, chainId: this.chainId, to: p.deposit_address, amount: left }),
      method: p.quote_method,
      methods,
      authorization:
        methods.includes("wallet") && (p.quote_method === null || p.quote_method === "wallet")
          ? checkoutTransferTemplate({
              domain: this.domain,
              forwarder: p.deposit_address,
              paymentRef: this.rails.paymentRefOf(p.id),
              paid: BigInt(p.amount_paid),
              value: left,
              expiresAt: p.expires_unix,
            })
          : null,
      success_url: p.success_url,
      tx_hash: lastConfirmed?.tx_hash ?? null,
      order_hash: p.order_hash,
      expires_at: p.expires_at,
      created_at: p.created_at,
      // Dashboard extras.
      confirmations,
      link: link ? { slug: link.slug, active: link.active === 1 } : null,
      paid_at: p.paid_at,
      payer: p.payer,
      payout: p.payout,
      // Only a business that offers HSP (or a payment that already used it) shows HSP to the payer.
      hsp: this.hsp && (p.hsp_flow_id || this.merchants.method(m.id, "hsp")?.enabled === 1) ? this.hsp.checkout(p) : null,
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
      merchant: { id: m.id, name: m.name, support_email: m.support_email, brand_color: m.brand_color, logo_url: m.logo_url },
      chain_id: this.chainId,
      token: this.token,
      url: linkUrl(this.ctx.checkoutBaseUrl, l.slug),
    };
  }

  /**
   * What a customer pays on top of the price per enabled method (GATEWAY.md section 15): only the customer-borne method
   * fee, never platform fees or what the business receives. With a fixed amount each method also carries `quote`.
   */
  #publicMethods(m: MerchantRow, l: LinkRow) {
    return this.merchants
      .methods(m.id)
      .filter((r) => r.enabled === 1)
      .map((r) => {
        const customer = r.bearer === "customer";
        let quote: { amount: string; surcharge: string; amount_due: string } | null = null;
        if (l.amount !== null) {
          try {
            const q = this.payments.quote(m, BigInt(l.amount), r.method);
            quote = { amount: q.amount.toString(), surcharge: q.surcharge.toString(), amount_due: q.amount_due.toString() };
          } catch {
            quote = null; // outside this method's limits: the method is not offered for this amount
          }
        }
        return { method: r.method, enabled: true, surcharge_bps: customer ? r.fee_bps : 0, surcharge_fixed: customer ? r.fee_fixed : "0", quote };
      });
  }

  /** Screens before a deposit address, requirements, relay or voucher acceptance (section 13.1). */
  async screen(stage: ScreeningStage, p: { merchantId: string; payout: Address; payer?: Address | null; paymentId?: string | null; linkId?: string | null; amount?: bigint | null }) {
    await this.screening.check({ stage, ...p });
  }

  // ------------------------------------------------------------------ wallet and x402 exact

  /**
   * Re-quotes for the method actually used while the payment is untouched; once money arrived the quote stays (its
   * deposit forwarder and fee are already bound), but the method must still be enabled.
   */
  #requote(p: PaymentRow, method: PaymentMethod): PaymentRow {
    if (p.quote_method === method) return p;
    if (p.status === "open" && p.amount_paid === "0" && this.payments.credits(p.id).length === 0) return this.payments.requote(p, method);
    const row = this.merchants.method(p.merchant_id, method);
    if (!row.enabled) throw new ApiError(409, "METHOD_DISABLED", `${method} payments are disabled for this merchant`);
    return p;
  }

  #assertPayable(p: PaymentRow) {
    const m = this.merchants.merchant(p.merchant_id);
    if (m.status !== "active") throw new ApiError(403, "MERCHANT_SUSPENDED", "this merchant is suspended");
    if (isTerminalPaymentStatus(p.status) || this.#clock() >= p.expires_unix) throw new ApiError(409, "PAYMENT_NOT_PAYABLE", `payment is ${p.status === "open" ? "expired" : p.status}`);
    if (p.status === "processing") throw new ApiError(409, "PAYMENT_PROCESSING", "a payment for this checkout is already being confirmed");
    if (isHspInFlight(p.hsp_status)) throw new ApiError(409, "PAYMENT_PROCESSING", "an HSP payment for this checkout is already being confirmed");
  }

  /**
   * The checkout `wallet` method: the node rebuilds the TransferWithAuthorization the page asked the payer to sign, to
   * the payment's fee-splitting forwarder for the remaining amount (section 3), relays it, credits it and flushes it
   * like any deposit. The forwarder is the only place customer money goes, so its fee counter is the single source of
   * truth for the split, whatever mix of rails paid the payment.
   */
  async authorize(paymentId: string, payer: Address, signature: Hex) {
    let p = this.#payment(paymentId);
    this.#assertPayable(p);
    p = this.#requote(p, "wallet");
    const message = walletTransferAuthorization({
      forwarder: p.deposit_address,
      paymentRef: this.rails.paymentRefOf(p.id),
      paid: BigInt(p.amount_paid),
      value: BigInt(p.amount_due) - BigInt(p.amount_paid),
      expiresAt: p.expires_unix,
      from: getAddress(payer),
    });
    return this.#payByAuthorization(p, "wallet", message, signature, { kind: "transfer", call: this.rails.transferCall(message, signature) });
  }

  /**
   * x402 `exact` against an existing payment: a standard client signs TransferWithAuthorization with its own nonce, so
   * payTo is the payment's fee-splitting forwarder; the node relays it there and the flush enforces the split.
   */
  async payExact(p: PaymentRow, x: ExactPayload) {
    this.#assertPayable(p);
    p = this.#requote(p, "x402");
    const a = x.authorization;
    const remaining = BigInt(p.amount_due) - BigInt(p.amount_paid);
    if (!isAddressEqual(a.to, p.deposit_address)) throw new ApiError(402, "PAY_TO_MISMATCH", `authorization must pay ${p.deposit_address}`);
    if (a.value !== remaining) throw new ApiError(402, "AMOUNT_MISMATCH", `authorization must be for exactly ${remaining}`);
    if (p.draft) {
      // A valid signature is a real payment attempt: the draft becomes visible before the relay.
      if (!(await this.relay.verify("transfer", a, x.signature))) throw new ApiError(402, "BAD_SIGNATURE", "the signature does not recover to the payer");
      p = this.payments.promote(p.id);
    }
    return this.#payByAuthorization(p, "x402", a, x.signature, { kind: "transfer", call: this.rails.transferCall(a, x.signature) });
  }

  /** The payment an x402 exact authorization pays: its `to` is that payment's forwarder. */
  paymentByDepositAddress(address: Address): PaymentRow | undefined {
    return this.db.get<PaymentRow>("SELECT * FROM payments WHERE deposit_address = ?", getAddress(address));
  }

  /**
   * What a relayed transaction paid toward the payment: the payer's Transfer to one of the payment's forwarders (the
   * current one, or one of an earlier quote it was signed for). Wallet and x402 both pay the forwarder.
   */
  #relayCreditOf(r: TransactionReceipt, p: PaymentRow, _method: "wallet" | "x402", payer: Address): { amount: bigint; logIndex: number } | null {
    for (const to of [p.deposit_address, ...this.payments.previousForwarders(p.id).map((f) => f.address)]) {
      const t = this.rails.transferOf(r, payer, to);
      if (t) return { amount: t.value, logIndex: t.logIndex };
    }
    return null;
  }

  async #payByAuthorization(
    p: PaymentRow,
    method: "wallet" | "x402",
    message: TransferAuthorization,
    signature: Hex,
    how: { kind: AuthorizationKind; call: { to: Address; data: Hex } },
  ): Promise<{ payment: PaymentRow; txHash: Hex }> {
    await this.screen(method === "wallet" ? "authorize" : "x402", { merchantId: p.merchant_id, payout: p.payout, payer: message.from, paymentId: p.id, amount: message.value });
    if (this.#relaying.has(p.id)) throw new ApiError(409, "RELAY_IN_PROGRESS", "an authorization for this payment is being relayed");
    this.#relaying.add(p.id);
    let relayId: number | null = null;
    try {
      relayId = this.db.tx(() => {
        const existing = this.db.get<{ id: number; status: string }>("SELECT id, status FROM payment_relays WHERE payer = ? AND nonce = ?", message.from, message.nonce);
        if (existing && existing.status !== "failed") throw new ApiError(409, "AUTHORIZATION_USED", "this authorization was already submitted");
        const at = nowIso();
        if (existing) {
          this.db.run("UPDATE payment_relays SET status = 'sending', payment_id = ?, method = ?, error = NULL, tx_hash = NULL, updated_at = ? WHERE id = ?", p.id, method, at, existing.id);
          return existing.id;
        }
        return this.db.run(
          "INSERT INTO payment_relays (payment_id, method, payer, nonce, value, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)",
          p.id,
          method,
          message.from,
          message.nonce,
          message.value.toString(),
          at,
          at,
        ).lastInsertRowid;
      });
      const out = await this.relay.relay(how.kind, how.call, message, signature, BigInt(p.created_block), (hash) =>
        this.db.run("UPDATE payment_relays SET tx_hash = ?, updated_at = ? WHERE id = ?", hash, nowIso(), relayId),
      );
      const credit = this.#relayCreditOf(out.receipt, p, method, message.from);
      if (!credit) throw new ApiError(409, "AUTHORIZATION_USED_ELSEWHERE", "the authorization was used for a transfer that does not pay this payment");
      this.#creditRelay(p, method, message.from, out.receipt.transactionHash, credit, out.receipt.blockNumber, out.receipt.blockHash, relayId);
      await this.#confirmIfFinal(out.receipt.transactionHash);
      return { payment: this.payments.row(p.id)!, txHash: out.receipt.transactionHash };
    } catch (err) {
      if (relayId !== null) {
        this.db.run(
          "UPDATE payment_relays SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'sending'",
          (err instanceof Error ? err.message : String(err)).slice(0, 300),
          nowIso(),
          relayId,
        );
      }
      throw err;
    } finally {
      this.#relaying.delete(p.id);
    }
  }

  #creditRelay(p: PaymentRow, method: "wallet" | "x402", payer: Address, txHash: Hex, credit: { amount: bigint; logIndex: number }, blockNumber: bigint, blockHash: Hex, relayId: number) {
    this.db.tx(() => {
      this.payments.addCredit({
        paymentId: p.id,
        method,
        payer,
        amount: credit.amount,
        txHash,
        logIndex: credit.logIndex,
        blockNumber: Number(blockNumber),
        blockHash,
        status: "pending",
        mayBeLate: false,
      });
      this.db.run("UPDATE payment_relays SET status = 'credited', tx_hash = ?, updated_at = ? WHERE id = ?", txHash, nowIso(), relayId);
    });
  }

  async #confirmIfFinal(txHash: Hex) {
    const head = await this.chain.headOf();
    for (const c of this.db.all<CreditRow>("SELECT * FROM payment_credits WHERE tx_hash = ? AND status = 'pending'", txHash)) {
      if (c.block_number !== null && BigInt(c.block_number) <= head) this.payments.confirmCredit(c.id);
    }
  }

  /**
   * Relay worker: confirms relayed credits at the finality head (re-proving the receipt's block), drops credits whose
   * transaction vanished while the authorization is unused again, and recovers relays a crash interrupted.
   */
  async trackRelays(): Promise<void> {
    const head = await this.chain.headOf();
    const pending = this.db.all<CreditRow>("SELECT * FROM payment_credits WHERE status = 'pending' AND method IN ('wallet', 'x402') LIMIT 100");
    for (const c of pending) {
      const r = await this.chain.receiptOf(c.tx_hash!);
      if (!r) {
        const relay = this.db.get<{ payer: Address; nonce: Hex }>("SELECT payer, nonce FROM payment_relays WHERE tx_hash = ?", c.tx_hash);
        if (relay && !(await this.relay.isUsed(relay.payer, relay.nonce))) {
          this.log.warn("relayed credit dropped: its transaction left the chain", { paymentId: c.payment_id, txHash: c.tx_hash });
          this.db.tx(() => {
            this.payments.dropCredit(c.id);
            this.db.run("UPDATE payment_relays SET status = 'failed', error = 'transaction left the chain', updated_at = ? WHERE tx_hash = ?", nowIso(), c.tx_hash);
          });
        }
        continue;
      }
      if (r.blockHash !== c.block_hash) this.db.run("UPDATE payment_credits SET block_number = ?, block_hash = ? WHERE id = ?", Number(r.blockNumber), r.blockHash, c.id);
      if (r.blockNumber <= head) this.payments.confirmCredit(c.id, { blockNumber: Number(r.blockNumber), blockHash: r.blockHash });
    }
    const stale = this.db.all<{ id: number; payment_id: string; method: "wallet" | "x402"; payer: Address; nonce: Hex; updated_at: string }>(
      "SELECT id, payment_id, method, payer, nonce, updated_at FROM payment_relays WHERE status = 'sending'",
    );
    for (const s of stale) {
      if (this.#relaying.has(s.payment_id) || Date.parse(s.updated_at) > Date.now() - 60_000) continue;
      const p = this.payments.row(s.payment_id)!;
      if (await this.relay.isUsed(s.payer, s.nonce)) {
        const r = await this.relay.findUsed(s.payer, s.nonce, BigInt(p.created_block));
        const credit = r ? this.#relayCreditOf(r, p, s.method, s.payer) : null;
        if (r && credit) this.#creditRelay(p, s.method, s.payer, r.transactionHash, credit, r.blockNumber, r.blockHash, s.id);
      } else if (Date.parse(s.updated_at) < Date.now() - 600_000) {
        this.db.run("UPDATE payment_relays SET status = 'failed', error = 'never landed', updated_at = ? WHERE id = ?", nowIso(), s.id);
      }
    }
  }

  // ------------------------------------------------------------------ vouchers

  /** The voucher requirements for a payment's amounts: the merchant net, plus the platform fee when there is one. */
  voucherSplit(m: MerchantRow, q: { net_amount: bigint; fee_total: bigint }): Array<{ provider: ProviderRow; amount: bigint }> {
    const out = [{ provider: this.merchants.provider(m.id), amount: q.net_amount }];
    if (q.fee_total > 0n) {
      const fee = this.merchants.feeProvider();
      if (!fee) throw new ApiError(409, "FEE_RECIPIENT_REQUIRED", "fees need PLATFORM_FEE_ADDRESS");
      out.push({ provider: fee, amount: q.fee_total });
    }
    return out.filter((s) => s.amount > 0n);
  }

  /**
   * Accepts the vouchers that pay a payment: one per requirement (merchant net, platform fee). All are checked against
   * the agent's mandate policy like any clearing call and booked in one BEGIN IMMEDIATE transaction with their payment
   * credits, or none is. A retry of the same vouchers returns the receipts already issued. The payment is processing
   * until the clearing batch that settles the calls is confirmed.
   */
  async payVouchers(p: PaymentRow, vouchers: VoucherPayload[]) {
    const callIds = vouchers.map((v) => callIdOf({ mandateId: v.mandateId.toLowerCase() as Hex, payee: getAddress(v.payee), cumulative: v.cumulative, requestHash: v.requestHash }));
    const replay = this.#voucherReplay(p, callIds, vouchers);
    // Stored receipts go back only to whoever holds the agent's signatures over exactly these vouchers.
    if (replay && (await Promise.all(vouchers.map((v) => this.#vouchers.isSignedByAgent(v)))).every(Boolean)) return replay;
    this.#assertPayable(p);
    p = this.#requote(p, "voucher");
    if (BigInt(p.amount_paid) !== 0n || this.payments.credits(p.id).length > 0) throw new ApiError(409, "PAYMENT_PARTIALLY_PAID", "voucher payments need an untouched payment");
    const m = this.merchants.merchant(p.merchant_id);
    const split = this.voucherSplit(m, { net_amount: BigInt(p.net_amount), fee_total: BigInt(p.fee_total) });
    if (vouchers.length !== split.length) throw new ApiError(402, "VOUCHER_MISSING", `exactly ${split.length} voucher(s) are required, one per requirement`);
    const items = split.map((s) => {
      const v = vouchers.find((x) => isAddressEqual(x.payee, s.provider.payee));
      if (!v) throw new ApiError(402, "VOUCHER_MISSING", `a voucher to ${s.provider.payee} for ${s.amount} is required`);
      if (v.amount !== s.amount) throw new ApiError(402, "AMOUNT_MISMATCH", `the voucher to ${s.provider.payee} must be for exactly ${s.amount}`);
      return { provider: { ...s.provider, price_atomic: s.amount.toString() }, voucher: v };
    });
    if (new Set(items.map((i) => i.voucher.mandateId.toLowerCase())).size !== 1) throw new ApiError(402, "MANDATE_MISMATCH", "all vouchers of a payment must come from one mandate");
    const agent = await this.#agentOf(vouchers[0]!);
    await this.screen("voucher", { merchantId: m.id, payout: p.payout, payer: agent, paymentId: p.id, amount: BigInt(p.amount_due) });
    const out = await this.#vouchers.acceptAll(items, {
      onAccepted: (ids) => {
        const cur = this.payments.row(p.id)!;
        if (isTerminalPaymentStatus(cur.status) || this.#clock() >= cur.expires_unix || this.payments.credits(p.id).length > 0) {
          throw new ApiError(409, "PAYMENT_NOT_PAYABLE", `payment is ${cur.status}`);
        }
        ids.forEach((callId, i) =>
          this.payments.addCredit({
            paymentId: p.id,
            method: "voucher",
            payer: agent,
            amount: items[i]!.voucher.amount,
            txHash: null,
            logIndex: null,
            blockNumber: null,
            blockHash: null,
            callId,
            status: "pending",
            mayBeLate: false,
          }),
        );
      },
    });
    if (!out.ok) return { ok: false as const, denial: { code: out.denial.rule, message: out.denial.message, details: out.denial.details }, receipts: [] };
    return { ok: true as const, receipts: out.results, payment: this.payments.row(p.id)! };
  }

  /** The draft an unpaid x402 request on a link uses: reused for the same requester while it lives, else created. */
  async draftFor(l: LinkRow, m: MerchantRow, amount: bigint, method: "x402" | "voucher" | "hsp", requester: string): Promise<PaymentRow> {
    const key = createHash("sha256").update(`${l.id}\n${requester}`).digest("hex");
    const found = this.payments.findDraft(l.id, key, amount, method);
    if (found) return found;
    return this.payments.create(m, { amount, method, link_id: l.id, description: l.title, success_url: l.success_url, expires_in: MIN_EXPIRES_IN_SECONDS }, { draftKey: key });
  }

  /** The payment of this link that already accepted these vouchers, for an idempotent retry. */
  paymentForVouchers(linkId: string, vouchers: VoucherPayload[]): PaymentRow | undefined {
    const callId = callIdOf({ mandateId: vouchers[0]!.mandateId.toLowerCase() as Hex, payee: getAddress(vouchers[0]!.payee), cumulative: vouchers[0]!.cumulative, requestHash: vouchers[0]!.requestHash });
    return this.db.get<PaymentRow>("SELECT p.* FROM payments p JOIN payment_credits c ON c.payment_id = p.id WHERE c.call_id = ? AND p.link_id = ?", callId, linkId);
  }

  /** The receipts of vouchers this payment already accepted, when every presented voucher is one of them (same amount). */
  #voucherReplay(p: PaymentRow, callIds: Hex[], vouchers: VoucherPayload[]) {
    const rows = callIds.map((id) =>
      this.db.get<CallRow>("SELECT c.* FROM calls c JOIN payment_credits pc ON pc.call_id = c.call_id WHERE c.call_id = ? AND pc.payment_id = ?", id, p.id),
    );
    if (rows.length === 0 || rows.some((r, i) => !r || BigInt(r.amount) !== vouchers[i]!.amount)) return null;
    const receipts = (rows as CallRow[]).map((c) => ({
      ok: true as const,
      receipt: {
        callId: c.call_id,
        mandateId: c.mandate_id,
        payee: c.payee,
        amount: c.amount,
        cumulative: c.cumulative,
        requestHash: c.request_hash,
        timestamp: c.timestamp,
        leaf: c.leaf,
        nodeSignature: c.node_signature,
        node: this.chain.operator.address,
      },
      position: this.#vouchers.positionJson(c.mandate_id, c.payee),
    }));
    return { ok: true as const, receipts, payment: this.payments.row(p.id)! };
  }

  async #agentOf(v: VoucherPayload): Promise<Address | null> {
    return this.db.get<{ agent: Address }>("SELECT agent FROM mandates WHERE id = ?", v.mandateId.toLowerCase())?.agent ?? null;
  }

  /** Settlement hook, inside the booking transaction: voucher credits of the batch's calls are now confirmed. */
  #onBatchConfirmed(b: { seq: number; batchId: Hex; txHash: Hex; blockNumber: number }) {
    const credits = this.db.all<CreditRow>(
      "SELECT pc.* FROM payment_credits pc JOIN calls c ON c.call_id = pc.call_id WHERE c.batch_seq = ? AND pc.status = 'pending'",
      b.seq,
    );
    for (const c of credits) this.payments.confirmCredit(c.id, { txHash: b.txHash, blockNumber: b.blockNumber, batchId: b.batchId });
  }

  // ------------------------------------------------------------------ x402 requirements

  requirements(o: {
    merchant: MerchantRow;
    amount: bigint;
    payment: PaymentRow | null;
    /** The x402-quoted payment whose forwarder an exact client pays. */
    exactPayment: PaymentRow | null;
    /** The payment an agent may pay through HSP (re-quoted for HSP when it prepares). */
    hspPayment?: PaymentRow | null;
    resource: string;
    description: string;
    error?: string;
  }): X402PaymentRequired {
    const { merchant: m } = o;
    const net = networkFor(this.chainId);
    const accepts: X402PaymentRequired["accepts"] = [];
    const ttl = o.payment ? Math.max(1, Math.min(MAX_X402_TIMEOUT_SEC, o.payment.expires_unix - this.#clock())) : MAX_X402_TIMEOUT_SEC;
    // x402 exact pays the payment's forwarder, so it is offered only once the payment exists (a link's 402 creates one).
    // Only while there is something left to pay: a paid or overpaid payment must never advertise a zero or negative amount.
    const exactLeft = o.exactPayment ? BigInt(o.exactPayment.amount_due) - BigInt(o.exactPayment.amount_paid) : 0n;
    if (o.exactPayment && exactLeft > 0n && !isTerminalPaymentStatus(o.exactPayment.status)) {
      const p = o.exactPayment;
      accepts.push({
        scheme: "exact",
        network: net.caip2,
        amount: exactLeft.toString(),
        asset: this.token.address,
        payTo: p.deposit_address,
        resource: o.resource,
        description: o.description,
        mimeType: "application/json",
        maxTimeoutSeconds: Math.max(1, Math.min(MAX_X402_TIMEOUT_SEC, p.expires_unix - this.#clock())),
        extra: { name: this.domain.name, version: this.domain.version, paymentId: p.id },
      });
    }
    const hsp = o.hspPayment ? this.#hspRequirement(m, o.hspPayment, o.resource, o.description) : null;
    if (hsp) accepts.push(hsp);
    try {
      if (!o.payment || BigInt(o.payment.amount_paid) === 0n) {
        const q = this.payments.quote(m, o.amount, "voucher");
        for (const s of this.voucherSplit(m, q)) {
          accepts.push({
            scheme: SCHEME,
            network: net.caip2,
            asset: this.token.address,
            payTo: s.provider.payee,
            amount: s.amount.toString(),
            resource: o.resource,
            description: o.description,
            mimeType: "application/json",
            maxTimeoutSeconds: ttl,
            extra: { clearingNode: this.#publicUrl, clearingHub: this.chain.hub, providerId: s.provider.id, tokenSymbol: this.token.symbol, tokenDecimals: this.token.decimals },
          });
        }
      }
    } catch {
      // vouchers not available for this merchant or amount.
    }
    return {
      x402Version: X402_VERSION,
      ...(o.error ? { error: o.error } : {}),
      resource: { url: o.resource, description: o.description, mimeType: "application/json" },
      accepts,
    };
  }

  /**
   * The `hsp` offer (section 17): an untouched payment HSP can take now. payTo is the forwarder of the payment's HSP
   * quote (where it moves when the agent prepares), amount its amount due; the agent starts at prepareUrl.
   */
  #hspRequirement(m: MerchantRow, p: PaymentRow, resource: string, description: string): HspRequirement | null {
    if (!this.hsp || p.status !== "open" || p.amount_paid !== "0" || isHspInFlight(p.hsp_status)) return null;
    let q;
    try {
      q = this.payments.quote(m, BigInt(p.amount), "hsp");
    } catch {
      return null;
    }
    const feeRecipient = q.fee_total > 0n ? (this.merchants.platformRow()?.fee_recipient ?? null) : null;
    const payTo = p.quote_method === "hsp" ? p.deposit_address : this.rails.deposit({ paymentId: p.id, payout: p.payout, feeRecipient, fee: q.fee_total, amountDue: q.amount_due }).address;
    const base = `${this.#publicUrl.replace(/\/+$/, "")}/v1/checkout/${p.id}/hsp`;
    return {
      scheme: HSP_SCHEME,
      network: networkFor(this.chainId).caip2,
      amount: q.amount_due.toString(),
      asset: this.token.address,
      payTo,
      resource,
      description,
      mimeType: "application/json",
      maxTimeoutSeconds: Math.max(1, p.expires_unix - this.#clock()),
      extra: { paymentId: p.id, prepareUrl: `${base}/prepare`, submitUrl: `${base}/submit`, statusUrl: base, x402Version: X402_VERSION },
    };
  }

  #payment(id: string): PaymentRow {
    const p = this.payments.row(id);
    if (!p) throw new ApiError(404, "NOT_FOUND", "payment not found");
    return p;
  }

  // ------------------------------------------------------------------ proofs (section 13.3) and orders (13.2)

  /** The canonical order JSON, the exact bytes order_hash is keccak256 of. Carries no metadata. */
  order(p: PaymentRow): string {
    return canonicalOrder(this.payments.order(p));
  }

  async proof(p: PaymentRow) {
    if (p.status !== "paid" && p.status !== "overpaid") throw new ApiError(409, "NOT_PAID", `a proof exists only for paid payments (status is ${p.status})`);
    const head = await this.chain.headOf();
    const credits = this.payments.credits(p.id).filter((c) => c.status === "confirmed");
    const items = [];
    for (const c of credits) {
      const r = c.tx_hash ? await this.chain.receiptOf(c.tx_hash) : null;
      const transfers = r
        ? parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: r.logs.filter((l) => isAddressEqual(l.address, this.token.address)) })
            // A deposit, wallet or x402 credit is one Transfer to the forwarder; batch transactions show every transfer.
            .filter((l) => c.method === "voucher" || Number(l.logIndex) === c.log_index)
            .map((l) => ({ log_index: Number(l.logIndex), from: l.args.from, to: l.args.to, value: l.args.value.toString() }))
        : [];
      const used = r
        ? parseEventLogs({ abi: eip3009Abi, eventName: "AuthorizationUsed", logs: r.logs.filter((l) => isAddressEqual(l.address, this.token.address)) }).map((l) => ({
            log_index: Number(l.logIndex),
            authorizer: l.args.authorizer,
            nonce: l.args.nonce,
          }))
        : [];
      items.push({
        method: c.method,
        amount: c.amount,
        payer: c.payer,
        tx_hash: c.tx_hash,
        block_number: r ? Number(r.blockNumber) : c.block_number,
        block_hash: r ? r.blockHash : c.block_hash,
        log_index: c.log_index,
        batch_id: c.batch_id,
        finality: r && r.blockNumber <= head ? "final" : r ? "pending" : "missing",
        transfers,
        authorization_used: c.method === "wallet" || c.method === "x402" ? used : [],
      });
    }
    const eas = this.#attester;
    return {
      payment_id: p.id,
      livemode: this.ctx.livemode,
      status: p.status,
      chain_id: this.chainId,
      confirm_tag: this.chain.confirmTag,
      token: this.token,
      payout: p.payout,
      amount_due: p.amount_due,
      amount_paid: p.amount_paid,
      order_hash: p.order_hash,
      paid_at: p.paid_at,
      credits: items,
      attestation: eas
        ? {
            enabled: true,
            status: p.attest_status,
            uid: p.attestation_uid,
            tx_hash: p.attestation_tx,
            eas: eas.eas,
            schema: PAYMENT_SCHEMA,
            schema_uid: schemaUid(PAYMENT_SCHEMA),
            attester: this.chain.operator.address,
            payment_ref: this.rails.paymentRefOf(p.id),
          }
        : { enabled: false, status: "disabled", reason: "EAS attestation is off on this node (EAS_ATTEST=false or no EAS predeploy on this chain)" },
    };
  }

  /** Attests paid payments on EAS (EAS_ATTEST=true). Failures are retried; payment state never depends on them. */
  async attestDue(): Promise<void> {
    if (!this.#attester) return;
    const due = this.db.all<PaymentRow>("SELECT * FROM payments WHERE attest_status = 'pending' ORDER BY paid_at LIMIT 5");
    for (const p of due) {
      try {
        const tx = this.db.get<{ tx_hash: Hex | null }>("SELECT tx_hash FROM payment_credits WHERE payment_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1", p.id)?.tx_hash ?? zeroHash;
        const a = await this.#attester.attestPayment({
          paymentRef: this.rails.paymentRefOf(p.id),
          orderHash: p.order_hash,
          payer: p.payer ?? zeroAddress,
          payout: p.payout,
          token: this.token.address,
          amount: BigInt(p.amount_paid),
          txHash: tx,
        });
        this.db.run("UPDATE payments SET attest_status = 'done', attestation_uid = ?, attestation_tx = ?, attest_error = NULL WHERE id = ?", a.uid, a.txHash, p.id);
      } catch (err) {
        this.db.run("UPDATE payments SET attest_error = ? WHERE id = ?", (err instanceof Error ? err.message : String(err)).slice(0, 300), p.id);
        this.log.warn("payment attestation failed; retrying", { paymentId: p.id, err });
      }
    }
  }

  // ------------------------------------------------------------------ service directory (section 13.4)

  directory() {
    const net = networkFor(this.chainId);
    const token = { ...this.token, chain_id: this.chainId };
    const links = this.links.listed().map((l) => {
      const m = this.merchants.merchant(l.merchant_id);
      const price = BigInt(l.amount ?? l.min_amount!);
      const schemes = [
        ...(this.#quotes(m, price, "x402") ? ["exact"] : []),
        ...(this.#quotes(m, price, "voucher") ? [SCHEME] : []),
        ...(this.hsp && this.#quotes(m, price, "hsp") ? [HSP_SCHEME] : []),
      ];
      return {
        type: "link" as const,
        id: l.id,
        merchant: { id: m.id, name: m.name },
        title: l.title,
        description: l.description,
        price: l.amount !== null ? { amount: l.amount } : { min_amount: l.min_amount, max_amount: l.max_amount },
        token,
        chain_id: this.chainId,
        schemes,
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
        token,
        chain_id: this.chainId,
        schemes: [SCHEME],
        pay_url: p.resource,
      }));
    return {
      version: 1,
      node: { url: this.#publicUrl, chain_id: this.chainId, network: net.caip2, hub: this.chain.hub, checkout_base_url: this.ctx.checkoutBaseUrl },
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

const domainSeparatorAbi = [{ type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const;

