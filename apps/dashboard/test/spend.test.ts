import { describe, expect, it } from "vitest";
import { budgetSplit, daysLeft, describeDaysLeft, describeTimeLeft } from "@/lib/spend";

describe("budgetSplit", () => {
  it("splits the cap into settled, pending and remaining", () => {
    const s = budgetSplit("250000", "50000", "1000000");
    expect(s.settledPct).toBe(25);
    expect(s.pendingPct).toBe(5);
    expect(s.remainingPct).toBe(70);
    expect(s.usedPct).toBe(30);
    expect(s.tone).toBe("primary");
  });

  it("never lets the segments exceed 100 percent and flags a nearly spent budget", () => {
    const s = budgetSplit("950000", "200000", "1000000");
    expect(s.settledPct + s.pendingPct + s.remainingPct).toBe(100);
    expect(s.remainingPct).toBe(0);
    expect(s.tone).toBe("negative");
    expect(budgetSplit("800000", "0", "1000000").tone).toBe("warning");
  });

  it("treats a zero cap as nothing used", () => {
    expect(budgetSplit("0", "0", "0")).toMatchObject({ usedPct: 0, remainingPct: 100 });
  });
});

describe("daysLeft", () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  const sec = (ms: number) => Math.floor(ms / 1000);
  it("rounds partial days up while valid", () => {
    expect(daysLeft(sec(now + 36 * 3_600_000), now)).toBe(2);
    expect(daysLeft(sec(now + 3_600_000), now)).toBe(1);
  });
  it("goes negative once expired", () => {
    expect(daysLeft(sec(now - 30 * 3_600_000), now)).toBe(-2);
  });
  it("describes the result in words", () => {
    expect(describeDaysLeft(2)).toBe("2 days left");
    expect(describeDaysLeft(1)).toBe("1 day left");
    expect(describeDaysLeft(0)).toBe("Expires today");
    expect(describeDaysLeft(-1)).toBe("Expired 1 day ago");
  });
});

describe("describeTimeLeft", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  it("is precise inside two days and whole days after that", () => {
    expect(describeTimeLeft(now / 1000 + 45 * 60, now)).toBe("45 min left");
    expect(describeTimeLeft(now / 1000 + 12 * 3600 - 30, now)).toBe("11 h left");
    expect(describeTimeLeft(now / 1000 + 5 * 86_400, now)).toBe("5 days left");
    expect(describeTimeLeft(now / 1000 - 10, now)).toBe("Expired 1 day ago");
  });
});
