import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIntents, type IntentsHost } from "@/lib/mock/intents";
import { intentsOptionsSchema, intentsPayoutSchema, intentsQuoteSchema, paymentIntentsSchema, type PaymentDetail } from "@/lib/schemas";
import { ApiError } from "@/lib/http";

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const REFUND = "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f";

function payment(over: Partial<PaymentDetail> = {}): PaymentDetail {
  const now = Date.now();
  return {
    id: "pay_anychain",
    merchant_id: "mer_acme",
    livemode: false,
    status: "open",
    amount: "25000000",
    surcharge: "0",
    amount_due: "25000000",
    platform_fee: "0",
    method_fee: "0",
    fee_total: "0",
    net_amount: "25000000",
    amount_paid: "0",
    amount_refunded: "0",
    refund_status: "none",
    network: "near:testnet",
    token: "usdc.fakes.testnet",
    metadata: {},
    line_items: [],
    order_hash: "ab".repeat(32),
    link_id: null,
    payer: null,
    method: null,
    late: false,
    checkout_url: "http://localhost:3000/pay/pay_anychain",
    expires_at: new Date(now + 3_600_000).toISOString(),
    created_at: new Date(now).toISOString(),
    credits: [],
    refunds: [],
    events: [],
    intents: null,
    ...over,
  };
}

/** The mock gateway's own state step, reduced: pending credits hold processing, confirmed ones pay. */
function harness(seed: { account: string | null } = { account: "acme-store.near" }, enabled = true) {
  const p = payment();
  const host: IntentsHost = {
    find: (id) => {
      if (id !== p.id) throw new ApiError(404, "PAYMENT_NOT_FOUND", "no payment");
      return p;
    },
    enabled: () => enabled,
    changed(x, opts) {
      const confirmed = x.credits.filter((c) => c.status === "confirmed").reduce((a, c) => a + BigInt(c.amount), 0n);
      x.amount_paid = confirmed.toString();
      if (confirmed >= BigInt(x.amount_due)) x.status = "paid";
      else if (x.credits.length) x.status = "processing";
      else if (opts?.reopen) x.status = "open";
    },
    event: (x, type) => void x.events.push({ id: type, type, created_at: new Date().toISOString(), data: null }),
    merchant: { id: "mer_acme", hub: "hub.payminto.testnet" },
  };
  return { p, intents: new MockIntents(host, seed) };
}

describe("the mock node's any-chain checkout", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("offers every origin with a price, and greys a route below its bridge minimum with the reason", () => {
    const { intents } = harness();
    const o = intentsOptionsSchema.parse(intents.options("pay_anychain"));
    expect(o.label).toBe("Simulated - no real money");
    expect(o.options.map((x) => `${x.origin.symbol} ${x.origin.chain_name}`)).toEqual(["USDC Base", "USDC Ethereum", "USDC Arbitrum", "USDC Solana", "USDC Polygon", "USDT Ethereum", "ETH Base", "ETH Ethereum"]);
    const eth = o.options.find((x) => x.origin.asset === "nep141:eth.omft.near")!;
    expect(eth.available).toBe(false);
    expect(eth.reason).toBe("The bridge needs at least 30.000000 USDC for this route.");
    const base = o.options[0]!;
    expect(BigInt(base.amount_in!.amount)).toBeGreaterThan(25_000_000n);
    expect(base.fees!.merchant_receives.amount).toBe("25000000");
  });

  it("refuses an address of another chain, and reuses the address for the same origin and refund address", () => {
    const { intents } = harness();
    expect(() => intents.createQuote("pay_anychain", { origin_asset: BASE_USDC, refund_to: "0x123" })).toThrow(/not an address on Base/);
    const a = intents.createQuote("pay_anychain", { origin_asset: BASE_USDC, refund_to: REFUND });
    const b = intents.createQuote("pay_anychain", { origin_asset: BASE_USDC, refund_to: REFUND });
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(true);
    expect(b.quote.id).toBe(a.quote.id);
    expect(intentsQuoteSchema.parse(a.quote).refund_to).toBe("0x5f2b...554f");
    expect(a.quote.deposit_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(a.quote.warning).toMatch(/^Send only USDC on the Base network/);
  });

  it("runs a full deposit to confirmed, paying the payment, with the steps the node reports", () => {
    const { p, intents } = harness();
    const { quote } = intents.createQuote("pay_anychain", { origin_asset: BASE_USDC, refund_to: REFUND });
    const after = intents.simulate("pay_anychain", quote.id);
    expect(after.status).toBe("deposit_detected");
    expect(p.status).toBe("processing");
    expect(after.steps.map((s) => s.state)).toEqual(["done", "current", "pending", "pending"]);
    vi.advanceTimersByTime(5_100);
    const done = intents.quote("pay_anychain", quote.id);
    expect(done.status).toBe("confirmed");
    expect(done.verification).toBe("rpc_checked");
    expect(done.delivery_tx).not.toBeNull();
    expect(done.steps.every((s) => s.state === "done")).toBe(true);
    expect(p.status).toBe("paid");
    expect(p.credits[0]).toMatchObject({ method: "oneclick", payer: `base:${REFUND}`, status: "confirmed" });
    const merchantView = paymentIntentsSchema.parse(intents.paymentIntents("pay_anychain"));
    expect(merchantView.quotes[0]!.refund_to).toBe(REFUND);
    expect(merchantView.quotes[0]!.quote_response).toBeTruthy();
  });

  it("returns a deposit that is too small and opens the payment again", () => {
    const { p, intents } = harness();
    const { quote } = intents.createQuote("pay_anychain", { origin_asset: BASE_USDC, refund_to: REFUND });
    const short = intents.simulate("pay_anychain", quote.id, "1000000");
    expect(short.status).toBe("incomplete_deposit");
    expect(p.status).toBe("processing");
    vi.advanceTimersByTime(4_100);
    const back = intents.quote("pay_anychain", quote.id);
    expect(back.status).toBe("refunded");
    expect(back.refund_reason).toBe("PARTIAL_DEPOSIT");
    expect(back.refunded!.amount).toBe("997600");
    expect(back.steps.map((s) => s.state)).toEqual(["done", "failed", "pending", "pending"]);
    expect(p.status).toBe("open");
    expect(p.credits).toEqual([]);
  });

  it("is not offered until the business's NEAR account passes its three checks and the method is on", () => {
    const fresh = harness({ account: null }, false);
    expect(fresh.intents.checkout(fresh.p).available).toBe(false);
    expect(() => fresh.intents.options("pay_anychain")).toThrow(/does not take payments from other chains/);
    expect(() => fresh.intents.assertCanEnable()).toThrow(expect.objectContaining({ code: "INTENTS_PAYOUT_REQUIRED" }));
    const unregistered = intentsPayoutSchema.parse(fresh.intents.setPayout({ account: "new-shop.near", proof: { timestamp: 1, public_key: "ed25519:abc", signature: "c2ln" } }));
    expect(unregistered.checks).toMatchObject({ exists: true, usdc_registered: false, proven: true });
    expect(unregistered.storage_step?.transaction.actions[0]!.params.methodName).toBe("storage_deposit");
    expect(() => fresh.intents.assertCanEnable()).toThrow(expect.objectContaining({ code: "INTENTS_PAYOUT_NOT_REGISTERED" }));
    fresh.intents.markRegistered();
    expect(fresh.intents.payout().verified).toBe(true);
    expect(() => fresh.intents.assertCanEnable()).not.toThrow();
  });
});
