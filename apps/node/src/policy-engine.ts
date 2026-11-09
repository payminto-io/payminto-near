import { isAddressEqual, type Address, type Hex } from "viem";
import { DENIAL_RULES, type DenialRule, type Policy } from "@payminto/protocol";

/** Everything the policy engine needs, loaded inside the acceptance transaction. Pure data, no I/O. */
export type VoucherContext = {
  now: number; // unix seconds
  nodeToken: Address;
  provider: { payee: Address; priceAtomic: bigint };
  voucher: { mandateId: Hex; payee: Address; amount: bigint; cumulative: bigint };
  /** Result of the EIP-712 / ERC-1271 check, computed before the transaction (the agent is immutable). */
  signatureValid: boolean;
  mandate: null | {
    status: "pending" | "open" | "revoked";
    token: Address;
    totalCap: bigint;
    validAfter: number;
    validUntil: number;
    payees: readonly Address[];
    policy: Policy;
  };
  /** Latest accepted cumulative for (mandate, payee), or 0. */
  position: bigint;
  /** Accepted calls of this mandate in the last 60 s. */
  callsLastMinute: number;
  /** Accepted spend of this mandate in the last 24 h. */
  spentLast24h: bigint;
  /** Settled plus accepted-unsettled spend of this mandate. */
  spentTotal: bigint;
  /** Accepted-unsettled debits of the agent wallet across all its mandates in this token. */
  agentOutstanding: bigint;
  /** Last known wallet funds; null if never observed. */
  funds: null | { balance: bigint; allowance: bigint };
};

export type Decision =
  | { ok: true }
  | { ok: false; rule: DenialRule; message: string; details: Record<string, string | number | boolean | null> };

function deny(rule: DenialRule, details: Record<string, string | number | boolean | null> = {}): Decision {
  return { ok: false, rule, message: DENIAL_RULES[rule], details };
}

/**
 * The full denial rule order (SPEC 5.4). The first failing rule wins.
 * Kept pure so every rule is unit tested without a database or chain.
 */
export function evaluateVoucher(c: VoucherContext): Decision {
  const { voucher: v, mandate: m } = c;
  if (!m) return deny("UNKNOWN_MANDATE");
  if (m.status === "revoked") return deny("MANDATE_REVOKED");
  if (m.status !== "open" || c.now < m.validAfter || c.now > m.validUntil) {
    return deny("MANDATE_NOT_ACTIVE", { status: m.status, validAfter: m.validAfter, validUntil: m.validUntil, now: c.now });
  }
  if (!isAddressEqual(m.token, c.nodeToken)) return deny("TOKEN_MISMATCH", { mandateToken: m.token, nodeToken: c.nodeToken });
  if (m.payees.length > 0 && !m.payees.some((p) => isAddressEqual(p, v.payee))) {
    return deny("PAYEE_NOT_ALLOWED", { payee: v.payee });
  }
  if (v.amount !== c.provider.priceAtomic) {
    return deny("PRICE_MISMATCH", { amount: v.amount.toString(), price: c.provider.priceAtomic.toString() });
  }
  const perCallCap = BigInt(m.policy.perCallCap);
  if (v.amount > perCallCap) return deny("PER_CALL_CAP", { amount: v.amount.toString(), perCallCap: perCallCap.toString() });
  if (!c.signatureValid) return deny("BAD_SIGNATURE");
  if (v.cumulative !== c.position + v.amount) {
    return deny("STALE_CUMULATIVE", { expectedCumulative: (c.position + v.amount).toString(), cumulative: v.cumulative.toString() });
  }
  if (m.policy.maxCallsPerMinute > 0 && c.callsLastMinute >= m.policy.maxCallsPerMinute) {
    return deny("RATE_LIMIT", { maxCallsPerMinute: m.policy.maxCallsPerMinute, callsLastMinute: c.callsLastMinute });
  }
  const dailyCap = BigInt(m.policy.dailyCap);
  if (c.spentLast24h + v.amount > dailyCap) {
    return deny("DAILY_CAP", { dailyCap: dailyCap.toString(), spentLast24h: c.spentLast24h.toString(), amount: v.amount.toString() });
  }
  if (c.spentTotal + v.amount > m.totalCap) {
    return deny("TOTAL_CAP", { totalCap: m.totalCap.toString(), spentTotal: c.spentTotal.toString(), amount: v.amount.toString() });
  }
  const available = c.funds ? (c.funds.balance < c.funds.allowance ? c.funds.balance : c.funds.allowance) : 0n;
  if (c.agentOutstanding + v.amount > available) {
    return deny("INSUFFICIENT_FUNDS", {
      outstanding: c.agentOutstanding.toString(),
      amount: v.amount.toString(),
      balance: c.funds ? c.funds.balance.toString() : null,
      allowance: c.funds ? c.funds.allowance.toString() : null,
    });
  }
  return { ok: true };
}
