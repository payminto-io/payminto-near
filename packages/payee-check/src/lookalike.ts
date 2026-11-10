import type { AccountId } from "./account.ts";

/**
 * Characters and pairs that read alike in the fonts wallets and terminals use. Account ids are lowercase ASCII, so the
 * table is short. Single characters are folded first, then pairs, so `c1` folds to `cl` and then to `d`.
 */
const SINGLE: ReadonlyArray<readonly [string, string]> = [
  ["0", "o"],
  ["1", "l"],
  ["5", "s"],
  ["_", "-"],
];
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["rn", "m"],
  ["vv", "w"],
  ["cl", "d"],
];

/** The id with every confusable spelling folded to one form. Two ids with the same skeleton read the same at a glance. */
export function skeleton(id: string): string {
  let s = id;
  for (const [from, to] of SINGLE) s = s.replaceAll(from, to);
  for (const [from, to] of PAIRS) s = s.replaceAll(from, to);
  return s;
}

/** Edits to turn one string into the other: insert, delete, substitute, or swap two neighbours. Each costs one. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** Both ids without the trailing labels they share, so `.near` or `.testnet` neither hides nor pads a difference. */
function withoutSharedParent(a: string, b: string): [string, string] {
  const x = a.split(".");
  const y = b.split(".");
  while (x.length > 1 && y.length > 1 && x[x.length - 1] === y[y.length - 1]) {
    x.pop();
    y.pop();
  }
  return [x.join("."), y.join(".")];
}

export type LookalikeRule = {
  /** The most edits that still count as a lookalike, however long the name. */
  maxEdits: number;
  /** One edit is tolerated per this many characters of the shorter name, so short names need an exact confusable match. */
  charsPerEdit: number;
};

export type LookalikeMatch = {
  /** The allowed account the payee resembles. */
  resembles: AccountId;
  /** `confusable`: the same once confusable spellings are folded. `edit_distance`: a few edits apart. */
  how: "confusable" | "edit_distance";
  /** Edits between the names, after shared parent labels are removed. */
  distance: number;
};

/**
 * The allowed account that `payee` most resembles without being it, or null.
 * A payee that is itself on the list never matches. A sub-account of an allowed account never matches either, because
 * only the parent account can create it.
 */
export function findLookalike(payee: AccountId, allowed: readonly AccountId[], rule: LookalikeRule): LookalikeMatch | null {
  if (allowed.includes(payee)) return null;
  let best: LookalikeMatch | null = null;
  for (const candidate of [...new Set(allowed)].sort()) {
    if (payee.endsWith(`.${candidate}`)) continue;
    const [p, c] = withoutSharedParent(payee, candidate);
    const distance = editDistance(p, c);
    let match: LookalikeMatch | null = null;
    if (skeleton(p) === skeleton(c)) {
      match = { resembles: candidate, how: "confusable", distance };
    } else {
      const folded = Math.min(distance, editDistance(skeleton(p), skeleton(c)));
      const tolerated = Math.min(rule.maxEdits, Math.floor(Math.min(p.length, c.length) / rule.charsPerEdit));
      if (folded <= tolerated) match = { resembles: candidate, how: "edit_distance", distance };
    }
    if (!match) continue;
    const better = !best || (match.how === "confusable" && best.how !== "confusable") || (match.how === best.how && match.distance < best.distance);
    if (better) best = match;
  }
  return best;
}
