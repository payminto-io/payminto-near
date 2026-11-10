import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/config.ts";
import { guide } from "../src/guide.ts";
import { intentsNodeEnv, isMainnetAccount, liveBanner, readMainnetPayout } from "../src/intents-live.ts";
import type { Stack } from "../src/stack.ts";

const usage = (argv: string[]) => {
  try {
    parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return e.message.split("\n")[0]!;
    throw e;
  }
  return null;
};

describe("pnpm local --intents live", () => {
  afterEach(() => {
    delete process.env.INTENTS_CHECKOUT;
    delete process.env.INTENTS_PAYOUT;
  });

  it("is simulated unless the flag says live; no environment variable turns it on", () => {
    process.env.INTENTS_CHECKOUT = "live";
    process.env.INTENTS_PAYOUT = "northwind.near";
    expect(parseArgs([]).intents).toEqual({ mode: "simulated" });
    expect(parseArgs(["--intents", "simulated"]).intents).toEqual({ mode: "simulated" });
  });

  it("takes the payout account, and optional delivery senders and a mainnet RPC", () => {
    expect(parseArgs(["--intents", "live", "--intents-payout", "northwind-usdc.near"]).intents).toEqual({ mode: "live", payout: "northwind-usdc.near", senders: [], rpcUrl: null });
    expect(parseArgs(["--intents=live", "--intents-payout=northwind-usdc.near", "--intents-senders", "relay.near,solver-relay.near", "--intents-rpc", "https://rpc.mainnet.fastnear.com/"]).intents).toEqual({
      mode: "live",
      payout: "northwind-usdc.near",
      senders: ["relay.near", "solver-relay.near"],
      rpcUrl: "https://rpc.mainnet.fastnear.com",
    });
  });

  it("refuses to start without the payout account, or with one that is not a NEAR mainnet account", () => {
    expect(usage(["--intents", "live"])).toMatch(/--intents live needs --intents-payout <your NEAR mainnet account>/);
    expect(usage(["--intents", "live", "--intents-payout", "shop.testnet"])).toMatch(/not a NEAR mainnet account/);
    expect(usage(["--intents", "live", "--intents-payout", "anychain.test.near"])).toMatch(/not a NEAR mainnet account/);
    expect(usage(["--intents", "live", "--intents-payout", "Not An Account"])).toMatch(/not a NEAR mainnet account/);
  });

  it("refuses the live-only flags without --intents live, and live with --check or --reset", () => {
    expect(usage(["--intents-payout", "northwind.near"])).toMatch(/only with --intents live/);
    expect(usage(["--intents-senders", "relay.near"])).toMatch(/only with --intents live/);
    expect(usage(["--intents", "live", "--intents-payout", "northwind.near", "--check"])).toMatch(/--check runs the simulated pass/);
    expect(usage(["--intents", "live", "--intents-payout", "northwind.near", "--reset"])).toMatch(/--reset takes no other flag/);
    expect(usage(["--intents", "mainnet"])).toMatch(/--intents is simulated or live/);
    expect(usage(["--intents", "live", "--intents-payout", "northwind.near", "--intents-rpc", "http://127.0.0.1:3030"])).toMatch(/https/);
    expect(usage(["--intents", "live", "--intents-payout", "northwind.near", "--intents-senders", "relay.testnet"])).toMatch(/NEAR mainnet account/);
  });

  it("knows a NEAR mainnet account from a testnet or local one", () => {
    for (const ok of ["northwind.near", "pay.northwind.near", "a".repeat(64), "0x5f2b3a1e9c7d4b6a8f0e1d2c3b4a59687766554f"]) expect(isMainnetAccount(ok), ok).toBe(true);
    for (const no of ["near", "shop.testnet", "x.test.near", "UPPER.near", "a".repeat(63)]) expect(isMainnetAccount(no), no).toBe(false);
  });
});

describe("what the node is given", () => {
  const sim = { baseUrl: "http://127.0.0.1:53000", managerPublicKey: "ed25519:Fake", rpcUrl: "http://127.0.0.1:52000", token: "usdc.test.near", solver: "solver.test.near" };

  it("simulated: the fake 1Click server, its test key, the local chain and its token", () => {
    expect(intentsNodeEnv({ mode: "simulated" }, sim)).toEqual({
      INTENTS_CHECKOUT: "simulated",
      ONECLICK_BASE_URL: sim.baseUrl,
      ONECLICK_MANAGER_PUBLIC_KEY: sim.managerPublicKey,
      NEAR_MAINNET_RPC_URL: sim.rpcUrl,
      INTENTS_USDC_CONTRACT: sim.token,
      INTENTS_DELIVERY_SENDERS: sim.solver,
    });
  });

  it("live: the real 1Click API and NEAR mainnet, and nothing of the fake server", () => {
    expect(intentsNodeEnv({ mode: "live", payout: "northwind.near", senders: [], rpcUrl: null }, null)).toEqual({ INTENTS_CHECKOUT: "live" });
    expect(intentsNodeEnv({ mode: "live", payout: "northwind.near", senders: ["relay.near"], rpcUrl: "https://rpc.mainnet.fastnear.com" }, null)).toEqual({
      INTENTS_CHECKOUT: "live",
      INTENTS_DELIVERY_SENDERS: "relay.near",
      NEAR_MAINNET_RPC_URL: "https://rpc.mainnet.fastnear.com",
    });
  });

  it("prints the loud banner", () => {
    const text = liveBanner("northwind-usdc.near").join("\n");
    expect(text).toContain("LIVE - real money on NEAR mainnet");
    expect(text).toContain("northwind-usdc.near");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("reads the payout account on NEAR mainnet: whether it exists and is registered with USDC (views only)", async () => {
    const seen: string[] = [];
    const rpc = (answers: Record<string, unknown>) =>
      (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: { request_type: string; method_name?: string } };
        expect(body.method).toBe("query");
        const key = body.params.method_name ?? body.params.request_type;
        seen.push(key);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", ...(answers[key] as object) }), { status: 200 });
      }) as typeof fetch;
    const registered = { result: { result: [...new TextEncoder().encode(JSON.stringify({ total: "1250000000000000000000", available: "0" }))] } };
    expect(await readMainnetPayout("https://rpc.mainnet.near.org", "northwind.near", rpc({ view_account: { result: { amount: "1" } }, storage_balance_of: registered }))).toEqual({ exists: true, registered: true });
    expect(seen).toEqual(["view_account", "storage_balance_of"]);
    const missing = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
    expect(await readMainnetPayout("https://rpc.mainnet.near.org", "ghost.near", rpc({ view_account: missing }))).toEqual({ exists: false, registered: false });
    const unregistered = { result: { result: [...new TextEncoder().encode("null")] } };
    expect(await readMainnetPayout("https://rpc.mainnet.near.org", "northwind.near", rpc({ view_account: { result: { amount: "1" } }, storage_balance_of: unregistered }))).toEqual({ exists: true, registered: false });
  });
});

describe("the printed guide in live mode", () => {
  const account = (key: string, role: string) => ({ key, role, does: `does ${key}`, near: 1, usdc: 0n, accountId: `${key}.test.near`, secretKey: `ed25519:SECRET-${key}`, publicKey: `ed25519:PUBLIC-${key}` });
  const list = ["alice", "bob", "carol", "seller", "merchant", "anychain", "shopper", "platform"].map((k) => account(k, `role of ${k}`));
  const stack = {
    opts: { intents: { mode: "live", payout: "northwind-usdc.near", senders: [], rpcUrl: null } },
    urls: { dashboard: "http://localhost:3210", node: "http://127.0.0.1:4210", signer: "http://127.0.0.1:4211", services: "http://127.0.0.1:4212", remote: "http://127.0.0.1:4212/", relayer: "http://127.0.0.1:4213", rpc: "http://127.0.0.1:52000", oneclick: "" },
    paths: { logins: "/data/logins.txt", logs: "/data/logs" },
    accounts: { list, by: Object.fromEntries(list.map((a) => [a.key, a])), settler: "node.test.near", relayer: { accountId: "relayer.test.near", secretKey: "ed25519:SECRET-relayer" }, vendor: "newvendor.test.near", solver: "solver.test.near" },
    hub: { names: { hub: "hub.test.near", token: "usdc.test.near" } },
    setup: { link: { url: "http://localhost:3210/l/abc", slug: "abc" }, anyChain: null, merchant: { name: "Northwind Coffee" }, logins: [{ who: "Platform owner", email: "owner@payminto.local", password: "PASSWORD-1" }] },
    signerToken: "TOKEN-1",
    activity: {},
    oneclick: null,
    mainnetPayout: { exists: true, registered: false },
  } as unknown as Stack;
  const text = guide(stack).join("\n");

  it("says LIVE, names the payout account, and never offers the simulated buttons or the fake server", () => {
    expect(text).toContain("LIVE - real money on NEAR mainnet");
    expect(text).toContain("northwind-usdc.near");
    expect(text).toContain("https://1click.chaindefuser.com");
    expect(text).not.toContain("Simulate deposit");
    expect(text).not.toContain("Send too little");
    expect(text).not.toContain("solver.test.near");
    expect(text).not.toContain("anychain.test.near");
    expect(text).toContain("docs/LIVE_RUN.md");
  });

  it("explains how the node checks a live delivery: INTENTS_DELIVERY_SENDERS and the provider_only fallback", () => {
    expect(text).toContain("--intents-senders");
    expect(text).toContain("INTENTS_DELIVERY_SENDERS");
    expect(text).toContain("provider_only");
    expect(text).toMatch(/10 minutes/);
  });

  it("says what the payout account needs, read from NEAR mainnet", () => {
    expect(text).toContain("northwind-usdc.near exists on NEAR mainnet and is not registered with USDC yet");
  });

  it("keeps every step saying what to do and what to see, with no password, key, token or em dash", () => {
    const bodies = text.split(/\n\s+\d+\. /).slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(6);
    for (const b of bodies) expect(b).toMatch(/See /);
    expect(text).not.toContain("PASSWORD-1");
    expect(text).not.toContain("SECRET-");
    expect(text).not.toContain("TOKEN-1");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
