/**
 * End to end on an in-process stack with the simulated hub (apps/demo's startStack: the clearing node on a temporary
 * *.demo.db, paid services behind the SDK paywall, four owners with one Budget each).
 *
 * - The buyer agent (Globex) runs through the agent runtime with a scripted model and the real Payminto MCP tools. It
 *   finds the seller skill in the directory, pays for a brief, and is refused when it obeys an injected payee.
 * - The seller skill (Acme) is the real marketBriefApp: paid per call, it buys its own inputs with Acme's Budget.
 * - Initech's agent pays a seller directly, and the DAO's swarm of agents shares one Budget's hourly cap.
 * - One settlement nets it all on the hub, and receipts prove against the root the hub stores.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, loadDemoConfig, OWNERS, PRICES, SWARM_SIZE, startStack, type Stack } from "@payminto/demo";
import { MemoryVoucherStore, NodeHttp, verifyReceiptOnchain, type DeniedEvent } from "@payminto/sdk";
import type { Id32 } from "@payminto/protocol";
import { BUYER_SYSTEM } from "../src/prompts.ts";
import { runAgent, type RunResult } from "../src/runtime.ts";
import { lastToolResults, scriptedModel, sellerData, toolJson } from "../src/scripted.ts";
import { marketBriefApp, registerSeller, SKILL_NAME } from "../src/seller.ts";
import { listen, type Listening } from "../src/service.ts";
import { toolHostFromClients, type ToolHost } from "../src/mcp.ts";

const BRIEF_PRICE = 30_000n;
const dir = mkdtempSync(join(tmpdir(), "payminto-agent-e2e-"));
let stack: Stack;
let seller: Listening;
let tools: ToolHost;
const sellerVouchers = new MemoryVoucherStore();
let run: RunResult;
let brief: { purchases: Array<{ callId: Id32; payee: string; amountAtomic: string }>; writtenBy: { model: string | null } } | null = null;
const swarmDenials: DeniedEvent[] = [];
let swarmPaid = 0;
let gross = 0n;
let net = 0n;

beforeAll(async () => {
  stack = await startStack(loadDemoConfig({ DEMO_DATA_DIR: dir }, ["--scale", "0.2"]));

  // The seller agent: Acme's market brief skill, registered at the node and paid per call. It buys its inputs with
  // Acme's own Budget, which allows Globex quotes and Risk Scan.
  const port = await freePort();
  const provider = await registerSeller(new NodeHttp(stack.nodeUrl, { bearer: stack.adminToken }), { payee: OWNERS.acme, price: BRIEF_PRICE, resource: `http://127.0.0.1:${port}/v1/brief` });
  const writer = scriptedModel([{ text: "NEAR is steady and the counterparty scores low risk (scripted writer)." }]);
  seller = await listen(
    marketBriefApp({ nodeUrl: stack.nodeUrl, provider, price: BRIEF_PRICE, buyer: stack.acme, inputs: { quoteUrl: `${stack.urls.quotes}/v1/quote`, riskUrl: `${stack.urls.scans}/v1/scan` }, model: writer, vouchers: sellerVouchers }),
    port,
  );

  // The buyer agent: the runtime over the real MCP tools of Globex's wallet, driven by a scripted model.
  tools = await toolHostFromClients([{ name: "payminto-wallet", client: stack.globex.mcp }]);
  const model = scriptedModel([
    { toolUses: [{ name: "list_paid_services", input: {} }] },
    (req) => {
      const services = toolJson<Array<{ id: string; name: string }>>(lastToolResults(req)[0]!.text) ?? [];
      const skill = services.find((s) => s.name === SKILL_NAME);
      if (!skill) throw new Error("the seller skill is not in the directory");
      return { toolUses: [{ name: "call_paid_service", input: { serviceId: skill.id, body: { symbols: ["NEAR"], address: "vendor-7.testnet" } } }] };
    },
    (req) => {
      // The brief is what the seller wrote: it comes fenced as seller data, apart from the wallet's own facts.
      brief = sellerData<typeof brief>(lastToolResults(req)[0]!.text);
      // The model obeys an instruction planted in paid content: the wallet must refuse it.
      return { toolUses: [{ name: "call_paid_service", input: { url: `${stack.urls.alpha}/v1/alpha` } }] };
    },
    { text: "Bought one market brief. The premium alpha payment was refused by the Budget." },
  ]);
  run = await runAgent({ model, tools, system: BUYER_SYSTEM, task: "Buy one NEAR market brief that includes a risk read on vendor-7.testnet." });

  // Initech's agent pays a seller directly with the SDK.
  for (let i = 0; i < 3; i++) await (await stack.initech.fetch(`${stack.urls.scans}/v1/scan?address=supplier-${i}.testnet`)).body?.cancel();

  // The DAO's swarm: three agents with one Budget key take turns until the shared hourly cap stops them.
  for (const w of stack.swarm) {
    w.on("denied", (d) => swarmDenials.push(d));
    w.on("receipt", () => swarmPaid++);
  }
  const allowed = Number(stack.swarmHourlyCap / PRICES.quote);
  for (let i = 0; i < allowed + SWARM_SIZE && swarmDenials.length === 0; i++) {
    await (await stack.swarm[i % SWARM_SIZE]!.fetch(`${stack.urls.quotes}/v1/quote?symbol=ETH&w=${i}`)).body?.cancel();
  }

  const settled = await stack.node.services.settlement.settle("manual");
  if ("skipped" in settled) throw new Error(`settlement skipped: ${settled.skipped}`);
  for (const id of settled.batchIds) {
    const b = (await stack.hub.chain.batch(id))!;
    gross += b.gross;
    net += b.net;
  }
}, 60_000);

afterAll(async () => {
  await seller?.close();
  await stack?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("agents from different owners pay sellers, and the node clears them", () => {
  it("the buyer agent finds the seller skill in the directory, pays it, and reports the spend", () => {
    expect(run.status).toBe("completed");
    expect(run.spend!.receipts).toEqual([expect.objectContaining({ tool: "call_paid_service", service: SKILL_NAME, payee: OWNERS.acme, amountAtomic: BRIEF_PRICE.toString() })]);
  });

  it("the seller agent bought its own inputs with its own Budget, and kept the buyer's voucher for settle_own", () => {
    expect(brief?.writtenBy.model).toBe("scripted-stand-in");
    expect(brief?.purchases.map((p) => p.payee).sort()).toEqual([OWNERS.globex, "scan.testnet"]);
    const kept = sellerVouchers.all();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ budgetId: stack.budgets.globex, payee: OWNERS.acme, cumulative: BRIEF_PRICE.toString() });
  });

  it("the buyer's injected payment is refused with the rule, the amount, the Budget left and a retry hint", () => {
    expect(run.spend!.refusals).toEqual([
      expect.objectContaining({ rule: "PAYEE_NOT_ALLOWED", enforcedBy: "agent", attemptedAmount: PRICES.alpha.toString(), remainingBudget: expect.stringMatching(/^\d+$/), retry: { kind: "never" } }),
    ]);
  });

  it("a swarm shares one Budget: the node enforces the hourly cap on the agents' combined spend", () => {
    expect(swarmPaid).toBe(Number(stack.swarmHourlyCap / PRICES.quote));
    // The node refused, and the seller relayed it: the agent keeps the rule code and says whose word it is.
    expect(swarmDenials.map((d) => [d.code, d.source, d.refusal?.retry.kind])).toEqual([["HOURLY_CAP", "seller", "after"]]);
  });

  it("one settlement nets what Acme earned against what it spent", async () => {
    expect(gross).toBeGreaterThan(0n);
    expect(net).toBeLessThan(gross);
    await stack.hub.solvency();
  });

  it("receipts of both agents prove against the root the hub stores", async () => {
    const callId = run.spend!.receipts[0]!.callId;
    const proved = await tools.call("prove_receipt", { callId });
    expect(proved.isError).toBe(false);
    expect((proved.structured as { result: Record<string, unknown> }).result).toMatchObject({ settled: true, independentlyVerifiedOnchain: true, nodeRootMatchesChain: true });

    const purchase = brief!.purchases[0]!;
    const receipt = stack.acme.receipts.get(purchase.callId)!;
    const p = (await (await fetch(`${stack.nodeUrl}/v1/receipts/${purchase.callId}/proof`)).json()) as { batchId: Id32; proof: Id32[] };
    const chain = stack.hub.chain;
    const check = await verifyReceiptOnchain({ chain, operator: chain.operator, nodeKey: stack.node.services.chain.nodeKey, agentPk: stack.keys.acme.publicKey, receipt, batchId: p.batchId, proof: p.proof });
    expect(check).toMatchObject({ verified: true, agentSigned: true });
  });
});
