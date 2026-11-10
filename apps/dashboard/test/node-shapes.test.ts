import { describe, expect, it } from "vitest";
import { EVENT_TYPES, anyProofSchema, batchDetailSchema, budgetSchema, callSchema, denyListEntrySchema, infoSchema, overviewSchema, platformFeesSchema, proofSchema } from "@/lib/schemas";
import { MockClearingApi } from "@/lib/mock/server";
import { hubReadinessProblems, receiptKeyText } from "@/lib/hub-readiness";

const A = "northwind.testnet";
const T = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const H = "ab".repeat(32);
const TX = "9vC3q2GdkKZ7v1pGQX5qRpX7n2bT8fW1sLmYhZc4eDuA";

describe("node response shapes (GATEWAY.md section 15)", () => {
  it("maps the node's NEAR proof (credits plus the hub payment id) to what the receipt page checks", () => {
    const p = anyProofSchema.parse({
      payment_id: "pay_x",
      livemode: false,
      status: "paid",
      network: "near:testnet",
      hub: "hub.payminto.testnet",
      token: { address: T, symbol: "USDC", decimals: 6 },
      payout: A,
      amount_due: "25000000",
      amount_paid: "25000000",
      order_hash: H,
      paid_at: "2026-11-01T10:00:00.000Z",
      checked_at: "2026-11-01T10:05:00.000Z",
      credits: [
        { method: "wallet", amount: "25000000", payer: "mira.testnet", checkout_id: H, hub_record: { merchant: A, amount: "25000000", payer: "mira.testnet", at_ms: "1" }, verified: true },
        { method: "voucher", amount: "1", payer: "treasury.testnet", call_id: H, batch_id: H, tx_hash: TX, verified: true },
      ],
    });
    expect(p).toMatchObject({ token: T, hub: "hub.payminto.testnet", credit_amount: "25000000", hub_payment_id: H, payer: "mira.testnet", tx_hash: null });
  });
  it("folds per merchant and method fee rows", () => {
    const f = platformFeesSchema.parse({
      fee_recipient: A,
      totals: { platform_fee: "150", method_fee: "0", fee_total: "150" },
      items: [
        { merchant_id: "mer_a", merchant_name: "Acme", method: "wallet", payments: 2, volume: "1000", platform_fee: "100", method_fee: "0", fee_total: "100" },
        { merchant_id: "mer_a", merchant_name: "Acme", method: "voucher", payments: 1, volume: "500", platform_fee: "50", method_fee: "0", fee_total: "50" },
      ],
    });
    expect(f.total).toBe("150");
    expect(f.by_merchant).toEqual([{ merchant_id: "mer_a", name: "Acme", volume: "1500", fees: "150", payments: 3 }]);
    expect(f.by_method.map((m) => m.method)).toEqual(["wallet", "voucher"]);
  });
  it("reads the deny list's reason as the note", () => {
    expect(denyListEntrySchema.parse({ address: A, reason: "chargebacks", created_at: "2026-11-01T10:00:00.000Z" }).note).toBe("chargebacks");
  });
});

const ID = "ab".repeat(32);
const SIG = "cd".repeat(64);
const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

describe("clearing node shapes on NEAR", () => {
  it("parses /v1/info", () => {
    const i = infoSchema.parse({ version: "1", network: { id: "near:testnet", name: "NEAR testnet", explorer: null, testnet: true, rpc_url: "https://rpc.testnet.near.org" }, hub: "hub.testnet", token: { address: "c".repeat(64), symbol: "USDC", decimals: 6 }, operator: "node.testnet", nodeKey: KEY });
    expect(i.network.id).toBe("near:testnet");
  });
  it("parses a Budget with an agent key and millisecond expiry", () => {
    const terms = { owner: "alice.testnet", agentPk: KEY, settler: "node.testnet", cap: "1000", validUntil: "1800000000000", payees: ["svc.testnet"], policyHash: ID, salt: ID };
    const b = budgetSchema.parse({ id: ID, label: "L", status: "open", budget: terms, owner: terms.owner, agent: KEY, settler: terms.settler, cap: "1000", expiresAt: "2027-01-15T08:00:00.000Z", payees: terms.payees, policy: { perCallCap: "10", dailyCap: "100", hourlyCap: "50", maxCallsPerMinute: 60, maxRepeatsPerRequest: 3, purpose: "p" }, openTxHash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", revokedAt: null, createdAt: "2026-11-10T00:00:00.000Z", spend: { settled: "0", pending: "0", total: "0", today: "0", remaining: "1000" }, calls: 0, escrow: null, ownerCredit: null });
    expect(b.budget.validUntil).toBe("1800000000000");
  });
  it("keeps a batch's net total when the detail route sends per-account entries", () => {
    const b = batchDetailSchema.parse({ id: ID, seq: 1, status: "confirmed", token: "c".repeat(64), receiptsRoot: ID, claims: 1, calls: 2, transfers: 1, gross: "10", net: [{ account: "a.testnet", debit: "7", credit: "0" }, { account: "b.testnet", debit: "0", credit: "7" }], txHash: null, createdAt: "2026-11-10T00:00:00.000Z", claimList: [], netTransfers: [] });
    expect(b.net).toBe("7");
    expect(b.netEntries).toHaveLength(2);
  });
  it("parses a receipt proof without a leaf", () => {
    const p = proofSchema.parse({ receipt: { callId: ID, budgetId: ID, payee: "svc.testnet", amount: "1", cumulative: "1", requestHash: ID, timestamp: 1800000000, voucherSig: SIG, digest: ID, nodeSignature: SIG, node: KEY }, status: "accepted", batchId: null, batchStatus: null, receiptsRoot: null, proof: [], txHash: null, explorerUrl: null, onchainVerified: null });
    expect(p.leaf).toBeUndefined();
  });
  it("serves mock Budgets and proofs in the wire shape", async () => {
    const api = new MockClearingApi();
    const [b] = await api.budgets();
    expect(budgetSchema.safeParse(b).success).toBe(true);
    expect(b!.budget).not.toHaveProperty("totalCap");
    const { items } = await api.calls({ status: "settled", limit: 200 });
    const inBatch = items.find((c) => c.settledBy === "batch")!;
    const p = await api.receiptProof(inBatch.id);
    expect(proofSchema.safeParse(p).success).toBe(true);
    expect(p.onchainVerified).toBe(true);
  });
});

const RECEIPT = { callId: ID, budgetId: ID, payee: "svc.testnet", amount: "1000", cumulative: "5000", requestHash: ID, timestamp: 1800000000, voucherSig: SIG, digest: ID, nodeSignature: SIG, node: KEY };
const CALL = { id: ID, seq: 7, budgetId: ID, agent: KEY, payee: "svc.testnet", providerId: "prv_x", amount: "1000", cumulative: "5000", requestHash: ID, timestamp: 1800000000, createdAt: "2026-11-10T00:00:00.000Z", status: "settled", batchId: null, leaf: ID };
const NO_BATCH = { batchId: null, batchStatus: null, receiptsRoot: null, leaf: null, proof: [], txHash: null, explorerUrl: null, onchainVerified: null };
const OVERVIEW = { volume: { settled: "10", pending: "2", last24h: "12" }, calls: { all: 3, last24h: 3, pending: 1, settled: 2 }, denials24h: 0, activeBudgets: 1, providers: 1, batches: 1, settled: { gross: "8", net: "6" }, compressionRatio: 2, lastBatch: null };

describe("calls a seller settled itself", () => {
  it("reads settledBy on a call, and parses a call from a node that does not send it", () => {
    expect(callSchema.parse({ ...CALL, settledBy: "seller" }).settledBy).toBe("seller");
    expect(callSchema.parse({ ...CALL, settledBy: "batch", batchId: ID }).settledBy).toBe("batch");
    expect(callSchema.parse({ ...CALL, status: "accepted", settledBy: null }).settledBy).toBeNull();
    const older = callSchema.parse(CALL);
    expect(older.settledBy).toBeUndefined();
    expect(older.status).toBe("settled");
  });
  it("keeps parsing a call list when a newer node names a way of settling this dashboard does not know", () => {
    const c = callSchema.parse({ ...CALL, settledBy: "something_new" });
    expect(c.settledBy).toBeUndefined();
    expect(c.id).toBe(ID);
  });
  it("reads the seller settlement on a proof, with what the hub's position covers", () => {
    const seller = { id: "sst_0123456789abcdef", previous: "2000", cumulative: "5000", detectedAt: "2026-11-10T00:00:00.000Z", hubSettled: "5000", covered: true };
    const p = proofSchema.parse({ receipt: RECEIPT, status: "settled", settledBy: "seller", sellerSettlement: seller, ...NO_BATCH });
    expect(p.settledBy).toBe("seller");
    expect(p.sellerSettlement).toEqual(seller);
    expect(p.batchId).toBeNull();
    expect(p.proof).toEqual([]);
    expect(proofSchema.parse({ receipt: RECEIPT, settledBy: "seller", sellerSettlement: { ...seller, covered: false, hubSettled: "4000" }, ...NO_BATCH }).sellerSettlement!.covered).toBe(false);
    // The node could not read the hub: both are null, and that is not the same as "does not cover".
    const unread = proofSchema.parse({ receipt: RECEIPT, settledBy: "seller", sellerSettlement: { ...seller, covered: null, hubSettled: null }, ...NO_BATCH }).sellerSettlement!;
    expect(unread.covered).toBeNull();
    expect(unread.hubSettled).toBeNull();
  });
  it("parses the proof of an older node, and of a batch-settled call with no seller settlement", () => {
    const older = proofSchema.parse({ receipt: RECEIPT, status: "accepted", ...NO_BATCH });
    expect(older.settledBy).toBeUndefined();
    expect(older.sellerSettlement).toBeUndefined();
    const inBatch = proofSchema.parse({ receipt: RECEIPT, status: "settled", settledBy: "batch", sellerSettlement: null, ...NO_BATCH, batchId: ID, receiptsRoot: ID, leaf: ID, proof: [ID], onchainVerified: true });
    expect(inBatch.sellerSettlement).toBeNull();
    expect(inBatch.settledBy).toBe("batch");
  });
  it("reads what sellers settled themselves on the overview, and parses an overview without it", () => {
    expect(overviewSchema.parse(OVERVIEW).settledBySeller).toBeUndefined();
    expect(overviewSchema.parse({ ...OVERVIEW, settledBySeller: { gross: "250000", calls: 5, settlements: 1 } }).settledBySeller).toEqual({ gross: "250000", calls: 5, settlements: 1 });
  });
  it("lists the two new events among the ones the live stream listens for", () => {
    expect(EVENT_TYPES).toContain("seller.settled");
    expect(EVENT_TYPES).toContain("operator.alert");
  });
  it("serves a seller-settled call from the mock with a proof that has no batch", async () => {
    const api = new MockClearingApi();
    const { items } = await api.calls({ status: "settled", limit: 200 });
    const bySeller = items.filter((c) => c.settledBy === "seller");
    expect(bySeller.length).toBeGreaterThan(0);
    expect(bySeller.every((c) => callSchema.safeParse(c).success && !c.batchId)).toBe(true);
    const raw = await api.receiptProof(bySeller[0]!.id);
    const p = proofSchema.parse(raw);
    expect(p).toMatchObject({ status: "settled", settledBy: "seller", batchId: null, receiptsRoot: null, proof: [], onchainVerified: null });
    expect(p.sellerSettlement).toMatchObject({ covered: true });
    expect(p.sellerSettlement!.id).toMatch(/^sst_[0-9a-f]{16}$/);
    // The hub's settled position of the pair is past every call the seller settlement covered.
    expect(BigInt(p.sellerSettlement!.hubSettled!)).toBeGreaterThanOrEqual(BigInt(p.receipt.cumulative));
    const o = overviewSchema.parse(await api.overview());
    expect(o.settledBySeller).toMatchObject({ calls: bySeller.length, settlements: 1 });
    expect(BigInt(o.settledBySeller!.gross)).toBe(bySeller.reduce((a, c) => a + BigInt(c.amount), 0n));
  });
  it("answers the demo hub's views of a settled position, the receipt key and the storage balance", async () => {
    const api = new MockClearingApi();
    const info = await api.info();
    const { reader } = api.nearReader();
    const { items } = await api.calls({ status: "settled", limit: 200 });
    const c = items.find((x) => x.settledBy === "seller")!;
    const settled = await reader.view<string>(info.hub, "settled_of", { budget_id: c.budgetId, payee: c.payee });
    expect(BigInt(settled.value)).toBeGreaterThanOrEqual(BigInt(c.cumulative));
    const keys = await reader.view<string[]>(info.hub, "receipt_keys", { settler: info.operator });
    expect(keys.value.map(receiptKeyText)).toEqual([info.nodeKey]);
    const storage = await reader.view<string>(info.hub, "storage_of", { account: info.operator });
    expect(hubReadinessProblems({ operator: info.operator, hub: info.hub, nodeKey: info.nodeKey }, { receiptKeys: keys.value.map(receiptKeyText), storageYocto: BigInt(storage.value) })).toEqual([]);
  });
});
