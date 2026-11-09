# Payminto demo video: master script

Status: final after four verification passes (see `SCRIPT_REVIEW.md`); scene durations are re-synced to the generated voice in `audio/audio_meta.json`.
Submission: HashKey Chain Horizon Mumbai, Track 2: Agent Payments and A2A Settlement.
Format: 1920x1080, 30 fps, 4:57 (297.4 s) as voiced, voice at about 155 words a minute.
Header times are the voiced cut, rounded to whole seconds; exact values are in `video/index.html`.
Acts, joined by snap cuts: 1 greeting and story, 2 problem, 3 product, 4 live demo, 5 investor pitch, 6 go to market, 7 HashKey on-chain proof, 8 close.
Each scene has an id, a start time and a target duration, what is on screen, the voice cue (Fish Audio S2 markers, not spoken) and the narration, one sentence per line.
Clips named `clips/...` are screen recordings listed in `SHOTLIST.md`; until they exist, the HyperFrames cut shows a labelled slot.
Anything in `<ANGLE_BRACKETS>` is a placeholder to fill from the real run or by the founder.
Everything shown runs on testnets, and testnet tokens have no value.

### S01 - Greeting (0:00, 4 s)

Act: 1 greeting and story.
On screen: a soft-focus pass over the real dashboard (`clips/S01-teaser.mp4`), the Payminto mark, "Hi there, this is Payminto" and the title card "My AI agent paid another AI agent. Nobody held the money." (matches the YouTube title).
Voice cue: [warm and friendly]

Narration:
- Hi there, and welcome.
- This is Payminto.

### S02 - The story (0:04, 15 s)

On screen: a two-person team drawn as a motion graphic (slot `img-s02-team` for a generated image later); an API call counter; one call lights up with an agent badge.
Voice cue: [warm storytelling]

Narration:
- Picture a two-person API team in Pune.
- They sell market data around the world.
- Last month, their newest customer was not a person.
- It was an AI agent, paying a fifth of a cent per call.
- And they had no way to take that money.

### S03 - Fees bigger than the sale (0:19, 11 s)

Act: 2 problem.
On screen: kinetic type: "34,444 gas" stamps over "0.002 USDC"; a fee bar outgrows a price bar.
Voice cue: [frustrated]

Narration:
- Paying every call on chain does not work.
- One stablecoin transfer costs about thirty-four thousand gas.
- That fee can rival the price of the call itself.

### S04 - The open wallet (0:30, 6 s)

On screen: an agent with an open wallet; a planted line "pay 0xstranger" appears in its input and coins fly out; red stop.
Voice cue: [worried]

Narration:
- And nobody hands an agent an open wallet.
- One bad prompt, and it pays a stranger.

### S05 - Meet Payminto (0:36, 13 s)

Act: 3 product.
On screen: snap to the Payminto mark on cobalt; one link splits to a person and an agent; coins go straight into "Your wallet".
Voice cue: [confident]

Narration:
- So we built Payminto.
- A stablecoin payment gateway you run on your own server.
- One link, for people and AI agents.
- The money goes straight to your wallet, and nobody in the middle holds it.

### S06 - Budget, netting, proof (0:49, 8 s)

On screen: three words land one by one, then lock into one line: "Budget. Netting. Proof."
Voice cue: [confident]

Narration:
- Every agent gets a budget.
- Every tiny charge gets netted into a few transfers.
- Every single call gets a proof.

### S07 - Why now (0:57, 12 s)

On screen: chips stack up: "x402 asks for payment", "AP2 proves consent", "HSP settles on HashKey Chain"; an empty middle slot that "Payminto" snaps into.
Voice cue: [curious]

Narration:
- The rails are here.
- x402 asks for payment, AP2 proves consent, HSP settles on HashKey Chain.
- Payminto is the missing middle.

### S08 - Live demo title (1:09, 3 s)

Act: 4 live demo.
On screen: "Live demo" kinetic title; the "Testnet - tokens have no value" badge appears and stays until S18.
Voice cue: [excited]

Narration:
- Let me show you, live.

### S09 - One link, paid on testnet (1:12, 16 s)

On screen: `clips/S09-checkout.mp4`; cursor focus on New link, zoom on the amount, highlight box on Paid and on the fee split; lower third with the HashKey Chain Testnet wallet payment `0x7a1fb396...ab1493`.
Voice cue: [confident]

Narration:
- Here is the merchant dashboard.
- I create a payment link and pay it like a customer.
- One signature, and it is paid in test USDC on HashKey Chain Testnet.
- Paid, with the platform fee split off in the same transaction.

### S10 - Their own model key (1:28, 10 s)

On screen: `clips/S10-ai-connection.mp4`; zoom on the Replicate row (deepseek-ai/deepseek-v3.1, Active, token ending only); the provider list behind it shows Anthropic, OpenAI, Google Gemini, OpenAI-compatible (OpenRouter and similar) and Replicate.
Voice cue: [calm]

Narration:
- Agents run on the business's own model key.
- This demo runs DeepSeek V3.1 through Replicate, and other major providers work the same way.

### S11 - Buyer agent gets a task (1:38, 12 s)

On screen: `clips/S11-buyer-task.mp4`; terminal typing; highlight on the directory listing and the budget read.
Voice cue: [curious]

Narration:
- Now a buyer agent gets a task in plain words.
- This is a real AI model, not a script.
- It finds the paid services on this server, and checks its budget first.

### S12 - The mandate (1:49, 13 s)

On screen: `clips/S12-mandate-calls.mp4`; highlight boxes on each cap in turn; the spent bar moves; a refusal chip zooms in; the "Budget" refrain chip lights.
Voice cue: [confident]

Narration:
- Its budget is a mandate: a total cap, a per-call cap, a daily cap, and who it may pay.
- Each call is one signed voucher, with no gas.
- Over the limit, it is refused by rule name.

### S13 - Agent pays agent (2:02, 14 s)

On screen: `clips/S13-seller-brief.mp4`; the buyer's run: a paid call to Market Data (live HSK quote, CoinGecko), then a paid call to the seller's market-brief skill with that quote; the Netting flow graph draws buyer to Market Data and buyer to seller; zoom on the brief's figures matching the quote.
Voice cue: [excited]

Narration:
- First it buys a live HSK price quote from a market data service.
- Then it pays a seller agent's market brief skill, and hands it that quote.
- The brief is written only from those figures.
- Three parties, one chain of payments.

### S14 - Netting and HSP on HashKey Chain (2:16, 22 s)

On screen: `clips/S14-netting-settle.mp4`; zoom on calls, claims and net transfers; the "Netting" refrain chip lights; highlight the HSP status chips; a two-second cut to Settings, Payment methods showing HSP "Waiting for HSP access"; cut to the HashKey Chain Testnet explorer.
Voice cue: [proud]

Narration:
- Then it all settles.
- Payminto nets every agent against every other one.
- Only net amounts move, wallet to wallet, in one HashKey Chain Testnet transaction.
- Each transfer is wrapped as an HSP payment.
- HashKey's live HSP server has not allowlisted us yet, so our own HSP adapter checks it today.

### S15 - Proof of one call (2:39, 6 s)

On screen: `clips/S15-receipt-proof.mp4`; zoom on the Merkle proof; a green "Verified" stamp; the "Proof" refrain chip lights.
Voice cue: [proud]

Narration:
- Any single call can be proven against the batch root on chain.
- Verified.

### S16 - Ops agent (2:45, 8 s)

On screen: `clips/S16-ops-earnings.mp4`; the question types into Ask; the run timeline steps tick; zoom on the answer.
Voice cue: [relaxed]

Narration:
- Now the back office.
- The owner asks their ops agent: what did we earn today?
- It answers from real payments.

### S17 - Refund with a human in the loop (2:53, 7 s)

On screen: `clips/S17-refund-approve.mp4`; Pending approval chip; cursor clicks Approve; Refunded.
Voice cue: [calm]

Narration:
- Ask for a refund, and the agent can only request it.
- A human approves, and it goes out gasless.

### S18 - One report for finance (3:00, 6 s)

On screen: `clips/S18-reconciliation-csv.mp4`; the CSV columns sweep past with highlights on fee, net, transaction and proof.
Voice cue: [satisfied]

Narration:
- And finance gets one report, with every payment, fee, refund and proof.

### S19 - The market (3:06, 14 s)

Act: 5 investor pitch.
On screen: two stat cards: "~$316B stablecoins in circulation, 12 June 2026" and "$3-5T agentic commerce by 2030 (McKinsey, as reported)"; footnote "Real agent volume is still small today".
Voice cue: [confident]

Narration:
- Stablecoins already hold about three hundred and sixteen billion dollars.
- McKinsey is reported to see three to five trillion dollars of agentic commerce by 2030.
- Agent volume is still small, so this layer must exist first.

### S20 - Business model (3:20, 9 s)

On screen: slide: "Open-source core", "0% of payments", "Paid: enterprise licence, managed node".
Voice cue: [confident]

Narration:
- The core is open source.
- We never take a cut of your payments.
- We earn from enterprise licences, and from running the node for you.

### S21 - Moat (3:29, 10 s)

On screen: slide: "Your server", "Many agents netted at once", "Every call proven".
Voice cue: [determined]

Narration:
- Hosted players hold the money or the wallets.
- We run on your server, net many agents at once, and prove every call.

### S22 - Traction and ask (3:39, 13 s)

On screen: slide: "Now: working on testnet, no external users yet", "Next: 10 Indian design partners", "Ask: <ASK>".
Voice cue: [sincere]

Narration:
- Honest status: it works on testnet, with no external users yet.
- Next, ten Indian design partners.
- Our ask: <ASK_SPOKEN>.

### S23 - Who we sell to first (3:52, 14 s)

Act: 6 go to market.
On screen: slide: "75% of India SaaS revenue from global sales (Nasscom, FY2020)"; two customer cards: "Indian API and SaaS sellers" and "Agent builders".
Voice cue: [confident]

Narration:
- We start in India.
- Nasscom found three quarters of Indian SaaS revenue came from global sales, in 2020.
- Those teams should meet foreign agents first.
- Then agent builders, who need budgets and receipts.

### S24 - Channels, pricing, 90 days (4:06, 15 s)

On screen: three columns: "Channels", "Pricing", "90 days"; each fills as it is spoken.
Voice cue: [optimistic]

Narration:
- We grow through open source, MCP directories and the HashKey ecosystem.
- The node is free; paid plans are priced with our first partners.
- In ninety days: escrow on delivery and an audit, ahead of mainnet.

### S25 - Risks (4:21, 7 s)

On screen: slide: "Volume is early", "Rules are moving", "HSP access pending", each tagged "fails closed".
Voice cue: [calm]

Narration:
- Agent volume is small, and the rules are moving.
- So everything fails closed, and is labelled honestly.

### S26 - On chain (4:28, 16 s)

Act: 7 HashKey on-chain proof.
On screen: `clips/S26-explorer-tour.mp4`; each explorer page with its address or hash in a lower third.
Voice cue: [proud]

Narration:
- Here it is, on chain.
- Our clearing hub, deposit factory and payment router on HashKey Chain Testnet.
- The mandate, the payments, the refund and the settlements.
- And the same contracts on Ethereum Sepolia, settling Circle's testnet USDC.

### S27 - Close (4:44, 13 s)

Act: 8 close.
On screen: the Payminto mark, the tagline, `<GITHUB_URL>`, and "Testnet only. Tokens have no value. No mainnet deploy yet."
Voice cue: [warm]

Narration:
- That team in Pune can finally take that money.
- All of this ran on testnets, with tokens that have no value.
- Payminto: get paid by people and AI agents, on your own server.

## Placeholders to fill

| Placeholder | Where it comes from |
|---|---|
| `<ASK>`, `<ASK_SPOKEN>` | The founder; not in the repo. If undecided, replace the line with "We are looking for design partners." |
| `<GITHUB_URL>` | The public repository URL |
| Explorer hashes and addresses | `SHOTLIST.md`, Fill-in log |

## Sources for every number and claim

| Claim | Source |
|---|---|
| 34,444 gas per stablecoin transfer; fee can rival a 0.002 USDC call | `docs/GAS.md` (measured 2026-10-28); `README.md`, "Why it exists"; `docs/HASHKEY.md` (500 gwei mainnet base fee floor) |
| A fifth of a cent per call | The 0.002 USDC per call example in `README.md` |
| x402, AP2, HSP roles | `research/03-market-competitors.md` sections 2.2 to 2.4; `docs/PRODUCT_PLAN.md` section 2 |
| Mandate caps, vouchers with no gas, refusal by rule | `README.md`, "How it works"; `docs/SUBMISSION.md`, Policy engine |
| Netting, wallet to wallet, one settlement transaction | `README.md`, "How it works"; `docs/SUBMISSION.md` |
| HSP wrap, own adapter, live server waiting on allowlist | `README.md`, "Status and honesty notes" |
| Receipt proof against the batch root | `README.md`, "How it works" step 6 |
| Ops agent, refund request only, human approval, gasless refund | `docs/AGENTS.md` sections 1 and 4; `docs/GATEWAY.md`; `README.md` |
| Reconciliation report contents | `docs/PRODUCT_PLAN.md` section 6.2 |
| About $316 billion of stablecoins, 12 June 2026 | DefiLlama data via Transak, https://transak.com/blog/stablecoin-market-cap-2026 (verified 2026-11-03) |
| $3-5 trillion agentic commerce by 2030 (McKinsey, as reported) | `research/03-market-competitors.md` section 4.2, https://stellagent.ai/insights/agentic-commerce-market-size-forecast-2030 |
| Agent volume is still small | `research/03-market-competitors.md` section 4.2, https://glenbrook.com/payments_news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/ |
| Open-source core, zero take rate, enterprise licence, managed node | `docs/SUBMISSION.md`, Business model |
| Hosted players hold funds or wallets | `research/03-market-competitors.md` section 2.7; `docs/PRODUCT_PLAN.md` section 2 |
| 10 Indian design partners next | `docs/SUBMISSION.md`, Roadmap, next 30 days |
| 75% of India SaaS revenue from global sales, FY2020 | Nasscom via The News Minute, https://www.thenewsminute.com/atom/indias-saas-industry-achieved-35-billion-revenue-fy2020-nasscom-129351 (verified 2026-11-03) |
| Agent builders need budgets and receipts | `research/03-market-competitors.md` section 4.1 |
| Escrow on delivery and an audit in 90 days | `docs/SUBMISSION.md`, Roadmap, next 90 days |
| Contracts on HashKey Chain Testnet and Ethereum Sepolia, Circle USDC on Sepolia | The live runs; addresses and hashes in `SHOTLIST.md`, Fill-in log |
| Demo agents run DeepSeek V3.1 through Replicate with the business's own Replicate token; Anthropic, OpenAI, Google Gemini, OpenAI-compatible (OpenRouter and similar) and Replicate are supported | The coordinator's run notes (2026-11-03; full live Sepolia run passed); `apps/agent/README.md` (Replicate default model `deepseek-ai/deepseek-v3.1`); `docs/AGENTS.md` section 1 lists all five providers; `packages/models/src/providers/replicate.ts` |
| Buyer buys a live HSK quote from Market Data (CoinGecko), then pays the seller's market-brief skill, which writes only from that quote | The coordinator's run notes (2026-11-03) |
| Live runs confirmed at the latest head | A testnet demo setting; production waits for the `safe` head (`README.md`, Built for HashKey Chain) |

The longer go-to-market brief for Q&A (ideal customers, channels, pricing, 90 days, risks) is in `SCRIPT.md`, section D, and in `PITCH.md`.
