/**
 * The Gemini adapter against a local mock of the generateContent API, and the JSON Schema conversion.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type ModelRequest, type ToolSpec } from "../src/model.ts";
import { toGeminiSchema, toGeminiTool } from "../src/providers/google.ts";
import { createModelClient, listModels, verifyConnection } from "../src/providers/index.ts";
import { mockProvider, type MockProvider } from "./mock-provider.ts";

const KEY = "AIzaTESTKEY0123456789abcdef";
const TOOLS: ToolSpec[] = [
  {
    name: "get_quote",
    description: "Spot quote",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { symbol: { type: "string", default: "HSK" } }, required: ["symbol"], additionalProperties: false },
  },
  { name: "get_budget", description: "Budget", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
const ask = (text: string, messages: ChatMessage[] = []): ModelRequest => ({ system: "You are a test agent.", tools: TOOLS, maxTokens: 400, messages: [{ role: "user", parts: [{ type: "text", text }] }, ...messages] });

const gen = (parts: unknown[], finishReason = "STOP", usage: unknown = { promptTokenCount: 20, candidatesTokenCount: 6, thoughtsTokenCount: 4, totalTokenCount: 30 }) => ({
  json: { candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }], usageMetadata: usage, modelVersion: "gemini-2.5-pro-002" },
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
const client = (o: { maxRetries?: number } = {}) => createModelClient({ provider: "google", apiKey: KEY, baseUrl: `${m.url}/v1beta`, model: "gemini-2.5-pro" }, o);

describe("google adapter", () => {
  it("answers in plain text, maps usage (thinking counts as output) and builds the request", async () => {
    m.answer(gen([{ text: "thinking...", thought: true }, { text: "HSK is " }, { text: "0.52 USD." }]));
    const t = await client().turn(ask("What is HSK at?"));
    expect(t.parts).toEqual([{ type: "text", text: "HSK is 0.52 USD." }]);
    expect(t).toMatchObject({ stop: "end", usage: { inputTokens: 20, outputTokens: 10 }, model: "gemini-2.5-pro-002", native: { provider: "google" } });
    const r = m.requests[0]!;
    expect([r.method, r.path, r.headers["x-goog-api-key"]]).toEqual(["POST", "/v1beta/models/gemini-2.5-pro:generateContent", KEY]);
    expect(r.path).not.toContain(KEY);
    expect(r.body).toEqual({
      systemInstruction: { parts: [{ text: "You are a test agent." }] },
      contents: [{ role: "user", parts: [{ text: "What is HSK at?" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "get_quote", description: "Spot quote", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
            { name: "get_budget", description: "Budget" },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 400 },
    });
  });

  it("maps a single function call and parallel function calls", async () => {
    m.answer(gen([{ functionCall: { name: "get_quote", args: { symbol: "HSK" } }, thoughtSignature: "sig-1" }]));
    const one = await client().turn(ask("Quote HSK."));
    expect(one.stop).toBe("tool_use");
    expect(one.parts).toEqual([{ type: "tool_call", id: expect.stringMatching(/^gemini_call_\d+_1$/), name: "get_quote", input: { symbol: "HSK" } }]);

    m.answer(gen([{ text: "Both." }, { functionCall: { id: "fc_1", name: "get_quote", args: { symbol: "HSK" } } }, { functionCall: { id: "fc_2", name: "get_quote", args: { symbol: "ETH" } } }]));
    const two = await client().turn(ask("Quote both."));
    expect(two.parts).toEqual([
      { type: "text", text: "Both." },
      { type: "tool_call", id: "fc_1", name: "get_quote", input: { symbol: "HSK" } },
      { type: "tool_call", id: "fc_2", name: "get_quote", input: { symbol: "ETH" } },
    ]);
  });

  it("replays the model turn natively (thought signatures kept) and answers with functionResponse parts", async () => {
    m.answer(gen([{ functionCall: { name: "get_quote", args: { symbol: "HSK" } }, thoughtSignature: "sig-1" }, { functionCall: { name: "get_quote", args: { symbol: "ETH" } } }]));
    const first = await client().turn(ask("Quote both."));
    const [a, b] = first.parts as Array<{ id: string }>;
    const history: ChatMessage[] = [
      { role: "assistant", parts: first.parts, native: first.native },
      {
        role: "user",
        parts: [
          { type: "tool_result", id: a!.id, content: "0.52", isError: false },
          { type: "tool_result", id: b!.id, content: "no supplier", isError: true },
        ],
      },
    ];
    m.answer(gen([{ text: "HSK 0.52; ETH unavailable." }]));
    const second = await client().turn(ask("Quote both.", history));
    expect(second).toMatchObject({ stop: "end", parts: [{ type: "text", text: "HSK 0.52; ETH unavailable." }] });
    expect(m.requests[1]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "Quote both." }] },
      { role: "model", parts: [{ functionCall: { name: "get_quote", args: { symbol: "HSK" } }, thoughtSignature: "sig-1" }, { functionCall: { name: "get_quote", args: { symbol: "ETH" } } }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_quote", response: { result: "0.52" } } }, { functionResponse: { name: "get_quote", response: { error: "no supplier" } } }],
      },
    ]);

    // History written by another provider (no native content) is rebuilt from the neutral parts, ids included.
    m.answer(gen([{ text: "ok" }]));
    await client().turn(ask("x", [{ role: "assistant", parts: [{ type: "tool_call", id: "call_9", name: "get_budget", input: {} }] }, { role: "user", parts: [{ type: "tool_result", id: "call_9", content: "1 USDC", isError: false }] }]));
    expect(m.requests[2]!.body.contents.slice(1)).toEqual([
      { role: "model", parts: [{ functionCall: { id: "call_9", name: "get_budget", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "call_9", name: "get_budget", response: { result: "1 USDC" } } }] },
    ]);
  });

  it("stops on MAX_TOKENS and refuses on SAFETY or a blocked prompt", async () => {
    m.answer(gen([{ text: "Cut" }], "MAX_TOKENS"), gen([], "SAFETY"), { json: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 9 } } });
    expect((await client().turn(ask("x"))).stop).toBe("max_tokens");
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "refusal", refusal: { category: "safety" } });
    expect(await client().turn(ask("x"))).toMatchObject({ stop: "refusal", parts: [], usage: { inputTokens: 9, outputTokens: 0 }, refusal: { category: "prohibited_content" } });
  });

  it("maps a bad key (400 API_KEY_INVALID) to auth, 429 with RetryInfo or Retry-After, 503 to overloaded", async () => {
    m.answer({
      status: 400,
      json: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } },
    });
    const auth = await rejection(client().turn(ask("x")));
    expect(auth).toMatchObject({ kind: "auth", retryable: false, status: 400, provider: "google" });
    expect(auth.message).not.toContain(KEY);

    m.answer({ status: 429, json: { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 12_000 });
    m.answer({ status: 429, headers: { "retry-after": "4" }, json: { error: { code: 429, message: "slow", status: "RESOURCE_EXHAUSTED" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryAfterMs: 4_000 });

    m.answer({ status: 503, json: { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } } }, { status: 403, json: { error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: 503 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "auth", status: 403 });
  });

  it("turns unusable function arguments into a tool error and a malformed call into a retryable error", async () => {
    m.answer(gen([{ functionCall: { name: "get_quote", args: "{symbol" } }, { functionCall: { name: "get_quote", args: ["HSK"] } }]));
    const t = await client().turn(ask("x"));
    expect(t.parts).toEqual([
      { type: "tool_call", id: expect.any(String), name: "get_quote", input: {}, inputError: expect.stringMatching(/not valid JSON/) },
      { type: "tool_call", id: expect.any(String), name: "get_quote", input: {}, inputError: "arguments must be a JSON object, got an array" },
    ]);
    m.answer({ json: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL", finishMessage: "Malformed function call: get_quote(" }] } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "unknown", retryable: true, message: expect.stringMatching(/MALFORMED_FUNCTION_CALL/) });
  });

  it("lists generateContent models across pages and verifies a connection", async () => {
    m.answer(
      { json: { models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent", "countTokens"] }, { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "p2" } },
      { json: { models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] } },
    );
    expect(await listModels({ provider: "google", apiKey: KEY, baseUrl: `${m.url}/v1beta` })).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(m.requests.map((r) => r.path)).toEqual(["/v1beta/models?pageSize=1000", "/v1beta/models?pageSize=1000&pageToken=p2"]);

    m.answer({ json: { models: [{ name: "models/gemini-2.5-pro" }] } });
    expect(await verifyConnection({ provider: "google", apiKey: KEY, baseUrl: `${m.url}/v1beta`, model: "gemini-2.5-pro" })).toEqual({ ok: true, models: ["gemini-2.5-pro"] });
    m.answer({ status: 400, json: { error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } } });
    expect(await verifyConnection({ provider: "google", apiKey: KEY, baseUrl: `${m.url}/v1beta`, model: "gemini-2.5-pro" })).toMatchObject({ ok: false, error: { kind: "auth" } });
  });
});

describe("JSON Schema to Gemini's schema subset", () => {
  it("drops unsupported keywords and keeps the supported ones", () => {
    expect(
      toGeminiSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "x",
        type: "object",
        title: "Args",
        description: "Arguments",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20, exclusiveMinimum: 0, format: "int32" },
          email: { type: "string", format: "email", minLength: 3, pattern: "^.+@.+$" },
          when: { type: "string", format: "date-time" },
          tags: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        },
        required: ["limit", "ghost"],
      }),
    ).toEqual({
      type: "object",
      title: "Args",
      description: "Arguments",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, format: "int32" },
        email: { type: "string", minLength: 3, pattern: "^.+@.+$" },
        when: { type: "string", format: "date-time" },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["limit"],
    });
  });

  it("maps nullable unions, real unions, oneOf, allOf, const and enums sensibly", () => {
    expect(toGeminiSchema({ type: ["string", "null"], description: "maybe" })).toEqual({ type: "string", nullable: true, description: "maybe" });
    expect(toGeminiSchema({ anyOf: [{ type: "number" }, { type: "null" }] })).toEqual({ type: "number", nullable: true });
    expect(toGeminiSchema({ type: ["string", "number"] })).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(toGeminiSchema({ oneOf: [{ type: "string" }, { type: "boolean" }] })).toEqual({ anyOf: [{ type: "string" }, { type: "boolean" }] });
    expect(toGeminiSchema({ anyOf: [{ const: "GET" }, { const: "POST" }] })).toEqual({ type: "string", enum: ["GET", "POST"] });
    expect(toGeminiSchema({ allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] })).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(toGeminiSchema({ enum: ["HSK", "BTC"] })).toEqual({ type: "string", enum: ["HSK", "BTC"] });
    expect(toGeminiSchema({ type: "integer", enum: [1, 2, 3] })).toEqual({ type: "integer", description: "One of: 1, 2, 3." });
  });

  it("gives free-form values a usable shape and omits parameters for a tool without any", () => {
    // z.unknown() lists as {}; z.record(...) as an object with additionalProperties only.
    expect(toGeminiSchema({})).toEqual({ type: "object" });
    expect(toGeminiSchema({ type: "object", additionalProperties: { type: "string" } })).toEqual({ type: "object" });
    expect(toGeminiSchema({ type: "array" })).toEqual({ type: "array", items: { type: "object" } });
    expect(toGeminiSchema({ $ref: "#/definitions/x", not: { type: "string" } })).toEqual({ type: "object" });
    expect(toGeminiTool({ name: "get_budget", description: "Budget", inputSchema: { type: "object", properties: {} } })).toEqual({ name: "get_budget", description: "Budget" });
    // The wallet's call_paid_service shape as zod lists it.
    expect(
      toGeminiTool({
        name: "call_paid_service",
        description: "pay and call",
        inputSchema: {
          type: "object",
          properties: { serviceId: { type: "string" }, query: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} }, body: {} },
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      }),
    ).toEqual({ name: "call_paid_service", description: "pay and call", parameters: { type: "object", properties: { serviceId: { type: "string" }, query: { type: "object" }, body: { type: "object" } } } });
  });
});
