import { describe, expect, it } from "vitest";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY } from "@payminto/near-addons/intents/fake-server";
import { ConfigError, DEV_NODE_SEED, intentsBootWarnings, loadConfig } from "../src/config.ts";

const base = {
  HUB_ACCOUNT: "hub.payminto.testnet",
  OPERATOR_ACCOUNT: "node.payminto.testnet",
  OPERATOR_KEY: "ed25519:LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ",
  NODE_SIGNING_SEED: "22".repeat(32),
  ADMIN_TOKEN: "a".repeat(32),
};

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return "";
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
};

describe("config", () => {
  it("defaults to the local sandbox and the network token", () => {
    const c = loadConfig({ ...base, ADMIN_TOKEN: "dev-admin-token" });
    expect(c).toMatchObject({ network: "near:sandbox", hub: base.HUB_ACCOUNT, operator: base.OPERATOR_ACCOUNT, token: "usdc.sandbox", rpcUrl: "http://127.0.0.1:3030" });
  });

  it("refuses an operator key that is not a NEAR ed25519 secret key", () => {
    expect(problems({ ...base, OPERATOR_KEY: "ed25519:not-a-real-key" })).toMatch(/OPERATOR_KEY.*NEAR ed25519 secret key/);
    expect(problems({ ...base, OPERATOR_KEY: "0x" + "11".repeat(32) })).toMatch(/OPERATOR_KEY/);
  });

  it("uses Circle testnet USDC on near:testnet", () => {
    expect(loadConfig({ ...base, NETWORK: "near:testnet" }).token).toBe("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af");
  });

  it("refuses mainnet, because this submission has no mainnet node mode", () => {
    expect(problems({ ...base, NETWORK: "near:mainnet" })).toMatch(/NETWORK/);
  });

  it("refuses the public dev seed and dev admin token on testnet, without echoing secrets", () => {
    const msg = problems({ ...base, NETWORK: "near:testnet", NODE_SIGNING_SEED: DEV_NODE_SEED, ADMIN_TOKEN: "dev-admin-token" });
    expect(msg).toMatch(/NODE_SIGNING_SEED: is the public dev seed/);
    expect(msg).toMatch(/ADMIN_TOKEN: is the public dev token/);
    expect(msg).not.toContain(DEV_NODE_SEED);
  });

  it("validates account ids and the seed format", () => {
    const msg = problems({ ...base, HUB_ACCOUNT: "0xNotNear", NODE_SIGNING_SEED: "xyz" });
    expect(msg).toMatch(/HUB_ACCOUNT/);
    expect(msg).toMatch(/NODE_SIGNING_SEED/);
  });

  it("keeps the maximum funds snapshot age short: 10 s by default, never under 500 ms or over 60 s", () => {
    expect(loadConfig(base).fundsMaxAgeMs).toBe(10_000);
    expect(loadConfig({ ...base, FUNDS_MAX_AGE_MS: "2500" }).fundsMaxAgeMs).toBe(2_500);
    expect(problems({ ...base, FUNDS_MAX_AGE_MS: "60001" })).toMatch(/FUNDS_MAX_AGE_MS: must be <= 60000/);
    expect(problems({ ...base, FUNDS_MAX_AGE_MS: "100" })).toMatch(/FUNDS_MAX_AGE_MS: must be >= 500/);
    expect(loadConfig(base).rateLimit.unsigned).toEqual({ rps: 5, burst: 50 });
  });

  it("refuses a gateway payout that is the operator account on testnet", () => {
    expect(problems({ ...base, NETWORK: "near:testnet", GATEWAY_PAYOUT_ACCOUNT: base.OPERATOR_ACCOUNT, PUBLIC_CHECKOUT_URL: "https://pay.example.com" })).toMatch(
      /GATEWAY_PAYOUT_ACCOUNT: must not be the operator account/,
    );
  });

  it("reads the minimum checkout amount, which defaults to the hub's own minimum", () => {
    expect(loadConfig({ ...base, GATEWAY_ENABLED: "true" }).gateway?.minCheckoutAmount).toBeUndefined();
    expect(loadConfig({ ...base, GATEWAY_ENABLED: "true", MIN_CHECKOUT_AMOUNT: "25000" }).gateway?.minCheckoutAmount).toBe(25_000n);
    expect(problems({ ...base, GATEWAY_ENABLED: "true", MIN_CHECKOUT_AMOUNT: "0" })).toMatch(/MIN_CHECKOUT_AMOUNT/);
    expect(problems({ ...base, GATEWAY_ENABLED: "true", MIN_CHECKOUT_AMOUNT: "1.5" })).toMatch(/MIN_CHECKOUT_AMOUNT/);
  });
});

describe("live any-chain mode (INTENTS_CHECKOUT=live) applies the production checks", () => {
  // What `pnpm local --intents live` gives the node: a local chain, a random seed and admin token, its own dashboard on
  // this machine, and the password cost and webhook rule of a public network.
  const local = { ...base, GATEWAY_ENABLED: "true", INTENTS_CHECKOUT: "live", PUBLIC_CHECKOUT_URL: "http://localhost:3210", PUBLIC_DASHBOARD_URL: "http://localhost:3210" };

  it("accepts the local live stack, with private webhooks off by default", () => {
    const c = loadConfig(local);
    expect(c.gateway?.intents?.mode).toBe("live");
    expect(c.gateway?.webhookAllowPrivate).toBe(false);
    expect(loadConfig({ ...local, PUBLIC_CHECKOUT_URL: "https://pay.example.com", PUBLIC_DASHBOARD_URL: "https://pay.example.com" }).gateway?.checkoutBaseUrl).toBe("https://pay.example.com");
  });

  it("refuses the dev seed, a dev or short admin token and a cheap password hash, naming live mode as the reason", () => {
    const msg = problems({ ...local, NODE_SIGNING_SEED: DEV_NODE_SEED, ADMIN_TOKEN: "dev-admin-token", PASSWORD_HASH_COST: "14" });
    expect(msg).toMatch(/NODE_SIGNING_SEED: is the public dev seed; refusing to use it with INTENTS_CHECKOUT=live/);
    expect(msg).toMatch(/ADMIN_TOKEN: is the public dev token/);
    expect(msg).toMatch(/PASSWORD_HASH_COST: must be at least 17 with INTENTS_CHECKOUT=live/);
    expect(problems({ ...local, ADMIN_TOKEN: "short-but-12-chars" })).toMatch(/ADMIN_TOKEN: must be at least 32 characters with INTENTS_CHECKOUT=live/);
  });

  it("refuses a plain-http checkout or dashboard anywhere but this machine, and private webhooks", () => {
    expect(problems({ ...local, PUBLIC_CHECKOUT_URL: "http://shop.example.com" })).toMatch(/PUBLIC_CHECKOUT_URL: must be an https origin/);
    expect(problems({ ...local, PUBLIC_CHECKOUT_URL: "http://0.0.0.0:3000" })).toMatch(/PUBLIC_CHECKOUT_URL/);
    expect(problems({ ...local, PUBLIC_DASHBOARD_URL: "http://dash.example.com" })).toMatch(/PUBLIC_DASHBOARD_URL: must be https with INTENTS_CHECKOUT=live/);
    expect(problems({ ...local, WEBHOOK_ALLOW_PRIVATE: "true" })).toMatch(/WEBHOOK_ALLOW_PRIVATE: refusing true with INTENTS_CHECKOUT=live/);
  });

  it("leaves simulated mode on a local chain as it was", () => {
    const sim = { ...base, GATEWAY_ENABLED: "true", PASSWORD_HASH_COST: "14", ADMIN_TOKEN: "dev-admin-token", INTENTS_CHECKOUT: "simulated", ONECLICK_BASE_URL: "http://127.0.0.1:9", ONECLICK_MANAGER_PUBLIC_KEY: FAKE_ONECLICK_MANAGER_PUBLIC_KEY, NEAR_MAINNET_RPC_URL: "http://127.0.0.1:3030", INTENTS_USDC_CONTRACT: "usdc.sandbox" };
    expect(loadConfig(sim).gateway?.webhookAllowPrivate).toBe(true);
  });

  it("warns at boot without a 1Click API key and on the public mainnet RPC", () => {
    const warnings = intentsBootWarnings(loadConfig(local));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/ONECLICK_API_KEY.*25 bps/);
    expect(warnings[1]).toMatch(/NEAR_MAINNET_RPC_URL is the public default/);
    expect(intentsBootWarnings(loadConfig({ ...local, ONECLICK_API_KEY: "partner-key-123", NEAR_MAINNET_RPC_URL: "https://near.rpc.example.com/v1" }))).toEqual([]);
    expect(intentsBootWarnings(loadConfig(base))).toEqual([]);
    expect(warnings.join(" ")).not.toContain("\u2014");
  });
});
