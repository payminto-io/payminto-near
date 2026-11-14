/**
 * The any-chain invoice tools in the wallet server: an agent reads the ways to pay a live invoice, gets a deposit
 * address with the exact amount, token, network, deadline and payment URI, and reads whether it is paid, waiting or
 * returned. The node is an in-memory fetch that answers the documented public checkout routes and records every request,
 * so nothing here reaches a network, and the tests can see that no tool ever sends a key or asks anything but those routes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/config.ts";
import { INVOICE_TOOL_NAMES, InvoicePayer, registerInvoiceTools } from "../src/invoice.ts";
import { createMcpServer } from "../src/server.ts";
import type { AgentWallet } from "../src/wallet.ts";

const NODE = "http://node.test";
const CHECKOUT = "http://checkout.test";
const PAY = "pay_boxykimcem2hjper3q3nb53l";
const LINK_PAY = "pay_lnkpaymentaaaaaaaaaaaaaa";
const QID = "iq_ccbq7ktq3ypx2m3l3wmbqcbb";
const EVM_DEPOSIT = "0x87151c5ac911a4459762ce215649313cd369dc05";
const SOL_DEPOSIT = "mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN";
const REFUND = "0x2527d02599ba641c19fea793cd0f167589a0f10d";

const amt = (amount: string, formatted: string, symbol = "USDC") => ({ amount, formatted, symbol });
const origin = (chain: string, chain_name: string, symbol: string, decimals: number, contract_address: string | null, chain_id: number | null, asset: string) => ({ asset, chain, chain_name, symbol, decimals, contract_address, chain_id });
const ORIGINS = {
  "base:USDC": origin("base", "Base", "USDC", 6, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 8453, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"),
  "sol:USDC": origin("sol", "Solana", "USDC", 6, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", null, "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"),
  "base:ETH": origin("base", "Base", "ETH", 18, null, 8453, "nep141:base.omft.near"),
  "arb:USDC": origin("arb", "Arbitrum", "USDC", 6, "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 42161, "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
};
const SEND = { "base:USDC": amt("4509585", "4.509585"), "sol:USDC": amt("4509585", "4.509585"), "base:ETH": amt("1250000000000000", "0.00125", "ETH"), "arb:USDC": null };

type Seen = { method: string; path: string; headers: Record<string, string>; body: any };
type Mode = "simulated" | "live";

/** The node, in memory: one open invoice, its public link, and whatever quote a test puts there. */
class FakeNode {
  readonly seen: Seen[] = [];
  mode: Mode = "simulated";
  paymentStatus = "open";
  available = true;
  quote: Record<string, any> | null = null;
  postError: { status: number; body: unknown } | null = null;
  link: Record<string, any> = { slug: "coffee", active: true, amount: "4500000", collect_email: false, collect_name: false, intents: { mode: "simulated", label: "Simulated - no real money", offered: true, reason: null } };

  get label() {
    return this.mode === "live" ? "Live - NEAR mainnet" : "Simulated - no real money";
  }

  quoteFor(key: keyof typeof ORIGINS, refund: string | undefined, over: Record<string, unknown> = {}) {
    const o = ORIGINS[key];
    return {
      id: QID,
      object: "intents_quote",
      payment_id: PAY,
      mode: this.mode,
      label: this.label,
      status: "awaiting_deposit",
      provider_status: null,
      origin: o,
      deposit_address: o.chain === "sol" ? SOL_DEPOSIT : EVM_DEPOSIT,
      deposit_memo: null,
      send_exactly: SEND[key],
      min_amount_in: SEND[key],
      amount_out: amt("4500000", "4.500000"),
      amount_in_usd: "4.507570845505",
      fees: null,
      slippage_bps: 10,
      time_estimate_sec: 35,
      refund_to: refund === undefined ? "anychain.test.near" : `${refund.slice(0, 6)}...${refund.slice(-4)}`,
      refund_type: refund === undefined ? "INTENTS" : "ORIGIN_CHAIN",
      send_by: "2026-11-10T22:38:01.000Z",
      recipient: "anychain.test.near",
      settlement_network: "near:mainnet (simulated)",
      deadline: "2026-11-10T22:38:01.000Z",
      deadline_passed: false,
      inactive_at: "2026-11-10T22:38:01.000Z",
      deposited: null,
      delivered: null,
      refunded: null,
      refund_reason: null,
      origin_txs: [],
      destination_txs: [],
      near_txs: [],
      delivery_tx: null,
      verification: null,
      steps: [
        { key: "waiting", label: "Waiting for deposit", state: "current" },
        { key: "received", label: "Deposit received", state: "pending" },
      ],
      warning: `Send only ${o.symbol} on the ${o.chain_name} network, to this address.`,
      correlation_id: "0f8b2c1e",
      signature_valid: true,
      created_at: "2026-11-10T22:08:01.512Z",
      updated_at: "2026-11-10T22:08:01.512Z",
      ...over,
    };
  }

  #answer(r: Seen): { status: number; body: unknown } {
    const p = r.path;
    const known = (id: string) => id === PAY || id === LINK_PAY;
    if (r.method === "GET" && p === "/v1/info") return { status: 200, body: { publicUrl: NODE, gateway: { enabled: true, checkoutBaseUrl: CHECKOUT } } };
    if (r.method === "GET" && p === "/v1/links/public/coffee") return { status: 200, body: this.link };
    if (r.method === "POST" && p === "/v1/links/public/coffee/payments") return { status: 201, body: { id: LINK_PAY, status: "open" } };
    const m = /^\/v1\/checkout\/([^/]+)(\/.*)?$/.exec(p);
    if (!m || !known(m[1]!)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "payment not found" } } };
    const rest = m[2] ?? "";
    if (r.method === "GET" && rest === "") {
      return {
        status: 200,
        body: {
          id: m[1],
          status: this.paymentStatus,
          amount_due: "4500000",
          amount_paid: this.paymentStatus === "paid" ? "4500000" : "0",
          expires_at: "2026-11-10T23:00:00.000Z",
          merchant: { name: "Northwind\u0007 Coffee" },
          intents: { mode: this.mode, label: this.label, available: this.available, reason: this.available ? null : "This checkout expires too soon to pay from another chain.", settlement_network: "near:mainnet (simulated)", active_quote: this.quote },
        },
      };
    }
    if (r.method === "GET" && rest === "/intents/options") {
      return {
        status: 200,
        body: {
          object: "intents_options",
          payment_id: m[1],
          mode: this.mode,
          label: this.label,
          amount_out: amt("4500000", "4.500000"),
          recipient: "anychain.test.near",
          settlement_network: "near:mainnet (simulated)",
          quoted_at: "2026-11-10T22:08:00.000Z",
          valid_until: "2026-11-10T22:08:30.000Z",
          options: (Object.keys(ORIGINS) as Array<keyof typeof ORIGINS>).map((k) => ({
            origin: ORIGINS[k],
            available: SEND[k] !== null,
            reason: SEND[k] === null ? "The minimum on this network is $100." : null,
            slippage_bps: 10,
            amount_in: SEND[k],
            amount_in_usd: SEND[k] ? "4.51" : null,
            time_estimate_sec: SEND[k] ? 35 : null,
            fees: null,
          })),
        },
      };
    }
    if (r.method === "POST" && rest === "/intents/quotes") {
      if (this.postError) return this.postError;
      const key = (Object.keys(ORIGINS) as Array<keyof typeof ORIGINS>).find((k) => ORIGINS[k].asset === r.body.origin_asset)!;
      this.quote = this.quoteFor(key, r.body.refund_to);
      return { status: 201, body: this.quote };
    }
    if (r.method === "GET" && rest === `/intents/quotes/${QID}` && this.quote) return { status: 200, body: this.quote };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "no such quote for this payment" } } };
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== NODE) throw new Error(`the test reached outside the node: ${url.href}`);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const r: Seen = { method: init?.method ?? "GET", path: url.pathname, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    this.seen.push(r);
    const out = this.#answer(r);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

type Res = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any> };
const said = (r: Res) => r.content[0]!.text.split("\n\n")[0]!;

let node: FakeNode;
let client: Client;
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;

beforeEach(async () => {
  node = new FakeNode();
  const server = new McpServer({ name: "test", version: "1" });
  registerInvoiceTools(server, new InvoicePayer({ nodeUrl: `${NODE}/`, fetch: node.fetch }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "1" });
  await client.connect(ct);
});

afterEach(async () => {
  await client.close();
  // Whatever a test did, every request was a public checkout route, and none carried a key.
  for (const s of node.seen) {
    expect(s.headers.authorization).toBeUndefined();
    expect(s.path).toMatch(/^\/v1\/(info|checkout\/[^/]+(\/intents\/(options|quotes(\/[^/]+)?))?|links\/public\/[^/]+(\/payments)?)$/);
  }
});

describe("the invoice tools", () => {
  it("say the agent sends from its own wallet and never changes the amount or the address", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...INVOICE_TOOL_NAMES]);
    for (const t of tools) {
      expect(t.description).toContain("you send the deposit from your own wallet");
      expect(t.description).toContain("Never change the amount, the token, the network or the address");
    }
    expect(tools.find((t) => t.name === "invoice_status")!.annotations?.readOnlyHint).toBe(true);
  });
});

describe("invoice_pay_options", () => {
  it("lists the tokens that can pay an invoice, with estimates, and the greyed ones with their reason", async () => {
    const r = await call("invoice_pay_options", { invoice: PAY });
    expect(r.isError).toBeFalsy();
    expect(said(r)).toBe(
      `Invoice ${PAY}: the business receives 4.500000 USDC. Simulated - no real money. 3 of 4 options can pay it now: base:USDC about 4.509585 USDC, sol:USDC about 4.509585 USDC, base:ETH about 0.00125 ETH. ` +
        "Estimates only: invoice_deposit gives the exact amount. Call invoice_deposit with paymentId, an origin and your own refund address on that network.",
    );
    const res = r.structuredContent!.result;
    expect(res).toMatchObject({ paymentId: PAY, createdFromLink: false, paymentStatus: "open", merchant: "Northwind Coffee", mode: "simulated", available: true });
    expect(res.options[3]).toEqual({ origin: "arb:USDC", token: "USDC", network: "Arbitrum", available: false, reason: "The minimum on this network is $100.", estimate: null, estimateUsd: null, timeEstimateSec: null });
  });

  it("takes a checkout URL of this server, its own checkout route, or a receipt page", async () => {
    for (const invoice of [`${CHECKOUT}/pay/${PAY}`, `${NODE}/v1/checkout/${PAY}`, `${CHECKOUT}/receipt/${PAY}/`]) {
      const r = await call("invoice_pay_options", { invoice });
      expect(r.structuredContent?.result?.paymentId, invoice).toBe(PAY);
    }
  });

  it("refuses a URL of another server before asking anything about it", async () => {
    const r = await call("invoice_pay_options", { invoice: `https://evil.example/pay/${PAY}` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.error.code).toBe("INVOICE_NOT_THIS_SERVER");
    expect(said(r)).toMatch(/evil\.example is not this Payminto server.*Nothing was sent\.$/);
    expect(node.seen.map((s) => s.path)).toEqual(["/v1/info"]);
    expect((await call("invoice_pay_options", { invoice: "pay me" })).structuredContent!.error.code).toBe("INVOICE_NOT_RECOGNIZED");
  });

  it("creates an invoice from a fixed-amount payment link, and refuses links it cannot pay without creating one", async () => {
    const r = await call("invoice_pay_options", { invoice: `${CHECKOUT}/l/coffee` });
    expect(r.structuredContent!.result).toMatchObject({ paymentId: LINK_PAY, createdFromLink: true });
    expect(said(r)).toMatch(new RegExp(`^Invoice ${LINK_PAY} \\(created from the payment link\\)`));
    const created = node.seen.filter((s) => s.method === "POST");
    expect(created).toEqual([{ method: "POST", path: "/v1/links/public/coffee/payments", headers: expect.any(Object), body: {} }]);

    for (const [change, code] of [
      [{ amount: null }, "LINK_OPEN_AMOUNT"],
      [{ collect_email: true }, "LINK_NEEDS_DETAILS"],
      [{ intents: { offered: false, reason: "This link carries a fee." } }, "INTENTS_UNAVAILABLE"],
      [{ intents: null }, "INTENTS_CHECKOUT_OFF"],
      [{ active: false }, "LINK_INACTIVE"],
    ] as const) {
      const before = node.link;
      node.link = { ...before, ...change };
      const refused = await call("invoice_pay_options", { invoice: `${CHECKOUT}/l/coffee` });
      expect(refused.structuredContent!.error.code).toBe(code);
      node.link = before;
    }
    expect(node.seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("says plainly when the invoice cannot be paid from another chain now", async () => {
    node.available = false;
    const r = await call("invoice_pay_options", { invoice: PAY });
    expect(said(r)).toBe(`Invoice ${PAY}: the business receives 4.500000 USDC. Simulated - no real money. It cannot be paid from another chain now: This checkout expires too soon to pay from another chain.`);
  });
});

describe("invoice_deposit", () => {
  it("gives the exact amount, token, network, address, deadline and EIP-681 URI for USDC on Base", async () => {
    const r = await call("invoice_deposit", { payment_id: PAY, origin: "base:USDC", refund_to: REFUND });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent!.result;
    expect(d).toMatchObject({
      paymentId: PAY,
      quoteId: QID,
      status: "awaiting_deposit",
      sendExactly: { amount: "4509585", formatted: "4.509585", symbol: "USDC" },
      token: { symbol: "USDC", decimals: 6, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      network: { chain: "base", name: "Base", chainId: 8453 },
      depositAddress: EVM_DEPOSIT,
      deadline: "2026-11-10T22:38:01.000Z",
      paymentUri: `ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=${EVM_DEPOSIT}&uint256=4509585`,
    });
    expect(said(r)).toBe(
      `Simulated - no real money. Send exactly 4.509585 USDC (4509585 base units) on the Base network to ${EVM_DEPOSIT} before 2026-11-10T22:38:01.000Z. ` +
        "Send only USDC on Base: another token, another network, another amount or a deposit after the deadline may be lost. Never change the amount or the address. " +
        "This is simulated: no real money moves, and this address is not a real address on that network. Send no real funds to it.",
    );
    const post = node.seen.find((s) => s.method === "POST")!;
    expect(post.path).toBe(`/v1/checkout/${PAY}/intents/quotes`);
    expect(post.body).toEqual({ origin_asset: ORIGINS["base:USDC"].asset, refund_to: REFUND });
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("works without a refund address: the node is asked with none, and the agent is told a returned deposit goes to the business", async () => {
    const r = await call("invoice_deposit", { payment_id: PAY, origin: "base:USDC" });
    const post = node.seen.filter((x) => x.method === "POST").at(-1)!;
    expect(post.body).toEqual({ origin_asset: ORIGINS["base:USDC"].asset });
    expect(r.structuredContent!.result).toMatchObject({ refundType: "INTENTS", refundTo: "anychain.test.near", depositAddress: EVM_DEPOSIT });
  });

  it("gives a Solana Pay URI for USDC on Solana and a native EIP-681 URI for ETH, and says when the money is real", async () => {
    const sol = await call("invoice_deposit", { payment_id: PAY, origin: "Solana:usdc", refund_to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
    expect(sol.structuredContent!.result.paymentUri).toBe(`solana:${SOL_DEPOSIT}?amount=4.509585&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`);
    node.mode = "live";
    const eth = await call("invoice_deposit", { payment_id: PAY, origin: "base:ETH", refund_to: REFUND });
    expect(eth.structuredContent!.result.paymentUri).toBe(`ethereum:${EVM_DEPOSIT}@8453?value=1250000000000000`);
    expect(said(eth)).toMatch(/^Live - NEAR mainnet\. Send exactly 0\.00125 ETH \(1250000000000000 base units\) on the Base network .* This is live: it moves real money\.$/);
  });

  it("refuses an origin that is not offered or not available now, before asking for an address", async () => {
    const unknown = await call("invoice_deposit", { payment_id: PAY, origin: "tron:USDT", refund_to: REFUND });
    expect(unknown.structuredContent!.error).toEqual({ code: "ORIGIN_NOT_OFFERED", message: "tron:USDT is not offered for this invoice; offered: base:USDC, sol:USDC, base:ETH, arb:USDC" });
    const greyed = await call("invoice_deposit", { payment_id: PAY, origin: "arb:USDC", refund_to: REFUND });
    expect(greyed.structuredContent!.error.code).toBe("ORIGIN_UNAVAILABLE");
    expect(said(greyed)).toBe("arb:USDC cannot pay this invoice now: The minimum on this network is $100. (ORIGIN_UNAVAILABLE). Nothing was sent.");
    expect((await call("invoice_deposit", { payment_id: "https://x/pay/1", origin: "base:USDC", refund_to: REFUND })).structuredContent!.error.code).toBe("INVOICE_NOT_RECOGNIZED");
    expect(node.seen.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("passes the node's refusal on in its own plain words", async () => {
    node.postError = { status: 400, body: { error: { code: "INVALID_REFUND_ADDRESS", message: "This is not an address on Base." } } };
    const r = await call("invoice_deposit", { payment_id: PAY, origin: "base:USDC", refund_to: "shop.near" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.error).toEqual({ code: "INVALID_REFUND_ADDRESS", message: "This is not an address on Base.", status: 400 });
  });

  it("gives no payment URI when the node does not say which contract and chain the token is", async () => {
    const before = ORIGINS["base:USDC"];
    ORIGINS["base:USDC"] = { ...before, contract_address: null, chain_id: null };
    try {
      const r = await call("invoice_deposit", { payment_id: PAY, origin: "base:USDC", refund_to: REFUND });
      expect(r.structuredContent!.result.paymentUri).toBeNull();
      expect(r.structuredContent!.result.depositAddress).toBe(EVM_DEPOSIT);
    } finally {
      ORIGINS["base:USDC"] = before;
    }
  });
});

describe("invoice_status", () => {
  it("is waiting with no deposit address, then with the deposit's steps", async () => {
    expect(said(await call("invoice_status", { payment_id: PAY }))).toBe(`Invoice ${PAY} is waiting (open); it has no deposit address yet: call invoice_deposit. Simulated - no real money.`);
    await call("invoice_deposit", { payment_id: PAY, origin: "base:USDC", refund_to: REFUND });
    const r = await call("invoice_status", { payment_id: PAY });
    expect(said(r)).toBe(`Invoice ${PAY} is waiting: no deposit has arrived yet (deposit address ${QID}, deadline 2026-11-10T22:38:01.000Z). Simulated - no real money.`);
    expect(r.structuredContent!.result).toMatchObject({ state: "waiting", quote: { quoteId: QID, origin: "base:USDC", depositAddress: EVM_DEPOSIT, sendExactly: { amount: "4509585" } } });
  });

  it("is paid, with the NEAR transaction that delivered the USDC", async () => {
    node.quote = node.quoteFor("base:USDC", REFUND, { status: "confirmed", delivered: amt("4500000", "4.500000"), delivery_tx: { hash: "4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q", explorer_url: "https://nearblocks.io/txns/4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q" }, verification: "rpc_checked" });
    node.paymentStatus = "paid";
    const r = await call("invoice_status", { payment_id: PAY, quote_id: QID });
    expect(said(r)).toBe(`Invoice ${PAY} is paid. Delivered on NEAR in transaction 4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q (https://nearblocks.io/txns/4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q). Simulated - no real money.`);
    expect(r.structuredContent!.result).toMatchObject({ state: "paid", paymentStatus: "paid", quote: { status: "confirmed", verification: "rpc_checked" } });
    expect(node.seen.at(-1)!.path).toBe(`/v1/checkout/${PAY}/intents/quotes/${QID}`);
  });

  it("is returned, with what came back and why", async () => {
    node.quote = node.quoteFor("base:USDC", REFUND, { status: "refunded", refunded: amt("4100000", "4.100000"), refund_reason: "The deposit was less than the minimum." });
    expect(said(await call("invoice_status", { payment_id: PAY }))).toBe(`Invoice ${PAY} is not paid: the deposit was returned to the refund address (4.100000 USDC): The deposit was less than the minimum. Simulated - no real money.`);
  });

  it("says to get a new address once the deadline passed, and never to send to the old one", async () => {
    node.quote = node.quoteFor("base:USDC", REFUND, { deadline_passed: true });
    expect(said(await call("invoice_status", { payment_id: PAY }))).toBe(`Invoice ${PAY} is waiting, and the deadline of deposit address ${QID} passed: send nothing to it, and call invoice_deposit for a new one. Simulated - no real money.`);
  });
});

describe("wiring", () => {
  const base = { NODE_URL: "http://localhost:8787", BUDGET_ID: "ab".repeat(32), AGENT_KEY: "05".repeat(32), PAYMINTO_DATA_DIR: "/nonexistent-payminto-test-dir" };

  it("is on by default and off with ANY_CHAIN_INVOICES=off", () => {
    expect(loadMcpConfig(base).anyChainInvoices).toBe(true);
    expect(loadMcpConfig({ ...base, ANY_CHAIN_INVOICES: "off" }).anyChainInvoices).toBe(false);
    expect(() => loadMcpConfig({ ...base, ANY_CHAIN_INVOICES: "maybe" })).toThrow(/ANY_CHAIN_INVOICES/);
  });

  it("adds the tools and their instructions to the wallet server only when the wallet has the invoice client", async () => {
    const names = async (invoices: InvoicePayer | null) => {
      const server = createMcpServer({ market: null, invoices } as unknown as AgentWallet);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const c = new Client({ name: "test", version: "1" });
      await c.connect(ct);
      const out = { tools: (await c.listTools()).tools.map((t) => t.name), instructions: c.getInstructions() ?? "" };
      await c.close();
      return out;
    };
    const on = await names(new InvoicePayer({ nodeUrl: NODE, fetch: node.fetch }));
    expect(on.tools).toEqual(expect.arrayContaining([...INVOICE_TOOL_NAMES]));
    expect(on.instructions).toContain("You send the deposit from your own wallet");
    const off = await names(null);
    expect(off.tools.filter((n) => n.startsWith("invoice_"))).toEqual([]);
    expect(off.instructions).not.toContain("invoice_");
  });
});
