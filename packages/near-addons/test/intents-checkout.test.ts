import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_ORIGINS,
  checkPayInQuote,
  feeLines,
  formatUnits,
  isOriginAddress,
  mapStatus,
  originOf,
  payInQuoteRequest,
  quoteErrorReason,
  slippageFor,
} from "../src/intents/checkout.ts";
import { quoteSigningMessage, verifyQuoteSignature } from "../src/intents/signature.ts";
import { NEAR_MAINNET_USDC_ASSET, type QuoteRequest, type QuoteResponse } from "../src/intents/types.ts";
import { run } from "../src/intents/cli.ts";
import { fakeFetch, fixture, type Route } from "./helpers.ts";

type Recorded = { request: QuoteRequest; status: number; body: QuoteResponse };
const live = (name: string) => fixture<Recorded>(`oneclick/pay-in/${name}.live.json`);
const baseUsdc = live("quote-base-usdc");
const baseEth = live("quote-base-eth");
const ethUsdc = live("quote-eth-usdc");
const solUsdc = live("quote-sol-usdc");

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const MERCHANT = "1111111111111111111111111111111111111111111111111111111111111111";
const QUOTED_AT = Date.parse("2026-11-10T15:19:42.789Z");

// SYNTHETIC: no wet quote was ever requested live. This is the live dry quote turned wet and signed by a test key.
const TEST_SEED = new Uint8Array(32).fill(9);
const TEST_MANAGER = `ed25519:${base58.encode(ed25519.getPublicKey(TEST_SEED))}`;
const EVM_DEPOSIT = "0x2b5f3a1e9c7d4b6a8f0e1d2c3b4a59687766554f";

function wet(rec: Recorded, mutate: (r: QuoteResponse) => void = () => {}): QuoteResponse {
  const r = structuredClone(rec.body);
  r.quoteRequest.dry = false;
  r.quote.depositAddress = EVM_DEPOSIT;
  r.quote.deadline = r.quoteRequest.deadline;
  r.quote.timeWhenInactive = r.quoteRequest.deadline;
  mutate(r);
  r.signature = `ed25519:${base58.encode(ed25519.sign(quoteSigningMessage(r), TEST_SEED))}`;
  return r;
}

describe("the pay-in origins", () => {
  it("offers exactly the agreed origins, with decimals and chains from the live token list", () => {
    const tokens = fixture<{ body: Array<{ assetId: string; decimals: number; blockchain: string; symbol: string }> }>("oneclick/pay-in/tokens.live.json").body;
    expect(CHECKOUT_ORIGINS.map((o) => `${o.symbol}/${o.blockchain}`)).toEqual(["USDC/base", "USDC/eth", "USDC/arb", "USDC/sol", "USDC/pol", "USDT/eth", "ETH/base", "ETH/eth"]);
    for (const o of CHECKOUT_ORIGINS) {
      const t = tokens.find((x) => x.assetId === o.assetId);
      expect(t, o.assetId).toBeDefined();
      expect({ decimals: t!.decimals, blockchain: t!.blockchain, symbol: t!.symbol }).toEqual({ decimals: o.decimals, blockchain: o.blockchain, symbol: o.symbol });
    }
    expect(originOf("nep141:btc.omft.near")).toBeUndefined();
    expect(originOf("nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near")).toBeUndefined();
  });

  it("validates refund addresses per chain and refuses the forms the live API refused", () => {
    const base = originOf(BASE_USDC)!;
    const sol = originOf(SOL_USDC)!;
    expect(isOriginAddress(base, "0x1111111111111111111111111111111111111111")).toBe(true);
    expect(isOriginAddress(base, "0x2527d02599ba641c19fea793cd0f167589a0f10d")).toBe(true);
    expect(isOriginAddress(base, "0x123")).toBe(false);
    expect(isOriginAddress(base, "0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isOriginAddress(base, "So11111111111111111111111111111111111111112")).toBe(false);
    expect(isOriginAddress(sol, "So11111111111111111111111111111111111111112")).toBe(true);
    // The system program id: the live API answered "refundTo is not valid".
    expect(isOriginAddress(sol, "11111111111111111111111111111111")).toBe(false);
    expect(isOriginAddress(sol, "0x1111111111111111111111111111111111111111")).toBe(false);
    expect(isOriginAddress(sol, "not base58 0OIl")).toBe(false);
  });

  it("picks 10 bps for stablecoins and 100 bps for volatile tokens", () => {
    expect(slippageFor(originOf(BASE_USDC)!)).toBe(10);
    expect(slippageFor(originOf("nep141:base.omft.near")!)).toBe(100);
    expect(slippageFor(originOf("nep141:base.omft.near")!, { stable: 5, volatile: 50 })).toBe(50);
  });
});

describe("payInQuoteRequest", () => {
  it("builds exactly the request the live API answered for 5 USDC paid from Base", () => {
    const asked = payInQuoteRequest({ origin: BASE_USDC, amount: 5_000_000n, recipient: MERCHANT, refundTo: "0x1111111111111111111111111111111111111111", slippageBps: 10, deadline: "2026-11-10T15:49:42.000Z", dry: true });
    expect(asked).toEqual(baseUsdc.request);
    expect(asked.destinationAsset).toBe(NEAR_MAINNET_USDC_ASSET);
  });

  it("adds a referral when given and never a memo or customRecipientMsg", () => {
    const asked = payInQuoteRequest({ origin: SOL_USDC, amount: 1n, recipient: MERCHANT, refundTo: "So11111111111111111111111111111111111111112", slippageBps: 10, deadline: new Date(QUOTED_AT + 60_000), dry: false, referral: "payminto" });
    expect(asked).toMatchObject({ dry: false, swapType: "EXACT_OUTPUT", recipientType: "DESTINATION_CHAIN", depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", referral: "payminto" });
    expect(asked).not.toHaveProperty("customRecipientMsg");
    expect(asked).not.toHaveProperty("depositMode");
  });

  it("refuses what the API would refuse, before any request", () => {
    const ok = { origin: BASE_USDC, amount: 5_000_000n, recipient: MERCHANT, refundTo: "0x1111111111111111111111111111111111111111", slippageBps: 10, deadline: "2026-11-10T15:49:42.000Z", dry: true };
    expect(() => payInQuoteRequest({ ...ok, origin: "nep141:btc.omft.near" })).toThrow(/not an offered origin/);
    expect(() => payInQuoteRequest({ ...ok, refundTo: "0x123" })).toThrow(/refund address/);
    expect(() => payInQuoteRequest({ ...ok, recipient: "Not An Account" })).toThrow(/recipient/);
    expect(() => payInQuoteRequest({ ...ok, amount: 0n })).toThrow(/amount/);
    expect(() => payInQuoteRequest({ ...ok, slippageBps: 10_001 })).toThrow(/slippage/);
    expect(() => payInQuoteRequest({ ...ok, deadline: "yesterday" })).toThrow(/deadline/);
  });
});

describe("checkPayInQuote against the recorded live dry quotes", () => {
  for (const [name, rec] of [["Base USDC", baseUsdc], ["Base ETH", baseEth], ["Ethereum USDC", ethUsdc], ["Solana USDC", solUsdc]] as const) {
    it(`accepts the live ${name} dry quote: signed by 1Click, fields echoed, minAmountOut equals the amount`, () => {
      expect(verifyQuoteSignature(rec.body)).toBe(true);
      expect(checkPayInQuote(rec.request, rec.body, { recipient: MERCHANT, now: QUOTED_AT })).toEqual([]);
    });
  }

  it("refuses a recipient other than the merchant's account even when 1Click signed it", () => {
    expect(checkPayInQuote(baseUsdc.request, baseUsdc.body, { recipient: "merchant.near", now: QUOTED_AT }).join()).toMatch(/recipient/);
  });

  it("refuses any change to a signed field", () => {
    const r = structuredClone(baseUsdc.body);
    r.quote.minAmountOut = "4999999";
    expect(checkPayInQuote(baseUsdc.request, r, { recipient: MERCHANT, now: QUOTED_AT }).join()).toMatch(/signature/);
  });
});

describe("checkPayInQuote on wet quotes (synthetic, signed by a test key)", () => {
  const asked = { ...baseUsdc.request, dry: false };
  const check = (r: QuoteResponse, now = QUOTED_AT) => checkPayInQuote(asked, r, { recipient: MERCHANT, managerPublicKey: TEST_MANAGER, now });

  it("accepts a wet quote that says what was asked", () => {
    expect(check(wet(baseUsdc))).toEqual([]);
  });

  it("refuses each kind of mismatch, even when validly signed", () => {
    const cases: Array<[(r: QuoteResponse) => void, RegExp]> = [
      [(r) => (r.quoteRequest.recipient = "attacker.near"), /recipient/],
      [(r) => (r.quoteRequest.refundTo = "0x2222222222222222222222222222222222222222"), /refundTo/],
      [(r) => (r.quoteRequest.originAsset = "nep141:base.omft.near"), /originAsset/],
      [(r) => (r.quoteRequest.destinationAsset = "nep141:wrap.near"), /destinationAsset/],
      [(r) => (r.quoteRequest.swapType = "EXACT_INPUT"), /swapType/],
      [(r) => (r.quoteRequest.amount = "4000000"), /amount/],
      [(r) => (r.quote.minAmountOut = "4990000"), /minAmountOut/],
      [(r) => (r.quote.amountOut = "4990000"), /amountOut/],
      [(r) => (r.quoteRequest.slippageTolerance = 500), /slippage/],
      [(r) => (r.quote.minAmountIn = "9999999999"), /minAmountIn/],
      [(r) => (r.quote.depositMemo = "42"), /memo/],
      [(r) => delete r.quote.depositAddress, /deposit address/],
      [(r) => (r.quote.depositAddress = "So11111111111111111111111111111111111111112"), /deposit address/],
      [(r) => delete r.quote.deadline, /deadline/],
      [(r) => (r.quoteRequest.customRecipientMsg = "x"), /customRecipientMsg/],
    ];
    for (const [mutate, why] of cases) expect(check(wet(baseUsdc, mutate)).join("; ")).toMatch(why);
  });

  it("refuses a dry answer to a wet request, a quote past its deadline and one signed by anyone else", () => {
    expect(check(wet(baseUsdc, (r) => (r.quoteRequest.dry = true))).join()).toMatch(/dry/);
    expect(check(wet(baseUsdc), Date.parse("2026-11-10T15:50:00Z")).join()).toMatch(/deadline/);
    expect(checkPayInQuote(asked, wet(baseUsdc), { recipient: MERCHANT, now: QUOTED_AT }).join()).toMatch(/signature/);
  });

  it("wants a Solana deposit address for a Solana origin", () => {
    const solAsked = { ...solUsdc.request, dry: false };
    const solWet = (addr: string) => wet(solUsdc, (r) => (r.quote.depositAddress = addr));
    expect(checkPayInQuote(solAsked, solWet("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), { recipient: MERCHANT, managerPublicKey: TEST_MANAGER, now: QUOTED_AT })).toEqual([]);
    expect(checkPayInQuote(solAsked, solWet(EVM_DEPOSIT), { recipient: MERCHANT, managerPublicKey: TEST_MANAGER, now: QUOTED_AT }).join()).toMatch(/deposit address/);
  });
});

describe("mapStatus", () => {
  it("maps every 1Click status to a checkout state", () => {
    expect(
      Object.fromEntries((["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"] as const).map((s) => [s, mapStatus(s)])),
    ).toEqual({
      PENDING_DEPOSIT: "awaiting_deposit",
      KNOWN_DEPOSIT_TX: "deposit_detected",
      INCOMPLETE_DEPOSIT: "incomplete_deposit",
      PROCESSING: "processing",
      SUCCESS: "delivered",
      REFUNDED: "refunded",
      FAILED: "failed",
    });
    expect(() => mapStatus("SOMETHING_NEW" as never)).toThrow(/unknown 1Click status/);
  });
});

describe("feeLines", () => {
  it("computes the stablecoin lines from the signed quote: cost is minAmountIn minus the invoice, buffer is amountIn minus minAmountIn", () => {
    expect(feeLines(baseUsdc.body, originOf(BASE_USDC)!)).toEqual({
      send_exactly: { amount: "5010154", formatted: "5.010154", symbol: "USDC" },
      merchant_receives: { amount: "5000000", formatted: "5.000000", symbol: "USDC" },
      swap_cost: { amount: "5148", formatted: "0.005148", unit: "USDC" },
      price_buffer: { amount: "5006", formatted: "0.005006", symbol: "USDC" },
      refund_fee: { amount: "2400", formatted: "0.002400", symbol: "USDC" },
      delivery_fee: { amount: "4628", formatted: "0.004628", symbol: "USDC" },
      time_estimate_sec: 35,
    });
  });

  it("states the cost of a volatile token in US dollars, from the quote's own USD figures", () => {
    const f = feeLines(baseEth.body, originOf("nep141:base.omft.near")!);
    expect(f.send_exactly).toEqual({ amount: "2441510706578070", formatted: "0.002441510706578070", symbol: "ETH" });
    // minAmountIn in USD (5.055196748184 * 2417117936896134 / 2441510706578070 = 5.004691...) minus 4.99778 out.
    expect(f.swap_cost.unit).toBe("USD");
    expect(f.swap_cost.formatted).toBe("0.006911");
    expect(f.price_buffer).toEqual({ amount: "24392769681936", formatted: "0.000024392769681936", symbol: "ETH" });
  });

  it("formats base units", () => {
    expect(formatUnits(5_010_154n, 6)).toBe("5.010154");
    expect(formatUnits("1", 18)).toBe("0.000000000000000001");
    expect(formatUnits(0n, 0)).toBe("0");
  });
});

describe("quoteErrorReason", () => {
  it("turns the live API's refusals into plain words", () => {
    const msg = (name: string) => (live(name).body as unknown as { message: string }).message;
    expect(quoteErrorReason(msg("error-tron-minimum"))).toBe("The minimum on this network is $100.");
    expect(quoteErrorReason(msg("error-btc-bridge-minimum"), { decimals: 6, symbol: "USDC" })).toBe("The bridge needs at least 6.165424 USDC for this route.");
    expect(quoteErrorReason(msg("error-refund-invalid"))).toBe("The refund address is not valid on this network.");
    expect(quoteErrorReason(msg("error-recipient-missing"))).toBe("NEAR Intents could not quote this route right now.");
    expect(quoteErrorReason(msg("error-deadline-past"))).toBe("The checkout expires too soon for this route.");
  });
});

describe("quote-in: live dry quotes for the demo", () => {
  const API = "https://1click.chaindefuser.com";
  const cli = async (argv: string[], routes: Route[]) => {
    const { fetch, calls } = fakeFetch(routes);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { fetch, out: (l) => out.push(l), err: (l) => err.push(l), now: () => QUOTED_AT, env: {} });
    return { code, out: out.join("\n"), err: err.join("\n"), calls };
  };

  it("asks for a dry EXACT_OUTPUT quote, checks it and prints the deposit screen's numbers", async () => {
    const r = await cli(["quote-in", "--from", "base:USDC", "--usdc", "5", "--merchant", MERCHANT], [{ method: "POST", url: `${API}/v0/quote`, status: 201, body: baseUsdc.body }]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    const sent = r.calls[0]!.body as QuoteRequest;
    expect(sent).toEqual({ ...baseUsdc.request, deadline: new Date(QUOTED_AT + 30 * 60_000).toISOString() });
    expect(r.out).toMatch(/DRY quote/);
    expect(r.out).toMatch(/Send exactly 5\.010154 USDC on Base/);
    expect(r.out).toMatch(/Merchant receives 5\.000000 USDC on NEAR/);
    expect(r.out).toMatch(/Swap and delivery cost 0\.005148 USDC/);
    expect(r.out).toMatch(/Price buffer 0\.005006 USDC/);
    expect(r.out).toMatch(/1Click signature: valid/);
    expect(r.out).toMatch(/checks: passed/);
    expect(r.out).toMatch(/"correlationId": "d4d6691a/);
  });

  it("never asks for a wet quote, and explains a refusal in plain words", async () => {
    const r = await cli(["quote-in", "--from", "base:USDC", "--usdc", "5", "--merchant", MERCHANT, "--mainnet"], []);
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/always dry/);
    const refusal = live("error-refund-invalid");
    const refused = await cli(["quote-in", "--from", "eth:USDC", "--usdc", "5", "--merchant", MERCHANT], [{ method: "POST", url: `${API}/v0/quote`, status: 400, body: refusal.body }]);
    expect(refused.code).toBe(2);
    expect(refused.out).toMatch(/USDC on Ethereum: refused: The refund address is not valid on this network\./);
  });

  it("--from all quotes every offered origin", async () => {
    const r = await cli(["quote-in", "--from", "all", "--usdc", "5", "--merchant", MERCHANT], [{ method: "POST", url: `${API}/v0/quote`, status: 201, body: baseUsdc.body }]);
    expect(r.calls).toHaveLength(CHECKOUT_ORIGINS.length);
    expect(new Set(r.calls.map((c) => (c.body as QuoteRequest).originAsset)).size).toBe(CHECKOUT_ORIGINS.length);
    expect(r.calls.every((c) => (c.body as QuoteRequest).dry === true)).toBe(true);
  });

  it("refuses bad arguments", async () => {
    expect((await cli(["quote-in", "--from", "btc:BTC", "--usdc", "5", "--merchant", MERCHANT], [])).err).toMatch(/not an offered origin/);
    expect((await cli(["quote-in", "--from", "base:USDC", "--usdc", "5.1234567", "--merchant", MERCHANT], [])).err).toMatch(/--usdc/);
    expect((await cli(["quote-in", "--from", "base:USDC", "--usdc", "5", "--merchant", "Bad Name"], [])).err).toMatch(/--merchant/);
  });
});
