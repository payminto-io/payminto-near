import { describe, expect, it } from "vitest";
import { DENIAL_RULES } from "@payminto/protocol";
import { RULE_INFO, asSentence, ruleTitle, summarizeDenials } from "@/lib/denials";
import type { Denial } from "@/lib/schemas";

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
