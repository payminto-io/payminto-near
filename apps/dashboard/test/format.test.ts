import { describe, expect, it } from "vitest";
import { formatMoney, formatRatio, formatToken, percentOf, shortAddress, shortHash, splitLedgerAccount } from "@/lib/format";

describe("splitLedgerAccount", () => {
  it("keeps an account that contains a colon whole", () => {
    expect(splitLedgerAccount("owner:acme.testnet:payable")).toEqual({ role: "owner", addr: "acme.testnet", kind: "payable" });
    expect(splitLedgerAccount("agent:ed25519:AbC:payable")).toEqual({ role: "agent", addr: "ed25519:AbC", kind: "payable" });
  });
});

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

  it("never rounds: every significant decimal shows", () => {
    expect(formatMoney("2994517", 6)).toBe("2.994517");
    expect(formatMoney("1999999", 6)).toBe("1.999999");
  });

  it("handles negative balances", () => {
    expect(formatMoney("-570000", 6)).toBe("-0.57");
    expect(formatMoney("-1234567", 6)).toBe("-1.234567");
  });

  it("always attaches the unit", () => {
    expect(formatToken("50000", "USDC", 6)).toBe("0.05 USDC");
    expect(formatToken("1500000000000000000000000", "NEAR", 24)).toBe("1.50 NEAR");
  });
});

describe("addresses and hashes", () => {
  const a = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
  it("truncates the middle of a long id and keeps the last 8 characters", () => {
    expect(shortAddress(a)).toBe("3e2210e118…4afcb8af");
    expect(shortAddress("research-writer.testnet")).toBe("research-writer.testnet");
    expect(shortHash("ab".repeat(32))).toBe("ababababab…ababab");
  });
  it("leaves short strings alone", () => {
    expect(shortAddress("acme.near")).toBe("acme.near");
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

