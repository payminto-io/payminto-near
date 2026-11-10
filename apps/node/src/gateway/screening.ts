import { randomBytes } from "node:crypto";
import type { AccountId } from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { nowIso } from "../store.ts";

export const SCREENING_RULES = {
  PAYER_DENIED: "The merchant blocks this payer account",
} as const;
export type ScreeningRule = keyof typeof SCREENING_RULES;

/** The same rules in plain words for the business that owns the payment (Blocked page, decision detail). */
export const SCREENING_MERCHANT_MESSAGES: Record<ScreeningRule, string> = {
  PAYER_DENIED: "This account is on your blocked list",
};

/**
 * Where in the flow the check ran. `voucher`: an agent payment, refused before acceptance. `wallet`: a checkout payment
 * the hub already took (the payer is known only once it pays), recorded so the business can refund it.
 */
export type ScreeningStage = "voucher" | "wallet";

export type ScreeningInput = {
  merchantId: string;
  stage: ScreeningStage;
  payout: AccountId;
  payer?: AccountId | null;
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
  payer: AccountId | null;
  payout: AccountId;
  payment_id: string | null;
  link_id: string | null;
  amount: string | null;
  details: string;
  timestamp: number;
  at: string;
};

/** Identical refusals within this window are not recorded again. */
const DEDUP_SEC = 60;

/**
 * Intake screening: the business's own deny list of payer accounts. NEAR testnet USDC exposes no issuer blacklist the
 * node can read, so this is the only rule. A voucher payment from a denied account is refused before acceptance; a
 * wallet payment can only be recorded after the hub took it.
 */
export class Screening {
  readonly #db: Database;
  readonly #clock: () => number;

  constructor(o: { db: Database; clock?: () => number }) {
    this.#db = o.db;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  denied(merchantId: string, payer: AccountId): boolean {
    return !!this.#db.get("SELECT 1 FROM screening_deny_list WHERE merchant_id = ? AND address = ?", merchantId, payer);
  }

  /** Screens and records; throws 403 SCREENING_REFUSED on a refusal. */
  check(i: ScreeningInput): void {
    if (!i.payer || !this.denied(i.merchantId, i.payer)) return;
    this.record(i, "PAYER_DENIED", { payer: i.payer });
    throw new ApiError(403, "SCREENING_REFUSED", SCREENING_RULES.PAYER_DENIED, { rule: "PAYER_DENIED", source: "gateway" });
  }

  record(i: ScreeningInput, rule: ScreeningRule, details: Record<string, unknown>): void {
    const now = this.#clock();
    const dup = this.#db.get(
      `SELECT 1 FROM screening_decisions WHERE merchant_id = ? AND rule = ? AND stage = ? AND COALESCE(payer, '') = ? AND COALESCE(payment_id, '') = ?
       AND COALESCE(link_id, '') = ? AND timestamp > ?`,
      i.merchantId,
      rule,
      i.stage,
      i.payer ?? "",
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
      i.payer ?? null,
      i.payout,
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
    const rows = this.#db.all<DecisionRow>(`SELECT * FROM screening_decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...params, limit + 1);
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
        .all<{ address: AccountId; reason: string | null; created_at: string }>("SELECT address, reason, created_at FROM screening_deny_list WHERE merchant_id = ? ORDER BY created_at DESC", merchantId)
        .map((r) => ({ address: r.address, reason: r.reason, created_at: r.created_at })),
    };
  }

  deny(merchantId: string, account: AccountId, reason: string | null) {
    this.#db.run(
      "INSERT INTO screening_deny_list (merchant_id, address, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (merchant_id, address) DO UPDATE SET reason = excluded.reason",
      merchantId,
      account,
      reason,
      nowIso(),
    );
    return { address: account, reason };
  }

  allow(merchantId: string, account: AccountId): boolean {
    return this.#db.run("DELETE FROM screening_deny_list WHERE merchant_id = ? AND address = ?", merchantId, account).changes > 0;
  }
}
