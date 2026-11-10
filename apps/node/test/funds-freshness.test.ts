/**
 * The funds check fails closed when the hub cannot be read: once a Budget's snapshot is older than FUNDS_MAX_AGE_MS and
 * the refresh failed, calls are refused with NET_EXPOSURE and a hint to retry shortly, so stale escrow is never spent
 * and an on-chain revoke is never missed for longer than that age.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { HUB_UNREADABLE_MESSAGE, SCHEME, X402_VERSION, sha256Text, type Chain } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { HUB_RETRY_SEC } from "../src/policy-engine.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, SELLER, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;
const MAX_AGE_MS = 400;
const tmp = tempDir("payminto-funds-");
let fake: FakeChain;
let node: ClearingNode;
let budget: OpenedBudget;
let seller: { id: string; apiKey: string };
/** While true, every hub read fails the way an RPC outage does. */
let down = false;
/**
 * The node's clock. It moves only when a test moves it, so a snapshot is fresh or stale because the test says so,
 * never because the machine was slow (the suite used to sleep and failed under load).
 */
let nowMs = Date.now();
const advance = (ms: number) => {
  nowMs += ms;
};

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

let cumulative = 0n;
async function pay() {
  const next = cumulative + PRICE;
  const requestHash = sha256Text(`req-${Math.random()}`);
  const signature = signVoucher(fake, budget.agent, { budgetId: budget.id, payee: SELLER, amount: PRICE, cumulative: next, requestHash });
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${seller.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: fake.network, providerId: seller.id, requestHash, payload: { budgetId: budget.id, payee: SELLER, amount: PRICE.toString(), cumulative: next.toString(), signature, requestHash } }),
  });
  const json = (await r.json()) as any;
  if (r.status === 200) cumulative = next;
  return { status: r.status, json };
}

const calls = () => node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls")!.n;

beforeAll(async () => {
  fake = startFakeChain();
  // FakeChain behind a seam whose reads fail while `down`, like an RPC that stopped answering.
  const chain = new Proxy(fake, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "budget" || prop === "creditOf" || prop === "settledOf") {
        return async (...args: unknown[]) => {
          if (down) throw new Error("fetch failed: connect ECONNREFUSED");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as Chain;
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, fundsMaxAgeMs: MAX_AGE_MS }), { chain, logger: silentLogger, port: 0, workers: false, clockMs: () => nowMs });
  budget = await openBudget(fake, node.url, ADMIN, OWNER_A, testKey(1), { escrow: 50_000n });
  const p = await admin("POST", "/v1/providers", { name: "seller", payee: SELLER, priceAtomic: PRICE.toString(), resource: "https://seller.example/api" });
  seller = p.json;
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("funds check while the hub is unreadable", () => {
  it("keeps deciding on a snapshot younger than the maximum age", async () => {
    expect((await pay()).status).toBe(200);
    down = true;
    advance(MAX_AGE_MS - 1);
    expect((await pay()).status).toBe(200);
  });

  it("refuses with NET_EXPOSURE and a short retry once the snapshot is too old and the refresh fails", async () => {
    // The owner revokes on chain during the outage: the node cannot see it, so it must not accept on old state.
    await fake.revokeBudget(OWNER_A, budget.id);
    advance(MAX_AGE_MS + 1);
    const before = calls();
    const r = await pay();
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: "NET_EXPOSURE", message: HUB_UNREADABLE_MESSAGE });
    expect(r.json.refusal).toEqual({
      rule: "NET_EXPOSURE",
      message: HUB_UNREADABLE_MESSAGE,
      attemptedAmount: "1000",
      remainingBudget: "99998000",
      retry: { kind: "after", seconds: HUB_RETRY_SEC, reason: "hub_unreadable" },
    });
    expect(r.json.error.details).toMatchObject({ hubUnreadable: true, fundsKnown: true });
    expect(calls()).toBe(before);
    // Still refused on the next attempt, and never with a hint that asks the owner for money.
    expect((await pay()).json.refusal.retry).toEqual({ kind: "after", seconds: HUB_RETRY_SEC, reason: "hub_unreadable" });
  });

  it("sees the on-chain revoke as soon as the hub answers again", async () => {
    down = false;
    const r = await pay();
    expect(r.status).toBe(402);
    expect(r.json.refusal).toMatchObject({ rule: "BUDGET_REVOKED", retry: { kind: "never" } });
  });

  it("refuses a Budget whose funds were never read, without asking for a deposit", async () => {
    // Registering a Budget needs the hub, so it is opened first and its snapshot removed, as if no read ever succeeded.
    const fresh = await openBudget(fake, node.url, ADMIN, OWNER_A, testKey(2), { escrow: 50_000n });
    node.services.db.run("DELETE FROM budget_funds WHERE budget_id = ?", fresh.id);
    down = true;
    const requestHash = sha256Text("never read");
    const signature = signVoucher(fake, fresh.agent, { budgetId: fresh.id, payee: SELLER, amount: PRICE, cumulative: PRICE, requestHash });
    const r = await fetch(`${node.url}/v1/vouchers`, {
      method: "POST",
      headers: { authorization: `Bearer ${seller.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: fake.network, providerId: seller.id, requestHash, payload: { budgetId: fresh.id, payee: SELLER, amount: PRICE.toString(), cumulative: PRICE.toString(), signature, requestHash } }),
    });
    down = false;
    const json = (await r.json()) as any;
    expect(r.status).toBe(402);
    expect(json.refusal).toMatchObject({ rule: "NET_EXPOSURE", retry: { kind: "after", seconds: HUB_RETRY_SEC, reason: "hub_unreadable" } });
    expect(json.error.details).toMatchObject({ hubUnreadable: true, fundsKnown: false });
  });
});
