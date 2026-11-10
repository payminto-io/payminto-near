import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileVoucherStore, NO_ACCEPTANCE } from "../src/voucher-store.ts";
import { storedVoucher } from "./voucher-fixture.ts";

const WRITER = join(dirname(fileURLToPath(import.meta.url)), "voucher-writer.ts");

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "payminto-voucher-store-"));
  return { dir, path: join(dir, "seller.vouchers.json") };
}

/** What a process that opens the file now would see. */
function onDisk(path: string): string[] {
  const reader = new FileVoucherStore(path);
  try {
    return reader
      .all()
      .map((v) => v.payee)
      .sort();
  } finally {
    reader.close();
  }
}

/** A lock file as a writer that died long ago left it. */
function staleLock(path: string, content: string) {
  writeFileSync(`${path}.lock`, content);
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(`${path}.lock`, longAgo, longAgo);
}

describe("FileVoucherStore", () => {
  it("keeps the latest voucher per payee across a restart, in a file only its owner can read", () => {
    const { dir, path } = fresh();
    const first = new FileVoucherStore(path);
    expect(first.put(storedVoucher("x.testnet", 1000n))).toBe(true);
    expect(first.put(storedVoucher("x.testnet", 3000n))).toBe(true);
    expect(first.put(storedVoucher("x.testnet", 2000n))).toBe(false); // never lowered
    expect(first.put(storedVoucher("y.testnet", 1000n))).toBe(true);
    first.close();
    expect(() => first.put(storedVoucher("z.testnet", 1000n))).toThrow(/is closed/);

    const again = new FileVoucherStore(path);
    expect(again.all().map((v) => [v.payee, v.cumulative])).toEqual([
      ["x.testnet", "3000"],
      ["y.testnet", "1000"],
    ]);
    expect(again.latest("hub.payminto.testnet", "near:sandbox", "ab".repeat(32), "x.testnet")).toMatchObject({ cumulative: "3000", acceptance: { timestampS: "1762732800" } });
    again.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).format).toBe("payminto.voucher-store.v2");
    // Nothing is left beside the file: no lock, no temporary file.
    expect(readdirSync(dir)).toEqual(["seller.vouchers.json"]);
  });

  it("removes what a crash mid-write left behind, and never overwrites a file it cannot read", () => {
    const { dir, path } = fresh();
    const first = new FileVoucherStore(path);
    first.put(storedVoucher("x.testnet", 1000n));
    first.close();
    writeFileSync(`${path}.123.456.tmp`, "{ torn");
    const again = new FileVoucherStore(path);
    expect(again.all().map((v) => v.payee)).toEqual(["x.testnet"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // Another program damages the file. Neither a write nor a fresh open replaces it, so its bytes can be recovered.
    writeFileSync(path, "not json");
    expect(() => again.put(storedVoucher("y.testnet", 1000n))).toThrow(/left untouched/);
    expect(() => new FileVoucherStore(path)).toThrow(/left untouched/);
    expect(readFileSync(path, "utf8")).toBe("not json");
    expect(existsSync(`${path}.lock`)).toBe(false);
    again.close();
  });

  it("reads a file written before acceptances were kept, and stores no voucher without one", () => {
    const { path } = fresh();
    const { acceptance: _none, ...legacy } = storedVoucher("x.testnet", 5000n);
    writeFileSync(path, JSON.stringify({ format: "payminto.voucher-store.v1", vouchers: [legacy] }));
    const store = new FileVoucherStore(path);
    // The old voucher is still there to see, marked as having no acceptance: it cannot be settled by the seller.
    expect(store.all()).toEqual([{ ...legacy, acceptance: null }]);
    expect(() => store.put({ ...storedVoucher("y.testnet", 1000n), acceptance: null })).toThrow(NO_ACCEPTANCE);
    // The next call the node accepts for that payee replaces it with a voucher that can be settled.
    expect(store.put(storedVoucher("x.testnet", 6000n))).toBe(true);
    expect(store.all()[0]).toMatchObject({ cumulative: "6000", acceptance: { timestampS: "1762732800" } });
    store.close();
  });
});

describe("FileVoucherStore shared by several writers", () => {
  it("two writers that both run as the same pid on one volume keep each other's vouchers", () => {
    // Two containers that mount one volume each run their seller as pid 1. Here the second writer reaches the same
    // file through a symlinked directory, so it is a separate store with the same pid as the first.
    const { dir, path } = fresh();
    const link = `${dir}-volume`;
    symlinkSync(dir, link);
    const first = new FileVoucherStore(path);
    first.put(storedVoucher("x.testnet", 1000n));
    const second = new FileVoucherStore(join(link, "seller.vouchers.json"));

    first.put(storedVoucher("y.testnet", 1000n));
    second.put(storedVoucher("z.testnet", 1000n));
    // Each sees what the other stored, without reopening.
    expect(first.all().map((v) => v.payee)).toEqual(["x.testnet", "y.testnet", "z.testnet"]);
    expect(second.latest("hub.payminto.testnet", "near:sandbox", "ab".repeat(32), "y.testnet")).toMatchObject({ payee: "y.testnet" });
    // A higher voucher from one writer is not lowered by the other writer's older view of the same payee.
    first.put(storedVoucher("z.testnet", 5000n));
    expect(second.put(storedVoucher("z.testnet", 2000n))).toBe(false);
    first.close();
    second.close();
    expect(onDisk(path)).toEqual(["x.testnet", "y.testnet", "z.testnet"]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("waits for a lock another writer holds, and does not take it over while it is fresh", async () => {
    const { path } = fresh();
    const store = new FileVoucherStore(path);
    // Another writer holds the lock for a moment, then finishes and removes it, as every write does.
    writeFileSync(`${path}.lock`, JSON.stringify({ token: "another-writer", pid: process.pid }));
    const HOLD_MS = 300;
    const other = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").rmSync(${JSON.stringify(`${path}.lock`)}), ${HOLD_MS})`], { stdio: "ignore" });
    const started = Date.now();
    expect(store.put(storedVoucher("x.testnet", 1000n))).toBe(true);
    // The write went through only after the holder let go: the lock named this very pid and was still left alone.
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 150);
    await new Promise((ok) => other.on("close", ok));
    store.close();
    expect(onDisk(path)).toEqual(["x.testnet"]);
  });

  it("takes over a lock once it is stale, and gives up with a clear error on one that never ages", () => {
    const { path } = fresh();
    const store = new FileVoucherStore(path, { lockStaleMs: 100, lockWaitMs: 400 });
    // A writer died just now, holding the lock. Nobody takes it at once; after `lockStaleMs` the waiting write does.
    writeFileSync(`${path}.lock`, "held by a writer that died");
    const started = Date.now();
    expect(store.put(storedVoucher("x.testnet", 1000n))).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);

    // A lock stamped in the future never looks stale. The write gives up after `lockWaitMs`, names the holder, and
    // leaves both the lock and the vouchers as they were.
    writeFileSync(`${path}.lock`, "held by a writer with a wrong clock");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(`${path}.lock`, future, future);
    expect(() => store.put(storedVoucher("y.testnet", 1000n))).toThrow(/locked by another writer \(held by a writer with a wrong clock\) and did not come free in 400 ms/);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("held by a writer with a wrong clock");
    expect(JSON.parse(readFileSync(path, "utf8")).vouchers).toHaveLength(1);
    store.close();

    // The wait must outlast the stale threshold, or a dead writer's lock could never be taken over.
    expect(() => new FileVoucherStore(path, { lockStaleMs: 500, lockWaitMs: 400 })).toThrow(/lockWaitMs must be longer/);
  });

  it("several processes that meet a dead writer's lock at the same moment all store their vouchers", async () => {
    const { dir, path } = fresh();
    // A writer died holding the lock, long ago. An older version wrote its pid there.
    staleLock(path, "999999999");
    const start = join(dir, "go");
    const writers = ["a", "b", "c", "d"];
    const PER_WRITER = 25;
    const done = writers.map(
      (name) =>
        new Promise<{ name: string; code: number | null; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, [WRITER, path, name, String(PER_WRITER), start], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          child.on("close", (code) => resolve({ name, code, stderr: stderr.slice(-400) }));
        }),
    );
    await new Promise((ok) => setTimeout(ok, 500));
    writeFileSync(start, "");
    const results = await Promise.all(done);
    expect(results.filter((r) => r.code !== 0)).toEqual([]);
    const expected = writers.flatMap((name) => Array.from({ length: PER_WRITER }, (_, i) => `${name}-${i}.testnet`)).sort();
    expect(onDisk(path)).toEqual(expected);
    // Every writer released its lock, and nothing the lock uses is left behind.
    expect(readdirSync(dir).sort()).toEqual(["go", "seller.vouchers.json"]);
  }, 60_000);
});
