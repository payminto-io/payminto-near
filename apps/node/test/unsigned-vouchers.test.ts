/**
 * A voucher that is not signed by its Budget's agent key is nobody's refusal: the node answers with a plain error,
 * rate limits the sender, and records nothing in the owner's name (no denial row, no event, no webhook).
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { SCHEME, X402_VERSION, sha256Text, type Policy } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, SELLER, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;
const tmp = tempDir("payminto-unsigned-");
let chain: FakeChain;
let node: ClearingNode;
let receiver: Server;
const received: string[] = [];
let budget: OpenedBudget;
let seller: { id: string; apiKey: string };

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

/** Posts a voucher as the seller. `signer` null sends a well-formed signature nobody made. */
async function post(o: { budgetId?: string; amount?: bigint; cumulative?: bigint; request?: string; signer?: ReturnType<typeof testKey> | null }) {
  const budgetId = o.budgetId ?? budget.id;
  const amount = o.amount ?? PRICE;
  const cumulative = o.cumulative ?? amount;
  const requestHash = sha256Text(o.request ?? `req-${Math.random()}`);
  const signature = o.signer === null ? "11".repeat(64) : signVoucher(chain, o.signer ?? budget.agent, { budgetId, payee: SELLER, amount, cumulative, requestHash });
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${seller.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: chain.network, providerId: seller.id, requestHash, payload: { budgetId, payee: SELLER, amount: amount.toString(), cumulative: cumulative.toString(), signature, requestHash } }),
  });
  return { status: r.status, json: (await r.json()) as any, headers: r.headers };
}

const denialRows = () => node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM denials")!.n;
const deniedEvents = () => node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'call.denied'")!.n;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  chain = startFakeChain();
  node = await startNode(
    testConfig({
      dbPath: tmp.dbPath,
      adminToken: ADMIN,
      rateLimit: { provider: { rps: 200, burst: 1000 }, ip: { rps: 100, burst: 1000 }, unsigned: { rps: 1, burst: 8 } },
      gateway: { seedPayout: null, platformName: "Alerts", feeRecipient: null, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000 },
    }),
    { chain, logger: silentLogger, port: 0, workers: false },
  );
  const ep = await admin("POST", "/v1/platform/webhooks", { url: `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hooks`, events: ["budget.refused"] });
  expect(ep.status).toBe(201);
  const policy: Policy = { perCallCap: "5000", dailyCap: "10000000", maxCallsPerMinute: 0, purpose: "unsigned" };
  budget = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(1), { policy });
  const p = await admin("POST", "/v1/providers", { name: "seller", payee: SELLER, priceAtomic: PRICE.toString(), resource: "https://seller.example/api" });
  expect(p.status).toBe(201);
  seller = p.json;
});

afterAll(async () => {
  await node?.stop();
  await new Promise<void>((r) => receiver.close(() => r()));
  tmp.cleanup();
});

describe("vouchers not signed by the Budget's agent key", () => {
  it("records nothing and alerts nobody, whichever rule the forged fields would break", async () => {
    const attempts = [
      // Would be PRICE_MISMATCH, PER_CALL_CAP and STALE_CUMULATIVE if the fields were believed.
      await post({ signer: null, amount: 999n }),
      await post({ signer: null, amount: 9_999n }),
      await post({ signer: null, cumulative: 77n }),
      // Signed, but by a key that is not this Budget's agent.
      await post({ signer: testKey(9) }),
      await post({ signer: testKey(9), amount: 123n }),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(402);
      expect(r.json).toEqual({ error: { code: "BAD_SIGNATURE", message: "Voucher is not signed by the Budget agent" } });
    }
    // A Budget this node does not know has no agent key to check against: the same plain answer, nothing recorded.
    const unknown = await post({ signer: null, budgetId: "ab".repeat(32) });
    expect(unknown.status).toBe(402);
    expect(unknown.json).toEqual({ error: { code: "UNKNOWN_BUDGET", message: "No open Budget with this id on this node" } });

    expect(denialRows()).toBe(0);
    expect(deniedEvents()).toBe(0);
    await node.services.gateway!.webhooks.tick();
    expect(received).toHaveLength(0);
    expect((await admin("GET", `/v1/budgets/${budget.id}`)).json.denials).toEqual([]);
  });

  it("still records a refusal of a voucher the agent did sign, and sends its webhook", async () => {
    const r = await post({ amount: 999n });
    expect(r.status).toBe(402);
    expect(r.json.refusal).toMatchObject({ rule: "PRICE_MISMATCH", attemptedAmount: "999" });
    expect(denialRows()).toBe(1);
    await node.services.gateway!.webhooks.tick();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toMatchObject({ type: "budget.refused", data: { object: { rule: "PRICE_MISMATCH", budget_id: budget.id } } });
  });

  it("rate limits unsigned vouchers per provider key without slowing signed ones", async () => {
    // The burst of 8 is partly spent by the six unsigned vouchers above; a flood runs into 429 quickly.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post({ signer: null })).status);
    expect(statuses.filter((s) => s === 402).length).toBeLessThanOrEqual(8);
    expect(statuses.at(-1)).toBe(429);
    const limited = await post({ signer: null });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.json.error).toMatchObject({ code: "RATE_LIMITED", details: { scope: "unsigned" } });
    // The agent's own calls are untouched by the flood.
    const ok = await post({});
    expect(ok.status).toBe(200);
    expect(denialRows()).toBe(1);
    const metrics = await (await fetch(`${node.url}/metrics`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
    expect(metrics).toMatch(/^payminto_unsigned_vouchers_total\{reason="BAD_SIGNATURE"\} \d+$/m);
    expect(metrics).toMatch(/^payminto_rate_limited_total\{scope="unsigned"\} \d+$/m);
  });
});
