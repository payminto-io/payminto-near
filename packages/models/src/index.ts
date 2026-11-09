/**
 * @payminto/models: the neutral model layer (docs/AGENTS.md section 3). The agent runtime and the node's merchant
 * agents both build their model clients here, so a business can bring a key for any supported provider.
 */
export {
  ModelError,
  describeModelError,
  textOf,
  toolCallsOf,
  totalInputTokens,
  DEFAULT_MODEL,
  PROVIDER_IDS,
  type Provider,
  type Effort,
  type ToolSpec,
  type Part,
  type ChatMessage,
  type NativeContent,
  type ModelTurn,
  type TurnUsage,
  type ModelRequest,
  type ModelClient,
  type ModelErrorKind,
  type ConnectionSpec,
  type ClientOptions,
} from "./model.ts";
export { PROVIDERS, providerInfo, createModelClient, verifyConnection, listModels, type ProviderInfo, type VerifyResult } from "./providers/index.ts";
export { retryAfterMs, redact } from "./providers/http.ts";
export { anthropicModel, ANTHROPIC_BASE_URL, type AnthropicAdapterOptions } from "./providers/anthropic.ts";
export { openaiModel, OPENAI_BASE_URL, type OpenAIAdapterOptions } from "./providers/openai.ts";
export { openaiCompatibleModel, COMPATIBLE_PRESETS, type CompatibleAdapterOptions } from "./providers/openai-compatible.ts";
export { replicateModel, toReplicatePrompt, parseReplicateReply, REPLICATE_BASE_URL, REPLICATE_MODELS, type ReplicateAdapterOptions } from "./providers/replicate.ts";
export { googleModel, toGeminiSchema, GOOGLE_BASE_URL, type GoogleAdapterOptions } from "./providers/google.ts";
