/**
 * The Anthropic adapter (official SDK, streamed) against a local mock of the Messages API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type ModelRequest, type ToolSpec } from "../src/model.ts";
import { createModelClient, listModels, verifyConnection } from "../src/providers/index.ts";
import { claudeStream, mockProvider, type MockProvider } from "./mock-provider.ts";

const KEY = "sk-ant-test-SECRET0123456789";
const TOOLS: ToolSpec[] = [{ name: "get_quote", description: "Spot quote", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } }];
const ask = (text: string, messages: ChatMessage[] = []): ModelRequest => ({ system: "You are a test agent.", tools: TOOLS, maxTokens: 800, messages: [{ role: "user", parts: [{ type: "text", text }] }, ...messages] });

async function rejection(p: Promise<unknown>): Promise<ModelError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ModelError);
  return e as ModelError;
}

const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) => ({ status, headers, json: { type: "error", error: { type, message } } });

let m: MockProvider;
beforeEach(async () => {
  m = await mockProvider();
});
afterEach(async () => {
  await m.close();
});
const client = (model = "claude-opus-5-5", o: { effort?: "low" } = {}) => createModelClient({ provider: "anthropic", apiKey: KEY, baseUrl: m.url, model }, o);

describe("anthropic adapter", () => {
  it("streams a plain answer, maps usage with cache counts, and keeps caching, thinking and the fallback", async () => {
    m.answer({ sse: claudeStream({ blocks: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "HSK is 0.52 USD." }], stop: "end_turn", usage: { input: 30, output: 12, cacheRead: 2_000, cacheWrite: 100 } }) });
    const t = await client().turn(ask("What is HSK at?"));
    expect(t).toMatchObject({
      parts: [{ type: "text", text: "HSK is 0.52 USD." }],
      stop: "end",
      usage: { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 100 },
      model: "claude-opus-5-5",
      native: { provider: "anthropic" },
    });
    const r = m.requests[0]!;
    expect([r.method, r.path.split("?")[0], r.headers.authorization]).toEqual(["POST", "/v1/messages", `Bearer ${KEY}`]);
    expect(r.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(r.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 800,
      stream: true,
      system: [{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      tools: [{ name: "get_quote", description: "Spot quote", input_schema: TOOLS[0]!.inputSchema, eager_input_streaming: true }],
      messages: [{ role: "user", content: "What is HSK at?" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      fallbacks: "default",
    });
  });

  it("sends no thinking, effort or fallback to a model that has none", async () => {
    m.answer({ sse: claudeStream({ model: "claude-haiku-4-5", blocks: [{ type: "text", text: "ok" }], stop: "end_turn" }) });
    await client("claude-haiku-4-5").turn(ask("x"));
    const b = m.requests[0]!.body;
    expect([b.thinking, b.output_config, b.fallbacks]).toEqual([undefined, undefined, undefined]);
    m.answer({ sse: claudeStream({ model: "claude-haiku-5-5", blocks: [{ type: "text", text: "ok" }], stop: "end_turn" }) });
    await client("claude-haiku-5-5", { effort: "low" }).turn(ask("x"));
    expect(m.requests[1]!.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(m.requests[1]!.body.fallbacks).toBeUndefined();
  });

  it("maps a single tool call and parallel tool calls", async () => {
    m.answer(
      { sse: claudeStream({ blocks: [{ type: "tool_use", id: "toolu_1", name: "get_quote", json: '{"symbol":"HSK"}' }], stop: "tool_use" }) },
      {
        sse: claudeStream({
          blocks: [
            { type: "text", text: "Both." },
            { type: "tool_use", id: "toolu_2", name: "get_quote", json: '{"symbol":"HSK"}' },
            { type: "tool_use", id: "toolu_3", name: "get_quote", json: '{"symbol":"ETH"}' },
          ],
          stop: "tool_use",
        }),
      },
    );
    expect(await client().turn(ask("Quote HSK."))).toMatchObject({ stop: "tool_use", parts: [{ type: "tool_call", id: "toolu_1", name: "get_quote", input: { symbol: "HSK" } }] });
    expect((await client().turn(ask("Quote both."))).parts).toEqual([
      { type: "text", text: "Both." },
      { type: "tool_call", id: "toolu_2", name: "get_quote", input: { symbol: "HSK" } },
      { type: "tool_call", id: "toolu_3", name: "get_quote", input: { symbol: "ETH" } },
    ]);
  });

  it("replays Claude's turn unchanged (thinking included) and sends all tool results in one user message", async () => {
    m.answer({ sse: claudeStream({ blocks: [{ type: "thinking", thinking: "Need two quotes.", signature: "sig-abc" }, { type: "tool_use", id: "toolu_2", name: "get_quote", json: '{"symbol":"HSK"}' }, { type: "tool_use", id: "toolu_3", name: "get_quote", json: '{"symbol":"ETH"}' }], stop: "tool_use" }) });
    const first = await client().turn(ask("Quote both."));
    m.answer({ sse: claudeStream({ blocks: [{ type: "text", text: "HSK 0.52; ETH unavailable." }], stop: "end_turn" }) });
    await client().turn(
      ask("Quote both.", [
        { role: "assistant", parts: first.parts, native: first.native },
        {
          role: "user",
          parts: [
            { type: "tool_result", id: "toolu_2", content: "0.52", isError: false },
            { type: "tool_result", id: "toolu_3", content: "no supplier", isError: true },
          ],
        },
      ]),
    );
    const msgs = m.requests[1]!.body.messages;
    expect(msgs[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need two quotes.", signature: "sig-abc" },
        { type: "tool_use", id: "toolu_2", name: "get_quote", input: { symbol: "HSK" } },
        { type: "tool_use", id: "toolu_3", name: "get_quote", input: { symbol: "ETH" } },
      ],
    });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_2", content: "0.52" },
        { type: "tool_result", tool_use_id: "toolu_3", content: "no supplier", is_error: true },
      ],
    });
  });

  it("stops on max_tokens and on a refusal with its category", async () => {
    m.answer(
      { sse: claudeStream({ blocks: [{ type: "text", text: "Cut" }], stop: "max_tokens" }) },
      { sse: claudeStream({ blocks: [], stop: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "Declined by policy." } }) },
    );
    expect((await client().turn(ask("x"))).stop).toBe("max_tokens");
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "refusal", parts: [], refusal: { category: "cyber", explanation: "Declined by policy." } });
  });

  it("maps 401, 429 with Retry-After, 529, 503 and a mid-stream overload to ModelError without the key", async () => {
    m.answer(apiError(401, "authentication_error", "invalid x-api-key"));
    const auth = await rejection(client().turn(ask("x")));
    expect(auth).toMatchObject({ kind: "auth", retryable: false, status: 401, provider: "anthropic" });
    expect(JSON.stringify(auth) + auth.message).not.toContain("SECRET");

    m.answer(apiError(429, "rate_limit_error", "Number of requests has exceeded your rate limit", { "retry-after": "9" }));
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 9_000, status: 429 });

    m.answer(apiError(529, "overloaded_error", "Overloaded"), apiError(503, "api_error", "unavailable"), apiError(400, "invalid_request_error", "messages: bad"), apiError(404, "not_found_error", "model: claude-nope"));
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: 529 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", status: 503 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "bad_request", retryable: false, status: 400, message: expect.stringMatching(/messages: bad/) });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "bad_request", status: 404, message: expect.stringMatching(/check the model id/) });

    const events = claudeStream({ blocks: [{ type: "text", text: "partial" }], stop: "end_turn" }).slice(0, 3);
    m.answer({ sse: [...events, { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }] });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: null });

    m.answer({ hang: true });
    const slow = createModelClient({ provider: "anthropic", apiKey: KEY, baseUrl: m.url, model: "claude-opus-5-5" }, { timeoutMs: 150 });
    expect(await rejection(slow.turn(ask("x")))).toMatchObject({ kind: "timeout", retryable: true });
    const dead = createModelClient({ provider: "anthropic", apiKey: KEY, baseUrl: "http://127.0.0.1:1", model: "claude-opus-5-5" });
    expect(await rejection(dead.turn(ask("x")))).toMatchObject({ kind: "network", retryable: true });
  });

  it("never hands over silently truncated tool input: streamed JSON that does not parse becomes a tool error", async () => {
    m.answer({
      sse: claudeStream({
        blocks: [
          { type: "tool_use", id: "toolu_1", name: "get_quote", json: '{"symbol": "HS' },
          { type: "tool_use", id: "toolu_2", name: "get_quote", json: '{"symbol":"ETH"}' },
        ],
        stop: "tool_use",
      }),
    });
    const t = await client().turn(ask("x"));
    expect(t.parts).toEqual([
      { type: "tool_call", id: "toolu_1", name: "get_quote", input: {}, inputError: expect.stringMatching(/not valid JSON/) },
      { type: "tool_call", id: "toolu_2", name: "get_quote", input: { symbol: "ETH" } },
    ]);
    expect(m.requests).toHaveLength(1);
  });

  it("lists models and verifies a connection", async () => {
    m.answer({ json: { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }, { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-sonnet-5-5" } });
    expect(await listModels({ provider: "anthropic", apiKey: KEY, baseUrl: m.url })).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(m.requests[0]).toMatchObject({ method: "GET", headers: { authorization: `Bearer ${KEY}` } });
    expect(m.requests[0]!.path.split("?")[0]).toBe("/v1/models");

    m.answer(apiError(401, "authentication_error", "invalid x-api-key"));
    expect(await verifyConnection({ provider: "anthropic", apiKey: KEY, baseUrl: m.url, model: "claude-opus-5-5" })).toMatchObject({ ok: false, error: { kind: "auth", status: 401 } });
    m.answer({ json: { data: [{ type: "model", id: "claude-opus-5-5", display_name: "x", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null } });
    expect(await verifyConnection({ provider: "anthropic", apiKey: KEY, baseUrl: m.url, model: "claude-opus-5-5" })).toEqual({ ok: true, models: ["claude-opus-5-5"] });
  });
});
