/**
 * The any-chain checkout's business choices, end to end over HTTP with the fake 1Click server in process and an
 * in-memory NEAR reader: origin token details on options and quotes, the token the checkout pre-selects, and "receive
 * as", where the business takes its USDC on an EVM chain (proven with an EIP-191 signature) and the node confirms the
 * delivery by reading the ERC-20 Transfer in the transaction receipt over JSON-RPC. In simulated mode that JSON-RPC is
 * the fake server's simulated chain; the live reader is tested against canned answers. Nothing here reaches a network:
 * the database is a temp *.test.db and the chain is FakeChain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { PAYOUT_DESTINATIONS, type FetchLike } from "@payminto/near-addons/intents";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY, FakeOneClick, signTestEvmPayoutProof } from "@payminto/near-addons/intents/fake-server";
import { intentsPayoutProofRequest, nep413Digest, signDigest, type AccountId, type IntentsPayoutProof, type PublicKey } from "@payminto/protocol";
import { ConfigError, loadConfig, type GatewayConfig, type IntentsConfig } from "../src/config.ts";
import { DESTINATION_CHAINS, settlementNetworkOf } from "../src/gateway/intents.ts";
import { EVM_RPC_DEFAULTS, EvmRpc, type DeliveryRead, type IntentsChainReader } from "../src/gateway/intents-rpc.ts";
import { silentLogger } from "../src/logger.ts";
import type { AccessKeyKind } from "../src/near-rpc.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { FakeNearRpc, payoutAccount, startFakeChain, tempDir, testConfig, testKey, TOKEN } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const SHOP = payoutAccount("shop.testnet", 80);
const MAINNET = "shop-usdc.near";
const MAINNET_KEY = testKey(81);
const SOLVER = "solver.near";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const BASE_ETH = "nep141:base.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const BASE_USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const REFUND = "0x2527d02599ba641c19fea793cd0f167589a0f10d";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (v: string) => `0x${v.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

class FakeIntentsReader implements IntentsChainReader {
  readonly accounts = new Set<string>();
  readonly keys = new Map<string, AccessKeyKind>();
  readonly registered = new Set<string>();
  readonly txs = new Map<string, DeliveryRead>();
  async accountExists(a: AccountId) {
    return this.accounts.has(a);
  }
  async storageRegistered(token: AccountId, a: AccountId) {
    return this.registered.has(`${token} ${a}`);
  }
  async accessKey(a: AccountId, pk: PublicKey) {
    return this.keys.get(`${a} ${pk}`) ?? null;
  }
  async delivery(hash: string): Promise<DeliveryRead> {
    return this.txs.get(hash) ?? { status: "unknown" };
  }
}

const reader = new FakeIntentsReader();
let deliveries = 0;
const fake = new FakeOneClick({
  stepMs: 0,
  refundAfterMs: 0,
  accountExists: (id) => reader.accounts.has(id),
  deliver: async ({ recipient, amount }) => {
    const hash = `DeliveryTx${++deliveries}AbCdEfGhJkLmNoPq`;
    reader.txs.set(hash, { status: "final", hash, transfers: [{ token: TOKEN, from: SOLVER, to: recipient, amount }] });
    return { txHash: hash };
  },
});
/** Every URL the node fetched through the 1Click fetch, and a hook to rewrite the simulated chain's JSON-RPC answers. */
const fetched: string[] = [];
let rpcTamper: ((chain: string, body: any) => any) | null = null;
const oneclick: FetchLike = async (url, init) => {
  fetched.push(url);
  const res = await fake.fetch(url, init);
  const m = /\/_fake\/rpc\/([a-z]+)$/.exec(new URL(url).pathname);
  if (!m || !rpcTamper) return res;
  const out = rpcTamper(m[1]!, JSON.parse(await res.text()));
  return { status: res.status, text: async () => JSON.stringify(out) };
};

const intents: IntentsConfig = {
  mode: "simulated",
  baseUrl: "http://fake-1click.local",
  apiKey: null,
  managerPublicKey: FAKE_ONECLICK_MANAGER_PUBLIC_KEY,
  nearRpcUrl: "http://127.0.0.1:1",
  usdcContract: TOKEN,
  deliverySenders: [SOLVER],
  origins: null,
  slippage: { stable: 10, volatile: 100 },
  referral: "payminto",
};

const tmp = tempDir("payminto-receive-as-");
let chain: FakeChain;
let node: ClearingNode;
let shopId = "";

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth: string | null = ADMIN) => {
  const r = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}`, "merchant-id": shopId } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, json, text };
};
let client = 0;
const pub = (method: string, path: string, body?: unknown) => call(method, path, body, { "x-forwarded-for": `10.1.${Math.floor(++client / 250)}.${client % 250}` }, null);

function nearProof(account: AccountId, timestamp = Math.floor(Date.now() / 1000)): IntentsPayoutProof {
  const digest = nep413Digest(intentsPayoutProofRequest(shopId, account, timestamp, { settlementNetwork: "near:mainnet (simulated)", hub: chain.hub }));
  return { timestamp, public_key: MAINNET_KEY.publicKey, signature: Buffer.from(signDigest(MAINNET_KEY.secretKey, digest), "hex").toString("base64") };
}

const evmBody = async (destination_chain: string, chainId: number, o: { timestamp?: number; merchantId?: string } = {}) => {
  const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
  const { address, signature } = await signTestEvmPayoutProof({ merchantId: o.merchantId ?? shopId, timestamp, chainId, hub: chain.hub });
  return { destination_chain, address, proof: { type: "eip191", timestamp, signature } };
};

const svc = () => node.services.gateway!.intents!;
const newPayment = async (amount = "5000000") => {
  const r = await call("POST", "/v1/payments", { amount, description: "Receive as" });
  expect(r.status, r.text).toBe(201);
  return r.json.id as string;
};
const newQuote = async (paymentId: string, origin = BASE_USDC) => {
  const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes`, { origin_asset: origin, refund_to: REFUND });
  expect([200, 201], r.text).toContain(r.status);
  return r.json;
};

beforeAll(async () => {
  chain = startFakeChain([]);
  chain.register(SHOP.account);
  const gateway: GatewayConfig = { seedPayout: SHOP.account, platformName: "Shop", feeRecipient: null, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000, intents };
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, gateway, trustProxyHops: 1 }), {
    chain,
    nearRpc: new FakeNearRpc().addKey(SHOP.account, SHOP.key.publicKey),
    intentsReader: reader,
    intentsFetch: oneclick,
    logger: silentLogger,
    port: 0,
    workers: false,
  });
  shopId = (await call("GET", "/v1/merchant")).json.id;
  reader.accounts.add(MAINNET);
  reader.accounts.add(SOLVER);
  reader.keys.set(`${MAINNET} ${MAINNET_KEY.publicKey}`, "full_access");
  reader.registered.add(`${TOKEN} ${MAINNET}`);
  expect((await call("PUT", "/v1/merchant/intents-payout", { account: MAINNET, proof: nearProof(MAINNET) })).status).toBe(200);
  expect((await call("PUT", `/v1/merchants/${shopId}/methods`, { methods: [{ method: "oneclick", enabled: true }] })).status).toBe(200);
});

afterAll(async () => {
  await node?.stop();
  await fake.close();
  tmp.cleanup();
});

describe("origin token details", () => {
  it("every option names its token contract and EVM chain id, pinned rather than fetched", async () => {
    const paymentId = await newPayment();
    const o = (await pub("GET", `/v1/checkout/${paymentId}/intents/options`)).json;
    const by = Object.fromEntries(o.options.map((x: any) => [x.origin.asset, x.origin]));
    expect(by[BASE_USDC]).toEqual({ asset: BASE_USDC, chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6, contract_address: BASE_USDC_CONTRACT, chain_id: 8453 });
    expect(by[BASE_ETH]).toMatchObject({ contract_address: null, chain_id: 8453 });
    expect(by[SOL_USDC]).toMatchObject({ contract_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chain_id: null });
    expect(fetched.some((u) => u.includes("/v0/tokens"))).toBe(false);
  });

  it("the quote carries them too, and says where the USDC lands", async () => {
    const q = await newQuote(await newPayment());
    expect(q.origin).toMatchObject({ contract_address: BASE_USDC_CONTRACT, chain_id: 8453 });
    expect(q.destination).toEqual({ chain: "near", chain_name: "NEAR", symbol: "USDC", address: MAINNET });
    expect(q.settlement_network).toBe("near:mainnet (simulated)");
  });
});

describe("the token the checkout pre-selects", () => {
  it("starts unset, is set by PATCH to an offered origin, and shows on the payout and the checkout", async () => {
    expect((await call("GET", "/v1/merchant/intents-payout")).json.default_origin).toBeNull();
    const set = await call("PATCH", "/v1/merchant/intents-payout", { default_origin: SOL_USDC });
    expect(set.status, set.text).toBe(200);
    expect(set.json).toMatchObject({ object: "intents_payout", default_origin: SOL_USDC });
    expect((await call("GET", "/v1/merchant/intents-payout")).json.default_origin).toBe(SOL_USDC);
    const paymentId = await newPayment();
    expect((await pub("GET", `/v1/checkout/${paymentId}`)).json.intents).toMatchObject({ available: true, default_origin: SOL_USDC });
    const audit = node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'intents_default_origin.changed'");
    expect(audit?.n).toBe(1);
  });

  it("refuses a token that is not offered, and null clears it", async () => {
    const bad = await call("PATCH", "/v1/merchant/intents-payout", { default_origin: "nep141:btc.omft.near" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("ORIGIN_NOT_OFFERED");
    expect((await call("PATCH", "/v1/merchant/intents-payout", {})).status).toBe(400);
    expect((await call("GET", "/v1/merchant/intents-payout")).json.default_origin).toBe(SOL_USDC);
    const cleared = await call("PATCH", "/v1/merchant/intents-payout", { default_origin: null });
    expect(cleared.json.default_origin).toBeNull();
    expect((await pub("GET", `/v1/checkout/${await newPayment()}`)).json.intents.default_origin).toBeNull();
  });

  it("needs business.update", async () => {
    const r = await call("PATCH", "/v1/merchant/intents-payout", { default_origin: SOL_USDC }, {}, null);
    expect(r.status).toBe(401);
  });
});

describe("receive as: USDC on another chain", () => {
  it("shows NEAR as today's destination and the six destinations a business can choose", async () => {
    const p = (await call("GET", "/v1/merchant/intents-payout")).json;
    expect(p.destination).toEqual({ chain: "near", chain_name: "NEAR", symbol: "USDC", asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", address: MAINNET, proven: true, verify: "rpc" });
    expect(p.destinations).toEqual([
      { chain: "near", chain_name: "NEAR", symbol: "USDC", asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, verify: "rpc" },
      { chain: "base", chain_name: "Base", symbol: "USDC", asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, verify: "rpc" },
      { chain: "arb", chain_name: "Arbitrum", symbol: "USDC", asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, verify: "rpc" },
      { chain: "eth", chain_name: "Ethereum", symbol: "USDC", asset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, verify: "rpc" },
      { chain: "pol", chain_name: "Polygon", symbol: "USDC", asset: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", decimals: 6, verify: "rpc" },
      { chain: "op", chain_name: "Optimism", symbol: "USDC", asset: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ", decimals: 6, verify: "rpc" },
    ]);
    // Migration 009: a business that never chose keeps NEAR.
    expect(node.services.db.get<{ c: string }>("SELECT intents_destination_chain AS c FROM merchants WHERE id = ?", shopId)!.c).toBe("near");
  });

  it("refuses a proof by another key, for another chain or business, a stale one, and a chain that is not offered", async () => {
    const put = (b: unknown) => call("PUT", "/v1/merchant/intents-payout", b);
    const signedForArb = await evmBody("arb", 42161);
    expect((await put({ ...signedForArb, destination_chain: "base" })).json.error.code).toBe("PAYOUT_PROOF_INVALID");
    const other = await evmBody("base", 8453, { merchantId: "mer_someoneelseaaaaaaaaaaaaaaa" });
    expect((await put(other)).json.error.code).toBe("PAYOUT_PROOF_INVALID");
    const good = await evmBody("base", 8453);
    expect((await put({ ...good, address: REFUND })).json.error.code).toBe("PAYOUT_PROOF_INVALID");
    expect((await put(await evmBody("base", 8453, { timestamp: Math.floor(Date.now() / 1000) - 3600 }))).json.error.code).toBe("PAYOUT_PROOF_EXPIRED");
    const bsc = await put({ ...good, destination_chain: "bsc" });
    expect(bsc.status).toBe(400);
    expect(bsc.json.error.code).toBe("DESTINATION_NOT_OFFERED");
    expect((await put({ ...good, destination_chain: "near" })).json.error.code).toBe("DESTINATION_NOT_OFFERED");
    expect((await put({ ...good, proof: { ...good.proof, type: "nep413" } })).status).toBe(400);
    expect((await call("GET", "/v1/merchant/intents-payout")).json.destination.chain).toBe("near");
  });

  let paymentId = "";
  let quote: any;
  let address = "";

  it("switching to USDC on Base expires the open quotes to NEAR that saw no deposit", async () => {
    const open = await newQuote(await newPayment());
    expect(open.status).toBe("awaiting_deposit");
    const body = await evmBody("base", 8453);
    address = body.address;
    const r = await call("PUT", "/v1/merchant/intents-payout", { ...body, address: body.address.replace(/[a-f]/g, (c) => c.toUpperCase()).replace(/^0X/, "0x") });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ verified: true, destination: { chain: "base", chain_name: "Base", symbol: "USDC", asset: BASE_USDC, address, proven: true, verify: "rpc" }, storage_step: null });
    expect(svc().row(open.id)!.status).toBe("expired");
    const audit = node.services.db.get<{ meta: string }>("SELECT meta_json AS meta FROM audit_events WHERE action = 'intents_payout.changed' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(audit!.meta)).toMatchObject({ to: address, destination_chain: "base" });
  });

  it("quotes deliver USDC on Base to the business's address", async () => {
    paymentId = await newPayment();
    const o = (await pub("GET", `/v1/checkout/${paymentId}/intents/options`)).json;
    expect(o.recipient).toBe(address);
    expect(o.options.find((x: any) => x.origin.asset === BASE_USDC).available).toBe(true);
    quote = await newQuote(paymentId);
    expect(quote).toMatchObject({ recipient: address, destination: { chain: "base", chain_name: "Base", symbol: "USDC", address }, settlement_network: "eip155:8453 (simulated)", label: "Simulated - no real money" });
    const signed = (await call("GET", `/v1/payments/${paymentId}`)).json.intents.quotes[0].quote_response;
    expect(signed.quoteRequest).toMatchObject({ destinationAsset: BASE_USDC, recipient: address, recipientType: "DESTINATION_CHAIN" });
  });

  it("confirms only after reading the ERC-20 Transfer to the address in the receipt on the (simulated) chain", async () => {
    const r = await pub("POST", `/v1/checkout/${paymentId}/intents/quotes/${quote.id}/simulate`, {});
    expect(r.status, r.text).toBe(200);
    await fake.idle();
    const row = await svc().checkNow(quote.id);
    expect(row).toMatchObject({ status: "confirmed", verification: "rpc_checked" });
    const done = (await pub("GET", `/v1/checkout/${paymentId}/intents/quotes/${quote.id}`)).json;
    expect(done.delivery_tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(done.delivered).toEqual({ amount: "5000000", formatted: "5.000000", symbol: "USDC" });
    expect((await call("GET", `/v1/payments/${paymentId}`)).json.status).toBe("paid");
    // The receipt was read from the fake server's simulated Base, never a mainnet RPC.
    const rpc = fetched.filter((u) => u.includes("/_fake/rpc/"));
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpc.every((u) => u === "http://fake-1click.local/_fake/rpc/base")).toBe(true);
    expect(fetched.some((u) => Object.values(EVM_RPC_DEFAULTS).some((d) => u.startsWith(d)))).toBe(false);
    // The proof of the credit reads the same receipt again.
    const proof = (await pub("GET", `/v1/checkout/${paymentId}/proof`)).json;
    expect(proof.credits[0]).toMatchObject({ recipient: address, token: BASE_USDC_CONTRACT, delivered_on_chain: "5000000", verified: true, settlement_network: "eip155:8453 (simulated)", delivery_senders: [] });
    // The reconciliation report says where it settled.
    const day = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = (await call("GET", `/v1/reports/reconciliation?from=${day}&to=${tomorrow}`)).json.rows.find((x: any) => x.payment_id === paymentId);
    expect(report).toMatchObject({ method: "oneclick", currency: "USDC (Base, simulated)", settlement_network: "eip155:8453 (simulated)", origin_asset: BASE_USDC });
    // The delivery leg is named for where it landed, never "near_delivery", and the simulated chain has no explorer link.
    const legs = report.transactions.map((t: any) => [t.leg, t.explorer_url]);
    expect(legs).toEqual([
      ["origin_deposit", null],
      ["destination_delivery", null],
    ]);
  });

  it("never confirms a receipt that pays less or someone else, not even on 1Click's word", async () => {
    const id = await newPayment();
    const q = await newQuote(id);
    rpcTamper = (_chain, body) => {
      if (!body.result?.logs) return body;
      const [log] = body.result.logs;
      body.result.logs = [{ ...log, data: word((4_999_999).toString(16)) }, { ...log, topics: [TRANSFER, log.topics[1], word(REFUND)] }];
      return body;
    };
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    node.services.db.run("UPDATE intents_quotes SET delivered_unix = delivered_unix - 3600 WHERE id = ?", q.id);
    expect(await svc().checkNow(q.id)).toMatchObject({ status: "delivered", verification: null });
    rpcTamper = null;
    expect((await call("GET", `/v1/payments/${id}`)).json.status).toBe("processing");
  });

  it("a Transfer of another token does not count", async () => {
    const id = await newPayment();
    const q = await newQuote(id);
    rpcTamper = (_chain, body) => {
      if (body.result?.logs) body.result.logs = body.result.logs.map((l: any) => ({ ...l, address: "0x1111111111111111111111111111111111111111" }));
      return body;
    };
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    rpcTamper = null;
  });

  it("falls back to 1Click's word (provider_only) when the receipt cannot be read for 10 minutes", async () => {
    const id = await newPayment();
    const q = await newQuote(id);
    rpcTamper = (_chain, body) => (body.result && body.result.logs ? { ...body, result: null } : body);
    await fake.deposit(q.deposit_address, BigInt(q.send_exactly.amount));
    await fake.idle();
    expect((await svc().checkNow(q.id)).status).toBe("delivered");
    node.services.db.run("UPDATE intents_quotes SET delivered_unix = delivered_unix - 601 WHERE id = ?", q.id);
    expect(await svc().checkNow(q.id)).toMatchObject({ status: "confirmed", verification: "provider_only" });
    rpcTamper = null;
    expect((await call("GET", `/v1/payments/${id}`)).json.status).toBe("paid");
  });

  it("switching back to the NEAR account with today's body makes NEAR the destination again", async () => {
    const r = await call("PUT", "/v1/merchant/intents-payout", { account: MAINNET, proof: nearProof(MAINNET) });
    expect(r.status, r.text).toBe(200);
    expect(r.json.destination).toMatchObject({ chain: "near", address: MAINNET, proven: true });
    const q = await newQuote(await newPayment());
    expect(q.destination).toEqual({ chain: "near", chain_name: "NEAR", symbol: "USDC", address: MAINNET });
  });
});

describe("the destination table the node keeps for code that runs without the kit (reports)", () => {
  it("names the same chains with the same chain ids as the kit's PAYOUT_DESTINATIONS", () => {
    expect(Object.keys(DESTINATION_CHAINS)).toEqual(PAYOUT_DESTINATIONS.map((d) => d.blockchain));
    for (const d of PAYOUT_DESTINATIONS) {
      expect({ name: DESTINATION_CHAINS[d.blockchain]!.name, chainId: DESTINATION_CHAINS[d.blockchain]!.chainId }).toEqual({ name: d.chainName, chainId: d.chainId });
      expect(settlementNetworkOf("live", d.blockchain)).toBe(d.chainId === null ? "near:mainnet" : `eip155:${d.chainId}`);
      expect(settlementNetworkOf("simulated", d.blockchain)).toMatch(/ \(simulated\)$/);
    }
  });
});

describe("the EVM receipt reader (live mode's JSON-RPC, against canned answers)", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const TO = "0x5f2b3c4d5e6f708192a3b4c5d6e7f8091a2b554f";
  const receipt = (o: { status?: string; block?: number; logs?: unknown[] } = {}) => ({
    transactionHash: HASH,
    blockNumber: `0x${(o.block ?? 100).toString(16)}`,
    status: o.status ?? "0x1",
    logs: o.logs ?? [{ address: BASE_USDC_CONTRACT.toUpperCase().replace("0X", "0x"), topics: [TRANSFER, word("0x01"), word(TO)], data: word((5_000_000).toString(16)), removed: false }],
  });
  const serve = (answer: (method: string, params: unknown[]) => unknown, seen: string[] = []) =>
    (async (url: string, init?: { body?: string }) => {
      seen.push(url);
      const b = JSON.parse(init!.body!) as { id: unknown; method: string; params: unknown[] };
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: b.id, result: answer(b.method, b.params) }) };
    }) as never;

  it("reads the ERC-20 Transfers of a successful receipt with enough confirmations", async () => {
    const seen: string[] = [];
    const rpc = new EvmRpc({ base: "https://base.rpc.test" }, { fetch: serve((m) => (m === "eth_blockNumber" ? "0x64" : receipt()), seen) });
    expect(await rpc.delivery("base", HASH)).toEqual({ status: "final", hash: HASH, success: true, transfers: [{ token: BASE_USDC_CONTRACT, from: "0x0000000000000000000000000000000000000001", to: TO, amount: 5_000_000n }] });
    expect(seen.every((u) => u === "https://base.rpc.test")).toBe(true);
  });

  it("waits for confirmations, treats a missing receipt as unknown, a reverted one as paying nothing, and drops removed logs", async () => {
    const eth = new EvmRpc({ eth: "https://eth.rpc.test" }, { fetch: serve((m) => (m === "eth_blockNumber" ? "0x65" : receipt())) });
    expect((await eth.delivery("eth", HASH)).status).toBe("pending");
    const none = new EvmRpc({ base: "https://base.rpc.test" }, { fetch: serve((m) => (m === "eth_blockNumber" ? "0x64" : null)) });
    expect(await none.delivery("base", HASH)).toEqual({ status: "unknown" });
    const reverted = new EvmRpc({ base: "https://base.rpc.test" }, { fetch: serve((m) => (m === "eth_blockNumber" ? "0x64" : receipt({ status: "0x0" }))) });
    expect(await reverted.delivery("base", HASH)).toMatchObject({ status: "final", success: false, transfers: [] });
    const removed = new EvmRpc({ base: "https://base.rpc.test" }, { fetch: serve((m) => (m === "eth_blockNumber" ? "0x64" : receipt({ logs: [{ ...receipt().logs[0] as object, removed: true }, { address: BASE_USDC_CONTRACT, topics: ["0x00"], data: "0x" }] }))) });
    expect(await removed.delivery("base", HASH)).toMatchObject({ status: "final", transfers: [] });
  });

  it("refuses a chain with no RPC and gives up on a hung call within its timeout", async () => {
    const off = new EvmRpc({ base: null });
    expect(off.canRead("base")).toBe(false);
    await expect(off.delivery("base", HASH)).rejects.toThrow(/no RPC/);
    const hung = new EvmRpc({ base: "https://base.rpc.test" }, { timeoutMs: 50, fetch: (() => new Promise(() => {})) as never });
    await expect(hung.delivery("base", HASH)).rejects.toThrow(/did not answer within 50 ms/);
  });
});

describe("INTENTS_RPC_* configuration", () => {
  const base = {
    HUB_ACCOUNT: "hub.payminto.testnet",
    OPERATOR_ACCOUNT: "node.payminto.testnet",
    OPERATOR_KEY: "ed25519:LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ",
    NODE_SIGNING_SEED: "22".repeat(32),
    ADMIN_TOKEN: "a".repeat(32),
  };
  const live = { ...base, GATEWAY_ENABLED: "true", INTENTS_CHECKOUT: "live", PUBLIC_CHECKOUT_URL: "http://localhost:3210", PUBLIC_DASHBOARD_URL: "http://localhost:3210" };
  const sim = { ...base, GATEWAY_ENABLED: "true", PASSWORD_HASH_COST: "14", ADMIN_TOKEN: "dev-admin-token", INTENTS_CHECKOUT: "simulated", ONECLICK_BASE_URL: "http://127.0.0.1:9", ONECLICK_MANAGER_PUBLIC_KEY: FAKE_ONECLICK_MANAGER_PUBLIC_KEY, NEAR_MAINNET_RPC_URL: "http://127.0.0.1:3030", INTENTS_USDC_CONTRACT: "usdc.sandbox" };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return "";
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as Error).message;
    }
  };

  it("live mode reads each chain from its public RPC by default, or the operator's https RPC, or not at all", () => {
    expect(loadConfig(live).gateway!.intents!.evmRpcUrls).toEqual({
      base: "https://mainnet.base.org",
      arb: "https://arb1.arbitrum.io/rpc",
      eth: "https://ethereum-rpc.publicnode.com",
      pol: "https://polygon-bor-rpc.publicnode.com",
      op: "https://mainnet.optimism.io",
    });
    expect(loadConfig({ ...live, INTENTS_RPC_BASE: "https://base.example.com/key", INTENTS_RPC_OP: "off" }).gateway!.intents!.evmRpcUrls).toMatchObject({ base: "https://base.example.com/key", op: null });
    expect(problems({ ...live, INTENTS_RPC_ARB: "http://arb.example.com" })).toMatch(/INTENTS_RPC_ARB: must be https in live mode/);
  });

  it("simulated mode reads only the fake server's simulated chains", () => {
    expect(loadConfig(sim).gateway!.intents!.evmRpcUrls).toBeUndefined();
    expect(problems({ ...sim, INTENTS_RPC_ETH: "https://ethereum-rpc.publicnode.com" })).toMatch(/INTENTS_RPC_ETH: only for INTENTS_CHECKOUT=live/);
  });
});
