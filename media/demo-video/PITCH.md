# Payminto: investor one-pager

**Get paid in stablecoins by people and AI agents, on your own server.**

## The problem

AI agents are starting to buy from each other: a quote, a risk score, a research brief, a tool call.
Each call is worth a fraction of a cent, and one stablecoin transfer costs about 34,444 gas, which can rival the price of the call [1].
No business hands an agent an open wallet, so agent spend needs hard budgets that live outside the agent.
Today's answers are hosted platforms that hold the money or the wallets and own the data [2].

## The product

Payminto is a self-hosted, non-custodial stablecoin payment gateway for businesses and AI agents.
One payment link works for a person in a hosted checkout and for an agent over HTTP 402.
Money goes straight from the payer to the merchant's wallet, with fees split on chain in the same transaction; Payminto never holds funds.
Agents spend through a mandate: total cap, per-call cap, daily cap, allowed payees and expiry, enforced by the agent wallet, the server and the contract.
Hundreds of small charges are netted into a few wallet-to-wallet transfers; in our measured run one batch cleared 640 calls for 11.6x less gas than one transfer per call [1].
Every single call stays provable on chain through a receipt proof.
Merchants run their own AI agents on their own model key (Anthropic, OpenAI, Google Gemini, OpenAI-compatible providers such as OpenRouter, or Replicate; the demo runs DeepSeek V3.1 through Replicate): an ops agent for the back office and paid skill agents that sell per call.
In the live runs a buyer agent bought a live HSK quote from a market data service, then paid a seller agent's market-brief skill with it, and all three parties were netted and settled on chain with a receipt proof.
Finance gets one reconciliation report that ties every payment, fee, refund and on-chain proof together.

## Why now

The agent payment stack has split into layers: x402 asks for payment, AP2 proves consent, ERC-8004 proves identity, HSP settles on HashKey Chain [3].
Nobody owns the operator layer in the middle that budgets, meters, nets, refunds and proves agent spend, and nobody offers it self-hosted [2].
Stablecoins are already a large settlement asset, at about $316 billion in circulation on 12 June 2026 [4].
McKinsey is reported to project $3-5 trillion of global agentic commerce by 2030 [5].
Real agent payment volume is still small today [6], so the infrastructure has to be in place before volume arrives.

## Business model

- Open-source core under MIT: node, SDK, MCP server, contracts.
- Zero take rate on payments, because we are never in the money path.
- Paid enterprise licence: SSO, approval roles, audit and tax exports, support and SLAs.
- Managed node: we run and monitor the server, priced per node per month.
- Later: a hosted clearing network that nets across many operators, priced per settled batch, not per call.

Source: `docs/SUBMISSION.md`, Business model.
Price points are not set yet; they will be set with design partners.

## Wedge

Sellers first: API, data and AI-skill businesses that want agents and people to pay them per call, starting with Indian SaaS sellers who already earn most of their revenue abroad (75% of FY2020 India SaaS revenue came from global sales, per Nasscom [7]).
Bain projected Indian SaaS at $35 billion ARR by 2027 [9].
Indian buyers already know capped mandates for AI: NPCI, Razorpay and OpenAI announced an agentic payments pilot on UPI in October 2025 [10].
We do not compete with UPI at home; the gap is cross-border, per-call settlement.
Second: agent builders who need budgets and receipts before their customers trust an agent with money [8].

## Moat

- Self-hosted and non-custodial: the merchant keeps keys, revenue and ledger; nothing to freeze, no revenue share.
- Multilateral netting verified on chain with a per-call proof; we did not find another agent payment product that nets across independent agents and providers [2].
- Policy enforced in three places (agent wallet, server, contract) with every refusal recorded by rule.
- Operator-neutral: speaks x402 on the wire and fits HSP's AP2-based model without translation.

## Traction and plan

Honest status: a working product on testnets (Circle testnet USDC on Ethereum Sepolia, Payminto contracts and a Payminto Test USDC on HashKey Chain Testnet), no mainnet deploy, no external users yet.
Testnet tokens have no value.
Next 30 days: official HSP SDK once published, Safe-owned budgets, 10 Indian design partners.
Next 90 days: refunds as negative vouchers, escrow released on delivery, peered nodes, independent audit of the contracts, then mainnet.

## The ask

`<ASK>`: to be decided by the founder.
Suggested shape, to confirm: HSP allowlist and mainnet support from HashKey, introductions to Indian SaaS and agent-builder design partners, and `<AMOUNT>` to fund the audit and the first year of design-partner pilots.

## Sources

[1] `docs/GAS.md`: measured on a local anvil on 2026-10-28; 34,444 gas per ERC-20 transfer to an existing recipient; 640 calls in one batch for 1,907,140 gas versus 22,044,160 gas, about 11.6x less.
[2] `research/03-market-competitors.md` sections 2.7, 3.5 and 4.4, and `docs/PRODUCT_PLAN.md` section 2 (hosted players hold funds or wallets; no product found offering multilateral netting across independent operators).
[3] `research/03-market-competitors.md` sections 2.2, 2.3, 2.4 and 2.10; HSP described as an AP2 extension (TechFlow https://techflowpost.com/en-US/article/31203).
[4] Transak, citing DefiLlama: https://transak.com/blog/stablecoin-market-cap-2026 (about $316 billion as of 12 June 2026; verified 2026-11-03).
[5] `research/03-market-competitors.md` section 4.2, via Stellagent: https://stellagent.ai/insights/agentic-commerce-market-size-forecast-2030 (McKinsey as reported; other forecasts in the same source: Morgan Stanley $190-385B of US e-commerce, Bain $300-500B).
[6] `research/03-market-competitors.md` section 4.2, via Glenbrook: https://glenbrook.com/payments_news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/ (200M+ x402 transactions, more than 95% protocol signalling per Artemis).
[7] The News Minute, reporting Nasscom: https://www.thenewsminute.com/atom/indias-saas-industry-achieved-35-billion-revenue-fy2020-nasscom-129351 ($3.5 billion FY2020, 75% from global sales; verified 2026-11-03).
[8] `research/03-market-competitors.md` section 4.1, via Nevermined: https://nevermined.ai/solutions/accept-agent-payments/ (Valory/Olas reportedly cut billing build time from 6 weeks to 6 hours).
[9] Techloy, reporting Bain's India SaaS Report 2022: https://www.techloy.com/indian-software-service-companies-to-generate-35-billion-by-2027/ ($35 billion ARR by 2027, 8% of the global SaaS market; verified 2026-11-03).
[10] Onmanorama: https://www.onmanorama.com/news/business/2025/10/09/npci-razorpay-openai-chatgpt-payments.html (NPCI, Razorpay and OpenAI agentic payments pilot on UPI Reserve Pay, 9 October 2025).
