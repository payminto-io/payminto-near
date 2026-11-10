/**
 * OpenAI Chat Completions with function calling, over fetch. The same adapter serves OpenAI-compatible endpoints
 * (`openai-compatible.ts` sets `compatible`), which differ in small ways this file tolerates: missing `usage`, tool
 * arguments sent double-encoded or as an object, missing tool call ids, and `max_tokens` instead of
 * `max_completion_tokens`.
 */
import { ModelError, type ChatMessage, type ClientOptions, type ModelClient, type ModelTurn, type Part, type Provider, type ToolSpec } from "../model.ts";
import { DEFAULT_TIMEOUT_MS, errorDetail, httpError, joinUrl, num, parseToolArguments, requestJson, withRetries } from "./http.ts";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

type TokenParam = "max_completion_tokens" | "max_tokens";

export type OpenAIAdapterOptions = ClientOptions & {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Set by the compatible adapter: provider id in errors, max_tokens first, key optional. */
  compatible?: boolean;
};

type WireToolCall = { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
type WireMessage = { role: string; content?: unknown; tool_calls?: WireToolCall[]; refusal?: unknown };
export type WireCompletion = {
  model?: unknown;
  choices?: Array<{ message?: WireMessage; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null } | null;
};

export function toolsOf(tools: ToolSpec[]) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

/** Neutral history to Chat Completions messages: tool results become `role: "tool"` messages after the assistant turn. */
export function toOpenAIMessages(system: string, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }] : []));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool messages must directly follow the assistant message that called them, so they go before any user text.
    for (const p of m.parts) if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.id, content: p.isError ? `Error: ${p.content}` : p.content });
    const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

/** Message content as text: a string, or the text of an array of content parts (some compatible servers). */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.flatMap((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? [(x as { text: string }).text] : [])).join("");
}

export function fromOpenAICompletion(body: WireCompletion, requested: string, provider: Provider = "openai"): ModelTurn {
  const choice = body.choices?.[0];
  const msg = choice?.message;
  if (!choice || !msg) throw new ModelError("unknown", "the model answered without a choice", { provider, retryable: true });
  const parts: Part[] = [];
  const text = contentText(msg.content).trim();
  if (text) parts.push({ type: "text", text });
  let n = 0;
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    n++;
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    const id = typeof call.id === "string" && call.id ? call.id : `call_${n}`;
    const args = parseToolArguments(call.function?.arguments);
    if (!name) {
      parts.push({ type: "tool_call", id, name: "(unnamed)", input: {}, inputError: "the tool call has no function name" });
      continue;
    }
    parts.push({ type: "tool_call", id, name, input: args.input, ...(args.inputError ? { inputError: args.inputError } : {}) });
  }
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";
  const refusalText = typeof msg.refusal === "string" && msg.refusal.trim() ? msg.refusal.trim() : null;
  const hasCalls = parts.some((p) => p.type === "tool_call");
  let stop: ModelTurn["stop"];
  if (refusalText || finish === "content_filter") stop = "refusal";
  else if (finish === "length") stop = "max_tokens";
  else stop = hasCalls ? "tool_use" : "end";
  const u = body.usage ?? null;
  const cached = num(u?.prompt_tokens_details?.cached_tokens);
  return {
    parts,
    stop,
    usage: { inputTokens: num(u?.prompt_tokens), outputTokens: num(u?.completion_tokens), ...(cached ? { cacheReadInputTokens: cached } : {}) },
    model: typeof body.model === "string" && body.model ? body.model : requested,
    ...(stop === "refusal" ? { refusal: { category: finish === "content_filter" ? "content_filter" : null, explanation: refusalText } } : {}),
  };
}

/** True when a 400 says the token-limit parameter we sent is not supported (so the other one is worth one retry). */
function rejectsParam(err: ModelError, param: TokenParam): boolean {
  return err.kind === "bad_request" && err.status === 400 && err.message.includes(param) && /not supported|unsupported|unrecognized|unknown|not permitted|extra (?:fields|inputs)/i.test(err.message);
}

export function openaiErrorOf(provider: Provider, apiKey: string) {
  return (status: number, body: unknown, headers: Headers): ModelError => {
    const detail = errorDetail(body);
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    // An exhausted quota is a 429 that waiting does not fix.
    if (status === 429 && code === "insufficient_quota") return httpError(provider, status, detail || "the account has no quota left", { headers, apiKey, retryable: false });
    return httpError(provider, status, detail, { headers, apiKey });
  };
}

export function openaiHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function openaiModel(o: OpenAIAdapterOptions): ModelClient {
  const provider: Provider = o.compatible ? "openai_compatible" : "openai";
  const base = o.baseUrl ?? OPENAI_BASE_URL;
  const f = o.fetch ?? fetch;
  const onError = openaiErrorOf(provider, o.apiKey);
  // OpenAI wants max_completion_tokens (reasoning models refuse max_tokens); most compatible servers know max_tokens.
  let tokenParam: TokenParam = o.compatible ? "max_tokens" : "max_completion_tokens";
  let switched = false;
  return {
    provider,
    model: o.model,
    async turn(req, opts) {
      const send = () =>
        requestJson({
          provider,
          apiKey: o.apiKey,
          url: joinUrl(base, "chat/completions"),
          headers: openaiHeaders(o.apiKey),
          body: {
            model: o.model,
            messages: toOpenAIMessages(req.system, req.messages),
            ...(req.tools.length ? { tools: toolsOf(req.tools) } : {}),
            [tokenParam]: req.maxTokens,
          },
          fetch: f,
          timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: opts?.signal,
          onError,
        });
      const body = await withRetries(o.maxRetries ?? 0, opts?.signal, async () => {
        try {
          return await send();
        } catch (err) {
          if (!switched && err instanceof ModelError && rejectsParam(err, tokenParam)) {
            switched = true;
            tokenParam = tokenParam === "max_tokens" ? "max_completion_tokens" : "max_tokens";
            return await send();
          }
          throw err;
        }
      });
      return fromOpenAICompletion(body as WireCompletion, o.model, provider);
    },
  };
}

/** GET /models: the ids, or null when the endpoint has no model list (404 or 405 on some compatible servers). */
export async function listOpenAIModels(o: { provider: Provider; apiKey: string; baseUrl: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<string[] | null> {
  try {
    const body = (await requestJson({
      provider: o.provider,
      apiKey: o.apiKey,
      url: joinUrl(o.baseUrl, "models"),
      headers: openaiHeaders(o.apiKey),
      fetch: o.fetch ?? fetch,
      timeoutMs: o.timeoutMs ?? 30_000,
      signal: o.signal,
      onError: openaiErrorOf(o.provider, o.apiKey),
    })) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return null;
    return body.data.flatMap((m) => (typeof m.id === "string" ? [m.id] : [])).sort();
  } catch (err) {
    if (err instanceof ModelError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
}
