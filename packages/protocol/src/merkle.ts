import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, type Address, type Hex } from "viem";
import { ZERO_BYTES32 } from "./hub.ts";

/**
 * Payee allowlist tree. Leaf encoding matches ClearingHub._applyClaim:
 * keccak256(bytes.concat(keccak256(abi.encode(payee)))).
 */
export function payeeTree(payees: readonly Address[]) {
  const unique = [...new Set(payees.map((p) => getAddress(p)))].sort();
  return StandardMerkleTree.of(unique.map((p) => [p]), ["address"]);
}

/** Zero root means "any payee"; an empty list therefore yields the zero root. */
export function payeesRoot(payees: readonly Address[]): Hex {
  if (payees.length === 0) return ZERO_BYTES32;
  return payeeTree(payees).root as Hex;
}

export function payeeProof(payees: readonly Address[], payee: Address): Hex[] {
  if (payees.length === 0) return [];
  return payeeTree(payees).getProof([getAddress(payee)]) as Hex[];
}

/**
 * One cleared call. Every accepted call becomes a leaf, so any single call can be proven
 * against the batch receiptsRoot stored on chain (ClearingHub.verifyReceipt).
 */
export type CallReceipt = {
  callId: Hex; // bytes32
  mandateId: Hex;
  payee: Address;
  amount: bigint;
  cumulative: bigint;
  requestHash: Hex; // bytes32 hash of what was bought (method, url, body digest)
  timestamp: bigint; // unix seconds when the node accepted the voucher
};

export const RECEIPT_LEAF_TYPES = ["bytes32", "bytes32", "address", "uint256", "uint256", "bytes32", "uint64"] as const;

function receiptValues(r: CallReceipt) {
  return [r.callId, r.mandateId, getAddress(r.payee), r.amount, r.cumulative, r.requestHash, r.timestamp];
}

export function receiptsTree(receipts: readonly CallReceipt[]) {
  return StandardMerkleTree.of(receipts.map(receiptValues), [...RECEIPT_LEAF_TYPES]);
}

export function receiptLeaf(r: CallReceipt): Hex {
  return StandardMerkleTree.of([receiptValues(r)], [...RECEIPT_LEAF_TYPES]).leafHash(receiptValues(r)) as Hex;
}

export function receiptProof(tree: ReturnType<typeof receiptsTree>, r: CallReceipt): Hex[] {
  return tree.getProof(receiptValues(r)) as Hex[];
}

export function verifyReceiptProof(root: Hex, r: CallReceipt, proof: Hex[]): boolean {
  return StandardMerkleTree.verify(root, [...RECEIPT_LEAF_TYPES], receiptValues(r), proof);
}
