import type { RetryHint } from "@payminto/protocol";

/**
 * Every reason this package refuses to spend. They are agent-side rules: the check runs before anything is signed, so a
 * refusal costs nothing and moves nothing.
 */
export const MARKET_RULES = {
  NETWORK_NOT_ALLOWED: "The quote offers no payment on the network the policy allows",
  ASSET_NOT_ALLOWED: "The quote asks for an asset the policy does not allow",
  PAYEE_BLOCKED: "The payee check blocked the account the quote pays",
  PAYEE_WARNED: "The payee check warned about the account the quote pays, and the policy refuses on a warning",
  PAYEE_VERDICT_MISMATCH: "The payee verdict is about a different account than the one the quote pays",
  VALIDITY_TOO_LONG: "The payment would stay valid longer than the policy allows",
  PER_HIRE_MAX: "The quoted price exceeds the per-hire maximum",
  DAILY_MAX: "The hire would exceed the rolling 24h maximum",
  JOB_SPEND_CEILING: "The purchase would exceed the spend ceiling of this job",
} as const;

export type MarketRule = keyof typeof MARKET_RULES;

/**
 * A machine-readable refusal in the shape Payminto uses everywhere: the rule, the attempted amount, what is left of the
 * limit, and a retry hint. It parses with `refusalSchema` from `@payminto/protocol`, and it carries the two extra
 * fields the Payminto MCP wallet adds (`ruleText`, `enforcedBy`), so an agent reads it like any other refusal.
 */
export type MarketRefusal = {
  rule: MarketRule;
  /** The fixed sentence for the rule. */
  ruleText: string;
  /** The specifics of this refusal. Built from validated values only, never from another party's free text. */
  message: string;
  /** Always the agent's own side: nothing was signed and nothing reached the market's payment step. */
  enforcedBy: "agent";
  /** The amount that was refused, in atomic units. */
  attemptedAmount: string;
  /** What is left under the limit that applies (the rolling day, or the job's ceiling), in atomic units. */
  remainingBudget: string | null;
  /** The limit of the rule that fired, in atomic units, when the rule has one. */
  limit: string | null;
  retry: Extract<RetryHint, { kind: "never" | "after" }>;
};

export function refuse(rule: MarketRule, o: { message: string; attemptedAmount: bigint; remaining: bigint | null; limit?: bigint | null; retryAfterSeconds?: number }): MarketRefusal {
  return {
    rule,
    ruleText: MARKET_RULES[rule],
    message: o.message,
    enforcedBy: "agent",
    attemptedAmount: o.attemptedAmount.toString(),
    remainingBudget: o.remaining === null ? null : o.remaining.toString(),
    limit: o.limit === undefined || o.limit === null ? null : o.limit.toString(),
    retry: o.retryAfterSeconds === undefined ? { kind: "never" } : { kind: "after", seconds: o.retryAfterSeconds },
  };
}

/** The retry hint in words. */
export function retryText(retry: MarketRefusal["retry"]): string {
  return retry.kind === "never" ? "do not retry: waiting will not change this" : `retry after ${retry.seconds} s`;
}
