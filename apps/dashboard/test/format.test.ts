import { describe, expect, it } from "vitest";
import { formatMoney, formatNative, formatRatio, formatToken, percentOf, shortAddress, shortHash } from "@/lib/format";
import { batchStatusSchema } from "@/lib/schemas";

describe("formatMoney", () => {
  it("keeps exact precision from atomic units without floats", () => {
    expect(formatMoney("2000", 6)).toBe("0.002");
    expect(formatMoney("1234567", 6)).toBe("1.234567");
    expect(formatMoney(9_007_199_254_740_993n, 6)).toBe("9,007,199,254.740993");
  });

  it("pads to two decimals and groups thousands", () => {
    expect(formatMoney("0", 6)).toBe("0.00");
    expect(formatMoney("1234560000", 6)).toBe("1,234.56");
    expect(formatMoney("1000000000000", 6)).toBe("1,000,000.00");
  });

  it("rounds half up to a maximum fraction", () => {
    expect(formatMoney("1234567", 6, { maxFraction: 4 })).toBe("1.2346");
    expect(formatMoney("1999999", 6, { maxFraction: 2 })).toBe("2.00");
    expect(formatMoney("2000", 6, { maxFraction: 4 })).toBe("0.002");
  });

  it("handles negative balances", () => {
    expect(formatMoney("-570000", 6)).toBe("-0.57");
    expect(formatMoney("-1234567", 6, { maxFraction: 2 })).toBe("-1.23");
  });

  it("always attaches the unit", () => {
    expect(formatToken("50000", "USDC", 6)).toBe("0.05 USDC");
    expect(formatToken("1500000000000000000", "HSK", 18)).toBe("1.50 HSK");
  });
});

describe("addresses and hashes", () => {
  const a = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
  it("truncates while keeping checksum casing", () => {
    expect(shortAddress(a)).toBe("0x8FE3…53c6");
    expect(shortHash(`0x${"ab".repeat(32)}`)).toBe("0xabababab…ababab");
  });
  it("leaves short strings alone", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
    expect(shortAddress("")).toBe("");
  });
});

describe("ratios", () => {
  it("formats compression and percentages", () => {
    expect(formatRatio(34.5)).toBe("34.5");
    expect(formatRatio(49)).toBe("49");
    expect(formatRatio(1234.4)).toBe("1,234");
    expect(formatRatio(0)).toBe("0");
    expect(percentOf("250", "1000")).toBe(25);
    expect(percentOf("2000", "1000")).toBe(100);
    expect(percentOf("1", "0")).toBe(0);
  });
});

describe("finality and L1 fee", () => {
  it("formats an L1 data fee in HSK with three significant digits", () => {
    expect(formatNative("1180000000000000")).toBe("0.00118 HSK");
    expect(formatNative(10n ** 18n)).toBe("1 HSK");
    expect(formatNative("0")).toBe("0 HSK");
  });

  it("accepts the included batch status the node reports between one confirmation and the safe head", () => {
    expect(batchStatusSchema.parse("included")).toBe("included");
  });
});
