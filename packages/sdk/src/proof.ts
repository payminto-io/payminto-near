import {
  nodeDigest,
  receiptLeaf,
  verifyDigest,
  verifyMerkleProof,
  voucherDigest,
  type AccountId,
  type Chain,
  type ClearingReceipt,
  type Id32,
  type PublicKey,
} from "@payminto/protocol";

export type ReceiptProofCheck = {
  /** True only when every check below passed: the receipt is proven cleared by the trusted node. */
  verified: boolean;
  /** The digest recomputed from the receipt fields equals receipt.digest. */
  digestMatches: boolean;
  /** The digest carries a valid signature by the trusted node key. */
  nodeSigned: boolean;
  /** The voucher signature checks out against the agent key, or null when no agent key was given. */
  agentSigned: boolean | null;
  /** Who submitted the batch on chain, or null when the batch does not exist. */
  settler: AccountId | null;
  /** The batch was settled by the trusted operator account. */
  settlerIsNode: boolean;
  /** The Merkle path reaches the batch root, recomputed here from the receipt fields. */
  localProofValid: boolean;
  /** The hub's `verify_receipt` view accepts the receipt fields and the path. */
  merkleVerified: boolean;
  /** First failed check, for humans. */
  reason: string | null;
};

/**
 * Proves a receipt against a settled batch, without trusting whoever served the proof.
 * The chain proves only that a settler committed to a root, so a proof counts only if the batch was settled by the
 * trusted operator and the receipt carries the node's signature. It proves inclusion and, with `agentPk`, that the
 * agent authorized this call. It does not prove that the root covers every voucher, or that the service was delivered.
 */
export async function verifyReceiptOnchain(o: {
  chain: Pick<Chain, "hub" | "network" | "batch" | "verifyReceipt">;
  /** The node account this verifier trusts to settle. */
  operator: AccountId;
  /** The key this verifier trusts to sign receipts (GET /v1/info `nodeKey`, or AgentClient.nodeKey()). */
  nodeKey: PublicKey;
  receipt: Pick<ClearingReceipt, "callId" | "budgetId" | "payee" | "amount" | "cumulative" | "requestHash" | "timestamp" | "voucherSig" | "digest" | "nodeSignature">;
  batchId: Id32;
  proof: readonly Id32[];
  /** The Budget's agent key. When given, the voucher signature is checked too. */
  agentPk?: PublicKey;
}): Promise<ReceiptProofCheck> {
  const r = o.receipt;
  const amount = BigInt(r.amount);
  const cumulative = BigInt(r.cumulative);
  const digest = nodeDigest({ callId: r.callId, budgetId: r.budgetId, payee: r.payee, amount, cumulative, requestHash: r.requestHash, timestamp: BigInt(r.timestamp), voucherSig: r.voucherSig });
  const digestMatches = digest === r.digest;
  const nodeSigned = verifyDigest(o.nodeKey, digest, r.nodeSignature);
  const agentSigned = o.agentPk
    ? verifyDigest(o.agentPk, voucherDigest(o.chain.hub, o.chain.network, { budgetId: r.budgetId, payee: r.payee, amount, cumulative, requestHash: r.requestHash }), r.voucherSig)
    : null;

  // The leaf commits to milliseconds; the node attests whole seconds.
  const fields = { callId: r.callId, budgetId: r.budgetId, payee: r.payee, amount, cumulative, requestHash: r.requestHash, timestampMs: BigInt(r.timestamp) * 1000n, voucherSig: r.voucherSig };
  const batch = await o.chain.batch(o.batchId);
  const settler = batch?.settler ?? null;
  const settlerIsNode = settler === o.operator;
  const localProofValid = batch !== null && verifyMerkleProof(batch.root, receiptLeaf(o.chain.hub, o.chain.network, o.batchId, fields), o.proof);
  const merkleVerified = await o.chain.verifyReceipt(o.batchId, fields, o.proof);

  const reason = !digestMatches
    ? "digest does not match the receipt fields"
    : !nodeSigned
      ? "receipt is not signed by the trusted node key"
      : agentSigned === false
        ? "voucher signature does not match the agent key"
        : batch === null
          ? "batch does not exist on chain"
          : !settlerIsNode
            ? `batch was settled by ${settler}, not by the trusted operator ${o.operator}`
            : !localProofValid
              ? "Merkle path does not reach the batch root"
              : !merkleVerified
                ? "the hub rejected the receipt and Merkle path"
                : null;
  return { verified: reason === null, digestMatches, nodeSigned, agentSigned, settler, settlerIsNode, localProofValid, merkleVerified, reason };
}
