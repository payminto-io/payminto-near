/**
 * The NEAR AI Cloud adapter against a local mock of the gateway (no network, no key). Requests to
 * https://cloud-api.near.ai are rewritten to the mock by an injected fetch, so the registry sees the real base URL.
 * Model lists, the attestation report and error bodies are LIVE recordings; completions and signatures are SYNTHETIC
 * (see nearai-fixtures.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ModelRequest, type ToolSpec } from "../src/model.ts";
import { PROVIDER_IDS } from "../src/model.ts";
import { PROVIDERS, createModelClient, listModels, providerInfo, verifyConnection } from "../src/providers/index.ts";
import {
  NEARAI_BASE_URL,
  NEARAI_DEFAULT_MODEL,
  checkNearAiAttestation,
  fetchNearAiAttestation,
  fetchNearAiSignature,
  isNearAiBaseUrl,
  listNearAiCatalog,
  nearaiModel,
  type NearAiAdapterOptions,
} from "../src/providers/nearai.ts";
import { mockProvider, type MockAnswer, type MockProvider, type SeenRequest } from "./mock-provider.ts";
import { LIVE_MODEL, LIVE_NONCE, LIVE_NOW, ecdsaKey, eip191Sign, liveErrors, liveModelList, liveModels, liveReport, sha256Hex, signatureBody } from "./nearai-fixtures.ts";

const KEY = "sk-test-SECRET0123456789";
const TOOLS: ToolSpec[] = [{ name: "get_quote", description: "Spot quote for a symbol", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } }];
const ask = (text: string, tools = TOOLS): ModelRequest => ({ system: "You are a test agent.", tools, maxTokens: 500, messages: [{ role: "user", parts: [{ type: "text", text }] }] });
const completion = (message: Record<string, unknown>, finish = "stop", id = "chatcmpl-synthetic-1") => ({
  id,
  object: "chat.completion",
  created: 1_780_405_025,
  model: LIVE_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 11, completion_tokens: 70, completion_tokens_details: { reasoning_tokens: 21 }, prompt_tokens_details: { cached_tokens: 4 }, total_tokens: 81 },
});
const errors = liveErrors();
const live401: MockAnswer = { status: 401, json: errors.invalid_key.body };

async function rejection(p: Promise<unknown>): Promise<ModelError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ModelError);
  return e as ModelError;
}

let m: MockProvider;
/** Sends what the adapter addresses to the real gateway to the mock instead. */
let toMock: typeof fetch;
beforeEach(async () => {
  m = await mockProvider();
  toMock = (input, init) => fetch(String(input).replace("https://cloud-api.near.ai", m.url), init);
});
afterEach(async () => {
  await m.close();
});

const SPEC = { provider: "openai_compatible" as const, apiKey: KEY, baseUrl: NEARAI_BASE_URL, model: LIVE_MODEL };
const paths = () => m.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
const query = (r: SeenRequest) => Object.fromEntries(new URL(r.path, "http://x").searchParams);

describe("catalogue", () => {
  it("lists NEAR AI Cloud as a provider of its own, last, with its endpoint, default model and key hint", () => {
    expect(PROVIDER_IDS).toEqual(["anthropic", "openai", "google", "openai_compatible", "replicate", "nearai"]);
    expect(PROVIDERS.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    const p = PROVIDERS.at(-1)!;
    expect(p).toEqual({
      id: "nearai",
      name: "NEAR AI Cloud",
      needsBaseUrl: false,
      defaultBaseUrl: "https://cloud-api.near.ai/v1",
      keyOptional: false,
      suggestedModels: ["z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B", "deepseek-ai/DeepSeek-V4.1-Flash-1017"],
      docsUrl: "https://docs.near.ai/cloud/quickstart",
      presets: [],
      note: expect.stringMatching(/The key starts with sk- and comes from API Keys at cloud\.near\.ai\..*shows what was and was not verified/),
    });
    expect(providerInfo("nearai")).toBe(p);
    // The same nine fields as every other entry: the dashboard reads the catalogue as is.
    for (const x of PROVIDERS) expect(Object.keys(x).sort()).toEqual(Object.keys(PROVIDERS[0]!).sort());
    expect(p.note).not.toMatch(/\u2014/);
  });

  it("offers NEAR AI Cloud first among the OpenAI-compatible presets and detects its base URL", () => {
    const compatible = PROVIDERS.find((p) => p.id === "openai_compatible")!;
    expect(compatible.presets[0]).toEqual({ name: "NEAR AI Cloud", baseUrl: "https://cloud-api.near.ai/v1" });
    expect(compatible.name).toMatch(/NEAR AI Cloud/);
    expect(JSON.parse(JSON.stringify(PROVIDERS))).toEqual(PROVIDERS);
    expect(isNearAiBaseUrl("https://cloud-api.near.ai/v1")).toBe(true);
    expect(isNearAiBaseUrl("https://CLOUD-API.near.ai/v1/")).toBe(true);
    for (const no of ["http://cloud-api.near.ai/v1", "https://cloud-api.near.ai.evil.example/v1", "https://openrouter.ai/api/v1", "https://example.com/cloud-api.near.ai", "not a url", "", undefined, null]) expect(isNearAiBaseUrl(no)).toBe(false);
    expect(NEARAI_DEFAULT_MODEL).toBe("z-ai/glm-5.3-flash");
  });
});

describe("nearai adapter: chat", () => {
  const client = (o: Partial<NearAiAdapterOptions> = {}) => createModelClient(SPEC, { fetch: toMock, attestation: "off", ...o });

  it("is what the registry builds for a NEAR AI Cloud base URL, under the provider id the connection has", async () => {
    m.answer({ json: completion({ content: "HSK is 0.52 USD." }) });
    const c = client();
    expect([c.provider, c.model]).toEqual(["openai_compatible", LIVE_MODEL]);
    const t = await c.turn(ask("What is HSK at?"));
    expect(t).toEqual({ parts: [{ type: "text", text: "HSK is 0.52 USD." }], stop: "end", usage: { inputTokens: 11, outputTokens: 70, cacheReadInputTokens: 4 }, model: LIVE_MODEL });
    const r = m.requests[0]!;
    expect([r.method, r.path, r.headers.authorization]).toEqual(["POST", "/v1/chat/completions", `Bearer ${KEY}`]);
    expect(r.body).toMatchObject({ model: LIVE_MODEL, max_tokens: 500, messages: [{ role: "system", content: "You are a test agent." }, { role: "user", content: "What is HSK at?" }] });
    expect(r.body.tools[0]).toEqual({ type: "function", function: { name: "get_quote", description: "Spot quote for a symbol", parameters: TOOLS[0]!.inputSchema } });
    expect(Object.keys(r.body)).toEqual(["model", "messages", "tools", "max_tokens"]);
    // Attestation off: no alias guard, no attestation or signature requests.
    expect(r.headers["x-no-aliasing"]).toBeUndefined();
    expect(paths()).toEqual(["POST /v1/chat/completions"]);
    expect(t.attestation).toBeUndefined();
  });

  it("maps tool calls, tool results going back, a cut-off answer and a reasoning-only answer", async () => {
    m.answer({ json: completion({ tool_calls: [{ id: "call_a", type: "function", function: { name: "get_quote", arguments: '{"symbol":"HSK"}' } }] }, "tool_calls") });
    expect(await client().turn(ask("Quote HSK."))).toMatchObject({ stop: "tool_use", parts: [{ type: "tool_call", id: "call_a", name: "get_quote", input: { symbol: "HSK" } }] });

    m.answer({ json: completion({ content: "HSK 0.52." }) });
    await client().turn({
      ...ask("Quote HSK."),
      messages: [
        { role: "user", parts: [{ type: "text", text: "Quote HSK." }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "call_a", name: "get_quote", input: { symbol: "HSK" } }] },
        { role: "user", parts: [{ type: "tool_result", id: "call_a", content: "0.52", isError: false }] },
      ],
    });
    expect(m.requests[1]!.body.messages.slice(2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "get_quote", arguments: '{"symbol":"HSK"}' } }] },
      { role: "tool", tool_call_id: "call_a", content: "0.52" },
    ]);

    // A reasoning model that spent its tokens thinking: no content, finish_reason length.
    m.answer({ json: completion({ content: null, reasoning_content: "The user wants..." }, "length") });
    expect(await client().turn(ask("x"))).toMatchObject({ parts: [], stop: "max_tokens" });
  });

  it("maps the gateway's errors: wrong key, no credits, rate limit, overload, alias, timeouts", async () => {
    m.answer(live401);
    const auth = await rejection(client().turn(ask("x")));
    expect(auth).toMatchObject({ kind: "auth", retryable: false, status: 401, provider: "openai_compatible" });
    expect(auth.message).toBe("NEAR AI Cloud rejected the API key (401): Invalid or expired API key. Create or copy a key under API Keys at https://cloud.near.ai (it starts with sk-)");

    m.answer({ status: 401, json: { error: { message: `Invalid or expired API key ${KEY}`, type: "invalid_api_key" } } });
    const echoed = await rejection(client().turn(ask("x")));
    expect(echoed.message).not.toContain("SECRET");
    expect(JSON.stringify(echoed)).not.toContain("SECRET");

    m.answer({ status: 402, json: { error: { message: "Insufficient credits", type: "insufficient_credits", param: null, code: null } } });
    const credits = await rejection(client().turn(ask("x")));
    expect(credits).toMatchObject({ kind: "rate_limit", retryable: false, status: 402 });
    expect(credits.message).toBe("NEAR AI Cloud refused the request: no credits left, or the key's spend limit is reached (402): Insufficient credits. Add credits under Credits at https://cloud.near.ai");

    m.answer({ status: 429, headers: { "retry-after": "7" }, json: { error: { message: "Too many requests", type: "rate_limit_exceeded" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 7_000, message: expect.stringMatching(/^rate limited by NEAR AI Cloud \(429\)/) });
    m.answer({ status: 429, json: { error: { message: "All backends busy", type: "service_overloaded" } } });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: 429 });

    m.answer({ status: 400, json: errors.alias_with_no_aliasing.body });
    const alias = await rejection(client().turn(ask("x")));
    expect(alias).toMatchObject({ kind: "bad_request", retryable: false, status: 400 });
    expect(alias.message).toMatch(/NEAR AI Cloud refused the request \(400\): Model 'glm-latest' is an alias of 'z-ai\/glm-5.3-flash'.*Use the canonical model name/);

    m.answer({ status: 503, json: errors.model_without_attestation.body }, { status: 500, text: "boom" });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", retryable: true, status: 503 });
    expect(await rejection(client().turn(ask("x")))).toMatchObject({ kind: "overloaded", status: 500 });

    m.answer({ hang: true });
    expect(await rejection(client({ timeoutMs: 150 }).turn(ask("x")))).toMatchObject({ kind: "timeout", retryable: true, message: "NEAR AI Cloud did not answer in time" });
    const dead = nearaiModel({ apiKey: KEY, model: LIVE_MODEL, baseUrl: "http://127.0.0.1:1/v1", attestation: "off" });
    expect(await rejection(dead.turn(ask("x")))).toMatchObject({ kind: "network", retryable: true, message: expect.stringMatching(/^cannot reach NEAR AI Cloud/) });

    m.answer({ status: 503, headers: { "retry-after": "0" }, json: { error: { message: "busy" } } }, { json: completion({ content: "ok" }) });
    expect((await client({ maxRetries: 1 }).turn(ask("x"))).parts).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("the nearai provider id", () => {
  const NEARAI = { provider: "nearai" as const, apiKey: KEY, model: LIVE_MODEL };

  it("builds the adapter at NEAR's endpoint and reports its own id, also in errors", async () => {
    m.answer({ json: completion({ content: "ok" }) }, live401);
    const c = createModelClient(NEARAI, { fetch: toMock, attestation: "off" });
    expect([c.provider, c.model]).toEqual(["nearai", LIVE_MODEL]);
    expect((await c.turn(ask("x"))).parts).toEqual([{ type: "text", text: "ok" }]);
    expect(m.requests[0]).toMatchObject({ method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${KEY}` } });
    expect(await rejection(c.turn(ask("x")))).toMatchObject({ kind: "auth", provider: "nearai", message: expect.stringMatching(/^NEAR AI Cloud rejected the API key \(401\)/) });
  });

  it("needs a key, and accepts another base URL (a proxy in front of the gateway)", async () => {
    expect(() => createModelClient({ ...NEARAI, apiKey: " " })).toThrow("NEAR AI Cloud needs an API key");
    expect(await verifyConnection({ ...NEARAI, apiKey: "" })).toMatchObject({ ok: false, error: { kind: "bad_request", provider: "nearai" } });
    m.answer({ json: completion({ content: "via proxy" }) });
    const proxied = createModelClient({ ...NEARAI, baseUrl: `${m.url}/v1` }, { attestation: "off" });
    expect((await proxied.turn(ask("x"))).parts).toEqual([{ type: "text", text: "via proxy" }]);
  });

  it("checks the key, not the public model list, and lists models", async () => {
    m.answer((r) => (r.path === "/v1/check_api_key" ? live401 : { json: liveModels() }));
    const bad = await verifyConnection(NEARAI, { fetch: toMock });
    expect(bad).toMatchObject({ ok: false, error: { kind: "auth", status: 401, provider: "nearai" } });
    expect(bad.ok ? "" : bad.error.message).toBe("NEAR AI Cloud rejected the API key (401): Invalid or expired API key. Create or copy a key under API Keys at https://cloud.near.ai (it starts with sk-)");

    const route = (r: SeenRequest): MockAnswer => (r.path === "/v1/check_api_key" ? { json: { valid: true, organization_id: "o", workspace_id: "w", api_key_id: "k" } } : { json: liveModels() });
    m.answer(route, route, route);
    expect(await verifyConnection(NEARAI, { fetch: toMock })).toMatchObject({ ok: true, models: expect.arrayContaining([LIVE_MODEL]) });
    expect(await listModels({ provider: "nearai", apiKey: KEY }, { fetch: toMock })).toHaveLength(6);
  });

  it("verifies attestation by default", async () => {
    const stranger = ecdsaKey(9);
    const reply = completion({ content: "ok" });
    const route = (r: SeenRequest): MockAnswer => {
      const path = r.path.split("?")[0]!;
      if (path === "/v1/attestation/report") return { json: liveReport() };
      if (path === "/v1/chat/completions") return { json: reply };
      return { json: signatureBody({ kind: "provider_tee", model: LIVE_MODEL, request: "x", response: "y", sign: (t) => eip191Sign(t, stranger), signer: stranger.signer }) };
    };
    m.answer(route, route, route);
    const t = await createModelClient(NEARAI, { fetch: toMock }).turn(ask("x", []));
    expect(paths()).toEqual(["GET /v1/attestation/report", "POST /v1/chat/completions", "GET /v1/signature/chatcmpl-synthetic-1"]);
    // A random nonce against a recorded report, and a signature over other bytes: honestly failed, and still answered.
    expect(t.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(t.attestation).toMatchObject({ status: "failed" });
  });
});

describe("nearai adapter: connection check and model lists", () => {
  it("rejects a wrong key although the public model list would accept it", async () => {
    // What the live gateway does: the key check says 401, the model list says 200 to anyone.
    m.answer((r) => (r.path === "/v1/check_api_key" ? live401 : { json: liveModels() }));
    const bad = await verifyConnection(SPEC, { fetch: toMock });
    expect(bad).toMatchObject({ ok: false, error: { kind: "auth", status: 401, retryable: false } });
    expect(bad.ok ? "" : bad.error.message).toMatch(/NEAR AI Cloud rejected the API key \(401\): Invalid or expired API key\. Create or copy a key under API Keys at https:\/\/cloud\.near\.ai/);
    expect(bad.ok ? "" : bad.error.message).not.toContain(KEY);
    expect(m.requests[0]).toMatchObject({ method: "POST", path: "/v1/check_api_key", headers: { authorization: `Bearer ${KEY}` } });
    expect(paths()).toEqual(["POST /v1/check_api_key"]);
  });

  it("accepts a good key and returns the model list", async () => {
    const route = (r: SeenRequest): MockAnswer => (r.path === "/v1/check_api_key" ? { json: { valid: true, organization_id: "org", workspace_id: "ws", api_key_id: "key" } } : { json: liveModels() });
    m.answer(route, route);
    const ok = await verifyConnection(SPEC, { fetch: toMock });
    expect(ok).toEqual({ ok: true, models: ["Qwen/Qwen3-Embedding-0.6B", "Qwen/Qwen3.8-27B", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "moonshotai/kimi-k3", "openai/gpt-5-nano", "z-ai/glm-5.3-flash"] });
    expect(paths()).toEqual(["POST /v1/check_api_key", "GET /v1/models"]);

    m.answer({ json: liveModels() });
    expect(await listModels({ provider: "openai_compatible", apiKey: KEY, baseUrl: NEARAI_BASE_URL }, { fetch: toMock })).toContain(LIVE_MODEL);
  });

  it("says so when the account has no credits, when the key check says invalid, and when the gateway is down", async () => {
    m.answer({ status: 402, json: { error: { message: "Insufficient credits", type: "insufficient_credits" } } });
    const credits = await verifyConnection(SPEC, { fetch: toMock });
    expect(credits).toMatchObject({ ok: false, error: { kind: "rate_limit", retryable: false, status: 402, message: expect.stringMatching(/no credits left.*Add credits under Credits at https:\/\/cloud\.near\.ai/) } });

    m.answer({ json: { valid: false } });
    expect(await verifyConnection(SPEC, { fetch: toMock })).toMatchObject({ ok: false, error: { kind: "auth", message: expect.stringMatching(/the key is not valid/) } });

    m.answer({ status: 503, text: "upstream down" });
    expect(await verifyConnection(SPEC, { fetch: toMock })).toMatchObject({ ok: false, error: { kind: "overloaded", retryable: true } });
    // No key at all: said before any request goes out.
    const before = m.requests.length;
    expect(await verifyConnection({ ...SPEC, apiKey: " " }, { fetch: toMock })).toMatchObject({ ok: false, error: { kind: "bad_request", message: "NEAR AI Cloud needs an API key (it starts with sk-); create one under API Keys at https://cloud.near.ai" } });
    expect(() => createModelClient({ ...SPEC, apiKey: "" })).toThrow(/NEAR AI Cloud needs an API key/);
    expect(m.requests).toHaveLength(before);
  });

  it("falls back to a one-token completion when a proxy has no key check", async () => {
    m.answer({ status: 404, text: "not found" }, { json: liveModels() }, live401);
    const bad = await verifyConnection(SPEC, { fetch: toMock });
    expect(bad).toMatchObject({ ok: false, error: { kind: "auth" } });
    expect(paths()).toEqual(["POST /v1/check_api_key", "GET /v1/models", "POST /v1/chat/completions"]);
    expect(m.requests[2]!.body.max_tokens).toBe(1);

    m.answer({ status: 404, text: "not found" }, { json: liveModels() }, { json: completion({ content: "O" }, "length") });
    expect(await verifyConnection(SPEC, { fetch: toMock })).toMatchObject({ ok: true, models: expect.arrayContaining([LIVE_MODEL]) });
  });

  it("reads the public catalogue: which models run in NEAR's enclaves, tools, prices", async () => {
    m.answer({ json: liveModelList() });
    const catalog = await listNearAiCatalog({ fetch: toMock });
    expect(m.requests[0]!.headers.authorization).toBeUndefined();
    expect(m.requests[0]!.path).toBe("/v1/model/list?limit=1000");
    const by = Object.fromEntries(catalog.map((x) => [x.id, x]));
    expect(by["z-ai/glm-5.3-flash"]).toMatchObject({ hosting: "near_tee", attestable: true, tools: true, inputUsdPerMTok: 0.08, outputUsdPerMTok: 0.5, contextLength: 1_048_576 });
    expect(by["z-ai/glm-5.3-flash"]!.aliases).toContain("glm-latest");
    expect(by["Qwen/Qwen3.8-27B"]).toMatchObject({ hosting: "near_tee", attestable: true, tools: true, inputUsdPerMTok: 0.04, outputUsdPerMTok: 1.35 });
    expect(by["moonshotai/kimi-k3"]).toMatchObject({ hosting: "third_party_tee", attestable: false });
    expect(by["openai/gpt-5-nano"]).toMatchObject({ hosting: "external", attestable: false, inputUsdPerMTok: 0.05, outputUsdPerMTok: 0.4 });
    expect(by["Qwen/Qwen3-Embedding-0.6B"]).toMatchObject({ hosting: "near_tee", tools: false });
  });
});

describe("nearai adapter: attestation requests", () => {
  it("asks for the report with a client nonce, the canonical model and no API key", async () => {
    m.answer({ json: liveReport() });
    const fetched = await fetchNearAiAttestation({ fetch: toMock, apiKey: KEY, model: LIVE_MODEL, nonce: LIVE_NONCE });
    expect(fetched).toMatchObject({ nonce: LIVE_NONCE, model: LIVE_MODEL, modelEvidenceError: null });
    const r = m.requests[0]!;
    expect([r.method, r.path.split("?")[0], r.headers["x-no-aliasing"], r.headers.authorization]).toEqual(["GET", "/v1/attestation/report", "true", undefined]);
    expect(query(r)).toEqual({ model: LIVE_MODEL, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce: LIVE_NONCE });

    m.answer({ json: liveReport() });
    await fetchNearAiAttestation({ fetch: toMock, apiKey: KEY, sendKey: true, model: LIVE_MODEL });
    expect(m.requests[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(query(m.requests[1]!).nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(query(m.requests[1]!).nonce).not.toBe(LIVE_NONCE);
    await expect(fetchNearAiAttestation({ fetch: toMock, nonce: "xyz" })).rejects.toThrow(/64 hex characters/);
  });

  it("verifies a fetched report end to end, and falls back to the gateway report for a model without one", async () => {
    m.answer({ json: liveReport() });
    const a = await checkNearAiAttestation({ fetch: toMock, model: LIVE_MODEL, nonce: LIVE_NONCE, now: LIVE_NOW });
    expect(a).toMatchObject({ status: "partially_verified", model: LIVE_MODEL });
    expect(a.models).toHaveLength(1);

    // The live gateway answers 503 for a model that has no NEAR enclave report (recorded).
    m.answer({ status: 503, json: errors.model_without_attestation.body }, { json: { gateway_attestation: liveReport().gateway_attestation } });
    const external = await checkNearAiAttestation({ fetch: toMock, model: "openai/gpt-5-nano", nonce: LIVE_NONCE, now: LIVE_NOW });
    expect(external.status).toBe("failed");
    expect(external.gateway?.status).toBe("partially_verified");
    expect(external.checks.find((c) => c.id === "model_evidence")).toMatchObject({ status: "fail", detail: "no NEAR model report for openai/gpt-5-nano: Provider error: No provider found that supports attestation reports for model: openai/gpt-5-nano" });
    expect(query(m.requests.at(-1)!)).toEqual({ include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce: LIVE_NONCE });
    expect(m.requests.at(-1)!.headers["x-no-aliasing"]).toBeUndefined();
  });

  it("never throws when the attestation endpoint is unreachable", async () => {
    const a = await checkNearAiAttestation({ baseUrl: "http://127.0.0.1:1/v1", model: LIVE_MODEL, maxRetries: 0 });
    expect(a).toMatchObject({ status: "failed", gateway: null, models: [] });
    expect(a.checks).toEqual([expect.objectContaining({ id: "report_fetched", status: "fail", detail: expect.stringMatching(/could not be fetched, so nothing is verified \(cannot reach NEAR AI Cloud/) })]);
  });

  it("retries a signature that is not recorded yet, then gives up without throwing", async () => {
    const body = { text: "a:b", signature: "00", signing_address: "0x00", signing_algo: "ecdsa", signature_kind: "gateway" };
    m.answer({ status: 404, json: { error: { message: "Signature not found", type: "not_found" } } }, { json: body });
    expect(await fetchNearAiSignature({ fetch: toMock, apiKey: KEY, chatId: "chatcmpl-1", delayMs: 1 })).toEqual({ signature: body, error: null });
    expect(m.requests[1]).toMatchObject({ method: "GET", path: "/v1/signature/chatcmpl-1?signing_algo=ecdsa", headers: { authorization: `Bearer ${KEY}` } });

    const missing = { status: 404, json: { error: { message: "Signature not found", type: "not_found" } } };
    m.answer(missing, missing);
    const none = await fetchNearAiSignature({ fetch: toMock, apiKey: KEY, chatId: "chatcmpl-2", attempts: 2, delayMs: 1 });
    expect(none).toEqual({ signature: null, error: expect.stringMatching(/\(404\): Signature not found/) });
    m.answer(live401);
    expect((await fetchNearAiSignature({ fetch: toMock, apiKey: KEY, chatId: "x", delayMs: 1 })).error).toMatch(/rejected the API key/);
    expect(m.requests).toHaveLength(5);
  });
});

describe("nearai adapter: attestation around a turn", () => {
  const stranger = ecdsaKey(9);
  /** Routes the three endpoints of an attested turn; the signature is made over the bytes the mock really exchanged. */
  function gateway(o: { report?: MockAnswer; reply?: unknown; signature?: (request: string, response: string) => MockAnswer } = {}) {
    const reply = o.reply ?? completion({ content: "ok" });
    let sent = "";
    const route = (r: SeenRequest): MockAnswer => {
      const path = r.path.split("?")[0]!;
      if (path === "/v1/attestation/report") return o.report ?? { json: liveReport() };
      if (path === "/v1/chat/completions") {
        sent = JSON.stringify(r.body);
        return { json: reply };
      }
      if (path.startsWith("/v1/signature/")) {
        return o.signature ? o.signature(sent, JSON.stringify(reply)) : { json: signatureBody({ kind: "provider_tee", model: LIVE_MODEL, request: sent, response: JSON.stringify(reply), sign: (t) => eip191Sign(t, stranger), signer: stranger.signer }) };
      }
      return { status: 404, text: "not found" };
    };
    m.answer(route, route, route, route, route, route);
  }
  const client = (o: Partial<NearAiAdapterOptions> = {}) => nearaiModel({ apiKey: KEY, model: LIVE_MODEL, fetch: toMock, now: () => LIVE_NOW, nonce: () => LIVE_NONCE, signatureDelayMs: 1, ...o });

  it("verifies the enclaves before the key is sent, hashes the exact bytes, and reports the result on the turn", async () => {
    gateway();
    const t = await client().turn(ask("Reply with the word ok.", []));
    expect(t.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(paths()).toEqual(["GET /v1/attestation/report", "POST /v1/chat/completions", "GET /v1/signature/chatcmpl-synthetic-1"]);
    // The preflight goes out without the key; the completion carries the alias guard.
    expect(m.requests[0]!.headers.authorization).toBeUndefined();
    expect(m.requests[1]!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "x-no-aliasing": "true" });

    const a = t.attestation as import("../src/attestation/nearai.ts").NearAiResponseVerification;
    expect(a.kind).toBe("nearai_response");
    // The hashes are of the bytes on the wire, so the synthetic signature's text matches...
    expect(a.requestHash).toBe(sha256Hex(JSON.stringify(m.requests[1]!.body)));
    expect(a.checks.find((c) => c.id === "signed_text")).toMatchObject({ status: "pass" });
    expect(a.checks.find((c) => c.id === "signature_valid")).toMatchObject({ status: "pass" });
    // ...but the signer is a throwaway key, not the enclave key of the recorded report: the answer is not verified.
    expect(a).toMatchObject({ status: "failed", boundTo: null, signatureKind: "provider_tee", attestation: { status: "partially_verified", nonce: LIVE_NONCE } });
    expect(a.checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual(["signer_attested", "model_binding"]);
    expect(a.summary).toMatch(/^Not verified: the signer .* matches no model enclave report/);
  });

  it("reuses a verified preflight for the next turn and refreshes it on demand", async () => {
    gateway();
    const c = client();
    await c.turn(ask("one", []));
    await c.turn(ask("two", []));
    expect(paths().filter((p) => p === "GET /v1/attestation/report")).toHaveLength(1);
    expect((await c.attest()).status).toBe("partially_verified");
    expect(paths().filter((p) => p === "GET /v1/attestation/report")).toHaveLength(1);
    await c.attest({ refresh: true });
    expect(paths().filter((p) => p === "GET /v1/attestation/report")).toHaveLength(2);
  });

  it("answers even when attestation is unavailable, and says the answer is unverified", async () => {
    gateway({ report: { status: 500, text: "boom" }, signature: () => ({ status: 404, json: { error: { message: "Signature not found" } } }) });
    const t = await client({ signatureAttempts: 1 }).turn(ask("x", []));
    expect(t.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(t.attestation).toMatchObject({ status: "failed", summary: expect.stringMatching(/no signature available, so the answer is unverified/) });

    // A stale report (made for another nonce): the turn still answers, the result is failed.
    await m.close();
    m = await mockProvider();
    toMock = (input, init) => fetch(String(input).replace("https://cloud-api.near.ai", m.url), init);
    gateway();
    const stale = await client({ nonce: () => "ab".repeat(32), fetch: toMock }).turn(ask("x", []));
    expect(stale.attestation).toMatchObject({ status: "failed" });
    expect(stale.attestation!.checks.find((c) => c.id === "signer_attested")!.status).toBe("fail");
  });

  it("in require mode sends nothing, not even the key, when the preflight fails", async () => {
    gateway();
    const refused = await rejection(client({ attestation: "require", nonce: () => "ab".repeat(32) }).turn(ask("x", [])));
    expect(refused).toMatchObject({ kind: "bad_request", retryable: false, message: expect.stringMatching(/attestation failed, so the request was not sent: Attestation failed \(gateway: the quote carries nonce/) });
    expect(paths()).toEqual(["GET /v1/attestation/report"]);
    expect(m.requests.every((r) => r.headers.authorization === undefined)).toBe(true);

    // An unreachable attestation endpoint keeps its retryable kind.
    const down = await rejection(nearaiModel({ apiKey: KEY, model: LIVE_MODEL, baseUrl: "http://127.0.0.1:1/v1", attestation: "require" }).turn(ask("x", [])));
    expect(down).toMatchObject({ kind: "network", retryable: true });
  });

  it("in require mode discards an answer whose signature does not verify", async () => {
    gateway();
    const e = await rejection(client({ attestation: "require" }).turn(ask("x", [])));
    expect(e).toMatchObject({ kind: "unknown", retryable: false, message: expect.stringMatching(/the answer could not be verified and was discarded: Not verified: the signer/) });
    expect(e.message).not.toContain(KEY);
  });
});
