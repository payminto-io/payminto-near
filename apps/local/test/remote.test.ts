import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { REMOTE_PAGE } from "../src/remote-page.ts";
import { remoteApp, type RemoteOptions } from "../src/remote.ts";

const BUDGET = "ab".repeat(32);
const HOST = "127.0.0.1:4212";

function app(over: Partial<RemoteOptions> = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const owner = {
    get: async () => [{ id: BUDGET, label: "Research agent", status: "open", owner: "alice.test.near", agent: "ed25519:held", cap: "25000000", escrow: null, policy: { perCallCap: "50000" }, payees: ["bob.test.near"] }],
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { approval: { decision: "approve", payee: "newvendor.test.near" } };
    },
  };
  const desk = { holds: (pk: string) => pk === "ed25519:held", keys: () => [{ name: "Spare key 1", keypair: { publicKey: "ed25519:spare" } }], call: async () => ({ ok: true, url: "u", status: 200, priceAtomic: "2000", callId: "cd".repeat(32), body: {} }) };
  const a = remoteApp({
    services: new Hono(),
    desk: desk as never,
    owner: owner as never,
    urls: { dashboard: "http://localhost:3210", services: "http://127.0.0.1:4212" },
    list: () => [{ id: "prv_1", key: "quotes", name: "Bob's Quotes", url: "http://127.0.0.1:4212/svc/quotes/v1/quote", priceAtomic: 2_000n, payee: "bob.test.near", note: "n", description: "d", path: "/svc/quotes/v1/quote", category: "data" }],
    first: () => [BUDGET],
    accounts: { settler: "node.test.near" } as never,
    port: 4212,
    ...over,
  });
  const call = (path: string, o: { body?: unknown; origin?: string; host?: string; type?: string } = {}) =>
    a.request(`http://${HOST}${path}`, { method: o.body === undefined ? "GET" : "POST", headers: { host: o.host ?? HOST, ...(o.origin ? { origin: o.origin } : {}), ...(o.body === undefined ? {} : { "content-type": o.type ?? "application/json" }) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { call, posts };
}

describe("the agent remote's page", () => {
  it("has a script that parses, and says what it is", () => {
    const script = REMOTE_PAGE.split("<script>")[1]!.split("</script>")[0]!;
    // A quoting slip in the page's own script leaves a page that only ever says "Loading".
    expect(() => new Function(script)).not.toThrow();
    expect(REMOTE_PAGE).toContain("Local development tool");
    expect(REMOTE_PAGE).toContain("Nothing here reaches a public network");
    expect(REMOTE_PAGE).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the agent remote's routes", () => {
  it("lists the Budgets whose key it holds, the spare keys and the services, and no secret", async () => {
    const { call } = app();
    const res = await call("/remote/state");
    const body = (await res.json()) as { budgets: Array<{ id: string; label: string }>; spareKeys: Array<{ publicKey: string }>; services: Array<{ name: string; priceAtomic: string }> };
    expect(body.budgets).toEqual([expect.objectContaining({ id: BUDGET, label: "Research agent", perCallCap: "50000" })]);
    expect(body.spareKeys).toEqual([{ name: "Spare key 1", publicKey: "ed25519:spare" }]);
    expect(body.services[0]).toMatchObject({ name: "Bob's Quotes", priceAtomic: "2000" });
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  it("makes a call only from its own page, with JSON, for a Budget it holds", async () => {
    const { call } = app();
    const ok = await call("/remote/call", { body: { budgetId: BUDGET, serviceId: "prv_1", guard: false }, origin: "http://127.0.0.1:4212" });
    expect(await ok.json()).toMatchObject({ ok: true, priceAtomic: "2000" });
    expect((await call("/remote/call", { body: { budgetId: BUDGET, serviceId: "prv_1" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/remote/call", { body: { budgetId: BUDGET, serviceId: "prv_1" }, type: "text/plain" })).status).toBe(400);
    expect((await call("/remote/call", { body: { budgetId: "cd".repeat(32), serviceId: "prv_1" } })).status).toBe(404);
    expect((await call("/remote/call", { body: { budgetId: BUDGET, serviceId: "prv_unknown" } })).status).toBe(400);
    expect((await call("/remote/state", { host: "remote.evil.example" })).status).toBe(403);
  });

  it("leaves approving a payee to its owner: the agent remote has no route that approves", async () => {
    // An agent's runtime must never be able to approve a payee for itself; the owner does it on the Budget's page.
    const { call, posts } = app();
    expect((await call("/remote/approve", { body: { budgetId: BUDGET, payee: "newvendor.test.near" }, origin: "http://localhost:4212" })).status).toBe(404);
    expect(posts).toHaveLength(0);
  });
});
