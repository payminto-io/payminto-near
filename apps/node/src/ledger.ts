import { getAddress, type Address } from "viem";
import type { Database } from "./db/database.ts";
import { nowIso, type LedgerEntryRow } from "./store.ts";

export type JournalKind = "call.accepted" | "batch.settled";
export type Posting = { account: string; debit?: bigint; credit?: bigint; memo?: string };

export const accounts = {
  agentPayable: (a: Address) => `agent:${getAddress(a)}:payable`,
  agentWallet: (a: Address) => `agent:${getAddress(a)}:wallet`,
  providerReceivable: (a: Address) => `provider:${getAddress(a)}:receivable`,
  providerWallet: (a: Address) => `provider:${getAddress(a)}:wallet`,
};

export class UnbalancedJournalError extends Error {}

/**
 * Double-entry ledger (SPEC 5.8). Every journal must balance before it is written, so the trial balance
 * is zero by construction; the trial-balance endpoint recomputes it from the entries to prove it.
 */
export class Ledger {
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  post(kind: JournalKind, ref: string, memo: string, postings: readonly Posting[]): number {
    let debits = 0n;
    let credits = 0n;
    for (const p of postings) {
      const d = p.debit ?? 0n;
      const c = p.credit ?? 0n;
      if (d < 0n || c < 0n) throw new UnbalancedJournalError("negative posting");
      if ((d === 0n) === (c === 0n)) throw new UnbalancedJournalError("a posting must have exactly one of debit or credit");
      debits += d;
      credits += c;
    }
    if (postings.length < 2 || debits !== credits) {
      throw new UnbalancedJournalError(`journal ${kind} ${ref} does not balance: debits ${debits} credits ${credits}`);
    }
    return this.#db.tx(() => {
      const at = nowIso();
      const { lastInsertRowid: journalId } = this.#db.run(
        "INSERT INTO journals (kind, ref, memo, at) VALUES (?, ?, ?, ?)",
        kind,
        ref,
        memo,
        at,
      );
      for (const p of postings) {
        this.#db.run(
          "INSERT INTO ledger_entries (journal_id, account, debit, credit, memo, at) VALUES (?, ?, ?, ?, ?, ?)",
          journalId,
          p.account,
          (p.debit ?? 0n).toString(),
          (p.credit ?? 0n).toString(),
          p.memo ?? memo,
          at,
        );
      }
      return journalId;
    });
  }

  entries(f: { account?: string; limit: number; cursor?: number }) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (f.account) {
      // Exact account, or a prefix such as "agent:0xabc" to see all of a party's accounts.
      where.push("(e.account = ? OR e.account LIKE ?)");
      params.push(f.account, `${f.account}:%`);
    }
    if (f.cursor !== undefined) (where.push("e.id < ?"), params.push(f.cursor));
    const rows = this.#db.all<LedgerEntryRow>(
      `SELECT e.*, j.kind AS kind, j.ref AS ref FROM ledger_entries e JOIN journals j ON j.id = e.journal_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.id DESC LIMIT ?`,
      ...params,
      f.limit,
    );
    return rows.map((r) => ({
      id: r.id,
      journalId: r.journal_id,
      kind: r.kind,
      ref: r.ref,
      account: r.account,
      debit: r.debit,
      credit: r.credit,
      memo: r.memo,
      createdAt: r.at,
    }));
  }

  trialBalance() {
    const rows = this.#db.all<{ account: string; debit: string; credit: string }>(
      "SELECT account, bigsum(debit) AS debit, bigsum(credit) AS credit FROM ledger_entries GROUP BY account ORDER BY account",
    );
    let totalDebit = 0n;
    let totalCredit = 0n;
    const accountsOut = rows.map((r) => {
      const d = BigInt(r.debit);
      const c = BigInt(r.credit);
      totalDebit += d;
      totalCredit += c;
      return { account: r.account, debit: r.debit, credit: r.credit, balance: (d - c).toString() };
    });
    const journals = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journals")!.n;
    return {
      balanced: totalDebit === totalCredit,
      totalDebit: totalDebit.toString(),
      totalCredit: totalCredit.toString(),
      /** Total debits minus total credits: always "0". */
      balance: (totalDebit - totalCredit).toString(),
      journals,
      accounts: accountsOut,
    };
  }
}
