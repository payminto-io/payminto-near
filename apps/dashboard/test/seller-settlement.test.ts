import { describe, expect, it } from "vitest";
import { SELLER_SETTLED_LABEL, callStatusLabel, isSellerSettled, sellerSettledChecks, sellerSettledVerdict, serverReadText, type HubPositionRead } from "@/lib/seller-settlement";
import type { ReceiptProof } from "@/lib/schemas";

const H = "ab".repeat(32);
const money = (a: string) => `${a} units`;
const receipt: ReceiptProof["receipt"] = { callId: H, budgetId: H, payee: "research-writer.testnet", amount: "50000", cumulative: "250000", requestHash: H, timestamp: 1_800_000_000, voucherSig: "", digest: H, nodeSignature: "", node: "ed25519:x" };
const settlement = { id: "sst_0123456789abcdef", previous: "100000", cumulative: "300000", detectedAt: "2026-11-10T00:00:00.000Z", hubSettled: "300000", covered: true as boolean | null };
const proof = (covered: boolean | null = true) => ({ receipt, sellerSettlement: { ...settlement, covered, hubSettled: covered === null ? null : settlement.hubSettled } });
const done = (settled: string): HubPositionRead => ({ state: "done", settled, blockHeight: 219_402_871, source: "rpc.testnet.near.org" });
const states = (c: ReturnType<typeof sellerSettledChecks>) => Object.fromEntries(c.map((x) => [x.key, x.state]));

describe("how a Call was settled", () => {
  it("names a Call its seller settled as settled by the seller, never as waiting", () => {
    expect(SELLER_SETTLED_LABEL).toBe("Settled by the seller on the hub");
    expect(callStatusLabel({ status: "settled", settledBy: "seller" })).toBe(SELLER_SETTLED_LABEL);
    expect(callStatusLabel({ status: "settled", settledBy: "batch" })).toBe("Settled");
    expect(callStatusLabel({ status: "settling", settledBy: null })).toBe("Settling");
    expect(callStatusLabel({ status: "accepted", settledBy: null })).toBe("In next settlement");
  });
  it("reads a Call from an older node, which sends no settledBy, by its status alone", () => {
    expect(callStatusLabel({ status: "settled" })).toBe("Settled");
    expect(isSellerSettled({ status: "settled" })).toBe(false);
  });
  it("knows a seller-settled proof by settledBy or by the seller settlement it carries", () => {
    expect(isSellerSettled({ settledBy: "seller", sellerSettlement: null })).toBe(true);
    expect(isSellerSettled({ settledBy: undefined, sellerSettlement: settlement })).toBe(true);
    expect(isSellerSettled({ settledBy: "batch", sellerSettlement: null })).toBe(false);
    expect(isSellerSettled({ settledBy: null, sellerSettlement: undefined })).toBe(false);
  });
});

describe("sellerSettledChecks", () => {
  it("passes when this browser reads a settled position at or past the Call", () => {
    const checks = sellerSettledChecks(proof(), done("300000"), money);
    expect(states(checks)).toEqual({ receipt: "pass", booked: "pass", position: "pass", server: "pass" });
    expect(checks.find((c) => c.key === "booked")!.detail).toBe("The hub's settled position moved from 100000 units to 300000 units outside any batch of this server, and the server booked it as sst_0123456789abcdef.");
    expect(checks.find((c) => c.key === "position")!.detail).toBe(
      "Read from rpc.testnet.near.org at final block 219,402,871: the hub has settled 300000 units to this Payee under this Budget, at or past this Call's running total of 250000 units.",
    );
    expect(sellerSettledVerdict(checks, done("300000"))).toMatchObject({ verdict: "verified", title: SELLER_SETTLED_LABEL });
  });
  it("passes at exactly the Call's running total", () => {
    expect(states(sellerSettledChecks(proof(), done("250000"), money)).position).toBe("pass");
  });
  it("says there is no batch root to check", () => {
    const v = sellerSettledVerdict(sellerSettledChecks(proof(), done("300000"), money), done("300000"));
    expect(v.body).toContain("There is no batch root to check, so there is no Merkle proof.");
    expect(v.body).toContain("it covers this Call");
  });
  it("fails when the hub's settled position is below the Call", () => {
    const read = done("200000");
    const checks = sellerSettledChecks(proof(), read, money);
    expect(states(checks).position).toBe("fail");
    expect(checks.find((c) => c.key === "position")!.detail).toContain("below this Call's running total of 250000 units");
    const v = sellerSettledVerdict(checks, read);
    expect(v.verdict).toBe("failed");
    expect(v.title).toBe("The hub does not show this Call as settled");
  });
  it("fails when the server's own read does not cover the Call, whatever this browser could read", () => {
    const read: HubPositionRead = { state: "error", message: "NEAR did not answer in time." };
    const checks = sellerSettledChecks(proof(false), read, money);
    expect(states(checks)).toMatchObject({ position: "unknown", server: "fail" });
    expect(sellerSettledVerdict(checks, read).verdict).toBe("failed");
  });
  it("stays settled by the seller while NEAR is being read", () => {
    const read: HubPositionRead = { state: "reading" };
    const checks = sellerSettledChecks(proof(), read, money);
    expect(states(checks).position).toBe("pending");
    expect(sellerSettledVerdict(checks, read)).toMatchObject({ verdict: "checking", title: SELLER_SETTLED_LABEL });
  });
  it("says so when neither this browser nor the server could read the hub, and never calls the Call unsettled", () => {
    const read: HubPositionRead = { state: "error", message: "NEAR did not answer in time. Nothing was proven either way; try again." };
    const checks = sellerSettledChecks(proof(null), read, money);
    expect(states(checks)).toEqual({ receipt: "pass", booked: "pass", position: "unknown", server: "unknown" });
    const v = sellerSettledVerdict(checks, read);
    expect(v).toMatchObject({ verdict: "unreachable", title: SELLER_SETTLED_LABEL });
    expect(v.body).toContain("NEAR did not answer in time.");
    expect(v.body).toContain("The server could not read the hub when this page asked.");
    expect(v.body).not.toMatch(/pending|unverified/i);
  });
  it("names a page with no RPC as that", () => {
    const checks = sellerSettledChecks(proof(), { state: "none" }, money);
    expect(checks.find((c) => c.key === "position")).toMatchObject({ state: "unknown", detail: "This page has no NEAR RPC configured, so the hub was not read from this browser." });
    expect(sellerSettledVerdict(checks, { state: "none" }).body).toContain("The server read the hub when this page asked, and the hub's settled position covers this Call.");
  });
  it("shows a Call marked seller-settled with no record as not reported, not as failed", () => {
    const checks = sellerSettledChecks({ receipt, sellerSettlement: null }, done("300000"), money);
    expect(states(checks)).toEqual({ receipt: "pass", booked: "unknown", position: "pass", server: "unknown" });
    expect(sellerSettledVerdict(checks, done("300000")).verdict).toBe("verified");
  });
  it("words the server's read three ways", () => {
    expect(serverReadText(true)).toContain("covers this Call");
    expect(serverReadText(false)).toContain("does not cover this Call");
    expect(serverReadText(null)).toBe("The server could not read the hub when this page asked.");
    expect(serverReadText(undefined)).toBe(serverReadText(null));
  });
  it("never uses an em dash", () => {
    const all = [true, false, null].flatMap((c) => [done("300000"), done("1"), { state: "reading" } as const, { state: "none" } as const].flatMap((r) => {
      const checks = sellerSettledChecks(proof(c), r, money);
      const v = sellerSettledVerdict(checks, r);
      return [v.title, v.body, ...checks.flatMap((x) => [x.label, x.detail])];
    }));
    for (const t of all) expect(t).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
  });
});
