# DoraHacks BUIDL submission - Payminto Clearing

Paste-ready text for the HashKey Chain Horizon Hackathon, India / Mumbai edition.
Every `<PLACEHOLDER>` must be replaced with a real, verifiable value before submitting, or the line must be deleted.
Never submit a placeholder, and never round a measured number up.

Submission deadline: 2026-11-02 21:30 IST (extended from 2026-11-01; DoraHacks timeline shows 2026-11-02 16:00 UTC).
Target: submit a first version on 2026-11-01 and the final one by 2026-11-02 18:00 IST, so a failed upload or a WAF challenge does not cost us the slot.

---

## Name

Payminto Clearing

## Tagline (under 80 characters)

Clearing for AI agents: pay per call, settle net on HashKey Chain via HSP.

(74 characters.)

Alternates if the form is tighter:
- "Visa-style clearing for AI agents, on HashKey Chain." (52)
- "500 agent payments. A handful of transfers. Zero custody." (57)

## Short description (under 280 characters)

Payminto Clearing lets AI agents pay APIs, MCP tools and other agents per call with gas-free signed vouchers under an owner's on-chain mandate, then nets hundreds of calls into a few HSP payments on HashKey Chain.
Self-hosted, non-custodial, every call provable on chain.

(271 characters.)

---

## Full description

### The problem

AI agents are starting to buy things from each other: a quote, a risk score, a research brief, a tool call.
Those calls are worth fractions of a cent each.
A single stablecoin transfer costs about 34,000 gas, which at HashKey Chain's 500 gwei base fee is about 0.017 HSK (`<HSK_USD>` USD at submission time).
For a 0.002 USDC API call that fee is the same order as the price itself, so paying per call on chain does not work.
In our measured run, one netted batch cleared 640 calls for 1.91M gas, versus 22.04M gas for one transfer per call: 11.6x less gas, and the agent pays none of it (see docs/GAS.md).
Per-call settlement does not work for the agent economy, on any chain with a real fee floor.

The second problem is trust.
Nobody lets an autonomous agent hold an open wallet.
Owners need hard limits that live outside the agent's own process: a total budget, a per-call cap, a daily cap, a rate limit, a list of who it may pay, and an expiry.
A prompt-injected agent must not be able to pay a stranger.

The third problem is custody.
Today's answers are hosted platforms that hold the money, take a cut and own the data.
Providers want their keys, their revenue and their ledger on their own servers.

### The solution

Payminto Clearing is a self-hosted clearinghouse for agent-to-agent payments on HashKey Chain.
It works the way card schemes and interbank clearing work, but nobody in the middle holds funds.

1. An owner (a person, a company treasury, or a Safe) signs one Mandate that gives an agent a bounded budget: total cap, per-call cap, daily cap, rate limit, allowed payees, expiry.
2. The agent pays any API, MCP tool or other agent per call with a gas-free signed cumulative Voucher, over the standard x402 v2 HTTP 402 flow.
3. The provider's own Clearing Node checks every voucher against the mandate atomically, books it in a double-entry ledger, and returns a signed receipt.
4. On demand or on a timer, the node clears hundreds of vouchers in one `settleBatch` transaction on our ClearingHub contract.
5. The hub re-verifies every signature and every cap on chain, nets all obligations between all agents, and moves only the net amounts, directly wallet to wallet.
6. Every net transfer is an HSP payment whose `settlementBinding` is the batch id, and every individual call is provable against the batch Merkle root stored on chain.

### How it works

- **Mandate (EIP-712).** Domain `Payminto Clearing` v1 on chain 177.
  The owner may be an EOA or any ERC-1271 wallet, including a Safe.
  `openMandate` stores the policy hash and the Merkle root of allowed payees on chain.
- **Voucher (EIP-712, cumulative).** Each voucher says "the total I owe this payee under this mandate is now X".
  Only the latest one per (mandate, payee) matters, so vouchers cannot be double-spent or replayed: the hub pays `cumulative - settled[mandate][payee]`.
- **Policy engine.** 13 ordered denial rules, from `UNKNOWN_MANDATE` and `PAYEE_NOT_ALLOWED` to `PER_CALL_CAP`, `DAILY_CAP`, `TOTAL_CAP` and `INSUFFICIENT_FUNDS`.
  Every acceptance runs in one `BEGIN IMMEDIATE` transaction, so 50 parallel calls cannot overspend.
  Every denial is recorded with the rule that fired.
- **Netting.** The node projects net positions off chain, pre-checks each debtor's balance and allowance, and submits.
  The hub computes the same netting on chain and emits `NetTransfer(batchId, from, to, amount)`; the node compares the two and refuses to book a mismatch.
- **Receipts and proofs.** A Merkle tree over every call in the batch; the root goes on chain in `BatchSettled`.
  Anyone can call `verifyReceipt(batchId, leaf, proof)` for any single call.
- **HSP.** Each net transfer is wrapped as an HSP wire-v1 Mandate (`buildNetTransferMandate`) with `settlementBinding = batchId`.
  The debtor agent co-signs it, after checking the amount against its own receipts.
  After confirmation an HSP adapter checks the `NetTransfer` log, signs a Receipt, and the verifier returns `ACCEPT` when `proves:settlement-verified:v1`, `proves:payminto-mandate-bound:v1` and `proves:payminto-netting-batch:v1` are satisfied.
  The same `HspPort` interface drives either our built-in adapter or the official HSP Coordinator.
- **Ledger.** Double-entry, every journal balances, and the trial balance is shown live in the dashboard at zero.
- **MCP.** An MCP server gives any MCP-capable agent a budgeted wallet: `list_paid_services`, `call_paid_service`, `pay_link`, `get_budget`, `get_receipts`, `prove_receipt`.
  Every tool call is mandate-bound.
  `list_paid_services` reads the node's service directory, and `pay_link` pays a merchant payment link with vouchers only, never with an unbudgeted transfer.
- **Payment gateway.** The same node is a self-hosted, non-custodial gateway for merchants: one link that people pay in a hosted checkout and agents pay over x402.
  People pay with a wallet signature (EIP-3009 through a PaymentRouter) or by plain transfer to a per-payment deposit forwarder; plain x402 agents pay with `exact`; mandate agents pay with two vouchers, one to the merchant and one to the platform fee.
  The operator runs many merchants with their own fee plans and method fees, and every fee is split on chain in the same transaction that pays the merchant.
  Refunds are gasless (the payout signs, the node relays), webhooks are HMAC-signed with a timestamp, intake screening refuses denied or blacklisted payers, and every paid payment has a proof page that re-checks the chain.
  The SDK adds `GatewayClient`, `constructEvent` for webhooks and `payExact` for plain x402 agents.

### Why HashKey Chain and HSP

- HashKey's April 2026 whitepaper describes an economy of "Agent-to-Agent interactions" with stablecoins as its cash settlement layer.
  Payminto Clearing is the operator layer that makes that economy affordable and controllable.
- HSP gives every payment cryptographic evidence that anyone can re-check.
  We extend that evidence down to the individual call: an HSP payment proves the net transfer, our Merkle root proves each call inside it.
- HSP is zero-custody and wallet-settling; so are we.
  Net transfers move from the debtor's own wallet to the creditor's wallet, and no Payminto contract or node ever holds a balance.
- HashKey Chain has 2-second blocks, canonical USDC.e with EIP-3009, and EVM tooling, which make a ClearingHub practical.
  Its fee floor is exactly why batching and netting matter here.
- HSP is described by HashKey as AP2-based, and our Mandate is an AP2-style intent mandate with on-chain enforcement, so the two fit without translation.

### What is live on HashKey Chain mainnet

Fill in only what is actually deployed and verifiable on Blockscout at submission time.

| Item | Value |
|---|---|
| ClearingHub (chain 177) | `<HUB_ADDRESS_MAINNET>` |
| Verified source | `https://hsk.blockscout.com/address/<HUB_ADDRESS_MAINNET>?tab=contract` |
| Settlement token | USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a` (canonical, 6 dp) |
| Deploy tx | `<DEPLOY_TX_MAINNET>` |
| First mainnet mandate | `<MANDATE_OPEN_TX_MAINNET>` |
| First mainnet settleBatch | `<SETTLE_TX_MAINNET>`: `<N_CALLS>` calls, `<N_CLAIMS>` claims, `<N_TRANSFERS>` net transfers |
| Gas used by that batch | `<SETTLE_GAS_USED>` gas (`<SETTLE_FEE_HSK>` HSK) |
| Proof verified on chain | call `<CALL_ID>` in batch `<BATCH_ID_MAINNET>`, `verifyReceipt` returned `true` |
| HSP mode used for the mainnet batch | `<HSP_MODE_MAINNET>` (`coordinator` with the official Coordinator, or `local` with our wire-v1 adapter) |
| HSP payment ids | `<HSP_PAYMENT_IDS>` with status `<HSP_STATUSES>` |

Honest scope note to keep in the submission:
mainnet volume is demo volume generated by our own agents and providers.
We have no external users yet.

### Tech stack

- Contracts: Solidity, Foundry 1.5; `ClearingHub.sol` with EIP-712, ERC-1271 owner support, Merkle receipts, on-chain netting, at most 64 claims per batch.
- Shared protocol package: TypeScript, viem; EIP-712 types, Merkle trees, policy hashing, HSP wire v1, x402 v2 headers, bigint money.
- Clearing Node: Node 22+, TypeScript, SQLite (`node:sqlite`, WAL), zod at every trust boundary, SSE event stream, settlement worker, HSP adapter.
- SDK `@payminto/sdk`: `OwnerClient`, `AgentClient` (402 handling, voucher signing including two-payee splits, retries, co-sign loop), `paywall` middleware for Hono and any fetch handler, `GatewayClient`, `constructEvent` and `payExact`.
- MCP server: MCP SDK 1.x, stdio and Streamable HTTP.
- Dashboard: Next.js 16, React 19, Tailwind 4, shadcn/ui, Recharts, TanStack Query, live SSE.
- Network: HashKey Chain mainnet (177), testnet (133) and local anvil (31337) from one config.

### What is novel (vs x402, AP2, Skyfire, Nevermined, Circle Nanopayments)

| | What it does well | What it does not do | What Payminto Clearing adds |
|---|---|---|---|
| x402 | Standard HTTP 402 ask-and-pay | Settles each payment individually; no budget or mandate; no netting | We speak x402 v2 on the wire, then replace per-call settlement with cumulative vouchers and on-chain enforced mandates |
| AP2 | Proves a human's consent with signed mandates | Authorization only; no runtime enforcement, metering or settlement | Our Mandate is enforced twice: atomically by the node per call, and again by the hub on chain at settlement |
| Skyfire | Agent identity plus USDC payments | Hosted, platform-mediated wallets | Self-hosted, non-custodial; the provider runs the node next to its own API |
| Nevermined | Metering, credits, pricing plans | Hosted SaaS, payouts through a platform | Metering and settlement in the provider's own ledger, no revenue share |
| Circle Nanopayments | Off-chain authorization, batched settlement | Circle-operated, USDC-only, not on HashKey Chain in any source we found | Same economics, operator-neutral, on HashKey Chain, with multilateral netting across many agents |

The specific new thing: **multilateral netting of agent micropayments, verified on chain, with a per-call Merkle proof inside an HSP payment.**
We did not find another agent payment product that nets obligations across many independent agents and providers.

### India relevance

- Indians already understand mandates: UPI AutoPay and the 2025 UPI Reserve Pay agentic pilot put preset limits on what an AI can spend.
  Payminto Clearing is the same mental model for agents, but programmable and cross-border.
- We do not pitch crypto against UPI.
  UPI wins domestic retail.
  The gap is cross-border: Indian API, data and AI-agent startups selling to agents abroad, and Indian agents buying foreign APIs, GPU time and data, have no clean per-call rail.
- Every call, every batch and every net transfer is in a double-entry ledger with an on-chain anchor, which is the raw material for India's reporting rules on virtual digital assets (1% TDS under Section 194S, and gains reporting).
  We export it; we do not give tax advice.
- Self-hosting keeps usage data and mandates in the operator's own database, which suits Indian enterprises that care about data residency.

### Business model

- **Free and open source core (MIT):** the node, SDK, MCP server and contracts.
- **Zero per-call take rate.** We never sit in the money path, so we never charge a percentage of it.
- **Enterprise licence:** SSO, role-based approvals on mandates, audit and tax exports, priority support, SLAs.
- **Managed Clearing Node:** we run and monitor the node for providers who do not want to, priced per node per month.
- **Hosted clearing network (later):** a neutral multi-operator clearing window that nets across many providers' nodes, priced per settled batch, not per call.
- **Paid connectors:** compliance attestations (KYC, sanctions) via HSP issuers, fiat off-ramp partners in the ONERWAY pattern, accounting exports.

### Roadmap

- **Now (hackathon):** ClearingHub on HashKey Chain mainnet, Clearing Node, SDK, MCP server, dashboard, three demo providers and two demo agents, HSP wire v1 with local adapter and Coordinator mode, and the payment gateway (multi-merchant, one link for people and agents, on-chain fee splits).
- **Next 30 days:** swap in the official `@hsp/sdk` once published; require `attests:sanctions` capability for compliant mandates; Safe-owned mandates in the dashboard wizard; 10 Indian design partners.
- **Next 90 days:** refunds as negative vouchers; conditional (escrowed) vouchers released on task acceptance; peered nodes netting across operators; settlement receipts posted as ERC-8004 reputation signals; independent audit of ClearingHub.
- **Later:** USDT via Permit2, more HashKey-native assets, fiat off-ramp partner integration, HashKey Chain KYC SBT checks on mandate owners.

### Team

List only people who actually contributed, and add each of them on DoraHacks.

| Person | Role | Owns |
|---|---|---|
| Sagar Jethi `<HANDLE>` | Founder, engineering and pitch | Product, contracts, node, SDK, dashboard, Demo Day pitch |
| `<ADD REAL TEAMMATES OR DELETE THIS ROW>` | | |

Built with AI-assisted engineering: the founder directed the work and reviewed and tested every component.

Payminto (https://payminto.io) is our self-hosted payment gateway for merchants.
Payminto Clearing was built from scratch during the hackathon period: new contracts, new node, new SDK, all open source under MIT.

---

## Track selection

**Agent Payments & A2A Settlement** (HSP required).

Do not also enter AI Agent Trading unless the form explicitly allows multi-track entries; one sharp entry beats two diluted ones.

---

## Links

| Link | Value |
|---|---|
| GitHub repository | `<GITHUB_URL>` |
| Demo video (2 min, unlisted YouTube or Loom) | `<DEMO_VIDEO_URL>` |
| Live dashboard (read-only operator view) | `<LIVE_DASHBOARD_URL>` |
| ClearingHub on Blockscout | `https://hsk.blockscout.com/address/<HUB_ADDRESS_MAINNET>` |
| Example settleBatch tx | `https://hsk.blockscout.com/tx/<SETTLE_TX_MAINNET>` |
| Pitch deck (PDF) | `<DECK_URL>` |
| Parent product | https://payminto.io |

The live dashboard must never expose the `ADMIN_TOKEN`; deploy a read-only view or a recorded session instead.

---

## Submission requirement checklist

Source: the requirements on the DoraHacks hackathon page and the Luma Demo Day page; re-read both on submission day.
The DoraHacks page itself sits behind a WAF challenge from our tooling, so one human must re-read it in a browser on submission day and add anything missing here.

| # | Requirement | How we satisfy it | Status |
|---|---|---|---|
| 1 | Project is original and built or rebuilt during the hackathon period | New repo, first commit `<FIRST_COMMIT_DATE>`; parent brand only, no reused code | `<CHECK>` |
| 2 | Payments track must use HSP | Every net transfer is an HSP wire-v1 payment, `settlementBinding = batchId`, co-signed by the debtor, verified to `ACCEPT`; Coordinator mode if the organizer issues credentials | `<CHECK>` |
| 3 | Smart contracts deployed on HashKey Chain mainnet, or the team forfeits demo selection | `ClearingHub` at `<HUB_ADDRESS_MAINNET>`, source verified on hsk.blockscout.com | `<CHECK>` |
| 4 | Strong completeness, technical maturity and innovation | End-to-end flow on mainnet, Foundry tests, one E2E test on anvil, policy unit tests for all 13 rules, balanced ledger; novelty is on-chain multilateral netting plus per-call proofs | `<CHECK>` |
| 5 | Officially recommended products and frameworks earn extra points | HSP wire v1 (and `@hsp/sdk` if released in time), canonical HashKey Chain USDC.e token contract, Safe as mandate owner via ERC-1271, Blockscout verification; list them on one slide | `<CHECK>` |
| 6 | In-person Mumbai demo teams get priority for pitch selection | Sagar presents in person at ATLAS SkillTech University on Nov 4; state "attending in person" in the BUIDL text | `<CHECK>` |
| 7 | Demo Day: live pitch plus Q&A, 3 judges in room, 2 HashKey judges remote | `pnpm demo:stage` walks the live demo step by step; screen-share works for remote judges | `<CHECK>` |
| 8 | BUIDL form: name, logo, tagline, description | This file; logo `<LOGO_PATH>` (square PNG, at least 512 px) | `<CHECK>` |
| 9 | BUIDL form: public GitHub repo | `<GITHUB_URL>`, README with quickstart (`pnpm demo`), license MIT | `<CHECK>` |
| 10 | BUIDL form: demo video | `<DEMO_VIDEO_URL>`, 2 minutes, recorded from `pnpm demo:stage` | `<CHECK>` |
| 11 | BUIDL form: team members added on DoraHacks | Every real contributor invited and accepted | `<CHECK>` |
| 12 | Track selected | Agent Payments & A2A Settlement | `<CHECK>` |
| 13 | Submitted before 2026-11-01 21:30 IST | Target 12:00 IST same day | `<CHECK>` |

Hard rule: if item 3 is not true by Oct 31, everything else stops until it is.
