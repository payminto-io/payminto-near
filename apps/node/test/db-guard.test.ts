import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Database, LegacySchemaError, MIGRATIONS_DIR } from "../src/db/database.ts";
import { DISPOSABLE_FLAG, assertDisposableTarget, isDisposableTarget } from "../src/db/guard.ts";
import { tempDir } from "./helpers.ts";

// Every database here lives in a fresh OS temp dir: the guard under test protects everything else.
const tmp = tempDir("payminto-guard-");
afterAll(() => tmp.cleanup());

describe("disposable target guard", () => {
  it("accepts temp dirs, *.test.db, *.demo.db and :memory:", () => {
    expect(isDisposableTarget(join(tmp.dir, "x.db")).ok).toBe(true);
    expect(isDisposableTarget("/srv/data/clearing.test.db").ok).toBe(true);
    expect(isDisposableTarget("/srv/data/clearing.demo.db").ok).toBe(true);
    expect(isDisposableTarget(":memory:").ok).toBe(true);
  });

  it("refuses the node's real database path unless the run says it is disposable", () => {
    const real = join(homedir(), "payminto-data", "clearing.db");
    expect(isDisposableTarget(real).ok).toBe(false);
    expect(() => assertDisposableTarget(real)).toThrow(/Refusing to reset or seed/);
    expect(() => assertDisposableTarget(real, [DISPOSABLE_FLAG])).not.toThrow();
  });

  it("is not fooled by a .test.db directory name or a lookalike suffix", () => {
    expect(isDisposableTarget("/srv/clearing.test.db/real.db").ok).toBe(false);
    expect(isDisposableTarget("/srv/clearing.test.db.bak").ok).toBe(false);
  });
});

describe("startup schema check", () => {
  it("migrates a fresh database to the NEAR schema with the zero fee plan", () => {
    const db = new Database(join(tmp.dir, "fresh.test.db"));
    const shipped = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    expect(shipped[0]).toBe("001_near.sql");
    expect(db.migrate()).toBe(shipped.length);
    expect(db.migrate()).toBe(0);
    expect(db.all<{ name: string }>("SELECT name FROM schema_migrations ORDER BY version").map((r) => r.name)).toEqual(shipped);
    expect(db.get<{ platform_fee_bps: number }>("SELECT platform_fee_bps FROM fee_plans WHERE id = 'fp_zero'")).toEqual({ platform_fee_bps: 0 });
    for (const gone of ["hsp_quotes", "hsp_payments", "payment_forwarders", "payment_relays", "gateway_cursors", "wallet_logins", "siwe_nonces"]) {
      expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", gone)).toBeUndefined();
    }
    for (const kept of ["budgets", "oneclick_quotes", "batch_net", "fee_plans"]) {
      expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", kept)).toBeDefined();
    }
    db.close();
  });

  it("migrates a database created by 001 forward and keeps every row", () => {
    // A database as an earlier build left it: only 001 applied, with a call and its journal in it.
    const only001 = join(tmp.dir, "migrations-001");
    mkdirSync(only001, { recursive: true });
    copyFileSync(join(MIGRATIONS_DIR, "001_near.sql"), join(only001, "001_near.sql"));
    const path = join(tmp.dir, "upgrade.test.db");
    const old = new Database(path);
    expect(old.migrate(only001)).toBe(1);
    old.run(
      "INSERT INTO budgets (id, owner, agent, settler, cap, valid_until_ms, policy_hash, salt, policy, payees, label, status, created_at) VALUES ('b1', 'o.testnet', 'ed25519:k', 'n.testnet', '10', 1, 'h', 's', '{}', '[]', 'l', 'open', 'now')",
    );
    old.run("INSERT INTO providers (id, name, description, payee, price_atomic, resource, category, api_key_hash, created_at) VALUES ('p1', 'p', '', 's.testnet', '1', 'r', 'api', 'kh', 'now')");
    old.run(
      "INSERT INTO calls (call_id, budget_id, agent, payee, provider_id, amount, cumulative, request_hash, agent_signature, timestamp, leaf, node_signature, status, accepted_at) VALUES ('c1', 'b1', 'ed25519:k', 's.testnet', 'p1', '1', '1', 'rh', 'sig', 5, 'leaf', 'nsig', 'accepted', 'now')",
    );
    for (const kind of ["call.accepted", "batch.settled"]) {
      const { lastInsertRowid: j } = old.run("INSERT INTO journals (kind, ref, memo, at) VALUES (?, 'c1', 'm', 'now')", kind);
      old.run("INSERT INTO ledger_entries (journal_id, account, debit, credit, memo, at) VALUES (?, 'a', '1', '0', 'm', 'now'), (?, 'b', '0', '1', 'm', 'now')", j, j);
    }
    old.close();

    const db = new Database(path);
    const shipped = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f));
    expect(db.migrate()).toBe(shipped.length - 1);
    expect(db.get("SELECT call_id, status, request_part, seller_settlement_seq FROM calls")).toEqual({ call_id: "c1", status: "accepted", request_part: 0, seller_settlement_seq: null });
    expect(db.all("SELECT id, kind, ref FROM journals ORDER BY id")).toEqual([
      { id: 1, kind: "call.accepted", ref: "c1" },
      { id: 2, kind: "batch.settled", ref: "c1" },
    ]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_entries e JOIN journals j ON j.id = e.journal_id")!.n).toBe(4);
    // The rebuilt journal table takes the new kind, still refuses unknown ones, keeps counting ids and is still referenced.
    expect(db.run("INSERT INTO journals (kind, ref, memo, at) VALUES ('seller.settled', 'sst_1', 'm', 'now')").lastInsertRowid).toBe(3);
    expect(() => db.run("INSERT INTO journals (kind, ref, memo, at) VALUES ('made.up', 'x', 'm', 'now')")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO ledger_entries (journal_id, account, debit, credit, memo, at) VALUES (999, 'a', '1', '0', 'm', 'now')")).toThrow(/FOREIGN KEY/);
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.close();
  });

  it("refuses a database with older migration entries and leaves it untouched", () => {
    const path = join(tmp.dir, "legacy.test.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    raw.exec("INSERT INTO schema_migrations VALUES (1, '001_init.sql', 'then'), (12, '012_ai_connections_replicate.sql', 'then')");
    raw.exec("CREATE TABLE legacy_rows (id TEXT PRIMARY KEY)");
    raw.exec("INSERT INTO legacy_rows VALUES ('keep-me')");
    raw.close();

    const db = new Database(path);
    expect(() => db.migrate()).toThrow(LegacySchemaError);
    expect(() => db.migrate()).toThrow(/001_init\.sql.*never drops/s);
    db.close();

    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT id FROM legacy_rows").all()).toEqual([{ id: "keep-me" }]);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'budgets'").all()).toEqual([]);
    after.close();
  });

  it("refuses a database whose schema has an entry from a newer file that this build does not ship", () => {
    const dir = join(tmp.dir, "migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001_near.sql"), "CREATE TABLE t (x INTEGER);");
    const db = new Database(join(tmp.dir, "ahead.test.db"));
    db.migrate(dir);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, '002_future.sql', 'now')");
    expect(() => db.migrate(dir)).toThrow(/002_future\.sql/);
    db.close();
    expect(existsSync(join(tmp.dir, "ahead.test.db"))).toBe(true);
  });
});
