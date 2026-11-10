/**
 * The node's limits on payees new to a Budget (internal audit F4). The first settlement of a (Budget, payee) pair makes
 * the node's settler pay permanent hub storage whatever the amount, so dust payments to many new payees would drain it.
 * Both refusals are recorded and signed like every other node refusal, with a retry hint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { SCHEME, X402_VERSION, sha256Text, verifyDigest, type AccountId } from "@payminto/protocol";
import { DEFAULT_NEW_PAYEE_LIMITS, loadConfig, redactedConfig } from "../src/config.ts";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const tmp = tempDir("payminto-new-payees-");
let chain: FakeChain;
let node: ClearingNode;
const sellers = new Map<AccountId, { id: string; apiKey: string; price: bigint }>();

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

const positions = new Map<string, bigint>();
async function pay(b: OpenedBudget, payee: AccountId) {
  const s = sellers.get(payee)!;
  const key = `${b.id}:${payee}`;
  const cumulative = (positions.get(key) ?? 0n) + s.price;
  const requestHash = sha256Text(`req-${Math.random()}`);
  const signature = signVoucher(chain, b.agent, { budgetId: b.id, payee, amount: s.price, cumulative, requestHash });
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: chain.network, providerId: s.id, requestHash, payload: { budgetId: b.id, payee, amount: s.price.toString(), cumulative: cumulative.toString(), signature, requestHash } }),
  });
  const json = (await r.json()) as any;
  if (r.status === 200) positions.set(key, cumulative);
  return { status: r.status, json };
}

const PAYEES = ["p1.testnet", "p2.testnet", "p3.testnet", "p4.testnet"] as const;
const DUST = "dust.testnet";

beforeAll(async () => {
  chain = startFakeChain([OWNER_A, ...PAYEES, DUST]);
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, newPayees: { minFirstAmount: 1_500n, maxPerHour: 2 } }), { chain, logger: silentLogger, port: 0, workers: false });
  for (const [payee, price] of [...PAYEES.map((p) => [p, 2_000n] as const), [DUST, 1_000n] as const]) {
    const p = await admin("POST", "/v1/providers", { name: payee, payee, priceAtomic: price.toString(), resource: `https://${payee}/api` });
    expect(p.status).toBe(201);
    sellers.set(payee, { id: p.json.id, apiKey: p.json.apiKey, price });
  }
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("payees new to a Budget", () => {
  let b: OpenedBudget;

  it("refuses a first payment below NEW_PAYEE_MIN_AMOUNT, signed and recorded, with no retry", async () => {
    b = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(40));
    const r = await pay(b, DUST);
    expect(r.status).toBe(402);
    expect(r.json.refusal).toEqual({
      rule: "NEW_PAYEE_MIN_AMOUNT",
      message: "A first payment to a payee new to this Budget is below this node's minimum",
      attemptedAmount: "1000",
      remainingBudget: expect.any(String),
      retry: { kind: "never" },
    });
    expect(r.json.error.details).toMatchObject({ payee: DUST, amount: "1000", minFirstAmount: "1500" });
    // The refusal is the node's signed record, like every other.
    const record = r.json.error.details.record;
    expect(record).toMatchObject({ id: expect.stringMatching(/^dny_/), node: node.services.chain.nodeKey });
    expect(verifyDigest(record.node, record.digest, record.nodeSignature)).toBe(true);
  });

  it("allows NEW_PAYEES_PER_HOUR new payees, then refuses the next with the seconds until one leaves the hour", async () => {
    expect((await pay(b, PAYEES[0])).status).toBe(200);
    expect((await pay(b, PAYEES[1])).status).toBe(200);
    const r = await pay(b, PAYEES[2]);
    expect(r.status).toBe(402);
    expect(r.json.refusal).toMatchObject({ rule: "NEW_PAYEE_RATE", retry: { kind: "after" } });
    // The first new payee was paid moments ago: its slot frees up close to an hour from now.
    expect(r.json.refusal.retry.seconds).toBeGreaterThan(3_590);
    expect(r.json.refusal.retry.seconds).toBeLessThanOrEqual(3_600);
    expect(r.json.error.details).toMatchObject({ payee: PAYEES[2], newPayeesLastHour: 2, maxNewPayeesPerHour: 2 });
  });

  it("never limits a payee the Budget already paid", async () => {
    for (let i = 0; i < 3; i++) expect((await pay(b, PAYEES[0])).status).toBe(200);
    expect((await pay(b, PAYEES[1])).status).toBe(200);
  });

  it("counts per Budget: another Budget of the same owner has its own quota", async () => {
    const other = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(41));
    expect((await pay(other, PAYEES[2])).status).toBe(200);
    expect((await pay(other, PAYEES[3])).status).toBe(200);
  });
});

describe("configuration", () => {
  const env = {
    HUB_ACCOUNT: "hub.payminto.testnet",
    OPERATOR_ACCOUNT: "node.payminto.testnet",
    OPERATOR_KEY: "ed25519:LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ",
    NODE_SIGNING_SEED: "22".repeat(32),
    ADMIN_TOKEN: "a".repeat(32),
  };

  it("defaults to a 0.001 USDC first payment and 20 new payees per Budget per hour, and reads both from the environment", () => {
    expect(DEFAULT_NEW_PAYEE_LIMITS).toEqual({ minFirstAmount: 1_000n, maxPerHour: 20 });
    expect(loadConfig(env).newPayees).toEqual(DEFAULT_NEW_PAYEE_LIMITS);
    expect(loadConfig({ ...env, NEW_PAYEE_MIN_AMOUNT: "0", NEW_PAYEES_PER_HOUR: "0" }).newPayees).toEqual({ minFirstAmount: 0n, maxPerHour: 0 });
    expect(loadConfig({ ...env, NEW_PAYEE_MIN_AMOUNT: "250000" }).newPayees?.minFirstAmount).toBe(250_000n);
    expect(() => loadConfig({ ...env, NEW_PAYEE_MIN_AMOUNT: "0.5" })).toThrow(/NEW_PAYEE_MIN_AMOUNT/);
    expect(() => loadConfig({ ...env, NEW_PAYEES_PER_HOUR: "-1" })).toThrow(/NEW_PAYEES_PER_HOUR/);
    expect(redactedConfig(loadConfig(env)).newPayees).toEqual({ minFirstAmount: "1000", maxPerHour: 20 });
  });

  it("keeps the default above what any listed Budget can reach: at most 16 payees", () => {
    expect(DEFAULT_NEW_PAYEE_LIMITS.maxPerHour).toBeGreaterThan(16);
  });
});
