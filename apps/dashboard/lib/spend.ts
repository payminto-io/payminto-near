import { EXPIRY_GRACE_MS } from "@payminto/protocol";
import { percentOf } from "./format";
import { REVOKE_GRACE_MS } from "./grace";

export type BudgetSplit = {
  /** Percent of the total cap, each clamped so the three always sum to 100. */
  settledPct: number;
  pendingPct: number;
  remainingPct: number;
  usedPct: number;
  tone: "primary" | "warning" | "negative";
};

/** The Budget bar: settled, then accepted-but-unsettled, then what is left of the total cap. */
export function budgetSplit(settled: bigint | string, pending: bigint | string, totalCap: bigint | string): BudgetSplit {
  const settledPct = percentOf(settled, totalCap);
  const pendingPct = Math.min(100 - settledPct, percentOf(pending, totalCap));
  const usedPct = settledPct + pendingPct;
  const remainingPct = Math.max(0, 100 - usedPct);
  return { settledPct, pendingPct, remainingPct, usedPct, tone: usedPct > 90 ? "negative" : usedPct > 75 ? "warning" : "primary" };
}

/**
 * Whole days until a unix time in seconds: positive while valid, 0 on the last day, negative once past.
 * Rounds up so a budget valid for 36 more hours reads "2 days left".
 */
export function daysLeft(validUntilSec: bigint | string | number, nowMs = Date.now()): number {
  const ms = Number(validUntilSec) * 1000 - nowMs;
  return ms >= 0 ? Math.ceil(ms / 86_400_000) : Math.floor(ms / 86_400_000);
}

/** A Budget's `validUntil` (Unix milliseconds on the wire) in the seconds these helpers take. */
export const validUntilSec = (validUntilMs: string): number => Math.floor(Number(validUntilMs) / 1000);

export function describeDaysLeft(days: number): string {
  if (days < 0) return `Expired ${-days} ${-days === 1 ? "day" : "days"} ago`;
  if (days === 0) return "Expires today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/**
 * Time left on a budget, precise where it matters: "45 min left" and "11 h left" inside two days, whole days after that.
 */
export function describeTimeLeft(validUntilSec: bigint | string | number, nowMs = Date.now()): string {
  const ms = Number(validUntilSec) * 1000 - nowMs;
  if (ms <= 0) return describeDaysLeft(daysLeft(validUntilSec, nowMs));
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min left`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h left`;
  return describeDaysLeft(daysLeft(validUntilSec, nowMs));
}

/**
 * When the owner may reclaim escrow: one settlement grace period after a revoke, or after the Budget expires, so Payees
 * can still settle Calls already served. Unix milliseconds; the hub refuses earlier with TOO_EARLY.
 */
export function reclaimAt(b: { validUntil: string | bigint; revokedAt?: string | null }): number {
  if (b.revokedAt) return new Date(b.revokedAt).getTime() + REVOKE_GRACE_MS;
  return Number(BigInt(b.validUntil) + EXPIRY_GRACE_MS);
}

/**
 * What the agent can spend now, when escrow is tighter than the remaining cap. The server refuses a Call once the
 * Budget's unsettled spending plus the Call would pass its escrow (NET_EXPOSURE), so escrow minus what waits to settle
 * is the real limit until a deposit or a settlement. Null when the escrow is unknown or the cap is the tighter limit.
 */
export function spendableNow(m: { escrow?: string | null; spend: { pending: string; remaining: string } }): { atomic: string; why: string } | null {
  if (m.escrow == null) return null;
  const room = BigInt(m.escrow) - BigInt(m.spend.pending);
  const spendable = room > 0n ? room : 0n;
  if (spendable >= BigInt(m.spend.remaining)) return null;
  return { atomic: spendable.toString(), why: "limited by the escrow. Deposit to raise it; settling also frees what is waiting." };
}
