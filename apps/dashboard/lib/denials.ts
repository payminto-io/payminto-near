import { DENIAL_RULES, type DenialRule } from "@payminto/protocol";
import type { Denial } from "./schemas";

/**
 * Plain-language names for each policy rule, grouped by what the refused call looked like.
 * "attack" rules catch a charge that was tampered with or aimed somewhere it should not go;
 * "limit" rules catch an honest agent that ran into its budget; "state" rules catch a budget
 * that cannot pay right now.
 */
export const RULE_INFO: Record<DenialRule, { title: string; kind: "attack" | "limit" | "state" }> = {
  PAYEE_NOT_ALLOWED: { title: "Service not allowed", kind: "attack" },
  BAD_SIGNATURE: { title: "Forged charge signature", kind: "attack" },
  STALE_CUMULATIVE: { title: "Replayed charge", kind: "attack" },
  PRICE_MISMATCH: { title: "Price changed", kind: "attack" },
  TOKEN_MISMATCH: { title: "Wrong token", kind: "attack" },
  UNKNOWN_MANDATE: { title: "Unknown budget", kind: "attack" },
  PER_CALL_CAP: { title: "Over limit per charge", kind: "limit" },
  DAILY_CAP: { title: "Over daily limit", kind: "limit" },
  TOTAL_CAP: { title: "Over total limit", kind: "limit" },
  RATE_LIMIT: { title: "Too many charges per minute", kind: "limit" },
  MANDATE_NOT_ACTIVE: { title: "Budget not active", kind: "state" },
  MANDATE_REVOKED: { title: "Budget stopped", kind: "state" },
  INSUFFICIENT_FUNDS: { title: "Agent wallet too low", kind: "state" },
  POSITION_UNVERIFIED: { title: "False balance claim", kind: "attack" },
};

export function ruleTitle(rule: DenialRule): string {
  return RULE_INFO[rule]?.title ?? rule;
}

/** One plain sentence per rule (PRODUCT.md 2.3); the server's technical message stays in the API. */
export const PLAIN_REASON: Record<DenialRule, string> = {
  PAYEE_NOT_ALLOWED: "This service is not on the budget's list of allowed services.",
  BAD_SIGNATURE: "The charge was not signed by the agent's wallet.",
  STALE_CUMULATIVE: "The charge repeated one that was already paid.",
  PRICE_MISMATCH: "The charge did not match the service's price.",
  TOKEN_MISMATCH: "The charge asked for a different token than the budget holds.",
  UNKNOWN_MANDATE: "No budget on this server matches the charge.",
  PER_CALL_CAP: "The charge was over the budget's limit per charge.",
  DAILY_CAP: "The charge would have gone over the budget's daily limit.",
  TOTAL_CAP: "The charge would have gone over the budget's total limit.",
  RATE_LIMIT: "The agent tried to pay more often than its charges-per-minute limit.",
  MANDATE_NOT_ACTIVE: "The budget is not active yet, or has ended.",
  MANDATE_REVOKED: "The budget owner stopped this budget.",
  INSUFFICIENT_FUNDS: "The agent's wallet does not hold enough to cover the charge.",
  POSITION_UNVERIFIED: "The agent claimed a balance the chain does not show.",
};

export function ruleDescription(rule: DenialRule): string {
  return PLAIN_REASON[rule] ?? DENIAL_RULES[rule] ?? "";
}

export type RuleSummary = {
  rule: DenialRule;
  title: string;
  kind: "attack" | "limit" | "state";
  count: number;
  /** Sum of the amounts the refused vouchers asked for, in atomic units. */
  attempted: bigint;
  /** ISO time of the most recent denial under this rule. */
  last: string;
};

export type DenialSummary = {
  total: number;
  attempted: bigint;
  attacks: number;
  byRule: RuleSummary[];
  latest: Denial | null;
};

/**
 * Totals for the blocked-calls view: how many vouchers were refused, how much they asked for,
 * and one row per rule ordered by count, then by recency.
 */
export function summarizeDenials(denials: readonly Denial[]): DenialSummary {
  const map = new Map<DenialRule, RuleSummary>();
  let attempted = 0n;
  let attacks = 0;
  let latest: Denial | null = null;
  for (const d of denials) {
    const amount = d.amount ? BigInt(d.amount) : 0n;
    attempted += amount;
    const info = RULE_INFO[d.rule] ?? { title: d.rule, kind: "state" as const };
    if (info.kind === "attack") attacks += 1;
    if (!latest || d.createdAt > latest.createdAt) latest = d;
    const row = map.get(d.rule);
    if (row) {
      row.count += 1;
      row.attempted += amount;
      if (d.createdAt > row.last) row.last = d.createdAt;
    } else {
      map.set(d.rule, { rule: d.rule, title: info.title, kind: info.kind, count: 1, attempted: amount, last: d.createdAt });
    }
  }
  const byRule = [...map.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  return { total: denials.length, attempted, attacks, byRule, latest };
}

/** Ends a node message with a full stop unless it already ends in punctuation. */
export function asSentence(message: string): string {
  const m = message.trim();
  if (!m) return m;
  return /[.!?…]$/.test(m) ? m : `${m}.`;
}
