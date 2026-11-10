import type { DatabaseSync } from "node:sqlite";
import type { AccountId, ClearingReceipt, Id32 } from "@payminto/protocol";

/**
 * What an agent must remember to stay safe across calls, restarts and processes:
 * - the receipts it was given, which it can later prove against a batch root,
 * - the highest cumulative it has signed per (budget, payee), so it never trusts a position it did not sign.
 *
 * Two processes that share one agent key must share one store (the SQLite store supports that through WAL);
 * otherwise each sees the other's vouchers as an unverified position and refuses to sign (POSITION_UNVERIFIED).
 */
export interface ReceiptStore {
  add(receipt: ClearingReceipt): void;
  get(callId: Id32): ClearingReceipt | undefined;
  all(): ClearingReceipt[];
  /** Highest cumulative this agent has signed for (budget, payee); 0n when it never signed one. */
  signedPosition(budgetId: Id32, payee: AccountId): bigint;
  /** Every signed high-water mark of a budget, keyed by payee account. */
  signedPositions(budgetId: Id32): Map<string, bigint>;
  /**
   * Raises the (budget, payee) high-water mark to `cumulative`; never lowers it.
   * Called before the voucher is signed, so it must be durable when it returns.
   */
  recordSigned(budgetId: Id32, payee: AccountId, cumulative: bigint): void;
  close?(): void;
}

/** In-process store. Everything is lost on restart: use SqliteReceiptStore (AgentClient `storePath`) in production. */
export class MemoryReceiptStore implements ReceiptStore {
  readonly #receipts = new Map<string, ClearingReceipt>();
  readonly #signed = new Map<string, Map<string, bigint>>();

  add(r: ClearingReceipt) {
    this.#receipts.set(r.callId, r);
  }
  get(id: Id32) {
    return this.#receipts.get(id);
  }
  all() {
    return [...this.#receipts.values()];
  }
  signedPosition(budgetId: Id32, payee: AccountId): bigint {
    return this.#signed.get(budgetId)?.get(payee) ?? 0n;
  }
  signedPositions(budgetId: Id32): Map<string, bigint> {
    return new Map(this.#signed.get(budgetId) ?? []);
  }
  recordSigned(budgetId: Id32, payee: AccountId, cumulative: bigint): void {
    let m = this.#signed.get(budgetId);
    if (!m) this.#signed.set(budgetId, (m = new Map()));
    if (cumulative > (m.get(payee) ?? 0n)) m.set(payee, cumulative);
  }
}

const SCHEMA_VERSION = 1;

/**
 * Durable ReceiptStore on a node:sqlite file in WAL mode with synchronous=FULL, so a signed high-water mark survives
 * a crash. Safe to share between processes of the same agent: every read goes to the file, and writes that must
 * not lose updates run in BEGIN IMMEDIATE transactions. It never deletes or rewrites history.
 */
export class SqliteReceiptStore implements ReceiptStore {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    // Node built-ins are loaded at runtime, so importing the SDK in a browser or edge runtime stays possible.
    const builtin = typeof process !== "undefined" ? process.getBuiltinModule : undefined;
    const sqlite = builtin?.("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!builtin || !sqlite) throw new Error("SqliteReceiptStore needs Node.js with node:sqlite (>= 22.13)");
    const fs = builtin("node:fs") as typeof import("node:fs");
    const nodePath = builtin("node:path") as typeof import("node:path");
    this.path = path;
    if (path !== ":memory:") fs.mkdirSync(nodePath.dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new sqlite.DatabaseSync(path);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL");
    const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) throw new Error(`${path}: receipt store schema ${version} is newer than this SDK (${SCHEMA_VERSION})`);
    if (version < SCHEMA_VERSION) {
      this.#tx(() => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS receipts (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id TEXT NOT NULL UNIQUE,
            budget_id TEXT NOT NULL,
            receipt TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS signed_positions (
            budget_id TEXT NOT NULL,
            payee TEXT NOT NULL,
            cumulative TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (budget_id, payee)
          );
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      });
    }
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  add(r: ClearingReceipt): void {
    this.#db
      .prepare("INSERT INTO receipts (call_id, budget_id, receipt) VALUES (?, ?, ?) ON CONFLICT(call_id) DO NOTHING")
      .run(r.callId, r.budgetId, JSON.stringify(r));
  }

  get(callId: Id32): ClearingReceipt | undefined {
    const row = this.#db.prepare("SELECT receipt FROM receipts WHERE call_id = ?").get(callId) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as ClearingReceipt) : undefined;
  }

  all(): ClearingReceipt[] {
    return (this.#db.prepare("SELECT receipt FROM receipts ORDER BY seq").all() as Array<{ receipt: string }>).map(
      (r) => JSON.parse(r.receipt) as ClearingReceipt,
    );
  }

  signedPosition(budgetId: Id32, payee: AccountId): bigint {
    const row = this.#db
      .prepare("SELECT cumulative FROM signed_positions WHERE budget_id = ? AND payee = ?")
      .get(budgetId, payee) as { cumulative: string } | undefined;
    return row ? BigInt(row.cumulative) : 0n;
  }

  signedPositions(budgetId: Id32): Map<string, bigint> {
    const rows = this.#db.prepare("SELECT payee, cumulative FROM signed_positions WHERE budget_id = ?").all(budgetId) as Array<{
      payee: string;
      cumulative: string;
    }>;
    return new Map(rows.map((r) => [r.payee, BigInt(r.cumulative)]));
  }

  recordSigned(budgetId: Id32, payee: AccountId, cumulative: bigint): void {
    this.#tx(() => {
      // Decimal text compared as bigint in JS: SQLite integers stop at int64.
      if (cumulative <= this.signedPosition(budgetId, payee)) return;
      this.#db
        .prepare(
          `INSERT INTO signed_positions (budget_id, payee, cumulative, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(budget_id, payee) DO UPDATE SET cumulative = excluded.cumulative, updated_at = excluded.updated_at`,
        )
        .run(budgetId, payee, cumulative.toString(), new Date().toISOString());
    });
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
