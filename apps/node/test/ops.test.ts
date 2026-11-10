/**
 * Operations hardening: live-network config guards, the revocation scan start block, rate limiting,
 * denial folding and pruning, metrics, and backups. Every database lives in a fresh temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEME, sha256Text, X402_VERSION } from "@payminto/protocol";
import { backupDatabase } from "../src/backup.ts";
import type { ChainClient } from "../src/chain.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { Database, MIGRATIONS_DIR } from "../src/db/database.ts";
import { EventBus } from "../src/events.ts";
import { silentLogger } from "../src/logger.ts";
import { BudgetService } from "../src/budgets.ts";
import { TokenBuckets } from "../src/ratelimit.ts";
import { pruneTable } from "../src/retention.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { OWNER_A, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey } from "./helpers.ts";

const tmp = tempDir("payminto-ops-");
afterAll(() => tmp.cleanup());




describe("token buckets", () => {
  it("allows a burst, refills at the rate, and reports Retry-After", () => {
    let t = 0;
    const b = new TokenBuckets({ rps: 2, burst: 3, now: () => t });
    expect([1, 2, 3].map(() => b.take("k").ok)).toEqual([true, true, true]);
    const denied = b.take("k");
    expect(denied).toEqual({ ok: false, retryAfterSec: 1 });
    expect(b.take("other").ok).toBe(true);
    t += 500;
    expect(b.take("k").ok).toBe(true);
    expect(b.take("k").ok).toBe(false);
  });

  it("is disabled at 0 rps and stays bounded in memory", () => {
    expect(new TokenBuckets({ rps: 0, burst: 1 }).take("k").ok).toBe(true);
    let t = 0;
    const b = new TokenBuckets({ rps: 1, burst: 1, maxKeys: 100, now: () => t });
    for (let i = 0; i < 1_000; i++) b.take(`ip-${i}`);
    expect(b.size).toBeLessThanOrEqual(100);
    t += 10_000;
    expect(b.prune()).toBeGreaterThan(0);
    expect(b.size).toBe(0);
  });
});

describe("retention and backup", () => {
  it("prunes only the oldest denial and event rows", () => {
    const db = new Database(join(tmp.dir, "prune.test.db"));
    db.migrate();
    const events = new EventBus(db);
    for (let i = 0; i < 50; i++) {
      db.run(
        `INSERT INTO denials (id, rule, message, budget_id, agent, payee, provider_id, amount, cumulative, request_hash, details, timestamp, at)
         VALUES (?, 'UNKNOWN_BUDGET', 'm', '0x00', NULL, '0x00', 'p', '1', '1', '0x00', '{}', ?, 'now')`,
        `dny_${i}`,
        i,
      );
      events.emit("funds.warning", { i });
    }
    expect(pruneTable(db, "denials", 20)).toBe(30);
    expect(pruneTable(db, "events", 10)).toBe(40);
    expect(db.get<{ n: number; lo: string }>("SELECT COUNT(*) AS n, MIN(id) AS lo FROM denials")).toEqual({ n: 20, lo: "dny_30" });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n).toBe(10);
    expect(pruneTable(db, "denials", 20)).toBe(0);
    db.close();
  });

  it("backs up a live database with VACUUM INTO and verifies the copy", () => {
    const src = join(tmp.dir, "backup-src.test.db");
    const db = new Database(src);
    db.migrate();
    db.run("INSERT INTO meta (key, value) VALUES ('chain_id', '31337')");
    const r = backupDatabase(src, join(tmp.dir, "backups"), new Date("2026-10-29T10:15:30.000Z"));
    expect(r.file).toMatch(/clearing-20261029T101530Z\.db$/);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.migrations).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).length);
    const copy = new DatabaseSync(r.file, { readOnly: true });
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'chain_id'").get()).toEqual({ value: "31337" });
    copy.close();
    expect(() => backupDatabase(src, join(tmp.dir, "backups"), new Date("2026-10-29T10:15:30.000Z"))).toThrow(/refusing to overwrite/);
    expect(() => backupDatabase(join(tmp.dir, "missing.db"), join(tmp.dir, "backups"))).toThrow(/no database/);
    db.close();
  });
});

describe("HTTP limits, denial folding and metrics", () => {
  const ADMIN = "test-admin-token-123";
  let fakeChain: ReturnType<typeof startFakeChain>;
  let node: ClearingNode;
  const PAYEE = "api.seller.testnet";

  beforeAll(async () => {
    fakeChain = startFakeChain();
    const { hub, token } = { hub: fakeChain.hub, token: fakeChain.token };
    node = await startNode(
      testConfig({
        hub,
        token,
        dbPath: join(tmp.dir, "http.test.db"),
        rateLimit: { provider: { rps: 1, burst: 4 }, ip: { rps: 1, burst: 3 } },
      }),
      { logger: silentLogger, workers: false, chain: fakeChain },
    );
  });
  afterAll(async () => {
    await node?.stop();
    });

  const call = (method: string, path: string, opts: { bearer?: string; body?: unknown } = {}) =>
    fetch(`${node.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  it("limits unauthenticated callers per IP with 429 and Retry-After, never admin or /healthz", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call("GET", "/v1/providers")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await call("GET", "/v1/info");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect((await call("GET", "/healthz")).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await call("GET", "/v1/providers", { bearer: ADMIN })).status).toBe(200);
    // Wrong admin tokens are unauthenticated traffic, so guessing is throttled too.
    expect((await call("GET", "/v1/overview", { bearer: "wrong-token-guess" })).status).toBe(429);
  });

  it("limits voucher traffic per provider key, folds replayed denials, and exposes metrics", async () => {
    const created = await call("POST", "/v1/providers", {
      bearer: ADMIN,
      body: { name: "Quote", payee: PAYEE, priceAtomic: "1000", resource: "/quote" },
    });
    expect(created.status).toBe(201);
    const { id, apiKey } = (await created.json()) as { id: string; apiKey: string };

    // Signed by the Budget's agent, with a cumulative that does not extend its position: a refusal the node records.
    const budget = await openBudget(fakeChain, node.url, ADMIN, OWNER_A, testKey(40));
    const voucher = (requestHash: string) => ({
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: "near:sandbox",
      payload: {
        budgetId: budget.id,
        payee: PAYEE,
        amount: "1000",
        cumulative: "5000",
        signature: signVoucher(fakeChain, budget.agent, { budgetId: budget.id, payee: PAYEE, amount: 1_000n, cumulative: 5_000n, requestHash }),
        requestHash,
      },
      providerId: id,
      requestHash,
    });
    const h1 = sha256Text("request 1");
    const h2 = sha256Text("request 2");
    const statuses = [];
    for (const h of [h1, h1, h1, h2, h1]) statuses.push((await call("POST", "/v1/vouchers", { bearer: apiKey, body: voucher(h) })).status);
    expect(statuses).toEqual([402, 402, 402, 402, 429]);

    const denials = (await (await call("GET", "/v1/denials", { bearer: ADMIN })).json()) as Array<{ requestHash: string; repeats: number; rule: string }>;
    expect(denials.map((d) => [d.requestHash, d.repeats, d.rule])).toEqual([
      [h2, 1, "STALE_CUMULATIVE"],
      [h1, 3, "STALE_CUMULATIVE"],
    ]);
    const overview = (await (await call("GET", "/v1/overview", { bearer: ADMIN })).json()) as { denialsTotal: number };
    expect(overview.denialsTotal).toBe(4);

    expect((await call("GET", "/metrics")).status).not.toBe(200);
    const metrics = await call("GET", "/metrics", { bearer: ADMIN });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await metrics.text();
    expect(text).toMatch(/^payminto_node_info\{version="[^"]+",network="near:sandbox"\} 1$/m);
    expect(text).toMatch(/^payminto_denials 4$/m);
    expect(text).toMatch(/^payminto_denial_rows 2$/m);
    expect(text).toMatch(/^payminto_rate_limited_total\{scope="provider"\} 1$/m);
    expect(text).toMatch(/^payminto_rate_limited_total\{scope="ip"\} \d+$/m);
    expect(text).toMatch(/^payminto_rpc_up 1$/m);
    expect(text).not.toContain(ADMIN);
  });
});
