# 03 - Agent payments market, competitors and product direction

Research date: 2026-10-24.
Scope: HashKey Chain Horizon Hackathon (India), "Agent Payments & A2A Settlement" track, plus one idea for the "AI Agent Trading" track.
Method: web search and page fetches; every claim below links to a source.
Many sources in this space are vendor blogs or aggregators, so treat numbers as directional and re-check primary docs before quoting them to judges.

## 0. TL;DR

The agent payments stack has split into layers, and nobody owns the middle.
x402 owns "how an HTTP or MCP call asks for money", AP2 owns "how a human's consent is proven", ERC-8004 owns "who is this agent and can I trust it", and card networks own "agent-initiated card checkout".
The gap is the operator layer in between: something a provider or enterprise runs itself that enforces mandates, meters usage, nets thousands of tiny obligations into a few settlements, holds funds for conditional delivery, and produces an audit trail.
HSP (HashKey Settlement Protocol / Platform) is positioned as an AP2 extension with A2A payments, sub-cent settlement and on-chain AML, but its public developer surface is still thin, which is an opening for a reference operator implementation.
Top recommendation: **Payminto Agent Clearinghouse** - a self-hosted node that combines mandate-bound agent budgets, an x402-compatible paywall for APIs and MCP tools, off-chain signed vouchers, and batched netting into HSP settlement on HashKey Chain, with every call recorded in Payminto's double-entry ledger.

## 1. Where Payminto starts from

The live site positions Payminto as an open-source (MIT), self-hostable gateway where card and stablecoin payments are peer rails on one double-entry ledger ([payminto.io](https://payminto.io)).
Notable primitives already described on the site: balances derived from ledger lines rather than stored, per-payment deposit accounts with crash-safe sweeps, versioned fee rules, a payment switch with intents, attempts, idempotency keys and exclusive claims, payment links and hosted checkout, two-RPC agreement before crediting a deposit, strict live/test isolation, and optional Chainlink CRE solvency attestation ([payminto.io](https://payminto.io)).
The site mentions an "API and MCP server" in the self-hosted core, but does not mention agents or x402 anywhere ([payminto.io](https://payminto.io)).
Stablecoins are currently on Solana, so HashKey Chain (EVM, OP Stack) is a new connector.
Those primitives (idempotent intents, exclusive claims, derived balances, dual-RPC evidence) are exactly what an agent clearing layer needs and what most agent-payment demos lack.

## 2. Landscape of agent payment protocols and products

### 2.1 Summary table

| Name | What it does | Settlement model | Custody | Main gaps |
|------|--------------|------------------|---------|-----------|
| Coinbase x402 | HTTP 402 pay-per-request for APIs and MCP tools | On-chain stablecoin per request via a facilitator; `exact`, `upto`, `auth-capture`, `batch-settlement` schemes | Non-custodial for payer, facilitator relays | Per-call settlement cost, no mandates, discovery tied to CDP facilitator, weak refund story |
| Google AP2 | Proves user consent via signed Intent, Cart and Payment mandates | Rail-agnostic; cards first, stablecoins via A2A x402 extension | Depends on rail | Authorization layer only, no metering, no netting, no escrow |
| HashKey HSP | AP2 extension for A2A payments with sub-cent stablecoin settlement and on-chain AML | Stablecoin settlement, Master Account pooling, Settlement Protocol for authorization verification | Licensed HashKey entities for custody and OTC | Public developer docs thin; no reference operator tooling found |
| Stripe/OpenAI ACP | Agent checkout in ChatGPT via Shared Payment Token | Card rails via Stripe or other PSP | Stripe holds credentials | Human shopping only, not machine-to-machine micropayments |
| Visa Intelligent Commerce / TAP | Agent identity for merchants, tokenized agent cards | Card rails | Issuer/network | Cards cannot do sub-cent calls; merchant-centric |
| Mastercard Agent Pay | Agentic Tokens bound to agent and policy, Verifiable Intent | Card rails | Issuer/network | Same as Visa |
| Skyfire (KYAPay) | Agent identity (KYA) plus USDC payments, MCP monetization | USDC, platform-mediated | Platform wallets | Hosted, centralized operator |
| Nevermined | Metering, credits, pricing plans, A2A and MCP support | Credits, payouts via Stripe or crypto | Platform-mediated | Hosted SaaS; vendor lock-in |
| Payman | Separated agent wallets, agents paying humans, bank focus | Bank rails and wallets | Platform | Not crypto-native micropayments |
| Catena Labs (ACK) | Open ACK-ID (DIDs, VCs) and ACK-Pay with verifiable receipts | USDC on Base and other rails | Self-hosted possible; regulated institution planned | Hosted preview closed; protocol kit, not an operator product |
| Crossmint | Non-custodial agent wallets, x402, agentic virtual cards | Stablecoin and card | Non-custodial wallets | Wallet layer, not a clearing or metering layer |
| Circle Gateway / Nanopayments | Gas-free USDC transfers down to $0.000001 | Off-chain authorization, batched on-chain settlement | Circle Gateway balances | Circle-operated; USDC-only; not on HashKey Chain per sources found |
| Lightning L402 | Macaroon plus Lightning invoice pay-per-request | Lightning channels | Self-custodial node | BTC-only, liquidity management, alpha tooling |
| ERC-8004 | On-chain Identity, Reputation and Validation registries for agents | None (payments out of scope) | n/a | No payment rail; needs payment proofs from elsewhere |
| Google A2A + a2a-x402 | Agent-to-agent task protocol with x402 payment states in task metadata | Per-task x402 settlement | Payer wallet | Per-task only; no netting or escrow |
| MCP payment patterns | `paidTool` wrappers returning PaymentRequired in tool results | x402 per tool call | Payer wallet | Per-call cost, client approval UX undefined |

### 2.2 Coinbase x402

x402 revives HTTP 402 so a server can demand payment and a client can retry with a signed payment payload, settled through a facilitator.
The spec repo now defines four schemes: `exact`, `upto`, `auth-capture` and `batch-settlement` ([x402 schemes](https://github.com/coinbase/x402/tree/main/specs/schemes)).
`upto` lets a client sign an authorization for a maximum amount, and the server settles the actual usage after the handler runs, which fits per-token LLM pricing or metered bandwidth ([upto spec](https://raw.githubusercontent.com/coinbase/x402/main/specs/schemes/upto/scheme_upto.md)).
`upto` is single-use, time-bounded and recipient-bound, and it explicitly leaves multiple settlements per authorization (streaming) and open-ended allowances out of scope ([upto spec](https://raw.githubusercontent.com/coinbase/x402/main/specs/schemes/upto/scheme_upto.md)).
Cloudflare proposed a deferred scheme for delayed and batched settlement when the x402 Foundation launched in September 2025 ([The Block](https://www.theblock.co/post/372064/cloudflare-coinbase-launch-x402-foundation)).
The foundation moved under the Linux Foundation in April 2026 with members including Coinbase, Cloudflare, Circle, Google, Microsoft, Stripe, Visa, Mastercard, Shopify, AWS and Polygon Labs ([policylayer glossary](https://policylayer.com/glossary/x402-foundation), [Forkast](https://forkast.news/the-giants-are-building-on-x402-the-transaction-count-is-the-least-interesting-part/)).
Bazaar is the discovery layer: it indexes payable endpoints with descriptions and payment metadata, discovery APIs are public, but a resource is only indexed after settling through the CDP facilitator ([CDP Bazaar docs](https://docs.cdp.coinbase.com/x402/bazaar.md), [x402 Bazaar extension](https://docs.x402.org/extensions/bazaar)).
The spec says any facilitator can implement its own discovery layer ([x402 Bazaar extension](https://docs.x402.org/extensions/bazaar)).
Volume reality check: trackers report 200M+ transactions by June 2026, but Artemis found more than 95% was protocol signaling rather than buyer-seller exchange ([Glenbrook](https://glenbrook.com/payments_news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/)).
Gaps: per-request on-chain settlement does not scale to sub-cent calls, there is no budget or mandate concept, refunds are out of band, and discovery is centralized on one facilitator.

### 2.3 Google AP2

AP2 uses three verifiable-credential mandates: an Intent Mandate with the user's constraints for delegated tasks, a Cart Mandate signed by merchant then user to lock the order, and a Payment Mandate that signals agent involvement to the network or bank ([Vellum](https://www.vellum.ai/blog/googles-ap2-a-new-protocol-for-ai-agent-payments), [Google Developer forum](https://discuss.google.dev/t/new-agent-payments-protocol-ap2-an-open-and-secure-standard-for-agentic-payments/265614)).
AP2 is an extension of A2A and works alongside MCP; it launched with cards, with stablecoins handled through the A2A x402 extension ([AP2 llms-full](https://ap2-protocol.org/llms-full.txt), [Coinbase x402 + AP2](https://www.coinbase.com/es-es/developer-platform/discover/launches/google_x402)).
Mastercard reportedly accepts AP2 mandates as Verifiable Intent as of April 2026 ([eco.com comparison](https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared)).
Gaps: AP2 proves consent but does not meter, net, escrow or reconcile; somebody still has to enforce the mandate at runtime and book the result.

### 2.4 HashKey HSP

HashKey describes HSP as an extension of Google's AP2 that supports A2A payments, ultra-micro payments below $0.01, near-instant cross-border clearing, licensed verification nodes and on-chain AML, with privacy plus regulatory auditability ([TechFlow](https://techflowpost.com/en-US/article/31203), [Phemex](https://phemex.com/news/article/hashkey-unveils-hsp-protocol-to-power-ai-agent-economy-74466)).
Named use cases are per-unit solar electricity billing (eCandle) and robots paying for data APIs (Lingchu) ([TechFlow](https://techflowpost.com/en-US/article/31203)).
The September 2026 ONERWAY partnership describes two modules: a Master Account for on-chain asset pooling and a Settlement Protocol for on-chain transaction authorization verification, with HashKey licensed entities providing custody and OTC ([PR Newswire](https://www.prnewswire.com/news-releases/hashkey-settlement-platform-hsp-and-onerway-announce-strategic-partnership-to-shape-the-future-of-on-chain-payments-and-support-cross-border-commerce-development-302868883.html)).
The same release says HSP itself does not engage in regulated activities and participants own their compliance ([PR Newswire](https://www.prnewswire.com/news-releases/hashkey-settlement-platform-hsp-and-onerway-announce-strategic-partnership-to-shape-the-future-of-on-chain-payments-and-support-cross-border-commerce-development-302868883.html)).
Past hackathon projects describe the HSP flow as payer-signed EIP-712 Mandate, adapter settlement that emits a signed Receipt, and a verifier that checks KYC and sanctions capabilities ([hashera README](https://github.com/TheSupermanish/hashera), [IntentGuard](https://github.com/Ayotwix01/IntentGuard)).
Those projects reference `github.com/project-hsp/hsp` and `hashfans.io` as official pointers, but the GitHub URL returned 404 at research time, so confirm the current spec with organizers.
HashKey Chain is an OP Stack L2 with chain ID 177, 2-second blocks and HSK as gas ([Cointelegraph](https://cointelegraph.com/news/hashkey-group-ethereum-layer-2-hashkey-chain-mainnet)); testnet is chain ID 133 with RPC `https://testnet.hsk.xyz` and mainnet USDC.e at `0x054ed45810DbBAb8B27668922D110669c9D88D0a` per a past project README ([hashera](https://github.com/TheSupermanish/hashera)).
Prior HashKey Horizon editions ran AI (HSP) and DeFi tracks, for example Japan with a 12,000 USDT pool ([TechFlow newsletter](https://techflowpost.com/en-US/newsletter/126305), [Luma Japan Demo Day](https://luma.com/bljpi0vd?locale=ja)).
Implication: judges will reward a project that makes HSP concrete and reusable, not one that wraps a single transfer.

### 2.5 Stripe and OpenAI Agentic Commerce Protocol (ACP)

ACP connects ChatGPT Instant Checkout to merchant backends, and Stripe issues a Shared Payment Token scoped to one merchant and cart total so the agent never sees card details ([Stripe newsroom](https://stripe.com/newsroom/news/stripe-openai-instant-checkout)).
Merchants keep acceptance, tax, fulfillment and returns, and can process through Stripe or another PSP ([Stripe newsroom](https://stripe.com/newsroom/news/stripe-openai-instant-checkout)).
Gaps: built for human shopping baskets on card rails, not machine-to-machine sub-cent calls or agent-to-agent settlement.

### 2.6 Visa Intelligent Commerce and Mastercard Agent Pay

Mastercard Agent Pay issues Agentic Tokens (MDES extension) bound to an agent and a commerce policy, uses passkeys and Verifiable Intent, and reported a first live agentic transaction in Hong Kong in March 2026 with HSBC and DBS ([eco.com](https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared), [Stellagent](https://stellagent.ai/insights/mastercard-agent-pay-ai-agents)).
Visa's Trusted Agent Protocol defines how agents identify themselves to merchants and how merchants verify them ([RisingWave comparison](https://risingwave.com/blog/mastercard-agent-pay-vs-visa-vs-stripe-agentic-commerce/)).
Gaps: card economics (fixed fees, chargebacks) make sub-cent per-call pricing impossible, and both are merchant-checkout oriented.

### 2.7 Skyfire, Nevermined, Payman, Catena Labs, Crossmint

Skyfire pairs a Know Your Agent framework with USDC payments through KYAPay and pitches it as a monetization layer for MCP servers ([BusinessWire](https://www.businesswire.com/news/home/20250626772489/en), [Stellagent](https://stellagent.ai/insights/skyfire-kyapay-know-your-agent)).
Nevermined positions itself as metering and settlement for agents, billing per API call, MCP tool execution or A2A interaction with credits, time, dynamic and outcome-based plans, with payouts via Stripe ([Nevermined](https://nevermined.ai/solutions/accept-agent-payments/), [Nevermined pricing models](https://nevermined.ai/blog/ai-agent-credit-based-pricing)).
Payman gives each agent a separate wallet so a malfunctioning agent's blast radius is limited, and focuses on community banks ([dupple review](https://dupple.com/reviews/payman), [VentureBeat](https://venturebeat.com/business/payman-ai-selected-for-icba-thinktech-accelerator)).
Catena Labs ships the open Agent Commerce Kit: ACK-ID (DIDs and VCs) and ACK-Pay with PaymentReceiptCredential receipts; the hosted ACK-Lab preview closed but the protocols remain self-hostable ([Catena blog](https://catena.com/blog/acklab-developer-preview), [Stablecoin Insider](https://stablecoininsider.org/how-to-settle-usdc-agent-payments-with-catena-ack-pay/), [FinTech Futures](https://www.fintechfutures.com/fintech-start-ups/catena-labs-emerges-from-stealth-with-18m-seed-funding)).
Crossmint offers non-custodial agent wallets with x402 support plus agentic virtual cards via Visa Intelligent Commerce and Mastercard Agent Pay, with spend limits and approval thresholds ([Crossmint docs](https://docs.crossmint.com/solutions/ai-agents/agent-wallets/overview), [Crossmint cards launch](https://www.crossmint.com/announcement/agentic-cards-api-launch-visa-basistheory)).
Common gap: all are hosted platforms or toolkits; none is a self-hosted operator node that a provider runs next to its own API and books into its own ledger.

### 2.8 Circle Gateway and Nanopayments

Circle Nanopayments, powered by Gateway, went live on mainnet on 29 April 2026 across 11 chains, with gas-free USDC transfers as small as $0.000001 ([Circle](https://circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet), [Circle testnet post](https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity)).
The model is off-chain authorization with batched on-chain settlement ([Crowdfund Insider](https://www.crowdfundinsider.com/?p=278131)).
This validates the architecture we recommend (vouchers plus batch settlement) while showing the gap: it is Circle-operated, USDC-only, and not on HashKey Chain in any source found.

### 2.9 Lightning L402

Lightning Labs released lightning-agent-tools in February 2026: `lnget` pays L402 invoices automatically, Aperture is the server-side reverse proxy, and scoped macaroons plus `--max-cost` limit spend ([Bitcoin Magazine](https://bitcoinmagazine.com/news/lightning-labs-rolls-out-ai-agent-tools), [Lightning docs](https://docs.lightning.engineering/agents/resources-for-agents)).
L402 is the closest prior art to a self-hosted paywall with spend caps, but it is BTC-only, needs channel liquidity, and `lnget` is early alpha.

### 2.10 ERC-8004 (Trustless Agents)

ERC-8004 defines Identity (ERC-721 agent tokens pointing at a registration file), Reputation (on-chain feedback) and Validation (attestations such as audits, code hashes, TEE proofs) registries ([BuildBear](https://buildbear.io/blog/erc-8004), [Polygon docs](https://agentic-docs.polygon.technology/general/agentic/erc8004)).
Payments are explicitly out of scope, but payment proofs such as x402 receipts can be referenced in reputation feedback ([BuildBear](https://buildbear.io/blog/erc-8004)).
This is a natural sink for Payminto settlement receipts: "paid and delivered" events become reputation signals.

### 2.11 Google A2A and how payments plug in

The `a2a-x402` extension adds payment states to A2A task metadata (`x402.payment.status` moving through payment-required, submitted, verified, completed, rejected, failed) and a pluggable wallet interface ([a2a-x402](https://github.com/google-agentic-commerce/a2a-x402)).
AP2 adopted x402 as one of its first extensions, with Coinbase as the stablecoin facilitator ([Coinbase](https://www.coinbase.com/es-es/developer-platform/discover/launches/google_x402)).
Gap: every task settles individually, and there is no notion of escrow tied to task completion even though A2A already models task state.

### 2.12 MCP payment patterns

Cloudflare's Agents SDK exposes `paidTool` as a drop-in for `tool`, wrapped by `withX402`, with clients using `withX402Client` ([Cloudflare docs](https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/)).
The x402 MCP pattern returns an `isError: true` tool result with the PaymentRequired object in both `structuredContent` and `content[0].text` ([Eco guide](https://eco.com/support/en/articles/14846276-build-an-mcp-server-with-x402-monetization), [Stablecoin Insider](https://stablecoininsider.org/how-to-charge-for-mcp-tools-with-cloudflare-agents-x402.md)).
Community wrappers such as `@xmcp-dev/x402` add per-tool prices ([xmcp docs](https://xmcp.dev/docs/guides/monetization.md)).
Gap: whether the client may sign without human approval is left to the product, which is precisely where a mandate engine belongs.

## 3. Unsolved problems that matter to real users

### 3.1 Spend limits, mandates and budget control

Owners need "this agent may spend at most X per day, Y per call, only with these counterparties, until this date", enforced outside the agent's own process.
AP2 Intent Mandates express this, x402 `upto` caps a single call, macaroons cap Lightning spend, and Crossmint and Payman cap wallets, but nobody enforces one portable mandate across x402, MCP and A2A calls with a shared running balance.
Enforcement must be atomic against concurrent calls, which is a ledger problem (exclusive claims, idempotency) more than a crypto problem.

### 3.2 Micropayment economics

An API call priced at $0.001 cannot carry its own on-chain settlement on most chains, and even when gas is fractions of a cent, OP Stack L2s add an L1 data fee per transaction.
HashKey Chain gas has been observed near 0.001 gwei with lab tests around 400 TPS ([Cointelegraph](https://cointelegraph.com/news/hashkey-group-ethereum-layer-2-hashkey-chain-mainnet)), which helps but does not make one-tx-per-call sensible at agent volumes.
The scalable pattern is signed off-chain vouchers with cumulative amounts and periodic on-chain settlement, which Circle Nanopayments, the x402 `batch-settlement` and deferred schemes, and payment channels all converge on.
Settling N calls in one transfer divides per-call settlement cost by N, and netting between many agents reduces the number of transfers further.

### 3.3 Escrow and conditional settlement

Agent work (research reports, code, data labeling, translations) needs "pay on verified delivery", not pay-before-call.
A2A has task state but no escrow; ERC-8004 has Validation but no funds; x402 `auth-capture` hints at authorize-then-capture but is still a single payment primitive.
The missing piece is an escrow tied to a task ID, released by a buyer acceptance, a validator attestation, or a timeout, with partial release and refund paths.

### 3.4 Streaming and metered billing

`upto` explicitly excludes multiple settlements per authorization ([upto spec](https://raw.githubusercontent.com/coinbase/x402/main/specs/schemes/upto/scheme_upto.md)), so long-running streams (token streams, robot telemetry, the eCandle per-kWh case) need cumulative vouchers or channels.
Providers also need usage records that reconcile to money, which hosted metering vendors like Nevermined sell as SaaS.

### 3.5 Netting and batch settlement between many agents

In an agent mesh, A pays B, B pays C, C pays A thousands of times a day.
Multilateral netting collapses those obligations to one net transfer per participant per window, exactly like card scheme or interbank clearing.
No agent payment product found offers multilateral netting; Circle batches transfers but does not net obligations across independent operators.

### 3.6 Refunds and disputes

Push payments on chain have no chargeback, so refunds must be designed in: hold periods, escrow, signed refund vouchers that offset the next batch, and an evidence bundle (request hash, response hash, mandate, receipt).
Card-based agent rails inherit chargebacks, which is one reason card networks are investing in Verifiable Intent ([eco.com](https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared)).

### 3.7 Identity and reputation

Providers need to know who is behind an agent (KYA, ACK-ID, Visa TAP, Web Bot Auth) and whether it pays reliably, and buyers need to know whether a provider delivers.
ERC-8004 provides registries but needs real economic events to be meaningful; settlement receipts are the cheapest high-signal input.

### 3.8 Compliance and audit trails

HSP puts compliance on participants and offers on-chain AML hooks ([PR Newswire](https://www.prnewswire.com/news-releases/hashkey-settlement-platform-hsp-and-onerway-announce-strategic-partnership-to-shape-the-future-of-on-chain-payments-and-support-cross-border-commerce-development-302868883.html)).
Enterprises need to answer "which human authorized which agent to pay whom, for what, under which rule version", which maps directly to Payminto's versioned fee rules and double-entry ledger.
For an India pitch, note that crypto transfers carry tax and reporting obligations (for example TDS on virtual digital asset transfers), so an exportable per-transaction audit trail is a practical selling point; confirm specifics with counsel.

### 3.9 Provider-side monetization

API, data and MCP tool providers want to price per call, per token or per outcome without building billing, without a hosted intermediary taking a cut, and while still serving card-paying humans.
Today they choose between Stripe metered billing (no agents, card fees), hosted agent platforms (lock-in, revenue share), or raw x402 (no budgets, no ledger, no netting, no refunds).

## 4. Product-market fit

### 4.1 Who pays

1. **API, data and MCP tool providers** (primary): they monetize directly and the product sits in their revenue path; Cloudflare, xmcp and Skyfire all target them, which confirms demand.
2. **Agent builders and agent platforms**: they need budgets, approvals and receipts to let customers trust agents with money; Valory/Olas reportedly cut billing build time from 6 weeks to 6 hours with Nevermined, a signal that builders will pay to avoid this work ([Nevermined](https://nevermined.ai/solutions/accept-agent-payments/)).
3. **Enterprises and PSPs**: they need policy, audit, AML and treasury pooling (HSP Master Account targets exactly this segment) and pay for managed operations and SLAs.

### 4.2 Market size signals

McKinsey is reported at $3-5T of global agentic commerce by 2030, Morgan Stanley at $190-385B of US e-commerce, Bain at $300-500B, and eMarketer at about $144B by 2029 for in-AI-platform sales only ([Stellagent](https://stellagent.ai/insights/agentic-commerce-market-size-forecast-2030), [Nevermined stats](https://nevermined.ai/blog/agentic-commerce-growth-statistics)).
Infrastructure investment is real: x402 Foundation membership spans Coinbase, Google, Visa, Mastercard, Stripe, AWS and Cloudflare, Circle shipped nanopayments to mainnet, Catena raised a reported $30M Series A, and Payman a reported $16M Series A ([Forkast](https://forkast.news/the-giants-are-building-on-x402-the-transaction-count-is-the-least-interesting-part/), [Circle](https://circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet), [yespress Catena profile](https://yespress.io/catena), [Caplight](https://www.caplight.com/company/paymanai)).
Honest counter-signal: real x402 commercial volume is still tiny relative to headline counts ([Glenbrook](https://glenbrook.com/payments_news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/)), so the pitch should be "infrastructure providers will need when volume arrives", backed by a usable provider-side wedge today.

### 4.3 Pricing models

Observed models: per-call flat price (x402, `paidTool`), usage up to a cap (`upto`), prepaid credits, time-based subscriptions, outcome-based pricing (Nevermined), and per-active-wallet fees (Crossmint at $0.05 per wallet above 1,000 free, per a Nevermined review) ([Nevermined](https://nevermined.ai/blog/ai-agent-credit-based-pricing), [Nevermined Crossmint review](https://nevermined.ai/blog/crossmint-review)).
Payminto fit: open-core with a free self-hosted node, paid enterprise licence (managed ops, audit reporting, SLA), and paid connectors, which matches the model already on [payminto.io](https://payminto.io); a hosted clearing service could later charge a small per-batch fee rather than per call.

### 4.4 Why self-hosted and non-custodial is a differentiator

- Providers keep their keys and revenue; no facilitator or platform takes a revenue share or can freeze payouts.
- Discovery and settlement are not tied to one facilitator, unlike Bazaar indexing only CDP-settled endpoints ([CDP Bazaar](https://docs.cdp.coinbase.com/x402/bazaar.md)).
- Compliance stays with the operator, which matches HSP's stated model where participants own compliance and HashKey's licensed entities handle custody and OTC.
- Data residency and audit: usage records and mandates never leave the operator's database, which matters to enterprises and regulated PSPs.
- Agents calling agents across organizations need a neutral clearing protocol, not another walled platform; self-hosted nodes that interoperate via x402, AP2/HSP and ERC-8004 are that neutral layer.

## 5. Product concepts for the A2A track

Scoring is 1-5 (higher is better) for judge appeal, 7-day buildability for a strong team, and real PMF.

| Rank | Concept | Judge appeal | Buildability | PMF | Total |
|------|---------|--------------|--------------|-----|-------|
| 1 | Payminto Agent Clearinghouse: mandate-bound budgets, x402/MCP paywall, vouchers, netted HSP settlement | 5 | 4 | 5 | 14 |
| 2 | Payminto Task Escrow: pay-on-verified-delivery for A2A tasks with validator release and ERC-8004 reputation | 5 | 3 | 4 | 12 |
| 3 | Payminto Agent Treasury: enterprise agent wallets, policy engine, approvals, AML screening, audit export over HSP Master Account | 3 | 4 | 4 | 11 |

### 5.1 Concept 1 (recommended): Payminto Agent Clearinghouse

**One line:** A self-hosted node that lets any API or MCP tool charge agents per call under a signed spending mandate, accrues sub-cent vouchers off-chain, and clears them on HashKey Chain through HSP in netted batches with receipts in a double-entry ledger.

**Why it is more than a payment link:**

- **Mandate-bound budgets:** the human or enterprise signs one EIP-712 mandate (AP2 Intent Mandate semantics, HSP-compatible) that caps per call, per day and total, restricts counterparties and tools, and expires; the node enforces it atomically with Payminto's exclusive claims, so 50 parallel calls cannot overspend.
- **x402-compatible paywall:** providers put the node in front of any HTTP API or wrap MCP tools; unpaid requests get a standard 402 / PaymentRequired so existing x402 clients work, plus a voucher extension for sub-cent pricing.
- **Vouchers instead of per-call transactions:** each call carries a signed cumulative voucher (monotonic amount per payer-payee channel), so calls cost zero gas and settle later.
- **Multilateral netting:** at the end of a window, the node (or a set of peered nodes) nets all A-to-B, B-to-C, C-to-A obligations and settles only net positions via HSP on HashKey Chain, posting one ledger journal per batch.
- **On-chain receipts:** each batch writes a Merkle root of the included vouchers and their request/response hashes, so any single call can be proven with a Merkle proof; receipts are optionally posted as ERC-8004 reputation feedback.
- **Refunds as negative vouchers:** a provider can issue a signed credit that offsets the next batch, giving a refund path without chargebacks.
- **Operator tooling:** dashboard for providers (revenue per tool, per agent, pending vs settled), for agent owners (budget burn, blocked calls with reasons), webhooks for every state change, and CSV/JSON audit export.

**MVP scope for 7 days:**

1. Solidity on HashKey Chain testnet (chain ID 133): `MandateRegistry` (register, revoke, read caps) and `ClearingSettlement` (deposit USDC.e or test token into payer balance, `settleBatch(netTransfers[], merkleRoot)` verifying signatures, emitting receipts), integrated with HSP's mandate and receipt flow as far as the official SDK allows, with a thin adapter so the HSP path is swappable.
2. Go service in the Payminto backend: mandate verification, voucher validation and atomic budget claim, netting engine, batch settlement worker, ledger postings, webhooks.
3. x402 middleware (HTTP) and a `paidTool` equivalent in the Payminto MCP server that speaks PaymentRequired and accepts vouchers.
4. A TypeScript buyer SDK that signs mandates and vouchers, wrapping `fetch` and an MCP client.
5. Dashboard pages: Mandates, Live Calls, Net Positions, Batches with explorer links, Receipts verifier.
6. Demo agents: one orchestrator agent and three provider agents (search, summarize, translate), each running its own Payminto node.

Explicitly out of scope for MVP: card rail for agents, production AML provider, Bazaar-style public discovery (a static registry file is enough), multi-chain.

**The wow demo (under 3 minutes):**

1. 0:00-0:25: A user signs one mandate in the dashboard: "Research agent, $2/day, max $0.01 per call, only these 3 tools, expires tonight." It appears on HashKey Chain explorer.
2. 0:25-1:15: The research agent fires about 500 paid calls across three providers' APIs and MCP tools in under a minute; the Live Calls view streams each call with price, voucher number and remaining budget, and the gas counter stays at zero.
3. 1:15-1:40: The agent is prompt-injected into calling an unlisted "premium" tool and then tries to exceed the cap; both calls are refused with the mandate clause cited, and nothing is paid.
4. 1:40-2:20: Providers also call each other (summarizer pays search), so obligations form a cycle; the presenter clicks Settle, and about 500 obligations across four parties net into two or three HSP transfers on HashKey Chain, shown side by side with "would have been ~500 transactions".
5. 2:20-2:50: A judge picks any single call from the list; the receipts verifier shows its Merkle proof against the on-chain batch root, the mandate it ran under, and the balanced ledger journal.

**Tagline for judges:** "Visa-style clearing for agents, that every API provider can run on their own server."

### 5.2 Concept 2: Payminto Task Escrow

Buyer agents post A2A tasks with a price; funds lock in an escrow contract keyed by task ID; a seller agent delivers; release happens on buyer acceptance, on a validator agent's attestation (ERC-8004 Validation Registry), or after a timeout with partial refund rules; outcome is written as reputation feedback.
Strong judge appeal and real need for agent labor markets, but the verification oracle is the hard part, and PMF depends on agent work marketplaces maturing.
Recommended as a stretch "conditional settlement mode" inside Concept 1 if time remains: a task voucher that is held, not netted, until release.

### 5.3 Concept 3: Payminto Agent Treasury

An enterprise console where finance teams fund per-agent sub-wallets from an HSP Master Account, apply policies (limits, allowlists, approval thresholds), screen counterparties via on-chain AML hooks, and export audit reports.
Clear PMF with PSPs and enterprises that HSP already targets, and very buildable, but visually closer to a spend-management dashboard, so the demo has less wow.
Most of it falls out of Concept 1's mandate engine and ledger, so it is a good post-hackathon enterprise upsell.

## 6. AI Agent Trading track idea: Mandate-bound trading agent with a paid signal market

**Idea:** A trading agent on HashKey Chain that buys signals per call from independent signal-provider agents through the same Clearinghouse paywall and executes trades on a HashKey Chain DEX only within a signed trading mandate (asset allowlist, max position, max slippage, daily loss limit, kill switch), while signal providers are paid partly up front and partly from an escrow released according to the realized PnL of trades their signal triggered.

**Rationale:** The hardest problem in agent trading is not prediction, it is trust and accountability: owners need hard, externally enforced limits on what an autonomous trader can do, and signal sellers need to be paid in a way that rewards being right rather than being loud.
The Clearinghouse already provides the mandate engine, per-call vouchers, escrow-style held settlement, ledger and receipts, so the trading entry reuses about 70% of the code and adds a DEX adapter, a PnL attribution job and a risk mandate schema.
The demo writes itself: a signal market with three provider agents, a trader agent that pays fractions of a cent per signal, a blocked trade when a signal pushes past the loss limit, and an end-of-day settlement where an accurate provider's escrow releases and an inaccurate one's refunds, all provable on chain.

## 7. Open questions to resolve before building

- Exact HSP developer interface (mandate schema, receipt format, verifier node API, testnet contracts) from organizers or `hashfans.io`, since the referenced GitHub repo returned 404 at research time.
- Whether judges require HSP to be the settlement call itself or accept HSP-compatible mandates plus HashKey Chain settlement.
- Which stablecoin on HashKey Chain testnet has a faucet, or whether to deploy a test USDC.
- Official track rules and judging criteria for the India edition, which were not found in search.

## Sources

- https://payminto.io
- https://github.com/coinbase/x402/tree/main/specs/schemes
- https://raw.githubusercontent.com/coinbase/x402/main/specs/schemes/upto/scheme_upto.md
- https://docs.x402.org/extensions/bazaar
- https://docs.cdp.coinbase.com/x402/bazaar.md
- https://www.theblock.co/post/372064/cloudflare-coinbase-launch-x402-foundation
- https://forkast.news/the-giants-are-building-on-x402-the-transaction-count-is-the-least-interesting-part/
- https://policylayer.com/glossary/x402-foundation
- https://glenbrook.com/payments_news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/
- https://www.vellum.ai/blog/googles-ap2-a-new-protocol-for-ai-agent-payments
- https://discuss.google.dev/t/new-agent-payments-protocol-ap2-an-open-and-secure-standard-for-agentic-payments/265614
- https://ap2-protocol.org/llms-full.txt
- https://www.coinbase.com/es-es/developer-platform/discover/launches/google_x402
- https://github.com/google-agentic-commerce/a2a-x402
- https://techflowpost.com/en-US/article/31203
- https://techflowpost.com/en-US/newsletter/126305
- https://phemex.com/news/article/hashkey-unveils-hsp-protocol-to-power-ai-agent-economy-74466
- https://www.prnewswire.com/news-releases/hashkey-settlement-platform-hsp-and-onerway-announce-strategic-partnership-to-shape-the-future-of-on-chain-payments-and-support-cross-border-commerce-development-302868883.html
- https://tradeinformer.com/payments/hashkey-hsp-onerway-stablecoin-fiat-offramps
- https://github.com/TheSupermanish/hashera
- https://github.com/Ayotwix01/IntentGuard
- https://luma.com/bljpi0vd?locale=ja
- https://cointelegraph.com/news/hashkey-group-ethereum-layer-2-hashkey-chain-mainnet
- https://stripe.com/newsroom/news/stripe-openai-instant-checkout
- https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared
- https://stellagent.ai/insights/mastercard-agent-pay-ai-agents
- https://risingwave.com/blog/mastercard-agent-pay-vs-visa-vs-stripe-agentic-commerce/
- https://www.businesswire.com/news/home/20250626772489/en
- https://stellagent.ai/insights/skyfire-kyapay-know-your-agent
- https://nevermined.ai/solutions/accept-agent-payments/
- https://nevermined.ai/blog/ai-agent-credit-based-pricing
- https://nevermined.ai/blog/crossmint-review
- https://dupple.com/reviews/payman
- https://venturebeat.com/business/payman-ai-selected-for-icba-thinktech-accelerator
- https://www.caplight.com/company/paymanai
- https://catena.com/blog/acklab-developer-preview
- https://stablecoininsider.org/how-to-settle-usdc-agent-payments-with-catena-ack-pay/
- https://www.fintechfutures.com/fintech-start-ups/catena-labs-emerges-from-stealth-with-18m-seed-funding
- https://yespress.io/catena
- https://docs.crossmint.com/solutions/ai-agents/agent-wallets/overview
- https://www.crossmint.com/announcement/agentic-cards-api-launch-visa-basistheory
- https://circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet
- https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity
- https://www.crowdfundinsider.com/?p=278131
- https://bitcoinmagazine.com/news/lightning-labs-rolls-out-ai-agent-tools
- https://docs.lightning.engineering/agents/resources-for-agents
- https://buildbear.io/blog/erc-8004
- https://agentic-docs.polygon.technology/general/agentic/erc8004
- https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/
- https://eco.com/support/en/articles/14846276-build-an-mcp-server-with-x402-monetization
- https://stablecoininsider.org/how-to-charge-for-mcp-tools-with-cloudflare-agents-x402.md
- https://xmcp.dev/docs/guides/monetization.md
- https://stellagent.ai/insights/agentic-commerce-market-size-forecast-2030
- https://nevermined.ai/blog/agentic-commerce-growth-statistics
