import { explorerTx, reportCsvCell, type AccountId, type Network } from "@payminto/protocol";
import type { Database } from "./db/database.ts";

/** What one party paid to and received from one counterparty through settled calls, gross. */
export type CounterpartyGross = { counterparty: AccountId; paid: string; received: string; callsPaid: number; callsReceived: number };

/** One party in a batch or a range: gross expense and revenue per counterparty, and the net cash movement. */
export type PartyBooks = {
  account: AccountId;
  /** Gross paid through settled calls: the expense to book. */
  grossOut: string;
  /** Gross received through settled calls: the revenue to book. */
  grossIn: string;
  /** Cash out of this party's escrow. */
  netDebit: string;
  /** Cash into this party's hub credit. */
  netCredit: string;
  counterparties: CounterpartyGross[];
};

export type SettlementExport = {
  object: "settlement_export";
  network: Network;
  hub: AccountId;
  token: AccountId;
  /** Inclusive start and exclusive end of the range, ISO 8601 UTC, by batch confirmation time. */
  from: string;
  to: string;
  /** The party whose books this is, or null for every party. */
  account: AccountId | null;
  generatedAt: string;
  /** `gross`, `net` and `calls` include what payees settled themselves; `sellerSettlements` counts those movements. */
  totals: { batches: number; calls: number; gross: string; net: string; sellerSettlements: number };
  /** Each party over the whole range, batches and seller settlements together. */
  parties: PartyBooks[];
  batches: Array<{ batchId: string; seq: number; confirmedAt: string; txHash: string | null; explorerUrl: string | null; gross: string; net: string; calls: number; parties: PartyBooks[] }>;
  /**
   * What payees settled themselves on the hub (`settle_own`), outside any batch, by the time the node booked it. Nothing
   * offsets: the hub moves `amount` from the owner's escrow to the payee's credit, so gross and net are the same.
   * `uncleared` is the part of `amount` for a voucher this node never accepted; it is cash moved without a cleared call.
   */
  sellerSettlements: Array<{ id: string; detectedAt: string; budgetId: string; owner: AccountId; payee: AccountId; amount: string; uncleared: string; calls: number }>;
};

type Acc = { grossOut: bigint; grossIn: bigint; netDebit: bigint; netCredit: bigint; cps: Map<AccountId, { paid: bigint; received: bigint; callsPaid: number; callsReceived: number }> };

const newAcc = (): Acc => ({ grossOut: 0n, grossIn: 0n, netDebit: 0n, netCredit: 0n, cps: new Map() });

function cp(a: Acc, who: AccountId) {
  let x = a.cps.get(who);
  if (!x) a.cps.set(who, (x = { paid: 0n, received: 0n, callsPaid: 0, callsReceived: 0 }));
  return x;
}

function booksJson(m: Map<AccountId, Acc>, only: AccountId | null): PartyBooks[] {
  return [...m.entries()]
    .filter(([account]) => only === null || account === only)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, a]) => ({
      account,
      grossOut: a.grossOut.toString(),
      grossIn: a.grossIn.toString(),
      netDebit: a.netDebit.toString(),
      netCredit: a.netCredit.toString(),
      counterparties: [...a.cps.entries()]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([counterparty, c]) => ({ counterparty, paid: c.paid.toString(), received: c.received.toString(), callsPaid: c.callsPaid, callsReceived: c.callsReceived })),
    }));
}

/**
 * Decision 9: the books of confirmed batches, with gross per counterparty next to net, so that expense and revenue are
 * booked separately from the cash movement. Gross comes from the claims the hub settled (owner pays payee), net from the
 * canonical netting result the hub checked. A party's gross out minus gross in always equals its net debit minus its
 * net credit; the export carries both so an accountant need not trust that identity.
 */
export function settlementExport(db: Database, o: { network: Network; hub: AccountId; token: AccountId; from: string; to: string; account: AccountId | null }): SettlementExport {
  const batches = db.all<{ seq: number; batch_id: string; confirmed_at: string; tx_hash: string | null; gross: string; net: string; calls: number }>(
    "SELECT seq, batch_id, confirmed_at, tx_hash, gross, net, calls FROM batches WHERE status = 'confirmed' AND confirmed_at >= ? AND confirmed_at < ? ORDER BY seq",
    o.from,
    o.to,
  );
  const range = new Map<AccountId, Acc>();
  const at = (m: Map<AccountId, Acc>, who: AccountId) => {
    let a = m.get(who);
    if (!a) m.set(who, (a = newAcc()));
    return a;
  };
  let gross = 0n;
  let net = 0n;
  let calls = 0;
  const out: SettlementExport["batches"] = [];
  for (const b of batches) {
    const per = new Map<AccountId, Acc>();
    const claims = db.all<{ owner: AccountId; payee: AccountId; delta: string; calls: number }>(
      "SELECT m.owner AS owner, c.payee AS payee, c.delta AS delta, c.calls AS calls FROM batch_claims c JOIN budgets m ON m.id = c.budget_id WHERE c.batch_seq = ? ORDER BY c.idx",
      b.seq,
    );
    for (const c of claims) {
      const amount = BigInt(c.delta);
      for (const m of [per, range]) {
        const payer = at(m, c.owner);
        payer.grossOut += amount;
        const p = cp(payer, c.payee);
        p.paid += amount;
        p.callsPaid += c.calls;
        const payee = at(m, c.payee);
        payee.grossIn += amount;
        const r = cp(payee, c.owner);
        r.received += amount;
        r.callsReceived += c.calls;
      }
    }
    for (const n of db.all<{ account: AccountId; debit: string; credit: string }>("SELECT account, debit, credit FROM batch_net WHERE batch_seq = ?", b.seq)) {
      for (const m of [per, range]) {
        const a = at(m, n.account);
        a.netDebit += BigInt(n.debit);
        a.netCredit += BigInt(n.credit);
      }
    }
    const parties = booksJson(per, o.account);
    if (o.account !== null && parties.length === 0) continue;
    gross += BigInt(b.gross);
    net += BigInt(b.net);
    calls += b.calls;
    out.push({
      batchId: b.batch_id,
      seq: b.seq,
      confirmedAt: b.confirmed_at,
      txHash: b.tx_hash,
      explorerUrl: b.tx_hash ? explorerTx(o.network, b.tx_hash) : null,
      gross: b.gross,
      net: b.net,
      calls: b.calls,
      parties,
    });
  }
  const sellerSettlements: SettlementExport["sellerSettlements"] = [];
  for (const s of db.all<{ id: string; detected_at: string; budget_id: string; owner: AccountId; payee: AccountId; delta: string; uncleared: string; calls: number }>(
    `SELECT s.id, s.detected_at, s.budget_id, m.owner AS owner, s.payee, s.delta, s.uncleared, s.calls
     FROM seller_settlements s JOIN budgets m ON m.id = s.budget_id WHERE s.detected_at >= ? AND s.detected_at < ? ORDER BY s.seq`,
    o.from,
    o.to,
  )) {
    if (o.account !== null && s.owner !== o.account && s.payee !== o.account) continue;
    const amount = BigInt(s.delta);
    const payer = at(range, s.owner);
    payer.grossOut += amount;
    payer.netDebit += amount;
    const p = cp(payer, s.payee);
    p.paid += amount;
    p.callsPaid += s.calls;
    const payee = at(range, s.payee);
    payee.grossIn += amount;
    payee.netCredit += amount;
    const r = cp(payee, s.owner);
    r.received += amount;
    r.callsReceived += s.calls;
    gross += amount;
    net += amount;
    calls += s.calls;
    sellerSettlements.push({ id: s.id, detectedAt: s.detected_at, budgetId: s.budget_id, owner: s.owner, payee: s.payee, amount: s.delta, uncleared: s.uncleared, calls: s.calls });
  }
  return {
    object: "settlement_export",
    network: o.network,
    hub: o.hub,
    token: o.token,
    from: o.from,
    to: o.to,
    account: o.account,
    generatedAt: new Date().toISOString(),
    totals: { batches: out.length, calls, gross: gross.toString(), net: net.toString(), sellerSettlements: sellerSettlements.length },
    parties: booksJson(range, o.account),
    batches: out,
    sellerSettlements,
  };
}

export const SETTLEMENT_CSV_COLUMNS = ["batch_id", "confirmed_at", "tx_hash", "account", "line", "counterparty", "expense", "revenue", "calls", "net_debit", "net_credit"] as const;

/**
 * One `gross` line per (batch, party, counterparty) with the expense and revenue to book, then one `net` line per
 * (batch, party) with the cash movement. Amounts are atomic token units. What a payee settled itself follows as the
 * same two lines per party, with the seller settlement id (`sst_...`) in the batch column and no transaction hash.
 */
export function settlementExportCsv(e: SettlementExport): string {
  const lines = [SETTLEMENT_CSV_COLUMNS.join(",")];
  const row = (cells: Array<string | number | null>) => lines.push(cells.map(reportCsvCell).join(","));
  for (const b of e.batches) {
    for (const p of b.parties) {
      for (const c of p.counterparties) row([b.batchId, b.confirmedAt, b.txHash, p.account, "gross", c.counterparty, c.paid, c.received, c.callsPaid + c.callsReceived, null, null]);
      row([b.batchId, b.confirmedAt, b.txHash, p.account, "net", null, null, null, null, p.netDebit, p.netCredit]);
    }
  }
  for (const s of e.sellerSettlements) {
    if (e.account === null || e.account === s.owner) {
      row([s.id, s.detectedAt, null, s.owner, "gross", s.payee, s.amount, "0", s.calls, null, null]);
      row([s.id, s.detectedAt, null, s.owner, "net", null, null, null, null, s.amount, "0"]);
    }
    if (e.account === null || e.account === s.payee) {
      row([s.id, s.detectedAt, null, s.payee, "gross", s.owner, "0", s.amount, s.calls, null, null]);
      row([s.id, s.detectedAt, null, s.payee, "net", null, null, null, null, "0", s.amount]);
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}
