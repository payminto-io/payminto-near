/**
 * The any-chain checkout rail (method `oneclick`): a buyer pays from another chain through NEAR Intents (the 1Click
 * API) and the merchant receives exactly the invoice amount of USDC in its own NEAR account. The node, never the
 * browser, talks to 1Click: it builds every quote, checks the signed answer before a deposit address is shown, keeps
 * the whole signed quote, watches the status, and counts a payment only after it read the delivery on NEAR itself.
 *
 * The node core never imports @payminto/near-addons: this module only takes its types, and server.ts loads the package
 * with a dynamic import when INTENTS_CHECKOUT is not off. Nothing here signs or sends a transaction.
 */
import type * as Kit from "@payminto/near-addons/intents";
import {
  INTENTS_LABELS,
  INTENTS_QUOTE_STATUSES,
  intentsPayoutProofRequest,
  isTerminalPaymentStatus,
  newIntentsQuoteId,
  PAYOUT_PROOF_MAX_AGE_SECONDS,
  storageDepositTx,
  TERMINAL_INTENTS_STATUSES,
  verifyIntentsPayoutSignature,
  type AccountId,
  type IntentsCheckout,
  type IntentsDepositEvent,
  type IntentsOption,
  type IntentsOptions,
  type IntentsPayout,
  type IntentsPayoutProof,
  type IntentsPlatformStatus,
  type IntentsQuote,
  type IntentsQuoteStatus,
  type IntentsStep,
  type IntentsTx,
  type PaymentIntents,
} from "@payminto/protocol";
import type { IntentsConfig } from "../config.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { Mutex } from "../mutex.ts";
import { nowIso } from "../store.ts";
import type { CheckoutRail } from "./checkout.ts";
import type { IntentsChainReader } from "./intents-rpc.ts";
import type { MerchantRow, MerchantService } from "./merchants.ts";
import { isoOf, type CreditRow, type PaymentRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";
import type { WebhookService } from "./webhooks.ts";

export type IntentsKit = typeof Kit;
type FetchLike = Kit.FetchLike;
type QuoteResponse = Kit.QuoteResponse;
type StatusResponse = Kit.StatusResponse;
type CheckoutOrigin = Kit.CheckoutOrigin;

/** A wet quote is refused with less than this left before the payment expires. */
export const MIN_QUOTE_WINDOW_SEC = 600;
/** The longest a deposit address is asked for. */
export const QUOTE_TTL_SEC = 1_800;
/** Active quotes a payment may have at once. */
export const MAX_ACTIVE_QUOTES = 5;
/** Dry prices are reused this long per origin, amount and recipient. */
export const OPTIONS_CACHE_SEC = 30;
/** A 404 for a new deposit address is "not seen yet" for this long. */
export const NOT_FOUND_GRACE_SEC = 120;
/** After this, a delivery 1Click reports but the node cannot read is confirmed on 1Click's word (`provider_only`). */
export const PROVIDER_ONLY_AFTER_SEC = 600;
/** A quote whose address never saw a deposit is watched this long after its deadline, then marked expired. */
export const WATCH_AFTER_DEADLINE_SEC = 86_400;
/** NEP-145 registration of native USDC on NEAR mainnet: 0.00125 NEAR (storage_balance_bounds, read live 2026-11-10). */
export const USDC_STORAGE_DEPOSIT = "1250000000000000000000";

export type QuoteRow = {
  id: string;
  payment_id: string;
  merchant_id: string;
  mode: "live" | "simulated";
  origin_asset: string;
  origin_chain: string;
  origin_symbol: string;
  origin_decimals: number;
  recipient: AccountId;
  refund_to: string;
  slippage_bps: number;
  amount_out: string;
  amount_in: string;
  min_amount_in: string;
  amount_in_usd: string | null;
  refund_fee: string | null;
  withdraw_fee: string | null;
  time_estimate_sec: number;
  deposit_address: string;
  deposit_memo: string | null;
  deadline_unix: number;
  inactive_unix: number | null;
  correlation_id: string;
  signature_valid: number;
  quote_json: string;
  status: IntentsQuoteStatus;
  provider_status: string | null;
  deposited_amount: string | null;
  delivered_amount: string | null;
  refunded_amount: string | null;
  refund_reason: string | null;
  origin_txs: string;
  destination_txs: string;
  near_txs: string;
  delivery_tx: string | null;
  verification: "rpc_checked" | "provider_only" | null;
  delivered_unix: number | null;
  last_status_json: string | null;
  next_poll_unix: number;
  poll_errors: number;
  created_at: string;
  updated_at: string;
};

type WireTx = { hash: string; explorerUrl?: string };
type LastCall = NonNullable<IntentsPlatformStatus["last_call"]>;

const STEP_LABELS: Record<IntentsStep["key"], string> = {
  waiting: "Waiting for deposit",
  received: "Deposit received",
  converting: "Converting to USDC",
  delivered: "Delivered to merchant",
};
/** How many steps each state has finished, and whether the next one failed. */
const STEP_PROGRESS: Record<IntentsQuoteStatus, { done: number; failed: boolean }> = {
  awaiting_deposit: { done: 0, failed: false },
  incomplete_deposit: { done: 0, failed: false },
  deposit_detected: { done: 1, failed: false },
  processing: { done: 2, failed: false },
  delivered: { done: 3, failed: false },
  confirmed: { done: 4, failed: false },
  refunded: { done: 1, failed: true },
  failed: { done: 1, failed: true },
  expired: { done: 0, failed: true },
};
const ACTIVE: readonly IntentsQuoteStatus[] = ["awaiting_deposit", "deposit_detected", "incomplete_deposit", "processing", "delivered"];
const inList = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(", ");

const mask = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
const hhmm = (unix: number) => new Date(unix * 1000).toISOString().slice(11, 16);

/** A transaction hash on any of the origin chains: 0x and 64 hex (EVM), or base58 (Solana, NEAR). */
export const ORIGIN_TX_HASH = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,90})$/;

export type IntentsDeps = {
  config: IntentsConfig;
  kit: IntentsKit;
  reader: IntentsChainReader;
  /** The HTTP client for 1Click (tests pass the fake server's in-process fetch). */
  fetch?: FetchLike;
  db: Database;
  payments: PaymentService;
  merchants: MerchantService;
  webhooks: WebhookService;
  log: Logger;
  hub: AccountId;
  /** Unix seconds. */
  clock: () => number;
};

/** What the hosted page needs to offer `oneclick` on a payment, or null when this rail cannot take it now. */
export class IntentsRail implements CheckoutRail<IntentsCheckout> {
  readonly method = "oneclick";
  readonly #s: IntentsService;
  constructor(s: IntentsService) {
    this.#s = s;
  }
  offer(p: PaymentRow): IntentsCheckout | null {
    const view = this.#s.checkout(p);
    return view.available ? view : null;
  }
}

export class IntentsService {
  readonly mode: "simulated" | "live";
  readonly label: string;
  /** Where the USDC lands: `near:mainnet`, or `near:mainnet (simulated)`. */
  readonly settlementNetwork: string;
  readonly usdcContract: AccountId;
  readonly origins: readonly CheckoutOrigin[];
  readonly config: IntentsConfig;
  readonly kit: IntentsKit;
  readonly #reader: IntentsChainReader;
  readonly #client: Kit.OneClickClient;
  readonly #fetch: FetchLike;
  readonly #db: Database;
  readonly #payments: PaymentService;
  readonly #merchants: MerchantService;
  readonly #webhooks: WebhookService;
  readonly #log: Logger;
  readonly #hub: AccountId;
  readonly #clock: () => number;
  readonly #locks = new Map<string, Mutex>();
  readonly #options = new Map<string, { at: number; rows: Promise<IntentsOption[]> }>();
  #lastCall: LastCall | null = null;
  #rateRemaining: number | null = null;

  constructor(d: IntentsDeps) {
    const k = d.kit;
    this.config = d.config;
    this.kit = k;
    this.mode = d.config.mode;
    this.label = INTENTS_LABELS[this.mode];
    this.settlementNetwork = this.mode === "live" ? "near:mainnet" : "near:mainnet (simulated)";
    // Live mode always pays into native USDC on NEAR mainnet and checks quotes against the published 1Click key.
    if (this.mode === "live" && (d.config.usdcContract || d.config.managerPublicKey)) throw new Error("INTENTS_CHECKOUT=live always uses native USDC and the published 1Click key");
    if (this.mode === "live" && d.config.baseUrl !== k.ONECLICK_BASE_URL && !/^https:/.test(d.config.baseUrl)) throw new Error("INTENTS_CHECKOUT=live needs an https 1Click URL");
    if (this.mode === "simulated" && d.config.managerPublicKey === k.ONECLICK_MANAGER_PUBLIC_KEY) throw new Error("INTENTS_CHECKOUT=simulated must not use the published 1Click key");
    this.usdcContract = d.config.usdcContract ?? k.NEAR_MAINNET_USDC;
    const wanted = d.config.origins ?? k.CHECKOUT_ORIGINS.map((o) => o.assetId);
    const unknown = wanted.filter((a) => !k.originOf(a));
    if (unknown.length) throw new Error(`INTENTS_ORIGINS: not offered origins: ${unknown.join(", ")}`);
    this.origins = k.CHECKOUT_ORIGINS.filter((o) => wanted.includes(o.assetId));
    this.#reader = d.reader;
    this.#db = d.db;
    this.#payments = d.payments;
    this.#merchants = d.merchants;
    this.#webhooks = d.webhooks;
    this.#log = d.log;
    this.#hub = d.hub;
    this.#clock = d.clock;
    this.#fetch = this.#recording(d.fetch ?? (globalThis.fetch as unknown as FetchLike));
    this.#client = new k.OneClickClient({ baseUrl: d.config.baseUrl, ...(d.config.apiKey ? { apiKey: d.config.apiKey } : {}), fetch: this.#fetch });
  }

  /** Every 1Click call goes through here: a timeout, the last call and the rate limit left, for the platform status. */
  #recording(inner: FetchLike): FetchLike {
    return async (url, init) => {
      const at = nowIso();
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      try {
        const res = await inner(url, init);
        const r = res as typeof res & { headers?: { get(n: string): string | null } };
        const remaining = r.headers?.get("x-ratelimit-remaining") ?? r.headers?.get("x-ratelimit-remaining-unauth") ?? null;
        if (remaining !== null && /^\d+$/.test(remaining)) this.#rateRemaining = Number(remaining);
        this.#lastCall = { at, method, path, status: res.status, ok: res.status >= 200 && res.status < 300, error: null };
        return res;
      } catch (err) {
        this.#lastCall = { at, method, path, status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    };
  }

  #mgr(): { managerPublicKey: string } | Record<string, never> {
    return this.config.managerPublicKey ? { managerPublicKey: this.config.managerPublicKey } : {};
  }

  #lock(paymentId: string): Mutex {
    let m = this.#locks.get(paymentId);
    if (!m) this.#locks.set(paymentId, (m = new Mutex()));
    return m;
  }

  // ------------------------------------------------------------------ the merchant's NEAR account

  /** The account, proven, existing and registered with USDC: only then can `oneclick` be on. */
  verified(m: MerchantRow): boolean {
    return !!m.intents_payout && !!m.intents_payout_proven_at && m.intents_payout_registered === 1;
  }

  #scope() {
    return { settlementNetwork: this.settlementNetwork, hub: this.#hub };
  }

  /** The proof request a wallet signs for this merchant and account (the dashboard builds the same one itself). */
  proofRequest(merchantId: string, account: AccountId, timestamp: number) {
    return intentsPayoutProofRequest(merchantId, account, timestamp, this.#scope());
  }

  async payoutView(m: MerchantRow, fresh = true): Promise<IntentsPayout> {
    const account = m.intents_payout ?? null;
    let exists: boolean | null = null;
    let registered: boolean | null = account ? m.intents_payout_registered === 1 : null;
    if (account && fresh) {
      // Read now: a human may have just sent the storage_deposit. A failed read leaves the stored answer.
      try {
        [exists, registered] = await Promise.all([this.#reader.accountExists(account), this.#reader.storageRegistered(this.usdcContract, account)]);
        if ((registered ? 1 : 0) !== m.intents_payout_registered) {
          this.#db.run("UPDATE merchants SET intents_payout_registered = ?, updated_at = ? WHERE id = ?", registered ? 1 : 0, nowIso(), m.id);
          m = this.#merchants.merchant(m.id);
        }
      } catch (err) {
        this.#log.warn("could not read the any-chain payout account", { merchantId: m.id, account, err });
        exists = null;
      }
    }
    const proven = !!account && !!m.intents_payout_proven_at;
    return {
      object: "intents_payout",
      mode: this.mode,
      label: this.label,
      settlement_network: this.settlementNetwork,
      account,
      verified: this.verified(m) && exists !== false,
      checks: { exists, usdc_registered: registered, proven, proven_at: m.intents_payout_proven_at ?? null },
      usdc: { contract: this.usdcContract, asset_id: `nep141:${this.kit.NEAR_MAINNET_USDC}`, decimals: 6 },
      storage_step:
        account && registered === false
          ? {
              why: `${account} is not registered with USDC yet, so a delivery to it would fail. Send this storage_deposit from ${account} (it costs 0.00125 NEAR, once).`,
              deposit_near: "0.00125",
              transaction: storageDepositTx(this.usdcContract, account, USDC_STORAGE_DEPOSIT),
            }
          : null,
      enabled: this.#merchants.method(m.id, "oneclick")?.enabled === 1,
      proof_scope: { settlement_network: this.settlementNetwork, hub: this.#hub },
      checked_at: nowIso(),
    };
  }

  /**
   * Sets the merchant's NEAR account after checking, on the settlement chain: the NEP-413 signature (fresh, for this
   * merchant, this account and this node), that the key is a full-access key of the account, and that the account
   * exists. USDC registration is stored as read; without it the account is saved but not verified.
   */
  async setPayout(m: MerchantRow, account: AccountId, proof: IntentsPayoutProof): Promise<IntentsPayout> {
    const age = this.#clock() - proof.timestamp;
    if (age > PAYOUT_PROOF_MAX_AGE_SECONDS || age < -60) throw new ApiError(400, "PAYOUT_PROOF_EXPIRED", `the signed timestamp must be within ${PAYOUT_PROOF_MAX_AGE_SECONDS}s`);
    if (!verifyIntentsPayoutSignature(account, proof, m.id, this.#scope())) {
      throw new ApiError(400, "PAYOUT_PROOF_INVALID", "the signature does not match the any-chain payout message for this business, account and node");
    }
    const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> =>
      fn().catch((err: unknown) => {
        this.#log.warn(`could not read ${what}`, { account, err });
        throw new ApiError(503, "CHAIN_UNAVAILABLE", `could not read ${what} from NEAR; try again`);
      });
    if (!(await read("the account", () => this.#reader.accountExists(account)))) {
      throw new ApiError(400, "ACCOUNT_NOT_FOUND", `${account} does not exist on ${this.mode === "live" ? "NEAR mainnet" : "the local chain"}`);
    }
    const kind = await read("the account's keys", () => this.#reader.accessKey(account, proof.public_key));
    if (kind !== "full_access") {
      throw new ApiError(400, "PAYOUT_PROOF_INVALID", kind === "function_call" ? "the signing key is a function-call key; sign with a full-access key of the account" : "the signing key is not a key of this account");
    }
    const registered = await read("the USDC registration", () => this.#reader.storageRegistered(this.usdcContract, account));
    const at = nowIso();
    this.#db.run(
      "UPDATE merchants SET intents_payout = ?, intents_payout_proven_at = ?, intents_payout_registered = ?, intents_payout_proof = ?, updated_at = ? WHERE id = ?",
      account,
      at,
      registered ? 1 : 0,
      JSON.stringify({ public_key: proof.public_key, signature: proof.signature, timestamp: proof.timestamp, settlement_network: this.settlementNetwork, hub: this.#hub }),
      at,
      m.id,
    );
    this.#log.info("any-chain payout account set", { merchantId: m.id, account, registered });
    return this.payoutView(this.#merchants.merchant(m.id), false);
  }

  /** `PUT /v1/merchants/{id}/methods` turning `oneclick` on. */
  assertCanEnable(m: MerchantRow): void {
    if (!m.intents_payout) throw new ApiError(409, "INTENTS_PAYOUT_REQUIRED", "set a NEAR account for any-chain payments first (PUT /v1/merchant/intents-payout)");
    if (!m.intents_payout_proven_at) throw new ApiError(409, "INTENTS_PAYOUT_REQUIRED", "prove the NEAR account for any-chain payments with a signed message first");
    if (m.intents_payout_registered !== 1) throw new ApiError(409, "INTENTS_PAYOUT_NOT_REGISTERED", `${m.intents_payout} is not registered with USDC yet; send the storage_deposit shown by GET /v1/merchant/intents-payout`);
  }

  // ------------------------------------------------------------------ the hosted checkout

  /** Whether this payment can be paid from another chain now, and why not. */
  availability(p: PaymentRow, m: MerchantRow = this.#merchants.merchant(p.merchant_id)): { available: boolean; reason: string | null } {
    const no = (reason: string) => ({ available: false, reason });
    if (this.#merchants.method(m.id, "oneclick")?.enabled !== 1) return no("This business does not take payments from other chains.");
    if (!this.verified(m)) return no("This business has not finished setting up payments from other chains.");
    if (m.status !== "active") return no("This business is not taking payments.");
    if (isTerminalPaymentStatus(p.status) || this.#clock() >= p.expires_unix) return no("This payment is closed.");
    if (p.status === "processing") return no("A payment for this checkout is already being confirmed.");
    if (BigInt(p.fee_total) > 0n) return no("This payment carries a platform fee, which a payment from another chain cannot split off.");
    if (BigInt(p.amount_due) - BigInt(p.amount_paid) <= 0n) return no("Nothing is left to pay.");
    if (p.expires_unix - this.#clock() < MIN_QUOTE_WINDOW_SEC) return no("This checkout expires too soon to pay from another chain.");
    return { available: true, reason: null };
  }

  /** `intents` on the checkout view and its SSE stream. */
  checkout(p: PaymentRow): IntentsCheckout {
    const a = this.availability(p);
    const row = this.#db.get<QuoteRow>("SELECT * FROM intents_quotes WHERE payment_id = ? AND status != 'expired' ORDER BY created_at DESC, rowid DESC LIMIT 1", p.id);
    return { mode: this.mode, label: this.label, available: a.available, reason: a.reason, settlement_network: this.settlementNetwork, active_quote: row ? this.json(row) : null };
  }

  /** `intents` on `GET /v1/payments/{id}`: every quote with its signed 1Click response, or null when there is none. */
  paymentIntents(paymentId: string): PaymentIntents | null {
    const rows = this.#db.all<QuoteRow>("SELECT * FROM intents_quotes WHERE payment_id = ? ORDER BY created_at, rowid", paymentId);
    if (!rows.length) return null;
    return { mode: this.mode, label: this.label, quotes: rows.map((r) => this.json(r, true)) };
  }

  #remaining(p: PaymentRow): bigint {
    return BigInt(p.amount_due) - BigInt(p.amount_paid);
  }

  #recipient(m: MerchantRow): AccountId {
    if (!m.intents_payout) throw new ApiError(409, "INTENTS_UNAVAILABLE", "This business has not finished setting up payments from other chains.");
    return m.intents_payout;
  }

  /** `GET /v1/checkout/{id}/intents/options`: each offered origin with an indicative dry price, or why it is greyed. */
  async options(p: PaymentRow): Promise<IntentsOptions> {
    const m = this.#merchants.merchant(p.merchant_id);
    const a = this.availability(p, m);
    if (!a.available) throw new ApiError(409, "INTENTS_UNAVAILABLE", a.reason!);
    const amount = this.#remaining(p);
    const recipient = this.#recipient(m);
    const now = this.#clock();
    const key = `${amount}|${recipient}`;
    let cached = this.#options.get(key);
    if (!cached || now - cached.at >= OPTIONS_CACHE_SEC) {
      cached = { at: now, rows: Promise.all(this.origins.map((o) => this.#dryOption(o, amount, recipient))) };
      this.#options.set(key, cached);
      // Old entries go once they cannot be served any more.
      for (const [k, v] of this.#options) if (now - v.at >= OPTIONS_CACHE_SEC) this.#options.delete(k);
    }
    const rows = await cached.rows;
    return {
      object: "intents_options",
      payment_id: p.id,
      mode: this.mode,
      label: this.label,
      amount_out: { amount: amount.toString(), formatted: this.kit.formatUnits(amount, 6), symbol: "USDC" },
      recipient,
      settlement_network: this.settlementNetwork,
      quoted_at: isoOf(cached.at),
      valid_until: isoOf(cached.at + OPTIONS_CACHE_SEC),
      options: rows,
    };
  }

  #originJson(o: Pick<CheckoutOrigin, "assetId" | "blockchain" | "chainName" | "symbol" | "decimals">) {
    return { asset: o.assetId, chain: o.blockchain, chain_name: o.chainName, symbol: o.symbol, decimals: o.decimals };
  }

  async #dryOption(origin: CheckoutOrigin, amount: bigint, recipient: AccountId): Promise<IntentsOption> {
    const slippage = this.kit.slippageFor(origin, this.config.slippage);
    const base = { origin: this.#originJson(origin), slippage_bps: slippage };
    const greyed = (reason: string): IntentsOption => ({ ...base, available: false, reason, amount_in: null, amount_in_usd: null, time_estimate_sec: null, fees: null });
    const asked = this.kit.payInQuoteRequest({
      origin,
      amount,
      recipient,
      refundTo: this.kit.DRY_QUOTE_REFUND_TO[origin.addressFormat],
      slippageBps: slippage,
      deadline: (this.#clock() + QUOTE_TTL_SEC) * 1000,
      dry: true,
      ...(this.config.referral ? { referral: this.config.referral } : {}),
    });
    let res: QuoteResponse;
    try {
      res = await this.#client.quote(asked);
    } catch (err) {
      if (err instanceof this.kit.OneClickError) {
        this.#log.info("1Click refused a dry quote", { origin: origin.assetId, status: err.status, message: err.message });
        if (err.status === 429) return greyed("NEAR Intents is busy; try again in a minute.");
        return greyed(this.kit.quoteErrorReason(err.message.replace(/^1Click \d+: /, "")));
      }
      this.#log.warn("dry quote failed", { origin: origin.assetId, err });
      return greyed("NEAR Intents could not be reached; try again in a minute.");
    }
    const refusals = this.kit.checkPayInQuote(asked, res, { recipient, now: this.#clock() * 1000, ...this.#mgr() });
    if (refusals.length) {
      this.#log.error("a dry 1Click quote failed the checks; the origin is shown greyed", { origin: origin.assetId, correlationId: res.correlationId, refusals });
      return greyed("The price for this route could not be verified.");
    }
    const fees = this.kit.feeLines(res, origin);
    return { ...base, available: true, reason: null, amount_in: fees.send_exactly, amount_in_usd: res.quote.amountInUsd, time_estimate_sec: res.quote.timeEstimate, fees };
  }

  /**
   * `POST /v1/checkout/{id}/intents/quotes`: a wet quote, checked before its deposit address is stored or shown. An
   * active quote for the same origin and refund address with 10 minutes or more left is reused.
   */
  async createQuote(p0: PaymentRow, b: { origin_asset: string; refund_to: string }): Promise<{ quote: IntentsQuote; reused: boolean }> {
    const origin = this.origins.find((o) => o.assetId === b.origin_asset);
    if (!origin) throw new ApiError(400, "ORIGIN_NOT_OFFERED", `${b.origin_asset} is not an origin this checkout offers`);
    if (!this.kit.isOriginAddress(origin, b.refund_to)) throw new ApiError(400, "INVALID_REFUND_ADDRESS", `the refund address is not a valid ${origin.chainName} address`);
    return this.#lock(p0.id).run(async () => {
      const p = this.#payments.row(p0.id)!;
      const m = this.#merchants.merchant(p.merchant_id);
      const a = this.availability(p, m);
      if (!a.available) throw new ApiError(409, "INTENTS_UNAVAILABLE", a.reason!);
      const amount = this.#remaining(p);
      const recipient = this.#recipient(m);
      const now = this.#clock();
      const reuse = this.#db.get<QuoteRow>(
        `SELECT * FROM intents_quotes WHERE payment_id = ? AND origin_asset = ? AND refund_to = ? AND recipient = ? AND amount_out = ? AND status = 'awaiting_deposit' AND deadline_unix >= ?
         ORDER BY created_at DESC LIMIT 1`,
        p.id,
        origin.assetId,
        b.refund_to,
        recipient,
        amount.toString(),
        now + MIN_QUOTE_WINDOW_SEC,
      );
      if (reuse) return { quote: this.json(reuse), reused: true };
      const active = this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM intents_quotes WHERE payment_id = ? AND status IN (${inList(ACTIVE)}) AND deadline_unix > ?`, p.id, now)!.n;
      if (active >= MAX_ACTIVE_QUOTES) throw new ApiError(409, "INTENTS_QUOTE_LIMIT", `this payment already has ${MAX_ACTIVE_QUOTES} deposit addresses waiting; use one of them`);
      const deadline = Math.min(p.expires_unix, now + QUOTE_TTL_SEC);
      if (deadline - now < MIN_QUOTE_WINDOW_SEC) throw new ApiError(409, "INTENTS_UNAVAILABLE", "This checkout expires too soon to pay from another chain.");
      const slippage = this.kit.slippageFor(origin, this.config.slippage);
      const asked = this.kit.payInQuoteRequest({
        origin,
        amount,
        recipient,
        refundTo: b.refund_to,
        slippageBps: slippage,
        deadline: deadline * 1000,
        dry: false,
        ...(this.config.referral ? { referral: this.config.referral } : {}),
      });
      let res: QuoteResponse;
      try {
        res = await this.#client.quote(asked);
      } catch (err) {
        if (err instanceof this.kit.OneClickError) {
          this.#log.warn("1Click refused a quote", { paymentId: p.id, origin: origin.assetId, status: err.status, message: err.message, correlationId: err.correlationId });
          if (err.status === 429 || err.status >= 500) throw new ApiError(503, "INTENTS_BUSY", "NEAR Intents is busy; try again in a minute.");
          throw new ApiError(502, "INTENTS_QUOTE_FAILED", this.kit.quoteErrorReason(err.message.replace(/^1Click \d+: /, "")), { provider_message: err.message });
        }
        this.#log.warn("1Click could not be reached", { paymentId: p.id, err });
        throw new ApiError(503, "INTENTS_BUSY", "NEAR Intents could not be reached; try again in a minute.");
      }
      const refusals = this.kit.checkPayInQuote(asked, res, { recipient, now: now * 1000, ...this.#mgr() });
      if (refusals.length) {
        // The deposit address of a refused quote is never stored or shown: nobody can be told to pay into it.
        this.#log.error("a 1Click quote failed the checks; no deposit address is shown", { paymentId: p.id, correlationId: res.correlationId, refusals });
        throw new ApiError(502, "INTENTS_QUOTE_REFUSED", "The quote from NEAR Intents did not pass this checkout's checks, so no deposit address is shown. Try again or pay another way.", { refusals });
      }
      const q = res.quote;
      const id = newIntentsQuoteId();
      const at = nowIso();
      this.#db.tx(() => {
        this.#db.run(
          `INSERT INTO intents_quotes (id, payment_id, merchant_id, mode, origin_asset, origin_chain, origin_symbol, origin_decimals, recipient, refund_to, slippage_bps,
                                      amount_out, amount_in, min_amount_in, amount_in_usd, refund_fee, withdraw_fee, time_estimate_sec, deposit_address, deposit_memo,
                                      deadline_unix, inactive_unix, correlation_id, signature_valid, quote_json, status, next_poll_unix, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, 'awaiting_deposit', ?, ?, ?)`,
          id,
          p.id,
          m.id,
          this.mode,
          origin.assetId,
          origin.blockchain,
          origin.symbol,
          origin.decimals,
          recipient,
          b.refund_to,
          res.quoteRequest.slippageTolerance,
          amount.toString(),
          q.amountIn,
          q.minAmountIn,
          q.amountInUsd ?? null,
          q.refundFee ?? null,
          q.withdrawFee ?? null,
          q.timeEstimate,
          q.depositAddress!,
          Math.floor(Date.parse(q.deadline!) / 1000),
          q.timeWhenInactive ? Math.floor(Date.parse(q.timeWhenInactive) / 1000) : null,
          res.correlationId,
          JSON.stringify(res),
          now + 5,
          at,
          at,
        );
        // The payment now shows the method a person is paying with.
        const cur = this.#payments.row(p.id)!;
        if (cur.quote_method !== "oneclick" && cur.status === "open" && this.#payments.credits(p.id).length === 0) this.#payments.requote(cur, "oneclick");
        this.#payments.notify(p.id);
      });
      this.#log.info("any-chain deposit address issued", { paymentId: p.id, quoteId: id, origin: origin.assetId, amountIn: q.amountIn, correlationId: res.correlationId });
      return { quote: this.json(this.row(id)!), reused: false };
    });
  }

  row(id: string): QuoteRow | undefined {
    return this.#db.get<QuoteRow>("SELECT * FROM intents_quotes WHERE id = ?", id);
  }

  /** A quote of this payment, or 404 (ids never leak across payments). */
  quoteOf(p: PaymentRow, qid: string): QuoteRow {
    const r = this.row(qid);
    if (!r || r.payment_id !== p.id) throw new ApiError(404, "NOT_FOUND", "no such quote for this payment");
    return r;
  }

  /** `POST .../deposit`: tells 1Click about the buyer's transaction (it only speeds detection) and checks now. */
  async submitDeposit(r: QuoteRow, txHash: string): Promise<QuoteRow> {
    try {
      await this.#client.submitDeposit({ txHash, depositAddress: r.deposit_address });
    } catch (err) {
      // The deposit is found without it; the buyer is not told anything went wrong.
      this.#log.warn("1Click did not take the deposit transaction", { quoteId: r.id, err });
    }
    return this.checkNow(r.id);
  }

  /** `POST .../simulate`, simulated mode only: the fake server's control API reports a deposit. */
  async simulateDeposit(r: QuoteRow, amount: bigint): Promise<QuoteRow> {
    if (this.mode !== "simulated") throw new ApiError(404, "NOT_FOUND", "not found");
    if (TERMINAL_INTENTS_STATUSES.includes(r.status)) throw new ApiError(409, "QUOTE_CLOSED", `this quote is ${r.status}`);
    const res = await this.#fetch(`${this.config.baseUrl}/_fake/deposits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depositAddress: r.deposit_address, amount: amount.toString() }),
    });
    if (res.status !== 200) throw new ApiError(409, "SIMULATION_REFUSED", `the fake 1Click server refused the deposit: ${(await res.text()).slice(0, 200)}`);
    this.#log.info("simulated deposit reported to the fake 1Click server", { quoteId: r.id, amount: amount.toString() });
    return this.checkNow(r.id);
  }

  // ------------------------------------------------------------------ the watcher's work

  readonly #inflight = new Map<string, Promise<void>>();

  /** Polls one quote now (shared with a tick that is polling it already). */
  async checkNow(id: string): Promise<QuoteRow> {
    await this.poll(id);
    return this.row(id)!;
  }

  poll(id: string): Promise<void> {
    let p = this.#inflight.get(id);
    if (!p) {
      p = this.#poll(id).finally(() => this.#inflight.delete(id));
      this.#inflight.set(id, p);
    }
    return p;
  }

  /** Quotes due for a poll. */
  due(limit = 100): QuoteRow[] {
    return this.#db.all<QuoteRow>(`SELECT * FROM intents_quotes WHERE status IN (${inList(ACTIVE)}) AND next_poll_unix <= ? ORDER BY next_poll_unix LIMIT ?`, this.#clock(), limit);
  }

  /** 5 s while a checkout page watches the payment, 15 s otherwise, 60 s after the deadline. */
  #nextPoll(r: Pick<QuoteRow, "payment_id" | "deadline_unix">, errors = 0): number {
    const now = this.#clock();
    if (errors > 0) return now + Math.min(300, 15 * 2 ** Math.min(errors - 1, 4));
    if (now > r.deadline_unix) return now + 60;
    return now + (this.#payments.hasSubscribers(r.payment_id) ? 5 : 15);
  }

  async #poll(id: string): Promise<void> {
    const r = this.row(id);
    if (!r || !ACTIVE.includes(r.status)) return;
    const now = this.#clock();
    if (r.status === "delivered") return this.#confirmDelivery(r);
    let s: StatusResponse;
    try {
      s = await this.#client.status(r.deposit_address, r.deposit_memo ?? undefined);
    } catch (err) {
      const status = err instanceof this.kit.OneClickError ? err.status : 0;
      const fresh = now - Date.parse(r.created_at) / 1000 < NOT_FOUND_GRACE_SEC;
      if (status === 404 && fresh) return this.#touch(r, { next: this.#nextPoll(r) });
      if (r.status === "awaiting_deposit" && now > r.deadline_unix + WATCH_AFTER_DEADLINE_SEC) return this.#expire(r);
      // 404 after the grace, 429, 5xx or the network: back off and never change state.
      this.#log.warn("1Click status read failed; backing off", { quoteId: r.id, status, err: err instanceof Error ? err.message : String(err) });
      return this.#touch(r, { errors: r.poll_errors + 1, next: this.#nextPoll(r, r.poll_errors + 1) });
    }
    // The status must describe the quote this node stored, signature and all.
    const stored = JSON.parse(r.quote_json) as QuoteResponse;
    const embedded = s.quoteResponse;
    if (embedded && (embedded.correlationId !== stored.correlationId || embedded.signature !== stored.signature || embedded.quote?.depositAddress !== r.deposit_address)) {
      this.#log.error("1Click's status names another quote than the one stored; ignoring it", { quoteId: r.id, stored: stored.correlationId, got: embedded.correlationId });
      return this.#touch(r, { errors: r.poll_errors + 1, next: this.#nextPoll(r, r.poll_errors + 1) });
    }
    let next: IntentsQuoteStatus;
    try {
      next = this.kit.mapStatus(s.status);
    } catch {
      this.#log.error("1Click answered an unknown status", { quoteId: r.id, status: s.status });
      return this.#touch(r, { errors: r.poll_errors + 1, next: this.#nextPoll(r, r.poll_errors + 1) });
    }
    if (next === "awaiting_deposit" && now > r.deadline_unix + WATCH_AFTER_DEADLINE_SEC) return this.#expire(r);
    this.#apply(r, s, next);
    const after = this.row(id)!;
    if (after.status === "delivered") await this.#confirmDelivery(after);
  }

  #touch(r: QuoteRow, o: { errors?: number; next: number }) {
    this.#db.run("UPDATE intents_quotes SET poll_errors = ?, next_poll_unix = ?, updated_at = ? WHERE id = ?", o.errors ?? 0, o.next, nowIso(), r.id);
  }

  #expire(r: QuoteRow) {
    this.#db.tx(() => {
      this.#db.run("UPDATE intents_quotes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_deposit'", nowIso(), r.id);
      this.#payments.notify(r.payment_id);
    });
    this.#log.info("any-chain deposit address expired unused", { quoteId: r.id });
  }

  #credit(r: QuoteRow): CreditRow | undefined {
    return this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE intents_quote_id = ?", r.id);
  }

  /** A new 1Click status, applied with its credit and the payment's recompute in one transaction. */
  #apply(r: QuoteRow, s: StatusResponse, next: IntentsQuoteStatus) {
    const d = s.swapDetails;
    // Never back out of a terminal state, nor back from delivered.
    const status = TERMINAL_INTENTS_STATUSES.includes(r.status) || (r.status === "delivered" && ACTIVE.includes(next) && next !== "delivered") ? r.status : next;
    const txs = (xs: WireTx[] | undefined) => JSON.stringify((xs ?? []).map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl ?? "" })));
    const now = this.#clock();
    let event: "payment.deposit_returned" | "payment.deposit_failed" | null = null;
    this.#db.tx(() => {
      this.#db.run(
        `UPDATE intents_quotes SET status = ?, provider_status = ?, last_status_json = ?, deposited_amount = COALESCE(?, deposited_amount), refunded_amount = COALESCE(?, refunded_amount),
                refund_reason = COALESCE(?, refund_reason), delivered_amount = COALESCE(?, delivered_amount), origin_txs = ?, destination_txs = ?, near_txs = ?,
                delivered_unix = COALESCE(delivered_unix, ?), poll_errors = 0, next_poll_unix = ?, updated_at = ? WHERE id = ?`,
        status,
        s.status,
        JSON.stringify(s),
        d.depositedAmount ?? null,
        d.refundedAmount ?? null,
        d.refundReason ?? null,
        status === "delivered" ? (d.amountOut ?? null) : null,
        txs(d.originChainTxHashes),
        txs(d.destinationChainTxHashes),
        JSON.stringify(d.nearTxHashes ?? []),
        status === "delivered" ? now : null,
        this.#nextPoll(r),
        nowIso(),
        r.id,
      );
      const credit = this.#credit(r);
      if (["deposit_detected", "incomplete_deposit", "processing", "delivered"].includes(status) && !credit) {
        // Money is on its way: a pending credit holds the payment's expiry until the delivery is read on NEAR.
        this.#payments.addCredit({ paymentId: r.payment_id, method: "oneclick", payer: this.#payer(r), amount: BigInt(r.amount_out), txHash: null, intentsQuoteId: r.id, status: "pending", mayBeLate: true });
      }
      if ((status === "refunded" || status === "failed") && r.status !== status) {
        if (credit?.status === "pending") this.#payments.removeCredit(credit.id);
        event = status === "refunded" ? "payment.deposit_returned" : "payment.deposit_failed";
      }
      if (event) this.#emit(event, this.row(r.id)!);
      this.#payments.notify(r.payment_id);
    });
    if (status !== r.status) this.#log.info("any-chain payment moved", { quoteId: r.id, from: r.status, to: status, provider: s.status });
  }

  #payer(r: Pick<QuoteRow, "origin_chain" | "refund_to">): string {
    return `${r.origin_chain}:${r.refund_to}`;
  }

  #emit(type: "payment.deposit_returned" | "payment.deposit_failed", r: QuoteRow) {
    const p = this.#payments.row(r.payment_id)!;
    const object: IntentsDepositEvent = { ...this.#payments.json(p), intents: this.paymentIntents(p.id), deposit: this.json(r, true) };
    this.#webhooks.emit(r.merchant_id, type, r.id, p.id, object);
    // A failed swap is also an alert for the platform.
    if (type === "payment.deposit_failed" && this.#webhooks.hasSubscribers(null, type)) this.#webhooks.emit(null, type, r.id, p.id, object);
  }

  /**
   * 1Click says the USDC was delivered: read each delivery transaction on NEAR and look for the NEP-141 `ft_transfer`
   * event of the USDC contract to the merchant's account for at least the invoice amount. Found: confirmed
   * (`rpc_checked`). Not readable for 10 minutes: confirmed on 1Click's word (`provider_only`), with a warning. Read
   * but short or to someone else: never confirmed; it stays delivered and is logged as an error.
   */
  async #confirmDelivery(r: QuoteRow): Promise<void> {
    const destination = (JSON.parse(r.destination_txs) as WireTx[]).map((t) => t.hash);
    const hashes = [...new Set([...destination, ...(JSON.parse(r.near_txs) as string[])])];
    let contradicted = false;
    for (const hash of hashes) {
      let read;
      try {
        read = await this.#reader.delivery(hash, [...this.config.deliverySenders, r.recipient]);
      } catch (err) {
        this.#log.warn("could not read a delivery transaction", { quoteId: r.id, hash, err: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (read.status !== "final") continue;
      const to = read.transfers.filter((t) => t.token === this.usdcContract && t.to === r.recipient);
      const total = to.reduce((s, t) => s + t.amount, 0n);
      if (total >= BigInt(r.amount_out)) return this.#confirm(r, { verification: "rpc_checked", amount: total, tx: hash });
      contradicted = true;
      this.#log.error("a delivery transaction on NEAR does not pay the merchant the invoice amount", { quoteId: r.id, hash, recipient: r.recipient, token: this.usdcContract, found: total.toString(), due: r.amount_out });
    }
    const now = this.#clock();
    if (!contradicted && now - (r.delivered_unix ?? now) >= PROVIDER_ONLY_AFTER_SEC) {
      this.#log.warn("delivery not readable on NEAR after 10 minutes; confirming on 1Click's report (provider_only)", { quoteId: r.id, hashes });
      return this.#confirm(r, { verification: "provider_only", amount: BigInt(r.delivered_amount ?? r.amount_out), tx: destination[0] ?? null });
    }
    this.#touch(r, { next: contradicted ? now + 60 : this.#nextPoll(r) });
  }

  #confirm(r: QuoteRow, o: { verification: "rpc_checked" | "provider_only"; amount: bigint; tx: string | null }) {
    this.#db.tx(() => {
      const cur = this.row(r.id)!;
      if (cur.status !== "delivered") return;
      this.#db.run(
        "UPDATE intents_quotes SET status = 'confirmed', verification = ?, delivered_amount = ?, delivery_tx = ?, updated_at = ? WHERE id = ?",
        o.verification,
        o.amount.toString(),
        o.tx,
        nowIso(),
        r.id,
      );
      const credit = this.#credit(r);
      if (credit) this.#payments.confirmCredit(credit.id, { txHash: o.tx, amount: o.amount });
      else this.#payments.addCredit({ paymentId: r.payment_id, method: "oneclick", payer: this.#payer(r), amount: o.amount, txHash: o.tx, intentsQuoteId: r.id, status: "confirmed", mayBeLate: true });
      this.#payments.notify(r.payment_id);
    });
    this.#log.info("any-chain payment confirmed", { quoteId: r.id, verification: o.verification, tx: o.tx, amount: o.amount.toString() });
  }

  // ------------------------------------------------------------------ JSON

  #amount(v: string | null, decimals: number, symbol: string) {
    return v === null ? null : { amount: v, formatted: this.kit.formatUnits(v, decimals), symbol };
  }

  #tx(t: WireTx): IntentsTx {
    return { hash: t.hash, explorer_url: t.explorerUrl ? t.explorerUrl : null };
  }

  /** NEAR mainnet transactions link to NearBlocks; the local chain has no explorer. */
  nearExplorer(hash: string): string | null {
    return this.mode === "live" ? `https://nearblocks.io/txns/${hash}` : null;
  }

  #steps(status: IntentsQuoteStatus): IntentsStep[] {
    const p = STEP_PROGRESS[status];
    const keys: Array<IntentsStep["key"]> = ["waiting", "received", "converting", "delivered"];
    return keys.map((key, i) => ({
      key,
      label: STEP_LABELS[key],
      state: i < p.done ? "done" : i === p.done ? (p.failed ? "failed" : "current") : "pending",
    }));
  }

  /** The public JSON of a quote; `merchant` adds the full refund address and the signed 1Click response. */
  json(r: QuoteRow, merchant = false): IntentsQuote {
    const res = JSON.parse(r.quote_json) as QuoteResponse;
    const origin = this.kit.originOf(r.origin_asset);
    const o = { assetId: r.origin_asset, blockchain: r.origin_chain as CheckoutOrigin["blockchain"], chainName: origin?.chainName ?? r.origin_chain, symbol: r.origin_symbol, decimals: r.origin_decimals };
    const fees = this.kit.feeLines(res, { symbol: r.origin_symbol, decimals: r.origin_decimals, stable: origin?.stable ?? false });
    const destination = (JSON.parse(r.destination_txs) as WireTx[]).map((t) => this.#tx(t));
    const deliveryHash = r.delivery_tx ?? destination[0]?.hash ?? null;
    const out: IntentsQuote = {
      id: r.id,
      object: "intents_quote",
      payment_id: r.payment_id,
      mode: r.mode,
      label: INTENTS_LABELS[r.mode],
      status: r.status,
      provider_status: r.provider_status,
      origin: this.#originJson(o),
      deposit_address: r.deposit_address,
      deposit_memo: null,
      send_exactly: this.#amount(r.amount_in, r.origin_decimals, r.origin_symbol)!,
      min_amount_in: this.#amount(r.min_amount_in, r.origin_decimals, r.origin_symbol)!,
      amount_out: this.#amount(r.amount_out, 6, "USDC")!,
      amount_in_usd: r.amount_in_usd,
      fees,
      slippage_bps: r.slippage_bps,
      time_estimate_sec: r.time_estimate_sec,
      refund_to: merchant ? r.refund_to : mask(r.refund_to),
      recipient: r.recipient,
      settlement_network: r.mode === "live" ? "near:mainnet" : "near:mainnet (simulated)",
      deadline: isoOf(r.deadline_unix),
      deadline_passed: this.#clock() >= r.deadline_unix,
      inactive_at: r.inactive_unix === null ? null : isoOf(r.inactive_unix),
      deposited: this.#amount(r.deposited_amount, r.origin_decimals, r.origin_symbol),
      delivered: r.status === "confirmed" || r.status === "delivered" ? this.#amount(r.delivered_amount, 6, "USDC") : null,
      refunded: this.#amount(r.refunded_amount, r.origin_decimals, r.origin_symbol),
      refund_reason: r.refund_reason,
      origin_txs: (JSON.parse(r.origin_txs) as WireTx[]).map((t) => this.#tx(t)),
      destination_txs: destination,
      near_txs: JSON.parse(r.near_txs) as string[],
      delivery_tx: deliveryHash ? { hash: deliveryHash, explorer_url: destination.find((t) => t.hash === deliveryHash)?.explorer_url ?? this.nearExplorer(deliveryHash) } : null,
      verification: r.verification,
      steps: this.#steps(r.status),
      warning: `Send only ${r.origin_symbol} on the ${o.chainName} network, to this address. Other tokens, other networks, or a deposit after ${hhmm(r.deadline_unix)} UTC may be lost.`,
      correlation_id: r.correlation_id,
      signature_valid: r.signature_valid === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    if (merchant) out.quote_response = res;
    return out;
  }

  /** `GET /v1/platform/intents`. */
  platformStatus(): IntentsPlatformStatus {
    const counts = Object.fromEntries(INTENTS_QUOTE_STATUSES.map((s) => [s, 0])) as Record<IntentsQuoteStatus, number>;
    for (const c of this.#db.all<{ status: IntentsQuoteStatus; n: number }>("SELECT status, COUNT(*) AS n FROM intents_quotes GROUP BY status")) counts[c.status] = c.n;
    return {
      object: "intents_status",
      mode: this.mode,
      label: this.label,
      base_url: this.config.baseUrl,
      api_key_set: !!this.config.apiKey,
      manager_key: this.config.managerPublicKey ? "test" : "1click",
      near_rpc_url: redact(this.config.nearRpcUrl),
      usdc_contract: this.usdcContract,
      settlement_network: this.settlementNetwork,
      origins: this.origins.map((o) => o.assetId),
      slippage_bps: { ...this.config.slippage },
      referral: this.config.referral,
      last_call: this.#lastCall,
      rate_limit_remaining: this.#rateRemaining,
      counts,
    };
  }
}

function redact(u: string): string {
  try {
    const url = new URL(u);
    return url.username || url.password || url.search || /[0-9a-f]{16,}|[A-Za-z0-9_-]{24,}/.test(url.pathname) ? `${url.protocol}//${url.host}/***` : u;
  } catch {
    return "***";
  }
}

/**
 * Polls every quote that is due, like the payment watcher: overlapping ticks share one pass, and a quote checked by a
 * route at the same moment is polled once.
 */
export class IntentsWatcher {
  readonly #s: IntentsService;
  readonly #log: Logger;
  #busy: Promise<number> | null = null;

  constructor(s: IntentsService, log: Logger) {
    this.#s = s;
    this.#log = log;
  }

  tick(): Promise<number> {
    this.#busy ??= this.#run().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  async #run(): Promise<number> {
    const due = this.#s.due();
    for (const r of due) {
      await this.#s.poll(r.id).catch((err: unknown) => this.#log.warn("any-chain quote poll failed", { quoteId: r.id, err }));
    }
    return due.length;
  }
}

/** The reconciliation columns of one payment's confirmed any-chain quotes. */
export function reconciliationOf(rows: QuoteRow[], formatUnits: (v: string, d: number) => string) {
  const confirmed = rows.filter((r) => r.status === "confirmed");
  if (!confirmed.length) return null;
  const live = confirmed.some((r) => r.mode === "live");
  const parsedOrigin = (r: QuoteRow) => JSON.parse(r.origin_txs) as WireTx[];
  return {
    settlement_network: live ? "near:mainnet" : "near:mainnet (simulated)",
    currency: live ? "USDC (NEAR mainnet)" : "USDC (NEAR mainnet, simulated)",
    origin_asset: [...new Set(confirmed.map((r) => r.origin_asset))].join(" "),
    origin_amount: confirmed.map((r) => `${formatUnits(r.deposited_amount ?? r.amount_in, r.origin_decimals)} ${r.origin_symbol}`).join(" "),
    deposit_address: confirmed.map((r) => r.deposit_address).join(" "),
    origin_txs: confirmed.flatMap((r) => parsedOrigin(r).map((t) => ({ quote: r, hash: t.hash, explorerUrl: t.explorerUrl || null }))),
    live,
  };
}
