# Hub v2 and any-chain checkout: plan

Status: proposed on 2026-11-10, for the product owner's approval.
Deadline: 2026-11-14 23:59 UTC (NEAR HACKATHON development ends).

## Why

Two goals for the last four days.

1. A hub contract that holds up to an external audit: the internal audit's findings fixed, one module per invariant, one guard per role, an event for every state change, and a build anyone can reproduce.
2. A drop-in checkout where a buyer pays from any chain and the merchant receives USDC on NEAR, through NEAR Intents (the 1Click API).
   It answers the `realworld` and `business` tracks directly: "merchant payments and stablecoin rails", "cross-chain payments via NEAR Intents".

## Inputs

- Internal contract audit, 2026-11-10: 8 findings, 8 confirmed with proof-of-concept tests.
  No double payout, no unchecked value arithmetic, no callable callback, no hub-paid storage, no voucher replay.
  High: F1, the node and the hub verify ed25519 signatures with different rules, so an owner can make vouchers the node accepts and the hub refuses.
  Medium: F2 (the same for node acceptances), F4 (the settler pays permanent storage for every new Budget and payee pair).
  Low: F3 (weak public keys accepted), F5 (a revoke right after expiry cuts the 3-day grace to 24 h), F6 (batch ids are global).
  Info: F7 (`amount` not bound to the cumulative step), F8 (the wasm embeds the builder's home path, so the hash reproduces on one machine only).
- 1Click research, 2026-11-10, checked live against the docs, OpenAPI 0.1.10 and free dry quotes.
  Base URL `https://1click.chaindefuser.com`; `GET /v0/tokens`, `POST /v0/quote`, `GET /v0/status`, `POST /v0/deposit/submit`.
  Native USDC on NEAR is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals.
  A dry `EXACT_OUTPUT` quote for 5 USDC from Base USDC asked the buyer for 5.010154, and the merchant receives exactly 5.000000.

No hub has been deployed on testnet or mainnet: every run deploys the committed `contracts-near/out/hub.wasm` on a fresh local chain.
So a hub v2 costs a rebuild and new hashes in the docs, not a migration.

## Stream 1: hub v2 (contract team: NEAR contract engineer, Rust engineer, payments reviewer)

Contract (`contracts-near`):

- Module split with the public ABI unchanged except where a fix below changes it: `auth`, `budgets`, `settlement`, `payouts`, `storage`, `checkout`, `admin`, `views`, `events`, `crypto`, with `encoding`, `netting`, `types`, `errors` kept.
- One guard per role (admin, owner, settler, payee, token, self-callback, anyone), each returning a typed context, and a test that calls every method as every wrong caller.
- NEP-297 events for every state change (`budget_opened`, `budget_funded`, `budget_revoked`, `batch_settled`, `claim_settled_by_payee`, `payout_started`, `payout_finished`, `payment_received`, and the admin and storage events).
- Every panic a code from `errors.rs`.
- F3: refuse small-order and non-canonical keys in `open_budget` and `register_receipt_key`.
- F5: refuse `revoke_budget` after `valid_until`.
- F6: key batches by settler and batch id.
- F7: require `amount <= cumulative step`.
- F4: the owner prepays settlement storage for its Budget's payees at `open_budget`, and `prune` returns storage after the deadline; the settler no longer funds other people's pairs.
  The contract team confirms the exact rule and its gas before building it; if it does not fit in the time, the node policy below ships and F4 stays documented.
- Refuse `fund_storage` for the hub and token accounts.
- Drop `wee_alloc` (`near-sdk` with `default-features = false`): closes the last Dependabot alert.
- F8: a reproducible build with no home paths in the wasm, and the right cargo-near version in `Cargo.toml`.
- Rebuild `out/hub.wasm`, rerun the sandbox tests and the gas profile, and update every hash and gas number in the docs.

Off-chain (TypeScript):

- F1, F2: one hub-exact ed25519 verifier in `packages/chain`, used by the node's voucher intake, the SDK's acceptance check and the wallet, with shared vectors (torsioned R, non-canonical R and A, small-order A, `s >= L`) that the Rust and TypeScript tests both read.
- The node pre-verifies every claim with that rule before it builds a batch, so one bad claim never fails a batch.
- F4 node policy: a minimum first payment to a new payee and a cap on new payees per Budget per hour.
- The simulated hub (`FakeChain`) follows every new contract rule, so `pnpm demo` and `pnpm swarm` keep matching the sandbox.

Then a pre-audit: a fresh reviewer who has not seen this work audits hub v2 from the code alone; its findings are fixed or documented before submission.

## Stream 2: any-chain checkout (payments team: gateway engineer, NEAR Intents engineer, backend, frontend)

Buyer flow, on the existing hosted checkout:

1. "NEAR wallet" stays first and unchanged; a second tab "Any chain" appears when the merchant turned it on.
2. One list of token and chain pairs with indicative prices from dry quotes; pairs the API refuses are greyed with the reason in plain words.
3. One field: the refund address on that chain (1Click requires it).
4. One button: "Get deposit address".
5. "Send exactly 5.010154 USDC on Base", with copy buttons, a QR code, a countdown, the fee lines from the signed quote and a plain warning about wrong tokens, networks and late deposits.
6. Live steps: waiting, received, converting, delivered; then the existing success screen with links to both transactions, or a clear returned or failed screen.

Merchant side:

- One setting: "Accept any chain (NEAR Intents)", which needs a NEAR mainnet payout account that exists, is registered with USDC and is proven by a signed message.
- The payment page shows a NEAR Intents card; webhooks add `payment.deposit_returned` and `payment.deposit_failed`; reconciliation adds origin and settlement columns.
- Drop-in: one script tag and one button with `data-payminto-link`, which opens the hosted checkout in a popup; the link alone still works with no code.

Backend:

- `packages/near-addons/src/intents`: the pay-in quote builder, its checks (signature, fields, `minAmountOut == amount`, recipient, deadline), status mapping, fee lines and a fake 1Click server that follows the live wire shapes.
- Node: migration 007 (additive only), an intents service, a status poller built like the existing payment watcher, five public checkout routes, two merchant routes and a platform status route; the node loads `@payminto/near-addons` only when `INTENTS_CHECKOUT` is on.
- `pnpm local` runs the fake 1Click server, which delivers real mock USDC on the local chain, so the node's on-chain delivery check runs for real; a guide step and a `--check` step cover it.
- A `quote-in` command shows live dry quotes for the demo.

## Decisions taken by the principal engineer (the product owner can overrule any)

- The buyer pays the swap cost (`EXACT_OUTPUT`): the merchant always receives the invoice amount.
- Money goes straight to the merchant's own NEAR mainnet account: non-custodial, no hub credit, no payout step.
- First origins: USDC on Base, Ethereum, Arbitrum, Solana and Polygon; USDT on Ethereum; ETH on Base and Ethereum. Not Bitcoin (the quote signature check fails on Bitcoin quotes today), Tron or BNB (high minimums).
- No 1Click partner key for now (allowed by rule Q-006); fees are always shown from the signed quote, never a constant.
- Payminto takes no fee on this rail.
- The team's code never requests a real deposit address from the live API during development: only dry quotes, and the fake server for everything else.
  Live mode is an operator flag, labeled "Live - NEAR mainnet" everywhere.
- Merchant refund to the buyer's origin chain is a stretch goal; until then the refund page explains the manual step.
- The unused `oneclick_quotes` table stays; nothing is dropped.

## Human steps (real funds or mainnet keys; never done by the team)

- Optional, for the video: a separate dev NEAR mainnet account registered with USDC, a signed ownership message, and one real payment of 1 to 2 USDC from Base with `INTENTS_CHECKOUT=live`.
  Without it, the video shows the simulated path and a live dry quote, and the README says the live path has not run.
- Push, the demo post on X and the submission, as before.

## Schedule

- 2026-11-11: the shared verifier and vectors (F1, F2); contract module split, guards and events; near-addons checkout builders and the fake server; migration 007 and the intents service.
- 2026-11-12: contract fixes F3 to F8 and wee_alloc, new wasm, sandbox tests and gas profile; checkout routes, poller and the buyer screens.
- 2026-11-13: pre-audit of hub v2 and its fixes; merchant settings, webhooks, reconciliation, embed; `pnpm local` and `--check` for the any-chain path.
- 2026-11-14: full verification and CI on GitHub, README and the walkthrough, the optional human mainnet run, the tag, push and submission.

Each stream works on its own branch, test first, and merges only after the full suite, `pnpm demo`, `pnpm swarm`, `pnpm local --check` and the sandbox runs pass.

## Not in scope

- A mainnet hub, or moving the clearing node to mainnet.
- Bitcoin, Tron and BNB as origins.
- An iframe overlay instead of the popup.
- An external audit (the pre-audit prepares for it).
