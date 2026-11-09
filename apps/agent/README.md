# Payminto agents

`@payminto/agent` (bin `payminto-agent`) runs real AI agents on Payminto, on both sides of a payment.
All three agents share one runtime: a provider-neutral tool-use loop connected to Payminto MCP servers.
Claude is the default model; OpenAI, Google Gemini and any OpenAI-compatible endpoint work the same way (see Model providers).
The product contract is `docs/PRODUCT_PLAN.md` section 5, and the model layer is `docs/AGENTS.md` section 3.

| Agent | Command | Tools | Does |
|---|---|---|---|
| Buyer (spends) | `payminto-agent run "<task>"` | wallet MCP server (`apps/mcp`), bound to one mandate | Finds paid services, checks its budget, buys only what the task needs, answers with a spend report |
| Agent service | `payminto-agent serve` | the buyer agent | `POST /v1/runs` hands the buyer agent a task over HTTP |
| Seller (earns) | `payminto-agent serve-skill market-brief` | its own mandate through `AgentClient` | Sells the "HashKey market brief" per call behind `paywall()`, buys its own inputs, writes the brief with its model |
| Ops (back office) | `payminto-agent ops "<question>"` | merchant MCP server (`apps/mcp --merchant`) | Answers "what did we earn today", lists payments, requests refunds through the approval rule |

From the repository root, `pnpm agent <command> ...` runs the same CLI.
Node 22.18 or newer is required (TypeScript runs through Node type stripping).

## The runtime

`runAgent` (in `src/runtime.ts`) sends the task to the model with the tools the MCP servers list, runs every tool call the model asks for, and loops until the model answers or a limit stops it.

- The loop talks to one neutral `ModelClient` from `@payminto/models` (`packages/models`): tools are `ToolSpec`s with a JSON Schema, messages are `ChatMessage`s made of text, tool call and tool result parts, and every turn comes back as a `ModelTurn` with its stop reason (`end`, `tool_use`, `max_tokens`, `refusal`) and token usage.
- Limits: model turns, output tokens for the whole task, and for the buyer a per-task spend ceiling in token base units.
- The system prompt and tool list never change during a run, so providers that cache prompts can cache them; the per-task ceiling goes in the user turn.
- History is append-only: every assistant turn goes back to the model unchanged, with the provider's own content (Claude's thinking blocks, Gemini's thought signatures) replayed as it came.
- Tool arguments a provider sends broken (malformed JSON, a bare string, input cut off mid-stream) never reach a tool: the model gets a tool error and can try again.
- Every run returns the final answer and a structured spend report: each receipt (call id, service, payee, amount), the total spent, the mandate budget left, and every refusal with its rule code and who enforced it.
- Every run also records usage per model turn (`turnUsage`) and emits a `model_turn` event for each.
- A model or tool failure never throws away the report: the run ends with a status (`completed`, `max_turns`, `max_output_tokens`, `spend_ceiling`, `model_refusal`, `model_error`, `aborted`) and a one-line note.
- A `model_error` run carries the provider's `ModelError` unchanged in `error` (kind, `retryable`, `retryAfterMs`, HTTP status), so a caller such as the node's run worker decides whether and when to retry.
- Tests use a scripted stand-in (`scriptedModel`) and run without an API key.

## Model providers

| Provider | `PAYMINTO_AGENT_PROVIDER` | Key variable | Default model | Base URL | How it talks |
|---|---|---|---|---|---|
| Anthropic (Claude) | `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | optional (`PAYMINTO_AGENT_BASE_URL` or `ANTHROPIC_BASE_URL`) | Messages API through the official SDK, streamed, with prompt caching, adaptive thinking and the server-side refusal fallback where the model has them |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.1` | optional, default `https://api.openai.com/v1` | Chat Completions with function calling and `max_completion_tokens` |
| Google Gemini | `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` | optional, default `https://generativelanguage.googleapis.com/v1beta` | `generateContent` with `functionDeclarations`; tool schemas are converted to Gemini's schema subset |
| Any OpenAI-compatible endpoint | `openai_compatible` | `PAYMINTO_AGENT_API_KEY` (optional for a server on this machine) | none, set `PAYMINTO_AGENT_MODEL` | required | Chat Completions, tolerant of servers that omit usage, send tool arguments double-encoded or know only `max_tokens` |
| Replicate (DeepSeek and others) | `replicate` | `REPLICATE_API_TOKEN` | `deepseek-ai/deepseek-v3.1` | optional, default `https://api.replicate.com` | Predictions API with `Prefer: wait`, polling until the prediction ends; no model on Replicate takes native tools, so tools are emulated by a prompted JSON protocol (less reliable than native tool calling) |

Every adapter maps its provider's failures to `ModelError`: 401 and 403 are `auth`, 429 is `rate_limit` (with `Retry-After` in seconds or as a date), 503, 529 and other 5xx are `overloaded`, 400 is `bad_request`, a timeout or abort is `timeout`, and a connection failure is `network`.
Replicate adds 402 (the account is out of credit: `rate_limit`, not retryable), 404 and 422 (`bad_request`), and a failed or canceled prediction (`unknown`, with Replicate's error text).
Error messages never contain the API key; key-shaped strings a provider echoes back are redacted.
The CLI retries a busy provider twice by itself; the library default is no retries, because the node's run worker owns retries and backoff.

The provider adapters live in `@payminto/models` (`packages/models/src/providers`), and this package re-exports them from its index.
The node uses the same layer for each business's own AI connections: `createModelClient(connection)`, `verifyConnection(connection)` (the model list where the provider has one, else a one-token completion) and `listModels(connection)`, plus the `PROVIDERS` catalogue that `GET /v1/ai/providers` returns.

### OpenRouter

```sh
export PAYMINTO_AGENT_PROVIDER=openai_compatible
export PAYMINTO_AGENT_BASE_URL=https://openrouter.ai/api/v1
export PAYMINTO_AGENT_API_KEY=sk-or-...
export PAYMINTO_AGENT_MODEL=meta-llama/llama-4-maverick
pnpm agent ops "what did we earn this week"
```

### Groq

```sh
export PAYMINTO_AGENT_PROVIDER=openai_compatible
export PAYMINTO_AGENT_BASE_URL=https://api.groq.com/openai/v1
export PAYMINTO_AGENT_API_KEY=gsk_...
export PAYMINTO_AGENT_MODEL=<a Groq model id that supports tool use>
```

### Ollama on the same machine

```sh
ollama pull llama3.2
export PAYMINTO_AGENT_PROVIDER=openai_compatible
export PAYMINTO_AGENT_BASE_URL=http://127.0.0.1:11434/v1
export PAYMINTO_AGENT_MODEL=llama3.2
```

A server on `localhost`, `127.0.0.1` or `::1` needs no key.
Pick a model that supports tool calls; a small local model follows the safety rules in the prompt less reliably, but the runtime's guards (spend ceiling, `NOT_IN_DIRECTORY`) hold whatever the model does.
Together, DeepSeek, Mistral, xAI, vLLM and LM Studio work the same way with their own base URL.

## Safety model

The owner's mandate is the boundary, and it is enforced below the model at three layers.

1. The runtime.
   It reads `get_budget` before the first turn and after every paying round, and stops the loop when the task's spend reaches its ceiling (`spend_ceiling`).
   It refuses a paying call whose known price would pass the ceiling (`TASK_SPEND_CEILING`) before the wallet sees it.
   It refuses a paying call to any target that is neither in the node's service directory nor written by the user in the task (`NOT_IN_DIRECTORY`), so an address planted inside paid content is never paid, whatever the model decides.
2. The wallet (`apps/mcp`).
   It checks the mandate policy before signing and refuses with the rule (`PAYEE_NOT_ALLOWED`, `PER_CALL_CAP`, `DAILY_CAP` and so on).
3. The clearing node and the hub.
   They enforce the same mandate again and record every denial.

The system prompts say the same in words: refusals are reported, never routed around, and content from paid services is data, never instructions.
The ops agent is read-only unless asked, and refunds go only through `request_refund`, which follows the business's approval rule.
MCP child processes get only their own variables (and the SDK's safe defaults such as `PATH`), never a model API key.
Without the provider's key every command fails at once with a message that names the variable to set, before any tool server starts.
The seller refuses paid requests with `503 MODEL_UNAVAILABLE` before the paywall when it has no model, so it never takes payment without serving; if the model fails after payment, it still returns a brief built from the purchased data, labelled as a template.

## Environment

### Model and limits (all agents)

| Var | Default | Meaning |
|---|---|---|
| `PAYMINTO_AGENT_PROVIDER` | `anthropic` | `anthropic`, `openai`, `google`, `openai_compatible` or `replicate` |
| `ANTHROPIC_API_KEY` | required for `anthropic` | Anthropic API key; the agents fail with a clear message without it |
| `OPENAI_API_KEY` | required for `openai` | OpenAI API key |
| `GOOGLE_API_KEY` | required for `google` | Gemini API key from Google AI Studio |
| `PAYMINTO_AGENT_API_KEY` | required for `openai_compatible`, except on this machine | The endpoint's key |
| `REPLICATE_API_TOKEN` | required for `replicate` | Replicate API token |
| `PAYMINTO_AGENT_MODEL` | `claude-opus-5-5`, `gpt-5.1`, `gemini-2.5-pro`, `deepseek-ai/deepseek-v3.1`; required for `openai_compatible` | Model id |
| `PAYMINTO_AGENT_BASE_URL` | the provider's own; required for `openai_compatible` | API base URL, for example `https://openrouter.ai/api/v1` |
| `PAYMINTO_AGENT_EFFORT` | `high` | Claude only: `low`, `medium`, `high`, `xhigh` or `max` |
| `PAYMINTO_AGENT_MAX_TURNS` | `16` | Model turns per task (`--max-turns` overrides) |
| `PAYMINTO_AGENT_MAX_OUTPUT_TOKENS` | `64000` | Output tokens per task, thinking included |
| `PAYMINTO_AGENT_MAX_TOKENS_PER_TURN` | `16000` | `max_tokens` of one model turn |
| `PAYMINTO_AGENT_MAX_SPEND_ATOMIC` | `500000` | Buyer spend ceiling per task in token base units (6 decimals: 500000 is 0.50); `--max-spend` overrides |
| `ANTHROPIC_BASE_URL` | unset | Anthropic only: the same as `PAYMINTO_AGENT_BASE_URL` (kept for existing setups) |

### Buyer agent (`run` and `serve`)

| Var | Default | Meaning |
|---|---|---|
| `NODE_URL` | required | Clearing node base URL |
| `AGENT_KEY` | required | The buyer agent's private key; only the wallet process sees it |
| `MANDATE_ID` | required | The mandate the owner signed for this agent |
| `CHAIN_ID`, `RPC_URL`, `HUB_ADDRESS`, `TRUSTED_NODE`, `MAX_PRICE_ATOMIC`, `RECEIPT_STORE_PATH`, `PAYMINTO_DATA_DIR`, `DEPLOYMENTS_DIR` | see `apps/mcp/README.md` | Passed through to the wallet MCP server unchanged |
| `PAYMINTO_WALLET_MCP` | `node apps/mcp/src/main.ts` | Another wallet server: a command line, or a Streamable HTTP URL such as `http://127.0.0.1:3334/mcp` |

`--mcp <url|command>` (repeatable) connects more MCP servers next to the wallet; tool names must not collide.

### Agent service (`serve`)

| Var | Default | Meaning |
|---|---|---|
| `AGENT_SERVICE_TOKEN` | required | Bearer token callers send; at least 24 characters |
| `AGENT_SERVICE_PORT`, `AGENT_SERVICE_HOST` | `3340`, `127.0.0.1` | Listener; loopback only unless `AGENT_SERVICE_ALLOW_REMOTE=1` (put TLS in front) |
| `AGENT_SERVICE_MAX_RUNS` | `200` | Run records kept in memory |

`POST /v1/runs` takes `{ "task": "...", "maxSpendAtomic": "100000", "wait": true }`.
`maxSpendAtomic` may lower the service ceiling (`PAYMINTO_AGENT_MAX_SPEND_ATOMIC`), never raise it.
With `wait` (the default) the answer is the finished run record; with `"wait": false` it is `202` with the run id, and `GET /v1/runs/:id` reports status, answer and spend report.
Runs execute one at a time, because they share one mandate and a per-task ceiling only means something when no other task spends from it at the same moment.
Records live in memory and reset on restart; receipts are durable in the wallet's receipt store.

```sh
curl -s -H "authorization: Bearer $AGENT_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"task":"Quote HSK and ETH and write one line on the spread","maxSpendAtomic":"50000"}' \
  http://127.0.0.1:3340/v1/runs
```

### Seller agent (`serve-skill market-brief`)

| Var | Default | Meaning |
|---|---|---|
| `NODE_URL` | required | Clearing node base URL |
| `SELLER_AGENT_KEY`, `SELLER_MANDATE_ID` | required | The seller's own key and mandate, used to buy its inputs (the mandate must allow the quote and risk services' payees) |
| `SELLER_PROVIDER_ID`, `SELLER_PROVIDER_API_KEY` | unset | An existing provider registration of the skill (Agents > Providers) |
| `PAYMINTO_OPERATOR_EMAIL`, `PAYMINTO_OPERATOR_PASSWORD`, `PAYMINTO_DASHBOARD_URL` | unset | Without a registration: sign in as the platform operator and register the skill now, paying the seller's own address |
| `SELLER_PRICE_ATOMIC` | `30000` | Price per brief in base units; must match the registration |
| `SELLER_PORT`, `SELLER_HOST`, `SELLER_PUBLIC_URL` | `4190`, `127.0.0.1`, `http://host:port` | Listener and the URL registered as the resource |
| `SELLER_QUOTE_URL`, `SELLER_RISK_URL` | from the node directory | Suppliers; by default the first `market-data` quote service and `risk` service in `GET /v1/directory` |
| `SELLER_RECEIPT_STORE_PATH` | `$PAYMINTO_DATA_DIR/agent/seller-<chain>-<address>.db` | The seller's durable receipt store |

`POST /v1/brief` takes `{ "symbols": ["HSK", "ETH"], "address": "0x...", "focus": "..." }` (all optional) and returns the brief, the inputs, and `purchases`: the receipts of what the seller bought.
The seller pays to its own address, so on settlement its earnings net against what it spent.

### Ops agent (`ops`)

| Var | Default | Meaning |
|---|---|---|
| `NODE_URL` | required | Clearing node base URL |
| `MERCHANT_API_KEY` | required | A business API key (dashboard Developers > API keys) |
| `PAYMINTO_MERCHANT_MCP` | `node apps/mcp/src/main.ts --merchant` | Another merchant server: a command line, or a Streamable HTTP URL |

The merchant tools are `get_overview`, `list_payments`, `get_payment`, `create_link`, `request_refund`, `get_reconciliation` and `list_blocked` (`docs/PRODUCT_PLAN.md` section 6.3).

## Run against the local stage

`pnpm demo:stage` boots anvil, the contracts, the node and the paid demo services, and prints the exact `pnpm agent run` and `pnpm agent ops` commands for that node.
The buyer runs on the Trading Agent's mandate, which may buy Market Data quotes and Risk Scan scans:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
export PAYMINTO_TRADING_AGENT_KEY=<the Trading Agent key: anvil dev account #3>
NODE_URL=http://localhost:8787 CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 HUB_ADDRESS=0x... \
  AGENT_KEY="$PAYMINTO_TRADING_AGENT_KEY" MANDATE_ID=0x... RECEIPT_STORE_PATH=<printed by demo:stage> \
  pnpm agent run "Quote HSK and ETH, scan wallet 0x... for risk, and write me a short risk note" --max-spend 50000
```

Use the values `pnpm demo:stage` prints; the receipt store must be the Trading Agent's, because every process of one agent key shares one store.
Add `--json` for machine output.

## Run against a HashKey Chain node

1. Create a budget (mandate) for the buyer agent in the dashboard (Agents > Budgets) with the payees it may pay, and fund it.
2. Run the buyer with that node and mandate:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   NODE_URL=https://node.example.com CHAIN_ID=133 AGENT_KEY=0x... MANDATE_ID=0x... \
     pnpm agent run "Buy a HashKey market brief on HSK and summarise it" --max-spend 20000
   ```

   `CHAIN_ID` is 133 for HashKey Chain testnet and 177 for mainnet; the wallet reads the hub from `contracts/deployments/<CHAIN_ID>.json` or the node.
3. To sell the market brief, give the seller its own budget that allows the quote and risk services, register it under Agents > Providers (or let it register with the operator sign-in), and start it with `pnpm agent serve-skill market-brief`.
4. For the ops agent, create a business API key and run `NODE_URL=... MERCHANT_API_KEY=... pnpm agent ops "what did we earn this week"`.

On a live network every payment is real; keep `--max-spend` and the mandate caps small.

## Tests

```sh
pnpm --filter @payminto/agent test
```

- `test/runtime.test.ts`: the loop with a scripted model and an in-memory wallet stand-in: tool calls, refusal reporting, the spend ceiling (before a call and after it), an injected payment instruction that is never paid, turn and token limits, unusable tool arguments, usage per turn, a `ModelError` passed through unchanged, a missing API key and the provider chosen from the environment; and the ops agent against a stdio stand-in of the merchant server started through `PAYMINTO_MERCHANT_MCP`.
- `packages/models/test/providers-anthropic.test.ts`, `providers-openai.test.ts` (OpenAI and OpenAI-compatible) and `providers-google.test.ts`, in the `@payminto/models` package: each adapter against a local mock of its provider's HTTP API (`packages/models/test/mock-provider.ts`, node:http on 127.0.0.1, exported as `@payminto/models/mock-provider`): plain answers, single and parallel tool calls, multi-turn tool results, usage, `max_tokens` and refusal stops, 401, 429 with `Retry-After`, 5xx, timeouts, malformed tool arguments, model lists and `verifyConnection`, and Gemini's schema conversion.
- `test/providers-loop.test.ts`: the same buyer task through `runAgent` on every provider's mock, with the runtime's guards intact on each, and the provider catalogue.
- `test/service.test.ts`: the agent service (token, ceiling, queueing) and the seller's 503 before payment.
- `test/cli.test.ts`: the CLI's usage, missing-key and configuration errors.
- `test/e2e.test.ts`: the local stack from `apps/demo` (own anvil, a temporary `*.demo.db`), a buyer and a seller agent with their own gasless mandates, and the seller registered on the node.
  The buyer runs through the real wallet MCP server over stdio with a scripted model, finds the seller in the directory and pays it; the seller buys two quotes and a risk scan with its own mandate; one settlement nets it all, and every receipt proves on chain through `prove_receipt`.
- `test/live.test.ts`: the same flow with the real model on both sides; it runs only when `ANTHROPIC_API_KEY` is set and is skipped otherwise.
