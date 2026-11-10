import { describe, expect, it } from "vitest";
import { guide } from "../src/guide.ts";
import type { Stack } from "../src/stack.ts";

describe("the printed guide", () => {
  const account = (key: string, role: string) => ({ key, role, does: `does ${key}`, near: 1, usdc: 0n, accountId: `${key}.test.near`, secretKey: `ed25519:SECRET-${key}`, publicKey: `ed25519:PUBLIC-${key}` });
  const list = ["alice", "bob", "carol", "seller", "merchant", "anychain", "shopper", "platform"].map((k) => account(k, `role of ${k}`));
  const stack = {
    urls: { dashboard: "http://localhost:3210", node: "http://127.0.0.1:4210", signer: "http://127.0.0.1:4211", services: "http://127.0.0.1:4212", remote: "http://127.0.0.1:4212/", relayer: "http://127.0.0.1:4213", rpc: "http://127.0.0.1:52000", oneclick: "http://127.0.0.1:53000" },
    paths: { logins: "/data/logins.txt", logs: "/data/logs" },
    accounts: { list, by: Object.fromEntries(list.map((a) => [a.key, a])), settler: "node.test.near", relayer: { accountId: "relayer.test.near", secretKey: "ed25519:SECRET-relayer" }, vendor: "newvendor.test.near", solver: "solver.test.near" },
    hub: { names: { hub: "hub.test.near", token: "usdc.test.near" } },
    setup: { link: { url: "http://localhost:3210/l/abc", slug: "abc" }, anyChain: { account: "anychain.test.near", link: { url: "http://localhost:3210/l/def", slug: "def" } }, merchant: { name: "Northwind Coffee" }, logins: [{ who: "Platform owner", email: "owner@payminto.local", password: "PASSWORD-1" }] },
    signerToken: "TOKEN-1",
    activity: {},
  } as unknown as Stack;
  const text = guide(stack).join("\n");

  it("says where everything is and who is who", () => {
    for (const url of Object.values(stack.urls)) expect(text).toContain(url);
    expect(text).toContain("/data/logins.txt");
    for (const a of list) expect(text).toContain(a.accountId);
    expect(text).toContain("node.test.near");
    expect(text).toContain("solver.test.near");
    expect(text).toContain("Simulated - no real money");
    expect(text).toContain("DEVELOPMENT ONLY");
  });

  it("has six to eleven numbered steps, each saying what to do and what to see", () => {
    const steps = text.split("\n").filter((l) => /^\s+\d+\. /.test(l));
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.length).toBeLessThanOrEqual(11);
    const bodies = text.split(/\n\s+\d+\. /).slice(1);
    for (const b of bodies) expect(b).toMatch(/See /);
  });

  it("prints no password, key or token, and no em dash", () => {
    expect(text).not.toContain("PASSWORD-1");
    expect(text).not.toContain("SECRET-");
    expect(text).not.toContain("TOKEN-1");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
