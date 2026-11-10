import { gasless } from "@payminto/near-addons";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, nearToYocto, redactedConfig } from "../src/config.ts";

// A syntactically valid NEAR secret key that belongs to no account: 64 bytes of a fixed test pattern in base58.
const KEY = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";
const base = { RELAYER_ACCOUNT: "relayer.example.testnet", RELAYER_KEY: KEY, HUB_ACCOUNT: "hub.example.testnet", NETWORK: "near:testnet" };

const problemsOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
};

describe("loadConfig", () => {
  it("fills safe defaults, and takes the method list from the add-on, not from a second copy", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      network: "near:testnet",
      relayer: "relayer.example.testnet",
      hub: "hub.example.testnet",
      rpcUrl: "https://rpc.testnet.near.org",
      port: 8790,
      host: "127.0.0.1",
      maxGasTgas: 300,
      maxTtlBlocks: 600,
      expiryMarginBlocks: 5,
      dailyGasBudgetTgas: 3_000,
      gasLedgerPath: null,
      rateLimit: { ip: { perMin: 30, burst: 30 }, sender: { perMin: 6, burst: 6 } },
      maxPending: 16,
      maxBodyBytes: 16_384,
      trustProxyHops: 0,
      corsOrigins: ["http://localhost:3000"],
      lowBalanceYocto: 5n * 10n ** 23n,
      logLevel: "info",
    });
    expect(c.methods).toEqual([...gasless.DEFAULT_RELAY_METHODS]);
  });

  it("defaults to the local sandbox when NETWORK is unset", () => {
    const c = loadConfig({ ...base, NETWORK: undefined, RELAYER_ACCOUNT: "relayer.test.near", HUB_ACCOUNT: "hub.test.near" });
    expect(c).toMatchObject({ network: "near:sandbox", rpcUrl: "http://127.0.0.1:3030" });
  });

  it("reads every variable", () => {
    const c = loadConfig({
      ...base,
      RPC_URL: "https://rpc.example.org",
      PORT: "9000",
      HOST: "0.0.0.0",
      ALLOWED_METHODS: "revoke_budget, pause_agent,revoke_budget",
      MAX_GAS_TGAS: "100",
      MAX_TTL_BLOCKS: "300",
      EXPIRY_MARGIN_BLOCKS: "10",
      DAILY_GAS_BUDGET_TGAS: "500",
      GAS_LEDGER_PATH: "./data/gas.json",
      RATE_LIMIT_IP_PER_MIN: "10",
      RATE_LIMIT_IP_BURST: "5",
      RATE_LIMIT_SENDER_PER_MIN: "2",
      RATE_LIMIT_SENDER_BURST: "1",
      MAX_PENDING_RELAYS: "4",
      MAX_BODY_BYTES: "4096",
      TRUST_PROXY_HOPS: "1",
      CORS_ORIGINS: "https://dash.example, http://localhost:3000",
      LOW_BALANCE_NEAR: "1.25",
      LOG_LEVEL: "debug",
      READ_TIMEOUT_MS: "5000",
      SEND_TIMEOUT_MS: "30000",
    });
    expect(c).toMatchObject({
      rpcUrl: "https://rpc.example.org",
      port: 9000,
      host: "0.0.0.0",
      methods: ["revoke_budget", "pause_agent"],
      maxGasTgas: 100,
      maxTtlBlocks: 300,
      expiryMarginBlocks: 10,
      dailyGasBudgetTgas: 500,
      gasLedgerPath: "./data/gas.json",
      rateLimit: { ip: { perMin: 10, burst: 5 }, sender: { perMin: 2, burst: 1 } },
      maxPending: 4,
      maxBodyBytes: 4096,
      trustProxyHops: 1,
      corsOrigins: ["https://dash.example", "http://localhost:3000"],
      lowBalanceYocto: 125n * 10n ** 22n,
      logLevel: "debug",
      readTimeoutMs: 5000,
      sendTimeoutMs: 30000,
    });
  });

  it("treats an empty value in an env file as unset", () => {
    expect(loadConfig({ ...base, ALLOWED_METHODS: "", PORT: "", RPC_URL: " " })).toMatchObject({ port: 8790, rpcUrl: "https://rpc.testnet.near.org" });
  });

  it("names every missing required variable at once and says what to put there", () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(3);
    expect(problems.find((p) => p.startsWith("RELAYER_ACCOUNT:"))).toContain("is required: the account that pays the gas");
    expect(problems.find((p) => p.startsWith("RELAYER_KEY:"))).toContain("is required: the relayer account's secret key");
    expect(problems.find((p) => p.startsWith("HUB_ACCOUNT:"))).toContain("is required: the Payminto hub contract");
  });

  it.each([
    ["RELAYER_ACCOUNT", "Not An Account", "must be a NEAR account id"],
    ["HUB_ACCOUNT", "x", "must be a NEAR account id"],
    ["RELAYER_KEY", "ed25519:short", "must be a NEAR ed25519 secret key"],
    ["RELAYER_KEY", "secp256k1:abc", "must be a NEAR ed25519 secret key"],
    ["NETWORK", "near:devnet", "must be near:testnet or near:sandbox"],
    ["RPC_URL", "not a url", "must be an http or https URL"],
    ["RPC_URL", "ftp://rpc.example.org", "must be an http or https URL"],
    ["PORT", "eighty", "must be a whole number between 0 and 65535"],
    ["PORT", "70000", "must be between 0 and 65535"],
    ["ALLOWED_METHODS", "revoke budget", "is not a contract method name"],
    ["ALLOWED_METHODS", " , ", "must name at least one hub method"],
    ["MAX_GAS_TGAS", "301", "must be between 1 and 300"],
    ["MAX_GAS_TGAS", "0", "must be between 1 and 300"],
    ["MAX_TTL_BLOCKS", "-5", "must be a whole number"],
    ["DAILY_GAS_BUDGET_TGAS", "1.5", "must be a whole number"],
    ["DAILY_GAS_BUDGET_TGAS", "100", "must be at least MAX_GAS_TGAS + 5"],
    ["EXPIRY_MARGIN_BLOCKS", "600", "must be smaller than MAX_TTL_BLOCKS"],
    ["RATE_LIMIT_IP_PER_MIN", "many", "must be a whole number"],
    ["RATE_LIMIT_SENDER_BURST", "0", "must be between 1 and 100000"],
    ["MAX_PENDING_RELAYS", "0", "must be between 1 and 1000"],
    ["MAX_BODY_BYTES", "10", "must be between 256 and 1048576"],
    ["TRUST_PROXY_HOPS", "yes", "must be a whole number"],
    ["CORS_ORIGINS", "https://dash.example/path", "is not an origin"],
    ["CORS_ORIGINS", "dash.example", "is not an origin"],
    ["LOW_BALANCE_NEAR", "half", "must be an amount of NEAR"],
    ["LOG_LEVEL", "loud", "must be debug, info, warn or error"],
    ["SEND_TIMEOUT_MS", "5", "must be between 1000 and 600000"],
  ])("refuses a malformed %s (%s)", (name, value, expected) => {
    const problems = problemsOf({ ...base, [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name}: `));
    expect(problems[0]).toContain(expected);
  });

  it("reports every malformed variable in one go", () => {
    const problems = problemsOf({
      RELAYER_ACCOUNT: "Bad Name",
      RELAYER_KEY: "abc",
      HUB_ACCOUNT: "hub.example.testnet",
      NETWORK: "near:mainnet",
      RPC_URL: "nope",
      PORT: "99999",
      ALLOWED_METHODS: "revoke budget",
      CORS_ORIGINS: "dash.example",
      LOW_BALANCE_NEAR: "lots",
    });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["RELAYER_ACCOUNT", "RELAYER_KEY", "NETWORK", "RPC_URL", "PORT", "ALLOWED_METHODS", "CORS_ORIGINS", "LOW_BALANCE_NEAR"]);
  });

  it("refuses mainnet however it is asked for", () => {
    expect(problemsOf({ ...base, NETWORK: "near:mainnet" })[0]).toContain("NETWORK: mainnet is refused in this submission");
    expect(problemsOf({ ...base, NETWORK: "mainnet" })[0]).toContain("mainnet is refused");
    expect(problemsOf({ ...base, RPC_URL: "https://rpc.mainnet.near.org" })[0]).toContain("RPC_URL: points at mainnet");
    const names = problemsOf({ ...base, RELAYER_ACCOUNT: "relayer.near", HUB_ACCOUNT: "hub.near" });
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("RELAYER_ACCOUNT: is a mainnet account name");
    expect(names[1]).toContain("HUB_ACCOUNT: is a mainnet account name");
  });

  it("refuses the hub as its own relayer", () => {
    expect(problemsOf({ ...base, RELAYER_ACCOUNT: "hub.example.testnet" })[0]).toContain("must be a separate account from HUB_ACCOUNT");
  });

  it("never prints a value in an error, and never includes the key in the loggable summary", () => {
    const bad = "ed25519:" + "9".repeat(60);
    let message = "";
    try {
      loadConfig({ ...base, RELAYER_KEY: bad, RPC_URL: "https://user:hunter2@rpc.mainnet.example" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("RELAYER_KEY:");
    expect(message).not.toContain("9".repeat(20));
    expect(message).not.toContain("hunter2");

    const summary = JSON.stringify(redactedConfig(loadConfig({ ...base, RPC_URL: "https://rpc.example.org/v1/0123456789abcdef0123456789abcdef" })));
    expect(summary).not.toContain(KEY.slice(8));
    expect(summary).not.toContain("relayerKey");
    expect(summary).toContain("https://rpc.example.org/***");
  });

  it("converts NEAR amounts exactly", () => {
    expect(nearToYocto("0.5")).toBe(5n * 10n ** 23n);
    expect(nearToYocto("2")).toBe(2n * 10n ** 24n);
    expect(nearToYocto("0.000000000000000000000001")).toBe(1n);
    expect(nearToYocto("1e3")).toBeNull();
    expect(nearToYocto("-1")).toBeNull();
  });
});
