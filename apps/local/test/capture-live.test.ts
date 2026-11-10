import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiKeyFromLogins, captureLive, CaptureError } from "../src/capture-live.ts";

const PAYMENT = "pay_aaaaaaaaaaaaaaaaaaaaaaaa";
const DEPOSIT = "0x87151c5ac911a4459762ce215649313cd369dc05";
const REFUND = "0x5f2b3a1e9c7d4b6a8f0e1d2c3b4a59687766554f";
const PAYOUT = "northwind-usdc.near";
const DELIVERY = "4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q";
const KEY = "pk_live_secret_key_never_written";

const quote = (over: Record<string, unknown> = {}) => ({
  id: "iq_aaaaaaaaaaaaaaaaaaaaaaaa",
  object: "intents_quote",
  mode: "live",
  label: "Live - NEAR mainnet",
  status: "confirmed",
  provider_status: "SUCCESS",
  origin: { asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 },
  deposit_address: DEPOSIT,
  send_exactly: { amount: "1503010", formatted: "1.50301", symbol: "USDC" },
  amount_out: { amount: "1500000", formatted: "1.5", symbol: "USDC" },
  fees: { send_exactly: { amount: "1503010" } },
  refund_to: REFUND,
  recipient: PAYOUT,
  settlement_network: "near:mainnet",
  deadline: "2026-11-14T10:30:00.000Z",
  deposited: { amount: "1503010", formatted: "1.50301", symbol: "USDC" },
  delivered: { amount: "1500000", formatted: "1.5", symbol: "USDC" },
  origin_txs: [{ hash: `0x${"1".repeat(64)}`, explorer_url: "https://basescan.org/tx/0x1" }],
  delivery_tx: { hash: DELIVERY, explorer_url: `https://nearblocks.io/txns/${DELIVERY}` },
  verification: "rpc_checked",
  correlation_id: "0f8b2c1e-6a43-4c1b-9d61-3f0c8f0d2a77",
  quote_response: { correlationId: "0f8b2c1e-6a43-4c1b-9d61-3f0c8f0d2a77", signature: "ed25519:sig", quoteRequest: { recipient: PAYOUT, refundTo: REFUND }, quote: { depositAddress: DEPOSIT } },
  ...over,
});

type Seen = { url: string; auth: string | null; body: unknown };
function fakeFetch(detail: Record<string, unknown>, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url, auth, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url === `http://127.0.0.1:4210/v1/payments/${PAYMENT}`) return json(detail);
    if (url === `https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`) return json({ status: "SUCCESS", correlationId: "0f8b2c1e", swapDetails: { amountOut: "1500000", nearTxHashes: [DELIVERY] }, quoteResponse: { quoteRequest: { refundTo: REFUND } } });
    if (url === "https://rpc.mainnet.near.org") return json({ jsonrpc: "2.0", id: "x", result: { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: DELIVERY, signer_id: "relay.near" }, receipts_outcome: [] } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const detail = (q = quote()) => ({
  id: PAYMENT,
  status: "paid",
  amount: "1500000",
  amount_paid: "1500000",
  method: "oneclick",
  paid_at: "2026-11-14T10:05:00.000Z",
  customer_email: "someone@example.com",
  customer_name: "Someone Private",
  metadata: { order: "private" },
  description: "Demo",
  intents: { mode: "live", label: "Live - NEAR mainnet", quotes: [q] },
});

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("capturing the live run as a dated fixture", () => {
  it("saves the 1Click status and the NEAR delivery transaction, with nothing personal but the dev accounts it lists", async () => {
    dir = mkdtempSync(join(tmpdir(), "payminto-capture-"));
    const seen: Seen[] = [];
    const out = await captureLive({ paymentId: PAYMENT, nodeUrl: "http://127.0.0.1:4210", apiKey: KEY, outDir: dir, fetch: fakeFetch(detail(), seen), now: new Date("2026-11-14T11:00:00.000Z") });
    expect(out.path).toBe(join(dir, `2026-11-14-${PAYMENT}.json`));
    expect(readdirSync(dir)).toEqual([`2026-11-14-${PAYMENT}.json`]);
    const text = readFileSync(out.path, "utf8");
    const f = JSON.parse(text);
    expect(f).toMatchObject({
      captured_at: "2026-11-14T11:00:00.000Z",
      payment: { id: PAYMENT, status: "paid", amount: "1500000", method: "oneclick", settlement_network: "near:mainnet" },
      quote: { id: "iq_aaaaaaaaaaaaaaaaaaaaaaaa", status: "confirmed", verification: "rpc_checked", delivery_tx: { hash: DELIVERY } },
      oneclick_status: { status: "SUCCESS" },
      near_delivery_tx: { final_execution_status: "FINAL", transaction: { hash: DELIVERY } },
    });
    // Only the dev accounts and the addresses of this payment; never the buyer's email, name, metadata or the API key.
    for (const secret of ["someone@example.com", "Someone Private", "private", KEY]) expect(text).not.toContain(secret);
    expect(out.accounts.sort()).toEqual([DEPOSIT, PAYOUT, REFUND, "relay.near"].sort());
    expect(text).not.toContain(String.fromCharCode(0x2014));
    // The API key went to the node only, and the reads were the node, 1Click's status and NEAR mainnet: nothing else.
    expect(seen.map((s) => [s.url, s.auth])).toEqual([
      [`http://127.0.0.1:4210/v1/payments/${PAYMENT}`, `Bearer ${KEY}`],
      [`https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`, null],
      ["https://rpc.mainnet.near.org", null],
    ]);
    expect(seen[2]!.body).toMatchObject({ method: "tx", params: { tx_hash: DELIVERY, sender_account_id: PAYOUT, wait_until: "NONE" } });
  });

  it("refuses a simulated payment, a payment without a delivery, and an unknown payment", async () => {
    dir = mkdtempSync(join(tmpdir(), "payminto-capture-"));
    const run = (d: Record<string, unknown>) => captureLive({ paymentId: PAYMENT, nodeUrl: "http://127.0.0.1:4210", apiKey: KEY, outDir: dir, fetch: fakeFetch(d, []), now: new Date() });
    await expect(run(detail(quote({ mode: "simulated" })))).rejects.toThrow(/simulated/);
    await expect(run(detail(quote({ status: "awaiting_deposit", delivery_tx: null })))).rejects.toThrow(/no delivery/);
    await expect(run({ ...detail(), intents: null })).rejects.toThrow(CaptureError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reads the business's API key from the logins file of the running stack", () => {
    const text = ["Payminto local stack: generated logins.", "", "API key of Northwind Coffee (Authorization: Bearer ...), for the SDK", `  ${KEY}`, ""].join("\n");
    expect(apiKeyFromLogins(text)).toBe(KEY);
    expect(() => apiKeyFromLogins("nothing here")).toThrow(CaptureError);
  });
});
