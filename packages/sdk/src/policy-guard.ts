import {
  DENIAL_RULES,
  REPEAT_WINDOW_SEC,
  budgetIdOf,
  budgetTermsFromJson,
  canonicalPayees,
  policyHash,
  type AccountId,
  type BudgetTerms,
  type BudgetTermsJson,
  type DenialRule,
  type Id32,
  type Network,
  type Policy,
  type RetryHint,
} from "@payminto/protocol";

/** What the agent needs to enforce its own Budget: the terms, which include the allowlist, and the policy they commit to. */
export type BudgetPolicy = { budget: BudgetTerms | BudgetTermsJson; policy: Policy };

export type VerifiedPolicy = { budget: BudgetTerms; policy: Policy; payees: AccountId[] };

export class PolicyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyMismatchError";
  }
}

/**
 * Checks a policy bundle against the Budget id the agent holds. The id is the hash of the terms, which commit to the
 * policy hash and the payee list, so a node (or anyone) serving a looser policy or allowlist is caught here.
 */
export function verifyBudgetPolicy(hub: AccountId, network: Network, expectedBudgetId: Id32, bundle: BudgetPolicy): VerifiedPolicy {
  const terms = typeof bundle.budget.cap === "bigint" ? (bundle.budget as BudgetTerms) : budgetTermsFromJson(bundle.budget as BudgetTermsJson);
  if (budgetIdOf(hub, network, terms) !== expectedBudgetId) {
    throw new PolicyMismatchError("budget terms do not hash to this client's budgetId");
  }
  if (policyHash(bundle.policy) !== terms.policyHash) {
    throw new PolicyMismatchError("policyHash(policy) does not equal budget.policyHash");
  }
  return { budget: terms, policy: bundle.policy, payees: canonicalPayees(terms.payees) };
}

export type PreSignContext = {
  now: number; // unix seconds
  policy: VerifiedPolicy;
  /** The asset the provider asks for. */
  asset: AccountId;
  /** The token the configured node's hub clears. */
  token: AccountId;
  payee: AccountId;
  amount: bigint;
  /** Cumulative the voucher would carry for this payee. */
  cumulative: bigint;
  /** Highest known cumulative of every other payee of this budget (settled plus unsettled), plus in-flight reservations. */
  otherPayeesTotal: bigint;
  /** This agent's accepted spend in the last hour plus in-flight reservations. */
  spentLastHour: bigint;
  /** This agent's accepted spend in the last 24 h plus in-flight reservations. */
  spentLast24h: bigint;
  /** This agent's accepted calls in the last 60 s plus in-flight reservations. */
  callsLastMinute: number;
  /** This agent's accepted calls repeating this request hash in REPEAT_WINDOW_SEC plus in-flight reservations. */
  sameRequestCalls: number;
  /** When each counted call of this request was made (unix seconds, oldest first), for the REPEAT_REQUEST retry hint. */
  sameRequestTimes?: readonly number[];
  /**
   * An empty payee list on the Budget means any payee on chain. The agent pays under such a Budget only when its
   * operator opted in with this setting; otherwise every payee is refused.
   */
  allowAnyPayee?: boolean;
};

/** Agent-side only: the hub clears one token, so a requirement in any other asset cannot be paid by a voucher. */
const TOKEN_MISMATCH = "Requirement asset is not the token this hub clears";

export type PreSignRule = DenialRule | "TOKEN_MISMATCH";
export type PreSignDenial = { code: PreSignRule; message: string; details: Record<string, string | number>; retry: RetryHint };

/** The same retry hints the node gives for the same rules. REPEAT_REQUEST is computed from the call times instead. */
const RETRY: Partial<Record<PreSignRule, RetryHint>> = {
  RATE_LIMIT: { kind: "after", seconds: 60 },
  HOURLY_CAP: { kind: "after", seconds: 3_600 },
  DAILY_CAP: { kind: "after", seconds: 86_400 },
};

function deny(code: PreSignRule, details: Record<string, string | number> = {}, retry?: RetryHint): PreSignDenial {
  return { code, message: code === "TOKEN_MISMATCH" ? TOKEN_MISMATCH : DENIAL_RULES[code], details: { ...details, enforcedBy: "agent" }, retry: retry ?? RETRY[code] ?? { kind: "never" } };
}

/**
 * Seconds until a repeated request fits again: when enough of the counted calls have left the repeat window that the
 * count drops below the limit. Without the call times it is the whole window, which is the longest it can take.
 */
function repeatRetrySeconds(now: number, maxRepeats: number, times: readonly number[] | undefined): number {
  if (!times || times.length < maxRepeats) return REPEAT_WINDOW_SEC;
  const frees = times[times.length - maxRepeats]! + REPEAT_WINDOW_SEC;
  return Math.min(REPEAT_WINDOW_SEC, Math.max(1, frees - now));
}

/**
 * The agent's half of "policy is enforced twice": the same rules, codes and order as the node, evaluated before a
 * voucher is signed, so a refused call never produces a signature anyone could settle.
 */
export function checkBeforeSigning(c: PreSignContext): PreSignDenial | null {
  const { budget: m, policy: p, payees } = c.policy;
  if (BigInt(c.now) * 1000n > m.validUntil) return deny("BUDGET_NOT_ACTIVE", { validUntilMs: m.validUntil.toString(), now: c.now });
  if (c.asset !== c.token) return deny("TOKEN_MISMATCH", { asset: c.asset, token: c.token });
  if (payees.length === 0) {
    // On chain an empty list allows every payee. That is too wide to accept silently: the operator must say so.
    if (!c.allowAnyPayee) return deny("PAYEE_NOT_ALLOWED", { payee: c.payee, allowlist: "empty", optIn: "allowAnyPayee" });
  } else if (!payees.includes(c.payee)) return deny("PAYEE_NOT_ALLOWED", { payee: c.payee });
  if (c.amount > BigInt(p.perCallCap)) return deny("PER_CALL_CAP", { amount: c.amount.toString(), perCallCap: p.perCallCap });
  if (p.maxCallsPerMinute > 0 && c.callsLastMinute >= p.maxCallsPerMinute) {
    return deny("RATE_LIMIT", { maxCallsPerMinute: p.maxCallsPerMinute, callsLastMinute: c.callsLastMinute });
  }
  const maxRepeats = p.maxRepeatsPerRequest ?? 0;
  if (maxRepeats > 0 && c.sameRequestCalls >= maxRepeats) {
    const seconds = repeatRetrySeconds(c.now, maxRepeats, c.sameRequestTimes);
    return deny("REPEAT_REQUEST", { maxRepeatsPerRequest: maxRepeats, sameRequestCalls: c.sameRequestCalls, windowSec: REPEAT_WINDOW_SEC }, { kind: "after", seconds });
  }
  const hourlyCap = BigInt(p.hourlyCap ?? "0");
  if (hourlyCap > 0n && c.spentLastHour + c.amount > hourlyCap) {
    return deny("HOURLY_CAP", { hourlyCap: hourlyCap.toString(), spentLastHour: c.spentLastHour.toString(), amount: c.amount.toString() });
  }
  if (c.spentLast24h + c.amount > BigInt(p.dailyCap)) {
    return deny("DAILY_CAP", { dailyCap: p.dailyCap, spentLast24h: c.spentLast24h.toString(), amount: c.amount.toString() });
  }
  if (c.otherPayeesTotal + c.cumulative > m.cap) {
    return deny("TOTAL_CAP", { cap: m.cap.toString(), wouldBe: (c.otherPayeesTotal + c.cumulative).toString() });
  }
  return null;
}

/**
 * The extra rule for a split payment: the vouchers buy one thing, so their combined price is held against the
 * per-call cap. Every other rule applies to each voucher.
 */
export function checkSplitBeforeSigning(c: { policy: VerifiedPolicy; amounts: readonly bigint[] }): PreSignDenial | null {
  const total = c.amounts.reduce((s, a) => s + a, 0n);
  if (total > BigInt(c.policy.policy.perCallCap)) {
    return deny("PER_CALL_CAP", { amount: total.toString(), perCallCap: c.policy.policy.perCallCap, vouchers: c.amounts.length });
  }
  return null;
}
