/**
 * GatewayClient's public any-chain checkout calls (docs/DEVELOPERS.md, "Any-chain checkout"): the options, a deposit
 * address with an Idempotency-Key, and one quote. Behind an in-memory fetch that records each request and answers with
 * the documented shapes, so nothing here reaches a network.
 */
import { describe, expect, it } from "vitest";
import type { IntentsOptions, IntentsQuote } from "@payminto/protocol";
import { GatewayClient, NodeApiError } from "../src/index.ts";

const NODE = "http://node.test";
const PAY = "pay_boxykimcem2hjper3q3nb53l";
const QID = "iq_ccbq7ktq3ypx2m3l3wmbqcbb";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ORIGIN = { asset: BASE_USDC, chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6, contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", chain_id: 8453 };
const amt = (amount: string, formatted: string, symbol = "USDC") => ({ amount, formatted, symbol });

const OPTIONS = {
  object: "intents_options",
  payment_id: PAY,
  mode: "simulated",
  label: "Simulated - no real money",
  amount_out: amt("4500000", "4.500000"),
  recipient: "anychain.test.near",
  settlement_network: "near:mainnet (simulated)",
  quoted_at: "2026-11-10T22:08:00.000Z",
  valid_until: "2026-11-10T22:08:30.000Z",
  options: [{ origin: ORIGIN, available: true, reason: null, slippage_bps: 10, amount_in: amt("4509585", "4.509585"), amount_in_usd: "4.507570845505", time_estimate_sec: 35, fees: null }],
} satisfies IntentsOptions;

const QUOTE = {
  id: QID,
  object: "intents_quote",
  payment_id: PAY,
  mode: "simulated",
  label: "Simulated - no real money",
  status: "awaiting_deposit",
  provider_status: null,
  origin: ORIGIN,
  deposit_address: "0x87151c5ac911a4459762ce215649313cd369dc05",
  deposit_memo: null,
  send_exactly: amt("4509585", "4.509585"),
  min_amount_in: amt("4505080", "4.505080"),
  amount_out: amt("4500000", "4.500000"),
  amount_in_usd: "4.507570845505",
  fees: {
    send_exactly: amt("4509585", "4.509585"),
    merchant_receives: amt("4500000", "4.500000"),
    swap_cost: { amount: "5080", formatted: "0.005080", unit: "USDC" },
    price_buffer: amt("4505", "0.004505"),
    refund_fee: null,
    delivery_fee: null,
    time_estimate_sec: 35,
  },
  slippage_bps: 10,
  time_estimate_sec: 35,
  refund_to: "0x5f2b...554f",
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
  steps: [{ key: "waiting", label: "Waiting for deposit", state: "current" }],
  warning: "Send only USDC on the Base network, to this address. Other tokens, other networks, or a deposit after 22:38 UTC may be lost.",
  correlation_id: "0f8b2c1e-6a43-4c1b-9d61-3f0c8f0d2a77",
  refund_type: "ORIGIN_CHAIN",
  send_by: "2026-11-10T22:38:01.000Z",
  signature_valid: true,
  created_at: "2026-11-10T22:08:01.512Z",
  updated_at: "2026-11-10T22:08:01.512Z",
} satisfies IntentsQuote;

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A node that answers the three public routes, and records every request it is sent. */
function fakeNode(answer?: (r: Seen) => { status: number; body: unknown } | undefined) {
  const seen: Seen[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const r: Seen = { method: init?.method ?? "GET", url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(r);
    const custom = answer?.(r);
    const path = new URL(url).pathname;
    const out =
      custom ??
      (r.method === "GET" && path === `/v1/checkout/${PAY}/intents/options`
        ? { status: 200, body: OPTIONS }
        : r.method === "POST" && path === `/v1/checkout/${PAY}/intents/quotes`
          ? { status: 201, body: QUOTE }
          : r.method === "GET" && path === `/v1/checkout/${PAY}/intents/quotes/${QID}`
            ? { status: 200, body: QUOTE }
            : { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { seen, fetch: fetchFake };
}

describe("GatewayClient any-chain checkout (public, no key)", () => {
  it("reads the options without a key or an Authorization header", async () => {
    const n = fakeNode();
    const client = new GatewayClient({ nodeUrl: `${NODE}/`, fetch: n.fetch });
    const o = await client.checkout.anyChainOptions(PAY);
    expect(o.options[0]!.origin).toEqual(ORIGIN);
    expect(o.options[0]!.amount_in?.formatted).toBe("4.509585");
    expect(n.seen).toEqual([{ method: "GET", url: `${NODE}/v1/checkout/${PAY}/intents/options`, headers: { accept: "application/json" }, body: undefined }]);
  });

  it("creates a deposit address with the origin, the refund address and the Idempotency-Key", async () => {
    const n = fakeNode();
    const client = new GatewayClient({ nodeUrl: NODE, fetch: n.fetch });
    const q = await client.checkout.createAnyChainQuote(PAY, { originAsset: BASE_USDC, refundTo: "0x5f2b4e7b0e8a6f3c4d9e1a2b3c4d5e6f7a8b554f", idempotencyKey: "agent-run-7" });
    expect(q).toMatchObject({ id: QID, deposit_address: "0x87151c5ac911a4459762ce215649313cd369dc05", send_exactly: { amount: "4509585" }, deadline: "2026-11-10T22:38:01.000Z" });
    expect(q.origin.contract_address).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(q.origin.chain_id).toBe(8453);
    const [r] = n.seen;
    expect(r).toMatchObject({ method: "POST", url: `${NODE}/v1/checkout/${PAY}/intents/quotes` });
    expect(r!.headers).toEqual({ accept: "application/json", "content-type": "application/json", "idempotency-key": "agent-run-7" });
    expect(r!.body).toEqual({ origin_asset: BASE_USDC, refund_to: "0x5f2b4e7b0e8a6f3c4d9e1a2b3c4d5e6f7a8b554f" });
  });

  it("sends no Idempotency-Key when none is given", async () => {
    const n = fakeNode();
    await new GatewayClient({ nodeUrl: NODE, fetch: n.fetch }).checkout.createAnyChainQuote(PAY, { originAsset: BASE_USDC, refundTo: "0xabc" });
    expect(n.seen[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("reads one quote, with the ids escaped into the path", async () => {
    const n = fakeNode();
    const client = new GatewayClient({ nodeUrl: NODE, fetch: n.fetch });
    expect((await client.checkout.anyChainQuote(PAY, QID)).status).toBe("awaiting_deposit");
    await client.checkout.anyChainQuote("pay_x/../y", "iq_a?b").catch(() => null);
    expect(n.seen.map((s) => s.url)).toEqual([`${NODE}/v1/checkout/${PAY}/intents/quotes/${QID}`, `${NODE}/v1/checkout/pay_x%2F..%2Fy/intents/quotes/iq_a%3Fb`]);
  });

  it("never sends a key it holds on a public call", async () => {
    const n = fakeNode();
    const client = new GatewayClient({ nodeUrl: NODE, apiKey: "sk_test_secret", fetch: n.fetch });
    await client.checkout.anyChainOptions(PAY);
    await client.checkout.createAnyChainQuote(PAY, { originAsset: BASE_USDC, refundTo: "0xabc" });
    await client.checkout.anyChainQuote(PAY, QID);
    for (const s of n.seen) expect(s.headers.authorization).toBeUndefined();
  });

  it("throws the node's error code and plain message", async () => {
    const n = fakeNode((r) =>
      r.method === "POST" ? { status: 409, body: { error: { code: "INTENTS_UNAVAILABLE", message: "This checkout expires too soon to pay from another chain." } } } : { status: 404, body: { error: { code: "INTENTS_CHECKOUT_OFF", message: "this node does not offer the any-chain checkout (INTENTS_CHECKOUT=off)" } } },
    );
    const client = new GatewayClient({ nodeUrl: NODE, fetch: n.fetch });
    await expect(client.checkout.anyChainOptions(PAY)).rejects.toMatchObject({ status: 404, code: "INTENTS_CHECKOUT_OFF" });
    const err = await client.checkout.createAnyChainQuote(PAY, { originAsset: BASE_USDC, refundTo: "0xabc" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeApiError);
    expect(err).toMatchObject({ status: 409, code: "INTENTS_UNAVAILABLE", reason: "This checkout expires too soon to pay from another chain." });
  });

  it("refuses a call that needs a key on a client built without one, before any request", async () => {
    const n = fakeNode();
    const client = new GatewayClient({ nodeUrl: NODE, fetch: n.fetch });
    await expect(client.payments.list()).rejects.toThrow(/no apiKey/);
    expect(n.seen).toEqual([]);
  });
});
