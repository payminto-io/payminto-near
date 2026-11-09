/**
 * Claude through the official Anthropic SDK (Messages API, beta surface). Every turn is streamed (long turns never hit
 * an HTTP timeout) and the final message is returned. Prompt caching: the system prompt carries a breakpoint (tools
 * render before it, so both are cached) and the top-level breakpoint caches the growing conversation turn by turn.
 * Adaptive thinking is on for the models that have it, with effort as the control. A policy decline is retried on
 * Anthropic's recommended fallback model server-side (`fallbacks: "default"`) where the model supports it; if the whole
 * chain declines, the turn stops with "refusal". Assistant turns are replayed with their native content (thinking
 * blocks included), so history stays append-only.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ModelError, DEFAULT_MODEL, type ChatMessage, type ClientOptions, type ModelClient, type ModelTurn, type Part, type ToolSpec } from "../model.ts";
import { DEFAULT_TIMEOUT_MS, errorDetail, httpError, parseToolArguments, redact } from "./http.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;
type Tool = Anthropic.Beta.Messages.BetaTool;

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export type AnthropicAdapterOptions = ClientOptions & { apiKey: string; model?: string; baseUrl?: string };

/** Models with adaptive thinking and the effort control (Claude 4.6 and newer). */
const ADAPTIVE = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|(?:opus|sonnet)-4-[6-9])/;
/** Models that take the server-side refusal fallback in its "default" form. */
const FALLBACK = /^claude-(?:fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

function toolsOf(tools: ToolSpec[]): Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Tool["input_schema"], eager_input_streaming: true }));
}

/** Neutral history to Messages API params. Claude's own turns go back exactly as they came (native content). */
export function toAnthropicMessages(messages: ChatMessage[]): MessageParam[] {
  return messages.map((m): MessageParam => {
    if (m.role === "assistant") {
      if (m.native?.provider === "anthropic" && Array.isArray(m.native.content)) return { role: "assistant", content: m.native.content as ContentBlockParam[] };
      const content = m.parts.flatMap((p): ContentBlockParam[] => {
        if (p.type === "text") return p.text ? [{ type: "text", text: p.text }] : [];
        if (p.type === "tool_call") return [{ type: "tool_use", id: p.id, name: p.name, input: p.input }];
        return [];
      });
      return { role: "assistant", content };
    }
    // Tool results come first in a user message, text after them.
    const results = m.parts.flatMap((p): ContentBlockParam[] =>
      p.type === "tool_result" ? [{ type: "tool_result", tool_use_id: p.id, content: p.content || "(empty)", ...(p.isError ? { is_error: true } : {}) }] : [],
    );
    const texts = m.parts.flatMap((p): ContentBlockParam[] => (p.type === "text" ? [{ type: "text", text: p.text }] : []));
    if (results.length === 0 && texts.length === 1 && texts[0]!.type === "text") return { role: "user", content: texts[0]!.text };
    return { role: "user", content: [...results, ...texts] };
  });
}

/**
 * `rawInput` holds the streamed JSON of each tool_use block by content index. With eager input streaming the SDK's
 * tolerant parser can return a silently truncated object, so the raw JSON is parsed strictly here and a block that
 * does not parse becomes an inputError (a tool error back to the model) instead of a call with cut-off arguments.
 */
export function fromAnthropicMessage(msg: Message, rawInput: ReadonlyMap<number, string> = new Map()): ModelTurn {
  const parts: Part[] = [];
  msg.content.forEach((b, i) => {
    if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") {
      const raw = rawInput.get(i);
      const args = parseToolArguments(raw ?? b.input);
      parts.push({ type: "tool_call", id: b.id, name: b.name, input: args.input, ...(args.inputError ? { inputError: args.inputError } : {}) });
    }
  });
  const reason = msg.stop_reason;
  let stop: ModelTurn["stop"];
  if (reason === "refusal") stop = "refusal";
  else if (reason === "max_tokens" || reason === "model_context_window_exceeded") stop = "max_tokens";
  else if (reason === "tool_use") stop = "tool_use";
  // end_turn, stop_sequence; pause_turn only follows server tools, which this adapter never sends.
  else stop = parts.some((p) => p.type === "tool_call") ? "tool_use" : "end";
  const d = msg.stop_details as { category?: string | null; explanation?: string | null } | null | undefined;
  return {
    parts,
    stop,
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
    model: msg.model,
    ...(stop === "refusal" ? { refusal: { category: d?.category ?? null, explanation: d?.explanation ?? null } } : {}),
    native: { provider: "anthropic", content: msg.content },
  };
}

/** SDK errors to ModelError, most specific first. */
export function anthropicError(err: unknown, apiKey: string): ModelError {
  if (err instanceof ModelError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ModelError("timeout", "the request to Anthropic was aborted", { provider: "anthropic", cause: err });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelError("timeout", "Anthropic did not answer in time", { provider: "anthropic", cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new ModelError("network", `cannot reach Anthropic: ${redact(err.message, apiKey)}`, { provider: "anthropic", cause: err });
  if (err instanceof Anthropic.APIError) {
    const detail = errorDetail(err.error) || err.message;
    if (typeof err.status === "number") {
      const e = httpError("anthropic", err.status, detail, { headers: err.headers ?? undefined, apiKey });
      return err.status === 404 ? new ModelError("bad_request", `${e.message} (check the model id)`, { status: 404, provider: "anthropic" }) : e;
    }
    // An error event in the middle of a stream has a type but no status.
    const kind = err.type === "overloaded_error" || err.type === "api_error" ? "overloaded" : err.type === "rate_limit_error" ? "rate_limit" : "unknown";
    return new ModelError(kind, `Anthropic stream error${err.type ? ` (${err.type})` : ""}: ${redact(detail, apiKey)}`, { provider: "anthropic", cause: err });
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return new ModelError("timeout", "the request to Anthropic was aborted", { provider: "anthropic", cause: err });
  return new ModelError("unknown", `Anthropic: ${redact(err instanceof Error ? err.message : String(err), apiKey)}`, { provider: "anthropic", cause: err });
}

function clientOf(o: AnthropicAdapterOptions): Anthropic {
  return new Anthropic({
    apiKey: o.apiKey,
    baseURL: o.baseUrl,
    timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: o.maxRetries ?? 0,
    ...(o.fetch ? { fetch: o.fetch as unknown as NonNullable<ConstructorParameters<typeof Anthropic>[0]>["fetch"] } : {}),
  });
}

export function anthropicModel(o: AnthropicAdapterOptions): ModelClient {
  const client = clientOf(o);
  const model = o.model ?? DEFAULT_MODEL;
  const adaptive = ADAPTIVE.test(model);
  const fallback = FALLBACK.test(model);
  return {
    provider: "anthropic",
    model,
    async turn(req, opts) {
      const params = {
        model,
        max_tokens: req.maxTokens,
        system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
        cache_control: { type: "ephemeral" as const },
        ...(req.tools.length ? { tools: toolsOf(req.tools) } : {}),
        messages: toAnthropicMessages(req.messages),
        ...(adaptive ? { thinking: { type: "adaptive" as const }, output_config: { effort: o.effort ?? "high" } } : {}),
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      } as Anthropic.Beta.Messages.MessageCreateParamsStreaming;
      // A tool input the server streamed eagerly can fail to parse; that one case is re-issued (at most twice).
      // API errors and aborts go straight to the caller as ModelError.
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(params, { signal: opts?.signal });
          const rawInput = new Map<number, string>();
          stream.on("streamEvent", (e) => {
            if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") rawInput.set(e.index, (rawInput.get(e.index) ?? "") + e.delta.partial_json);
          });
          return fromAnthropicMessage(await stream.finalMessage(), rawInput);
        } catch (err) {
          const parseFailure = err instanceof SyntaxError || (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError));
          if (!parseFailure || opts?.signal?.aborted || attempt >= 2) throw anthropicError(err, o.apiKey);
        }
      }
    },
  };
}

/** The model ids the key may use (Models API). */
export async function listAnthropicModels(o: AnthropicAdapterOptions & { signal?: AbortSignal }): Promise<string[]> {
  const client = clientOf({ ...o, timeoutMs: o.timeoutMs ?? 30_000 });
  const out: string[] = [];
  try {
    for await (const m of client.models.list({ limit: 100 }, { signal: o.signal })) {
      out.push(m.id);
      if (out.length >= 1_000) break;
    }
  } catch (err) {
    throw anthropicError(err, o.apiKey);
  }
  return out;
}
