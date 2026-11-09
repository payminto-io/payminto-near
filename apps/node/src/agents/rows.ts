/**
 * Rows, ids and API shapes of the agent feature (docs/AGENTS.md sections 2, 4 and 5). Keys and ciphertexts never
 * appear in a JSON shape.
 */
import type { Provider } from "@payminto/models";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `prefix_` + 24 base32 characters, like the gateway's ids. */
export function newId(prefix: "aic" | "agt" | "run"): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(15));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${prefix}_${out}`;
}

export const isAgentId = (v: unknown, prefix: "aic" | "agt" | "run"): v is string => typeof v === "string" && new RegExp(`^${prefix}_[a-z2-7]{24}$`).test(v);

export const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------------
// AI connections

export type ConnectionStatus = "active" | "invalid" | "disabled";

export type ConnectionRow = {
  id: string;
  merchant_id: string;
  provider: Provider;
  label: string;
  base_url: string | null;
  default_model: string;
  key_hint: string;
  key_ciphertext: string;
  key_iv: string;
  key_tag: string;
  key_version: number;
  status: ConnectionStatus;
  verified_at: string | null;
  last_error: string | null;
  monthly_token_limit: number | null;
  created_at: string;
  created_by: string | null;
  rotated_at: string | null;
  updated_at: string;
  deleted_at: string | null;
};

export type TokenUsage = { input_tokens: number; output_tokens: number; total_tokens: number; runs: number };

export function connectionJson(r: ConnectionRow, usage: TokenUsage) {
  return {
    id: r.id,
    object: "ai_connection" as const,
    merchant_id: r.merchant_id,
    provider: r.provider,
    label: r.label,
    base_url: r.base_url,
    default_model: r.default_model,
    key_hint: r.key_hint,
    status: r.status,
    verified_at: r.verified_at,
    last_error: r.last_error,
    monthly_token_limit: r.monthly_token_limit,
    usage_this_month: usage,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    created_at: r.created_at,
    created_by: r.created_by,
    rotated_at: r.rotated_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Agents

export const AGENT_KINDS = ["ops", "skill"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export type AgentStatus = "active" | "paused";

export const DEFAULT_AGENT_LIMITS = { max_turns: 12, max_output_tokens: 20_000, timeout_seconds: 180 } as const;

export type AgentRow = {
  id: string;
  merchant_id: string;
  kind: AgentKind;
  name: string;
  description: string;
  connection_id: string;
  model: string;
  instructions: string;
  tools: string | null;
  max_turns: number;
  max_output_tokens: number;
  timeout_seconds: number;
  status: AgentStatus;
  slug: string | null;
  price: string | null;
  input_hint: string | null;
  provider_id: string | null;
  provider_key_ciphertext: string | null;
  provider_key_iv: string | null;
  provider_key_tag: string | null;
  provider_key_version: number | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  deleted_at: string | null;
};

export function agentTools(r: AgentRow): string[] | null {
  return r.tools ? (JSON.parse(r.tools) as string[]) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
export type RunTrigger = "dashboard" | "api" | "skill_call";
export const RUN_EVENT_TYPES = ["started", "model_turn", "tool_call", "tool_result", "retry_scheduled", "finished"] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunRow = {
  id: string;
  agent_id: string;
  merchant_id: string;
  connection_id: string;
  trigger: RunTrigger;
  input: string;
  status: RunStatus;
  attempt: number;
  max_attempts: number;
  next_attempt_ms: number;
  lease_owner: string | null;
  lease_expires_ms: number | null;
  cancel_requested: number;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  provider: string | null;
  idempotency_key: string | null;
  result_token_hash: string | null;
  skill_call_id: string | null;
  payer: string | null;
  created_by: string | null;
  created_ms: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type RunEventRow = { run_id: string; seq: number; type: RunEventType; attempt: number; data: string; at: string };

export function runJson(r: RunRow) {
  return {
    id: r.id,
    object: "agent_run" as const,
    agent_id: r.agent_id,
    merchant_id: r.merchant_id,
    connection_id: r.connection_id,
    trigger: r.trigger,
    input: r.input,
    status: r.status,
    attempt: r.attempt,
    max_attempts: r.max_attempts,
    next_attempt_at: r.status === "queued" ? iso(r.next_attempt_ms) : null,
    cancel_requested: r.cancel_requested === 1,
    result: r.result ? (JSON.parse(r.result) as { answer: string; data?: unknown }) : null,
    error_code: r.error_code,
    error_message: r.error_message,
    usage: { input_tokens: r.input_tokens, output_tokens: r.output_tokens, model: r.model, provider: r.provider },
    idempotency_key: r.idempotency_key,
    skill_call: r.trigger === "skill_call" ? { call_id: r.skill_call_id, payer: r.payer } : null,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    updated_at: r.updated_at,
  };
}

export type RunJson = ReturnType<typeof runJson>;

export function runEventJson(e: RunEventRow) {
  return { run_id: e.run_id, seq: e.seq, type: e.type, attempt: e.attempt, data: JSON.parse(e.data) as Record<string, unknown>, at: e.at };
}

/** First `n` characters, with an ellipsis when cut. */
export function excerpt(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Removes a key and anything shaped like a provider key from provider error text before it is stored or shown.
 * Providers sometimes echo a masked key ("Incorrect API key provided: sk-...1234").
 */
export function scrubSecrets(message: string, key?: string | null): string {
  let out = message;
  if (key && key.length >= 4) out = out.split(key).join("[key]");
  return out.replace(/\b(sk|pk|rk|gsk|xai|sk-ant|sk-proj|AIza)[-_A-Za-z0-9*.]{6,}/g, "[key]").slice(0, 500);
}
