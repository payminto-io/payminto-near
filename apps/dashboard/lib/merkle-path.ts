import { compareAscii, hashPair, type Id32 } from "@payminto/protocol";

export type PathStep = { level: number; node: Id32; sibling: Id32; parent: Id32; siblingOnLeft: boolean };

/** Replays a receipt proof from leaf to root, one step per level, so the screen can show every intermediate hash. */
export function replayProof(leaf: Id32, proof: readonly Id32[]): { steps: PathStep[]; root: Id32 } {
  let node = leaf;
  const steps: PathStep[] = [];
  proof.forEach((sibling, level) => {
    const parent = hashPair(node, sibling);
    steps.push({ level, node, sibling, parent, siblingOnLeft: compareAscii(sibling, node) < 0 });
    node = parent;
  });
  return { steps, root: node };
}
