import { describe, expect, it } from "vitest";
import { AGENT_ONLY_RULES, DENIAL_RULES, HUB_UNREADABLE_MESSAGE, PAYEE_CHECK_RULES, REPEAT_WINDOW_SEC, canonicalPolicy, policyHash, type NodeDenialRule, type PayeeCheckRule } from "@payminto/protocol";
import { HUB_RETRY_SEC, evaluateVoucher, type VoucherContext, type WindowQuery } from "../src/policy-engine.ts";

const NOW = 1_800_000_000;
const PAYEE = "api.seller.testnet";

function ctx(over: Partial<VoucherContext> = {}): VoucherContext {
  return {
    now: NOW,
    nowMs: BigInt(NOW) * 1000n,
    provider: { payee: PAYEE, priceAtomic: 1_000n },
    voucher: { budgetId: "aa".repeat(32), payee: PAYEE, amount: 1_000n, cumulative: 6_000n },
    signatureValid: true,
    budget: {
      status: "open",
      cap: 100_000n,
      validUntilMs: BigInt(NOW + 3_600) * 1000n,
      payees: [PAYEE],
      policy: { perCallCap: "5000", dailyCap: "50000", hourlyCap: "20000", maxCallsPerMinute: 10, maxRepeatsPerRequest: 3, purpose: "test" },
    },
    position: 5_000n,
    callsLastMinute: 0,
    sameRequestCalls: 0,
    spentLastHour: 0n,
    spentLast24h: 5_000n,
    spentTotal: 5_000n,
    budgetOutstanding: 5_000n,
    ownerIncoming: 0n,
    funds: { escrow: 50_000n, credit: 0n },
    fundsAgeMs: 0,
    fundsMaxAgeMs: 10_000,
    ...over,
  };
}

const withBudget = (b: Partial<NonNullable<VoucherContext["budget"]>>) => ctx({ budget: { ...ctx().budget!, ...b } });
const withPolicy = (p: Partial<NonNullable<VoucherContext["budget"]>["policy"]>) => withBudget({ policy: { ...ctx().budget!.policy, ...p } });

/** A first call to a payee this Budget has never paid, under the node's new-payee limits (min 1,000, 5 per hour). */
const newPayee = (limits: Partial<NonNullable<VoucherContext["newPayee"]>> = {}, over: Partial<VoucherContext> = {}) =>
  ctx({
    position: 0n,
    voucher: { ...ctx().voucher, cumulative: 1_000n },
    newPayee: { isNew: true, lastHour: 0, minFirstAmount: 1_000n, maxPerHour: 5, ...limits },
    ...over,
  });

/** The rules the engine decides: every node rule but the two of the payee check, which runs before it (test/payee-check.test.ts). */
type EngineRule = Exclude<NodeDenialRule, PayeeCheckRule>;

/** One context per engine rule that breaks only that rule. */
const breakers: Record<EngineRule, () => VoucherContext> = {
  UNKNOWN_BUDGET: () => ctx({ budget: null }),
  BUDGET_REVOKED: () => withBudget({ status: "revoked" }),
  BUDGET_NOT_ACTIVE: () => withBudget({ validUntilMs: BigInt(NOW - 1) * 1000n }),
  PAYEE_NOT_ALLOWED: () => ctx({ voucher: { ...ctx().voucher, payee: "attacker.testnet" }, provider: { payee: "attacker.testnet", priceAtomic: 1_000n } }),
  PRICE_MISMATCH: () => ctx({ provider: { payee: PAYEE, priceAtomic: 999n } }),
  PER_CALL_CAP: () => withPolicy({ perCallCap: "999" }),
  BAD_SIGNATURE: () => ctx({ signatureValid: false }),
  STALE_CUMULATIVE: () => ctx({ voucher: { ...ctx().voucher, cumulative: 5_500n } }),
  RATE_LIMIT: () => ctx({ callsLastMinute: 10 }),
  REPEAT_REQUEST: () => ctx({ sameRequestCalls: 3 }),
  HOURLY_CAP: () => ctx({ spentLastHour: 19_500n }),
  DAILY_CAP: () => ctx({ spentLast24h: 49_500n }),
  TOTAL_CAP: () => withBudget({ cap: 5_500n }),
  NET_EXPOSURE: () => ctx({ funds: { escrow: 5_500n, credit: 0n } }),
  NEW_PAYEE_MIN_AMOUNT: () => newPayee({ minFirstAmount: 1_001n }),
  NEW_PAYEE_RATE: () => newPayee({ lastHour: 5 }),
};

describe("evaluateVoucher", () => {
  it("accepts a call that fits every rule", () => {
    expect(evaluateVoucher(ctx())).toEqual({ ok: true });
  });

  it("has a breaker for every rule the engine decides", () => {
    const nodeRules = Object.keys(DENIAL_RULES).filter((r) => ![...AGENT_ONLY_RULES, ...PAYEE_CHECK_RULES].includes(r as never)).sort();
    expect(Object.keys(breakers).sort()).toEqual(nodeRules);
  });

  it.each(Object.entries(breakers))("refuses with %s and nothing else", (rule, make) => {
    const d = evaluateVoucher(make());
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.rule).toBe(rule);
      expect(d.message).toBe(DENIAL_RULES[rule as NodeDenialRule]);
    }
  });

  it("returns the attempted amount, the remaining Budget and a retry hint with every refusal", () => {
    const d = evaluateVoucher(ctx({ callsLastMinute: 10 }));
    if (d.ok) throw new Error("expected a refusal");
    expect(d.refusal).toEqual({ rule: "RATE_LIMIT", message: DENIAL_RULES.RATE_LIMIT, attemptedAmount: "1000", remainingBudget: "95000", retry: { kind: "after", seconds: 60 } });
    const unknown = evaluateVoucher(ctx({ budget: null }));
    if (unknown.ok) throw new Error("expected a refusal");
    expect(unknown.refusal).toMatchObject({ remainingBudget: null, retry: { kind: "never" } });
  });

  it("tells a client with a stale cumulative which cumulative to sign", () => {
    const d = evaluateVoucher(breakers.STALE_CUMULATIVE());
    if (d.ok) throw new Error("expected a refusal");
    expect(d.refusal.retry).toEqual({ kind: "resign", expectedCumulative: "6000" });
  });
});

describe("per-hour limit", () => {
  it("allows spending exactly up to the hourly cap and waits an hour after it", () => {
    expect(evaluateVoucher(ctx({ spentLastHour: 19_000n })).ok).toBe(true);
    const d = evaluateVoucher(ctx({ spentLastHour: 19_001n }));
    if (d.ok) throw new Error("expected a refusal");
    expect(d.rule).toBe("HOURLY_CAP");
    expect(d.refusal.retry).toEqual({ kind: "after", seconds: 3_600 });
  });

  it("is off when hourlyCap is 0 or absent", () => {
    expect(evaluateVoucher({ ...withPolicy({ hourlyCap: "0" }), spentLastHour: 10n ** 9n }).ok).toBe(true);
    const { hourlyCap: _h, ...rest } = ctx().budget!.policy;
    expect(evaluateVoucher({ ...withPolicy({}), budget: { ...ctx().budget!, policy: rest }, spentLastHour: 10n ** 9n }).ok).toBe(true);
  });
});

describe("same-request repeat limit", () => {
  it("lets an agent repeat a request up to the limit, then refuses until the oldest counted call leaves the window", () => {
    expect(evaluateVoucher(ctx({ sameRequestCalls: 2 })).ok).toBe(true);
    const asked: WindowQuery[] = [];
    const d = evaluateVoucher(ctx({ sameRequestCalls: 3, waitFor: (q) => (asked.push(q), 1_234) }));
    if (d.ok) throw new Error("expected a refusal");
    expect(d.rule).toBe("REPEAT_REQUEST");
    // One call must leave the one-hour window; the caller says that happens in 1,234 s.
    expect(asked).toEqual([{ window: "sameRequest", seconds: REPEAT_WINDOW_SEC, leave: 1 }]);
    expect(d.refusal.retry).toEqual({ kind: "after", seconds: 1_234 });
  });

  it("never says never for a window: without window reads the hint is the whole window", () => {
    const d = evaluateVoucher(ctx({ sameRequestCalls: 3 }));
    if (d.ok) throw new Error("expected a refusal");
    expect(d.refusal.retry).toEqual({ kind: "after", seconds: REPEAT_WINDOW_SEC });
  });

  it("is off when maxRepeatsPerRequest is 0", () => {
    expect(evaluateVoucher({ ...withPolicy({ maxRepeatsPerRequest: 0 }), sameRequestCalls: 1_000 }).ok).toBe(true);
  });
});

describe("retry hints never invite a retry that cannot work, and never say never when waiting works", () => {
  const hint = (c: VoucherContext) => {
    const d = evaluateVoucher(c);
    if (d.ok) throw new Error("expected a refusal");
    return { rule: d.rule, retry: d.refusal.retry };
  };
  /** A Budget valid for ten more days, so waits of hours are not cut short by its expiry. */
  const longLived = () => withBudget({ validUntilMs: BigInt(NOW + 10 * 86_400) * 1000n });
  /** Answers every window read with a fixed number of seconds per window kind. */
  const waits = (w: { calls?: number; sameRequest?: number; hour?: number; day?: number }) => (q: WindowQuery) =>
    q.window === "calls" ? (w.calls ?? null) : q.window === "sameRequest" ? (w.sameRequest ?? null) : q.seconds === 3_600 ? (w.hour ?? null) : (w.day ?? null);

  it("waits for as many calls to leave the minute as are over the limit", () => {
    const asked: WindowQuery[] = [];
    const d = hint(ctx({ callsLastMinute: 12, waitFor: (q) => (asked.push(q), 17) }));
    expect(asked).toEqual([{ window: "calls", seconds: 60, leave: 3 }]);
    expect(d).toEqual({ rule: "RATE_LIMIT", retry: { kind: "after", seconds: 17 } });
  });

  it("waits until enough spend leaves the hour for this call to fit", () => {
    const asked: WindowQuery[] = [];
    const d = hint(ctx({ spentLastHour: 19_500n, waitFor: (q) => (asked.push(q), 600) }));
    expect(asked).toEqual([{ window: "spend", seconds: 3_600, free: 500n }]);
    expect(d).toEqual({ rule: "HOURLY_CAP", retry: { kind: "after", seconds: 600 } });
    expect(hint({ ...longLived(), spentLast24h: 49_500n, waitFor: waits({ day: 7_200 }) })).toEqual({ rule: "DAILY_CAP", retry: { kind: "after", seconds: 7_200 } });
  });

  it("says never when the call alone is larger than a rolling cap", () => {
    // 1,000 against an hourly cap of 900: no amount of waiting makes it fit.
    expect(hint({ ...withPolicy({ hourlyCap: "900" }), waitFor: waits({ hour: 10 }) })).toEqual({ rule: "HOURLY_CAP", retry: { kind: "never" } });
    expect(hint({ ...withPolicy({ dailyCap: "900" }), spentLast24h: 0n, waitFor: waits({ day: 10 }) })).toEqual({ rule: "DAILY_CAP", retry: { kind: "never" } });
  });

  it("waits for the slowest limit when a later rolling limit would still refuse the retry", () => {
    // Over the per-minute limit and over the daily cap: retrying after the minute would only meet DAILY_CAP.
    const both = { ...longLived(), callsLastMinute: 10, spentLast24h: 49_500n, waitFor: waits({ calls: 20, day: 5_000 }) };
    expect(hint(both)).toEqual({ rule: "RATE_LIMIT", retry: { kind: "after", seconds: 5_000 } });
    const hourThenDay = { ...longLived(), spentLastHour: 19_500n, spentLast24h: 49_500n, waitFor: waits({ hour: 100, day: 9_000 }) };
    expect(hint(hourThenDay)).toEqual({ rule: "HOURLY_CAP", retry: { kind: "after", seconds: 9_000 } });
  });

  it("says never for a window refusal when the Budget cap would refuse the retry anyway", () => {
    const d = hint({ ...withBudget({ cap: 5_500n }), callsLastMinute: 10, waitFor: waits({ calls: 20 }) });
    expect(d).toEqual({ rule: "RATE_LIMIT", retry: { kind: "never" } });
  });

  it("says never when the Budget expires before the wait is over", () => {
    const soon = { ...withBudget({ validUntilMs: BigInt(NOW + 30) * 1000n }), callsLastMinute: 10 };
    expect(hint({ ...soon, waitFor: waits({ calls: 20 }) })).toEqual({ rule: "RATE_LIMIT", retry: { kind: "after", seconds: 20 } });
    expect(hint({ ...soon, waitFor: waits({ calls: 31 }) })).toEqual({ rule: "RATE_LIMIT", retry: { kind: "never" } });
  });

  it("keeps never for refusals no wait can change", () => {
    for (const rule of ["UNKNOWN_BUDGET", "BAD_SIGNATURE", "BUDGET_REVOKED", "BUDGET_NOT_ACTIVE", "PAYEE_NOT_ALLOWED", "PRICE_MISMATCH", "PER_CALL_CAP", "TOTAL_CAP"] as const) {
      expect(hint(breakers[rule]())).toEqual({ rule, retry: { kind: "never" } });
    }
  });
});

describe("a request paid with several vouchers", () => {
  it("checks every cap against the total of the request", () => {
    // Two vouchers of 3,000 each fit a per-call cap of 5,000; the 6,000 request does not.
    const first = { voucher: { ...ctx().voucher, amount: 3_000n, cumulative: 8_000n }, provider: { payee: PAYEE, priceAtomic: 3_000n } };
    expect(evaluateVoucher(ctx(first)).ok).toBe(true);
    const d = evaluateVoucher(ctx({ ...first, requestAmount: 6_000n }));
    if (d.ok) throw new Error("expected a refusal");
    expect(d.rule).toBe("PER_CALL_CAP");
    expect(d.refusal.attemptedAmount).toBe("6000");
    expect(d.details).toMatchObject({ amount: "3000", requestAmount: "6000", perCallCap: "5000" });
  });

  it("checks the rolling caps, the Budget cap and the exposure limit against the total too", () => {
    const part = (over: Partial<VoucherContext>) => {
      const d = evaluateVoucher({ ...withPolicy({ perCallCap: "50000" }), requestAmount: 4_000n, ...over });
      return d.ok ? "ok" : d.rule;
    };
    expect(part({})).toBe("ok");
    expect(part({ spentLastHour: 16_001n })).toBe("HOURLY_CAP");
    expect(part({ spentLast24h: 46_001n })).toBe("DAILY_CAP");
    expect(part({ spentTotal: 96_001n })).toBe("TOTAL_CAP");
    expect(part({ budgetOutstanding: 46_001n })).toBe("NET_EXPOSURE");
  });

  it("counts the request once: its later vouchers skip the per-minute and same-request limits", () => {
    const full = { callsLastMinute: 10, sameRequestCalls: 3 };
    const first = evaluateVoucher(ctx(full));
    expect(first.ok ? null : first.rule).toBe("RATE_LIMIT");
    expect(evaluateVoucher(ctx({ ...full, requestPart: 1 })).ok).toBe(true);
  });
});

describe("fail-closed net exposure", () => {
  const refusal = (c: VoucherContext) => {
    const d = evaluateVoucher(c);
    if (d.ok) throw new Error("expected a refusal");
    expect(d.rule).toBe("NET_EXPOSURE");
    return d;
  };

  it("allows this Budget's unsettled spending up to its escrow", () => {
    expect(evaluateVoucher(ctx({ budgetOutstanding: 49_000n, funds: { escrow: 50_000n, credit: 0n } })).ok).toBe(true);
    expect(evaluateVoucher(ctx({ budgetOutstanding: 49_001n, funds: { escrow: 50_000n, credit: 0n } })).ok).toBe(false);
  });

  it("counts escrow only: hub credit never widens the limit, because the hub debits only escrow at settlement", () => {
    // 9,000 outstanding plus this call is 10,000 against 5,000 escrow. Credit cannot pay a net debit on chain.
    const base = { budgetOutstanding: 9_000n };
    refusal(ctx({ ...base, funds: { escrow: 5_000n, credit: 0n } }));
    refusal(ctx({ ...base, funds: { escrow: 5_000n, credit: 1_000_000n } }));
    expect(evaluateVoucher(ctx({ ...base, funds: { escrow: 10_000n, credit: 0n } })).ok).toBe(true);
  });

  it("does not count unsettled incoming calls either: an offset that has not settled may never arrive", () => {
    refusal(ctx({ budgetOutstanding: 9_000n, ownerIncoming: 1_000_000n, funds: { escrow: 5_000n, credit: 0n } }));
  });

  it("fails closed when funds were never read, and asks to retry shortly instead of asking for a deposit", () => {
    const d = refusal(ctx({ funds: null, budgetOutstanding: 0n }));
    expect(d.details).toMatchObject({ fundsKnown: false, hubUnreadable: true });
    expect(d.message).toBe(HUB_UNREADABLE_MESSAGE);
    expect(d.refusal.retry).toEqual({ kind: "after", seconds: HUB_RETRY_SEC, reason: "hub_unreadable" });
  });

  it("fails closed on a snapshot older than its maximum age, however much escrow it showed", () => {
    expect(evaluateVoucher(ctx({ fundsAgeMs: 10_000 })).ok).toBe(true);
    const d = refusal(ctx({ fundsAgeMs: 10_001, funds: { escrow: 10n ** 12n, credit: 0n } }));
    expect(d.message).toBe(HUB_UNREADABLE_MESSAGE);
    expect(d.refusal).toMatchObject({ message: HUB_UNREADABLE_MESSAGE, retry: { kind: "after", seconds: HUB_RETRY_SEC, reason: "hub_unreadable" } });
    expect(d.details).toMatchObject({ hubUnreadable: true, fundsKnown: true, fundsAgeMs: 10_001, fundsMaxAgeMs: 10_000 });
    // A stale snapshot never turns another rule's refusal into this one: the first failing rule still wins.
    const capped = evaluateVoucher({ ...withBudget({ cap: 5_500n }), fundsAgeMs: 99_999 });
    expect(capped.ok ? null : capped.rule).toBe("TOTAL_CAP");
  });

  it("asks for a deposit when settling would leave no room, as when the Budget only spends", () => {
    // 50,000 outstanding against 50,000 escrow: settling debits all of it, so only new escrow helps.
    const d = refusal(ctx({ budgetOutstanding: 50_000n, funds: { escrow: 50_000n, credit: 0n } }));
    expect(d.refusal.retry).toEqual({ kind: "fund", shortBy: "1000" });
    expect(refusal(ctx({ budgetOutstanding: 0n, funds: { escrow: 0n, credit: 0n } })).refusal.retry).toEqual({ kind: "fund", shortBy: "1000" });
  });

  it("asks to wait for settlement when the owner is owed enough in the same window to leave room after the batch", () => {
    // Net debit after settling is 50,000 - 2,000 = 48,000, leaving 2,000 of escrow for this 1,000 call.
    const d = refusal(ctx({ budgetOutstanding: 50_000n, ownerIncoming: 2_000n, funds: { escrow: 50_000n, credit: 0n } }));
    expect(d.refusal.retry).toEqual({ kind: "after_settlement" });
    // Owed only 500: settling leaves 500 of escrow, which this call does not fit.
    expect(refusal(ctx({ budgetOutstanding: 50_000n, ownerIncoming: 500n, funds: { escrow: 50_000n, credit: 0n } })).refusal.retry).toMatchObject({ kind: "fund" });
  });

  it("names fund_from_credit when the owner holds hub credit", () => {
    const d = refusal(ctx({ budgetOutstanding: 9_000n, funds: { escrow: 5_000n, credit: 3_000n } }));
    expect(d.refusal.retry).toEqual({
      kind: "fund",
      shortBy: "5000",
      fromCredit: { action: "fund_from_credit", budgetId: "aa".repeat(32), amount: "3000", credit: "3000" },
    });
    const plenty = refusal(ctx({ budgetOutstanding: 9_000n, funds: { escrow: 5_000n, credit: 80_000n } }));
    expect(plenty.refusal.retry).toMatchObject({ fromCredit: { amount: "5000", credit: "80000" } });
  });
});

describe("revoked and expired Budgets", () => {
  it("refuses a revoked Budget with no retry, whatever its funds", () => {
    const d = evaluateVoucher({ ...withBudget({ status: "revoked" }), funds: { escrow: 10n ** 12n, credit: 0n } });
    if (d.ok) throw new Error("expected a refusal");
    expect(d.rule).toBe("BUDGET_REVOKED");
    expect(d.refusal.retry).toEqual({ kind: "never" });
  });

  it("refuses from the first millisecond after validUntil, although the hub still settles during its grace period", () => {
    expect(evaluateVoucher(withBudget({ validUntilMs: BigInt(NOW) * 1000n })).ok).toBe(true);
    const d = evaluateVoucher(withBudget({ validUntilMs: BigInt(NOW) * 1000n - 1n }));
    if (d.ok) throw new Error("expected a refusal");
    expect(d.rule).toBe("BUDGET_NOT_ACTIVE");
    expect(d.refusal.retry).toEqual({ kind: "never" });
  });
});

describe("policy hash", () => {
  it("treats absent new fields as disabled, so old and explicit-zero policies hash the same", () => {
    const old = { perCallCap: "1", dailyCap: "2", maxCallsPerMinute: 0, purpose: "p" };
    expect(policyHash(old)).toBe(policyHash({ ...old, hourlyCap: "0", maxRepeatsPerRequest: 0 }));
    expect(policyHash(old)).not.toBe(policyHash({ ...old, hourlyCap: "5" }));
    expect(canonicalPolicy(old)).toBe('{"dailyCap":"2","hourlyCap":"0","maxCallsPerMinute":0,"maxRepeatsPerRequest":0,"perCallCap":"1","purpose":"p"}');
  });
});

describe("new payees (audit F4: every first settlement of a pair costs the settler permanent hub storage)", () => {
  const refused = (c: VoucherContext) => {
    const d = evaluateVoucher(c);
    if (d.ok) throw new Error("expected a refusal");
    return d;
  };

  it("accepts a first payment at exactly the minimum, and a new payee while the hour has room", () => {
    expect(evaluateVoucher(newPayee()).ok).toBe(true);
    expect(evaluateVoucher(newPayee({ lastHour: 4 })).ok).toBe(true);
  });

  it("never applies either limit to a payee this Budget has paid before", () => {
    expect(evaluateVoucher(ctx({ newPayee: { isNew: false, lastHour: 99, minFirstAmount: 10n ** 9n, maxPerHour: 1 } })).ok).toBe(true);
  });

  it("refuses a first payment below the minimum, for good: the same call never passes", () => {
    const d = refused(newPayee({ minFirstAmount: 1_001n }));
    expect(d.rule).toBe("NEW_PAYEE_MIN_AMOUNT");
    expect(d.refusal).toMatchObject({ rule: "NEW_PAYEE_MIN_AMOUNT", attemptedAmount: "1000", retry: { kind: "never" } });
    expect(d.details).toEqual({ payee: PAYEE, amount: "1000", minFirstAmount: "1001" });
  });

  it("checks the minimum against the whole request on its first voucher, and not on the later ones", () => {
    // A split payment of 1,000 to the merchant and 50 to the platform fee is one first payment of 1,050.
    expect(evaluateVoucher(newPayee({ minFirstAmount: 1_050n }, { requestAmount: 1_050n, requestPart: 0 })).ok).toBe(true);
    expect(refused(newPayee({ minFirstAmount: 1_051n }, { requestAmount: 1_050n, requestPart: 0 })).rule).toBe("NEW_PAYEE_MIN_AMOUNT");
    // The fee voucher (part 1) pays the operator's own fee account: the request already passed the minimum.
    const fee = newPayee(
      { minFirstAmount: 1_051n },
      { provider: { payee: PAYEE, priceAtomic: 50n }, voucher: { ...ctx().voucher, amount: 50n, cumulative: 50n }, requestAmount: 50n, requestPart: 1 },
    );
    expect(evaluateVoucher(fee).ok).toBe(true);
  });

  it("refuses a new payee once the hour's quota of new payees is used, and says when one leaves the window", () => {
    const asked: WindowQuery[] = [];
    const d = refused(newPayee({ lastHour: 5 }, { waitFor: (q) => (asked.push(q), 1_234) }));
    expect(d.rule).toBe("NEW_PAYEE_RATE");
    expect(d.message).toBe(DENIAL_RULES.NEW_PAYEE_RATE);
    expect(asked).toEqual([{ window: "newPayees", seconds: 3_600, leave: 1 }]);
    expect(d.refusal.retry).toEqual({ kind: "after", seconds: 1_234 });
    expect(d.details).toEqual({ payee: PAYEE, newPayeesLastHour: 5, maxNewPayeesPerHour: 5 });
    // Without a lookup the hint is the whole hour, which is always long enough.
    expect(refused(newPayee({ lastHour: 7 })).refusal.retry).toEqual({ kind: "after", seconds: 3_600 });
  });

  it("says never when the Budget expires before a slot frees up", () => {
    const d = refused(newPayee({ lastHour: 5 }, { waitFor: () => 1_800, budget: { ...ctx().budget!, validUntilMs: BigInt(NOW + 600) * 1000n } }));
    expect(d.rule).toBe("NEW_PAYEE_RATE");
    expect(d.refusal.retry).toEqual({ kind: "never" });
  });

  it("is off when a limit is 0 or the node passes none", () => {
    expect(evaluateVoucher(newPayee({ minFirstAmount: 0n, maxPerHour: 0, lastHour: 10_000 })).ok).toBe(true);
    expect(evaluateVoucher({ ...newPayee(), newPayee: undefined }).ok).toBe(true);
  });
});
