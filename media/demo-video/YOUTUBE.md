# YouTube packaging draft (for review, not posted)

Positioning in one line: a self-hosted payment gateway for AI agents, and for people.
Payminto lets a business get paid by humans and AI agents on its own server; agents pay per call inside a budget and pay each other, settled on HashKey Chain.
Everything below is true to what the video shows: testnet only, no mainnet claim, and no number that is not on screen.

## Title options (all under 70 characters)

| # | Title | Characters | Trend it rides |
|---|---|---|---|
| 1 | My AI agent paid another AI agent. Nobody held the money. | 57 | Agents paying agents; no middleman |
| 2 | AI agents paying AI agents, on a server you own | 47 | Agents paying agents; self-hosted |
| 3 | HTTP 402 is back: watch AI agents pay per call | 46 | x402 and HTTP 402 returning |
| 4 | I gave an AI agent a wallet with a hard budget | 46 | AI agents with wallets |
| 5 | An AI agent that can only pay who you allow | 43 | Prompt injection cannot redirect money |
| 6 | A payment gateway for AI agents that you host yourself | 54 | "Payment gateway for AI agents" framing, no company named |
| 7 | No middleman: get paid by people and AI agents | 46 | Self-hosted, no middleman |
| 8 | x402 in action: one AI agent buys from another | 46 | x402; agent-to-agent commerce |
| 9 | Agentic payments on HashKey Chain, live on testnet | 50 | Agentic payments |
| 10 | AI agents with budgets: pay per call, settle on chain | 53 | AI agents with wallets; pay per call |

**Top pick: #1, "My AI agent paid another AI agent. Nobody held the money."**
It is a first-person story with a twist in the second sentence, and it names the trend (agents paying agents) and the promise (no custody) in plain words anyone can repeat.

**Runner-up: #3, "HTTP 402 is back: watch AI agents pay per call."**
"X is back" headlines pull developers who remember the unused 402 status code, and "watch" promises a working demo rather than a talk.

Truth notes:
- #1: the buyer agent pays the seller agent's market-brief skill (S13), settled wallet to wallet by contracts that never hold funds (S05, S14).
- #5: the mandate's allowed-payees list and the refusal by rule are on screen in S12; the video does not stage an injection attack, so the title promises the rule, not an attack demo.
- #3 and #8: agent calls use the x402 v2 HTTP 402 flow (S07, and the "x402 agent payment" transaction in S26).
- No title mentions mainnet, a user count or a volume.

## Thumbnail

File: `thumbnail.png` (1280x720), built from `thumbnail/index.html` with HyperFrames (`npx hyperframes snapshot --at 0.5` in `thumbnail/`).
Concept: huge "AGENTS PAY AGENTS" on the left with "PAY" in a cobalt block; two of our own agent tiles on the right with a USDC coin travelling between them; "Self-hosted. No middleman." in amber; an "Inside a hard budget" tag; "Live on testnet" in small caps.
Only Payminto's own mark and our own drawn graphics are used: no other company's logo and no mocked-up product screens.
It pairs with title #1: the thumbnail states the claim, the title tells the story.

## First 5 seconds of the video

The S01 title card now reads "Hi there, this is Payminto" over "My AI agent paid another AI agent. Nobody held the money.", matching title #1, while the voice says "Hi there, and welcome. This is Payminto."
If title #3 is chosen instead, change the S01 `title` in `video/build.mjs` to "HTTP 402 is back: watch AI agents pay per call" and run `node video/build.mjs .` from `media/demo-video`.

## Description

My AI agent paid another AI agent, inside a hard budget, and nobody held the money.
Payminto is a self-hosted payment gateway for people and AI agents, settled on HashKey Chain (testnet in this demo).

What you will see:
- A customer pays a payment link in test USDC on HashKey Chain Testnet.
- The business brings its own model key; this demo runs DeepSeek V3.1 through Replicate (Anthropic, OpenAI, Google Gemini and OpenAI-compatible providers such as OpenRouter also work).
- A buyer agent buys a live HSK quote from a market data service, then pays a seller agent's market-brief skill with that quote: three parties, one chain of payments.
- Every tiny charge is netted into a few wallet-to-wallet transfers on chain, and any single call can be proven later.
- An ops agent answers "what did we earn today", requests a refund that a human approves, and finance gets one reconciliation report.

Chapters:
0:00 Hi, and a story from Pune
0:19 The problem
0:36 Meet Payminto
0:57 Why now
1:09 Live demo: one link, paid on testnet
1:28 The business's own model key
1:38 Buyer agent and its budget
2:02 Agent pays agent
2:16 Netting and HSP on HashKey Chain
2:39 Proof, ops agent, refund and report
3:06 Investor pitch
3:52 Go to market
4:28 On chain
4:44 Close

Run your own: clone the repository, open your AI coding agent in it, and paste:
"Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A."

Code (MIT): https://github.com/sagarjethi/payminto-clearing

On chain, HashKey Chain Testnet (chain 133):
- Agent calls netted and settled: https://testnet-explorer.hskchain.net/tx/0xebef334562fc83fb4403f55c7e588c08bb9dc60f1b78e1ffb0eeb80350bb51ad
- AI agent paying another agent's skill: https://testnet-explorer.hskchain.net/tx/0x5b0733e7c2ca0a0613924197d6f64a2c451c8da869f504a6a945a6ca48df173f
- Customer wallet payment: https://testnet-explorer.hskchain.net/tx/0x7a1fb3961cc99184f433c452934bd307d0108abfb75466af7de9d68894ab1493
- x402 agent payment: https://testnet-explorer.hskchain.net/tx/0xab0057b48145d14e14ac2f2b2d306a4bd238fa89ec270590e25b9e604eeecd8f
- Budget (mandate) opened: https://testnet-explorer.hskchain.net/tx/0x0cf7b987e4bdc5ebb91ebad22144324c35d5fe7cd52f6e5913112ee131e63a63
- Voucher batch: https://testnet-explorer.hskchain.net/tx/0x349d3b32fb0f9eea972f5aa46c234926e2ae97cd9e26c7ea1847525b4527a281
- Gasless refund: https://testnet-explorer.hskchain.net/tx/0x33d833ffa7153f7a10e201743e90daba13ae1b3745d67d39584969b4f5a78c76
- ClearingHub contract: https://testnet-explorer.hskchain.net/address/0x53E4B5712fEeD40dd6597F0A50cC14C063186e81

On chain, Ethereum Sepolia (same contract addresses, Circle testnet USDC):
- Settlement: https://sepolia.etherscan.io/tx/0xe9170a444bfa4f8164d051e5dc0deeff75238ffc56efd13bb3abf63e5e443c2b
- AI skill settlement: https://sepolia.etherscan.io/tx/0x3c3c5c21609367dd261d800a1e5db49dba84a4a02c812adb2beaa216ab2bd88f
- Refund: https://sepolia.etherscan.io/tx/0x73cfb26ba441b06bda2f6f515598a253c460df154c274191036f038a1a26e722

Honest note: everything here runs on testnets (HashKey Chain Testnet and Ethereum Sepolia), testnet tokens have no value, and there is no mainnet deployment yet.
For the demo, confirmations are taken at the latest block; production settings wait for the safe head.
HashKey's live HSP server has not allowlisted our server yet, so today our own HSP adapter checks each HSP-wrapped transfer.
The narration is a generated voice.
Built for the HashKey Chain Horizon Hackathon, Mumbai edition, Track 2: Agent Payments and A2A Settlement.
Market sources for the pitch are listed in the repository under media/demo-video/MASTER_SCRIPT.md.

#AIagents #AgenticPayments #x402 #HashKeyChain #SelfHosted

## Tags

Payminto, AI agents, agentic payments, agent to agent payments, AI agent wallet, x402, HTTP 402, pay per call, self-hosted payment gateway, non-custodial, stablecoin payments, USDC, HashKey Chain, HSP, MCP, DeepSeek, Replicate, prompt injection, hackathon, DoraHacks

## Upload settings to choose

- Visibility: unlisted until the founder reviews it.
- Captions: upload an SRT built from `audio/audio_meta.json`, or correct "Payminto" and "HashKey" in YouTube's auto-captions.
- End screen: the repository link.
