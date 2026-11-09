/**
 * The AI agents act on the full local stack, with the scripted OpenAI-compatible model standing in for a provider:
 * the business's AI connection, an ops agent run in the node's worker, the real payminto-agent runtime as the AI buyer
 * (its own process, with the wallet MCP server), the paid skill run, settlement and an on-chain receipt proof.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { checkAi, runAiAct, type AiResult } from "../src/ai.ts";
import { portIsFree } from "../src/chain.ts";
import { ANVIL_KEYS, DemoConfigError, LIVE_PRICES, loadDemoConfig, LOCAL_PRICES, planFor, plannedSpend } from "../src/config.ts";
import { runGatewayAct } from "../src/gateway.ts";
import { runTraffic, settle } from "../src/scenario.ts";
import { startStack, type Stack } from "../src/stack.ts";
import { SCRIPTED_MODEL, startScriptedModel } from "../scripts/scripted-model.ts";

const SECRET = "sk-test-demo-ai-0123456789SECRET";

async function freeBlock(): Promise<number> {
  for (;;) {
    const base = 20_000 + Math.floor(Math.random() * 30_000);
    const ok = await Promise.all([0, 1, 2, 3].map((i) => portIsFree(base + i, "127.0.0.1")));
    if (ok.every(Boolean)) return base;
  }
}

describe("AI act configuration", () => {
  it("is off unless DEMO_AI=1", () => {
    expect(loadDemoConfig({}).ai).toBeNull();
  });

  it("needs the provider's key, and never puts it in a problem message", () => {
    expect(() => loadDemoConfig({ DEMO_AI: "1" })).toThrow(/OPENAI_API_KEY: required/);
    const cfg = loadDemoConfig({ DEMO_AI: "1", OPENAI_API_KEY: SECRET });
    expect(cfg.ai).toMatchObject({ provider: "openai", model: "gpt-5-mini", keyHint: "CRET", skillPrice: LOCAL_PRICES.writer, buyerCeiling: 2n * LOCAL_PRICES.writer });
  });

  it("lets a local OpenAI-compatible server run without a key", () => {
    const cfg = loadDemoConfig({ DEMO_AI: "1", DEMO_AI_PROVIDER: "openai_compatible", DEMO_AI_BASE_URL: "http://127.0.0.1:11434/v1", DEMO_AI_MODEL: "llama" });
    expect(cfg.ai).toMatchObject({ apiKey: null, localModel: true });
    expect(() => loadDemoConfig({ DEMO_AI: "1", DEMO_AI_PROVIDER: "openai_compatible", DEMO_AI_BASE_URL: "https://openrouter.ai/api/v1", DEMO_AI_MODEL: "x" })).toThrow(/DEMO_AI_API_KEY/);
  });

  it("counts the AI buyer's ceiling in the planned spend", () => {
    const plan = planFor(100);
    expect(plannedSpend(plan, LIVE_PRICES, 5_000n).total - plannedSpend(plan, LIVE_PRICES).total).toBe(5_000n);
    const cfg = loadDemoConfig({ DEMO_AI: "1", OPENAI_API_KEY: SECRET, DEMO_CALLS: "100" });
    expect(cfg.spend.total).toBe(plannedSpend(cfg.plan, cfg.prices, cfg.ai!.buyerCeiling).total + cfg.spend.gateway);
  });

  it("on a live network needs the seller's payout and a public checkout origin, and refuses a demo key's wallet", () => {
    const k = (i: number) => `0x${String(i).padStart(64, "a")}`;
    const live = {
      DEMO_CHAIN_ID: "11155111",
      DEMO_LIVE_NETWORK_CONFIRM: "yes",
      DEMO_ADMIN_TOKEN: "a-long-enough-admin-token",
      DEMO_OPERATOR_KEY: k(1),
      DEMO_OWNER_KEY: k(2),
      DEMO_TREASURY_KEY: k(3),
      DEMO_TRADING_KEY: k(4),
      DEMO_WRITER_KEY: k(5),
      DEMO_MARKET_PAYEE: privateKeyToAccount(ANVIL_KEYS[5]).address,
      DEMO_RISK_PAYEE: privateKeyToAccount(ANVIL_KEYS[6]).address,
      DEMO_AI: "1",
      OPENAI_API_KEY: SECRET,
    };
    const problems = (env: Record<string, string>) => {
      try {
        loadDemoConfig(env, { deploymentsDir: tmpdir() });
        return "";
      } catch (e) {
        expect(e).toBeInstanceOf(DemoConfigError);
        return (e as Error).message;
      }
    };
    const missing = problems(live);
    expect(missing).toMatch(/DEMO_MERCHANT_PAYOUT: required/);
    expect(missing).toMatch(/DEMO_PUBLIC_CHECKOUT_URL: required/);
    expect(missing).not.toContain(SECRET);
    const own = problems({ ...live, DEMO_MERCHANT_PAYOUT: privateKeyToAccount(k(3) as `0x${string}`).address, DEMO_PUBLIC_CHECKOUT_URL: "https://pay.example.com" });
    expect(own).toMatch(/DEMO_MERCHANT_PAYOUT: must be a wallet of its own/);
  });

  it("runs on Replicate with REPLICATE_API_TOKEN and DeepSeek V3.1 by default, no base URL", () => {
    const cfg = loadDemoConfig({ DEMO_AI: "1", DEMO_AI_PROVIDER: "replicate", REPLICATE_API_TOKEN: SECRET });
    expect(cfg.ai).toMatchObject({ provider: "replicate", model: "deepseek-ai/deepseek-v3.1", apiKey: SECRET, baseUrl: null });
    expect(() => loadDemoConfig({ DEMO_AI: "1", DEMO_AI_PROVIDER: "replicate" })).toThrow(/REPLICATE_API_TOKEN: required/);
  });
});

describe("AI agents act (local stack, scripted model)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "payminto-demo-ai-"));
  let model: Awaited<ReturnType<typeof startScriptedModel>>;
  let stack: Stack;
  let ai: AiResult;

  beforeAll(async () => {
    model = await startScriptedModel();
    const cfg = loadDemoConfig({
      DEMO_CALLS: "20",
      DEMO_CONCURRENCY: "4",
      DEMO_NODE_PORT: "0",
      DEMO_PROVIDER_BASE_PORT: String(await freeBlock()),
      DEMO_OFFLINE: "1",
      DEMO_DATA_DIR: dataDir,
      DEMO_HSP_COSIGN_TIMEOUT_SEC: "10",
      DEMO_AI: "1",
      DEMO_AI_PROVIDER: "openai_compatible",
      DEMO_AI_BASE_URL: model.baseUrl,
      DEMO_AI_MODEL: SCRIPTED_MODEL,
      DEMO_AI_API_KEY: SECRET,
    });
    stack = await startStack(cfg);
    await runTraffic(stack);
    await settle(stack);
    const gateway = await runGatewayAct(stack);
    ai = await runAiAct(stack, { opsMerchantId: gateway.merchant.id });
  }, 300_000);

  afterAll(async () => {
    await stack?.stop();
    await model?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("passes every AI act check", () => {
    expect(checkAi(ai)).toEqual([]);
  });

  it("gave each business its own verified connection, and the key never left the node", () => {
    expect(ai.connections.map((x) => x.merchant).sort()).toEqual(["Northwind Data", "Payminto Demo"]);
    for (const x of ai.connections) expect(x).toMatchObject({ status: "active", verified: true, keyHint: "CRET" });
    expect(JSON.stringify(ai, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(SECRET);
    expect(readFileSync(ai.buyer.log, "utf8")).not.toContain(SECRET);
    expect(readFileSync(stack.logFile, "utf8")).not.toContain(SECRET);
  });

  it("ran the ops agent on the business with payments, through the merchant tools", () => {
    expect(ai.ops).toMatchObject({ merchant: "Northwind Data", status: "succeeded" });
    expect(ai.ops.toolCalls.map((t) => t.name)).toEqual(["get_overview", "list_payments"]);
  });

  it("had the AI buyer buy a live quote, then pay the skill once with it, and the skill run answered it", () => {
    expect(ai.buyer.toolCalls.map((t) => t.name)).toEqual(["list_paid_services", "call_paid_service", "call_paid_service"]);
    expect(ai.buyer.receipts.map((r) => r.amount)).toEqual([LOCAL_PRICES.market, LOCAL_PRICES.writer]);
    expect(ai.skill.run?.answer).toMatch(/HSK market brief/);
    // The model requests carried the key only in the provider's auth header.
    const turns = model.requests.filter((r) => r.path.endsWith("/chat/completions"));
    expect(turns.length).toBeGreaterThanOrEqual(6);
    expect(turns.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
  });

  it("settled the skill call and proved its receipt on chain", () => {
    expect(ai.skillCall?.status).toBe("settled");
    expect(ai.proof?.verifiedOnchain).toBe(true);
  });
});
