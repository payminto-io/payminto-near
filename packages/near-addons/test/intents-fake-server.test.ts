import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPayInQuote, isOriginAddress, originOf, payInQuoteRequest } from "../src/intents/checkout.ts";
import { OneClickClient, OneClickError } from "../src/intents/client.ts";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY, FakeOneClick } from "../src/intents/fake-server.ts";
import { ONECLICK_MANAGER_PUBLIC_KEY, verifyQuoteSignature } from "../src/intents/signature.ts";
import type { QuoteRequest, QuoteResponse, StatusResponse } from "../src/intents/types.ts";
import { fixture } from "./helpers.ts";

type Recorded = { request: QuoteRequest; status: number; body: unknown };
const live = (name: string) => fixture<Recorded>(`oneclick/pay-in/${name}.live.json`);
const QUOTED_AT = Date.parse("2026-11-10T15:19:40Z");
const MERCHANT = "1111111111111111111111111111111111111111111111111111111111111111";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const REFUND = "0x1111111111111111111111111111111111111111";

/** The keys and value types of a JSON value, recursively; arrays by their first element. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? "null" : typeof v;
}

const request = async (fake: FakeOneClick, method: "GET" | "POST", path: string, body?: unknown) => {
  const res = await fake.handle(method, path, body === undefined ? undefined : JSON.stringify(body));
  return { status: res.status, headers: res.headers, body: JSON.parse(res.body) as Record<string, unknown> };
};

describe("contract: the fake answers the recorded live requests with the same status, keys and types", () => {
  const fake = new FakeOneClick({ now: () => QUOTED_AT, accountExists: () => false });

  for (const name of ["quote-base-usdc", "quote-base-eth", "quote-eth-usdc", "quote-sol-usdc", "error-tron-minimum", "error-btc-bridge-minimum", "error-refund-invalid", "error-recipient-missing", "error-deadline-past"]) {
    it(name, async () => {
      const rec = live(name);
      const got = await request(fake, "POST", "/v0/quote", rec.request);
      expect(got.status).toBe(rec.status);
      expect(shape(got.body)).toEqual(shape(rec.body));
      if (rec.status === 201) {
        expect(got.body.quoteRequest).toEqual({ ...(rec.body as QuoteResponse).quoteRequest });
        expect(verifyQuoteSignature(got.body as unknown as QuoteResponse, FAKE_ONECLICK_MANAGER_PUBLIC_KEY)).toBe(true);
        // Never valid under the real manager key: a simulated quote can never pass as a live one.
        expect(verifyQuoteSignature(got.body as unknown as QuoteResponse, ONECLICK_MANAGER_PUBLIC_KEY)).toBe(false);
        // Priced from the recorded token list: within 0.1% of what the live API asked.
        const want = BigInt((rec.body as QuoteResponse).quote.amountIn);
        const have = BigInt((got.body as unknown as QuoteResponse).quote.amountIn);
        expect(Number(have > want ? have - want : want - have) / Number(want)).toBeLessThan(0.001);
      } else {
        expect(got.body.message).toBe((rec.body as { message: string }).message);
      }
    });
  }

  it("tokens", async () => {
    const rec = fixture<{ status: number; body: unknown[] }>("oneclick/pay-in/tokens.live.json");
    const got = await fake.handle("GET", "/v0/tokens");
    expect(got.status).toBe(200);
    expect(shape(JSON.parse(got.body))).toEqual(shape(rec.body));
  });

  it("status of an unknown deposit address", async () => {
    const rec = live("status-not-found-evm");
    const got = await request(fake, "GET", "/v0/status?depositAddress=0x1111111111111111111111111111111111111111");
    expect(got.status).toBe(404);
    expect(shape(got.body)).toEqual(shape(rec.body));
    expect(got.body.message).toBe((rec.body as { message: string }).message);
  });

  it("carries the live rate limit headers and says it is simulated", async () => {
    const got = await fake.handle("GET", "/v0/tokens");
    expect(got.headers).toMatchObject({ "x-ratelimit-limit-unauth": "1200", "x-ratelimit-reset-unauth": "60", "x-payminto-simulated": "1" });
    expect(Number(got.headers["x-ratelimit-remaining-unauth"])).toBeLessThan(1200);
  });
});

describe("the simulated swap", () => {
  const delivered: Array<{ recipient: string; amount: bigint }> = [];
  let now = QUOTED_AT;
  const fake = new FakeOneClick({
    now: () => now,
    stepMs: 0,
    refundAfterMs: 0,
    accountExists: (id) => id === "shop.near",
    deliver: async (d) => {
      delivered.push({ recipient: d.recipient, amount: d.amount });
      return { txHash: `DeliveryTx${delivered.length}` };
    },
  });
  let client: OneClickClient;

  beforeAll(async () => {
    await fake.listen(0);
    client = new OneClickClient({ baseUrl: fake.url });
  });
  afterAll(() => fake.close());

  const wetQuote = async (recipient = MERCHANT, origin = BASE_USDC, refundTo = REFUND) => {
    const asked = payInQuoteRequest({ origin, amount: 5_000_000n, recipient, refundTo, slippageBps: 10, deadline: now + 30 * 60_000, dry: false, referral: "payminto" });
    const res = await client.quote(asked);
    return { asked, res };
  };

  it("serves a wet quote over HTTP that passes every check, with a deposit address of the origin's chain", async () => {
    const { asked, res } = await wetQuote();
    expect(checkPayInQuote(asked, res, { recipient: MERCHANT, managerPublicKey: fake.managerPublicKey, now })).toEqual([]);
    expect(isOriginAddress(originOf(BASE_USDC)!, res.quote.depositAddress!)).toBe(true);
    const sol = await wetQuote(MERCHANT, "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "So11111111111111111111111111111111111111112");
    expect(isOriginAddress(originOf(sol.asked.originAsset)!, sol.res.quote.depositAddress!)).toBe(true);
    expect((await client.status(res.quote.depositAddress!)).status).toBe("PENDING_DEPOSIT");
  });

  it("a full deposit is detected, swapped and delivered through the deliver hook", async () => {
    const { res } = await wetQuote("shop.near");
    const address = res.quote.depositAddress!;
    await fetch(`${fake.url}/_fake/deposits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depositAddress: address, amount: res.quote.amountIn }) });
    await fake.idle();
    const s: StatusResponse = await client.status(address);
    expect(s.status).toBe("SUCCESS");
    expect(s.quoteResponse).toEqual(res);
    expect(s.swapDetails).toMatchObject({ amountOut: "5000000", depositedAmount: res.quote.amountIn, destinationChainTxHashes: [{ hash: `DeliveryTx${delivered.length}` }], referral: "payminto" });
    expect(s.swapDetails.originChainTxHashes).toHaveLength(1);
    expect(delivered.at(-1)).toEqual({ recipient: "shop.near", amount: 5_000_000n });
    expect(fake.history(address)).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  });

  it("a short deposit is incomplete, then returned less the refund fee; a top-up in time completes it", async () => {
    const { res } = await wetQuote();
    const address = res.quote.depositAddress!;
    await fake.deposit(address, 3_000_000n);
    await fake.idle();
    const s = await client.status(address);
    expect(s.status).toBe("REFUNDED");
    expect(s.swapDetails).toMatchObject({ depositedAmount: "3000000", refundedAmount: String(3_000_000n - BigInt(res.quote.refundFee!)), refundReason: "PARTIAL_DEPOSIT" });
    expect(fake.history(address)).toEqual(["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "REFUNDED"]);

    const slow = new FakeOneClick({ now: () => now, stepMs: 0, refundAfterMs: 60_000 });
    const q = await new OneClickClient({ fetch: slow.fetch }).quote({ ...payInQuoteRequest({ origin: BASE_USDC, amount: 5_000_000n, recipient: MERCHANT, refundTo: REFUND, slippageBps: 10, deadline: now + 30 * 60_000, dry: false }) });
    await slow.deposit(q.quote.depositAddress!, 3_000_000n);
    await slow.deposit(q.quote.depositAddress!, BigInt(q.quote.amountIn) - 3_000_000n);
    await slow.idle();
    expect(slow.history(q.quote.depositAddress!)).toEqual(["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
    await slow.close();
  });

  it("fails on request, and returns a deposit that arrives after the deadline", async () => {
    const a = await wetQuote();
    await fake.deposit(a.res.quote.depositAddress!, BigInt(a.res.quote.amountIn), { fail: true });
    const b = await wetQuote();
    now += 31 * 60_000;
    await fake.deposit(b.res.quote.depositAddress!, BigInt(b.res.quote.amountIn));
    await fake.idle();
    expect((await client.status(a.res.quote.depositAddress!)).status).toBe("FAILED");
    const late = await client.status(b.res.quote.depositAddress!);
    expect(late.status).toBe("REFUNDED");
    expect(late.swapDetails.refundReason).toBe("DEADLINE_EXCEEDED");
    now = QUOTED_AT;
  });

  it("a delivery that fails on chain fails the swap", async () => {
    const broken = new FakeOneClick({ now: () => now, stepMs: 0, deliver: async () => Promise.reject(new Error("no storage")) });
    const q = await new OneClickClient({ fetch: broken.fetch }).quote(payInQuoteRequest({ origin: BASE_USDC, amount: 1_000_000n, recipient: MERCHANT, refundTo: REFUND, slippageBps: 10, deadline: now + 600_000, dry: false }));
    await broken.deposit(q.quote.depositAddress!, BigInt(q.quote.amountIn));
    await broken.idle();
    expect(broken.history(q.quote.depositAddress!).at(-1)).toBe("FAILED");
  });

  it("deposit/submit records the buyer's transaction and answers with the status shape", async () => {
    const { res } = await wetQuote();
    const s = await client.submitDeposit({ txHash: "0xabc123", depositAddress: res.quote.depositAddress! });
    expect(s.status).toBe("PENDING_DEPOSIT");
    expect(s.swapDetails.originChainTxHashes).toEqual([{ hash: "0xabc123", explorerUrl: "" }]);
    await expect(client.submitDeposit({ txHash: "0x1", depositAddress: "0x9999999999999999999999999999999999999999" })).rejects.toBeInstanceOf(OneClickError);
  });

  it("keeps its control routes off /v0 and refuses unknown routes", async () => {
    expect((await fake.handle("POST", "/v0/_fake/deposits", "{}")).status).toBe(404);
    expect((await fake.handle("GET", "/v0/nope")).status).toBe(404);
    expect((await fake.handle("POST", "/_fake/deposits", JSON.stringify({ depositAddress: "0xnope", amount: "1" }))).status).toBe(404);
    const clock = await request(fake, "POST", "/_fake/clock", { advanceMs: 1000 });
    expect(clock.status).toBe(200);
  });
});
