/**
 * Merchant AI agents end to end (docs/AGENTS.md section 8): anvil with the gateway contracts, the node in-process on
 * a temp SQLite file with background workers off (the agent worker is driven by the test, or started where a test
 * needs it), and a scripted model in place of a provider. Covers the connections API and roles, keys never leaking,
 * agents and their validation, runs with long-poll, steps, cancel and idempotency, the worker (exclusive claims under
 * two workers, lease expiry, Retry-After, non-retryable failures and connection invalidation, timeout, cancel mid-run,
 * per-business concurrency, token limit, idempotent tool effects on retry), an ops run on the real merchant tools,
 * paid skills (402, pay, 202, poll with the result token, refusal before payment), webhooks and the event stream.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { maxUint256, type Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { depositFactoryAbi, depositFactoryBytecode, newRefundId, paymentRouterAbi, paymentRouterBytecode, payoutChangeMessage } from "@payminto/protocol";
import { ModelError, type VerifyResult } from "@payminto/models";
import { AgentClient, OwnerClient } from "@payminto/sdk";
import { startNode, type ClearingNode } from "../src/server.ts";
import { createLogger } from "../src/logger.ts";
import type { AgentsConfig, GatewayConfig } from "../src/config.ts";
import { Database } from "../src/db/database.ts";
import { EventBus } from "../src/events.ts";
import { AgentService } from "../src/agents/agents.ts";
import { ConnectionService } from "../src/agents/connections.ts";
import type { ModelLayer } from "../src/agents/models.ts";
import { RUN_SCOPED_PERMISSIONS } from "../src/agents/ops-tools.ts";
import type { RunRow } from "../src/agents/rows.ts";
import { RunService } from "../src/agents/runs.ts";
import { reencryptSecrets } from "../src/agents/rotate.ts";
import { SecretBox } from "../src/agents/secrets.ts";
import { AgentWorker } from "../src/agents/worker.ts";
import { scriptedModel, type ScriptStep } from "./scripted-model.ts";
import { ANVIL_KEYS, deployClearing, freePort, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const USDC = 1_000_000n;
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const BUYER = privateKeyToAccount(ANVIL_KEYS[4]);
const PAYOUT_B = privateKeyToAccount(ANVIL_KEYS[5]);
const PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]);
const FEES = privateKeyToAccount(ANVIL_KEYS[7]).address;
const PW = "purple-otter-sings-at-dawn";
const SECRETS_KEY = randomBytes(32).toString("base64");
/** Every model key used here; none may ever show up in a response, log, audit entry, event or error. */
const MODEL_KEYS = {
  main: "sk-ant-test-main-0123456789abcdefSECRET",
  rotated: "sk-ant-test-rotated-0123456789abcdefSECRET",
  second: "sk-ant-test-second-0123456789abcdefSECRET",
  other: "sk-ant-test-business-b-0123456789SECRET",
  limit: "sk-ant-test-limit-0123456789abcdefSECRET",
};

let anvil: Anvil;
let node: ClearingNode;
let hub: Address;
let token: Address;
const tmp = tempDir("payminto-agents-");
const logs: string[] = [];
/** Every response body seen by the test, for the key grep. */
const responses: string[] = [];

// ---------------------------------------------------------------------------------------------------------------------
// The scripted model in place of a provider

let script = scriptedModel([]);
let verifyResult: VerifyResult = { ok: true, models: ["claude-test-1", "claude-test-2"] };
const models: Partial<ModelLayer> = {
  createModelClient: (c) => ({ provider: c.provider, model: c.model, turn: (r, o) => script.turn(r, o) }),
  verifyConnection: async () => verifyResult,
  listModels: async () => ["claude-test-1", "claude-test-2"],
};
const play = (...steps: ScriptStep[]) => (script = scriptedModel(steps));
/** A turn that waits until it is released or aborted. */
function gate() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { step: (async () => (await p, { text: "released" })) as ScriptStep, release };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// HTTP

type Res = { status: number; json: any; text: string; headers: Headers };

async function call(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Res> {
  const res = await fetch(`${node.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, text, headers: res.headers };
}
const api = (method: string, path: string, body?: unknown, auth = keyA, headers: Record<string, string> = {}) => call(method, path, body, { authorization: `Bearer ${auth}`, ...headers });

/** A browser with the session cookie and CSRF token, sending the dashboard Origin. */
class Browser {
  cookie: string | null = null;
  csrf: string | null = null;
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { "content-type": "application/json", origin: "http://localhost:3000", ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== "GET") h["x-payminto-csrf"] = this.csrf;
    const res = await fetch(`${node.url}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      if (kv!.slice(0, i) === "pm_session") this.cookie = kv!.slice(i + 1) ? kv! : null;
    }
    const text = await res.text();
    responses.push(text);
    const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
    if (json && typeof json === "object" && json.csrf_token) this.csrf = json.csrf_token;
    return { status: res.status, json, text, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
}

async function member(merchantId: string, email: string, role: "admin" | "staff" | "viewer"): Promise<Browser> {
  const inv = await api("POST", "/v1/invites", { emails: [email], role }, ADMIN, { "merchant-id": merchantId });
  expect(inv.status).toBe(201);
  const b = new Browser();
  const acc = await b.post("/v1/invites/accept", { token: inv.json.items[0].link.split("/").pop(), name: email.split("@")[0], password: PW });
  expect(acc.status).toBe(200);
  await b.get("/v1/auth/session");
  return b;
}

// ---------------------------------------------------------------------------------------------------------------------
// Worker helpers

const agents = () => node.services.agents!;
const worker = () => agents().worker!;
const run = (id: string) => agents().runs.row(id)!;
const steps = (id: string) => agents().runs.events(id, 0);

/** Ticks the worker until the run is finished. */
async function drain(id: string, ms = 15_000): Promise<RunRow> {
  const deadline = Date.now() + ms;
  for (;;) {
    await worker().tick();
    await worker().idle();
    const r = run(id);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(r.status)) return r;
    if (Date.now() > deadline) throw new Error(`run ${id} still ${r.status}`);
    await sleep(25);
  }
}

let merchantA = "";
let merchantB = "";
let keyA = "";
let keyB = "";
let admin: Browser;
let staff: Browser;
let viewer: Browser;
let connA = "";
let opsAgent = "";

const agentsConfig: AgentsConfig = {
  enabled: true,
  secretsKeys: { 1: SECRETS_KEY },
  secretsKeyVersion: 1,
  usingDevKey: false,
  allowPrivateModelUrls: false,
  workers: 2,
  maxPerMerchant: 1,
  pollMs: 50,
  idlePollMs: 100,
  leaseMs: 2_000,
  heartbeatMs: 100,
  retryDelaysMs: [50, 100, 150],
  skillWaitMs: 400,
};

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  const factory = await anvil.deploy(depositFactoryAbi as Abi, depositFactoryBytecode);
  const router = await anvil.deploy(paymentRouterAbi as Abi, paymentRouterBytecode);
  const gateway: GatewayConfig = {
    seedPayout: PAYOUT.address,
    platformName: "Acme Store",
    feeRecipient: FEES,
    paymentRouter: router,
    checkoutBaseUrl: "http://localhost:3000",
    depositFactory: factory,
    depositFactoryBlock: 0n,
    forwarderImplementation: null,
    checkoutTtlSec: 1800,
    webhookAllowPrivate: true,
    watchIntervalMs: 2000,
    screenMinPayerNonce: 0,
  };
  const port = await freePort();
  node = await startNode(
    testConfig({
      rpcUrl: anvil.rpcUrl,
      hub,
      token,
      dbPath: tmp.dbPath,
      adminToken: ADMIN,
      gateway,
      port,
      publicUrl: `http://127.0.0.1:${port}`,
      auth: { scryptLogN: 12, rateLimitPerMin: 10_000, setupPerMin: 10_000, emailPerHour: 10_000, searchRps: 1_000, breakGlass: true },
      agents: agentsConfig,
    }),
    { logger: createLogger({ level: "debug", sink: (l) => logs.push(l) }), port, workers: false, models },
  );
  merchantA = (await api("GET", "/v1/merchant", undefined, ADMIN)).json.id;
  keyA = (await api("POST", "/v1/api-keys", { name: "automation" }, ADMIN)).json.secret;
  const ts = Math.floor(Date.now() / 1000);
  const b = await api("POST", "/v1/merchants", {
    name: "Beta Shop",
    payout: { payout: PAYOUT_B.address, timestamp: ts, signature: await PAYOUT_B.signMessage({ message: payoutChangeMessage("new", PAYOUT_B.address, ts, { chainId: 31337, hub }) }) },
  }, ADMIN);
  expect(b.status).toBe(201);
  merchantB = b.json.id;
  keyB = (await api("POST", "/v1/api-keys", { name: "beta" }, ADMIN, { "merchant-id": merchantB })).json.secret;
  admin = await member(merchantA, "admin@acme.test", "admin");
  staff = await member(merchantA, "staff@acme.test", "staff");
  viewer = await member(merchantA, "viewer@acme.test", "viewer");
}, 120_000);

afterAll(async () => {
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
});

// ---------------------------------------------------------------------------------------------------------------------

describe("AI connections", () => {
  it("lists the providers to any member", async () => {
    const r = await viewer.get("/v1/ai/providers");
    expect(r.status).toBe(200);
    expect(r.json.items.map((p: { id: string }) => p.id)).toEqual(["anthropic", "openai", "google", "openai_compatible", "replicate"]);
  });

  it("lets only Admins create one; it is verified, sealed, and shown with the key's last 4 characters only", async () => {
    expect((await viewer.post("/v1/ai/connections", { provider: "anthropic", label: "x", api_key: MODEL_KEYS.main, default_model: "claude-test-1" })).json.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await staff.post("/v1/ai/connections", { provider: "anthropic", label: "x", api_key: MODEL_KEYS.main, default_model: "claude-test-1" })).status).toBe(403);
    const r = await admin.post("/v1/ai/connections", { provider: "anthropic", label: "Team Claude", api_key: MODEL_KEYS.main, default_model: "claude-test-1", monthly_token_limit: 5_000_000 });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      object: "ai_connection",
      merchant_id: merchantA,
      provider: "anthropic",
      label: "Team Claude",
      key_hint: "CRET",
      status: "active",
      last_error: null,
      monthly_token_limit: 5_000_000,
      usage_this_month: { total_tokens: 0, runs: 0 },
      verification: { ok: true, models: ["claude-test-1", "claude-test-2"] },
    });
    expect(r.json.verified_at).toBeTruthy();
    connA = r.json.id;
    const row = node.services.db.get<Record<string, unknown>>("SELECT * FROM ai_connections WHERE id = ?", connA)!;
    expect(JSON.stringify(row)).not.toContain("0123456789abcdef");
    expect(row.key_version).toBe(1);
    expect(agents().connections.spec(agents().connections.row(connA)!).apiKey).toBe(MODEL_KEYS.main);
    // Viewers and Staff see label, provider, model, status and usage.
    const list = await viewer.get("/v1/ai/connections");
    expect(list.json.items.map((c: { id: string }) => c.id)).toEqual([connA]);
    expect((await viewer.get(`/v1/ai/connections/${connA}/models`)).json.items).toEqual(["claude-test-1", "claude-test-2"]);
    // Another business's key sees none of it.
    expect((await api("GET", "/v1/ai/connections", undefined, keyB)).json.items).toEqual([]);
    expect((await api("GET", `/v1/ai/connections/${connA}`, undefined, keyB)).status).toBe(404);
    const audit = node.services.db.get<{ meta_json: string }>("SELECT meta_json FROM audit_events WHERE action = 'ai_connection.created' AND target = ?", connA)!;
    expect(JSON.parse(audit.meta_json)).toMatchObject({ provider: "anthropic", label: "Team Claude" });
  });

  it("stores a rejected key as invalid, re-verifies on rotate, and audits create, rotate, disable and delete", async () => {
    verifyResult = { ok: false, error: new ModelError("auth", "Anthropic answered 401: invalid x-api-key sk-ant-test-second-0123456789abcdefSECRET", { status: 401 }) };
    const bad = await api("POST", "/v1/ai/connections", { provider: "anthropic", label: "Second", api_key: MODEL_KEYS.second, default_model: "claude-test-1" });
    expect(bad.status).toBe(201);
    expect(bad.json).toMatchObject({ status: "invalid", verified_at: null, verification: { ok: false, error: { kind: "auth", status: 401 } } });
    expect(bad.json.last_error).toContain("[key]");
    verifyResult = { ok: true, models: null };
    const rotated = await api("PATCH", `/v1/ai/connections/${bad.json.id}`, { api_key: MODEL_KEYS.rotated });
    expect(rotated.json).toMatchObject({ status: "active", key_hint: "CRET", last_error: null, verification: { ok: true } });
    expect(rotated.json.rotated_at).toBeTruthy();
    expect(agents().connections.spec(agents().connections.row(bad.json.id)!).apiKey).toBe(MODEL_KEYS.rotated);
    expect((await api("PATCH", `/v1/ai/connections/${bad.json.id}`, { status: "disabled" })).json.status).toBe("disabled");
    expect((await api("POST", `/v1/ai/connections/${bad.json.id}/verify`)).json).toMatchObject({ status: "disabled", verification: { ok: true } });
    expect((await api("DELETE", `/v1/ai/connections/${bad.json.id}`)).json).toEqual({ id: bad.json.id, deleted: true });
    expect((await api("GET", `/v1/ai/connections/${bad.json.id}`)).status).toBe(404);
    const wiped = node.services.db.get<{ key_ciphertext: string }>("SELECT key_ciphertext FROM ai_connections WHERE id = ?", bad.json.id)!;
    expect(wiped.key_ciphertext).toBe("");
    const actions = node.services.db.all<{ action: string }>("SELECT action FROM audit_events WHERE target = ? ORDER BY id", bad.json.id).map((a) => a.action);
    expect(actions).toEqual(["ai_connection.created", "ai_connection.rotated", "ai_connection.disabled", "ai_connection.verified", "ai_connection.deleted"]);
  });

  it("puts base URLs through the SSRF guard unless private model URLs are allowed", async () => {
    for (const base_url of ["http://127.0.0.1:11434/v1", "https://localhost/v1", "https://10.0.0.5/v1"]) {
      const r = await api("POST", "/v1/ai/connections", { provider: "openai_compatible", label: "Local", base_url, default_model: "llama" });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: "BASE_URL_REJECTED", details: { hint: expect.stringMatching(/AGENT_ALLOW_PRIVATE_MODEL_URLS/) } });
    }
    expect((await api("POST", "/v1/ai/connections", { provider: "openai_compatible", label: "No URL", default_model: "llama" })).json.error.code).toBe("VALIDATION_ERROR");
    expect((await api("POST", "/v1/ai/connections", { provider: "openai", label: "No key", default_model: "gpt-5.1" })).json.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("agents", () => {
  it("creates ops agents (Admins), validates each kind, and appends instructions to the built-in prompt", async () => {
    expect((await staff.post("/v1/agents", { kind: "ops", name: "Desk", connection_id: connA })).status).toBe(403);
    const r = await admin.post("/v1/agents", { kind: "ops", name: "Back office", connection_id: connA, instructions: "Always answer in British English." });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      object: "agent",
      kind: "ops",
      model: "claude-test-1",
      status: "active",
      tools: ["get_overview", "list_payments", "get_payment", "create_link", "request_refund", "get_reconciliation", "list_blocked"],
      limits: { max_turns: 12, max_output_tokens: 20_000, timeout_seconds: 180 },
      skill: null,
      last_run: null,
      connection: { label: "Team Claude", provider: "anthropic", status: "active" },
    });
    opsAgent = r.json.id;
    const bad = async (b: Record<string, unknown>) => (await api("POST", "/v1/agents", { name: "X", connection_id: connA, ...b })).json.error.code;
    expect(await bad({ kind: "ops", slug: "nope" })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "ops", tools: ["approve_refund"] })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "skill", slug: "brief" })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "skill", slug: "brief", price: "0" })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "skill", slug: "Bad Slug", price: "10" })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "skill", slug: "brief", price: "10", tools: ["get_overview"] })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "ops", connection_id: "aic_aaaaaaaaaaaaaaaaaaaaaaaa" })).toBe("UNKNOWN_CONNECTION");
    expect((await api("GET", `/v1/agents/${opsAgent}`, undefined, keyB)).status).toBe(404);
    // Deleting a connection an active agent uses is refused.
    const del = await api("DELETE", `/v1/ai/connections/${connA}`);
    expect(del.status).toBe(409);
    expect(del.json.error).toMatchObject({ code: "CONNECTION_IN_USE", details: { agents: [{ id: opsAgent, name: "Back office" }] } });
  });
});

describe("runs", () => {
  it("Staff start runs, Viewers cannot; an Idempotency-Key replays the first run", async () => {
    expect((await viewer.post(`/v1/agents/${opsAgent}/runs`, { input: "hello" })).status).toBe(403);
    const r = await staff.post(`/v1/agents/${opsAgent}/runs`, { input: "How much did we earn?" });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ object: "agent_run", trigger: "dashboard", status: "queued", attempt: 0, max_attempts: 3, cancel_requested: false, result: null });
    // A queued run is cancelled at once.
    const c = await staff.post(`/v1/agent-runs/${r.json.id}/cancel`);
    expect(c.json).toMatchObject({ status: "cancelled", error_code: "CANCELLED" });
    expect((await viewer.post(`/v1/agent-runs/${r.json.id}/cancel`)).status).toBe(403);
    const a = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "same" }, keyA, { "idempotency-key": "k-1" });
    const b = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "same" }, keyA, { "idempotency-key": "k-1" });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.json.id).toBe(a.json.id);
    expect(a.json.trigger).toBe("api");
    expect((await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "different" }, keyA, { "idempotency-key": "k-1" })).json.error.code).toBe("IDEMPOTENCY_MISMATCH");
    await api("POST", `/v1/agent-runs/${a.json.id}/cancel`);
    const list = await viewer.get(`/v1/agent-runs?agent_id=${opsAgent}&status=cancelled&limit=1`);
    expect(list.json.items).toHaveLength(1);
    expect(list.json.next_cursor).toBeTruthy();
    expect((await viewer.get(`/v1/agent-runs?agent_id=${opsAgent}&status=cancelled&cursor=${list.json.next_cursor}`)).json.items).toHaveLength(1);
    expect((await api("GET", `/v1/agent-runs/${a.json.id}`, undefined, keyB)).status).toBe(404);
  });

  it("an ops run calls the real merchant tools in-process with a run-scoped key, step by step", async () => {
    play(
      { text: "Let me look.", toolCalls: [{ name: "get_overview", input: {} }] },
      { toolCalls: [{ name: "create_link", input: { title: "Consulting hour", amount: "12.50" } }] },
      { text: "This month: 0 payments. Your link is ready.", usage: { inputTokens: 900, outputTokens: 40 } },
    );
    const r = await staff.post(`/v1/agents/${opsAgent}/runs`, { input: "How are we doing, and make me a 12.50 consulting link" });
    // Long-poll while it runs: the status changes from queued.
    const waiting = staff.get(`/v1/agent-runs/${r.json.id}?wait=5`);
    const done = await drain(r.json.id);
    expect((await waiting).json.status).not.toBe("queued");
    expect(done.status).toBe("succeeded");
    const view = (await viewer.get(`/v1/agent-runs/${r.json.id}?wait=1`)).json;
    expect(view).toMatchObject({
      status: "succeeded",
      attempt: 1,
      result: { answer: "This month: 0 payments. Your link is ready.", data: { turns: 3, tool_calls: 2 } },
      usage: { input_tokens: 1100, output_tokens: 140, model: "scripted-stand-in", provider: "anthropic" },
      error_code: null,
    });
    // The model saw the built-in prompt with the business's instructions after it, and the real tool results.
    const req = script.requests[0]!;
    expect(req.system).toMatch(/^You are the back-office assistant/);
    expect(req.system).toMatch(/Instructions from the business[^\n]*\nAlways answer in British English\.$/);
    expect(req.tools.map((t) => t.name)).toContain("request_refund");
    expect(req.tools.find((t) => t.name === "create_link")!.inputSchema).toMatchObject({ type: "object", required: ["title", "amount"] });
    const linkResult = script.requests[2]!.messages.at(-1)!.parts[0] as { type: string; content: string; isError: boolean };
    expect(linkResult).toMatchObject({ type: "tool_result", isError: false });
    expect(linkResult.content).toMatch(/^Created the payment link "Consulting hour" for 12.50 USDC: http/);
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payment_links WHERE title = 'Consulting hour'")!.n).toBe(1);
    const s = (await viewer.get(`/v1/agent-runs/${r.json.id}/events`)).json;
    expect(s.items.map((e: { type: string }) => e.type)).toEqual(["started", "model_turn", "tool_call", "tool_result", "model_turn", "tool_call", "tool_result", "model_turn", "finished"]);
    expect(s.items[2].data).toMatchObject({ ordinal: 1, name: "get_overview", input: {} });
    expect(s.items[3].data).toMatchObject({ ordinal: 1, is_error: false, summary: expect.stringMatching(/^Acme Store from/) });
    const after = (await viewer.get(`/v1/agent-runs/${r.json.id}/events?after=7`)).json;
    expect(after.items.map((e: { seq: number }) => e.seq)).toEqual([8, 9]);
    // The run's key is revoked, never listed, and could never approve refunds.
    const keys = node.services.db.all<{ revoked_at: string | null; permissions: string; agent_run_id: string }>("SELECT revoked_at, permissions, agent_run_id FROM api_keys WHERE agent_run_id = ?", r.json.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.revoked_at).toBeTruthy();
    expect(JSON.parse(keys[0]!.permissions)).toEqual(["payments.read", "links.write", "refunds.request", "screening.read"]);
    const listed = (await api("GET", "/v1/api-keys", undefined, ADMIN, { "merchant-id": merchantA })).json.items;
    expect(listed.every((k: { name: string }) => !k.name?.startsWith("agent run"))).toBe(true);
    expect((await viewer.get(`/v1/agents/${opsAgent}`)).json.last_run).toMatchObject({ id: r.json.id, status: "succeeded" });
  });

  it("a run-scoped key reads payments and requests refunds but never approves, issues or creates payments", async () => {
    const k = agents().gateway.keys.createRunScoped(merchantA, "run_test", RUN_SCOPED_PERMISSIONS, new Date(Date.now() + 60_000));
    expect((await api("GET", "/v1/payments", undefined, k.secret)).status).toBe(200);
    expect((await api("POST", "/v1/payments", { amount: "1000" }, k.secret)).json.error).toMatchObject({ code: "FORBIDDEN", details: { permission: "payments.write" } });
    expect((await api("POST", `/v1/refunds/${newRefundId()}/approve`, {}, k.secret)).json.error).toMatchObject({ code: "FORBIDDEN", details: { permission: "refunds.approve" } });
    expect((await api("POST", "/v1/webhooks", { url: "http://127.0.0.1:9/x", events: ["*"] }, k.secret)).status).toBe(403);
    const expired = agents().gateway.keys.createRunScoped(merchantA, "run_test2", RUN_SCOPED_PERMISSIONS, new Date(Date.now() - 1));
    expect((await api("GET", "/v1/payments", undefined, expired.secret)).status).toBe(401);
    agents().gateway.keys.revokeRunScoped(k.id);
    expect((await api("GET", "/v1/payments", undefined, k.secret)).status).toBe(401);
  });

  it("a retry restarts the conversation but cannot create a second link (idempotent tool effects)", async () => {
    play(
      { toolCalls: [{ name: "create_link", input: { title: "Retry link", amount: "3" } }] },
      new ModelError("overloaded", "Anthropic answered 529: overloaded", { status: 529 }),
      { toolCalls: [{ name: "create_link", input: { title: "Retry link", amount: "3" } }] },
      { text: "Link made once." },
    );
    const r = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "make a 3 USDC link" });
    const done = await drain(r.json.id);
    expect(done).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payment_links WHERE title = 'Retry link'")!.n).toBe(1);
    const retry = steps(r.json.id).find((e) => e.type === "retry_scheduled")!;
    expect(retry.data).toMatchObject({ reason: "overloaded", status: 529 });
    const second = script.requests[3]!.messages.at(-1)!.parts[0] as { content: string; isError: boolean };
    expect(second.isError).toBe(false);
    expect(second.content).toMatch(/Retry link/);
  });

  it("honours Retry-After on a rate limit, then succeeds", async () => {
    play(new ModelError("rate_limit", "slow down", { status: 429, retryAfterMs: 400 }), { text: "ok" });
    const r = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "hi" });
    await worker().tick();
    await worker().idle();
    const queued = run(r.json.id);
    expect(queued).toMatchObject({ status: "queued", attempt: 1 });
    expect(queued.next_attempt_ms - Date.now()).toBeGreaterThan(250);
    expect(steps(r.json.id).at(-1)!.data).toMatchObject({ reason: "rate_limit", delay_ms: 400, retry_after_ms: 400 });
    await worker().tick();
    expect(run(r.json.id).status).toBe("queued");
    expect(await drain(r.json.id)).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("fails after max attempts with the last error", async () => {
    const busy = () => new ModelError("overloaded", "busy", { status: 503 });
    play(busy(), busy(), busy());
    const r = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "hi" });
    expect(await drain(r.json.id)).toMatchObject({ status: "failed", attempt: 3, error_code: "MODEL_OVERLOADED" });
    expect(steps(r.json.id).filter((e) => e.type === "retry_scheduled")).toHaveLength(2);
  });

  it("a rejected key fails at once, marks the connection invalid, and nothing retries; a bad request fails at once too", async () => {
    play(new ModelError("auth", `Anthropic answered 401: invalid x-api-key ${MODEL_KEYS.main}`, { status: 401 }));
    const r = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "hi" });
    const done = await drain(r.json.id);
    expect(done).toMatchObject({ status: "failed", attempt: 1, error_code: "MODEL_AUTH_FAILED" });
    expect(done.error_message).not.toContain("0123456789abcdef");
    expect(agents().connections.row(connA)!.status).toBe("invalid");
    // While invalid, new runs are refused before they queue.
    const refused = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "hi" });
    expect(refused.status).toBe(503);
    expect(refused.json.error).toMatchObject({ code: "MODEL_UNAVAILABLE", details: { reason: "connection_invalid" } });
    // Re-activating re-verifies.
    verifyResult = { ok: true, models: null };
    expect((await api("PATCH", `/v1/ai/connections/${connA}`, { status: "active" })).json.status).toBe("active");
    play(new ModelError("bad_request", "model not found", { status: 404 }));
    const b = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "hi" });
    expect(await drain(b.json.id)).toMatchObject({ status: "failed", attempt: 1, error_code: "MODEL_BAD_REQUEST" });
  });

  it("times out an attempt through its AbortSignal, and does not retry it", async () => {
    const g = gate();
    play(g.step);
    node.services.db.run("UPDATE agents SET timeout_seconds = 1 WHERE id = ?", opsAgent);
    const r = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "slow" });
    expect(await drain(r.json.id)).toMatchObject({ status: "timed_out", attempt: 1, error_code: "TIMEOUT" });
    node.services.db.run("UPDATE agents SET timeout_seconds = 180 WHERE id = ?", opsAgent);
    g.release();
  });

  it("cancels mid-run: the in-flight request is aborted at the next heartbeat", async () => {
    const g = gate();
    play(g.step);
    const r = await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "long task" });
    await worker().tick();
    for (let i = 0; i < 100 && script.requests.length === 0; i++) await sleep(10);
    expect(run(r.json.id).status).toBe("running");
    const c = await staff.post(`/v1/agent-runs/${r.json.id}/cancel`);
    expect(c.json).toMatchObject({ status: "running", cancel_requested: true });
    await worker().idle();
    expect(run(r.json.id)).toMatchObject({ status: "cancelled", error_code: "CANCELLED" });
    g.release();
  });

  it("runs at most one run per business at a time, so one busy business cannot starve another", async () => {
    const connB = (await api("POST", "/v1/ai/connections", { provider: "anthropic", label: "Beta", api_key: MODEL_KEYS.other, default_model: "claude-test-1" }, keyB)).json.id;
    const agentB = (await api("POST", "/v1/agents", { kind: "ops", name: "Beta desk", connection_id: connB }, keyB)).json.id;
    const g = gate();
    play(g.step, g.step, g.step);
    const a1 = (await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "a1" })).json.id;
    const a2 = (await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "a2" })).json.id;
    const b1 = (await api("POST", `/v1/agents/${agentB}/runs`, { input: "b1" }, keyB)).json.id;
    expect(await worker().tick()).toBe(2);
    expect([run(a1).status, run(a2).status, run(b1).status]).toEqual(["running", "queued", "running"]);
    g.release();
    await worker().idle();
    expect(await drain(a2)).toMatchObject({ status: "succeeded" });
    expect([run(a1).status, run(b1).status]).toEqual(["succeeded", "succeeded"]);
  });

  it("stops at the connection's monthly token limit, before starting and before queueing", async () => {
    const conn = (await api("POST", "/v1/ai/connections", { provider: "anthropic", label: "Capped", api_key: MODEL_KEYS.limit, default_model: "claude-test-1", monthly_token_limit: 200 })).json.id;
    const agent = (await api("POST", "/v1/agents", { kind: "ops", name: "Capped desk", connection_id: conn })).json.id;
    play({ text: "big answer", usage: { inputTokens: 150, outputTokens: 100 } });
    const r1 = (await api("POST", `/v1/agents/${agent}/runs`, { input: "one" })).json.id;
    const r2 = (await api("POST", `/v1/agents/${agent}/runs`, { input: "two" })).json.id;
    expect(await drain(r1)).toMatchObject({ status: "succeeded" });
    expect(await drain(r2)).toMatchObject({ status: "failed", error_code: "TOKEN_LIMIT_REACHED", attempt: 1 });
    const refused = await api("POST", `/v1/agents/${agent}/runs`, { input: "three" });
    expect(refused.json.error).toMatchObject({ code: "MODEL_UNAVAILABLE", details: { reason: "token_limit_reached" } });
    const usage = (await viewer.get(`/v1/ai/usage?month=${new Date().toISOString().slice(0, 7)}`)).json;
    expect(usage.connections.find((c: { connection_id: string }) => c.connection_id === conn)).toMatchObject({ total_tokens: 250, runs: 2, monthly_token_limit: 200 });
    expect(usage.agents.find((a: { agent_id: string }) => a.agent_id === agent)).toMatchObject({ input_tokens: 150, output_tokens: 100 });
    expect((await viewer.get(`/v1/ai/connections/${conn}`)).json.usage_this_month).toMatchObject({ total_tokens: 250 });
    expect((await api("PATCH", `/v1/agents/${agent}`, { status: "paused" })).json.status).toBe("paused");
  });

  it("counts cached prompt tokens toward usage and the monthly limit", async () => {
    const conn = (await api("POST", "/v1/ai/connections", { provider: "anthropic", label: "Cached", api_key: MODEL_KEYS.limit, default_model: "claude-test-1", monthly_token_limit: 200 })).json.id;
    const agent = (await api("POST", "/v1/agents", { kind: "ops", name: "Cached desk", connection_id: conn })).json.id;
    // Anthropic reports a cached prompt mostly as cache reads: 10 fresh + 150 read + 5 written = 165 input tokens.
    play({ text: "cached answer", usage: { inputTokens: 10, cacheReadInputTokens: 150, cacheCreationInputTokens: 5, outputTokens: 40 } });
    const r1 = (await api("POST", `/v1/agents/${agent}/runs`, { input: "one" })).json.id;
    expect(await drain(r1)).toMatchObject({ status: "succeeded" });
    const usage = (await viewer.get(`/v1/ai/usage?month=${new Date().toISOString().slice(0, 7)}`)).json;
    expect(usage.agents.find((a: { agent_id: string }) => a.agent_id === agent)).toMatchObject({ input_tokens: 165, output_tokens: 40 });
    const refused = await api("POST", `/v1/agents/${agent}/runs`, { input: "two" });
    expect(refused.json.error).toMatchObject({ code: "MODEL_UNAVAILABLE", details: { reason: "token_limit_reached" } });
  });

  it("a run whose lease expires goes back to the queue with the attempt counted; on the last attempt it fails WORKER_LOST", async () => {
    play({ text: "picked up again" });
    const r = (await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "crash me" })).json.id;
    expect(agents().runs.claim("crashed-worker", 1, 10)!.id).toBe(r);
    await sleep(10);
    expect(agents().runs.requeueExpired()).toBe(1);
    expect(run(r)).toMatchObject({ status: "queued", attempt: 1, lease_owner: null });
    expect(steps(r).at(-1)).toMatchObject({ type: "retry_scheduled", data: { reason: "lease_expired" } });
    expect(await drain(r)).toMatchObject({ status: "succeeded", attempt: 2 });
    const last = (await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "crash me twice" })).json.id;
    node.services.db.run("UPDATE agent_runs SET max_attempts = 1 WHERE id = ?", last);
    expect(agents().runs.claim("crashed-worker", 1, 10)!.id).toBe(last);
    await sleep(10);
    agents().runs.requeueExpired();
    expect(run(last)).toMatchObject({ status: "failed", error_code: "WORKER_LOST" });
  });

  it("two workers on two database connections never run the same run", async () => {
    const db2 = new Database(tmp.dbPath);
    const box = new SecretBox(new Map([[1, Buffer.from(SECRETS_KEY, "base64")]]), 1);
    const conns2 = new ConnectionService({ db: db2, box, models: models as ModelLayer, allowPrivateModelUrls: false });
    const services = [
      { runs: agents().runs, agents: agents().agents, connections: agents().connections },
      { runs: new RunService({ db: db2, events: new EventBus(db2), webhooks: null }), agents: new AgentService({ db: db2, box, connections: conns2, publicUrl: "http://x" }), connections: conns2 },
    ];
    const claimed: string[][] = [[], []];
    const restore: Array<() => void> = [];
    const workers = services.map((s, i) => {
      const orig = s.runs.claim.bind(s.runs);
      restore.push(() => (s.runs.claim = orig));
      s.runs.claim = (owner, lease, max) => {
        const row = orig(owner, lease, max);
        if (row) claimed[i]!.push(row.id);
        return row;
      };
      return new AgentWorker({ ...s, tools: async () => ({ specs: [], call: async () => ({ isError: true, content: "" }), close() {} }), log: node.services.log, workers: 3, maxPerMerchant: 20, pollMs: 10, idlePollMs: 20 });
    });
    play(...Array.from({ length: 12 }, () => (async () => (await sleep(15), { text: "done" })) as ScriptStep));
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await api("POST", `/v1/agents/${opsAgent}/runs`, { input: `job ${i}` })).json.id);
    for (const w of workers) w.start();
    for (let i = 0; i < 400 && ids.some((id) => run(id).status !== "succeeded"); i++) await sleep(10);
    await Promise.all(workers.map((w) => w.stop()));
    for (const r of restore) r();
    db2.close();
    expect(ids.map((id) => run(id).status)).toEqual(Array(12).fill("succeeded"));
    expect([...claimed[0]!, ...claimed[1]!].sort()).toEqual([...ids].sort());
    expect(claimed[0]!.filter((id) => claimed[1]!.includes(id))).toEqual([]);
    for (const id of ids) expect(steps(id).filter((e) => e.type === "started")).toHaveLength(1);
  });

  it("sends agent_run.* webhooks through the outbox and lets endpoints subscribe to them", async () => {
    const hook = await api("POST", "/v1/webhooks", { url: "http://127.0.0.1:9/hook", events: ["agent_run.succeeded", "agent_run.failed", "agent_run.cancelled", "agent_run.timed_out"] });
    expect(hook.status).toBe(201);
    play({ text: "hooked" });
    const r = (await api("POST", `/v1/agents/${opsAgent}/runs`, { input: "webhook me" })).json.id;
    await drain(r);
    const ev = node.services.db.get<{ id: string; body: string }>("SELECT id, body FROM gateway_events WHERE type = 'agent_run.succeeded' AND object_id = ?", r)!;
    expect(JSON.parse(ev.body).data.object).toMatchObject({ id: r, status: "succeeded", result: { answer: "hooked" } });
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event_id = ?", ev.id)!.n).toBe(1);
    const types = node.services.db.all<{ type: string }>("SELECT DISTINCT type FROM gateway_events WHERE type LIKE 'agent_run.%' ORDER BY type").map((t) => t.type);
    expect(types).toEqual(["agent_run.cancelled", "agent_run.failed", "agent_run.succeeded", "agent_run.timed_out"]);
  });

  it("publishes run events on /v1/events, and a business sees only its own", async () => {
    const ac = new AbortController();
    const res = await fetch(`${node.url}/v1/events?since=0`, { headers: { authorization: `Bearer ${keyB}` }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (buf.match(/^event: /gm)?.length ?? 0) < 40) {
      const { value, done } = await Promise.race([reader.read(), sleep(300).then(() => ({ value: "", done: false }))]);
      if (done) break;
      buf += value ?? "";
    }
    ac.abort();
    const events = [...buf.matchAll(/^event: (.+)\n(?:id: .+\n)?data: (.+)$/gm)].map((m) => ({ type: m[1]!, data: JSON.parse(m[2]!) }));
    const runEvents = events.filter((e) => e.type !== "ready");
    expect(runEvents.length).toBeGreaterThan(0);
    for (const e of runEvents) {
      expect(e.type).toMatch(/^agent_run\.(queued|started|updated|step|succeeded|failed|cancelled|timed_out)$/);
      expect(e.data.merchant_id).toBe(merchantB);
      expect(e.data.run_id).toMatch(/^run_/);
    }
    expect(new Set(runEvents.map((e) => e.type))).toEqual(new Set(["agent_run.queued", "agent_run.started", "agent_run.updated", "agent_run.step", "agent_run.succeeded"]));
    // Viewers of a business may subscribe too; anonymous callers may not.
    expect((await fetch(`${node.url}/v1/events`)).status).toBe(401);
  });
});

describe("paid skills", () => {
  let skill = "";
  let buyer: AgentClient;

  it("registers a skill as a provider listed in the directory", async () => {
    const r = await api("POST", "/v1/agents", { kind: "skill", name: "Market brief", description: "A short market note.", connection_id: connA, slug: "market-brief", price: "10000", input_hint: "a trading pair" });
    expect(r.status).toBe(201);
    expect(r.json.skill).toMatchObject({ slug: "market-brief", price: "10000", url: `${node.url}/v1/skills/market-brief` });
    skill = r.json.id;
    expect((await api("POST", "/v1/agents", { kind: "skill", name: "Dup", connection_id: connA, slug: "market-brief", price: "1" })).json.error.code).toBe("SLUG_TAKEN");
    const dir = (await call("GET", "/v1/directory", undefined, {})).json;
    expect(dir.services.find((s: { pay_url: string }) => s.pay_url === `${node.url}/v1/skills/market-brief`)).toMatchObject({ type: "endpoint", title: "Market brief", price: { amount: "10000" }, payee: PAYOUT.address, category: "skill" });
  });

  it("answers 402 unpaid, then a paid call waits, answers 202 and the buyer polls the result with its token", async () => {
    const owner = new OwnerClient({ nodeUrl: node.url, chainId: 31337, hub, account: OWNER, publicClient: anvil.pub, adminToken: ADMIN });
    const policy = { perCallCap: "100000", dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 100, purpose: "buy skills" };
    const m = await owner.createMandate({ agent: BUYER.address, token, totalCap: 10n * USDC, validForSeconds: 86_400, payees: [PAYOUT.address], policy });
    await owner.submit({ ...m, policy, payees: [PAYOUT.address], label: "Skill buyer" });
    await mint(anvil, token, BUYER.address, 100n * USDC);
    buyer = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: BUYER, mandateId: m.mandateId });
    await buyer.ensureAllowance(anvil.wallet(ANVIL_KEYS[4]), maxUint256, { token });

    const unpaid = await call("POST", "/v1/skills/market-brief", { input: "HSK-USDC" }, {});
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("payment-required")).toBeTruthy();
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ?", skill)!.n).toBe(0);

    worker().start();
    play((async () => (await sleep(900), { text: "HSK-USDC is calm today." })) as ScriptStep);
    const res = await buyer.fetch(`${node.url}/v1/skills/market-brief`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "HSK-USDC" }) });
    expect(res.status).toBe(202);
    expect(res.headers.get("payment-response")).toBeTruthy();
    const accepted = (await res.json()) as { run_id: string; status: string; poll_url: string; result_token: string };
    expect(accepted).toMatchObject({ status: expect.stringMatching(/^(queued|running)$/), result_token: expect.stringMatching(/^rtk_/) });
    expect(accepted.poll_url).toBe(`${node.url}/v1/skills/market-brief/runs/${accepted.run_id}?token=${accepted.result_token}`);
    const polled = await call("GET", `${new URL(accepted.poll_url).pathname}${new URL(accepted.poll_url).search}&wait=10`, undefined, {});
    expect(polled.json).toMatchObject({ run_id: accepted.run_id, status: "succeeded", result: { answer: "HSK-USDC is calm today." } });
    expect(polled.json.result_token).toBeUndefined();
    // Nobody else can read it: a wrong token, or another run id, is the same 404.
    expect((await call("GET", `/v1/skills/market-brief/runs/${accepted.run_id}?token=rtk_${"A".repeat(32)}`, undefined, {})).status).toBe(404);
    expect((await call("GET", `/v1/skills/market-brief/runs/${accepted.run_id}`, undefined, {})).status).toBe(404);
    const r = run(accepted.run_id);
    expect(r).toMatchObject({ trigger: "skill_call", payer: BUYER.address });
    expect(r.skill_call_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE call_id = ?", r.skill_call_id)!.n).toBe(1);

    // A fast skill answers in the same response.
    play({ text: "Quick note." });
    const fast = await buyer.fetch(`${node.url}/v1/skills/market-brief`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "BTC-USDC" }) });
    expect(fast.status).toBe(200);
    expect(await fast.json()).toMatchObject({ status: "succeeded", result: { answer: "Quick note." } });
  });

  it("refuses before payment when the connection is not active or the agent is paused, and unlists a paused skill", async () => {
    const calls = () => node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls")!.n;
    const before = calls();
    await api("PATCH", `/v1/ai/connections/${connA}`, { status: "disabled" });
    const r = await buyer.fetch(`${node.url}/v1/skills/market-brief`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "ETH-USDC" }) });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: { code: "MODEL_UNAVAILABLE", details: { reason: "connection_disabled" } } });
    expect(calls()).toBe(before);
    await api("PATCH", `/v1/ai/connections/${connA}`, { status: "active" });
    await api("PATCH", `/v1/agents/${skill}`, { status: "paused" });
    const paused = await call("POST", "/v1/skills/market-brief", { input: "x" }, {});
    expect(paused.json.error).toMatchObject({ code: "MODEL_UNAVAILABLE", details: { reason: "agent_paused" } });
    const dir = (await call("GET", "/v1/directory", undefined, {})).json;
    expect(dir.services.some((s: { pay_url: string }) => s.pay_url.endsWith("/v1/skills/market-brief"))).toBe(false);
    expect((await call("POST", "/v1/skills/no-such-skill", { input: "x" }, {})).status).toBe(404);
    expect((await call("POST", "/v1/skills/market-brief", { input: "" }, {})).json.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("keys never leak", () => {
  it("no model key appears in any API response, log line, audit entry, event, webhook, run or step", () => {
    const db = node.services.db;
    const dump = (sql: string) => JSON.stringify(db.all(sql));
    const haystacks: Record<string, string> = {
      responses: responses.join("\n"),
      logs: logs.join("\n"),
      audit: dump("SELECT * FROM audit_events"),
      events: dump("SELECT * FROM events"),
      webhooks: dump("SELECT * FROM gateway_events"),
      runs: dump("SELECT * FROM agent_runs"),
      steps: dump("SELECT * FROM agent_run_events"),
      connections: dump("SELECT * FROM ai_connections"),
      agents: dump("SELECT * FROM agents"),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      expect(text.length, where).toBeGreaterThan(0);
      for (const k of Object.values(MODEL_KEYS)) {
        expect(text.includes(k), `${where} contains a model key`).toBe(false);
        expect(text.includes(k.slice(8, 30)), `${where} contains part of a model key`).toBe(false);
      }
      expect(text.includes(SECRETS_KEY), `${where} contains the server key`).toBe(false);
    }
  });
});

describe("rotating AGENT_SECRETS_KEY", () => {
  it("re-seals every key with the new version in one transaction; a dry run writes nothing", () => {
    const db = node.services.db;
    const v1 = Buffer.from(SECRETS_KEY, "base64");
    const v2 = randomBytes(32);
    const box = new SecretBox(
      new Map([
        [1, v1],
        [2, v2],
      ]),
      2,
    );
    const before = JSON.stringify(db.all("SELECT key_ciphertext FROM ai_connections"));
    const dry = reencryptSecrets(db, box, { apply: false });
    expect(dry.connections).toBeGreaterThan(0);
    expect(dry.agents).toBe(1);
    expect(JSON.stringify(db.all("SELECT key_ciphertext FROM ai_connections"))).toBe(before);
    // Without the old key nothing can be opened, and nothing changes.
    expect(() => reencryptSecrets(db, new SecretBox(new Map([[2, v2]]), 2), { apply: true })).toThrow(/version 1/);
    expect(JSON.stringify(db.all("SELECT key_ciphertext FROM ai_connections"))).toBe(before);
    const done = reencryptSecrets(db, box, { apply: true });
    expect(done).toMatchObject({ connections: dry.connections, agents: 1, apply: true });
    expect(db.all<{ v: number }>("SELECT DISTINCT key_version AS v FROM ai_connections WHERE deleted_at IS NULL").map((r) => r.v)).toEqual([2]);
    const onlyNew = new SecretBox(new Map([[2, v2]]), 2);
    const row = db.get<{ key_ciphertext: string; key_iv: string; key_tag: string; key_version: number }>("SELECT * FROM ai_connections WHERE id = ?", connA)!;
    expect(onlyNew.open({ ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag, version: row.key_version }, { merchantId: merchantA, rowId: connA })).toBe(MODEL_KEYS.main);
    expect(reencryptSecrets(db, box, { apply: true })).toMatchObject({ connections: 0, agents: 0 });
  });
});
