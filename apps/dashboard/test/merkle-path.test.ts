import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import { receiptLeaf, receiptProof, receiptsTree, type CallReceipt } from "@payminto/protocol";
import { replayProof } from "@/lib/merkle-path";

const receipts: CallReceipt[] = Array.from({ length: 37 }, (_, i) => ({
  callId: keccak256(toBytes(`call-${i}`)),
  mandateId: keccak256(toBytes("mandate")),
  payee: getAddress(`0x${(i % 3 + 1).toString().padStart(40, "0")}`),
  amount: 2000n,
  cumulative: 2000n * BigInt(i + 1),
  requestHash: keccak256(toBytes(`req-${i}`)),
  timestamp: 1_790_000_000n + BigInt(i),
}));

describe("Merkle path replay", () => {
  it("walks from the leaf to the same root the protocol tree computes", () => {
    const tree = receiptsTree(receipts);
    for (const r of [receipts[0]!, receipts[18]!, receipts[36]!]) {
      const { steps, root } = replayProof(receiptLeaf(r), receiptProof(tree, r));
      expect(root).toBe((tree.root as Hex).toLowerCase());
      expect(steps[0]!.node).toBe(receiptLeaf(r).toLowerCase());
      for (let i = 1; i < steps.length; i++) expect(steps[i]!.node).toBe(steps[i - 1]!.parent);
    }
  });

  it("does not reach the root with a tampered sibling", () => {
    const tree = receiptsTree(receipts);
    const r = receipts[5]!;
    const proof = [...receiptProof(tree, r)];
    proof[0] = keccak256(toBytes("forged"));
    expect(replayProof(receiptLeaf(r), proof).root).not.toBe((tree.root as Hex).toLowerCase());
  });
});
