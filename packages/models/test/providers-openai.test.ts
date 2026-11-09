/**
 * The OpenAI and OpenAI-compatible adapters against a local mock of the Chat Completions API (no network, no key).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type ModelRequest, type ToolSpec } from "../src/model.ts";
import { createModelClient, listModels, verifyConnection } from "../src/providers/index.ts";
import { mockProvider, type MockProvider } from "./mock-provider.ts";

const KEY = "sk-test-SECRET0123456789";
const TOOLS: ToolSpec[] = [
  {
    name: "get_quote",
    description: "Spot quote for a symbol",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
  },
  { name: "get_budget", description: "Budget left", inputSchema: { type: "object", properties: {} } },
];
const ask = (text: string, messages: ChatMessage[] = []): ModelRequest => ({ system: "You are a test agent.", tools: TOOLS, maxTokens: 500, messages: [{ role: "user", parts: [{ type: "text", text }] }, ...messages] });

const completion = (message: Record<string, unknown>, finish = "stop", usage: unknown = { prompt_tokens: 12, completion_tokens: 3 }) => ({
  json: { id: "chatcmpl_1", object: "chat.completion", model: "gpt-5.1-2025-11-13", choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: finish }], ...(usage ? { usage } : {}) },
});

async function rejection(p: Promise<unknown>): Promise<ModelError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ModelError);
  return e as ModelError;
}

let m: MockProvider;
beforeEach(async () => {
  m = await mockProvider();
});
afterEach(async () => {
  await m.close();
});

describe("openai adapter", () => {
  const client = (o: { maxRetries?: number; timeoutMs?: number } = {}) => createModelClient({ provider: "openai", apiKey: KEY, baseUrl: `${m.url}/v1`, model: "gpt-5.1" }, o);

  it("answers in plain text and maps usage, model and the request", async () => {
    m.answer(completion({ content: "HSK is 0.52 USD." }, "stop", { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }));
    const t = await client().turn(ask("What is HSK at?"));
    expect(t).toEqual({ parts: [{ type: "text", text: "HSK is 0.52 USD." }], stop: "end", usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 4 }, model: "gpt-5.1-2025-11-13" });
    const r = m.requests[0]!;
    expect([r.method, r.path, r.headers.authorization]).toEqual(["POST", "/v1/chat/completions", `Bearer ${KEY}`]);
    expect(r.body).toMatchObject({ model: "gpt-5.1", max_completion_tokens: 500, messages: [{ role: "system", content: "You are a test agent." }, { role: "user", content: "What is HSK at?" }] });
    expect(r.body.max_tokens).toBeUndefined();
    expect(r.body.tools[0]).toEqual({ type: "function", function: { name: "get_quote", description: "Spot quote for a symbol", parameters: TOOLS[0]!.inputSchema } });
  });

  it("maps a single tool call and parallel tool calls", async () => {
    m.answer(
      completion({ tool_calls: [{ id: "call_a", type: "function", function: { name: "get_quote", arguments: '{"symbol":"HSK"}' } }] }, "tool_calls"),
      completion(
        {
          content: "Two quotes.",
          tool_calls: [
            { id: "call_b", type: "function", function: { name: "get_quote", arguments: '{"symbol":"HSK"}' } },
            { id: "call_c", type: "function", function: { name: "get_quote", arguments: '{"symbol":"ETH"}' } },
          ],
        },
        "tool_calls",
      ),
    );
    const one = await client().turn(ask("Quote HSK."));
    expect(one).toMatchObject({ stop: "tool_use", parts: [{ type: "tool_call", id: "call_a", name: "get_quote", input: { symbol: "HSK" } }] });
    const two = await client().turn(ask("Quote HSK and ETH."));
    expect(two.parts).toEqual([
      { type: "text", text: "Two quotes." },
      { type: "tool_call", id: "call_b", name: "get_quote", input: { symbol: "HSK" } },
      { type: "tool_call", id: "call_c", name: "get_quote", input: { symbol: "ETH" } },
    ]);
  });

  it("sends tool results back as role tool messages in a multi-turn conversation", async () => {
    m.answer(completion({ content: "HSK 0.52, ETH failed." }));
    const history: ChatMessage[] = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Quoting." },
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
    expect(t.stop).toBe("end");
    expect(m.requests[0]!.body.messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: "Quoting.",
        tool_calls: [
          { id: "call_b", type: "function", function: { name: "get_quote", arguments: '{"symbol":"HSK"}' } },
          { id: "call_c", type: "function", function: { name: "get_quote", arguments: '{"symbol":"ETH"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_b", content: "0.52" },
      { role: "tool", tool_call_id: "call_c", content: "Error: no supplier" },
    ]);
  });

  it("stops on max tokens and on a refusal or content filter", async () => {
    m.answer(completion({ content: "Cut o" }, "length"), completion({ refusal: "I can't help with that." }), completion({ content: "" }, "content_filter"));
    expect((await client().turn(ask("x"))).stop).toBe("max_tokens");
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "refusal", refusal: { category: null, explanation: "I can't help with that." } });
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "refusal", refusal: { category: "content_filter" } });
  });

  it("maps 401 to auth without leaking the key, 429 with Retry-After, 5xx to overloaded", async () => {
    m.answer({ status: 401, json: { error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com.`, type: "invalid_request_error", code: "invalid_api_key" } } });
    const auth = await rejection(client().turn(ask("x")));
    expect(auth).toMatchObject({ kind: "auth", retryable: false, status: 401, provider: "openai" });
    expect(auth.message).not.toContain(KEY);
    expect(auth.message).not.toContain("SECRET");
    expect(JSON.stringify(auth)).not.toContain("SECRET");

    m.answer({ status: 429, headers: { "retry-after": "7" }, json: { error: { message: "Rate limit reached", type: "requests" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 7_000, status: 429 });

    const at = new Date(Date.now() + 20_000).toUTCString();
    m.answer({ status: 429, headers: { "retry-after": at }, json: { error: { message: "slow down" } } });
    const dated = await rejection(client().turn(ask("x")));
    expect(dated.retryAfterMs).toBeGreaterThan(15_000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(20_000);

    m.answer({ status: 429, json: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryable: false });

    m.answer({ status: 503, json: { error: { message: "overloaded" } } }, { status: 500, text: "boom" }, { status: 400, json: { error: { message: "bad tools" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: 503 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", status: 500 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "bad_request", retryable: false, status: 400, message: expect.stringMatching(/bad tools/) });
  });

  it("turns malformed or double-encoded tool arguments into a clean result, never a crash", async () => {
    m.answer(
      completion(
        {
          tool_calls: [
            { id: "call_bad", type: "function", function: { name: "get_quote", arguments: '{"symbol": "HS' } },
            { id: "call_double", type: "function", function: { name: "get_quote", arguments: JSON.stringify('{"symbol":"ETH"}') } },
            { id: "call_array", type: "function", function: { name: "get_quote", arguments: "[1,2]" } },
          ],
        },
        "tool_calls",
      ),
    );
    const t = await client().turn(ask("x"));
    expect(t.parts).toEqual([
      { type: "tool_call", id: "call_bad", name: "get_quote", input: {}, inputError: expect.stringMatching(/not valid JSON/) },
      { type: "tool_call", id: "call_double", name: "get_quote", input: { symbol: "ETH" } },
      { type: "tool_call", id: "call_array", name: "get_quote", input: {}, inputError: "arguments must be a JSON object, got an array" },
    ]);
  });

  it("times out, reports network failures, and retries a busy provider when asked to", async () => {
    m.answer({ hang: true });
    expect(await rejection(client({ timeoutMs: 150 }).turn(ask("x")))).toMatchObject({ kind: "timeout", retryable: true });

    const abort = new AbortController();
    m.answer({ hang: true });
    const pending = client().turn(ask("x"), { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    expect(await rejection(pending)).toMatchObject({ kind: "timeout" });

    const dead = createModelClient({ provider: "openai", apiKey: KEY, baseUrl: "http://127.0.0.1:1/v1", model: "gpt-5.1" });
    expect(await rejection(dead.turn(ask("x")))).toMatchObject({ kind: "network", retryable: true });

    m.answer({ status: 503, headers: { "retry-after": "0" }, json: { error: { message: "busy" } } }, completion({ content: "ok" }));
    expect((await client({ maxRetries: 1 }).turn(ask("x"))).parts).toEqual([{ type: "text", text: "ok" }]);
    expect(m.requests.filter((r) => r.path === "/v1/chat/completions").length).toBeGreaterThanOrEqual(2);
  });

  it("lists models and verifies a connection", async () => {
    m.answer({ json: { object: "list", data: [{ id: "gpt-5.1" }, { id: "gpt-5" }] } });
    expect(await listModels({ provider: "openai", apiKey: KEY, baseUrl: `${m.url}/v1` })).toEqual(["gpt-5", "gpt-5.1"]);
    expect(m.requests[0]).toMatchObject({ method: "GET", path: "/v1/models", headers: { authorization: `Bearer ${KEY}` } });

    m.answer({ json: { object: "list", data: [{ id: "gpt-5.1" }] } });
    expect(await verifyConnection({ provider: "openai", apiKey: KEY, baseUrl: `${m.url}/v1`, model: "gpt-5.1" })).toEqual({ ok: true, models: ["gpt-5.1"] });

    m.answer({ status: 401, json: { error: { message: "Incorrect API key provided: sk-test-...6789" } } });
    const bad = await verifyConnection({ provider: "openai", apiKey: KEY, baseUrl: `${m.url}/v1`, model: "gpt-5.1" });
    expect(bad).toMatchObject({ ok: false, error: { kind: "auth", status: 401 } });
    expect(bad.ok ? "" : bad.error.message).not.toMatch(/sk-test/);
  });
});

describe("openai-compatible adapter", () => {
  const client = (apiKey = KEY) => createModelClient({ provider: "openai_compatible", apiKey, baseUrl: `${m.url}/api/v1/`, model: "meta-llama/llama-4-maverick" });

  it("sends max_tokens, tolerates missing usage, content arrays, missing ids and object arguments", async () => {
    m.answer(
      completion(
        {
          content: [{ type: "text", text: "Checking." }],
          tool_calls: [
            { type: "function", function: { name: "get_quote", arguments: { symbol: "HSK" } } },
            { type: "function", function: { name: "get_budget", arguments: "" } },
          ],
        },
        "tool_calls",
        null,
      ),
    );
    const t = await client().turn(ask("x"));
    expect(t).toEqual({
      parts: [
        { type: "text", text: "Checking." },
        { type: "tool_call", id: "call_1", name: "get_quote", input: { symbol: "HSK" } },
        { type: "tool_call", id: "call_2", name: "get_budget", input: {} },
      ],
      stop: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "gpt-5.1-2025-11-13",
    });
    expect(client().provider).toBe("openai_compatible");
    expect(m.requests[0]!.path).toBe("/api/v1/chat/completions");
    expect(m.requests[0]!.body).toMatchObject({ max_tokens: 500 });
    expect(m.requests[0]!.body.max_completion_tokens).toBeUndefined();
  });

  it("switches the token limit parameter once when the server rejects the one it got", async () => {
    m.answer({ status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } }, completion({ content: "ok" }));
    const c = client();
    expect((await c.turn(ask("x"))).parts).toEqual([{ type: "text", text: "ok" }]);
    expect(m.requests.map((r) => [r.body.max_tokens, r.body.max_completion_tokens])).toEqual([
      [500, undefined],
      [undefined, 500],
    ]);
    // Remembered for the next turn.
    m.answer(completion({ content: "again" }));
    await c.turn(ask("x"));
    expect(m.requests[2]!.body.max_completion_tokens).toBe(500);
  });

  it("sends no Authorization header without a key, and needs a base URL", async () => {
    m.answer(completion({ content: "local" }));
    await client("").turn(ask("x"));
    expect(m.requests[0]!.headers.authorization).toBeUndefined();
    expect(() => createModelClient({ provider: "openai_compatible", apiKey: "k", model: "x" })).toThrow(/needs a base URL/);
    expect(() => createModelClient({ provider: "openai_compatible", apiKey: "k", model: "x", baseUrl: "ftp://x" })).toThrow(/must be http or https/);
    expect(() => createModelClient({ provider: "openai", apiKey: " ", model: "gpt-5.1" })).toThrow(/needs an API key/);
  });

  it("maps errors like OpenAI does", async () => {
    m.answer({ status: 401, json: { error: "invalid key gsk_abcdefghijklmnop" } }, { status: 429, headers: { "retry-after": "3" }, json: { error: { message: "slow" } } }, { status: 502, text: "bad gateway" });
    const auth = await rejection(client().turn(ask("x")));
    expect(auth).toMatchObject({ kind: "auth", provider: "openai_compatible" });
    expect(auth.message).not.toContain("gsk_abcdefghijklmnop");
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryAfterMs: 3_000 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", status: 502 });
  });

  it("verifies with a one-token completion when the server has no model list", async () => {
    m.answer({ status: 404, text: "not found" });
    expect(await listModels({ provider: "openai_compatible", apiKey: KEY, baseUrl: `${m.url}/v1` })).toBeNull();
    m.answer({ status: 404, text: "not found" }, completion({ content: "O" }, "length"));
    expect(await verifyConnection({ provider: "openai_compatible", apiKey: KEY, baseUrl: `${m.url}/v1`, model: "llama3.2" })).toEqual({ ok: true, models: null });
    const probe = m.requests.at(-1)!;
    expect([probe.path, probe.body.max_tokens]).toEqual(["/v1/chat/completions", 1]);

    m.answer({ json: { data: [{ id: "llama3.2" }] } });
    expect(await verifyConnection({ provider: "openai_compatible", apiKey: "", baseUrl: `${m.url}/v1`, model: "llama3.2" })).toEqual({ ok: true, models: ["llama3.2"] });
    expect(await verifyConnection({ provider: "openai_compatible", apiKey: "", model: "llama3.2" })).toMatchObject({ ok: false, error: { kind: "bad_request" } });
  });
});
