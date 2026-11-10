import { nodeDigest, verifyDigest, type AccountId, type Id32, type NodeAttestation, type PublicKey, type ReceiptFields, type Sig64 } from "@payminto/protocol";
import type { Chain } from "@payminto/chain";

/**
 * Whether a receipt is proven on chain as cleared by this node.
 * The chain proves only that the settler committed to a root, so a proof counts only when this node settled the batch,
 * the node's acceptance signature checks out, and the hub verifies the Merkle proof. Returns null when the chain cannot be read.
 */
export async function receiptVerifiedOnchain(
  chain: Pick<Chain, "batch" | "verifyReceipt">,
  operator: AccountId,
  nodeKey: PublicKey,
  batchId: Id32,
  fields: ReceiptFields,
  attestation: NodeAttestation,
  nodeSignature: Sig64,
  proof: Id32[],
): Promise<boolean | null> {
  if (!verifyDigest(nodeKey, nodeDigest(attestation), nodeSignature)) return false;
  try {
    // Batch ids belong to their settler, so the hub is asked for this node's batch under that id.
    const batch = await chain.batch(batchId, operator);
    if (!batch || batch.settler !== operator) return false;
    return await chain.verifyReceipt(batchId, operator, fields, proof);
  } catch {
    return null;
  }
}
