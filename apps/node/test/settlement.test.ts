/**
 * Settlement completeness through FakeChain: sends without a verdict (late landings, adoption, restarts), hub refusals,
 * payout scheduling in calls of at most 10 accounts, the gross-per-counterparty export, and refusal webhooks.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeChain } from "@payminto/chain/fake";
import {
  ChainError,
  SCHEME,
  X402_VERSION,
  sha256Text,
  verifyWebhook,
  type AccountId,
  type Chain,
  type ChainPayment,
  type Id32,
  type ReceiptFields,
  type SettleArgs,
  type TxHash,
  type TxState,
} from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, OWNER_B, SELLER, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;

/** A hub write the test controls: lands or not, answers or not. */
type SettleMode = "ok" | "land-then-throw" | "throw-before" | "refuse" | "hold";

/** FakeChain behind a seam that can drop answers the way a real RPC connection does. */
class FlakyChain implements Chain {
  readonly hub: AccountId;
  readonly token: AccountId;
  readonly network;
  readonly operator: AccountId;
  settleMode: SettleMode = "ok";
  /** Sends that never reached the hub, for the test to land later. */
  readonly unsent: SettleArgs[] = [];
  readonly held: Array<{ resolve: (h: TxHash) => void; reject: (e: Error) => void }> = [];
  readonly payoutCalls: AccountId[][] = [];

  readonly inner: FakeChain;

  constructor(inner: FakeChain) {
    this.inner = inner;
    this.hub = inner.hub;
    this.token = inner.token;
    this.network = inner.network;
    this.operator = inner.operator;
  }

  budget(id: Id32) {
    return this.inner.budget(id);
  }
  settledOf(id: Id32, payee: AccountId) {
    return this.inner.settledOf(id, payee);
  }
  creditOf(a: AccountId) {
    return this.inner.creditOf(a);
  }
  balanceOf(a: AccountId) {
    return this.inner.balanceOf(a);
  }
  batch(id: Id32, settler: AccountId) {
    return this.inner.batch(id, settler);
  }
  payments(ids: readonly Id32[]): Promise<Array<ChainPayment | null>> {
    return this.inner.payments(ids);
  }
  isRegistered(a: AccountId) {
    return this.inner.isRegistered(a);
  }
  receiptKeys(settler: AccountId) {
    return this.inner.receiptKeys(settler);
  }
  storageOf(a: AccountId) {
    return this.inner.storageOf(a);
  }
  txState(h: TxHash): Promise<TxState> {
    return this.inner.txState(h);
  }
  verifyReceipt(id: Id32, settler: AccountId, f: ReceiptFields, p: readonly Id32[]) {
    return this.inner.verifyReceipt(id, settler, f, p);
  }
  async payout(accounts: readonly AccountId[]): Promise<TxHash> {
    this.payoutCalls.push([...accounts]);
    return this.inner.payout(accounts);
  }
  async settle(args: SettleArgs): Promise<TxHash> {
    switch (this.settleMode) {
      case "ok":
        return this.inner.settle(args);
      case "land-then-throw":
        await this.inner.settle(args);
        throw new Error("fetch failed: socket hang up");
      case "throw-before":
        this.unsent.push(args);
        throw new Error("request timed out");
      case "refuse":
        throw new ChainError("NOT_SETTLER", "refused for the test");
      case "hold": {
        const hash = await this.inner.settle(args);
        void hash;
        return new Promise<TxHash>((resolve, reject) => this.held.push({ resolve, reject }));
      }
    }
  }
}

const tmp = tempDir("payminto-settlement-");
let fake: FakeChain;
let chain: FlakyChain;
let node: ClearingNode;

const call = async (n: ClearingNode, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${n.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, text, headers: r.headers };
};
const admin = (method: string, path: string, body?: unknown) => call(node, method, path, body);

async function provider(n: ClearingNode, name: string, payee: AccountId) {
  const r = await call(n, "POST", "/v1/providers", { name, payee, priceAtomic: PRICE.toString(), resource: `https://${name}.example/api` });
  expect(r.status).toBe(201);
  return r.json as { id: string; apiKey: string };
}

const cumulative = new Map<string, bigint>();
async function pay(n: ClearingNode, p: { id: string; apiKey: string }, b: OpenedBudget, payee: AccountId) {
  const key = `${b.id}:${payee}`;
  const next = (cumulative.get(key) ?? 0n) + PRICE;
  const requestHash = sha256Text(`req-${Math.random()}`);
  const signature = signVoucher(fake, b.agent, { budgetId: b.id, payee, amount: PRICE, cumulative: next, requestHash });
  const r = await fetch(`${n.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: fake.network, providerId: p.id, requestHash, payload: { budgetId: b.id, payee, amount: PRICE.toString(), cumulative: next.toString(), signature, requestHash } }),
  });
  const json = (await r.json()) as any;
  if (r.status === 200) cumulative.set(key, next);
  return { status: r.status, json };
}

const batches = async () => (await admin("GET", "/v1/batches")).json as Array<{ id: string; seq: number; status: string; error: string | null }>;

let budget: OpenedBudget;
let seller: { id: string; apiKey: string };

beforeAll(async () => {
  fake = startFakeChain();
  chain = new FlakyChain(fake);
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, port: 0, workers: false });
  budget = await openBudget(fake, node.url, ADMIN, OWNER_A, testKey(1), { escrow: 50_000_000n });
  seller = await provider(node, "seller", SELLER);
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("sends without a verdict", () => {
  it("books a batch that landed although the send reported an error", async () => {
    for (let i = 0; i < 2; i++) expect((await pay(node, seller, budget, SELLER)).status).toBe(200);
    chain.settleMode = "land-then-throw";
    const out = (await admin("POST", "/v1/settlements")).json;
    chain.settleMode = "ok";
    expect(out.batchIds).toHaveLength(1);
    expect((await admin("GET", `/v1/batches/${out.batchIds[0]}`)).json.status).toBe("confirmed");
    expect(await fake.settledOf(budget.id, SELLER)).toBe(2_000n);
    expect((await admin("GET", "/v1/calls?status=accepted")).json.items).toHaveLength(0);
  });

  it("returns the calls to the queue when nothing answers, and adopts the batch when it lands later", async () => {
    expect((await pay(node, seller, budget, SELLER)).status).toBe(200);
    chain.settleMode = "throw-before";
    const first = (await admin("POST", "/v1/settlements")).json;
    chain.settleMode = "ok";
    expect(first.skipped).toBeDefined();
    const unknown = (await batches())[0]!;
    expect(unknown).toMatchObject({ status: "unknown", error: "request timed out" });
    expect((await admin("GET", "/v1/calls?status=accepted")).json.items).toHaveLength(1);

    // Another call arrives, then the lost send reaches the hub after all.
    expect((await pay(node, seller, budget, SELLER)).status).toBe(200);
    await fake.settle(chain.unsent.shift()!);
    expect(await fake.settledOf(budget.id, SELLER)).toBe(3_000n);

    const next = (await admin("POST", "/v1/settlements")).json;
    expect(next.batchIds).toHaveLength(1);
    expect((await admin("GET", `/v1/batches/${unknown.id}`)).json.status).toBe("confirmed");
    expect(await fake.settledOf(budget.id, SELLER)).toBe(4_000n);
    expect((await admin("GET", "/v1/calls?status=accepted")).json.items).toHaveLength(0);
    // The adopted calls prove against the root the hub stored for the late batch.
    const adopted = (await admin("GET", `/v1/batches/${unknown.id}`)).json.callList;
    expect(adopted).toHaveLength(1);
    expect((await admin("GET", `/v1/receipts/${adopted[0].id}/proof`)).json.onchainVerified).toBe(true);
    fake.solvency();
  });

  it("fails a batch the hub refuses and settles its calls in the next batch", async () => {
    expect((await pay(node, seller, budget, SELLER)).status).toBe(200);
    chain.settleMode = "refuse";
    await admin("POST", "/v1/settlements");
    chain.settleMode = "ok";
    expect((await batches())[0]).toMatchObject({ status: "failed" });
    expect((await admin("POST", "/v1/settlements")).json.batchIds).toHaveLength(1);
    expect(await fake.settledOf(budget.id, SELLER)).toBe(5_000n);
  });

  it("after a restart, books a batch that was in flight when the node stopped", async () => {
    expect((await pay(node, seller, budget, SELLER)).status).toBe(200);
    chain.settleMode = "hold";
    const inFlight = admin("POST", "/v1/settlements");
    for (let i = 0; i < 100 && chain.held.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(chain.held).toHaveLength(1);
    expect((await batches())[0]).toMatchObject({ status: "submitted" });
    chain.settleMode = "ok";

    // A second process on the same database, as after a crash and restart: recovery asks the hub and books the batch.
    const restarted = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, port: 0, workers: false });
    try {
      const list = (await call(restarted, "GET", "/v1/batches")).json;
      expect(list[0]).toMatchObject({ status: "confirmed" });
      expect((await call(restarted, "GET", "/v1/calls?status=settling")).json.items).toHaveLength(0);
    } finally {
      await restarted.stop();
    }
    chain.held.shift()!.reject(new Error("connection reset"));
    await inFlight;
    expect((await batches())[0]).toMatchObject({ status: "confirmed" });
    expect(await fake.settledOf(budget.id, SELLER)).toBe(6_000n);
  });
});

describe("payouts", () => {
  const payees = Array.from({ length: 11 }, (_, i) => `payee-${i}.testnet`);
  const unregistered = "payee-unregistered.testnet";
  const failing = payees[3]!;

  it("pays every creditor in calls of at most 10 accounts, keeps unregistered credit, and retries a failed transfer", async () => {
    for (const p of payees) fake.register(p);
    for (const p of [...payees, unregistered]) expect((await pay(node, await provider(node, p, p), budget, p)).status).toBe(200);
    expect((await admin("POST", "/v1/settlements")).json.batchIds).toHaveLength(1);
    fake.failNextTransferTo(failing);
    const before = await Promise.all(payees.map((p) => fake.balanceOf(p)));
    const sellerCredit = await fake.creditOf(SELLER);
    expect(sellerCredit).toBe(6_000n);

    const out = (await admin("POST", "/v1/payouts")).json;
    // SELLER plus 11 payees are registered creditors: 12 accounts in two calls.
    expect(chain.payoutCalls.map((c) => c.length)).toEqual([10, 2]);
    expect(out.payouts).toHaveLength(2);
    expect(out.waitingRegistration).toEqual([unregistered]);
    for (const [i, p] of payees.entries()) {
      expect(await fake.balanceOf(p)).toBe(before[i]! + (p === failing ? 0n : PRICE));
    }
    expect(await fake.creditOf(failing)).toBe(PRICE);
    expect(await fake.creditOf(unregistered)).toBe(PRICE);
    expect(await fake.creditOf(SELLER)).toBe(0n);
    fake.solvency();

    const list = (await admin("GET", "/v1/payouts")).json;
    const byAccount = new Map<string, any>(list.accounts.map((a: any) => [a.account, a]));
    expect(byAccount.get(SELLER)).toMatchObject({ status: "clear", paidTotal: "6000" });
    expect(byAccount.get(unregistered)).toMatchObject({ status: "waiting_registration", credit: "1000" });
    expect(byAccount.get(failing)).toMatchObject({ status: "due", credit: "1000", attempts: 1, lastError: expect.stringMatching(/transfer failed/) });
    const items = list.payouts.flatMap((p: any) => p.items);
    expect(items.find((i: any) => i.account === failing)).toMatchObject({ outcome: "kept", paid: "0" });
    expect(items.find((i: any) => i.account === payees[0])).toMatchObject({ outcome: "paid", paid: "1000", creditAfter: "0" });
  });

  it("does nothing more while every remaining account waits for registration or its backoff", async () => {
    const before = chain.payoutCalls.length;
    expect((await admin("POST", "/v1/payouts")).json).toEqual({ skipped: "no account is due" });
    expect(chain.payoutCalls.length).toBe(before);
  });
});

describe("export with gross per counterparty", () => {
  it("books each party's gross expense and revenue per counterparty next to its net cash movement", async () => {
    const all = (await admin("GET", "/v1/settlements/export")).json;
    expect(all.object).toBe("settlement_export");
    expect(all.totals.batches).toBeGreaterThan(0);
    for (const p of all.parties) {
      expect(BigInt(p.grossOut) - BigInt(p.grossIn)).toBe(BigInt(p.netDebit) - BigInt(p.netCredit));
      const paid = p.counterparties.reduce((s: bigint, c: any) => s + BigInt(c.paid), 0n);
      const received = p.counterparties.reduce((s: bigint, c: any) => s + BigInt(c.received), 0n);
      expect(paid.toString()).toBe(p.grossOut);
      expect(received.toString()).toBe(p.grossIn);
    }
    const owner = (await admin("GET", `/v1/settlements/export?account=${OWNER_A}`)).json;
    expect(owner.parties).toHaveLength(1);
    expect(owner.parties[0]).toMatchObject({ account: OWNER_A, grossOut: "18000", grossIn: "0", netDebit: "18000", netCredit: "0" });
    expect(owner.parties[0].counterparties.find((c: any) => c.counterparty === SELLER)).toMatchObject({ paid: "6000", callsPaid: 6 });

    const csv = await admin("GET", `/v1/settlements/export?account=${SELLER}&format=csv`);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toBe("batch_id,confirmed_at,tx_hash,account,line,counterparty,expense,revenue,calls,net_debit,net_credit");
    expect(lines.filter((l) => l.includes('"gross"')).every((l) => l.includes(`"${OWNER_A}"`))).toBe(true);
    expect(lines.some((l) => l.includes('"net"'))).toBe(true);
  });

  it("refuses a malformed range", async () => {
    expect((await admin("GET", "/v1/settlements/export?from=tomorrow")).status).toBe(400);
    expect((await admin("GET", "/v1/settlements/export?format=xml")).status).toBe(400);
  });
});

describe("refusal webhooks", () => {
  const gtmp = tempDir("payminto-refusals-");
  let gnode: ClearingNode;
  let receiver: Server;
  let receiverUrl: string;
  const received: Array<{ body: string; signature: string | undefined }> = [];

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ body, signature: req.headers["payminto-signature"] as string | undefined });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hooks`;
    gnode = await startNode(
      testConfig({
        dbPath: gtmp.dbPath,
        adminToken: ADMIN,
        gateway: { seedPayout: null, platformName: "Alerts", feeRecipient: null, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000 },
      }),
      { chain: fake, logger: silentLogger, port: 0, workers: false },
    );
  });

  afterAll(async () => {
    await gnode?.stop();
    await new Promise<void>((r) => receiver.close(() => r()));
    gtmp.cleanup();
  });

  it("sends budget.refused with the rule, attempted amount, remaining Budget and retry hint to platform endpoints", async () => {
    const ep = await call(gnode, "POST", "/v1/platform/webhooks", { url: receiverUrl, events: ["budget.refused"] });
    expect(ep.status).toBe(201);
    const secret = ep.json.secret as string;
    expect((await call(gnode, "POST", "/v1/platform/webhooks", { url: receiverUrl, events: ["payment.paid"] })).status).toBe(400);

    const b = await openBudget(fake, gnode.url, ADMIN, OWNER_B, testKey(7), { escrow: 1_000n });
    const api = await provider(gnode, "refused-seller", SELLER);
    expect((await pay(gnode, api, b, SELLER)).status).toBe(200);
    const refused = await pay(gnode, api, b, SELLER);
    expect(refused.status).toBe(402);
    await gnode.services.gateway!.webhooks.tick();

    expect(received).toHaveLength(1);
    expect(await verifyWebhook(received[0]!.body, received[0]!.signature, secret)).toBe(true);
    const event = JSON.parse(received[0]!.body);
    expect(event).toMatchObject({
      type: "budget.refused",
      data: {
        object: {
          object: "refusal",
          rule: "NET_EXPOSURE",
          budget_id: b.id,
          owner: OWNER_B,
          payee: SELLER,
          attempted_amount: "1000",
          remaining_budget: "99999000",
          retry: { kind: "fund", shortBy: "1000" },
        },
      },
    });
    const deliveries = (await call(gnode, "GET", `/v1/platform/webhooks/${ep.json.id}/deliveries`)).json.items;
    expect(deliveries[0]).toMatchObject({ event_type: "budget.refused", status: "succeeded" });
  });
});
