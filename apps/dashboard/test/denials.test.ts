import { describe, expect, it } from "vitest";
import { DENIAL_RULES } from "@payminto/protocol";
import { RULE_INFO, asSentence, defaultRetry, isHubUnreadable, refusalOf, refusalReason, refusalTitle, retrySchema, retryText, ruleTitle, summarizeDenials, waitText } from "@/lib/denials";
import type { Denial } from "@/lib/schemas";

describe("refusal details (decision 8)", () => {
  const denial: Denial = { id: "dn_1", rule: "NET_EXPOSURE", message: "m", amount: "10000", createdAt: "2026-11-10T00:00:00.000Z" };
  const money = (a: string) => `${a} units`;
  it("reads the node's refusal, including the amount hub credit can cover", () => {
    const fromCredit = { action: "fund_from_credit", budgetId: "ab".repeat(32), amount: "400000", credit: "1250000" };
    const r = refusalOf({ ...denial, details: { refusal: { rule: "NET_EXPOSURE", message: "m", attemptedAmount: "10000", remainingBudget: "2124000", retry: { kind: "fund", shortBy: "400000", fromCredit } } } });
    expect(r.remainingBudget).toBe("2124000");
    expect(retryText(r.retry, money)).toBe("Add 400000 units to this Budget's escrow, then retry. Your hub credit can cover 400000 units of it.");
  });
  it("falls back to what the rule implies when an older node sent no refusal", () => {
    expect(refusalOf(denial)).toMatchObject({ attemptedAmount: "10000", remainingBudget: null, retry: { kind: "after_settlement" } });
    expect(retryText(defaultRetry("RATE_LIMIT"), money)).toBe("Retry in about 60 seconds.");
    expect(retryText({ kind: "never" }, money)).toContain("will not help");
  });
});

describe("retry hints with real seconds", () => {
  const money = (a: string) => `${a} units`;
  const withRetry = (rule: Denial["rule"], retry: unknown): Denial => ({
    id: "dn_2",
    rule,
    message: "m",
    amount: "2000",
    createdAt: "2026-11-10T00:00:00.000Z",
    details: { refusal: { rule, message: "m", attemptedAmount: "2000", remainingBudget: "100", retry } },
  });

  it("words an after hint with the seconds the node sent", () => {
    expect(retryText({ kind: "after", seconds: 40 }, money)).toBe("Retry in about 40 seconds.");
    expect(retryText({ kind: "after", seconds: 1 }, money)).toBe("Retry in about 1 second.");
    expect(retryText({ kind: "after", seconds: 0 }, money)).toBe("Retry in about 1 second.");
    expect(retryText({ kind: "after", seconds: 720 }, money)).toBe("Retry in about 12 minutes.");
    expect(retryText({ kind: "after", seconds: 3_600 }, money)).toBe("Retry in about 1 hour.");
    expect(retryText({ kind: "after", seconds: 21_600 }, money)).toBe("Retry in about 6 hours.");
    // Rounded up, so the words never promise a retry sooner than the seconds do.
    expect(waitText(40.2)).toBe("41 seconds");
    expect(waitText(4_500)).toBe("75 minutes");
    expect(waitText(5_400)).toBe("2 hours");
    expect(waitText(86_400)).toBe("24 hours");
    expect(waitText(172_800)).toBe("2 days");
  });

  it("reads REPEAT_REQUEST as a wait, from the node or from the rule alone", () => {
    const r = refusalOf(withRetry("REPEAT_REQUEST", { kind: "after", seconds: 1_500 }));
    expect(r.retry).toEqual({ kind: "after", seconds: 1_500 });
    expect(retryText(r.retry, money)).toBe("Retry in about 25 minutes.");
    const older: Denial = { id: "dn_3", rule: "REPEAT_REQUEST", message: "m", amount: "2000", createdAt: "2026-11-10T00:00:00.000Z" };
    expect(refusalOf(older).retry).toEqual({ kind: "after", seconds: 3_600 });
  });

  it("says the hub could not be read and that nothing is wrong with the Budget", () => {
    const r = refusalOf(withRetry("NET_EXPOSURE", { kind: "after", seconds: 5, reason: "hub_unreadable" }));
    expect(r.retry).toEqual({ kind: "after", seconds: 5, reason: "hub_unreadable" });
    expect(isHubUnreadable(r.retry)).toBe(true);
    expect(refusalTitle("NET_EXPOSURE", r.retry)).toBe("Hub could not be read");
    expect(refusalReason("NET_EXPOSURE", r.retry)).toBe("The server could not read this Budget's escrow from the hub, so it refused the Call. Nothing is wrong with the Budget.");
    expect(retryText(r.retry, money)).toBe("The server reads the hub again shortly. Retry in about 5 seconds.");
  });

  it("keeps the rule's own words for an escrow shortfall", () => {
    const r = refusalOf(withRetry("NET_EXPOSURE", { kind: "fund", shortBy: "400000" }));
    expect(isHubUnreadable(r.retry)).toBe(false);
    expect(refusalTitle("NET_EXPOSURE", r.retry)).toBe("Escrow too low");
    expect(refusalReason("NET_EXPOSURE", r.retry)).toContain("holds in escrow");
  });

  it("parses the hint of an older node and drops a reason it does not know", () => {
    expect(retrySchema.parse({ kind: "after", seconds: 60 })).toEqual({ kind: "after", seconds: 60 });
    expect(retrySchema.parse({ kind: "after", seconds: 9, reason: "something_new" })).toEqual({ kind: "after", seconds: 9 });
    expect(retrySchema.safeParse({ kind: "after" }).success).toBe(false);
    expect(retrySchema.parse({ kind: "never" })).toEqual({ kind: "never" });
  });
});

describe("unsigned vouchers", () => {
  it("does not call a voucher the agent never signed forged, since the server records no Refusal for one", () => {
    expect(ruleTitle("BAD_SIGNATURE")).toBe("Voucher not signed by the agent");
    for (const rule of Object.keys(RULE_INFO) as Denial["rule"][]) expect(ruleTitle(rule)).not.toMatch(/forged/i);
  });
});

const d = (id: string, rule: Denial["rule"], createdAt: string, amount?: string): Denial => ({
  id,
  rule,
  message: DENIAL_RULES[rule],
  createdAt,
  amount: amount ?? null,
});

describe("summarizeDenials", () => {
  it("returns zeros for no denials", () => {
    const s = summarizeDenials([]);
    expect(s).toEqual({ total: 0, attempted: 0n, attacks: 0, byRule: [], latest: null });
  });

  it("groups by rule, sums attempted amounts and orders by count then recency", () => {
    const s = summarizeDenials([
      d("1", "PER_CALL_CAP", "2026-11-04T10:00:00.000Z", "500000"),
      d("2", "PAYEE_NOT_ALLOWED", "2026-11-04T10:05:00.000Z", "1000000"),
      d("3", "PER_CALL_CAP", "2026-11-04T10:02:00.000Z", "250000"),
      d("4", "BAD_SIGNATURE", "2026-11-04T10:06:00.000Z"),
    ]);
    expect(s.total).toBe(4);
    expect(s.attempted).toBe(1_750_000n);
    expect(s.attacks).toBe(2);
    expect(s.latest?.id).toBe("4");
    expect(s.byRule.map((r) => r.rule)).toEqual(["PER_CALL_CAP", "BAD_SIGNATURE", "PAYEE_NOT_ALLOWED"]);
    expect(s.byRule[0]).toMatchObject({ count: 2, attempted: 750_000n, last: "2026-11-04T10:02:00.000Z", kind: "limit" });
  });
});

describe("RULE_INFO", () => {
  it("names every protocol rule in plain words without em dashes", () => {
    for (const rule of Object.keys(DENIAL_RULES) as (keyof typeof DENIAL_RULES)[]) {
      expect(RULE_INFO[rule]).toBeDefined();
      expect(ruleTitle(rule)).not.toMatch(/\u2014/);
    }
  });
});

describe("asSentence", () => {
  it("adds a full stop only when the message lacks closing punctuation", () => {
    expect(asSentence("Too many calls per minute")).toBe("Too many calls per minute.");
    expect(asSentence("Asked the agent to pay 0x12…")).toBe("Asked the agent to pay 0x12…");
    expect(asSentence("Done.")).toBe("Done.");
    expect(asSentence("  ")).toBe("");
  });
});
