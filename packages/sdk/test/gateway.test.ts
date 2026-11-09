/**
 * The SDK's gateway side against a real stack: anvil with ClearingHub, MockStablecoin (EIP-3009), DepositFactory and
 * PaymentRouter, and the Payminto node in-process on a temp SQLite file with workers off (each tick driven here).
 * Covers GatewayClient (operator and merchant), constructEvent on real deliveries, payExact for a plain x402 agent,
 * and AgentClient paying a fee-carrying link with two vouchers under its policy guard.
 * The node is imported by path (it depends on this package, so it cannot be a dependency of it).
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, maxUint256, type Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  checkoutTypedData,
  decodeHeader,
  depositFactoryAbi,
  depositFactoryBytecode,
  networkFor,
  paymentRouterAbi,
  paymentRouterBytecode,
  receiveAuthorizationTypedData,
  signWebhook,
  type CheckoutView,
  type TokenDomain,
} from "@payminto/protocol";
import { startNode, type ClearingNode } from "../../../apps/node/src/server.ts";
import { silentLogger } from "../../../apps/node/src/logger.ts";
import type { GatewayConfig } from "../../../apps/node/src/config.ts";
import type { Gateway } from "../../../apps/node/src/gateway/index.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil, tempDir, testConfig, type Anvil } from "../../../apps/node/test/helpers.ts";
import {
  AgentClient,
  constructEvent,
  ExactPaymentError,
  GatewayClient,
  MemoryReceiptStore,
  NodeApiError,
  OwnerClient,
  payExact,
  signPayoutProof,
  WebhookSignatureError,
  type DeniedEvent,
} from "../src/index.ts";

const ADMIN = "sdk-gateway-admin-token";
const USDC = 1_000_000n;
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const PAYER = privateKeyToAccount(ANVIL_KEYS[2]);
const X402_AGENT = privateKeyToAccount(ANVIL_KEYS[3]);
const MANDATE_AGENT = privateKeyToAccount(ANVIL_KEYS[4]);
const NORTHWIND = privateKeyToAccount(ANVIL_KEYS[5]);
const SEED_PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]).address;
const FEES = privateKeyToAccount(ANVIL_KEYS[7]).address;

let anvil: Anvil;
let node: ClearingNode;
let g: Gateway;
let hub: Address;
let token: Address;
let router: Address;
let domain: TokenDomain;
let operator: GatewayClient;
let merchant: GatewayClient;
let merchantId: string;
const tmp = tempDir("payminto-sdk-gateway-");

const balanceOf = (who: Address) => anvil.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  const factory = await anvil.deploy(depositFactoryAbi as Abi, depositFactoryBytecode);
  router = await anvil.deploy(paymentRouterAbi as Abi, paymentRouterBytecode);
  const gateway: GatewayConfig = {
    seedPayout: SEED_PAYOUT,
    platformName: "SDK Platform",
    feeRecipient: FEES,
    paymentRouter: router,
    checkoutBaseUrl: "http://localhost:3000",
    depositFactory: factory,
    depositFactoryBlock: 0n,
    forwarderImplementation: null,
    checkoutTtlSec: 1800,
    webhookAllowPrivate: true,
    watchIntervalMs: 2000,
    screenMinPayerNonce: 0,
  };
  node = await startNode(testConfig({ rpcUrl: anvil.rpcUrl, hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, gateway }), { logger: silentLogger, port: 0, workers: false });
  g = node.services.gateway!;
  domain = { ...networkFor(31337).token.eip712, chainId: 31337, verifyingContract: token };
  for (const a of [PAYER, X402_AGENT, MANDATE_AGENT]) await mint(anvil, token, a.address, 50n * USDC);
  operator = new GatewayClient({ nodeUrl: node.url, apiKey: ADMIN });
}, 120_000);

afterAll(async () => {
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
});

describe("GatewayClient (operator)", () => {
  it("creates a fee plan, a merchant with a payout proof, its method fees and an API key", async () => {
    const plan = await operator.feePlans.create({ name: "Data plan", platform_fee_bps: 50, platform_fee_fixed: 10_000n });
    expect(plan).toMatchObject({ name: "Data plan", platform_fee_bps: 50, platform_fee_fixed: "10000" });
    expect((await operator.feePlans.list()).items.map((p) => p.id)).toContain(plan.id);

    const m = await operator.merchants.create({ name: "Northwind Data", fee_plan_id: plan.id, payout: await signPayoutProof(NORTHWIND, "new", { chainId: 31337, hub }) });
    expect(m).toMatchObject({ name: "Northwind Data", payout: NORTHWIND.address, fee_plan: { id: plan.id }, payment_router: router });
    merchantId = m.id;
    // A proof signed by another wallet is refused with the node's code.
    const forged = { ...(await signPayoutProof(PAYER, "new", { chainId: 31337, hub })), payout: NORTHWIND.address };
    await expect(operator.merchants.create({ name: "Forged", payout: forged })).rejects.toMatchObject({ name: "NodeApiError", code: "PAYOUT_PROOF_INVALID", status: 400 });

    const methods = await operator.merchants.setMethods(merchantId, [{ method: "deposit", fee_bps: 100, bearer: "customer" }]);
    expect(methods.items.find((x) => x.method === "deposit")).toMatchObject({ fee_bps: 100, bearer: "customer", enabled: true });

    // Two merchants now: the admin token needs Merchant-Id, which forMerchant sends.
    await expect(operator.merchant.retrieve()).rejects.toMatchObject({ code: "MERCHANT_REQUIRED" });
    const key = await operator.forMerchant(merchantId).apiKeys.create("server");
    expect(key.secret).toMatch(/^sk_test_/);
    merchant = new GatewayClient({ nodeUrl: node.url, apiKey: key.secret });
    expect(await merchant.merchant.retrieve()).toMatchObject({ id: merchantId, name: "Northwind Data" });
    // A merchant key cannot reach operator routes.
    await expect(merchant.merchants.list()).rejects.toMatchObject({ status: 401 });
    expect((await operator.platform.retrieve()).fee_recipient).toBe(FEES);
  });
});

describe("GatewayClient (merchant)", () => {
  it("creates payments with the fee breakdown under an Idempotency-Key, lists, retrieves and cancels them", async () => {
    const a = await merchant.payments.create({ amount: USDC, reference: "ord-1", method: "wallet" }, { idempotencyKey: "ord-1" });
    expect(a).toMatchObject({ status: "open", amount: "1000000", surcharge: "0", amount_due: "1000000", platform_fee: "15000", fee_total: "15000", net_amount: "985000", fee_recipient: FEES });
    expect(a.checkout_url).toBe(`http://localhost:3000/pay/${a.id}`);
    const replay = await merchant.payments.create({ amount: USDC, reference: "ord-1", method: "wallet" }, { idempotencyKey: "ord-1" });
    expect(replay.id).toBe(a.id);
    const mismatch = await merchant.payments.create({ amount: 2n * USDC, reference: "ord-1" }, { idempotencyKey: "ord-1" }).catch((e: unknown) => e);
    expect(mismatch).toBeInstanceOf(NodeApiError);
    expect((mismatch as NodeApiError).code).toBe("IDEMPOTENCY_MISMATCH");

    // The customer bears the deposit fee: it is added to amount_due, and the fee recipient gets both fees.
    const d = await merchant.payments.create({ amount: USDC, method: "deposit" });
    expect(d).toMatchObject({ amount: "1000000", surcharge: "10000", amount_due: "1010000", method_fee: "10000", platform_fee: "15000", fee_total: "25000", net_amount: "985000" });

    const detail = await merchant.payments.retrieve(a.id);
    expect(detail).toMatchObject({ id: a.id, credits: [], refunds: [] });
    expect(detail.events.map((e) => e.type)).toEqual(["payment.created"]);
    const list = await merchant.payments.list({ status: ["open"], limit: 10 });
    expect(list.items.map((p) => p.id)).toEqual(expect.arrayContaining([a.id, d.id]));
    expect(list.counts.open).toBeGreaterThanOrEqual(2);
    expect((await merchant.payments.cancel(d.id)).status).toBe("canceled");
    await expect(merchant.payments.retrieve("pay_aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({ status: 404 });
  });

  it("manages links, and finds listed ones in the public directory", async () => {
    const link = await merchant.links.create({ title: "Market dataset", amount: 2n * USDC }, { idempotencyKey: "link-1" });
    expect(link).toMatchObject({ title: "Market dataset", amount: "2000000", listed: true, active: true, url: `http://localhost:3000/l/${link.slug}` });
    expect((await merchant.links.list()).items.map((l) => l.id)).toContain(link.id);
    expect((await merchant.links.update(link.id, { description: "Daily OHLC" })).description).toBe("Daily OHLC");
    const dir = await new GatewayClient({ nodeUrl: node.url, apiKey: "unused" }).directory();
    expect(dir.services.find((s) => s.id === link.id)).toMatchObject({ type: "link", title: "Market dataset", schemes: ["exact", "payminto-voucher"], price: { amount: "2000000" } });
  });

  it("refunds gaslessly: the payout signs the router authorization the refund carries, the node relays it", async () => {
    const p = await merchant.payments.create({ amount: USDC });
    const view = (await (await fetch(`${node.url}/v1/checkout/${p.id}`)).json()) as CheckoutView;
    const signature = await PAYER.signTypedData(checkoutTypedData(view.authorization!, PAYER.address));
    const paid = await fetch(`${node.url}/v1/checkout/${p.id}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payer: PAYER.address, signature }) });
    expect(paid.status).toBe(200);
    // The wallet payment sits in the payment's forwarder until the flush pays the payout (and the platform its fee).
    expect(view.authorization).toMatchObject({ primaryType: "TransferWithAuthorization", message: { to: view.deposit_address } });
    await g.flusher.tick();
    expect(await balanceOf(view.deposit_address)).toBe(0n);

    const r = await merchant.refunds.create({ paymentId: p.id, amount: 400_000n, reason: "partial" }, { idempotencyKey: "refund-1" });
    expect(r).toMatchObject({ status: "pending", to: PAYER.address, amount: "400000" });
    expect(r.authorization).toMatchObject({ router, value: "400000" });
    const message = { from: NORTHWIND.address, to: router, value: 400_000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: r.authorization!.nonce };
    const sig = await NORTHWIND.signTypedData(receiveAuthorizationTypedData(domain, message));
    const [payer0, payoutTx0] = await Promise.all([balanceOf(PAYER.address), anvil.pub.getTransactionCount({ address: NORTHWIND.address })]);
    const done = await merchant.refunds.submit(r.id, {
      authorization: { ...message, value: "400000", validAfter: "0", validBefore: message.validBefore.toString(), signature: sig },
    });
    expect(done).toMatchObject({ status: "succeeded", method: "authorization" });
    expect(await balanceOf(PAYER.address)).toBe(payer0 + 400_000n);
    expect(await anvil.pub.getTransactionCount({ address: NORTHWIND.address })).toBe(payoutTx0);
    expect((await merchant.refunds.list({ payment_id: p.id })).items.map((x) => x.id)).toEqual([r.id]);
    expect((await merchant.payments.retrieve(p.id))).toMatchObject({ refund_status: "partial", amount_refunded: "400000" });

    // The reconciliation report has the payment with its fee, net and refund, and totals that add up.
    const report = await merchant.reconciliation({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
    const row = report.rows.find((x) => x.payment_id === p.id)!;
    expect(row).toMatchObject({ status: "paid", method: "wallet", amount_paid: "1.000000", fee_total: "0.015000", net_amount: "0.985000", refunded: "0.400000", net_after_refunds: "0.585000" });
    expect(row.refunds.map((f) => f.id)).toEqual([r.id]);
    expect(BigInt(report.totals.base_units.gross) - BigInt(report.totals.base_units.fees)).toBe(BigInt(report.totals.base_units.net));
    await expect(merchant.reconciliation({ from: "2026-10-10", to: "2026-10-01" })).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("screens payers on the merchant deny list", async () => {
    const flagged = privateKeyToAccount(ANVIL_KEYS[8]).address;
    await merchant.screening.deny(flagged, "chargeback fraud");
    expect((await merchant.screening.denyList()).items.map((d) => d.address)).toEqual([flagged]);
    const p = await merchant.payments.create({ amount: USDC });
    const res = await fetch(`${node.url}/v1/checkout/${p.id}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payer: flagged, signature: "0x" + "11".repeat(65) }) });
    expect(res.status).toBe(403);
    expect((await merchant.screening.decisions()).items[0]).toMatchObject({ source: "gateway", rule: "PAYER_DENIED", payer: flagged });
    await merchant.screening.allow(flagged);
  });
});

describe("constructEvent", () => {
  const secret = "whsec_test_secret_for_the_sdk";
  const body = JSON.stringify({ id: "evt_x", type: "payment.paid", created: 1_800_000_000, livemode: false, data: { object: { id: "pay_x" } } });

  it("returns the event for a valid signature and throws on anything else", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signWebhook(secret, body, now);
    expect(await constructEvent(body, header, secret)).toMatchObject({ id: "evt_x", type: "payment.paid" });
    expect(await constructEvent(new TextEncoder().encode(body), header, secret)).toMatchObject({ type: "payment.paid" });
    await expect(constructEvent(body.replace("pay_x", "pay_y"), header, secret)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(constructEvent(body, header, "whsec_other")).rejects.toThrow(/does not match/);
    await expect(constructEvent(body, await signWebhook(secret, body, now - 301), secret)).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await constructEvent(body, await signWebhook(secret, body, now - 301), secret, { toleranceSec: 600 })).toMatchObject({ id: "evt_x" });
    await expect(constructEvent(body, undefined, secret)).rejects.toThrow(/missing Payminto-Signature/);
    await expect(constructEvent(body, header, "")).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("verifies every delivery a real endpoint receives", async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const endpoint = await merchant.webhooks.create({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`, events: ["*"] });
      expect(endpoint.secret).toMatch(/^whsec_/);
      expect((await merchant.webhooks.test(endpoint.id)).status).toBe("succeeded");
      const p = await merchant.payments.create({ amount: 500_000n, method: "deposit" });
      const w = anvil.wallet(ANVIL_KEYS[2]);
      const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [p.deposit_address, BigInt(p.amount_due)] });
      await anvil.pub.waitForTransactionReceipt({ hash });
      await g.watcher.tick();
      await g.webhooks.tick();
      const events = [];
      for (const r of received) events.push(await constructEvent(r.body, r.headers["payminto-signature"] as string, endpoint.secret));
      expect(events.map((e) => e.type)).toEqual(["ping", "payment.created", "payment.paid"]);
      expect(events[2]!.data.object).toMatchObject({ id: p.id, status: "paid", net_amount: p.net_amount, fee_total: p.fee_total });
      const log = await merchant.webhooks.deliveries(endpoint.id);
      expect(log.items.every((d) => d.status === "succeeded")).toBe(true);
      expect((await merchant.webhooks.rotateSecret(endpoint.id)).secret).not.toBe(endpoint.secret);
      await merchant.webhooks.delete(endpoint.id);
    } finally {
      server.close();
    }
  });
});

describe("payExact (plain x402 agent)", () => {
  it("pays a link's exact requirement to its forwarder and returns the PAYMENT-RESPONSE; the flush splits the fee", async () => {
    await g.flusher.tick(); // earlier deposits, so the balances below move by this payment only
    const link = await merchant.links.create({ title: "Exact report", amount: USDC });
    const url = `${node.url}/v1/pay/l/${link.slug}`;
    const tx0 = await anvil.pub.getTransactionCount({ address: X402_AGENT.address });
    const out = await payExact(url, { account: X402_AGENT, maxAmount: USDC, chainId: 31337 });
    expect(out.response.status).toBe(200);
    expect(out.settlement).toMatchObject({ success: true, network: "eip155:31337", status: "paid", paymentId: out.requirement.extra.paymentId, payer: X402_AGENT.address });
    expect(out.settlement.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(((await out.response.json()) as { payment_id: string }).payment_id).toBe(out.settlement.paymentId);
    // The agent sent no transaction: the node relayed its authorization.
    expect(await anvil.pub.getTransactionCount({ address: X402_AGENT.address })).toBe(tx0);
    const forwarder = out.requirement.payTo as Address;
    expect(await balanceOf(forwarder)).toBe(USDC);
    const [payout0, fees0] = await Promise.all([balanceOf(NORTHWIND.address), balanceOf(FEES)]);
    await g.flusher.tick();
    expect(await balanceOf(forwarder)).toBe(0n);
    expect(await balanceOf(NORTHWIND.address)).toBe(payout0 + 985_000n);
    expect(await balanceOf(FEES)).toBe(fees0 + 15_000n);
  });

  it("refuses above maxAmount without signing, and reports a resource that asks for no payment", async () => {
    const link = await merchant.links.create({ title: "Pricey", amount: 5n * USDC });
    const err = await payExact(`${node.url}/v1/pay/l/${link.slug}`, { account: X402_AGENT, maxAmount: USDC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExactPaymentError);
    expect((err as ExactPaymentError).code).toBe("MAX_AMOUNT");
    await expect(payExact(`${node.url}/v1/info`, { account: X402_AGENT, maxAmount: USDC })).rejects.toMatchObject({ code: "NOT_PAYMENT_REQUIRED" });
  });
});

describe("AgentClient paying a fee-carrying link (two vouchers)", () => {
  const owner = () => new OwnerClient({ nodeUrl: node.url, chainId: 31337, hub, account: OWNER, publicClient: anvil.pub, adminToken: ADMIN });
  const mandate = async (payees: Address[], perCallCap: string, label: string) => {
    const policy = { perCallCap, dailyCap: (10n * USDC).toString(), maxCallsPerMinute: 100, purpose: label };
    const m = await owner().createMandate({ agent: MANDATE_AGENT.address, token, totalCap: 10n * USDC, validForSeconds: 3600, payees, policy });
    await owner().submit({ ...m, policy, payees, label });
    const agent = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: MANDATE_AGENT, mandateId: m.mandateId });
    const denied: DeniedEvent[] = [];
    const errors: Error[] = [];
    agent.on("denied", (d) => denied.push(d));
    agent.on("error", (e) => errors.push(e));
    return { agent, denied, errors, mandateId: m.mandateId };
  };

  it("signs one voucher per payee atomically, verifies both receipts, and the payment is paid when the batch confirms", async () => {
    const link = await merchant.links.create({ title: "Voucher report", amount: USDC });
    const { agent, denied, errors } = await mandate([NORTHWIND.address, FEES], USDC.toString(), "pays Northwind and its platform fee");
    await agent.ensureAllowance(anvil.wallet(ANVIL_KEYS[4]), maxUint256, { token });
    const res = await agent.fetch(`${node.url}/v1/pay/l/${link.slug}`);
    expect(res.status).toBe(200);
    expect(denied).toEqual([]);
    expect(errors).toEqual([]);
    const response = decodeHeader<{ paymentId: string; status: string }>(res.headers.get("PAYMENT-RESPONSE"))!;
    expect(response.status).toBe("processing");
    expect(agent.receipts.all().map((r) => [r.payee, r.amount])).toEqual([[NORTHWIND.address, "985000"], [FEES, "15000"]]);
    const [payout0, fees0] = await Promise.all([balanceOf(NORTHWIND.address), balanceOf(FEES)]);
    agent.startCosignLoop(100);
    const settled = await fetch(`${node.url}/v1/settlements`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(settled.status).toBe(200);
    agent.close();
    expect(await merchant.payments.retrieve(response.paymentId)).toMatchObject({ status: "paid", method: "voucher", amount_paid: "1000000", payer: MANDATE_AGENT.address });
    expect(await balanceOf(NORTHWIND.address)).toBe(payout0 + 985_000n);
    expect(await balanceOf(FEES)).toBe(fees0 + 15_000n);
  });

  it("re-signs and retries a pair the node denied as stale, even when another process moved both positions past it", async () => {
    const link = await merchant.links.create({ title: "Stale pair report", amount: USDC });
    const policy = { perCallCap: USDC.toString(), dailyCap: (10n * USDC).toString(), maxCallsPerMinute: 100, purpose: "stale pair" };
    const payees = [NORTHWIND.address, FEES];
    const m = await owner().createMandate({ agent: MANDATE_AGENT.address, token, totalCap: 10n * USDC, validForSeconds: 3600, payees, policy });
    await owner().submit({ ...m, policy, payees, label: "stale pair" });
    // Two processes of one agent share one receipt store (as AgentClient requires).
    const receipts = new MemoryReceiptStore();
    const other = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: MANDATE_AGENT, mandateId: m.mandateId, receipts });
    let raced = false;
    const racingFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!raced && headers.get("PAYMENT-SIGNATURE") && String(input).includes(`/v1/pay/l/${link.slug}`)) {
        raced = true;
        // The other process pays first and moves both positions to exactly what this pair signed; the node then denies
        // this whole pair as stale (it books a pair atomically, so nothing of it was accepted).
        expect((await other.fetch(`${node.url}/v1/pay/l/${link.slug}`)).status).toBe(200);
        return new Response(JSON.stringify({ error: { code: "STALE_CUMULATIVE", message: "cumulative is stale" } }), { status: 402, headers: { "content-type": "application/json" } });
      }
      return fetch(input, init);
    };
    const agent = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: MANDATE_AGENT, mandateId: m.mandateId, receipts, fetch: racingFetch, sleep: async () => {} });
    const denied: DeniedEvent[] = [];
    agent.on("denied", (d) => denied.push(d));
    const res = await agent.fetch(`${node.url}/v1/pay/l/${link.slug}`);
    expect(raced).toBe(true);
    expect(denied).toEqual([]);
    expect(res.status).toBe(200);
    // Both payments were made: each payee's position is two vouchers deep.
    expect(receipts.signedPosition(m.mandateId, NORTHWIND.address)).toBe(2n * 985_000n);
    expect(receipts.signedPosition(m.mandateId, FEES)).toBe(2n * 15_000n);
    agent.close();
    other.close();
  });

  it("holds the combined price against the per-call cap and needs both payees on the allowlist, signing nothing otherwise", async () => {
    const link = await merchant.links.create({ title: "Capped report", amount: USDC });
    // Each voucher alone (985000 and 15000) is under the cap; together they are not.
    const capped = await mandate([NORTHWIND.address, FEES], "990000", "capped");
    const r1 = await capped.agent.fetch(`${node.url}/v1/pay/l/${link.slug}`);
    expect(r1.status).toBe(402);
    expect(((await r1.json()) as { error: { code: string; details: { enforcedBy: string } } }).error).toMatchObject({ code: "PER_CALL_CAP", details: { enforcedBy: "agent" } });
    expect(capped.denied.map((d) => [d.code, d.amount])).toEqual([["PER_CALL_CAP", USDC]]);
    for (const payee of [NORTHWIND.address, FEES]) expect(capped.agent.receipts.signedPosition(capped.mandateId, payee)).toBe(0n);

    const merchantOnly = await mandate([NORTHWIND.address], USDC.toString(), "merchant only");
    const r2 = await merchantOnly.agent.fetch(`${node.url}/v1/pay/l/${link.slug}`);
    expect(((await r2.json()) as { error: { code: string; details: { payee: string } } }).error).toMatchObject({ code: "PAYEE_NOT_ALLOWED", details: { payee: FEES } });
    for (const payee of [NORTHWIND.address, FEES]) expect(merchantOnly.agent.receipts.signedPosition(merchantOnly.mandateId, payee)).toBe(0n);
    // Nothing reached the node: no voucher payment was created for the link.
    expect((await merchant.payments.list({ link_id: link.id })).items.filter((p) => p.method === "voucher")).toEqual([]);
    capped.agent.close();
    merchantOnly.agent.close();
  });
});
