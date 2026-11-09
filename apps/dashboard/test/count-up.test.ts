import { describe, expect, it } from "vitest";
import { easeOut, interpolate, numberTokens } from "@/lib/count-up";

describe("count-up", () => {
  it("finds numbers with their formatting", () => {
    expect(numberTokens("1,234.50 USDC").map((t) => [t.value, t.decimals, t.grouped])).toEqual([[1234.5, 2, true]]);
  });
  it("interpolates and lands exactly on the target text", () => {
    expect(interpolate("1,234.50 USDC", [0], 0)).toBe("0.00 USDC");
    expect(interpolate("1,234.50 USDC", [0], 1)).toBe("1,234.50 USDC");
    expect(interpolate("12 of 40", [10, 20], 0.5)).toBe("11 of 30");
    expect(interpolate("Never", [], 0.5)).toBe("Never");
  });
  it("eases out and clamps", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});
