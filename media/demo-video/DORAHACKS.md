# DoraHacks BUIDL update draft (for review, not submitted)

This updates the build text in `docs/SUBMISSION.md` with what the live runs now show.
Paste only after the founder has checked every line against the running product.

## Name

Payminto

## Tagline

Get paid in stablecoins by people and AI agents, on your own server.

## Short description

Payminto is a self-hosted, non-custodial stablecoin gateway: one link that people pay at checkout and AI agents pay over HTTP 402.
Agents spend through on-chain mandates, their per-call charges are netted into a few transfers on HashKey Chain, and every call is provable.

## Video

https://youtu.be/G2QipGsU6ZM (unlisted YouTube; text in `media/demo-video/YOUTUBE_SHORT.md`).

## What is new in this build

- **Merchant AI agents on the business's own key.**
  The demo agents run DeepSeek V3.1 through Replicate with the business's own Replicate token; the full live Sepolia run passed every check (clearing, gateway and AI), and the buyer's note quoted the live HSK price it bought.
  The same agents run on Anthropic, OpenAI, Google Gemini, any OpenAI-compatible endpoint such as OpenRouter, and Replicate, so the business picks the provider and pays it directly.
  Every agent task is a run with a queue, leases, retries, polling and webhooks.
- **A three-party agent payment chain.**
  A buyer agent buys a live HSK quote from a Market Data service (CoinGecko), then pays a seller agent's AI market-brief skill and hands it that quote.
  The brief is written only from those figures.
  All three parties are paid with signed vouchers under mandates, netted, and settled on chain, and a receipt proof for the call verifies against the batch root.
- **Ops agent for the back office.**
  It answers "what did we earn today" from real payments and requests refunds; a human approves, and the refund is sent gasless.
- **Reconciliation report.**
  One CSV per business and date range with every payment, fee, refund, on-chain transaction and proof.
- **HSP.**
  Every net transfer in a settlement is wrapped as an HSP wire-v1 payment bound to the batch.
  HashKey's live HSP Agentic Payment server has not allowlisted our server's IP yet, so a server pointed at it shows the HSP payment method as "Waiting for HSP access", and our own HSP adapter checks the transfers today.

## Live on testnets

The live runs passed every check on HashKey Chain Testnet (chain 133) and Ethereum Sepolia (Circle testnet USDC).
For the demo, confirmations are taken at the latest block, a testnet setting; production waits for the safe head.
Testnet tokens have no value, and there is no mainnet deployment yet.

| Item | HashKey Chain Testnet (133) |
|---|---|
| ClearingHub | `0x53E4B5712fEeD40dd6597F0A50cC14C063186e81` |
| DepositFactory | `0xcBAFd928dF0C40EDccEC7b82bCaee4a6Ae0E094b` |
| PaymentRouter | `0x1e0f2223D61BF9831fa0b009AE741c3F5E898F0e` |
| Payminto Test USDC | `0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15` |
| Clearing settlement | https://testnet-explorer.hskchain.net/tx/0xebef334562fc83fb4403f55c7e588c08bb9dc60f1b78e1ffb0eeb80350bb51ad |
| Wallet payment | https://testnet-explorer.hskchain.net/tx/0x7a1fb3961cc99184f433c452934bd307d0108abfb75466af7de9d68894ab1493 |
| x402 agent payment | https://testnet-explorer.hskchain.net/tx/0xab0057b48145d14e14ac2f2b2d306a4bd238fa89ec270590e25b9e604eeecd8f |
| Mandate opened | https://testnet-explorer.hskchain.net/tx/0x0cf7b987e4bdc5ebb91ebad22144324c35d5fe7cd52f6e5913112ee131e63a63 |
| Voucher batch | https://testnet-explorer.hskchain.net/tx/0x349d3b32fb0f9eea972f5aa46c234926e2ae97cd9e26c7ea1847525b4527a281 |
| Gasless refund | https://testnet-explorer.hskchain.net/tx/0x33d833ffa7153f7a10e201743e90daba13ae1b3745d67d39584969b4f5a78c76 |
| AI skill settlement | https://testnet-explorer.hskchain.net/tx/0x5b0733e7c2ca0a0613924197d6f64a2c451c8da869f504a6a945a6ca48df173f |

| Item | Ethereum Sepolia (same contract addresses) |
|---|---|
| Settlement | https://sepolia.etherscan.io/tx/0xe9170a444bfa4f8164d051e5dc0deeff75238ffc56efd13bb3abf63e5e443c2b |
| AI skill settlement | https://sepolia.etherscan.io/tx/0x3c3c5c21609367dd261d800a1e5db49dba84a4a02c812adb2beaa216ab2bd88f |
| Refund | https://sepolia.etherscan.io/tx/0x73cfb26ba441b06bda2f6f515598a253c460df154c274191036f038a1a26e722 |

The deployed bytecode was checked against this repository's build on both chains.
The sources are not verified on the HashKey testnet Blockscout yet: it rejects the verification upload as too large (HTTP 413).

## Links

| Link | Value |
|---|---|
| Repository | https://github.com/sagarjethi/payminto-clearing |
| Demo video | https://youtu.be/G2QipGsU6ZM |
| Track | Agent Payments and A2A Settlement |
| Run your own | Clone the repo and paste into Claude Code: "Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A." |

## Product screenshots to capture (8)

Capture at 1920x1080, light theme, testnet badge visible, no secrets on screen.
`record/` can take these with Playwright once `record/config.json` has the live IDs.

| # | Route | State | What it proves |
|---|---|---|---|
| 1 | `http://localhost:3000/l/<slug>` | Hosted checkout for one link, before paying, showing the price and the payment methods (wallet, deposit, HSP waiting) | One link for people; HSP is a real, labelled payment method |
| 2 | `http://localhost:3000/payments/<PAYMENT_ID>` | A paid payment with its fee breakdown and the HashKey Chain Testnet transaction | Non-custodial payment with the fee split on chain in the same transaction |
| 3 | `http://localhost:3000/settings/ai` | The Replicate connection active on deepseek-ai/deepseek-v3.1, token shown by its last characters only, with the provider list open | Bring your own model key, any major provider |
| 4 | `http://localhost:3000/mandates/<MANDATE_ID>` | A mandate with its caps, allowed payees, spent amount and at least one refusal by rule | Agent budgets enforced below the model |
| 5 | `http://localhost:3000/netting` | The flow graph after the three-party run: buyer to Market Data and buyer to the market-brief seller | Agent-to-agent payments, netted |
| 6 | `http://localhost:3000/batches/<BATCH_ID>` | A settled batch with calls, claims, net transfers and the HSP status of each transfer | Settlement on HashKey Chain with HSP-wrapped transfers |
| 7 | `http://localhost:3000/receipts/<CALL_ID>` | One call's receipt with its Merkle proof verified on chain | Any single call is provable after netting |
| 8 | `http://localhost:3000/agents/runs/<RUN_ID>` | The ops agent's run answering "what did we earn today", with its tool calls and the refund request | A real AI agent running the back office, with a human approving refunds |
