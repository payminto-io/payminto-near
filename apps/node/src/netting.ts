import type { AccountId } from "@payminto/protocol";

export type ClaimFlow = { owner: AccountId; payee: AccountId; delta: bigint };
export type NetTransfer = { from: AccountId; to: AccountId; amount: bigint };
export type NettingProjection = { transfers: NetTransfer[]; gross: bigint; net: bigint; parties: number };

/**
 * One debtor-to-creditor matching of a batch's net result, for display and books. The authoritative result is
 * `computeNetting` in @payminto/chain, because the hub moves cash through escrow and credits and has no pairwise transfers.
 * Parties are Budget owner accounts and payee accounts; order is first appearance, which keeps the output stable.
 */
export function projectNetting(claims: readonly ClaimFlow[]): NettingProjection {
  const parties: AccountId[] = [];
  const balances: bigint[] = [];
  const index = new Map<string, number>();
  let gross = 0n;

  const credit = (who: AccountId, amount: bigint) => {
    const i = index.get(who);
    if (i !== undefined) {
      balances[i]! += amount;
      return;
    }
    index.set(who, parties.length);
    parties.push(who);
    balances.push(amount);
  };

  for (const c of claims) {
    if (c.delta < 0n) throw new Error("negative claim delta");
    if (c.delta === 0n) continue;
    gross += c.delta;
    credit(c.owner, -c.delta);
    credit(c.payee, c.delta);
  }

  const transfers: NetTransfer[] = [];
  let net = 0n;
  let d = 0;
  let c = 0;
  const count = parties.length;
  for (;;) {
    while (d < count && balances[d]! >= 0n) d++;
    while (c < count && balances[c]! <= 0n) c++;
    if (d === count || c === count) break;
    const owed = -balances[d]!;
    const due = balances[c]!;
    const amount = owed < due ? owed : due;
    transfers.push({ from: parties[d]!, to: parties[c]!, amount });
    balances[d]! += amount;
    balances[c]! -= amount;
    net += amount;
  }
  return { transfers, gross, net, parties: count };
}

/** Net debit per debtor (positive amounts). */
export function netDebits(p: NettingProjection): Map<AccountId, bigint> {
  const out = new Map<AccountId, bigint>();
  for (const t of p.transfers) out.set(t.from, (out.get(t.from) ?? 0n) + t.amount);
  return out;
}

/** Gross obligations graph: one edge per (owner, payee) with the summed amount and call count. */
export function grossGraph(
  flows: readonly { owner: AccountId; payee: AccountId; amount: bigint; calls: number }[],
): { from: AccountId; to: AccountId; amount: bigint; calls: number }[] {
  const m = new Map<string, { from: AccountId; to: AccountId; amount: bigint; calls: number }>();
  for (const f of flows) {
    const key = `${f.owner}>${f.payee}`;
    const e = m.get(key);
    if (e) {
      e.amount += f.amount;
      e.calls += f.calls;
    } else m.set(key, { from: f.owner, to: f.payee, amount: f.amount, calls: f.calls });
  }
  return [...m.values()];
}
