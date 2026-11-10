import { compareAscii } from "./bytes.ts";
import { EXPIRY_GRACE_MS, REVOKE_GRACE_MS } from "./constants.ts";
import type { AccountId, Budget, NetEntry } from "./types.ts";

export type NettingLine = { owner: AccountId; payee: AccountId; delta: bigint };
export type NettingResult = { gross: bigint; net: bigint; entries: NetEntry[] };

/**
 * Nets by party account: an owner's Budget owes each payee its delta. Exactly what `settle_batch` recomputes.
 * `net` is the cash that moves: the sum of credits, which always equals the sum of debits.
 */
export function computeNetting(lines: readonly NettingLine[]): NettingResult {
  const balances = new Map<AccountId, bigint>();
  let gross = 0n;
  for (const { owner, payee, delta } of lines) {
    gross += delta;
    balances.set(owner, (balances.get(owner) ?? 0n) - delta);
    balances.set(payee, (balances.get(payee) ?? 0n) + delta);
  }
  const entries: NetEntry[] = [...balances]
    .filter(([, b]) => b !== 0n)
    .sort(([a], [b]) => compareAscii(a, b))
    .map(([account, b]) => (b < 0n ? { account, debit: -b, credit: 0n } : { account, debit: 0n, credit: b }));
  const net = entries.reduce((sum, e) => sum + e.credit, 0n);
  return { gross, net, entries };
}

/** The last moment a voucher under this Budget can settle, in Unix milliseconds. Revoked Budgets close at the earlier bound. */
export function settleDeadline(b: Pick<Budget, "validUntil" | "revokedAt">): bigint {
  const byExpiry = b.validUntil + EXPIRY_GRACE_MS;
  if (b.revokedAt === null) return byExpiry;
  const byRevoke = b.revokedAt + REVOKE_GRACE_MS;
  return byRevoke < byExpiry ? byRevoke : byExpiry;
}

export function sameNet(a: readonly NetEntry[], b: readonly NetEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.account === b[i]!.account && e.debit === b[i]!.debit && e.credit === b[i]!.credit);
}
