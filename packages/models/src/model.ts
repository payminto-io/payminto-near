/**
 * The neutral model layer (docs/AGENTS.md section 3), shared by the agent runtime (`@payminto/agent`) and the node's
 * merchant agents. An agent loop only ever sees these types; each provider (Anthropic, OpenAI, Google Gemini, any
 * OpenAI-compatible endpoint, Replicate, NEAR AI Cloud) is an adapter in `src/providers/` that maps them to its own wire format and maps its
 * failures to ModelError.
 */

export type Provider = "anthropic" | "openai" | "google" | "openai_compatible" | "replicate" | "nearai";

export const PROVIDER_IDS = ["anthropic", "openai", "google", "openai_compatible", "replicate", "nearai"] as const satisfies readonly Provider[];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The default Claude model (Anthropic connections and the CLI without PAYMINTO_AGENT_MODEL). */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** A tool the model may call. `inputSchema` is JSON Schema, as MCP servers list it. */
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type Part =
  | { type: "text"; text: string }
  /**
   * `inputError` is set when the provider sent arguments that are not a JSON object (malformed JSON, a bare string, an
   * array). The runtime then answers the call with a tool error instead of running the tool.
   */
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; inputError?: string }
  | { type: "tool_result"; id: string; content: string; isError: boolean };

/**
 * The provider's own content for one assistant turn. An adapter replays it unchanged when the conversation goes back
 * to the same provider, so provider-only state survives the round trip: Claude's thinking blocks (history must stay
 * append-only) and Gemini's thought signatures. Other providers ignore it and read `parts`.
 */
export type NativeContent = { provider: Provider; content: unknown };

/** Tool results travel in a user message, all results of one turn in one message. */
export type ChatMessage = { role: "user" | "assistant"; parts: Part[]; native?: NativeContent };

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache, where it reports them. */
  cacheReadInputTokens?: number;
  /** Prompt tokens written to the provider's cache (Anthropic). */
  cacheCreationInputTokens?: number;
};

/**
 * Every prompt token the provider processed: fresh input plus cache reads and cache writes. Anthropic reports a
 * cached prompt mostly as cache reads, so counting inputTokens alone undercounts what a token limit is meant to cap.
 */
export function totalInputTokens(u: TurnUsage): number {
  return u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
}

export type AttestationStatus = "verified" | "partially_verified" | "failed";

/**
 * One thing an attestation check looked at. `pass` and `fail` are checks that ran; `not_verified` is a check that
 * did not run here (it needs a remote service, a policy nobody configured, or evidence that was unavailable).
 * `trust` says whose word a `pass` rests on: `local` is cryptography done in this process, `remote` is the verdict of
 * a service, `none` is nobody (the check did not run).
 */
export type AttestationCheck = {
  id: string;
  /** Which evidence the check is about, for example "gateway", "model:0" or "response". */
  scope: string;
  /** Plain words for the dashboard. */
  title: string;
  status: "pass" | "fail" | "not_verified";
  trust: "local" | "remote" | "none";
  detail: string;
  evidence?: Record<string, string>;
};

/**
 * What a provider that runs models in attested enclaves can say about one turn (NEAR AI Cloud). `verified` means
 * every check passed; `partially_verified` means no check failed but some did not run here; `failed` means a check
 * failed or the evidence was unavailable. The claim never goes beyond the checks listed.
 */
export type TurnAttestation = {
  status: AttestationStatus;
  /** One or two plain sentences: what was shown and what was not. */
  summary: string;
  checks: AttestationCheck[];
};

export type ModelTurn = {
  /** Text and tool_call parts, in order. */
  parts: Part[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  usage: TurnUsage;
  /** What the provider says it ran. */
  model: string;
  /** Why the provider declined, when stop is "refusal" (category and explanation where the provider gives them). */
  refusal?: { category: string | null; explanation: string | null };
  /** Replayed unchanged on the next turn to the same provider (see NativeContent). */
  native?: NativeContent;
  /** Set by providers that verify enclave attestation for the turn (NEAR AI Cloud); absent everywhere else. */
  attestation?: TurnAttestation;
};

/** One model turn: the frozen system prompt and tool list, plus the conversation so far (append-only). */
export type ModelRequest = {
  system: string;
  tools: ToolSpec[];
  messages: ChatMessage[];
  maxTokens: number;
};

/**
 * The seam between the agent loop and a model provider. The runtime only ever calls `turn`; tests inject a scripted
 * stand-in so every loop path runs without a network or an API key.
 */
export interface ModelClient {
  readonly provider: Provider;
  readonly model: string;
  turn(req: ModelRequest, opts?: { signal?: AbortSignal }): Promise<ModelTurn>;
}

export type ModelErrorKind = "auth" | "rate_limit" | "overloaded" | "bad_request" | "timeout" | "network" | "refusal" | "unknown";

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set(["rate_limit", "overloaded", "timeout", "network"]);

/**
 * A provider failure in neutral terms. The node worker decides retries from `retryable` and `retryAfterMs`; the
 * message never contains the API key.
 */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  /** rate_limit, overloaded, timeout and network, unless the provider said otherwise (an exhausted quota). */
  readonly retryable: boolean;
  /** From Retry-After or the provider's own retry hint. */
  readonly retryAfterMs: number | null;
  readonly status: number | null;
  readonly provider: Provider | null;

  constructor(
    kind: ModelErrorKind,
    message: string,
    o: { status?: number | null; retryAfterMs?: number | null; retryable?: boolean; provider?: Provider | null; cause?: unknown } = {},
  ) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "ModelError";
    this.kind = kind;
    this.retryable = o.retryable ?? RETRYABLE.has(kind);
    this.retryAfterMs = o.retryAfterMs ?? null;
    this.status = o.status ?? null;
    this.provider = o.provider ?? null;
  }

  toJSON() {
    return { name: this.name, kind: this.kind, message: this.message, retryable: this.retryable, retryAfterMs: this.retryAfterMs, status: this.status, provider: this.provider };
  }
}

/** A connection a business stores (docs/AGENTS.md section 2), in the form the adapters take. */
export type ConnectionSpec = { provider: Provider; apiKey: string; baseUrl?: string; model: string };

export type ClientOptions = {
  /** Injected for tests and for the node's outbound guard; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10 minutes). */
  timeoutMs?: number;
  /**
   * Retries of retryable failures inside the client (default 0: the node worker owns retries and backoff). The CLI
   * asks for 2.
   */
  maxRetries?: number;
  /** Claude only: thinking depth and token spend (default high). */
  effort?: Effort;
  /**
   * NEAR AI Cloud only: `verify` (default) checks enclave attestation around every turn and reports it as
   * `turn.attestation` without ever failing the turn; `require` also refuses to send a request when the attestation
   * failed and fails a turn whose answer cannot be verified; `off` skips it.
   */
  attestation?: "off" | "verify" | "require";
};

/** Explains a model failure in one line. Never includes the key (adapters redact it before building the message). */
export function describeModelError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The text parts of a turn or message, joined. */
export function textOf(m: { parts: Part[] }): string {
  return m.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n")
    .trim();
}

/** The tool calls of a turn, in order. */
export function toolCallsOf(m: { parts: Part[] }): Array<Extract<Part, { type: "tool_call" }>> {
  return m.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
}
