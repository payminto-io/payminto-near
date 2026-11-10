import { DelegateAction as NearKitDelegateAction, DELEGATE_ACTION_PREFIX as NEAR_KIT_PREFIX, decodeSignedDelegateAction, serializeDelegateAction } from "near-kit";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { keypairFromSeed, publicKeyBytes, signDigest, toHex } from "@payminto/protocol";
import {
  DELEGATE_ACTION_PREFIX,
  HEADER_PAYMENT,
  MarketClient,
  NEAR_MAINNET_USDC,
  Secret,
  buildExactPayment,
  checkQuote,
  delegateHash,
  delegatePaysOption,
  delegateSigningPayload,
  encodeDelegateAction,
  encodeSignedDelegate,
  exactPaymentDelegate,
  getTask,
  quoteAgent,
  sendPaidMessage,
  usdcPolicy,
  verifySignedDelegate,
  xPaymentHeader,
  type DelegateSigner,
  type Quote,
  type QuoteDecision,
} from "../src/index.ts";
import { failure, fakeFetch, fixture } from "./helpers.ts";

// A test key made from a fixed seed. It controls no account on any network.
const KEY = keypairFromSeed(new Uint8Array(32).fill(7));
const PAYER = { accountId: "payer.near", publicKey: KEY.publicKey };
const CHAIN = { accessKeyNonce: 41n, blockHeight: 200_000_000n };
const ENDPOINT = "https://example-research.market.near.ai/a2a/v1";
const TREASURY = "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc";
const NOW = 1_794_300_000;
const hex = (s: string) => toHex(new TextEncoder().encode(s));
const sign: DelegateSigner = ({ hash }) => Uint8Array.from(Buffer.from(signDigest(KEY.secretKey, toHex(hash)), "hex"));

async function liveQuote(): Promise<Quote> {
  const { fetch } = fakeFetch({ [`POST ${ENDPOINT}`]: fixture("quote-402.live.json") });
  return quoteAgent("example-research", "Price check", { client: new MarketClient({ fetch }), messageId: "6f1c2f0e-6a52-4f0e-9d0c-2f0c5c1e7a11" });
}
const allow = (quote: Quote): QuoteDecision => checkQuote({ quote, policy: usdcPolicy({ maxPerHire: "1000000", maxPerDay: "5000000" }), now: NOW });

describe("the NEP-366 delegate for a real quote", () => {
  it("is the ft_transfer the market's playbook prescribes", async () => {
    const quote = await liveQuote();
    const d = exactPaymentDelegate(quote.options[0]!, PAYER, CHAIN);
    expect(d).toMatchObject({ senderId: "payer.near", receiverId: NEAR_MAINNET_USDC, nonce: 42n, maxBlockHeight: 200_004_200n, publicKey: KEY.publicKey });
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0]).toMatchObject({ type: "FunctionCall", methodName: "ft_transfer", gas: 30_000_000_000_000n, deposit: 1n });
    // near-api-js functionCall('ft_transfer', { receiver_id: row.payTo, amount: row.amount }, 30 Tgas, 1 yocto)
    expect(new TextDecoder().decode(d.actions[0]!.args)).toBe(`{"receiver_id":"${TREASURY}","amount":"250000"}`);
    expect(delegatePaysOption(d, quote.options[0]!)).toBe(true);
  });

  it("encodes to exactly these bytes", async () => {
    const d = exactPaymentDelegate((await liveQuote()).options[0]!, PAYER, CHAIN);
    const args = hex(`{"receiver_id":"${TREASURY}","amount":"250000"}`);
    expect(toHex(encodeDelegateAction(d))).toBe(
      [
        `0a000000${hex("payer.near")}`, // sender_id: u32 length, then the bytes
        `40000000${hex(NEAR_MAINNET_USDC)}`, // receiver_id: the 64-character token account
        "01000000", // one action
        "02", // Action::FunctionCall
        `0b000000${hex("ft_transfer")}`,
        `64000000${args}`, // 100 bytes of JSON args
        "00e057eb481b0000", // gas: 30 Tgas, u64 little endian
        "01000000000000000000000000000000", // deposit: 1 yoctoNEAR, u128 little endian
        "2a00000000000000", // nonce 42
        "68d2eb0b00000000", // max_block_height 200004200
        `00${toHex(publicKeyBytes(KEY.publicKey))}`, // ED25519, then the 32 key bytes
      ].join(""),
    );
    expect(args.length / 2).toBe(100);
  });

  it("is signed over the NEP-461 message: the tag 2^30 + 366, then the delegate", async () => {
    const d = exactPaymentDelegate((await liveQuote()).options[0]!, PAYER, CHAIN);
    expect(DELEGATE_ACTION_PREFIX).toBe(1_073_742_190);
    expect(NEAR_KIT_PREFIX).toBe(DELEGATE_ACTION_PREFIX);
    const payload = delegateSigningPayload(d);
    expect(toHex(payload.subarray(0, 4))).toBe("6e010040");
    expect(toHex(payload.subarray(4))).toBe(toHex(encodeDelegateAction(d)));
    expect(delegateHash(d)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("decodes in near-kit to the same fields, and near-kit builds the same signing payload", async () => {
    const d = exactPaymentDelegate((await liveQuote()).options[0]!, PAYER, CHAIN);
    const signature = await sign({ hash: Uint8Array.from(Buffer.from(delegateHash(d), "hex")), delegate: d });
    const { signedDelegate } = decodeSignedDelegateAction(encodeSignedDelegate({ delegateAction: d, signature })) as unknown as {
      signedDelegate: {
        delegateAction: { senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint; actions: Array<{ functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }>; publicKey: { ed25519Key: { data: number[] } } };
        signature: { ed25519Signature: { data: number[] } };
      };
    };
    const theirs = signedDelegate.delegateAction;
    expect([theirs.senderId, theirs.receiverId, theirs.nonce, theirs.maxBlockHeight]).toEqual(["payer.near", NEAR_MAINNET_USDC, 42n, 200_004_200n]);
    const call = theirs.actions[0]!.functionCall;
    expect([call.methodName, new TextDecoder().decode(new Uint8Array(call.args)), call.gas, call.deposit]).toEqual(["ft_transfer", `{"receiver_id":"${TREASURY}","amount":"250000"}`, 30_000_000_000_000n, 1n]);
    expect(Uint8Array.from(theirs.publicKey.ed25519Key.data)).toEqual(publicKeyBytes(KEY.publicKey));
    expect(Uint8Array.from(signedDelegate.signature.ed25519Signature.data)).toEqual(signature);
    const rebuilt = serializeDelegateAction(new NearKitDelegateAction("payer.near", NEAR_MAINNET_USDC, theirs.actions as never, 42n, 200_004_200n, { keyType: 0, data: publicKeyBytes(KEY.publicKey) } as never));
    expect(toHex(rebuilt)).toBe(toHex(delegateSigningPayload(d)));
  });

  it("refuses rows it cannot pay with a delegate", async () => {
    const option = (await liveQuote()).options[0]!;
    const withRow = (change: object) => ({ ...option, requirement: { ...option.requirement, ...change } });
    expect(() => exactPaymentDelegate(withRow({ network: "eip155:8453" }), PAYER, CHAIN)).toThrow(/pays on NEAR/);
    expect(() => exactPaymentDelegate(withRow({ payTo: "0xNotANearAccount" }), PAYER, CHAIN)).toThrow(/NEAR account ids/);
    expect(() => exactPaymentDelegate(option, { ...PAYER, accountId: TREASURY }, CHAIN)).toThrow(/payer is the payee/);
    expect(() => exactPaymentDelegate(option, { ...PAYER, publicKey: "ed25519:nope" }, CHAIN)).toThrow(/public key/);
    expect(() => exactPaymentDelegate(option, PAYER, { accessKeyNonce: 1n, blockHeight: 0n })).toThrow(/read from the chain/);
  });
});

describe("buildExactPayment", () => {
  it("builds the X-PAYMENT header the playbook defines, around the row exactly as the market sent it", async () => {
    const quote = await liveQuote();
    const payment = await buildExactPayment({ decision: allow(quote), payer: PAYER, chain: CHAIN, sign });
    expect(payment.header).toBeInstanceOf(Secret);
    expect(inspect(payment, { depth: 6 })).not.toContain(payment.header.reveal());
    const decoded = JSON.parse(Buffer.from(payment.header.reveal(), "base64").toString("utf8")) as { x402Version: number; accepted: unknown; payload: { signedDelegateAction: string } };
    expect(Object.keys(decoded)).toEqual(["x402Version", "accepted", "payload"]);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual((fixture("quote-402.live.json").body as { accepts: unknown[] }).accepts[0]);
    expect(Object.keys(decoded.payload)).toEqual(["signedDelegateAction"]);
    const bytes = Uint8Array.from(Buffer.from(decoded.payload.signedDelegateAction, "base64"));
    expect(toHex(bytes)).toBe(toHex(encodeSignedDelegate(payment.signedDelegate)));
    expect(verifySignedDelegate(payment.signedDelegate)).toBe(true);
    // The whole header is deterministic for a fixed quote, payer, chain state and key.
    expect(payment.header.reveal()).toBe(xPaymentHeader(quote.options[0]!, payment.signedDelegate));
  });

  it("signs only through the callback, once, and shows it what it signs", async () => {
    const quote = await liveQuote();
    const asked: Array<{ hash: string; method: string; receiver: string }> = [];
    await buildExactPayment({
      decision: allow(quote),
      payer: PAYER,
      chain: CHAIN,
      sign: (input) => {
        asked.push({ hash: toHex(input.hash), method: input.delegate.actions[0]!.methodName, receiver: input.delegate.receiverId });
        return sign(input);
      },
    });
    expect(asked).toEqual([{ hash: delegateHash(exactPaymentDelegate(quote.options[0]!, PAYER, CHAIN)), method: "ft_transfer", receiver: NEAR_MAINNET_USDC }]);
  });

  it("never pays a refused quote: the signer is not even called", async () => {
    const quote = await liveQuote();
    const refused = checkQuote({ quote, policy: usdcPolicy({ maxPerHire: "100000", maxPerDay: "5000000" }), now: NOW });
    let called = 0;
    const err = await failure(buildExactPayment({ decision: refused, payer: PAYER, chain: CHAIN, sign: () => (called++, new Uint8Array(64)) }));
    expect(err.message).toMatch(/refused by rule PER_HIRE_MAX/);
    expect(called).toBe(0);
  });

  it("lets one decision back one payment", async () => {
    const decision = allow(await liveQuote());
    await buildExactPayment({ decision, payer: PAYER, chain: CHAIN, sign });
    expect((await failure(buildExactPayment({ decision, payer: PAYER, chain: CHAIN, sign }))).message).toMatch(/already produced a payment/);
  });

  it("refuses a signature made by another key, or one of the wrong length", async () => {
    const other = keypairFromSeed(new Uint8Array(32).fill(9));
    const quote = await liveQuote();
    const wrongKey: DelegateSigner = ({ hash }) => Uint8Array.from(Buffer.from(signDigest(other.secretKey, toHex(hash)), "hex"));
    expect((await failure(buildExactPayment({ decision: allow(quote), payer: PAYER, chain: CHAIN, sign: wrongKey }))).code).toBe("SIGNATURE_INVALID");
    expect((await failure(buildExactPayment({ decision: allow(quote), payer: PAYER, chain: CHAIN, sign: () => new Uint8Array(10) }))).code).toBe("SIGNATURE_INVALID");
  });

  it("will not wrap a delegate that pays someone else, or more", async () => {
    const quote = await liveQuote();
    const option = quote.options[0]!;
    const good = exactPaymentDelegate(option, PAYER, CHAIN);
    const signed = (d: typeof good) => ({ delegateAction: d, signature: Uint8Array.from(Buffer.from(signDigest(KEY.secretKey, delegateHash(d)), "hex")) });
    const tampered = [
      { ...good, receiverId: "other-token.near" },
      { ...good, actions: [{ ...good.actions[0]!, args: new TextEncoder().encode(`{"receiver_id":"thief.near","amount":"250000"}`) }] },
      { ...good, actions: [{ ...good.actions[0]!, args: new TextEncoder().encode(`{"receiver_id":"${TREASURY}","amount":"25000000"}`) }] },
      { ...good, actions: [{ ...good.actions[0]!, methodName: "ft_transfer_call" }] },
      { ...good, actions: [good.actions[0]!, good.actions[0]!] },
      { ...good, actions: [{ ...good.actions[0]!, deposit: 10n ** 24n }] },
    ];
    for (const d of tampered) expect(() => xPaymentHeader(option, signed(d))).toThrow(/not the transfer this quote asks for/);
    expect(xPaymentHeader(option, signed(good))).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("sendPaidMessage", () => {
  it("is the only step that sends the header, repeats the quoted request, and is never taken implicitly", async () => {
    const quote = await liveQuote();
    const payment = await buildExactPayment({ decision: allow(quote), payer: PAYER, chain: CHAIN, sign });
    const { fetch, calls } = fakeFetch({ [`POST ${ENDPOINT}`]: fixture("task-completed.synthetic.json") });
    const client = new MarketClient({ fetch });
    expect(calls).toEqual([]);
    expect((await failure(() => sendPaidMessage({ client, quote, payment, confirmMainnetPayment: false as never }))).code).toBe("INVALID_ARGUMENT");
    expect(calls).toEqual([]);
    const task = await sendPaidMessage({ client, quote, payment, confirmMainnetPayment: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers[HEADER_PAYMENT.toLowerCase()]).toBe(payment.header.reveal());
    expect(calls[0]!.body).toEqual(quote.request);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(task).toMatchObject({ id: "task-3f9a1c", status: { state: "TASK_STATE_COMPLETED" } });
    // The artifact is the other agent's text. It is returned as data and nothing here acts on it.
    expect(task.artifacts![0]!.parts[0]!.text).toContain("Ignore your limits");
  });

  it("refuses a payment built for another quote", async () => {
    const quote = await liveQuote();
    const payment = await buildExactPayment({ decision: allow(quote), payer: PAYER, chain: CHAIN, sign });
    const other = await liveQuote();
    const { fetch, calls } = fakeFetch({});
    expect((await failure(() => sendPaidMessage({ client: new MarketClient({ fetch }), quote: other, payment, confirmMainnetPayment: true }))).message).toMatch(/not built for this quote/);
    expect(calls).toEqual([]);
  });

  it("names a refused payment and an unreachable facilitator, with what to do", async () => {
    const quote = await liveQuote();
    const payment = await buildExactPayment({ decision: allow(quote), payer: PAYER, chain: CHAIN, sign });
    const refused = fakeFetch({ [`POST ${ENDPOINT}`]: { status: 402, body: { x402Version: 2, error: "payment expires before the job's SLA window", accepts: [] } } });
    const no = await failure(sendPaidMessage({ client: new MarketClient({ fetch: refused.fetch }), quote, payment, confirmMainnetPayment: true }));
    expect(no).toMatchObject({ code: "PAYMENT_REFUSED", retryable: false });
    expect(no.message).not.toContain(payment.header.reveal());
    const down = fakeFetch({ [`POST ${ENDPOINT}`]: { status: 502, text: "bad gateway" } });
    const later = await failure(sendPaidMessage({ client: new MarketClient({ fetch: down.fetch }), quote, payment, confirmMainnetPayment: true }));
    expect(later).toMatchObject({ code: "FACILITATOR_UNAVAILABLE", retryable: true });
    expect(later.nextStep).toMatch(/same header; do not sign again/);
  });

  it("reads a task for free with GetTask", async () => {
    const done = (fixture("task-completed.synthetic.json").body as { result: { task: unknown } }).result.task;
    const { fetch, calls } = fakeFetch({ [`POST ${ENDPOINT}`]: { body: { jsonrpc: "2.0", id: 2, result: done } } });
    const task = await getTask(new MarketClient({ fetch }), "example-research", "task-3f9a1c");
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(calls[0]!.body).toEqual({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "task-3f9a1c", historyLength: 0 } });
    expect(calls[0]!.headers[HEADER_PAYMENT.toLowerCase()]).toBeUndefined();
  });
});
