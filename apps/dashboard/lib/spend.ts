import { percentOf } from "./format";

export type BudgetSplit = {
  /** Percent of the total cap, each clamped so the three always sum to 100. */
  settledPct: number;
  pendingPct: number;
  remainingPct: number;
  usedPct: number;
  tone: "primary" | "warning" | "negative";
};

/** The mandate budget bar: settled, then accepted-but-unsettled, then what is left of the total cap. */
export function budgetSplit(settled: bigint | string, pending: bigint | string, totalCap: bigint | string): BudgetSplit {
  const settledPct = percentOf(settled, totalCap);
  const pendingPct = Math.min(100 - settledPct, percentOf(pending, totalCap));
  const usedPct = settledPct + pendingPct;
  const remainingPct = Math.max(0, 100 - usedPct);
  return { settledPct, pendingPct, remainingPct, usedPct, tone: usedPct > 90 ? "negative" : usedPct > 75 ? "warning" : "primary" };
}

/**
 * Whole days until a unix time in seconds: positive while valid, 0 on the last day, negative once past.
 * Rounds up so a mandate valid for 36 more hours reads "2 days left".
 */
export function daysLeft(validUntilSec: bigint | string | number, nowMs = Date.now()): number {
  const ms = Number(validUntilSec) * 1000 - nowMs;
  return ms >= 0 ? Math.ceil(ms / 86_400_000) : Math.floor(ms / 86_400_000);
}

export function describeDaysLeft(days: number): string {
  if (days < 0) return `Expired ${-days} ${-days === 1 ? "day" : "days"} ago`;
  if (days === 0) return "Expires today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/**
 * Time left on a mandate, precise where it matters: "45 min left" and "11 h left" inside two days, whole days after that.
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
