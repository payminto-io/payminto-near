import { describe, expect, it } from "vitest";
import { ConfigError, DEV_NODE_SEED, loadConfig } from "../src/config.ts";

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
});
