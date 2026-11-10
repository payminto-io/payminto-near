/**
 * Merchant AI agents without a chain: the secret box (AES-256-GCM bound to business and row, key versions), the
 * agents config guards on HashKey Chain, the retry backoff, and the node's seam onto @payminto/models. The provider
 * adapters are tested in packages/models, and runs on each provider in agents-providers.test.ts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ModelError, PROVIDERS, retryAfterMs } from "@payminto/models";
import { ConfigError, loadConfig } from "../src/config.ts";
import { DEV_AGENT_SECRETS_KEY, parseSecretsKey, SecretBox, SecretError } from "../src/agents/secrets.ts";
import { asModelError } from "../src/agents/models.ts";
import { AgentWorker } from "../src/agents/worker.ts";
import { silentLogger } from "../src/logger.ts";

const key = () => randomBytes(32);

describe("secret box", () => {
  it("round trips, binds the ciphertext to its business and row, and never shows the plaintext", () => {
    const box = new SecretBox(new Map([[1, key()]]), 1);
    const s = box.seal("sk-ant-super-secret-1234", { merchantId: "mer_a", rowId: "aic_1" });
    expect(s.version).toBe(1);
    expect(Buffer.from(s.ciphertext, "base64").toString("utf8")).not.toContain("secret");
    expect(box.open(s, { merchantId: "mer_a", rowId: "aic_1" })).toBe("sk-ant-super-secret-1234");
    // Copied to another business or another row: fails.
    expect(() => box.open(s, { merchantId: "mer_b", rowId: "aic_1" })).toThrow(SecretError);
    expect(() => box.open(s, { merchantId: "mer_a", rowId: "aic_2" })).toThrow(SecretError);
    // Tampered tag or ciphertext: fails.
    expect(() => box.open({ ...s, tag: Buffer.alloc(16).toString("base64") }, { merchantId: "mer_a", rowId: "aic_1" })).toThrow(SecretError);
    // Two seals of the same key differ (fresh IV).
    expect(box.seal("x", { merchantId: "m", rowId: "r" }).iv).not.toBe(box.seal("x", { merchantId: "m", rowId: "r" }).iv);
    try {
      box.open(s, { merchantId: "mer_b", rowId: "aic_1" });
    } catch (err) {
      expect(String(err)).not.toContain("sk-ant");
    }
  });

  it("reads older key versions during a rotation and seals with the current one", () => {
    const k1 = key();
    const k2 = key();
    const old = new SecretBox(new Map([[1, k1]]), 1);
    const sealed = old.seal("sk-old", { merchantId: "m", rowId: "r" });
    const rotated = new SecretBox(
      new Map([
        [1, k1],
        [2, k2],
      ]),
      2,
    );
    expect(rotated.open(sealed, { merchantId: "m", rowId: "r" })).toBe("sk-old");
    expect(rotated.seal("sk-new", { merchantId: "m", rowId: "r" }).version).toBe(2);
    const onlyNew = new SecretBox(new Map([[2, k2]]), 2);
    expect(() => onlyNew.open(sealed, { merchantId: "m", rowId: "r" })).toThrow(/version 1/);
  });

  it("accepts only base64 32-byte server keys, naming the variable but never the value", () => {
    expect(parseSecretsKey(DEV_AGENT_SECRETS_KEY)).toHaveLength(32);
    expect(() => parseSecretsKey("c2hvcnQ=")).toThrow(/AGENT_SECRETS_KEY: must decode to 32 bytes/);
    expect(() => parseSecretsKey("not base64 !!")).toThrow(/AGENT_SECRETS_KEY: must be base64/);
    try {
      parseSecretsKey("c2hvcnQ=");
    } catch (err) {
      expect(String(err)).not.toContain("c2hvcnQ=");
    }
  });
});

describe("agents config", () => {
  const live = (over: Record<string, string>) => ({
    NETWORK: "near:testnet",
    HUB_ACCOUNT: "hub.payminto.testnet",
    OPERATOR_ACCOUNT: "node.payminto.testnet",
    OPERATOR_KEY: "ed25519:LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ",
    NODE_SIGNING_SEED: "22".repeat(32),
    ADMIN_TOKEN: "x".repeat(40),
    GATEWAY_PAYOUT_ACCOUNT: "shop.testnet",
    PUBLIC_CHECKOUT_URL: "https://pay.example.com",
    ...over,
  });
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return [];
    } catch (err) {
      return (err as ConfigError).problems;
    }
  };
  const local = { OPERATOR_KEY: "ed25519:LnrbZDPq59Ywk2Ddy9zVxg7KVaDBPRpikn7V7A3ZWgEb2JK6JYLkQKJCbqyeji46k7svBPp5UsFu4v4mh1DGzTJ", ADMIN_TOKEN: "x".repeat(20), HUB_ACCOUNT: "hub.sandbox", OPERATOR_ACCOUNT: "node.sandbox", NODE_SIGNING_SEED: "22".repeat(32) };

  it("is on locally with the gateway, using the documented dev key, and off without the gateway", () => {
    const withGateway = loadConfig({ ...local, GATEWAY_ENABLED: "true" });
    expect(withGateway.agents).toMatchObject({ enabled: true, usingDevKey: true, secretsKeyVersion: 1, workers: 2, maxPerMerchant: 1, pollMs: 1000, allowPrivateModelUrls: false });
    expect(loadConfig(local).agents!.enabled).toBe(false);
    expect(problems({ ...local, AGENTS_ENABLED: "true" })).toEqual([expect.stringMatching(/^AGENTS_ENABLED: .*gateway/)]);
  });

  it("on NEAR testnet is off by default and refuses a missing or documented dev key when turned on", () => {
    expect(loadConfig(live({})).agents!.enabled).toBe(false);
    expect(problems(live({ AGENTS_ENABLED: "true" }))).toEqual([expect.stringMatching(/^AGENT_SECRETS_KEY: required on near:testnet/)]);
    expect(problems(live({ AGENTS_ENABLED: "true", AGENT_SECRETS_KEY: DEV_AGENT_SECRETS_KEY }))).toEqual([expect.stringMatching(/^AGENT_SECRETS_KEY: is the documented dev key/)]);
    const real = randomBytes(32).toString("base64");
    const ok = loadConfig(live({ AGENTS_ENABLED: "true", AGENT_SECRETS_KEY: real }));
    expect(ok.agents).toMatchObject({ enabled: true, usingDevKey: false, secretsKeys: { 1: real } });
    // A previous key for rotation needs a version above 1; values never appear in the problems.
    const prev = randomBytes(32).toString("base64");
    expect(problems(live({ AGENTS_ENABLED: "true", AGENT_SECRETS_KEY: real, AGENT_SECRETS_KEY_PREVIOUS: prev }))).toEqual([expect.stringMatching(/^AGENT_SECRETS_KEY_PREVIOUS: set AGENT_SECRETS_KEY_VERSION/)]);
    expect(loadConfig(live({ AGENTS_ENABLED: "true", AGENT_SECRETS_KEY: real, AGENT_SECRETS_KEY_PREVIOUS: prev, AGENT_SECRETS_KEY_VERSION: "2" })).agents!.secretsKeys).toEqual({ 1: prev, 2: real });
    const bad = problems(live({ AGENTS_ENABLED: "true", AGENT_SECRETS_KEY: "dG9vLXNob3J0" }));
    expect(bad).toEqual([expect.stringMatching(/^AGENT_SECRETS_KEY: must decode to 32 bytes/)]);
    expect(bad.join(" ")).not.toContain("dG9vLXNob3J0");
  });
});

describe("retry backoff", () => {
  it("is 2 s, 8 s, 30 s with jitter, and never less than Retry-After", () => {
    const at = (random: number) =>
      new AgentWorker({ runs: {} as never, agents: {} as never, connections: {} as never, tools: (async () => ({})) as never, log: silentLogger, workers: 1, maxPerMerchant: 1, pollMs: 1000, random: () => random });
    expect(at(0.5).retryDelay(1, null)).toBe(2_000);
    expect(at(0.5).retryDelay(2, null)).toBe(8_000);
    expect(at(0.5).retryDelay(3, null)).toBe(30_000);
    expect(at(0).retryDelay(1, null)).toBe(1_600);
    expect(at(1).retryDelay(1, null)).toBe(2_400);
    expect(at(0.5).retryDelay(1, 45_000)).toBe(45_000);
    expect(at(0.5).retryDelay(1, 3_600_000)).toBe(600_000);
  });

  it("keeps the defaults for options passed as undefined (unset config values)", () => {
    const w = new AgentWorker({
      runs: {} as never,
      agents: {} as never,
      connections: {} as never,
      tools: (async () => ({})) as never,
      log: silentLogger,
      workers: 1,
      maxPerMerchant: 1,
      pollMs: 1000,
      idlePollMs: undefined,
      leaseMs: undefined,
      heartbeatMs: undefined,
      retryDelaysMs: undefined,
      random: () => 0.5,
    });
    expect([1, 2, 3].map((a) => w.retryDelay(a, null))).toEqual([2_000, 8_000, 30_000]);
  });

  it("reads Retry-After in seconds, as a date, and retry-after-ms", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(retryAfterMs(h({ "retry-after": "7" }))).toBe(7_000);
    expect(retryAfterMs(h({ "retry-after-ms": "1500" }))).toBe(1_500);
    expect(retryAfterMs(h({ "retry-after": new Date(Date.now() + 10_000).toUTCString() }))!).toBeGreaterThan(8_000);
    expect(retryAfterMs(h({}))).toBeNull();
  });
});

describe("model layer", () => {
  it("serves the catalogue of @payminto/models, one entry per provider", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["anthropic", "openai", "google", "openai_compatible", "replicate", "nearai"]);
    expect(PROVIDERS.find((p) => p.id === "openai_compatible")).toMatchObject({ needsBaseUrl: true, keyOptional: true, defaultBaseUrl: null });
    for (const p of PROVIDERS) expect(Object.keys(p).sort()).toEqual(["defaultBaseUrl", "docsUrl", "id", "keyOptional", "name", "needsBaseUrl", "note", "presets", "suggestedModels"]);
  });

  it("coerces aborts and stray errors to ModelError, and keeps ModelErrors as they are", () => {
    const e = new ModelError("rate_limit", "slow down", { status: 429, retryAfterMs: 1_000 });
    expect(asModelError(e)).toBe(e);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(asModelError(abort)).toMatchObject({ kind: "timeout", retryable: true });
    expect(asModelError("boom")).toMatchObject({ kind: "unknown", message: "boom", retryable: false });
  });
});
