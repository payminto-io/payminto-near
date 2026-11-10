/**
 * An agent hears about a refusal from the seller it called, and a seller can say anything. The agent confirms it with
 * its own node: the node's record of the refusal, by Budget and request hash, signed with the node's receipt key.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { REFUSAL_DOMAIN, SCHEME, X402_VERSION, nodeDigest, refusalDigest, refusalSignedBy, sha256Text, verifyDigest, type PublicKey, type RefusalRecord } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { callIdOf } from "../src/vouchers.ts";
import { OWNER_A, SELLER, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;
const tmp = tempDir("payminto-refusals-");
let chain: FakeChain;
let node: ClearingNode;
let budget: OpenedBudget;
let seller: { id: string; apiKey: string };
let nodeKey: PublicKey;

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
/** As the agent: no credential, like its position read. */
const lookup = async (budgetId: string, query: string) => {
  const r = await fetch(`${node.url}/v1/budgets/${budgetId}/refusals${query}`);
  return { status: r.status, json: (await r.json()) as any };
};

async function post(o: { amount?: bigint; cumulative: bigint; request: string; signer?: ReturnType<typeof testKey> }) {
  const amount = o.amount ?? PRICE;
  const requestHash = sha256Text(o.request);
  const v = { budgetId: budget.id, payee: SELLER, amount, cumulative: o.cumulative, requestHash };
  const signature = signVoucher(chain, o.signer ?? budget.agent, v);
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${seller.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: chain.network, providerId: seller.id, requestHash, payload: { budgetId: budget.id, payee: SELLER, amount: amount.toString(), cumulative: o.cumulative.toString(), signature, requestHash } }),
  });
  return { status: r.status, json: (await r.json()) as any, voucher: { ...v, signature } };
}

beforeAll(async () => {
  chain = startFakeChain();
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, port: 0, workers: false });
  budget = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(1), { escrow: 1_500n });
  seller = (await admin("POST", "/v1/providers", { name: "seller", payee: SELLER, priceAtomic: PRICE.toString(), resource: "https://seller.example/api" })).json;
  nodeKey = ((await (await fetch(`${node.url}/v1/info`)).json()) as { nodeKey: PublicKey }).nodeKey;
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("the node's own record of a refusal", () => {
  let refused: Awaited<ReturnType<typeof post>>;

  it("is returned to the agent by Budget and request hash, with the refusal the node gave", async () => {
    expect((await post({ cumulative: 1_000n, request: "first" })).status).toBe(200);
    // 1,000 unsettled against 1,500 of escrow: the next call is refused.
    refused = await post({ cumulative: 2_000n, request: "second" });
    expect(refused.status).toBe(402);
    expect(refused.json.refusal).toMatchObject({ rule: "NET_EXPOSURE", retry: { kind: "fund", shortBy: "500" } });

    const r = await lookup(budget.id, `?requestHash=${sha256Text("second")}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ budgetId: budget.id, requestHash: sha256Text("second"), node: nodeKey, hub: chain.hub, network: chain.network });
    expect(r.json.refusals).toHaveLength(1);
    expect(r.json.refusals[0]).toEqual({
      id: expect.stringMatching(/^dny_[0-9a-f]{16}$/),
      budgetId: budget.id,
      payee: SELLER,
      amount: "1000",
      cumulative: "2000",
      requestHash: sha256Text("second"),
      callId: callIdOf(refused.voucher),
      timestamp: expect.any(Number),
      lastSeen: expect.any(Number),
      repeats: 1,
      refusal: refused.json.refusal,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      nodeSignature: expect.stringMatching(/^[0-9a-f]{128}$/),
      node: nodeKey,
    });
  });

  it("is signed with the node's receipt key over a digest that is not an acceptance", async () => {
    const rec = (await lookup(budget.id, `?requestHash=${sha256Text("second")}`)).json.refusals[0];
    const facts: RefusalRecord = { id: rec.id, budgetId: rec.budgetId, payee: rec.payee, amount: rec.amount, cumulative: rec.cumulative, requestHash: rec.requestHash, timestamp: rec.timestamp, refusal: rec.refusal };
    expect(refusalDigest(chain.hub, chain.network, facts)).toBe(rec.digest);
    expect(refusalSignedBy(chain.hub, chain.network, facts, rec.nodeSignature, nodeKey)).toBe(true);
    // The documented preimage, spelled out.
    const r = rec.refusal;
    expect(rec.digest).toBe(
      sha256Text([REFUSAL_DOMAIN, chain.hub, chain.network, rec.id, rec.budgetId, rec.payee, "1000", "2000", rec.requestHash, "NET_EXPOSURE", r.attemptedAmount, r.remainingBudget, "fund", "500", rec.timestamp].join("|")),
    );
    // Anything a relaying seller changes breaks it: the rule, the hint, the amounts, the Budget.
    for (const forged of [
      { ...facts, refusal: { ...facts.refusal, rule: "BUDGET_REVOKED" as const } },
      { ...facts, refusal: { ...facts.refusal, retry: { kind: "fund" as const, shortBy: "999999" } } },
      { ...facts, refusal: { ...facts.refusal, retry: { kind: "never" as const } } },
      { ...facts, cumulative: "3000" },
      { ...facts, budgetId: "ab".repeat(32) },
    ]) {
      expect(refusalSignedBy(chain.hub, chain.network, forged, rec.nodeSignature, nodeKey)).toBe(false);
    }
    expect(refusalSignedBy("other.hub.testnet", chain.network, facts, rec.nodeSignature, nodeKey)).toBe(false);
    // A refusal signature is never a receipt: it does not verify as the node's acceptance of the same voucher.
    const asAcceptance = nodeDigest({ callId: rec.callId, budgetId: rec.budgetId, payee: rec.payee, amount: 1_000n, cumulative: 2_000n, requestHash: rec.requestHash, timestamp: BigInt(rec.timestamp), voucherSig: refused.voucher.signature });
    expect(verifyDigest(nodeKey, asAcceptance, rec.nodeSignature)).toBe(false);
  });

  it("travels with the 402 as well, so a seller can relay the node's own signed record", async () => {
    const rec = (await lookup(budget.id, `?requestHash=${sha256Text("second")}`)).json.refusals[0];
    expect(refused.json.error.details.record).toEqual({ id: rec.id, timestamp: rec.timestamp, digest: rec.digest, nodeSignature: rec.nodeSignature, node: nodeKey });
  });

  it("folds a replayed refusal into the same record", async () => {
    expect((await post({ cumulative: 2_000n, request: "second" })).status).toBe(402);
    const r = await lookup(budget.id, `?requestHash=${sha256Text("second")}`);
    expect(r.json.refusals).toHaveLength(1);
    expect(r.json.refusals[0].repeats).toBe(2);
  });

  it("has nothing for a request the node accepted, never saw, or never attributed to the agent", async () => {
    expect((await lookup(budget.id, `?requestHash=${sha256Text("first")}`)).json.refusals).toEqual([]);
    expect((await lookup(budget.id, `?requestHash=${sha256Text("never sent")}`)).json.refusals).toEqual([]);
    // A voucher someone else signed is answered with a plain error and leaves no record a seller could point to.
    expect((await post({ cumulative: 2_000n, request: "forged", signer: testKey(9) })).status).toBe(402);
    expect((await lookup(budget.id, `?requestHash=${sha256Text("forged")}`)).json.refusals).toEqual([]);
  });

  it("never vouches for a row recorded before signatures were checked first", async () => {
    // As an older build could have written it for an unsigned voucher: no agent signature on the row.
    const hash = sha256Text("planted");
    node.services.db.run(
      `INSERT INTO denials (id, rule, message, budget_id, agent, payee, provider_id, amount, cumulative, request_hash, details, timestamp, at)
       VALUES ('dny_planted', 'PRICE_MISMATCH', 'm', ?, ?, ?, ?, '999', '999', ?, ?, 1, 'then')`,
      budget.id,
      budget.agent.publicKey,
      SELLER,
      seller.id,
      hash,
      JSON.stringify({ refusal: { rule: "PRICE_MISMATCH", message: "m", attemptedAmount: "999", remainingBudget: "1", retry: { kind: "never" } } }),
    );
    expect((await lookup(budget.id, `?requestHash=${hash}`)).json.refusals).toEqual([]);
    // The operator still sees it.
    expect((await admin("GET", `/v1/budgets/${budget.id}`)).json.denials.map((d: { id: string }) => d.id)).toContain("dny_planted");
  });

  it("narrows by payee and cumulative, and refuses malformed lookups", async () => {
    const hash = sha256Text("second");
    expect((await lookup(budget.id, `?requestHash=${hash}&payee=${SELLER}&cumulative=2000`)).json.refusals).toHaveLength(1);
    expect((await lookup(budget.id, `?requestHash=${hash}&payee=someone.else.testnet`)).json.refusals).toEqual([]);
    expect((await lookup(budget.id, `?requestHash=${hash}&cumulative=9`)).json.refusals).toEqual([]);
    expect((await lookup(budget.id, "")).status).toBe(400);
    expect((await lookup(budget.id, "?requestHash=xyz")).status).toBe(400);
    const unknown = await lookup("ab".repeat(32), `?requestHash=${hash}`);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe("UNKNOWN_BUDGET");
  });
});
