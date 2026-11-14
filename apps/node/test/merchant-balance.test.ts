/**
 * A business's Balance (`GET /v1/merchant/balance`) and the platform's earnings by month (`GET /v1/platform/fees/months`)
 * over HTTP: a checkout payment credits the business on the hub, a payout pays it out and the balance reads both back,
 * a payout still in flight and any-chain deliveries to its NEAR account count apart, and each route keeps to its
 * permission and its business. FakeChain and a temp *.test.db only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { explorerTx } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import type { GatewayConfig } from "../src/config.ts";
import { FakeNearRpc, OWNER_A, payoutAccount, payoutProof, startFakeChain, tempDir, testConfig } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const DASH = "http://localhost:3000";
const SHOP = payoutAccount("balance-shop.testnet", 80);
const BETA = payoutAccount("balance-beta.testnet", 81);
const SHOPPER = "balance-shopper.testnet";
const FEES = "balance-fees.testnet";
const PW = "a-long-enough-passphrase-9";
const tmp = tempDir("payminto-balance-");
const rpc = new FakeNearRpc().addKey(SHOP.account, SHOP.key.publicKey).addKey(BETA.account, BETA.key.publicKey);
let chain: FakeChain;
let node: ClearingNode;
let shopId = "";
let betaId = "";
let shopPayment = "";
let viewerCookie = "";

type Res = { status: number; json: any };
const call = async (method: string, path: string, o: { body?: unknown; merchant?: string | null; auth?: string | null; cookie?: string } = {}): Promise<Res> => {
  const auth = o.auth === undefined ? ADMIN : o.auth;
  const merchant = o.merchant === undefined ? shopId : o.merchant;
  const r = await fetch(`${node.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(merchant ? { "merchant-id": merchant } : {}),
      ...(o.cookie ? { cookie: o.cookie, origin: DASH } : {}),
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
const scope = () => ({ network: chain.network, hub: chain.hub });
const nowIso = () => new Date().toISOString();

/** A wallet checkout payment, paid by the shopper's wallet through the hub. */
async function paidPayment(amount: string): Promise<string> {
  const created = await call("POST", "/v1/payments", { body: { amount, description: "Balance test" } });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const view = (await call("GET", `/v1/checkout/${created.json.id}`, { auth: null, merchant: null })).json;
  const args = view.wallet.transaction.actions[0].params.args as { amount: string; msg: string };
  expect(chain.ftTransferCall(SHOPPER, BigInt(args.amount), args.msg).refunded).toBe(0n);
  const reported = await call("POST", `/v1/checkout/${created.json.id}/wallet`, { body: { tx_hash: "9vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx" }, auth: null, merchant: null });
  expect(reported.json.status).toBe("paid");
  return created.json.id;
}

let quoteSeq = 0;
/** An any-chain quote row as the 1Click watcher leaves it; the balance only reads these. */
function quote(paymentId: string, merchantId: string, o: { status?: string; destination?: string; delivered?: string; mode?: "live" | "simulated"; tx?: string | null } = {}): string {
  const id = `iq_balance${++quoteSeq}`;
  node.services.db.run(
    `INSERT INTO intents_quotes (id, payment_id, merchant_id, mode, origin_asset, origin_chain, origin_symbol, origin_decimals, recipient, refund_to,
       slippage_bps, amount_out, amount_in, min_amount_in, time_estimate_sec, deposit_address, deadline_unix, correlation_id, signature_valid,
       quote_json, status, delivered_amount, delivery_tx, delivered_unix, next_poll_unix, created_at, updated_at, destination_chain)
     VALUES (?, ?, ?, ?, 'nep141:base-usdc', 'base', 'USDC', 6, 'corner-shop.near', '0xrefund', 10, '1000000', '1001000', '1000500', 30, ?, ?, 'c', 1,
       '{}', ?, ?, ?, ?, 0, ?, ?, ?)`,
    id,
    paymentId,
    merchantId,
    o.mode ?? "live",
    `0xdeposit${quoteSeq}`,
    Math.floor(Date.now() / 1000) + 600,
    o.status ?? "confirmed",
    o.delivered ?? null,
    o.tx === undefined ? `DeliveryTx${quoteSeq}` : o.tx,
    Math.floor(Date.now() / 1000) - quoteSeq,
    nowIso(),
    nowIso(),
    o.destination ?? "near",
  );
  return id;
}

beforeAll(async () => {
  chain = startFakeChain([OWNER_A, SHOPPER]);
  for (const a of [SHOP.account, BETA.account, FEES]) chain.register(a);
  const gateway: GatewayConfig = { seedPayout: SHOP.account, platformName: "Acme", feeRecipient: FEES, checkoutBaseUrl: DASH, checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000 };
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, gateway, publicUrl: "http://node.test" }), { chain, nearRpc: rpc, logger: silentLogger, port: 0, workers: false });
  chain.setCheckoutKey(node.services.chain.nodeKey);
  await chain.registerReceiptKey(chain.operator, node.services.chain.nodeKey);
  shopId = (await call("GET", "/v1/merchant", { merchant: null })).json.id;
  const beta = await call("POST", "/v1/merchants", { body: { name: "Beta", payout: payoutProof(BETA, "new", scope()) }, merchant: null });
  expect(beta.status).toBe(201);
  betaId = beta.json.id;
  await node.services.auth.addMember(shopId, { email: "viewer@balance.test", name: "Vera", password: PW }, "viewer", { type: "system", id: null });
  const login = await fetch(`${node.url}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: DASH }, body: JSON.stringify({ email: "viewer@balance.test", password: PW }) });
  expect(login.status).toBe(200);
  viewerCookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /pm_session=/.test(c!)) ?? "";
  expect(viewerCookie).not.toBe("");
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("GET /v1/merchant/balance", () => {
  it("starts empty for a business nobody paid yet", async () => {
    const r = await call("GET", "/v1/merchant/balance");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      object: "merchant_balance",
      merchant_id: shopId,
      payout: SHOP.account,
      network: chain.network,
      credit: "0",
      status: "none",
      checked_at: null,
      last_error: null,
      in_flight: "0",
      paid_30d: "0",
      paid_total: "0",
      payouts: [],
      any_chain: { total: "0", count: 0, items: [] },
    });
  });

  it("shows a checkout payment queued for payout, then paid out with its transaction", async () => {
    shopPayment = await paidPayment("2500000");
    const queued = (await call("GET", "/v1/merchant/balance")).json;
    expect(queued).toMatchObject({ status: "due", paid_30d: "0", payouts: [] });

    const run = (await call("POST", "/v1/payouts", { merchant: null })).json;
    expect(run.payouts?.[0]?.items, JSON.stringify(run)).toEqual([expect.objectContaining({ account: SHOP.account, paid: "2500000", outcome: "paid" })]);
    const paid = (await call("GET", "/v1/merchant/balance")).json;
    expect(paid).toMatchObject({ status: "clear", credit: "0", in_flight: "0", paid_30d: "2500000", paid_total: "2500000" });
    expect(paid.payouts).toEqual([
      {
        seq: run.payouts[0].seq,
        status: "confirmed",
        outcome: "paid",
        amount: "2500000",
        credit_before: "2500000",
        tx_hash: run.payouts[0].txHash,
        explorer_url: explorerTx(chain.network, run.payouts[0].txHash),
        at: run.payouts[0].finishedAt,
      },
    ]);
  });

  it("counts a payout without a verdict as in flight, and leaves payouts older than 30 days out of the 30-day sum", async () => {
    const db = node.services.db;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const oldSeq = db.run("INSERT INTO payouts (status, trigger, tx_hash, created_at, finished_at) VALUES ('confirmed', 'interval', 'OldPayoutTx', ?, ?)", old, old).lastInsertRowid;
    db.run("INSERT INTO payout_items (payout_seq, account, credit_before, credit_after, paid, outcome) VALUES (?, ?, '700000', '0', '700000', 'paid')", oldSeq, SHOP.account);
    const flying = db.run("INSERT INTO payouts (status, trigger, created_at) VALUES ('submitted', 'manual', ?)", nowIso()).lastInsertRowid;
    db.run("INSERT INTO payout_items (payout_seq, account, credit_before, outcome) VALUES (?, ?, '300000', 'pending')", flying, SHOP.account);
    // Another account's payout is not this business's money.
    db.run("INSERT INTO payout_items (payout_seq, account, credit_before, outcome) VALUES (?, ?, '999', 'pending')", flying, BETA.account);

    const b = (await call("GET", "/v1/merchant/balance")).json;
    expect(b.in_flight).toBe("300000");
    expect(b.paid_30d).toBe("2500000");
    expect(b.payouts.map((p: { seq: number; status: string; amount: string }) => [p.seq, p.status, p.amount])).toEqual([
      [flying, "submitted", "0"],
      [b.payouts[1].seq, "confirmed", "2500000"],
      [oldSeq, "confirmed", "700000"],
    ]);
    // Leave the books as the payout service would: the flight ended without a verdict.
    db.run("UPDATE payouts SET status = 'unknown', finished_at = ? WHERE seq = ?", nowIso(), flying);
    db.run("UPDATE payout_items SET outcome = 'kept' WHERE payout_seq = ?", flying);
    expect((await call("GET", "/v1/merchant/balance")).json.in_flight).toBe("0");
  });

  it("sums confirmed any-chain deliveries to the business's NEAR account only", async () => {
    const live = quote(shopPayment, shopId, { delivered: "999000" });
    const sim = quote(shopPayment, shopId, { mode: "simulated", tx: "SimTx" });
    quote(shopPayment, shopId, { status: "processing" });
    quote(shopPayment, shopId, { destination: "base", delivered: "5000000" });
    const betaPayment = (await call("POST", "/v1/payments", { body: { amount: "1000000" }, merchant: betaId })).json.id;
    quote(betaPayment, betaId, { delivered: "4000000" });

    const any = (await call("GET", "/v1/merchant/balance")).json.any_chain;
    expect(any.total).toBe("1999000");
    expect(any.count).toBe(2);
    expect(any.items).toEqual([
      expect.objectContaining({ quote_id: live, payment_id: shopPayment, amount: "999000", origin_chain: "base", origin_symbol: "USDC", recipient: "corner-shop.near", mode: "live", tx_hash: expect.stringMatching(/^DeliveryTx/), explorer_url: expect.stringMatching(/^https:\/\/nearblocks\.io\/txns\/DeliveryTx/) }),
      // No delivered amount recorded: the invoice amount stands. A simulated delivery has no explorer page.
      expect.objectContaining({ quote_id: sim, amount: "1000000", mode: "simulated", tx_hash: "SimTx", explorer_url: null }),
    ]);
    expect((await call("GET", "/v1/merchant/balance", { merchant: betaId })).json.any_chain).toMatchObject({ total: "4000000", count: 1 });
  });

  it("is read only for every member of the business, and only for that business", async () => {
    const mine = await call("GET", "/v1/merchant/balance", { auth: null, merchant: shopId, cookie: viewerCookie });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    expect(mine.json.merchant_id).toBe(shopId);
    const other = await call("GET", "/v1/merchant/balance", { auth: null, merchant: betaId, cookie: viewerCookie });
    expect([403, 404]).toContain(other.status);
    expect((await call("GET", "/v1/merchant/balance", { auth: null, merchant: null })).status).toBe(401);
    expect((await call("POST", "/v1/merchant/balance", { auth: null, merchant: shopId, cookie: viewerCookie, body: {} })).status).toBe(404);
  });
});

describe("GET /v1/platform/fees/months", () => {
  it("groups the platform's earnings by the month payments were paid in, by business, matching the totals", async () => {
    const months = await call("GET", "/v1/platform/fees/months", { merchant: null });
    expect(months.status).toBe(200);
    const fees = (await call("GET", "/v1/platform/fees", { merchant: null })).json;
    const month = new Date().toISOString().slice(0, 7);
    expect(months.json.object).toBe("platform_fee_months");
    expect(months.json.items).toEqual([expect.objectContaining({ month, merchant_id: shopId, merchant_name: expect.any(String), payments: 1, volume: "2500000" })]);
    const sum = months.json.items.reduce((a: bigint, i: { fee_total: string }) => a + BigInt(i.fee_total), 0n);
    expect(sum.toString()).toBe(fees.totals.fee_total);
  });

  it("needs earnings.read", async () => {
    expect((await call("GET", "/v1/platform/fees/months", { auth: null, merchant: null, cookie: viewerCookie })).status).toBe(403);
  });
});
