import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database, MIGRATIONS_DIR } from "../src/db/database.ts";
import { DISPOSABLE_FLAG, assertDisposableTarget, isDisposableTarget } from "../src/db/guard.ts";
import { accounts, Ledger, UnbalancedJournalError } from "../src/ledger.ts";
import { tempDir } from "./helpers.ts";

const tmp = tempDir("payminto-storage-");
const MIGRATION_COUNT = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).length;
afterAll(() => tmp.cleanup());

const AGENT = "agent-owner.testnet";
const PROVIDER = "provider.testnet";

describe("database", () => {
  it("migrates once, in WAL mode with foreign keys on", () => {
    const db = new Database(join(tmp.dir, "a.test.db"));
    expect(db.migrate()).toBe(MIGRATION_COUNT);
    expect(db.migrate()).toBe(0);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
    db.close();
  });

  it("sums decimal-text amounts beyond int64 exactly", () => {
    const db = new Database(":memory:");
    db.raw.exec("CREATE TABLE t (v TEXT)");
    for (const v of ["9223372036854775807", "9223372036854775807", "1"]) db.run("INSERT INTO t VALUES (?)", v);
    expect(db.get<{ s: string }>("SELECT bigsum(v) AS s FROM t")!.s).toBe("18446744073709551615");
    db.close();
  });

  it("rolls back a failed transaction and publishes after-commit hooks only on commit", () => {
    const db = new Database(":memory:");
    db.raw.exec("CREATE TABLE t (v INTEGER)");
    const fired: string[] = [];
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t VALUES (1)");
        db.afterCommit(() => fired.push("rolled-back"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    db.tx(() => {
      db.run("INSERT INTO t VALUES (2)");
      db.tx(() => db.run("INSERT INTO t VALUES (3)")); // nested joins the outer transaction
      db.afterCommit(() => fired.push("committed"));
    });
    expect(db.all<{ v: number }>("SELECT v FROM t ORDER BY v").map((r) => r.v)).toEqual([2, 3]);
    expect(fired).toEqual(["committed"]);
    expect(() => db.tx(() => Promise.resolve(1) as unknown as number)).toThrow(/synchronous/);
    db.close();
  });
});

describe("ledger", () => {
  const db = new Database(join(tmp.dir, "ledger.test.db"));
  db.migrate();
  const ledger = new Ledger(db);

  it("posts balanced journals and the trial balance stays at zero", () => {
    ledger.post("call.accepted", "c1", "call", [
      { account: accounts.providerReceivable(PROVIDER), debit: 2_000n },
      { account: accounts.ownerPayable(AGENT), credit: 2_000n },
    ]);
    ledger.post("call.accepted", "c2", "call", [
      { account: accounts.providerReceivable(PROVIDER), debit: 3_000n },
      { account: accounts.ownerPayable(AGENT), credit: 3_000n },
    ]);
    ledger.post("batch.settled", "b1", "batch", [
      { account: accounts.ownerPayable(AGENT), debit: 5_000n },
      { account: accounts.providerReceivable(PROVIDER), credit: 5_000n },
      { account: accounts.providerCredit(PROVIDER), debit: 5_000n },
      { account: accounts.ownerEscrow(AGENT), credit: 5_000n },
    ]);
    const tb = ledger.trialBalance();
    expect(tb).toMatchObject({ balanced: true, balance: "0", totalDebit: "15000", totalCredit: "15000", journals: 3 });
    const byAccount = Object.fromEntries(tb.accounts.map((a) => [a.account, a.balance]));
    expect(byAccount[accounts.ownerPayable(AGENT)]).toBe("0");
    expect(byAccount[accounts.providerReceivable(PROVIDER)]).toBe("0");
    expect(byAccount[accounts.providerCredit(PROVIDER)]).toBe("5000");
    expect(byAccount[accounts.ownerEscrow(AGENT)]).toBe("-5000");
  });

  it("refuses unbalanced, one-sided, negative or single-line journals and writes nothing", () => {
    const before = ledger.trialBalance().journals;
    expect(() =>
      ledger.post("call.accepted", "x", "bad", [
        { account: "a", debit: 1n },
        { account: "b", credit: 2n },
      ]),
    ).toThrow(UnbalancedJournalError);
    expect(() => ledger.post("call.accepted", "x", "bad", [{ account: "a", debit: 1n, credit: 1n }, { account: "b" }])).toThrow(UnbalancedJournalError);
    expect(() => ledger.post("call.accepted", "x", "bad", [{ account: "a", debit: -1n }, { account: "b", credit: -1n }])).toThrow(UnbalancedJournalError);
    expect(() => ledger.post("call.accepted", "x", "bad", [{ account: "a", debit: 0n }])).toThrow(UnbalancedJournalError);
    expect(ledger.trialBalance().journals).toBe(before);
  });

  it("filters entries by account or party prefix", () => {
    expect(ledger.entries({ account: accounts.ownerPayable(AGENT), limit: 10 })).toHaveLength(3);
    expect(ledger.entries({ account: `owner:${AGENT}`, limit: 10 })).toHaveLength(4);
    const page = ledger.entries({ limit: 2 });
    expect(ledger.entries({ limit: 10, cursor: page[1]!.id })[0]!.id).toBeLessThan(page[1]!.id);
  });
});

describe("data-safety guard", () => {
  it("accepts only disposable targets", () => {
    expect(isDisposableTarget(join(tmp.dir, "x.db")).ok).toBe(true); // temp dir
    expect(isDisposableTarget("/srv/payminto/clearing.test.db").ok).toBe(true);
    expect(isDisposableTarget("/srv/payminto/clearing.demo.db").ok).toBe(true);
    expect(isDisposableTarget(":memory:").ok).toBe(true);
    // Absolute on purpose: a relative path is disposable when the checkout itself lives in the temp dir (CI, scratch clones).
    expect(isDisposableTarget("/var/lib/payminto/data/clearing.db").ok).toBe(false);
    expect(isDisposableTarget("/srv/payminto/clearing.db").ok).toBe(false);
    expect(isDisposableTarget("/srv/payminto/test.db.backup").ok).toBe(false);
    expect(isDisposableTarget("/srv/payminto/clearing.db", [DISPOSABLE_FLAG]).ok).toBe(true);
    expect(() => assertDisposableTarget("/var/lib/payminto/data/clearing.db")).toThrow(/Refusing/);
  });
});

