# Merchant AI agents: keys, providers, agents and runs

Status: approved for build on 2026-11-01.
This is the contract for the merchant-level agent feature.
`PRODUCT_PLAN.md` section 5 says why agents exist; this file says how they work inside a business.
Where this file and `PRODUCT.md` disagree on user-facing words, `PRODUCT.md` wins.

## 1. Product decisions

1. **Each business brings its own model keys.**
   Model calls cost money, so the platform does not pay for a business's agents.
   A business adds one or more AI connections (provider + API key) in Settings, and every agent run is billed to that business's own provider account.
   The platform owner may later offer a shared connection with a quota; that is P1 and off by default.
2. **Any major model provider, not one vendor.**
   Supported at launch: Anthropic, OpenAI, Google Gemini, any OpenAI-compatible endpoint (OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Ollama, vLLM, LM Studio, or a custom URL), and Replicate (DeepSeek V3.1 and V3).
   The agent loop talks to one neutral model interface; each provider is an adapter.
3. **Agents are part of the product, not a command.**
   A business creates agents in the dashboard, and every piece of work an agent does is a run: queued, picked up by a worker on the server, retried when a provider is busy, visible step by step, cancellable, and pollable over the API.
4. **Two agent kinds ship now, one next.**
   - `ops`: the business's back-office agent (earnings, payments, links, refund requests, the reconciliation report, blocked payers).
   - `skill`: an AI skill the business sells per call; buyers and buyer agents pay through the normal paywall, then get the result.
   - `buyer` (P1): a business agent that spends through a mandate. It needs a server-held agent wallet and an owner-signed mandate in the dashboard; until then buyer agents run with `payminto-agent run` as today.
5. **Keys are secrets.**
   Stored encrypted, never returned by any API, never logged, never sent anywhere except the provider's own endpoint.

## 2. AI connections

| Field | Meaning |
|---|---|
| `id` | `aic_...` |
| `merchant_id` | Owning business |
| `provider` | `anthropic`, `openai`, `google`, `openai_compatible`, `replicate` |
| `label` | Business's name for it, e.g. "Team OpenAI" |
| `base_url` | Required for `openai_compatible`; optional override for the others |
| `default_model` | e.g. `claude-sonnet-5-5`, `gpt-5.1`, `gemini-2.5-pro`, `meta-llama/llama-4-maverick`, `deepseek-ai/deepseek-v3.1` |
| `key_hint` | Last 4 characters of the key, for display |
| `status` | `active`, `invalid` (provider rejected the key), `disabled` |
| `verified_at`, `last_error` | Result of the last check |
| `monthly_token_limit` | Optional cap; runs refuse to start once this month's input plus output tokens reach it |
| `created_at`, `created_by`, `rotated_at` | Audit |

Rules:
- Only business Admins can create, rotate, disable or delete a connection; Staff and Viewers see label, provider, model, status and usage.
- Saving runs a cheap verification call (list models where the provider has it, else a one-token completion) and stores the result.
  Replicate has no list of chat models, so its check is `GET /v1/account` (a rejected token is a 401) and the model picker offers the curated list.
- A provider answering 401 or 403 during a run marks the connection `invalid` and fails the run with `MODEL_AUTH_FAILED`; nothing retries it.
- Deleting a connection is refused while an active agent uses it.
- Every create, rotate, disable and delete writes an audit log entry, never the key.

Encryption:
- AES-256-GCM with a 32-byte server key from env `AGENT_SECRETS_KEY` (base64).
  Associated data binds the ciphertext to `merchant_id` and connection `id`, so a ciphertext copied to another row fails to decrypt.
- Stored as `key_ciphertext`, `key_iv`, `key_tag`, `key_version`.
- On chains 133 and 177 the node refuses to start with agents enabled and no `AGENT_SECRETS_KEY`, or with the documented dev key.
- Rotating the server key: `key_version` plus a re-encrypt script; documented in `OPERATIONS.md`.

Outbound safety:
- `openai_compatible` base URLs go through the same SSRF guard as webhooks (`gateway/ssrf.ts`).
  Private and loopback addresses (Ollama, vLLM on the same box) are allowed only when the operator sets `AGENT_ALLOW_PRIVATE_MODEL_URLS=true`.
- Requests carry the key only in the provider's auth header; logs redact headers and bodies.

## 3. Model layer (package `@payminto/models`)

The layer is its own workspace package, `packages/models` (`@payminto/models`).
The agent runtime (`@payminto/agent`) and the node's merchant agents both import it, so neither depends on the other and the workspace has no dependency cycle.
The node keeps only glue in `apps/node/src/agents/models.ts`: the three entry points as one replaceable `ModelLayer` (clients pinned to `maxRetries: 0`, because the run worker owns retries), binding a model `fetch` for tests, and `asModelError`.

Neutral types, so the loop never sees a provider's wire format:

```ts
type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }; // JSON Schema
type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean };
type ChatMessage = { role: "user" | "assistant"; parts: Part[] }; // tool results travel in a user message
type ModelTurn = {
  parts: Part[];                       // text and tool_call parts, in order
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  usage: { inputTokens: number; outputTokens: number };
  model: string;                       // what the provider says it ran
};
interface ModelClient {
  readonly provider: Provider;
  readonly model: string;
  turn(req: { system: string; tools: ToolSpec[]; messages: ChatMessage[]; maxTokens: number }, opts?: { signal?: AbortSignal }): Promise<ModelTurn>;
}
class ModelError extends Error {
  kind: "auth" | "rate_limit" | "overloaded" | "bad_request" | "timeout" | "network" | "refusal" | "unknown";
  retryable: boolean;                  // rate_limit, overloaded, timeout, network
  retryAfterMs: number | null;         // from Retry-After or provider hints
  status: number | null;
}
type ConnectionSpec = { provider: Provider; apiKey: string; baseUrl?: string; model: string };
function createModelClient(c: ConnectionSpec, o?: { fetch?: typeof fetch }): ModelClient;
function verifyConnection(c: ConnectionSpec, o?): Promise<{ ok: true; models: string[] | null } | { ok: false; error: ModelError }>;
function listModels(c: Omit<ConnectionSpec, "model">, o?): Promise<string[] | null>;
```

Adapters:
- `anthropic`: Messages API through the official SDK, as the runtime does today (prompt caching kept).
- `openai`: Chat Completions with `tools` / `tool_calls` (function calling), `max_completion_tokens`.
- `openai_compatible`: the `openai` adapter with `baseUrl`; tolerant of providers that omit `usage` or return tool arguments as a string.
- `google`: Gemini `generateContent` with `functionDeclarations` and `functionCall` / `functionResponse` parts; JSON Schema converted to Gemini's schema subset.
- `replicate`: the predictions API (`POST /v1/models/{owner}/{name}/predictions`, or `/v1/predictions` with a pinned `owner/name:version`) with `Prefer: wait=60`; a prediction still starting or processing is polled until it ends, the caller's abort and the timeout are honoured while polling, and an abandoned prediction is cancelled.
  Usage comes from the prediction's `metrics` token counts.
  No language model on Replicate takes native tools, so this adapter emulates them with a prompted JSON protocol.
  The prompt holds the system text, the current date (UTC) unless the system text already states it, each tool as JSON Schema, and the rule "reply with exactly one JSON object": `{"tool_calls":[{"name":...,"input":{...}}]}` to call tools or `{"answer":"..."}` when done.
  Earlier assistant turns are replayed in the same protocol, and tool results are labelled with the call id and tool name.
  The reply is read tolerantly (code fences, prose around the object, thinking blocks); the adapter gives each call a stable id, and a reply that is not protocol JSON becomes a plain text answer instead of an error.
  This is less reliable than native tool calling: the model can ignore the format or pick a wrong tool, and nothing on the provider side enforces the schema.
  DeepSeek V3.1 followed it in a live two-turn check; other models may not.
  Errors: 402 means the account is out of credit (`rate_limit`, not retryable), 404 is an unknown model and 422 a rejected input (both `bad_request`), and a failed or canceled prediction is `unknown` with Replicate's error text.
- Each adapter maps its errors to `ModelError`; each has tests against a local mock HTTP server (`packages/models/test`), including tool calls, multi-turn tool results, usage, 401, 429 with Retry-After, 5xx and malformed tool arguments.
- The mock server is exported as `@payminto/models/mock-provider`, so the agent runtime and the node test against the same stand-in.

The runtime (`runAgent`) and the node's run worker both use these types; each keeps a scripted stand-in for its own tests.

## 4. Agents

| Field | Meaning |
|---|---|
| `id` | `agt_...` |
| `merchant_id` | Owning business |
| `kind` | `ops` or `skill` (`buyer` later) |
| `name`, `description` | Shown in the dashboard and, for skills, in the directory |
| `connection_id`, `model` | Which AI connection and model it runs on |
| `instructions` | Extra instructions from the business, appended to the kind's built-in system prompt, never replacing its safety rules |
| `tools` | Allowed subset of the kind's tools (ops) |
| `limits` | `max_turns` (default 12), `max_output_tokens` (default 20,000), `timeout_seconds` (default 180) |
| `status` | `active`, `paused` |
| Skill only | `slug`, `price` (token base units), `input_hint` |

Ops tools are the merchant tools the merchant MCP server serves, defined once in `packages/sdk/src/merchant-tools.ts`: `get_overview`, `list_payments`, `get_payment`, `create_link`, `request_refund`, `get_reconciliation`, `list_blocked`.
In the node they run in-process against the business's own data, with a run-scoped API key that can read payments and request (never approve) refunds.
The key holds only `payments.read`, `links.write`, `refunds.request` and `screening.read`, expires with the attempt, is revoked when the attempt ends, and is not listed under Developers > API keys.

A skill is served at `POST /v1/skills/{slug}` behind the existing `paywall()`, listed in `GET /v1/directory` as an `endpoint` with category `skill` while the agent is active.
The SDK paywall takes `payminto-voucher` payments only, so skills do too; x402 `exact` for skills is P1.
The request is `{"input": "..."}` as JSON, or the input as plain text, and is validated before the paywall.
A paid call creates a run with trigger `skill_call`; the response waits up to 25 seconds, then returns `202` with the run id and a poll URL that needs the run's `result_token`, so the buyer can fetch the result it paid for and nobody else can.
A run that finishes within the wait answers `200` with the result.
Both carry `{run_id, skill, status, result, error_code, error_message, created_at, finished_at, poll_url, result_token}` and the `PAYMENT-RESPONSE` header.
A skill refuses before payment (503 `MODEL_UNAVAILABLE`) when its connection is not active, the business is over its token limit, or the agent is paused, so nobody pays for work that cannot run.
`details.reason` says which: `agent_paused`, `connection_invalid`, `connection_disabled`, `connection_deleted`, `token_limit_reached` or `business_suspended`.
If the run fails after payment, the business gets a `agent_run.failed` webhook and the payment shows a refund suggestion; automatic refund is P1.

## 5. Runs and the worker

| Field | Meaning |
|---|---|
| `id` | `run_...` |
| `agent_id`, `merchant_id` | |
| `trigger` | `dashboard`, `api`, `skill_call` |
| `input` | The question or task (untrusted text) |
| `status` | `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` |
| `attempt`, `max_attempts` | Default 3 |
| `next_attempt_at` | When a queued or retrying run may start |
| `lease_owner`, `lease_expires_at` | Which worker holds it, until when |
| `cancel_requested` | Set by a cancel; the worker stops at the next step |
| `result` | `{ answer, data? }` |
| `error_code`, `error_message` | `MODEL_AUTH_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_OVERLOADED`, `MODEL_TIMEOUT`, `MODEL_UNREACHABLE`, `MODEL_BAD_REQUEST`, `MODEL_REFUSED`, `MODEL_ERROR`, `MODEL_UNAVAILABLE`, `CONNECTION_DISABLED`, `CONNECTION_NOT_FOUND`, `TOKEN_LIMIT_REACHED`, `OUTPUT_LIMIT_REACHED`, `MAX_TURNS_REACHED`, `TIMEOUT`, `TOOL_FAILED`, `CANCELLED`, `WORKER_LOST`, `AGENT_DELETED`, `SECRET_UNAVAILABLE`, `INTERNAL` |
| `usage` | `{ input_tokens, output_tokens, model, provider }` |
| `idempotency_key` | Optional, unique per business |
| `result_token_hash` | For skill callers |
| `created_at`, `started_at`, `finished_at` | |

Steps (`agent_run_events`): `seq`, `run_id`, `type` (`started`, `model_turn`, `tool_call`, `tool_result`, `retry_scheduled`, `finished`), `attempt`, `data` (JSON, with tool inputs and short result summaries, never keys), `at`.
Step data: `started {attempt, provider, model, tools}`, `model_turn {turn, stop, model, input_tokens (fresh input plus cache reads and writes), output_tokens, cache_read_input_tokens, ms, text, tool_calls}`, `tool_call {ordinal, id, name, input}`, `tool_result {ordinal, id, name, is_error, summary}`, `retry_scheduled {attempt, reason, error_code, error_message, next_attempt_at, delay_ms?, retry_after_ms?}`, `finished {status, error_code, error_message, input_tokens, output_tokens}`.

Worker (in the node process, like the settlement and webhook workers):
- Polls every `AGENT_POLL_MS` (default 1,000) when work is likely, backing off to 5,000 when idle; wakes immediately when a run is created in this process.
- Claims one run atomically: `UPDATE ... SET status='running', lease_owner=?, lease_expires_at=now+60, attempt=attempt+1 WHERE id=(SELECT ... WHERE status='queued' AND next_attempt_at<=now ORDER BY created_at LIMIT 1) RETURNING *`.
- Heartbeat renews the lease every 15 seconds; a run whose lease expires (crash, kill) returns to `queued` and counts the attempt.
- Concurrency: `AGENT_WORKERS` runs at once per node (default 2) and at most `AGENT_MAX_PER_MERCHANT` per business (default 1), so one busy business cannot starve the others.
- Retries: retryable `ModelError`s reschedule with exponential backoff and jitter (2 s, 8 s, 30 s), honouring `Retry-After`; non-retryable errors fail at once; after `max_attempts` the run fails with the last error.
  A retry restarts the model conversation but tool side effects are guarded: `create_link` and `request_refund` use an idempotency key derived from the run id and the tool call's position, so a retried run cannot create a second link or refund.
- Timeout: `timeout_seconds` per attempt via `AbortSignal`; then `timed_out` (not retried).
- Cancel: `cancel_requested` is checked before every model turn and tool call; the in-flight request is aborted.
- Token limit: before starting and after each turn, this month's usage on the connection is compared with `monthly_token_limit`.
- Every transition writes an event and an `agent_run.*` webhook (`succeeded`, `failed`, `cancelled`, `timed_out`) through the existing outbox; the webhook's `data.object` is the run.
- A cancel of a queued run takes effect at once; a running run stops at its next step, or at the next heartbeat for a request in flight.
- A node shutting down aborts runs in flight and returns them to the queue without counting the attempt.

## 6. API

All under the business's auth (API key, or dashboard session with the business selected by `Merchant-Id`); Admin-only where marked.
Permissions as built: any = `payments.read` (Viewer and up), Staff+ = `payments.write`, Admin = `business.update` (a business API key holds all three).

| Method and path | Who | Does |
|---|---|---|
| `GET /v1/ai/providers` | any | Supported providers, whether each needs a base URL, suggested models |
| `GET /v1/ai/connections` | any | List, without keys |
| `POST /v1/ai/connections` | Admin | `{provider, label, api_key, base_url?, default_model, monthly_token_limit?}`; verifies; `201` |
| `PATCH /v1/ai/connections/:id` | Admin | Label, base URL, model, limit, `status: disabled|active`, or `api_key` to rotate (re-verifies) |
| `GET /v1/ai/connections/:id` | any | One connection |
| `DELETE /v1/ai/connections/:id` | Admin | Refused while an active agent uses it: 409 `CONNECTION_IN_USE` with `details.agents: [{id, name}]`; the key is wiped |
| `POST /v1/ai/connections/:id/verify` | Admin | Re-check now |
| `GET /v1/ai/connections/:id/models` | any | Provider's model list where available |
| `GET /v1/ai/usage?month=YYYY-MM` | any | Tokens per connection and per agent |
| `GET /v1/agents` / `POST /v1/agents` | any / Admin | List and create |
| `GET /v1/agents/:id` / `PATCH` / `DELETE` | any / Admin | Read, edit, pause, delete (runs kept) |
| `POST /v1/agents/:id/runs` | Staff+ | `{input}` with optional `Idempotency-Key`; `202` with the run, `200` for a replay, 503 `MODEL_UNAVAILABLE` when the agent cannot run |
| `GET /v1/agent-runs?agent_id=&status=&limit=&cursor=` | any | List |
| `GET /v1/agent-runs/:id?wait=0..30` | any | Read; `wait` long-polls until the status changes or the time passes |
| `GET /v1/agent-runs/:id/events?after=<seq>` | any | Steps after a sequence number |
| `POST /v1/agent-runs/:id/cancel` | Staff+ | Request cancel |
| `POST /v1/skills/:slug` | public, paid | Run a skill (section 4) |
| `GET /v1/skills/:slug/runs/:id?token=` | holder of result token | Poll a paid skill run |

Live updates: run events are also published on the existing `/v1/events` stream so the dashboard updates without polling; polling with `wait` is the contract for API clients.
Event names: `agent_run.queued`, `agent_run.started`, `agent_run.updated` (every state change), `agent_run.step`, and `agent_run.succeeded`, `failed`, `cancelled`, `timed_out`; each carries `merchant_id`, `run_id`, and `run` (or `step`).
Business members and API keys may open `/v1/events` too (with `Merchant-Id`, or `?merchant_id=` for EventSource) and get only their business's `agent_run.*` events; platform roles get everything as before.
Creating a connection whose key fails verification still answers `201`, with `status: "invalid"` and `last_error`; responses carry `verification: {ok, models} | {ok: false, error: {kind, message, status, retryable}}`.

## 7. Dashboard

- Settings > AI models: connections table (provider logo-free text badge, label, model, status, key ending, this month's tokens), Add connection dialog (provider, key, base URL when needed, model picker filled from the provider), Verify, Rotate key, Disable, Delete.
  Plain words: "Your agents use your own AI account. You pay your AI provider directly; Payminto never sees your bill."
- Agents section gets "AI agents": list with kind, model, status and last run; Create agent (kind, name, connection and model, instructions, limits; skill adds slug, price, description).
- Agent page: for ops, an "Ask" box that starts a run and shows the answer as it arrives; for skills, the public URL, price, a copyable `curl` and an agent example; run history.
- Run page: status pill, timeline of steps (model turns with token counts, tool calls with inputs and results), answer, usage, error, Cancel while running, Retry for failed runs (creates a new run).
- Live status from `/v1/events`, falling back to polling `GET /v1/agent-runs/:id?wait=25`.
- Mock mode data for every screen.

## 8. Tests that prove it

- Model adapters against mock HTTP servers (section 3).
- Encryption: round trip, wrong merchant or row fails, keys never in API responses, logs or audit entries.
- Worker: claim is exclusive under two workers, lease expiry requeues, retry with Retry-After, non-retryable fail, timeout, cancel mid-run, per-business concurrency, token limit, idempotent tool side effects on retry.
- Ops agent run end to end in the node with a scripted model calling real merchant tools on a temp database.
- Ops agent runs in the node on each non-Anthropic provider through the real model layer (`apps/node/test/agents-providers.test.ts`): an OpenAI-compatible, an OpenAI, a Gemini and a Replicate connection pointed at a local mock provider, each completing a run with tool calls against the real merchant tools and recording usage, a 429 with Retry-After scheduling a retry, and a 401 marking the connection invalid.
- Skill: paid call on local anvil, `202` then poll with the result token, refusal before payment when the connection is invalid.
- Dashboard: schemas, mock data, and component tests for the run timeline.
