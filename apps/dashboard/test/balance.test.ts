import { describe, expect, it } from "vitest";
import { balanceFromPayouts, balanceTotals } from "@/lib/balance";
import { merchantBalanceSchema, type MerchantBalance } from "@/lib/platform-schemas";
import type { Payouts } from "@/lib/schemas";

const SHOP = "shop.testnet";
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const item = (account: string, paid: string, outcome: "pending" | "paid" | "kept" = "paid") => ({ account, creditBefore: paid === "0" ? "400000" : paid, creditAfter: outcome === "paid" ? "0" : null, paid, outcome });

const payouts: Payouts = {
  accounts: [{ account: SHOP, status: "due", credit: "400000", paidTotal: "3200000", attempts: 0, nextAttemptAt: null, lastError: null, checkedAt: iso(0) }],
  payouts: [
    { seq: 1, status: "confirmed", trigger: "interval", txHash: "OldTx", explorerUrl: null, error: null, createdAt: iso(45), finishedAt: iso(45), items: [item(SHOP, "700000")] },
    { seq: 2, status: "confirmed", trigger: "manual", txHash: "NewTx", explorerUrl: "https://x/txns/NewTx", error: null, createdAt: iso(2), finishedAt: iso(2), items: [item(SHOP, "2500000"), item("other.testnet", "9")] },
    { seq: 3, status: "submitted", trigger: "manual", txHash: null, explorerUrl: null, error: null, createdAt: iso(0), finishedAt: null, items: [item(SHOP, "0", "pending")] },
    { seq: 4, status: "confirmed", trigger: "interval", txHash: "Theirs", explorerUrl: null, error: null, createdAt: iso(1), finishedAt: iso(1), items: [item("other.testnet", "5")] },
  ],
};

describe("balanceFromPayouts (the demo's Balance)", () => {
  it("keeps to the business's payout account and sums the last 30 days", () => {
    const b = balanceFromPayouts("mer_a", SHOP, "near:testnet", payouts, NOW);
    expect(merchantBalanceSchema.parse(b)).toEqual(b);
    expect(b).toMatchObject({ payout: SHOP, credit: "400000", status: "due", in_flight: "400000", paid_30d: "2500000", paid_total: "3200000" });
    expect(b.payouts.map((p) => [p.seq, p.amount, p.tx_hash])).toEqual([
      [3, "0", null],
      [2, "2500000", "NewTx"],
      [1, "700000", "OldTx"],
    ]);
  });
  it("is empty for a business without a payout account", () => {
    expect(balanceFromPayouts("mer_a", null, "near:testnet", payouts, NOW)).toMatchObject({ status: "none", credit: "0", in_flight: "0", paid_30d: "0", payouts: [] });
  });
});

describe("balanceTotals", () => {
  const base = balanceFromPayouts("mer_a", SHOP, "near:testnet", { ...payouts, payouts: payouts.payouts.filter((p) => p.seq !== 3) }, NOW);
  const withFlight: MerchantBalance = { ...base, in_flight: "400000" };

  it("takes the hub's own credit when this browser read it", () => {
    expect(balanceTotals(base, "1250000")).toEqual({ waiting: "1250000", inFlight: "0", paid30d: "2500000", source: "hub" });
  });
  it("falls back to the server's last read without one", () => {
    expect(balanceTotals(base, null)).toEqual({ waiting: "400000", inFlight: "0", paid30d: "2500000", source: "server" });
  });
  it("never counts a payout in flight as waiting too", () => {
    // The server's copy still holds the credit it is paying out; the hub zeroed it when the payout started.
    expect(balanceTotals(withFlight, null).waiting).toBe("0");
    expect(balanceTotals({ ...withFlight, credit: "900000" }, null).waiting).toBe("500000");
    expect(balanceTotals(withFlight, "0")).toMatchObject({ waiting: "0", inFlight: "400000", source: "hub" });
  });
});
