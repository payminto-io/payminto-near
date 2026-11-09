import { isAddressEqual, recoverMessageAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { clearingHubAbi, receiptLeaf, type ClearingReceipt } from "@payminto/protocol";

export type ReceiptProofCheck = {
  /** True only when every check below passed: the receipt is proven cleared by the trusted node. */
  verified: boolean;
  /** The leaf recomputed from the receipt fields equals receipt.leaf. */
  leafMatches: boolean;
  /** The leaf is signed by the trusted node operator. */
  nodeSigned: boolean;
  /** Who submitted the batch on chain (zero address when the batch does not exist). */
  settler: Address;
  /** batches[batchId].settler is the trusted node operator. */
  settlerIsNode: boolean;
  /** ClearingHub.verifyReceipt(batchId, leaf, proof). */
  merkleVerified: boolean;
  /** First failed check, for humans. */
  reason: string | null;
};

/**
 * Proves a receipt against a settled batch, without trusting whoever served the proof.
 * settleBatch is permissionless, so a receiptsRoot alone proves nothing: anyone can settle a batch of real vouchers
 * under a root of made-up receipts. A proof counts only if the batch was settled by the trusted node operator and
 * the leaf carries that operator's signature.
 */
export async function verifyReceiptOnchain(o: {
  publicClient: Pick<PublicClient, "readContract">;
  hub: Address;
  /** The clearing node operator this verifier trusts (AgentClient.nodeOperator()). */
  operator: Address;
  receipt: Pick<ClearingReceipt, "callId" | "mandateId" | "payee" | "amount" | "cumulative" | "requestHash" | "timestamp" | "leaf" | "nodeSignature">;
  batchId: Hex;
  proof: readonly Hex[];
}): Promise<ReceiptProofCheck> {
  const r = o.receipt;
  const leaf = receiptLeaf({
    callId: r.callId,
    mandateId: r.mandateId,
    payee: r.payee,
    amount: BigInt(r.amount),
    cumulative: BigInt(r.cumulative),
    requestHash: r.requestHash,
    timestamp: BigInt(r.timestamp),
  });
  const leafMatches = leaf.toLowerCase() === r.leaf.toLowerCase();
  const signer = await recoverMessageAddress({ message: { raw: leaf }, signature: r.nodeSignature }).catch(() => null);
  const nodeSigned = signer !== null && isAddressEqual(signer, o.operator);
  const batch = (await o.publicClient.readContract({ address: o.hub, abi: clearingHubAbi, functionName: "batches", args: [o.batchId] })) as readonly [
    Hex,
    Address,
    Address,
    bigint | number,
    bigint,
    bigint,
  ];
  const settler = batch[2] ?? zeroAddress;
  const settlerIsNode = isAddressEqual(settler, o.operator);
  const merkleVerified = (await o.publicClient.readContract({
    address: o.hub,
    abi: clearingHubAbi,
    functionName: "verifyReceipt",
    args: [o.batchId, leaf, [...o.proof]],
  })) as boolean;
  const reason = !leafMatches
    ? "leaf does not match the receipt fields"
    : !nodeSigned
      ? "leaf is not signed by the trusted node operator"
      : !settlerIsNode
        ? `batch was settled by ${settler}, not by the trusted node operator ${o.operator}`
        : !merkleVerified
          ? "Merkle proof does not verify against the batch receiptsRoot"
          : null;
  return { verified: reason === null, leafMatches, nodeSigned, settler, settlerIsNode, merkleVerified, reason };
}
