import { describe, expect, it } from "vitest";
import { escrowFull, escrowShort, networkInWords, testMoneyLabel } from "@/lib/disclosures";
import { payoutRows } from "@/lib/use-hub-credits";
import { budgetDetailSchema, type PayoutAccount } from "@/lib/schemas";

describe("custody wording names the network the server runs on", () => {
  it("says sandbox, testnet or mainnet, and never assumes testnet", () => {
    expect(escrowShort("near:sandbox")).toBe("Funds are escrowed in an unaudited contract on a local NEAR sandbox");
    expect(escrowShort("near:testnet")).toBe("Funds are escrowed in an unaudited contract on NEAR testnet");
    expect(escrowShort(null)).toBe("Funds are escrowed in an unaudited contract on NEAR");
    expect(escrowFull("near:sandbox")).toContain("local NEAR sandbox");
    expect(escrowFull("near:mainnet")).not.toContain("testnet");
    expect(networkInWords("near:mainnet")).toBe("NEAR mainnet");
    for (const id of ["near:sandbox", "near:testnet", "near:mainnet", null]) expect(escrowShort(id)).not.toContain("by default");
  });

  it("labels test money by network", () => {
    expect(testMoneyLabel(false, "near:sandbox")).toBe("Local sandbox");
    expect(testMoneyLabel(true, "near:sandbox")).toBe("Local sandbox");
    expect(testMoneyLabel(false, "near:testnet")).toBe("Testnet");
    expect(testMoneyLabel(true, "near:mainnet")).toBeNull();
  });
});

describe("Payouts reads the hub's credit", () => {
  const row = (over: Partial<PayoutAccount>): PayoutAccount => ({ account: "merchant.test.near", status: "clear", credit: "0", paidTotal: "0", attempts: 0, ...over });
  it("shows credit the server has not looked at yet as due", () => {
    expect(payoutRows([row({ status: "due", credit: "0" })], new Map([["merchant.test.near", "4500000"]]))[0]).toMatchObject({ status: "due", credit: "4500000", hubCredit: "4500000" });
    expect(payoutRows([row({ status: "clear" })], new Map([["merchant.test.near", "4500000"]]))[0]!.status).toBe("due");
  });
  it("keeps an account that waits for registration waiting, and marks one the hub owes nothing as paid out", () => {
    expect(payoutRows([row({ status: "waiting_registration", credit: "1" })], new Map([["merchant.test.near", "300000"]]))[0]!.status).toBe("waiting_registration");
    expect(payoutRows([row({ status: "due", credit: "5" })], new Map([["merchant.test.near", "0"]]))[0]!.status).toBe("clear");
  });
  it("falls back to the server's figures when the hub was not read", () => {
    expect(payoutRows([row({ status: "due", credit: "7" })], new Map())[0]).toMatchObject({ status: "due", credit: "7", hubCredit: null });
  });
});

describe("the Budget page shows the hub's escrow", () => {
  const base = {
    id: "ab".repeat(32),
    label: "Research agent",
    status: "open",
    budget: { owner: "alice.test.near", agentPk: "ed25519:x", settler: "node.test.near", cap: "25000000", validUntil: "1", payees: [], policyHash: "11".repeat(32), salt: "22".repeat(32) },
    owner: "alice.test.near",
    agent: "ed25519:x",
    settler: "node.test.near",
    cap: "25000000",
    expiresAt: "2026-12-10T00:00:00.000Z",
    policy: { perCallCap: "50000", dailyCap: "5000000", maxCallsPerMinute: 60, purpose: "p" },
    payees: [],
    spend: { settled: "0", pending: "0", today: "0", remaining: "25000000" },
    createdAt: "2026-11-10T00:00:00.000Z",
    escrow: "4998000",
  };
  it("prefers what the hub held when the server answered over its periodic read", () => {
    expect(budgetDetailSchema.parse({ ...base, onchain: { open: true, escrow: "6998000" } }).escrow).toBe("6998000");
    expect(budgetDetailSchema.parse({ ...base, onchain: null }).escrow).toBe("4998000");
    expect(budgetDetailSchema.parse({ ...base, onchain: { open: false } }).escrow).toBe("4998000");
  });
});
