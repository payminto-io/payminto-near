/**
 * The settlement grace period after an owner revokes a Budget: how long Payees can still settle Calls already served,
 * and how long the owner waits before reclaiming escrow. Every screen reads it from here, in time math and in words.
 *
 * It follows the chain package, which mirrors the contract. To pin another value in the dashboard alone, replace the
 * right-hand side of the one line below.
 */
import { REVOKE_GRACE_MS as HUB_REVOKE_GRACE_MS } from "@payminto/protocol";

export const REVOKE_GRACE_MS: number = Number(HUB_REVOKE_GRACE_MS);

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The period as a count and a unit: whole hours when it is whole hours, minutes otherwise. */
function parts(ms: number): { n: number; unit: "hour" | "minute" } {
  return ms % HOUR_MS === 0 ? { n: ms / HOUR_MS, unit: "hour" } : { n: Math.round(ms / MINUTE_MS), unit: "minute" };
}

/** "1 hour", "24 hours": for "for 1 hour after it was stopped". */
export function graceDuration(ms: number = REVOKE_GRACE_MS): string {
  const { n, unit } = parts(ms);
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "1-hour", "24-hour": for "after a 1-hour grace period". */
export function graceAdjective(ms: number = REVOKE_GRACE_MS): string {
  const { n, unit } = parts(ms);
  return `${n}-${unit}`;
}
