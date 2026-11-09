import { describe, expect, it } from "vitest";
import { bucketCalls } from "@/lib/calls-chart";

const at = (ms: number) => ({ createdAt: new Date(ms).toISOString(), amount: "1000" });

describe("bucketCalls", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  it("uses 5-second bars for a burst that started a minute ago, starting one bar before the first call", () => {
    const items = [at(now - 60_000), at(now - 59_000), at(now - 1_000)];
    const r = bucketCalls(items, now);
    expect(r.unit).toBe("5 seconds");
    expect(r.hourly).toBe(false);
    expect(r.bars[0]!.calls).toBe(0);
    expect(r.bars.reduce((a, b) => a + b.calls, 0)).toBe(3);
    expect(r.bars.length).toBeLessThanOrEqual(30);
  });
  it("falls back to hourly bars over 12 hours for a long-running node", () => {
    const r = bucketCalls([at(now - 30 * 3_600_000), at(now + 1000)], now + 30 * 60_000);
    expect(r.hourly).toBe(true);
    expect(r.bars).toHaveLength(12);
    expect(r.bars.at(-1)!.calls).toBe(1);
  });
});
