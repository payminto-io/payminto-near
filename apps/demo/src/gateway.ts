import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { erc20Abi, keccak256, parseEther, toBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  checkoutTypedData,
  computeFees,
  formatAmount,
  networkFor,
  receiveAuthorizationTypedData,
  type CheckoutView,
  type FeePlan,
  type MerchantMethod,
  type PaymentMethod,
  type WebhookEvent,
} from "@payminto/protocol";
import { AgentClient, constructEvent, GatewayClient, NodeApiError, OwnerClient, payExact, signPayoutProof, type PaymentDetail } from "@payminto/sdk";
import { assertDisposableTarget } from "@payminto/node";
import { AgentWallet, createMcpServer } from "@payminto/mcp";
import { mintLocal } from "./chain.ts";
import { LOCAL_GATEWAY_AMOUNTS, type GatewayAmounts } from "./config.ts";
import { addBusinessAdmin } from "./session.ts";
import { liveConfirmTimeoutMs, settle } from "./scenario.ts";
import type { Say, Stack } from "./stack.ts";

/**
 * The gateway act (docs/GATEWAY.md sections 10 and 14), after the clearing run: the operator onboards a second merchant
 * with a fee plan and a customer-borne deposit fee, the merchant shares one link, and four payers pay it four ways:
 * a person with a wallet signature (EIP-3009 TransferWithAuthorization to the payment's forwarder), a person by plain transfer to the deposit
 * forwarder, a plain x402 agent with `exact`, and a mandate agent over MCP with two vouchers settled in the next batch.
 * Then a gasless refund, a screening refusal, the reconciliation report, and checks that every balance moved exactly
 * by the fee breakdowns. Locally it mints its wallets; on a live network (DEMO_GATEWAY=1) they are funded testnet
 * wallets (apps/demo/scripts/fund-testnet.ts) and every amount is about a hundredth of the local one.
 */

/** The local amounts (the live ones are in config.ts, LIVE_GATEWAY_AMOUNTS). */
export const LINK_PRICE = LOCAL_GATEWAY_AMOUNTS.link;
/** 0.5 % plus a fixed part (0.01 USDC locally) on every payment. */
export const northwindPlan = (a: GatewayAmounts) => ({ name: "Northwind data plan", platform_fee_bps: 50, platform_fee_fixed: a.planFixed }) as const;
export const NORTHWIND_PLAN = northwindPlan(LOCAL_GATEWAY_AMOUNTS);
/** A flat handling fee on deposits (0.05 USDC locally), added to what the customer pays. */
export const depositFee = (a: GatewayAmounts) => ({ method: "deposit" as const, fee_bps: 0, fee_fixed: a.depositFee, bearer: "customer" as const });
export const DEPOSIT_FEE = depositFee(LOCAL_GATEWAY_AMOUNTS);
export const REFUND_AMOUNT = LOCAL_GATEWAY_AMOUNTS.refund;

export type GatewayPaymentRow = {
  method: PaymentMethod;
  payer: string;
  paymentId: string;
  status: string;
  amountDue: bigint;
  fee: bigint;
  net: bigint;
  /** What computeFees says this payment's fee must be, from the plan and the method settings. */
  expectedFee: bigint;
  tx: Hex | null;
  /** Clearing batch for the voucher payment. */
  batchId: Hex | null;
  depositAddress: Address;
};

export type WebhookLog = { type: string; eventId: string; objectId: string | null; verified: boolean; error: string | null };

export type GatewayResult = {
  merchant: { id: string; name: string; payout: Address; plan: FeePlan; deposit: MerchantMethod };
  link: { id: string; slug: string; url: string; payUrl: string; amount: bigint };
  payments: GatewayPaymentRow[];
  mcp: { listed: boolean; toolText: string };
  refund: { id: string; paymentId: string; amount: bigint; status: string; txHash: Hex | null; payoutTransactions: number };
  screening: { payer: Address; httpStatus: number; code: string | null; rule: string | null; recorded: boolean };
  /**
   * `local`: a receiver on this machine verified every delivery. `public`: deliveries to DEMO_WEBHOOK_URL, checked by
   * their delivery status. `skipped`: a live network with no public receiver (the node refuses private targets there).
   */
  webhooks: { mode: "local" | "public" | "skipped"; received: WebhookLog[]; delivered: number; deliveriesNotOk: number; missing: string[] };
  /** GET /v1/reports/reconciliation for the act's time range, checked against the payments it made. */
  report: { payments: number; paid: number; net: bigint; refunds: bigint; expectedNet: bigint; ledgerMatches: boolean; csvRows: number } | null;
  /** Every on-chain transaction of the act, for the explorer. */
  txs: Array<{ what: string; hash: Hex }>;
  balances: {
    merchantDelta: bigint;
    expectedMerchantDelta: bigint;
    platformDelta: bigint;
    expectedPlatformDelta: bigint;
    platformEarned: bigint;
    forwarders: Array<{ method: PaymentMethod; address: Address; balance: bigint }>;
    router: bigint;
    hub: bigint;
  };
  proof: { paymentId: string; method: string; finality: string; forwarderTransfer: boolean; authorizedByPayer: boolean; orderHashMatches: boolean } | null;
  ms: number;
};

type Json = Record<string, any>;

async function publicJson(url: string, init?: RequestInit): Promise<{ status: number; json: Json }> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", "content-type": "application/json", ...init?.headers } });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, everyMs = 250): Promise<T> {
  // Public RPCs lag and rate-limit: poll less often there (the caller passes a live timeout).
  if (timeoutMs > 30_000) everyMs = Math.max(everyMs, 2_000);
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`gateway act: timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** A local merchant webhook endpoint that accepts only deliveries constructEvent verifies. */
async function webhookReceiver(secret: () => string | null) {
  const received: WebhookLog[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const s = secret();
      const header = req.headers["payminto-signature"];
      void (async () => {
        try {
          if (!s) throw new Error("no secret yet");
          const e: WebhookEvent = await constructEvent(raw, typeof header === "string" ? header : null, s);
          received.push({ type: e.type, eventId: e.id, objectId: (e.data.object as { id?: string }).id ?? null, verified: true, error: null });
          res.writeHead(204).end();
        } catch (err) {
          received.push({ type: String(req.headers["payminto-event-type"] ?? "?"), eventId: String(req.headers["payminto-event-id"] ?? "?"), objectId: null, verified: false, error: (err as Error).message });
          res.writeHead(400).end();
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/payminto/webhooks`, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function runGatewayAct(stack: Stack, o: { say?: Say } = {}): Promise<GatewayResult> {
  const say = o.say ?? (() => {});
  const gw = stack.gateway;
  if (!gw) throw new Error("the gateway act needs its wallets: locally they are minted, on a live network set DEMO_GATEWAY=1 and the DEMO_*_KEY wallets");
  const t0 = Date.now();
  const startedAt = new Date(t0 - 60_000);
  const { rpc, token, cfg, nodeUrl } = stack;
  const A = cfg.gatewayAmounts;
  const txs: GatewayResult["txs"] = [];
  // Credits, flushes and refunds wait for the node's confirm tag: seconds locally, minutes at a public chain's safe head.
  const wait = cfg.live ? await liveConfirmTimeoutMs(stack) : 30_000;
  /** A balance read that a lagging public RPC may serve from an older block: retried until it equals `want`. */
  const settledBalance = async (who: Address, want: bigint) => {
    let v = await balanceOf(who);
    for (let i = 0; cfg.live && v !== want && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      v = await balanceOf(who);
    }
    return v;
  };
  const a = gw.addresses;
  const acct = (k: Hex) => privateKeyToAccount(k);
  const balanceOf = (who: Address) => rpc.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  // The token's own EIP-712 domain as the node verified it on chain (GET /v1/info): on HashKey Chain Testnet the token
  // is Payminto Test USDC, not the Circle USDC chains.ts names. chains.ts only for an older node.
  const info = await publicJson(`${nodeUrl}/v1/info`);
  const eip712 = (info.json?.token?.eip712 as { name: string; version: string } | undefined) ?? networkFor(cfg.chainId).token.eip712;
  const domain = { ...eip712, chainId: cfg.chainId, verifyingContract: token };

  // ---------------------------------------------------------------- wallets
  const payers = { walletPayer: a.walletPayer, depositPayer: a.depositPayer, x402Agent: a.x402Agent, mandateAgent: a.mandateAgent, flagged: a.flagged };
  if (!cfg.live) {
    for (const who of Object.values(payers)) await mintLocal(rpc, cfg.keys.deployer!, token, who, A.payerFunds);
    // Only the person paying by plain transfer sends a transaction; everyone else only signs.
    const gas = await rpc.wallet(cfg.keys.deployer!).sendTransaction({ to: a.depositPayer, value: parseEther("1") });
    await rpc.pub.waitForTransactionReceipt({ hash: gas });
    say(`minted ${usdcText(A.payerFunds)} test USDC each to two shoppers, an x402 agent, a mandate agent and a flagged wallet`);
  } else {
    const short: string[] = [];
    for (const [role, who] of Object.entries(payers)) {
      const bal = await balanceOf(who);
      if (bal < A.payerFunds) short.push(`${role} ${who} holds ${usdcText(bal)}, needs ${usdcText(A.payerFunds)}`);
    }
    if ((await rpc.pub.getBalance({ address: a.depositPayer })) === 0n) short.push(`depositPayer ${a.depositPayer} has no gas for its transfer`);
    if (short.length) throw new Error(`gateway act: fund the wallets first (pnpm --filter @payminto/demo fund:testnet ${cfg.chainId} --yes): ${short.join("; ")}`);
    say(`two shoppers, an x402 agent, a mandate agent and a flagged wallet each hold at least ${usdcText(A.payerFunds)} USDC (funded testnet wallets)`);
  }

  // ---------------------------------------------------------------- operator onboards Northwind Data
  // The platform owner's dashboard session (the apiKey is a placeholder: the session fetch sends the cookie instead).
  const operator = new GatewayClient({ nodeUrl, apiKey: "dashboard-session", fetch: stack.session.fetch });
  const plan = await operator.feePlans.create(northwindPlan(A));
  const created = await operator.merchants.create({
    name: "Northwind Data",
    slug: "northwind-data",
    support_email: "billing@northwind.example",
    brand_color: "#0f766e",
    fee_plan_id: plan.id,
    payout: await signPayoutProof(acct(gw.keys.merchantPayout), "new", { chainId: cfg.chainId, hub: stack.hub }),
  });
  const methods = await operator.merchants.setMethods(created.id, [depositFee(A)]);
  const deposit = methods.items.find((m) => m.method === "deposit")!;
  const key = await operator.forMerchant(created.id).apiKeys.create("northwind-server");
  await addBusinessAdmin(stack, created.id, "admin@northwind.demo.local", "Northwind Admin");
  say(`operator created merchant Northwind Data (${created.id}): plan 0.5 % + ${usdcText(A.planFixed)} USDC, deposit fee ${usdcText(A.depositFee)} USDC borne by the customer, API key ${key.prefix}...`);

  // ---------------------------------------------------------------- merchant: webhook endpoint and one link
  const merchant = new GatewayClient({ nodeUrl, apiKey: key.secret });
  let secret: string | null = null;
  const webhookMode: GatewayResult["webhooks"]["mode"] = !cfg.live ? "local" : cfg.webhookUrl ? "public" : "skipped";
  const receiver = webhookMode === "local" ? await webhookReceiver(() => secret) : null;
  try {
    const endpoint =
      webhookMode === "skipped" ? null : await merchant.webhooks.create({ url: receiver?.url ?? cfg.webhookUrl!, events: ["*"], description: "Northwind order service" });
    secret = endpoint?.secret ?? null;
    if (webhookMode === "skipped") say("webhooks: skipped on this live network (no DEMO_WEBHOOK_URL; the node refuses private webhook targets on public chains)");
    const link = await merchant.links.create({ title: "Northwind market dataset", description: "Daily OHLC for HSK, BTC and ETH", amount: A.link }, { idempotencyKey: `northwind-dataset-${created.id}` });
    const payUrl = `${nodeUrl}/v1/pay/l/${link.slug}`;
    say(`merchant (API key) created link ${link.url}${endpoint ? ` and webhook endpoint ${endpoint.id}` : ""}; agents pay ${payUrl}`);

    const before = { merchant: await balanceOf(a.merchantPayout), platform: await balanceOf(a.platformFees) };
    const linkPayment = (method: "wallet" | "deposit") =>
      publicJson(`${nodeUrl}/v1/links/public/${link.slug}/payments`, { method: "POST", body: JSON.stringify({ method }) }).then((r) => {
        if (r.status !== 201) throw new Error(`link payment (${method}) failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
        return r.json as CheckoutView & { checkout_url: string };
      });
    const authorize = async (view: CheckoutView, key: Hex) => {
      const payer = acct(key);
      const signature = await payer.signTypedData(checkoutTypedData(view.authorization!, payer.address));
      return publicJson(`${nodeUrl}/v1/checkout/${view.id}/authorize`, { method: "POST", body: JSON.stringify({ payer: payer.address, signature }) });
    };
    const ids: Partial<Record<PaymentMethod, string>> = {};

    // ---------------------------------------------------------------- 1. a person pays with a wallet signature
    const walletView = await linkPayment("wallet");
    const walletPaid = await authorize(walletView, gw.keys.walletPayer);
    if (walletPaid.status !== 200) throw new Error(`wallet payment failed: ${JSON.stringify(walletPaid.json)}`);
    ids.wallet = walletView.id;
    say(`person 1 signed a TransferWithAuthorization to the payment's forwarder; the node relayed it: ${walletPaid.json.status}, tx ${walletPaid.json.txHash}`);
    if (walletPaid.json.txHash) txs.push({ what: "wallet payment (relayed EIP-3009)", hash: walletPaid.json.txHash });
    await until("the wallet flush", async () => (await balanceOf(walletView.deposit_address)) === 0n, wait);

    // ---------------------------------------------------------------- 2. a person pays by plain transfer
    const depositView = await linkPayment("deposit");
    ids.deposit = depositView.id;
    const sent = await rpc.wallet(gw.keys.depositPayer).writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [depositView.deposit_address, BigInt(depositView.amount_due)] });
    await rpc.pub.waitForTransactionReceipt({ hash: sent });
    txs.push({ what: "deposit transfer by the shopper", hash: sent });
    say(`person 2 sent ${depositView.amount_due} base units (price + deposit fee) to forwarder ${depositView.deposit_address}`);
    await until("the deposit credit", async () => (await merchant.payments.retrieve(depositView.id)).status === "paid", wait);
    await until("the deposit flush", async () => (await balanceOf(depositView.deposit_address)) === 0n, wait);
    say("the watcher credited it and the flush split the fee on chain");

    // ---------------------------------------------------------------- 3. a plain x402 agent pays with exact
    const exact = await payExact(payUrl, { account: acct(gw.keys.x402Agent), maxAmount: A.link, chainId: cfg.chainId });
    ids.x402 = exact.settlement.paymentId!;
    if (exact.settlement.txHash) txs.push({ what: "x402 exact payment (relayed EIP-3009)", hash: exact.settlement.txHash as Hex });
    await until("the x402 flush", async () => (await balanceOf(exact.requirement.payTo)) === 0n, wait);
    say(`x402 agent paid with exact (EIP-3009 to the payment's forwarder): ${exact.settlement.status}, tx ${exact.settlement.txHash}; flushed`);

    // ---------------------------------------------------------------- 4. a mandate agent pays over MCP with two vouchers
    const owner = new OwnerClient({ nodeUrl, chainId: cfg.chainId, hub: stack.hub, account: acct(cfg.keys.owner), publicClient: rpc.pub, fetch: stack.session.fetch });
    const policy = { perCallCap: ((A.link * 5n) / 4n).toString(), dailyCap: A.mandateCap.toString(), maxCallsPerMinute: 60, purpose: "Procurement Agent: buys Northwind datasets" };
    const payees = [a.merchantPayout, a.platformFees];
    const m = await owner.createMandate({ agent: a.mandateAgent, token, totalCap: A.mandateCap, validForSeconds: 12 * 3600, payees, policy });
    const signer = new AgentClient({ chainId: cfg.chainId, hub: stack.hub, nodeUrl, account: acct(gw.keys.mandateAgent), mandateId: m.mandateId });
    const permit = await signer.signPermit({ token, value: A.mandateCap, publicClient: rpc.pub });
    signer.close();
    const opened = (await owner.submit({ ...m, policy, payees, label: "Procurement Agent", permit })) as { status: string; openTxHash?: string | null };
    if (opened.status !== "open") throw new Error(`Procurement Agent mandate is ${opened.status}, expected open`);
    if (opened.openTxHash) {
      txs.push({ what: "Procurement Agent mandate opened with its permit (node-paid gas)", hash: opened.openTxHash as Hex });
      await rpc.pub.waitForTransactionReceipt({ hash: opened.openTxHash as Hex });
    }
    // The node would deny the first voucher if a lagging public RPC still served it the pre-permit allowance.
    for (let streak = 0, i = 0; cfg.live && streak < 3; i++) {
      if (i >= 30) throw new Error("gateway act: the Procurement Agent's permit allowance is not visible on the RPC after 60 s");
      const allowance = await rpc.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [a.mandateAgent, stack.hub] });
      streak = allowance >= A.mandateCap ? streak + 1 : 0;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    const storePath = join(stack.runDir, "agent-procurement.receipts.demo.db");
    assertDisposableTarget(storePath);
    const wallet = await AgentWallet.connect({ nodeUrl, chainId: cfg.chainId, hub: stack.hub, agentKey: gw.keys.mandateAgent, mandateId: m.mandateId, rpcUrl: rpc.rpcUrl, receiptStorePath: storePath });
    const server = createMcpServer(wallet);
    const mcp = new Client({ name: "procurement-agent", version: "0.1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await mcp.connect(ct);
    let toolText = "";
    let listed = false;
    try {
      const services = (await mcp.callTool({ name: "list_paid_services", arguments: {} })) as { content: Array<{ text: string }> };
      listed = services.content[0]!.text.includes(link.id);
      const r = (await mcp.callTool({ name: "pay_link", arguments: { url: payUrl } })) as { isError?: boolean; content: Array<{ text: string }> };
      toolText = r.content[0]!.text;
      if (r.isError) throw new Error(`pay_link failed: ${toolText}`);
      const paid = JSON.parse(toolText.slice(toolText.indexOf("\n\n") + 2)) as { paymentId: string };
      ids.voucher = paid.paymentId;
      say(`Procurement Agent (MCP pay_link): ${toolText.split("\n")[0]}`);
      const s = await settle(stack, { say });
      if (s.skipped) throw new Error(`voucher settlement skipped: ${s.skipped}`);
      for (const id of s.batchIds) {
        const b = (await stack.admin.get(`/v1/batches/${id}`, z.object({ txHash: z.string().nullable() }).loose())) as { txHash: string | null };
        if (b.txHash) txs.push({ what: "voucher settlement batch (settleBatch)", hash: b.txHash as Hex });
      }
      say(`settled the vouchers in the next clearing batch ${s.batchIds[0] ?? "-"}`);
    } finally {
      await mcp.close();
      await server.close();
      wallet.close();
    }

    // ---------------------------------------------------------------- refund, gasless, by the merchant payout
    const payoutTx0 = await rpc.pub.getTransactionCount({ address: a.merchantPayout });
    const refund = await merchant.refunds.create({ paymentId: ids.wallet, amount: A.refund, reason: "one file was corrupt" }, { idempotencyKey: `refund-${ids.wallet}` });
    const message = { from: a.merchantPayout, to: refund.authorization!.router, value: A.refund, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: refund.authorization!.nonce };
    const refundSig = await acct(gw.keys.merchantPayout).signTypedData(receiveAuthorizationTypedData(domain, message));
    const refunded = await merchant.refunds.submit(refund.id, {
      authorization: { ...message, value: message.value.toString(), validAfter: "0", validBefore: message.validBefore.toString(), signature: refundSig },
    });
    let final = refunded;
    if (cfg.live && final.status !== "succeeded") final = await until("the refund", async () => {
      const r = await merchant.refunds.retrieve(refund.id);
      return r.status === "succeeded" || r.status === "failed" ? r : null;
    }, wait);
    if (final.tx_hash) txs.push({ what: "gasless refund through the router", hash: final.tx_hash as Hex });
    const payoutTransactions = (await rpc.pub.getTransactionCount({ address: a.merchantPayout })) - payoutTx0;
    say(`refund ${refund.id}: the payout signed, the node relayed through the router: ${final.status}, payout sent ${payoutTransactions} transactions`);

    // ---------------------------------------------------------------- intake screening refusal
    await merchant.screening.deny(a.flagged, "chargeback fraud on a previous order");
    const flaggedView = await linkPayment("wallet");
    const refused = await authorize(flaggedView, gw.keys.flagged);
    const decisions = await merchant.screening.decisions();
    const decision = decisions.items.find((d) => d.payer === a.flagged && d.payment_id === flaggedView.id);
    const screening = {
      payer: a.flagged,
      httpStatus: refused.status,
      code: (refused.json?.error?.code as string | undefined) ?? null,
      rule: (refused.json?.error?.details?.rule as string | undefined) ?? null,
      recorded: decision?.rule === "PAYER_DENIED",
    };
    say(`flagged wallet on the deny list: HTTP ${screening.httpStatus} ${screening.code} ${screening.rule}, decision ${screening.recorded ? "recorded" : "MISSING"}`);

    // ---------------------------------------------------------------- collect
    const details: Array<[PaymentMethod, PaymentDetail]> = [];
    for (const method of ["wallet", "deposit", "x402", "voucher"] as const) details.push([method, await merchant.payments.retrieve(ids[method]!)]);
    const payerOf: Record<PaymentMethod, string> = { wallet: "person, wallet", deposit: "person, transfer", x402: "x402 agent", voucher: "MCP agent", hsp: "HSP payer" };
    const payments: GatewayPaymentRow[] = details.map(([method, p]) => {
      const fees = computeFees({ amount: p.amount, plan, method: methods.items.find((x) => x.method === method)! });
      const last = [...p.credits].reverse().find((c) => c.tx_hash) ?? null;
      return {
        method,
        payer: payerOf[method],
        paymentId: p.id,
        status: p.status,
        amountDue: BigInt(p.amount_due),
        fee: BigInt(p.fee_total),
        net: BigInt(p.net_amount),
        expectedFee: fees.fee_total,
        tx: last?.tx_hash ?? null,
        batchId: p.credits.find((c) => c.batch_id)?.batch_id ?? null,
        depositAddress: p.deposit_address,
      };
    });

    // Every terminal event of the act must arrive at the receiver, signed.
    const expected = [...payments.map((p) => `payment.paid ${p.paymentId}`), `refund.succeeded ${refund.id}`];
    // A local receiver verifies each signature itself and knows the object; a public receiver is judged by the node's
    // delivery status, matched by event type and count. Skipped: nothing is expected.
    const missingNow = async (): Promise<string[]> => {
      if (receiver) return expected.filter((e) => !receiver.received.some((r) => r.verified && `${r.type} ${r.objectId}` === e));
      if (!endpoint) return [];
      const ok = (await merchant.webhooks.deliveries(endpoint.id, { limit: 200 })).items.filter((d) => d.status === "succeeded").map((d) => d.event_type as string);
      return expected.map((e) => e.split(" ")[0]!).filter((t, i, all) => ok.filter((x) => x === t).length < all.slice(0, i + 1).filter((x) => x === t).length);
    };
    await until("the webhooks", async () => (await missingNow()).length === 0, cfg.live ? 120_000 : 20_000).catch(() => null);
    const deliveriesFinal = endpoint ? await merchant.webhooks.deliveries(endpoint.id, { limit: 200 }) : { items: [] };

    const earnings = await operator.platform.fees();
    const platformEarned = earnings.items.filter((i) => i.merchant_id === created.id).reduce((s, i) => s + BigInt(i.fee_total), 0n);
    const forwarders = [];
    for (const p of payments.filter((x) => x.method === "deposit" || x.method === "x402")) forwarders.push({ method: p.method, address: p.depositAddress, balance: await balanceOf(p.depositAddress) });
    const expectedMerchantDelta = payments.reduce((s, p) => s + p.net, 0n) - BigInt(final.amount);
    const expectedPlatformDelta = payments.reduce((s, p) => s + p.fee, 0n);
    const balances = {
      merchantDelta: (await settledBalance(a.merchantPayout, before.merchant + expectedMerchantDelta)) - before.merchant,
      expectedMerchantDelta,
      platformDelta: (await settledBalance(a.platformFees, before.platform + expectedPlatformDelta)) - before.platform,
      expectedPlatformDelta,
      platformEarned,
      forwarders,
      router: await settledBalance(created.payment_router, 0n),
      hub: await settledBalance(stack.hub, 0n),
    };

    // The finance view: the reconciliation report for the act's range must hold exactly these payments and refund.
    const rep = await merchant.reconciliation({ from: startedAt, to: new Date(Date.now() + 60_000) });
    const csv = await fetch(`${nodeUrl}/v1/reports/reconciliation?from=${encodeURIComponent(startedAt.toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&format=csv`, {
      headers: { authorization: `Bearer ${key.secret}` },
    }).then((r) => (r.ok ? r.text() : ""));
    const report: GatewayResult["report"] = {
      payments: rep.totals.payments,
      paid: rep.counts.paid ?? 0,
      net: BigInt(rep.totals.base_units.net),
      refunds: BigInt(rep.totals.base_units.refunds),
      expectedNet: payments.reduce((s, p) => s + p.net, 0n),
      ledgerMatches: rep.ledger.matches,
      // Header and totals row aside, one line per payment.
      csvRows: Math.max(0, csv.trim().split("\n").length - 2),
    };
    say(`reconciliation report: ${report.payments} payments (${report.paid} paid), net ${usdcText(report.net)}, refunds ${usdcText(report.refunds)}, ledger ${report.ledgerMatches ? "matches" : "DIFFERS"}; CSV ${report.csvRows} rows`);

    // Proof of the wallet payment, as the receipt page checks it: final tx, the Transfer to the payout, the payer's
    // AuthorizationUsed, and the order hash recomputed from the canonical order.
    let proof: GatewayResult["proof"] = null;
    const pr = await publicJson(`${nodeUrl}/v1/checkout/${ids.wallet}/proof`);
    const order = await fetch(`${nodeUrl}/v1/checkout/${ids.wallet}/order`).then((r) => r.text());
    if (pr.status === 200) {
      const credit = pr.json.credits[0] as Json;
      const wallet = payments.find((p) => p.method === "wallet")!;
      proof = {
        paymentId: ids.wallet,
        method: credit.method,
        finality: credit.finality,
        // The wallet payment is the payer's Transfer to the payment's forwarder (the flush split it afterwards).
        forwarderTransfer: (credit.transfers as Json[]).some((t) => t.from === a.walletPayer && t.to === walletView.deposit_address && BigInt(t.value) === wallet.amountDue),
        authorizedByPayer: (credit.authorization_used as Json[]).some((u) => u.authorizer === a.walletPayer),
        orderHashMatches: keccak256(toBytes(order)) === pr.json.order_hash,
      };
    }

    return {
      merchant: { id: created.id, name: created.name, payout: created.payout, plan, deposit },
      link: { id: link.id, slug: link.slug, url: link.url, payUrl, amount: A.link },
      payments,
      mcp: { listed, toolText },
      refund: { id: refund.id, paymentId: ids.wallet, amount: BigInt(final.amount), status: final.status, txHash: final.tx_hash, payoutTransactions },
      screening,
      webhooks: {
        mode: webhookMode,
        received: receiver?.received ?? [],
        delivered: deliveriesFinal.items.filter((d) => d.status === "succeeded").length,
        deliveriesNotOk: deliveriesFinal.items.filter((d) => d.status !== "succeeded").length,
        missing: await missingNow(),
      },
      balances,
      proof,
      report,
      txs,
      ms: Date.now() - t0,
    };
  } catch (err) {
    if (err instanceof NodeApiError) throw new Error(`gateway act: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ""}`);
    throw err;
  } finally {
    await receiver?.close();
  }
}

const usdcText = (v: bigint) => formatAmount(v, 6);

/** The properties the gateway act promises; the CLI prints them and the test asserts them. */
export function checkGateway(r: GatewayResult): string[] {
  const p: string[] = [];
  for (const m of ["wallet", "deposit", "x402", "voucher"] as const) {
    const row = r.payments.find((x) => x.method === m);
    if (!row) p.push(`no ${m} payment`);
    else {
      if (row.status !== "paid") p.push(`${m} payment is ${row.status}, expected paid`);
      if (row.fee !== row.expectedFee) p.push(`${m} fee ${row.fee} differs from computeFees ${row.expectedFee}`);
      if (row.net + row.fee !== row.amountDue) p.push(`${m}: net + fee != amount due`);
    }
  }
  const dep = r.payments.find((x) => x.method === "deposit");
  if (dep && dep.amountDue !== r.link.amount + BigInt(r.merchant.deposit.fee_fixed)) p.push(`deposit amount due ${dep.amountDue} does not carry the customer-borne fee`);
  if (!r.mcp.listed) p.push("list_paid_services did not list the link");
  if (r.refund.status !== "succeeded") p.push(`refund is ${r.refund.status}`);
  if (r.refund.payoutTransactions !== 0) p.push(`the payout sent ${r.refund.payoutTransactions} transactions for a gasless refund`);
  const b = r.balances;
  if (b.merchantDelta !== b.expectedMerchantDelta) p.push(`merchant balance moved ${b.merchantDelta}, fee breakdowns say ${b.expectedMerchantDelta}`);
  if (b.platformDelta !== b.expectedPlatformDelta) p.push(`platform balance moved ${b.platformDelta}, fee breakdowns say ${b.expectedPlatformDelta}`);
  if (b.platformEarned !== b.expectedPlatformDelta) p.push(`platform earnings report ${b.platformEarned}, expected ${b.expectedPlatformDelta}`);
  for (const f of b.forwarders) if (f.balance !== 0n) p.push(`${f.method} forwarder ${f.address} still holds ${f.balance}`);
  if (b.forwarders.length !== 2) p.push(`checked ${b.forwarders.length} forwarders, expected 2`);
  if (b.router !== 0n) p.push(`router holds ${b.router}`);
  if (b.hub !== 0n) p.push(`hub holds ${b.hub} after the voucher batch`);
  const w = r.webhooks;
  if (w.mode === "local") {
    if (w.received.length === 0) p.push("no webhook received");
    const bad = w.received.filter((x) => !x.verified);
    if (bad.length) p.push(`${bad.length} webhooks failed verification: ${bad[0]!.error}`);
  }
  if (w.mode !== "skipped") {
    if (w.missing.length) p.push(`webhooks not received: ${w.missing.join(", ")}`);
    if (w.deliveriesNotOk) p.push(`${w.deliveriesNotOk} webhook deliveries did not succeed`);
  }
  const rep = r.report;
  if (!rep) p.push("no reconciliation report");
  else {
    if (rep.paid !== 4) p.push(`reconciliation report lists ${rep.paid} paid payments, expected 4`);
    if (rep.net !== rep.expectedNet) p.push(`reconciliation report net ${rep.net}, the payments say ${rep.expectedNet}`);
    if (rep.refunds !== r.refund.amount) p.push(`reconciliation report refunds ${rep.refunds}, expected ${r.refund.amount}`);
    if (!rep.ledgerMatches) p.push("reconciliation report: agent charges differ from the ledger");
    if (rep.csvRows !== rep.payments) p.push(`reconciliation CSV has ${rep.csvRows} rows for ${rep.payments} payments`);
  }
  if (r.screening.httpStatus !== 403 || r.screening.code !== "SCREENING_REFUSED" || r.screening.rule !== "PAYER_DENIED") {
    p.push(`flagged payer was not refused by screening (HTTP ${r.screening.httpStatus} ${r.screening.code} ${r.screening.rule})`);
  }
  if (!r.screening.recorded) p.push("screening decision not recorded");
  if (!r.proof) p.push("no proof for the wallet payment");
  else if (r.proof.finality !== "final" || !r.proof.forwarderTransfer || !r.proof.authorizedByPayer || !r.proof.orderHashMatches) p.push(`proof check failed: ${JSON.stringify(r.proof)}`);
  return p;
}
