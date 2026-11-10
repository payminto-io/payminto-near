/**
 * A fake 1Click server for tests and the local stack. It follows the live wire shapes recorded on 2026-11-10 (status
 * codes, field names, error messages, rate limit headers) and simulates the swap: a deposit reported through the
 * control API under `/_fake/` (never under `/v0`) moves an address through KNOWN_DEPOSIT_TX, PROCESSING and SUCCESS,
 * or INCOMPLETE_DEPOSIT and REFUNDED when it is short, or FAILED on request.
 *
 * It signs quotes with a public test key, never the 1Click manager key, so a simulated quote can never pass as a live
 * one. Every response carries `x-payminto-simulated: 1`. The `deliver` hook lets the local stack make the delivery a
 * real NEP-141 transfer on its local chain, so the node's on-chain delivery check runs for real.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ed25519 } from "@noble/curves/ed25519.js";
import { isAccountId } from "@payminto/chain";
import { base58 } from "@scure/base";
import { formatUnits, isOriginAddress } from "./checkout.ts";
import type { FetchLike } from "./client.ts";
import { quoteSigningMessage } from "./signature.ts";
import type { ExecutionStatus, OneClickToken, QuoteRequest, QuoteResponse, StatusResponse, SwapDetails, TransactionDetails } from "./types.ts";

/** Public test seed of the fake manager key. Anyone can sign with it, which is the point: it proves nothing. */
export const FAKE_ONECLICK_SEED: Uint8Array = new Uint8Array(32).fill(0x2c);
export const FAKE_ONECLICK_MANAGER_PUBLIC_KEY = `ed25519:${base58.encode(ed25519.getPublicKey(FAKE_ONECLICK_SEED))}`;

/** The 1Click fee account the live API injected into `appFees` on 2026-11-10. */
const LIVE_APP_FEE_RECIPIENT = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
/** The delivery fee to a NEAR account observed on every live quote (0.004628 USDC). */
const WITHDRAW_FEE_USDC = 4_628n;

/**
 * The recorded live token list, trimmed to the entries checkout offers or refuses. Prices are the live ones of
 * 2026-11-10 15:18 UTC; the fake prices every quote from them.
 */
export const FAKE_TOKENS: OneClickToken[] = [
  { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, blockchain: "near", symbol: "USDC", price: 0.999553, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", coingeckoId: "usd-coin" },
  { assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", decimals: 6, blockchain: "eth", symbol: "USDT", price: 0.999094, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", coingeckoId: "tether" },
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, blockchain: "eth", symbol: "USDC", price: 0.999553, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", coingeckoId: "usd-coin" },
  { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", price: 2073.69, priceUpdatedAt: "2026-11-10T15:18:00.903Z", coingeckoId: "ethereum" },
  { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", price: 74377, priceUpdatedAt: "2026-11-10T15:18:00.903Z", coingeckoId: "bitcoin" },
  { assetId: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", decimals: 6, blockchain: "tron", symbol: "USDT", price: 0.999094, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", coingeckoId: "tether" },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, blockchain: "arb", symbol: "USDC", price: 0.999553, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", coingeckoId: "usd-coin" },
  { assetId: "nep141:base.omft.near", decimals: 18, blockchain: "base", symbol: "ETH", price: 2073.69, priceUpdatedAt: "2026-11-10T15:18:00.903Z", coingeckoId: "ethereum" },
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", price: 0.999553, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", coingeckoId: "usd-coin" },
  { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6, blockchain: "sol", symbol: "USDC", price: 0.999553, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", coingeckoId: "usd-coin" },
  { assetId: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", decimals: 6, blockchain: "pol", symbol: "USDC", price: 0.999553, priceUpdatedAt: "2026-11-10T15:18:00.903Z", contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", coingeckoId: "usd-coin" },
];

/** Per origin chain: refund fee in USD and the time estimate in seconds, close to what the live quotes showed. */
const CHAIN_TERMS: Record<string, { refundUsd: number; seconds: number }> = {
  base: { refundUsd: 0.0024, seconds: 35 },
  eth: { refundUsd: 0.3, seconds: 45 },
  arb: { refundUsd: 0.01, seconds: 30 },
  sol: { refundUsd: 0.010005, seconds: 20 },
  pol: { refundUsd: 0.01, seconds: 40 },
  btc: { refundUsd: 1.4, seconds: 807 },
  tron: { refundUsd: 1, seconds: 60 },
};
/** Live minimums: Tron needs $100 per swap, and the Bitcoin bridge 6.165424 USDC out (2026-11-10). */
const TRON_MIN_USD = 100;
const BTC_BRIDGE_MIN_OUT = 6_165_424n;

const REQUIRED: Array<keyof QuoteRequest> = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"];

export type Delivery = { recipient: string; amount: bigint; depositAddress: string; destinationAsset: string; correlationId: string };

export type FakeOneClickOptions = {
  /** The clock quotes and deadlines are judged by, in unix milliseconds. Default `Date.now`. */
  now?: () => number;
  /** Named NEAR recipients that exist. Implicit (64 hex) accounts always exist. Default: none. */
  accountExists?: (accountId: string) => boolean | Promise<boolean>;
  /** Makes the delivery happen somewhere real (the local stack sends a NEP-141 transfer on its chain). */
  deliver?: (d: Delivery) => Promise<{ txHash: string; explorerUrl?: string }>;
  /** Delay between the steps of a swap, in real milliseconds. Default 1000. */
  stepMs?: number;
  /** How long a short deposit waits for a top-up before it is returned. Default three steps. */
  refundAfterMs?: number;
  tokens?: OneClickToken[];
  seed?: Uint8Array;
  log?: (line: string) => void;
};

export type FakeResponse = { status: number; headers: Record<string, string>; body: string };

type Swap = {
  response: QuoteResponse;
  chain: string;
  decimals: number;
  originPrice: number;
  deadlineMs: number;
  status: ExecutionStatus;
  history: ExecutionStatus[];
  deposited: bigint;
  originTxs: TransactionDetails[];
  destinationTxs: TransactionDetails[];
  nearTxs: string[];
  delivered: bigint | null;
  refunded: bigint | null;
  refundReason: string | null;
  updatedAt: number;
  refundTimer: NodeJS.Timeout | null;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms).unref()));

/** Trailing zeros dropped but one decimal kept, as the live `*Formatted` fields are ("5.0", "5.010154"). */
function formatted(v: bigint, decimals: number): string {
  const full = formatUnits(v, decimals);
  if (!full.includes(".")) return `${full}.0`;
  const t = full.replace(/0+$/, "");
  return t.endsWith(".") ? `${t}0` : t;
}

const usd = (v: bigint, decimals: number, price: number) => ((Number(v) / 10 ** decimals) * price).toFixed(12);

export class FakeOneClick {
  readonly managerPublicKey: string;
  readonly #seed: Uint8Array;
  readonly #now: () => number;
  readonly #accountExists: (id: string) => boolean | Promise<boolean>;
  readonly #deliver: FakeOneClickOptions["deliver"];
  readonly #stepMs: number;
  readonly #refundAfterMs: number;
  readonly #tokens: OneClickToken[];
  readonly #log: (line: string) => void;
  readonly #swaps = new Map<string, Swap>();
  readonly #inflight = new Set<Promise<void>>();
  #offsetMs = 0;
  #requests = 0;
  #server: Server | null = null;
  #url = "";

  constructor(o: FakeOneClickOptions = {}) {
    this.#seed = o.seed ?? FAKE_ONECLICK_SEED;
    this.managerPublicKey = `ed25519:${base58.encode(ed25519.getPublicKey(this.#seed))}`;
    this.#now = o.now ?? Date.now;
    this.#accountExists = o.accountExists ?? (() => false);
    this.#deliver = o.deliver;
    this.#stepMs = o.stepMs ?? 1_000;
    this.#refundAfterMs = o.refundAfterMs ?? 3 * this.#stepMs;
    this.#tokens = o.tokens ?? FAKE_TOKENS;
    this.#log = o.log ?? (() => {});
  }

  get url(): string {
    if (!this.#url) throw new Error("the fake 1Click server is not listening; call listen() first");
    return this.#url;
  }

  now(): number {
    return this.#now() + this.#offsetMs;
  }

  /** Listens on 127.0.0.1 (port 0 picks a free one) and resolves to the base URL. */
  listen(port = 0, host = "127.0.0.1"): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void this.handle(req.method ?? "GET", req.url ?? "/", chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined).then((r) => {
            res.writeHead(r.status, { ...r.headers, "content-length": String(Buffer.byteLength(r.body)) });
            res.end(r.body);
          });
        });
      });
      server.once("error", reject);
      server.listen(port, host, () => {
        this.#server = server;
        this.#url = `http://${host}:${(server.address() as AddressInfo).port}`;
        resolve(this.#url);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.#swaps.values()) if (s.refundTimer) clearTimeout(s.refundTimer);
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  /** In-process fetch for OneClickClient: the same handler without a socket. */
  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const r = await this.handle(init?.method ?? "GET", `${u.pathname}${u.search}`, init?.body);
    return { status: r.status, text: async () => r.body };
  };

  /** Resolves once every swap step in flight has run (tests use a step of 0 ms and then wait for this). */
  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
  }

  /** Every status an address went through, in order. */
  history(depositAddress: string): ExecutionStatus[] {
    return [...(this.#swaps.get(depositAddress)?.history ?? [])];
  }

  /** What `POST /_fake/deposits` does: a deposit of `amount` (origin base units) arrived at the address. */
  async deposit(depositAddress: string, amount: bigint, o: { txHash?: string; fail?: boolean } = {}): Promise<ExecutionStatus> {
    const s = this.#swaps.get(depositAddress);
    if (!s) throw new HttpError(404, `Deposit address ${depositAddress} not found`);
    if (amount <= 0n) throw new HttpError(400, "amount must be positive");
    if (["SUCCESS", "REFUNDED", "FAILED", "PROCESSING", "KNOWN_DEPOSIT_TX"].includes(s.status)) throw new HttpError(409, `the swap is already ${s.status}`);
    s.deposited += amount;
    s.originTxs.push({ hash: o.txHash ?? this.#hash(`origin ${depositAddress} ${s.originTxs.length}`, s.chain), explorerUrl: "" });
    this.#log(`deposit ${amount} to ${depositAddress} (total ${s.deposited})`);
    if (s.refundTimer) {
      clearTimeout(s.refundTimer);
      s.refundTimer = null;
    }
    const minIn = BigInt(s.response.quote.minAmountIn);
    if (this.now() > s.deadlineMs) this.#run(s, async () => this.#refund(s, s.deposited, "DEADLINE_EXCEEDED"));
    else if (o.fail) {
      this.#set(s, "KNOWN_DEPOSIT_TX");
      this.#run(s, async () => {
        await sleep(this.#stepMs);
        this.#set(s, "FAILED");
      });
    } else if (s.deposited < minIn) {
      this.#set(s, "INCOMPLETE_DEPOSIT");
      const refund = () => this.#refund(s, s.deposited, "PARTIAL_DEPOSIT");
      if (this.#refundAfterMs <= 0) this.#run(s, async () => refund());
      else {
        // A top-up before this fires clears it, and the swap then runs on the whole deposit.
        s.refundTimer = setTimeout(() => {
          s.refundTimer = null;
          if (s.status === "INCOMPLETE_DEPOSIT") refund();
        }, this.#refundAfterMs);
        s.refundTimer.unref();
      }
    } else this.#run(s, () => this.#swap(s));
    return s.status;
  }

  #run(s: Swap, fn: () => Promise<void>) {
    const p = fn()
      .catch((err: unknown) => {
        this.#log(`swap of ${s.response.quote.depositAddress} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.#set(s, "FAILED");
      })
      .finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  async #swap(s: Swap) {
    this.#set(s, "KNOWN_DEPOSIT_TX");
    await sleep(this.#stepMs);
    this.#set(s, "PROCESSING");
    await sleep(this.#stepMs);
    const q = s.response.quote;
    const req = s.response.quoteRequest;
    const amount = BigInt(q.amountOut);
    let tx: { txHash: string; explorerUrl?: string };
    if (this.#deliver) tx = await this.#deliver({ recipient: req.recipient, amount, depositAddress: q.depositAddress!, destinationAsset: req.destinationAsset, correlationId: s.response.correlationId });
    else tx = { txHash: this.#hash(`delivery ${q.depositAddress}`, "near") };
    s.delivered = amount;
    s.destinationTxs.push({ hash: tx.txHash, explorerUrl: tx.explorerUrl ?? "" });
    s.nearTxs.push(tx.txHash);
    // EXACT_OUTPUT: what is above amountIn goes back to the refund address after the swap.
    const excess = s.deposited - BigInt(q.amountIn);
    if (excess > 0n) s.refunded = excess;
    this.#set(s, "SUCCESS");
  }

  #refund(s: Swap, deposited: bigint, reason: string) {
    const fee = BigInt(s.response.quote.refundFee ?? "0");
    s.refunded = deposited > fee ? deposited - fee : 0n;
    s.refundReason = reason;
    this.#set(s, "REFUNDED");
  }

  #set(s: Swap, status: ExecutionStatus) {
    s.status = status;
    s.history.push(status);
    s.updatedAt = this.now();
    this.#log(`${s.response.quote.depositAddress} ${status}`);
  }

  /** A transaction hash in the format of the chain: 0x and 64 hex on EVM chains, base58 of 32 bytes elsewhere. */
  #hash(seed: string, chain: string): string {
    const h = createHash("sha256").update(`${seed} ${randomUUID()}`).digest();
    return ["base", "eth", "arb", "pol", "bsc", "op"].includes(chain) ? `0x${h.toString("hex")}` : base58.encode(h);
  }

  #headers(): Record<string, string> {
    this.#requests++;
    return {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-ratelimit-limit-unauth": "1200",
      "x-ratelimit-remaining-unauth": String(Math.max(0, 1200 - (this.#requests % 1200))),
      "x-ratelimit-reset-unauth": "60",
      "x-payminto-simulated": "1",
    };
  }

  /** One request, as the HTTP server and `fetch` both route it. Never throws. */
  async handle(method: string, pathWithQuery: string, body?: string): Promise<FakeResponse> {
    const headers = this.#headers();
    const u = new URL(pathWithQuery, "http://fake.local");
    const path = u.pathname;
    const json = (status: number, v: unknown): FakeResponse => ({ status, headers, body: JSON.stringify(v) });
    const fail = (status: number, message: string): FakeResponse =>
      status === 404 && path === "/v0/status"
        ? json(404, { message, error: "Not Found", statusCode: 404, timestamp: new Date(this.now()).toISOString(), path: pathWithQuery })
        : json(status, { message, correlationId: randomUUID(), timestamp: new Date(this.now()).toISOString(), path });
    try {
      const parse = (): Record<string, unknown> => {
        try {
          const v = body ? (JSON.parse(body) as unknown) : {};
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
          return v as Record<string, unknown>;
        } catch {
          throw new HttpError(400, "body must be a JSON object");
        }
      };
      if (method === "GET" && path === "/v0/tokens") return json(200, this.#tokens);
      if (method === "POST" && path === "/v0/quote") return json(201, await this.#quote(parse()));
      if (method === "GET" && path === "/v0/status") {
        const s = this.#swaps.get(u.searchParams.get("depositAddress") ?? "");
        if (!s) return fail(404, `Deposit address ${u.searchParams.get("depositAddress") ?? ""} not found`);
        return json(200, this.#status(s));
      }
      if (method === "POST" && path === "/v0/deposit/submit") {
        const b = parse();
        const s = this.#swaps.get(String(b.depositAddress ?? ""));
        if (!s) return json(404, { message: `Deposit address ${String(b.depositAddress ?? "")} not found`, error: "Not Found", statusCode: 404, timestamp: new Date(this.now()).toISOString(), path });
        const hash = String(b.txHash ?? "");
        if (hash && !s.originTxs.some((t) => t.hash === hash)) s.originTxs.push({ hash, explorerUrl: "" });
        return json(200, this.#status(s));
      }
      if (method === "POST" && path === "/_fake/deposits") {
        const b = parse();
        const amount = String(b.amount ?? "");
        if (!/^[1-9][0-9]*$/.test(amount)) throw new HttpError(400, "amount must be a positive integer of origin base units");
        const status = await this.deposit(String(b.depositAddress ?? ""), BigInt(amount), { ...(typeof b.txHash === "string" ? { txHash: b.txHash } : {}), fail: b.fail === true });
        return json(200, { depositAddress: b.depositAddress, status });
      }
      if (method === "POST" && path === "/_fake/clock") {
        const b = parse();
        if (typeof b.advanceMs === "number") this.#offsetMs += b.advanceMs;
        return json(200, { now: new Date(this.now()).toISOString() });
      }
      if (method === "GET" && path === "/_fake/state") {
        return json(200, { swaps: [...this.#swaps.entries()].map(([address, s]) => ({ depositAddress: address, status: s.status, history: s.history, deposited: s.deposited.toString() })) });
      }
      return fail(404, `Cannot ${method} ${path}`);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      this.#log(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return fail(500, "Internal server error");
    }
  }

  async #quote(b: Record<string, unknown>): Promise<QuoteResponse> {
    for (const k of REQUIRED) if (b[k] === undefined || b[k] === null || b[k] === "") throw new HttpError(400, `${k} is required`);
    const r = b as unknown as QuoteRequest;
    if (r.customRecipientMsg !== undefined) throw new HttpError(400, "customRecipientMsg is not supported by this fake");
    const deadline = Date.parse(String(r.deadline));
    if (!Number.isFinite(deadline) || deadline <= this.now()) throw new HttpError(400, "deadline is not valid");
    if (!/^[1-9][0-9]*$/.test(String(r.amount))) throw new HttpError(400, "amount is not valid");
    if (!Number.isInteger(r.slippageTolerance) || r.slippageTolerance < 0 || r.slippageTolerance > 10_000) throw new HttpError(400, "slippageTolerance is not valid");
    const origin = this.#tokens.find((t) => t.assetId === r.originAsset);
    const dest = this.#tokens.find((t) => t.assetId === r.destinationAsset);
    if (!origin) throw new HttpError(400, `Token ${r.originAsset} is not supported`);
    if (!dest) throw new HttpError(400, `Token ${r.destinationAsset} is not supported`);
    if (r.swapType !== "EXACT_OUTPUT" || r.depositType !== "ORIGIN_CHAIN" || r.refundType !== "ORIGIN_CHAIN") throw new HttpError(400, "this fake simulates EXACT_OUTPUT from an origin chain only");
    if (!this.#validRefund(origin.blockchain, String(r.refundTo))) throw new HttpError(400, "refundTo is not valid");
    if (dest.blockchain !== "near" || r.recipientType !== "DESTINATION_CHAIN") throw new HttpError(400, "this fake delivers to NEAR accounts only");
    const recipient = String(r.recipient);
    const implicit = /^[0-9a-f]{64}$/.test(recipient) || /^0x[0-9a-f]{40}$/.test(recipient);
    // The live API answers a named account that does not exist with a bare 500-style message and HTTP 400.
    if (!isAccountId(recipient) || (!implicit && !(await this.#accountExists(recipient)))) throw new HttpError(400, "Internal server error");

    const amount = BigInt(r.amount);
    const usdcPrice = dest.price;
    const outUsd = (Number(amount + WITHDRAW_FEE_USDC) / 10 ** dest.decimals) * usdcPrice;
    if (origin.blockchain === "tron" && outUsd < TRON_MIN_USD) throw new HttpError(400, `Temporary swap limits: minimum swap amount is $${TRON_MIN_USD}`);
    if (origin.blockchain === "btc" && amount < BTC_BRIDGE_MIN_OUT) throw new HttpError(400, `Amount is too low for bridge, try at least ${BTC_BRIDGE_MIN_OUT}`);
    const stable = /^USD/.test(origin.symbol);
    const feeBps = stable ? 1 : 20;
    const minInUsd = outUsd / (1 - feeBps / 10_000);
    const minAmountIn = BigInt(Math.ceil((minInUsd / origin.price) * 10 ** origin.decimals));
    const amountIn = BigInt(Math.ceil(Number(minAmountIn) * (1 + r.slippageTolerance / 10_000)));
    const terms = CHAIN_TERMS[origin.blockchain] ?? { refundUsd: 0.01, seconds: 60 };
    const refundFee = BigInt(Math.ceil((terms.refundUsd / origin.price) * 10 ** origin.decimals));

    const { dry, ...rest } = r;
    const quoteRequest: QuoteRequest = {
      dry,
      depositMode: r.depositMode ?? "SIMPLE",
      ...rest,
      confidentiality: r.confidentiality ?? "public",
      quoteWaitingTimeMs: r.quoteWaitingTimeMs ?? 0,
      insured: r.insured ?? false,
      appFees: [{ recipient: LIVE_APP_FEE_RECIPIENT, fee: feeBps }],
    };
    const correlationId = randomUUID();
    let quote: QuoteResponse["quote"] = {
      amountIn: amountIn.toString(),
      amountInFormatted: formatted(amountIn, origin.decimals),
      amountInUsd: usd(amountIn, origin.decimals, origin.price),
      minAmountIn: minAmountIn.toString(),
      amountOut: amount.toString(),
      amountOutFormatted: formatted(amount, dest.decimals),
      amountOutUsd: usd(amount, dest.decimals, usdcPrice),
      minAmountOut: amount.toString(),
      timeEstimate: terms.seconds,
      refundFee: refundFee.toString(),
      withdrawFee: WITHDRAW_FEE_USDC.toString(),
    };
    if (!dry) {
      const seed = createHash("sha256").update(`deposit ${correlationId}`).digest();
      let address: string;
      if (origin.blockchain === "sol") address = base58.encode(seed);
      else if (origin.blockchain === "btc") address = `bc1q${seed.toString("hex").slice(0, 38)}`;
      else if (origin.blockchain === "tron") address = `T${base58.encode(seed).slice(0, 33)}`;
      else address = `0x${seed.toString("hex").slice(0, 40)}`;
      // The deposit address becomes inactive at the requested deadline.
      quote = { depositAddress: address, ...quote, deadline: new Date(deadline).toISOString(), timeWhenInactive: new Date(deadline).toISOString() };
    }
    const response: QuoteResponse = { quote, quoteRequest, signature: "", timestamp: new Date(this.now()).toISOString(), correlationId };
    response.signature = `ed25519:${base58.encode(ed25519.sign(quoteSigningMessage(response), this.#seed))}`;
    if (!dry) {
      const address = quote.depositAddress!;
      this.#swaps.set(address, {
        response,
        chain: origin.blockchain,
        decimals: origin.decimals,
        originPrice: origin.price,
        deadlineMs: deadline,
        status: "PENDING_DEPOSIT",
        history: ["PENDING_DEPOSIT"],
        deposited: 0n,
        originTxs: [],
        destinationTxs: [],
        nearTxs: [],
        delivered: null,
        refunded: null,
        refundReason: null,
        updatedAt: this.now(),
        refundTimer: null,
      });
      this.#log(`wet quote ${correlationId}: deposit ${quote.amountIn} of ${origin.symbol} on ${origin.blockchain} to ${address}`);
    }
    return response;
  }

  #validRefund(chain: string, address: string): boolean {
    if (chain === "sol") return isOriginAddress({ addressFormat: "solana" }, address);
    if (chain === "btc") return /^(bc1[a-z0-9]{20,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address);
    if (chain === "tron") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
    if (chain === "near") return isAccountId(address);
    return isOriginAddress({ addressFormat: "evm" }, address);
  }

  #status(s: Swap): StatusResponse {
    const q = s.response.quote;
    const req = s.response.quoteRequest;
    const d: SwapDetails = {
      intentHashes: s.delivered !== null ? [this.#hash(`intent ${q.depositAddress}`, "near")] : [],
      nearTxHashes: [...s.nearTxs],
      originChainTxHashes: s.originTxs.map((t) => ({ ...t })),
      destinationChainTxHashes: s.destinationTxs.map((t) => ({ ...t })),
    };
    if (s.deposited > 0n) {
      d.depositedAmount = s.deposited.toString();
      d.depositedAmountFormatted = formatted(s.deposited, s.decimals);
      d.depositedAmountUsd = usd(s.deposited, s.decimals, s.originPrice);
    }
    if (s.delivered !== null) {
      d.amountIn = q.amountIn;
      d.amountInFormatted = q.amountInFormatted;
      d.amountInUsd = q.amountInUsd;
      d.amountOut = s.delivered.toString();
      d.amountOutFormatted = q.amountOutFormatted;
      d.amountOutUsd = q.amountOutUsd;
      d.slippage = 0;
      d.withdrawFee = q.withdrawFee;
    }
    if (s.refunded !== null) {
      d.refundedAmount = s.refunded.toString();
      d.refundedAmountFormatted = formatted(s.refunded, s.decimals);
      d.refundedAmountUsd = usd(s.refunded, s.decimals, s.originPrice);
      if (s.refundReason) d.refundReason = s.refundReason;
    }
    if (req.referral) d.referral = req.referral;
    return { correlationId: s.response.correlationId, quoteResponse: s.response, status: s.status, updatedAt: new Date(s.updatedAt).toISOString(), swapDetails: d };
  }
}
