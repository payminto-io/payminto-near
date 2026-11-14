/**
 * The business side of the any-chain checkout (NEAR Intents) end to end over HTTP: manual refunds of a payment that came
 * from another chain, the receipt email, the NEAR wallet refused while a deposit is on its way, returned and failed
 * deposits in the reconciliation report, and live mode taking only real money from other chains. The fake 1Click
 * server runs in process and NEAR is read from memory: the database is a temp *.test.db and the chain is FakeChain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import type { FetchLike } from "@payminto/near-addons/intents";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY, FakeOneClick } from "@payminto/near-addons/intents/fake-server";
import { intentsPayoutProofRequest, nep413Digest, signDigest, type AccountId, type IntentsPayoutProof, type PublicKey } from "@payminto/protocol";
import type { GatewayConfig, IntentsConfig } from "../src/config.ts";
import type { DeliveryRead, IntentsChainReader } from "../src/gateway/intents-rpc.ts";
import { silentLogger } from "../src/logger.ts";
import type { AccessKeyKind } from "../src/near-rpc.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { FakeNearRpc, payoutAccount, startFakeChain, tempDir, testConfig, testKey, TOKEN } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const SHOP = payoutAccount("shop.testnet", 90);
const MAINNET = "corner-shop.near";
const MAINNET_KEY = testKey(91);
const SOLVER = "solver.near";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const REFUND = "0x2527d02599ba641c19fea793cd0f167589a0f10d";
const BASE_TX = `0x${"ab".repeat(32)}`;
const SOL_TX = "5".repeat(87);
const LIVE_REASON = "Off in live mode: the hub runs on a test network, and this server takes only real money from other chains.";

class FakeIntentsReader implements IntentsChainReader {
  readonly accounts = new Set<string>([MAINNET, SOLVER]);
  readonly keys = new Map<string, AccessKeyKind>([[`${MAINNET} ${MAINNET_KEY.publicKey}`, "full_access"]]);
  readonly registered = new Set<string>();
  readonly txs = new Map<string, DeliveryRead>();
  async accountExists(a: AccountId) {
    return this.accounts.has(a);
  }
  async storageRegistered(token: AccountId, a: AccountId) {
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
let deliveries = 0;
const fake = new FakeOneClick({
  stepMs: 0,
  refundAfterMs: 0,
  accountExists: (id) => reader.accounts.has(id),
  deliver: async ({ recipient, amount }) => {
    if (deliveryGate) await deliveryGate;
    const hash = `BizDeliveryTx${++deliveries}AbCdEfGhJkLm`;
    reader.txs.set(hash, { status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: recipient, amount }] });
    return { txHash: hash };
  },
});
const oneclick: FetchLike = (url, init) => fake.fetch(url, init);

const simulated: IntentsConfig = {
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

const gatewayOf = (intents: IntentsConfig): GatewayConfig => ({
  seedPayout: SHOP.account,
  platformName: "Corner Shop",
  feeRecipient: null,
  checkoutBaseUrl: "http://localhost:3000",
  checkoutTtlSec: 1800,
  webhookAllowPrivate: true,
  watchIntervalMs: 2000,
  intents,
});

type Res = { status: number; json: any; text: string };

/** One node and its helpers: business calls with the recovery key, public calls from their own client address. */
async function startShop(intents: IntentsConfig, fetchImpl: FetchLike, prefix: string) {
  const tmp = tempDir(prefix);
  const chain: FakeChain = startFakeChain([]);
  chain.register(SHOP.account);
  const node: ClearingNode = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, gateway: gatewayOf(intents), trustProxyHops: 1 }), {
    chain,
    nearRpc: new FakeNearRpc().addKey(SHOP.account, SHOP.key.publicKey),
    intentsReader: reader,
    intentsFetch: fetchImpl,
    logger: silentLogger,
    port: 0,
    workers: false,
  });
  let shopId = "";
  let client = 0;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth: string | null = ADMIN): Promise<Res> => {
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
  const pub = (method: string, path: string, body?: unknown) => call(method, path, body, { "x-forwarded-for": `10.1.${Math.floor(++client / 250)}.${client % 250}` }, null);
  shopId = (await call("GET", "/v1/merchant")).json.id;
  const settlementNetwork = intents.mode === "live" ? "near:mainnet" : "near:mainnet (simulated)";
  const proof = (): IntentsPayoutProof => {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = nep413Digest(intentsPayoutProofRequest(shopId, MAINNET, timestamp, { settlementNetwork, hub: chain.hub }));
    return { timestamp, public_key: MAINNET_KEY.publicKey, signature: Buffer.from(signDigest(MAINNET_KEY.secretKey, digest), "hex").toString("base64") };
  };
  // The business proves its NEAR account, registers it with USDC and turns the any-chain checkout on.
  const usdc = intents.usdcContract ?? "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  reader.registered.add(`${usdc} ${MAINNET}`);
  const set = await call("PUT", "/v1/merchant/intents-payout", { account: MAINNET, proof: proof() });
  expect(set.status, set.text).toBe(200);
  const on = await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] });
  expect(on.status, on.text).toBe(200);
  return {
    node,
    chain,
    call,
    pub,
    get shopId() {
      return shopId;
    },
    async stop() {
      await node.stop();
      tmp.cleanup();
    },
  };
}

type Shop = Awaited<ReturnType<typeof startShop>>;
let shop: Shop;

const svc = () => shop.node.services.gateway!.intents!;
const outbox = (to: string) => shop.node.services.db.all<{ subject: string; body_text: string; kind: string; link: string | null }>("SELECT subject, body_text, kind, link FROM outbox_emails WHERE to_addr = ? ORDER BY id", to);

async function newPayment(body: Record<string, unknown> = {}): Promise<string> {
  const r = await shop.call("POST", "/v1/payments", { amount: "5000000", description: "Coffee subscription", ...body });
  expect(r.status, r.text).toBe(201);
  return r.json.id as string;
}

async function newQuote(paymentId: string) {
  const r = await shop.pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: REFUND });
  expect([200, 201], r.text).toContain(r.status);
  return r.json;
}

/** A payment paid in full from USDC on Base, read on NEAR: confirmed rpc_checked. */
async function paidFromBase(body: Record<string, unknown> = {}) {
  const id = await newPayment(body);
  const q = await newQuote(id);
  await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
  await fake.idle();
  expect((await svc().checkNow(q.id)).status).toBe("confirmed");
  expect((await shop.call("GET", `/v1/payments/${id}`)).json.status).toBe("paid");
  return { id, quote: q };
}

beforeAll(async () => {
  shop = await startShop(simulated, oneclick, "payminto-anychain-biz-");
});

afterAll(async () => {
  await shop?.stop();
  await fake.close();
});

describe("refunding a payment that came from another chain (manual refunds)", () => {
  let paymentId = "";
  let originTx: { hash: string; explorer_url: string | null };

  it("a buyer who paid from the one-screen checkout gave no address: the refund details say so, never the business's own account", async () => {
    const id = await newPayment();
    const q = (await shop.pub("POST", `/v1/checkout/${id}/intents/quotes`, { origin_asset: BASE_USDC })).json;
    expect(q.refund_type).toBe("INTENTS");
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("confirmed");
    const r = await shop.call("POST", "/v1/refunds", { paymentId: id, amount: "1000000", reason: "returned item" });
    expect(r.status, r.text).toBe(409);
    expect(r.json.error.details).toMatchObject({ chain: "base", refund_to: null });
    const view = (await shop.pub("GET", `/v1/checkout/${id}`)).json;
    expect(view.intents.active_quote.refund_to).not.toMatch(/\.\.\./);
  });

  it("refuses a NEAR refund and says where to send it: 409 REFUND_MANUAL_REQUIRED with the buyer's full address", async () => {
    const paid = await paidFromBase();
    paymentId = paid.id;
    const detail = (await shop.call("GET", `/v1/payments/${paymentId}`)).json;
    originTx = detail.intents.quotes[0].origin_txs[0];
    const r = await shop.call("POST", "/v1/refunds", { paymentId, amount: "1000000", reason: "returned item" });
    expect(r.status, r.text).toBe(409);
    expect(r.json.error).toEqual({
      code: "REFUND_MANUAL_REQUIRED",
      message: "This payment came from another chain through NEAR Intents. Send the refund from your own wallet on that chain, then record it here.",
      details: {
        chain: "base",
        chain_name: "Base",
        symbol: "USDC",
        refund_to: REFUND,
        deposit_tx: { hash: originTx.hash, explorer_url: originTx.explorer_url ?? `https://basescan.org/tx/${originTx.hash}` },
        refundable: "5000000",
      },
    });
    // Nothing was created.
    expect((await shop.call("GET", `/v1/refunds?payment_id=${paymentId}`)).json.items).toEqual([]);
  });

  it("checks the chain, the transaction format and the amount of a manual refund", async () => {
    const post = (manual: unknown, amount = "1000000") => shop.call("POST", "/v1/refunds", { paymentId, amount, reason: "returned item", manual });
    const wrongChain = await post({ chain: "sol", tx_hash: SOL_TX });
    expect(wrongChain.status).toBe(400);
    expect(wrongChain.json.error.code).toBe("MANUAL_REFUND_CHAIN_MISMATCH");
    expect(wrongChain.json.error.message).toMatch(/Base/);
    const badHash = await post({ chain: "base", tx_hash: "0x1234" });
    expect(badHash.status).toBe(400);
    expect(badHash.json.error.code).toBe("INVALID_TX_HASH");
    const tooMuch = await post({ chain: "base", tx_hash: BASE_TX }, "5000001");
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.json.error.code).toBe("REFUND_EXCEEDS_PAID");
  });

  it("needs refunds.issue: a key that may only request refunds gets the permission error", async () => {
    const key = shop.node.services.gateway!.keys.create(shop.shopId, "request only");
    shop.node.services.db.run("UPDATE api_keys SET permissions = ? WHERE id = ?", JSON.stringify(["payments.read", "refunds.request"]), key.id);
    const r = await shop.call("POST", "/v1/refunds", { paymentId, amount: "1000000", manual: { chain: "base", tx_hash: BASE_TX } }, {}, key.secret);
    expect(r.status, r.text).toBe(403);
    expect(r.json.error).toMatchObject({ code: "FORBIDDEN", details: { permission: "refunds.issue" } });
  });

  it("records a manual refund as succeeded: no NEAR transfer, the payment's refunded amount moves, refund.succeeded goes out", async () => {
    const r = await shop.call("POST", "/v1/refunds", { paymentId, amount: "2000000", reason: "returned item", note: "sent from our Base wallet", manual: { chain: "base", tx_hash: BASE_TX } });
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({
      payment_id: paymentId,
      amount: "2000000",
      status: "succeeded",
      to: `base:${REFUND}`,
      method: "manual",
      verification: "manual",
      tx_hash: null,
      transfer: null,
      note: "sent from our Base wallet",
      manual: { chain: "base", chain_name: "Base", tx_hash: BASE_TX, explorer_url: `https://basescan.org/tx/${BASE_TX}`, recorded_by: "recovery_key" },
    });
    const got = await shop.call("GET", `/v1/refunds/${r.json.id}`);
    expect(got.json).toMatchObject({ status: "succeeded", manual: { tx_hash: BASE_TX }, transfer: null });
    expect((await shop.call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ amount_refunded: "2000000", refund_status: "partial" });
    const ev = shop.node.services.db.get<{ body: string }>("SELECT body FROM gateway_events WHERE type = 'refund.succeeded' AND object_id = ?", r.json.id);
    expect(JSON.parse(ev!.body).data.object).toMatchObject({ id: r.json.id, method: "manual", manual: { chain: "base", tx_hash: BASE_TX } });
    const audit = shop.node.services.db.get<{ action: string; meta: string }>("SELECT action, meta_json AS meta FROM audit_events WHERE target = ?", r.json.id);
    expect(audit?.action).toBe("refund.issued");
    expect(JSON.parse(audit!.meta)).toMatchObject({ manual: true, chain: "base", tx_hash: BASE_TX });
    // A normal refund has `manual: null`; the same transaction cannot record a second refund.
    const again = await shop.call("POST", "/v1/refunds", { paymentId, amount: "1000000", manual: { chain: "base", tx_hash: BASE_TX.toUpperCase().replace("0X", "0x") } });
    expect(again.json.error.code).toBe("TX_ALREADY_USED");
    // The refundable amount went down.
    const guard = await shop.call("POST", "/v1/refunds", { paymentId, amount: "1000000" });
    expect(guard.json.error.details.refundable).toBe("3000000");
  });

  it("is only for payments that came from another chain", async () => {
    const id = await newPayment();
    shop.node.services.db.run("UPDATE payments SET status = 'paid', amount_paid = amount, payer = ?, method = 'wallet' WHERE id = ?", "buyer.testnet", id);
    const r = await shop.call("POST", "/v1/refunds", { paymentId: id, amount: "1000000", manual: { chain: "base", tx_hash: `0x${"cd".repeat(32)}` } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("MANUAL_REFUND_NOT_ALLOWED");
    const normal = await shop.call("POST", "/v1/refunds", { paymentId: id, amount: "1000000" });
    expect(normal.status, normal.text).toBe(201);
    expect(normal.json).toMatchObject({ method: null, manual: null, to: "buyer.testnet" });
  });

  it("shows the manual refund in the reconciliation report with its origin-chain explorer link", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const row = (await shop.call("GET", `/v1/reports/reconciliation?from=${day}&to=${tomorrow}`)).json.rows.find((x: any) => x.payment_id === paymentId);
    expect(row.refunds).toMatchObject([{ amount: "2.000000", status: "succeeded", tx_hash: BASE_TX, explorer_url: `https://basescan.org/tx/${BASE_TX}` }]);
  });
});

describe("the receipt email", () => {
  it("is queued once when a payment with a customer email becomes paid, and never twice", async () => {
    const email = "ada@example.com";
    const { id } = await paidFromBase({ customer_email: email, reference: "INV-77" });
    const mails = outbox(email);
    expect(mails).toHaveLength(1);
    const m = mails[0]!;
    expect(m.kind).toBe("receipt");
    expect(m.subject).toBe("Receipt from Corner Shop");
    expect(m.link).toBe(`http://localhost:3000/pay/${id}`);
    expect(m.body_text).toContain("5.00 USDC");
    expect(m.body_text).toContain("From USDC on Base through NEAR Intents");
    expect(m.body_text).toMatch(/Paid at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(m.body_text).toContain(`http://localhost:3000/pay/${id}`);
    expect(m.body_text).toContain("INV-77");
    expect(m.body_text).not.toContain(String.fromCharCode(0x2014));
    // A recompute (a restart re-reading the payment) and a late duplicate credit do not send it again.
    shop.node.services.gateway!.payments.recompute(id);
    expect(outbox(email)).toHaveLength(1);
    expect(shop.node.services.db.get<{ receipt_sent_at: string | null }>("SELECT receipt_sent_at FROM payments WHERE id = ?", id)?.receipt_sent_at).toMatch(/^\d{4}-/);
  });

  it("is sent when the buyer saves an email on a payment that is already paid, with the support email", async () => {
    await shop.call("PATCH", "/v1/merchant", { support_email: "help@corner.example" });
    const { id } = await paidFromBase();
    const email = "late@example.com";
    const r = await shop.pub("POST", `/v1/checkout/${id}/email`, { email });
    expect(r.status, r.text).toBe(200);
    const mails = outbox(email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body_text).toContain("help@corner.example");
    // A second save is refused (the first email stays) and sends nothing.
    expect((await shop.pub("POST", `/v1/checkout/${id}/email`, { email: "other@example.com" })).json.error.code).toBe("EMAIL_ALREADY_SET");
    expect(outbox("other@example.com")).toHaveLength(0);
    expect(outbox(email)).toHaveLength(1);
  });

  it("is not sent for a payment without an email, nor before it is paid", async () => {
    const before = shop.node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox_emails WHERE kind = 'receipt'")!.n;
    await paidFromBase();
    const open = await newPayment();
    expect((await shop.pub("POST", `/v1/checkout/${open}/email`, { email: "early@example.com" })).status).toBe(200);
    expect(outbox("early@example.com")).toHaveLength(0);
    expect(shop.node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox_emails WHERE kind = 'receipt'")!.n).toBe(before);
  });
});

describe("a deposit on its way blocks the NEAR wallet on that checkout", () => {
  it("answers 409 INTENTS_IN_FLIGHT to choosing or paying with the wallet until the deposit is done", async () => {
    const id = await newPayment();
    const q = await newQuote(id);
    let release!: () => void;
    deliveryGate = new Promise<void>((r) => (release = r));
    try {
      const r = await shop.pub("POST", `/v1/checkout/${id}/intents/quotes/${q.id}/simulate`, {});
      expect(r.json.status).toBe("processing");
      const choose = await shop.pub("POST", `/v1/checkout/${id}/method`, { method: "wallet" });
      expect(choose.status, choose.text).toBe(409);
      expect(choose.json.error.code).toBe("INTENTS_IN_FLIGHT");
      expect(choose.json.error.message).toMatch(/already on its way/);
      const pay = await shop.pub("POST", `/v1/checkout/${id}/wallet`, {});
      expect(pay.status).toBe(409);
      expect(pay.json.error.code).toBe("INTENTS_IN_FLIGHT");
      expect((await shop.pub("GET", `/v1/checkout/${id}`)).json.methods).not.toContain("wallet");
    } finally {
      release();
      deliveryGate = null;
      await fake.idle();
    }
  });
});

describe("the reconciliation report", () => {
  it("lists a returned deposit on its own line, with what was deposited, returned and kept as the refund fee", async () => {
    const id = await newPayment();
    const q = await newQuote(id);
    await shop.pub("POST", `/v1/checkout/${id}/intents/quotes/${q.id}/simulate`, { amount: "3000000" });
    await fake.idle();
    const after = await svc().checkNow(q.id);
    expect(after.status).toBe("refunded");
    const day = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = (await shop.call("GET", `/v1/reports/reconciliation?from=${day}&to=${tomorrow}`)).json;
    const row = report.rows.find((x: any) => x.payment_id === id);
    expect(row.status).toBe("open");
    expect(row.deposits).toHaveLength(1);
    const d = row.deposits[0];
    expect(d).toMatchObject({ quote_id: q.id, status: "returned", origin_asset: BASE_USDC, chain: "base", symbol: "USDC", deposit_address: q.deposit_address, refund_to: `base:${REFUND}`, refund_reason: "PARTIAL_DEPOSIT" });
    expect(d.deposited).toBe("3.000000");
    expect(BigInt(d.base_units.returned) + BigInt(d.base_units.refund_fee)).toBe(3_000_000n);
    expect(d.origin_txs.length).toBeGreaterThan(0);
    const csv = (await shop.call("GET", `/v1/reports/reconciliation?from=${day}&to=${tomorrow}&format=csv`)).text;
    const lines = csv.split("\r\n").filter((l) => l.startsWith(`"${id}"`));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"deposit_returned"');
    expect(lines[1]).toContain(`"${BASE_USDC}"`);
    expect(lines[1]).toContain('"3.000000 USDC"');
    expect(lines[1]).toMatch(/returned .* USDC, refund fee kept .* USDC/);
    // Money that never reached the business adds nothing to the totals.
    expect(report.totals.base_units.gross).toBe(report.rows.reduce((s: bigint, r: any) => s + BigInt(r.base_units.amount_paid), 0n).toString());
  });
});

describe("live mode takes only real money from other chains", () => {
  let live: Shop;
  const calls: string[] = [];
  const liveConfig: IntentsConfig = { ...simulated, mode: "live", baseUrl: "https://1click.chaindefuser.com", managerPublicKey: null, usdcContract: null, nearRpcUrl: "https://rpc.mainnet.near.org" };

  beforeAll(async () => {
    const outer = shop;
    live = await startShop(
      liveConfig,
      async (url) => {
        calls.push(url);
        throw new Error("tests never call the live 1Click API");
      },
      "payminto-anychain-live-",
    );
    shop = outer;
  });
  afterAll(async () => {
    await live?.stop();
  });

  it("offers only Any chain on the checkout, signs no wallet terms and locks the wallet and voucher methods", async () => {
    const p = await live.call("POST", "/v1/payments", { amount: "5000000" });
    expect(p.status, p.text).toBe(201);
    const view = (await live.pub("GET", `/v1/checkout/${p.json.id}`)).json;
    expect(view.methods).toEqual(["oneclick"]);
    expect(view.wallet).toBeNull();
    const methods = (await live.call("GET", `/v1/merchants/${live.shopId}/methods`)).json.items;
    expect(methods.map((m: any) => [m.method, m.enabled, m.locked_reason])).toEqual([
      ["oneclick", true, null],
      ["voucher", false, LIVE_REASON],
      ["wallet", false, LIVE_REASON],
    ]);
    expect((await live.call("GET", "/v1/merchant")).json.methods.find((m: any) => m.method === "wallet").locked_reason).toBe(LIVE_REASON);
    expect(calls).toEqual([]);
  });

  it("refuses to turn a locked method on, and keeps it when another method is saved", async () => {
    const on = await live.call("PUT", `/v1/merchants/${live.shopId}/methods`, { methods: [{ method: "wallet", enabled: true }] });
    expect(on.status).toBe(409);
    expect(on.json.error).toMatchObject({ code: "METHOD_NOT_OFFERED", message: LIVE_REASON });
    // Sending back what the list shows (locked methods off) changes nothing.
    const save = await live.call("PUT", `/v1/merchants/${live.shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }, { method: "wallet", enabled: false }, { method: "voucher", enabled: false }] });
    expect(save.status, save.text).toBe(200);
    expect(live.node.services.db.get<{ enabled: number }>("SELECT enabled FROM merchant_methods WHERE merchant_id = ? AND method = 'wallet'", live.shopId)?.enabled).toBe(1);
  });

  it("answers 409 METHOD_NOT_OFFERED to the wallet and vouchers on a checkout, and to a payment created for them", async () => {
    const p = (await live.call("POST", "/v1/payments", { amount: "5000000" })).json;
    const choose = await live.pub("POST", `/v1/checkout/${p.id}/method`, { method: "wallet" });
    expect(choose.status).toBe(409);
    expect(choose.json.error).toMatchObject({ code: "METHOD_NOT_OFFERED", message: LIVE_REASON });
    expect((await live.pub("POST", `/v1/checkout/${p.id}/wallet`, {})).json.error.code).toBe("METHOD_NOT_OFFERED");
    expect((await live.call("POST", "/v1/payments", { amount: "5000000", method: "wallet" })).json.error.code).toBe("METHOD_NOT_OFFERED");
    expect((await live.call("POST", "/v1/payments", { amount: "5000000", method: "voucher" })).json.error.code).toBe("METHOD_NOT_OFFERED");
    // An agent asking to pay by voucher is offered nothing.
    const x402 = await fetch(`${live.node.url}/v1/pay/${p.id}`);
    expect(x402.status).toBe(402);
    expect(((await x402.json()) as { accepts: unknown[] }).accepts).toEqual([]);
  });

  it("offers only Any chain on the public payment link", async () => {
    const link = (await live.call("POST", "/v1/links", { title: "Gift card", amount: "2000000" })).json;
    const view = (await live.pub("GET", `/v1/links/public/${link.slug}`)).json;
    expect(view.methods.map((m: any) => m.method)).toEqual(["oneclick"]);
    expect(view.intents).toMatchObject({ mode: "live", offered: true });
    const paid = await live.pub("POST", `/v1/links/public/${link.slug}/payments`, { method: "wallet" });
    expect(paid.json.error.code).toBe("METHOD_NOT_OFFERED");
    const any = await live.pub("POST", `/v1/links/public/${link.slug}/payments`, {});
    expect(any.status, any.text).toBe(201);
    expect(any.json.methods).toEqual(["oneclick"]);
  });

  it("keeps every method unlocked in simulated mode", async () => {
    const methods = (await shop.call("GET", `/v1/merchants/${shop.shopId}/methods`)).json.items;
    expect(methods.every((m: any) => m.locked_reason === null)).toBe(true);
  });

  it("is a live server: payments say livemode true and new API keys are sk_live_; a simulated server stays test", async () => {
    expect((await live.call("POST", "/v1/payments", { amount: "5000000" })).json.livemode).toBe(true);
    const key = await live.call("POST", "/v1/api-keys", { name: "live key" });
    expect(key.status, key.text).toBe(201);
    expect(key.json.secret).toMatch(/^sk_live_/);
    expect((await shop.call("POST", "/v1/payments", { amount: "5000000" })).json.livemode).toBe(false);
    expect((await shop.call("POST", "/v1/api-keys", { name: "test key" })).json.secret).toMatch(/^sk_test_/);
  });

  it("says its mode in /v1/info, so every screen can show Test or Live", async () => {
    const info = async (url: string) => (await (await fetch(`${url}/v1/info`)).json()) as { mode?: unknown };
    expect((await info(live.node.url)).mode).toEqual({ livemode: true, any_chain: "live" });
    expect((await info(shop.node.url)).mode).toEqual({ livemode: false, any_chain: "simulated" });
  });
});
