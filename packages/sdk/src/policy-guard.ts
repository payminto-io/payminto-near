import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import {
  DENIAL_RULES,
  mandateFromJson,
  mandateId as computeMandateId,
  payeesRoot,
  policyHash,
  type DenialRule,
  type Mandate,
  type MandateJson,
  type Policy,
} from "@payminto/protocol";

/** What the agent needs to enforce its own mandate: the signed mandate, the policy it commits to, and the allowlist. */
export type MandatePolicy = { mandate: Mandate | MandateJson; policy: Policy; payees: readonly Address[] };

export type VerifiedPolicy = { mandate: Mandate; policy: Policy; payees: Address[] };

export class PolicyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyMismatchError";
  }
}

/**
 * Checks a policy bundle against the mandate id the agent holds. The mandate id is the EIP-712 digest of the mandate,
 * which commits to policyHash and payeesRoot, so a node (or anyone) serving a looser policy or allowlist is caught here.
 */
export function verifyMandatePolicy(chainId: number, hub: Address, expectedMandateId: Hex, bundle: MandatePolicy): VerifiedPolicy {
  const m = typeof bundle.mandate.totalCap === "bigint" ? (bundle.mandate as Mandate) : mandateFromJson(bundle.mandate as MandateJson);
  if (computeMandateId(chainId, hub, m).toLowerCase() !== expectedMandateId.toLowerCase()) {
    throw new PolicyMismatchError("mandate does not hash to this client's mandateId");
  }
  if (policyHash(bundle.policy).toLowerCase() !== m.policyHash.toLowerCase()) {
    throw new PolicyMismatchError("policyHash(policy) does not equal mandate.policyHash");
  }
  const payees = bundle.payees.map((p) => getAddress(p));
  if (payeesRoot(payees).toLowerCase() !== m.payeesRoot.toLowerCase()) {
    throw new PolicyMismatchError("payeesRoot(payees) does not equal mandate.payeesRoot");
  }
  return { mandate: m, policy: bundle.policy, payees };
}

export type PreSignContext = {
  now: number; // unix seconds
  policy: VerifiedPolicy;
  asset: Address;
  payee: Address;
  amount: bigint;
  /** Cumulative the voucher would carry for this payee. */
  cumulative: bigint;
  /** Highest known cumulative of every other payee of this mandate (settled plus unsettled), plus in-flight reservations. */
  otherPayeesTotal: bigint;
  /** This agent's accepted spend in the last 24 h plus in-flight reservations. */
  spentLast24h: bigint;
  /** This agent's accepted calls in the last 60 s plus in-flight reservations. */
  callsLastMinute: number;
};

export type PreSignDenial = { code: DenialRule; message: string; details: Record<string, string | number> };

function deny(code: DenialRule, details: Record<string, string | number> = {}): PreSignDenial {
  return { code, message: DENIAL_RULES[code], details: { ...details, enforcedBy: "agent" } };
}

/**
 * The agent's half of "policy is enforced twice": the same rules and codes as the node (SPEC 5.4), evaluated
 * before a voucher is signed, so a refused call never produces a signature anyone could settle.
 */
export function checkBeforeSigning(c: PreSignContext): PreSignDenial | null {
  const { mandate: m, policy: p, payees } = c.policy;
  if (c.now < Number(m.validAfter) || c.now > Number(m.validUntil)) {
    return deny("MANDATE_NOT_ACTIVE", { validAfter: m.validAfter.toString(), validUntil: m.validUntil.toString(), now: c.now });
  }
  if (!isAddressEqual(c.asset, m.token)) return deny("TOKEN_MISMATCH", { asset: c.asset, mandateToken: m.token });
  if (payees.length > 0 && !payees.some((x) => isAddressEqual(x, c.payee))) return deny("PAYEE_NOT_ALLOWED", { payee: c.payee });
  if (c.amount > BigInt(p.perCallCap)) return deny("PER_CALL_CAP", { amount: c.amount.toString(), perCallCap: p.perCallCap });
  if (p.maxCallsPerMinute > 0 && c.callsLastMinute >= p.maxCallsPerMinute) {
    return deny("RATE_LIMIT", { maxCallsPerMinute: p.maxCallsPerMinute, callsLastMinute: c.callsLastMinute });
  }
  if (c.spentLast24h + c.amount > BigInt(p.dailyCap)) {
    return deny("DAILY_CAP", { dailyCap: p.dailyCap, spentLast24h: c.spentLast24h.toString(), amount: c.amount.toString() });
  }
  if (c.otherPayeesTotal + c.cumulative > m.totalCap) {
    return deny("TOTAL_CAP", { totalCap: m.totalCap.toString(), wouldBe: (c.otherPayeesTotal + c.cumulative).toString() });
  }
  return null;
}

/**
 * The extra rule for a split payment (merchant net plus platform fee, GATEWAY.md section 14.2): the vouchers buy one
 * thing, so their combined price is held against the per-call cap. Every other rule applies to each voucher.
 */
export function checkSplitBeforeSigning(c: { policy: VerifiedPolicy; amounts: readonly bigint[] }): PreSignDenial | null {
  const total = c.amounts.reduce((s, a) => s + a, 0n);
  if (total > BigInt(c.policy.policy.perCallCap)) {
    return deny("PER_CALL_CAP", { amount: total.toString(), perCallCap: c.policy.policy.perCallCap, vouchers: c.amounts.length });
  }
  return null;
}
