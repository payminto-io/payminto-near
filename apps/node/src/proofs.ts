import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { clearingHubAbi } from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";

/**
 * Whether a receipt is proven on chain as cleared by this node.
 * ClearingHub.settleBatch is permissionless, so verifyReceipt alone only says "the leaf is under some stored root":
 * anyone settling real vouchers could have stored a root of made-up receipts. A proof therefore counts only when
 * this node's operator settled the batch and signed the leaf. Returns null when the chain cannot be read.
 */
export async function receiptVerifiedOnchain(
  chain: Pick<ChainClient, "public" | "hub" | "operator">,
  batchId: Hex,
  leaf: Hex,
  nodeSignature: Hex,
  proof: Hex[],
): Promise<boolean | null> {
  const signer = await recoverMessageAddress({ message: { raw: leaf }, signature: nodeSignature }).catch(() => null);
  if (!signer || !isAddressEqual(signer, chain.operator.address)) return false;
  try {
    const batch = (await chain.public.readContract({ address: chain.hub, abi: clearingHubAbi, functionName: "batches", args: [batchId] })) as readonly [
      Hex,
      Address,
      Address,
      bigint | number,
      bigint,
      bigint,
    ];
    if (!isAddressEqual(batch[2], chain.operator.address)) return false;
    return (await chain.public.readContract({
      address: chain.hub,
      abi: clearingHubAbi,
      functionName: "verifyReceipt",
      args: [batchId, leaf, proof],
    })) as boolean;
  } catch {
    return null;
  }
}
