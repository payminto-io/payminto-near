import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { run } from "../src/intents/cli.ts";
import { OneClickClient, OneClickError, pollStatus } from "../src/intents/client.ts";
import { exitPlan, exitQuoteRequest, nearCliCommands } from "../src/intents/plan.ts";
import { ONECLICK_MANAGER_PUBLIC_KEY, quoteSigningMessage, stableStringify, verifyQuoteSignature } from "../src/intents/signature.ts";
import { NEAR_MAINNET_USDC, type QuoteResponse, type StatusResponse } from "../src/intents/types.ts";
import { fakeFetch, fixture, rpcView, type Route } from "./helpers.ts";

const API = "https://1click.chaindefuser.com";
const RPC = "https://rpc.mainnet.near.org";

type Recorded = { request: Record<string, unknown>; status: number; body: unknown };
const dryLive = fixture<Recorded & { body: QuoteResponse }>("oneclick/quote-dry.live.json");
const tokensLive = fixture<{ status: number; body: unknown[] }>("oneclick/tokens.live.json");
const notFoundLive = fixture<{ status: number; body: unknown }>("oneclick/status-not-found.live.json");
const refundErrLive = fixture<Recorded>("oneclick/quote-error-refund.live.json");
const boundsLive = fixture<{ result: unknown }>("rpc/mainnet-usdc-storage-bounds.live.json");
const unregisteredLive = fixture<{ result: unknown }>("rpc/mainnet-usdc-storage-unregistered.live.json");

// Values from the recorded live dry quote: 10 USDC on NEAR to USDC on Base.
const SENDER = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const RECIPIENT = "0x2527d02599ba641c19fea793cd0f167589a0f10d";
const NOW = Date.parse("2026-11-10T03:10:30Z");

// SYNTHETIC: no wet quote was taken live. This one is the live dry quote turned wet and signed by a test key.
const TEST_SEED = new Uint8Array(32).fill(7);
const TEST_MANAGER = `ed25519:${base58.encode(ed25519.getPublicKey(TEST_SEED))}`;
const DEPOSIT = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function wetQuote(mutate: (r: QuoteResponse) => void = () => {}): QuoteResponse {
  const r = structuredClone(dryLive.body);
  r.quoteRequest.dry = false;
  r.quote.depositAddress = DEPOSIT;
  r.quote.deadline = "2026-11-10T03:40:25.679Z";
  r.quote.timeWhenInactive = "2026-11-10T03:40:25.679Z";
  mutate(r);
  r.signature = `ed25519:${base58.encode(ed25519.sign(quoteSigningMessage(r), TEST_SEED))}`;
  return r;
}

const askedFromLive = () => ({ ...(dryLive.request as ReturnType<typeof exitQuoteRequest>) });

function statusBody(status: StatusResponse["status"], extra: Partial<StatusResponse["swapDetails"]> = {}): StatusResponse {
  // SYNTHETIC: shaped from GetExecutionStatusResponse in the OpenAPI document; no swap was run.
  return {
    correlationId: "synthetic",
    quoteResponse: wetQuote(),
    status,
    updatedAt: "2026-11-10T03:12:00.000Z",
    swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...extra },
  };
}

describe("quote signature (1Click manager key)", () => {
  it("verifies the recorded live dry quote against the published manager key", () => {
    expect(verifyQuoteSignature(dryLive.body)).toBe(true);
    expect(verifyQuoteSignature(dryLive.body, ONECLICK_MANAGER_PUBLIC_KEY)).toBe(true);
  });

  it("rejects any change to a signed field", () => {
    for (const mutate of [
      (r: QuoteResponse) => (r.quote.amountOut = "9996227"),
      (r: QuoteResponse) => (r.quote.minAmountOut = "1"),
      (r: QuoteResponse) => (r.quoteRequest.recipient = "0x0000000000000000000000000000000000000001"),
      (r: QuoteResponse) => (r.quoteRequest.refundTo = "attacker.near"),
      (r: QuoteResponse) => (r.timestamp = "2026-11-10T03:10:09.000Z"),
    ]) {
      const r = structuredClone(dryLive.body);
      mutate(r);
      expect(verifyQuoteSignature(r)).toBe(false);
    }
  });

  it("does not cover appFees, as in the official SDK", () => {
    const r = structuredClone(dryLive.body);
    r.quoteRequest.appFees = [];
    expect(verifyQuoteSignature(r)).toBe(true);
  });

  it("never throws on garbage", () => {
    expect(verifyQuoteSignature({ ...dryLive.body, signature: "ed25519:0OIl" })).toBe(false);
    expect(verifyQuoteSignature(dryLive.body, "ed25519:")).toBe(false);
  });

  it("stringifies like json-stable-stringify", () => {
    expect(stableStringify({ b: 1, a: [3, undefined, { d: undefined, c: "x" }], e: null })).toBe('{"a":[3,null,{"c":"x"}],"b":1,"e":null}');
  });
});

describe("OneClickClient against recorded responses", () => {
  it("lists tokens and finds native USDC on NEAR", async () => {
    const { fetch, calls } = fakeFetch([{ method: "GET", url: `${API}/v0/tokens`, status: 200, body: tokensLive.body }]);
    const tokens = await new OneClickClient({ fetch }).tokens();
    const usdc = tokens.find((t) => t.assetId === `nep141:${NEAR_MAINNET_USDC}`);
    expect(usdc).toMatchObject({ blockchain: "near", symbol: "USDC", decimals: 6, contractAddress: NEAR_MAINNET_USDC });
    expect(calls).toHaveLength(1);
  });

  it("accepts the 201 the live API returns for a quote, and sends the documented body", async () => {
    const { fetch, calls } = fakeFetch([{ method: "POST", url: `${API}/v0/quote`, status: dryLive.status, body: dryLive.body }]);
    const asked = askedFromLive();
    const res = await new OneClickClient({ fetch, apiKey: "jwt" }).quote(asked);
    expect(res.quote.amountOut).toBe("9996226");
    expect(calls[0]!.body).toEqual(asked);
  });

  it("surfaces 400 and 404 bodies as OneClickError with the correlation id", async () => {
    const { fetch } = fakeFetch([
      { method: "POST", url: `${API}/v0/quote`, status: refundErrLive.status, body: refundErrLive.body },
      { method: "GET", url: `${API}/v0/status`, status: notFoundLive.status, body: notFoundLive.body },
    ]);
    const c = new OneClickClient({ fetch });
    await expect(c.quote(askedFromLive())).rejects.toMatchObject({ name: "OneClickError", status: 400, correlationId: "682c5435-05bd-4b06-a3f1-881047ea484f" });
    const e = await c.status("0".repeat(64)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OneClickError);
    expect((e as OneClickError).status).toBe(404);
  });

  it("refuses customRecipientMsg before any request", async () => {
    const { fetch, calls } = fakeFetch([]);
    await expect(new OneClickClient({ fetch }).quote({ ...askedFromLive(), customRecipientMsg: "x" })).rejects.toThrow(/customRecipientMsg/);
    expect(calls).toHaveLength(0);
  });

  it("polls until a terminal status and reports each change once", async () => {
    const seq = ["PENDING_DEPOSIT", "PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"] as const;
    let i = 0;
    const c = new OneClickClient({ fetch: async () => ({ status: 200, text: async () => JSON.stringify(statusBody(seq[Math.min(i++, seq.length - 1)]!)) }) });
    const seen: string[] = [];
    const r = await pollStatus(c, DEPOSIT, { sleep: async () => {}, onUpdate: (s) => seen.push(s.status) });
    expect(r.final).toBe(true);
    expect(seen).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  });

  it("stops at the timeout without a terminal status", async () => {
    let t = 0;
    const c = new OneClickClient({ fetch: async () => ({ status: 200, text: async () => JSON.stringify(statusBody("PROCESSING")) }) });
    const r = await pollStatus(c, DEPOSIT, { intervalMs: 10, timeoutMs: 25, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(r).toMatchObject({ final: false, last: { status: "PROCESSING" } });
  });
});

describe("exit plan", () => {
  const asked = askedFromLive();
  const unregistered = { registered: false as const, minDeposit: (boundsLive.result as { min: string }).min };

  it("builds exactly storage_deposit then ft_transfer of amountIn to the deposit address", () => {
    const plan = exitPlan(asked, wetQuote(), SENDER, unregistered, { managerPublicKey: TEST_MANAGER, now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.tx).toEqual({
      receiverId: NEAR_MAINNET_USDC,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "storage_deposit", args: { account_id: DEPOSIT, registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" },
        },
        { type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: DEPOSIT, amount: "10000000" }, gas: "30000000000000", deposit: "1" } },
      ],
    });
    expect(plan.minAmountOut).toBe("9896263");
  });

  it("skips storage_deposit when the address is registered", () => {
    const plan = exitPlan(asked, wetQuote(), SENDER, { registered: true }, { managerPublicKey: TEST_MANAGER, now: NOW });
    expect(plan.tx.actions.map((a) => a.params.methodName)).toEqual(["ft_transfer"]);
    expect(nearCliCommands(plan)).toEqual([
      `near contract call-function as-transaction ${NEAR_MAINNET_USDC} ft_transfer json-args '{"receiver_id":"${DEPOSIT}","amount":"10000000"}' prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${SENDER} network-config mainnet sign-with-keychain send`,
    ]);
  });

  it("refuses a quote signed by anyone but the 1Click key", () => {
    const plan = exitPlan(asked, wetQuote(), SENDER, { registered: true }, { now: NOW });
    expect(plan.refusals.join()).toMatch(/signature/);
  });

  it("refuses a quote that differs from what was asked, even if validly signed", () => {
    const cases: Array<[(r: QuoteResponse) => void, RegExp]> = [
      [(r) => (r.quoteRequest.recipient = "0x0000000000000000000000000000000000000bad"), /recipient/],
      [(r) => (r.quoteRequest.refundTo = "someone-else.near"), /refundTo/],
      [(r) => (r.quoteRequest.destinationAsset = "nep141:eth.omft.near"), /destinationAsset/],
      [(r) => (r.quote.amountIn = "20000000"), /amountIn/],
      [(r) => (r.quote.depositMemo = "1"), /memo/],
      [(r) => delete r.quote.depositAddress, /deposit address/],
      [(r) => (r.quoteRequest.slippageTolerance = 500), /slippage/],
    ];
    for (const [mutate, why] of cases) {
      const plan = exitPlan(asked, wetQuote(mutate), SENDER, { registered: true }, { managerPublicKey: TEST_MANAGER, now: NOW });
      expect(plan.refusals.join("; ")).toMatch(why);
    }
  });

  it("refuses an expired quote, a dry quote, and a sender that is not the refund account", () => {
    expect(exitPlan(asked, wetQuote(), SENDER, { registered: true }, { managerPublicKey: TEST_MANAGER, now: Date.parse("2026-11-10T04:00:00Z") }).refusals.join()).toMatch(/deadline/);
    expect(exitPlan(asked, dryLive.body, SENDER, { registered: true }, { now: NOW }).refusals.join()).toMatch(/dry quote/);
    expect(exitPlan(asked, wetQuote(), "other.near", { registered: true }, { managerPublicKey: TEST_MANAGER, now: NOW }).refusals.join()).toMatch(/refundTo must be the sender/);
  });

  it("asks for EXACT_INPUT from NEAR, delivered on the destination chain, refunded on NEAR", () => {
    expect(exitQuoteRequest({ originToken: NEAR_MAINNET_USDC, destinationAsset: BASE_USDC, amount: 10_000_000n, recipient: RECIPIENT, refundTo: SENDER, dry: true }, NOW)).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: `nep141:${NEAR_MAINNET_USDC}`,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: BASE_USDC,
      amount: "10000000",
      refundTo: SENDER,
      refundType: "ORIGIN_CHAIN",
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-10T03:40:30.000Z",
    });
    expect(() => exitQuoteRequest({ originToken: "Bad!", destinationAsset: BASE_USDC, amount: 1n, recipient: RECIPIENT, refundTo: SENDER, dry: true })).toThrow();
    expect(() => exitQuoteRequest({ originToken: NEAR_MAINNET_USDC, destinationAsset: BASE_USDC, amount: 0n, recipient: RECIPIENT, refundTo: SENDER, dry: true })).toThrow();
  });
});

describe("payminto-exit CLI", () => {
  const cli = async (argv: string[], routes: Route[], extra: Parameters<typeof run>[1] = {}) => {
    const { fetch, calls } = fakeFetch(routes);
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await run(argv, { fetch, out: (l) => lines.push(l), err: (l) => errs.push(l), now: () => NOW, env: {}, sleep: async () => {}, ...extra });
    return { code, out: lines.join("\n"), err: errs.join("\n"), calls };
  };
  const quoteArgs = ["--to", BASE_USDC, "--amount", "10000000", "--recipient", RECIPIENT, "--sender", SENDER];

  it("a dry quote prints the price and no transfer", async () => {
    const r = await cli(["quote", ...quoteArgs], [{ method: "POST", url: `${API}/v0/quote`, status: 201, body: dryLive.body }]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DRY quote/);
    expect(r.out).toMatch(/1Click signature: valid/);
    expect(r.out).not.toMatch(/HUMAN STEP/);
    expect(r.calls).toHaveLength(1);
    expect((r.calls[0]!.body as { dry: boolean }).dry).toBe(true);
  });

  it("--mainnet prints the human step after checking registration read-only, and never submits a transaction", async () => {
    const r = await cli(
      ["quote", ...quoteArgs, "--mainnet"],
      [
        { method: "POST", url: `${API}/v0/quote`, status: 201, body: wetQuote() },
        { method: "POST", url: RPC, rpc: "storage_balance_of", status: 200, body: rpcView(unregisteredLive.result) },
        { method: "POST", url: RPC, rpc: "storage_balance_bounds", status: 200, body: rpcView(boundsLive.result) },
      ],
      { managerPublicKey: TEST_MANAGER },
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/HUMAN STEP - NEAR MAINNET, REAL FUNDS/);
    expect(r.out).toMatch(/"methodName": "storage_deposit"/);
    expect(r.out).toMatch(/"methodName": "ft_transfer"/);
    expect(r.out).toMatch(new RegExp(`status --deposit ${DEPOSIT} --watch`));
    const rpcMethods = r.calls.filter((c) => c.url === RPC).map((c) => (c.body as { method: string }).method);
    expect(rpcMethods).toEqual(["query", "query"]);
  });

  it("--mainnet refuses and prints no transfer when the signature is not 1Click's", async () => {
    const r = await cli(
      ["quote", ...quoteArgs, "--mainnet"],
      [
        { method: "POST", url: `${API}/v0/quote`, status: 201, body: wetQuote() },
        { method: "POST", url: RPC, rpc: "storage_balance_of", status: 200, body: rpcView(null) },
        { method: "POST", url: RPC, rpc: "storage_balance_bounds", status: 200, body: rpcView(boundsLive.result) },
      ],
    );
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/REFUSED/);
    expect(r.out).not.toMatch(/HUMAN STEP/);
  });

  it("tokens filters by chain and symbol", async () => {
    const r = await cli(["tokens", "--chain", "near", "--symbol", "usdc"], [{ method: "GET", url: `${API}/v0/tokens`, status: 200, body: tokensLive.body }]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`nep141:${NEAR_MAINNET_USDC}`);
    expect(r.out).toMatch(/1 tokens/);
  });

  it("status --watch exits 0 on SUCCESS and reports the destination transaction", async () => {
    const body = statusBody("SUCCESS", { amountOutFormatted: "9.996226", destinationChainTxHashes: [{ hash: "0xabc", explorerUrl: "" }] });
    const r = await cli(["status", "--deposit", DEPOSIT, "--watch"], [{ method: "GET", url: `${API}/v0/status?depositAddress=${DEPOSIT}`, status: 200, body }]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/SUCCESS {2}out 9\.996226 {2}dest tx 0xabc/);
  });

  it("status reports an unknown deposit address as a 1Click 404", async () => {
    const r = await cli(["status", "--deposit", "0".repeat(64)], [{ method: "GET", url: `${API}/v0/status`, status: 404, body: notFoundLive.body }]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/1Click 404: Deposit address 0+ not found/);
  });

  it("submit sends only the documented notification fields", async () => {
    const r = await cli(["submit", "--deposit", DEPOSIT, "--tx", "Hash111", "--sender", SENDER], [{ method: "POST", url: `${API}/v0/deposit/submit`, status: 200, body: statusBody("KNOWN_DEPOSIT_TX") }]);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ depositAddress: DEPOSIT, txHash: "Hash111", nearSenderAccount: SENDER });
  });

  it("rejects bad arguments with usage", async () => {
    expect((await cli(["quote", "--to"], [])).code).toBe(1);
    expect((await cli(["nope"], [])).code).toBe(64);
    expect((await cli(["help"], [])).out).toMatch(/never signs or sends/);
  });
});
