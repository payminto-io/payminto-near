import { describe, expect, it } from "vitest";
import { buildReceiptTree, checkReceiptOnChain, type ReceiptCheck, type ReceiptFields } from "@payminto/protocol";
import { isVerified, proofChecks, rebuildLeaf, type ChainRead } from "@/lib/proof";
import { mockReader } from "@/lib/mock/rpc";
import type { ReceiptProof } from "@/lib/schemas";

const H = "ab".repeat(32);
const states = (c: ReturnType<typeof proofChecks>) => Object.fromEntries(c.map((x) => [x.key, x.state]));
const hub = "hub.payminto.testnet";
const batchId = "cd".repeat(32);
const fields: ReceiptFields = { callId: "01".repeat(32), budgetId: "02".repeat(32), payee: "market-data.testnet", amount: 2000n, cumulative: 6000n, requestHash: "03".repeat(32), timestampMs: 1_762_000_000_000n, voucherSig: "04".repeat(64) };
const other: ReceiptFields = { ...fields, callId: "05".repeat(32), amount: 1000n };
const tree = buildReceiptTree(hub, "near:testnet", batchId, [fields, other]);
const receipt = { callId: fields.callId, budgetId: fields.budgetId, payee: fields.payee, amount: "2000", cumulative: "6000", requestHash: fields.requestHash, timestamp: 1_762_000_000, voucherSig: fields.voucherSig, digest: H, nodeSignature: "", node: "ed25519:x" };

const check = (o: Partial<ReceiptCheck> = {}): ReceiptCheck => ({
  rpcUrl: "https://rpc.testnet.near.org",
  hub,
  network: "near:testnet",
  batchId,
  blockHeight: 219_402_871,
  storedRoot: tree.root,
  leaf: tree.leaves[0]!,
  recomputedRoot: tree.root,
  rootMatches: true,
  hubVerified: true,
  verified: true,
  ...o,
});
const done = (o?: Partial<ReceiptCheck>): ChainRead => ({ state: "done", check: check(o), source: "rpc.testnet.near.org" });
const settled = { batchId, leaf: tree.leaves[0]!, proof: tree.proofOf(fields.callId) };

describe("proofChecks", () => {
  it("passes every check when NEAR's root, the browser's path and the hub agree", () => {
    const checks = proofChecks(settled, tree.leaves[0]!, done());
    expect(checks.map((c) => c.state)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(isVerified(checks)).toBe(true);
    expect(checks.find((c) => c.key === "root")!.detail).toContain("rpc.testnet.near.org at final block 219,402,871");
    expect(checks.find((c) => c.key === "path")!.detail).toContain("1 sibling hash leads");
  });

  it("leaves batch checks pending before settlement", () => {
    const checks = proofChecks({ batchId: null, leaf: null, proof: [] }, null, { state: "none" });
    expect(checks.map((c) => c.state)).toEqual(["pass", "pending", "pending", "pending", "pending"]);
    expect(isVerified(checks)).toBe(false);
  });

  it("fails when the root on NEAR, the path or the hub disagree", () => {
    const checks = proofChecks(settled, tree.leaves[0]!, done({ rootMatches: false, recomputedRoot: H, hubVerified: false, verified: false }));
    expect(states(checks)).toMatchObject({ path: "fail", hub: "fail" });
    expect(isVerified(checks)).toBe(false);
  });

  it("fails a batch the hub does not have", () => {
    const checks = proofChecks(settled, tree.leaves[0]!, done({ storedRoot: null, rootMatches: false, hubVerified: null, verified: false }));
    expect(states(checks)).toMatchObject({ root: "fail", path: "fail", hub: "unknown" });
  });

  it("fails a receipt whose fields do not hash to the server's leaf", () => {
    expect(states(proofChecks({ ...settled, leaf: H }, tree.leaves[0]!, done())).leaf).toBe("fail");
  });

  it("never verifies on the server's word when NEAR could not be read", () => {
    const checks = proofChecks(settled, tree.leaves[0]!, { state: "error", message: "NEAR did not answer in time." });
    expect(states(checks)).toMatchObject({ root: "unknown", path: "unknown", hub: "unknown" });
    expect(checks.find((c) => c.key === "root")!.detail).toBe("NEAR did not answer in time.");
    expect(isVerified(checks)).toBe(false);
    expect(isVerified(proofChecks(settled, tree.leaves[0]!, { state: "reading" }))).toBe(false);
  });
});

describe("rebuildLeaf", () => {
  it("hashes the receipt fields to the same leaf the batch tree holds", () => {
    const p = { batchId, receipt } as Pick<ReceiptProof, "receipt" | "batchId">;
    expect(rebuildLeaf(p, { hub, network: "near:testnet" })).toBe(tree.leaves[0]);
    expect(rebuildLeaf({ ...p, batchId: null }, { hub, network: "near:testnet" })).toBeNull();
  });
});

describe("the demo RPC", () => {
  const source = mockReader({
    hub,
    view: (method, args) => {
      if (method === "batch") return args.batch_id === batchId ? { root: tree.root, settler: "node.payminto.testnet", gross: "3000", net: "3000", at: "1762000060000" } : null;
      if (method === "verify_receipt") return args.batch_id === batchId;
      throw new Error("MethodNotFound");
    },
    txFinal: () => true,
  });

  it("serves NearReader through fetch, so mock pages run the real proof code", async () => {
    const c = await checkReceiptOnChain(source.reader, { network: "near:testnet", batchId, fields, proof: tree.proofOf(fields.callId) });
    expect(source.demo).toBe(true);
    expect(c).toMatchObject({ rpcUrl: "demo:in-browser-hub", storedRoot: tree.root, rootMatches: true, hubVerified: true, verified: true });
  });

  it("answers a different hub as a missing account", async () => {
    await expect(source.reader.view("other.testnet", "batch", { batch_id: batchId })).rejects.toMatchObject({ kind: "not_found" });
  });
});
