import { keccak256, toBytes, type Hex } from "viem";

/**
 * Off-chain policy the clearing node enforces atomically on every call.
 * The on-chain mandate commits to it through policyHash, so the owner can prove which rules were agreed.
 * The total cap, validity window and payee allowlist are additionally enforced on chain.
 */
export type Policy = {
  /** Largest single call price, in token atomic units. */
  perCallCap: string;
  /** Rolling 24h spend limit, in token atomic units. */
  dailyCap: string;
  /** Calls per minute across all payees. 0 disables the limit. */
  maxCallsPerMinute: number;
  /** Human-readable purpose shown to providers and in the audit trail, e.g. "research agent for Q4 market report". */
  purpose: string;
};

/** Canonical JSON: keys sorted, no whitespace. Changing this breaks every existing policyHash. */
export function canonicalPolicy(p: Policy): string {
  const ordered = {
    dailyCap: p.dailyCap,
    maxCallsPerMinute: p.maxCallsPerMinute,
    perCallCap: p.perCallCap,
    purpose: p.purpose,
  };
  return JSON.stringify(ordered);
}

export function policyHash(p: Policy): Hex {
  return keccak256(toBytes(canonicalPolicy(p)));
}

/** Every reason the node can refuse a call. Shown verbatim in the dashboard and returned to agents. */
export const DENIAL_RULES = {
  UNKNOWN_MANDATE: "No open mandate with this id on this node",
  MANDATE_NOT_ACTIVE: "Mandate is not yet valid or has expired",
  MANDATE_REVOKED: "Owner or agent revoked the mandate",
  PAYEE_NOT_ALLOWED: "Payee is not on the mandate allowlist",
  PER_CALL_CAP: "Call price exceeds the per-call cap",
  DAILY_CAP: "Call would exceed the rolling 24h cap",
  TOTAL_CAP: "Call would exceed the mandate total cap",
  RATE_LIMIT: "Too many calls per minute",
  BAD_SIGNATURE: "Voucher is not signed by the mandate agent",
  STALE_CUMULATIVE: "Voucher cumulative does not extend the latest accepted voucher",
  PRICE_MISMATCH: "Voucher amount does not match the provider price",
  INSUFFICIENT_FUNDS: "Agent wallet balance or hub allowance cannot cover outstanding vouchers",
  TOKEN_MISMATCH: "Mandate token differs from the provider settlement token",
  /** Agent-side only: the node reported a position above the highest cumulative this agent has signed. */
  POSITION_UNVERIFIED: "Reported position exceeds what this agent has signed",
} as const;

export type DenialRule = keyof typeof DENIAL_RULES;

/** Rules only the agent applies before signing; the node never returns them. */
export const AGENT_ONLY_RULES = ["POSITION_UNVERIFIED"] as const satisfies readonly DenialRule[];
export type NodeDenialRule = Exclude<DenialRule, (typeof AGENT_ONLY_RULES)[number]>;
