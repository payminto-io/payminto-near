/**
 * The same end-to-end flow with the real model on both sides (buyer and seller). Runs only when ANTHROPIC_API_KEY is
 * set; it spends a few cents of API usage and nothing else (the chain is a local anvil). Skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settle } from "@payminto/demo";
import { runBuyerTask } from "../src/agents.ts";
import { modelFromEnv, walletServerSpec } from "../src/config.ts";
import { connectMcp } from "../src/mcp.ts";
import type { RunResult } from "../src/runtime.ts";
import { cosigner, SELLER_PRICE, startAgentStack, type AgentStack } from "./agent-stack.ts";

const live = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

describe.skipIf(!live)("live: Claude buys a market brief from the Claude seller", () => {
  let s: AgentStack;
  let run: RunResult;

  beforeAll(async () => {
    s = await startAgentStack({ sellerModel: modelFromEnv(process.env, { effort: "low" }) });
    run = await runBuyerTask({
      task: "Buy one HashKey Market Brief covering HSK and ETH, with a risk read on wallet 0x1111111111111111111111111111111111111111, and summarise it for me in three sentences.",
      env: { ...s.buyerEnv, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, PAYMINTO_AGENT_MODEL: process.env.PAYMINTO_AGENT_MODEL },
      stderr: "pipe",
      limits: { maxSpendAtomic: 100_000n, maxTurns: 10 },
    });
  }, 600_000);

  afterAll(async () => {
    await s?.stop();
  });

  it("completes, pays the seller once, and the seller's purchases settle and prove", async () => {
    expect(run.status, run.note ?? "").toBe("completed");
    expect(run.answer.length).toBeGreaterThan(40);
    const toSeller = run.spend!.receipts.filter((r) => r.payee === s.seller.address);
    expect(toSeller.length).toBeGreaterThanOrEqual(1);
    expect(BigInt(run.spend!.spentAtomic)).toBeLessThanOrEqual(100_000n);
    expect(BigInt(toSeller[0]!.amountAtomic)).toBe(SELLER_PRICE);
    expect(s.seller.client.receipts.all().length).toBeGreaterThanOrEqual(2);

    const c = cosigner(s, "buyer");
    try {
      expect((await settle(s.stack)).batchIds.length).toBeGreaterThanOrEqual(1);
    } finally {
      c.close();
    }
    const wallet = await connectMcp([walletServerSpec(s.buyerEnv)], { stderr: "pipe" });
    try {
      const p = await wallet.call("prove_receipt", { callId: toSeller[0]!.callId });
      expect(p.text).toMatch(/verifyReceipt\): true/);
    } finally {
      await wallet.close();
    }
  }, 300_000);
});
