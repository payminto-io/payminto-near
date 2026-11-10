import { createHash, randomBytes } from "node:crypto";
import {
  newFeePlanId,
  type AccountId,
  type PublicKey,
  newMerchantId,
  PAYMENT_METHODS,
  type FeePlan,
  type Merchant,
  type MerchantMethod,
  type MerchantProfile,
  type CheckoutMethod,
  type PaymentMethod,
  type Platform,
} from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { nowIso, type ProviderRow } from "../store.ts";
import type { ModelContext } from "./model.ts";

export type FeePlanRow = {
  id: string;
  name: string;
  platform_fee_bps: number;
  platform_fee_fixed: string;
  min_fee: string;
  max_fee: string | null;
  created_at: string;
  updated_at: string;
};

export type PlatformRow = {
  id: 1;
  name: string;
  fee_recipient: AccountId | null;
  default_fee_plan_id: string;
  signup_mode: "off" | "approval" | "open";
  require_2fa_platform: number;
  agent_budgets_for_businesses: number;
  updated_at: string;
};

export type MerchantRow = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  /** The NEAR account checkout payments credit; null until an Admin proves one (payout_set = 0). */
  payout: AccountId | null;
  support_email: string | null;
  brand_color: string | null;
  logo_url: string | null;
  fee_plan_id: string;
  provider_id: string | null;
  /** 0 for a business created by sign-up until it proves a payout account (payout is null meanwhile). */
  payout_set: number;
  created_at: string;
  updated_at: string;
  /** Any-chain checkout (migration 007): the NEAR account USDC from other chains lands in, and its checks. */
  intents_payout?: AccountId | null;
  intents_payout_proven_at?: string | null;
  intents_payout_registered?: number;
  intents_payout_proof?: string | null;
};

export type MethodRow = {
  merchant_id: string;
  method: CheckoutMethod;
  enabled: number;
  fee_bps: number;
  fee_fixed: string;
  bearer: "merchant" | "customer";
  min_amount: string | null;
  max_amount: string | null;
  updated_at: string;
};

// JSON shapes (snake_case). Section 14 types are being added to packages/protocol; these match GATEWAY.md 14.1.
export function feePlanJson(r: FeePlanRow): FeePlan {
  return {
    id: r.id,
    name: r.name,
    platform_fee_bps: r.platform_fee_bps,
    platform_fee_fixed: r.platform_fee_fixed,
    min_fee: r.min_fee,
    max_fee: r.max_fee,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function methodJson(r: MethodRow): MerchantMethod {
  return {
    merchant_id: r.merchant_id,
    // `oneclick` only on a node with the any-chain checkout on (CHECKOUT_METHODS).
    method: r.method as PaymentMethod,
    enabled: r.enabled === 1,
    fee_bps: r.fee_bps,
    fee_fixed: r.fee_fixed,
    bearer: r.bearer,
    min_amount: r.min_amount,
    max_amount: r.max_amount,
  };
}

export function merchantJson(r: MerchantRow, m: ModelContext): Merchant & { payout_set: boolean } {
  return {
    payout_set: r.payout_set !== 0,
    id: r.id,
    livemode: m.livemode,
    name: r.name,
    slug: r.slug,
    status: r.status,
    payout: r.payout,
    support_email: r.support_email,
    brand_color: r.brand_color,
    logo_url: r.logo_url,
    fee_plan_id: r.fee_plan_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}




function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "merchant"
  );
}

/** Seeded by migrations/001_near.sql. */
export const ZERO_FEE_PLAN_ID = "fp_zero";

/** A verified NEP-413 payout proof as stored with the payout change. */
export type PayoutProofRecord = { signature: string; publicKey: PublicKey; signedAt: number };

/** Platform, fee plans, merchants and their payment methods. */

export class MerchantService {
  readonly #db: Database;
  readonly #ctx: ModelContext;
  readonly #checkoutKey: PublicKey;
  /** Methods listed in method lists: the core two, plus `oneclick` when the any-chain checkout is on. */
  #listed: readonly CheckoutMethod[] = PAYMENT_METHODS;

  constructor(o: { db: Database; ctx: ModelContext; checkoutKey: PublicKey }) {
    this.#db = o.db;
    this.#ctx = o.ctx;
    this.#checkoutKey = o.checkoutKey;
  }

  /** Called by the gateway when INTENTS_CHECKOUT is on: method lists then show the `oneclick` row too. */
  listIntentsMethod(): void {
    this.#listed = [...PAYMENT_METHODS, "oneclick"];
  }

  /**
   * First-boot seeding and env sync: the platform row on the zero fee plan from 001_near.sql (fee recipient is env-only),
   * and the default merchant when GATEWAY_PAYOUT_ACCOUNT is set and no merchant exists yet.
   */
  seed(o: { platformName: string; feeRecipient: AccountId | null; seedPayout: AccountId | null }): { defaultMerchant: MerchantRow | null; seedPayoutIgnored: boolean } {
    return this.#db.tx(() => {
      const now = nowIso();
      const platform = this.platformRow();
      if (!platform) {
        // The operator take rate is roadmap: every business starts on the zero plan the schema seeds.
        const plan = { id: ZERO_FEE_PLAN_ID };
        this.#db.run(
          "INSERT INTO platform (id, name, fee_recipient, default_fee_plan_id, updated_at) VALUES (1, ?, ?, ?, ?)",
          o.platformName,
          o.feeRecipient,
          plan.id,
          now,
        );
      } else if ((platform.fee_recipient ?? "") !== (o.feeRecipient ?? "")) {
        this.#db.run("UPDATE platform SET fee_recipient = ?, updated_at = ? WHERE id = 1", o.feeRecipient, now);
      }
      let defaultMerchant: MerchantRow | null = null;
      let seedPayoutIgnored = false;
      const first = this.#db.get<MerchantRow>("SELECT * FROM merchants ORDER BY created_at, id LIMIT 1") ?? null;
      if (!first && o.seedPayout) {
        defaultMerchant = this.create({ name: o.platformName, payout: o.seedPayout, proof: null });
      } else {
        defaultMerchant = first;
        if (first && o.seedPayout && first.payout !== o.seedPayout) seedPayoutIgnored = true;
      }
      return { defaultMerchant, seedPayoutIgnored };
    });
  }

  // ------------------------------------------------------------------ platform and fee plans

  platformRow(): PlatformRow | undefined {
    return this.#db.get<PlatformRow>("SELECT * FROM platform WHERE id = 1");
  }

  platformJson(): Platform & Record<string, unknown> {
    const p = this.platformRow()!;
    return {
      livemode: this.#ctx.livemode,
      name: p.name,
      fee_recipient: p.fee_recipient,
      default_fee_plan_id: p.default_fee_plan_id,
      network: this.#ctx.network,
      hub: this.#ctx.hub,
      token: this.#ctx.token,
      checkout_key: this.#checkoutKey,
      checkout_base_url: this.#ctx.checkoutBaseUrl,
      signup_mode: p.signup_mode ?? "off",
      require_2fa_platform: p.require_2fa_platform === 1,
      agent_budgets_for_businesses: p.agent_budgets_for_businesses === 1,
      updated_at: p.updated_at,
    };
  }

  updatePlatform(patch: { name?: string; default_fee_plan_id?: string; signup_mode?: "off" | "approval" | "open"; agent_budgets_for_businesses?: boolean }) {
    if (patch.default_fee_plan_id) this.feePlan(patch.default_fee_plan_id);
    this.#db.run(
      `UPDATE platform SET name = COALESCE(?, name), default_fee_plan_id = COALESCE(?, default_fee_plan_id), signup_mode = COALESCE(?, signup_mode),
       agent_budgets_for_businesses = COALESCE(?, agent_budgets_for_businesses), updated_at = ? WHERE id = 1`,
      patch.name ?? null,
      patch.default_fee_plan_id ?? null,
      patch.signup_mode ?? null,
      patch.agent_budgets_for_businesses === undefined ? null : patch.agent_budgets_for_businesses ? 1 : 0,
      nowIso(),
    );
    return this.platformJson();
  }

  /** A pricing plan with the number of businesses on it. */
  planJson(r: FeePlanRow) {
    const n = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM merchants WHERE fee_plan_id = ?", r.id)!.n;
    return { ...feePlanJson(r), merchant_count: n };
  }

  feePlans(): FeePlanRow[] {
    return this.#db.all<FeePlanRow>("SELECT * FROM fee_plans ORDER BY created_at, id");
  }

  feePlan(id: string): FeePlanRow {
    const r = this.#db.get<FeePlanRow>("SELECT * FROM fee_plans WHERE id = ?", id);
    if (!r) throw new ApiError(404, "NOT_FOUND", "fee plan not found");
    return r;
  }

  #checkPlan(p: { platform_fee_fixed: string; min_fee: string; max_fee: string | null }) {
    if (p.max_fee !== null && BigInt(p.max_fee) < BigInt(p.min_fee)) throw new ApiError(400, "VALIDATION_ERROR", "max_fee must be >= min_fee");
  }

  #requireRecipientFor(nonZero: boolean) {
    if (nonZero && !this.platformRow()?.fee_recipient) {
      throw new ApiError(409, "FEE_RECIPIENT_REQUIRED", "set PLATFORM_FEE_ACCOUNT before configuring a non-zero fee");
    }
  }

  createFeePlan(b: { name: string; platform_fee_bps: number; platform_fee_fixed: string; min_fee: string; max_fee: string | null }): FeePlanRow {
    this.#checkPlan(b);
    this.#requireRecipientFor(b.platform_fee_bps > 0 || BigInt(b.platform_fee_fixed) > 0n || BigInt(b.min_fee) > 0n);
    const id = newFeePlanId();
    const now = nowIso();
    this.#db.run(
      "INSERT INTO fee_plans (id, name, platform_fee_bps, platform_fee_fixed, min_fee, max_fee, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      b.name,
      b.platform_fee_bps,
      b.platform_fee_fixed,
      b.min_fee,
      b.max_fee,
      now,
      now,
    );
    return this.feePlan(id);
  }

  updateFeePlan(id: string, b: Partial<{ name: string; platform_fee_bps: number; platform_fee_fixed: string; min_fee: string; max_fee: string | null }>): FeePlanRow {
    const cur = this.feePlan(id);
    const next = { ...cur, ...b };
    this.#checkPlan(next);
    this.#requireRecipientFor(next.platform_fee_bps > 0 || BigInt(next.platform_fee_fixed) > 0n || BigInt(next.min_fee) > 0n);
    // Fees of existing payments are fixed at creation; only new payments see the change.
    this.#db.run(
      "UPDATE fee_plans SET name = ?, platform_fee_bps = ?, platform_fee_fixed = ?, min_fee = ?, max_fee = ?, updated_at = ? WHERE id = ?",
      next.name,
      next.platform_fee_bps,
      next.platform_fee_fixed,
      next.min_fee,
      next.max_fee,
      nowIso(),
      id,
    );
    return this.feePlan(id);
  }

  // ------------------------------------------------------------------ merchants

  merchants(): MerchantRow[] {
    return this.#db.all<MerchantRow>("SELECT * FROM merchants ORDER BY created_at, id");
  }

  merchant(id: string): MerchantRow {
    const r = this.#db.get<MerchantRow>("SELECT * FROM merchants WHERE id = ?", id);
    if (!r) throw new ApiError(404, "UNKNOWN_MERCHANT", "merchant not found");
    return r;
  }

  maybeMerchant(id: string): MerchantRow | undefined {
    return this.#db.get<MerchantRow>("SELECT * FROM merchants WHERE id = ?", id);
  }

  /** The only merchant, when there is exactly one (a single-merchant node needs no Merchant-Id header). */
  soleMerchant(): MerchantRow | undefined {
    const rows = this.#db.all<MerchantRow>("SELECT * FROM merchants LIMIT 2");
    return rows.length === 1 ? rows[0] : undefined;
  }

  create(b: {
    name: string;
    /** Null for a business created by sign-up: no payout account until an Admin proves one. */
    payout: AccountId | null;
    slug?: string;
    support_email?: string | null;
    brand_color?: string | null;
    logo_url?: string | null;
    fee_plan_id?: string;
    /** The verified NEP-413 proof; null for the seed payout from GATEWAY_PAYOUT_ACCOUNT. */
    proof: PayoutProofRecord | null;
  }): MerchantRow {
    return this.#db.tx(() => {
      const plan = b.fee_plan_id ? this.feePlan(b.fee_plan_id) : this.feePlan(this.platformRow()!.default_fee_plan_id);
      const base = b.slug ?? slugify(b.name);
      let slug = base;
      for (let i = 2; this.#db.get("SELECT 1 FROM merchants WHERE slug = ?", slug); i++) {
        if (b.slug) throw new ApiError(409, "SLUG_TAKEN", "a merchant with this slug exists");
        slug = `${base}-${i}`;
      }
      const id = newMerchantId();
      const now = nowIso();
      this.#db.run(
        `INSERT INTO merchants (id, name, slug, status, payout, support_email, brand_color, logo_url, fee_plan_id, payout_set, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        b.name,
        slug,
        b.payout,
        b.support_email ?? null,
        b.brand_color ?? null,
        b.logo_url ?? null,
        plan.id,
        b.payout === null ? 0 : 1,
        now,
        now,
      );
      for (const method of PAYMENT_METHODS) {
        this.#db.run("INSERT INTO merchant_methods (merchant_id, method, enabled, updated_at) VALUES (?, ?, ?, ?)", id, method, 1, now);
      }
      // The any-chain rail starts off: it needs a proven NEAR account first (migration 007 did the same for older rows).
      this.#db.run("INSERT INTO merchant_methods (merchant_id, method, enabled, updated_at) VALUES (?, 'oneclick', 0, ?)", id, now);
      if (b.payout !== null) {
        this.#db.run(
          "INSERT INTO merchant_payout_changes (merchant_id, old_payout, new_payout, signature, public_key, signed_at, at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
          id,
          b.payout,
          b.proof?.signature ?? null,
          b.proof?.publicKey ?? null,
          b.proof?.signedAt ?? null,
          now,
        );
        this.#ensureProvider(id);
      }
      return this.merchant(id);
    });
  }

  update(id: string, b: Partial<{ name: string; status: "active" | "suspended"; support_email: string | null; brand_color: string | null; logo_url: string | null; fee_plan_id: string }>): MerchantRow {
    const cur = this.merchant(id);
    if (b.fee_plan_id) this.feePlan(b.fee_plan_id);
    const next = { ...cur, ...b };
    this.#db.run(
      "UPDATE merchants SET name = ?, status = ?, support_email = ?, brand_color = ?, logo_url = ?, fee_plan_id = ?, updated_at = ? WHERE id = ?",
      next.name,
      next.status,
      next.support_email,
      next.brand_color,
      next.logo_url,
      next.fee_plan_id,
      nowIso(),
      id,
    );
    return this.merchant(id);
  }

  /** Records a verified payout change; the caller checked the NEP-413 proof and the key. New payments use the new payout. */
  changePayout(id: string, newPayout: AccountId, proof: PayoutProofRecord): { merchant: MerchantRow; old: AccountId | null } {
    return this.#db.tx(() => {
      const cur = this.merchant(id);
      const now = nowIso();
      this.#db.run("UPDATE merchants SET payout = ?, provider_id = NULL, payout_set = 1, updated_at = ? WHERE id = ?", newPayout, now, id);
      this.#db.run(
        "INSERT INTO merchant_payout_changes (merchant_id, old_payout, new_payout, signature, public_key, signed_at, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        cur.payout,
        newPayout,
        proof.signature,
        proof.publicKey,
        proof.signedAt,
        now,
      );
      this.#ensureProvider(id);
      return { merchant: this.merchant(id), old: cur.payout };
    });
  }

  payoutHistory(id: string) {
    return this.#db
      .all<{ old_payout: AccountId | null; new_payout: AccountId; signature: string | null; public_key: PublicKey | null; signed_at: number | null; at: string }>(
        "SELECT old_payout, new_payout, signature, public_key, signed_at, at FROM merchant_payout_changes WHERE merchant_id = ? ORDER BY seq DESC",
        id,
      )
      .map((r) => ({ old_payout: r.old_payout, new_payout: r.new_payout, proven: r.signature !== null, public_key: r.public_key, signed_at: r.signed_at, changed_at: r.at }));
  }

  methods(merchantId: string): MethodRow[] {
    return this.#db.all<MethodRow>("SELECT * FROM merchant_methods WHERE merchant_id = ? ORDER BY method", merchantId).filter((r) => this.#listed.includes(r.method));
  }

  method(merchantId: string, method: CheckoutMethod): MethodRow {
    return this.#db.get<MethodRow>("SELECT * FROM merchant_methods WHERE merchant_id = ? AND method = ?", merchantId, method)!;
  }

  /** Operator sets terms; `enabledOnly` is what a merchant key may change (fees are the operator's). */
  setMethods(
    merchantId: string,
    items: Array<{ method: CheckoutMethod; enabled?: boolean; fee_bps?: number; fee_fixed?: string; bearer?: "merchant" | "customer"; min_amount?: string | null; max_amount?: string | null }>,
    enabledOnly: boolean,
  ): MethodRow[] {
    this.merchant(merchantId);
    return this.#db.tx(() => {
      for (const it of items) {
        const cur = this.method(merchantId, it.method);
        const next = enabledOnly ? { ...cur, enabled: it.enabled === undefined ? cur.enabled : it.enabled ? 1 : 0 } : {
          ...cur,
          enabled: it.enabled === undefined ? cur.enabled : it.enabled ? 1 : 0,
          fee_bps: it.fee_bps ?? cur.fee_bps,
          fee_fixed: it.fee_fixed ?? cur.fee_fixed,
          bearer: it.bearer ?? cur.bearer,
          min_amount: it.min_amount === undefined ? cur.min_amount : it.min_amount,
          max_amount: it.max_amount === undefined ? cur.max_amount : it.max_amount,
        };
        if (next.min_amount !== null && next.max_amount !== null && BigInt(next.max_amount) < BigInt(next.min_amount)) {
          throw new ApiError(400, "VALIDATION_ERROR", `${it.method}: max_amount must be >= min_amount`);
        }
        this.#requireRecipientFor(next.fee_bps > 0 || BigInt(next.fee_fixed) > 0n);
        this.#db.run(
          "UPDATE merchant_methods SET enabled = ?, fee_bps = ?, fee_fixed = ?, bearer = ?, min_amount = ?, max_amount = ?, updated_at = ? WHERE merchant_id = ? AND method = ?",
          next.enabled,
          next.fee_bps,
          next.fee_fixed,
          next.bearer,
          next.min_amount,
          next.max_amount,
          nowIso(),
          merchantId,
          it.method,
        );
      }
      return this.methods(merchantId);
    });
  }

  /** MerchantProfile (protocol type) plus the fee plan and methods (read-only for a merchant key). */
  profileJson(r: MerchantRow): MerchantProfile & Record<string, unknown> {
    return {
      ...merchantJson(r, this.#ctx),
      network: this.#ctx.network,
      hub: this.#ctx.hub,
      token: this.#ctx.token,
      checkout_key: this.#checkoutKey,
      checkout_base_url: this.#ctx.checkoutBaseUrl,
      fee_plan: feePlanJson(this.feePlan(r.fee_plan_id)),
      methods: this.methods(r.id).map(methodJson),
      ...this.stats30d(r.id),
      payout_history: this.payoutHistory(r.id),
    };
  }

  // ------------------------------------------------------------------ clearing provider records (vouchers)

  /** The provider record a merchant's vouchers clear against: payee = payout, priced per payment. */
  provider(merchantId: string): ProviderRow {
    const m = this.merchant(merchantId);
    const id = m.provider_id ?? this.#ensureProvider(merchantId);
    return this.#db.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", id)!;
  }

  /** The provider record for platform fees (payee = fee recipient), or null when there is no fee recipient. */
  feeProvider(): ProviderRow | null {
    const recipient = this.platformRow()?.fee_recipient;
    if (!recipient) return null;
    return this.#providerFor(recipient, `${this.platformRow()!.name} fees`);
  }

  #ensureProvider(merchantId: string): string {
    const m = this.#db.get<MerchantRow>("SELECT * FROM merchants WHERE id = ?", merchantId)!;
    if (m.payout === null) throw new ApiError(409, "PAYOUT_REQUIRED", "this business has no payout account yet; an Admin must prove one first");
    const p = this.#providerFor(m.payout, m.name);
    this.#db.run("UPDATE merchants SET provider_id = ? WHERE id = ?", p.id, merchantId);
    return p.id;
  }

  /** Gateway provider records never have a usable API key: the node accepts their vouchers itself. */
  #providerFor(payee: AccountId, name: string): ProviderRow {
    const existing = this.#db.get<ProviderRow>("SELECT * FROM providers WHERE payee = ? AND category = 'gateway' ORDER BY created_at LIMIT 1", payee);
    if (existing) return existing;
    const id = `prv_${randomBytes(6).toString("hex")}`;
    this.#db.run(
      `INSERT INTO providers (id, name, description, payee, price_atomic, resource, category, api_key_hash, created_at)
       VALUES (?, ?, ?, ?, '1', ?, 'gateway', ?, ?)`,
      id,
      name,
      "Payminto Gateway payments (priced per payment)",
      payee,
      this.#ctx.checkoutBaseUrl,
      createHash("sha256").update(randomBytes(32)).digest("hex"),
      nowIso(),
    );
    return this.#db.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", id)!;
  }

  // ------------------------------------------------------------------ platform earnings

  /** Paid volume and payment count of a merchant over the last 30 days (drafts excluded). */
  stats30d(merchantId: string, nowSec = Math.floor(Date.now() / 1000)) {
    const r = this.#db.get<{ volume: string; n: number }>(
      "SELECT bigsum(amount_paid) AS volume, COUNT(*) AS n FROM payments WHERE merchant_id = ? AND draft = 0 AND created_at >= ?",
      merchantId,
      new Date((nowSec - 30 * 86_400) * 1000).toISOString(),
    )!;
    return { volume_30d: r.volume, payments_30d: r.n };
  }

  /**
   * Fees of payments that reached paid or overpaid, by merchant and method, plus the last 30 days by the day the
   * payment was paid (UTC), each day split by method, for the earnings chart.
   */
  earnings(nowSec = Math.floor(Date.now() / 1000)) {
    const rows = this.#db.all<{ merchant_id: string; name: string; method: string | null; payments: number; platform_fee: string; method_fee: string; fee_total: string; volume: string }>(
      `SELECT p.merchant_id, m.name, COALESCE(p.quote_method, p.method) AS method, COUNT(*) AS payments,
              bigsum(p.platform_fee) AS platform_fee, bigsum(p.method_fee) AS method_fee, bigsum(p.fee_total) AS fee_total,
              bigsum(p.amount_paid) AS volume
       FROM payments p JOIN merchants m ON m.id = p.merchant_id
       WHERE p.status IN ('paid', 'overpaid')
       GROUP BY p.merchant_id, COALESCE(p.quote_method, p.method)
       ORDER BY m.name, method`,
    );
    const total = rows.reduce(
      (a, r) => ({ platform_fee: a.platform_fee + BigInt(r.platform_fee), method_fee: a.method_fee + BigInt(r.method_fee), fee_total: a.fee_total + BigInt(r.fee_total) }),
      { platform_fee: 0n, method_fee: 0n, fee_total: 0n },
    );
    const today = Math.floor(nowSec / 86_400) * 86_400;
    const from = new Date((today - 29 * 86_400) * 1000).toISOString();
    const daily = this.#db.all<{ d: string; method: string | null; fee_total: string }>(
      `SELECT substr(paid_at, 1, 10) AS d, COALESCE(quote_method, method) AS method, bigsum(fee_total) AS fee_total
       FROM payments WHERE status IN ('paid', 'overpaid') AND paid_at >= ? GROUP BY d, COALESCE(quote_method, method)`,
      from,
    );
    const days = Array.from({ length: 30 }, (_, i) => {
      const day = new Date((today - (29 - i) * 86_400) * 1000).toISOString().slice(0, 10);
      const byMethod: Record<string, string> = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, "0"]));
      let total = 0n;
      for (const r of daily.filter((x) => x.d === day)) {
        if (r.method) byMethod[r.method] = (BigInt(byMethod[r.method] ?? "0") + BigInt(r.fee_total)).toString();
        total += BigInt(r.fee_total);
      }
      return { day, fee_total: total.toString(), by_method: byMethod };
    });
    return {
      fee_recipient: this.platformRow()?.fee_recipient ?? null,
      days,
      totals: { platform_fee: total.platform_fee.toString(), method_fee: total.method_fee.toString(), fee_total: total.fee_total.toString() },
      items: rows.map((r) => ({
        merchant_id: r.merchant_id,
        merchant_name: r.name,
        method: r.method,
        payments: r.payments,
        volume: r.volume,
        platform_fee: r.platform_fee,
        method_fee: r.method_fee,
        fee_total: r.fee_total,
      })),
    };
  }
}
