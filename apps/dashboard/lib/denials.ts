import { z } from "zod";
import { DENIAL_RULES, REPEAT_WINDOW_SEC, type DenialRule, type Refusal, type RetryHint } from "@payminto/protocol";
import type { Denial } from "./schemas";

/**
 * Plain-language names for each policy rule, grouped by what the refused Call looked like.
 * "attack" rules catch a Call that was aimed somewhere it should not go or did not match what the server expected;
 * "limit" rules catch an honest agent that ran into its Budget; "state" rules catch a Budget
 * that cannot pay right now.
 *
 * A Refusal is always of a voucher the Budget's agent key signed. A voucher that key did not sign, or one for a Budget
 * this server does not know, is nobody's Refusal: the server answers it with a plain error and records nothing in the
 * owner's name. BAD_SIGNATURE and UNKNOWN_BUDGET stay named here only for rows an older server recorded.
 */
export const RULE_INFO: Record<DenialRule, { title: string; kind: "attack" | "limit" | "state" }> = {
  PAYEE_NOT_ALLOWED: { title: "Payee not allowed", kind: "attack" },
  BAD_SIGNATURE: { title: "Voucher not signed by the agent", kind: "attack" },
  STALE_CUMULATIVE: { title: "Replayed voucher", kind: "attack" },
  PRICE_MISMATCH: { title: "Price changed", kind: "attack" },
  UNKNOWN_BUDGET: { title: "Unknown Budget", kind: "attack" },
  PER_CALL_CAP: { title: "Over the per-Call limit", kind: "limit" },
  DAILY_CAP: { title: "Over the daily limit", kind: "limit" },
  TOTAL_CAP: { title: "Over the Budget cap", kind: "limit" },
  HOURLY_CAP: { title: "Over the hourly limit", kind: "limit" },
  RATE_LIMIT: { title: "Too many Calls per minute", kind: "limit" },
  REPEAT_REQUEST: { title: "Same request paid too often", kind: "limit" },
  NET_EXPOSURE: { title: "Escrow too low", kind: "state" },
  BUDGET_NOT_ACTIVE: { title: "Budget not active", kind: "state" },
  BUDGET_REVOKED: { title: "Budget stopped", kind: "state" },
  PAYEE_BLOCKED: { title: "Payee blocked by the Payee check", kind: "attack" },
  PAYEE_NEEDS_APPROVAL: { title: "Payee waiting for approval", kind: "state" },
  POSITION_UNVERIFIED: { title: "False balance claim", kind: "attack" },
};

export function ruleTitle(rule: DenialRule): string {
  return RULE_INFO[rule]?.title ?? rule;
}

/** One plain sentence per rule (PRODUCT.md 2.3); the server's technical message stays in the API. */
export const PLAIN_REASON: Record<DenialRule, string> = {
  PAYEE_NOT_ALLOWED: "This Payee is not on the Budget's list of allowed Payees.",
  BAD_SIGNATURE: "The voucher was not signed by the Budget's agent key.",
  STALE_CUMULATIVE: "The voucher repeated one that was already accepted.",
  PRICE_MISMATCH: "The voucher did not match the Payee's price.",
  UNKNOWN_BUDGET: "No Budget on this server matches the voucher.",
  PER_CALL_CAP: "The Call was over the Budget's limit per Call.",
  DAILY_CAP: "The Call would have gone over the Budget's daily limit.",
  TOTAL_CAP: "The Call would have gone over the Budget's cap.",
  HOURLY_CAP: "The Call would have gone over the Budget's hourly limit.",
  REPEAT_REQUEST: "The agent paid for this exact request too many times within an hour.",
  NET_EXPOSURE: "Unsettled spending would have gone over what this Budget holds in escrow.",
  RATE_LIMIT: "The agent tried to pay more often than its Calls-per-minute limit.",
  BUDGET_NOT_ACTIVE: "The Budget is not active yet, or has ended.",
  BUDGET_REVOKED: "The Budget owner stopped this Budget.",
  PAYEE_BLOCKED: "The Payee check found a reason not to pay this Payee, or the Budget owner denied it.",
  PAYEE_NEEDS_APPROVAL: "The Payee check has warnings about this Payee, and the Budget owner has not approved it yet.",
  POSITION_UNVERIFIED: "The agent claimed a balance the chain does not show.",
};

export function ruleDescription(rule: DenialRule): string {
  return PLAIN_REASON[rule] ?? DENIAL_RULES[rule] ?? "";
}

const uint = z.string().regex(/^\d+$/);
/**
 * The node's retry hint. `after` carries the real seconds until the same Call fits, and a `reason` when the wait is not
 * for a rolling limit. A reason this dashboard does not know is dropped, so the hint still reads as a plain wait.
 */
export const retrySchema: z.ZodType<RetryHint, unknown> = z.union([
  z.object({ kind: z.literal("never") }),
  z
    .object({ kind: z.literal("after"), seconds: z.number().nonnegative(), reason: z.string().optional() })
    .transform((h): RetryHint => (h.reason === "hub_unreadable" ? { kind: "after", seconds: h.seconds, reason: "hub_unreadable" } : { kind: "after", seconds: h.seconds })),
  z.object({ kind: z.literal("after_settlement") }),
  z.object({
    kind: z.literal("fund"),
    shortBy: uint,
    fromCredit: z.object({ action: z.literal("fund_from_credit"), budgetId: z.string(), amount: uint, credit: uint }).optional(),
  }),
  z.object({ kind: z.literal("resign"), expectedCumulative: uint }),
  // The owner decides on the Budget page. `approveAt` is where the node says that page is; it is shown to a person
  // and never followed by this dashboard, which links to its own Budget page instead.
  z.object({ kind: z.literal("approval"), payee: z.string().min(2).max(64), approveAt: z.string().max(300) }),
]);
const refusalSchema = z.object({
  rule: z.string(),
  message: z.string(),
  attemptedAmount: uint,
  remainingBudget: uint.nullable(),
  retry: retrySchema,
});

/**
 * The machine-readable refusal the node recorded with a denial (decision 8), or one rebuilt from the denial itself when
 * an older node sent none: then the remaining Budget is unknown and the hint says only what the rule implies.
 */
export function refusalOf(d: Denial): Refusal {
  const parsed = refusalSchema.safeParse(d.details?.refusal);
  if (parsed.success) return { ...parsed.data, rule: d.rule };
  return { rule: d.rule, message: d.message, attemptedAmount: d.amount ?? "0", remainingBudget: null, retry: defaultRetry(d.rule) };
}

/** What a rule implies about retrying when the node did not say more. */
export function defaultRetry(rule: DenialRule): RetryHint {
  switch (rule) {
    case "RATE_LIMIT":
      return { kind: "after", seconds: 60 };
    case "HOURLY_CAP":
      return { kind: "after", seconds: 3_600 };
    case "DAILY_CAP":
      return { kind: "after", seconds: 86_400 };
    case "REPEAT_REQUEST":
      return { kind: "after", seconds: REPEAT_WINDOW_SEC };
    case "NET_EXPOSURE":
      return { kind: "after_settlement" };
    default:
      return { kind: "never" };
  }
}

/**
 * A wait in the largest unit that reads naturally: "40 seconds", "12 minutes", "1 hour", "2 days". It rounds up, so the
 * words never promise a retry sooner than the node's seconds do, and it is never zero.
 */
export function waitText(seconds: number): string {
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds < 90) return count(Math.max(1, Math.ceil(seconds)), "second");
  if (seconds < 129_600 && seconds % 3_600 === 0) return count(seconds / 3_600, "hour");
  if (seconds < 5_400) return count(Math.ceil(seconds / 60), "minute");
  if (seconds < 129_600) return count(Math.ceil(seconds / 3_600), "hour");
  return count(Math.ceil(seconds / 86_400), "day");
}

/**
 * True when the server refused only because it could not read the Budget's escrow from the hub. It fails closed and
 * never decides on an old snapshot, so this says nothing about the Budget: its escrow, cap and rules are untouched.
 */
export function isHubUnreadable(retry: RetryHint): boolean {
  return retry.kind === "after" && retry.reason === "hub_unreadable";
}

/** What to call a Refusal: the rule's title, unless the hint says the hub could not be read. */
export function refusalTitle(rule: DenialRule, retry: RetryHint): string {
  return isHubUnreadable(retry) ? "Hub could not be read" : ruleTitle(rule);
}

/** Why a Call was refused, in one or two plain sentences. */
export function refusalReason(rule: DenialRule, retry: RetryHint): string {
  if (isHubUnreadable(retry)) return "The server could not read this Budget's escrow from the hub, so it refused the Call. Nothing is wrong with the Budget.";
  return ruleDescription(rule);
}

const payeeDetailsSchema = z.object({
  payeeCheck: z
    .object({
      unavailable: z.boolean().optional(),
      signals: z.array(z.object({ id: z.string(), severity: z.enum(["info", "warn", "block"]), reason: z.string() })).optional().default([]),
    })
    .nullable()
    .optional(),
  approval: z.object({ status: z.string() }).nullable().optional(),
});

/**
 * Where the owner decides about a Payee: the `approveAt` the node sent when it is this dashboard's own Budget page,
 * else that page built here. A link in a Refusal never leads anywhere else.
 */
export function approvalHref(budgetId: string, approveAt: string | null | undefined, origin: string | null): string {
  const own = `/budgets/${budgetId}`;
  if (!approveAt) return `${own}#waiting-payees`;
  try {
    const u = new URL(approveAt, origin ?? "http://localhost");
    if ((origin === null || u.origin === origin) && u.pathname === own) return `${own}${u.search}${u.hash || "#waiting-payees"}`;
  } catch {
    // Not a URL: the page built here.
  }
  return `${own}#waiting-payees`;
}

/** True for the two Refusals the Payee check makes. The owner resolves both on the Budget page. */
export function isPayeeCheckRule(rule: DenialRule): rule is "PAYEE_BLOCKED" | "PAYEE_NEEDS_APPROVAL" {
  return rule === "PAYEE_BLOCKED" || rule === "PAYEE_NEEDS_APPROVAL";
}

/**
 * Why the Payee check refused a Call, from what the server recorded with the Refusal: the owner's denial, an account
 * it could not read, or the heaviest reason the check gave. Null for any other rule. The reason is the check's own
 * sentence, built from checked values; a report's text is never part of it.
 */
export function payeeRefusalReason(d: Denial): string | null {
  if (!isPayeeCheckRule(d.rule)) return null;
  const parsed = payeeDetailsSchema.safeParse(d.details ?? {});
  const details = parsed.success ? parsed.data : {};
  const signals = details.payeeCheck?.signals ?? [];
  if (d.rule === "PAYEE_NEEDS_APPROVAL") {
    const warning = signals.find((s) => s.severity === "warn");
    return warning ? `The Payee check has a warning about this Payee, and the Budget owner has not approved it yet. ${asSentence(warning.reason)}` : PLAIN_REASON.PAYEE_NEEDS_APPROVAL;
  }
  if (details.approval?.status === "denied") return "The Budget owner denied this Payee, so nothing is paid to it.";
  if (details.payeeCheck?.unavailable) return "The Payee could not be checked, and this server has never seen it, so nothing was paid to it yet.";
  const block = signals.find((s) => s.severity === "block");
  return block ? `The Payee check blocks this Payee. ${asSentence(block.reason)}` : PLAIN_REASON.PAYEE_BLOCKED;
}

/** The retry hint as one sentence. `money` renders an atomic amount with its unit. */
export function retryText(retry: RetryHint, money: (atomic: string) => string): string {
  switch (retry.kind) {
    case "never":
      return "Retrying will not help; the Call needs a different Payee, price or Budget.";
    case "after":
      return isHubUnreadable(retry) ? `The server reads the hub again shortly. Retry in about ${waitText(retry.seconds)}.` : `Retry in about ${waitText(retry.seconds)}.`;
    case "after_settlement":
      return "Retry after the next settlement batch confirms.";
    case "fund":
      return retry.fromCredit
        ? `Add ${money(retry.shortBy)} to this Budget's escrow, then retry. Your hub credit can cover ${money(retry.fromCredit.amount)} of it.`
        : `Add ${money(retry.shortBy)} to this Budget's escrow, then retry.`;
    case "resign":
      return `The agent should sign a new voucher at a running total of ${money(retry.expectedCumulative)}.`;
    case "approval":
      return `Waiting for the owner's approval of ${retry.payee}. The same Call goes through once the owner approves it on the Budget's page.`;
  }
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
  /** Why these Calls were refused, in plain words. */
  description: string;
  /**
   * Set for the row of Calls refused only because the hub could not be read. They carry the NET_EXPOSURE rule but say
   * nothing about escrow, so they are counted apart from real escrow shortfalls.
   */
  hubUnreadable?: RetryHint;
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
  const map = new Map<string, RuleSummary>();
  let attempted = 0n;
  let attacks = 0;
  let latest: Denial | null = null;
  for (const d of denials) {
    const amount = d.amount ? BigInt(d.amount) : 0n;
    attempted += amount;
    const info = RULE_INFO[d.rule] ?? { title: d.rule, kind: "state" as const };
    if (info.kind === "attack") attacks += 1;
    if (!latest || d.createdAt > latest.createdAt) latest = d;
    const retry = refusalOf(d).retry;
    const unreadable = isHubUnreadable(retry);
    const key = unreadable ? `${d.rule}:hub_unreadable` : d.rule;
    const row = map.get(key);
    if (row) {
      row.count += 1;
      row.attempted += amount;
      if (d.createdAt > row.last) row.last = d.createdAt;
    } else {
      map.set(key, {
        rule: d.rule,
        title: refusalTitle(d.rule, retry),
        kind: unreadable ? "state" : info.kind,
        count: 1,
        attempted: amount,
        last: d.createdAt,
        description: refusalReason(d.rule, retry),
        ...(unreadable ? { hubUnreadable: retry } : {}),
      });
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
