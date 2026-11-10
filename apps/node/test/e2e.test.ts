/**
 * The clearing story end to end on FakeChain, the way the demo tells it: three Budget owners (one a DAO) whose agents
 * buy from each other and from a seller, a paid response trying to send money to an attacker, an agent over its cap,
 * settlement that clears more gross than the tokens it moves, a random call proven against the hub's root, payouts,
 * and the books. The node restarts in the middle, on the same database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { receiptLeaf, SCHEME, sha256Text, verifyMerkleProof, X402_VERSION, type AccountId, type Policy } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { receiptVerifiedOnchain } from "../src/proofs.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const DAO = "research.sputnik-dao.testnet";
const SELLER = "data-seller.testnet";
const ATTACKER = "attacker.testnet";
const PRICE = 1_000n;
const tmp = tempDir("payminto-e2e-");
let chain: FakeChain;
let node: ClearingNode;

const config = () => testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN });
const start = () => startNode(config(), { chain, logger: silentLogger, port: 0, workers: false });
const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

type Api = { id: string; apiKey: string; payee: AccountId };
const cumulative = new Map<string, bigint>();

async function pay(p: Api, b: OpenedBudget) {
  const key = `${b.id}:${p.payee}`;
  const next = (cumulative.get(key) ?? 0n) + PRICE;
  const requestHash = sha256Text(`req-${Math.random()}`);
  const signature = signVoucher(chain, b.agent, { budgetId: b.id, payee: p.payee, amount: PRICE, cumulative: next, requestHash });
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: chain.network, providerId: p.id, requestHash, payload: { budgetId: b.id, payee: p.payee, amount: PRICE.toString(), cumulative: next.toString(), signature, requestHash } }),
  });
  const json = (await r.json()) as any;
  if (r.status === 200) cumulative.set(key, next);
  return { status: r.status, json };
}

let alice: OpenedBudget;
let bob: OpenedBudget;
let dao: OpenedBudget;
const api: Record<string, Api> = {};

beforeAll(async () => {
  chain = startFakeChain([ALICE, BOB, DAO, SELLER]);
  node = await start();
  const policy: Policy = { perCallCap: "5000", dailyCap: "1000000", maxCallsPerMinute: 0, purpose: "research" };
  // Small escrows: each owner spends more gross than it escrows, and clears because the others owe it back.
  alice = await openBudget(chain, node.url, ADMIN, ALICE, testKey(11), { escrow: 20_000n, policy, payees: [BOB, DAO, SELLER] });
  bob = await openBudget(chain, node.url, ADMIN, BOB, testKey(12), { escrow: 20_000n, policy, payees: [ALICE, DAO, SELLER] });
  // The DAO's Budget has a small cap to show the over-cap refusal.
  dao = await openBudget(chain, node.url, ADMIN, DAO, testKey(13), { escrow: 20_000n, cap: 30_000n, policy, payees: [ALICE, BOB] });
  for (const payee of [ALICE, BOB, DAO, SELLER, ATTACKER]) {
    const r = await admin("POST", "/v1/providers", { name: `sells-${payee}`, payee, priceAtomic: PRICE.toString(), resource: `https://${payee}/api` });
    api[payee] = { ...(r.json as { id: string; apiKey: string }), payee };
  }
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("the clearing story", () => {
  it("accepts calls between three owners and a seller, and refuses the attacker payee and the over-cap call", async () => {
    // Round 1: Alice buys 15 from Bob, Bob 12 from the DAO, the DAO 14 from Alice, and both companies 3 from the seller.
    const plan: Array<[OpenedBudget, AccountId, number]> = [
      [alice, BOB, 15],
      [bob, DAO, 12],
      [dao, ALICE, 14],
      [alice, SELLER, 3],
      [bob, SELLER, 3],
    ];
    for (const [b, payee, n] of plan) for (let i = 0; i < n; i++) expect((await pay(api[payee]!, b)).status).toBe(200);

    // A paid response told Alice's agent to pay an attacker: the payee list refuses it, and says retrying is useless.
    const attack = await pay(api[ATTACKER]!, alice);
    expect(attack.status).toBe(402);
    expect(attack.json.refusal).toMatchObject({ rule: "PAYEE_NOT_ALLOWED", attemptedAmount: "1000", retry: { kind: "never" } });
    expect((await admin("GET", `/v1/denials`)).json[0]).toMatchObject({ rule: "PAYEE_NOT_ALLOWED", payee: ATTACKER });
  });

  it("restarts on the same database and keeps every position", async () => {
    await node.stop();
    node = await start();
    expect((await admin("GET", `/v1/budgets/${alice.id}`)).json.spend).toMatchObject({ pending: "18000", settled: "0" });
  });

  it("settles more gross than the tokens it moves, keeping the hub solvent", async () => {
    const preview = (await admin("GET", "/v1/netting/preview")).json;
    expect(preview).toMatchObject({ calls: 47, grossTotal: "47000" });
    const out = (await admin("POST", "/v1/settlements")).json;
    expect(out.batchIds).toHaveLength(1);
    const batch = (await chain.batch(out.batchIds[0], chain.operator))!;
    // Alice: 18,000 out, 14,000 in. Bob: 15,000 out, 15,000 in. DAO: 14,000 out, 12,000 in. Seller: 6,000 in.
    expect(batch).toMatchObject({ gross: 47_000n, net: 6_000n });
    expect((await chain.budget(alice.id))!.escrow).toBe(16_000n);
    expect((await chain.budget(bob.id))!.escrow).toBe(20_000n);
    expect((await chain.budget(dao.id))!.escrow).toBe(18_000n);
    expect(await chain.creditOf(SELLER)).toBe(6_000n);
    chain.solvency();
    const overview = (await admin("GET", "/v1/overview")).json;
    expect(overview.settled).toEqual({ gross: "47000", net: "6000" });
  });

  it("refuses the DAO's call over its cap even with escrow left", async () => {
    // The DAO has spent 14,000 of its 30,000 cap; 16 more fit and the 17th does not.
    for (let i = 0; i < 16; i++) expect((await pay(api[ALICE]!, dao)).status).toBe(200);
    const over = await pay(api[ALICE]!, dao);
    expect(over.json.refusal).toMatchObject({ rule: "TOTAL_CAP", remainingBudget: "0", retry: { kind: "never" } });
  });

  it("proves a random settled call against the root stored on the hub, and nothing else", async () => {
    const calls = (await admin("GET", `/v1/calls?status=settled&limit=200`)).json.items as Array<{ id: string }>;
    const pick = calls[Math.floor(Math.random() * calls.length)]!;
    const p = (await admin("GET", `/v1/receipts/${pick.id}/proof`)).json;
    expect(p).toMatchObject({ status: "settled", batchStatus: "confirmed", onchainVerified: true });
    // Anyone can check it with the hub's root and the receipt fields, without trusting the node.
    const fields = { callId: p.receipt.callId, budgetId: p.receipt.budgetId, payee: p.receipt.payee, amount: BigInt(p.receipt.amount), cumulative: BigInt(p.receipt.cumulative), requestHash: p.receipt.requestHash, timestampMs: BigInt(p.receipt.timestamp) * 1000n, voucherSig: p.receipt.voucherSig };
    const root = (await chain.batch(p.batchId, chain.operator))!.root;
    expect(receiptLeaf(chain.hub, chain.network, p.batchId, fields)).toBe(p.leaf);
    expect(verifyMerkleProof(root, p.leaf, p.proof)).toBe(true);
    expect(await chain.verifyReceipt(p.batchId, chain.operator, fields, p.proof)).toBe(true);
    // A changed amount, or a proof from another call, does not verify.
    expect(await chain.verifyReceipt(p.batchId, chain.operator, { ...fields, amount: fields.amount + 1n }, p.proof)).toBe(false);
    const attestation = { callId: fields.callId, budgetId: fields.budgetId, payee: fields.payee, amount: fields.amount, cumulative: fields.cumulative, requestHash: fields.requestHash, timestamp: BigInt(p.receipt.timestamp), voucherSig: fields.voucherSig };
    // The node counts a proof only for its own batches and its own signature.
    expect(await receiptVerifiedOnchain(chain, "someone-else.testnet", node.services.chain.nodeKey, p.batchId, fields, attestation, p.receipt.nodeSignature, p.proof)).toBe(false);
    expect(await receiptVerifiedOnchain(chain, chain.operator, testKey(99).publicKey, p.batchId, fields, attestation, p.receipt.nodeSignature, p.proof)).toBe(false);
  });

  it("pays out the creditors and books balance", async () => {
    // The DAO calls above are unsettled; settle them first, then pay out everyone the hub owes.
    expect((await admin("POST", "/v1/settlements")).json.batchIds).toHaveLength(1);
    const credits = await Promise.all([SELLER, ALICE].map((a) => chain.creditOf(a)));
    expect(credits).toEqual([6_000n, 16_000n]);
    const before = await chain.balanceOf(SELLER);
    const out = (await admin("POST", "/v1/payouts")).json;
    expect(out.payouts.flatMap((p: { items: unknown[] }) => p.items)).toEqual(
      expect.arrayContaining([expect.objectContaining({ account: SELLER, paid: "6000", outcome: "paid" }), expect.objectContaining({ account: ALICE, paid: "16000", outcome: "paid" })]),
    );
    expect(await chain.balanceOf(SELLER)).toBe(before + 6_000n);
    chain.solvency();
    expect((await admin("GET", "/v1/ledger/trial-balance")).json).toMatchObject({ balanced: true, balance: "0" });
    const books = (await admin("GET", "/v1/settlements/export")).json;
    expect(books.totals).toMatchObject({ batches: 2, gross: "63000" });
    for (const p of books.parties) expect(BigInt(p.grossOut) - BigInt(p.grossIn)).toBe(BigInt(p.netDebit) - BigInt(p.netCredit));
  });
});
