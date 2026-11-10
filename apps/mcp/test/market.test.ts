/**
 * `quote_market_agent` in the wallet server: a quote from the NEAR AI Agent Market, checked against the wallet's own
 * limits and the payee check, and never a payment. The market's answers are the package's recorded fixtures (real
 * public answers of the live market, replayed), the clearing node is the real one in process on a FakeChain hub, and
 * no test reaches the network: an unknown route fails the test.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarketClient, type PayeeVerdict } from "@payminto/agent-market";
import type { FakeChain } from "@payminto/chain/fake";
import { refusalSchema, type Id32 } from "@payminto/protocol";
import { MemoryReceiptStore, OwnerClient } from "@payminto/sdk";
import { silentLogger, startNode, type ClearingNode } from "@payminto/node";
import { fakeFetch, fixture } from "../../../packages/agent-market/test/helpers.ts";
import { HUB, OPERATOR, OWNER_A, SELLER, startFakeChain, tempDir, testConfig, testKey, TOKEN } from "../../node/test/helpers.ts";
import { loadMcpConfig } from "../src/config.ts";
import { createMcpServer } from "../src/server.ts";
import { AgentWallet, type WalletOptions } from "../src/wallet.ts";

const ADMIN = "test-admin-token-123";
const AGENT_SEED = new Uint8Array(32).fill(5);
const ENDPOINT = "https://example-research.market.near.ai/a2a/v1";
/** The account the recorded quote pays: the market's treasury on NEAR mainnet. */
const TREASURY = "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc";

const tmp = tempDir("payminto-mcp-market-");
const stops: Array<() => unknown> = [];
let chain: FakeChain;
let node: ClearingNode;
let budgetId: Id32;

type Res = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any> };
const said = (r: Res) => r.content[0]!.text.split("\n\n")[0]!;
const recorded = () => fakeFetch({ [`POST ${ENDPOINT}`]: fixture("quote-402.live.json"), "POST https://example-analyst.market.near.ai/a2a/v1": fixture("quote-unavailable.live.json") });

async function open(o: { perCallCap?: string; market?: WalletOptions["market"] | null; maxPrice?: bigint } = {}) {
  const owner = new OwnerClient({ nodeUrl: node.url, network: chain.network, hub: HUB, token: TOKEN, owner: OWNER_A, settler: OPERATOR, adminToken: ADMIN });
  const policy = { perCallCap: o.perCallCap ?? "1000000", dailyCap: "5000000", maxCallsPerMinute: 1000, purpose: "mcp market tests" };
  const m = owner.createBudget({ agentPk: testKey(5).publicKey, cap: 10_000_000n, validForSeconds: 3600, payees: [SELLER], policy });
  chain.openBudget(OWNER_A, m.terms);
  chain.depositBudget(OWNER_A, m.budgetId, 5_000_000n);
  await owner.submit({ terms: m.terms, policy, label: "MCP market agent" });
  budgetId = m.budgetId;
  const market = o.market === null ? undefined : (o.market ?? { client: new MarketClient({ fetch: recorded().fetch }) });
  const wallet = await AgentWallet.connect({ nodeUrl: node.url, agentKey: AGENT_SEED, budgetId, chain, receipts: new MemoryReceiptStore(), signWithoutPayeeCheck: true, ...(market ? { market } : {}), ...(o.maxPrice !== undefined ? { maxPrice: o.maxPrice } : {}) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createMcpServer(wallet).connect(st);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(ct);
  stops.push(() => client.close(), () => wallet.close());
  return { wallet, client, call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res };
}

beforeAll(async () => {
  chain = startFakeChain();
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, workers: false, port: 0 });
});

afterAll(async () => {
  for (const s of stops.reverse()) await s();
  await node.stop();
  tmp.cleanup();
});

describe("quote_market_agent", () => {
  it("is registered next to the wallet's tools, reads only, and nothing in the server pays the market", async () => {
    const { client } = await open();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "quote_market_agent")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.description).toMatch(/This tool cannot pay/);
    expect(tool.description).toMatch(/The limits are this wallet's own: the Budget's per-call cap and what is left of its rolling 24 hours\./);
    expect(tools.map((t) => t.name).filter((n) => /hire|market/.test(n))).toEqual(["quote_market_agent"]);
    expect(client.getInstructions()).toMatch(/no tool here pays it/);
  });

  it("allows a quote inside the Budget's per-call cap, and says who pays a hire", async () => {
    const { call } = await open({ perCallCap: "1000000" });
    const r = await call("quote_market_agent", { handle: "example-research" });
    expect(r.isError).toBeFalsy();
    expect(said(r)).toBe(
      "ALLOW: example-research quotes 0.25 USDC, within the per-hire maximum of 1.00 USDC. Nothing was signed or paid. A hire on the Agent Market is paid through the market itself; Payminto only checks the quote against the owner's policy. " +
        "This wallet has no tool that pays the market: paying a market hire is a separate step that a person confirms on the market itself.",
    );
    expect(r.structuredContent!.result).toMatchObject({ handle: "example-research", decision: "allow", price: { atomic: "250000", display: "0.25 USDC", network: "near:mainnet", payTo: TREASURY }, maxPerHire: { atomic: "1000000" }, refusal: null });
  });

  it("takes the per-hire maximum from the wallet: a lower per-call cap, or the operator's lower maximum, refuses the same quote", async () => {
    for (const o of [{ perCallCap: "100000" }, { perCallCap: "1000000", maxPrice: 100_000n }]) {
      const { call } = await open(o);
      const r = await call("quote_market_agent", { handle: "example-research" });
      expect(r.isError).toBe(true);
      expect(said(r)).toMatch(/^Hire refused by wallet rule PER_HIRE_MAX: The quoted price exceeds the per-hire maximum \(refused by this wallet before signing\)\./);
      expect(said(r)).toMatch(/Retry: do not retry: waiting will not change this\. Nothing was signed, so nothing was paid\. This is the owner's policy; do not route around it\.$/);
      // The same refusal shape as the wallet's other refusals, and one the protocol's schema reads.
      const refusal = r.structuredContent!.refusal;
      expect(refusal).toMatchObject({ rule: "PER_HIRE_MAX", enforcedBy: "agent", authenticated: true, attemptedAmount: "250000", retry: { kind: "never" }, handle: "example-research", limit: "100000" });
      expect(refusalSchema.safeParse(refusal).success).toBe(true);
      expect(r.structuredContent!.spend).toMatchObject({ status: "none", countedAtomic: "0" });
    }
  });

  it("lets the model tighten the maximum for one check, never raise it", async () => {
    const { call } = await open({ perCallCap: "1000000" });
    expect((await call("quote_market_agent", { handle: "example-research", max_usdc: "0.10" })).structuredContent!.refusal).toMatchObject({ rule: "PER_HIRE_MAX", limit: "100000" });
    const tight = await open({ perCallCap: "100000" });
    expect((await tight.call("quote_market_agent", { handle: "example-research", max_usdc: "5" })).structuredContent!.refusal).toMatchObject({ rule: "PER_HIRE_MAX", limit: "100000" });
  });

  it("asks the payee check about the account the quote pays, and refuses a blocked one", async () => {
    const asked: string[] = [];
    const verdict = (v: PayeeVerdict["verdict"]) => ({ account, network }: { account: string; network: string }) => {
      asked.push(`${network} ${account}`);
      return { verdict: v, payee: account, signals: v === "allow" ? [] : [{ id: "reported_by_several", severity: "block", reason: "3 distinct reporters filed a report against this account." }] };
    };
    const blocked = await open({ market: { client: new MarketClient({ fetch: recorded().fetch }), payeeVerdict: verdict("block") } });
    const r = await blocked.call("quote_market_agent", { handle: "example-research" });
    expect(r.isError).toBe(true);
    expect(said(r)).toMatch(/^Hire refused by wallet rule PAYEE_BLOCKED: The payee check blocked the account the quote pays \(refused by this wallet before signing\)\./);
    expect(asked).toEqual([`near:mainnet ${TREASURY}`]);
    const fine = await open({ market: { client: new MarketClient({ fetch: recorded().fetch }), payeeVerdict: verdict("allow") } });
    expect((await fine.call("quote_market_agent", { handle: "example-research" })).isError).toBeFalsy();
  });

  it("counts what the wallet already spent today against the rolling 24 hours", async () => {
    const { wallet } = await open();
    expect(await wallet.hireLimits()).toEqual({ maxPerHire: 1_000_000n, maxPerDay: 5_000_000n });
    wallet.history.push({ at: new Date().toISOString(), service: "x", url: "http://127.0.0.1/x", price: "4900000", receipt: { amount: "4900000" } as never });
    expect(await wallet.hireLimits()).toEqual({ maxPerHire: 1_000_000n, maxPerDay: 100_000n });
  });

  it("says what to do when the agent cannot be quoted, and that nothing was paid", async () => {
    const { call } = await open();
    const r = await call("quote_market_agent", { handle: "example-analyst" });
    expect(r.isError).toBe(true);
    expect(said(r)).toMatch(/^No quote \([A-Z_]+\): /);
    expect(said(r)).toMatch(/Nothing was signed, so nothing was paid\.$/);
    expect(r.structuredContent!.error.nextStep.length).toBeGreaterThan(10);
  });

  it("is absent when the wallet has no market wiring", async () => {
    const { client } = await open({ market: null });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("quote_market_agent");
  });
});

describe("configuration", () => {
  const base = { NODE_URL: "http://localhost:8787", BUDGET_ID: "ab".repeat(32), AGENT_KEY: "05".repeat(32), PAYMINTO_DATA_DIR: tmp.dir };

  it("is on by default with the mainnet payee check, and off with AGENT_MARKET=off", () => {
    expect(loadMcpConfig(base).market).toEqual({ rpcUrl: null, payeeCheck: { indexer: "nearblocks", indexerKey: null } });
    expect(loadMcpConfig({ ...base, NETWORK: "near:sandbox" }).market).toEqual({ rpcUrl: null, payeeCheck: { indexer: "nearblocks", indexerKey: null } });
    expect(loadMcpConfig({ ...base, PAYEE_CHECK: "off" }).market).toEqual({ rpcUrl: null, payeeCheck: null });
    expect(loadMcpConfig({ ...base, AGENT_MARKET: "off" }).market).toBeNull();
    expect(loadMcpConfig({ ...base, AGENT_MARKET_RPC_URL: "https://rpc.example.org" }).market).toMatchObject({ rpcUrl: "https://rpc.example.org" });
  });
});
