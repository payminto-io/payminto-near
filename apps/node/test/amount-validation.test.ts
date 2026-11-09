import { describe, expect, it } from "vitest";
import { zAmount, zUint } from "../src/gateway/http.ts";

// A malformed amount is the caller's mistake: it must fail validation (400), never throw (500).
describe("amount validation", () => {
  it.each(["1.00", "abc", "-1", "01", "1e6", " 5", ""])("rejects %j without throwing", (v) => {
    const r = zAmount.safeParse(v);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("base units");
  });

  it("rejects zero as not positive", () => {
    expect(zAmount.safeParse("0").error?.issues[0]?.message).toBe("must be positive");
  });

  it("accepts base units", () => {
    expect(zAmount.parse("1000000")).toBe(1_000_000n);
    expect(zUint.parse("0")).toBe("0");
  });
});
