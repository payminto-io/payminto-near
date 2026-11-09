import { describe, expect, it } from "vitest";
import { AGENT_ONLY_RULES, DENIAL_RULES, type NodeDenialRule } from "@payminto/protocol";
import { evaluateVoucher, type VoucherContext } from "../src/policy-engine.ts";

const TOKEN = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
const OTHER_TOKEN = "0x054ed45810DbBAb8B27668922D110669c9D88D0a";
const PAYEE = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const STRANGER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const NOW = 1_800_000_000;

/** A context where every rule passes; each test breaks exactly one thing. */
function ok(): VoucherContext {
  return {
    now: NOW,
    nodeToken: TOKEN,
    provider: { payee: PAYEE, priceAtomic: 1_000n },
    voucher: { mandateId: `0x${"11".repeat(32)}`, payee: PAYEE, amount: 1_000n, cumulative: 6_000n },
    signatureValid: true,
    mandate: {
      status: "open",
      token: TOKEN,
      totalCap: 100_000n,
      validAfter: NOW - 100,
      validUntil: NOW + 100,
      payees: [PAYEE],
      policy: { perCallCap: "5000", dailyCap: "20000", maxCallsPerMinute: 10, purpose: "test" },
    },
    position: 5_000n,
    callsLastMinute: 3,
    spentLast24h: 5_000n,
    spentTotal: 5_000n,
    agentOutstanding: 5_000n,
    funds: { balance: 1_000_000n, allowance: 1_000_000n },
  };
}

type Breaker = (c: VoucherContext) => void;
const breakers: Record<NodeDenialRule, Breaker> = {
  UNKNOWN_MANDATE: (c) => {
    c.mandate = null;
  },
  MANDATE_REVOKED: (c) => {
    c.mandate!.status = "revoked";
  },
  MANDATE_NOT_ACTIVE: (c) => {
    c.mandate!.validUntil = NOW - 1;
  },
  TOKEN_MISMATCH: (c) => {
    c.mandate!.token = OTHER_TOKEN;
  },
  PAYEE_NOT_ALLOWED: (c) => {
    c.voucher.payee = STRANGER;
  },
  PRICE_MISMATCH: (c) => {
    c.voucher.amount = 999n;
    c.voucher.cumulative = c.position + 999n;
  },
  PER_CALL_CAP: (c) => {
    c.provider.priceAtomic = 6_000n;
    c.voucher.amount = 6_000n;
    c.voucher.cumulative = c.position + 6_000n;
  },
  BAD_SIGNATURE: (c) => {
    c.signatureValid = false;
  },
  STALE_CUMULATIVE: (c) => {
    c.voucher.cumulative = c.position; // does not extend the latest accepted voucher
  },
  RATE_LIMIT: (c) => {
    c.callsLastMinute = 10;
  },
  DAILY_CAP: (c) => {
    c.spentLast24h = 19_500n;
  },
  TOTAL_CAP: (c) => {
    c.spentTotal = 99_500n;
  },
  INSUFFICIENT_FUNDS: (c) => {
    c.funds = { balance: 5_500n, allowance: 1_000_000n };
  },
};

const ORDER = Object.keys(breakers) as NodeDenialRule[];

describe("policy engine", () => {
  it("accepts a voucher that passes every rule", () => {
    expect(evaluateVoucher(ok())).toEqual({ ok: true });
  });

  it("covers every DenialRule the protocol defines, except the agent-only ones", () => {
    const agentOnly: readonly string[] = AGENT_ONLY_RULES;
    expect(new Set(ORDER)).toEqual(new Set(Object.keys(DENIAL_RULES).filter((r) => !agentOnly.includes(r))));
  });

  for (const rule of ORDER) {
    it(`denies with ${rule}`, () => {
      const c = ok();
      breakers[rule](c);
      const d = evaluateVoucher(c);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.rule).toBe(rule);
        expect(d.message).toBe(DENIAL_RULES[rule]);
      }
    });
  }

  it("applies rules in SPEC 5.4 order: for every pair of broken rules the earlier one is reported", () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = i + 1; j < ORDER.length; j++) {
        const c = ok();
        breakers[ORDER[j]!](c);
        breakers[ORDER[i]!](c);
        const d = evaluateVoucher(c);
        expect(d.ok ? "ok" : d.rule, `${ORDER[i]} before ${ORDER[j]}`).toBe(ORDER[i]);
      }
    }
  });

  it("treats a pending (not yet opened on chain) or not-yet-valid mandate as not active", () => {
    const a = ok();
    a.mandate!.status = "pending";
    expect(evaluateVoucher(a)).toMatchObject({ rule: "MANDATE_NOT_ACTIVE" });
    const b = ok();
    b.mandate!.validAfter = NOW + 1;
    expect(evaluateVoucher(b)).toMatchObject({ rule: "MANDATE_NOT_ACTIVE" });
  });

  it("allows any payee when the allowlist is empty", () => {
    const c = ok();
    c.mandate!.payees = [];
    c.voucher.payee = STRANGER;
    c.provider.payee = STRANGER;
    expect(evaluateVoucher(c).ok).toBe(true);
  });

  it("disables the rate limit when maxCallsPerMinute is 0", () => {
    const c = ok();
    c.mandate!.policy.maxCallsPerMinute = 0;
    c.callsLastMinute = 1_000_000;
    expect(evaluateVoucher(c).ok).toBe(true);
  });

  it("allows spend exactly at the per-call, daily and total caps", () => {
    const c = ok();
    c.mandate!.policy.perCallCap = "1000";
    c.spentLast24h = 19_000n;
    c.spentTotal = 99_000n;
    expect(evaluateVoucher(c).ok).toBe(true);
  });

  it("reports the expected cumulative on STALE_CUMULATIVE so the agent can re-sign", () => {
    const c = ok();
    c.voucher.cumulative = 1_000n;
    expect(evaluateVoucher(c)).toMatchObject({ rule: "STALE_CUMULATIVE", details: { expectedCumulative: "6000", cumulative: "1000" } });
  });

  it("bounds funds by min(balance, allowance) and counts outstanding unsettled debits", () => {
    const lowAllowance = ok();
    lowAllowance.funds = { balance: 1_000_000n, allowance: 5_999n };
    expect(evaluateVoucher(lowAllowance)).toMatchObject({ rule: "INSUFFICIENT_FUNDS" });
    const exact = ok();
    exact.funds = { balance: 6_000n, allowance: 6_000n };
    expect(evaluateVoucher(exact).ok).toBe(true);
    const unknownFunds = ok();
    unknownFunds.funds = null;
    expect(evaluateVoucher(unknownFunds)).toMatchObject({ rule: "INSUFFICIENT_FUNDS" });
  });
});
