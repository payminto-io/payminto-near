import { describe, expect, it } from "vitest";
import { buildReceiptTree, receiptLeaf, sha256Text, type ReceiptFields } from "@payminto/protocol";
import { replayProof } from "@/lib/merkle-path";

const HUB = "hub.payminto.testnet";
const NET = "near:testnet" as const;
const BATCH = sha256Text("batch");
const receipts: ReceiptFields[] = Array.from({ length: 37 }, (_, i) => ({
  callId: sha256Text(`call:${i}`),
  budgetId: sha256Text("budget"),
  payee: "market-data.testnet",
  amount: 2000n,
  cumulative: BigInt(2000 * (i + 1)),
  requestHash: sha256Text(`req:${i}`),
  timestampMs: 1_800_000_000_000n + BigInt(i),
  voucherSig: sha256Text(`a:${i}`) + sha256Text(`b:${i}`),
}));

describe("Merkle path replay", () => {
  const tree = buildReceiptTree(HUB, NET, BATCH, receipts);
  it("walks from the leaf to the same root the protocol tree computes", () => {
    for (const r of [receipts[0]!, receipts[18]!, receipts[36]!]) {
      const proof = tree.proofOf(r.callId);
      const { steps, root } = replayProof(receiptLeaf(HUB, NET, BATCH, r), proof);
      expect(root).toBe(tree.root);
      expect(steps).toHaveLength(proof.length);
    }
  });
  it("does not reach the root with a tampered sibling", () => {
    const r = receipts[5]!;
    const proof = [...tree.proofOf(r.callId)];
    proof[0] = sha256Text("tampered");
    expect(replayProof(receiptLeaf(HUB, NET, BATCH, r), proof).root).not.toBe(tree.root);
  });
});
