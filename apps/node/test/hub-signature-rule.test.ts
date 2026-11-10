/**
 * The node decides with the hub's own signature rule (internal audit F1, F3, F7 and hardening item 2):
 * - a voucher signed with a torsioned R by the Budget's own agent key is refused at intake, before any acceptance is
 *   signed, because the hub would refuse it at settlement;
 * - a Budget whose agent key is small-order or non-canonical is never registered;
 * - a voucher's cumulative must extend the latest accepted one by exactly its amount;
 * - every claim is checked again with the hub rule before a batch is built, and a claim that fails is left out and
 *   reported, so it never fails the batch for everyone else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { signWithTorsionedR } from "@payminto/chain/testing";
import { SCHEME, X402_VERSION, budgetTermsToJson, publicKeyToString, sha256Text, voucherDigest, type Id32, type Keypair, type Policy, type PublicKey } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { DEFAULT_POLICY, OWNER_A, OWNER_B, SELLER, budgetTerms, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;
const tmp = tempDir("payminto-hub-rule-");
let chain: FakeChain;
let node: ClearingNode;
let seller: { id: string; apiKey: string };

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

/** Posts a voucher as the seller; `sign` decides the signature over the voucher digest. */
async function post(b: OpenedBudget, o: { cumulative: bigint; amount?: bigint; request?: string; sign?: (agent: Keypair, digest: Id32) => string }) {
  const amount = o.amount ?? PRICE;
  const requestHash = sha256Text(o.request ?? `req-${Math.random()}`);
  const v = { budgetId: b.id, payee: SELLER, amount, cumulative: o.cumulative, requestHash };
  const signature = o.sign ? o.sign(b.agent, voucherDigest(chain.hub, chain.network, v)) : signVoucher(chain, b.agent, v);
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${seller.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: chain.network, providerId: seller.id, requestHash, payload: { budgetId: b.id, payee: SELLER, amount: amount.toString(), cumulative: o.cumulative.toString(), signature, requestHash } }),
  });
  return { status: r.status, json: (await r.json()) as any };
}

const callRows = (budgetId: Id32) => node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ?", budgetId)!.n;
const alerts = () => node.services.db.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'operator.alert' ORDER BY id").map((r) => (JSON.parse(r.payload) as { alert: Record<string, unknown> }).alert);

let seed = 20;

beforeAll(async () => {
  chain = startFakeChain([OWNER_A, OWNER_B, SELLER]);
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, port: 0, workers: false });
  const p = await admin("POST", "/v1/providers", { name: "seller", payee: SELLER, priceAtomic: PRICE.toString(), resource: "https://seller.example/api" });
  expect(p.status).toBe(201);
  seller = p.json;
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("F1: the node refuses at intake what the hub would refuse at settlement", () => {
  it("refuses a voucher the agent signed with a torsioned R, signs no acceptance, and takes the honest one", async () => {
    const b = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(seed++));
    const request = "torsioned";
    const bad = await post(b, { cumulative: PRICE, request, sign: (agent, digest) => signWithTorsionedR(agent.secretKey, digest) });
    expect(bad.status).toBe(402);
    expect(bad.json).toEqual({ error: { code: "BAD_SIGNATURE", message: "Voucher is not signed by the Budget agent" } });
    expect(bad.json.receipt).toBeUndefined();
    expect(callRows(b.id)).toBe(0);
    expect((await admin("GET", `/v1/budgets/${b.id}/position?payee=${SELLER}`)).json).toMatchObject({ cumulative: "0" });

    const good = await post(b, { cumulative: PRICE, request });
    expect(good.status).toBe(200);
    expect(good.json.receipt).toMatchObject({ budgetId: b.id, cumulative: PRICE.toString() });
  });
});

describe("F7: cumulative is the only authority on chain, so the node binds it to the amount", () => {
  it("refuses a voucher that says one call's price but moves cumulative much further, and says what to sign", async () => {
    const b = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(seed++));
    expect((await post(b, { cumulative: PRICE })).status).toBe(200);
    // The audit's case: amount 1 call, cumulative jumps by 400 calls. On chain this would settle all 400.
    const jump = await post(b, { cumulative: PRICE * 401n });
    expect(jump.status).toBe(402);
    expect(jump.json.refusal).toMatchObject({ rule: "STALE_CUMULATIVE", retry: { kind: "resign", expectedCumulative: (PRICE * 2n).toString() } });
    // And a step below the amount, the replay shape, is refused the same way.
    const short = await post(b, { cumulative: PRICE + 1n });
    expect(short.json.refusal).toMatchObject({ rule: "STALE_CUMULATIVE" });
    expect((await admin("GET", `/v1/budgets/${b.id}/position?payee=${SELLER}`)).json).toMatchObject({ cumulative: PRICE.toString() });
  });
});

describe("F3: the node never registers a Budget whose agent key anyone can sign for", () => {
  const register = async (agentPk: PublicKey) => {
    const { terms, policy } = budgetTerms(OWNER_A, testKey(seed++), { policy: DEFAULT_POLICY as Policy });
    const weak = { ...terms, agentPk };
    // The hub v1 takes any 32 bytes as agent_pk, so the Budget exists on chain; only the node can refuse it.
    chain.openBudget(OWNER_A, weak);
    return admin("POST", "/v1/budgets", { budget: budgetTermsToJson(weak), policy, label: "weak key" });
  };

  it.each([
    ["the all-zero key (order 4)", publicKeyToString(new Uint8Array(32))],
    ["a point of order 8", publicKeyToString(Buffer.from("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", "hex"))],
    ["the identity written with y = p + 1 (non-canonical)", publicKeyToString(Buffer.from(`ee${"ff".repeat(30)}7f`, "hex"))],
  ])("refuses %s with WEAK_AGENT_KEY", async (_what, agentPk) => {
    const r = await register(agentPk);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: "WEAK_AGENT_KEY" });
    expect(r.json.error.message).toMatch(/small-order or non-canonical/);
  });
});

describe("hardening 2: every claim is checked with the hub rule before a batch is built", () => {
  it("leaves out and reports a claim whose stored signature the hub would refuse, and settles the rest", async () => {
    const a = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(seed++));
    const b = await openBudget(chain, node.url, ADMIN, OWNER_B, testKey(seed++));
    expect((await post(a, { cumulative: PRICE, request: "a1" })).status).toBe(200);
    expect((await post(b, { cumulative: PRICE, request: "b1" })).status).toBe(200);
    // A call accepted before the node used the hub rule: its stored signature is the agent's torsioned one.
    const row = node.services.db.get<{ seq: number; request_hash: Id32 }>("SELECT seq, request_hash FROM calls WHERE budget_id = ?", a.id)!;
    const digest = voucherDigest(chain.hub, chain.network, { budgetId: a.id, payee: SELLER, amount: PRICE, cumulative: PRICE, requestHash: row.request_hash });
    node.services.db.run("UPDATE calls SET agent_signature = ? WHERE seq = ?", signWithTorsionedR(a.agent.secretKey, digest), row.seq);

    const out = (await admin("POST", "/v1/settlements")).json;
    // Earlier tests left calls of OWNER_A's other Budgets, which settle in batches of their own (one Budget per owner).
    const claimed: string[] = [];
    for (const id of out.batchIds) claimed.push(...(await admin("GET", `/v1/batches/${id}`)).json.claimList.map((c: { budgetId: string }) => c.budgetId));
    expect(claimed).toContain(b.id);
    expect(claimed).not.toContain(a.id);
    expect(out.dropped).toEqual([{ budgetId: a.id, payee: SELLER, reason: "the voucher signature fails the hub's ed25519 rule" }]);
    expect(await chain.settledOf(b.id, SELLER)).toBe(PRICE);
    expect(await chain.settledOf(a.id, SELLER)).toBe(0n);
    expect(alerts()).toContainEqual(expect.objectContaining({ kind: "claim_signature_invalid", budgetId: a.id, payee: SELLER, cumulative: PRICE.toString() }));
    // The call is not lost: it stays accepted, and a later run reports it again rather than failing a batch.
    expect(node.services.db.get<{ status: string }>("SELECT status FROM calls WHERE seq = ?", row.seq)!.status).toBe("accepted");
    const again = (await admin("POST", "/v1/settlements")).json;
    expect(again.dropped).toEqual([{ budgetId: a.id, payee: SELLER, reason: "the voucher signature fails the hub's ed25519 rule" }]);
  });
});
