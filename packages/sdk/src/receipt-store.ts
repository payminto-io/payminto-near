import type { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import type { ClearingReceipt } from "@payminto/protocol";

/**
 * What an agent must remember to stay safe across calls, restarts and processes:
 * - the receipts it was given (they justify, or refuse, HSP co-sign requests),
 * - the highest cumulative it has signed per (mandate, payee), so it never trusts a position it did not sign,
 * - how much of each settlement batch it has already co-signed, so a receipt never justifies two batches.
 *
 * Two processes that share one agent key must share one store (the SQLite store supports that through WAL);
 * otherwise each sees the other's vouchers as an unverified position and refuses to sign (POSITION_UNVERIFIED).
 */
export interface ReceiptStore {
  add(receipt: ClearingReceipt): void;
  get(callId: Hex): ClearingReceipt | undefined;
  all(): ClearingReceipt[];
  /** Highest cumulative this agent has signed for (mandate, payee); 0n when it never signed one. */
  signedPosition(mandateId: Hex, payee: Address): bigint;
  /** Every signed high-water mark of a mandate, keyed by lowercase payee address. */
  signedPositions(mandateId: Hex): Map<string, bigint>;
  /**
   * Raises the (mandate, payee) high-water mark to `cumulative`; never lowers it.
   * Called before the voucher is signed, so it must be durable when it returns.
   */
  recordSigned(mandateId: Hex, payee: Address, cumulative: bigint): void;
  /** Settlement batch a receipt was already used to justify a co-signature for. */
  batchOf(callId: Hex): string | undefined;
  /** Total HSP amount this agent co-signed for a batch. */
  cosignedInBatch(batchId: Hex): bigint;
  /** Records a co-signature: adds `amount` to the batch total and binds the receipts to the batch. */
  recordCosign(batchId: Hex, amount: bigint, callIds: readonly Hex[]): void;
  close?(): void;
}

const k = (v: string) => v.toLowerCase();

/** In-process store. Everything is lost on restart: use SqliteReceiptStore (AgentClient `storePath`) in production. */
export class MemoryReceiptStore implements ReceiptStore {
  readonly #receipts = new Map<string, ClearingReceipt>();
  readonly #signed = new Map<string, Map<string, bigint>>();
  readonly #callBatch = new Map<string, string>();
  readonly #cosigned = new Map<string, bigint>();

  add(r: ClearingReceipt) {
    this.#receipts.set(k(r.callId), r);
  }
  get(id: Hex) {
    return this.#receipts.get(k(id));
  }
  all() {
    return [...this.#receipts.values()];
  }
  signedPosition(mandateId: Hex, payee: Address): bigint {
    return this.#signed.get(k(mandateId))?.get(k(payee)) ?? 0n;
  }
  signedPositions(mandateId: Hex): Map<string, bigint> {
    return new Map(this.#signed.get(k(mandateId)) ?? []);
  }
  recordSigned(mandateId: Hex, payee: Address, cumulative: bigint): void {
    let m = this.#signed.get(k(mandateId));
    if (!m) this.#signed.set(k(mandateId), (m = new Map()));
    if (cumulative > (m.get(k(payee)) ?? 0n)) m.set(k(payee), cumulative);
  }
  batchOf(callId: Hex) {
    return this.#callBatch.get(k(callId));
  }
  cosignedInBatch(batchId: Hex): bigint {
    return this.#cosigned.get(k(batchId)) ?? 0n;
  }
  recordCosign(batchId: Hex, amount: bigint, callIds: readonly Hex[]): void {
    this.#cosigned.set(k(batchId), this.cosignedInBatch(batchId) + amount);
    for (const c of callIds) this.#callBatch.set(k(c), k(batchId));
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
            mandate_id TEXT NOT NULL,
            receipt TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS signed_positions (
            mandate_id TEXT NOT NULL,
            payee TEXT NOT NULL,
            cumulative TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (mandate_id, payee)
          );
          CREATE TABLE IF NOT EXISTS cosigned_batches (batch_id TEXT PRIMARY KEY, amount TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS call_batches (call_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL);
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
      .prepare("INSERT INTO receipts (call_id, mandate_id, receipt) VALUES (?, ?, ?) ON CONFLICT(call_id) DO NOTHING")
      .run(k(r.callId), k(r.mandateId), JSON.stringify(r));
  }

  get(callId: Hex): ClearingReceipt | undefined {
    const row = this.#db.prepare("SELECT receipt FROM receipts WHERE call_id = ?").get(k(callId)) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as ClearingReceipt) : undefined;
  }

  all(): ClearingReceipt[] {
    return (this.#db.prepare("SELECT receipt FROM receipts ORDER BY seq").all() as Array<{ receipt: string }>).map(
      (r) => JSON.parse(r.receipt) as ClearingReceipt,
    );
  }

  signedPosition(mandateId: Hex, payee: Address): bigint {
    const row = this.#db
      .prepare("SELECT cumulative FROM signed_positions WHERE mandate_id = ? AND payee = ?")
      .get(k(mandateId), k(payee)) as { cumulative: string } | undefined;
    return row ? BigInt(row.cumulative) : 0n;
  }

  signedPositions(mandateId: Hex): Map<string, bigint> {
    const rows = this.#db.prepare("SELECT payee, cumulative FROM signed_positions WHERE mandate_id = ?").all(k(mandateId)) as Array<{
      payee: string;
      cumulative: string;
    }>;
    return new Map(rows.map((r) => [r.payee, BigInt(r.cumulative)]));
  }

  recordSigned(mandateId: Hex, payee: Address, cumulative: bigint): void {
    this.#tx(() => {
      // Decimal text compared as bigint in JS: SQLite integers stop at int64.
      if (cumulative <= this.signedPosition(mandateId, payee)) return;
      this.#db
        .prepare(
          `INSERT INTO signed_positions (mandate_id, payee, cumulative, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(mandate_id, payee) DO UPDATE SET cumulative = excluded.cumulative, updated_at = excluded.updated_at`,
        )
        .run(k(mandateId), k(payee), cumulative.toString(), new Date().toISOString());
    });
  }

  batchOf(callId: Hex): string | undefined {
    const row = this.#db.prepare("SELECT batch_id FROM call_batches WHERE call_id = ?").get(k(callId)) as { batch_id: string } | undefined;
    return row?.batch_id;
  }

  cosignedInBatch(batchId: Hex): bigint {
    const row = this.#db.prepare("SELECT amount FROM cosigned_batches WHERE batch_id = ?").get(k(batchId)) as { amount: string } | undefined;
    return row ? BigInt(row.amount) : 0n;
  }

  recordCosign(batchId: Hex, amount: bigint, callIds: readonly Hex[]): void {
    this.#tx(() => {
      const total = this.cosignedInBatch(batchId) + amount;
      this.#db
        .prepare("INSERT INTO cosigned_batches (batch_id, amount) VALUES (?, ?) ON CONFLICT(batch_id) DO UPDATE SET amount = excluded.amount")
        .run(k(batchId), total.toString());
      const bind = this.#db.prepare("INSERT INTO call_batches (call_id, batch_id) VALUES (?, ?) ON CONFLICT(call_id) DO NOTHING");
      for (const c of callIds) bind.run(k(c), k(batchId));
    });
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
