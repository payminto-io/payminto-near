/**
 * Provider registry: the catalogue the node serves at GET /v1/ai/providers, and the three entry points the node and
 * the CLI use (createModelClient, verifyConnection, listModels). docs/AGENTS.md sections 2 and 3.
 */
import { ModelError, DEFAULT_MODEL, type ClientOptions, type ConnectionSpec, type ModelClient, type Provider } from "../model.ts";
import { ANTHROPIC_BASE_URL, anthropicModel, listAnthropicModels } from "./anthropic.ts";
import { GOOGLE_BASE_URL, googleModel, listGoogleModels } from "./google.ts";
import { COMPATIBLE_PRESETS, listCompatibleModels, openaiCompatibleModel } from "./openai-compatible.ts";
import { OPENAI_BASE_URL, listOpenAIModels, openaiModel } from "./openai.ts";
import { REPLICATE_BASE_URL, REPLICATE_MODELS, listReplicateModels, replicateModel } from "./replicate.ts";

export type ProviderInfo = {
  id: Provider;
  /** Plain words for the dashboard. */
  name: string;
  /** True when a connection must name its endpoint (openai_compatible). */
  needsBaseUrl: boolean;
  defaultBaseUrl: string | null;
  /** True when a connection may leave the key empty (local servers such as Ollama). */
  keyOptional: boolean;
  suggestedModels: string[];
  docsUrl: string;
  /** Well-known endpoints to pick from (openai_compatible only). */
  presets: Array<{ name: string; baseUrl: string }>;
  /** Something a business should know before choosing the provider, in plain words; null when there is nothing. */
  note: string | null;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    needsBaseUrl: false,
    defaultBaseUrl: ANTHROPIC_BASE_URL,
    keyOptional: false,
    suggestedModels: [DEFAULT_MODEL, "claude-sonnet-5-5", "claude-haiku-5-5"],
    docsUrl: "https://platform.claude.com/docs/en/api/overview",
    presets: [],
    note: null,
  },
  {
    id: "openai",
    name: "OpenAI",
    needsBaseUrl: false,
    defaultBaseUrl: OPENAI_BASE_URL,
    keyOptional: false,
    suggestedModels: ["gpt-5.1", "gpt-5", "gpt-5-mini"],
    docsUrl: "https://platform.openai.com/docs/guides/function-calling",
    presets: [],
    note: null,
  },
  {
    id: "google",
    name: "Google Gemini",
    needsBaseUrl: false,
    defaultBaseUrl: GOOGLE_BASE_URL,
    keyOptional: false,
    suggestedModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    docsUrl: "https://ai.google.dev/gemini-api/docs/function-calling",
    presets: [],
    note: null,
  },
  {
    id: "openai_compatible",
    name: "Other (OpenAI-compatible: OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Ollama, vLLM, LM Studio)",
    needsBaseUrl: true,
    defaultBaseUrl: null,
    keyOptional: true,
    suggestedModels: ["meta-llama/llama-4-maverick", "deepseek-chat", "mistral-large-latest"],
    docsUrl: "https://openrouter.ai/docs/quickstart",
    presets: COMPATIBLE_PRESETS.map((p) => ({ ...p })),
    note: null,
  },
  {
    id: "replicate",
    name: "Replicate (DeepSeek and others)",
    needsBaseUrl: false,
    defaultBaseUrl: REPLICATE_BASE_URL,
    keyOptional: false,
    suggestedModels: [...REPLICATE_MODELS],
    docsUrl: "https://replicate.com/docs/reference/http",
    presets: [],
    note: "Models on Replicate have no native tool calling. Payminto emulates tools with a JSON reply format in the prompt, which works well with DeepSeek V3.1 but is less reliable than native tools.",
  },
];

export function providerInfo(id: Provider): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new ModelError("bad_request", `unknown provider ${String(id)}; use one of ${PROVIDERS.map((x) => x.id).join(", ")}`);
  return p;
}

/** Checks a connection's shape before any request: a known provider, a key where one is needed, a usable base URL. */
function validate(c: Omit<ConnectionSpec, "model"> & { model?: string }): { baseUrl: string | undefined } {
  const info = providerInfo(c.provider);
  const fail = (m: string) => new ModelError("bad_request", m, { provider: c.provider });
  if (!info.keyOptional && !c.apiKey?.trim()) throw fail(`${info.name} needs an API key`);
  const raw = c.baseUrl?.trim() || undefined;
  if (info.needsBaseUrl && !raw) throw fail("an OpenAI-compatible connection needs a base URL, for example https://openrouter.ai/api/v1");
  if (raw) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw fail(`base URL ${raw} is not a valid URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw fail(`base URL ${raw} must be http or https`);
    if (u.username || u.password) throw fail("base URL must not carry credentials; put the key in the API key field");
  }
  if (c.model !== undefined && !c.model.trim()) throw fail("a model id is required");
  return { baseUrl: raw?.replace(/\/+$/, "") };
}

/** A ModelClient for one connection. Throws ModelError (bad_request) for a connection that cannot work. */
export function createModelClient(c: ConnectionSpec, o: ClientOptions = {}): ModelClient {
  const { baseUrl } = validate(c);
  const common = { ...o, apiKey: c.apiKey.trim(), model: c.model.trim() };
  switch (c.provider) {
    case "anthropic":
      return anthropicModel({ ...common, baseUrl });
    case "openai":
      return openaiModel({ ...common, baseUrl });
    case "google":
      return googleModel({ ...common, baseUrl });
    case "openai_compatible":
      return openaiCompatibleModel({ ...common, baseUrl: baseUrl! });
    case "replicate":
      return replicateModel({ ...common, baseUrl });
  }
}

/** The provider's model list, or null where the provider (some compatible servers) has none. */
export async function listModels(c: Omit<ConnectionSpec, "model">, o: ClientOptions & { signal?: AbortSignal } = {}): Promise<string[] | null> {
  const { baseUrl } = validate(c);
  const apiKey = c.apiKey.trim();
  const common = { apiKey, fetch: o.fetch, timeoutMs: o.timeoutMs, signal: o.signal };
  switch (c.provider) {
    case "anthropic":
      return listAnthropicModels({ ...common, baseUrl, maxRetries: o.maxRetries });
    case "openai":
      return listOpenAIModels({ ...common, provider: "openai", baseUrl: baseUrl ?? OPENAI_BASE_URL });
    case "google":
      return listGoogleModels({ ...common, baseUrl });
    case "openai_compatible":
      return listCompatibleModels({ ...common, baseUrl: baseUrl! });
    case "replicate":
      return listReplicateModels({ ...common, baseUrl });
  }
}

export type VerifyResult = { ok: true; models: string[] | null } | { ok: false; error: ModelError };

/**
 * A cheap check of a connection: the model list where the provider has one, else a one-token completion. Never
 * throws; a rejected key comes back as `{ ok: false, error }` with kind "auth".
 */
export async function verifyConnection(c: ConnectionSpec, o: ClientOptions & { signal?: AbortSignal } = {}): Promise<VerifyResult> {
  try {
    validate(c);
    const models = await listModels(c, { timeoutMs: 30_000, ...o });
    if (models !== null) return { ok: true, models };
    await createModelClient(c, { timeoutMs: 30_000, ...o }).turn({ system: "Reply with OK.", tools: [], messages: [{ role: "user", parts: [{ type: "text", text: "OK?" }] }], maxTokens: 1 }, { signal: o.signal });
    return { ok: true, models: null };
  } catch (err) {
    return { ok: false, error: err instanceof ModelError ? err : new ModelError("unknown", err instanceof Error ? err.message : String(err), { provider: c.provider, cause: err }) };
  }
}
