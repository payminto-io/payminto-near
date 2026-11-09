import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export type Row = Record<string, SQLInputValue>;

/**
 * Thin wrapper over node:sqlite with WAL, foreign keys, numbered forward-only migrations,
 * a bigint-safe `bigsum` aggregate, and synchronous BEGIN IMMEDIATE transactions with after-commit hooks.
 */
export class Database {
  readonly raw: DatabaseSync;
  readonly path: string;
  #depth = 0;
  #afterCommit: Array<() => void> = [];

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    // Sums decimal-text atomic amounts exactly; SQLite's SUM would go through int64/float.
    this.raw.aggregate("bigsum", {
      start: () => 0n,
      step: (acc: bigint, v: SQLInputValue) => (v === null || v === undefined ? acc : acc + BigInt(v as string)),
      result: (acc: bigint) => acc.toString(),
    });
  }

  migrate(dir = MIGRATIONS_DIR): number {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.raw.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
    );
    const files = readdirSync(dir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    let count = 0;
    for (const file of files) {
      const version = parseInt(file, 10);
      if (applied.has(version)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      // A migration that rebuilds a referenced table must run with foreign keys off (SQLite's 12-step procedure).
      // The pragma is a no-op inside a transaction, so it is switched around it, and the result is checked before commit.
      const fkOff = /^-- migrate: foreign-keys-off\s*$/m.test(sql.split("\n", 1)[0] ?? "");
      if (fkOff) this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.tx(() => {
          this.raw.exec(sql);
          if (fkOff) {
            const broken = this.all<Record<string, unknown>>("PRAGMA foreign_key_check");
            if (broken.length) throw new Error(`migration ${file} breaks ${broken.length} foreign key reference(s)`);
          }
          this.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", version, file, new Date().toISOString());
        });
      } finally {
        if (fkOff) this.raw.exec("PRAGMA foreign_keys = ON");
      }
      count++;
    }
    return count;
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /**
   * Runs fn inside BEGIN IMMEDIATE (nested calls join the outer transaction).
   * fn must be synchronous, so no other request can interleave in this process,
   * and the write lock keeps other processes out.
   */
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return fn();
      } finally {
        this.#depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error("Database.tx callback must be synchronous");
      this.raw.exec("COMMIT");
    } catch (err) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      this.#afterCommit = [];
      throw err;
    } finally {
      this.#depth = 0;
    }
    const hooks = this.#afterCommit;
    this.#afterCommit = [];
    for (const h of hooks) h();
    return result;
  }

  /** Runs hook after the current transaction commits, or immediately when there is none. */
  afterCommit(hook: () => void): void {
    if (this.#depth > 0) this.#afterCommit.push(hook);
    else hook();
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}
