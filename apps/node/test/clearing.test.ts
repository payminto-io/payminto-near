/**
 * The clearing core end to end through FakeChain: a node in-process on a temp SQLite file, Budgets opened on the fake
 * hub, vouchers over HTTP, refusals, offset settlement and an on-chain receipt proof.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { REPEAT_WINDOW_SEC, SCHEME, X402_VERSION, sha256Text, type Policy } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, OWNER_B, SELLER, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;
const tmp = tempDir("payminto-clearing-");
let chain: FakeChain;
let node: ClearingNode;

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

async function provider(name: string, payee: string) {
  const r = await admin("POST", "/v1/providers", { name, payee, priceAtomic: PRICE.toString(), resource: `https://${name}.example/api` });
  expect(r.status).toBe(201);
  return r.json as { id: string; apiKey: string };
}

const cumulative = new Map<string, bigint>();

async function pay(p: { id: string; apiKey: string }, b: OpenedBudget, payee: string, request = `req-${Math.random()}`, amount = PRICE) {
  const key = `${b.id}:${payee}`;
  const next = (cumulative.get(key) ?? 0n) + amount;
  const requestHash = sha256Text(request);
  const signature = signVoucher(chain, b.agent, { budgetId: b.id, payee, amount, cumulative: next, requestHash });
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: chain.network,
      providerId: p.id,
      requestHash,
      payload: { budgetId: b.id, payee, amount: amount.toString(), cumulative: next.toString(), signature, requestHash },
    }),
  });
  const json = (await r.json()) as any;
  if (r.status === 200) cumulative.set(key, next);
  return { status: r.status, json };
}

beforeAll(async () => {
  chain = startFakeChain();
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, port: 0, workers: false });
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("Budgets", () => {
  it("refuses to register a Budget that is not open on the hub", async () => {
    const policy: Policy = { perCallCap: "1000", dailyCap: "1000000", maxCallsPerMinute: 0, purpose: "x" };
    const { budgetTermsToJson, policyHash } = await import("@payminto/protocol");
    const terms = { owner: OWNER_A, agentPk: testKey(9).publicKey, settler: chain.operator, cap: 10_000n, validUntil: BigInt(Date.now() + 60_000), payees: [], policyHash: policyHash(policy), salt: "09".repeat(32) };
    const r = await admin("POST", "/v1/budgets", { budget: budgetTermsToJson(terms), policy, label: "not on chain" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("BUDGET_NOT_ON_CHAIN");
  });

  it("reads a new Budget's escrow from the hub when it is registered, before any Call", async () => {
    // A Budget nobody has called yet used to show no escrow at all, so its owner could not see the deposit arrive.
    const fresh = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(7), { escrow: 3_000_000n });
    const r = await admin("GET", `/v1/budgets/${fresh.id}`);
    expect(r.status).toBe(200);
    expect(r.json.escrow).toBe("3000000");
  });

  it("refuses a Budget whose settler is another node", async () => {
    await expect(openBudget(chain, node.url, ADMIN, OWNER_A, testKey(8), { settler: "other.testnet" })).rejects.toThrow(/WRONG_SETTLER/);
  });
});

describe("clearing through FakeChain", () => {
  let a: OpenedBudget;
  let b: OpenedBudget;
  let sellerApi: { id: string; apiKey: string };
  let bobApi: { id: string; apiKey: string };
  let aliceApi: { id: string; apiKey: string };

  beforeAll(async () => {
    // Small escrow on purpose: Alice and Bob each spend far more gross than they escrow, and clear because they offset.
    const policy: Policy = { perCallCap: "5000", dailyCap: "10000000", hourlyCap: "200000", maxCallsPerMinute: 0, maxRepeatsPerRequest: 2, purpose: "demo" };
    a = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(1), { escrow: 5_000n, policy, payees: [OWNER_B, SELLER] });
    b = await openBudget(chain, node.url, ADMIN, OWNER_B, testKey(2), { escrow: 5_000n, policy });
    sellerApi = await provider("seller", SELLER);
    bobApi = await provider("bob-sells", OWNER_B);
    aliceApi = await provider("alice-sells", OWNER_A);
  });

  it("accepts paid calls with a node-signed receipt", async () => {
    const r = await pay(sellerApi, a, SELLER, "first");
    expect(r.status).toBe(200);
    expect(r.json.receipt).toMatchObject({ budgetId: a.id, payee: SELLER, amount: "1000", cumulative: "1000", node: expect.stringMatching(/^ed25519:/) });
  });

  it("refuses a payee outside the on-chain list with the structured refusal", async () => {
    const attacker = await provider("attacker", "attacker.testnet");
    const r = await pay(attacker, a, "attacker.testnet");
    expect(r.status).toBe(402);
    expect(r.json.error.code).toBe("PAYEE_NOT_ALLOWED");
    expect(r.json.refusal).toMatchObject({ rule: "PAYEE_NOT_ALLOWED", attemptedAmount: "1000", retry: { kind: "never" } });
  });

  it("refuses the third payment for the same request", async () => {
    expect((await pay(sellerApi, a, SELLER, "loop")).status).toBe(200);
    expect((await pay(sellerApi, a, SELLER, "loop")).status).toBe(200);
    const third = await pay(sellerApi, a, SELLER, "loop");
    expect(third.json.error.code).toBe("REPEAT_REQUEST");
    // Not "never": the first of the two counted calls leaves the one-hour window in just under an hour.
    const { retry } = third.json.refusal;
    expect(retry.kind).toBe("after");
    expect(retry.seconds).toBeGreaterThan(REPEAT_WINDOW_SEC - 10);
    expect(retry.seconds).toBeLessThanOrEqual(REPEAT_WINDOW_SEC);
  });

  it("stops new calls fail-closed once unsettled spending exceeds escrow", async () => {
    // Alice has 3,000 outstanding against 5,000 escrow, so two more calls fit and the third does not. Nobody owes Alice
    // anything yet, so settling would debit all 5,000 and leave no room: only more escrow helps.
    expect((await pay(bobApi, a, OWNER_B)).status).toBe(200);
    expect((await pay(bobApi, a, OWNER_B)).status).toBe(200);
    const refused = await pay(bobApi, a, OWNER_B);
    expect(refused.status).toBe(402);
    expect(refused.json.refusal).toMatchObject({ rule: "NET_EXPOSURE", attemptedAmount: "1000", retry: { kind: "fund", shortBy: "1000" } });
  });

  it("tells the agent to wait for settlement once its owner is owed enough in the same window", async () => {
    // Bob owes Alice 2,000 unsettled: settling nets Alice's debit to 3,000 and leaves 2,000 of escrow for this call.
    for (let i = 0; i < 2; i++) expect((await pay(aliceApi, b, OWNER_A)).status).toBe(200);
    const refused = await pay(bobApi, a, OWNER_B);
    expect(refused.json.refusal).toMatchObject({ rule: "NET_EXPOSURE", retry: { kind: "after_settlement" } });
  });

  it("settles offsetting obligations with less cash than gross, and keeps the hub solvent", async () => {
    // Bob owes Alice 4,000 in the same window: 2,000 from the test above and 2,000 more.
    for (let i = 0; i < 2; i++) expect((await pay(aliceApi, b, OWNER_A)).status).toBe(200);
    const preview = (await admin("GET", "/v1/netting/preview")).json;
    expect(preview.grossTotal).toBe("9000");
    const out = (await admin("POST", "/v1/settlements")).json;
    expect(out.batchIds).toHaveLength(1);
    const batch = await chain.batch(out.batchIds[0]);
    // Alice: 5,000 out, 4,000 in. Bob: 4,000 out, 2,000 in. Seller: 3,000 in. Net cash is 3,000 of 9,000 gross.
    expect(batch).toMatchObject({ gross: 9_000n, net: 3_000n, settler: chain.operator });
    expect((await chain.budget(a.id))!.escrow).toBe(4_000n);
    expect((await chain.budget(b.id))!.escrow).toBe(3_000n);
    expect(await chain.creditOf(SELLER)).toBe(3_000n);
    chain.solvency();
    const detail = (await admin("GET", `/v1/batches/${out.batchIds[0]}`)).json;
    expect(detail.status).toBe("confirmed");
    expect(detail.net).toEqual([
      { account: OWNER_A, debit: "1000", credit: "0" },
      { account: OWNER_B, debit: "2000", credit: "0" },
      { account: SELLER, debit: "0", credit: "3000" },
    ]);
    expect((await admin("GET", "/v1/ledger/trial-balance")).status).toBe(200);
  });

  it("proves a settled call against the root stored on the hub", async () => {
    const calls = (await admin("GET", `/v1/calls?budgetId=${a.id}&status=settled`)).json.items;
    const proof = (await admin("GET", `/v1/receipts/${calls[0].id}/proof`)).json;
    expect(proof.batchStatus).toBe("confirmed");
    expect(proof.onchainVerified).toBe(true);
  });

  it("frees the exposure limit once the batch confirmed", async () => {
    expect((await pay(bobApi, a, OWNER_B)).status).toBe(200);
  });

  it("never counts hub credit as room, and names fund_from_credit when the owner has credit", async () => {
    // The seller holds 3,000 of hub credit from the batch above, but its new Budget escrows only 1,000.
    expect(await chain.creditOf(SELLER)).toBe(3_000n);
    const s = await openBudget(chain, node.url, ADMIN, SELLER, testKey(4), { escrow: 1_000n });
    expect((await pay(bobApi, s, OWNER_B)).status).toBe(200);
    const refused = await pay(bobApi, s, OWNER_B);
    expect(refused.status).toBe(402);
    expect(refused.json.refusal).toMatchObject({
      rule: "NET_EXPOSURE",
      remainingBudget: "99999000",
      retry: { kind: "fund", shortBy: "1000", fromCredit: { action: "fund_from_credit", budgetId: s.id, amount: "1000", credit: "3000" } },
    });
  });

  it("stops accepting a revoked Budget and hands the owner the on-chain revoke", async () => {
    const r = await admin("POST", `/v1/budgets/${b.id}/revoke`, {});
    expect(r.json.onchain.call).toMatchObject({ receiverId: chain.hub, actions: [{ params: { methodName: "revoke_budget" } }] });
    expect((await pay(aliceApi, b, OWNER_A)).json.error.code).toBe("BUDGET_REVOKED");
  });
});

describe("revoked or expired Budgets fail closed inside the hub's grace period", () => {
  let api: { id: string; apiKey: string };
  beforeAll(async () => {
    api = await provider("grace-seller", SELLER);
  });

  it("refuses new calls after an owner revokes on chain, while calls accepted before still settle", async () => {
    const g = await openBudget(chain, node.url, ADMIN, OWNER_B, testKey(5));
    expect((await pay(api, g, SELLER, "before revoke")).status).toBe(200);
    await chain.revokeBudget(OWNER_B, g.id);
    await node.services.budgets.scanRevocations();
    const refused = await pay(api, g, SELLER, "after revoke");
    expect(refused.json.refusal).toMatchObject({ rule: "BUDGET_REVOKED", retry: { kind: "never" } });
    // The hub's revoke grace is for exactly this: the call served before the revoke settles.
    const out = (await admin("POST", "/v1/settlements")).json;
    expect(out.batchIds).toHaveLength(1);
    expect(await chain.settledOf(g.id, SELLER)).toBe(PRICE);
  });

  it("refuses new calls once validUntil passes, while the earlier call still settles", async () => {
    const g = await openBudget(chain, node.url, ADMIN, OWNER_B, testKey(6), { validUntil: BigInt(Date.now() + 1_200) });
    expect((await pay(api, g, SELLER, "before expiry")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_300));
    const refused = await pay(api, g, SELLER, "after expiry");
    expect(refused.status, JSON.stringify(refused.json)).toBe(402);
    expect(refused.json.refusal).toMatchObject({ rule: "BUDGET_NOT_ACTIVE", retry: { kind: "never" } });
    expect((await admin("POST", "/v1/settlements")).json.batchIds).toHaveLength(1);
    expect(await chain.settledOf(g.id, SELLER)).toBe(PRICE);
  });
});
