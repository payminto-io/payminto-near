# Payminto demo video: first draft script (superseded)

Superseded by `MASTER_SCRIPT.md`, which is the script that was voiced and built; scene ids below are the old draft ids and do not match `SHOTLIST.md`.
This file is kept for its go-to-market brief (section D, "Go-to-market brief behind S22 to S25"), which is the Q&A reference for the pitch.

Target length: 4:53 (293 seconds), 1920x1080, 30 fps.
Submission: HashKey Chain Horizon Mumbai, Track 2: Agent Payments and A2A Settlement.
Every scene has an id (S01 to S27), a start time, a target duration, what is on screen, and the narration.
Narration is one sentence per line, written to be spoken at about 150 words a minute.
Screen recordings are listed in `SHOTLIST.md`; anything in `<ANGLE_BRACKETS>` is a placeholder to fill from the real run.
Numbers marked [n] cite the source list at the end of this file.
Never round a measured number up, and delete any line whose placeholder cannot be filled with a real value.

## Honesty rules for this video

Everything shown runs on testnets.
Payments use Circle's testnet USDC on Ethereum Sepolia and a Payminto Test USDC on HashKey Chain Testnet (chain 133).
Testnet tokens have no value, and there is no mainnet deploy.
The video says this out loud twice (S07 and S27) and a "Testnet - tokens have no value" badge stays on screen during every demo and explorer scene.

## Scene list

| Id | Section | Start | Duration | What |
|---|---|---|---|---|
| S01 | A. Hi, this is Payminto | 0:00 | 8 s | Hook |
| S02 | A | 0:08 | 12 s | What Payminto is |
| S03 | A | 0:20 | 16 s | The problem |
| S04 | A | 0:36 | 12 s | Why now |
| S05 | A | 0:48 | 12 s | The bigger market |
| S06 | B. Live demo | 1:00 | 3 s | Section card |
| S07 | B | 1:03 | 18 s | One link, paid with Sepolia USDC |
| S08 | B | 1:21 | 8 s | Bring your own model key |
| S09 | B | 1:29 | 14 s | Buyer agent gets a task and discovers paid services |
| S10 | B | 1:43 | 14 s | Mandate: the agent pays per call inside a budget |
| S11 | B | 1:57 | 16 s | Seller agent sells a market brief and buys its own inputs |
| S12 | B | 2:13 | 14 s | Netting settles on HashKey Chain Testnet |
| S13 | B | 2:27 | 10 s | Receipt proof verified |
| S14 | B | 2:37 | 12 s | Ops agent: what did we earn today |
| S15 | B | 2:49 | 10 s | Refund requested by the agent, approved by a human |
| S16 | B | 2:59 | 8 s | Reconciliation CSV |
| S17 | C. Investor pitch | 3:07 | 2 s | Section card |
| S18 | C | 3:09 | 10 s | Business model |
| S19 | C | 3:19 | 8 s | Wedge |
| S20 | C | 3:27 | 10 s | Moat |
| S21 | C | 3:37 | 10 s | Traction plan and ask |
| S22 | D. Go to market | 3:47 | 12 s | Ideal customers |
| S23 | D | 3:59 | 12 s | Channels and pricing |
| S24 | D | 4:11 | 10 s | First 90 days |
| S25 | D | 4:21 | 8 s | Risks |
| S26 | E. On chain, live | 4:29 | 16 s | HashKey transactions on the explorer |
| S27 | Close | 4:45 | 8 s | Outro |

Total: 293 seconds.

---

## A. Hi, this is Payminto (0:00 to 1:00)

### S01 - Hook (0:00, 8 s)

On screen: black, then the Payminto mark and the line "Your next customer is an AI agent." in large type.
Clip: none (HyperFrames title card `s01-hook`).

Narration:
- Hi, this is Payminto.
- Your next customer is not a person.
- It is an AI agent, and it wants to pay you per call.

### S02 - What Payminto is (0:08, 12 s)

On screen: three words animate in: "Self-hosted. Non-custodial. Stablecoins." Then one payment link fans out to a person icon and an agent icon.
Clip: none (card `s02-what`).

Narration:
- Payminto is a stablecoin payment gateway you run on your own server.
- One payment link works for people and for AI agents.
- The money goes straight to your wallet.
- Nobody in the middle holds it, not even us.

### S03 - The problem (0:20, 16 s)

On screen: a counter of tiny agent calls ticking up next to a gas meter; "34,444 gas per transfer" vs "0.002 USDC per call" [1].
Then a padlock over an open wallet: "Nobody gives an agent an open wallet."
Clip: none (card `s03-problem`).

Narration:
- Agents buy in tiny amounts.
- A quote, a risk score, a research brief, each worth a fraction of a cent.
- One stablecoin transfer costs about thirty-four thousand gas, which can rival the price of the call itself.
- And no business will hand an agent an open wallet.
- So agent payments need budgets, batching and proof.

### S04 - Why now (0:36, 12 s)

On screen: four logos-free text chips slide in: "x402 asks for payment", "AP2 proves consent", "ERC-8004 proves identity", "HSP settles on HashKey Chain" [2][3].
A gap opens in the middle labelled "Who enforces the budget?".
Clip: none (card `s04-why-now`).

Narration:
- The rails are arriving right now.
- x402 lets a call ask for money.
- AP2 proves a human said yes.
- HashKey's HSP settles it.
- But nobody owns the middle layer that budgets, meters and proves agent spend.

### S05 - The bigger market (0:48, 12 s)

On screen: two stat cards with sources in small type.
"About $316B of stablecoins in circulation (DefiLlama, 12 June 2026)" [4].
"$3-5T of agentic commerce by 2030 (McKinsey, as reported)" [5].
Footnote: "Real agent payment volume is still small today" [6].
Clip: none (card `s05-market`).

Narration:
- Stablecoins already hold about three hundred and sixteen billion dollars.
- McKinsey is reported to see three to five trillion dollars of agentic commerce by 2030.
- Real agent volume is still small today.
- That is exactly why the operator layer has to exist before it arrives.

---

## B. Live demo (1:00 to 3:07)

The "Testnet - tokens have no value" badge is on screen from S06 to S16.

### S06 - Section card (1:00, 3 s)

On screen: "Live demo. Real model. Real testnet payments."
Clip: none (card `s06-demo-card`).

Narration:
- Let me show you, live.

### S07 - One link, paid with Sepolia USDC (1:03, 18 s)

On screen: the merchant creates a payment link in the dashboard, opens the hosted checkout, and a person pays it from a wallet with Circle testnet USDC on Ethereum Sepolia.
The payment turns Paid, the fee split shows, then the Sepolia explorer page for `<SEPOLIA_PAYMENT_TX>`.
Clip: `clips/S07-sepolia-checkout.mp4`.

Narration:
- This is the merchant dashboard.
- I create a payment link and open it like a customer would.
- The customer signs once and pays with real Circle USDC on Ethereum Sepolia.
- Paid, with the fee split in the same transaction.
- This is testnet money, so it has no value, but the flow is exactly the real one.

### S08 - Bring your own model key (1:21, 8 s)

On screen: Settings, AI models: an OpenAI connection with status Active and the key shown only as its last four characters.
Clip: `clips/S08-ai-connection.mp4`.

Narration:
- Agents run on the merchant's own model key.
- Here it is OpenAI, and the bill goes to the merchant, not to us.

### S09 - Buyer agent gets a task (1:29, 14 s)

On screen: terminal: `pnpm agent run "<TASK>"` with the OpenAI provider; the agent lists paid services from the node directory and reads its budget.
Clip: `clips/S09-buyer-task.mp4`.

Narration:
- Now a buyer agent gets a task in plain words.
- It looks up the paid services this server lists.
- It checks its budget first.
- And it only buys what the task actually needs.

### S10 - Mandate: pay per call inside a budget (1:43, 14 s)

On screen: the mandate page in the dashboard: total cap, per-call cap, daily cap, allowed payees, expiry; the spent bar moves as each call is paid.
Clip: `clips/S10-mandate-calls.mp4`.

Narration:
- Every call is paid with a signed voucher under a mandate.
- The mandate is the budget: a total cap, a per-call cap, a daily cap, and who it may pay.
- No gas per call, just one signature.
- Go over the limit and it is refused, by rule name.

### S11 - Seller agent sells a market brief (1:57, 16 s)

On screen: split view.
Left: the seller agent `pnpm agent serve-skill market-brief` receiving a paid call.
Right: the seller paying its own inputs (spot quotes, wallet risk) from its own mandate; the flow graph on the Netting page lights up buyer to seller to providers.
Clip: `clips/S11-seller-brief.mp4`.

Narration:
- The buyer pays a seller agent for a market brief.
- That seller is an agent too.
- It buys its own inputs from other paid services, with its own budget.
- Agent pays agent, which pays other agents.
- That is agent-to-agent commerce, and every step is metered.

### S12 - Netting settles on HashKey Chain Testnet (2:13, 14 s)

On screen: the Batches page: one batch with `<N_CALLS>` calls, `<N_CLAIMS>` claims and `<N_TRANSFERS>` net transfers; then the HashKey Chain Testnet explorer page for `<HASHKEY_SETTLE_TX>`.
Clip: `clips/S12-netting-settle.mp4`.

Narration:
- Now all those small charges settle.
- Payminto nets every agent against every other agent.
- Only the net amounts move, wallet to wallet, in one transaction on HashKey Chain Testnet.
- In our measured run, netting used eleven point six times less gas than one transfer per call.

### S13 - Receipt proof verified (2:27, 10 s)

On screen: a receipt page for one call: the call id, the batch, the Merkle proof, and "Verified on chain" after `verifyReceipt` returns true.
Clip: `clips/S13-receipt-proof.mp4`.

Narration:
- Any single call can be proven later.
- One receipt, one proof, checked against the batch root on chain.
- Verified.

### S14 - Ops agent: what did we earn today (2:37, 12 s)

On screen: Agents, the ops agent page; the merchant types "what did we earn today" in the Ask box; the run timeline shows tool calls and the answer with totals.
Clip: `clips/S14-ops-earnings.mp4`.

Narration:
- Now the back office.
- The merchant asks their ops agent: what did we earn today?
- It reads the real payments and answers with the numbers.

### S15 - Refund: agent requests, human approves (2:49, 10 s)

On screen: the merchant asks the ops agent to refund one payment; the refund appears on the Refunds page as Pending approval; a human clicks Approve; status becomes Refunded.
Clip: `clips/S15-refund-approve.mp4`.

Narration:
- Then I ask it to refund an order.
- The agent can only request it.
- A human approves, and the refund goes out gasless.

### S16 - Reconciliation CSV (2:59, 8 s)

On screen: Payments, Download report; the CSV opens with method, fees, net, on-chain transaction and proof columns.
Clip: `clips/S16-reconciliation-csv.mp4`.

Narration:
- And finance gets one report.
- Every payment, fee, refund and proof, in one CSV.

---

## C. Investor pitch (3:07 to 3:47)

### S17 - Section card (3:07, 2 s)

On screen: "Why this is a business."
Clip: none (card `s17-pitch-card`).

Narration:
- So why is this a business?

### S18 - Business model (3:09, 10 s)

On screen: slide with four rows: "Open-source core (MIT)", "0% take rate on payments", "Paid: enterprise licence, managed node", "Later: hosted clearing, priced per batch".
Source: `docs/SUBMISSION.md`, Business model.
Clip: none (slide `s18-model`).

Narration:
- The core is open source and free.
- We take zero percent of payments, because we never touch the money.
- We charge for the enterprise licence and for running the node for you.
- Later, a hosted clearing network priced per batch, not per call.

### S19 - Wedge (3:19, 8 s)

On screen: slide "Wedge: sellers who already want to charge agents per call".
Clip: none (slide `s19-wedge`).

Narration:
- Our wedge is the seller.
- API, data and AI skill businesses that want agents to pay them per call, today.

### S20 - Moat (3:27, 10 s)

On screen: slide with three moats: "Self-hosted and non-custodial", "Multilateral netting with per-call proofs", "Budgets enforced in three places".
Clip: none (slide `s20-moat`).

Narration:
- Hosted players hold your money or your wallets.
- We run on your server and never hold funds.
- We net many agents at once and prove every single call.
- We have not found another agent payment product that nets across independent agents.

### S21 - Traction plan and ask (3:37, 10 s)

On screen: slide "Now: working product on testnet, no external users yet." "Next 30 days: 10 Indian design partners." "Ask: `<ASK>`".
Clip: none (slide `s21-ask`).

Narration:
- Honest status: a working product on testnet, and no external users yet.
- Next, ten Indian design partners in thirty days.
- Our ask: `<ASK_SPOKEN>`.

---

## D. Go to market (3:47 to 4:29)

### S22 - Ideal customers (3:47, 12 s)

On screen: slide with two ideal customer profiles.
"1. Indian API and SaaS sellers with foreign customers: India SaaS was $3.5B revenue in FY2020, 75% from global sales (Nasscom)" [7].
"2. Agent builders who need budgets and receipts: one builder reportedly cut billing work from 6 weeks to 6 hours with a hosted tool" [8].
Clip: none (slide `s22-icp`).

Narration:
- We start in India.
- Indian SaaS already earns most of its revenue abroad.
- Nasscom put it at seventy-five percent from global sales.
- Those sellers need a clean way to get paid per call by foreign agents.
- Then agent builders, who need budgets and receipts before customers trust their agents with money.

### S23 - Channels and pricing (3:59, 12 s)

On screen: slide "Channels: open-source repo and MCP directories; HashKey ecosystem and HSP; Indian SaaS communities; hackathon and agent-builder communities."
"Pricing: free self-hosted node; enterprise licence and managed node priced per node per month (`<PRICE_TBD>` with design partners)."
Clip: none (slide `s23-channels`).

Narration:
- Developers find us through the open-source repo and MCP tool directories.
- Businesses find us through the HashKey ecosystem and India's SaaS communities.
- The node is free.
- Paid plans are priced per node per month, and we set the price with our first design partners.

### S24 - First 90 days (4:11, 10 s)

On screen: three columns.
"Days 1-30: official HSP SDK, Safe-owned budgets, 10 design partners."
"Days 31-60: first paid pilots, refunds as negative vouchers."
"Days 61-90: escrowed payments released on delivery, independent contract audit, mainnet."
Source: `docs/SUBMISSION.md`, Roadmap.
Clip: none (slide `s24-90days`).

Narration:
- First thirty days: the official HSP SDK and ten design partners.
- By ninety days: pay-on-delivery escrow, an independent audit, and mainnet.

### S25 - Risks (4:21, 8 s)

On screen: slide with three risks and their answer: "Agent volume is still small: we sell the seller side today." "Regulation and tax: exportable ledger, no tax advice." "HSP access depends on HashKey: fails closed, clearly labelled."
Clip: none (slide `s25-risks`).

Narration:
- The risks are real.
- Agent volume is small, regulation is moving, and HSP access depends on HashKey.
- Each one fails closed and is labelled honestly.

### Go-to-market brief behind S22 to S25 (not spoken)

This is the management-level read the slides compress; use it for Q&A.

**Ideal customer 1: Indian API, data and SaaS sellers with foreign customers.**
Indian SaaS already sells abroad: Nasscom put FY2020 revenue at $3.5 billion with 75% from global sales [7].
Bain projected $35 billion ARR by 2027 and 8% of the global SaaS market (India SaaS Report 2022, via Techloy).
These sellers are the first who will see agent traffic from foreign buyers, and per-call cross-border billing is where cards and invoices fit worst.
UPI wins domestic retail, so we do not pitch against it; the gap is cross-border per-call settlement (`docs/SUBMISSION.md`, India relevance).
Indian buyers already understand capped mandates: NPCI, Razorpay and OpenAI announced an agentic payments pilot on UPI Reserve Pay on 9 October 2025 (Onmanorama).
Buying trigger: a foreign customer or partner asks to pay in USDC, or the seller lists an MCP tool and wants it paid.

**Ideal customer 2: agent builders and agent platforms.**
They need budgets, approvals and receipts before their customers trust an agent with money [8].
Buying trigger: a customer asks "how do I cap what your agent spends, and see every charge".

**Channels.**
Developer-led: the MIT repository, the MCP server listed in MCP directories, the SDK and `paywall()` docs.
Ecosystem: HashKey Chain and HSP, hackathon follow-ups, HashKey ecosystem intros.
Community: India SaaS founder communities and agent-builder communities, with a design-partner offer.
Partners later: fiat off-ramp partners in the pattern HSP already uses (`research/03-market-competitors.md` section 2.4).

**Pricing.**
Free self-hosted node, zero take rate on payments, paid enterprise licence and managed node priced per node per month, later a hosted clearing network priced per settled batch (`docs/SUBMISSION.md`, Business model).
Comparable models in the market: per-call prices, prepaid credits, outcome pricing and per-wallet fees (`research/03-market-competitors.md` section 4.3).
Actual price points are not set; we set them with the first design partners and do not quote invented numbers.

**First 90 days.**
Days 1 to 30: swap in the official HSP SDK once published, Safe-owned budgets in the dashboard, 10 Indian design partners (`docs/SUBMISSION.md`, Roadmap).
Days 31 to 60: first paid pilots with design partners, refunds as negative vouchers.
Days 61 to 90: escrowed vouchers released on task acceptance, peered nodes netting across operators, an independent audit of ClearingHub, then mainnet.
Success measures: design partners live on testnet, then mainnet; calls per task, refusals per task, share of agent payments settled by netting, and zero unexplained differences in reconciliation (`docs/PRODUCT_PLAN.md` section 8).

**Risks.**
Agent payment volume is still small relative to headline counts [6]: we sell the seller-side gateway that is useful now.
Big platforms are moving in (x402 Foundation members, Circle Nanopayments live since 29 April 2026, per `research/03-market-competitors.md` section 2.8): we stay self-hosted, operator-neutral and interoperable with x402 rather than competing on a hosted network.
Regulation and tax for crypto in India (for example TDS on virtual digital asset transfers): we export a per-transaction ledger and do not give tax advice; confirm specifics with counsel.
HSP access depends on HashKey allowlisting our server: the method fails closed with "Waiting for HSP access" until it is granted.
Model cost or outage during a demo: per-task spend and token ceilings, and a recorded run as backup.

---

## E. On chain, live (4:29 to 4:45)

### S26 - HashKey transactions on the explorer (4:29, 16 s)

On screen: the HashKey Chain Testnet explorer (https://testnet-explorer.hskchain.net), one page after another, each with its address or hash in a lower third.

| Order | Page | Placeholder |
|---|---|---|
| 1 | ClearingHub contract, verified source | `https://testnet-explorer.hskchain.net/address/<HUB_ADDRESS_TESTNET>?tab=contract` |
| 2 | DepositFactory contract | `https://testnet-explorer.hskchain.net/address/<DEPOSIT_FACTORY_TESTNET>` |
| 3 | PaymentRouter contract | `https://testnet-explorer.hskchain.net/address/<PAYMENT_ROUTER_TESTNET>` |
| 4 | Payminto Test USDC token | `https://testnet-explorer.hskchain.net/token/<TEST_USDC_TESTNET>` |
| 5 | Mandate opened | `https://testnet-explorer.hskchain.net/tx/<MANDATE_OPEN_TX>` |
| 6 | settleBatch with NetTransfer logs | `https://testnet-explorer.hskchain.net/tx/<HASHKEY_SETTLE_TX>?tab=logs` |
| 7 | Sepolia USDC payment (Circle) | `https://sepolia.etherscan.io/tx/<SEPOLIA_PAYMENT_TX>` |

Clip: `clips/S26-explorer-tour.mp4`.

Narration:
- Here is everything on chain.
- Our contracts on HashKey Chain Testnet: the clearing hub, the deposit factory and the payment router.
- The mandate that set the agent's budget.
- The settlement batch, with every net transfer in its logs.
- And the customer's USDC payment on Sepolia.

### S27 - Outro (4:45, 8 s)

On screen: Payminto mark, "Get paid by people and AI agents, on your own server.", repo URL `<GITHUB_URL>`, "Testnet only. Tokens have no value. No mainnet deploy yet."
Clip: none (card `s27-outro`).

Narration:
- Everything you saw ran on testnets, with tokens that have no value.
- Payminto: get paid by people and AI agents, on your own server.

---

## Placeholders to fill from the real run

| Placeholder | Where it comes from |
|---|---|
| `<TASK>` | The exact task given to the buyer agent in the recorded run |
| `<SEPOLIA_PAYMENT_TX>` | The payment's transaction on the payment detail page |
| `<N_CALLS>`, `<N_CLAIMS>`, `<N_TRANSFERS>` | The batch detail page for the recorded settlement |
| `<HASHKEY_SETTLE_TX>`, `<MANDATE_OPEN_TX>` | Batch and mandate detail pages |
| `<HUB_ADDRESS_TESTNET>`, `<DEPOSIT_FACTORY_TESTNET>`, `<PAYMENT_ROUTER_TESTNET>`, `<TEST_USDC_TESTNET>` | The testnet deploy output (`forge script script/Deploy.s.sol --rpc-url hashkey_testnet`) |
| `<ASK>`, `<ASK_SPOKEN>` | Decided by the founder; not in the repo |
| `<PRICE_TBD>` | Decided with design partners; leave as "set with design partners" if unknown |
| `<GITHUB_URL>` | The public repository URL |

## Sources

[1] Measured gas, repository: `docs/GAS.md` (34,444 gas per ERC-20 transfer to an existing recipient; 640 calls in one batch for 1,907,140 gas versus 22,044,160 gas, about 11.6x less), and the 0.002 USDC per call example from `README.md`, "Why it exists".
[2] x402, AP2 and ERC-8004 roles: `research/03-market-competitors.md` sections 2.2, 2.3 and 2.10, and `docs/PRODUCT_PLAN.md` section 2.
[3] HSP as HashKey's settlement protocol extending AP2: `research/03-market-competitors.md` section 2.4 (TechFlow https://techflowpost.com/en-US/article/31203, Phemex https://phemex.com/news/article/hashkey-unveils-hsp-protocol-to-power-ai-agent-economy-74466).
[4] Total stablecoin market cap about $316 billion as of 12 June 2026, DefiLlama data as reported by Transak: https://transak.com/blog/stablecoin-market-cap-2026 (verified by web fetch on 2026-11-03).
[5] McKinsey reported at $3-5 trillion of global agentic commerce by 2030: `research/03-market-competitors.md` section 4.2 (Stellagent https://stellagent.ai/insights/agentic-commerce-market-size-forecast-2030).
[6] x402 headline counts above 200 million transactions, with more than 95% protocol signalling rather than buyer-seller exchange (Artemis via Glenbrook): `research/03-market-competitors.md` sections 2.2 and 4.2 (https://glenbrook.com/payments_news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/).
[7] India SaaS revenue $3.5 billion in FY2020, 75% from global sales (Nasscom), as reported by The News Minute: https://www.thenewsminute.com/atom/indias-saas-industry-achieved-35-billion-revenue-fy2020-nasscom-129351 (verified by web fetch on 2026-11-03).
[8] Valory/Olas reportedly cut billing build time from 6 weeks to 6 hours with a hosted metering tool: `research/03-market-competitors.md` section 4.1 (https://nevermined.ai/solutions/accept-agent-payments/).

Supporting context used in PITCH.md and not spoken: Bain projected Indian SaaS at $35 billion ARR by 2027 and 8% of the global SaaS market (India SaaS Report 2022, as reported by Techloy: https://www.techloy.com/indian-software-service-companies-to-generate-35-billion-by-2027/); NPCI, Razorpay and OpenAI announced an agentic payments pilot on UPI on 9 October 2025 (https://www.onmanorama.com/news/business/2025/10/09/npci-razorpay-openai-chatgpt-payments.html).
