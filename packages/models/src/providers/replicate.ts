/**
 * Replicate predictions (DeepSeek V3.1 and V3, and other language models Replicate hosts), over fetch.
 *
 * No language model on Replicate takes native tools: a model takes one `prompt` string and returns text. This adapter
 * emulates tool use with a prompted JSON protocol. The prompt carries the system text, the current date, the tools as
 * JSON Schema and a reply contract ("exactly one JSON object: {"tool_calls":[...]} or {"answer":"..."}"), then the
 * transcript with earlier assistant turns re-serialized in that same protocol and tool results labelled by call id and
 * tool name. The reply is parsed tolerantly (code fences, prose around the object, thinking blocks); a reply that is
 * not protocol JSON becomes a plain text answer, never a crash. Without tools the prompt is plain and so is the reply.
 *
 * A prediction is created with `Prefer: wait=60`, which usually returns it finished; one still starting or processing
 * is polled until it ends, honouring the caller's abort and the timeout, and cancelled on Replicate when abandoned.
 */
import { createHash } from "node:crypto";
import { ModelError, type ChatMessage, type ClientOptions, type ModelClient, type ModelTurn, type Part, type ToolSpec } from "../model.ts";
import { DEFAULT_TIMEOUT_MS, errorDetail, httpError, joinUrl, num, parseToolArguments, redact, requestJson, transportError, withRetries } from "./http.ts";

export const REPLICATE_BASE_URL = "https://api.replicate.com";

/** The language models the connection dialog suggests (and listModels returns: Replicate has no chat model list). */
export const REPLICATE_MODELS = ["deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3"] as const;

/** Low, so the model sticks to the JSON protocol and agent runs stay repeatable. */
const TEMPERATURE = 0.2;
/** First wait between polls of an unfinished prediction; it doubles up to POLL_MAX_MS. */
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 2_000;

export type ReplicateAdapterOptions = ClientOptions & {
  apiKey: string;
  /** `owner/name` (the model's latest version) or `owner/name:version`. */
  model: string;
  baseUrl?: string;
  /** The clock for the date line of the prompt (tests pin it). */
  now?: () => Date;
};

type WirePrediction = {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  output?: unknown;
  error?: unknown;
  urls?: { get?: unknown; cancel?: unknown } | null;
  metrics?: Record<string, unknown> | null;
};

// ------------------------------------------------------------------ prompt

function protocolText(tools: ToolSpec[]): string {
  const list = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema })).join("\n");
  return [
    "You can call these tools. Each line is one tool: its name, what it does, and the JSON Schema of its input.",
    list,
    "",
    "How to reply:",
    'Reply with exactly one JSON object and nothing else: {"tool_calls":[{"name":"<tool>","input":{...}}]} to call tools, or {"answer":"<final answer>"} when done.',
    "- One reply may call several tools; their results come back labelled with the call id and tool name.",
    "- The input of a call must match the tool's schema. Use only the tools listed above.",
    "- Never invent a tool result. Wait for it, then decide the next step.",
    "- No text outside the JSON object, no code fences.",
  ].join("\n");
}

/** Today's date line, unless the system prompt already states today's date. */
function dateLine(system: string, now: Date): string | null {
  const day = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return system.includes(day) ? null : `Current date: ${weekday} ${day} (UTC).`;
}

/** An assistant turn as the protocol would have it: tool calls with their ids, or the answer. */
function assistantJson(m: ChatMessage): string {
  const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [{ id: p.id, name: p.name, input: p.input }] : []));
  const text = m.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n")
    .trim();
  return JSON.stringify(calls.length ? { tool_calls: calls } : { answer: text });
}

/**
 * The neutral request as one prompt: system, date, tools and protocol, then the transcript ending in "Assistant:".
 * Exported for tests.
 */
export function toReplicatePrompt(req: { system: string; tools: ToolSpec[]; messages: ChatMessage[] }, now: Date = new Date()): string {
  const head = [req.system.trim(), dateLine(req.system, now), req.tools.length ? protocolText(req.tools) : null].filter((s): s is string => Boolean(s));
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const m of req.messages) {
    if (m.role === "assistant") {
      for (const p of m.parts) if (p.type === "tool_call") names.set(p.id, p.name);
      lines.push(`Assistant: ${req.tools.length ? assistantJson(m) : m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")}`);
      continue;
    }
    for (const p of m.parts) {
      if (p.type !== "tool_result") continue;
      const label = `${p.isError ? "Tool error" : "Tool result"} (id ${p.id}, ${names.get(p.id) ?? "unknown tool"})`;
      lines.push(`${label}:\n${p.content}`);
    }
    const text = m.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n")
      .trim();
    if (text) lines.push(`User: ${text}`);
  }
  return `${head.join("\n\n")}\n\n${lines.join("\n\n")}\n\nAssistant:`;
}

// ------------------------------------------------------------------ reply

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every balanced `{...}` span of the text, in order of its start (strings and escapes respected). */
function* objectSpans(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        yield text.slice(start, i + 1);
        break;
      }
    }
  }
}

/** The first protocol object in the reply ({"answer"} or {"tool_calls"}), or null. */
function protocolObject(text: string): Record<string, unknown> | null {
  for (const span of objectSpans(text)) {
    let v: unknown;
    try {
      v = JSON.parse(span);
    } catch {
      continue;
    }
    if (isObj(v) && (Array.isArray(v.tool_calls) || typeof v.answer === "string")) return v;
  }
  return null;
}

/** A tool call id that is the same for the same call at the same point of the conversation. */
function callId(turn: number, index: number, name: string, input: unknown): string {
  return `call_${createHash("sha256").update(JSON.stringify([turn, index, name, input])).digest("hex").slice(0, 16)}`;
}

/** Thinking blocks and code fences off, whitespace trimmed. */
function cleanReply(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/```[a-zA-Z]*\s*\n?/g, "")
    .trim();
}

/**
 * The model's text as neutral parts. `turn` (the number of assistant turns before this one) seeds the call ids.
 * Exported for tests.
 */
export function parseReplicateReply(raw: string, o: { tools: boolean; turn: number }): { parts: Part[]; protocol: boolean } {
  const text = cleanReply(raw);
  if (!o.tools) return { parts: text ? [{ type: "text", text }] : [], protocol: true };
  const obj = protocolObject(text);
  if (!obj) return { parts: text ? [{ type: "text", text }] : [], protocol: false };
  const parts: Part[] = [];
  const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  if (answer) parts.push({ type: "text", text: answer });
  const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
  calls.forEach((c, i) => {
    const call = isObj(c) ? c : {};
    const fn = isObj(call.function) ? call.function : {};
    const name = typeof call.name === "string" && call.name.trim() ? call.name.trim() : typeof fn.name === "string" ? fn.name.trim() : "";
    const args = parseToolArguments(call.input ?? call.arguments ?? fn.arguments);
    const id = callId(o.turn, i, name, args.input);
    if (!name) parts.push({ type: "tool_call", id, name: "(unnamed)", input: {}, inputError: "the tool call has no name" });
    else parts.push({ type: "tool_call", id, name, input: args.input, ...(args.inputError ? { inputError: args.inputError } : {}) });
  });
  return { parts, protocol: true };
}

/** The prediction's output as text: an array of chunks (streaming language models) or one string. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((x) => (typeof x === "string" ? x : "")).join("");
  return "";
}

// ------------------------------------------------------------------ HTTP

/** Replicate's error bodies are problem details ({ title, detail, status }); older ones use { detail } or { error }. */
function replicateDetail(body: unknown): string {
  if (isObj(body)) {
    if (typeof body.detail === "string" && body.detail.trim()) return body.detail.trim();
    if (typeof body.title === "string" && body.title.trim()) return body.title.trim();
  }
  return errorDetail(body);
}

function replicateErrorOf(apiKey: string, model: string) {
  return (status: number, body: unknown, headers: Headers): ModelError => {
    const detail = replicateDetail(body);
    // Out of credit: a quota problem waiting does not fix (like OpenAI's insufficient_quota), so never retried.
    if (status === 402) {
      return new ModelError("rate_limit", `the Replicate account is out of credit (402); add credit at https://replicate.com/account/billing${detail ? `: ${redact(detail, apiKey)}` : ""}`, {
        status,
        provider: "replicate",
        retryable: false,
      });
    }
    if (status === 404) return httpError("replicate", status, `model ${model} was not found on Replicate${detail ? ` (${detail})` : ""}`, { headers, apiKey, kind: "bad_request" });
    if (status === 422) return httpError("replicate", status, detail || "the model refused the input", { headers, apiKey, kind: "bad_request" });
    return httpError("replicate", status, detail, { headers, apiKey });
  };
}

function headersOf(apiKey: string, waitSec?: number): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, ...(waitSec ? { prefer: `wait=${waitSec}` } : {}) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** `owner/name` runs the model's latest version; `owner/name:version` runs that version. */
function modelRoute(base: string, model: string): { url: string; version: string | null } {
  const [ref, version] = model.split(":", 2) as [string, string | undefined];
  if (!/^[\w.-]+\/[\w.-]+$/.test(ref)) {
    throw new ModelError("bad_request", `Replicate model ids look like owner/name or owner/name:version, got ${model}`, { provider: "replicate" });
  }
  if (version) return { url: joinUrl(base, "v1/predictions"), version };
  return { url: joinUrl(base, `v1/models/${ref}/predictions`), version: null };
}

export function replicateModel(o: ReplicateAdapterOptions): ModelClient {
  const base = (o.baseUrl ?? REPLICATE_BASE_URL).replace(/\/+$/, "");
  const f = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onError = replicateErrorOf(o.apiKey, o.model);
  const route = modelRoute(base, o.model);

  /** The poll URL of a prediction: Replicate's own `urls.get` when it is on our base URL, else built from the id. */
  const pollUrl = (p: WirePrediction): string | null => {
    const get = typeof p.urls?.get === "string" ? p.urls.get : null;
    if (get && new URL(get).origin === new URL(base).origin) return get;
    return typeof p.id === "string" && p.id ? joinUrl(base, `v1/predictions/${encodeURIComponent(p.id)}`) : null;
  };

  /** Best effort: an abandoned prediction is cancelled so it stops costing money. */
  const cancel = (p: WirePrediction) => {
    if (typeof p.id !== "string" || !p.id) return;
    void f(joinUrl(base, `v1/predictions/${encodeURIComponent(p.id)}/cancel`), { method: "POST", headers: headersOf(o.apiKey), signal: AbortSignal.timeout(10_000) }).then(
      (r) => r.body?.cancel(),
      () => undefined,
    );
  };

  return {
    provider: "replicate",
    model: o.model,
    async turn(req, opts) {
      const deadline = Date.now() + timeoutMs;
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), timeoutMs);
      const signal = opts?.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
      const left = () => Math.max(1, deadline - Date.now());
      const input = {
        prompt: toReplicatePrompt(req, now()),
        max_tokens: req.maxTokens,
        temperature: TEMPERATURE,
      };
      let p: WirePrediction | null = null;
      try {
        p = (await withRetries(o.maxRetries ?? 0, signal, () =>
          requestJson({
            provider: "replicate",
            apiKey: o.apiKey,
            url: route.url,
            headers: headersOf(o.apiKey, Math.min(60, Math.max(1, Math.floor(left() / 1000)))),
            body: route.version ? { version: route.version, input } : { input },
            fetch: f,
            timeoutMs: left(),
            signal,
            onError,
          }),
        )) as WirePrediction;
        for (let wait = POLL_FIRST_MS; p.status === "starting" || p.status === "processing"; wait = Math.min(POLL_MAX_MS, wait * 2)) {
          const url = pollUrl(p);
          if (!url) throw new ModelError("unknown", "Replicate answered an unfinished prediction without an id", { provider: "replicate", retryable: true });
          await sleep(Math.min(wait, left()), signal);
          const current: WirePrediction = p;
          p = (await withRetries(o.maxRetries ?? 0, signal, () =>
            requestJson({ provider: "replicate", apiKey: o.apiKey, url, headers: headersOf(o.apiKey), fetch: f, timeoutMs: left(), signal, onError }),
          )) as WirePrediction;
          if (!p.id) p = { ...p, id: current.id };
        }
      } catch (err) {
        if (p && (p.status === "starting" || p.status === "processing")) cancel(p);
        // Our own deadline (not the caller's abort): one clear timeout, whichever request or wait it cut short.
        if (timer.signal.aborted && !opts?.signal?.aborted) throw new ModelError("timeout", "Replicate did not finish the prediction in time", { provider: "replicate", cause: err });
        throw transportError("replicate", err, o.apiKey, false);
      } finally {
        clearTimeout(t);
      }
      if (p.status === "failed" || p.status === "canceled") {
        const why = typeof p.error === "string" && p.error.trim() ? p.error.trim() : isObj(p.error) ? JSON.stringify(p.error) : "no reason given";
        throw new ModelError("unknown", `the Replicate prediction ${p.status === "failed" ? "failed" : "was canceled"}: ${redact(why, o.apiKey)}`, { provider: "replicate" });
      }
      if (p.status !== "succeeded") {
        throw new ModelError("unknown", `Replicate answered a prediction with status ${String(p.status)}`, { provider: "replicate", retryable: true });
      }
      return fromPrediction(p, req, o.model);
    },
  };
}

/** A finished prediction as a neutral turn. */
function fromPrediction(p: WirePrediction, req: { tools: ToolSpec[]; messages: ChatMessage[]; maxTokens: number }, requested: string): ModelTurn {
  const m = p.metrics ?? {};
  const usage = { inputTokens: num(m.input_token_count ?? m.token_input_count), outputTokens: num(m.output_token_count ?? m.token_output_count) };
  const turn = req.messages.filter((x) => x.role === "assistant").length;
  const { parts, protocol } = parseReplicateReply(outputText(p.output), { tools: req.tools.length > 0, turn });
  const hasCalls = parts.some((x) => x.type === "tool_call");
  // Replicate reports no finish reason: a reply that is not protocol JSON and used the whole budget was cut off.
  const cut = !protocol && usage.outputTokens > 0 && usage.outputTokens >= req.maxTokens;
  const variant = typeof m.model_variant === "string" && m.model_variant.trim() ? m.model_variant.trim() : null;
  return {
    parts,
    stop: hasCalls ? "tool_use" : cut ? "max_tokens" : "end",
    usage,
    model: variant ?? (typeof p.model === "string" && p.model ? p.model : requested),
  };
}

/**
 * Replicate has no list of chat models, so a connection is checked with GET /v1/account (a rejected token is a 401)
 * and the curated list comes back.
 */
export async function listReplicateModels(o: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<string[] | null> {
  await requestJson({
    provider: "replicate",
    apiKey: o.apiKey,
    url: joinUrl(o.baseUrl ?? REPLICATE_BASE_URL, "v1/account"),
    headers: headersOf(o.apiKey),
    fetch: o.fetch ?? fetch,
    timeoutMs: o.timeoutMs ?? 30_000,
    signal: o.signal,
    onError: replicateErrorOf(o.apiKey, "(account)"),
  });
  return [...REPLICATE_MODELS];
}
