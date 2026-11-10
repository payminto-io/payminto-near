import { describe, expect, it } from "vitest";
import { REVOKE_GRACE_MS as HUB_REVOKE_GRACE_MS } from "@payminto/protocol";
import { REVOKE_GRACE_MS, graceAdjective, graceDuration } from "@/lib/grace";
import { reclaimAt } from "@/lib/spend";

describe("revoke grace period", () => {
  it("is read from the chain package, in one place", () => {
    expect(REVOKE_GRACE_MS).toBe(Number(HUB_REVOKE_GRACE_MS));
  });

  it("puts the same period into the reclaim time and into the words", () => {
    const revokedAt = "2026-11-10T10:00:00.000Z";
    expect(reclaimAt({ validUntil: "0", revokedAt })).toBe(new Date(revokedAt).getTime() + REVOKE_GRACE_MS);
    expect(graceDuration()).toBe(graceDuration(REVOKE_GRACE_MS));
  });

  it("says the period in words for any value, so switching the constant changes every screen", () => {
    expect(graceDuration(3_600_000)).toBe("1 hour");
    expect(graceAdjective(3_600_000)).toBe("1-hour");
    expect(graceDuration(24 * 3_600_000)).toBe("24 hours");
    expect(graceAdjective(24 * 3_600_000)).toBe("24-hour");
    expect(graceDuration(30 * 60_000)).toBe("30 minutes");
  });
});
