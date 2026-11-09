/**
 * Google Gemini through the `generateContent` REST API, over fetch. Tools are `functionDeclarations`; the model calls
 * them with `functionCall` parts and gets `functionResponse` parts back. Gemini accepts only a subset of JSON Schema,
 * so tool schemas go through `toGeminiSchema` first. A model turn is replayed with its native parts, which keeps
 * Gemini's thought signatures intact (newer models refuse a function call history without them).
 */
import { ModelError, type ChatMessage, type ClientOptions, type ModelClient, type ModelTurn, type Part, type ToolSpec } from "../model.ts";
import { DEFAULT_TIMEOUT_MS, errorDetail, httpError, joinUrl, num, parseToolArguments, requestJson, withRetries } from "./http.ts";

export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type GoogleAdapterOptions = ClientOptions & { apiKey: string; model: string; baseUrl?: string };

type Json = Record<string, unknown>;
type GeminiPart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown }; functionResponse?: unknown };
type GeminiResponse = {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string; finishMessage?: string }>;
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; cachedContentTokenCount?: unknown };
  modelVersion?: string;
};

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Keywords Gemini's Schema object understands; everything else is dropped. */
const KEEP = new Set(["description", "title", "nullable", "enum", "format", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "minProperties", "maxProperties"]);
const STRING_FORMATS = new Set(["date-time", "enum"]);
const NUMBER_FORMATS = new Set(["float", "double", "int32", "int64"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/** Shallow merge of allOf members: properties and required are unioned, the first value of other keys wins. */
function mergeAll(members: unknown[]): Json {
  const out: Json = {};
  const props: Json = {};
  const required = new Set<string>();
  for (const m of members) {
    if (!isObj(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if (k === "properties" && isObj(v)) Object.assign(props, v);
      else if (k === "required" && Array.isArray(v)) for (const r of v) if (typeof r === "string") required.add(r);
      else if (!(k in out)) out[k] = v;
    }
  }
  if (Object.keys(props).length) out.properties = props;
  if (required.size) out.required = [...required];
  return out;
}

/**
 * JSON Schema to Gemini's schema subset. Drops what Gemini rejects (`$schema`, `additionalProperties`, `default`,
 * `$ref`, `const`, `not`, ...), turns `oneOf` into `anyOf`, merges `allOf`, maps a nullable union (`["string", "null"]`
 * or `anyOf` with `{type: "null"}`) to `nullable: true`, keeps only string enums and the formats Gemini knows, and
 * keeps `required` to the properties that exist. A schema with no type (any JSON value) becomes a free-form object.
 */
export function toGeminiSchema(schema: unknown): Json {
  if (!isObj(schema)) return { type: "object" };
  let s: Json = schema;
  if (Array.isArray(s.allOf)) s = { ...mergeAll(s.allOf), ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "allOf")) };
  const union = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  const out: Json = {};
  if (typeof s.description === "string") out.description = s.description;

  if (union) {
    const nonNull = union.filter((m) => !(isObj(m) && m.type === "null"));
    const nullable = nonNull.length < union.length;
    const conv = nonNull.map(toGeminiSchema);
    if (conv.length === 1) return { ...conv[0], ...out, ...(nullable ? { nullable: true } : {}) };
    // An enum split over several string members (zod literal unions) reads better as one enum.
    if (conv.length > 1 && conv.every((c) => c.type === "string" && Array.isArray(c.enum))) {
      return { type: "string", enum: conv.flatMap((c) => c.enum as string[]), ...out, ...(nullable ? { nullable: true } : {}) };
    }
    return { anyOf: conv.length ? conv : [{ type: "object" }], ...out, ...(nullable ? { nullable: true } : {}) };
  }

  let type = s.type;
  let nullable = s.nullable === true;
  if (Array.isArray(type)) {
    const types = type.filter((t): t is string => typeof t === "string");
    nullable ||= types.includes("null");
    const rest = types.filter((t) => t !== "null" && TYPES.has(t));
    if (rest.length > 1) {
      const base = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "type"));
      return { anyOf: rest.map((t) => toGeminiSchema({ ...base, type: t })), ...out, ...(nullable ? { nullable: true } : {}) };
    }
    type = rest[0];
  }
  if (type === undefined && "const" in s) type = typeof s.const === "string" ? "string" : typeof s.const === "number" ? "number" : typeof s.const === "boolean" ? "boolean" : undefined;
  if (type === undefined && Array.isArray(s.enum) && s.enum.length && s.enum.every((x) => typeof x === "string")) type = "string";
  if (type === undefined && isObj(s.properties)) type = "object";
  if (type === undefined && s.items !== undefined) type = "array";
  if (typeof type !== "string" || !TYPES.has(type)) type = "object";
  out.type = type;
  if (nullable) out.nullable = true;

  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k) || k === "description" || k === "nullable") continue;
    if (k === "enum") {
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string") && type === "string") out.enum = v;
      else if (Array.isArray(v) && v.length) out.description = `${out.description ? `${out.description} ` : ""}One of: ${v.map((x) => JSON.stringify(x)).join(", ")}.`;
      continue;
    }
    if (k === "format") {
      if (typeof v === "string" && ((type === "string" && STRING_FORMATS.has(v)) || ((type === "number" || type === "integer") && NUMBER_FORMATS.has(v)))) out.format = v;
      continue;
    }
    out[k] = v;
  }
  if (typeof s.const === "string" && type === "string") out.enum = [s.const];

  if (type === "object" && isObj(s.properties)) {
    const props = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (Object.keys(props).length) {
      out.properties = props;
      const req = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string" && r in props) : [];
      if (req.length) out.required = req;
    }
  }
  if (type === "array") out.items = toGeminiSchema(s.items ?? {});
  return out;
}

/** A function declaration; a tool without parameters gets none (Gemini refuses an object schema with no properties). */
export function toGeminiTool(t: ToolSpec): Json {
  const params = toGeminiSchema(t.inputSchema);
  const empty = params.type === "object" && !isObj(params.properties);
  return { name: t.name, description: t.description, ...(empty ? {} : { parameters: params }) };
}

/** Ids we made up for calls Gemini sent without one: never sent back, Gemini pairs those by name and order. */
const LOCAL_ID = /^gemini_call_\d+_\d+$/;

export function toGeminiContents(messages: ChatMessage[]): Json[] {
  const names = new Map<string, string>();
  const out: Json[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.parts) if (p.type === "tool_call") names.set(p.id, p.name);
      if (m.native?.provider === "google" && Array.isArray(m.native.content)) {
        out.push({ role: "model", parts: m.native.content });
        continue;
      }
      const parts = m.parts.flatMap((p): Json[] => {
        if (p.type === "text") return p.text ? [{ text: p.text }] : [];
        if (p.type === "tool_call") return [{ functionCall: { ...(LOCAL_ID.test(p.id) ? {} : { id: p.id }), name: p.name, args: p.input } }];
        return [];
      });
      out.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    const parts = m.parts.flatMap((p): Json[] => {
      if (p.type === "text") return [{ text: p.text }];
      if (p.type === "tool_result") {
        const name = names.get(p.id) ?? "unknown_tool";
        return [{ functionResponse: { ...(LOCAL_ID.test(p.id) ? {} : { id: p.id }), name, response: p.isError ? { error: p.content } : { result: p.content } } }];
      }
      return [];
    });
    if (parts.length) out.push({ role: "user", parts });
  }
  return out;
}

const SAFETY_STOPS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);
let turnSeq = 0;

export function fromGeminiResponse(body: GeminiResponse, requested: string): ModelTurn {
  const usage = {
    inputTokens: num(body.usageMetadata?.promptTokenCount),
    // Thinking tokens are billed as output.
    outputTokens: num(body.usageMetadata?.candidatesTokenCount) + num(body.usageMetadata?.thoughtsTokenCount),
    ...(num(body.usageMetadata?.cachedContentTokenCount) ? { cacheReadInputTokens: num(body.usageMetadata?.cachedContentTokenCount) } : {}),
  };
  const model = typeof body.modelVersion === "string" && body.modelVersion ? body.modelVersion : requested;
  const cand = body.candidates?.[0];
  if (!cand) {
    const reason = body.promptFeedback?.blockReason ?? null;
    if (reason) return { parts: [], stop: "refusal", usage, model, refusal: { category: reason.toLowerCase(), explanation: body.promptFeedback?.blockReasonMessage ?? null } };
    throw new ModelError("unknown", "Google Gemini answered without a candidate", { provider: "google", retryable: true });
  }
  const finish = cand.finishReason ?? "STOP";
  if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") {
    throw new ModelError("unknown", `Google Gemini produced an unusable function call (${finish})${cand.finishMessage ? `: ${cand.finishMessage}` : ""}`, { provider: "google", retryable: true });
  }
  const raw = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  const parts: Part[] = [];
  const seq = ++turnSeq;
  let n = 0;
  for (const p of raw) {
    if (p.thought) continue;
    if (typeof p.text === "string" && p.text) {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += p.text;
      else parts.push({ type: "text", text: p.text });
    }
    if (p.functionCall) {
      n++;
      const id = typeof p.functionCall.id === "string" && p.functionCall.id ? p.functionCall.id : `gemini_call_${seq}_${n}`;
      const name = typeof p.functionCall.name === "string" ? p.functionCall.name : "(unnamed)";
      const args = parseToolArguments(p.functionCall.args);
      parts.push({ type: "tool_call", id, name, input: args.input, ...(args.inputError ? { inputError: args.inputError } : {}) });
    }
  }
  for (const p of parts) if (p.type === "text") p.text = p.text.trim();
  const clean = parts.filter((p) => p.type !== "text" || p.text);
  let stop: ModelTurn["stop"];
  if (SAFETY_STOPS.has(finish)) stop = "refusal";
  else if (finish === "MAX_TOKENS") stop = "max_tokens";
  else stop = clean.some((p) => p.type === "tool_call") ? "tool_use" : "end";
  return {
    parts: clean,
    stop,
    usage,
    model,
    ...(stop === "refusal" ? { refusal: { category: finish.toLowerCase(), explanation: cand.finishMessage ?? null } } : {}),
    native: { provider: "google", content: raw },
  };
}

type GoogleErrorBody = { error?: { code?: number; message?: string; status?: string; details?: Array<{ "@type"?: string; reason?: string; retryDelay?: string }> } };

/** Gemini answers a bad key with 400 API_KEY_INVALID, and puts the retry hint of a 429 in RetryInfo. */
export function googleErrorOf(apiKey: string) {
  return (status: number, body: unknown, headers: Headers): ModelError => {
    const e = (body as GoogleErrorBody | null)?.error;
    const detail = errorDetail(body);
    const details = Array.isArray(e?.details) ? e.details : [];
    const badKey = details.some((d) => d.reason === "API_KEY_INVALID") || (status === 400 && /api key/i.test(detail));
    if (badKey) return httpError("google", status, detail, { headers, apiKey, kind: "auth" });
    const delay = details.find((d) => typeof d.retryDelay === "string")?.retryDelay;
    const hinted = delay && /^\d+(\.\d+)?s$/.test(delay) ? Math.round(Number(delay.slice(0, -1)) * 1000) : null;
    return httpError("google", status, detail, { headers, apiKey, ...(hinted !== null ? { retryAfterMs: hinted } : {}) });
  };
}

const modelPath = (m: string) => (m.startsWith("models/") || m.startsWith("tunedModels/") ? m : `models/${m}`);

export function googleModel(o: GoogleAdapterOptions): ModelClient {
  const base = o.baseUrl ?? GOOGLE_BASE_URL;
  const f = o.fetch ?? fetch;
  return {
    provider: "google",
    model: o.model,
    async turn(req, opts) {
      const body = await withRetries(o.maxRetries ?? 0, opts?.signal, () =>
        requestJson({
          provider: "google",
          apiKey: o.apiKey,
          url: joinUrl(base, `${modelPath(o.model)}:generateContent`),
          headers: { "x-goog-api-key": o.apiKey },
          body: {
            systemInstruction: { parts: [{ text: req.system }] },
            contents: toGeminiContents(req.messages),
            ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools.map(toGeminiTool) }] } : {}),
            generationConfig: { maxOutputTokens: req.maxTokens },
          },
          fetch: f,
          timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: opts?.signal,
          onError: googleErrorOf(o.apiKey),
        }),
      );
      return fromGeminiResponse(body as GeminiResponse, o.model);
    },
  };
}

/** The models that support generateContent, without the `models/` prefix (up to 10 pages). */
export async function listGoogleModels(o: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<string[]> {
  const out: string[] = [];
  let page: string | undefined;
  for (let i = 0; i < 10; i++) {
    const body = (await requestJson({
      provider: "google",
      apiKey: o.apiKey,
      url: `${joinUrl(o.baseUrl ?? GOOGLE_BASE_URL, "models")}?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
      headers: { "x-goog-api-key": o.apiKey },
      fetch: o.fetch ?? fetch,
      timeoutMs: o.timeoutMs ?? 30_000,
      signal: o.signal,
      onError: googleErrorOf(o.apiKey),
    })) as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>; nextPageToken?: unknown };
    for (const m of body.models ?? []) {
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : null;
      if (typeof m.name === "string" && (!methods || methods.includes("generateContent"))) out.push(m.name.replace(/^models\//, ""));
    }
    page = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
    if (!page) break;
  }
  return out.sort();
}
