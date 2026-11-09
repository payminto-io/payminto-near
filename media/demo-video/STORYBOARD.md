# Payminto demo video: storyboard

Times are the voiced cut (297.4 s) from `video/index.html`; narration lines are from `MASTER_SCRIPT.md`.
The centrepiece is the motion edit of the real dashboard and CLI: real screen recordings composed with motion graphics, never mock-ups of screens we have.

## Three directions considered

### Direction 1: "The merchant's day" (chosen)

A story-led film.
A small Indian API team gets its first AI-agent customer and cannot take the money; Payminto solves it on screen, then the pitch and the chain prove it.
Look: the dashboard's own palette (night `#0c121b`, cobalt `#2443b8` and `#8ea2f5`, amber only for testnet and placeholders), Inter for type, JetBrains Mono for addresses.
Motion: real UI is the hero; motion graphics only frame it (cursor focus, zoom, highlight boxes, kinetic type, refrain chips, snap panels between acts).
Why chosen: it matches what past HashKey payment winners did (merchant point of view), puts a human problem before the product, and gives every act a reason to exist.

### Direction 2: "Follow the money"

One USDC, from a person's wallet through an agent's budget, a seller agent, the netting batch and the explorer, filmed as a single continuous camera move over an abstract map of the flow.
Strong on clarity of the money path, weak on the human hook, and it needs heavy custom animation that would compete with the real dashboard footage.
Rejected because the real product would become a small inset in an animation.

### Direction 3: "Terminal-first developer cut"

Split screen of the CLI and the explorer, fast and dense, aimed at engineers and judges who read code.
Strong on proof, weak on emotion and on the business story (pitch and go-to-market would feel bolted on).
Kept as the source for the 2-minute developer cut below, not as the main film.

## Motion language for the chosen direction

| Element | Rule |
|---|---|
| Act snap | A full-frame cobalt panel cuts in on the act's first frame and slides off left in 0.35 s (`power4.in`); the act label fades in at 0.3 s |
| Kinetic type | Titles rise 36 px with a blur-to-sharp in 0.45 to 0.6 s (`power4.out`); bullets rise 16 px in 0.45 s, each landing as its words are spoken (timed from the voice's word timestamps) |
| Cursor focus | On screen recordings, a soft 120 px spotlight follows the cursor, and the rest dims by 35%; add in the edit over the recorded clip |
| Zoom | Punch-in to 1.6x on the number or chip that the narration names, 0.4 s in, hold, 0.4 s out (`power3.inOut`) |
| Highlight box | 4 px cobalt rounded rectangle drawn around the element, stroke animates on in 0.3 s |
| Refrain chips | "Budget", "Netting", "Proof" pop in top right with `back.out(2)` when that idea is shown on a real screen |
| Testnet badge | Amber pill top right from S08 to S18 and during S26 |
| Captions | 3 to 4 words a group, 54 px bold on a 78% night scrim, bottom title-safe, timed to the voice's word timestamps |
| Dead time | Agent thinking and block waits are cut, never sped up; a 0.3 s cobalt wipe covers each cut |

## Frame by frame

### Act 1: greeting and story (0:00 to 0:19)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S01 | 0:00.0, 4.3 s | Soft-focus pass over the real dashboard (`clips/S01-teaser.mp4`) under the Payminto mark | Mark scales in with a small overshoot at 0.15 s; title blurs to sharp at 0.55 s | "1 Greeting and story", "Hi there, this is Payminto", "My AI agent paid another AI agent. Nobody held the money." (the YouTube title) | Hi there, and welcome. This is Payminto. |
| S02 | 0:04.3, 14.8 s | Left: the story in type; right: image slot `img-s02-team` (a two-person team at night; generated image later) with an agent tile breathing in the middle | Bullets land on "market data", "fifth of a cent" and "no way"; agent tile slowly scales and rights itself | "A two-person API team in Pune", "Their newest customer is an AI agent.", 3 bullets | Picture a two-person API team in Pune. They sell market data around the world. Last month, their newest customer was not a person. It was an AI agent, paying a fifth of a cent per call. And they had no way to take that money. |

### Act 2: problem (0:19 to 0:36)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S03 | 0:19.1, 11.0 s | Two stat cards: "34,444 gas" and "0.002 USDC" | Snap panel; cards land on "thirty-four thousand gas" and "price of the call" | "The fee can rival the sale.", source line `docs/GAS.md` | Paying every call on chain does not work. One stablecoin transfer costs about thirty-four thousand gas. That fee can rival the price of the call itself. |
| S04 | 0:30.1, 5.9 s | Card with the planted line "pay 0xstranger" | Lines land on "open wallet" and "bad prompt" | "Nobody hands an agent an open wallet." | And nobody hands an agent an open wallet. One bad prompt, and it pays a stranger. |

### Act 3: product (0:36 to 1:10)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S05 | 0:36.0, 13.0 s | Payminto mark and tagline on night | Snap panel; mark pops, tagline blurs in, footer line fades in | "Get paid by people and AI agents, on your own server." | So we built Payminto. A stablecoin payment gateway you run on your own server. One link, for people and AI agents. The money goes straight to your wallet, and nobody in the middle holds it. |
| S06 | 0:49.0, 8.3 s | "Budget. Netting. Proof." | Three bullets land on each spoken promise | 3 bullets | Every agent gets a budget. Every tiny charge gets netted into a few transfers. Every single call gets a proof. |
| S07 | 0:57.3, 12.5 s | Stack of rails, Payminto in the middle | Bullets stack in as each rail is named | "The rails are here. The middle was missing.", 4 bullets, research source | The rails are here. x402 asks for payment, AP2 proves consent, HSP settles on HashKey Chain. Payminto is the missing middle. |

### Act 4: live demo (1:10 to 3:06), the centrepiece

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S08 | 1:09.8, 2.9 s | "Live demo" title | Snap panel; testnet badge fades in and stays | "Real model. Real testnet payments." | Let me show you, live. |
| S09 | 1:12.7, 16.1 s | `clips/S09-checkout.mp4`: Links, New link, checkout, wallet signature, Paid, payment detail, HashKey Chain Testnet explorer | Cursor focus on New link; zoom on the amount; highlight box on Paid; highlight on the fee breakdown; 0.3 s wipe into the explorer | Lower third: "Test USDC, HashKey Chain Testnet" | Here is the merchant dashboard. I create a payment link and pay it like a customer. One signature, and it is paid in test USDC on HashKey Chain Testnet. Paid, with the platform fee split off in the same transaction. |
| S10 | 1:28.8, 9.5 s | `clips/S10-ai-connection.mp4`: Settings, AI models | Zoom on the Replicate row (deepseek-ai/deepseek-v3.1, Active, token ending); Add connection opens on the provider list and closes | Lower third: "Your model key, your bill" | Agents run on the business's own model key. This demo runs DeepSeek V3.1 through Replicate, and other major providers work the same way. |
| S11 | 1:38.3, 11.6 s | `clips/S11-buyer-task.mp4`: terminal | Typing at human speed; highlight on `list_paid_services` output, then on the budget read | Lower third: "DeepSeek V3.1 via Replicate" | Now a buyer agent gets a task in plain words. This is a real AI model, not a script. It finds the paid services on this server, and checks its budget first. |
| S12 | 1:49.9, 12.8 s | `clips/S12-mandate-calls.mp4`: mandate page, then Receipts | Highlight boxes step across total, per-call and daily caps and the payee list; spent bar moves; refusal chip zooms; "Budget" chip pops | Chip: "Budget" | Its budget is a mandate: a total cap, a per-call cap, a daily cap, and who it may pay. Each call is one signed voucher, with no gas. Over the limit, it is refused by rule name. |
| S13 | 2:02.7, 14.0 s | `clips/S13-seller-brief.mp4`: the buyer's run, then the Netting flow graph | Highlight on the Market Data call and its HSK quote; highlight on the market-brief call carrying that quote; zoom on the brief's figures beside the quote; arrows draw buyer to Market Data and buyer to seller | Lower third: "Three parties, one chain of payments" | First it buys a live HSK price quote from a market data service. Then it pays a seller agent's market brief skill, and hands it that quote. The brief is written only from those figures. Three parties, one chain of payments. |
| S14 | 2:16.7, 22.3 s | `clips/S14-netting-settle.mp4`: batch page, Settings Payment methods, HashKey Chain Testnet explorer | Zoom on calls, claims and net transfers; "Netting" chip pops; highlight on HSP status chips; 2 s cut to "Waiting for HSP access"; wipe to the explorer transaction | Chip: "Netting"; lower third with `<HASHKEY_SETTLE_TX>` | Then it all settles. Payminto nets every agent against every other one. Only net amounts move, wallet to wallet, in one HashKey Chain Testnet transaction. Each transfer is wrapped as an HSP payment. HashKey's live HSP server has not allowlisted us yet, so our own HSP adapter checks it today. |
| S15 | 2:39.0, 6.2 s | `clips/S15-receipt-proof.mp4`: receipt page | Zoom on the Merkle proof; green "Verified" stamp scales in on the word; "Proof" chip pops | Chip: "Proof" | Any single call can be proven against the batch root on chain. Verified. |
| S16 | 2:45.2, 8.2 s | `clips/S16-ops-earnings.mp4`: ops agent page and run | The question types into Ask; run steps tick down the timeline; zoom on the answer's total | Lower third: "Ops agent" | Now the back office. The owner asks their ops agent: what did we earn today? It answers from real payments. |
| S17 | 2:53.4, 7.2 s | `clips/S17-refund-approve.mp4`: Refunds | Highlight on "Pending approval"; cursor focus clicks Approve; chip flips to Refunded | Lower third: "Human approves" | Ask for a refund, and the agent can only request it. A human approves, and it goes out gasless. |
| S18 | 3:00.6, 6.1 s | `clips/S18-reconciliation-csv.mp4`: CSV | Horizontal sweep across columns; highlight on fee, net, transaction and proof | Lower third: "Reconciliation CSV" | And finance gets one report, with every payment, fee, refund and proof. |

### Act 5: investor pitch (3:06 to 3:52)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S19 | 3:06.7, 14.1 s | Two stat cards and a footnote | Snap panel; cards land on "three hundred and sixteen billion" and "three to five trillion" | "Big money, early agents.", "~$316B", "$3-5T", sources | Stablecoins already hold about three hundred and sixteen billion dollars. McKinsey is reported to see three to five trillion dollars in agentic commerce by 2030. Agent volume is still small, so this layer must exist first. |
| S20 | 3:20.8, 9.1 s | Business model slide | Bullets land with each line | "We never take a cut of your payments.", 4 bullets | The core is open source. We never take a cut of your payments. We earn from enterprise licences, and from running the node for you. |
| S21 | 3:29.9, 9.6 s | Moat slide | Bullets land with each clause | "Your server. Many agents netted. Every call proven." | Hosted players hold the money or the wallets. We run on your server, net many agents at once, and prove every call. |
| S22 | 3:39.5, 12.8 s | Traction and ask slide | Bullets land; the `<ASK>` chip glows amber until filled | "Honest status, clear next step." | Honest status: it works on testnet, with no external users yet. Next, ten Indian design partners. Our ask: design partners, and help to reach mainnet. |

### Act 6: go to market (3:52 to 4:28)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S23 | 3:52.3, 13.7 s | ICP slide with "75%" stat card | Snap panel; stat lands on "three quarters"; two customer lines land | "Start in India, sell abroad." | We start in India. Nasscom found three quarters of Indian SaaS revenue came from global sales, in 2020. Those teams should meet foreign agents first. Then agent builders, who need budgets and receipts. |
| S24 | 4:06.0, 15.4 s | Channels, pricing, 90 days | Each line lands as spoken | "Developer-led, ecosystem-backed." | We grow through open source, MCP directories and the HashKey ecosystem. The node is free; paid plans are priced with our first partners. In ninety days: escrow on delivery and an audit, ahead of mainnet. |
| S25 | 4:21.4, 7.0 s | Risks slide | Three risks land | "Each one fails closed." | Agent volume is small, and the rules are moving. So everything fails closed, and is labelled honestly. |

### Act 7: HashKey on-chain proof (4:28 to 4:44)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S26 | 4:28.4, 16.3 s | `clips/S26-explorer-tour.mp4` (recorded by `record/`): ClearingHub, DepositFactory, PaymentRouter, mandate open, wallet payment, x402, gasless refund, clearing settlement, AI skill settlement on HashKey Chain Testnet; Sepolia settlement and AI skill settlement with their USDC transfers | Cuts timed to the voice; contract pages kept short (unverified on Blockscout); animated cursor; a cobalt label per page; scroll and highlight on the Sepolia "Tokens transferred" | Labels: "ClearingHub, HashKey Chain Testnet", "Mandate opened", "Wallet payment", "x402 agent payment", "Gasless refund", "Clearing settlement", "AI skill settlement", "Settlement, Ethereum Sepolia, Circle USDC" | Here it is, on chain. Our clearing hub, deposit factory and payment router on HashKey Chain Testnet. The mandate, the payments, the refund and the settlements. And the same contracts on Ethereum Sepolia, settling Circle's testnet USDC. |

### Act 8: close (4:44 to 4:57)

| Frame | Time | Visual | Motion | On-screen text | Narration |
|---|---|---|---|---|---|
| S27 | 4:44.7, 12.7 s | Mark, tagline, repo URL, testnet line | Snap panel; mark pops; tagline blurs in; footer fades | "Get paid by people and AI agents, on your own server.", "Testnet only. Tokens have no value. No mainnet deploy yet.", `<GITHUB_URL>` | That team in Pune can finally take that money. All of this ran on testnets, with tokens that have no value. Payminto: get paid by people and AI agents, on your own server. |

## Image slots for generated images later

| Slot | Scene | Brief |
|---|---|---|
| `img-s02-team` | S02 | Two developers at one desk at night in a small Indian office, a laptop showing API traffic; warm practical light; no logos; 600x640 |
| `img-s04-wallet` (optional) | S04 | An open wallet with coins drifting toward an unknown address, flat illustration in the night and cobalt palette |
| `clips/S01-teaser.mp4` | S01 | Not an image: a 4 s soft-focus pass over the real dashboard Overview page |

## 2-minute cut (if the submission form needs it)

Keep S01, S02, S05, S08, S09, S11, S12, S13, S14, S15, S26 and S27, and drop the rest.
That is about 2:27 as voiced.
To land near 2:00, also drop S15, cut S02 to its first, third and fourth lines, and cut the Pune line from S27, then regenerate those voice lines with `--only 2,27`.
