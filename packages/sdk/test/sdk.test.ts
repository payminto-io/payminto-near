import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { FakeChain } from "@payminto/chain/fake";
import {
  budgetIdOf,
  budgetTermsToJson,
  buildReceiptTree,
  computeNetting,
  decodeHeader,
  encodeHeader,
  acceptanceDigest,
  keypairFromSeed,
  nodeVoucherBody,
  parsePaymentSignature,
  vouchersOf,
  nodeDigest,
  openBudgetTx,
  policyHash,
  sha256Text,
  signAcceptance,
  signDigest,
  verifyDigest,
  voucherCallId,
  voucherDigest,
  type AccountId,
  type BudgetTerms,
  type ClearingReceipt,
  type Id32,
  type Keypair,
  type Network,
  type Policy,
  type PublicKey,
  type Refusal,
  type Sig64,
} from "@payminto/protocol";
import {
  AgentClient,
  type BeforeSignRequest,
  callIdOf,
  computeRequestHash,
  KeyedMutex,
  MemoryReceiptStore,
  MemoryVoucherStore,
  NO_ACCEPTANCE,
  exportVouchers,
  parseVoucherExport,
  settleOwnClaims,
  settleOwnTxs,
  OwnerClient,
  paywall,
  revokeDigest,
  SqliteReceiptStore,
  verifyReceiptOnchain,
  type DeniedEvent,
  type StoredVoucher,
} from "../src/index.ts";

const key = (n: number): Keypair => keypairFromSeed(new Uint8Array(32).fill(n));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "OK";
};
/** The claim and acceptance of a stored voucher, as `settle_own` takes them. */
const claimAndAcceptance = (v: StoredVoucher) =>
  [
    { budgetId: v.budgetId, payee: v.payee, amount: BigInt(v.amount), cumulative: BigInt(v.cumulative), requestHash: v.requestHash, signature: v.signature },
    { nodeKey: v.acceptance!.nodeKey, timestampS: BigInt(v.acceptance!.timestampS), signature: v.acceptance!.signature },
  ] as const;
const AGENT = key(1);
const NODE = key(2);
const EVIL = key(3);
const NETWORK: Network = "near:sandbox";
const HUB: AccountId = "hub.payminto.testnet";
const TOKEN: AccountId = "usdc.fake.testnet";
const OPERATOR: AccountId = "node.payminto.testnet";
const PAYEE: AccountId = "payee-a.testnet";
const PAYEE_2: AccountId = "payee-b.testnet";
const OWNER: AccountId = "owner.testnet";
const NOW_MS = BigInt(Date.now());
const POLICY: Policy = { perCallCap: "10000", dailyCap: "1000000", maxCallsPerMinute: 0, purpose: "sdk tests" };

type Bundle = { id: Id32; budget: BudgetTerms; policy: Policy };
function bundle(over: { budget?: Partial<BudgetTerms>; policy?: Partial<Policy> } = {}): Bundle {
  const policy = { ...POLICY, ...over.policy };
  const budget: BudgetTerms = {
    owner: OWNER,
    agentPk: AGENT.publicKey,
    settler: OPERATOR,
    cap: 10_000_000n,
    validUntil: NOW_MS + 86_400_000n,
    payees: [PAYEE, PAYEE_2],
    policyHash: policyHash(policy),
    salt: sha256Text("salt"),
    ...over.budget,
  };
  return { id: budgetIdOf(HUB, NETWORK, budget), budget, policy };
}
const DEFAULT = bundle();
const BUDGET = DEFAULT.id;
const NODE_URL = "http://node.test";

type Script = {
  /** The Budget the fake node clears (default DEFAULT). */
  bundle?: Bundle;
  /** What GET /v1/budgets/:id/policy serves; defaults to the honest bundle. */
  servedPolicy?: { budget: BudgetTerms; policy: Policy };
  alwaysStale?: boolean;
  receiptSigner?: Keypair;
  /** Key the receipt names as its node (default the honest node key). */
  receiptNode?: PublicKey;
  /** Added to every position GET /position serves (a lying node). */
  inflatePosition?: bigint;
  /** Refuse every voucher with this machine-readable refusal. */
  refuse?: Refusal;
  /** The receipt handed to the seller names this call id; its digest and node signature stay those of the real call. */
  swapCallId?: Id32;
};

type VoucherBody = { payload: { budgetId: Id32; payee: AccountId; amount: string; cumulative: string; signature: Sig64; requestHash: Id32 } };

/** In-memory clearing node + two providers behind the real SDK paywall. Everything goes through one fetch. */
function world(script: Script = {}) {
  const truth = new Map<string, bigint>();
  const accepted: Array<{ payee: AccountId; cumulative: bigint }> = [];
  const booked = new Map<string, ClearingReceipt>();
  const inflight = new Map<string, number>();
  let maxInflightSamePayee = 0;
  let maxInflightAll = 0;
  let totalInflight = 0;
  const voucherPosts: unknown[] = [];

  const b = script.bundle ?? DEFAULT;
  const BUDGET = b.id;
  const node = new Hono();
  node.get("/v1/budgets/:id/policy", (c) => {
    const served = script.servedPolicy ?? b;
    return c.json({ id: BUDGET, status: "open", budget: budgetTermsToJson(served.budget), policy: served.policy, payees: served.budget.payees });
  });
  node.get("/v1/info", (c) =>
    c.json({ version: "t", network: { id: NETWORK, name: "Local NEAR sandbox" }, hub: HUB, token: { address: TOKEN, symbol: "USDC", decimals: 6 }, operator: OPERATOR, nodeKey: NODE.publicKey, publicUrl: NODE_URL }),
  );
  node.get("/v1/providers", (c) =>
    c.json([
      { id: "prv_a", name: "A", description: "quotes", payee: PAYEE, priceAtomic: "2000", resource: "/q", category: "data", calls24h: 0 },
      { id: "prv_b", name: "B", description: "briefs", payee: PAYEE_2, priceAtomic: "5000", resource: "/b", category: "data", calls24h: 0 },
    ]),
  );
  node.get("/v1/budgets/:id/position", (c) => {
    const payee = c.req.query("payee")!;
    const served = (truth.get(payee) ?? 0n) + (script.inflatePosition ?? 0n);
    return c.json({ budgetId: BUDGET, payee, cumulative: served.toString(), settled: "0" });
  });
  node.post("/v1/vouchers", async (c) => {
    const body = (await c.req.json()) as VoucherBody;
    voucherPosts.push(body);
    const p = body.payload;
    const payee = p.payee;
    totalInflight++;
    inflight.set(payee, (inflight.get(payee) ?? 0) + 1);
    maxInflightSamePayee = Math.max(maxInflightSamePayee, inflight.get(payee)!);
    maxInflightAll = Math.max(maxInflightAll, totalInflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight.set(payee, inflight.get(payee)! - 1);
    totalInflight--;
    if (script.refuse) return c.json({ error: { code: script.refuse.rule, message: script.refuse.message, details: {} }, refusal: script.refuse }, 402);
    const pos = truth.get(payee) ?? 0n;
    const position = { budgetId: BUDGET, payee, cumulative: pos.toString(), settled: "0" };
    if (script.alwaysStale || BigInt(p.cumulative) !== pos + BigInt(p.amount)) {
      return c.json({ error: { code: "STALE_CUMULATIVE", message: "stale", details: { position } } }, 402);
    }
    const digest = voucherDigest(HUB, NETWORK, { budgetId: BUDGET, payee, amount: BigInt(p.amount), cumulative: BigInt(p.cumulative), requestHash: p.requestHash });
    if (!verifyDigest(AGENT.publicKey, digest, p.signature)) return c.json({ error: { code: "BAD_SIGNATURE", message: "bad" } }, 402);
    truth.set(payee, BigInt(p.cumulative));
    accepted.push({ payee, cumulative: BigInt(p.cumulative) });
    const base = { callId: callIdOf({ budgetId: BUDGET, payee, cumulative: BigInt(p.cumulative), requestHash: p.requestHash }), budgetId: BUDGET, payee, requestHash: p.requestHash, voucherSig: p.signature };
    const attested = nodeDigest({ ...base, amount: BigInt(p.amount), cumulative: BigInt(p.cumulative), timestamp: 1_800_000_000n });
    const receipt: ClearingReceipt = {
      ...base,
      amount: p.amount,
      cumulative: p.cumulative,
      timestamp: 1_800_000_000,
      digest: attested,
      nodeSignature: signDigest((script.receiptSigner ?? NODE).secretKey, attested),
      node: script.receiptNode ?? NODE.publicKey,
    };
    booked.set(receipt.callId, receipt);
    return c.json({ receipt: script.swapCallId ? { ...receipt, callId: script.swapCallId } : receipt, position: { ...position, cumulative: p.cumulative } });
  });
  // The public lookup an agent uses to ask its own node what became of a voucher it signed.
  node.get("/v1/receipts/:callId/proof", (c) => {
    const receipt = booked.get(c.req.param("callId"));
    return receipt ? c.json({ receipt, status: "accepted", batchId: null, proof: [] }) : c.json({ error: { code: "NOT_FOUND", message: "call not found" } }, 404);
  });

  // A node the honest agent must never talk to: it would serve an inflated position.
  const evilNodeHits: string[] = [];
  const evilNode = new Hono();
  evilNode.all("*", (c) => {
    evilNodeHits.push(c.req.path);
    return c.json({ budgetId: BUDGET, payee: PAYEE, cumulative: "9000000", settled: "0" });
  });

  const provider = new Hono();
  const fetchAll = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "node.test") return node.request(url.pathname + url.search, init);
    if (url.host === "evil-node.test") return evilNode.request(url.pathname + url.search, init);
    return provider.request(input instanceof Request ? input : url.toString(), init);
  }) as typeof fetch;

  const requirement = (over: { clearingNode?: string; asset?: AccountId; payTo?: AccountId; amount?: string; splits?: Array<{ payTo: AccountId; amount: string; providerId: string }> } = {}) => ({
    scheme: "payminto-voucher",
    network: NETWORK,
    asset: over.asset ?? TOKEN,
    payTo: over.payTo ?? PAYEE,
    amount: over.amount ?? "2000",
    maxTimeoutSeconds: 60,
    extra: { clearingNode: over.clearingNode ?? NODE_URL, clearingHub: HUB, providerId: "prv_evil", tokenSymbol: "USDC", tokenDecimals: 6, ...(over.splits ? { splits: over.splits } : {}) },
  });
  const required402 = (accepts: unknown[], url = "http://provider.test/evil") => {
    const required = { x402Version: 2, resource: { url, description: "evil" }, accepts };
    return new Response(JSON.stringify({ ...required, error: { code: "PAYMENT_REQUIRED", message: "pay" } }), { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodeHeader(required) } });
  };
  const capturedVouchers: Array<{ cumulative: string; signature: string }> = [];
  // Answers every voucher with STALE_CUMULATIVE carrying a huge "position", hoping the agent signs on top of it.
  provider.get("/evil-stale", (c) => {
    const sig = c.req.header("PAYMENT-SIGNATURE");
    if (!sig) return required402([requirement()]);
    capturedVouchers.push(JSON.parse(Buffer.from(sig, "base64").toString()).payload);
    const position = { budgetId: BUDGET, payee: PAYEE, cumulative: "9000000", settled: "0" };
    return c.json({ error: { code: "STALE_CUMULATIVE", message: "stale", details: { position } } }, 402);
  });
  // Advertises a clearing node of its own choosing in the requirement.
  provider.get("/fake-node", (c) => {
    const sig = c.req.header("PAYMENT-SIGNATURE");
    if (!sig) return required402([requirement({ clearingNode: "http://evil-node.test" })]);
    capturedVouchers.push(JSON.parse(Buffer.from(sig, "base64").toString()).payload);
    return c.json({ served: true });
  });
  provider.get("/other-asset", () => required402([requirement({ asset: "other-token.testnet" })]));
  // A PAYMENT-RESPONSE that is not a receipt must not count as paid.
  provider.get("/bogus-paid", (c) => {
    if (!c.req.header("PAYMENT-SIGNATURE")) return required402([requirement()]);
    return c.json({ served: true }, 200, { "PAYMENT-RESPONSE": encodeHeader({ note: "trust me" }) });
  });
  // A split sale: one requirement with extra.splits, paid with one voucher per split, answered by the same node.
  provider.get("/split", async (c) => {
    const sig = c.req.header("PAYMENT-SIGNATURE");
    const offer = requirement({ payTo: PAYEE, amount: "11000", splits: [{ payTo: PAYEE, amount: "6000", providerId: "prv_a" }, { payTo: PAYEE_2, amount: "5000", providerId: "prv_b" }] });
    if (!sig) return required402([offer], "http://provider.test/split");
    const parsed = parsePaymentSignature(sig);
    if (!parsed.ok) return c.json({ error: { code: "INVALID_PAYMENT", message: parsed.message } }, 402);
    const receipts: ClearingReceipt[] = [];
    for (const v of vouchersOf(parsed.value)) {
      const r = await node.request("/v1/vouchers", { method: "POST", body: JSON.stringify(nodeVoucherBody(NETWORK, v)) });
      if (r.status !== 200) return r;
      receipts.push(((await r.json()) as { receipt: ClearingReceipt }).receipt);
    }
    return c.json({ ok: true }, 200, { "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: "", network: NETWORK, receipts }) });
  });
  const sellerVouchers = new MemoryVoucherStore();
  const sellerErrors: string[] = [];
  const onError = (err: Error) => void sellerErrors.push(err.message);
  const payA = paywall({ nodeUrl: NODE_URL, providerId: "prv_a", apiKey: "pmk_a", fetch: fetchAll, vouchers: sellerVouchers, onError });
  const payB = paywall({ nodeUrl: NODE_URL, providerId: "prv_b", apiKey: "pmk_b", fetch: fetchAll, onError });
  provider.get("/q", payA.hono(), (c) => c.json({ ok: true, paidCumulative: c.get("payminto").receipt.cumulative }));
  provider.post("/b", payB.hono(), async (c) => c.json({ echo: await c.req.json() }));
  provider.get("/exact", (c) => c.json({ x402Version: 2, accepts: [{ scheme: "exact" }] }, 402, { "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, resource: { url: "http://provider.test/exact", description: "x" }, accepts: [{ scheme: "exact" }] }) }));
  // A seller still on x402 v1: never paid, whatever it asks for.
  provider.get("/v1-seller", () => {
    const v1 = { x402Version: 1, resource: { url: "http://provider.test/v1-seller", description: "old" }, accepts: [requirement()] };
    return new Response(JSON.stringify(v1), { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader(v1) } });
  });

  const sleeps: number[] = [];
  const voucherSignatures: unknown[] = [];
  // The store is written ahead of every signature, so counting writes proves a refused call signs nothing.
  class CountingStore extends MemoryReceiptStore {
    override recordSigned(budgetId: Id32, payee: AccountId, cumulative: bigint): void {
      voucherSignatures.push({ payee, cumulative });
      super.recordSigned(budgetId, payee, cumulative);
    }
  }
  const agent = (over: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) =>
    new AgentClient({
      network: NETWORK,
      hub: HUB,
      keypair: AGENT,
      budgetId: BUDGET,
      nodeUrl: NODE_URL,
      fetch: fetchAll,
      trustedNodeKey: NODE.publicKey,
      receipts: over.storePath ? undefined : new CountingStore(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      ...over,
    });
  return {
    agent,
    fetchAll,
    payA,
    sellerVouchers,
    sellerErrors,
    truth,
    accepted,
    sleeps,
    voucherPosts,
    voucherSignatures,
    capturedVouchers,
    evilNodeHits,
    stats: () => ({ maxInflightSamePayee, maxInflightAll }),
  };
}

describe("AgentClient.fetch", () => {
  it("answers a 402 with a voucher and verifies the receipt against the configured node", async () => {
    const w = world();
    const a = w.agent();
    const receipts: ClearingReceipt[] = [];
    a.on("receipt", (r) => receipts.push(r.receipt));
    const res = await a.fetch("http://provider.test/q?pair=NEAR-USDC");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paidCumulative: "2000" });
    expect(decodeHeader(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, transaction: "", network: NETWORK, payer: AGENT.publicKey, receipts: [{ cumulative: "2000" }] });
    expect(receipts).toHaveLength(1);
    expect(a.receipts.all()).toHaveLength(1);
    // Second call uses the cached position: no extra position lookup is needed and cumulative extends by the price.
    await a.fetch("http://provider.test/q?pair=BTC-USDC");
    expect(w.accepted.map((x) => x.cumulative)).toEqual([2000n, 4000n]);
  });

  it("binds the voucher signature to the price and the request", async () => {
    const w = world();
    await w.agent().fetch("http://provider.test/q?pair=NEAR-USDC");
    const { payload } = w.voucherPosts[0] as VoucherBody & { payload: { publicKey: string } };
    expect(payload.publicKey).toBe(AGENT.publicKey);
    expect(payload.requestHash).toBe(computeRequestHash("GET", "http://provider.test/q?pair=NEAR-USDC"));
    const signed = { budgetId: BUDGET, payee: PAYEE, amount: 2000n, cumulative: 2000n, requestHash: payload.requestHash };
    expect(verifyDigest(AGENT.publicKey, voucherDigest(HUB, NETWORK, signed), payload.signature)).toBe(true);
    expect(verifyDigest(AGENT.publicKey, voucherDigest(HUB, NETWORK, { ...signed, amount: 1n }), payload.signature)).toBe(false);
  });

  it("re-signs on STALE_CUMULATIVE at the node's position when another process sharing the store moved it", async () => {
    const w = world();
    const store = new MemoryReceiptStore();
    const a = w.agent({ receipts: store });
    const other = w.agent({ receipts: store }); // a second process of the same agent, sharing its store
    expect((await a.fetch("http://provider.test/q")).status).toBe(200); // a caches position 2000
    for (let i = 0; i < 3; i++) expect((await other.fetch(`http://provider.test/q?o=${i}`)).status).toBe(200);
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/q?again");
    expect(res.status).toBe(200);
    expect(w.accepted.map((x) => x.cumulative)).toEqual([2000n, 4000n, 6000n, 8000n, 10000n]);
    expect(w.sleeps).toEqual([50]);
    expect(denied).toEqual([]);
  });

  it("gives up after 3 retries, emits denied and returns the 402", async () => {
    const w = world({ alwaysStale: true });
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("STALE_CUMULATIVE");
    expect(w.voucherPosts).toHaveLength(4);
    expect(w.sleeps).toEqual([50, 100, 200]);
    expect(denied.map((d) => d.code)).toEqual(["STALE_CUMULATIVE"]);
  });

  it("carries the node's machine-readable refusal through the paywall to the agent", async () => {
    const refusal: Refusal = { rule: "DAILY_CAP", message: "Call would exceed the rolling 24h cap", attemptedAmount: "2000", remainingBudget: "9998000", retry: { kind: "after", seconds: 86_400 } };
    const w = world({ refuse: refusal });
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ success: false, errorReason: "DAILY_CAP", refusal });
    expect(denied[0]).toMatchObject({ code: "DAILY_CAP", refusal });
  });

  it("does not treat a PAYMENT-RESPONSE without a receipt as paid", async () => {
    const w = world();
    const a = w.agent();
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    expect((await a.fetch("http://provider.test/bogus-paid")).status).toBe(200);
    expect(errors.map((e) => e.message)).toEqual(["provider returned a malformed PAYMENT-RESPONSE"]);
    expect(a.receipts.all()).toHaveLength(0);
    // The signed cumulative still counts as this agent's exposure.
    expect(a.receipts.signedPosition(BUDGET, PAYEE)).toBe(2000n);
  });

  it("serializes vouchers per (budget, payee) but runs different payees in parallel", async () => {
    const w = world();
    const a = w.agent();
    const jobs = [
      ...Array.from({ length: 12 }, (_, i) => a.fetch(`http://provider.test/q?i=${i}`)),
      ...Array.from({ length: 6 }, (_, i) => a.fetch("http://provider.test/b", { method: "POST", body: JSON.stringify({ i }), headers: { "content-type": "application/json" } })),
    ];
    const res = await Promise.all(jobs);
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(w.stats().maxInflightSamePayee).toBe(1);
    expect(w.stats().maxInflightAll).toBe(2);
    expect(w.truth.get(PAYEE)).toBe(24_000n);
    expect(w.truth.get(PAYEE_2)).toBe(30_000n);
    expect(w.sleeps).toEqual([]); // no self-races, so no STALE retries
  });

  it("pays a split requirement with one voucher per payee and verifies both receipts", async () => {
    const w = world({ bundle: bundle({ policy: { perCallCap: "11000" } }) });
    const a = w.agent();
    const res = await a.fetch("http://provider.test/split");
    expect(res.status).toBe(200);
    expect(a.receipts.all().map((r) => [r.payee, r.amount])).toEqual([[PAYEE, "6000"], [PAYEE_2, "5000"]]);
  });

  it("holds a split's combined price against the per-call cap, signing nothing", async () => {
    const w = world({ bundle: bundle({ policy: { perCallCap: "10999" } }) });
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    expect((await a.fetch("http://provider.test/split")).status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["PER_CALL_CAP"]);
    expect(w.voucherSignatures).toHaveLength(0);
  });

  it("does not store a receipt whose node signature does not verify", async () => {
    const w = world({ receiptSigner: EVIL });
    const a = w.agent();
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(200);
    // Rejected twice: as the seller returned it, and again when the agent asked its node about the voucher.
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: not signed by the configured node key", "receipt rejected: not signed by the configured node key"]);
    expect(a.receipts.all()).toHaveLength(0);
  });

  it("requires nodeUrl", () => {
    const w = world();
    expect(() => w.agent({ nodeUrl: undefined as never })).toThrow(/requires nodeUrl/);
    expect(() => w.agent({ nodeUrl: "node.test" })).toThrow(/requires nodeUrl/);
  });

  it("leaves non-voucher 402s alone and refuses prices above maxPrice without signing", async () => {
    const w = world();
    const a = w.agent({ maxPrice: 1000n });
    expect((await a.fetch("http://provider.test/exact")).status).toBe(402);
    // An x402 v1 offer is another protocol version: returned as it came, never paid.
    expect((await a.fetch("http://provider.test/v1-seller")).status).toBe(402);
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    expect((await a.fetch("http://provider.test/q")).status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["CLIENT_MAX_PRICE"]);
    expect(w.voucherPosts).toHaveLength(0);
  });
});

describe("AgentClient beforeSign", () => {
  /** The agent's fetch, recording every request that carries a voucher: what leaves the process. */
  const watching = (w: ReturnType<typeof world>) => {
    const sent: string[] = [];
    const fetchSpy = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) sent.push(String(input));
      return w.fetchAll(input, init);
    }) as typeof fetch;
    return { sent, fetch: fetchSpy };
  };

  it("is asked about every payee before anything is signed, with the payer, the payee, the amount, the Budget's payees and the accepted requirement", async () => {
    const w = world({ bundle: bundle({ policy: { perCallCap: "11000" } }) });
    const asked: BeforeSignRequest[] = [];
    const signedWhenAsked: number[] = [];
    const a = w.agent({
      beforeSign: (r) => {
        asked.push(r);
        signedWhenAsked.push(w.voucherSignatures.length);
        return null;
      },
    });
    expect((await a.fetch("http://provider.test/split")).status).toBe(200);
    expect(asked.map((r) => [r.payer, r.payee, r.amount, r.total])).toEqual([
      [OWNER, PAYEE, 6000n, 11000n],
      [OWNER, PAYEE_2, 5000n, 11000n],
    ]);
    expect(asked[0]!.budgetPayees).toEqual([PAYEE, PAYEE_2]);
    expect(asked[0]!).toMatchObject({ budgetId: a.budgetId, url: "http://provider.test/split", requirement: { scheme: "payminto-voucher", payTo: PAYEE, amount: "11000", asset: TOKEN } });
    // Both questions came before the first signature.
    expect(signedWhenAsked).toEqual([0, 0]);
    expect(a.receipts.all()).toHaveLength(2);
  });

  it("a refusal is the normal structured refusal, and no voucher leaves the process", async () => {
    const w = world({ bundle: bundle({ policy: { perCallCap: "11000" } }) });
    const spy = watching(w);
    const denied: DeniedEvent[] = [];
    // It approves the first payee of the split and refuses the second: nothing is signed for either.
    const a = w.agent({
      fetch: spy.fetch,
      beforeSign: ({ payee }) => (payee === PAYEE_2 ? { rule: "PAYEE_BLOCKED", message: "the payee check blocks payee-b.testnet", retry: { kind: "never" }, details: { payeeCheck: { status: "blocked" } } } : null),
    });
    a.on("denied", (d) => denied.push(d));
    const { response, payment } = await a.pay("http://provider.test/split");
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string; details: Record<string, unknown> }; refusal: Refusal };
    expect(body.refusal).toEqual({ rule: "PAYEE_BLOCKED", message: "the payee check blocks payee-b.testnet", attemptedAmount: "11000", remainingBudget: null, retry: { kind: "never" } });
    expect(body.error).toMatchObject({ code: "PAYEE_BLOCKED", details: { enforcedBy: "agent", payee: PAYEE_2, payeeCheck: { status: "blocked" } } });
    expect(payment).toMatchObject({ status: "none", paid: 0n, unverified: 0n, vouchers: [], refusal: { source: "agent", code: "PAYEE_BLOCKED" } });
    expect(denied).toMatchObject([{ code: "PAYEE_BLOCKED", source: "agent", payee: PAYEE_2, amount: 11000n }]);
    // Nothing was signed, nothing was written ahead, and no request with a voucher on it left this process.
    expect(spy.sent).toEqual([]);
    expect(w.voucherSignatures).toHaveLength(0);
    expect(w.voucherPosts).toHaveLength(0);
    expect(a.receipts.signedPosition(a.budgetId, PAYEE)).toBe(0n);
  });

  it("fails closed: a hook that throws refuses the call, signing nothing", async () => {
    const w = world();
    const spy = watching(w);
    const a = w.agent({
      fetch: spy.fetch,
      beforeSign: async () => {
        throw new Error("the chain could not be read");
      },
    });
    const { response, payment } = await a.pay("http://provider.test/q");
    expect(response.status).toBe(402);
    expect(payment.refusal).toMatchObject({ source: "agent", code: "CLIENT_CHECK_FAILED", refusal: { retry: { kind: "after", seconds: 30 } } });
    expect(payment.refusal!.message).toContain("the chain could not be read");
    expect(spy.sent).toEqual([]);
    expect(w.voucherSignatures).toHaveLength(0);
  });

  it("is not asked when the price is already above the client's maximum, and a refusal from it counts for that call only", async () => {
    const w = world();
    let asked = 0;
    let refuse = true;
    const a = w.agent({
      maxPrice: 1_000n,
      beforeSign: () => {
        asked++;
        return refuse ? { rule: "PAYEE_NEEDS_APPROVAL", message: "waiting for the owner", retry: { kind: "never" } } : null;
      },
    });
    expect((await a.pay("http://provider.test/q")).payment.refusal?.code).toBe("CLIENT_MAX_PRICE");
    expect(asked).toBe(0);
    const b = w.agent({ beforeSign: () => (refuse ? { rule: "PAYEE_NEEDS_APPROVAL", message: "waiting for the owner", retry: { kind: "never" } } : null) });
    expect((await b.pay("http://provider.test/q")).payment.refusal?.code).toBe("PAYEE_NEEDS_APPROVAL");
    refuse = false;
    expect((await b.pay("http://provider.test/q")).payment.status).toBe("paid");
  });
});

describe("AgentClient against a malicious provider or node", () => {
  it("ignores an inflated position in a provider's STALE_CUMULATIVE body and never signs above its own position", async () => {
    const w = world();
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/evil-stale");
    expect(res.status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["STALE_CUMULATIVE"]);
    // Every attempt re-read the honest node (position 0) and signed 0 + 2000, never 9_000_000 + 2000.
    expect(w.capturedVouchers.map((v) => v.cumulative)).toEqual(["2000", "2000", "2000", "2000"]);
    expect(a.receipts.signedPosition(BUDGET, PAYEE)).toBe(2000n);
  });

  it("never talks to the clearing node a provider advertises in its requirement", async () => {
    const w = world();
    const a = w.agent();
    expect((await a.fetch("http://provider.test/fake-node")).status).toBe(200);
    expect(w.evilNodeHits).toEqual([]);
    expect(w.capturedVouchers.map((v) => v.cumulative)).toEqual(["2000"]);
  });

  it("refuses with POSITION_UNVERIFIED, signing nothing, when the node reports a position above what the agent signed", async () => {
    const w = world({ inflatePosition: 5_000_000n });
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string; details: Record<string, string> } };
    expect(body.error).toMatchObject({
      code: "POSITION_UNVERIFIED",
      message: "Reported position exceeds what this agent has signed",
      details: { reported: "5000000", signed: "0", enforcedBy: "agent" },
    });
    expect(denied.map((d) => d.code)).toEqual(["POSITION_UNVERIFIED"]);
    expect(w.voucherSignatures).toHaveLength(0);
  });

  it("rejects a receipt that is self-consistent but signed by a key other than the node's", async () => {
    const w = world({ receiptSigner: EVIL, receiptNode: EVIL.publicKey });
    const a = w.agent({ trustedNodeKey: undefined });
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    expect((await a.fetch("http://provider.test/q")).status).toBe(200);
    // Rejected twice: as the seller returned it, and again when the agent asked its node about the voucher.
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: not signed by the configured node key", "receipt rejected: not signed by the configured node key"]);
    expect(a.receipts.all()).toHaveLength(0);
  });

  it("rejects a receipt whose call id was changed after the node signed it: the digest covers the id", async () => {
    const swapped = sha256Text("another call");
    const w = world({ swapCallId: swapped });
    const a = w.agent();
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    const { payment } = await a.pay("http://provider.test/q");
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: digest mismatch"]);
    // The agent then asked its own node about the voucher, by the id it derives itself, and kept that receipt.
    const real = callIdOf({ budgetId: BUDGET, payee: PAYEE, cumulative: 2000n, requestHash: computeRequestHash("GET", "http://provider.test/q") });
    expect(payment.vouchers.map((v) => v.callId)).toEqual([real]);
    expect(a.receipts.all().map((r) => r.callId)).toEqual([real]);
    expect(a.receipts.get(swapped)).toBeUndefined();
  });

  it("refuses to sign when the configured node's key is not the pinned trustedNodeKey", async () => {
    const w = world();
    const a = w.agent({ trustedNodeKey: EVIL.publicKey });
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    expect((await a.fetch("http://provider.test/q")).status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["POLICY_UNAVAILABLE"]);
    expect(w.voucherSignatures).toHaveLength(0);
    await expect(a.nodeKey()).rejects.toThrow(/pinned trustedNodeKey/);
  });
});

describe("persistent receipt store", () => {
  it("survives a restart: positions stay known and the agent keeps paying", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "payminto-sdk-")), "agent.receipts.test.db");
    const w = world();
    const first = w.agent({ storePath: path });
    for (let i = 0; i < 3; i++) expect((await first.fetch(`http://provider.test/q?i=${i}`)).status).toBe(200);
    first.close();

    // Same file, new client: receipts and signed positions are back.
    const second = w.agent({ storePath: path });
    expect(second.receipts.all().map((r) => r.cumulative)).toEqual(["2000", "4000", "6000"]);
    expect(second.receipts.signedPosition(BUDGET, PAYEE)).toBe(6000n);
    // It extends the node's position because it remembers signing it.
    expect((await second.fetch("http://provider.test/q?after-restart")).status).toBe(200);
    expect(w.accepted.at(-1)).toEqual({ payee: PAYEE, cumulative: 8000n });
    second.close();

    // Without the store, the same agent no longer knows what it signed and refuses to extend the position.
    const amnesiac = w.agent();
    const denied: DeniedEvent[] = [];
    amnesiac.on("denied", (d) => denied.push(d));
    expect((await amnesiac.fetch("http://provider.test/q")).status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["POSITION_UNVERIFIED"]);
  });

  it("keeps the highest signed cumulative across processes sharing the file, never lowering it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "payminto-sdk-")), "shared.receipts.test.db");
    const a = new SqliteReceiptStore(path);
    const b = new SqliteReceiptStore(path);
    a.recordSigned(BUDGET, PAYEE, 10_000n);
    b.recordSigned(BUDGET, PAYEE, 4_000n);
    b.recordSigned(BUDGET, PAYEE_2, 10n ** 30n); // beyond int64
    expect(a.signedPosition(BUDGET, PAYEE)).toBe(10_000n);
    expect(a.signedPosition(BUDGET, PAYEE_2)).toBe(10n ** 30n);
    expect(b.signedPositions(BUDGET)).toEqual(new Map([[PAYEE, 10_000n], [PAYEE_2, 10n ** 30n]]));
    a.close();
    b.close();
  });
});

describe("verifyReceiptOnchain", () => {
  const BATCH = sha256Text("b");
  const TS = 1_800_000_000;

  /** Two calls settled for real on the fake hub, and the node's receipt for the first of them. */
  async function settled(o: { settler?: AccountId; signer?: Keypair } = {}) {
    const settler = o.settler ?? OPERATOR;
    const chain = new FakeChain({ hub: HUB, token: TOKEN, network: NETWORK, operator: OPERATOR });
    chain.addSettler(settler);
    chain.mint(OWNER, 1_000_000n);
    const b = bundle({ budget: { settler } });
    chain.openBudget(OWNER, b.budget);
    chain.depositBudget(OWNER, b.id, 100_000n);
    const voucher = (cumulative: bigint, label: string) => {
      const v = { budgetId: b.id, payee: PAYEE, amount: 2000n, cumulative, requestHash: sha256Text(label) };
      return { v, sig: signDigest(AGENT.secretKey, voucherDigest(HUB, NETWORK, v)) };
    };
    const first = voucher(2000n, "r1");
    const second = voucher(4000n, "r2");
    const fields = (callId: Id32, x: typeof first) => ({ callId, budgetId: x.v.budgetId, payee: x.v.payee, amount: x.v.amount, cumulative: x.v.cumulative, requestHash: x.v.requestHash, timestampMs: BigInt(TS) * 1000n, voucherSig: x.sig });
    const callId = sha256Text("c1");
    const tree = buildReceiptTree(HUB, NETWORK, BATCH, [fields(callId, first), fields(sha256Text("c2"), second)]);
    const { entries } = computeNetting([{ owner: OWNER, payee: PAYEE, delta: 4000n }]);
    await chain.settleAs(settler, { batchId: BATCH, root: tree.root, claims: [{ ...second.v, signature: second.sig }], expectedNet: entries });
    const attested = { callId, budgetId: b.id, payee: PAYEE, requestHash: first.v.requestHash, voucherSig: first.sig };
    const digest = nodeDigest({ ...attested, amount: 2000n, cumulative: 2000n, timestamp: BigInt(TS) });
    const receipt = { ...attested, amount: "2000", cumulative: "2000", timestamp: TS, digest, nodeSignature: signDigest((o.signer ?? NODE).secretKey, digest) };
    return { chain, receipt, proof: tree.proofOf(callId) };
  }

  it("verifies only when the operator settled the batch and the node signed the receipt", async () => {
    const s = await settled();
    const args = { chain: s.chain, operator: OPERATOR, nodeKey: NODE.publicKey, receipt: s.receipt, batchId: BATCH, proof: s.proof };
    expect(await verifyReceiptOnchain({ ...args, agentPk: AGENT.publicKey })).toMatchObject({ verified: true, agentSigned: true, localProofValid: true, merkleVerified: true, reason: null });
    expect(await verifyReceiptOnchain(args)).toMatchObject({ verified: true, agentSigned: null });
    // A voucher this agent did not sign proves nothing about the agent, even inside the node's batch.
    expect(await verifyReceiptOnchain({ ...args, agentPk: EVIL.publicKey })).toMatchObject({ verified: false, agentSigned: false });
    // A broken path fails locally and at the hub.
    expect(await verifyReceiptOnchain({ ...args, proof: [] })).toMatchObject({ verified: false, localProofValid: false, merkleVerified: false });
    expect(await verifyReceiptOnchain({ ...args, batchId: sha256Text("missing") })).toMatchObject({ verified: false, settler: null });
  });

  it("refuses a batch someone else settled", async () => {
    const s = await settled({ settler: "other-node.testnet" });
    const foreign = await verifyReceiptOnchain({ chain: s.chain, operator: OPERATOR, nodeKey: NODE.publicKey, receipt: s.receipt, batchId: BATCH, proof: s.proof });
    expect(foreign).toMatchObject({ verified: false, merkleVerified: true, settlerIsNode: false });
    expect(foreign.reason).toMatch(/settled by/);
  });

  it("refuses a receipt the node never signed, and one whose fields were altered", async () => {
    const forged = await settled({ signer: EVIL });
    const args = { chain: forged.chain, operator: OPERATOR, nodeKey: NODE.publicKey, batchId: BATCH, proof: forged.proof };
    expect(await verifyReceiptOnchain({ ...args, receipt: forged.receipt })).toMatchObject({ verified: false, nodeSigned: false });
    const honest = await settled();
    expect(await verifyReceiptOnchain({ ...args, chain: honest.chain, proof: honest.proof, receipt: { ...honest.receipt, amount: "2001" } })).toMatchObject({ verified: false, digestMatches: false });
  });
});

describe("AgentClient pre-sign policy guard", () => {
  /** Makes `ok` paid calls, then one call that must be refused locally with `rule` and never signed. */
  async function refused(rule: string, b: Bundle, calls: { ok: string[]; refused: string }) {
    const w = world({ bundle: b });
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    for (const path of calls.ok) expect((await a.fetch(`http://provider.test${path}`, path === "/b" ? { method: "POST", body: "{}" } : undefined)).status, path).toBe(200);
    const signedBefore = w.voucherSignatures.length;
    const res = await a.fetch(`http://provider.test${calls.refused}`, calls.refused === "/b" ? { method: "POST", body: "{}" } : undefined);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; details: { enforcedBy: string } }; refusal: Refusal };
    expect(body.error.code).toBe(rule);
    expect(body.error.details.enforcedBy).toBe("agent");
    // The same machine-readable refusal the node gives: rule, attempted amount, remaining Budget and retry hint.
    expect(body.refusal).toMatchObject({ rule, attemptedAmount: expect.stringMatching(/^\d+$/), retry: { kind: expect.any(String) } });
    expect(body.refusal.remainingBudget === null || /^\d+$/.test(body.refusal.remainingBudget)).toBe(true);
    expect(denied.map((d) => d.code)).toEqual([rule]);
    expect(denied[0]!.refusal).toEqual(body.refusal);
    expect(w.voucherSignatures.length, "no voucher signature for a refused call").toBe(signedBefore);
    expect(w.voucherPosts).toHaveLength(calls.ok.length);
  }

  it("PER_CALL_CAP", () => refused("PER_CALL_CAP", bundle({ policy: { perCallCap: "1999" } }), { ok: [], refused: "/q" }));
  it("PAYEE_NOT_ALLOWED", () => refused("PAYEE_NOT_ALLOWED", bundle({ budget: { payees: [PAYEE_2] } }), { ok: ["/b"], refused: "/q" }));
  it("BUDGET_NOT_ACTIVE (expired)", () => refused("BUDGET_NOT_ACTIVE", bundle({ budget: { validUntil: NOW_MS - 10_000n } }), { ok: [], refused: "/q" }));
  it("TOKEN_MISMATCH", () => refused("TOKEN_MISMATCH", DEFAULT, { ok: [], refused: "/other-asset" }));
  it("RATE_LIMIT", () => refused("RATE_LIMIT", bundle({ policy: { maxCallsPerMinute: 2 } }), { ok: ["/q", "/b"], refused: "/q" }));
  it("REPEAT_REQUEST counts this exact request only", () => refused("REPEAT_REQUEST", bundle({ policy: { maxRepeatsPerRequest: 2 } }), { ok: ["/q", "/b", "/q"], refused: "/q" }));
  it("HOURLY_CAP", () => refused("HOURLY_CAP", bundle({ policy: { hourlyCap: "6999" } }), { ok: ["/q", "/q"], refused: "/b" }));
  it("TOTAL_CAP reports what is left of the Budget", async () => {
    const w = world({ bundle: bundle({ budget: { cap: 8_999n } }) });
    const a = w.agent();
    for (let i = 0; i < 2; i++) expect((await a.fetch(`http://provider.test/q?i=${i}`)).status).toBe(200);
    const body = (await (await a.fetch("http://provider.test/b", { method: "POST", body: "{}" })).json()) as { refusal: Refusal };
    expect(body.refusal).toEqual({ rule: "TOTAL_CAP", message: "Call would exceed the Budget cap", attemptedAmount: "5000", remainingBudget: "4999", retry: { kind: "never" } });
  });
  it("DAILY_CAP", () => refused("DAILY_CAP", bundle({ policy: { dailyCap: "6999" } }), { ok: ["/q", "/q"], refused: "/b" }));
  it("TOTAL_CAP counts every payee's cumulative", () => refused("TOTAL_CAP", bundle({ budget: { cap: 8_999n } }), { ok: ["/q", "/q"], refused: "/b" }));

  it("reserves in-flight vouchers so parallel payees cannot jointly exceed a cap", async () => {
    const w = world({ bundle: bundle({ budget: { cap: 6_000n } }) });
    const a = w.agent();
    const res = await Promise.all([a.fetch("http://provider.test/q"), a.fetch("http://provider.test/b", { method: "POST", body: "{}" })]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(w.voucherSignatures).toHaveLength(1);
  });

  it("refuses to sign anything when the node serves a policy that does not hash to the Budget", async () => {
    const strict = bundle({ policy: { perCallCap: "1000" }, budget: { payees: [PAYEE_2] } });
    for (const served of [
      { ...strict, policy: { ...strict.policy, perCallCap: "1000000" } }, // loosened cap
      { ...strict, budget: { ...strict.budget, payees: [] } }, // dropped allowlist
      { ...strict, budget: { ...strict.budget, cap: 10n ** 18n } }, // different budget
    ]) {
      const w = world({ bundle: strict, servedPolicy: served });
      const a = w.agent();
      const denied: DeniedEvent[] = [];
      a.on("denied", (d) => denied.push(d));
      const res = await a.fetch("http://provider.test/q");
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("POLICY_MISMATCH");
      expect(denied.map((d) => d.code)).toEqual(["POLICY_MISMATCH"]);
      expect(w.voucherSignatures).toHaveLength(0);
    }
  });

  it("refuses to sign for a Budget that names another agent key", async () => {
    const w = world({ bundle: bundle({ budget: { agentPk: EVIL.publicKey } }) });
    expect(((await (await w.agent().fetch("http://provider.test/q")).json()) as { error: { code: string } }).error.code).toBe("POLICY_MISMATCH");
    expect(w.voucherSignatures).toHaveLength(0);
  });

  it("accepts the policy as a constructor option, still verified, without asking the node", async () => {
    const b = bundle({ policy: { perCallCap: "1999" } });
    const w = world({ bundle: b, servedPolicy: DEFAULT });
    const a = w.agent({ budgetId: b.id, policy: { budget: b.budget, policy: b.policy } });
    expect((await a.fetch("http://provider.test/q")).status).toBe(402);
    expect(w.voucherSignatures).toHaveLength(0);
    const bad = w.agent({ budgetId: b.id, policy: { budget: b.budget, policy: { ...b.policy, perCallCap: "99999" } } });
    await expect(bad.loadPolicy()).rejects.toThrow(/policyHash/);
  });

  it("can be turned off, leaving enforcement to the node and the hub", async () => {
    const b = bundle({ policy: { perCallCap: "1999" } });
    const w = world({ bundle: b });
    expect((await w.agent({ budgetId: b.id, enforcePolicy: false }).fetch("http://provider.test/q")).status).toBe(200);
  });
});

describe("paywall", () => {
  /** A v2 PAYMENT-SIGNATURE for a URL, built by hand so each test can break one part of it. */
  async function signedFor(w: ReturnType<typeof world>, url: string, over: { requestHash?: Id32; accepted?: Record<string, unknown>; version?: number; signer?: Keypair; cumulative?: string } = {}) {
    const first = await w.fetchAll(url);
    const offer = decodeHeader<{ resource: unknown; accepts: Array<Record<string, unknown>> }>(first.headers.get("PAYMENT-REQUIRED"))!;
    const requestHash = over.requestHash ?? computeRequestHash("GET", url);
    const cumulative = over.cumulative ?? "2000";
    const signature = signDigest((over.signer ?? AGENT).secretKey, voucherDigest(HUB, NETWORK, { budgetId: BUDGET, payee: PAYEE, amount: 2000n, cumulative: BigInt(cumulative), requestHash }));
    return encodeHeader({
      x402Version: over.version ?? 2,
      resource: offer.resource,
      accepted: over.accepted ?? offer.accepts[0],
      payload: { budgetId: BUDGET, payee: PAYEE, amount: "2000", cumulative, requestHash, publicKey: AGENT.publicKey, signature },
    });
  }
  const pay = (w: ReturnType<typeof world>, url: string, header: string) => w.fetchAll(url, { headers: { "PAYMENT-SIGNATURE": header } });

  it("returns an x402 v2 offer without a payment: resource at the top, the requirement in accepts", async () => {
    const w = world();
    const res = await w.fetchAll("http://provider.test/q?x=1");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>>; error: { code: string } };
    expect(body.error.code).toBe("PAYMENT_REQUIRED");
    expect(body).not.toHaveProperty("success");
    const header = decodeHeader<Record<string, unknown>>(res.headers.get("PAYMENT-REQUIRED"));
    expect(header).toEqual({
      x402Version: 2,
      resource: { url: "http://provider.test/q?x=1", description: "quotes" },
      accepts: [
        {
          scheme: "payminto-voucher",
          network: NETWORK,
          amount: "2000",
          asset: TOKEN,
          payTo: PAYEE,
          maxTimeoutSeconds: 60,
          extra: { clearingHub: HUB, clearingNode: NODE_URL, providerId: "prv_a", tokenSymbol: "USDC", tokenDecimals: 6 },
        },
      ],
    });
    expect(body.accepts).toEqual((header as { accepts: unknown[] }).accepts);
  });

  it("answers 400 to a header it cannot read or of another x402 version, as the node gateway does", async () => {
    const w = world();
    const url = "http://provider.test/q?x=1";
    const cases: Array<[string, string]> = [
      ["UNSUPPORTED_X402_VERSION", await signedFor(w, url, { version: 1 })],
      ["UNSUPPORTED_X402_VERSION", encodeHeader({ accepted: {}, payload: {} })],
      ["INVALID_PAYMENT", "not base64 json"],
      ["INVALID_PAYMENT", Buffer.from("{ not json").toString("base64")],
      ["INVALID_PAYMENT", "A".repeat(70_000)],
    ];
    for (const [code, header] of cases) {
      const r = await pay(w, url, header);
      expect(r.status, code).toBe(400);
      // A bad request is not a payment: no offer, no settlement response.
      expect(r.headers.get("PAYMENT-RESPONSE"), code).toBeNull();
      expect(r.headers.get("PAYMENT-REQUIRED"), code).toBeNull();
      expect(await r.json(), code).toMatchObject({ error: { code } });
    }
    expect(w.voucherPosts).toHaveLength(0);
  });

  it("answers 402 to a readable payment that fails the schema, the requirement, the request hash or the signature", async () => {
    const w = world();
    const url = "http://provider.test/q?x=1";
    const offered = decodeHeader<{ accepts: Array<Record<string, unknown>> }>((await w.fetchAll(url)).headers.get("PAYMENT-REQUIRED"))!.accepts[0]!;
    const cases: Array<[string, string]> = [
      ["INVALID_PAYMENT", encodeHeader({ x402Version: 2, accepted: {}, payload: {} })],
      ["REQUIREMENT_MISMATCH", await signedFor(w, url, { accepted: { ...offered, extra: { ...(offered.extra as object), providerId: "prv_b" } } })],
      ["REQUEST_HASH_MISMATCH", await signedFor(w, url, { requestHash: computeRequestHash("GET", "/other") })],
      ["BAD_SIGNATURE", await signedFor(w, url, { signer: EVIL })],
    ];
    for (const [code, header] of cases) {
      const r = await pay(w, url, header);
      expect(r.status, code).toBe(402);
      expect(await r.json(), code).toMatchObject({ success: false, errorReason: code, error: { code } });
      expect(decodeHeader(r.headers.get("PAYMENT-RESPONSE")), code).toMatchObject({ success: false, errorReason: code, transaction: "" });
      expect(decodeHeader<{ error: string }>(r.headers.get("PAYMENT-REQUIRED"))!.error, code).toBe(code);
    }
    // A strict payload: a field the agent did not sign never rides along.
    const extra = decodeHeader<Record<string, Record<string, unknown>>>(await signedFor(w, url))!;
    extra.payload!.note = "extra";
    const strict = await pay(w, url, encodeHeader(extra));
    expect(strict.status).toBe(402);
    expect(await strict.json()).toMatchObject({ errorReason: "INVALID_PAYMENT" });
    expect(w.voucherPosts).toHaveLength(0);
  });

  it("puts the node's refusal in PAYMENT-RESPONSE with success false and the rule in errorReason", async () => {
    const refusal: Refusal = { rule: "HOURLY_CAP", message: "Call would exceed the rolling one-hour cap", attemptedAmount: "2000", remainingBudget: "10", retry: { kind: "after", seconds: 3600 } };
    const w = world({ refuse: refusal });
    const r = await pay(w, "http://provider.test/q", await signedFor(w, "http://provider.test/q"));
    expect(r.status).toBe(402);
    expect(decodeHeader(r.headers.get("PAYMENT-RESPONSE"))).toEqual({ success: false, errorReason: "HOURLY_CAP", transaction: "", network: NETWORK, payer: AGENT.publicKey, refusal });
    expect(w.sellerVouchers.all()).toEqual([]);
  });

  it("keeps the latest accepted voucher per Budget with the node's acceptance, and exports both for settle_own", async () => {
    const w = world();
    const a = w.agent();
    for (let i = 0; i < 3; i++) expect((await a.fetch(`http://provider.test/q?i=${i}`)).status).toBe(200);
    const kept = w.sellerVouchers.all();
    expect(kept.map((v) => [v.budgetId, v.payee, v.cumulative, v.hub, v.network])).toEqual([[BUDGET, PAYEE, "6000", HUB, NETWORK]]);
    // The acceptance is the node's signature from the receipt, over exactly the stored voucher.
    const [v] = kept;
    expect(v!.acceptance).toMatchObject({ nodeKey: NODE.publicKey, timestampS: "1800000000" });
    const claim = { budgetId: v!.budgetId, payee: v!.payee, amount: BigInt(v!.amount), cumulative: BigInt(v!.cumulative), requestHash: v!.requestHash, signature: v!.signature };
    expect(verifyDigest(NODE.publicKey, acceptanceDigest(claim, 1_800_000_000n), v!.acceptance!.signature)).toBe(true);
    expect(w.sellerErrors).toEqual([]);

    const exp = await w.payA.exportVouchers();
    expect(exp).toMatchObject({ format: "payminto.vouchers.v2", hub: HUB, network: NETWORK, vouchers: [{ cumulative: "6000", acceptance: { nodeKey: NODE.publicKey } }] });
    expect(await parseVoucherExport(JSON.parse(JSON.stringify(exp)))).toEqual({ ...exp, checkedAgainst: "declared-keys" });
  });

  it("does not store a voucher whose acceptance does not verify, and keeps the last one that can be settled", async () => {
    // The node's receipts are signed by another key than the one they name: no hub would take such an acceptance.
    const good = world();
    const a = good.agent();
    expect((await a.fetch("http://provider.test/q?i=0")).status).toBe(200);
    expect(good.sellerVouchers.all()).toHaveLength(1);

    const bad = world({ receiptSigner: EVIL });
    const header = await (async () => {
      const url = "http://provider.test/q?i=1";
      const requestHash = computeRequestHash("GET", url);
      const offer = decodeHeader<{ resource: unknown; accepts: unknown[] }>((await bad.fetchAll(url)).headers.get("PAYMENT-REQUIRED"))!;
      const signature = signDigest(AGENT.secretKey, voucherDigest(HUB, NETWORK, { budgetId: BUDGET, payee: PAYEE, amount: 2000n, cumulative: 2000n, requestHash }));
      return encodeHeader({ x402Version: 2, resource: offer.resource, accepted: offer.accepts[0], payload: { budgetId: BUDGET, payee: PAYEE, amount: "2000", cumulative: "2000", requestHash, publicKey: AGENT.publicKey, signature } });
    })();
    const served = await bad.fetchAll("http://provider.test/q?i=1", { headers: { "PAYMENT-SIGNATURE": header } });
    // The node accepted the call, so it is served. The seller is told it cannot settle that voucher itself.
    expect(served.status).toBe(200);
    expect(bad.sellerVouchers.all()).toEqual([]);
    expect(bad.sellerErrors).toHaveLength(1);
    expect(bad.sellerErrors[0]).toMatch(/acceptance does not verify.*settle_own/);
  });
});

describe("settle_own from exported vouchers", () => {
  const CLAIMS = [2000n, 4000n, 6000n];
  /** A stored voucher for `payee`, signed by `agent` and accepted by `node` at `timestampS`. */
  function stored(budgetId: Id32, payee: AccountId, cumulative: bigint, over: { agent?: Keypair; node?: Keypair | null; timestampS?: bigint } = {}): StoredVoucher {
    const requestHash = sha256Text(`r${cumulative}`);
    const voucher = { budgetId, payee, amount: 2000n, cumulative, requestHash };
    const agent = over.agent ?? AGENT;
    const signature = signDigest(agent.secretKey, voucherDigest(HUB, NETWORK, voucher));
    const timestampS = over.timestampS ?? NOW_MS / 1000n;
    const accepted = over.node === null ? null : signAcceptance(over.node ?? NODE, { ...voucher, signature }, timestampS);
    return {
      budgetId,
      payee,
      amount: "2000",
      cumulative: cumulative.toString(),
      requestHash,
      publicKey: agent.publicKey,
      signature,
      hub: HUB,
      network: NETWORK,
      callId: voucherCallId(voucher),
      acceptedAt: new Date(Number(timestampS) * 1000).toISOString(),
      acceptance: accepted ? { nodeKey: accepted.nodeKey, timestampS: accepted.timestampS.toString(), signature: accepted.signature } : null,
    };
  }

  /** A real Budget on the fake hub, the node's receipt key registered there, and three calls whose latest voucher the seller kept. */
  function sellerWithVouchers() {
    const chain = new FakeChain({ hub: HUB, token: TOKEN, network: NETWORK, operator: OPERATOR });
    chain.addSettler(OPERATOR);
    void chain.registerReceiptKey(OPERATOR, NODE.publicKey);
    chain.mint(OWNER, 1_000_000n);
    const b = bundle();
    chain.openBudget(OWNER, b.budget);
    chain.depositBudget(OWNER, b.id, 100_000n);
    const store = new MemoryVoucherStore();
    for (const cumulative of CLAIMS) {
      const v = stored(b.id, PAYEE, cumulative);
      expect(store.put(v)).toBe(true);
      expect(store.put({ ...v, cumulative: "2000" })).toBe(false); // never lowered, and an equal cumulative is not news
    }
    return { chain, store, budgetId: b.id };
  }

  it("settles the seller's own earnings on the hub with no node involved, sending the node's acceptance", async () => {
    const { chain, store, budgetId } = sellerWithVouchers();
    const exp = await parseVoucherExport(JSON.parse(JSON.stringify(exportVouchers(store, { hub: HUB, network: NETWORK }))), chain);
    expect(exp.checkedAgainst).toBe("hub");
    const plan = await settleOwnClaims(exp, PAYEE, chain);
    expect(plan.unsettleable).toEqual([]);
    expect(plan.claims.map((c) => c.claim.cumulative)).toEqual([6000n]);
    expect(plan.claims[0]!.acceptance).toMatchObject({ nodeKey: NODE.publicKey });
    const [tx] = settleOwnTxs(HUB, plan.claims);
    expect(tx).toMatchObject({ receiverId: HUB, actions: [{ params: { methodName: "settle_own", deposit: "0" } }] });
    const args = tx!.actions[0]!.params.args as { claim: Record<string, unknown>; acceptance: Record<string, unknown> };
    expect(args.claim).toMatchObject({ budget_id: budgetId, payee: PAYEE, cumulative: "6000" });
    expect(args.acceptance).toMatchObject({ timestamp_s: (NOW_MS / 1000n).toString(), signature: exp.vouchers[0]!.acceptance!.signature });
    expect(settleOwnTxs(HUB, plan.claims, "1000")[0]!.actions[0]!.params.deposit).toBe("1000");

    await chain.settleOwn(PAYEE, plan.claims[0]!.claim, plan.claims[0]!.acceptance);
    expect(await chain.creditOf(PAYEE)).toBe(6000n);
    expect((await chain.budget(budgetId))!.escrow).toBe(94_000n);
    chain.solvency();
    // Already settled as far: nothing left to claim.
    expect(await settleOwnClaims(exp, PAYEE, chain)).toEqual({ claims: [], unsettleable: [] });
    expect(await settleOwnClaims(exp, PAYEE_2, chain)).toEqual({ claims: [], unsettleable: [] });
  });

  it("says clearly that a voucher with no acceptance cannot be settled, and never stores one", async () => {
    const { chain, budgetId } = sellerWithVouchers();
    const bare = stored(budgetId, PAYEE, 8000n, { node: null });
    expect(() => new MemoryVoucherStore().put(bare)).toThrow(/acceptance of this voucher is missing; settle_own needs it/);
    // An export written before acceptances were kept still parses, and its vouchers are listed as not settleable.
    const { acceptance: _dropped, ...legacy } = bare;
    const old = await parseVoucherExport({ format: "payminto.vouchers.v1", hub: HUB, network: NETWORK, exportedAt: new Date().toISOString(), vouchers: [legacy] }, chain);
    expect(old.vouchers[0]!.acceptance).toBeNull();
    const plan = await settleOwnClaims(old, PAYEE, chain);
    expect(plan.claims).toEqual([]);
    expect(plan.unsettleable).toEqual([{ voucher: old.vouchers[0], reason: NO_ACCEPTANCE }]);
    expect(settleOwnTxs(HUB, plan.claims)).toEqual([]);
  });

  it("leaves out what the hub would refuse: an acceptance after the revoke, and the owner as payee", async () => {
    const { chain, budgetId } = sellerWithVouchers();
    await chain.revokeBudget(OWNER, budgetId);
    const revokedS = chain.nowMs / 1000n;
    const store = new MemoryVoucherStore();
    store.put(stored(budgetId, PAYEE, 8000n, { timestampS: revokedS + 5n }));
    store.put(stored(budgetId, PAYEE_2, 2000n, { timestampS: revokedS - 5n }));
    store.put(stored(budgetId, OWNER, 2000n, { timestampS: revokedS - 5n }));
    const exp = await parseVoucherExport(exportVouchers(store, { hub: HUB, network: NETWORK }), chain);

    const late = await settleOwnClaims(exp, PAYEE, chain, { nowMs: chain.nowMs });
    expect(late.claims).toEqual([]);
    expect(late.unsettleable).toHaveLength(1);
    expect(late.unsettleable[0]!.reason).toMatch(/after the Budget was revoked or expired/);
    expect(await code(chain.settleOwn(PAYEE, ...claimAndAcceptance(exp.vouchers.find((v) => v.payee === PAYEE)!)))).toBe("ACCEPTANCE_TOO_LATE");

    const inTime = await settleOwnClaims(exp, PAYEE_2, chain, { nowMs: chain.nowMs });
    expect(inTime.claims).toHaveLength(1);
    await chain.settleOwn(PAYEE_2, inTime.claims[0]!.claim, inTime.claims[0]!.acceptance);
    expect(await chain.creditOf(PAYEE_2)).toBe(2000n);

    const owner = await settleOwnClaims(exp, OWNER, chain, { nowMs: chain.nowMs });
    expect(owner.claims).toEqual([]);
    expect(owner.unsettleable[0]!.reason).toMatch(/never pays a Budget's owner/);

    // Once the settlement period is over nothing can be settled.
    const closed = await settleOwnClaims(exp, PAYEE_2, { settledOf: async () => 0n, budget: (id) => chain.budget(id) }, { nowMs: chain.nowMs + 2n * 86_400_000n });
    expect(closed.unsettleable[0]!.reason).toMatch(/settlement period is over/);
  });

  it("refuses a forged or foreign export", async () => {
    const { store, chain } = sellerWithVouchers();
    const exp = exportVouchers(store, { hub: HUB, network: NETWORK });
    const forged = structuredClone(exp);
    forged.vouchers[0]!.cumulative = "999999";
    await expect(parseVoucherExport(forged)).rejects.toThrow(/valid signature/);
    await expect(parseVoucherExport({ ...exp, hub: "other-hub.testnet" })).rejects.toThrow(/not other-hub/);
    await expect(parseVoucherExport({ ...exp, format: "v0" })).rejects.toThrow();
    // An acceptance copied from another voucher, or altered, does not cover this one.
    const swapped = structuredClone(exp);
    swapped.vouchers[0]!.acceptance!.timestampS = "1";
    await expect(parseVoucherExport(swapped)).rejects.toThrow(/acceptance that is not a valid signature/);
    await expect(parseVoucherExport(exp, new FakeChain({ hub: "other-hub.testnet", network: NETWORK }))).rejects.toThrow(/chain reader is for other-hub/);
    expect((await parseVoucherExport(exp, chain)).checkedAgainst).toBe("hub");
  });

  it("checks a voucher against the Budget's agent key on the hub, not the key the voucher declares", async () => {
    const { chain, budgetId } = sellerWithVouchers();
    // A voucher signed by a key of the forger's own, which the voucher itself names. Its signature is valid for that
    // key, and the forger even signs an acceptance with a key of its own.
    const store = new MemoryVoucherStore();
    store.put(stored(budgetId, PAYEE, 8000n, { agent: EVIL, node: EVIL }));
    const forged = exportVouchers(store, { hub: HUB, network: NETWORK });

    // Without the hub this cannot be told from a real export, and the result says how little was checked.
    expect((await parseVoucherExport(forged)).checkedAgainst).toBe("declared-keys");
    // With the hub it is refused: the Budget's agent key is another key.
    await expect(parseVoucherExport(forged, chain)).rejects.toThrow(/not by .* the agent key of Budget/);

    // The right agent key with an acceptance by a key the settler never registered is refused too.
    const unregistered = new MemoryVoucherStore();
    unregistered.put(stored(budgetId, PAYEE, 8000n, { node: EVIL }));
    await expect(parseVoucherExport(exportVouchers(unregistered, { hub: HUB, network: NETWORK }), chain)).rejects.toThrow(/not a receipt key that .* registered on the hub/);
    // A Budget the hub does not hold cannot be checked at all.
    const unknown = new MemoryVoucherStore();
    unknown.put(stored("ab".repeat(32), PAYEE, 2000n));
    await expect(parseVoucherExport(exportVouchers(unknown, { hub: HUB, network: NETWORK }), chain)).rejects.toThrow(/which .* does not hold/);
  });

  it("derives the call id and the acceptance digest exactly as the node and the hub do", () => {
    // packages/chain/vectors/acceptance.json pins the digest for the contract. The node signs `nodeDigest` from
    // @payminto/protocol with a call id from apps/node; both must give the same bytes, or settle_own refuses.
    const file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "chain", "vectors", "acceptance.json"), "utf8")) as {
      cases: Array<{ name: string; input: { budget_id: string; payee: string; amount: string; cumulative: string; request_hash: string; timestamp_s: string; voucher_sig: string }; call_id: string; digest_hex: string }>;
    };
    expect(file.cases.length).toBeGreaterThan(0);
    for (const c of file.cases) {
      const i = c.input;
      const attested = nodeDigest({ callId: c.call_id, budgetId: i.budget_id, payee: i.payee, amount: BigInt(i.amount), cumulative: BigInt(i.cumulative), requestHash: i.request_hash, timestamp: BigInt(i.timestamp_s), voucherSig: i.voucher_sig });
      expect(attested, c.name).toBe(c.digest_hex);
      expect(sha256Text(`payminto.call.v1|${i.budget_id}|${i.payee}|${i.cumulative}|${i.request_hash}`), c.name).toBe(c.call_id);
    }
  });
});

describe("the call id", () => {
  it("has one definition: callIdOf is voucherCallId of @payminto/chain, and gives the id in every shared vector", () => {
    // Not a copy that happens to agree: the same function, so the SDK, the node and the hub cannot drift apart.
    expect(callIdOf).toBe(voucherCallId);
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "chain", "vectors", "acceptance.json");
    const cases = (JSON.parse(readFileSync(file, "utf8")) as { cases: Array<{ input: { budget_id: string; payee: string; cumulative: string; request_hash: string }; call_id: string }> }).cases;
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) expect(callIdOf({ budgetId: c.input.budget_id, payee: c.input.payee, cumulative: BigInt(c.input.cumulative), requestHash: c.input.request_hash })).toBe(c.call_id);
  });
});

describe("request hash", () => {
  it("binds the request hash to method, path, query and body", () => {
    const h = computeRequestHash("GET", "http://a.test/q?x=1");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestHash("get", "https://other-host/q?x=1")).toBe(h);
    expect(computeRequestHash("GET", "http://a.test/q?x=2")).not.toBe(h);
    expect(computeRequestHash("POST", "http://a.test/q?x=1")).not.toBe(h);
    expect(computeRequestHash("GET", "http://a.test/q?x=1", new TextEncoder().encode("{}"))).not.toBe(h);
  });
});

describe("OwnerClient", () => {
  const owner = (over: Partial<ConstructorParameters<typeof OwnerClient>[0]> = {}) => new OwnerClient({ nodeUrl: NODE_URL, network: NETWORK, hub: HUB, token: TOKEN, owner: OWNER, settler: OPERATOR, ...over });
  const args = { agentPk: AGENT.publicKey, cap: 1_000_000n, validForSeconds: 3_600, payees: [PAYEE_2, PAYEE], policy: POLICY };

  it("builds terms the fake hub accepts and returns unsigned wallet transactions", () => {
    const o = owner();
    const { terms, budgetId } = o.createBudget(args);
    expect(terms).toMatchObject({ owner: OWNER, agentPk: AGENT.publicKey, settler: OPERATOR, policyHash: policyHash(POLICY) });
    const chain = new FakeChain({ hub: HUB, token: TOKEN, network: NETWORK, operator: OPERATOR });
    expect(chain.openBudget(OWNER, terms)).toBe(budgetId);
    expect(o.openTx(terms, "1")).toEqual(openBudgetTx(HUB, terms, "1"));
    expect(o.depositTx(budgetId, 5n)).toMatchObject({ receiverId: TOKEN, actions: [{ params: { methodName: "ft_transfer_call" } }] });
    expect(o.revokeTx(budgetId)).toMatchObject({ receiverId: HUB, actions: [{ params: { methodName: "revoke_budget" } }] });
  });

  it("validates its arguments", () => {
    expect(() => owner().createBudget({ ...args, cap: 0n })).toThrow(/cap must be positive/);
    expect(() => owner().createBudget({ ...args, cap: 1n })).toThrow(/perCallCap exceeds cap/);
    expect(() => owner().createBudget({ ...args, validForSeconds: 0 })).toThrow(/validForSeconds/);
  });

  it("registers a Budget with the node without any owner signature", async () => {
    let seen: { url: string; body: unknown; auth: string | null } | null = null;
    const fetchMock = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string), auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify({ id: "x", status: "open" }), { status: 201 });
    }) as unknown as typeof fetch;
    const o = owner({ adminToken: "tok", fetch: fetchMock });
    const { terms } = o.createBudget(args);
    await o.submit({ terms, policy: POLICY, label: "L" });
    expect(seen).toEqual({ url: `${NODE_URL}/v1/budgets`, body: { budget: budgetTermsToJson(terms), policy: POLICY, label: "L" }, auth: "Bearer tok" });
  });
});

describe("AgentClient.revoke", () => {
  it("signs the digest the node checks with the agent key", async () => {
    let body: { signature: Sig64 } | null = null;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await new AgentClient({ network: NETWORK, hub: HUB, keypair: AGENT, budgetId: BUDGET, nodeUrl: NODE_URL, fetch: fetchMock }).revoke();
    expect(verifyDigest(AGENT.publicKey, revokeDigest(BUDGET), body!.signature)).toBe(true);
  });
});

describe("KeyedMutex", () => {
  it("orders same-key tasks and survives failures", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = m.run("k", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
      throw new Error("x");
    });
    const fast = m.run("k", async () => {
      order.push("b");
    });
    const other = m.run("other", async () => {
      order.push("c");
    });
    await expect(slow).rejects.toThrow("x");
    await fast;
    await other;
    expect(order).toEqual(["c", "a", "b"]);
  });
});
