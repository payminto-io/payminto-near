import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ANVIL_KEYS, DemoConfigError, loadDemoConfig, LIVE_PRICES, planFor, plannedCalls, plannedSpend } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "payminto-demo-cfg-"));
writeFileSync(join(dir, "177.json"), JSON.stringify({ clearingHub: "0x5FbDB2315678afecb367f032d93F642f64180aa3", chainId: 177, blockNumber: 1 }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Random, never-funded keys: the guard is evaluated before any RPC call, so nothing is broadcast.
const k = (n: number) => `0x${n.toString(16).padStart(64, "a")}`;
const liveEnv = {
  DEMO_CHAIN_ID: "177",
  DEMO_OPERATOR_KEY: k(1),
  DEMO_OWNER_KEY: k(2),
  DEMO_TREASURY_KEY: k(3),
  DEMO_TRADING_KEY: k(4),
  DEMO_WRITER_KEY: k(5),
  DEMO_MARKET_PAYEE: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  DEMO_RISK_PAYEE: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  DEMO_ADMIN_TOKEN: "a-long-random-admin-token",
};
const problems = (env: Record<string, string>) => {
  try {
    loadDemoConfig(env, { deploymentsDir: dir });
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(DemoConfigError);
    return (err as Error).message.split("\n").slice(1).map((l) => l.trim());
  }
};

describe("demo plan", () => {
  it("splits 500 calls into the scenario mix exactly", () => {
    const p = planFor(500);
    expect(plannedCalls(p)).toBe(500);
    expect(p).toMatchObject({ treasuryMarket: 120, treasuryRisk: 60, briefs: 20, tradingMarket: 200, tradingRisk: 40 });
    expect(plannedCalls(planFor(60))).toBe(60);
  });
});

describe("live network safety guard", () => {
  it("runs locally with anvil dev keys and no confirmation", () => {
    const cfg = loadDemoConfig({});
    expect(cfg).toMatchObject({ chainId: 31337, live: false, calls: 500 });
    expect(cfg.keys.operator).toBe(ANVIL_KEYS[9]);
    // The gateway act's wallets are deterministic, distinct, and none of the ten prefunded clearing accounts.
    const gw = Object.values(cfg.gatewayKeys!);
    expect(new Set(gw).size).toBe(8);
    for (const k of gw) expect(ANVIL_KEYS as readonly string[]).not.toContain(k);
    expect(loadDemoConfig({}).gatewayKeys).toEqual(cfg.gatewayKeys);
  });

  it("refuses mainnet without DEMO_LIVE_NETWORK_CONFIRM=yes", () => {
    expect(problems(liveEnv).join("\n")).toMatch(/DEMO_LIVE_NETWORK_CONFIRM/);
    expect(problems({ ...liveEnv, DEMO_LIVE_NETWORK_CONFIRM: "y" }).join("\n")).toMatch(/DEMO_LIVE_NETWORK_CONFIRM/);
  });

  it("accepts a confirmed, capped mainnet plan with tiny prices", () => {
    const cfg = loadDemoConfig({ ...liveEnv, DEMO_LIVE_NETWORK_CONFIRM: "yes" }, { deploymentsDir: dir });
    expect(cfg.live).toBe(true);
    expect(cfg.prices).toEqual(LIVE_PRICES);
    expect(cfg.spend.total).toBe(plannedSpend(cfg.plan, LIVE_PRICES).total);
    expect(cfg.spend.total).toBeLessThanOrEqual(1_000_000n);
    expect(cfg.deployment?.clearingHub).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    // The gateway act mints and funds test wallets, so it never runs on a live network.
    expect(cfg.gatewayKeys).toBeNull();
  });

  it("refuses a plan above the spend cap", () => {
    const p = problems({ ...liveEnv, DEMO_LIVE_NETWORK_CONFIRM: "yes", DEMO_CALLS: "5000", DEMO_MAX_SPEND_USDC: "0.5" });
    expect(p.join("\n")).toMatch(/planned spend .* exceeds DEMO_MAX_SPEND_USDC 0.50/);
  });

  it("refuses public anvil keys, missing keys, the default admin token and a missing deployments file", () => {
    const p = problems({ DEMO_CHAIN_ID: "133", DEMO_LIVE_NETWORK_CONFIRM: "yes", DEMO_OPERATOR_KEY: ANVIL_KEYS[9] });
    const all = p.join("\n");
    expect(all).toMatch(/operator key: is a public anvil dev key/);
    expect(all).toMatch(/DEMO_OWNER_KEY: required/);
    expect(all).toMatch(/DEMO_ADMIN_TOKEN: required/);
    expect(all).toMatch(/133\.json: missing/);
  });
});

describe("portIsFree", () => {
  // Regression: a port held on 127.0.0.1 only (for example a Docker port forward) was reported free because the probe
  // bound 0.0.0.0, which macOS allows alongside a more specific bind, and the node then crashed with EADDRINUSE.
  it("reports a port held on 127.0.0.1 only as busy", async () => {
    const { createServer } = await import("node:net");
    const { portIsFree } = await import("../src/chain.ts");
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const port = (holder.address() as { port: number }).port;
    try {
      expect(await portIsFree(port)).toBe(false);
    } finally {
      holder.close();
    }
  });
});
