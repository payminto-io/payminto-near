/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Ollama, vLLM,
 * LM Studio or a custom URL. It is the OpenAI adapter pointed at `baseUrl`, in its tolerant mode (see openai.ts).
 * One endpoint is not served from here: a base URL on NEAR AI Cloud gets the NEAR adapter (nearai.ts), which checks
 * the key properly and verifies enclave attestation. The registry (index.ts) makes that choice.
 * The key is optional for local servers (Ollama, LM Studio) that take none.
 */
import type { ClientOptions, ModelClient } from "../model.ts";
import { listOpenAIModels, openaiModel } from "./openai.ts";

export type CompatibleAdapterOptions = ClientOptions & { apiKey: string; model: string; baseUrl: string };

export function openaiCompatibleModel(o: CompatibleAdapterOptions): ModelClient {
  return openaiModel({ ...o, compatible: true });
}

export function listCompatibleModels(o: { apiKey: string; baseUrl: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<string[] | null> {
  return listOpenAIModels({ ...o, provider: "openai_compatible" });
}

/** Well-known OpenAI-compatible endpoints, for the connection dialog. */
export const COMPATIBLE_PRESETS = [
  { name: "NEAR AI Cloud", baseUrl: "https://cloud-api.near.ai/v1" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "Together", baseUrl: "https://api.together.xyz/v1" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { name: "xAI", baseUrl: "https://api.x.ai/v1" },
  { name: "Ollama (same server)", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio (same server)", baseUrl: "http://127.0.0.1:1234/v1" },
  { name: "vLLM (same server)", baseUrl: "http://127.0.0.1:8000/v1" },
] as const;
