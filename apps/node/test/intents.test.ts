/**
 * The any-chain checkout (NEAR Intents, 1Click) end to end over HTTP, with the fake 1Click server in process and an
 * in-memory NEAR reader: the merchant's NEAR account and its checks, options, wet quotes and their checks, the watcher's
 * states and credits, the delivery check on NEAR with its provider_only fallback, webhooks, the payment JSON, SSE data
 * and the reconciliation report. Nothing here reaches a network: the database is a temp *.test.db and the chain is
 * FakeChain.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import type { FetchLike, QuoteResponse } from "@payminto/near-addons/intents";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY, FakeOneClick, signFakeQuote } from "@payminto/near-addons/intents/fake-server";
import { intentsPayoutProofRequest, nep413Digest, signDigest, type AccountId, type IntentsPayoutProof, type PublicKey } from "@payminto/protocol";
import { loadConfig, type GatewayConfig, type IntentsConfig } from "../src/config.ts";
import type { DeliveryRead, IntentsChainReader } from "../src/gateway/intents-rpc.ts";
import { nep141Transfers } from "../src/gateway/intents-rpc.ts";
import { silentLogger } from "../src/logger.ts";
import type { AccessKeyKind } from "../src/near-rpc.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { FakeNearRpc, payoutAccount, startFakeChain, tempDir, testConfig, testKey, TOKEN } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const SHOP = payoutAccount("shop.testnet", 80);
const MAINNET = "shop-usdc.near";
const MAINNET_KEY = testKey(81);
const SOLVER = "solver.near";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const REFUND = "0x2527d02599ba641c19fea793cd0f167589a0f10d";

/** NEAR as the any-chain checkout reads it, in memory. */
class FakeIntentsReader implements IntentsChainReader {
  readonly accounts = new Set<string>();
  readonly keys = new Map<string, AccessKeyKind>();
  readonly registered = new Set<string>();
  readonly txs = new Map<string, DeliveryRead>();
  reads = 0;
  async accountExists(a: AccountId) {
    return this.accounts.has(a);
  }
  async storageRegistered(token: AccountId, a: AccountId) {
    return this.registered.has(`${token} ${a}`);
  }
  async accessKey(a: AccountId, pk: PublicKey) {
    return this.keys.get(`${a} ${pk}`) ?? null;
  }
  async delivery(hash: string, senders: readonly AccountId[]): Promise<DeliveryRead> {
    this.reads++;
    expect(senders).toContain(SOLVER);
    return this.txs.get(hash) ?? { status: "unknown" };
  }
}

const reader = new FakeIntentsReader();
/** Set by a test to hold the fake's delivery, or to change what it delivers on NEAR. */
let deliveryGate: Promise<void> | null = null;
let deliveryOverride: ((hash: string, recipient: string, amount: bigint) => DeliveryRead | null) | null = null;
let deliveries = 0;
const fake = new FakeOneClick({
  stepMs: 0,
  refundAfterMs: 0,
  accountExists: (id) => reader.accounts.has(id),
  deliver: async ({ recipient, amount }) => {
    if (deliveryGate) await deliveryGate;
    const hash = `DeliveryTx${++deliveries}AbCdEfGhJkLmNoPq`;
    reader.txs.set(hash, deliveryOverride?.(hash, recipient, amount) ?? { status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: recipient, amount }] });
    return { txHash: hash };
  },
});
/** Lets a test rewrite 1Click's answers (re-signed with the fake key, so only the field checks can catch them). */
let tamper: ((path: string, body: Record<string, any>) => Record<string, any> | { status: number; body: unknown }) | null = null;
const resign = (r: QuoteResponse) => signFakeQuote(r);
const oneclick: FetchLike = async (url, init) => {
  const res = await fake.fetch(url, init);
  if (!tamper) return res;
  const text = await res.text();
  const out = tamper(new URL(url).pathname, JSON.parse(text) as Record<string, any>);
  if ("status" in out && typeof out.status === "number" && "body" in out) return { status: out.status, text: async () => JSON.stringify(out.body) };
  return { status: res.status, text: async () => JSON.stringify(out) };
};

const intents: IntentsConfig = {
  mode: "simulated",
  baseUrl: "http://fake-1click.local",
  apiKey: null,
  managerPublicKey: FAKE_ONECLICK_MANAGER_PUBLIC_KEY,
  nearRpcUrl: "http://127.0.0.1:1",
  usdcContract: TOKEN,
  deliverySenders: [SOLVER],
  origins: null,
  slippage: { stable: 10, volatile: 100 },
  referral: "payminto",
};

const tmp = tempDir("payminto-intents-");
let chain: FakeChain;
let node: ClearingNode;
let shopId = "";

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth: string | null = ADMIN) => {
  const r = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}`, "merchant-id": shopId } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // CSV
  }
  return { status: r.status, json, text };
};
// Each public request from its own client address (TRUST_PROXY_HOPS=1), so the per-address quote limit is tested on its own.
let client = 0;
const pub = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(method, path, body, { "x-forwarded-for": `10.0.${Math.floor(++client / 250)}.${client % 250}`, ...headers }, null);

function proof(account: AccountId, merchantId: string, key = MAINNET_KEY, timestamp = Math.floor(Date.now() / 1000)): IntentsPayoutProof {
  const digest = nep413Digest(intentsPayoutProofRequest(merchantId, account, timestamp, { settlementNetwork: "near:mainnet (simulated)", hub: chain.hub }));
  return { timestamp, public_key: key.publicKey, signature: Buffer.from(signDigest(key.secretKey, digest), "hex").toString("base64") };
}

const svc = () => node.services.gateway!.intents!;
const events = (paymentId: string) => node.services.db.all<{ type: string; merchant_id: string | null; body: string }>("SELECT type, merchant_id, body FROM gateway_events WHERE payment_id = ? ORDER BY seq", paymentId);
const newPayment = async (amount = "5000000") => {
  const r = await call("POST", "/v1/payments", { amount, description: "Coffee subscription" });
  expect(r.status, r.text).toBe(201);
  return r.json.id as string;
};
const newQuote = async (paymentId: string, origin = BASE_USDC, refund = REFUND) => {
  const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: origin, refund_to: refund });
  expect([200, 201], r.text).toContain(r.status);
  return r.json;
};

beforeAll(async () => {
  chain = startFakeChain([]);
  chain.register(SHOP.account);
  const gateway: GatewayConfig = { seedPayout: SHOP.account, platformName: "Shop", feeRecipient: null, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000, intents };
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, gateway, trustProxyHops: 1 }), {
    chain,
    nearRpc: new FakeNearRpc().addKey(SHOP.account, SHOP.key.publicKey),
    intentsReader: reader,
    intentsFetch: oneclick,
    logger: silentLogger,
    port: 0,
    workers: false,
  });
  shopId = (await call("GET", "/v1/merchant")).json.id;
  reader.accounts.add(MAINNET);
  reader.accounts.add(SOLVER);
  reader.keys.set(`${MAINNET} ${MAINNET_KEY.publicKey}`, "full_access");
});

afterAll(async () => {
  await node?.stop();
  await fake.close();
  tmp.cleanup();
});

describe("the merchant's NEAR account for any-chain payments", () => {
  it("starts unset, with oneclick off and listed", async () => {
    const r = await call("GET", "/v1/merchant/intents-payout");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ object: "intents_payout", mode: "simulated", label: "Simulated - no real money", account: null, verified: false, enabled: false, settlement_network: "near:mainnet (simulated)" });
    const methods = (await call("GET", `/v1/merchants/${shopId}/methods`)).json.items.map((m: { method: string; enabled: boolean }) => [m.method, m.enabled]);
    expect(methods).toEqual([["oneclick", false], ["voucher", true], ["wallet", true]]);
    const refused = await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] });
    expect(refused.json.error.code).toBe("INTENTS_PAYOUT_REQUIRED");
  });

  it("refuses a proof for another business, an account that does not exist, a function-call key and a stale signature", async () => {
    const put = (body: unknown) => call("PUT", "/v1/merchant/intents-payout", body);
    expect((await put({ account: MAINNET, proof: proof(MAINNET, "mer_someoneelseaaaaaaaaaaaaaaa") })).json.error.code).toBe("PAYOUT_PROOF_INVALID");
    expect((await put({ account: "ghost.near", proof: proof("ghost.near", shopId) })).json.error.code).toBe("ACCOUNT_NOT_FOUND");
    const fc = testKey(82);
    reader.keys.set(`${MAINNET} ${fc.publicKey}`, "function_call");
    expect((await put({ account: MAINNET, proof: proof(MAINNET, shopId, fc) })).json.error.message).toMatch(/function-call key/);
    expect((await put({ account: MAINNET, proof: proof(MAINNET, shopId, MAINNET_KEY, Math.floor(Date.now() / 1000) - 3600) })).json.error.code).toBe("PAYOUT_PROOF_EXPIRED");
  });

  it("saves a proven account; until it is registered with USDC it shows the storage step and oneclick stays off", async () => {
    const r = await call("PUT", "/v1/merchant/intents-payout", { account: MAINNET, proof: proof(MAINNET, shopId) });
    expect(r.status, r.text).toBe(200);
    // The save reads the chain again, so every check has an answer (none shows as "not read").
    expect(r.json).toMatchObject({ account: MAINNET, verified: false, checks: { exists: true, usdc_registered: false, proven: true } });
    expect(r.json.storage_step.transaction).toEqual({
      receiverId: TOKEN,
      actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: MAINNET, registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } }],
    });
    expect((await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] })).json.error.code).toBe("INTENTS_PAYOUT_NOT_REGISTERED");
    // The merchant sends the storage_deposit itself; the next read sees it.
    reader.registered.add(`${TOKEN} ${MAINNET}`);
    const after = await call("GET", "/v1/merchant/intents-payout");
    expect(after.json).toMatchObject({ verified: true, checks: { exists: true, usdc_registered: true, proven: true }, storage_step: null });
    const on = await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] });
    expect(on.status, on.text).toBe(200);
    expect(on.json.items.find((m: { method: string }) => m.method === "oneclick").enabled).toBe(true);
    const audit = node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'intents_payout.changed'");
    expect(audit?.n).toBe(1);
  });
});

describe("paying from another chain", () => {
  let paymentId = "";
  let quote: any;

  it("offers oneclick on the checkout, with the options priced from signed dry quotes", async () => {
    paymentId = await newPayment();
    const view = (await pub("GET", `/v1/checkout/${paymentId}`)).json;
    expect(view.methods).toEqual(["wallet", "oneclick"]);
    expect(view.intents).toEqual({ mode: "simulated", label: "Simulated - no real money", available: true, reason: null, settlement_network: "near:mainnet (simulated)", active_quote: null });
    const o = await pub("GET", `/v1/checkout/${paymentId}/intents/options`);
    expect(o.status, o.text).toBe(200);
    expect(o.json).toMatchObject({ object: "intents_options", payment_id: paymentId, amount_out: { amount: "5000000", formatted: "5.000000", symbol: "USDC" }, recipient: MAINNET });
    expect(o.json.options).toHaveLength(8);
    const base = o.json.options.find((x: any) => x.origin.asset === BASE_USDC);
    expect(base).toMatchObject({ available: true, reason: null, slippage_bps: 10, origin: { chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 } });
    expect(BigInt(base.amount_in.amount)).toBeGreaterThan(5_000_000n);
    expect(base.fees.merchant_receives.formatted).toBe("5.000000");
    expect(o.json.options.find((x: any) => x.origin.symbol === "ETH").slippage_bps).toBe(100);
  });

  it("issues a checked deposit address, reuses it for the same origin and refund address, and refuses bad input", async () => {
    const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
    expect(r.status, r.text).toBe(201);
    quote = r.json;
    expect(quote).toMatchObject({ object: "intents_quote", status: "awaiting_deposit", mode: "simulated", recipient: MAINNET, amount_out: { amount: "5000000" }, deposit_memo: null, signature_valid: true, verification: null });
    expect(quote.deposit_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(quote.refund_to).toBe("0x2527...f10d");
    expect(quote.quote_response).toBeUndefined();
    expect(quote.steps.map((s: any) => s.state)).toEqual(["current", "pending", "pending", "pending"]);
    expect(quote.warning).toMatch(/^Send only USDC on the Base network/);
    const again = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(quote.id);
    expect((await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: "nep141:btc.omft.near", refund_to: REFUND })).json.error.code).toBe("ORIGIN_NOT_OFFERED");
    expect((await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: SOL_USDC, refund_to: REFUND })).json.error.code).toBe("INVALID_REFUND_ADDRESS");
    // The payment now shows the method the buyer is paying with, and the page sees the quote.
    const view = (await pub("GET", `/v1/checkout/${paymentId}`)).json;
    expect(view.method).toBe("oneclick");
    expect(view.intents.active_quote.id).toBe(quote.id);
  });

  it("a deposit is seen: a pending credit holds the payment in processing, and payment.processing goes out", async () => {
    let release!: () => void;
    deliveryGate = new Promise<void>((r) => (release = r));
    const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes/${quote.id}/simulate`, {});
    expect(r.status, r.text).toBe(200);
    expect(r.json.status).toBe("processing");
    expect(r.json.steps.map((s: any) => s.state)).toEqual(["done", "done", "current", "pending"]);
    const detail = (await call("GET", `/v1/payments/${paymentId}`)).json;
    expect(detail.status).toBe("processing");
    expect(detail.credits).toMatchObject([{ method: "oneclick", status: "pending", amount: "5000000", payer: `base:${REFUND}` }]);
    expect(events(paymentId).map((e) => e.type)).toContain("payment.processing");
    release();
    deliveryGate = null;
    await fake.idle();
  });

  it("the delivery is read on NEAR: confirmed rpc_checked, the payment is paid, and payment.paid goes out", async () => {
    const reads = reader.reads;
    const done = await svc().checkNow(quote.id);
    expect(done.status).toBe("confirmed");
    expect(done.verification).toBe("rpc_checked");
    expect(reader.reads).toBeGreaterThan(reads);
    const json = (await pub("GET", `/v1/checkout/${paymentId}/intents/quotes/${quote.id}`)).json;
    expect(json).toMatchObject({ status: "confirmed", verification: "rpc_checked", delivered: { amount: "5000000", symbol: "USDC" }, delivery_tx: { hash: done.delivery_tx, explorer_url: null } });
    expect(json.steps.every((s: any) => s.state === "done")).toBe(true);
    expect(json.origin_txs).toHaveLength(1);
    const detail = (await call("GET", `/v1/payments/${paymentId}`)).json;
    expect(detail).toMatchObject({ status: "paid", amount_paid: "5000000", method: "oneclick", payer: `base:${REFUND}` });
    expect(detail.credits).toMatchObject([{ method: "oneclick", status: "confirmed", tx_hash: done.delivery_tx }]);
    expect(detail.intents.quotes[0]).toMatchObject({ id: quote.id, refund_to: REFUND, quote_response: { correlationId: quote.correlation_id } });
    expect(events(paymentId).map((e) => e.type)).toEqual(["payment.created", "payment.processing", "payment.paid"]);
    const view = (await pub("GET", `/v1/checkout/${paymentId}`)).json;
    expect(view).toMatchObject({ status: "paid", methods: [], tx_hash: done.delivery_tx, intents: { available: false, active_quote: { status: "confirmed" } } });
  });

  it("lists the payment with where it came from: Any chain - USDC on Base", async () => {
    const list = (await call("GET", "/v1/payments?limit=50")).json;
    const item = list.items.find((x: any) => x.id === paymentId);
    expect(item.intents).toEqual({ mode: "simulated", label: "Simulated - no real money", status: "confirmed", origin: { asset: BASE_USDC, chain: "base", chain_name: "Base", symbol: "USDC" } });
    const wallet = await newPayment("1000000");
    expect((await call("GET", "/v1/payments?limit=50")).json.items.find((x: any) => x.id === wallet).intents).toBeNull();
  });

  it("proves the payment with the NEAR delivery transaction read again now, and 1Click's status as the node read it", async () => {
    const r = await pub("GET", `/v1/checkout/${paymentId}/proof`);
    expect(r.status, r.text).toBe(200);
    const detail = (await call("GET", `/v1/payments/${paymentId}`)).json;
    const q = detail.intents.quotes[0];
    expect(r.json.credits).toEqual([
      {
        method: "oneclick",
        amount: "5000000",
        payer: "base:0x2527...f10d",
        quote_id: quote.id,
        mode: "simulated",
        label: "Simulated - no real money",
        settlement_network: "near:mainnet (simulated)",
        token: TOKEN,
        recipient: MAINNET,
        origin: { asset: BASE_USDC, chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 },
        deposited: q.deposited,
        origin_txs: q.origin_txs,
        delivery_tx: q.delivery_tx,
        delivery_senders: [SOLVER, MAINNET],
        oneclick: { status: "SUCCESS", correlation_id: quote.correlation_id, deposit_address: quote.deposit_address, read_at: expect.any(String) },
        verification: "rpc_checked",
        delivered_on_chain: "5000000",
        verified: true,
      },
    ]);
    // A delivery that cannot be read now is not proven either way, and one that pays less is refused.
    const hash = q.delivery_tx.hash as string;
    const kept = reader.txs.get(hash)!;
    reader.txs.set(hash, { status: "unknown" });
    expect((await pub("GET", `/v1/checkout/${paymentId}/proof`)).json.credits[0]).toMatchObject({ delivered_on_chain: null, verified: null });
    reader.txs.set(hash, { status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: MAINNET, amount: 4_999_999n }] });
    expect((await pub("GET", `/v1/checkout/${paymentId}/proof`)).json.credits[0]).toMatchObject({ delivered_on_chain: "4999999", verified: false });
    reader.txs.set(hash, kept);
  });

  it("the reconciliation report says where the money came from and where it settled", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = (await call("GET", `/v1/reports/reconciliation?from=${day}&to=${tomorrow}`)).json;
    const row = report.rows.find((x: any) => x.payment_id === paymentId);
    expect(row).toMatchObject({
      method: "oneclick",
      payer: `base:${REFUND}`,
      currency: "USDC (NEAR mainnet, simulated)",
      settlement_network: "near:mainnet (simulated)",
      origin_asset: BASE_USDC,
      deposit_address: quote.deposit_address,
      net_amount: "5.000000",
      fee_total: "0.000000",
    });
    expect(row.origin_amount).toBe(`${quote.send_exactly.formatted} USDC`);
    expect(row.transactions.map((t: any) => t.leg)).toEqual(["origin_deposit", "near_delivery"]);
    const csv = (await call("GET", `/v1/reports/reconciliation?from=${day}&to=${tomorrow}&format=csv`)).text;
    const [head, line] = [csv.split("\r\n")[0]!, csv.split("\r\n").find((l) => l.includes(paymentId))!];
    expect(head.endsWith('"settlement_network","origin_asset","origin_amount","deposit_address"')).toBe(true);
    expect(line).toContain(`"near:mainnet (simulated)","${BASE_USDC}"`);
  });
});

describe("the public payment link", () => {
  it("says whether a buyer can pay from another chain, and why not", async () => {
    const link = (await call("POST", "/v1/links", { title: "Gift card", amount: "2000000" })).json;
    const view = async () => (await pub("GET", `/v1/links/public/${link.slug}`)).json;
    expect((await view()).intents).toEqual({ mode: "simulated", label: "Simulated - no real money", offered: true, reason: null });
    expect((await view()).methods.map((m: { method: string }) => m.method)).toContain("oneclick");
    await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: false }] });
    try {
      expect((await view()).intents).toEqual({ mode: "simulated", label: "Simulated - no real money", offered: false, reason: "This business does not take payments from other chains." });
    } finally {
      await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] });
    }
  });
});

describe("deposits that do not complete", () => {
  it("a short deposit is returned: the pending credit goes, the payment is open again, and payment.deposit_returned goes out", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes/${q.id}/simulate`, { amount: "3000000" });
    await fake.idle();
    const after = await svc().checkNow(q.id);
    expect(after.status, JSON.stringify(r.json)).toBe("refunded");
    expect(after.refund_reason).toBe("PARTIAL_DEPOSIT");
    const detail = (await call("GET", `/v1/payments/${paymentId}`)).json;
    expect(detail).toMatchObject({ status: "open", amount_paid: "0", credits: [] });
    const types = events(paymentId).map((e) => e.type);
    expect(types).toContain("payment.deposit_returned");
    const ev = JSON.parse(events(paymentId).find((e) => e.type === "payment.deposit_returned")!.body);
    expect(ev.data.object).toMatchObject({ id: paymentId, status: "open", deposit: { id: q.id, status: "refunded", refund_reason: "PARTIAL_DEPOSIT", refunded: { symbol: "USDC" } } });
    // Still payable: a new address can be asked for.
    expect((await pub("GET", `/v1/checkout/${paymentId}`)).json.methods).toContain("oneclick");
  });

  it("a failed swap sends payment.deposit_failed to the business and to platform alert endpoints", async () => {
    const hook = await call("POST", "/v1/platform/webhooks", { url: "http://127.0.0.1:9/alerts", events: ["payment.deposit_failed"] });
    expect(hook.status, hook.text).toBe(201);
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount), { fail: true });
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("failed");
    const failed = events(paymentId).filter((e) => e.type === "payment.deposit_failed");
    expect(failed.map((e) => e.merchant_id)).toEqual([shopId, null]);
    expect((await call("GET", `/v1/payments/${paymentId}`)).json.status).toBe("open");
  });

  it("a deposit seen after the payment expired still pays it, marked late", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    node.services.db.run("UPDATE payments SET expires_unix = ?, expires_at = ? WHERE id = ?", Math.floor(Date.now() / 1000) - 5, new Date(Date.now() - 5000).toISOString(), paymentId);
    node.services.gateway!.payments.expireDue();
    expect((await call("GET", `/v1/payments/${paymentId}`)).json.status).toBe("expired");
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("confirmed");
    expect((await call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ status: "paid", late: true });
  });

  it("two quotes both paid make the payment overpaid", async () => {
    const paymentId = await newPayment("1000000");
    const a = await newQuote(paymentId);
    const b = await newQuote(paymentId, SOL_USDC, "So11111111111111111111111111111111111111112");
    for (const q of [a, b]) await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    for (const q of [a, b]) expect((await svc().checkNow(q.id)).status).toBe("confirmed");
    expect((await call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ status: "overpaid", amount_paid: "2000000" });
  });
});

describe("the checks before a deposit address is shown", () => {
  const refused = async (mutate: (r: QuoteResponse) => void) => {
    const paymentId = await newPayment();
    tamper = (path, body) => (path === "/v0/quote" && !body.quoteRequest?.dry ? (mutate(body as QuoteResponse), resign(body as QuoteResponse)) : body);
    const before = node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM intents_quotes")!.n;
    const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
    tamper = null;
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM intents_quotes")!.n).toBe(before);
    return r;
  };

  it("refuses a quote to another recipient, with another minAmountOut, or with a memo: 502 and no deposit address", async () => {
    for (const [mutate, why] of [
      [(r: QuoteResponse) => (r.quoteRequest.recipient = "attacker.near"), /recipient/],
      [(r: QuoteResponse) => (r.quote.minAmountOut = "4900000"), /minAmountOut/],
      [(r: QuoteResponse) => (r.quote.depositMemo = "7"), /memo/],
    ] as const) {
      const r = await refused(mutate);
      expect(r.status).toBe(502);
      expect(r.json.error.code).toBe("INTENTS_QUOTE_REFUSED");
      expect(r.json.error.details.refusals.join()).toMatch(why);
      expect(r.text).not.toMatch(/depositAddress|deposit_address/);
    }
  });

  it("refuses a quote not signed by the configured manager key", async () => {
    const paymentId = await newPayment();
    tamper = (path, body) => (path === "/v0/quote" ? { ...body, signature: `ed25519:${"1".repeat(64)}` } : body);
    const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
    tamper = null;
    expect(r.json.error.details.refusals.join()).toMatch(/signature/);
  });

  it("turns a 1Click refusal into plain words and greys the option", async () => {
    const paymentId = await newPayment("2000000");
    tamper = (path, body) => (path === "/v0/quote" ? { status: 400, body: { message: "Temporary swap limits: minimum swap amount is $100", correlationId: "x", timestamp: "t", path } } : body);
    const o = (await pub("GET", `/v1/checkout/${paymentId}/intents/options`)).json;
    const q = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
    tamper = null;
    expect(o.options[0]).toMatchObject({ available: false, reason: "The minimum on this network is $100.", amount_in: null });
    expect(q).toMatchObject({ status: 502, json: { error: { code: "INTENTS_QUOTE_FAILED", message: "The minimum on this network is $100." } } });
  });

  it("caps active quotes per payment and makes a retried POST with the same Idempotency-Key safe", async () => {
    const paymentId = await newPayment();
    const first = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND }, { "idempotency-key": "k-1" });
    const replay = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND }, { "idempotency-key": "k-1" });
    expect(replay.json.id).toBe(first.json.id);
    for (let i = 1; i < 5; i++) await newQuote(paymentId, BASE_USDC, `0x${String(i).repeat(40)}`);
    const sixth = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: `0x${"9".repeat(40)}` });
    expect(sixth.json.error.code).toBe("INTENTS_QUOTE_LIMIT");
  });

  it("limits deposit addresses to ten a minute from one client address", async () => {
    const paymentId = await newPayment();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: "nope", refund_to: REFUND }, { "x-forwarded-for": "10.9.9.9" }, null)).status);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("the watcher", () => {
  it("ignores a status that names another quote, and backs off on 429 without changing state", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    tamper = (path, body) => (path === "/v0/status" ? { ...body, quoteResponse: { ...body.quoteResponse, correlationId: "someone-else" }, status: "SUCCESS" } : body);
    let row = await svc().checkNow(q.id);
    expect(row).toMatchObject({ status: "awaiting_deposit", poll_errors: 1 });
    tamper = (path, body) => (path === "/v0/status" ? { status: 429, body: { message: "rate-limit-exceeded" } } : body);
    row = await svc().checkNow(q.id);
    tamper = null;
    expect(row).toMatchObject({ status: "awaiting_deposit", poll_errors: 2 });
    expect(row.next_poll_unix).toBeGreaterThan(Math.floor(Date.now() / 1000) + 20);
    row = await svc().checkNow(q.id);
    expect(row).toMatchObject({ status: "awaiting_deposit", provider_status: "PENDING_DEPOSIT", poll_errors: 0 });
  });

  it("marks an address that never saw a deposit expired a day after its deadline", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    node.services.db.run("UPDATE intents_quotes SET deadline_unix = ? WHERE id = ?", Math.floor(Date.now() / 1000) - 86_401, q.id);
    expect((await svc().checkNow(q.id)).status).toBe("expired");
    expect((await pub("GET", `/v1/checkout/${paymentId}`)).json.intents.active_quote).toBeNull();
  });

  it("the tick polls every due quote once even when ticks overlap", async () => {
    const w = node.services.gateway!.intentsWatcher!;
    node.services.db.run("UPDATE intents_quotes SET next_poll_unix = 0 WHERE status = 'awaiting_deposit'");
    const [a, b] = await Promise.all([w.tick(), w.tick()]);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });
});

describe("the delivery check on NEAR", () => {
  it("does not confirm a delivery that pays someone else or less, and never falls back on 1Click's word for it", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    deliveryOverride = (hash, recipient, amount) => ({ status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: recipient, amount: amount - 1n }, { token: TOKEN, from: SOLVER, to: "other.near", amount }] });
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    deliveryOverride = null;
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    node.services.db.run("UPDATE intents_quotes SET delivered_unix = delivered_unix - 3600 WHERE id = ?", q.id);
    const row = await svc().checkNow(q.id);
    expect(row).toMatchObject({ status: "delivered", verification: null });
    expect((await call("GET", `/v1/payments/${paymentId}`)).json.status).toBe("processing");
    expect((await pub("GET", `/v1/checkout/${paymentId}/intents/quotes/${q.id}`)).json.steps.map((s: any) => s.state)).toEqual(["done", "done", "done", "current"]);
  });

  it("a token other than the configured USDC does not count", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    deliveryOverride = (hash, recipient, amount) => ({ status: "final", hash, transfers: [{ token: "fake-usdc.near", from: SOLVER, to: recipient, amount }] });
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    deliveryOverride = null;
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
  });

  it("confirms on 1Click's word (provider_only) when the delivery cannot be read for 10 minutes", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    deliveryOverride = () => ({ status: "unknown" });
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    deliveryOverride = null;
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    node.services.db.run("UPDATE intents_quotes SET delivered_unix = delivered_unix - 601 WHERE id = ?", q.id);
    const row = await svc().checkNow(q.id);
    expect(row).toMatchObject({ status: "confirmed", verification: "provider_only" });
    expect((await call("GET", `/v1/payments/${paymentId}`)).json.status).toBe("paid");
  });

  it("reads NEP-141 events of successful receipts only", () => {
    const ev = (to: string, amount: string) => `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: SOLVER, new_owner_id: to, amount }] })}`;
    expect(
      nep141Transfers([
        { outcome: { executor_id: TOKEN, logs: [ev(MAINNET, "5")], status: { SuccessValue: "" } } },
        { outcome: { executor_id: TOKEN, logs: [ev(MAINNET, "7")], status: { Failure: {} } } },
        { outcome: { executor_id: TOKEN, logs: ["EVENT_JSON:{bad", "plain log"], status: { SuccessReceiptId: "x" } } },
      ]),
    ).toEqual([{ token: TOKEN, from: SOLVER, to: MAINNET, amount: 5n }]);
  });
});

describe("platform status and the boundaries", () => {
  it("reports the mode, the last 1Click call and counts by state", async () => {
    const s = (await call("GET", "/v1/platform/intents")).json;
    expect(s).toMatchObject({ object: "intents_status", mode: "simulated", label: "Simulated - no real money", manager_key: "test", api_key_set: false, usdc_contract: TOKEN, last_call: { method: expect.any(String), path: expect.stringMatching(/^\/v0\//) } });
    expect(s.counts.confirmed).toBeGreaterThan(0);
    expect(s.origins).toHaveLength(8);
  });

  it("the node core never imports @payminto/near-addons except through server.ts's dynamic import", () => {
    const dir = join(import.meta.dirname, "..", "src");
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const line of src.split("\n").filter((l) => l.includes("@payminto/near-addons"))) {
        const ok = /^\s*import type /.test(line) || /^\s*\/\//.test(line) || /^\s*\/?\*/.test(line) || (f === "server.ts" && /await import\("@payminto\/near-addons\/intents"\)/.test(line));
        expect(ok, `${f}: ${line}`).toBe(true);
      }
    }
  });
});

describe("INTENTS_CHECKOUT configuration", () => {
  const base = {
    HUB_ACCOUNT: "hub.payminto.testnet",
    OPERATOR_ACCOUNT: "node.payminto.testnet",
    OPERATOR_KEY: `ed25519:${"1".repeat(88)}`,
    NODE_SIGNING_SEED: "22".repeat(32),
    ADMIN_TOKEN: "x".repeat(40),
    GATEWAY_ENABLED: "true",
  };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig({ ...base, ...env });
      return [];
    } catch (e) {
      return (e as { problems: string[] }).problems;
    }
  };

  it("is off by default and needs the gateway", () => {
    expect(loadConfig(base).gateway?.intents).toBeUndefined();
    expect(problems({ GATEWAY_ENABLED: "false", INTENTS_CHECKOUT: "simulated" }).join()).toMatch(/gateway/);
  });

  it("live refuses a test key, a stand-in USDC, another 1Click URL and plain-http RPC", () => {
    expect(loadConfig({ ...base, INTENTS_CHECKOUT: "live" }).gateway?.intents).toMatchObject({ mode: "live", baseUrl: "https://1click.chaindefuser.com", managerPublicKey: null, usdcContract: null, nearRpcUrl: "https://rpc.mainnet.near.org" });
    expect(problems({ INTENTS_CHECKOUT: "live", ONECLICK_MANAGER_PUBLIC_KEY: FAKE_ONECLICK_MANAGER_PUBLIC_KEY }).join()).toMatch(/ONECLICK_MANAGER_PUBLIC_KEY/);
    expect(problems({ INTENTS_CHECKOUT: "live", INTENTS_USDC_CONTRACT: "usdc.sandbox" }).join()).toMatch(/INTENTS_USDC_CONTRACT/);
    expect(problems({ INTENTS_CHECKOUT: "live", ONECLICK_BASE_URL: "https://my-proxy.example" }).join()).toMatch(/ONECLICK_ALLOW_CUSTOM_URL/);
    expect(problems({ INTENTS_CHECKOUT: "live", ONECLICK_BASE_URL: "http://127.0.0.1:9" }).join()).toMatch(/https/);
    expect(problems({ INTENTS_CHECKOUT: "live", NEAR_MAINNET_RPC_URL: "http://127.0.0.1:3030" }).join()).toMatch(/NEAR_MAINNET_RPC_URL/);
  });

  it("simulated needs the fake server, its key, the local chain and its token, and never the live URL", () => {
    expect(problems({ INTENTS_CHECKOUT: "simulated" })).toHaveLength(4);
    const sim = { INTENTS_CHECKOUT: "simulated", ONECLICK_BASE_URL: "http://127.0.0.1:9", ONECLICK_MANAGER_PUBLIC_KEY: FAKE_ONECLICK_MANAGER_PUBLIC_KEY, NEAR_MAINNET_RPC_URL: "http://127.0.0.1:3030", INTENTS_USDC_CONTRACT: "usdc.sandbox" };
    expect(problems(sim)).toEqual([]);
    expect(problems({ ...sim, ONECLICK_BASE_URL: "https://1click.chaindefuser.com" }).join()).toMatch(/never talks to the live/);
  });
});

describe("live mode", () => {
  it("has no simulate route, and the node never calls the network to answer it", async () => {
    const t = tempDir("payminto-intents-live-");
    const c = startFakeChain([]);
    c.register(SHOP.account);
    const calls: string[] = [];
    const live: IntentsConfig = { ...intents, mode: "live", baseUrl: "https://1click.chaindefuser.com", managerPublicKey: null, usdcContract: null, nearRpcUrl: "https://rpc.mainnet.near.org" };
    const gateway: GatewayConfig = { seedPayout: SHOP.account, platformName: "Shop", feeRecipient: null, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000, intents: live };
    const n = await startNode(testConfig({ dbPath: t.dbPath, adminToken: ADMIN, gateway }), {
      chain: c,
      intentsReader: reader,
      intentsFetch: async (url) => {
        calls.push(url);
        throw new Error("tests never call the live 1Click API");
      },
      logger: silentLogger,
      port: 0,
      workers: false,
    });
    try {
      const r = await fetch(`${n.url}/v1/checkout/pay_aaaaaaaaaaaaaaaaaaaaaaaa/intents/quotes/iq_aaaaaaaaaaaaaaaaaaaaaaaa/simulate`, { method: "POST", body: "{}" });
      expect(r.status).toBe(404);
      const status = await (await fetch(`${n.url}/v1/platform/intents`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
      expect(status).toMatchObject({ mode: "live", label: "Live - NEAR mainnet", manager_key: "1click", settlement_network: "near:mainnet" });
      expect(calls).toEqual([]);
    } finally {
      await n.stop();
      t.cleanup();
    }
  });

  it("with INTENTS_CHECKOUT off every intents route says so and the checkout carries no intents data", async () => {
    const t = tempDir("payminto-intents-off-");
    const c = startFakeChain([]);
    c.register(SHOP.account);
    const gateway: GatewayConfig = { seedPayout: SHOP.account, platformName: "Shop", feeRecipient: null, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000 };
    const n = await startNode(testConfig({ dbPath: t.dbPath, adminToken: ADMIN, gateway }), { chain: c, logger: silentLogger, port: 0, workers: false });
    try {
      const h = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
      const p = await (await fetch(`${n.url}/v1/payments`, { method: "POST", headers: h, body: JSON.stringify({ amount: "1000000" }) })).json();
      const view = await (await fetch(`${n.url}/v1/checkout/${p.id}`)).json();
      expect(view).toMatchObject({ methods: ["wallet"], intents: null });
      expect((await (await fetch(`${n.url}/v1/checkout/${p.id}/intents/options`)).json()).error.code).toBe("INTENTS_CHECKOUT_OFF");
      expect((await (await fetch(`${n.url}/v1/merchant/intents-payout`, { headers: h })).json()).error.code).toBe("INTENTS_CHECKOUT_OFF");
      expect(await (await fetch(`${n.url}/v1/platform/intents`, { headers: h })).json()).toEqual({ object: "intents_status", mode: "off", label: null });
      const methods = (await (await fetch(`${n.url}/v1/merchant`, { headers: h })).json()).methods.map((m: { method: string }) => m.method);
      expect(methods).toEqual(["voucher", "wallet"]);
      expect((await (await fetch(`${n.url}/v1/payments/${p.id}`, { headers: h })).json()).intents).toBeNull();
      expect((await (await fetch(`${n.url}/v1/payments`, { headers: h })).json()).items[0].intents).toBeNull();
      const link = await (await fetch(`${n.url}/v1/links`, { method: "POST", headers: h, body: JSON.stringify({ title: "Plain", amount: "1000000" }) })).json();
      expect((await (await fetch(`${n.url}/v1/links/public/${link.slug}`)).json()).intents).toBeNull();
    } finally {
      await n.stop();
      t.cleanup();
    }
  });
});
