import { randomBytes } from "node:crypto";
import { getAddress, type Address } from "viem";
import type { ChainClient } from "../chain.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { nowIso } from "../store.ts";

export const SCREENING_RULES = {
  PAYER_BLACKLISTED: "The payer wallet is blacklisted by the token issuer",
  PAYOUT_BLACKLISTED: "The merchant payout wallet is blacklisted by the token issuer",
  PAYER_DENIED: "The merchant blocks this payer wallet",
  PAYER_TOO_NEW: "The payer wallet has too little transaction history",
} as const;
export type ScreeningRule = keyof typeof SCREENING_RULES;

/** The same rules in plain words for the business that owns the payment (Blocked page, decision detail). */
export const SCREENING_MERCHANT_MESSAGES: Record<ScreeningRule, string> = {
  PAYER_BLACKLISTED: "This wallet is frozen by the token issuer",
  PAYOUT_BLACKLISTED: "Your payout wallet is frozen by the token issuer",
  PAYER_DENIED: "This wallet is on your blocked list",
  PAYER_TOO_NEW: "This wallet has too little history to accept payments from",
};

/** Where in the flow the check ran. */
export type ScreeningStage = "x402" | "authorize" | "voucher" | "checkout" | "hsp";

export type ScreeningInput = {
  merchantId: string;
  stage: ScreeningStage;
  payout: Address;
  payer?: Address | null;
  paymentId?: string | null;
  linkId?: string | null;
  amount?: bigint | null;
};

type DecisionRow = {
  seq: number;
  id: string;
  merchant_id: string;
  rule: ScreeningRule;
  message: string;
  stage: ScreeningStage;
  payer: Address | null;
  payout: Address;
  payment_id: string | null;
  link_id: string | null;
  amount: string | null;
  details: string;
  timestamp: number;
  at: string;
};

/** Identical refusals within this window are not recorded again (a checkout page polls). */
const DEDUP_SEC = 60;
const PAYOUT_CACHE_MS = 30_000;

/**
 * Intake screening (GATEWAY.md section 13.1). Every rule is a chain read or a merchant rule: the token's own
 * `isBlacklisted` through Multicall3 (the check settlement uses), the merchant deny list, and the payer's transaction
 * count. A refusal is stored, then thrown as 403 SCREENING_REFUSED before any signature, requirement or relay.
 */
export class Screening {
  readonly #db: Database;
  readonly #chain: ChainClient;
  readonly #minNonce: number;
  readonly #clock: () => number;
  readonly #payoutCache = new Map<string, { blacklisted: boolean; at: number }>();

  constructor(o: { db: Database; chain: ChainClient; minPayerNonce: number; clock?: () => number }) {
    this.#db = o.db;
    this.#chain = o.chain;
    this.#minNonce = o.minPayerNonce;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  async #payoutBlacklisted(payout: Address): Promise<boolean> {
    const key = payout.toLowerCase();
    const hit = this.#payoutCache.get(key);
    if (hit && Date.now() - hit.at < PAYOUT_CACHE_MS) return hit.blacklisted;
    const blacklisted = (await this.#chain.blacklisted([payout])).has(key);
    this.#payoutCache.set(key, { blacklisted, at: Date.now() });
    return blacklisted;
  }

  /** The first failing rule, or null. Chain read failures propagate: an unscreened payment is never let through. */
  async evaluate(i: ScreeningInput): Promise<{ rule: ScreeningRule; details: Record<string, unknown> } | null> {
    if (await this.#payoutBlacklisted(i.payout)) return { rule: "PAYOUT_BLACKLISTED", details: { payout: i.payout } };
    if (!i.payer) return null;
    const payer = getAddress(i.payer);
    if (this.#db.get("SELECT 1 FROM screening_deny_list WHERE merchant_id = ? AND address = ?", i.merchantId, payer)) {
      return { rule: "PAYER_DENIED", details: { payer } };
    }
    if ((await this.#chain.blacklisted([payer])).has(payer.toLowerCase())) return { rule: "PAYER_BLACKLISTED", details: { payer } };
    if (this.#minNonce > 0) {
      const nonce = await this.#chain.public.getTransactionCount({ address: payer });
      if (nonce < this.#minNonce) return { rule: "PAYER_TOO_NEW", details: { payer, transactions: nonce, required: this.#minNonce } };
    }
    return null;
  }

  /** Screens and records; throws 403 SCREENING_REFUSED on a refusal. */
  async check(i: ScreeningInput): Promise<void> {
    const hit = await this.evaluate(i);
    if (!hit) return;
    this.#record(i, hit.rule, hit.details);
    throw new ApiError(403, "SCREENING_REFUSED", SCREENING_RULES[hit.rule], { rule: hit.rule, source: "gateway" });
  }

  #record(i: ScreeningInput, rule: ScreeningRule, details: Record<string, unknown>) {
    const now = this.#clock();
    const dup = this.#db.get(
      `SELECT 1 FROM screening_decisions WHERE merchant_id = ? AND rule = ? AND stage = ? AND COALESCE(payer, '') = ? AND COALESCE(payment_id, '') = ?
       AND COALESCE(link_id, '') = ? AND timestamp > ?`,
      i.merchantId,
      rule,
      i.stage,
      i.payer ? getAddress(i.payer) : "",
      i.paymentId ?? "",
      i.linkId ?? "",
      now - DEDUP_SEC,
    );
    if (dup) return;
    this.#db.run(
      `INSERT INTO screening_decisions (id, merchant_id, rule, message, stage, payer, payout, payment_id, link_id, amount, details, timestamp, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `scr_${randomBytes(8).toString("hex")}`,
      i.merchantId,
      rule,
      SCREENING_MERCHANT_MESSAGES[rule],
      i.stage,
      i.payer ? getAddress(i.payer) : null,
      getAddress(i.payout),
      i.paymentId ?? null,
      i.linkId ?? null,
      i.amount === undefined || i.amount === null ? null : i.amount.toString(),
      JSON.stringify(details),
      now,
      nowIso(),
    );
  }

  /** Decisions for the dashboard's Blocked calls page; `source: "gateway"` sets them apart from clearing denials. */
  decisions(merchantIds: string | readonly string[] | null, limit: number, cursor?: number) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const ids = typeof merchantIds === "string" ? [merchantIds] : merchantIds;
    if (ids) (where.push(`merchant_id IN (${ids.map(() => "?").join(", ") || "NULL"})`), params.push(...ids));
    if (cursor !== undefined) (where.push("seq < ?"), params.push(cursor));
    const rows = this.#db.all<DecisionRow>(
      `SELECT * FROM screening_decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        source: "gateway" as const,
        merchant_id: r.merchant_id,
        rule: r.rule,
        message: SCREENING_MERCHANT_MESSAGES[r.rule] ?? r.message,
        stage: r.stage,
        payer: r.payer,
        payout: r.payout,
        payment_id: r.payment_id,
        link_id: r.link_id,
        amount: r.amount,
        details: JSON.parse(r.details) as Record<string, unknown>,
        timestamp: r.timestamp,
        created_at: r.at,
      })),
      next_cursor: rows.length > limit && page.length ? String(page[page.length - 1]!.seq) : null,
    };
  }

  denyList(merchantId: string) {
    return {
      items: this.#db
        .all<{ address: Address; reason: string | null; created_at: string }>("SELECT address, reason, created_at FROM screening_deny_list WHERE merchant_id = ? ORDER BY created_at DESC", merchantId)
        .map((r) => ({ address: r.address, reason: r.reason, created_at: r.created_at })),
    };
  }

  deny(merchantId: string, address: Address, reason: string | null) {
    this.#db.run(
      "INSERT INTO screening_deny_list (merchant_id, address, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (merchant_id, address) DO UPDATE SET reason = excluded.reason",
      merchantId,
      getAddress(address),
      reason,
      nowIso(),
    );
    return { address: getAddress(address), reason };
  }

  allow(merchantId: string, address: Address): boolean {
    return this.#db.run("DELETE FROM screening_deny_list WHERE merchant_id = ? AND address = ?", merchantId, getAddress(address)).changes > 0;
  }
}
