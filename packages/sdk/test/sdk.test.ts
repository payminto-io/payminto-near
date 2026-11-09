import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getAddress, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildNetTransferMandate,
  mandateId,
  mandateToJson,
  payeesRoot,
  policyHash,
  type Mandate,
  type Policy,
  encodeHeader,
  hspMandateToWire,
  hspPaymentId,
  hspTypes,
  isHspMandateSignedBy,
  isVoucherSignedBy,
  receiptLeaf,
  networks,
  permitTypedData,
  tokenDomainSeparator,
  type ClearingReceipt,
} from "@payminto/protocol";
import {
  AgentClient,
  computeRequestHash,
  KeyedMutex,
  MemoryReceiptStore,
  paywall,
  SqliteReceiptStore,
  verifyReceiptOnchain,
  type DeniedEvent,
} from "../src/index.ts";

// Anvil dev keys (public, local only).
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const NODE = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const EVIL = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");
const HUB = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const PAYEE = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const PAYEE_2 = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NOW = Math.floor(Date.now() / 1000);
const POLICY: Policy = { perCallCap: "10000", dailyCap: "1000000", maxCallsPerMinute: 0, purpose: "sdk tests" };

type Bundle = { id: Hex; mandate: Mandate; policy: Policy; payees: Address[] };
function bundle(over: { mandate?: Partial<Mandate>; policy?: Partial<Policy>; payees?: Address[] } = {}): Bundle {
  const policy = { ...POLICY, ...over.policy };
  const payees = over.payees ?? [];
  const mandate: Mandate = {
    owner: OWNER.address,
    agent: AGENT.address,
    token: TOKEN,
    totalCap: 10_000_000n,
    validAfter: BigInt(NOW - 60),
    validUntil: BigInt(NOW + 86_400),
    payeesRoot: payeesRoot(payees),
    policyHash: policyHash(policy),
    salt: keccak256(toBytes("salt")),
    ...over.mandate,
  };
  return { id: mandateId(31337, HUB, mandate), mandate, policy, payees };
}
const DEFAULT = bundle();
const MANDATE = DEFAULT.id;
const NODE_URL = "http://node.test";

type Script = {
  /** The mandate the fake node clears (default DEFAULT). */
  bundle?: Bundle;
  /** What GET /v1/mandates/:id/policy serves; defaults to the honest bundle. */
  servedPolicy?: { mandate: Mandate; policy: Policy; payees: Address[] };
  alwaysStale?: boolean;
  receiptSigner?: typeof NODE;
  /** Address the receipt names as its node (default the honest operator). */
  receiptNode?: Address;
  /** Added to every position GET /position serves (a lying node). */
  inflatePosition?: bigint;
  cosignItems?: unknown[];
};

/** In-memory clearing node + two providers behind the real SDK paywall. Everything goes through one fetch. */
function world(script: Script = {}) {
  const truth = new Map<string, bigint>();
  const accepted: Array<{ payee: Address; cumulative: bigint }> = [];
  const inflight = new Map<string, number>();
  let maxInflightSamePayee = 0;
  let maxInflightAll = 0;
  let totalInflight = 0;
  const cosigned: Array<{ id: string; signerProof: Hex }> = [];
  const voucherPosts: unknown[] = [];

  const b = script.bundle ?? DEFAULT;
  const MANDATE = b.id;
  const node = new Hono();
  node.get("/v1/mandates/:id/policy", (c) => {
    const served = script.servedPolicy ?? b;
    return c.json({ id: MANDATE, status: "open", mandate: mandateToJson(served.mandate), policy: served.policy, payees: served.payees });
  });
  node.get("/v1/info", (c) =>
    c.json({ version: "t", network: { chainId: 31337, caip2: "eip155:31337" }, hub: HUB, token: { address: TOKEN, symbol: "USDC", decimals: 6 }, operator: NODE.address, publicUrl: NODE_URL }),
  );
  node.get("/v1/providers", (c) =>
    c.json([
      { id: "prv_a", name: "A", description: "quotes", payee: PAYEE, priceAtomic: "2000", resource: "/q", category: "data", calls24h: 0 },
      { id: "prv_b", name: "B", description: "briefs", payee: PAYEE_2, priceAtomic: "5000", resource: "/b", category: "data", calls24h: 0 },
    ]),
  );
  node.get("/v1/mandates/:id/position", (c) => {
    const payee = getAddress(c.req.query("payee")!);
    const t = truth.get(payee) ?? 0n;
    const served = t + (script.inflatePosition ?? 0n);
    return c.json({ mandateId: MANDATE, payee, cumulative: served.toString(), settled: "0" });
  });
  node.post("/v1/vouchers", async (c) => {
    const b = (await c.req.json()) as { payload: { payee: Address; amount: string; cumulative: string; signature: Hex; requestHash: Hex; mandateId: Hex } };
    voucherPosts.push(b);
    const p = b.payload;
    const payee = getAddress(p.payee);
    totalInflight++;
    inflight.set(payee, (inflight.get(payee) ?? 0) + 1);
    maxInflightSamePayee = Math.max(maxInflightSamePayee, inflight.get(payee)!);
    maxInflightAll = Math.max(maxInflightAll, totalInflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight.set(payee, inflight.get(payee)! - 1);
    totalInflight--;
    const pos = truth.get(payee) ?? 0n;
    const position = { mandateId: MANDATE, payee, cumulative: pos.toString(), settled: "0" };
    if (script.alwaysStale || BigInt(p.cumulative) !== pos + BigInt(p.amount)) {
      return c.json({ error: { code: "STALE_CUMULATIVE", message: "stale", details: { position } } }, 402);
    }
    if (!(await isVoucherSignedBy(31337, HUB, { mandateId: MANDATE, payee, cumulative: BigInt(p.cumulative) }, p.signature, AGENT.address))) {
      return c.json({ error: { code: "BAD_SIGNATURE", message: "bad" } }, 402);
    }
    truth.set(payee, BigInt(p.cumulative));
    accepted.push({ payee, cumulative: BigInt(p.cumulative) });
    const base = {
      callId: keccak256(toBytes(`${payee}:${p.cumulative}`)),
      mandateId: MANDATE,
      payee,
      amount: BigInt(p.amount),
      cumulative: BigInt(p.cumulative),
      requestHash: p.requestHash,
      timestamp: 1_800_000_000n,
    };
    const leaf = receiptLeaf(base);
    const signer = script.receiptSigner ?? NODE;
    const receipt: ClearingReceipt = {
      ...base,
      amount: p.amount,
      cumulative: p.cumulative,
      timestamp: 1_800_000_000,
      leaf,
      nodeSignature: await signer.signMessage({ message: { raw: leaf } }),
      node: script.receiptNode ?? NODE.address,
    };
    return c.json({ receipt, position: { ...position, cumulative: p.cumulative } });
  });
  node.get("/v1/agents/:address/cosign", (c) => c.json(script.cosignItems ?? []));
  node.post("/v1/cosign/:id", async (c) => {
    cosigned.push({ id: c.req.param("id"), ...((await c.req.json()) as { signerProof: Hex }) });
    return c.json({ ok: true });
  });

  // A node the honest agent must never talk to: it would serve an inflated position.
  const evilNodeHits: string[] = [];
  const evilNode = new Hono();
  evilNode.all("*", (c) => {
    evilNodeHits.push(c.req.path);
    return c.json({ mandateId: MANDATE, payee: PAYEE, cumulative: "9000000", settled: "0" });
  });

  const provider = new Hono();
  const fetchAll = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "node.test") return node.request(url.pathname + url.search, init);
    if (url.host === "evil-node.test") return evilNode.request(url.pathname + url.search, init);
    return provider.request(input instanceof Request ? input : url.toString(), init);
  }) as typeof fetch;

  // Malicious providers: a valid-looking requirement for PAYEE at 2000, but they never forward the voucher honestly.
  const evilRequirement = (clearingNode: string) => {
    const required = {
      x402Version: 2,
      error: { code: "PAYMENT_REQUIRED", message: "pay" },
      accepts: [
        {
          scheme: "payminto-voucher",
          network: "eip155:31337",
          asset: TOKEN,
          payTo: PAYEE,
          amount: "2000",
          resource: "/evil",
          description: "evil",
          maxTimeoutSeconds: 60,
          extra: { clearingNode, clearingHub: HUB, providerId: "prv_evil", tokenSymbol: "USDC", tokenDecimals: 6 },
        },
      ],
    };
    return new Response(JSON.stringify(required), { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodeHeader(required) } });
  };
  const capturedVouchers: Array<{ cumulative: string; signature: Hex }> = [];
  // Answers every voucher with STALE_CUMULATIVE carrying a huge "position", hoping the agent signs on top of it.
  provider.get("/evil-stale", (c) => {
    const sig = c.req.header("PAYMENT-SIGNATURE");
    if (!sig) return evilRequirement(NODE_URL);
    capturedVouchers.push(JSON.parse(Buffer.from(sig, "base64").toString()).payload);
    const position = { mandateId: MANDATE, payee: PAYEE, cumulative: "9000000", settled: "0" };
    return c.json({ error: { code: "STALE_CUMULATIVE", message: "stale", details: { position } } }, 402);
  });
  // Advertises a clearing node of its own choosing in the requirement.
  provider.get("/fake-node", (c) => {
    const sig = c.req.header("PAYMENT-SIGNATURE");
    if (!sig) return evilRequirement("http://evil-node.test");
    capturedVouchers.push(JSON.parse(Buffer.from(sig, "base64").toString()).payload);
    return c.json({ served: true });
  });
  const payA = paywall({ nodeUrl: NODE_URL, providerId: "prv_a", apiKey: "pmk_a", fetch: fetchAll });
  const payB = paywall({ nodeUrl: NODE_URL, providerId: "prv_b", apiKey: "pmk_b", fetch: fetchAll });
  provider.get("/q", payA.hono(), (c) => c.json({ ok: true, paidCumulative: c.get("payminto").receipt.cumulative }));
  provider.post("/b", payB.hono(), async (c) => c.json({ echo: await c.req.json() }));
  provider.get("/exact", (c) =>
    c.json({ x402Version: 2, accepts: [{ scheme: "exact" }] }, 402, { "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts: [{ scheme: "exact" }] }) }),
  );

  const sleeps: number[] = [];
  const voucherSignatures: unknown[] = [];
  // Counts every voucher signature the agent produces, so tests can prove a refused call signs nothing.
  const countingAccount = {
    ...AGENT,
    signTypedData: (async (args: { primaryType: string }) => {
      if (args.primaryType === "Voucher") voucherSignatures.push(args);
      return AGENT.signTypedData(args as never);
    }) as typeof AGENT.signTypedData,
  };
  const agent = (over: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) =>
    new AgentClient({
      chainId: 31337,
      hub: HUB,
      account: countingAccount,
      mandateId: MANDATE,
      nodeUrl: NODE_URL,
      fetch: fetchAll,
      trustedNode: NODE.address,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      ...over,
    });
  return {
    agent,
    fetchAll,
    truth,
    accepted,
    cosigned,
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
    const res = await a.fetch("http://provider.test/q?pair=HSK-USDC");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paidCumulative: "2000" });
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(receipts).toHaveLength(1);
    expect(a.receipts.all()).toHaveLength(1);
    // Second call uses the cached position: no extra position lookup is needed and cumulative extends by the price.
    await a.fetch("http://provider.test/q?pair=BTC-USDC");
    expect(w.accepted.map((x) => x.cumulative)).toEqual([2000n, 4000n]);
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

  it("serializes vouchers per (mandate, payee) but runs different payees in parallel", async () => {
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

  it("does not store a receipt whose node signature does not verify", async () => {
    const w = world({ receiptSigner: EVIL });
    const a = w.agent();
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(200);
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: not signed by the configured node operator"]);
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
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    expect((await a.fetch("http://provider.test/q")).status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["CLIENT_MAX_PRICE"]);
    expect(w.voucherPosts).toHaveLength(0);
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
    expect(a.receipts.signedPosition(MANDATE, PAYEE)).toBe(2000n);
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

  it("rejects a receipt that is self-consistent but signed by a key other than the node operator", async () => {
    const w = world({ receiptSigner: EVIL, receiptNode: EVIL.address });
    const a = w.agent({ trustedNode: undefined });
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    expect((await a.fetch("http://provider.test/q")).status).toBe(200);
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: not signed by the configured node operator"]);
    expect(a.receipts.all()).toHaveLength(0);
  });

  it("rejects every receipt when the configured node's operator is not the pinned trustedNode", async () => {
    const w = world();
    const a = w.agent({ trustedNode: EVIL.address });
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    await a.fetch("http://provider.test/q");
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: cannot read the operator of the configured node"]);
    await expect(a.nodeOperator()).rejects.toThrow(/pinned trustedNode/);
  });
});

describe("persistent receipt store", () => {
  const BATCH = keccak256(toBytes("restart-batch"));

  it("survives a restart: positions stay known and co-signing still works", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "payminto-sdk-")), "agent.receipts.test.db");
    const w = world();
    const first = w.agent({ storePath: path });
    for (let i = 0; i < 3; i++) expect((await first.fetch(`http://provider.test/q?i=${i}`)).status).toBe(200);
    first.close();

    // Same file, new client: receipts and signed positions are back.
    const second = w.agent({ storePath: path });
    expect(second.receipts.all().map((r) => r.cumulative)).toEqual(["2000", "4000", "6000"]);
    expect(second.receipts.signedPosition(MANDATE, PAYEE)).toBe(6000n);
    // It extends the node's position because it remembers signing it.
    expect((await second.fetch("http://provider.test/q?after-restart")).status).toBe(200);
    expect(w.accepted.at(-1)).toEqual({ payee: PAYEE, cumulative: 8000n });

    const calls = second.receipts.all().slice(0, 3).map((r) => ({ callId: r.callId, amount: r.amount }));
    const honest = cosignItem(6000n, calls, BATCH);
    const w2 = world({ cosignItems: [honest] });
    const signer = w2.agent({ storePath: path });
    const r = await signer.cosignOnce();
    expect(r.signed).toEqual([honest.hspPaymentId]);
    signer.close();
    second.close();

    // Co-sign accounting is durable too: the same receipts cannot justify the batch twice after another restart.
    const third = w2.agent({ storePath: path });
    expect(third.checkCosign(cosignItem(1n, calls, BATCH) as never)).toMatchObject({ ok: false });
    third.close();

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
    a.recordSigned(MANDATE, PAYEE, 10_000n);
    b.recordSigned(MANDATE, PAYEE, 4_000n);
    b.recordSigned(MANDATE, PAYEE_2, 10n ** 30n); // beyond int64
    expect(a.signedPosition(MANDATE, PAYEE)).toBe(10_000n);
    expect(a.signedPosition(MANDATE, PAYEE_2)).toBe(10n ** 30n);
    expect(b.signedPositions(MANDATE)).toEqual(new Map([[PAYEE.toLowerCase(), 10_000n], [PAYEE_2.toLowerCase(), 10n ** 30n]]));
    a.close();
    b.close();
  });
});

describe("verifyReceiptOnchain", () => {
  async function signedReceipt(signer = NODE) {
    const base = { callId: keccak256(toBytes("c1")), mandateId: MANDATE, payee: PAYEE, amount: 2000n, cumulative: 2000n, requestHash: keccak256(toBytes("r")), timestamp: 1_800_000_000n };
    const leaf = receiptLeaf(base);
    return { ...base, amount: "2000", cumulative: "2000", timestamp: 1_800_000_000, leaf, nodeSignature: await signer.signMessage({ message: { raw: leaf } }) };
  }
  const chain = (settler: Address, merkle = true) => ({
    readContract: (async (args: { functionName: string }) =>
      args.functionName === "batches" ? [keccak256(toBytes("root")), TOKEN, settler, 1n, 1n, 1n] : merkle) as never,
  });
  const BATCH = keccak256(toBytes("b"));

  it("verifies only when the batch settler is the node operator and the operator signed the leaf", async () => {
    const r = await signedReceipt();
    expect(await verifyReceiptOnchain({ publicClient: chain(NODE.address), hub: HUB, operator: NODE.address, receipt: r, batchId: BATCH, proof: [] })).toMatchObject({
      verified: true,
      reason: null,
    });
    // A batch someone else settled (for example over replayed vouchers with a made-up root) proves nothing.
    const foreign = await verifyReceiptOnchain({ publicClient: chain(EVIL.address), hub: HUB, operator: NODE.address, receipt: r, batchId: BATCH, proof: [] });
    expect(foreign).toMatchObject({ verified: false, merkleVerified: true, settlerIsNode: false });
    expect(foreign.reason).toMatch(/settled by/);
    // A leaf the node never signed proves nothing even inside the node's own batch.
    const forged = await verifyReceiptOnchain({ publicClient: chain(NODE.address), hub: HUB, operator: NODE.address, receipt: await signedReceipt(EVIL), batchId: BATCH, proof: [] });
    expect(forged).toMatchObject({ verified: false, nodeSigned: false });
  });
});

describe("AgentClient pre-sign policy guard", () => {
  const OTHER_TOKEN = "0x054ed45810DbBAb8B27668922D110669c9D88D0a" as Address;

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
    const body = (await res.json()) as { error: { code: string; details: { enforcedBy: string } } };
    expect(body.error.code).toBe(rule);
    expect(body.error.details.enforcedBy).toBe("agent");
    expect(denied.map((d) => d.code)).toEqual([rule]);
    expect(w.voucherSignatures.length, "no voucher signature for a refused call").toBe(signedBefore);
    expect(w.voucherPosts).toHaveLength(calls.ok.length);
  }

  it("PER_CALL_CAP", () => refused("PER_CALL_CAP", bundle({ policy: { perCallCap: "1999" } }), { ok: [], refused: "/q" }));
  it("PAYEE_NOT_ALLOWED", () => refused("PAYEE_NOT_ALLOWED", bundle({ payees: [PAYEE_2] }), { ok: ["/b"], refused: "/q" }));
  it("MANDATE_NOT_ACTIVE (expired)", () =>
    refused("MANDATE_NOT_ACTIVE", bundle({ mandate: { validAfter: BigInt(NOW - 100), validUntil: BigInt(NOW - 10) } }), { ok: [], refused: "/q" }));
  it("MANDATE_NOT_ACTIVE (not yet valid)", () => refused("MANDATE_NOT_ACTIVE", bundle({ mandate: { validAfter: BigInt(NOW + 600) } }), { ok: [], refused: "/q" }));
  it("TOKEN_MISMATCH", () => refused("TOKEN_MISMATCH", bundle({ mandate: { token: OTHER_TOKEN } }), { ok: [], refused: "/q" }));
  it("RATE_LIMIT", () => refused("RATE_LIMIT", bundle({ policy: { maxCallsPerMinute: 2 } }), { ok: ["/q", "/b"], refused: "/q" }));
  it("DAILY_CAP", () => refused("DAILY_CAP", bundle({ policy: { dailyCap: "6999" } }), { ok: ["/q", "/q"], refused: "/b" }));
  it("TOTAL_CAP counts every payee's cumulative", () =>
    refused("TOTAL_CAP", bundle({ mandate: { totalCap: 8_999n } }), { ok: ["/q", "/q"], refused: "/b" }));

  it("reserves in-flight vouchers so parallel payees cannot jointly exceed a cap", async () => {
    const w = world({ bundle: bundle({ mandate: { totalCap: 6_000n } }) });
    const a = w.agent();
    const res = await Promise.all([a.fetch("http://provider.test/q"), a.fetch("http://provider.test/b", { method: "POST", body: "{}" })]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(w.voucherSignatures).toHaveLength(1);
  });

  it("refuses to sign anything when the node serves a policy that does not hash to the mandate", async () => {
    const strict = bundle({ policy: { perCallCap: "1000" }, payees: [PAYEE_2] });
    for (const served of [
      { ...strict, policy: { ...strict.policy, perCallCap: "1000000" } }, // loosened cap
      { ...strict, payees: [] }, // dropped allowlist
      { ...strict, mandate: { ...strict.mandate, totalCap: 10n ** 18n } }, // different mandate
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

  it("accepts the policy as a constructor option, still verified, without asking the node", async () => {
    const b = bundle({ policy: { perCallCap: "1999" } });
    const w = world({ bundle: b, servedPolicy: DEFAULT });
    const a = w.agent({ policy: { mandate: b.mandate, policy: b.policy, payees: b.payees } });
    expect((await a.fetch("http://provider.test/q")).status).toBe(402);
    expect(w.voucherSignatures).toHaveLength(0);
    const bad = w.agent({ policy: { mandate: b.mandate, policy: { ...b.policy, perCallCap: "99999" }, payees: [] } });
    await expect(bad.loadPolicy()).rejects.toThrow(/policyHash/);
  });

  it("can be turned off, leaving enforcement to the node and the hub", async () => {
    const w = world({ bundle: bundle({ policy: { perCallCap: "1999" } }) });
    expect((await w.agent({ enforcePolicy: false }).fetch("http://provider.test/q")).status).toBe(200);
  });
});

describe("paywall", () => {
  it("returns an x402 v2 requirement without a payment and checks the request hash before asking the node", async () => {
    const w = world();
    const res = await w.fetchAll("http://provider.test/q?x=1");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>>; error: { code: string } };
    expect(body.error.code).toBe("PAYMENT_REQUIRED");
    expect(body.accepts[0]).toMatchObject({
      scheme: "payminto-voucher",
      network: "eip155:31337",
      asset: TOKEN,
      payTo: PAYEE,
      amount: "2000",
      extra: { clearingNode: NODE_URL, clearingHub: HUB, providerId: "prv_a", tokenSymbol: "USDC", tokenDecimals: 6 },
    });
    // A voucher bound to a different request is refused locally.
    const sig = await AGENT.signTypedData({
      domain: { name: "Payminto Clearing", version: "1", chainId: 31337, verifyingContract: HUB },
      types: { Voucher: [{ name: "mandateId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "cumulative", type: "uint256" }] },
      primaryType: "Voucher",
      message: { mandateId: MANDATE, payee: PAYEE, cumulative: 2000n },
    });
    const payment = {
      x402Version: 2,
      scheme: "payminto-voucher",
      network: "eip155:31337",
      payload: { mandateId: MANDATE, payee: PAYEE, amount: "2000", cumulative: "2000", signature: sig, requestHash: computeRequestHash("GET", "/other") },
    };
    const r2 = await w.fetchAll("http://provider.test/q?x=1", { headers: { "PAYMENT-SIGNATURE": encodeHeader(payment) } });
    expect(r2.status).toBe(402);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("REQUEST_HASH_MISMATCH");
    expect(w.voucherPosts).toHaveLength(0);
  });

  it("binds the request hash to method, path, query and body", () => {
    const h = computeRequestHash("GET", "http://a.test/q?x=1");
    expect(computeRequestHash("get", "https://other-host/q?x=1")).toBe(h);
    expect(computeRequestHash("GET", "http://a.test/q?x=2")).not.toBe(h);
    expect(computeRequestHash("POST", "http://a.test/q?x=1")).not.toBe(h);
    expect(computeRequestHash("GET", "http://a.test/q?x=1", new TextEncoder().encode("{}"))).not.toBe(h);
  });
});

function cosignItem(amount: bigint, calls: Array<{ callId: Hex; amount: string }>, batchId: Hex) {
  const body = buildNetTransferMandate({ payer: AGENT.address, recipient: PAYEE, token: TOKEN, amount, chainId: 31337, batchId, deadline: 1_900_000_000n });
  return {
    hspPaymentId: hspPaymentId(31337, HUB, body),
    batchId,
    payer: AGENT.address,
    recipient: PAYEE,
    token: TOKEN,
    amount: amount.toString(),
    deadline: 1_900_000_000,
    calls: calls.map((c) => ({ ...c, mandateId: MANDATE, payee: PAYEE, cumulative: "0" })),
    typedData: { domain: { name: "HSP", version: "1", chainId: 31337, verifyingContract: HUB }, types: hspTypes, primaryType: "Mandate", message: hspMandateToWire(body) },
  };
}

describe("HSP co-sign (malicious node defence)", () => {
  const BATCH = keccak256(toBytes("batch-1"));

  function item(amount: bigint, calls: Array<{ callId: Hex; amount: string }>, over: { payer?: Address; batchId?: Hex; badId?: boolean } = {}) {
    const body = buildNetTransferMandate({
      payer: over.payer ?? AGENT.address,
      recipient: PAYEE,
      token: TOKEN,
      amount,
      chainId: 31337,
      batchId: BATCH,
      deadline: 1_900_000_000n,
    });
    const id = hspPaymentId(31337, HUB, body);
    return {
      hspPaymentId: over.badId ? keccak256(toBytes("forged")) : id,
      batchId: over.batchId ?? BATCH,
      payer: over.payer ?? AGENT.address,
      recipient: PAYEE,
      token: TOKEN,
      amount: amount.toString(),
      deadline: 1_900_000_000,
      calls: calls.map((c) => ({ ...c, mandateId: MANDATE, payee: PAYEE, cumulative: "0" })),
      typedData: { domain: { name: "HSP", version: "1", chainId: 31337, verifyingContract: HUB }, types: hspTypes, primaryType: "Mandate", message: hspMandateToWire(body) },
    };
  }

  async function agentWithReceipts(script: Script) {
    const w = world(script);
    const a = w.agent({ nodeUrl: NODE_URL });
    for (let i = 0; i < 3; i++) await a.fetch(`http://provider.test/q?i=${i}`); // 3 x 2000
    return { w, a, calls: a.receipts.all().map((r) => ({ callId: r.callId, amount: r.amount })) };
  }

  it("co-signs a mandate its receipts justify and refuses one that overstates the debit", async () => {
    const setup = await agentWithReceipts({});
    const honest = item(6000n, setup.calls);
    const greedy = item(6001n, setup.calls);
    const cosignItems: unknown[] = [greedy, honest];
    const w = world({ cosignItems });
    // Reuse the same agent receipts with a node that serves the co-sign items.
    const a = w.agent({ nodeUrl: NODE_URL, receipts: setup.a.receipts });
    const r = await a.cosignOnce();
    expect(r.refused.map((x) => x.hspPaymentId)).toEqual([greedy.hspPaymentId]);
    expect(r.refused[0]!.reason).toMatch(/exceed/);
    expect(r.signed).toEqual([honest.hspPaymentId]);
    expect(w.cosigned).toHaveLength(1);
    const { hspMandateFromWire } = await import("@payminto/protocol");
    expect(await isHspMandateSignedBy(31337, HUB, hspMandateFromWire(honest.typedData.message), w.cosigned[0]!.signerProof, AGENT.address)).toBe(true);
    // The same receipts cannot justify a second mandate for the batch: running total is enforced.
    expect(a.checkCosign(item(1n, setup.calls) as never)).toMatchObject({ ok: false });
  });

  it("refuses mandates not addressed to the agent, unknown receipts, forged ids and unbound batches", async () => {
    const { a, calls } = await agentWithReceipts({});
    expect(a.checkCosign(item(100n, calls, { payer: PAYEE_2 }) as never)).toMatchObject({ ok: false, reason: "not addressed to this agent" });
    expect(a.checkCosign(item(100n, [{ callId: keccak256(toBytes("not-mine")), amount: "999999" }]) as never)).toMatchObject({ ok: false });
    expect(a.checkCosign(item(100n, calls, { badId: true }) as never)).toMatchObject({ ok: false, reason: "hspPaymentId does not match the mandate" });
    expect(a.checkCosign(item(100n, calls, { batchId: keccak256(toBytes("other")) }) as never)).toMatchObject({ ok: false, reason: "settlementBinding is not the batch id" });
    const wrongVc = item(100n, calls);
    wrongVc.typedData.domain.verifyingContract = PAYEE_2;
    expect(a.checkCosign(wrongVc as never)).toMatchObject({ ok: false, reason: "unexpected verifying contract" });
    expect(a.checkCosign(item(6000n, calls) as never)).toMatchObject({ ok: true, justified: 6000n });
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

describe("AgentClient.signPermit (gasless onboarding)", () => {
  /** A read-only fake of the token: DOMAIN_SEPARATOR under `served`, permit nonce 3, optional ERC-5267 domain. */
  function token(chainId: number, address: Address, served: { name: string; version: string }, eip5267 = true) {
    return {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "DOMAIN_SEPARATOR" ? tokenDomainSeparator(chainId, address, served) : 3n,
      getEip712Domain: async () => {
        if (!eip5267) throw new Error("no eip712Domain()");
        return { domain: served };
      },
    } as unknown as PublicClient;
  }

  it("signs USDC.e permits under its real domain (Bridged USDC v2) from chains.ts, with the token's nonce", async () => {
    const usdce = networks[177]!.token.address;
    const agent = new AgentClient({ chainId: 177, hub: HUB, account: AGENT, mandateId: MANDATE, nodeUrl: NODE_URL });
    const p = await agent.signPermit({ token: usdce, value: 5_000_000n, deadline: 2_000_000_000n, publicClient: token(177, usdce, { name: "Bridged USDC", version: "2" }, false) });
    const signer = await recoverTypedDataAddress({
      ...permitTypedData(
        { name: "Bridged USDC", version: "2", chainId: 177, verifyingContract: usdce },
        { owner: AGENT.address, spender: HUB, value: 5_000_000n, nonce: 3n, deadline: 2_000_000_000n },
      ),
      signature: p.signature,
    });
    expect(signer).toBe(AGENT.address);
    expect(p).toMatchObject({ value: 5_000_000n, deadline: 2_000_000_000n });
  });

  it("refuses to sign when the domain it would use does not match the token's DOMAIN_SEPARATOR", async () => {
    const usdce = networks[177]!.token.address;
    const agent = new AgentClient({ chainId: 177, hub: HUB, account: AGENT, mandateId: MANDATE, nodeUrl: NODE_URL });
    // A token claiming to be USDC.e but serving the "USD Coin" separator: a signature would be rejected on chain.
    await expect(agent.signPermit({ token: usdce, value: 1n, publicClient: token(177, usdce, { name: "USD Coin", version: "2" }) })).rejects.toThrow(
      /does not match/,
    );
  });

  it("reads other tokens' domains from ERC-5267 eip712Domain(), or takes it explicitly", async () => {
    const agent = new AgentClient({ chainId: 31337, hub: HUB, account: AGENT, mandateId: MANDATE, nodeUrl: NODE_URL });
    const local = { name: "USD Coin", version: "1" };
    await expect(agent.signPermit({ token: TOKEN, value: 1n, publicClient: token(31337, TOKEN, local) })).resolves.toMatchObject({ value: 1n });
    await expect(agent.signPermit({ token: TOKEN, value: 1n, publicClient: token(31337, TOKEN, local, false) })).rejects.toThrow(/no known EIP-712 domain/);
    await expect(agent.signPermit({ token: TOKEN, value: 1n, domain: local, publicClient: token(31337, TOKEN, local, false) })).resolves.toBeTruthy();
  });
});
