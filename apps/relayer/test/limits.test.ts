import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubmitError } from "../src/chain.ts";
import { DailyGasBudget, FileGasLedger, GasLedgerError } from "../src/gas-budget.ts";
import { TokenBuckets } from "../src/ratelimit.ts";
import { HEIGHT, OTHER_KEY, OTHER_SEED, OWNER, OWNER_KEY, TGAS, bodyOf, call, errorOf, harness, revoke } from "./helpers.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "payminto-relayer-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("rate limits", () => {
  it("limits requests per client address and says when to retry", async () => {
    const h = harness({ trustProxyHops: 1, rateLimit: { ip: { perMin: 6, burst: 2 }, sender: { perMin: 0, burst: 1 } } });
    const junk = { signedDelegate: "AAAA" };
    expect((await h.post(junk, { ip: "203.0.113.5" })).status).toBe(400);
    expect((await h.post(junk, { ip: "203.0.113.5" })).status).toBe(400);
    const limited = await h.post(bodyOf(revoke()), { ip: "203.0.113.5" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect(await errorOf(limited)).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 10 });
    expect(h.chain.submissions).toHaveLength(0);
    // Another address is not affected, and the first one is served again once a token has refilled.
    expect((await h.post(bodyOf(revoke()), { ip: "203.0.113.6" })).status).toBe(200);
    h.clock.ms += 10_000;
    expect((await h.post(bodyOf(revoke({ nonce: 6n })), { ip: "203.0.113.5" })).status).toBe(200);
  });

  it("with no trusted proxy, a forged X-Forwarded-For does not buy a new bucket", async () => {
    const h = harness({ trustProxyHops: 0, rateLimit: { ip: { perMin: 6, burst: 1 }, sender: { perMin: 0, burst: 1 } } });
    expect((await h.post({ signedDelegate: "AAAA" }, { ip: "1.1.1.1" })).status).toBe(400);
    expect((await h.post({ signedDelegate: "AAAA" }, { ip: "2.2.2.2" })).status).toBe(429);
  });

  it("with one trusted proxy, only the address that proxy appended counts", async () => {
    const h = harness({ trustProxyHops: 1, rateLimit: { ip: { perMin: 6, burst: 1 }, sender: { perMin: 0, burst: 1 } } });
    expect((await h.post({ signedDelegate: "AAAA" }, { ip: "9.9.9.9, 203.0.113.5" })).status).toBe(400);
    // The client changes the part it controls; the proxy still appends the same real address.
    expect((await h.post({ signedDelegate: "AAAA" }, { ip: "8.8.8.8, 203.0.113.5" })).status).toBe(429);
  });

  it("limits relays per sender across addresses", async () => {
    const h = harness({ trustProxyHops: 1, rateLimit: { ip: { perMin: 0, burst: 1 }, sender: { perMin: 6, burst: 2 } } });
    expect((await h.post(bodyOf(revoke({ nonce: 5n })), { ip: "203.0.113.1" })).status).toBe(200);
    expect((await h.post(bodyOf(revoke({ nonce: 6n })), { ip: "203.0.113.2" })).status).toBe(200);
    const limited = await h.post(bodyOf(revoke({ nonce: 7n })), { ip: "203.0.113.3" });
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).message).toContain(`too many relays for ${OWNER}`);
    expect(h.chain.submissions).toHaveLength(2);
    h.clock.ms += 10_000;
    expect((await h.post(bodyOf(revoke({ nonce: 7n })), { ip: "203.0.113.3" })).status).toBe(200);
  });

  it("a stranger cannot use up an owner's limit: only a key on the owner's account counts", async () => {
    const h = harness({ rateLimit: { ip: { perMin: 0, burst: 1 }, sender: { perMin: 6, burst: 1 } } });
    // Ten delegates that name the owner as sender, each correctly signed by the attacker's own key.
    for (let i = 0; i < 10; i++) {
      const res = await h.post(bodyOf(revoke({ publicKey: OTHER_KEY.publicKey, nonce: BigInt(5 + i) }), OTHER_SEED));
      expect(res.status).toBe(403);
    }
    // The owner can still stop the agent.
    expect((await h.post(bodyOf(revoke()))).status).toBe(200);
  });

  it("refuses new relays while too many are in flight, then recovers", async () => {
    const h = harness({ maxPending: 1 });
    let release!: () => void;
    h.chain.hold = new Promise<void>((r) => (release = r));
    const first = h.post(bodyOf(revoke({ nonce: 5n })));
    await new Promise((r) => setTimeout(r, 10));
    const busy = await h.post(bodyOf(revoke({ nonce: 6n })));
    expect(busy.status).toBe(429);
    expect((await errorOf(busy)).message).toContain("busy");
    release();
    h.chain.hold = null;
    expect((await first).status).toBe(200);
    expect((await h.post(bodyOf(revoke({ nonce: 6n })))).status).toBe(200);
  });

  it("the same delegate sent twice at once is submitted once", async () => {
    const h = harness();
    let release!: () => void;
    h.chain.hold = new Promise<void>((r) => (release = r));
    const body = bodyOf(revoke());
    const a = h.post(body);
    const b = h.post(body);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const statuses = [(await a).status, (await b).status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(h.chain.submissions).toHaveLength(1);
  });

  it("token buckets stay bounded under many keys", () => {
    let now = 0;
    const b = new TokenBuckets({ perMin: 60, burst: 1, maxKeys: 100, now: () => now });
    for (let i = 0; i < 1_000; i++) b.take(`k${i}`);
    expect(b.size).toBeLessThanOrEqual(100);
    now += 60_000;
    b.take("fresh");
    expect(b.size).toBeLessThanOrEqual(2);
  });
});

describe("daily gas budget", () => {
  // A revoke attaches 30 Tgas and counts as 35 with the fixed margin for fees.
  it("refuses with a clear message once the day's gas is spent, and starts again the next UTC day", async () => {
    const h = harness({ dailyGasBudgetTgas: 80 });
    expect((await h.post(bodyOf(revoke({ nonce: 5n })))).status).toBe(200);
    expect((await h.post(bodyOf(revoke({ nonce: 6n })))).status).toBe(200);
    const spent = await h.post(bodyOf(revoke({ nonce: 7n })));
    expect(spent.status).toBe(429);
    const error = await errorOf(spent);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("daily gas budget of 80 Tgas");
    expect(error.message).toContain("2026-11-11T00:00:00.000Z");
    expect(error.message).toContain("your own gas");
    expect(Number(spent.headers.get("retry-after"))).toBe(12 * 3600);
    expect(h.chain.submissions).toHaveLength(2);
    expect(h.logs.some((l) => l.includes("daily gas budget is spent"))).toBe(true);

    const health = (await (await h.app.request("/health")).json()) as { gas: { usedTgas: number; budgetTgas: number } };
    expect(health.gas).toMatchObject({ usedTgas: 70, budgetTgas: 80 });

    h.clock.ms += 12 * 3600 * 1000 + 1_000;
    expect((await h.post(bodyOf(revoke({ nonce: 7n })))).status).toBe(200);
  });

  it("counts the gas a delegate attaches, so one large call can use the whole day", async () => {
    const h = harness({ dailyGasBudgetTgas: 320 });
    expect((await h.post(bodyOf(revoke({ nonce: 5n, actions: [call("payout", { gas: 300n * TGAS })] })))).status).toBe(200);
    expect((await h.post(bodyOf(revoke({ nonce: 6n })))).status).toBe(429);
  });

  it("gives the gas back when nothing was sent, and keeps it when the outcome is unknown", async () => {
    const h = harness({ dailyGasBudgetTgas: 40 });
    h.chain.failNextSubmit = new SubmitError("not_sent", "connection refused");
    expect((await h.post(bodyOf(revoke()))).status).toBe(502);
    // Nothing was spent, so the same delegate goes through on the second try.
    h.chain.failNextSubmit = new SubmitError("unknown", "timeout", "TxHash111");
    expect((await h.post(bodyOf(revoke()))).status).toBe(502);
    // That one may have landed: its gas stays counted, and the budget is now spent.
    const res = await h.post(bodyOf(revoke({ nonce: 6n })));
    expect(res.status).toBe(429);
    expect((await errorOf(res)).message).toContain("daily gas budget");
  });

  it("keeps the count across a restart when a ledger file is configured", async () => {
    const path = join(tempDir(), "data", "gas.json");
    const h1 = harness({ dailyGasBudgetTgas: 80 }, { gasLedger: new FileGasLedger(path) });
    expect((await h1.post(bodyOf(revoke({ nonce: 5n })))).status).toBe(200);
    expect((await h1.post(bodyOf(revoke({ nonce: 6n })))).status).toBe(200);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ day: "2026-11-10", usedGas: (70n * TGAS).toString() });

    // A new process with the same file: the day's budget is still spent.
    const h2 = harness({ dailyGasBudgetTgas: 80 }, { gasLedger: new FileGasLedger(path) });
    h2.chain.addKey(OWNER, OWNER_KEY.publicKey, 6n);
    expect((await h2.post(bodyOf(revoke({ nonce: 7n })))).status).toBe(429);
    expect(h2.chain.submissions).toHaveLength(0);
  });

  it("a ledger file that is not a ledger stops the relayer instead of resetting the count", () => {
    const path = join(tempDir(), "gas.json");
    writeFileSync(path, "{broken");
    expect(() => new DailyGasBudget({ limitGas: 1n, store: new FileGasLedger(path) })).toThrow(GasLedgerError);
    expect(() => new DailyGasBudget({ limitGas: 1n, store: new FileGasLedger(path) })).toThrow(/delete it to start today's count from zero/);
  });

  it("a ledger from an earlier day starts the new day at zero", () => {
    const path = join(tempDir(), "gas.json");
    writeFileSync(path, JSON.stringify({ day: "2026-11-09", usedGas: "999" }));
    const budget = new DailyGasBudget({ limitGas: 1_000n, now: () => Date.UTC(2026, 10, 10), store: new FileGasLedger(path) });
    expect(budget.snapshot()).toMatchObject({ day: "2026-11-10", usedGas: 0n });
  });

  it("reserve never goes over the limit and release never goes below zero", () => {
    const budget = new DailyGasBudget({ limitGas: 100n, now: () => Date.UTC(2026, 10, 10, 23, 59, 30) });
    expect(budget.reserve(60n)).toEqual({ ok: true });
    expect(budget.reserve(41n)).toEqual({ ok: false, retryAfterSec: 30, remainingGas: 40n });
    expect(budget.reserve(40n)).toEqual({ ok: true });
    budget.release(500n);
    expect(budget.snapshot().usedGas).toBe(0n);
  });
});

describe("chain height", () => {
  it("uses the chain height it reads, not a cached one", async () => {
    const h = harness();
    h.chain.height = HEIGHT + 200n;
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("EXPIRED");
  });
});
