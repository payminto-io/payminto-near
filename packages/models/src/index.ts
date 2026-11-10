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
  type AttestationStatus,
  type AttestationCheck,
  type TurnAttestation,
} from "./model.ts";
export { PROVIDERS, providerInfo, createModelClient, verifyConnection, listModels, type ProviderInfo, type VerifyResult } from "./providers/index.ts";
export { retryAfterMs, redact } from "./providers/http.ts";
export { anthropicModel, ANTHROPIC_BASE_URL, type AnthropicAdapterOptions } from "./providers/anthropic.ts";
export { openaiModel, OPENAI_BASE_URL, type OpenAIAdapterOptions } from "./providers/openai.ts";
export { openaiCompatibleModel, COMPATIBLE_PRESETS, type CompatibleAdapterOptions } from "./providers/openai-compatible.ts";
export { replicateModel, toReplicatePrompt, parseReplicateReply, REPLICATE_BASE_URL, REPLICATE_MODELS, type ReplicateAdapterOptions } from "./providers/replicate.ts";
export { googleModel, toGeminiSchema, GOOGLE_BASE_URL, type GoogleAdapterOptions } from "./providers/google.ts";
export {
  nearaiModel,
  isNearAiBaseUrl,
  verifyNearAiKey,
  listNearAiModels,
  listNearAiCatalog,
  fetchNearAiAttestation,
  checkNearAiAttestation,
  fetchNearAiSignature,
  NEARAI_LABEL,
  NEARAI_BASE_URL,
  NEARAI_KEY_ENV,
  NEARAI_KEY_HINT,
  NEARAI_MODELS,
  NEARAI_DEFAULT_MODEL,
  NEARAI_DOCS_URL,
  NEARAI_NOTE,
  NEARAI_HOSTS,
  type NearAiAdapterOptions,
  type NearAiModelClient,
  type NearAiAttestationMode,
  type NearAiCatalogModel,
  type FetchedNearAiAttestation,
  type CheckNearAiAttestationOptions,
} from "./providers/nearai.ts";
export {
  verifyNearAiAttestation,
  verifyNearAiResponse,
  summarizeAttestation,
  nearAiSignedText,
  recoverEip191Signer,
  replayRtmr3,
  DEFAULT_MAX_ATTESTATION_AGE_MS,
  type VerifyNearAiAttestationInput,
  type VerifyNearAiResponseInput,
  type NearAiAttestationVerification,
  type NearAiResponseVerification,
  type NearAiReportVerification,
  type NearAiAttestationPolicy,
  type NearAiMeasurements,
  type NearAiSigner,
  type NearAiSigningAlgo,
  type NearAiSignatureKind,
  type QuoteVerifier,
  type QuoteVerdict,
  type GpuVerifier,
  type GpuVerdict,
} from "./attestation/nearai.ts";
export { parseTdxQuote, verifyTdxQuoteLocally, TdxQuoteError, INTEL_SGX_ROOT_CA_PEM, INTEL_TD_QE_MRSIGNER, type TdxQuote, type TdReport, type TdxLocalVerification } from "./attestation/tdx-quote.ts";
