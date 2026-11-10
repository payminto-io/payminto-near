/**
 * A business runs its ops agent on each non-Anthropic provider, through the real model layer (@payminto/models) and
 * the real merchant tools: anvil with the gateway contracts, the node in-process on a temp SQLite file, and a local
 * mock provider on 127.0.0.1 (so AGENT_ALLOW_PRIVATE_MODEL_URLS is on). The OpenAI-compatible connection points at the
 * mock as its endpoint; the OpenAI, Gemini and Replicate connections override their base URL to it. Each provider: a run with
 * tool calls completes and records usage, a 429 with Retry-After schedules a retry, and a 401 marks the connection
 * invalid without the key ever showing up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import type { Provider } from "@payminto/models";
import { mockProvider, type MockAnswer, type MockProvider, type SeenRequest } from "@payminto/models/mock-provider";
import { startNode, type ClearingNode } from "../src/server.ts";
import { createLogger } from "../src/logger.ts";
import type { AgentsConfig, GatewayConfig } from "../src/config.ts";
import type { RunRow } from "../src/agents/rows.ts";
import { freePort, startFakeChain, tempDir, testConfig } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PAYOUT = "acme-store.testnet";
const FEES = "fees.testnet";

type Call = { name: string; args: Record<string, unknown> };

/** How one provider speaks: where it lives, what its answers look like, and where the tool results land. */
type Dialect = {
  provider: Exclude<Provider, "anthropic">;
  model: string;
  key: string;
  basePath: string;
  models(): MockAnswer;
  tools(calls: Call[]): MockAnswer;
  text(t: string, usage: { input: number; output: number }): MockAnswer;
  /** The tool result texts the adapter sent back in a request. */
  results(r: SeenRequest): string[];
  /** The tool names the adapter declared in a request. */
  declared(r: SeenRequest): string[];
  /** The path a turn is posted to. */
  turnPath: string;
  /** What the provider reports it ran. */
  served: string;
};

const chat = (provider: "openai" | "openai_compatible", model: string, key: string, served: string): Dialect => ({
  provider,
  model,
  key,
  basePath: "/v1",
  models: () => ({ json: { object: "list", data: [{ id: model }, { id: `${model}-mini` }] } }),
  tools: (calls) => ({
    json: {
      model: served,
      choices: [
        {
          message: { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ id: `call_${c.name}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 400, completion_tokens: 30 },
    },
  }),
  text: (t, u) => ({ json: { model: served, choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage: { prompt_tokens: u.input, completion_tokens: u.output } } }),
  results: (r) => (r.body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content),
  declared: (r) => r.body.tools.map((t: { function: { name: string } }) => t.function.name),
  turnPath: "/v1/chat/completions",
  served,
});

const DIALECTS: Dialect[] = [
  chat("openai_compatible", "llama-test", "gsk_test_compatible_0123456789SECRET", "llama-test"),
  chat("openai", "gpt-test", "sk-test-openai-0123456789abcdefSECRET", "gpt-test-2026-10-01"),
  {
    provider: "google",
    model: "gemini-test",
    key: "AIzaTestGoogle0123456789abcdefSECRET",
    basePath: "/v1beta",
    models: () => ({ json: { models: [{ name: "models/gemini-test" }, { name: "models/gemini-test-flash" }] } }),
    tools: (calls) => ({
      json: {
        candidates: [{ content: { role: "model", parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 30 },
        modelVersion: "gemini-test-001",
      },
    }),
    text: (t, u) => ({
      json: { candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output }, modelVersion: "gemini-test-001" },
    }),
    results: (r) =>
      (r.body.contents as Array<{ parts: Array<{ functionResponse?: { response: { result?: string; error?: string } } }> }>)
        .flatMap((c) => c.parts)
        .flatMap((p) => (p.functionResponse ? [p.functionResponse.response.result ?? p.functionResponse.response.error ?? ""] : [])),
    declared: (r) => r.body.tools[0].functionDeclarations.map((t: { name: string }) => t.name),
    turnPath: "/v1beta/models/gemini-test:generateContent",
    served: "gemini-test-001",
  },
  // Replicate has no native tools: the tools and their results travel in the prompt, the calls come back as JSON text.
  {
    provider: "replicate",
    model: "deepseek-ai/deepseek-v3.1",
    key: "r8_test_replicate_0123456789abcdefSECRET",
    basePath: "",
    models: () => ({ json: { type: "user", username: "acme", name: "Acme" } }),
    tools: (calls) => replicatePrediction(JSON.stringify({ tool_calls: calls.map((c) => ({ name: c.name, input: c.args })) }), { input: 400, output: 30 }),
    text: (t, u) => replicatePrediction(JSON.stringify({ answer: t }), u),
    results: (r) => [...String(r.body.input.prompt).matchAll(/^Tool (?:result|error) \(id [^,]+, [^)]+\):\n([\s\S]*?)(?=\n\n(?:Tool result|Tool error|User:|Assistant:)|(?![\s\S]))/gm)].map((x) => x[1]!),
    declared: (r) => [...String(r.body.input.prompt).matchAll(/^\{"name":"([^"]+)","description"/gm)].map((x) => x[1]!),
    turnPath: "/v1/models/deepseek-ai/deepseek-v3.1/predictions",
    served: "deepseek-ai/deepseek-v3.1",
  },
];

/** A finished Replicate prediction whose output is the given text, in chunks as Replicate streams it. */
function replicatePrediction(text: string, u: { input: number; output: number }): MockAnswer {
  return {
    status: 201,
    json: { id: "pred_test", model: "deepseek-ai/deepseek-v3.1", status: "succeeded", output: text.match(/[\s\S]{1,9}/g), error: null, metrics: { token_input_count: u.input, token_output_count: u.output } },
  };
}

let fakeChain: ReturnType<typeof startFakeChain>;
let node: ClearingNode;
let mock: MockProvider;
let key = "";
const tmp = tempDir("payminto-agents-providers-");
const logs: string[] = [];
const responses: string[] = [];

const agentsConfig: AgentsConfig = {
  enabled: true,
  secretsKeys: { 1: randomBytes(32).toString("base64") },
  secretsKeyVersion: 1,
  usingDevKey: false,
  // The mock provider listens on 127.0.0.1.
  allowPrivateModelUrls: true,
  workers: 1,
  maxPerMerchant: 1,
  pollMs: 50,
  idlePollMs: 100,
  leaseMs: 5_000,
  heartbeatMs: 100,
  retryDelaysMs: [50, 100, 150],
  skillWaitMs: 400,
};

async function api(method: string, path: string, body?: unknown, auth = key): Promise<{ status: number; json: any }> {
  const res = await fetch(`${node.url}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${auth}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const agents = () => node.services.agents!;
const worker = () => agents().worker!;
const run = (id: string) => agents().runs.row(id)!;
const steps = (id: string) => agents().runs.events(id, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

beforeAll(async () => {
  fakeChain = startFakeChain();
  const { hub, token } = { hub: fakeChain.hub, token: fakeChain.token };
  const gateway: GatewayConfig = {
    seedPayout: PAYOUT,
    platformName: "Acme Store",
    feeRecipient: FEES,
    checkoutBaseUrl: "http://localhost:3000",
    checkoutTtlSec: 1800,
    webhookAllowPrivate: true,
    watchIntervalMs: 2000,
  };
  mock = await mockProvider();
  const port = await freePort();
  // No model layer override: the node builds its clients with @payminto/models.
  node = await startNode(
    testConfig({ hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, gateway, port, publicUrl: `http://127.0.0.1:${port}`, agents: agentsConfig }),
    { logger: createLogger({ level: "debug", sink: (l) => logs.push(l) }), port, workers: false, chain: fakeChain },
  );
  key = (await api("POST", "/v1/api-keys", { name: "automation" }, ADMIN)).json.secret;
}, 120_000);

afterAll(async () => {
  await node?.stop();
  await mock?.close();
  tmp.cleanup();
});

describe("the provider catalogue", () => {
  it("is the model layer's PROVIDERS", async () => {
    const { PROVIDERS } = await import("@payminto/models");
    expect((await api("GET", "/v1/ai/providers")).json.items).toEqual(JSON.parse(JSON.stringify(PROVIDERS)));
  });
});

describe.each(DIALECTS)("an ops agent on $provider", (d) => {
  let conn = "";
  let agent = "";

  it("connects: the key is verified against the provider's model list", async () => {
    mock.requests.length = 0;
    mock.answer(d.models());
    const r = await api("POST", "/v1/ai/connections", { provider: d.provider, label: `Team ${d.provider}`, api_key: d.key, base_url: `${mock.url}${d.basePath}`, default_model: d.model });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ provider: d.provider, status: "active", verification: { ok: true, models: expect.arrayContaining([d.model]) } });
    conn = r.json.id;
    const listed = mock.requests[0]!;
    expect(listed.method).toBe("GET");
    if (d.provider === "replicate") expect(listed.path).toBe("/v1/account");
    if (d.provider === "google") expect(listed.headers["x-goog-api-key"]).toBe(d.key);
    else expect(listed.headers.authorization).toBe(`Bearer ${d.key}`);
    mock.answer(d.models());
    expect((await api("GET", `/v1/ai/connections/${conn}/models`)).json.items).toEqual(expect.arrayContaining([d.model]));
    const a = await api("POST", "/v1/agents", { kind: "ops", name: `Desk on ${d.provider}`, connection_id: conn });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ model: d.model, connection: { provider: d.provider, status: "active" } });
    agent = a.json.id;
  });

  it("runs with tool calls against the real merchant tools and records usage", async () => {
    const title = `Consulting on ${d.provider}`;
    mock.requests.length = 0;
    mock.answer(d.tools([{ name: "get_overview", args: {} }]), d.tools([{ name: "create_link", args: { title, amount: "12.50" } }]), d.text("Quiet month. Your link is ready.", { input: 900, output: 40 }));
    const r = await api("POST", `/v1/agents/${agent}/runs`, { input: "How are we doing, and make me a 12.50 consulting link" });
    expect(r.status).toBe(202);
    const done = await drain(r.json.id);
    expect(done.status).toBe("succeeded");
    const view = (await api("GET", `/v1/agent-runs/${r.json.id}`)).json;
    expect(view).toMatchObject({
      status: "succeeded",
      attempt: 1,
      result: { answer: "Quiet month. Your link is ready.", data: { turns: 3, tool_calls: 2 } },
      usage: { input_tokens: 400 + 400 + 900, output_tokens: 30 + 30 + 40, model: d.served, provider: d.provider },
      error_code: null,
    });
    // Three turns to the provider: the merchant tools went out as functions, and their real results came back.
    const turns = mock.requests.filter((q) => q.path.startsWith(d.turnPath));
    expect(turns).toHaveLength(3);
    expect(d.declared(turns[0]!)).toEqual(expect.arrayContaining(["get_overview", "create_link", "request_refund"]));
    expect(d.results(turns[1]!)[0]).toMatch(/^Acme Store from/);
    expect(d.results(turns[2]!).at(-1)).toMatch(new RegExp(`^Created the payment link "${title}" for 12.50 USDC: http`));
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payment_links WHERE title = ?", title)!.n).toBe(1);
    expect(steps(r.json.id).map((e) => e.type)).toEqual(["started", "model_turn", "tool_call", "tool_result", "model_turn", "tool_call", "tool_result", "model_turn", "finished"]);
    expect(steps(r.json.id)[0]!.data).toMatchObject({ provider: d.provider, model: d.model });
    expect((await api("GET", `/v1/ai/connections/${conn}`)).json.usage_this_month).toMatchObject({ total_tokens: 1700 + 100, runs: 1 });
  });

  it("schedules a retry on a 429, honouring Retry-After, then succeeds", async () => {
    mock.answer({ status: 429, headers: { "retry-after": "1" }, json: { error: { message: "Rate limit reached, slow down" } } });
    const r = await api("POST", `/v1/agents/${agent}/runs`, { input: "hi" });
    await worker().tick();
    await worker().idle();
    expect(run(r.json.id)).toMatchObject({ status: "queued", attempt: 1 });
    expect(run(r.json.id).next_attempt_ms - Date.now()).toBeGreaterThan(600);
    expect(steps(r.json.id).at(-1)).toMatchObject({ type: "retry_scheduled", data: { reason: "rate_limit", status: 429, retry_after_ms: 1_000, delay_ms: 1_000 } });
    mock.answer(d.text("Hello.", { input: 50, output: 5 }));
    expect(await drain(r.json.id)).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("marks the connection invalid on a 401, fails the run at once, and never shows the key", async () => {
    mock.answer({ status: 401, json: { error: { message: `Incorrect API key provided: ${d.key}` } } });
    const r = await api("POST", `/v1/agents/${agent}/runs`, { input: "hi" });
    const done = await drain(r.json.id);
    expect(done).toMatchObject({ status: "failed", attempt: 1, error_code: "MODEL_AUTH_FAILED" });
    expect(done.error_message).not.toContain(d.key.slice(4, -6));
    expect(agents().connections.row(conn)!.status).toBe("invalid");
    expect((await api("GET", `/v1/ai/connections/${conn}`)).json).toMatchObject({ status: "invalid" });
    const refused = await api("POST", `/v1/agents/${agent}/runs`, { input: "hi" });
    expect(refused.status).toBe(503);
    expect(refused.json.error).toMatchObject({ code: "MODEL_UNAVAILABLE", details: { reason: "connection_invalid" } });
    // Nothing retried.
    expect(steps(r.json.id).filter((e) => e.type === "retry_scheduled")).toHaveLength(0);
  });
});

describe("an ops agent on NEAR AI Cloud", () => {
  const NEAR_KEY = "sk-nearai-test-SECRETKEY-000111";

  it("checks the key with the key check, runs, and records what attestation showed for the turn", async () => {
    mock.requests.length = 0;
    const reply = { id: "chatcmpl-near-1", object: "chat.completion", model: "z-ai/glm-5.3-flash", choices: [{ index: 0, message: { role: "assistant", content: "All quiet today." }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 12 } };
    const gateway = (r: SeenRequest): MockAnswer => {
      const path = r.path.split("?")[0]!;
      if (path === "/v1/check_api_key") return { json: { valid: true, organization_id: "o", workspace_id: "w", api_key_id: "k" } };
      if (path === "/v1/models") return { json: { object: "list", data: [{ id: "z-ai/glm-5.3-flash" }] } };
      if (path === "/v1/chat/completions") return { json: reply };
      // No attestation report and no signature: the run still answers, and the step says the answer is unverified.
      return { status: 404, json: { error: { message: "not found", type: "not_found" } } };
    };
    // Nine requests, listed at the end; exactly as many answers, so nothing is left queued for a later test.
    mock.answer(...Array.from({ length: 9 }, () => gateway));
    const c = await api("POST", "/v1/ai/connections", { provider: "nearai", label: "NEAR AI Cloud", api_key: NEAR_KEY, base_url: `${mock.url}/v1`, default_model: "z-ai/glm-5.3-flash" });
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ provider: "nearai", status: "active", verification: { ok: true, models: ["z-ai/glm-5.3-flash"] } });
    expect(mock.requests[0]).toMatchObject({ method: "POST", path: "/v1/check_api_key", headers: { authorization: `Bearer ${NEAR_KEY}` } });
    const a = await api("POST", "/v1/agents", { kind: "ops", name: "Desk on NEAR AI Cloud", connection_id: c.json.id });
    expect(a.status).toBe(201);
    const r = await api("POST", `/v1/agents/${a.json.id}/runs`, { input: "How are we doing?" });
    const done = await drain(r.json.id);
    expect(done.status).toBe("succeeded");
    const view = (await api("GET", `/v1/agent-runs/${r.json.id}`)).json;
    expect(view).toMatchObject({ result: { answer: "All quiet today." }, usage: { input_tokens: 400, output_tokens: 12, provider: "nearai" } });
    const turn = steps(r.json.id).find((e) => e.type === "model_turn")!;
    expect(turn.data.attestation).toMatchObject({ status: "failed", failed: ["signature_available"], signature_kind: null, bound_to: null, summary: expect.stringMatching(/^Not verified: no signature available/) });
    // The attestation report is asked for without the key; the key only goes to the key check, the chat and the signature.
    const report = mock.requests.find((q) => q.path.startsWith("/v1/attestation/report"))!;
    expect(report.headers.authorization).toBeUndefined();
    for (const text of [...responses, ...logs, JSON.stringify(steps(r.json.id))]) expect(text).not.toContain("SECRETKEY");
    expect(mock.requests.map((q) => `${q.method} ${q.path.split("?")[0]}`)).toEqual([
      "POST /v1/check_api_key",
      "GET /v1/models",
      // With the model, then the gateway alone.
      "GET /v1/attestation/report",
      "GET /v1/attestation/report",
      "POST /v1/chat/completions",
      // Asked again while the signature is not recorded yet.
      "GET /v1/signature/chatcmpl-near-1",
      "GET /v1/signature/chatcmpl-near-1",
      "GET /v1/signature/chatcmpl-near-1",
      "GET /v1/signature/chatcmpl-near-1",
    ]);
  });

  it("marks the connection invalid for a key the key check rejects, though the model list would answer", async () => {
    const gateway = (r: SeenRequest): MockAnswer => (r.path === "/v1/check_api_key" ? { status: 401, json: { error: { message: "Invalid or expired API key", type: "invalid_api_key", param: null, code: null } } } : { json: { object: "list", data: [{ id: "z-ai/glm-5.3-flash" }] } });
    // Only the key check is asked.
    mock.answer(gateway);
    const c = await api("POST", "/v1/ai/connections", { provider: "nearai", label: "NEAR bad key", api_key: NEAR_KEY, base_url: `${mock.url}/v1`, default_model: "z-ai/glm-5.3-flash" });
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ status: "invalid", verification: { ok: false, error: { kind: "auth", status: 401 } } });
    expect(c.json.last_error).toMatch(/^NEAR AI Cloud rejected the API key \(401\): Invalid or expired API key/);
  });
});

describe("keys never leak", () => {
  it("no provider key appears in any API response, log line, run or step", () => {
    const runs = JSON.stringify(node.services.db.all("SELECT * FROM agent_runs"));
    const events = JSON.stringify(node.services.db.all("SELECT * FROM agent_run_events"));
    for (const d of DIALECTS) {
      const secret = d.key.slice(4, -6);
      for (const text of [...responses, ...logs, runs, events]) expect(text).not.toContain(secret);
    }
  });
});
