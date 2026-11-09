/**
 * The Replicate adapter against a local mock of the predictions API (no network, no key). Tools are emulated by a
 * prompted JSON protocol, so these tests check both the prompt the adapter writes and how it reads the model's text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type ModelRequest, type ToolSpec } from "../src/model.ts";
import { createModelClient, listModels, providerInfo, verifyConnection } from "../src/providers/index.ts";
import { parseReplicateReply, replicateModel, toReplicatePrompt } from "../src/providers/replicate.ts";
import { mockProvider, type MockAnswer, type MockProvider } from "./mock-provider.ts";

const KEY = "r8_testSECRET0123456789abcdef";
const MODEL = "deepseek-ai/deepseek-v3.1";
const PATH = `/v1/models/${MODEL}/predictions`;
const NOW = new Date("2026-11-03T09:30:00Z");
const TOOLS: ToolSpec[] = [
  { name: "get_quote", description: "Spot quote for a symbol", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "get_budget", description: "Budget left", inputSchema: { type: "object", properties: {} } },
];
const ask = (text: string, messages: ChatMessage[] = [], tools = TOOLS): ModelRequest => ({ system: "You are a test agent.", tools, maxTokens: 500, messages: [{ role: "user", parts: [{ type: "text", text }] }, ...messages] });

let m: MockProvider;
beforeEach(async () => {
  m = await mockProvider();
});
afterEach(async () => {
  await m.close();
});

const client = (o: { maxRetries?: number; timeoutMs?: number } = {}) => replicateModel({ apiKey: KEY, model: MODEL, baseUrl: m.url, now: () => NOW, ...o });

/** A prediction as Replicate answers it; the output arrives as string chunks. */
function prediction(o: { status?: string; text?: string; error?: string | null; id?: string; input?: number; output?: number; variant?: string } = {}): MockAnswer {
  const id = o.id ?? "pred_1";
  const status = o.status ?? "succeeded";
  const chunks = o.text === undefined ? null : o.text.match(/[\s\S]{1,7}/g) ?? [];
  return {
    status: 201,
    json: {
      id,
      model: MODEL,
      version: "hidden",
      status,
      output: status === "succeeded" ? chunks : null,
      error: o.error ?? null,
      urls: { get: `${m.url}/v1/predictions/${id}`, cancel: `${m.url}/v1/predictions/${id}/cancel`, stream: "https://stream.replicate.com/v1/files/x" },
      metrics: status === "succeeded" ? { token_input_count: o.input ?? 120, token_output_count: o.output ?? 18, predict_time: 1.2, ...(o.variant ? { model_variant: o.variant } : {}) } : {},
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<ModelError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ModelError);
  return e as ModelError;
}

describe("replicate adapter", () => {
  it("is registered with a curated model list, no base URL and an honest note", () => {
    expect(providerInfo("replicate")).toMatchObject({
      name: "Replicate (DeepSeek and others)",
      needsBaseUrl: false,
      keyOptional: false,
      defaultBaseUrl: "https://api.replicate.com",
      suggestedModels: ["deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3"],
      note: expect.stringMatching(/emulates tools/),
    });
    expect(createModelClient({ provider: "replicate", apiKey: KEY, model: MODEL }).provider).toBe("replicate");
    expect(() => createModelClient({ provider: "replicate", apiKey: " ", model: MODEL })).toThrow(/needs an API key/);
    expect(() => createModelClient({ provider: "replicate", apiKey: KEY, model: "deepseek" })).toThrow(/owner\/name/);
  });

  it("answers a synchronous prediction and sends the prompt, limits, auth and Prefer: wait", async () => {
    m.answer(prediction({ text: '{"answer":"HSK is 0.52 USD."}', input: 321, output: 12, variant: "deepseek-ai/deepseek-v3.1" }));
    const t = await client().turn(ask("What is HSK at?"));
    expect(t).toEqual({ parts: [{ type: "text", text: "HSK is 0.52 USD." }], stop: "end", usage: { inputTokens: 321, outputTokens: 12 }, model: "deepseek-ai/deepseek-v3.1" });
    const r = m.requests[0]!;
    expect([r.method, r.path, r.headers.authorization, r.headers.prefer]).toEqual(["POST", PATH, `Bearer ${KEY}`, "wait=60"]);
    expect(r.body.input).toMatchObject({ max_tokens: 500, temperature: 0.2 });
    expect(Object.keys(r.body.input).sort()).toEqual(["max_tokens", "prompt", "temperature"]);
    const prompt: string = r.body.input.prompt;
    expect(prompt.startsWith("You are a test agent.\n\nCurrent date: Tuesday 2026-11-03 (UTC).")).toBe(true);
    expect(prompt).toContain(JSON.stringify({ name: "get_quote", description: "Spot quote for a symbol", input_schema: TOOLS[0]!.inputSchema }));
    expect(prompt).toContain('Reply with exactly one JSON object and nothing else: {"tool_calls":[{"name":"<tool>","input":{...}}]} to call tools, or {"answer":"<final answer>"} when done.');
    expect(prompt.endsWith("User: What is HSK at?\n\nAssistant:")).toBe(true);
  });

  it("does not repeat the date when the system prompt states it, and runs a pinned version", async () => {
    expect(toReplicatePrompt({ system: "Today is 2026-11-03.", tools: [], messages: [] }, NOW)).not.toContain("Current date");
    m.answer(prediction({ text: "plain" }));
    await replicateModel({ apiKey: KEY, model: `${MODEL}:abc123`, baseUrl: m.url }).turn(ask("x"));
    expect([m.requests[0]!.path, m.requests[0]!.body.version]).toEqual(["/v1/predictions", "abc123"]);
  });

  it("maps tool calls with stable ids and stops on tool_use", async () => {
    const reply = '{"tool_calls":[{"name":"get_quote","input":{"symbol":"HSK"}},{"name":"get_budget","input":{}}]}';
    m.answer(prediction({ text: reply }), prediction({ text: reply }));
    const one = await client().turn(ask("Quote HSK and my budget."));
    expect(one.stop).toBe("tool_use");
    expect(one.parts).toEqual([
      { type: "tool_call", id: expect.stringMatching(/^call_[0-9a-f]{16}$/), name: "get_quote", input: { symbol: "HSK" } },
      { type: "tool_call", id: expect.stringMatching(/^call_[0-9a-f]{16}$/), name: "get_budget", input: {} },
    ]);
    const ids = one.parts.map((p) => (p.type === "tool_call" ? p.id : ""));
    expect(new Set(ids).size).toBe(2);
    // The same call at the same point of the conversation gets the same id.
    expect((await client().turn(ask("Quote HSK and my budget."))).parts.map((p) => (p.type === "tool_call" ? p.id : ""))).toEqual(ids);
  });

  it("reads code-fenced JSON, prose around the object, thinking blocks and braces inside strings", () => {
    const read = (s: string) => parseReplicateReply(s, { tools: true, turn: 0 }).parts;
    expect(read('```json\n{"tool_calls":[{"name":"get_quote","input":{"symbol":"ETH"}}]}\n```')).toMatchObject([{ type: "tool_call", name: "get_quote", input: { symbol: "ETH" } }]);
    expect(read('Sure, here it is: {"answer":"Use {curly} braces \\"carefully\\"."} Hope that helps {')).toEqual([{ type: "text", text: 'Use {curly} braces "carefully".' }]);
    expect(read('<think>{"answer":"no"} let me think</think>{"answer":"yes"}')).toEqual([{ type: "text", text: "yes" }]);
    expect(read('{"note":"x"} {"answer":"second object wins"}')).toEqual([{ type: "text", text: "second object wins" }]);
    expect(read('{"tool_calls":[{"name":"get_quote","arguments":"{\\"symbol\\":\\"BTC\\"}"},{"input":{}},{"name":"get_quote","input":[1]}]}')).toEqual([
      { type: "tool_call", id: expect.any(String), name: "get_quote", input: { symbol: "BTC" } },
      { type: "tool_call", id: expect.any(String), name: "(unnamed)", input: {}, inputError: "the tool call has no name" },
      { type: "tool_call", id: expect.any(String), name: "get_quote", input: {}, inputError: "arguments must be a JSON object, got an array" },
    ]);
  });

  it("turns a reply that is not protocol JSON into a plain answer, or max_tokens when it was cut off", async () => {
    m.answer(prediction({ text: "HSK is at 0.52 USD, no tools needed." }), prediction({ text: '{"tool_calls":[{"name":"get_qu', output: 500 }));
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "end", parts: [{ type: "text", text: "HSK is at 0.52 USD, no tools needed." }] });
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "max_tokens", parts: [{ type: "text", text: '{"tool_calls":[{"name":"get_qu' }] });
  });

  it("without tools sends a plain prompt and returns the text as is", async () => {
    m.answer(prediction({ text: "A haiku about fees." }));
    const t = await client().turn(ask("Write a haiku", [], []));
    expect(t).toMatchObject({ stop: "end", parts: [{ type: "text", text: "A haiku about fees." }] });
    expect(m.requests[0]!.body.input.prompt).not.toContain("tool_calls");
  });

  it("replays a multi-turn conversation in the protocol, with tool results labelled by id and name", async () => {
    m.answer(prediction({ text: '{"answer":"HSK 0.52; ETH failed."}' }));
    const history: ChatMessage[] = [
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "call_b", name: "get_quote", input: { symbol: "HSK" } },
          { type: "tool_call", id: "call_c", name: "get_quote", input: { symbol: "ETH" } },
        ],
      },
      {
        role: "user",
        parts: [
          { type: "tool_result", id: "call_b", content: "0.52", isError: false },
          { type: "tool_result", id: "call_c", content: "no supplier", isError: true },
        ],
      },
    ];
    const t = await client().turn(ask("Quote HSK and ETH.", history));
    expect(t).toMatchObject({ stop: "end", parts: [{ type: "text", text: "HSK 0.52; ETH failed." }] });
    const prompt: string = m.requests[0]!.body.input.prompt;
    const transcript = prompt.slice(prompt.indexOf("User: Quote HSK and ETH."));
    expect(transcript).toBe(
      [
        "User: Quote HSK and ETH.",
        `Assistant: {"tool_calls":[{"id":"call_b","name":"get_quote","input":{"symbol":"HSK"}},{"id":"call_c","name":"get_quote","input":{"symbol":"ETH"}}]}`,
        "Tool result (id call_b, get_quote):\n0.52",
        "Tool error (id call_c, get_quote):\nno supplier",
        "Assistant:",
      ].join("\n\n"),
    );
  });

  it("polls a prediction that is still starting or processing until it succeeds", async () => {
    m.answer(prediction({ status: "starting", id: "pred_slow" }), { json: { id: "pred_slow", status: "processing", urls: { get: `${m.url}/v1/predictions/pred_slow` } } }, prediction({ id: "pred_slow", text: '{"answer":"done"}', input: 7, output: 3 }));
    const t = await client().turn(ask("x"));
    expect(t).toMatchObject({ stop: "end", parts: [{ type: "text", text: "done" }], usage: { inputTokens: 7, outputTokens: 3 } });
    expect(m.requests.map((r) => [r.method, r.path])).toEqual([
      ["POST", PATH],
      ["GET", "/v1/predictions/pred_slow"],
      ["GET", "/v1/predictions/pred_slow"],
    ]);
    expect(m.requests[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("never sends the token to a poll URL on another host", async () => {
    m.answer({ status: 201, json: { id: "pred_x", status: "processing", urls: { get: "https://evil.example/steal" } } }, prediction({ id: "pred_x", text: '{"answer":"ok"}' }));
    expect((await client().turn(ask("x"))).parts).toEqual([{ type: "text", text: "ok" }]);
    expect(m.requests[1]!.path).toBe("/v1/predictions/pred_x");
  });

  it("maps a failed or canceled prediction to unknown with Replicate's error text", async () => {
    m.answer(prediction({ status: "failed", error: "CUDA out of memory" }), prediction({ status: "canceled" }));
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "unknown", retryable: false, provider: "replicate", message: "the Replicate prediction failed: CUDA out of memory" });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "unknown", message: expect.stringMatching(/was canceled/) });
  });

  it("maps 401, 402, 404, 422, 429 with Retry-After and 5xx, never leaking the token", async () => {
    m.answer({ status: 401, json: { title: "Unauthenticated", detail: `You did not pass a valid authentication token (${KEY})`, status: 401 } });
    const auth = await rejection(client().turn(ask("x")));
    expect(auth).toMatchObject({ kind: "auth", retryable: false, status: 401, provider: "replicate" });
    expect(JSON.stringify(auth)).not.toContain("SECRET");

    m.answer({ status: 402, json: { title: "Insufficient credit", detail: "You have insufficient credit to run this model.", status: 402 } });
    const credit = await rejection(client().turn(ask("x")));
    expect(credit).toMatchObject({ kind: "rate_limit", retryable: false, status: 402, message: expect.stringMatching(/out of credit.*replicate\.com\/account\/billing/) });

    m.answer({ status: 404, json: { detail: "Not found." } }, { status: 422, json: { title: "Input validation failed", detail: "max_tokens: Must be less than or equal to 16384" } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "bad_request", retryable: false, status: 404, message: expect.stringMatching(/model deepseek-ai\/deepseek-v3\.1 was not found/) });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "bad_request", status: 422, message: expect.stringMatching(/max_tokens: Must be less/) });

    m.answer({ status: 429, headers: { "retry-after": "4" }, json: { title: "Too Many Requests", detail: "Request was throttled. Expected available in 4 seconds.", status: 429 } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 4_000, status: 429 });

    m.answer({ status: 503, text: "unavailable" }, { status: 500, json: { detail: "internal" } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: 503 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", status: 500 });
  });

  it("retries a busy Replicate when asked to, and reports network failures", async () => {
    m.answer({ status: 503, headers: { "retry-after": "0" }, json: { detail: "busy" } }, prediction({ text: '{"answer":"ok"}' }));
    expect((await client({ maxRetries: 1 }).turn(ask("x"))).parts).toEqual([{ type: "text", text: "ok" }]);
    const dead = replicateModel({ apiKey: KEY, model: MODEL, baseUrl: "http://127.0.0.1:1" });
    expect(await rejection(dead.turn(ask("x")))).toMatchObject({ kind: "network", retryable: true });
  });

  it("honours an abort while waiting for the prediction and while polling, and cancels the abandoned prediction", async () => {
    const a1 = new AbortController();
    m.answer({ hang: true });
    const waiting = client().turn(ask("x"), { signal: a1.signal });
    setTimeout(() => a1.abort(), 50);
    expect(await rejection(waiting)).toMatchObject({ kind: "timeout", message: expect.stringMatching(/aborted/) });

    m.requests.length = 0;
    const a2 = new AbortController();
    m.answer(prediction({ status: "processing", id: "pred_poll" }), (r) => (r.path.endsWith("/cancel") ? { json: { status: "canceled" } } : { hang: true }), (r) => (r.path.endsWith("/cancel") ? { json: { status: "canceled" } } : { hang: true }));
    const polling = client().turn(ask("x"), { signal: a2.signal });
    setTimeout(() => a2.abort(), 400);
    expect(await rejection(polling)).toMatchObject({ kind: "timeout" });
    await new Promise((r) => setTimeout(r, 100));
    expect(m.requests.some((r) => r.method === "POST" && r.path === "/v1/predictions/pred_poll/cancel")).toBe(true);
  });

  it("times out on its own deadline", async () => {
    m.answer(...Array.from({ length: 6 }, () => prediction({ status: "processing", id: "pred_t" })));
    expect(await rejection(client({ timeoutMs: 300 }).turn(ask("x")))).toMatchObject({ kind: "timeout", retryable: true, message: "Replicate did not finish the prediction in time" });
  });

  it("verifies a connection with GET /v1/account and lists the curated models", async () => {
    m.answer({ json: { type: "user", username: "acme", name: "Acme" } });
    expect(await listModels({ provider: "replicate", apiKey: KEY, baseUrl: m.url })).toEqual(["deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3"]);
    expect(m.requests[0]).toMatchObject({ method: "GET", path: "/v1/account", headers: { authorization: `Bearer ${KEY}` } });

    m.answer({ json: { type: "user", username: "acme" } });
    expect(await verifyConnection({ provider: "replicate", apiKey: KEY, baseUrl: m.url, model: MODEL })).toEqual({ ok: true, models: ["deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3"] });

    m.answer({ status: 401, json: { title: "Unauthenticated", detail: "Invalid token r8_testSECRET0123" } });
    const bad = await verifyConnection({ provider: "replicate", apiKey: KEY, baseUrl: m.url, model: MODEL });
    expect(bad).toMatchObject({ ok: false, error: { kind: "auth", status: 401 } });
    expect(bad.ok ? "" : bad.error.message).not.toMatch(/SECRET/);
  });
});
