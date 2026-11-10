import { compareAscii, id32Bytes, isId32 } from "./bytes.ts";
import { MAX_MERKLE_DEPTH } from "./constants.ts";
import { sha256Hex } from "./crypto.ts";
import { receiptLeafPreimage } from "./digest.ts";
import type { AccountId, Id32, Network, ReceiptFields } from "./types.ts";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

export function receiptLeaf(hub: AccountId, network: Network, batchId: Id32, f: ReceiptFields): Id32 {
  const body = receiptLeafPreimage(hub, network, batchId, f);
  const buf = new Uint8Array(body.length + 1);
  buf[0] = LEAF_PREFIX;
  buf.set(body, 1);
  return sha256Hex(buf);
}

/** sha256(0x01 || min(a,b) || max(a,b)). */
export function hashPair(a: Id32, b: Id32): Id32 {
  const [lo, hi] = compareAscii(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(65);
  buf[0] = NODE_PREFIX;
  buf.set(id32Bytes(lo, "node"), 1);
  buf.set(id32Bytes(hi, "node"), 33);
  return sha256Hex(buf);
}

function nextLevel(level: readonly Id32[]): Id32[] {
  const up: Id32[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]!;
    const right = level[i + 1];
    up.push(right === undefined ? left : hashPair(left, right));
  }
  return up;
}

export function merkleRoot(leaves: readonly Id32[]): Id32 {
  if (leaves.length === 0) throw new Error("cannot build a Merkle root over an empty tree");
  let level = [...leaves];
  let depth = 0;
  while (level.length > 1) {
    if (++depth > MAX_MERKLE_DEPTH) throw new Error(`Merkle tree is deeper than ${MAX_MERKLE_DEPTH}`);
    level = nextLevel(level);
  }
  return level[0]!;
}

/** Sibling hashes from leaf to root. A promoted odd node contributes no sibling at that level. */
export function merkleProof(leaves: readonly Id32[], index: number): Id32[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const proof: Id32[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const sibling = level[i % 2 === 0 ? i + 1 : i - 1];
    if (sibling !== undefined) proof.push(sibling);
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(root: Id32, leaf: Id32, proof: readonly Id32[]): boolean {
  if (proof.length > MAX_MERKLE_DEPTH) return false;
  if (!isId32(root) || !isId32(leaf) || !proof.every(isId32)) return false;
  return proof.reduce((node, sibling) => hashPair(node, sibling), leaf) === root;
}

export type ReceiptTree = {
  root: Id32;
  /** Receipts in leaf order: ascending call id bytes. */
  receipts: ReceiptFields[];
  leaves: Id32[];
  proofOf(callId: Id32): Id32[];
};

export function buildReceiptTree(hub: AccountId, network: Network, batchId: Id32, fields: readonly ReceiptFields[]): ReceiptTree {
  const receipts = [...fields].sort((a, b) => compareAscii(a.callId, b.callId));
  for (let i = 1; i < receipts.length; i++) {
    if (receipts[i]!.callId === receipts[i - 1]!.callId) throw new Error(`duplicate call id ${receipts[i]!.callId}`);
  }
  const leaves = receipts.map((f) => receiptLeaf(hub, network, batchId, f));
  return {
    root: merkleRoot(leaves),
    receipts,
    leaves,
    proofOf(callId) {
      const i = receipts.findIndex((r) => r.callId === callId);
      if (i < 0) throw new Error(`unknown call id ${callId}`);
      return merkleProof(leaves, i);
    },
  };
}
