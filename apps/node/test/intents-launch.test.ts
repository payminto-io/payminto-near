/**
 * The any-chain checkout's launch gaps (docs/superpowers/specs/2026-11-12-any-chain-launch-gaps.md), end to end over
 * HTTP with the fake 1Click server in process and an in-memory NEAR reader: the confirmed quote on the receipt, a
 * deposit in flight, a top-up, an excess and the unused price buffer, a SLIPPAGE refund, 1Click busy or refusing the
 * key, operator alerts, the payout account changing or unregistering, and a hung 1Click call. Nothing here reaches a
 * network: the database is a temp *.test.db and the chain is FakeChain.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import type { FetchLike } from "@payminto/near-addons/intents";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY, FakeOneClick } from "@payminto/near-addons/intents/fake-server";
import { intentsPayoutProofRequest, nep413Digest, signDigest, type AccountId, type IntentsPayoutProof, type PublicKey } from "@payminto/protocol";
import type { GatewayConfig, IntentsConfig } from "../src/config.ts";
import { AUTH_RETRY_SEC, REGISTRATION_CACHE_SEC, STUCK_AFTER_SEC } from "../src/gateway/intents.ts";
import { IntentsRpc, type DeliveryRead, type IntentsChainReader } from "../src/gateway/intents-rpc.ts";
import { silentLogger } from "../src/logger.ts";
import type { AccessKeyKind } from "../src/near-rpc.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { FakeNearRpc, payoutAccount, startFakeChain, tempDir, testConfig, testKey, TOKEN } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const SHOP = payoutAccount("shop.testnet", 80);
const MAINNET = "shop-usdc.near";
const MAINNET_KEY = testKey(81);
const NEXT = "shop-next.near";
const NEXT_KEY = testKey(83);
const SOLVER = "solver.near";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const REFUND = "0x2527d02599ba641c19fea793cd0f167589a0f10d";
const SOL_REFUND = "So11111111111111111111111111111111111111112";

class FakeIntentsReader implements IntentsChainReader {
  readonly accounts = new Set<string>();
  readonly keys = new Map<string, AccessKeyKind>();
  readonly registered = new Set<string>();
  readonly txs = new Map<string, DeliveryRead>();
  storageReads = 0;
  async accountExists(a: AccountId) {
    return this.accounts.has(a);
  }
  async storageRegistered(token: AccountId, a: AccountId) {
    this.storageReads++;
    return this.registered.has(`${token} ${a}`);
  }
  async accessKey(a: AccountId, pk: PublicKey) {
    return this.keys.get(`${a} ${pk}`) ?? null;
  }
  async delivery(hash: string): Promise<DeliveryRead> {
    return this.txs.get(hash) ?? { status: "unknown" };
  }
}

const reader = new FakeIntentsReader();
let deliveryGate: Promise<void> | null = null;
let deliveryOverride: ((hash: string, recipient: string, amount: bigint) => DeliveryRead | null) | null = null;
let deliveries = 0;
// A short deposit waits a minute for a top-up, so a test can top it up.
const fake = new FakeOneClick({
  stepMs: 0,
  refundAfterMs: 60_000,
  accountExists: (id) => reader.accounts.has(id),
  deliver: async ({ recipient, amount }) => {
    if (deliveryGate) await deliveryGate;
    const hash = `LaunchTx${++deliveries}AbCdEfGhJkLmNoPq`;
    reader.txs.set(hash, deliveryOverride?.(hash, recipient, amount) ?? { status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: recipient, amount }] });
    return { txHash: hash };
  },
});
/** Lets a test answer for 1Click: a status and body, or a promise that settles when the test says so. */
let answer: ((path: string, url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> | null) | null = null;
const oneclick: FetchLike = async (url, init) => {
  const own = answer?.(new URL(url).pathname, url) ?? null;
  if (own) {
    const r = await own;
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  }
  return fake.fetch(url, init);
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

const tmp = tempDir("payminto-intents-launch-");
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
    // text
  }
  return { status: r.status, json, text };
};
let client = 0;
const pub = (method: string, path: string, body?: unknown) => call(method, path, body, { "x-forwarded-for": `10.1.${Math.floor(++client / 250)}.${client % 250}` }, null);

function proof(account: AccountId, key = MAINNET_KEY, timestamp = Math.floor(Date.now() / 1000)): IntentsPayoutProof {
  const digest = nep413Digest(intentsPayoutProofRequest(shopId, account, timestamp, { settlementNetwork: "near:mainnet (simulated)", hub: chain.hub }));
  return { timestamp, public_key: key.publicKey, signature: Buffer.from(signDigest(key.secretKey, digest), "hex").toString("base64") };
}

const svc = () => node.services.gateway!.intents!;
const db = () => node.services.db;
const events = (paymentId: string) => db().all<{ type: string }>("SELECT type FROM gateway_events WHERE payment_id = ? ORDER BY seq", paymentId).map((e) => e.type);
const alerts = (objectId: string) =>
  db()
    .all<{ merchant_id: string | null; body: string }>("SELECT merchant_id, body FROM gateway_events WHERE type = 'intents.alert' AND object_id = ? ORDER BY seq", objectId)
    .map((e) => ({ ...(JSON.parse(e.body).data.object as { kind: string; message: string; merchant_id: string; quote: any }), scope: e.merchant_id === null ? "platform" : e.merchant_id }));
const newPayment = async (amount = "5000000") => {
  const r = await call("POST", "/v1/payments", { amount, description: "Launch gaps" });
  expect(r.status, r.text).toBe(201);
  return r.json.id as string;
};
const newQuote = async (paymentId: string, origin = BASE_USDC, refund = REFUND) => {
  const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: origin, refund_to: refund });
  expect([200, 201], r.text).toContain(r.status);
  return r.json;
};
const metric = async (kind: string) => {
  const text = (await call("GET", "/metrics")).text;
  const line = text.split("\n").find((l) => l.startsWith(`payminto_intents_alerts_total{kind="${kind}"}`));
  return line ? Number(line.split(" ").at(-1)) : null;
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
  for (const a of [MAINNET, NEXT, SOLVER]) reader.accounts.add(a);
  reader.keys.set(`${MAINNET} ${MAINNET_KEY.publicKey}`, "full_access");
  reader.keys.set(`${NEXT} ${NEXT_KEY.publicKey}`, "full_access");
  reader.registered.add(`${TOKEN} ${MAINNET}`);
  reader.registered.add(`${TOKEN} ${NEXT}`);
  expect((await call("PUT", "/v1/merchant/intents-payout", { account: MAINNET, proof: proof(MAINNET) })).status).toBe(200);
  expect((await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] })).status).toBe(200);
});

afterAll(async () => {
  vi.useRealTimers();
  await node?.stop();
  await fake.close();
  tmp.cleanup();
});

describe("the receipt and a payment on its way", () => {
  it("names the confirmed quote as active_quote, not a newer one that was never paid", async () => {
    const paymentId = await newPayment();
    const paid = await newQuote(paymentId);
    const newer = await newQuote(paymentId, SOL_USDC, SOL_REFUND);
    expect((await pub("GET", `/v1/checkout/${paymentId}`)).json.intents.active_quote.id).toBe(newer.id);
    await fake.deposit(paid.deposit_address, BigInt(paid.send_exactly.amount));
    await fake.idle();
    expect((await svc().checkNow(paid.id)).status).toBe("confirmed");
    const view = (await pub("GET", `/v1/checkout/${paymentId}`)).json;
    expect(view.status).toBe("paid");
    expect(view.intents.active_quote).toMatchObject({ id: paid.id, status: "confirmed", origin: { chain: "base" } });
  });

  it("inFlight is true only while a deposit was seen and the quote is not final", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    expect(svc().inFlight(paymentId)).toBe(false);
    let release!: () => void;
    deliveryGate = new Promise<void>((r) => (release = r));
    await pub("POST", `/v1/checkout/${paymentId}/intents/quotes/${q.id}/simulate`, {});
    expect(svc().row(q.id)!.status).toBe("processing");
    expect(svc().inFlight(paymentId)).toBe(true);
    release();
    deliveryGate = null;
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("confirmed");
    expect(svc().inFlight(paymentId)).toBe(false);
    expect(svc().inFlight("pay_unknownaaaaaaaaaaaaaaaaa")).toBe(false);
  });
});

describe("what the buyer sends", () => {
  it("a short deposit then a top-up completes the payment", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    const first = 3_000_000n;
    await fake.deposit(q.deposit_address, first);
    await fake.idle();
    const short = await svc().checkNow(q.id);
    expect(short.status).toBe("incomplete_deposit");
    expect(svc().inFlight(paymentId)).toBe(true);
    expect((await call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ status: "processing", credits: [{ status: "pending" }] });
    const rest = BigInt(q.send_exactly.amount) - first;
    await fake.deposit(q.deposit_address, rest);
    await fake.idle();
    const done = await svc().checkNow(q.id);
    expect(done).toMatchObject({ status: "confirmed", verification: "rpc_checked", deposited_amount: q.send_exactly.amount });
    expect((await call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ status: "paid", amount_paid: "5000000", credits: [{ status: "confirmed", amount: "5000000" }] });
    expect(events(paymentId)).not.toContain("payment.deposit_returned");
  });

  it("an excess and the unused price buffer come back as refunded on a confirmed quote, and the payment is paid, not overpaid", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    const sent = BigInt(q.send_exactly.amount) + 1_000_000n;
    await fake.deposit(q.deposit_address, sent);
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("confirmed");
    const json = (await pub("GET", `/v1/checkout/${paymentId}/intents/quotes/${q.id}`)).json;
    expect(json).toMatchObject({
      status: "confirmed",
      deposited: { amount: String(sent) },
      delivered: { amount: "5000000", symbol: "USDC" },
      refunded: { amount: String(sent - BigInt(q.min_amount_in.amount)), symbol: "USDC" },
      refund_reason: null,
    });
    const detail = (await call("GET", `/v1/payments/${paymentId}`)).json;
    expect(detail).toMatchObject({ status: "paid", amount_paid: "5000000" });
    expect(events(paymentId)).toEqual(["payment.created", "payment.processing", "payment.paid"]);
    // Even the exact amount asked for returns the unused buffer.
    const exact = await newQuote(await newPayment());
    await fake.deposit(exact.deposit_address, BigInt(exact.send_exactly.amount));
    await fake.idle();
    await svc().checkNow(exact.id);
    expect((await pub("GET", `/v1/checkout/${exact.payment_id}/intents/quotes/${exact.id}`)).json.refunded).toMatchObject({ amount: String(BigInt(exact.send_exactly.amount) - BigInt(exact.min_amount_in.amount)) });
  });

  it("a SLIPPAGE refund returns the deposit: the payment is open again and payment.deposit_returned goes out", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount), { slippage: true });
    await fake.idle();
    const row = await svc().checkNow(q.id);
    expect(row).toMatchObject({ status: "refunded", refund_reason: "SLIPPAGE" });
    expect((await call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ status: "open", amount_paid: "0", credits: [] });
    expect(events(paymentId)).toContain("payment.deposit_returned");
    expect(svc().inFlight(paymentId)).toBe(false);
  });
});

describe("1Click busy, slow or refusing the key", () => {
  it("answers 503 INTENTS_BUSY when 1Click answers 429 or 5xx to a quote", async () => {
    const paymentId = await newPayment();
    for (const status of [429, 500, 502, 503]) {
      answer = (path) => (path === "/v0/quote" ? { status, body: { message: "busy" } } : null);
      const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
      answer = null;
      expect(r.status, `${status}: ${r.text}`).toBe(503);
      expect(r.json.error.code).toBe("INTENTS_BUSY");
    }
  });

  it("a 401 on status raises one auth alert and retries slowly instead of backing off forever", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    const before = (await metric("auth")) ?? 0;
    answer = (path) => (path === "/v0/status" ? { status: 401, body: { message: "Unauthorized" } } : null);
    try {
      const now = Math.floor(Date.now() / 1000);
      const row = await svc().checkNow(q.id);
      expect(row.status).toBe("awaiting_deposit");
      expect(row.next_poll_unix).toBeGreaterThanOrEqual(now + AUTH_RETRY_SEC);
      expect(AUTH_RETRY_SEC).toBe(900);
      await svc().checkNow(q.id);
      await svc().checkNow(q.id);
    } finally {
      answer = null;
    }
    const a = alerts(q.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ scope: "platform", kind: "auth", object: "intents_alert", merchant_id: shopId, payment_id: paymentId, quote: { id: q.id } });
    // Not on the payment's timeline: the business does not see platform alerts.
    expect(events(paymentId)).not.toContain("intents.alert");
    expect(await metric("auth")).toBe(before + 1);
    // The key works again: the next poll reads the status as usual.
    expect(await svc().checkNow(q.id)).toMatchObject({ status: "awaiting_deposit", provider_status: "PENDING_DEPOSIT", poll_errors: 0 });
  });

  it("a hung status call does not stall the other due quotes: the watcher polls them concurrently", async () => {
    const paymentIds = [await newPayment(), await newPayment(), await newPayment()];
    const quotes = await Promise.all(paymentIds.map((p) => newQuote(p)));
    const hung = quotes[0].deposit_address as string;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    answer = (path, url) => (path === "/v0/status" && url.includes(hung) ? held.then(() => ({ status: 429, body: { message: "slow" } })) : null);
    db().run("UPDATE intents_quotes SET next_poll_unix = 0, updated_at = 'old' WHERE id IN (?, ?, ?)", ...quotes.map((q) => q.id));
    const tick = node.services.gateway!.intentsWatcher!.tick();
    try {
      await vi.waitFor(() => {
        for (const q of quotes.slice(1)) expect(svc().row(q.id)!.updated_at).not.toBe("old");
      });
      expect(svc().row(quotes[0].id)!.updated_at).toBe("old");
    } finally {
      release();
      answer = null;
    }
    expect(await tick).toBeGreaterThanOrEqual(3);
    expect(svc().row(quotes[0].id)!.poll_errors).toBe(1);
  });
});

describe("the NEAR mainnet reads", () => {
  it("give up on an RPC that does not answer, or does not finish its body, within the timeout", async () => {
    const hung = (() => new Promise(() => {})) as unknown as typeof fetch;
    const slowBody = (async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })) as unknown as typeof fetch;
    for (const f of [hung, slowBody]) {
      const rpc = new IntentsRpc("http://rpc.invalid", { fetch: f, timeoutMs: 30 });
      const started = Date.now();
      await expect(rpc.storageRegistered(TOKEN, MAINNET)).rejects.toThrow(/did not answer within 30 ms/);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });
});

describe("operator alerts", () => {
  it("a delivery read on NEAR that pays less is a contradicted alert, raised once", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    deliveryOverride = (hash, recipient, amount) => ({ status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: recipient, amount: amount - 1n }] });
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    deliveryOverride = null;
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    await svc().checkNow(q.id);
    expect(alerts(q.id).map((a) => a.kind)).toEqual(["contradicted"]);
    expect(await metric("contradicted")).toBeGreaterThanOrEqual(1);
  });

  it("a confirmation on 1Click's word alone is a provider_only alert", async () => {
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    deliveryOverride = () => ({ status: "unknown" });
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    deliveryOverride = null;
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    expect(alerts(q.id)).toEqual([]);
    db().run("UPDATE intents_quotes SET delivered_unix = delivered_unix - 601 WHERE id = ?", q.id);
    expect(await svc().checkNow(q.id)).toMatchObject({ status: "confirmed", verification: "provider_only" });
    expect(alerts(q.id).map((a) => a.kind)).toEqual(["provider_only"]);
  });

  it(`a quote with a deposit still not final ${STUCK_AFTER_SEC / 3600} hours past its deadline is a stuck alert, raised once`, async () => {
    expect(STUCK_AFTER_SEC).toBe(6 * 3600);
    const paymentId = await newPayment();
    const q = await newQuote(paymentId);
    await fake.deposit(q.deposit_address, 1_000_000n);
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("incomplete_deposit");
    expect(alerts(q.id)).toEqual([]);
    db().run("UPDATE intents_quotes SET deadline_unix = ? WHERE id = ?", Math.floor(Date.now() / 1000) - STUCK_AFTER_SEC - 1, q.id);
    await svc().checkNow(q.id);
    await svc().checkNow(q.id);
    expect(alerts(q.id).map((a) => a.kind)).toEqual(["stuck"]);
    expect(await metric("stuck")).toBe(1);
    // A quote that never saw a deposit is not stuck: it simply expires later.
    const idle = await newQuote(await newPayment());
    db().run("UPDATE intents_quotes SET deadline_unix = ? WHERE id = ?", Math.floor(Date.now() / 1000) - STUCK_AFTER_SEC - 1, idle.id);
    await svc().checkNow(idle.id);
    expect(alerts(idle.id)).toEqual([]);
  });
});

describe("the payout account changes or unregisters", () => {
  it("re-reads the USDC registration before a deposit address, cached a few minutes, and refuses once it is gone", async () => {
    expect(REGISTRATION_CACHE_SEC).toBe(300);
    const paymentId = await newPayment();
    const reads = reader.storageReads;
    await newQuote(paymentId);
    await newQuote(paymentId, SOL_USDC, SOL_REFUND);
    // One read at most for both (the payout view may have read it already).
    expect(reader.storageReads - reads).toBeLessThanOrEqual(1);
    reader.registered.delete(`${TOKEN} ${MAINNET}`);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (REGISTRATION_CACHE_SEC + 1) * 1000 });
    try {
      const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: `0x${"3".repeat(40)}` });
      expect(r.status, r.text).toBe(409);
      expect(r.json.error).toMatchObject({ code: "INTENTS_UNAVAILABLE", message: "This business has not finished setting up payments from other chains." });
      expect(db().get<{ r: number }>("SELECT intents_payout_registered AS r FROM merchants WHERE id = ?", shopId)!.r).toBe(0);
      expect((await pub("GET", `/v1/checkout/${paymentId}`)).json.intents).toMatchObject({ available: false, reason: "This business has not finished setting up payments from other chains." });
    } finally {
      vi.useRealTimers();
      reader.registered.add(`${TOKEN} ${MAINNET}`);
    }
    // Registered again: the next fresh read of the payout account turns it back on.
    expect((await call("GET", "/v1/merchant/intents-payout")).json.verified).toBe(true);
    expect((await pub("GET", `/v1/checkout/${paymentId}`)).json.intents.available).toBe(true);
  });

  it("a new payout account expires open quotes without a deposit; a deposit on its way keeps its recipient", async () => {
    const openPayment = await newPayment();
    const open = await newQuote(openPayment);
    const busyPayment = await newPayment();
    const busy = await newQuote(busyPayment);
    await fake.deposit(busy.deposit_address, 1_000_000n);
    await fake.idle();
    expect((await svc().checkNow(busy.id)).status).toBe("incomplete_deposit");

    const r = await call("PUT", "/v1/merchant/intents-payout", { account: NEXT, proof: proof(NEXT, NEXT_KEY) });
    expect(r.status, r.text).toBe(200);
    expect(svc().row(open.id)!.status).toBe("expired");
    expect(svc().row(busy.id)).toMatchObject({ status: "incomplete_deposit", recipient: MAINNET });
    expect((await pub("GET", `/v1/checkout/${openPayment}`)).json.intents.active_quote).toBeNull();
    // The next address pays the new account.
    const next = await newQuote(openPayment);
    expect(next.id).not.toBe(open.id);
    expect(next.recipient).toBe(NEXT);
    // Saving the same account again changes nothing.
    expect((await call("PUT", "/v1/merchant/intents-payout", { account: NEXT, proof: proof(NEXT, NEXT_KEY) })).status).toBe(200);
    expect(svc().row(next.id)!.status).toBe("awaiting_deposit");
    expect(svc().payoutChanged(shopId, NEXT)).toBe(0);
  });
});
