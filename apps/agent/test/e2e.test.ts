/**
 * End to end on the local stack with stand-in models: the buyer agent (real wallet MCP server over stdio) discovers
 * the seller agent in the node directory and pays it; the seller pays Market Data and Risk Scan with its own mandate
 * and returns its brief and receipts; one settlement nets it all; both agents' receipts prove on chain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settle } from "@payminto/demo";
import type { AgentClient } from "@payminto/sdk";
import { runBuyerTask } from "../src/agents.ts";
import { walletServerSpec } from "../src/config.ts";
import { connectMcp } from "../src/mcp.ts";
import type { RunResult } from "../src/runtime.ts";
import { lastToolResults, messageText, scriptedModel, toolJson } from "../src/scripted.ts";
import { cosigner, SELLER_PRICE, startAgentStack, type AgentStack } from "./agent-stack.ts";

const WALLET = "0x1111111111111111111111111111111111111111";

type BriefResponse = { brief: string; writtenBy: { model: string | null }; purchases: Array<{ callId: string; service: string; payee: string; amountAtomic: string }>; missing: string[] };

let s: AgentStack;
let run: RunResult;
let brief: BriefResponse;
let sellerPrompt = "";
const listed: Array<{ name: string; allowedByMandate: boolean | null }> = [];

beforeAll(async () => {
  const sellerModel = scriptedModel([
    (req) => {
      sellerPrompt = messageText(req, 0);
      return { text: "HashKey market brief: HSK and ETH quotes and a wallet risk read, written from purchased data." };
    },
  ]);
  s = await startAgentStack({ sellerModel });
  const buyerModel = scriptedModel([
    { toolUses: [{ name: "list_paid_services", input: {} }] },
    (req) => {
      const dir = toolJson<Array<{ id: string; name: string; allowedByMandate: boolean | null }>>(lastToolResults(req)[0]!.text)!;
      listed.push(...dir);
      const seller = dir.find((d) => d.name === "HashKey Market Brief")!;
      return { toolUses: [{ name: "call_paid_service", input: { serviceId: seller.id, body: { symbols: ["HSK", "ETH"], address: WALLET } } }] };
    },
    (req) => {
      const r = lastToolResults(req)[0]!;
      brief = toolJson<{ response: BriefResponse }>(r.text)!.response;
      return { text: `Brief bought from the HashKey Market Brief seller: ${brief.brief}` };
    },
  ]);
  run = await runBuyerTask({ task: `Get me a HashKey market brief on HSK and ETH with a risk read on wallet ${WALLET}.`, env: s.buyerEnv, model: buyerModel, stderr: "pipe", limits: { maxSpendAtomic: 100_000n } });
}, 180_000);

afterAll(async () => {
  await s?.stop();
});

describe("buyer agent pays the seller agent, which pays its suppliers", () => {
  it("finds the seller in the node directory, allowed by its mandate", () => {
    expect(listed.find((d) => d.name === "HashKey Market Brief")).toMatchObject({ allowedByMandate: true });
    expect(listed.find((d) => d.name === "Market Data")).toMatchObject({ allowedByMandate: false });
  });

  it("completes with one receipt to the seller and a spend report from the wallet", () => {
    expect(run.status).toBe("completed");
    expect(run.answer).toMatch(/^Brief bought from the HashKey Market Brief seller/);
    expect(run.spend).toMatchObject({ spentAtomic: SELLER_PRICE.toString(), spent: "0.03 USDC", ceilingAtomic: "100000", budgetLeftAtomic: (2_000_000n - SELLER_PRICE).toString(), refusals: [] });
    expect(run.spend!.receipts).toHaveLength(1);
    expect(run.spend!.receipts[0]).toMatchObject({ tool: "call_paid_service", payee: s.seller.address, amountAtomic: SELLER_PRICE.toString() });
  });

  it("the seller bought two quotes and a risk scan with its own mandate and wrote the brief with its model", () => {
    expect(brief.missing).toEqual([]);
    expect(brief.writtenBy.model).toBe("scripted-stand-in");
    expect(brief.purchases.map((p) => p.service).sort()).toEqual(["quote ETH", "quote HSK", "risk scan"]);
    expect(brief.purchases.map((p) => p.payee).sort()).toEqual([s.stack.addresses.market, s.stack.addresses.market, s.stack.addresses.risk].sort());
    expect(sellerPrompt).toMatch(/<purchased_data>/);
    expect(sellerPrompt).toMatch(/"symbol": "HSK"/);
    expect(s.seller.client.receipts.all().length).toBe(3);
  });

  it("settles in one netted batch and both agents' receipts prove on chain", async () => {
    const buyerCosigner: AgentClient = cosigner(s, "buyer");
    try {
      const out = await settle(s.stack);
      expect(out.skipped).toBeUndefined();
      expect(out.batchIds.length).toBeGreaterThanOrEqual(1);
    } finally {
      buyerCosigner.close();
    }
    for (const [env, callIds] of [
      [s.buyerEnv, run.spend!.receipts.map((r) => r.callId)],
      [s.sellerEnv, brief.purchases.map((p) => p.callId)],
    ] as const) {
      const wallet = await connectMcp([walletServerSpec(env)], { stderr: "pipe" });
      try {
        for (const callId of callIds) {
          const p = await wallet.call("prove_receipt", { callId });
          expect(p.isError).toBe(false);
          expect(p.text).toMatch(/Proven on chain \(settled by the clearing node, node-signed, verifyReceipt\): true/);
        }
      } finally {
        await wallet.close();
      }
    }
  }, 120_000);
});
