# YouTube packaging for the short cut

Video: `renders/payminto-demo-short.mp4` (2:49), published unlisted at https://youtu.be/G2QipGsU6ZM.
Same title style as `YOUTUBE.md`; everything below is true to what this cut shows, with no mainnet claim and no number that is not on screen.

## Title options (all under 70 characters)

| # | Title | Characters |
|---|---|---|
| 1 | My AI agent paid another AI agent. Nobody held the money. | 57 |
| 2 | One prompt installs a payment gateway for AI agents | 51 |
| 3 | AI agents paying AI agents, on a server you own | 47 |
| 4 | HTTP 402 is back: watch AI agents pay per call | 46 |
| 5 | Paste one line, run your own AI agent payment gateway | 53 |

**Top pick: #1**, the same title as the long cut, so both videos read as one story.
It is a first-person story with a twist, and names agents paying agents and no custody in plain words.

**Runner-up: #2, "One prompt installs a payment gateway for AI agents."**
This cut ends on the self-host step, and "one prompt installs it" is the newest, most shareable claim, shown on screen with the exact line.
Truth note: the prompt makes a coding agent follow `docs/SELF_HOST.md`, which installs and runs Payminto locally; a fresh agent with no context did this from a clean clone.

## Thumbnail

Reuse `thumbnail.png` ("AGENTS PAY AGENTS / Self-hosted. No middleman.").
For title #2, change the headline in `thumbnail/index.html` to "ONE PROMPT. YOUR OWN GATEWAY." and re-run `npx hyperframes snapshot --at 0.5` in `thumbnail/`.

## Description

My AI agent paid another AI agent, inside a hard budget, and nobody held the money.
Payminto is a self-hosted payment gateway for people and AI agents, settled on HashKey Chain, and one prompt to your coding agent installs it.

What you will see:
- A customer pays a payment link in test USDC on HashKey Chain Testnet, with the platform fee split on chain.
- The business brings its own model key; this demo runs DeepSeek V3.1 through Replicate (Anthropic, OpenAI, Google Gemini and OpenAI-compatible providers such as OpenRouter also work).
- The buyer agent spends inside a budget: caps, allowed services, refusals by rule.
- It buys a live HSK quote from a market data service, then pays a seller agent's market-brief skill with that quote.
- Sixty charges are netted into a few wallet-to-wallet transfers in one transaction on HashKey Chain, and any single call is proven on chain.
- An ops agent answers from real payments, requests a refund that a human approves, and finance gets one reconciliation report.
- Self-host: clone the repo, open Claude Code or any coding agent, paste one line.

Chapters:
0:00 Hi, this is Payminto
0:11 What it is
0:25 People pay a payment link
0:39 AI agents: your own model key and a budget
1:00 The buyer agent pays another agent
1:23 Settlement on HashKey Chain, and proof
1:53 Back office: ops agent, refund, report
2:14 Self-host with any AI agent
2:38 Close

Run your own: clone the repository, open Claude Code or any coding agent in it, and paste:
"Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A."

Code (MIT): https://github.com/sagarjethi/payminto-clearing

On chain, HashKey Chain Testnet (chain 133):
- Agent calls netted and settled: https://testnet-explorer.hskchain.net/tx/0xebef334562fc83fb4403f55c7e588c08bb9dc60f1b78e1ffb0eeb80350bb51ad
- AI agent paying another agent's skill: https://testnet-explorer.hskchain.net/tx/0x5b0733e7c2ca0a0613924197d6f64a2c451c8da869f504a6a945a6ca48df173f
- Customer wallet payment: https://testnet-explorer.hskchain.net/tx/0x7a1fb3961cc99184f433c452934bd307d0108abfb75466af7de9d68894ab1493
- x402 agent payment: https://testnet-explorer.hskchain.net/tx/0xab0057b48145d14e14ac2f2b2d306a4bd238fa89ec270590e25b9e604eeecd8f
- Budget (mandate) opened: https://testnet-explorer.hskchain.net/tx/0x0cf7b987e4bdc5ebb91ebad22144324c35d5fe7cd52f6e5913112ee131e63a63
- Gasless refund: https://testnet-explorer.hskchain.net/tx/0x33d833ffa7153f7a10e201743e90daba13ae1b3745d67d39584969b4f5a78c76
- ClearingHub contract: https://testnet-explorer.hskchain.net/address/0x53E4B5712fEeD40dd6597F0A50cC14C063186e81

On chain, Ethereum Sepolia (same contract addresses, Circle testnet USDC):
- Settlement: https://sepolia.etherscan.io/tx/0xe9170a444bfa4f8164d051e5dc0deeff75238ffc56efd13bb3abf63e5e443c2b
- AI skill settlement: https://sepolia.etherscan.io/tx/0x3c3c5c21609367dd261d800a1e5db49dba84a4a02c812adb2beaa216ab2bd88f
- Refund: https://sepolia.etherscan.io/tx/0x73cfb26ba441b06bda2f6f515598a253c460df154c274191036f038a1a26e722

Honest notes: everything here runs on testnets (HashKey Chain Testnet and Ethereum Sepolia), testnet tokens have no value, and there is no mainnet deployment yet.
For the demo, confirmations are taken at the latest block; production settings wait for the safe head.
HashKey's live HSP server has not allowlisted our server yet, so today our own HSP adapter checks each HSP-wrapped transfer.
Some screen recordings are sped up and say so on screen; waits were cut.
The narration is a generated voice.
Built for the HashKey Chain Horizon Hackathon, Mumbai edition, Track 2: Agent Payments and A2A Settlement.

#AIagents #AgenticPayments #x402 #HashKeyChain #SelfHosted
