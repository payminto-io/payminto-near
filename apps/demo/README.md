# Payminto Clearing demo

Three paid services, three agents and the scripted live demo, on the real stack: ClearingHub, the Clearing Node, the SDK paywall, `AgentClient` and the MCP server.
The build contract is `docs/SPEC.md` section 8.

## One command

```sh
pnpm install
pnpm demo
```

It starts its own anvil on a free port, deploys with `forge script script/DeployLocal.s.sol`, starts the Clearing Node in-process on a fresh `*.demo.db`, registers and serves the providers, mints test USDC, opens three mandates on chain, runs about 500 paid calls at concurrency 24, settles, and prints a summary.
The summary shows calls, gross, net, on-chain transfers decoded from the tx receipts, the compression ratio, settlement gas versus a measured one-transfer-per-call baseline, every denial with its rule, HSP status per transfer, a Merkle proof checked on chain with `verifyReceipt`, the trial balance, and the dashboard URL.
Then the gateway act runs (local only, about 11 s): the operator creates the merchant Northwind Data with a 0.5 % + 0.01 USDC plan and a 0.05 USDC deposit fee the customer pays, and one 2.00 USDC link is paid by a person with a wallet signature, a person by plain transfer, a plain x402 agent with `payExact`, and an MCP mandate agent with two vouchers settled in the next batch.
A gasless refund and a screening refusal follow, and the gateway summary shows each payment's amount, fee, net, status and tx, the platform fees earned, the webhooks delivered and verified, and a proof check.
Its checks: every payment paid, fees equal `computeFees`, merchant and platform balance deltas equal the fee breakdowns, forwarders, router and hub at zero, every webhook verified, and the screening decision recorded.
In stage mode it is step 8, after the clearing steps.
It exits non-zero if any check fails.
Ctrl-C stops the node, providers and anvil; anvil also runs under a watchdog that stops it if the demo process dies.

## Stage mode

```sh
pnpm demo:stage
```

Same stack, paced (about 14 calls per second, `DEMO_STAGE_PACE`), advancing one demo step per Enter: mandate, agents buying with the two attacks, netting preview, settle (click Settle now in the dashboard, or press Enter in the terminal), batch with HSP status, a judge-picked call proven on chain, and the books.
If port 3000 is taken, set `DEMO_DASHBOARD_PORT` (for example 3010) and start the dashboard with `-p 3010`; the node then accepts that origin.
Node and providers keep running afterwards so the dashboard stays live; Ctrl-C stops everything.
Start the dashboard in a second terminal with the URL the demo prints, for example:

```sh
NEXT_PUBLIC_NODE_URL=http://localhost:8787 NEXT_PUBLIC_RPC_URL=<the printed RPC URL> pnpm --filter dashboard dev
```

The demo completes first-run setup itself (the dev admin token is the setup code) and signs in as the platform owner `owner@demo.local`, like a person would.
Stage mode prints the generated password once; both logins (the owner and `admin@northwind.demo.local`) are saved in `dashboard-logins.json` in the run directory.
After setup the admin token (the recovery key) no longer works, so the demo's own operator calls use the owner's session.

The optional MCP command it prints never contains a key: it reads the Trading Agent key from `PAYMINTO_TRADING_AGENT_KEY` (anvil dev account #3 on the local chain).

### Recording a film (auto mode)

`DEMO_STAGE_AUTO=1` advances every step on a timer, so the terminal can be filmed without touching the keyboard (Enter still skips ahead in a terminal).
Before step 4 it holds the pre-settle state so the Netting "before" shot can be taken and Settle now clicked in the dashboard; if nobody clicks, it settles from the terminal after the delay.
Settling from the dashboard or from the terminal plays out the same on the Netting screen.

| Var | Default | Meaning |
|---|---|---|
| `DEMO_STAGE_AUTO` | unset | `1` advances steps automatically |
| `DEMO_STAGE_STEP_MS` | `4000` | Pause before each step in auto mode |
| `DEMO_STAGE_SETTLE_DELAY_MS` | `20000` | Auto mode: how long step 4 waits for Settle now before settling from the terminal; `0` waits for the dashboard only |
| `DEMO_STAGE_HOLD` | unset | `1` keeps the stack up after the last step without a terminal on stdin |

```sh
# terminal 1, repo root
DEMO_STAGE_AUTO=1 DEMO_STAGE_STEP_MS=4000 DEMO_STAGE_SETTLE_DELAY_MS=45000 DEMO_STAGE_HOLD=1 DEMO_DASHBOARD_PORT=3010 pnpm demo:stage
# terminal 2, apps/dashboard
NEXT_PUBLIC_NODE_URL=http://localhost:8787 npx next dev -p 3010
```

In dev mode each screen compiles on its first visit; open every screen once (or `curl` it) before recording so no loading state is filmed.

## Cast

| Who | Port | Price (local) | Role |
|---|---|---|---|
| Market Data | 4101 | 0.002 USDC per quote | HSK, BTC and ETH quotes from CoinGecko (cached 30 s, 1.5 s timeout) with a deterministic fallback; every response has a `source` field |
| Risk Scan | 4102 | 0.01 USDC per address | Deterministic heuristic score, labelled as such in every response |
| Research Writer | 4103 | 0.05 USDC per brief | An agent and a provider: each brief buys 2 quotes and 1 scan with its own mandate |
| Premium Alpha (unlisted) | 4104 | 0.02 USDC | The attacker endpoint promoted by an injected post; no mandate allows its payee |
| Treasury Agent | - | - | Pays through `AgentClient` directly; payees Market Data, Risk Scan, Research Writer; per-call cap 0.05 USDC |
| Trading Agent | - | - | Pays only through the MCP tools (`call_paid_service`, `prove_receipt`); payees Market Data, Risk Scan |

The attacks run mid-traffic and are each denied twice.
Layer 1: the agent's own SDK refuses before signing (`PAYEE_NOT_ALLOWED` for the injection, `PER_CALL_CAP` for a 0.25 USDC deep dive).
Layer 2: the same agent key with its client guard switched off, standing in for a compromised runtime, signs anyway and the Clearing Node denies it with the same rule and records it, so it shows on the dashboard.

## Live networks

The same scenario runs on HashKey Chain testnet (133), Ethereum Sepolia (11155111, Circle test USDC) or HashKey Chain mainnet (177) with tiny prices (Market Data 0.0001, Risk Scan 0.0005, Research Writer 0.0025 USDC).
`docs/TESTNET.md` is the step-by-step runbook for the two testnets: wallets, deploy, funding and the full command.
It never deploys there: `contracts/deployments/<chainId>.json` must exist.
It refuses to start unless every one of these holds, before touching the chain:

- `DEMO_LIVE_NETWORK_CONFIRM=yes`.
- The planned spend, printed first, is at or below `DEMO_MAX_SPEND_USDC` (default `1`).
- Every key is given explicitly and none is a public anvil dev key: `DEMO_OPERATOR_KEY`, `DEMO_OWNER_KEY`, `DEMO_TREASURY_KEY`, `DEMO_TRADING_KEY`, `DEMO_WRITER_KEY`.
- Payee wallets are given: `DEMO_MARKET_PAYEE`, `DEMO_RISK_PAYEE` (`DEMO_ROGUE_PAYEE` defaults to the dead address and is never paid).
- `DEMO_ADMIN_TOKEN` is set, and `DEMO_RPC_URL` (or the network default) serves the declared chain.

Agent wallets must already hold the token; the demo approves the hub for exactly the mandate cap, never unlimited.
The Research Writer never approves: it signs an EIP-2612 permit for its cap and the node opens its mandate with `openMandateWithPermit`, and the run checks that it sent 0 transactions.

```sh
DEMO_CHAIN_ID=133 DEMO_LIVE_NETWORK_CONFIRM=yes DEMO_CALLS=100 DEMO_MAX_SPEND_USDC=0.1 \
  DEMO_OPERATOR_KEY=... DEMO_OWNER_KEY=... DEMO_TREASURY_KEY=... DEMO_TRADING_KEY=... DEMO_WRITER_KEY=... \
  DEMO_MARKET_PAYEE=0x... DEMO_RISK_PAYEE=0x... DEMO_ADMIN_TOKEN=... pnpm demo:stage
```

### Confirmations on a live network

On a public chain the node confirms at its `CONFIRM_TAG`, the safe head by default (about 10 minutes behind on 133, one to two epochs on Sepolia).
After settling, the demo waits until every batch is confirmed and reconciled before it reads gross and net, proves a receipt or checks HSP statuses, printing each status change; the wait is sized from the chain's measured safe-head lag.
`DEMO_CONFIRM_TAG` passes a tag to the node: `latest` is the testnet recording setting, and the plan and summary say "at the latest head (testnet demo setting)" whenever it is on.

### Gateway act on a live network

`DEMO_GATEWAY=1` runs the gateway act on a live network too, with funded testnet wallets instead of minted ones and about a hundredth of the local amounts: a 0.02 USDC link, a 0.0005 USDC deposit fee, 0.5 % + 0.0001 USDC platform fee, and a 0.005 USDC refund.
Its payers' spend (four payments of the link, one with the deposit fee) counts towards the planned spend and `DEMO_MAX_SPEND_USDC`.
Every role needs its own key, none a public dev key or another role's:

| Var | Role |
|---|---|
| `DEMO_STORE_PAYOUT_KEY` | The platform's own store, the seeded first business; it also sells the AI skill when `DEMO_AI=1` |
| `DEMO_PLATFORM_FEES_KEY` | The platform fee wallet |
| `DEMO_NORTHWIND_PAYOUT_KEY` | Northwind Data's payout: signs the payout proof and the gasless refund |
| `DEMO_HUMAN_PAYER_KEY` | A person paying by wallet signature (sends no transaction) |
| `DEMO_DEPOSIT_PAYER_KEY` | A person paying by plain transfer (the only payer that needs gas) |
| `DEMO_X402_AGENT_KEY` | An x402 agent paying with `exact` |
| `DEMO_MANDATE_AGENT_KEY` | An MCP mandate agent paying with vouchers (onboarded with a permit) |
| `DEMO_FLAGGED_KEY` | A wallet on the deny list, refused by screening |
| `DEMO_PUBLIC_CHECKOUT_URL` | A public https origin; the node runs the gateway |
| `DEMO_WEBHOOK_URL` | Optional public https receiver; without it the webhook checks are skipped, because the node refuses private webhook targets on public chains |

`pnpm --filter @payminto/demo fund:testnet <chainId> --gateway --yes` funds the payers from the operator.
The act also fetches the reconciliation report (JSON and CSV) for its time range and checks it holds the four paid payments, their net, the refund and a ledger that matches.
Every transaction of the act is listed with its explorer link at the end of its summary.

## AI agents act

`DEMO_AI=1` adds a last act (step 9 in stage mode) with real AI agents on the same stack, after the gateway act.
Each business brings its own model key, so model costs land on that business's own provider account.

What it does and checks:
- Each business that takes part adds an AI connection with its own key (`POST /v1/ai/connections`), and the node verifies it and seals it in the database.
- An ops agent runs in the node's run worker against a business's real data (locally Northwind Data after the gateway act) and must call at least one merchant tool.
- The seeded first business sells a paid AI skill, "HashKey market brief", at `/v1/skills/market-brief` for the Research Writer's price.
- An AI buyer agent, the real `payminto-agent run` runtime in its own process with the wallet MCP server, spends from the Treasury Agent's mandate under a ceiling of two briefs.
  It must find the skill in the directory and pay for it exactly once with a voucher.
- The batch settles, and the skill call's receipt is proven on chain with `verifyReceipt`; settlement transactions are printed as explorer links.

| Var | Default | Meaning |
|---|---|---|
| `DEMO_AI` | unset | `1` turns the act on |
| `DEMO_AI_PROVIDER` | `openai` | `openai`, `anthropic`, `google`, `openai_compatible` or `replicate` |
| `DEMO_AI_MODEL` | `gpt-5-mini` for OpenAI | The model both agents use (`claude-haiku-5-5`, `gemini-2.5-flash` and `deepseek-ai/deepseek-v3.1` on Replicate for the others; required for `openai_compatible`) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `REPLICATE_API_TOKEN` | unset | The provider's key; `DEMO_AI_API_KEY` overrides it and is the key for `openai_compatible`; Replicate needs no base URL |
| `DEMO_AI_BASE_URL` | unset | Required for `openai_compatible`; a server on this machine may run without a key |
| `DEMO_MERCHANT_PAYOUT` | unset | Live networks: the wallet of the business that sells the skill (never a demo key's wallet) |
| `DEMO_PUBLIC_CHECKOUT_URL` | unset | Live networks: a public https origin, because the node turns the gateway on for the act |

The key is never printed: the plan shows the provider, the model and the key's last four characters.
Each run seals it with a fresh `AGENT_SECRETS_KEY`, so it is unreadable once the run's database is gone.
On a live network the skill call and the ceiling count against `DEMO_MAX_SPEND_USDC`, and the Treasury Agent must hold the extra.

Cost: one run makes about seven model turns (two for the ops agent, one for the skill, three or four for the buyer), roughly 10,000 input and 1,000 output tokens; with `gpt-5-mini` that is well under one US cent.

Rehearsing without a key: `node scripts/scripted-model.ts` starts a scripted OpenAI-compatible stand-in on this machine and prints its `DEMO_AI_BASE_URL`; it is never a real model.

```sh
DEMO_AI=1 OPENAI_API_KEY=sk-... pnpm demo
DEMO_AI=1 DEMO_AI_PROVIDER=openai_compatible DEMO_AI_BASE_URL=http://127.0.0.1:<port>/v1 DEMO_AI_MODEL=scripted-demo-model pnpm demo
```

## Other knobs

| Var | Default | Meaning |
|---|---|---|
| `DEMO_CALLS` | `500` | Target paid calls (split into the scenario mix) |
| `DEMO_CONCURRENCY` | `24` | Parallel callers |
| `DEMO_NODE_PORT` | `8787` | Node port; falls back to a free port (and says so) when busy |
| `DEMO_PROVIDER_BASE_PORT` | `4101` | Providers use this port and the next three |
| `DEMO_RPC_URL` | own anvil | Use an existing chain instead |
| `DEMO_OFFLINE` | unset | `1` skips the live price source |
| `DEMO_DATA_DIR` | `apps/demo/data` | Each run gets `run-<time>/` with `clearing-<chainId>.demo.db` and `node.log` |

## Data safety

Every run uses a new database whose name ends in `.demo.db`, checked with the node's own `assertDisposableTarget` guard before the node starts.
`forge script DeployLocal` writes the shared `contracts/deployments/31337.json`; the demo restores that file's previous content and keeps its own copy in the run directory, so other local sessions are not disturbed.

## Tests

```sh
pnpm --filter @payminto/demo test
```

`test/demo.test.ts` runs the whole scenario compressed to 60 calls against its own anvil and asserts the summary: one confirmed, reconciled batch with fewer transfers than calls, gross equal to the planned mix, both attacks denied in the agent and at the node with the right rules, every transfer an accepted co-signed HSP payment, trial balance zero, hub empty, a proof verified on chain, and the MCP server over stdio.
`test/config.test.ts` covers the live-network safety guard.
