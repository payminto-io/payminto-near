/**
 * HSP payment method (docs/GATEWAY.md section 17) end to end: anvil with the gateway contracts, the node in-process on
 * a temp SQLite file with workers off (each tick is driven by the test), and the local HSP stand-in MCP server, whose
 * submit_payment really broadcasts the payer's EIP-3009 authorization. Never talks to HashKey.
 * Covers: availability (allowlist 403, network and token mismatch, unreachable at boot), the method toggle, a person's
 * payment from prepare to a split fee and a webhook carrying the HSP fields, an agent paying a link with payHsp,
 * requote on error 30043 and on an expired quote, duplicate submits, and refusals of mismatched submits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { erc20Abi, type Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeHeader,
  depositFactoryAbi,
  depositFactoryBytecode,
  HEADER_REQUIRED,
  hspAgenticTypedData,
  hspBaseUnits,
  hspUsdAmount,
  networkFor,
  paymentRouterAbi,
  paymentRouterBytecode,
  verifyWebhook,
  type HspEip712Json,
} from "@payminto/protocol";
import { payHsp } from "@payminto/sdk";
import { startNode, type ClearingNode } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import { ConfigError, loadConfig, type GatewayConfig } from "../src/config.ts";
import type { Gateway } from "../src/gateway/index.ts";
import { hspErrorCode, toolPayload } from "../src/hsp/agentic.ts";
import { ANVIL_KEYS, deployClearing, freePort, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";
import { startHspStandin, type HspStandin } from "./support/hsp-standin.ts";

const ADMIN = "test-admin-token-123";
const USDC = 1_000_000n;
const TEAM = "Payminto Horizon Team";
const PAYER = privateKeyToAccount(ANVIL_KEYS[2]);
const PAYER_2 = privateKeyToAccount(ANVIL_KEYS[3]);
const AGENT = privateKeyToAccount(ANVIL_KEYS[4]);
const PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]);
const FEES = privateKeyToAccount(ANVIL_KEYS[7]).address;

let anvil: Anvil;
let node: ClearingNode;
let g: Gateway;
let hsp: HspStandin;
let token: Address;
let gatewayConfig: GatewayConfig;
let secret = "";
const tmp = tempDir("payminto-hsp-pay-");

async function api<T = any>(method: string, path: string, body?: unknown, auth: "admin" | "none" | string = "admin") {
  const res = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth === "none" ? {} : { authorization: `Bearer ${auth === "admin" ? ADMIN : auth}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

const balanceOf = (who: Address) => anvil.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const sign = (eip712: HspEip712Json, account = PAYER) => account.signTypedData(hspAgenticTypedData(eip712) as Parameters<typeof account.signTypedData>[0]);
const calls = (tool: string) => hsp.calls.filter((c) => c === tool).length;
/** One poller round for this payment now, whatever HSP_POLL_INTERVAL_MS says. */
const pollNow = async (paymentId: string) => {
  node.services.db.run("UPDATE payments SET hsp_next_poll_unix = 0 WHERE id = ? AND hsp_next_poll_unix IS NOT NULL", paymentId);
  await g.hsp!.tick();
};
/** Mines the HSP gateway's broadcast before the watcher looks (anvil automines; this only waits for the receipt). */
const mined = async (paymentId: string) => {
  const tx = g.payments.row(paymentId)!.hsp_tx_hash;
  if (tx) await anvil.pub.waitForTransactionReceipt({ hash: tx });
};

beforeAll(async () => {
  anvil = await startAnvil();
  const c = await deployClearing(anvil);
  token = c.token;
  const factory = await anvil.deploy(depositFactoryAbi as Abi, depositFactoryBytecode);
  const router = await anvil.deploy(paymentRouterAbi as Abi, paymentRouterBytecode);
  hsp = await startHspStandin({ anvil, token, tokenDomain: networkFor(31337).token.eip712, broadcasterKey: ANVIL_KEYS[8] });
  gatewayConfig = {
    seedPayout: PAYOUT.address,
    platformName: "Northwind Data",
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
    hsp: { mcpUrl: hsp.url, merchantName: TEAM, pollIntervalMs: 1000 },
  };
  // The 402's prepare and submit URLs are absolute (PUBLIC_URL), so the node listens where its public URL says.
  const port = await freePort();
  node = await startNode(testConfig({ rpcUrl: anvil.rpcUrl, hub: c.hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, publicUrl: `http://127.0.0.1:${port}`, gateway: gatewayConfig }), {
    logger: silentLogger,
    port,
    workers: false,
  });
  g = node.services.gateway!;
  for (const p of [PAYER, PAYER_2, AGENT]) await mint(anvil, token, p.address, 100n * USDC);
  secret = (await api("POST", "/v1/api-keys", { name: "server" })).json.secret;
}, 120_000);

afterAll(async () => {
  await node?.stop();
  await hsp?.close();
  anvil?.stop();
  tmp.cleanup();
});

describe("HSP availability", () => {
  it("turns the method on once get_chain_config lists this node's chain id and token", async () => {
    expect((await g.hsp!.check()).state).toBe("available");
    const s = await api("GET", "/v1/hsp/status", undefined, secret);
    expect(s.json).toMatchObject({ configured: true, merchant_name: TEAM, state: "available", reason: null, network: "hashkey-local", protocol: "eip3009" });
    expect((await api("GET", "/v1/info", undefined, "none")).json.gateway.hspPayments).toMatchObject({ state: "available" });
  });

  it("is off for a business until it enables HSP in its payment methods", async () => {
    const off = await api("POST", "/v1/payments", { amount: "1000000", method: "hsp" }, secret);
    expect(off.json.error).toMatchObject({ code: "METHOD_DISABLED" });
    const merchant = (await api("GET", "/v1/merchant", undefined, secret)).json;
    // A business key may switch a method on or off (fees stay the platform's).
    const on = await api("PUT", `/v1/merchants/${merchant.id}/methods`, { methods: [{ method: "hsp", enabled: true }] }, secret);
    expect(on.status).toBe(200);
    expect(on.json.items.find((m: { method: string }) => m.method === "hsp")).toMatchObject({ enabled: true });
  });

  it("says it is waiting for HSP access when HashKey answers 403, and refuses cleanly", async () => {
    hsp.forbid = true;
    try {
      expect(await g.hsp!.check()).toMatchObject({ state: "unavailable", reason: "not_allowlisted" });
      const p = await api("POST", "/v1/payments", { amount: "1000000" }, secret);
      const view = (await api("GET", `/v1/checkout/${p.json.id}`, undefined, "none")).json;
      expect(view.methods).not.toContain("hsp");
      expect(view.hsp).toMatchObject({ availability: "unavailable", message: expect.stringMatching(/^Waiting for HSP access/) });
      const prep = await api("POST", `/v1/checkout/${p.json.id}/hsp/prepare`, { payer: PAYER.address }, "none");
      expect(prep.status).toBe(503);
      expect(prep.json.error).toMatchObject({ code: "HSP_UNAVAILABLE", details: { reason: "not_allowlisted" } });
      expect((await api("POST", "/v1/payments", { amount: "1000000", method: "hsp" }, secret)).json.error).toMatchObject({ code: "METHOD_UNAVAILABLE" });
      const pr = decodeHeader<{ accepts: Array<{ scheme: string }> }>((await fetch(`${node.url}/v1/pay/${p.json.id}`)).headers.get(HEADER_REQUIRED))!;
      expect(pr.accepts.map((a) => a.scheme)).not.toContain("hsp");
    } finally {
      hsp.forbid = false;
    }
    expect((await g.hsp!.check()).state).toBe("available");
  });

  it("stays off when HSP lists another network or another token", async () => {
    const listed = { ...hsp.listed };
    try {
      hsp.listed = { ...listed, chainId: 133 };
      expect(await g.hsp!.check()).toMatchObject({ state: "unavailable", reason: "network_mismatch", message: expect.stringMatching(/network/) });
      hsp.listed = { ...listed, token: "0x0000000000000000000000000000000000000001" };
      expect(await g.hsp!.check()).toMatchObject({ state: "unavailable", reason: "token_mismatch" });
    } finally {
      hsp.listed = listed;
    }
    expect((await g.hsp!.check()).state).toBe("available");
  });
});

describe("HSP payments", () => {
  it("pays a payment end to end: prepare, sign, submit, poll, forwarder, paid, fee split and a webhook with the HSP fields", async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    const hooks: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => hooks.listen(0, "127.0.0.1", () => r()));
    try {
      const endpoint = await api("POST", "/v1/webhooks", { url: `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hooks`, events: ["payment.paid"] }, secret);
      const p = (await api("POST", "/v1/payments", { amount: "2000000", description: "Market data, October" }, secret)).json;
      const view = (await api("GET", `/v1/checkout/${p.id}`, undefined, "none")).json;
      expect(view.methods).toContain("hsp");
      expect(view.hsp).toMatchObject({ availability: "available", status: null });

      const prep = await api("POST", `/v1/checkout/${p.id}/hsp/prepare`, { payer: PAYER.address }, "none");
      expect(prep.status).toBe(200);
      const row = g.payments.row(p.id)!;
      expect(row).toMatchObject({ quote_method: "hsp", hsp_status: "order-created", fee_total: "10000", net_amount: "1990000" });
      expect(prep.json).toMatchObject({ payment_id: p.id, protocol: "eip3009", token_total_raw: row.amount_due, recipient: row.deposit_address, payer: PAYER.address });
      expect(Date.parse(prep.json.quote_expires_at)).toBeGreaterThan(Date.now());
      // One order, paid into this payment's own forwarder, under the team's reporting name, in USD.
      const order = hsp.orders.get(row.hsp_flow_id!)!;
      expect(order).toMatchObject({ pay_to: row.deposit_address, merchant_name: TEAM, value: "2.00" });
      expect((order.cart as { id: string; cart_expiry: string }).id).toBe(p.id);
      expect((order.cart as { cart_expiry: string }).cart_expiry).toBe(row.expires_at);

      const signature = await sign(prep.json.eip712);
      const sub = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature }, "none");
      expect(sub.status).toBe(200);
      expect(sub.json).toMatchObject({ status: "open", hsp: { flow_id: row.hsp_flow_id, status: "payment-submitted", payer: PAYER.address } });
      // The same signature again is the same answer, and HSP sees one submission.
      const again = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature }, "none");
      expect(again.json.hsp.status).toBe("payment-submitted");
      expect(calls("submit_payment")).toBe(1);
      // The checkout is held while HSP is on its way; nothing else can pay it twice.
      expect((await api("GET", `/v1/checkout/${p.id}`, undefined, "none")).json.methods).toEqual([]);
      // An HSP status alone never makes a payment paid.
      expect(g.payments.row(p.id)!.status).toBe("open");

      await mined(p.id);
      await g.hsp!.tick();
      const polled = g.payments.row(p.id)!;
      expect(polled).toMatchObject({ hsp_status: "payment-included", hsp_attribution_verified: 1, status: "open" });
      expect(polled.hsp_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

      // The existing deposit watcher sees the HSP gateway's transfer land in the forwarder.
      await g.watcher.tick();
      const paid = g.payments.row(p.id)!;
      expect(paid).toMatchObject({ status: "paid", amount_paid: "2000000", payer: PAYER.address });
      expect(g.payments.credits(p.id)).toMatchObject([{ method: "deposit", payer: PAYER.address, amount: "2000000", tx_hash: polled.hsp_tx_hash, status: "confirmed" }]);

      const [payout0, fees0] = [await balanceOf(PAYOUT.address), await balanceOf(FEES)];
      await g.flusher.tick();
      expect(await balanceOf(row.deposit_address)).toBe(0n);
      expect(await balanceOf(PAYOUT.address)).toBe(payout0 + 1_990_000n);
      expect(await balanceOf(FEES)).toBe(fees0 + 10_000n);

      await pollNow(p.id);
      expect(g.payments.row(p.id)!.hsp_status).toBe("payment-safe");
      await pollNow(p.id);
      expect(g.payments.row(p.id)).toMatchObject({ hsp_status: "payment-finalized", hsp_next_poll_unix: null });
      const queries = calls("query_payment");
      await pollNow(p.id);
      expect(calls("query_payment")).toBe(queries); // final: polling stopped

      const detail = (await api("GET", `/v1/payments/${p.id}`, undefined, secret)).json;
      expect(detail).toMatchObject({ method: "hsp", status: "paid", hsp: { flow_id: row.hsp_flow_id, status: "payment-finalized", attribution_verified: true, tx_hash: polled.hsp_tx_hash } });

      await g.webhooks.tick();
      const event = received.find((r) => r.headers["payminto-event-type"] === "payment.paid")!;
      expect(await verifyWebhook(event.body, event.headers["payminto-signature"] as string, endpoint.json.secret)).toBe(true);
      expect(JSON.parse(event.body).data.object).toMatchObject({ id: p.id, method: "hsp", fee_total: "10000", hsp: { flow_id: row.hsp_flow_id, tx_hash: polled.hsp_tx_hash, attribution_verified: true } });
    } finally {
      hooks.close();
    }
  });

  it("lets an agent pay a link with payHsp from the 402's hsp offer", async () => {
    const link = (await api("POST", "/v1/links", { title: "Risk score", amount: "500000" }, secret)).json;
    const url = `${node.url}/v1/pay/l/${link.slug}`;
    const pr = decodeHeader<{ accepts: Array<Record<string, any>> }>((await fetch(url)).headers.get(HEADER_REQUIRED))!;
    const offer = pr.accepts.find((a) => a.scheme === "hsp")!;
    expect(offer).toMatchObject({ amount: "500000", asset: token, network: "eip155:31337", extra: { prepareUrl: expect.stringContaining("/hsp/prepare") } });

    const prepares = calls("prepare_payment");
    await expect(payHsp(url, { account: AGENT, maxAmount: 499_999n })).rejects.toMatchObject({ code: "MAX_AMOUNT" });
    expect(calls("prepare_payment")).toBe(prepares); // refused before anything was prepared or signed

    // The node's workers are off in this suite: drive the HSP poller and the deposit watcher while the agent waits.
    const ticker = setInterval(() => {
      node.services.db.run("UPDATE payments SET hsp_next_poll_unix = 0 WHERE hsp_next_poll_unix IS NOT NULL");
      void g.hsp!.tick().then(() => g.watcher.tick()).catch(() => {});
    }, 100);
    try {
      const out = await payHsp(url, { account: AGENT, maxAmount: 500_000n, pollMs: 100, timeoutMs: 30_000 });
      expect(out).toMatchObject({ status: "paid", attributionVerified: true });
      expect(out.hspStatus).toMatch(/^payment-(included|safe|finalized)$/);
      expect(g.payments.row(out.paymentId)).toMatchObject({ link_id: link.id, draft: 0, quote_method: "hsp", payer: AGENT.address, status: "paid" });
    } finally {
      clearInterval(ticker);
    }
  });

  it("prepares again when HSP answers 30043 or the quote expired, and never resends an old signature", async () => {
    const p = (await api("POST", "/v1/payments", { amount: "300000" }, secret)).json;
    const first = (await api("POST", `/v1/checkout/${p.id}/hsp/prepare`, { payer: PAYER.address }, "none")).json;
    const sig1 = await sign(first.eip712);
    hsp.failNextSubmit = 30043;
    const refused = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature: sig1 }, "none");
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "HSP_QUOTE_EXPIRED", details: { hsp_code: 30043 } });
    const submits = calls("submit_payment");
    expect((await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature: sig1 }, "none")).json.error.code).toBe("HSP_QUOTE_EXPIRED");
    expect(calls("submit_payment")).toBe(submits);

    // A quote past quote_expires_at is refused before HSP is asked.
    const second = (await api("POST", `/v1/checkout/${p.id}/hsp/prepare`, { payer: PAYER.address }, "none")).json;
    expect(second.eip712.message.nonce).not.toBe(first.eip712.message.nonce);
    node.services.db.run("UPDATE hsp_quotes SET quote_expires_unix = ? WHERE payment_id = ? AND status = 'prepared'", Math.floor(Date.now() / 1000) - 1, p.id);
    const late = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature: await sign(second.eip712) }, "none");
    expect(late.json.error.code).toBe("HSP_QUOTE_EXPIRED");
    expect(calls("submit_payment")).toBe(submits);

    const third = (await api("POST", `/v1/checkout/${p.id}/hsp/prepare`, { payer: PAYER.address }, "none")).json;
    const ok = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature: await sign(third.eip712) }, "none");
    expect(ok.json.hsp).toMatchObject({ status: "payment-submitted" });
    // Still one HSP order for the payment, reused by every prepare.
    expect([...hsp.orders.values()].filter((o) => (o.cart as { id: string }).id === p.id)).toHaveLength(1);
    await mined(p.id);
    await g.watcher.tick();
    expect(g.payments.row(p.id)!.status).toBe("paid");
  });

  it("refuses a submit from a payer that did not prepare, a wrong signature, and a quote the payment no longer matches", async () => {
    const p = (await api("POST", "/v1/payments", { amount: "400000" }, secret)).json;
    const prep = (await api("POST", `/v1/checkout/${p.id}/hsp/prepare`, { payer: PAYER.address }, "none")).json;
    const notPrepared = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER_2.address, signature: await sign(prep.eip712, PAYER_2) }, "none");
    expect(notPrepared.json.error.code).toBe("HSP_NOT_PREPARED");
    const wrongSigner = await api("POST", `/v1/checkout/${p.id}/hsp/submit`, { payer: PAYER.address, signature: await sign(prep.eip712, PAYER_2) }, "none");
    expect(wrongSigner.status).toBe(400);
    expect(wrongSigner.json.error.code).toBe("BAD_SIGNATURE");

    // A customer-borne HSP fee makes the HSP quote differ from the wallet quote: the person switches method after
    // preparing, so the prepared quote no longer pays this payment's forwarder for its amount due.
    const merchant = (await api("GET", "/v1/merchant", undefined, secret)).json;
    await api("PUT", `/v1/merchants/${merchant.id}/methods`, { methods: [{ method: "hsp", fee_bps: 100, bearer: "customer" }] });
    try {
      const q = (await api("POST", "/v1/payments", { amount: "400000" }, secret)).json;
      const quoted = (await api("POST", `/v1/checkout/${q.id}/hsp/prepare`, { payer: PAYER.address }, "none")).json;
      expect(quoted.token_total_raw).toBe("404000");
      expect((await api("POST", `/v1/checkout/${q.id}/method`, { method: "wallet" }, "none")).json.amount_due).toBe("400000");
      const stale = await api("POST", `/v1/checkout/${q.id}/hsp/submit`, { payer: PAYER.address, signature: await sign(quoted.eip712) }, "none");
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe("HSP_QUOTE_MISMATCH");
      expect(g.payments.row(q.id)).toMatchObject({ status: "open", hsp_status: "order-created" });
    } finally {
      await api("PUT", `/v1/merchants/${merchant.id}/methods`, { methods: [{ method: "hsp", fee_bps: 0, bearer: "merchant" }] });
    }
  });
});

describe("HSP client and config", () => {
  it("reads tool payloads and HSP error codes", () => {
    expect(toolPayload({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
    expect(toolPayload({ content: [{ type: "text", text: '{"flow_id":"f"}' }] })).toEqual({ flow_id: "f" });
    expect(hspErrorCode({ code: 30043, message: "expired" })).toBe(30043);
    expect(hspErrorCode({ error: { code: "30043" } })).toBe(30043);
    expect(hspErrorCode("gateway error 30043: quote expired")).toBe(30043);
    expect(hspErrorCode({ message: "nope" })).toBeNull();
    expect(hspUsdAmount(2_000_000n, 6)).toBe("2.00");
    expect(hspUsdAmount(1n, 6)).toBe("0.000001");
    expect(hspUsdAmount(1_234_500n, 6)).toBe("1.2345");
    expect(hspBaseUnits("1.2345", 6)).toBe(1_234_500n);
    expect(() => hspBaseUnits("0.0000001", 6)).toThrow();
  });

  it("needs HSP_MERCHANT_NAME with HSP_MCP_URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "payminto-hsp-config-"));
    writeFileSync(join(dir, "133.json"), JSON.stringify({ chainId: 133, clearingHub: "0x5FbDB2315678afecb367f032d93F642f64180aa3", blockNumber: 1, depositFactory: "0x5FbDB2315678afecb367f032d93F642f64180aa4", paymentRouter: "0x5FbDB2315678afecb367f032d93F642f64180aa5" }));
    const env = {
      CHAIN_ID: "133",
      DEPLOYMENTS_DIR: dir,
      OPERATOR_KEY: `0x${"11".repeat(32)}`,
      ADMIN_TOKEN: "x".repeat(40),
      GATEWAY_PAYOUT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      PUBLIC_CHECKOUT_URL: "https://pay.example.com",
    };
    expect(loadConfig(env).gateway!.hsp).toBeNull();
    expect(() => loadConfig({ ...env, HSP_MCP_URL: "https://mcp-qa.hashkeymerchant.com/" })).toThrow(ConfigError);
    expect(loadConfig({ ...env, HSP_MCP_URL: "https://mcp-qa.hashkeymerchant.com/", HSP_MERCHANT_NAME: TEAM }).gateway!.hsp).toEqual({
      mcpUrl: "https://mcp-qa.hashkeymerchant.com/",
      merchantName: TEAM,
      pollIntervalMs: 15_000,
    });
  });

  it("starts when HSP is unreachable and reports it", async () => {
    const t = tempDir("payminto-hsp-down-");
    const closed = await freePort();
    const down = await startNode(
      testConfig({
        rpcUrl: anvil.rpcUrl,
        hub: node.services.config.hub,
        token,
        dbPath: t.dbPath,
        adminToken: ADMIN,
        gateway: { ...gatewayConfig, hsp: { mcpUrl: `http://127.0.0.1:${closed}/`, merchantName: TEAM, pollIntervalMs: 1000 } },
      }),
      { logger: silentLogger, port: 0, workers: false },
    );
    try {
      expect(await down.services.gateway!.hsp!.check()).toMatchObject({ state: "unavailable", reason: "unreachable", message: "HSP is not answering right now." });
      expect((await fetch(`${down.url}/healthz`)).status).toBe(200);
    } finally {
      await down.stop();
      t.cleanup();
    }
  });
});

