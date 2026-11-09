import { concat, keccak256, type Hex } from "viem";

export type PathStep = { level: number; node: Hex; sibling: Hex; parent: Hex; siblingOnLeft: boolean };

/**
 * Replays an OpenZeppelin Merkle proof (sorted-pair keccak256) from leaf to root, one step per level,
 * so the screen can show every intermediate hash rather than just "valid".
 */
export function replayProof(leaf: Hex, proof: readonly Hex[]): { steps: PathStep[]; root: Hex } {
  let node = leaf.toLowerCase() as Hex;
  const steps: PathStep[] = [];
  proof.forEach((raw, level) => {
    const sibling = raw.toLowerCase() as Hex;
    const siblingOnLeft = BigInt(sibling) < BigInt(node);
    const parent = keccak256(siblingOnLeft ? concat([sibling, node]) : concat([node, sibling]));
    steps.push({ level, node, sibling, parent, siblingOnLeft });
    node = parent;
  });
  return { steps, root: node };
}
