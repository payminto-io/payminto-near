/**
 * Gateway end to end: anvil with ClearingHub, MockStablecoin (EIP-3009), DepositFactory and PaymentRouter, the node
 * in-process on a temp SQLite file with workers off (each worker tick is driven by the test). Covers API keys and
 * idempotency, public view redaction, the wallet relay through the router (and an authorization someone else submitted),
 * deposit to a forwarder then watcher credit then flush, x402 exact and voucher payments, refunds both ways, signed
 * webhooks to a real receiver, screening, order and proof, the directory, payout change proofs and config guards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { erc20Abi, keccak256, maxUint256, toBytes, toHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  checkoutTypedData,
  decodeHeader,
  depositFactoryAbi,
  depositFactoryBytecode,
  eip3009Abi,
  encodeHeader,
  metadataHash,
  networkFor,
  payoutChangeMessage,
  paymentRouterAbi,
  paymentRouterBytecode,
  receiveAuthorizationTypedData,
  transferAuthorizationTypedData,
  verifyWebhook,
  voucherTypedData,
  type CheckoutView,
  type TokenDomain,
} from "@payminto/protocol";
import { AgentClient, OwnerClient } from "@payminto/sdk";
import { startNode, type ClearingNode } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import { ConfigError, loadConfig, type GatewayConfig } from "../src/config.ts";
import type { Gateway } from "../src/gateway/index.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const USDC = 1_000_000n;
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const PAYER = privateKeyToAccount(ANVIL_KEYS[2]);
const PAYER_2 = privateKeyToAccount(ANVIL_KEYS[3]);
const AGENT = privateKeyToAccount(ANVIL_KEYS[4]);
const PAYOUT_B = privateKeyToAccount(ANVIL_KEYS[5]);
const PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]);
const FEES = privateKeyToAccount(ANVIL_KEYS[7]).address;
const THIRD_PARTY = ANVIL_KEYS[8];

let anvil: Anvil;
let node: ClearingNode;
let g: Gateway;
let hub: Address;
let token: Address;
let router: Address;
let domain: TokenDomain;
const tmp = tempDir("payminto-gateway-");

type Auth = "admin" | "none" | string;
async function api<T = any>(method: string, path: string, body?: unknown, auth: Auth = "admin", headers: Record<string, string> = {}) {
  const res = await fetch(`${node.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth === "none" ? {} : { authorization: `Bearer ${auth === "admin" ? ADMIN : auth}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T, text, headers: res.headers };
}

/** What payout proofs on this node are bound to. */
const scope = () => ({ chainId: 31337, hub });
const balanceOf = (who: Address) => anvil.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const now = () => BigInt(Math.floor(Date.now() / 1000));
const randomNonce = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

async function sendToken(key: Hex, to: Address, amount: bigint): Promise<Hex> {
  const w = anvil.wallet(key);
  const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await anvil.pub.waitForTransactionReceipt({ hash });
  return hash;
}

async function signCheckout(view: CheckoutView, account = PAYER) {
  return account.signTypedData(checkoutTypedData(view.authorization!, account.address));
}

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  const factory = await anvil.deploy(depositFactoryAbi as Abi, depositFactoryBytecode);
  router = await anvil.deploy(paymentRouterAbi as Abi, paymentRouterBytecode);
  const gateway: GatewayConfig = {
    seedPayout: PAYOUT.address,
    platformName: "Acme Store",
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
  for (const p of [PAYER, PAYER_2, AGENT]) await mint(anvil, token, p.address, 100n * USDC);
}, 120_000);

afterAll(async () => {
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
});

describe("gateway", () => {
  let secret = "";
  let keyId = "";

  it("seeds the platform and the default merchant from GATEWAY_PAYOUT_ADDRESS", async () => {
    const m = await api("GET", "/v1/merchant");
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ payout: PAYOUT.address, name: "Acme Store", status: "active", payment_router: router, chain_id: 31337, livemode: false });
    expect(m.json.fee_plan).toMatchObject({ name: "Standard", platform_fee_bps: 50 });
    expect(m.json.methods.map((x: { method: string; enabled: boolean }) => `${x.method}:${x.enabled}`)).toEqual(["deposit:true", "hsp:false", "voucher:true", "wallet:true", "x402:true"]);
    const info = await api("GET", "/v1/info", undefined, "none");
    expect(info.json.gateway).toMatchObject({ enabled: true, paymentRouter: router });
    const platform = await api("GET", "/v1/platform");
    expect(platform.json).toMatchObject({ name: "Acme Store", fee_recipient: FEES });
  });

  it("issues hashed sk_test_ keys shown once, tracks last use, and revokes them", async () => {
    const created = await api("POST", "/v1/api-keys", { name: "server" });
    expect(created.status).toBe(201);
    expect(created.json.secret).toMatch(/^sk_test_[a-z2-7]{52}$/);
    expect(created.json.prefix).toBe(created.json.secret.slice(0, 12));
    secret = created.json.secret;
    keyId = created.json.id;
    expect((await api("GET", "/v1/payments", undefined, secret)).status).toBe(200);
    const listed = await api("GET", "/v1/api-keys");
    expect(listed.json.items[0]).toMatchObject({ id: keyId, name: "server", revoked_at: null });
    expect(listed.json.items[0].last_used_at).not.toBeNull();
    expect(JSON.stringify(listed.json)).not.toContain(secret);
    expect(g.db.get<{ secret_hash: string }>("SELECT secret_hash FROM api_keys WHERE id = ?", keyId)!.secret_hash).not.toContain(secret.slice(8));
    // Key management needs the admin token; unknown and live-mode keys are refused.
    expect((await api("POST", "/v1/api-keys", { name: "x" }, secret)).status).toBe(401);
    expect((await api("GET", "/v1/payments", undefined, "sk_test_nope")).status).toBe(401);
    expect((await api("GET", "/v1/payments", undefined, secret.replace("sk_test_", "sk_live_"))).status).toBe(401);
    const second = await api("POST", "/v1/api-keys", { name: "revoked" });
    expect((await api("DELETE", `/v1/api-keys/${second.json.id}`)).json.revoked_at).not.toBeNull();
    expect((await api("GET", "/v1/payments", undefined, second.json.secret)).status).toBe(401);
  });

  it("replays the same Idempotency-Key and body, and refuses a different body with 409", async () => {
    const body = { amount: "1500000", reference: "ord-1" };
    const a = await api("POST", "/v1/payments", body, secret, { "Idempotency-Key": "k-1" });
    const b = await api("POST", "/v1/payments", body, secret, { "Idempotency-Key": "k-1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    const c = await api("POST", "/v1/payments", { ...body, amount: "1500001" }, secret, { "Idempotency-Key": "k-1" });
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe("IDEMPOTENCY_MISMATCH");
    // The same key on another route is another scope.
    expect((await api("POST", "/v1/links", { title: "T", amount: "1" }, secret, { "Idempotency-Key": "k-1" })).status).toBe(201);
  });

  it("answers a decimal amount with a 400 that names base units, never a 500", async () => {
    for (const [path, b] of [
      ["/v1/links", { title: "T", amount: "1.00" }],
      ["/v1/payments", { amount: "1.5" }],
    ] as const) {
      const r = await api("POST", path, b, secret);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain("base units");
    }
  });

  it("never leaks metadata, email, name or fees in public views", async () => {
    const p = await api("POST", "/v1/payments", { amount: "1000000", customer_email: "mira@mail.example", customer_name: "Mira Secret", metadata: { internal: "s3cr3t-meta" } }, secret);
    expect(p.json).toMatchObject({ customer_email: "mira@mail.example", platform_fee: "5000", fee_total: "5000", net_amount: "995000", merchant_id: expect.stringMatching(/^mer_/) });
    const view = await api("GET", `/v1/checkout/${p.json.id}`, undefined, "none");
    expect(view.status).toBe(200);
    for (const leak of ["mira@mail.example", "Mira Secret", "s3cr3t-meta", "metadata", "customer_", "platform_fee", "fee_total", "net_amount"]) expect(view.text).not.toContain(leak);
    expect(view.json).toMatchObject({ id: p.json.id, status: "open", amount: "1000000", surcharge: "0", amount_due: "1000000", methods: ["wallet", "deposit"] });
    expect(view.json.authorization).toMatchObject({ primaryType: "TransferWithAuthorization", message: { to: view.json.deposit_address, value: "1000000", validAfter: "0" } });
    expect(view.json.authorization.router).toBeUndefined();
    // The public receipt-email route cannot overwrite an email that is already set (by the merchant or the payer).
    const taken = await api("POST", `/v1/checkout/${p.json.id}/email`, { email: "attacker@mail.example" }, "none");
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe("EMAIL_ALREADY_SET");
    const bare = await api("POST", "/v1/payments", { amount: "1000000" }, secret);
    expect((await api("POST", `/v1/checkout/${bare.json.id}/email`, { email: "payer@mail.example" }, "none")).status).toBe(200);
    expect((await api("POST", `/v1/checkout/${bare.json.id}/email`, { email: "attacker@mail.example" }, "none")).json.error.code).toBe("EMAIL_ALREADY_SET");
    expect(g.payments.row(bare.json.id)!.customer_email).toBe("payer@mail.example");
    const sse = await fetch(`${node.url}/v1/checkout/${p.json.id}/events`);
    const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
    const first = (await reader.read()).value!;
    expect(first).toContain("event: status");
    expect(first).not.toContain("mira@mail.example");
    await reader.cancel();
    expect((await api("GET", "/v1/payments/pay_aaaaaaaaaaaaaaaaaaaaaaaa", undefined, secret)).status).toBe(404);
  });

  it("relays a wallet TransferWithAuthorization to the forwarder; the flush pays the payout the net and the platform the fee", async () => {
    const p = await api("POST", "/v1/payments", { amount: "2000000", description: "Mug" }, secret);
    const view = (await api<CheckoutView>("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
    const [payout0, fees0, payer0] = await Promise.all([balanceOf(PAYOUT.address), balanceOf(FEES), balanceOf(PAYER.address)]);
    const bad = await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER.address, signature: await signCheckout(view, PAYER_2) }, "none");
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("BAD_SIGNATURE");
    const r = await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER.address, signature: await signCheckout(view) }, "none");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "paid", txHash: expect.stringMatching(/^0x/) });
    // The money is in the payment's forwarder, which only the flush can split.
    expect(view.authorization).toMatchObject({ primaryType: "TransferWithAuthorization", message: { to: view.deposit_address, value: "2000000" } });
    expect(await balanceOf(view.deposit_address)).toBe(2_000_000n);
    expect(await balanceOf(router)).toBe(0n);
    await g.flusher.tick();
    expect(await balanceOf(view.deposit_address)).toBe(0n);
    expect(await balanceOf(PAYOUT.address)).toBe(payout0 + 1_990_000n);
    expect(await balanceOf(FEES)).toBe(fees0 + 10_000n);
    expect(await balanceOf(PAYER.address)).toBe(payer0 - 2_000_000n);
    const detail = await api("GET", `/v1/payments/${p.json.id}`, undefined, secret);
    expect(detail.json).toMatchObject({ status: "paid", amount_paid: "2000000", method: "wallet", payer: PAYER.address, late: false });
    expect(detail.json.credits).toMatchObject([{ method: "wallet", status: "confirmed", amount: "2000000", tx_hash: r.json.txHash }]);
    expect(detail.json.events.map((e: { type: string }) => e.type)).toEqual(["payment.created", "payment.processing", "payment.paid"]);
    // A terminal payment refuses further authorizations.
    expect((await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER.address, signature: await signCheckout(view) }, "none")).json.error.code).toBe("PAYMENT_NOT_PAYABLE");
  });

  it("credits an authorization someone else submitted first, from its AuthorizationUsed log", async () => {
    const p = await api("POST", "/v1/payments", { amount: "1000000" }, secret);
    const view = (await api<CheckoutView>("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
    const signature = await signCheckout(view, PAYER_2);
    const t = view.authorization!;
    const w = anvil.wallet(THIRD_PARTY);
    const hash = await w.writeContract({
      address: token,
      abi: eip3009Abi,
      functionName: "transferWithAuthorization",
      args: [PAYER_2.address, t.message.to, BigInt(t.message.value), 0n, BigInt(t.message.validBefore), t.message.nonce, signature],
    });
    await anvil.pub.waitForTransactionReceipt({ hash });
    const r = await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER_2.address, signature }, "none");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "paid", txHash: hash });
  });

  it("charges exactly fee_total across a partial deposit, a wallet payment of the rest and a late overpayment", async () => {
    // The forwarder is the only destination of customer money, so its cumulative fee counter is the single source of
    // truth: pro-rata on the partial, the rest with the wallet payment, nothing more on the overpayment.
    // Quoted at checkout (no method yet), so the page offers both the forwarder address and the wallet.
    const p = await api("POST", "/v1/payments", { amount: "2000000" }, secret);
    const forwarder = p.json.deposit_address as Address;
    expect(p.json.fee_total).toBe("10000");
    await g.flusher.tick(); // earlier tests' forwarders, so the balances below move only for this payment
    const [payout0, fees0] = await Promise.all([balanceOf(PAYOUT.address), balanceOf(FEES)]);
    await sendToken(ANVIL_KEYS[2], forwarder, 500_000n);
    await g.watcher.tick();
    await g.flusher.tick();
    expect(g.payments.row(p.json.id)).toMatchObject({ status: "partially_paid", amount_paid: "500000" });
    expect(await balanceOf(FEES)).toBe(fees0 + 2_500n);
    const view = (await api<CheckoutView>("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
    expect(view.authorization!.message).toMatchObject({ to: forwarder, value: "1500000" });
    const r = await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER.address, signature: await signCheckout(view) }, "none");
    expect(r.json).toMatchObject({ status: "paid" });
    await g.flusher.tick();
    expect(await balanceOf(FEES)).toBe(fees0 + 10_000n);
    await sendToken(ANVIL_KEYS[3], forwarder, 2_000_000n);
    await g.watcher.tick();
    await g.flusher.tick();
    expect(g.payments.row(p.json.id)).toMatchObject({ status: "overpaid", amount_paid: "4000000", fee_total: "10000" });
    expect(await balanceOf(forwarder)).toBe(0n);
    expect(await balanceOf(FEES)).toBe(fees0 + 10_000n);
    expect(await balanceOf(PAYOUT.address)).toBe(payout0 + 4_000_000n - 10_000n);
  });

  it("credits a deposit to the forwarder through the watcher, then flushes it with the fee split", async () => {
    const p = await api("POST", "/v1/payments", { amount: "3000000", method: "deposit" }, secret);
    const forwarder = p.json.deposit_address as Address;
    expect((await api("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json.deposit_uri).toBe(
      `ethereum:${token}@31337/transfer?address=${forwarder}&uint256=3000000`,
    );
    const [payout0, fees0] = await Promise.all([balanceOf(PAYOUT.address), balanceOf(FEES)]);
    await sendToken(ANVIL_KEYS[2], forwarder, 1_000_000n);
    await g.watcher.tick();
    expect(g.payments.row(p.json.id)).toMatchObject({ status: "partially_paid", amount_paid: "1000000", flush_status: "pending" });
    await sendToken(ANVIL_KEYS[3], forwarder, 2_000_000n);
    await g.watcher.tick();
    await g.watcher.tick(); // replays are no-ops
    expect(g.payments.row(p.json.id)).toMatchObject({ status: "paid", amount_paid: "3000000", payer: PAYER.address });
    expect(g.payments.credits(p.json.id)).toHaveLength(2);
    expect(await g.flusher.tick()).toBe(1);
    expect(await balanceOf(forwarder)).toBe(0n);
    expect(await balanceOf(PAYOUT.address)).toBe(payout0 + 2_985_000n);
    expect(await balanceOf(FEES)).toBe(fees0 + 15_000n);
    expect(g.payments.row(p.json.id)!.flush_status).toBe("done");
    // A late deposit after cancel is still credited (the money is already the merchant's).
    const c = await api("POST", "/v1/payments", { amount: "500000" }, secret);
    await api("POST", `/v1/payments/${c.json.id}/cancel`, {}, secret);
    await sendToken(ANVIL_KEYS[2], c.json.deposit_address, 500_000n);
    await g.watcher.tick();
    expect(g.payments.row(c.json.id)).toMatchObject({ status: "paid", late: 1 });
  });

  it("pays a link with x402 exact: 402 with PAYMENT-REQUIRED, retry with PAYMENT-SIGNATURE, PAYMENT-RESPONSE", async () => {
    const link = await api("POST", "/v1/links", { title: "API credits", min_amount: "100000", max_amount: "5000000" }, secret);
    expect(link.json).toMatchObject({ listed: true, url: `http://localhost:3000/l/${link.json.slug}` });
    const noAmount = await fetch(`${node.url}/v1/pay/l/${link.json.slug}`);
    expect(noAmount.status).toBe(400);
    const url = `${node.url}/v1/pay/l/${link.json.slug}?amount=1000000`;
    const first = await fetch(url, { headers: { origin: "http://localhost:3000" } });
    expect(first.status).toBe(402);
    expect(first.headers.get("access-control-expose-headers")).toMatch(/PAYMENT-REQUIRED/);
    expect(first.headers.get("access-control-expose-headers")).toMatch(/PAYMENT-RESPONSE/);
    const required = decodeHeader<{ x402Version: number; accepts: Array<Record<string, any>> }>(first.headers.get("PAYMENT-REQUIRED"))!;
    expect(required.x402Version).toBe(2);
    expect(required.accepts.map((a) => a.scheme)).toEqual(["exact", "payminto-voucher", "payminto-voucher"]);
    const exact = required.accepts[0]!;
    // The 402 made an invisible draft for its forwarder; the same client probing again gets the same one.
    const draftId = exact.extra.paymentId as string;
    expect(g.payments.row(draftId)).toMatchObject({ draft: 1, link_id: link.json.id });
    const again = decodeHeader<{ accepts: Array<Record<string, any>> }>((await fetch(url)).headers.get("PAYMENT-REQUIRED"))!;
    expect(again.accepts[0]!.payTo).toBe(exact.payTo);
    const listed = await api("GET", `/v1/payments?link_id=${link.json.id}`, undefined, secret);
    expect(listed.json.items).toEqual([]);
    expect((await api("GET", `/v1/payments/${draftId}`, undefined, secret)).status).toBe(404);
    expect(g.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gateway_events WHERE payment_id = ?", draftId)!.n).toBe(0);
    expect(exact).toMatchObject({ network: "eip155:31337", asset: token, amount: "1000000", extra: { name: "USD Coin", version: "1" } });
    // The voucher requirements split the fee: merchant net and platform fee recipient.
    expect(required.accepts.slice(1).map((a) => [a.payTo, a.amount])).toEqual([[PAYOUT.address, "995000"], [FEES, "5000"]]);
    const authorization = { from: PAYER.address, to: exact.payTo as Address, value: 1_000_000n, validAfter: 0n, validBefore: now() + 300n, nonce: randomNonce() };
    const signature = await PAYER.signTypedData(transferAuthorizationTypedData(domain, authorization));
    const payment = encodeHeader({
      x402Version: 2,
      accepted: exact,
      payload: { signature, authorization: { ...authorization, value: "1000000", validAfter: "0", validBefore: authorization.validBefore.toString() } },
    });
    const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": payment } });
    expect(paid.status).toBe(200);
    const response = decodeHeader<{ paymentId: string; status: string; txHash: Hex; success: boolean }>(paid.headers.get("PAYMENT-RESPONSE"))!;
    expect(response).toMatchObject({ success: true, status: "paid", paymentId: exact.extra.paymentId, txHash: expect.stringMatching(/^0x/) });
    const receipt = (await paid.json()) as { payment_id: string; order_hash: Hex };
    expect(receipt.payment_id).toBe(response.paymentId);
    // Paying promoted the draft: listed, announced, counted.
    expect(g.payments.row(draftId)!.draft).toBe(0);
    expect((await api("GET", `/v1/payments?link_id=${link.json.id}`, undefined, secret)).json.items.map((x: { id: string }) => x.id)).toEqual([draftId]);
    // The method filter: an agent payment is found under x402 (and agent methods together), not under wallet.
    expect((await api("GET", `/v1/payments?link_id=${link.json.id}&method=x402,voucher`, undefined, secret)).json).toMatchObject({ items: [{ id: draftId, method: "x402" }], counts: { all: 1 } });
    expect((await api("GET", `/v1/payments?link_id=${link.json.id}&method=wallet`, undefined, secret)).json.items).toEqual([]);
    expect((await api("GET", "/v1/payments?method=card", undefined, secret)).status).toBe(400);
    expect(g.db.all<{ type: string }>("SELECT type FROM gateway_events WHERE payment_id = ? ORDER BY seq", draftId).map((e) => e.type)).toEqual(["payment.created", "payment.processing", "payment.paid"]);
    // The watcher sees the same Transfer and does nothing new; the flush splits it.
    await g.watcher.tick();
    expect(g.payments.credits(response.paymentId)).toMatchObject([{ method: "x402", status: "confirmed" }]);
    await g.flusher.tick();
    expect(await balanceOf(exact.payTo as Address)).toBe(0n);
    // Replaying the same signature does not pay twice.
    expect((await fetch(url, { headers: { "PAYMENT-SIGNATURE": payment } })).status).not.toBe(200);
    // A paid payment offers nothing more to pay (no `exact` for a zero or negative remainder).
    const after = decodeHeader<{ accepts: Array<Record<string, any>> }>((await fetch(`${node.url}/v1/pay/${draftId}`)).headers.get("PAYMENT-REQUIRED"));
    expect(after?.accepts ?? []).toEqual([]);
  });

  it("pays a no-fee merchant's link with a payminto-voucher through AgentClient, paid when the batch confirms", async () => {
    const plans = await api("GET", "/v1/fee-plans");
    const noFee = plans.json.items.find((p: { name: string }) => p.name === "No fee");
    const ts = Number(now());
    const proofSig = await PAYOUT_B.signMessage({ message: payoutChangeMessage("new", PAYOUT_B.address, ts, scope()) });
    const created = await api("POST", "/v1/merchants", { name: "Data Shop", fee_plan_id: noFee.id, payout: { payout: PAYOUT_B.address, timestamp: ts, signature: proofSig } });
    expect(created.status).toBe(201);
    const mid = created.json.id as string;
    // A bad proof is refused.
    const forged = await api("POST", "/v1/merchants", { name: "Forged", payout: { payout: PAYOUT_B.address, timestamp: ts, signature: await PAYER.signMessage({ message: "x" }) } });
    expect(forged.json.error.code).toBe("PAYOUT_PROOF_INVALID");
    // Now there are two merchants, so the admin token must say which.
    expect((await api("GET", "/v1/merchant")).json.error.code).toBe("MERCHANT_REQUIRED");
    const link = await api("POST", "/v1/links", { title: "Report", amount: "250000" }, "admin", { "Merchant-Id": mid });
    expect(link.status).toBe(201);

    const owner = new OwnerClient({ nodeUrl: node.url, chainId: 31337, hub, account: OWNER, publicClient: anvil.pub, adminToken: ADMIN });
    const policy = { perCallCap: "1000000", dailyCap: "5000000", maxCallsPerMinute: 100, purpose: "buys reports" };
    const payees = [PAYOUT_B.address];
    const m = await owner.createMandate({ agent: AGENT.address, token, totalCap: 5n * USDC, validForSeconds: 86_400, payees, policy });
    await owner.submit({ ...m, policy, payees, label: "Report buyer" });
    const agent = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT, mandateId: m.mandateId });
    await agent.ensureAllowance(anvil.wallet(ANVIL_KEYS[4]), maxUint256, { token });
    const errors: Error[] = [];
    agent.on("error", (e) => errors.push(e));
    const res = await agent.fetch(`${node.url}/v1/pay/l/${link.json.slug}`);
    expect(res.status).toBe(200);
    expect(errors).toEqual([]);
    const response = decodeHeader<{ paymentId: string; status: string }>(res.headers.get("PAYMENT-RESPONSE"))!;
    expect(response.status).toBe("processing");
    const payout0 = await balanceOf(PAYOUT_B.address);
    const settled = await api("POST", "/v1/settlements", {});
    expect(settled.json.batchIds).toHaveLength(1);
    expect(g.payments.row(response.paymentId)).toMatchObject({ status: "paid", method: "voucher", amount_paid: "250000", payer: AGENT.address });
    expect(g.payments.credits(response.paymentId)).toMatchObject([{ method: "voucher", status: "confirmed", batch_id: settled.json.batchIds[0] }]);
    expect(await balanceOf(PAYOUT_B.address)).toBe(payout0 + 250_000n);
    // Merchant scoping: the default merchant's key cannot see it.
    expect((await api("GET", `/v1/payments/${response.paymentId}`, undefined, secret)).status).toBe(404);
  });

  it("pays a fee-carrying payment with two vouchers (merchant net and platform fee), paid when the batch confirms", async () => {
    const buyer = privateKeyToAccount(THIRD_PARTY);
    await mint(anvil, token, buyer.address, 10n * USDC);
    const approve = await anvil.wallet(THIRD_PARTY).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [hub, maxUint256] });
    await anvil.pub.waitForTransactionReceipt({ hash: approve });
    const owner = new OwnerClient({ nodeUrl: node.url, chainId: 31337, hub, account: OWNER, publicClient: anvil.pub, adminToken: ADMIN });
    const policy = { perCallCap: "2000000", dailyCap: "5000000", maxCallsPerMinute: 100, purpose: "pays the store and its platform fee" };
    const payees = [PAYOUT.address, FEES];
    const m = await owner.createMandate({ agent: buyer.address, token, totalCap: 5n * USDC, validForSeconds: 86_400, payees, policy });
    await owner.submit({ ...m, policy, payees, label: "Two-payee buyer" });

    const p = await api("POST", "/v1/payments", { amount: "1000000", method: "voucher", description: "Annual plan" }, secret);
    expect(p.json).toMatchObject({ method: "voucher", amount_due: "1000000", platform_fee: "5000", fee_total: "5000", net_amount: "995000" });
    const first = await fetch(`${node.url}/v1/pay/${p.json.id}`);
    expect(first.status).toBe(402);
    const required = decodeHeader<{ accepts: Array<{ scheme: string; payTo: Address; amount: string }> }>(first.headers.get("PAYMENT-REQUIRED"))!;
    const vouchers = required.accepts.filter((a) => a.scheme === "payminto-voucher");
    expect(vouchers.map((a) => [a.payTo, a.amount])).toEqual([[PAYOUT.address, "995000"], [FEES, "5000"]]);

    // Signed directly with the protocol helpers: one cumulative voucher per payee, both fresh positions.
    const requestHash = keccak256(toBytes(`GET /v1/pay/${p.json.id}`));
    const signed = await Promise.all(
      vouchers.map(async (r) => {
        const cumulative = BigInt(r.amount);
        const signature = await buyer.signTypedData(voucherTypedData(31337, hub, { mandateId: m.mandateId, payee: r.payTo, cumulative }));
        return { x402Version: 2, scheme: "payminto-voucher", network: "eip155:31337", payload: { mandateId: m.mandateId, payee: r.payTo, amount: r.amount, cumulative: r.amount, signature, requestHash } };
      }),
    );
    // One voucher alone is refused before anything is accepted.
    const partial = await fetch(`${node.url}/v1/pay/${p.json.id}`, { headers: { "PAYMENT-SIGNATURE": encodeHeader(signed[0]) } });
    expect(partial.status).toBe(402);
    expect(((await partial.json()) as { error: { code: string } }).error.code).toBe("VOUCHER_MISSING");
    expect(g.payments.credits(p.json.id)).toEqual([]);

    // A pair with one bad voucher books neither: no call, no credit.
    const calls0 = g.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls")!.n;
    const forged = [signed[0], { ...signed[1]!, payload: { ...signed[1]!.payload, signature: signed[0]!.payload.signature } }];
    const half = await fetch(`${node.url}/v1/pay/${p.json.id}`, { headers: { "PAYMENT-SIGNATURE": encodeHeader(forged) } });
    expect(half.status).toBe(402);
    expect(((await half.json()) as { error: { code: string } }).error.code).toBe("BAD_SIGNATURE");
    expect(g.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls")!.n).toBe(calls0);
    expect(g.payments.credits(p.json.id)).toEqual([]);

    const res = await fetch(`${node.url}/v1/pay/${p.json.id}`, { headers: { "PAYMENT-SIGNATURE": encodeHeader({ vouchers: signed }) } });
    expect(res.status).toBe(200);
    const response = decodeHeader<{ status: string; receipts: Array<{ callId: Hex; nodeSignature: Hex }> }>(res.headers.get("PAYMENT-RESPONSE"))!;
    expect(response.status).toBe("processing");
    expect(response.receipts).toHaveLength(2);
    expect(g.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls")!.n).toBe(calls0 + 2);
    // A retry of the same pair is idempotent: same receipts, nothing new booked.
    const retry = await fetch(`${node.url}/v1/pay/${p.json.id}`, { headers: { "PAYMENT-SIGNATURE": encodeHeader({ vouchers: signed }) } });
    expect(retry.status).toBe(200);
    expect(decodeHeader<{ receipts: unknown[] }>(retry.headers.get("PAYMENT-RESPONSE"))!.receipts).toEqual(response.receipts);
    expect(g.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls")!.n).toBe(calls0 + 2);
    expect(g.payments.credits(p.json.id).map((c) => [c.amount, c.status])).toEqual([["995000", "pending"], ["5000", "pending"]]);
    // Knowing the voucher fields is not enough to get the stored receipts back: the replay must carry valid signatures.
    const unsigned = signed.map((v, i) => ({ ...v, payload: { ...v.payload, signature: signed[1 - i]!.payload.signature } }));
    const stolen = await fetch(`${node.url}/v1/pay/${p.json.id}`, { headers: { "PAYMENT-SIGNATURE": encodeHeader({ vouchers: unsigned }) } });
    expect(stolen.status).not.toBe(200);
    expect(stolen.headers.get("PAYMENT-RESPONSE")).toBeNull();

    const [payout0, fees0, buyer0] = await Promise.all([balanceOf(PAYOUT.address), balanceOf(FEES), balanceOf(buyer.address)]);
    const settled = await api("POST", "/v1/settlements", {});
    expect(settled.json.batchIds).toHaveLength(1);
    expect(g.payments.row(p.json.id)).toMatchObject({ status: "paid", amount_paid: "1000000", method: "voucher", payer: buyer.address });
    expect(g.payments.credits(p.json.id).every((c) => c.status === "confirmed" && c.batch_id === settled.json.batchIds[0])).toBe(true);
    expect(await balanceOf(PAYOUT.address)).toBe(payout0 + 995_000n);
    expect(await balanceOf(FEES)).toBe(fees0 + 5_000n);
    expect(await balanceOf(buyer.address)).toBe(buyer0 - 1_000_000n);
  });

  it("refunds by a payout-signed router authorization and by a plain transfer, verified on chain", async () => {
    const p = await api("POST", "/v1/payments", { amount: "1000000" }, secret);
    const view = (await api<CheckoutView>("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
    await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER.address, signature: await signCheckout(view) }, "none");
    const tooMuch = await api("POST", "/v1/refunds", { paymentId: p.json.id, amount: "1000001" }, secret);
    expect(tooMuch.json.error.code).toBe("REFUND_EXCEEDS_PAID");
    const r1 = await api("POST", "/v1/refunds", { paymentId: p.json.id, amount: "300000", reason: "damaged" }, secret, { "Idempotency-Key": "refund-1" });
    expect(r1.status).toBe(201);
    expect(r1.json).toMatchObject({ status: "pending", to: PAYER.address, amount: "300000" });
    const auth = r1.json.authorization;
    const message = { from: PAYOUT.address, to: router, value: 300_000n, validAfter: 0n, validBefore: now() + 3600n, nonce: auth.nonce as Hex };
    const signature = await PAYOUT.signTypedData(receiveAuthorizationTypedData(domain, message));
    const payer0 = await balanceOf(PAYER.address);
    const authJson = { ...message, value: "300000", validAfter: "0", validBefore: message.validBefore.toString(), signature };
    const badTerms = await api("POST", `/v1/refunds/${r1.json.id}/submit`, { authorization: authJson, terms: { ...auth.terms, fee: "1" } }, secret);
    expect(badTerms.json.error.code).toBe("REFUND_TERMS_MISMATCH");
    // The dashboard sends {authorization, terms}; the terms are the ones the create response handed out.
    const s1 = await api("POST", `/v1/refunds/${r1.json.id}/submit`, { authorization: authJson, terms: auth.terms }, secret);
    expect(s1.json).toMatchObject({ status: "succeeded", method: "authorization" });
    expect(await balanceOf(PAYER.address)).toBe(payer0 + 300_000n);

    const r2 = await api("POST", "/v1/refunds", { paymentId: p.json.id, amount: "200000" }, secret);
    const wrong = await sendToken(ANVIL_KEYS[6], PAYER.address, 199_999n);
    expect((await api("POST", `/v1/refunds/${r2.json.id}/submit`, { txHash: wrong }, secret)).json.error.code).toBe("REFUND_TRANSFER_MISMATCH");
    const right = await sendToken(ANVIL_KEYS[6], PAYER.address, 200_000n);
    const s2 = await api("POST", `/v1/refunds/${r2.json.id}/submit`, { txHash: right }, secret);
    expect(s2.json).toMatchObject({ status: "succeeded", method: "transfer", tx_hash: right });
    const r3 = await api("POST", "/v1/refunds", { paymentId: p.json.id, amount: "100000" }, secret);
    expect((await api("POST", `/v1/refunds/${r3.json.id}/submit`, { txHash: right }, secret)).json.error.code).toBe("REFUND_TX_USED");
    expect((await api("POST", `/v1/refunds/${r3.json.id}/cancel`, {}, secret)).json.status).toBe("canceled");
    expect(g.payments.row(p.json.id)).toMatchObject({ amount_refunded: "500000" });
    expect((await api("GET", `/v1/payments/${p.json.id}`, undefined, secret)).json).toMatchObject({ refund_status: "partial", amount_refunded: "500000" });
  });

  it("delivers signed webhooks to a real receiver, with a test ping and a manual retry", async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    let fail = true;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(fail ? 503 : 204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
      const e = await api("POST", "/v1/webhooks", { url, events: ["payment.paid", "payment.created"] }, secret);
      expect(e.status).toBe(201);
      const secretKey = e.json.secret as string;
      expect((await api("GET", `/v1/webhooks/${e.json.id}`, undefined, secret)).json.secret).toBeUndefined();
      expect((await api("GET", `/v1/webhooks/${e.json.id}/secret`, undefined, secret)).json.secret).toBe(secretKey);
      const ping = await api("POST", `/v1/webhooks/${e.json.id}/test`, {}, secret);
      expect(ping.json).toMatchObject({ event_type: "ping", status: "failed", response_status: 503 });
      fail = false;
      const retried = await api("POST", `/v1/webhook-deliveries/${ping.json.id}/retry`, {}, secret);
      expect(retried.json).toMatchObject({ status: "succeeded", response_status: 204, attempt: 2 });
      const p = await api("POST", "/v1/payments", { amount: "700000" }, secret);
      await sendToken(ANVIL_KEYS[2], p.json.deposit_address, 700_000n);
      await g.watcher.tick();
      await g.webhooks.tick();
      const events = received.slice(2);
      expect(events.map((r) => r.headers["payminto-event-type"])).toEqual(["payment.created", "payment.paid"]);
      for (const r of received) expect(await verifyWebhook(r.body, r.headers["payminto-signature"] as string, secretKey)).toBe(true);
      expect(JSON.parse(events[1]!.body).data.object).toMatchObject({ id: p.json.id, status: "paid", fee_total: "3500", net_amount: "696500" });
      const log = await api("GET", `/v1/webhooks/${e.json.id}/deliveries`, undefined, secret);
      expect(log.json.items.length).toBe(4);
      expect(log.json.items[0].request_body).toContain(p.json.id);
    } finally {
      server.close();
    }
  });

  it("screens payers against the merchant deny list and records the decision", async () => {
    await api("POST", "/v1/screening/deny-list", { address: PAYER_2.address, reason: "chargeback fraud" }, secret);
    const p = await api("POST", "/v1/payments", { amount: "100000" }, secret);
    const view = (await api<CheckoutView>("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
    const r = await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER_2.address, signature: await signCheckout(view, PAYER_2) }, "none");
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: "SCREENING_REFUSED", details: { rule: "PAYER_DENIED", source: "gateway" } });
    const d = await api("GET", "/v1/screening/decisions", undefined, secret);
    expect(d.json.items[0]).toMatchObject({ source: "gateway", rule: "PAYER_DENIED", stage: "authorize", payer: PAYER_2.address, payment_id: p.json.id });
    expect(g.payments.row(p.json.id)!.status).toBe("open");
    await api("DELETE", `/v1/screening/deny-list/${PAYER_2.address}`, undefined, secret);
  });

  it("commits to the order, proves paid payments, and lists listed links in the directory", async () => {
    const p = await api("POST", "/v1/payments", { amount: "300000", reference: "inv-9", metadata: { crm: "c-77" }, line_items: [{ name: "Sticker", quantity: 3, unit_amount: "100000" }] }, secret);
    expect((await api("POST", "/v1/payments", { amount: "300000", line_items: [{ name: "x", quantity: 1, unit_amount: "1" }] }, secret)).json.error.code).toBe("LINE_ITEMS_MISMATCH");
    const order = await api("GET", `/v1/checkout/${p.json.id}/order`, undefined, "none");
    expect(keccak256(toBytes(order.text))).toBe(p.json.order_hash);
    expect(order.json).toMatchObject({ payment_id: p.json.id, reference: "inv-9", metadata_hash: metadataHash({ crm: "c-77" }) });
    expect(order.text).not.toContain("c-77");
    expect(order.text).not.toContain('"metadata"');
    expect(p.json.metadata).toEqual({ crm: "c-77" });
    expect((await api("GET", `/v1/checkout/${p.json.id}/proof`, undefined, "none")).json.error.code).toBe("NOT_PAID");
    const view = (await api<CheckoutView>("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
    expect(view.order_hash).toBe(p.json.order_hash);
    await api("POST", `/v1/checkout/${p.json.id}/authorize`, { payer: PAYER.address, signature: await signCheckout(view) }, "none");
    const proof = await api("GET", `/v1/checkout/${p.json.id}/proof`, undefined, "none");
    expect(proof.json).toMatchObject({ status: "paid", order_hash: p.json.order_hash, payout: PAYOUT.address, attestation: { enabled: false } });
    expect(proof.json.credits[0]).toMatchObject({ method: "wallet", finality: "final" });
    expect(proof.json.credits[0].authorization_used[0].authorizer).toBe(PAYER.address);
    // The wallet payment is one Transfer from the payer to the payment's forwarder (the flush splits it later).
    expect(proof.json.credits[0].transfers).toEqual([expect.objectContaining({ from: PAYER.address, to: view.deposit_address, value: view.amount_due })]);

    const hidden = await api("POST", "/v1/links", { title: "Hidden", amount: "1", listed: false }, secret);
    const dir = await api("GET", "/.well-known/payminto.json", undefined, "none");
    const titles = dir.json.services.map((s: { title: string }) => s.title);
    expect(titles).toContain("API credits");
    expect(titles).not.toContain("Hidden");
    expect(dir.json.services.find((s: { title: string }) => s.title === "API credits")).toMatchObject({ schemes: ["exact", "payminto-voucher"], price: { min_amount: "100000" } });
    expect((await api("GET", "/v1/directory", undefined, "none")).json.services.length).toBe(dir.json.services.length);
    void hidden;
  });

  it("changes a payout only with a fresh EIP-191 proof from the new wallet", async () => {
    const merchants = await api("GET", "/v1/merchants");
    const m = merchants.json.items.find((x: { name: string }) => x.name === "Data Shop");
    const ts = Number(now());
    const stale = await api("POST", `/v1/merchants/${m.id}/payout`, {
      payout: PAYER.address,
      timestamp: ts - 3600,
      signature: await PAYER.signMessage({ message: payoutChangeMessage(m.id, PAYER.address, ts - 3600, scope()) }),
    });
    expect(stale.json.error.code).toBe("PAYOUT_PROOF_EXPIRED");
    // A fresh proof signed for another node (other hub) is refused here.
    const elsewhere = await api("POST", `/v1/merchants/${m.id}/payout`, {
      payout: PAYER.address,
      timestamp: ts,
      signature: await PAYER.signMessage({ message: payoutChangeMessage(m.id, PAYER.address, ts, { chainId: 31337, hub: router }) }),
    });
    expect(elsewhere.json.error.code).toBe("PAYOUT_PROOF_INVALID");
    const ok = await api("POST", `/v1/merchants/${m.id}/payout`, {
      payout: PAYER.address,
      timestamp: ts,
      signature: await PAYER.signMessage({ message: payoutChangeMessage(m.id, PAYER.address, ts, scope()) }),
    });
    expect(ok.json.payout).toBe(PAYER.address);
    expect((await api("GET", `/v1/merchants/${m.id}`)).json.payout_history.map((h: { new_payout: Address }) => h.new_payout)).toEqual([PAYER.address, PAYOUT_B.address]);
    // A merchant key cannot reach operator routes.
    expect((await api("GET", "/v1/merchants", undefined, secret)).status).toBe(401);
  });

  it("reports overview stats and platform earnings", async () => {
    const o = await api("GET", "/v1/gateway/overview", undefined, secret);
    expect(o.json.days).toHaveLength(30);
    expect(o.json.counts.paid).toBeGreaterThan(3);
    expect(o.json.conversion).toBeGreaterThan(0);
    const fees = await api("GET", "/v1/platform/fees");
    expect(BigInt(fees.json.totals.fee_total)).toBeGreaterThan(0n);
    expect(fees.json.days).toHaveLength(30);
    const today = fees.json.days[29];
    expect(today.day).toBe(new Date().toISOString().slice(0, 10));
    expect(BigInt(today.fee_total)).toBe(BigInt(fees.json.totals.fee_total));
    expect(Object.keys(today.by_method).sort()).toEqual(["deposit", "hsp", "voucher", "wallet", "x402"]);
    expect(Object.values(today.by_method as Record<string, string>).reduce((a, v) => a + BigInt(v), 0n)).toBe(BigInt(today.fee_total));
    const list = await api("GET", "/v1/merchants");
    const acme = list.json.items.find((m: { name: string }) => m.name === "Acme Store");
    expect(acme.payments_30d).toBeGreaterThan(3);
    expect(BigInt(acme.volume_30d)).toBeGreaterThan(0n);
    const detail = await api("GET", `/v1/merchants/${acme.id}`);
    expect(detail.json.payout_history).toEqual([expect.objectContaining({ new_payout: PAYOUT.address, proven: false })]);
  });

  it("credits and flushes a deposit sent to a forwarder the checkout showed before a re-quote moved it", async () => {
    // A customer-borne deposit fee makes the deposit quote (and so its forwarder) differ from the wallet quote.
    const payout = privateKeyToAccount(generatePrivateKey());
    const ts = Number(now());
    const created = await api("POST", "/v1/merchants", {
      name: "Requote Shop",
      payout: { payout: payout.address, timestamp: ts, signature: await payout.signMessage({ message: payoutChangeMessage("new", payout.address, ts, scope()) }) },
    });
    const mid = created.json.id as string;
    const as = { "Merchant-Id": mid };
    const methods = await api("PUT", `/v1/merchants/${mid}/methods`, { methods: [{ method: "deposit", fee_bps: 100, bearer: "customer" }] }, "admin", as);
    expect(methods.status).toBe(200);
    const p = await api("POST", "/v1/payments", { amount: "2000000" }, "admin", as);
    const deposit = await api("POST", `/v1/checkout/${p.json.id}/method`, { method: "deposit" }, "none");
    const shown = deposit.json.deposit_address as Address;
    expect(deposit.json.amount_due).toBe("2020000");
    // The payer sends what the "Send manually" tab showed, then the page (or anyone) re-quotes before the watcher runs.
    await sendToken(ANVIL_KEYS[2], shown, 2_020_000n);
    const wallet = await api("POST", `/v1/checkout/${p.json.id}/method`, { method: "wallet" }, "none");
    expect(wallet.status).toBe(200);
    await g.watcher.tick();
    await g.watcher.tick();
    expect(g.payments.row(p.json.id)).toMatchObject({ status: "paid", amount_paid: "2020000", amount_due: "2020000", deposit_address: shown, quote_method: "deposit" });
    const payout0 = await balanceOf(payout.address);
    await g.flusher.tick();
    expect(await balanceOf(shown)).toBe(0n);
    const row = g.payments.row(p.json.id)!;
    expect(await balanceOf(payout.address)).toBe(payout0 + BigInt(row.net_amount));
  });
});

describe("gateway config", () => {
  const base = (over: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "payminto-gw-config-"));
    writeFileSync(join(dir, "133.json"), JSON.stringify({ chainId: 133, clearingHub: "0x5FbDB2315678afecb367f032d93F642f64180aa3", blockNumber: 1, depositFactory: "0x5FbDB2315678afecb367f032d93F642f64180aa4", paymentRouter: "0x5FbDB2315678afecb367f032d93F642f64180aa5" }));
    return {
      CHAIN_ID: "133",
      DEPLOYMENTS_DIR: dir,
      OPERATOR_KEY: `0x${"11".repeat(32)}`,
      ADMIN_TOKEN: "x".repeat(40),
      GATEWAY_PAYOUT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      PUBLIC_CHECKOUT_URL: "https://pay.example.com",
      ...over,
    };
  };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return [];
    } catch (err) {
      return (err as ConfigError).problems;
    }
  };

  it("is off without a payout, and refuses unsafe settings on real chains", () => {
    expect(loadConfig({ OPERATOR_KEY: ANVIL_KEYS[9], ADMIN_TOKEN: ADMIN, HUB_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3", TOKEN_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }).gateway).toBeUndefined();
    expect(loadConfig(base({})).gateway).toMatchObject({ webhookAllowPrivate: false, checkoutBaseUrl: "https://pay.example.com" });
    expect(problems(base({ WEBHOOK_ALLOW_PRIVATE: "true" }))).toEqual([expect.stringMatching(/^WEBHOOK_ALLOW_PRIVATE/)]);
    expect(problems(base({ PUBLIC_CHECKOUT_URL: "http://localhost:3000" }))).toEqual([expect.stringMatching(/^PUBLIC_CHECKOUT_URL/)]);
    expect(problems(base({ GATEWAY_PAYOUT_ADDRESS: privateKeyToAccount(ANVIL_KEYS[0]).address }))).toEqual([expect.stringMatching(/public anvil/)]);
    expect(problems(base({ GATEWAY_PAYOUT_ADDRESS: privateKeyToAccount(`0x${"11".repeat(32)}`).address }))).toEqual([expect.stringMatching(/operator wallet/)]);
    expect(problems(base({ CHECKOUT_TTL_SECONDS: "999999999" }))).toEqual([expect.stringMatching(/^CHECKOUT_TTL_SECONDS/)]);
  });
});
