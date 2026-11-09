/**
 * Operations hardening: live-network config guards, the revocation scan start block, rate limiting,
 * denial folding and pruning, metrics, and backups. Every database lives in a fresh temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networkFor, SCHEME, X402_VERSION } from "@payminto/protocol";
import { backupDatabase } from "../src/backup.ts";
import type { ChainClient } from "../src/chain.ts";
import { ConfigError, loadConfig, PUBLIC_DEV_KEYS } from "../src/config.ts";
import { Database } from "../src/db/database.ts";
import { EventBus } from "../src/events.ts";
import { silentLogger } from "../src/logger.ts";
import { MandateService } from "../src/mandates.ts";
import { TokenBuckets } from "../src/ratelimit.ts";
import { pruneTable } from "../src/retention.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ANVIL_KEYS, deployClearing, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const tmp = tempDir("payminto-ops-");
afterAll(() => tmp.cleanup());

const HUB = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const STRONG_TOKEN = "a".repeat(32);
const REAL_KEY = keccak256(toHex("payminto ops test operator, not a dev key"));

function liveEnv(chainId: 133 | 177, over: Record<string, string> = {}) {
  const dir = join(tmp.dir, `empty-deployments-${chainId}`);
  mkdirSync(dir, { recursive: true });
  return {
    CHAIN_ID: String(chainId),
    HUB_ADDRESS: HUB,
    TOKEN_ADDRESS: TOKEN,
    OPERATOR_KEY: REAL_KEY,
    ADMIN_TOKEN: STRONG_TOKEN,
    DEPLOY_BLOCK: "123",
    DEPLOYMENTS_DIR: dir,
    ...over,
  };
}

function problemsOf(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  return "";
}

describe("config on live networks", () => {
  it("lists exactly the ten public anvil/hardhat keys", () => {
    expect(PUBLIC_DEV_KEYS).toHaveLength(10);
    expect(new Set(PUBLIC_DEV_KEYS.map((k) => privateKeyToAccount(k).address)).size).toBe(10);
    expect(privateKeyToAccount(PUBLIC_DEV_KEYS[0]!).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it.each([133, 177] as const)("refuses every public dev operator key on chain %i", (chainId) => {
    for (const key of PUBLIC_DEV_KEYS) {
      const msg = problemsOf(liveEnv(chainId, { OPERATOR_KEY: key }));
      expect(msg).toMatch(/OPERATOR_KEY: is a public anvil\/hardhat dev key/);
      expect(msg).not.toContain(key.slice(2, 12));
    }
    expect(problemsOf(liveEnv(chainId, { OPERATOR_KEY: PUBLIC_DEV_KEYS[3]!.toUpperCase().replace("0X", "0x") }))).toMatch(/OPERATOR_KEY/);
  });

  it.each([133, 177] as const)("refuses the dev admin token and short tokens on chain %i", (chainId) => {
    expect(problemsOf(liveEnv(chainId, { ADMIN_TOKEN: "dev-admin-token" }))).toMatch(/ADMIN_TOKEN: is the public dev token/);
    expect(problemsOf(liveEnv(chainId, { ADMIN_TOKEN: "x".repeat(31) }))).toMatch(/ADMIN_TOKEN: must be at least 32 characters/);
    expect(problemsOf(liveEnv(chainId))).toBe("");
  });

  it("keeps the dev defaults working on the local chain", () => {
    const c = loadConfig({ CHAIN_ID: "31337", HUB_ADDRESS: HUB, TOKEN_ADDRESS: TOKEN, OPERATOR_KEY: ANVIL_KEYS[9], ADMIN_TOKEN: "dev-admin-token", DEPLOYMENTS_DIR: tmp.dir });
    expect(c.adminToken).toBe("dev-admin-token");
    expect(c.host).toBe("127.0.0.1");
    expect(c.deployBlock).toBe(0n);
    expect(c.rpcFallbackUrls).toEqual([]);
    expect(c.corsOrigins).toEqual(["http://localhost:3000"]);
    // Without CORS_ORIGINS the dashboard origin is allowed wherever it runs.
    const d = loadConfig({ CHAIN_ID: "31337", HUB_ADDRESS: HUB, TOKEN_ADDRESS: TOKEN, OPERATOR_KEY: ANVIL_KEYS[9], ADMIN_TOKEN: "dev-admin-token", DEPLOYMENTS_DIR: tmp.dir, PUBLIC_CHECKOUT_URL: "http://localhost:3005/" });
    expect(d.corsOrigins).toEqual(["http://localhost:3005", "http://localhost:3000"]);
  });

  it("requires a deploy block on live chains and prefers DEPLOY_BLOCK over the deployments file", () => {
    const { DEPLOY_BLOCK: _omit, ...noBlock } = liveEnv(133);
    expect(problemsOf(noBlock)).toMatch(/DEPLOY_BLOCK: required on chain 133/);

    const dir = join(tmp.dir, "deployments-133");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "133.json"), JSON.stringify({ clearingHub: HUB, chainId: 133, blockNumber: 35_000_000 }));
    expect(loadConfig({ ...noBlock, DEPLOYMENTS_DIR: dir }).deployBlock).toBe(35_000_000n);
    expect(loadConfig({ ...noBlock, DEPLOYMENTS_DIR: dir, DEPLOY_BLOCK: "35000123" }).deployBlock).toBe(35_000_123n);
  });

  it("defaults RPC fallbacks to the network's public endpoints, accepts a list, and accepts none", () => {
    expect(loadConfig(liveEnv(177)).rpcFallbackUrls).toEqual(["https://hashkey.drpc.org", "https://177.rpc.thirdweb.com"]);
    expect(loadConfig(liveEnv(133, { RPC_FALLBACK_URLS: "https://a.example, https://b.example" })).rpcFallbackUrls).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(loadConfig(liveEnv(133, { RPC_FALLBACK_URLS: "none" })).rpcFallbackUrls).toEqual([]);
    expect(problemsOf(liveEnv(133, { RPC_FALLBACK_URLS: "not a url" }))).toMatch(/RPC_FALLBACK_URLS/);
  });
});

describe("revocation scan start", () => {
  /** `head` is the finality head (CONFIRM_TAG); `latest` runs ahead of it like on HashKey Chain. */
  function fakeChain(head: bigint, ranges: Array<[bigint, bigint]>, latest = head) {
    return {
      hub: HUB,
      headOf: async () => head,
      public: {
        getBlockNumber: async () => latest,
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
          ranges.push([fromBlock, toBlock]);
          return [];
        },
      },
    } as unknown as ChainClient;
  }

  function service(dbFile: string, fromBlock: bigint, head: bigint, ranges: Array<[bigint, bigint]>, latest = head) {
    const db = new Database(join(tmp.dir, dbFile));
    db.migrate();
    const store = new Store(db);
    const svc = new MandateService({ db, store, chain: fakeChain(head, ranges, latest), events: new EventBus(db), log: silentLogger, fromBlock });
    return { db, store, svc };
  }

  it("starts at the deploy block and walks forward in 5,001-block windows", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const { db, store, svc } = service("scan-a.test.db", 35_000_000n, 35_012_000n, ranges);
    expect(svc.nextScanBlock).toBe(35_000_000n);
    await svc.scanRevocations();
    expect(ranges[0]).toEqual([35_000_000n, 35_005_000n]);
    for (const [f, t] of ranges) expect(t - f + 1n).toBeLessThanOrEqual(5_001n);
    expect(ranges.at(-1)![1]).toBe(35_012_000n);
    expect(store.getMeta("revocations_scanned_block")).toBe("35012000");
    db.close();
  });

  it("reads only up to the finality head, never the unsafe tip", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    // Testnet: the safe head trails latest by about 300 blocks.
    const { db, store, svc } = service("scan-safe.test.db", 35_000_000n, 35_009_700n, ranges, 35_010_000n);
    await svc.scanRevocations();
    expect(ranges.at(-1)![1]).toBe(35_009_700n);
    expect(store.getMeta("revocations_scanned_block")).toBe("35009700");
    db.close();
  });

  it("moves a stored cursor that is behind the deploy block forward", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const first = service("scan-b.test.db", 0n, 10n, ranges);
    await first.svc.scanRevocations();
    expect(ranges[0]).toEqual([1n, 10n]); // block 0 is genesis, it cannot hold the hub
    first.db.close();
    const db = new Database(join(tmp.dir, "scan-b.test.db"));
    const svc = new MandateService({ db, store: new Store(db), chain: fakeChain(10n, ranges), events: new EventBus(db), log: silentLogger, fromBlock: 500n });
    expect(svc.nextScanBlock).toBe(500n);
    db.close();
  });
});

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
        `INSERT INTO denials (id, rule, message, mandate_id, agent, payee, provider_id, amount, cumulative, request_hash, details, timestamp, at)
         VALUES (?, 'UNKNOWN_MANDATE', 'm', '0x00', NULL, '0x00', 'p', '1', '1', '0x00', '{}', ?, 'now')`,
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
    expect(r.migrations).toBeGreaterThanOrEqual(2);
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
  let anvil: Anvil;
  let node: ClearingNode;
  const PAYEE = privateKeyToAccount(ANVIL_KEYS[4]).address;

  beforeAll(async () => {
    anvil = await startAnvil();
    const { hub, token } = await deployClearing(anvil);
    node = await startNode(
      testConfig({
        rpcUrl: anvil.rpcUrl,
        hub,
        token,
        dbPath: join(tmp.dir, "http.test.db"),
        rateLimit: { provider: { rps: 1, burst: 4 }, ip: { rps: 1, burst: 3 } },
      }),
      { logger: silentLogger, workers: false },
    );
  });
  afterAll(async () => {
    await node?.stop();
    anvil?.stop();
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

    const voucher = (requestHash: Hex) => ({
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: networkFor(31337).caip2,
      payload: { mandateId: keccak256(toHex("no such mandate")), payee: PAYEE as Address, amount: "1000", cumulative: "1000", signature: `0x${"11".repeat(65)}`, requestHash },
      providerId: id,
      requestHash,
    });
    const h1 = keccak256(toHex("request 1"));
    const h2 = keccak256(toHex("request 2"));
    const statuses = [];
    for (const h of [h1, h1, h1, h2, h1]) statuses.push((await call("POST", "/v1/vouchers", { bearer: apiKey, body: voucher(h) })).status);
    expect(statuses).toEqual([402, 402, 402, 402, 429]);

    const denials = (await (await call("GET", "/v1/denials", { bearer: ADMIN })).json()) as Array<{ requestHash: string; repeats: number; rule: string }>;
    expect(denials.map((d) => [d.requestHash, d.repeats, d.rule])).toEqual([
      [h2, 1, "UNKNOWN_MANDATE"],
      [h1, 3, "UNKNOWN_MANDATE"],
    ]);
    const overview = (await (await call("GET", "/v1/overview", { bearer: ADMIN })).json()) as { denialsTotal: number };
    expect(overview.denialsTotal).toBe(4);

    expect((await call("GET", "/metrics")).status).not.toBe(200);
    const metrics = await call("GET", "/metrics", { bearer: ADMIN });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await metrics.text();
    expect(text).toMatch(/^payminto_node_info\{version="[^"]+",chain_id="31337",hsp_mode="local"\} 1$/m);
    expect(text).toMatch(/^payminto_denials 4$/m);
    expect(text).toMatch(/^payminto_denial_rows 2$/m);
    expect(text).toMatch(/^payminto_rate_limited_total\{scope="provider"\} 1$/m);
    expect(text).toMatch(/^payminto_rate_limited_total\{scope="ip"\} \d+$/m);
    expect(text).toMatch(/^payminto_chain_head_block \d+$/m);
    expect(text).not.toContain(ADMIN);
  });
});
