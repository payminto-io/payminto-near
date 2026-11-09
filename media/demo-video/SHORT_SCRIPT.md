# Payminto short cut: script

The product-only cut, built in `video-short/`, rendered to `renders/payminto-demo-short.mp4`.
Target 2:30 to 3:00, under 3:05.
The long cut (`MASTER_SCRIPT.md`, `video/`) is unchanged.
Same voice as the long cut: Fish Audio "Slax", speed 1.08, respelled "Pay Mint-oh" and "Hash Key".
Lines marked "reused" are the long cut's voice files, word for word; every other line is new and was transcribed to check it.
Header times are planned; the built cut's exact times are in `video-short/index.html` and in the report table at the end of this file.
Everything shown runs on testnets, and testnet tokens have no value.

### T01 - Hook (0:00, 10 s)

Section: Hook.
On screen: the Payminto mark, "Hi there, this is Payminto", and "AI agents pay each other. People pay you. On your own server."
Clip: none (title card).
Voice cue: [warm and friendly]

Narration:
- Hi there, this is Payminto.
- AI agents paying each other, and people paying a business, on a server that business owns, settled on HashKey Chain.

### T02 - What it is (0:10, 15 s)

Section: What it is.
On screen: the use-case diagram from the repository (`docs/img/hashkey-use-case.png`), sliding up and settling, with the line "Self-hosted. Non-custodial. One link for people and AI agents."
Clip: none (image card).
Voice cue: [confident]

Narration:
- Payminto is a payment gateway you run on your own server.
- One link works for people and for AI agents.
- The money goes straight to the business's wallet, with the fee split on chain, and nobody in the middle holds it.

### T03 - People pay (0:25, 17 s)

Section: People pay.
On screen: `clips/S09-checkout.mp4`: new link, hosted checkout, Paid, the fee split, the transaction.
Voice cue: [confident]

Narration:
- Here is the merchant dashboard.
- I create a payment link and open it like a customer would.
- One wallet signature, and it is paid in test USDC on HashKey Chain Testnet.
- The platform fee is split off in the same transaction.

### T04 - The business's own model key (0:42, 10 s)

Section: AI agents.
On screen: `clips/S10-ai-connection.mp4`: Settings, AI models, the Replicate connection on DeepSeek V3.1 and the provider list.
Voice: reused from the long cut, S10.

Narration:
- Agents run on the business's own model key.
- This demo runs DeepSeek V3.1 through Replicate, and other major providers work the same way.

### T05 - The budget (0:52, 13 s)

On screen: `clips/S12-mandate-calls.mp4`: the buyer agent's budget, its caps, its allowed services, its spend, and a refusal by rule.
Voice cue: [confident]

Narration:
- The buyer agent spends through a budget: a total cap, a daily cap, and the only services it may pay.
- Anything outside those rules is refused, and the refusal names the rule.

### T06 - The real buyer agent (1:05, 12 s)

On screen: `clips/S11-buyer-task.mp4`: the buyer agent's run in the terminal.
Voice cue: [curious]

Narration:
- Now the real buyer agent gets a task in plain words.
- It finds the paid services on this server, checks its budget, and pays per call, with no gas.

### T07 - Agent pays agent (1:17, 14 s)

On screen: `clips/S13-seller-brief.mp4`: the live HSK quote from Market Data, the paid market-brief skill, then the netting graph.
Voice: reused from the long cut, S13.

Narration:
- First it buys a live HSK price quote from a market data service.
- Then it pays a seller agent's market brief skill, and hands it that quote.
- The brief is written only from those figures.
- Three parties, one chain of payments.

### T08 - Settlement on HashKey Chain (1:31, 23 s)

Section: Settlement on HashKey Chain.
On screen: `clips/S14-netting-settle.mp4`: the settlement: 60 charges cleared, net transfers, HSP status, the transaction on chain.
Voice cue: [proud]

Narration:
- Then it all settles on HashKey Chain.
- Sixty charges are netted into a few transfers, wallet to wallet, in one transaction.
- Each transfer is matched to what was owed, and carries its HSP status.
- HashKey's live HSP server has not allowlisted us yet, so our own HSP adapter checks it today.

### T09 - One call, proven (1:54, 7 s)

On screen: `clips/S15-receipt-proof.mp4`: one call's receipt, its proof, "Verified on chain".
Voice: reused from the long cut, S15.

Narration:
- Any single call can be proven against the batch root on chain.
- Verified.

### T10 - Ops agent (2:01, 9 s)

Section: Back office.
On screen: `clips/S16-ops-earnings.mp4`: the ops agent answers "what did we earn today".
Voice: reused from the long cut, S16.

Narration:
- Now the back office.
- The owner asks their ops agent: what did we earn today?
- It answers from real payments.

### T11 - Refund with a human in the loop (2:10, 8 s)

On screen: `clips/S17-refund-approve.mp4`: the agent requests a refund; a human approves it.
Voice: reused from the long cut, S17.

Narration:
- Ask for a refund, and the agent can only request it.
- A human approves, and it goes out gasless.

### T12 - One report (2:18, 7 s)

On screen: `clips/S18-reconciliation-csv.mp4`: the reconciliation report.
Voice: reused from the long cut, S18.

Narration:
- And finance gets one report, with every payment, fee, refund and proof.

### T13 - Self-host: the one line (2:25, 10 s)

Section: Self-host with any AI agent.
On screen: a terminal-style card with the exact prompt: `Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A.`
Clip: none (terminal card; no mocked agent UI).
Voice cue: [excited]

Narration:
- And you can run all of this yourself.
- Clone the repository, open Claude Code or any coding agent, and paste this one line.

### T14 - Self-host: the guide (2:35, 14 s)

On screen: `clips/T14-self-host.mp4`, recorded by `record/` from the public repository: the README (the use-case image, "Watch the demo", the "With your AI coding agent" quickstart and its one line), then `docs/SELF_HOST.md`, Path A and its checks.
Voice cue: [confident]

Narration:
- It follows the self-host guide, installs Payminto, and runs your own node and dashboard locally, then on a testnet server.
- We tested it: a fresh agent with no context did it from a clean clone.

### T15 - Close (2:49, 10 s)

Section: Close.
On screen: the Payminto mark, "github.com/sagarjethi/payminto-clearing", "Live on HashKey Chain Testnet", and "Testnet only. Tokens have no value. No mainnet deploy yet."
Voice cue: [warm]

Narration:
- Payminto: get paid by people and AI agents, on your own server.
- Live on HashKey Chain Testnet, with test tokens that have no value.

## Sources for the claims

| Claim | Source |
|---|---|
| Self-hosted, non-custodial, fee split on chain, one link for people and agents | `README.md`, top section |
| Paid in test USDC on HashKey Chain Testnet | Wallet payment `0x7a1fb3961cc99184f433c452934bd307d0108abfb75466af7de9d68894ab1493` |
| DeepSeek V3.1 via Replicate with the business's own key; other providers supported | The coordinator's confirmed live Sepolia run (2026-11-03); `docs/AGENTS.md` section 1 |
| Budget caps, allowed services, refusal by rule | `README.md`, What it does; the S12 recording |
| Buyer buys a live HSK quote, pays the market-brief skill, brief uses only that quote | The coordinator's run notes (2026-11-03); the S13 recording |
| Sixty charges netted into a few transfers, matched, HSP status | The S14 recording (settlement page: "Charges cleared 60", net transfers "Matched") |
| HSP live server not allowlisted yet, own adapter checks | `README.md`, Status and honesty notes |
| Receipt proof on chain | `README.md`, How it works |
| Ops agent, refund request plus human approval, gasless refund, report | `docs/AGENTS.md`; `docs/GATEWAY.md`; the S16 to S18 recordings |
| Self-host with any coding agent, tested from a clean clone | `README.md`, Quickstart; `docs/SELF_HOST.md`; the coordinator's test of a fresh agent in a clean clone |

## Built cut (delivery render, 168.8 s)

| Scene | Start | Length | Voice | Picture |
|---|---|---|---|---|
| T01 Hook | 0:00.0 | 11.8 s | new | title card |
| T02 What it is | 0:11.8 | 13.7 s | new | use-case diagram |
| T03 People pay | 0:25.5 | 14.1 s | new | S09 at 1.16x |
| T04 Model key | 0:39.6 | 9.5 s | reused S10 | S10 at 1.02x |
| T05 Budget | 0:49.1 | 11.2 s | new | S12 at 1.16x |
| T06 Buyer agent | 1:00.3 | 9.6 s | new | raw S11: typing 5.5x (labelled "Sped up"), output at 1x, last frame held 1.7 s |
| T07 Agent pays agent | 1:09.9 | 14.0 s | reused S13 | S13 at 1.01x |
| T08 Settlement | 1:23.9 | 23.0 s | new | S14 at 1.18x, then 4 s of the S26 Sepolia settlement page |
| T09 Proof | 1:46.9 | 6.2 s | reused S15 | S15 at 1.01x |
| T10 Ops agent | 1:53.1 | 8.2 s | reused S16 | S16 at 1.01x |
| T11 Refund | 2:01.3 | 7.2 s | reused S17 | S17 at 1.01x |
| T12 Report | 2:08.5 | 6.1 s | reused S18 | S18 at 1.01x |
| T13 Self-host prompt | 2:14.6 | 9.6 s | new | terminal card with the exact prompt |
| T14 Self-host guide | 2:24.2 | 13.8 s | new | `record/out/T14-self-host.mp4`, last frame held 0.7 s |
| T15 Close | 2:38.0 | 10.8 s | new | closing card |

Speed-ups of 1.3x or less are not labelled; the fitted recordings keep their own on-screen "Sped up" labels where the earlier fit sped up a wait, and T06's typing carries its own label.
