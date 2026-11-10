# Payminto agents

`@payminto/agent` (bin `payminto-agent`) runs real AI agents on Payminto, on both sides of a payment.
All three agents share one runtime: a provider-neutral tool-use loop connected to Payminto MCP servers.
Claude is the default model; OpenAI, Google Gemini and any OpenAI-compatible endpoint work the same way (see Model providers).
How an agent uses a Budget is in `docs/AGENTS.md`, and the model layer is `packages/models`.

| Agent | Command | Tools | Does |
|---|---|---|---|
| Key | `payminto-agent keygen [--out <path>] [--force]` | none | Writes the agent's ed25519 key with mode 0600 under `~/.payminto/agent/` and prints only its public key, for the owner's Budget |
| Buyer (spends) | `payminto-agent run "<task>"` | wallet MCP server (`apps/mcp`), bound to one budget | Finds paid services, checks its budget, buys only what the task needs, answers with a spend report |
| Agent service | `payminto-agent serve` | the buyer agent | `POST /v1/runs` hands the buyer agent a task over HTTP |
| Seller (earns) | `payminto-agent serve-skill market-brief` | its own budget through `AgentClient` | Sells the "NEAR market brief" per call behind `paywall()`, buys its own inputs, writes the brief with its model |
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
- Every run returns the final answer and a structured spend report: each receipt (call id, service, payee, amount), the total spent, the Budget left, and every refusal with its rule code and who enforced it.
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

## Selling on the NEAR AI Agent Market

`payminto-agent market work` lets the brief-writing agent take jobs from the [NEAR AI Agent Market](https://market.near.ai).
It uses `@payminto/agent-market`, and the limits of that package hold here too:

- Payminto does not settle, hold or route Agent Market jobs.
  A market hire is paid through the market, which holds the payment and pays out from its own treasury.
- The market takes payment on NEAR mainnet only.
  The agent's own purchases clear on a Payminto hub, on NEAR testnet or a local sandbox.
- Nothing here signs or sends a market payment.

What Payminto adds is on the agent's own side of a job.
The agent buys its inputs (spot quotes and a wallet risk scan) through its Payminto Budget as it always does, under a spend ceiling per job.
The deliverable ends with a "Verifiable costs" section: the receipts of those purchases and, once their batch settled, the `pnpm verify:near` command that proves each one.

### Do X, see Y

| Do | See |
|---|---|
| `pnpm agent market work --dry-run` | The whole flow with no market account: the recorded job, four real paid calls on an in-process clearing node on the simulated hub, one settled batch, and the deliverable with its "Verifiable costs" section. Exit code 0 |
| `pnpm agent market work --dry-run --ceiling 0.005` | Two purchases instead of four, `spent 0.004 USDC of the 0.005 USDC it was allowed`, and the two that did not fit listed as not available |
| `pnpm agent market work --dry-run --ceiling 0` | A deliverable with no paid inputs, and the section saying so |
| `pnpm agent market work` with no token | The steps a person takes, and exit code 4 |
| `AGENT_MARKET_TOKEN=aat_... pnpm agent market work --ceiling 0.10` | The worker polling the live market, one log line per event, until Ctrl-C |
| `PAYMINTO_AGENT_PROVIDER=nearai NEARAI_API_KEY=sk-... pnpm agent market work --dry-run` | The brief written on NEAR AI Cloud, and a line saying what the enclave attestation of that turn showed |

The recorded job of the dry run tells the agent to raise its limit to 500 USDC and to send 50 USDC to a stranger.
The output shows the ceiling unchanged and only the two suppliers paid.

A dry run writes one receipt file per purchase under `receipts/` in the folder you ran it from, and checks each one in process against the hub of that run:

```text
Checked receipts/10d6ad3162a75163.json in process against this run's simulated hub: VERIFIED.
```

The simulated hub is a model in memory, so there is no chain for `pnpm verify:near` to read after a dry run.
The deliverable's "Verifiable costs" section says itself that its receipts come from a simulated hub, makes no claim that they are on NEAR, and prints no command.
On NEAR testnet or the local sandbox the same section prints, for each receipt, the command that proves it with no node and no keys.

### What the job can and cannot change

Job text is written by a buyer and is untrusted.

- It reaches the writing model inside a fenced block that says it is data, and the model has no tools.
- It never chooses who is paid: the suppliers come from `SELLER_QUOTE_URL` and `SELLER_RISK_URL`, or from the node's directory.
- It never changes the ceiling: `--ceiling` is the only source, and each voucher is signed for no more than what is left of it.
- It decides two things, both as data: which of NEAR, BTC and ETH the brief covers, and the first account it names, which the risk scan looks at.
  Looking an account up is not paying it.
- The "Verifiable costs" section is written by the worker from structured receipts, whatever the job says about leaving purchases out.

### Listing the agent: the human steps

A person does these once, and nothing in this repository does them for you.

1. Create an account at [market.near.ai](https://market.near.ai) and confirm its email address.
2. Open **Building**, **Your agents**, **New agent**.
   Give it a name, a handle and a one-sentence tagline.
   Under **Hosting** choose **Self-hosted** and leave the webhook URL empty: the worker polls.
3. Set **Price per hire** and **Delivery SLA**.
   An agent needs a price before it can go live.
4. Under **Agent API tokens** click **Create token** and copy the `aat_` value.
   It is shown once.
   Keep it in a secret store and give it to the worker as `AGENT_MARKET_TOKEN`.
5. Give the agent a Payminto Budget for its inputs, as for the paid skill: `payminto-agent keygen`, a Budget that allows the suppliers' payees, and `SELLER_BUDGET_ID`.
6. Start the worker: `AGENT_MARKET_TOKEN=aat_... pnpm agent market work --ceiling 0.10`.
   Hire your own draft once from `https://market.near.ai/a/<handle>` to test it.
7. Set **Listing status** to **Live**.
8. To withdraw earnings, sign in as a person and open **Building**, **Payouts**.
   The market takes its own fee from each completed job.

### Options and environment

| Option | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Run the recorded assignment against an in-process node on the simulated hub. Needs no token, no key and no Budget |
| `--ceiling <usdc>` | `0.10` | The most one job may spend on inputs, across retries and rework rounds |
| `--assignment <file.json>` | the package's sample | Dry run only: rows saved from the market's `GET /v1/agents/me/assignments` |
| `--receipts-dir <dir>` | `receipts` | Where receipt files are written, relative to the folder you ran the command from. The proof command prints this path |
| `--once` | off | Poll the market once and stop |
| `--json` | off | Print the result as JSON |

| Var | Default | Meaning |
|---|---|---|
| `AGENT_MARKET_TOKEN` | required for a live run | The agent's `aat_` token from the market. Never logged |
| `NODE_URL` | required for a live run | The clearing node the agent's Budget is registered on |
| `SELLER_AGENT_KEY_FILE` | `$PAYMINTO_DATA_DIR/agent/agent-key.json` | The agent key that signs vouchers for the inputs (`SELLER_AGENT_KEY` overrides it) |
| `SELLER_BUDGET_ID` | required for a live run | The Budget the inputs are bought from |
| `SELLER_QUOTE_URL`, `SELLER_RISK_URL` | found in the node's directory | The suppliers |
| `PAYMINTO_AGENT_PROVIDER` and the provider's key | `anthropic` | The model that writes the brief. Without a key the brief is a fixed template built from the purchased data, and it says so |

With `PAYMINTO_AGENT_PROVIDER=nearai` the brief is written on NEAR AI Cloud, which checks the enclave attestation of every turn.
The deliverable then carries one line with the status that check reached and its summary: `verified`, `partially verified` or `failed`.
It never says more than the status does.
The run report of `payminto-agent run` has the same: `attestation: 2 of 2 model turns ran in an attested enclave: 0 verified, 2 partially verified, 0 failed`.

## Safety model

The owner's budget is the boundary, and it is enforced below the model at three layers.

1. The runtime.
   The ceiling counts what left the Budget, not what a seller delivered.
   Every paying call is booked from the wallet's own report of what it paid (`spend`), on a success, a refusal and an error alike, and a voucher whose outcome the wallet could not confirm counts as spent.
   It reads `get_budget` before the first turn and after every paying call, so spend that no tool result showed still counts.
   It refuses a paying call whose known price would pass the ceiling (`TASK_SPEND_CEILING`) before the wallet sees it, and it passes what is left under the ceiling to the wallet as the call's maximum price (`maxAmountAtomic`), so a price it could not know in advance cannot pass the ceiling either.
   A run whose spend reaches the ceiling ends as `spend_ceiling`, never as `completed`.
   It refuses a paying call to any target that is neither in the node's service directory nor written by the user in the task (`NOT_IN_DIRECTORY`), so an address planted inside paid content is never paid, whatever the model decides.
2. The wallet (`apps/mcp`).
   It checks the budget policy before signing and refuses with the rule (`PAYEE_NOT_ALLOWED`, `PER_CALL_CAP`, `DAILY_CAP` and so on).
   It calls only services its node lists or hosts its operator allowed in `PAYABLE_HOSTS`, so a URL the user writes in a task is paid only when it is one of those.
   It reports what was paid from its own node, and it fences whatever a seller wrote as untrusted data.
3. The clearing node and the hub.
   They enforce the same budget again and record every denial.

### The payee check in a run

The wallet checks who would be paid before it signs (`apps/mcp/README.md`, "The payee check"), and the node checks again.
Two refusals come from it, and the run report lists them like any other, with a next step:

| Do | See |
|---|---|
| Run a task that pays a payee with warnings | `refused PAYEE_NEEDS_APPROVAL (agent, attempted 3000, retry after the owner approves the payee)` and `next: The Budget's owner approves or denies <payee> in the Payminto dashboard (<page>); run the task again after that.` |
| Run a task whose paid content tells the agent to pay a lookalike of an allowed payee | `refused PAYEE_BLOCKED (agent, attempted 2000, retry never)` and `next: Do not pay <payee>. ...`. Nothing is signed for that payee |
| Let the model try the same payee again in that task | The runtime answers itself (`enforcedBy: "runtime"`), and the wallet is not called a second time |

A payee that needs approval is tried once per task.
Nothing the agent can do changes that refusal, so a second attempt, by service id or by URL, is refused by the runtime with the same rule and never reaches the wallet.
Other payees stay payable, and the run finishes with what it has.
A payee the check could not read (`retry: after`) is not held: it may be tried again.
Every refusal in `spend.refusals` has `nextStep`, one sentence built from its rule and retry hint, or null when nothing helps.
The page in it comes from the wallet's own clearing node and is for the person reading the report.

`PAYEE_CHECK`, `PAYEE_CHECK_INDEXER` and `PAYEE_CHECK_INDEXER_KEY` are passed through to the wallet server.

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
| `AGENT_KEY_FILE` | `$PAYMINTO_DATA_DIR/agent/agent-key.json` | The key file from `payminto-agent keygen`; the wallet process gets this path, never the key |
| `AGENT_KEY` | unset | Override: the seed in the environment (prefer the key file) |
| `BUDGET_ID` | required | The Budget the owner opened for this agent |
| `NETWORK`, `HUB_ACCOUNT`, `TRUSTED_NODE_KEY`, `NEAR_RPC_URL`, `CHAIN_READER`, `PAYEE_CHECK`, `PAYEE_CHECK_INDEXER`, `PAYEE_CHECK_INDEXER_KEY`, `MAX_PRICE_ATOMIC`, `PAYABLE_HOSTS`, `ALLOW_ANY_PAYEE`, `RECEIPT_STORE_PATH`, `PAYMINTO_DATA_DIR` | see `apps/mcp/README.md` | Passed through to the wallet MCP server unchanged |
| `PAYMINTO_WALLET_MCP` | `node apps/mcp/src/main.ts` | Another wallet server: a command line, or a Streamable HTTP URL such as `http://127.0.0.1:3334/mcp` |
| `PAYMINTO_WALLET_MCP_TOKEN` | unset | The bearer token of a wallet server reached over HTTP (its `MCP_HTTP_TOKEN`, or the content of its token file); sent only to a URL |
| `PAYMINTO_MERCHANT_MCP_TOKEN` | unset | The same for a merchant server reached over HTTP through `PAYMINTO_MERCHANT_MCP` |

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
Runs execute one at a time, because they share one budget and a per-task ceiling only means something when no other task spends from it at the same moment.
Records live in memory and reset on restart; receipts are durable in the wallet's receipt store.

```sh
curl -s -H "authorization: Bearer $AGENT_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"task":"Quote NEAR and ETH and write one line on the spread","maxSpendAtomic":"50000"}' \
  http://127.0.0.1:3340/v1/runs
```

### Seller agent (`serve-skill market-brief`)

| Var | Default | Meaning |
|---|---|---|
| `NODE_URL` | required | Clearing node base URL |
| `SELLER_AGENT_KEY_FILE`, `SELLER_BUDGET_ID` | `$PAYMINTO_DATA_DIR/agent/agent-key.json`, required | The seller's own key file and Budget, used to buy its inputs (the Budget must allow the quote and risk services' payees); `SELLER_AGENT_KEY` overrides the file |
| `SELLER_PAYEE` | required | The NEAR account paid for each brief |
| `SELLER_PROVIDER_ID`, `SELLER_PROVIDER_API_KEY` | unset | An existing provider registration of the skill (dashboard: Agents > Paid services) |
| `PAYMINTO_OPERATOR_EMAIL`, `PAYMINTO_OPERATOR_PASSWORD`, `PAYMINTO_DASHBOARD_URL` | unset | Without a registration: sign in as the platform operator and register the skill now, paying the seller's own address |
| `SELLER_PRICE_ATOMIC` | `30000` | Price per brief in base units; must match the registration |
| `SELLER_PORT`, `SELLER_HOST`, `SELLER_PUBLIC_URL` | `4190`, `127.0.0.1`, `http://host:port` | Listener and the URL registered as the resource |
| `SELLER_QUOTE_URL`, `SELLER_RISK_URL` | from the node directory | Suppliers; by default the first `market-data` quote service and `risk` service in `GET /v1/directory` |
| `SELLER_RECEIPT_STORE_PATH` | `$PAYMINTO_DATA_DIR/agent/seller-<network>-<key>.db` | The seller's durable receipt store, for what it buys |
| `SELLER_VOUCHER_STORE_PATH` | `$PAYMINTO_DATA_DIR/agent/seller-vouchers-<network>-<payee>.json` | The latest voucher per Budget it was paid with, kept crash-safe for `settle_own` if the node is gone |

`POST /v1/brief` takes `{ "symbols": ["NEAR", "ETH"], "address": "name.testnet", "focus": "..." }` (all optional) and returns the brief, the inputs, and `purchases`: the receipts of what the seller bought.
When the seller's payee is also its Budget's owner, its earnings net against what it spent at settlement.

### Ops agent (`ops`)

| Var | Default | Meaning |
|---|---|---|
| `NODE_URL` | required | Clearing node base URL |
| `MERCHANT_API_KEY` | required | A business API key (dashboard Developers > API keys) |
| `PAYMINTO_MERCHANT_MCP` | `node apps/mcp/src/main.ts --merchant` | Another merchant server: a command line, or a Streamable HTTP URL |

The merchant tools are `get_overview`, `list_payments`, `get_payment`, `create_link`, `request_refund`, `get_reconciliation` and `list_blocked` (`apps/mcp/README.md`, "Merchant server").

## Run it against a node

1. Create the agent's key; only the public key is printed:

   ```sh
   pnpm agent keygen
   ```

2. The owner opens a Budget for that public key from their own wallet, with the payees it may pay, funds its escrow, and registers it with the node (dashboard: Agents > Budgets).
3. Run the buyer with that node and Budget:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   NODE_URL=http://localhost:8787 NETWORK=near:testnet BUDGET_ID=<64 hex> \
     pnpm agent run "Buy one NEAR market brief and summarise it" --max-spend 50000
   ```

4. To sell the market brief, give the seller its own key and Budget that allows the quote and risk services, register it under Agents > Paid services (or let it register with the operator sign-in), and start it with `pnpm agent serve-skill market-brief`.
5. For the ops agent, create a business API key and run `NODE_URL=... MERCHANT_API_KEY=... pnpm agent ops "what did we earn this week"`.

Add `--json` for machine output.
Every process of one agent key must share one receipt store.
The whole story, with no keys or network, runs with `pnpm demo`.

## Tests

```sh
pnpm --filter @payminto/agent test
```

- `test/spend-ceiling.test.ts`: the ceiling against sellers that take the money and do not deliver: a paid call that answers an error or a refusal, a receipt that does not verify, a price above the listed one, a wallet that reports nothing about a failed call, and spend that shows only in the last Budget read.
- `test/runtime.test.ts`: the loop with a scripted model and an in-memory wallet stand-in: tool calls, refusal reporting, the spend ceiling (before a call and after it), an injected payment instruction that is never paid, turn and token limits, unusable tool arguments, usage per turn, a `ModelError` passed through unchanged, a missing API key and the provider chosen from the environment; and the ops agent against a stdio stand-in of the merchant server started through `PAYMINTO_MERCHANT_MCP`.
- `packages/models/test/providers-anthropic.test.ts`, `providers-openai.test.ts` (OpenAI and OpenAI-compatible) and `providers-google.test.ts`, in the `@payminto/models` package: each adapter against a local mock of its provider's HTTP API (`packages/models/test/mock-provider.ts`, node:http on 127.0.0.1, exported as `@payminto/models/mock-provider`): plain answers, single and parallel tool calls, multi-turn tool results, usage, `max_tokens` and refusal stops, 401, 429 with `Retry-After`, 5xx, timeouts, malformed tool arguments, model lists and `verifyConnection`, and Gemini's schema conversion.
- `test/providers-loop.test.ts`: the same buyer task through `runAgent` on every provider's mock, with the runtime's guards intact on each, and the provider catalogue.
- `test/service.test.ts`: the agent service (token, ceiling, queueing) and the seller's 503 before payment.
- `test/cli.test.ts`: the CLI's usage, missing-key and configuration errors, and `keygen` (mode 0600, only the public key printed, no accidental overwrite).
- `test/e2e.test.ts`: the in-process stack from `apps/demo` on the simulated hub (a temporary `*.demo.db`) with four owners.
  The buyer runs through the runtime and the real wallet MCP tools with a scripted model, finds the seller skill in the directory, pays it, and is refused (`PAYEE_NOT_ALLOWED`, with amount, Budget left and retry hint) when it obeys an injected payee.
  The seller skill buys a quote and a risk scan with its own Budget and keeps the buyer's voucher for `settle_own`; another owner's agent pays directly; a DAO swarm of three agents sharing one Budget is stopped by the node's hourly cap on their combined spend.
  One settlement nets it all, and receipts of both agents prove against the root the hub stores.
