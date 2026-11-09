import { getAddress, type Address } from "viem";

export type ClaimFlow = { agent: Address; payee: Address; delta: bigint };
export type NetTransfer = { from: Address; to: Address; amount: bigint };
export type NettingProjection = { transfers: NetTransfer[]; gross: bigint; net: bigint; parties: number };

/**
 * Off-chain mirror of ClearingHub.settleBatch netting: same party insertion order (agent, then payee, per claim),
 * same greedy two-pointer match of debtors to creditors. Given the same claims in the same order it predicts
 * exactly the NetTransfer events the hub will emit, which the settlement worker reconciles after every batch.
 */
export function projectNetting(claims: readonly ClaimFlow[]): NettingProjection {
  const parties: Address[] = [];
  const balances: bigint[] = [];
  const index = new Map<string, number>();
  let gross = 0n;

  const credit = (who: Address, amount: bigint) => {
    const key = who.toLowerCase();
    const i = index.get(key);
    if (i !== undefined) {
      balances[i]! += amount;
      return;
    }
    index.set(key, parties.length);
    parties.push(getAddress(who));
    balances.push(amount);
  };

  for (const c of claims) {
    if (c.delta < 0n) throw new Error("negative claim delta");
    if (c.delta === 0n) continue;
    gross += c.delta;
    credit(c.agent, -c.delta);
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

/** Net debit per debtor (positive amounts), for balance and allowance pre-checks. */
export function netDebits(p: NettingProjection): Map<Address, bigint> {
  const out = new Map<Address, bigint>();
  for (const t of p.transfers) out.set(t.from, (out.get(t.from) ?? 0n) + t.amount);
  return out;
}

/** Gross obligations graph: one edge per (agent, payee) with the summed amount and call count. */
export function grossGraph(
  flows: readonly { agent: Address; payee: Address; amount: bigint; calls: number }[],
): { from: Address; to: Address; amount: bigint; calls: number }[] {
  const m = new Map<string, { from: Address; to: Address; amount: bigint; calls: number }>();
  for (const f of flows) {
    const key = `${f.agent.toLowerCase()}>${f.payee.toLowerCase()}`;
    const e = m.get(key);
    if (e) {
      e.amount += f.amount;
      e.calls += f.calls;
    } else m.set(key, { from: getAddress(f.agent), to: getAddress(f.payee), amount: f.amount, calls: f.calls });
  }
  return [...m.values()];
}
