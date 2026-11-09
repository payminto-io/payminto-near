# Payminto demo video: shot list

Every scene in `MASTER_SCRIPT.md`, with what to record, where, the file name and the length.
Scenes marked "card" or "slide" are built in the HyperFrames project (`video/`) and need no recording.
Record every clip at 1920x1080, 30 fps, H.264 MP4, no system audio (the voiceover is separate).
Record each clip 2 seconds longer than its scene on both ends, so the edit has handles.
Save every clip under `media/demo-video/clips/` with the exact file name below.

## Before recording

- Dashboard at http://localhost:3000, signed in as the merchant (and as the platform owner where noted).
- Browser window exactly 1920x1080 content area, zoom 110% to 125% so text reads on a phone, bookmarks bar and extensions hidden, one tab only.
- Terminal: 1920x1080, font size 20 or larger, dark theme, prompt shortened to `$ `, history cleared.
- Use the same light or dark dashboard theme in every clip.
- No real secrets on screen: model keys show only their last four characters; never show `ADMIN_TOKEN`, `.env`, a private key, or a full API key.
- Every on-screen amount is testnet money; leave the network badge visible where the dashboard shows it (Settings, Network).
- Write down every transaction hash, address, payment id, batch id and call id as you go: `MASTER_SCRIPT.md` lists the placeholders they fill.

## Shots

Scene ids and lengths match `MASTER_SCRIPT.md` and the voiced cut in `video/index.html` (297.4 s).
"Length" is what to record, including a 2-second handle at each end; the cut uses the middle.

| Scene | Type | What to record | Where | File | In the cut | Length |
|---|---|---|---|---|---|---|
| S01 | screen (teaser) | A slow scroll of the dashboard Overview with live numbers, no clicks; it plays soft-focus behind the greeting | `http://localhost:3000/` | `clips/S01-teaser.mp4` | 4.3 s | 8 s |
| S02 to S07 | motion graphics | - | HyperFrames `s02` to `s07` (image slot `img-s02-team` in S02) | - | 65.5 s | - |
| S08 | motion graphics | - | HyperFrames `s08` | - | 2.9 s | - |
| S09 | screen | Create a link (title "Market dataset", amount 2 USDC), open its checkout as a customer, pay with a browser wallet in test USDC on HashKey Chain Testnet, wait for Paid, open the payment detail with the fee breakdown, click the transaction to open the explorer | `http://localhost:3000/links/new`, `http://localhost:3000/l/<slug>`, `http://localhost:3000/payments/<PAYMENT_ID>`, `https://testnet-explorer.hskchain.net/tx/<WALLET_PAYMENT_TX>`; harness `record/shots/S09-checkout.mjs` | `clips/S09-checkout.mp4` | 16.1 s | 21 s (cut dead waits) |
| S10 | screen | Settings, AI models: the Replicate connection (deepseek-ai/deepseek-v3.1, Active, token ending only, this month's usage); open Add connection to show the provider list (Anthropic, OpenAI, Google Gemini, OpenAI-compatible such as OpenRouter, Replicate), then close it without saving | `http://localhost:3000/settings/ai`; harness `record/shots/S10-ai-connection.mjs` | `clips/S10-ai-connection.mp4` | 9.5 s | 15 s |
| S11 | terminal | Buyer agent on DeepSeek V3.1 through Replicate with the business's own `REPLICATE_API_TOKEN` exported before recording (never typed on screen): `PAYMINTO_AGENT_PROVIDER=replicate pnpm agent run "<TASK>"`; keep the directory listing and the budget read. Record the terminal with a screen recorder, or replay the run log with `record/shots/S11-buyer-task.mjs` | repo root terminal | `clips/S11-buyer-task.mp4` | 11.6 s | 16 s |
| S12 | screen | The buyer's mandate page while the run pays: caps, allowed payees, expiry, spent bar moving; then Receipts filling; include one refusal with its rule name | `http://localhost:3000/mandates/<MANDATE_ID>`, `http://localhost:3000/receipts` | `clips/S12-mandate-calls.mp4` | 12.8 s | 17 s |
| S13 | screen | The same buyer run: the paid call to Market Data (live HSK quote from CoinGecko), then the paid call to the seller's market-brief skill with that quote; the brief's figures next to the quote; then the Netting page with buyer to Market Data and buyer to seller | run page or terminal, then `http://localhost:3000/netting`; harness `record/shots/S13-seller-brief.mjs` | `clips/S13-seller-brief.mp4` | 14.0 s | 18 s |
| S14 | screen | Settle, open the batch (calls, claims, net transfers, HSP status chips), 2 s on Settings, Payment methods showing HSP "Waiting for HSP access", then the HashKey Chain Testnet settlement | `http://localhost:3000/batches/<BATCH_ID>`, `http://localhost:3000/settings/methods`, `https://testnet-explorer.hskchain.net/tx/0xebef334562fc83fb4403f55c7e588c08bb9dc60f1b78e1ffb0eeb80350bb51ad`; harness `record/shots/S14-netting-settle.mjs` | `clips/S14-netting-settle.mp4` | 22.3 s | 27 s |
| S15 | screen | One call's receipt from the batch, the Merkle proof, verify, hold on "Verified" | `http://localhost:3000/receipts/<CALL_ID>` (or the public proof page `http://localhost:3000/receipt/<id>`) | `clips/S15-receipt-proof.mp4` | 6.2 s | 10 s |
| S16 | screen | Ops agent: type "what did we earn today" in Ask, the run timeline steps, the answer | `http://localhost:3000/agents/<OPS_AGENT_ID>`, `http://localhost:3000/agents/runs/<RUN_ID>` | `clips/S16-ops-earnings.mp4` | 8.2 s | 12 s (cut model wait) |
| S17 | screen | Ask the ops agent to refund order `<REFERENCE>`; Refunds shows Pending approval; a human clicks Approve; Refunded. The business's refund approval rule must be on | `http://localhost:3000/agents/<OPS_AGENT_ID>`, `http://localhost:3000/refunds` | `clips/S17-refund-approve.mp4` | 7.2 s | 11 s |
| S18 | screen | Payments, Download report for today, open the CSV, sweep across method, fee, net, transaction and proof columns | `http://localhost:3000/payments` (endpoint `GET /v1/reports/reconciliation?from=&to=&format=csv`) | `clips/S18-reconciliation-csv.mp4` | 6.1 s | 10 s |
| S19 to S25 | slides | - | HyperFrames `s19` to `s25` | - | 81.7 s | - |
| S26 | screen (recorded) | Explorer tour timed to the voice: ClearingHub, DepositFactory, PaymentRouter (short: Blockscout shows them unverified), mandate open, wallet payment, x402, gasless refund, clearing settlement, AI skill settlement on HashKey Chain Testnet, then the Sepolia settlement and AI skill settlement with their USDC transfers. Sepolia pages use eth-sepolia.blockscout.com because sepolia.etherscan.io shows a bot check to headless browsers | `node record/run.mjs S26` | `clips/S26-explorer-tour.mp4` | 16.3 s | 20.3 s |
| S27 | motion graphics | - | HyperFrames `s27` | - | 12.7 s | - |

Recorded clips: 12 files; S26 is already recorded by `record/`.
Cursor focus, zooms, highlight boxes and refrain chips are added in the edit (see `STORYBOARD.md`, Motion language), so record with a plain cursor and no zoom.

## Putting a clip into the video

Each recorded scene has a slot in `video/index.html` with a commented `<video>` line under its scene host.
When a clip exists:

1. Copy it to `video/assets/clips/` with the same file name (for example `video/assets/clips/S09-sepolia-checkout.mp4`).
2. In `video/index.html`, uncomment that scene's `<video>` line; it is already `muted`, timed to the scene, and skips the 2-second head handle with `data-media-start="2"`.
3. From `video/`, run `npx hyperframes check --json` and `npx hyperframes snapshot --at <scene midpoint>` to confirm the clip covers the slot.
4. If `node video/build.mjs .` is re-run later (for example after a voice change), it rewrites `index.html`: uncomment the clip lines again.

## Fill-in log

Filled from the live runs on 2026-11-03; stack IDs are filled in `record/config.json` when the live stack is up.

| Item | Value |
|---|---|
| `<TASK>` | Get a live HSK quote and buy a market brief written only from it (confirm the exact wording of the recorded run) |
| `<PAYMENT_ID>` / `<slug>` | live stack |
| `<WALLET_PAYMENT_TX>` (HashKey Chain Testnet) | `0x7a1fb3961cc99184f433c452934bd307d0108abfb75466af7de9d68894ab1493` |
| x402 agent payment (HashKey Chain Testnet) | `0xab0057b48145d14e14ac2f2b2d306a4bd238fa89ec270590e25b9e604eeecd8f` |
| `<MANDATE_ID>` / `<MANDATE_OPEN_TX>` | live stack / `0x0cf7b987e4bdc5ebb91ebad22144324c35d5fe7cd52f6e5913112ee131e63a63` |
| Voucher batch (HashKey Chain Testnet) | `0x349d3b32fb0f9eea972f5aa46c234926e2ae97cd9e26c7ea1847525b4527a281` |
| `<BATCH_ID>` / `<HASHKEY_SETTLE_TX>` | live stack / `0xebef334562fc83fb4403f55c7e588c08bb9dc60f1b78e1ffb0eeb80350bb51ad` |
| AI skill settlement (HashKey Chain Testnet) | `0x5b0733e7c2ca0a0613924197d6f64a2c451c8da869f504a6a945a6ca48df173f` |
| Gasless refund (HashKey Chain Testnet) | `0x33d833ffa7153f7a10e201743e90daba13ae1b3745d67d39584969b4f5a78c76` |
| Settlement (Ethereum Sepolia) | `0xe9170a444bfa4f8164d051e5dc0deeff75238ffc56efd13bb3abf63e5e443c2b` |
| AI skill settlement (Ethereum Sepolia) | `0x3c3c5c21609367dd261d800a1e5db49dba84a4a02c812adb2beaa216ab2bd88f` |
| Refund (Ethereum Sepolia) | `0x73cfb26ba441b06bda2f6f515598a253c460df154c274191036f038a1a26e722` |
| `<N_CALLS>` / `<N_CLAIMS>` / `<N_TRANSFERS>` | live stack (batch page) |
| `<CALL_ID>` | live stack |
| `<OPS_AGENT_ID>` / `<RUN_ID>` | live stack |
| `<REFERENCE>` (refunded order) | live stack |
| ClearingHub (133 and Sepolia) | `0x53E4B5712fEeD40dd6597F0A50cC14C063186e81` |
| DepositFactory (133 and Sepolia) | `0xcBAFd928dF0C40EDccEC7b82bCaee4a6Ae0E094b` |
| PaymentRouter (133 and Sepolia) | `0x1e0f2223D61BF9831fa0b009AE741c3F5E898F0e` |
| Payminto Test USDC (133) | `0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15` |

Explorer base URLs: HashKey Chain Testnet `https://testnet-explorer.hskchain.net/tx/<hash>`; Ethereum Sepolia `https://sepolia.etherscan.io/tx/<hash>` for people, `https://eth-sepolia.blockscout.com/tx/<hash>` for the headless recorder.
Confirmations in the live runs were taken at the latest head, a testnet demo setting; say so if it comes up.
