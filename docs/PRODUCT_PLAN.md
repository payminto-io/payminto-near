# Payminto product plan: agents, HSP and reconciliation

Status: approved for build on 2026-11-01, ships in the HashKey Chain Horizon Mumbai submission on 2026-11-02.
Owner: Sagar Jethi.
Written as a product review: product manager, payments consultant and market research, then turned into a build plan.
Where this file and `PRODUCT.md` disagree on user-facing words, `PRODUCT.md` wins.

## 1. What Payminto is, and what this plan adds

Payminto lets a business get paid in stablecoins by people and by AI agents, on its own server, with nobody in the middle holding the money.
It already has two working halves: payments (links, hosted checkout, refunds, webhooks, fee split on chain) and agents (mandates, per-call vouchers, netting, receipt proofs).
What it does not have yet is the agents themselves.
Today the agents in the repo are scripted clients that call MCP tools in a fixed order, and the "Research Writer" is a deterministic function.
This plan makes agents first-class users of the product, on both sides of a payment, and adds the two things merchants and judges check first: HashKey's own settlement rail (HSP) and a reconciliation report.

We are not adding a second product.
Every item below is a surface of the existing one: an agent that spends through a mandate, an agent that earns through a paywall, an agent that runs the merchant's back office, a payment method, and a report.

## 2. Market read

Sources: `research/03-market-competitors.md`, `research/01-hsp-hashkey-tech.md`, the 27 Mumbai builds and past HashKey winners.

- The agent payments stack has split into layers.
  x402 owns "how a call asks for money", AP2 owns "how a human's consent is proven", ERC-8004 owns identity, and card networks own agent card checkout.
- Nobody owns the operator layer in the middle: enforcing budgets, metering, netting many tiny charges, refunds and an audit trail that a finance team accepts.
- Hosted players (Skyfire, Nevermined, Payman, Crossmint) hold funds or wallets; there is no self-hosted, non-custodial operator product.
- HSP is HashKey's licensed settlement rail, built on AP2, with a hackathon MCP server published on 2026-10-30.
  None of the 27 Mumbai builds has run a live HSP payment yet.
- Past HashKey payment winners solved a named business workflow and took the merchant's point of view (AllScale, Japan 1st: "makes merchants safe to get paid").
  Spend-limit wallets and payment links alone did not win in Hong Kong.
- India: UPI already has agentic payments (NPCI, Razorpay, OpenAI pilot), so the idea of an agent with a spending limit is familiar.
  Indian API and SaaS sellers with foreign customers are the natural first merchants for stablecoin settlement.

## 3. Who uses it and what job they hire it for

| User | Job | Where in Payminto today |
|---|---|---|
| Business that sells an API, data or an AI skill | Get paid per call by agents and by people, see every payment reconciled | Payments, Agents > Providers |
| Team that runs AI agents | Let agents buy what they need without an open wallet; know exactly what was spent and why | Agents > Budgets |
| Platform owner | Host many businesses on one server and earn a fee | Platform |
| Finance or accountant | One report that ties payment, fee, refund and on-chain proof together | Missing: this plan adds it |

## 4. Product principles for this release

1. Real, not staged.
   Agents call a real model and real paid services; a payment is real on whatever chain the server runs.
   The scripted demo stays, but it is no longer the only way to see an agent pay.
2. The owner's policy is the boundary.
   An agent can only spend through a mandate; refusals name the rule; agents never follow payment instructions found in content.
3. Merchant first.
   Every agent feature ends in something a merchant can see: a payment, a receipt, a refund, a line in the report.
4. One rail more, not a new stack.
   HSP is a payment method into the same fee-splitting forwarder, so fees, webhooks, refunds and the report work unchanged.
5. Honest labels.
   Anything that depends on outside access (HSP allowlist, model key) says so on screen and in the README, and fails closed.

## 5. The three agents

All three run on one agent runtime (`apps/agent`): a Claude tool-use loop connected to Payminto MCP servers.
Model and keys come from the environment (`ANTHROPIC_API_KEY`, `PAYMINTO_AGENT_MODEL`, default `claude-opus-5-5`).

### 5.1 Buyer agent (spends)

- Who: a team that runs agents.
- What: takes a task in plain words ("compare HSK and ETH spot and write me a risk note on wallet 0x..."), discovers paid services on the node, checks its budget, buys only what the task needs, and returns the answer with a spend report (each receipt, total spent, budget left).
- How: the existing wallet MCP server (`list_paid_services`, `call_paid_service`, `pay_link`, `get_budget`, `get_receipts`, `prove_receipt`), bound to one mandate.
- Guard rails: a per-task spend ceiling on top of the mandate; refusals are reported, never retried around; content from services is treated as data.
- Surfaces: `payminto-agent run "<task>"` (CLI) and `POST /v1/runs` on the agent service, so other software can hand it work.

### 5.2 Seller agent (earns)

- Who: a business that wants to sell an AI skill per call.
- What: wraps a Claude skill as a paid endpoint behind the existing `paywall()`.
  It is listed in the node's directory like any provider, so buyer agents find and pay it.
- First skill: "HashKey market brief".
  It buys its inputs from other paid services (spot quotes, wallet risk) with its own mandate, then writes the brief with Claude.
  That is real agent-to-agent commerce: one agent pays another, which pays others, and the node nets it all.
- Surfaces: `payminto-agent serve` with a skill config; registered as a provider on the node.

### 5.3 Ops agent (runs the back office)

- Who: the business owner or staff.
- What: answers "what did we earn this week", "which payments are unpaid", "refund order 1001", "send me the reconciliation for October", in plain words.
- How: a new merchant MCP server (section 6.3) authenticated with the business's API key.
  Refunds go through the existing approval flow, so the agent can request but a human approves when the business requires it.
- Surfaces: `payminto-agent ops "<question>"`, and the same MCP server works in Claude Desktop or Claude Code.

## 6. Features

### 6.1 HSP payment method (P0)

- A business can turn on "HSP" as a payment method next to wallet, deposit and agent.
- Flow for one payment: the server creates an HSP order (`create_order`, `pay_to` = the payment's fee-splitting forwarder, fixed `merchant_name`), the payer's wallet signs the EIP-712 data from `prepare_payment`, the server calls `finalize_payment` and `submit_payment`, then polls `query_payment` until `payment-finalized` or `payment-failed`.
- HSP's gateway broadcasts the transfer into our forwarder, so the existing deposit watcher sees it, the payment turns paid, and the fee is split exactly as today.
- The payment stores `hsp_flow_id`, `hsp_payment_request_id`, the HSP status and `attribution_verified`; the dashboard shows them; webhooks carry them.
- Agents: the 402 answer lists an `hsp` option when the method is on; the SDK and `pay_link` can pay through it.
- Access: the HSP MCP endpoint needs our egress IP on HashKey's allowlist.
  Until then the method shows "Waiting for HSP access" and is refused cleanly; tests run against a local HSP MCP stand-in that speaks the same eight tools.

### 6.2 Reconciliation report (P0)

- One report per business and date range, as CSV and JSON: payment id, reference, created and paid times, method (wallet, deposit, x402, voucher, HSP), payer, amount, fee lines, net to merchant, refunds, on-chain transaction, HSP flow id and status, batch and receipt proof for agent payments, screening decision if any.
- API: `GET /v1/reports/reconciliation?from=&to=&format=csv|json` with a business key.
- Dashboard: "Download report" on Payments, with a date range.
- Totals at the end match the ledger trial balance for the range; a test proves it.

### 6.3 Merchant MCP server (P0)

New MCP server mode (`payminto-mcp --merchant`) with the business API key:

| Tool | Does |
|---|---|
| `get_overview` | Earnings, payment counts and pending refunds for a range |
| `list_payments` / `get_payment` | Search and read payments |
| `create_link` | Create a payment link and return its URL |
| `request_refund` | Request a refund; follows the business's approval rule |
| `get_reconciliation` | The section 6.2 report for a range |
| `list_blocked` | Screening refusals with their rule |

### 6.4 Owner tools for budgets (P1)

`create_budget`, `pause_budget` and `get_budget_activity` for the team that runs agents, signed with the owner key on the owner's machine only.
P1 because the dashboard already covers it.

## 7. What done means for the 2 Nov submission

1. `payminto-agent run` completes a real task against a running server: it discovers services, buys from the seller agent, the seller agent buys its own inputs, and both receipts prove on chain after settlement.
2. `payminto-agent ops "what did we earn today"` answers from real data, and a refund request appears in the dashboard.
3. An HSP payment completes against the HSP stand-in in tests; against HashKey's QA server once our IP is allowlisted, with `attribution_verified` true.
4. The reconciliation CSV downloads from the dashboard and its totals match the ledger.
5. `pnpm test`, `pnpm typecheck` and `pnpm contracts:test` pass; CI is green.

## 8. Metrics we will show

- Calls bought by the buyer agent per task, spend per task, refusals per task.
- Share of agent payments settled by netting versus one transfer each (gas saved).
- Time from HSP submit to `payment-finalized`.
- Reconciliation: report totals equal ledger totals, zero unexplained differences.

## 9. Risks

| Risk | Mitigation |
|---|---|
| HSP allowlist not granted in time | Method fails closed with a clear status; stand-in proves the integration; README says what is live |
| HSP QA network differs from the server's chain | Read `get_chain_config` at startup; enable the method only when network and token match |
| Model cost or outage during the pitch | Per-task spend and token ceilings; recorded run kept as backup |
| Prompt injection inside paid content | Content is data; mandate allowlist and per-task ceiling enforced below the model |
| Scope too big for one day | P0 is 6.1 to 6.3 and the buyer and seller agents; everything else waits |

## 10. Out of scope for this release

Fiat off-ramp, card rails, ACP and MPP adapters, KYC of agent owners, invoices with due dates, multi-chain.
They stay on the roadmap slide.

## 11. Build plan

Three workstreams in parallel, each on its own branch, merged into `feat/agents-and-hsp`:

| Workstream | Scope | Main paths |
|---|---|---|
| A. HSP rail | 6.1 | `apps/node/src/hsp/`, `apps/node/src/gateway/`, `packages/protocol`, `packages/sdk`, `apps/mcp/src/wallet.ts`, checkout page |
| B. Agent runtime | 5.1, 5.2, 5.3 runtime | new `apps/agent`, seller skill, directory registration |
| C. Merchant side | 6.2, 6.3 | new `apps/node/src/gateway/reports.ts`, new `apps/mcp/src/merchant-server.ts`, Payments page |

After the merge: wire the ops agent to the merchant MCP server, run the end-to-end task, update README and SUBMISSION.
