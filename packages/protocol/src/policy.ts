import { sha256Text, verifyDigest, type AccountId, type Id32, type Network, type PublicKey, type Sig64 } from "@payminto/chain";

/**
 * Off-chain policy the clearing node enforces atomically on every call.
 * The on-chain Budget commits to it through policyHash, so the owner can prove which rules were agreed.
 * The cap, validity window and payee allowlist are additionally enforced on chain.
 */
export type Policy = {
  /** Largest single call price, in token atomic units. */
  perCallCap: string;
  /** Rolling 24h spend limit, in token atomic units. */
  dailyCap: string;
  /** Rolling one-hour spend limit, in token atomic units. "0" or absent disables it. */
  hourlyCap?: string;
  /** Calls per minute across all payees. 0 disables the limit. */
  maxCallsPerMinute: number;
  /** How many accepted calls may repeat one request hash within REPEAT_WINDOW_SEC. 0 or absent disables it. */
  maxRepeatsPerRequest?: number;
  /** Human-readable purpose shown to providers and in the audit trail, e.g. "research agent for Q4 market report". */
  purpose: string;
};

/** Window of the same-request repeat limit. An agent stuck in a loop hits it within minutes. */
export const REPEAT_WINDOW_SEC = 3_600;

/** Canonical JSON: keys sorted, no whitespace, optional fields filled. Changing this breaks every existing policyHash. */
export function canonicalPolicy(p: Policy): string {
  const ordered = {
    dailyCap: p.dailyCap,
    hourlyCap: p.hourlyCap ?? "0",
    maxCallsPerMinute: p.maxCallsPerMinute,
    maxRepeatsPerRequest: p.maxRepeatsPerRequest ?? 0,
    perCallCap: p.perCallCap,
    purpose: p.purpose,
  };
  return JSON.stringify(ordered);
}

export const policyHash = (p: Policy): Id32 => sha256Text(canonicalPolicy(p));

/** Every reason the node can refuse a call. Shown verbatim in the dashboard and returned to agents. */
export const DENIAL_RULES = {
  UNKNOWN_BUDGET: "No open Budget with this id on this node",
  BUDGET_NOT_ACTIVE: "Budget is not yet valid or has expired",
  BUDGET_REVOKED: "The owner revoked the Budget",
  PAYEE_NOT_ALLOWED: "Payee is not on the Budget allowlist",
  PER_CALL_CAP: "Call price exceeds the per-call cap",
  DAILY_CAP: "Call would exceed the rolling 24h cap",
  HOURLY_CAP: "Call would exceed the rolling one-hour cap",
  TOTAL_CAP: "Call would exceed the Budget cap",
  RATE_LIMIT: "Too many calls per minute",
  REPEAT_REQUEST: "This exact request has been paid for too many times",
  BAD_SIGNATURE: "Voucher is not signed by the Budget agent",
  STALE_CUMULATIVE: "Voucher cumulative does not extend the latest accepted voucher",
  PRICE_MISMATCH: "Voucher amount does not match the provider price",
  NET_EXPOSURE: "Unsettled spending of this Budget would exceed its escrow",
  /**
   * A node limit, not a Budget rule: the first payment from a Budget to a payee is below the node's NEW_PAYEE_MIN_AMOUNT.
   * Its settlement would make the node's settler pay permanent hub storage for the new (Budget, payee) pair.
   */
  NEW_PAYEE_MIN_AMOUNT: "A first payment to a payee new to this Budget is below this node's minimum",
  /** A node limit, not a Budget rule: this Budget already paid NEW_PAYEES_PER_HOUR payees for the first time in the last hour. */
  NEW_PAYEE_RATE: "This Budget has paid too many new payees in the last hour",
  /** The payee check judged the payee as block (a missing account, a lookalike of an allowed payee, several reports), or the owner denied it. */
  PAYEE_BLOCKED: "The payee check blocks this payee, so nothing is paid to it",
  /** The payee check judged the payee as warn and the Budget's owner has not approved it. */
  PAYEE_NEEDS_APPROVAL: "The payee check has warnings about this payee, so the Budget's owner must approve it first",
  /** Agent-side only: the node reported a position above the highest cumulative this agent has signed. */
  POSITION_UNVERIFIED: "Reported position exceeds what this agent has signed",
} as const;

export type DenialRule = keyof typeof DENIAL_RULES;

/** Rules only the agent applies before signing; the node never returns them. */
export const AGENT_ONLY_RULES = ["POSITION_UNVERIFIED"] as const satisfies readonly DenialRule[];
export type NodeDenialRule = Exclude<DenialRule, (typeof AGENT_ONLY_RULES)[number]>;

/**
 * Rules the payee check decides, before the Budget's own rules run. They need a look at the chain, so they are not
 * part of the pure policy engine (`evaluateVoucher`). An agent's wallet applies the same two before it signs.
 */
export const PAYEE_CHECK_RULES = ["PAYEE_BLOCKED", "PAYEE_NEEDS_APPROVAL"] as const satisfies readonly DenialRule[];
export type PayeeCheckRule = (typeof PAYEE_CHECK_RULES)[number];

/**
 * The message of a NET_EXPOSURE refusal given because the node could not read the Budget's escrow from the hub. The
 * node fails closed: it never decides on a snapshot older than its maximum age. Nothing is wrong with the Budget.
 */
export const HUB_UNREADABLE_MESSAGE = "The node could not read this Budget's escrow from the hub, so it refuses until it can; retry shortly";

/** Why an `after` hint is not about a rolling window. `hub_unreadable`: see HUB_UNREADABLE_MESSAGE. */
export type RetryReason = "hub_unreadable";

/**
 * What an automated client should do about a refusal. A separate shape from the rule name so that an agent loop can act
 * on it without parsing English:
 * - `never`: changing timing will not help.
 * - `after`: the same call can succeed once `seconds` have passed. For a rolling limit, `seconds` is the time until
 *   enough counted calls leave the window, assuming no other call is accepted meanwhile. `reason` is set when the wait
 *   is not for a window.
 * - `after_settlement`: retry after the next batch confirms; settling what this Budget owes then leaves room for the call.
 * - `fund`: retry after `shortBy` atomic units are added to escrow. When the owner holds withdrawable credit on the
 *   hub, `fromCredit` names the owner wallet action that moves it into this Budget's escrow without a token transfer.
 * - `resign`: sign a new voucher with `expectedCumulative`.
 * - `approval`: the same call can succeed once the Budget's owner has approved `payee`. Waiting does not help, and an
 *   agent cannot approve it. `approveAt` is the page of the node's own dashboard where the owner decides. It is for
 *   the owner to open: it is never an address for an agent to call, fetch or pay.
 */
export type RetryHint =
  | { kind: "never" }
  | { kind: "after"; seconds: number; reason?: RetryReason }
  | { kind: "after_settlement" }
  | { kind: "fund"; shortBy: string; fromCredit?: CreditFunding }
  | { kind: "resign"; expectedCumulative: string }
  | { kind: "approval"; payee: AccountId; approveAt: string };

/** Longest `approveAt` an approval hint may carry. */
export const APPROVE_AT_MAX = 300;

/**
 * The hub's owner wallet action `fund_from_credit({ budget_id, amount })`, which moves the owner's withdrawable credit
 * into a Budget's escrow. Credit never counts toward the exposure limit by itself, because the hub debits only escrow
 * at settlement.
 */
export type CreditFunding = {
  action: "fund_from_credit";
  budgetId: Id32;
  /** What the owner's credit can cover now: the smaller of the shortfall and the credit, atomic units. */
  amount: string;
  /** The owner's whole withdrawable credit, atomic units. */
  credit: string;
};

/** Machine-readable refusal, returned to the agent and recorded with the denial. */
export type Refusal = {
  rule: DenialRule;
  message: string;
  /**
   * The price of the refused call, atomic units as a decimal string. For a request paid with several vouchers (a
   * payment split between a merchant and a platform fee) this is the total of the request, which is what the caps see.
   */
  attemptedAmount: string;
  /** Remaining Budget under its cap, or null when the Budget is unknown. */
  remainingBudget: string | null;
  retry: RetryHint;
};

// ------------------------------------------------------------------------------------------------- signed refusals

/**
 * A refusal as the node recorded it. An agent hears about a refusal from the seller it called, and a seller can say
 * anything, so the node keeps its own record of every refusal of a voucher the agent signed and signs it with its
 * receipt key (`nodeKey` in `GET /v1/info`). The agent reads it from its own node with
 * `GET /v1/budgets/:id/refusals?requestHash=...`, and the same signature travels with the 402 in
 * `error.details.record`. The node keeps no record of a voucher the Budget's agent key did not sign.
 */
export type RefusalRecord = {
  /** The node's id of the refusal (`dny_...`). */
  id: string;
  budgetId: Id32;
  payee: AccountId;
  /** The refused voucher's own amount and cumulative, atomic units as decimal strings. */
  amount: string;
  cumulative: string;
  requestHash: Id32;
  /** Unix seconds when the node first refused it. */
  timestamp: number;
  refusal: Refusal;
};

/** Domain of `refusalDigest`. Different from the acceptance domain, so a refusal signature is never a receipt. */
export const REFUSAL_DOMAIN = "payminto.refused.v1";

/**
 * The part of a retry hint the signature covers: its kind and its one number (`seconds`, `shortBy` or
 * `expectedCumulative`), as text. `reason`, `fromCredit` and the fields of an `approval` hint are advice on top and are
 * not covered: the record already names the payee, and `approveAt` only says where the owner goes.
 */
function retryFields(h: RetryHint): [string, string] {
  switch (h.kind) {
    case "after":
      return [h.kind, String(h.seconds)];
    case "fund":
      return [h.kind, h.shortBy];
    case "resign":
      return [h.kind, h.expectedCumulative];
    default:
      return [h.kind, ""];
  }
}

/**
 * What the node signs for a refusal: SHA-256 of the UTF-8 text of these fields joined by "|", in this order:
 *
 *   "payminto.refused.v1" | hub | network | id | budgetId | payee | amount | cumulative | requestHash | rule |
 *   attemptedAmount | remainingBudget (empty when null) | retry kind | retry value (empty when the kind has none) | timestamp
 *
 * No field may contain "|" (this throws if one does, so shifted fields can never reproduce a signed text). The hub and
 * network bind the record to one deployment. The signature is ed25519 over the 32 digest bytes, by the same key that
 * signs acceptance receipts; the first field keeps the two apart (`nodeDigest` starts with "payminto.accepted.v1").
 */
export function refusalDigest(hub: AccountId, network: Network, r: RefusalRecord): Id32 {
  const [retryKind, retryValue] = retryFields(r.refusal.retry);
  const fields = [
    REFUSAL_DOMAIN,
    hub,
    network,
    r.id,
    r.budgetId,
    r.payee,
    r.amount,
    r.cumulative,
    r.requestHash,
    r.refusal.rule,
    r.refusal.attemptedAmount,
    r.refusal.remainingBudget ?? "",
    retryKind,
    retryValue,
    String(r.timestamp),
  ];
  if (fields.some((f) => typeof f !== "string" || f.includes("|"))) throw new Error("a refusal record field is not text or contains the separator");
  return sha256Text(fields.join("|"));
}

/** True when `signature` is the node key's signature over this refusal record for this hub and network. */
export function refusalSignedBy(hub: AccountId, network: Network, r: RefusalRecord, signature: Sig64, nodeKey: PublicKey): boolean {
  try {
    return verifyDigest(nodeKey, refusalDigest(hub, network, r), signature);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------- payee approvals

/** Domain of `payeeApprovalRequestDigest`. No voucher, receipt or refusal digest starts with it. */
export const PAYEE_APPROVAL_REQUEST_DOMAIN = "payminto.payee-approval-request.v1";

/** What an agent's wallet asks its node when its own payee check says warn: has the owner approved this payee? */
export type PayeeApprovalRequest = {
  budgetId: Id32;
  payee: AccountId;
  /** The price of the call that is waiting, atomic units as a decimal string. It is shown to the owner. */
  amount: string;
};

/**
 * What the Budget's agent key signs to ask its node about an approval (`POST /v1/budgets/:id/payee-approvals/requests`):
 * SHA-256 of the UTF-8 text `"payminto.payee-approval-request.v1" | hub | network | budgetId | payee | amount`.
 * The signature shows the question comes from the Budget's own agent, so nobody else can put requests in front of the
 * owner. It approves nothing: only an owner session or the operator can approve a payee. A replay asks the same
 * question again, which changes nothing.
 */
export function payeeApprovalRequestDigest(hub: AccountId, network: Network, r: PayeeApprovalRequest): Id32 {
  const fields = [PAYEE_APPROVAL_REQUEST_DOMAIN, hub, network, r.budgetId, r.payee, r.amount];
  if (fields.some((f) => typeof f !== "string" || f.includes("|"))) throw new Error("a payee approval request field is not text or contains the separator");
  return sha256Text(fields.join("|"));
}
