import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  contrastRatio,
  describeFeePlan,
  formatBps,
  groupAddress,
  linkPrice,
  manualPaymentUri,
  normalizeBrandColor,
  parseAmountInput,
  parsePercentToBps,
  refundSignData,
  paymentInTab,
  plainAmount,
  readableOn,
  safeRedirectUrl,
  tabCounts,
} from "@/lib/gateway";

const T = { symbol: "USDC", decimals: 6 };

describe("parseAmountInput", () => {
  it("parses typed amounts into base units without floats", () => {
    expect(parseAmountInput("25")).toEqual({ ok: true, atomic: 25_000_000n });
    expect(parseAmountInput("1,250.5")).toEqual({ ok: true, atomic: 1_250_500_000n });
    expect(parseAmountInput(".5")).toEqual({ ok: true, atomic: 500_000n });
    expect(parseAmountInput("0.000001")).toEqual({ ok: true, atomic: 1n });
  });
  it("refuses what a token cannot represent", () => {
    expect(parseAmountInput("").ok).toBe(false);
    expect(parseAmountInput("abc").ok).toBe(false);
    expect(parseAmountInput("1.2.3").ok).toBe(false);
    expect(parseAmountInput("0")).toEqual({ ok: false, error: "The amount must be more than zero." });
    expect(parseAmountInput("0.0000001")).toEqual({ ok: false, error: "At most 6 decimal places." });
  });
  it("applies inclusive bounds", () => {
    expect(parseAmountInput("0.5", 6, { min: 1_000_000n })).toEqual({ ok: false, error: "The minimum is 1.00." });
    expect(parseAmountInput("501", 6, { max: 500_000_000n })).toEqual({ ok: false, error: "The maximum is 500.00." });
    expect(parseAmountInput("500", 6, { max: 500_000_000n }).ok).toBe(true);
  });
});

describe("plainAmount", () => {
  it("is the exact paste-able amount with no grouping", () => {
    expect(plainAmount(25_000_000n)).toBe("25.00");
    expect(plainAmount("1234500000")).toBe("1234.50");
    expect(plainAmount(125_000n)).toBe("0.125");
  });
});

describe("manualPaymentUri (EIP-681)", () => {
  it("encodes token, chain, recipient and the remaining amount, checksummed", () => {
    const uri = manualPaymentUri({
      token: { address: "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6", symbol: "USDC", decimals: 6 },
      chain_id: 133,
      deposit_address: "0x00000000000000000000000000000000000000a1",
      amount_remaining: "5000000",
    });
    expect(uri).toBe(`ethereum:${getAddress("0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6")}@133/transfer?address=${getAddress("0x00000000000000000000000000000000000000a1")}&uint256=5000000`);
  });
});

describe("brand colour", () => {
  it("normalises hex and rejects anything else", () => {
    expect(normalizeBrandColor("#0F766E")).toBe("#0f766e");
    expect(normalizeBrandColor("abc")).toBe("#aabbcc");
    expect(normalizeBrandColor("red")).toBeNull();
    expect(normalizeBrandColor("url(javascript:1)")).toBeNull();
  });
  it("picks the readable text colour for a filled button", () => {
    expect(readableOn("#0f766e")).toBe("#ffffff");
    expect(readableOn("#fde047")).toBe("#0e1726");
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
});

describe("payment tabs", () => {
  it("maps statuses to tabs and counts them", () => {
    expect(paymentInTab({ status: "overpaid", refund_status: "none" }, "paid")).toBe(true);
    expect(paymentInTab({ status: "partially_paid", refund_status: "none" }, "pending")).toBe(true);
    expect(paymentInTab({ status: "paid", refund_status: "partial" }, "refunded")).toBe(true);
    expect(paymentInTab({ status: "canceled", refund_status: "none" }, "expired")).toBe(true);
    expect(tabCounts({ paid: 3, overpaid: 1, open: 2, processing: 1, underpaid: 1, expired: 4, canceled: 1, refunded: 2 })).toEqual({
      all: 13,
      paid: 4,
      pending: 3,
      underpaid: 1,
      expired: 5,
      refunded: 2,
    });
  });
});

describe("safeRedirectUrl", () => {
  it("only follows http(s)", () => {
    expect(safeRedirectUrl("https://acme.example/thanks")).toBe("https://acme.example/thanks");
    expect(safeRedirectUrl("javascript:alert(1)")).toBeNull();
    expect(safeRedirectUrl("data:text/html,hi")).toBeNull();
    expect(safeRedirectUrl("not a url")).toBeNull();
    expect(safeRedirectUrl(null)).toBeNull();
  });
});

describe("fees and prices", () => {
  it("formats basis points and parses percentages", () => {
    expect(formatBps(50)).toBe("0.5%");
    expect(formatBps(125)).toBe("1.25%");
    expect(formatBps(0)).toBe("0%");
    expect(parsePercentToBps("0.5")).toBe(50);
    expect(parsePercentToBps("10")).toBe(1000);
    expect(parsePercentToBps("10.01")).toBeNull();
    expect(parsePercentToBps("0.555")).toBeNull();
  });
  it("describes a plan in one sentence", () => {
    expect(describeFeePlan({ platform_fee_bps: 25, platform_fee_fixed: "0", min_fee: "50000", max_fee: "5000000" }, T)).toBe("0.25%, at least 0.05 USDC, at most 5.00 USDC");
    expect(describeFeePlan({ platform_fee_bps: 0, platform_fee_fixed: "100000" }, T)).toBe("0.10 USDC");
  });
  it("prices links", () => {
    expect(linkPrice({ amount: "25000000" }, T)).toBe("25.00 USDC");
    expect(linkPrice({ amount: null, min_amount: "1000000", max_amount: "500000000" }, T)).toBe("Customer chooses, 1.00 to 500.00 USDC");
  });
  it("groups an address in fours for comparison", () => {
    expect(groupAddress("0x00000000000000000000000000000000000000a1")).toEqual(["0x", "0000", "0000", "0000", "0000", "0000", "0000", "0000", "0000", "0000", "00a1"]);
  });
});

describe("refundSignData token domain", () => {
  const base = {
    router: getAddress("0x1e0f2223D61BF9831fa0b009AE741c3F5E898F0e"),
    refundId: "rf_1",
    from: getAddress("0x00000000000000000000000000000000000000a1"),
    to: getAddress("0x00000000000000000000000000000000000000b2"),
    amount: 1_000n,
    nowSec: 1_800_000_000,
  };

  it("uses chains.ts for the chain's own token", () => {
    const { typedData } = refundSignData({ ...base, chainId: 11155111, token: getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") });
    expect(typedData.domain).toMatchObject({ name: "USDC", version: "2", chainId: 11155111 });
  });

  it("uses the node's domain for a deployment's own test token", () => {
    const { typedData } = refundSignData({ ...base, chainId: 133, token: getAddress("0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15"), eip712: { name: "Payminto Test USDC", version: "1" } });
    expect(typedData.domain).toMatchObject({ name: "Payminto Test USDC", version: "1" });
  });

  it("refuses to guess a test token's domain before the node has sent it", () => {
    expect(() => refundSignData({ ...base, chainId: 133, token: getAddress("0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15") })).toThrow(/signing details/);
  });
});
