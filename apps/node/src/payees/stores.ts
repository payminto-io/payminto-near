/**
 * The payee check's stores, kept in the node's own database (migration 006): the blocklist of reports, the code each
 * account ran when the check last looked, and the node's call records as the payment history. They implement the
 * interfaces of @payminto/payee-check, so the judgment itself stays in the package.
 */
import { REPORT_LIMITS, StoreError, nextCodeRecord, parseReportInput, reportSchema, type Blocklist, type CodeRecord, type CodeStore, type HistorySource, type Report, type ReportInput } from "@payminto/payee-check";
import type { AccountId } from "@payminto/protocol";
import type { Database } from "../db/database.ts";

/** Who filed a report through this node's API. Absent for reports that came from a shared list. */
export type FiledBy = { type: string; id: string | null };

type ReportRow = { account: string; reporter: string; reason: string; evidence: string; at_ms: number; filed_by_type: string | null; filed_by_id: string | null };

const reportOf = (r: ReportRow): Report => reportSchema.parse({ account: r.account, reporter: r.reporter, reason: r.reason, evidence: JSON.parse(r.evidence), atMs: r.at_ms });

/**
 * The blocklist in SQLite. Every report is validated when it is filed and again when it is read, as the package's own
 * stores do: a row that no longer validates is an error, never a silent pass.
 */
export class SqliteBlocklist implements Blocklist {
  readonly #db: Database;
  readonly #clock: () => number;

  constructor(db: Database, clock: () => number = Date.now) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Files one report. A reporter holds one report per account, so filing again replaces the earlier one. */
  async report(input: ReportInput, filedBy?: FiledBy): Promise<Report> {
    return this.file(input, filedBy);
  }

  file(input: ReportInput, filedBy?: FiledBy): Report {
    const added: Report = { ...parseReportInput(input), atMs: this.#clock() };
    return this.#db.tx(() => {
      const others = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payee_reports WHERE account = ? AND reporter != ?", added.account, added.reporter)!.n;
      if (others >= REPORT_LIMITS.perAccount) throw new StoreError("account_full", `${added.account} already has ${REPORT_LIMITS.perAccount} reports`);
      this.#db.run(
        `INSERT INTO payee_reports (account, reporter, reason, evidence, at_ms, filed_by_type, filed_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account, reporter) DO UPDATE SET reason = excluded.reason, evidence = excluded.evidence, at_ms = excluded.at_ms,
           filed_by_type = excluded.filed_by_type, filed_by_id = excluded.filed_by_id`,
        added.account,
        added.reporter,
        added.reason,
        JSON.stringify(added.evidence),
        added.atMs,
        filedBy?.type ?? null,
        filedBy?.id ?? null,
      );
      return added;
    });
  }

  async reportsFor(account: AccountId): Promise<Report[]> {
    return this.rows(account).map((r) => r.report);
  }

  /** Reports against one account, oldest first, each with who filed it here. */
  rows(account: AccountId, limit: number = REPORT_LIMITS.perAccount): Array<{ report: Report; filedBy: FiledBy | null }> {
    return this.#db
      .all<ReportRow>("SELECT * FROM payee_reports WHERE account = ? ORDER BY at_ms, reporter LIMIT ?", account, limit)
      .map((r) => ({ report: reportOf(r), filedBy: r.filed_by_type ? { type: r.filed_by_type, id: r.filed_by_id } : null }));
  }

  /** The latest reports against any account, newest first. */
  latest(limit: number): Array<{ report: Report; filedBy: FiledBy | null }> {
    return this.#db
      .all<ReportRow>("SELECT * FROM payee_reports ORDER BY at_ms DESC, account, reporter LIMIT ?", limit)
      .map((r) => ({ report: reportOf(r), filedBy: r.filed_by_type ? { type: r.filed_by_type, id: r.filed_by_id } : null }));
  }
}

type CodeRow = { contract_id: string | null; first_seen_at_ms: number; changed_at_ms: number | null; previous_contract_id: string | null };

const recordOf = (r: CodeRow): CodeRecord => ({ contractId: r.contract_id, firstSeenAtMs: r.first_seen_at_ms, changedAtMs: r.changed_at_ms, previousContractId: r.previous_contract_id });

/** The code store in SQLite: what each account ran at the latest look, and when a look first found it changed. */
export class SqliteCodeStore implements CodeStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #get(account: AccountId): CodeRecord | null {
    const r = this.#db.get<CodeRow>("SELECT contract_id, first_seen_at_ms, changed_at_ms, previous_contract_id FROM payee_code_seen WHERE account = ?", account);
    return r ? recordOf(r) : null;
  }

  async get(account: AccountId): Promise<CodeRecord | null> {
    return this.#get(account);
  }

  async observe(account: AccountId, contractId: string | null, nowMs: number): Promise<CodeRecord> {
    return this.#db.tx(() => {
      const next = nextCodeRecord(this.#get(account), contractId, nowMs);
      this.#db.run(
        `INSERT INTO payee_code_seen (account, contract_id, first_seen_at_ms, changed_at_ms, previous_contract_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account) DO UPDATE SET contract_id = excluded.contract_id, changed_at_ms = excluded.changed_at_ms, previous_contract_id = excluded.previous_contract_id`,
        account,
        next.contractId,
        next.firstSeenAtMs,
        next.changedAtMs,
        next.previousContractId,
      );
      return next;
    });
  }
}

/** What an owner's Budgets have paid a payee, from the node's own accepted calls. */
export function callHistory(db: Database): HistorySource {
  return {
    async paymentsBetween(payer, payee) {
      const r = db.get<{ n: number; total: string; last: number | null }>(
        `SELECT COUNT(*) AS n, bigsum(c.amount) AS total, MAX(c.timestamp) AS last
         FROM calls c JOIN budgets b ON b.id = c.budget_id WHERE b.owner = ? AND c.payee = ?`,
        payer,
        payee,
      )!;
      return { count: r.n, total: BigInt(r.total), lastAtMs: r.last === null ? null : r.last * 1000 };
    },
  };
}
