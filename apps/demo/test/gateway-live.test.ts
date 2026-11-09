import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, DemoConfigError, GATEWAY_KEY_ENV, gatewaySpend, LIVE_GATEWAY_AMOUNTS, LOCAL_GATEWAY_AMOUNTS, loadDemoConfig } from "../src/config.ts";
import { confirmTimeoutMs } from "../src/scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "payminto-demo-gw-"));
writeFileSync(join(dir, "11155111.json"), JSON.stringify({ clearingHub: "0x53E4B5712fEeD40dd6597F0A50cC14C063186e81", chainId: 11155111, blockNumber: 1 }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Random, never-funded keys: the guard runs before any RPC call, so nothing is broadcast.
const k = (n: number) => `0x${n.toString(16).padStart(64, "b")}`;
const base = {
  DEMO_CHAIN_ID: "11155111",
  DEMO_LIVE_NETWORK_CONFIRM: "yes",
  DEMO_ADMIN_TOKEN: "a-long-enough-admin-token",
  DEMO_OPERATOR_KEY: k(1),
  DEMO_OWNER_KEY: k(2),
  DEMO_TREASURY_KEY: k(3),
  DEMO_TRADING_KEY: k(4),
  DEMO_WRITER_KEY: k(5),
  DEMO_MARKET_PAYEE: "0x00000000000000000000000000000000000000a1",
  DEMO_RISK_PAYEE: "0x00000000000000000000000000000000000000a2",
};
const gatewayKeys = Object.fromEntries(Object.values(GATEWAY_KEY_ENV).map((name, i) => [name, k(20 + i)]));
const load = (env: Record<string, string>) => loadDemoConfig(env, { deploymentsDir: dir });
const problems = (env: Record<string, string>) => {
  try {
    load(env);
    return "";
  } catch (e) {
    expect(e).toBeInstanceOf(DemoConfigError);
    return (e as Error).message;
  }
};

describe("gateway act on a live network", () => {
  it("is off without DEMO_GATEWAY=1, and adds nothing to the planned spend", () => {
    const cfg = load(base);
    expect(cfg.gatewayKeys).toBeNull();
    expect(cfg.spend.gateway).toBe(0n);
  });

  it("needs every role's key and a public checkout origin", () => {
    const msg = problems({ ...base, DEMO_GATEWAY: "1" });
    for (const name of Object.values(GATEWAY_KEY_ENV)) expect(msg).toContain(name);
    expect(msg).toContain("DEMO_PUBLIC_CHECKOUT_URL");
  });

  it("refuses a public dev key and a key shared by two roles", () => {
    const env = { ...base, ...gatewayKeys, DEMO_GATEWAY: "1", DEMO_PUBLIC_CHECKOUT_URL: "https://pay.example.com" };
    expect(problems({ ...env, DEMO_FLAGGED_KEY: ANVIL_KEYS[3] })).toContain("DEMO_FLAGGED_KEY: is a public anvil dev key");
    expect(problems({ ...env, DEMO_HUMAN_PAYER_KEY: k(3) })).toContain("needs a wallet of its own");
  });

  it("uses tiny live amounts, counts them in the planned spend, and the store sells the AI skill", () => {
    const cfg = load({ ...base, ...gatewayKeys, DEMO_GATEWAY: "1", DEMO_PUBLIC_CHECKOUT_URL: "https://pay.example.com", DEMO_CONFIRM_TAG: "latest", DEMO_AI: "1", OPENAI_API_KEY: "sk-test-not-a-real-key-0000" });
    expect(cfg.gatewayAmounts).toEqual(LIVE_GATEWAY_AMOUNTS);
    expect(cfg.spend.gateway).toBe(gatewaySpend(LIVE_GATEWAY_AMOUNTS));
    expect(cfg.spend.total).toBe(cfg.spend.treasury + cfg.spend.trading + cfg.spend.writer + cfg.spend.gateway);
    expect(cfg.confirmTag).toBe("latest");
    expect(cfg.webhookUrl).toBeNull();
    expect(cfg.ai!.merchantPayout).toBe(privateKeyToAccount(gatewayKeys.DEMO_STORE_PAYOUT_KEY as `0x${string}`).address);
    expect(LIVE_GATEWAY_AMOUNTS.link * 100n).toBe(LOCAL_GATEWAY_AMOUNTS.link);
  });

  it("stays inside DEMO_MAX_SPEND_USDC", () => {
    const env = { ...base, ...gatewayKeys, DEMO_GATEWAY: "1", DEMO_PUBLIC_CHECKOUT_URL: "https://pay.example.com", DEMO_MAX_SPEND_USDC: "0.05" };
    expect(problems(env)).toContain("exceeds DEMO_MAX_SPEND_USDC");
  });

  it("waits long enough for the confirm tag", () => {
    expect(confirmTimeoutMs(133, "latest")).toBe(180_000);
    // 300 safe-lag blocks of 2 s each, with margin.
    expect(confirmTimeoutMs(133, null)).toBeGreaterThan(600_000);
    expect(confirmTimeoutMs(11155111, "safe")).toBeGreaterThan(768_000);
  });
});
