/**
 * The SDK's gateway side against the real node gateway on NEAR: the Payminto node in-process on a FakeChain hub and a
 * temp `*.test.db`, with its workers off (each tick is driven here).
 * Covers GatewayClient (operator and merchant), NEP-413 payout proofs, a wallet checkout paid through the hub, refunds
 * the merchant sends itself, constructEvent on real webhook deliveries, and AgentClient paying a fee-carrying link with
 * two vouchers under its policy guard.
 * The node is imported by path (it depends on this package, so it cannot be a dependency of it).
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { refundTransferTx, signWebhook, verifyPayoutProofSignature, type Policy } from "@payminto/protocol";
import { startNode, type ClearingNode } from "../../../apps/node/src/server.ts";
import { silentLogger } from "../../../apps/node/src/logger.ts";
import type { GatewayConfig } from "../../../apps/node/src/config.ts";
import type { Gateway } from "../../../apps/node/src/gateway/index.ts";
import { FakeNearRpc, OWNER_A, openBudget, payoutAccount, startFakeChain, tempDir, testConfig, testKey } from "../../../apps/node/test/helpers.ts";
import {
  AgentClient,
  constructEvent,
  GatewayClient,
  MemoryReceiptStore,
  NodeApiError,
  payoutSignerFromKey,
  signPayoutProof,
  WebhookSignatureError,
  type DeniedEvent,
  type PayoutSigner,
} from "../src/index.ts";

const ADMIN = "sdk-gateway-admin-token";
const USDC = 1_000_000n;
const SEED = payoutAccount("seed-shop.testnet", 80);
const NORTHWIND = payoutAccount("northwind.testnet", 81);
const NORTHWIND_NEW = payoutAccount("northwind-treasury.testnet", 82);
const STRANGER = payoutAccount("stranger.testnet", 83);
const SHOPPER = "shopper.testnet";
const BLOCKED = "blocked-shopper.testnet";
const FEES = "fees.testnet";

const rpc = new FakeNearRpc().addKey(NORTHWIND.account, NORTHWIND.key.publicKey).addKey(NORTHWIND_NEW.account, NORTHWIND_NEW.key.publicKey);
const tmp = tempDir("payminto-sdk-gateway-");
let chain: FakeChain;
let node: ClearingNode;
let g: Gateway;
let operator: GatewayClient;
let merchant: GatewayClient;
let merchantId: string;
let payout = NORTHWIND;
let txSeq = 0;

const signer = (a: typeof NORTHWIND): PayoutSigner => payoutSignerFromKey(a.account, a.key);
const txHash = () => `sdk-refund-tx-${++txSeq}`;

/** A shopper pays a checkout from a NEAR wallet: the wallet sends the transaction the checkout hands it, through the hub. */
async function payFromWallet(paymentId: string, shopper = SHOPPER): Promise<void> {
  const view = await merchant.checkout.retrieve(paymentId);
  const args = view.wallet!.transaction.actions[0]!.params.args as { amount: string; msg: string };
  expect(chain.ftTransferCall(shopper, BigInt(args.amount), args.msg).refunded).toBe(0n);
  await merchant.request("POST", `/v1/checkout/${paymentId}/wallet`, { auth: false, body: { tx_hash: `wallet-tx-${paymentId.slice(4, 16)}` } });
}

beforeAll(async () => {
  chain = startFakeChain([OWNER_A, SHOPPER, BLOCKED]);
  // Payouts need token registration (NEP-145); so does the platform fee account.
  for (const a of [SEED.account, NORTHWIND.account, NORTHWIND_NEW.account, FEES]) chain.register(a);
  const gateway: GatewayConfig = { seedPayout: SEED.account, platformName: "SDK Platform", feeRecipient: FEES, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000 };
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, gateway, publicUrl: "http://node.test" }), { chain, nearRpc: rpc, logger: silentLogger, port: 0, workers: false });
  chain.setCheckoutKey(node.services.chain.nodeKey);
  g = node.services.gateway!;
  operator = new GatewayClient({ nodeUrl: node.url, apiKey: ADMIN });
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("GatewayClient (operator)", () => {
  it("reads the scope a payout proof must name, and signs a NEP-413 proof the protocol verifies", async () => {
    const scope = await operator.payoutScope();
    expect(scope).toEqual({ network: chain.network, hub: chain.hub });
    const proof = await signPayoutProof(signer(NORTHWIND), "new", scope);
    expect(proof).toMatchObject({ payout: NORTHWIND.account, public_key: NORTHWIND.key.publicKey, timestamp: expect.any(Number) });
    expect(proof.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(verifyPayoutProofSignature(proof, "new", scope)).toBe(true);
    // Bound to the merchant id and to this node: neither another id nor another hub verifies.
    expect(verifyPayoutProofSignature(proof, "mer_other", scope)).toBe(false);
    expect(verifyPayoutProofSignature(proof, "new", { ...scope, hub: "other-hub.testnet" })).toBe(false);
  });

  it("creates a fee plan, a merchant with a payout proof, its method settings and an API key", async () => {
    const scope = await operator.payoutScope();
    const plan = await operator.feePlans.create({ name: "Data plan", platform_fee_bps: 100 });
    expect(plan).toMatchObject({ name: "Data plan", platform_fee_bps: 100, platform_fee_fixed: "0" });
    expect((await operator.feePlans.list()).items.map((p) => p.id)).toContain(plan.id);
    expect((await operator.feePlans.update(plan.id, { name: "One percent" })).name).toBe("One percent");

    const m = await operator.merchants.create({ name: "Northwind Data", payout: await signPayoutProof(signer(NORTHWIND), "new", scope) });
    expect(m).toMatchObject({ name: "Northwind Data", payout: NORTHWIND.account, network: chain.network, hub: chain.hub, token: chain.token, checkout_key: node.services.chain.nodeKey, fee_plan: { id: "fp_zero" } });
    expect(m.payout_history[0]).toMatchObject({ new_payout: NORTHWIND.account, proven: true, public_key: NORTHWIND.key.publicKey });
    expect(m.methods.map((x) => x.method).sort()).toEqual(["voucher", "wallet"]);
    merchantId = m.id;

    // A key that is not a full-access key of the account, and a proof by the right key for the wrong account.
    await expect(operator.merchants.create({ name: "Stranger", payout: await signPayoutProof(signer(STRANGER), "new", scope) })).rejects.toMatchObject({ name: "NodeApiError", code: "PAYOUT_PROOF_INVALID", status: 400 });
    const forged = { ...(await signPayoutProof(signer(STRANGER), "new", scope)), payout: NORTHWIND.account };
    await expect(operator.merchants.create({ name: "Forged", payout: forged })).rejects.toMatchObject({ code: "PAYOUT_PROOF_INVALID" });
    // A proof for one merchant does not change the payout of another.
    await expect(operator.merchants.changePayout(merchantId, await signPayoutProof(signer(NORTHWIND_NEW), "mer_other", scope))).rejects.toMatchObject({ code: "PAYOUT_PROOF_INVALID" });

    const methods = await operator.merchants.setMethods(merchantId, [{ method: "voucher", enabled: true, min_amount: 1_000n }]);
    expect(methods.items.find((x) => x.method === "voucher")).toMatchObject({ enabled: true, min_amount: "1000" });
    expect((await operator.merchants.methods(merchantId)).items).toHaveLength(2);
    expect((await operator.merchants.list()).items.map((x) => x.id)).toContain(merchantId);
    expect(await operator.merchants.retrieve(merchantId)).toMatchObject({ id: merchantId, stats: { payments: 0, volume: "0" } });

    // Two merchants now: the admin token needs Merchant-Id, which forMerchant sends.
    await expect(operator.merchant.retrieve()).rejects.toMatchObject({ code: "MERCHANT_REQUIRED" });
    const key = await operator.forMerchant(merchantId).apiKeys.create("server");
    expect(key.secret).toMatch(/^sk_test_/);
    expect((await operator.forMerchant(merchantId).apiKeys.list()).items.map((k) => k.id)).toContain(key.id);
    merchant = new GatewayClient({ nodeUrl: node.url, apiKey: key.secret });
    expect(await merchant.merchant.retrieve()).toMatchObject({ id: merchantId, name: "Northwind Data", payout: NORTHWIND.account });
    expect((await merchant.merchant.update({ support_email: "help@northwind.example" })).support_email).toBe("help@northwind.example");
    // A merchant key cannot reach operator routes.
    const refused = await merchant.merchants.list().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NodeApiError);
    expect([401, 403]).toContain((refused as NodeApiError).status);
    expect(await operator.platform.retrieve()).toMatchObject({ name: "SDK Platform", fee_recipient: FEES });
  });

  it("changes a payout with a proof by the new account, bound to the merchant id", async () => {
    const scope = await operator.payoutScope();
    const changed = await operator.merchants.changePayout(merchantId, await signPayoutProof(signer(NORTHWIND_NEW), merchantId, scope));
    expect(changed.payout).toBe(NORTHWIND_NEW.account);
    expect(changed.payout_history.map((h) => [h.old_payout, h.new_payout, h.proven])).toEqual([
      [NORTHWIND.account, NORTHWIND_NEW.account, true],
      [null, NORTHWIND.account, true],
    ]);
    payout = NORTHWIND_NEW;
  });
});

describe("GatewayClient (merchant)", () => {
  let paidId = "";

  it("creates payments under an Idempotency-Key, lists, retrieves and cancels them", async () => {
    const a = await merchant.payments.create({ amount: USDC, reference: "ord-1", method: "wallet" }, { idempotencyKey: "ord-1" });
    expect(a).toMatchObject({
      status: "open",
      amount: "1000000",
      surcharge: "0",
      amount_due: "1000000",
      fee_total: "0",
      net_amount: "1000000",
      fee_recipient: null,
      method: "wallet",
      network: chain.network,
      hub: chain.hub,
      token: chain.token,
      payout: payout.account,
      checkout_id: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(a.checkout_url).toBe(`http://localhost:3000/pay/${a.id}`);
    const replay = await merchant.payments.create({ amount: USDC, reference: "ord-1", method: "wallet" }, { idempotencyKey: "ord-1" });
    expect(replay.id).toBe(a.id);
    const mismatch = await merchant.payments.create({ amount: 2n * USDC, reference: "ord-1" }, { idempotencyKey: "ord-1" }).catch((e: unknown) => e);
    expect(mismatch).toBeInstanceOf(NodeApiError);
    expect((mismatch as NodeApiError).code).toBe("IDEMPOTENCY_MISMATCH");
    // Only the methods the node has on NEAR.
    await expect(merchant.payments.create({ amount: USDC, method: "deposit" as never })).rejects.toMatchObject({ status: 400 });

    const v = await merchant.payments.create({ amount: 250_000n, method: "voucher", description: "for an agent" });
    const detail = await merchant.payments.retrieve(a.id);
    expect(detail).toMatchObject({ id: a.id, credits: [], refunds: [] });
    expect(detail.events.map((e) => e.type)).toEqual(["payment.created"]);
    const list = await merchant.payments.list({ status: ["open"], limit: 10 });
    expect(list.items.map((p) => p.id)).toEqual(expect.arrayContaining([a.id, v.id]));
    expect(list.counts.open).toBeGreaterThanOrEqual(2);
    expect((await merchant.payments.cancel(v.id)).status).toBe("canceled");
    await expect(merchant.payments.retrieve("pay_aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({ status: 404 });
    paidId = a.id;
  });

  it("manages links, and finds listed ones in the public directory", async () => {
    const link = await merchant.links.create({ title: "Market dataset", amount: 2n * USDC }, { idempotencyKey: "link-1" });
    expect(link).toMatchObject({ title: "Market dataset", amount: "2000000", listed: true, active: true, url: `http://localhost:3000/l/${link.slug}` });
    expect((await merchant.links.list()).items.map((l) => l.id)).toContain(link.id);
    expect((await merchant.links.update(link.id, { description: "Daily OHLC" })).description).toBe("Daily OHLC");
    expect((await merchant.links.retrieve(link.id)).description).toBe("Daily OHLC");
    const dir = await new GatewayClient({ nodeUrl: node.url, apiKey: "unused" }).directory();
    expect(dir.node).toEqual({ url: "http://node.test", network: chain.network, hub: chain.hub, checkout_base_url: "http://localhost:3000" });
    expect(dir.services.find((s) => s.id === link.id)).toMatchObject({
      type: "link",
      title: "Market dataset",
      merchant: { id: merchantId, name: "Northwind Data" },
      network: chain.network,
      token: { address: chain.token, symbol: "USDC", decimals: 6 },
      schemes: ["payminto-voucher"],
      price: { amount: "2000000" },
      pay_url: link.url,
    });
    await merchant.links.update(link.id, { listed: false });
    expect((await operator.directory()).services.some((s) => s.id === link.id)).toBe(false);
  });

  it("shows the checkout a NEAR wallet pays, and the proof read from the hub once it is paid", async () => {
    const view = await merchant.checkout.retrieve(paidId);
    expect(view).toMatchObject({ id: paidId, status: "open", methods: ["wallet"], amount_remaining: "1000000", network: chain.network, hub: chain.hub });
    expect(view.wallet).toMatchObject({ checkout_key: node.services.chain.nodeKey, terms: { merchant: payout.account, amount: "1000000" }, transaction: { receiverId: chain.token } });
    await expect(merchant.checkout.proof(paidId)).rejects.toMatchObject({ status: 409, code: "NOT_PAID" });
    await payFromWallet(paidId);
    expect(await merchant.payments.retrieve(paidId)).toMatchObject({ status: "paid", amount_paid: "1000000", payer: SHOPPER, method: "wallet", credits: [{ method: "wallet", payer: SHOPPER, status: "confirmed" }] });
    const proof = await merchant.checkout.proof(paidId);
    expect(proof).toMatchObject({ payment_id: paidId, status: "paid", network: chain.network, hub: chain.hub, payout: payout.account });
    expect(proof.credits).toEqual([expect.objectContaining({ method: "wallet", amount: "1000000", payer: SHOPPER, verified: true, hub_record: expect.objectContaining({ merchant: payout.account, amount: "1000000" }) })]);
    expect(await merchant.merchant.overview()).toMatchObject({ volume: "1000000", counts: { paid: 1 } });
  });

  it("refunds from the merchant's own payout account: the refund carries the transfer, the node checks the transaction", async () => {
    const r = await merchant.refunds.create({ paymentId: paidId, amount: 400_000n, reason: "partial" }, { idempotencyKey: "refund-1" });
    expect(r).toMatchObject({ status: "pending", to: SHOPPER, amount: "400000", approval: "not_required", method: null, tx_hash: null });
    // What the payout account sends from its own wallet: a plain ft_transfer to the payer. The node holds no key for it.
    expect(r.transfer).toEqual(refundTransferTx(chain.token, SHOPPER, 400_000n, r.id));
    expect((await merchant.refunds.create({ paymentId: paidId, amount: 400_000n, reason: "partial" }, { idempotencyKey: "refund-1" })).id).toBe(r.id);

    // A transaction that pays the wrong amount fails the refund; it is not taken on the merchant's word.
    const wrong = txHash();
    rpc.txs.set(wrong, { status: "final", signer: payout.account, transfers: [{ token: chain.token, receiverId: SHOPPER, amount: 399_999n }] });
    expect(await merchant.refunds.submit(r.id, { txHash: wrong })).toMatchObject({ status: "failed", failure_reason: expect.stringMatching(/no ft_transfer of 400000/) });

    const again = await merchant.refunds.create({ paymentId: paidId, amount: 400_000n, reason: "partial, second try" });
    const good = txHash();
    rpc.txs.set(good, { status: "pending" });
    expect(await merchant.refunds.submit(again.id, { txHash: good })).toMatchObject({ status: "pending", tx_hash: good, method: "transfer" });
    rpc.txs.set(good, { status: "final", signer: payout.account, transfers: [{ token: chain.token, receiverId: SHOPPER, amount: 400_000n }] });
    await g.refunds.tick();
    expect(await merchant.refunds.retrieve(again.id)).toMatchObject({ status: "succeeded", verification: "transfer_checked", transfer: null });
    expect((await merchant.refunds.list({ payment_id: paidId })).items.map((x) => [x.id, x.status])).toEqual(expect.arrayContaining([[r.id, "failed"], [again.id, "succeeded"]]));
    expect(await merchant.payments.retrieve(paidId)).toMatchObject({ refund_status: "partial", amount_refunded: "400000" });
    // One transaction proves one refund only.
    const third = await merchant.refunds.create({ paymentId: paidId, amount: 1n });
    await expect(merchant.refunds.submit(third.id, { txHash: good })).rejects.toMatchObject({ code: "TX_ALREADY_USED" });
    expect((await merchant.refunds.cancel(third.id)).status).toBe("canceled");
    // The EVM-era submit shape is gone: only a transaction hash is taken.
    const fourth = await merchant.refunds.create({ paymentId: paidId, amount: 1n });
    await expect(merchant.refunds.submit(fourth.id, { authorization: {} } as never)).rejects.toMatchObject({ status: 400 });
    await merchant.refunds.cancel(fourth.id);
  });

  it("holds a refund for an Admin when approval is asked for: no transfer until it is approved", async () => {
    const asked = await merchant.refunds.create({ paymentId: paidId, amount: 100_000n, reason: "goodwill", requestApproval: true });
    expect(asked).toMatchObject({ status: "pending", approval: "requested", transfer: null });
    await expect(merchant.refunds.submit(asked.id, { txHash: txHash() })).rejects.toMatchObject({ code: "REFUND_APPROVAL_REQUIRED" });
    // An API key cannot approve its own request; the operator (or an Admin in the dashboard) can.
    await expect(merchant.refunds.approve(asked.id)).rejects.toMatchObject({ status: 403 });
    const approved = await operator.refunds.approve(asked.id);
    expect(approved).toMatchObject({ approval: "approved" });
    expect(approved.transfer).toEqual(refundTransferTx(chain.token, SHOPPER, 100_000n, asked.id));
    await merchant.refunds.cancel(asked.id);
  });

  it("reports the payment with its refund and NEAR transaction in the reconciliation report", async () => {
    const report = await merchant.reconciliation({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
    expect(report).toMatchObject({ object: "reconciliation_report", network: chain.network, token: { address: chain.token, symbol: "USDC", decimals: 6 } });
    const row = report.rows.find((x) => x.payment_id === paidId)!;
    expect(row).toMatchObject({ status: "paid", method: "wallet", amount_paid: "1.000000", fee_total: "0.000000", net_amount: "1.000000", refunded: "0.400000", net_after_refunds: "0.600000", payer: SHOPPER });
    expect(row.transactions).toEqual([expect.objectContaining({ method: "wallet", tx_hash: expect.stringMatching(/^wallet-tx-/) })]);
    expect(BigInt(report.totals.base_units.gross) - BigInt(report.totals.base_units.fees)).toBe(BigInt(report.totals.base_units.net));
    await expect(merchant.reconciliation({ from: "2026-10-10", to: "2026-10-01" })).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("blocks payer accounts on the merchant deny list and lists what was flagged", async () => {
    expect(await merchant.screening.deny(BLOCKED, "chargeback fraud")).toMatchObject({ address: BLOCKED, reason: "chargeback fraud" });
    expect((await merchant.screening.denyList()).items.map((d) => d.address)).toEqual([BLOCKED]);
    // The hub takes a wallet payment before the payer is known, so it is recorded for the business to refund.
    const p = await merchant.payments.create({ amount: 50_000n, method: "wallet" });
    await payFromWallet(p.id, BLOCKED);
    expect((await merchant.screening.decisions()).items[0]).toMatchObject({ source: "gateway", rule: "PAYER_DENIED", stage: "wallet", payer: BLOCKED, payment_id: p.id });
    expect(await merchant.screening.allow(BLOCKED)).toEqual({ address: BLOCKED, deleted: true });
    expect((await merchant.screening.denyList()).items).toEqual([]);
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
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const endpoint = await merchant.webhooks.create({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`, events: ["*"] });
      expect(endpoint.secret).toMatch(/^whsec_/);
      expect((await merchant.webhooks.revealSecret(endpoint.id)).secret).toBe(endpoint.secret);
      expect((await merchant.webhooks.test(endpoint.id)).status).toBe("succeeded");
      const p = await merchant.payments.create({ amount: 500_000n, method: "wallet" });
      await payFromWallet(p.id);
      await g.webhooks.tick();
      const events = [];
      for (const r of received) events.push(await constructEvent(r.body, r.headers["payminto-signature"] as string, endpoint.secret));
      expect(events.map((e) => e.type)).toEqual(["ping", "payment.created", "payment.paid"]);
      expect(events[2]!.data.object).toMatchObject({ id: p.id, status: "paid", payer: SHOPPER, network: chain.network, net_amount: p.net_amount });
      // A body that was changed on the way, or signed with another secret, never parses as an event.
      await expect(constructEvent(received[2]!.body.replace(SHOPPER, "thief.testnet"), received[2]!.headers["payminto-signature"] as string, endpoint.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
      const log = await merchant.webhooks.deliveries(endpoint.id);
      expect(log.items).toHaveLength(3);
      expect(log.items.every((d) => d.status === "succeeded")).toBe(true);
      expect((await merchant.webhooks.rotateSecret(endpoint.id)).secret).not.toBe(endpoint.secret);
      expect((await merchant.webhooks.update(endpoint.id, { active: false })).active).toBe(false);
      expect(await merchant.webhooks.delete(endpoint.id)).toMatchObject({ id: endpoint.id, deleted: true });
      expect((await merchant.webhooks.list()).items).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe("AgentClient paying a fee-carrying link (two vouchers)", () => {
  const AGENT = testKey(90);
  const POLICY: Policy = { perCallCap: USDC.toString(), dailyCap: (20n * USDC).toString(), maxCallsPerMinute: 0, purpose: "buys Northwind reports" };

  const budget = async (payees: string[], policy: Policy = POLICY) => {
    const b = await openBudget(chain, node.url, ADMIN, OWNER_A, AGENT, { escrow: 20n * USDC, cap: 50n * USDC, payees, policy });
    const agent = new AgentClient({ nodeUrl: node.url, network: chain.network, hub: chain.hub, keypair: AGENT, budgetId: b.id, receipts: new MemoryReceiptStore(), sleep: async () => {} });
    const denied: DeniedEvent[] = [];
    const errors: Error[] = [];
    agent.on("denied", (d) => denied.push(d));
    agent.on("error", (e) => errors.push(e));
    return { agent, denied, errors, id: b.id };
  };

  beforeAll(async () => {
    // One percent to the platform: a link now costs the agent two vouchers, the merchant's net and the fee.
    const plan = (await operator.feePlans.list()).items.find((p) => p.name === "One percent")!;
    await operator.merchants.update(merchantId, { fee_plan_id: plan.id });
  });

  it("signs one voucher per payee at once, verifies both receipts, and the payment is paid when the batch settles", async () => {
    const link = await merchant.links.create({ title: "Voucher report", amount: USDC });
    const { agent, denied, errors } = await budget([payout.account, FEES]);
    const { response, payment } = await agent.pay(`${node.url}/v1/pay/l/${link.slug}`);
    expect(response.status).toBe(200);
    expect(denied).toEqual([]);
    expect(errors).toEqual([]);
    expect(payment).toMatchObject({ status: "paid", paid: USDC, unverified: 0n, refusal: null });
    expect(payment.vouchers.map((v) => [v.payee, v.amount, v.state])).toEqual([
      [payout.account, 990_000n, "paid"],
      [FEES, 10_000n, "paid"],
    ]);
    expect(agent.receipts.all().map((r) => [r.payee, r.amount])).toEqual([[payout.account, "990000"], [FEES, "10000"]]);
    const body = (await response.json()) as { payment_id: string; status: string; amount_due: string };
    expect(body).toMatchObject({ payment_id: expect.stringMatching(/^pay_/), status: "processing", amount_due: "1000000" });
    expect(await merchant.payments.retrieve(body.payment_id)).toMatchObject({ status: "processing", method: "voucher", platform_fee: "10000", net_amount: "990000", fee_recipient: FEES, link_id: link.id });

    const settled = await fetch(`${node.url}/v1/settlements`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(settled.status).toBe(200);
    expect(await merchant.payments.retrieve(body.payment_id)).toMatchObject({ status: "paid", method: "voucher", amount_paid: "1000000", payer: OWNER_A });
    const proof = await merchant.checkout.proof(body.payment_id);
    expect(proof.credits.map((c) => [c.method, c.amount, c.verified])).toEqual([["voucher", "990000", true], ["voucher", "10000", true]]);
    expect(await operator.platform.fees()).toMatchObject({ fee_recipient: FEES, totals: { platform_fee: "10000", fee_total: "10000" } });
  });

  it("re-signs a split the node refused as stale after another process of the same agent moved both positions", async () => {
    const link = await merchant.links.create({ title: "Stale pair report", amount: USDC });
    const b = await openBudget(chain, node.url, ADMIN, OWNER_A, AGENT, { escrow: 20n * USDC, cap: 50n * USDC, payees: [payout.account, FEES], policy: POLICY });
    // Two processes of one agent share one receipt store (as AgentClient requires).
    const receipts = new MemoryReceiptStore();
    const common = { nodeUrl: node.url, network: chain.network, hub: chain.hub, keypair: AGENT, budgetId: b.id, receipts, sleep: async () => {} };
    const other = new AgentClient(common);
    const url = `${node.url}/v1/pay/l/${link.slug}`;
    let raced = false;
    const racingFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!raced && headers.get("PAYMENT-SIGNATURE") && String(input).startsWith(url)) {
        raced = true;
        // The other process pays first (another request for the same link) and moves both positions to exactly what
        // this pair signed. The node books a split all or nothing, so it refuses this whole pair as stale.
        expect((await other.pay(`${url}?buyer=other`)).payment.status).toBe("paid");
      }
      return fetch(input, init);
    };
    const agent = new AgentClient({ ...common, fetch: racingFetch });
    const denied: DeniedEvent[] = [];
    agent.on("denied", (d) => denied.push(d));
    const { response, payment } = await agent.pay(`${url}?buyer=agent`);
    expect(raced).toBe(true);
    expect(denied).toEqual([]);
    expect(response.status).toBe(200);
    // The first pair is void (the node passed it over), the second is paid: one payment, not two.
    expect(payment).toMatchObject({ status: "paid", paid: USDC, unverified: 0n });
    expect(payment.vouchers.map((v) => [v.payee, v.cumulative, v.state])).toEqual([
      [payout.account, 990_000n, "void"],
      [FEES, 10_000n, "void"],
      [payout.account, 1_980_000n, "paid"],
      [FEES, 20_000n, "paid"],
    ]);
    expect(receipts.signedPosition(b.id, payout.account)).toBe(1_980_000n);
    expect(receipts.signedPosition(b.id, FEES)).toBe(20_000n);
  });

  it("holds the combined price against the per-call cap and needs both payees on the allowlist, signing nothing otherwise", async () => {
    const link = await merchant.links.create({ title: "Capped report", amount: USDC });
    // Each voucher alone (990000 and 10000) is under the cap; together they are not.
    const capped = await budget([payout.account, FEES], { ...POLICY, perCallCap: "995000" });
    const r1 = await capped.agent.pay(`${node.url}/v1/pay/l/${link.slug}`);
    expect(r1.response.status).toBe(402);
    expect(r1.payment).toMatchObject({ status: "none", vouchers: [], refusal: { source: "agent", code: "PER_CALL_CAP", details: { enforcedBy: "agent" } } });
    expect(capped.denied.map((d) => [d.code, d.amount])).toEqual([["PER_CALL_CAP", USDC]]);
    for (const payee of [payout.account, FEES]) expect(capped.agent.receipts.signedPosition(capped.id, payee)).toBe(0n);

    const merchantOnly = await budget([payout.account]);
    const r2 = await merchantOnly.agent.pay(`${node.url}/v1/pay/l/${link.slug}`);
    expect(r2.payment.refusal).toMatchObject({ source: "agent", code: "PAYEE_NOT_ALLOWED", details: { payee: FEES } });
    for (const payee of [payout.account, FEES]) expect(merchantOnly.agent.receipts.signedPosition(merchantOnly.id, payee)).toBe(0n);
    // Nothing reached the node: no voucher payment was taken for the link.
    expect((await merchant.payments.list({ link_id: link.id })).items.filter((p) => p.amount_paid !== "0" || p.status === "processing")).toEqual([]);
  });
});
