# Any-chain checkout: launch gaps and plan

Date: 2026-11-12.
Scope: the any-chain checkout (a buyer pays from another chain through NEAR Intents' 1Click API, the business receives USDC on NEAR), end to end for a real business and a real buyer, including running it outside `pnpm local`.
It builds on the approved design in `2026-11-10-hub-v2-and-any-chain-checkout-design.md`.

## How the gaps were found

- Live 1Click API, 2026-11-12: dry quotes from all eight offered origins (USDC on Base, Ethereum, Arbitrum, Solana and Polygon, USDT on Ethereum, ETH on Base and Ethereum) were signed, valid and passed every node check.
- A buyer walk-through on `pnpm local`: paid from Base, from Solana, a wrong refund address, a short deposit returned.
  Two defects found there are already fixed and tested (the short-deposit heading asked for the full amount again; the returned screen did not add up).
- Three read-only reviews: every buyer and business use case against the code and tests; the current 1Click docs and OpenAPI spec against our client; what live mode needs to run for real.
- The highest-impact claims were checked by hand in the code: refunds have no any-chain branch, the receipt email is never sent, the receipt reads the newest quote rather than the confirmed one, every business starts with the testnet wallet method on, and the 1Click client sets no per-request timeout.

## Use cases and where they stand

| Use case | Today |
|---|---|
| Buyer pays the exact amount | Works, tested, read on NEAR before "paid" |
| Short deposit, returned | Works, tested; the refund fee is only shown afterwards |
| Short deposit, then a top-up | Works in the 1Click kit; no node or screen test |
| Sends too much, or the price buffer comes back | Returned by 1Click, but shown to nobody on the buyer side, and stored as "refunded" on a paid invoice |
| Sends late | Watched 24 h past the deadline, then never seen |
| Wrong token or chain | Warning text only; no support path |
| Closes the tab, other device | Works |
| Pays twice (two addresses, or wallet and an address) | Ends `overpaid`; the receipt can name the wrong method |
| Payment expires while a deposit is in flight | Works |
| 1Click busy or down | Works for options; no alert to the operator |
| Email receipt | Promised on screen, never sent |
| Proof | Works; after 10 min without an RPC read it confirms on 1Click's word with only a log line |
| Business: enable, prove account, see status, webhooks | Works, tested |
| Business: refund an any-chain payment | Broken: builds a testnet hub transfer to `base:0x...`, which can never verify |
| Business: changes payout account with quotes open | Old quotes still pay the old account and count as paid |
| Business: payout account unregisters from USDC | Checkout keeps offering the method; delivery then fails after the buyer paid |
| Reconciliation export | Confirmed quotes only; returned and failed deposits missing |
| Operator: live mode outside `pnpm local` | Possible by config, but test money and real money share one invoice, live records are wiped by `pnpm local`, and nothing alerts on stuck quotes |

## Gaps, ranked

Size: S under 2 hours, M half a day, L a day or more.

### A. Money safety (before any real payment)

1. **A1 Real and test money on one invoice (M).**
   In live mode the hub is still testnet or the local sandbox, and every business starts with the `wallet` method on, so one invoice can be paid with real mainnet USDC or with free test USDC, and both count as Paid.
   Fix: decision Q2 below.
2. **A2 Refunds of any-chain payments are broken (S for a guard, L for a real refund).**
   Decision Q1 below.
3. **A3 `pnpm local` wipes live records on start (S).**
   It deletes the data directory with no check, so a live quote still processing is lost and nothing watches it.
   Fix: refuse to start, and say why, while the previous run holds a live quote that is not final; `pnpm local --reset` stays the explicit way out.
4. **A4 The receipt can name the wrong method (S).**
   The checkout reads the newest quote, not the one that paid.
   Fix: prefer the confirmed quote for `active_quote` once one exists.
5. **A5 Double payment while a deposit is in flight (S).**
   Fix: while an address has a deposit detected or processing, the NEAR wallet tab says a payment is already on its way and does not offer a second payment.
6. **A6 Payout account changes and unregistration (S).**
   Fix: changing the payout account expires open quotes that have no deposit yet; a quote that would create a deposit address re-reads `storage_balance_of` (cached a few minutes) and greys the option if the account is no longer registered.

### B. Buyer clarity

7. **B1 Refund fee before sending (S).** Add it to the fee lines on the deposit screen.
8. **B2 Excess and unused buffer (S).**
   On a paid invoice, show "Returned to you: X" on the receipt and call it "excess returned" for the business, not "refunded".
   The simulated 1Click server returns the unused buffer the way the docs describe, so this is tested.
9. **B3 Receipt email (M).** Decision Q3 below.
10. **B4 Wrong token or chain, very late deposits (S).**
    The deposit screen and the receipt name the business's support contact and the deposit address for the buyer to quote; the expired screen says the same.

### C. Live operation

11. **C1 1Click timeouts (S).** Per-request timeout in the client; the watcher polls quotes concurrently with a small cap, so one hung call never stalls the rest.
12. **C2 Silent fallbacks become alerts (M).**
    `provider_only` confirmations, quotes stuck past their window, a contradicted delivery and a 401 from 1Click (revoked key) each raise an operator alert (metric and platform alert event), not only a log line.
    A 401 stops retries instead of backing off forever.
13. **C3 Live mode applies production checks (S).**
    `INTENTS_CHECKOUT=live` turns on the same checks a public network does (admin token, password cost, https, private webhooks), warns at boot without `ONECLICK_API_KEY`, and warns when the mainnet RPC is the public default.
14. **C4 Reconciliation includes returned and failed deposits (S),** with the refund fee kept.
15. **C5 Self-host docs and Docker env for live mode (S):** the `INTENTS_*`, `GATEWAY_*` and `PUBLIC_CHECKOUT_URL` lines, and an operations section for any-chain (alerts, what to do with `provider_only`, backups).

### D. Tests that are missing

16. **D1** Node and screen tests for a top-up, an excess, a slippage refund (the simulated server learns to produce SLIPPAGE), `INTENTS_BUSY` on quote creation, a 401 from 1Click, and the payout-account change.

### Deferred, with reasons

- Chains that need a deposit memo (Stellar, XRP, TON): no offered origin needs one, and quotes with a memo are refused on purpose.
- Scheduled off-host backups: operations work for the self-hosting guide, not the checkout; documented as an operator step in C5.
- ANY_INPUT, orders and intent endpoints of 1Click: not needed for checkout.
- A mainnet hub: out of scope for this release (`docs/SELF_HOST.md`).

## Decisions for the product owner

- **Q1 Refunds of any-chain payments.**
  (a) Guard: the refund button explains that this payment came from another chain, shows the buyer's refund address and chain, and the business sends the refund from its own wallet; the node records it as manual.
  (b) Full: "Refund to Base through NEAR Intents", where the dashboard asks 1Click for a quote that delivers the refund to the buyer's address on its own chain, the business signs one USDC transfer on NEAR mainnet in its own wallet, and the node tracks it like a checkout quote.
  (b) is about a day of work on top of (a) and has never run live.
- **Q2 Test money next to real money in live mode.**
  (a) In live mode, checkout offers only Any chain; the NEAR wallet and voucher methods are hidden, so every Paid invoice is real money.
  (b) Keep both, label the wallet tab "Test money", and keep separate totals.
- **Q3 Receipt email.**
  (a) Send it: queue a receipt through the existing mailer when the payment is paid; locally it is written to the outbox log.
  (b) Remove the promise until email is configured.

## Decisions taken (2026-11-12)

- Q1: guard and manual refunds.
- Q2: any chain only in live mode.
- Q3: send the receipt email.
- Modes: one mode per server, Test or Live, chosen at start.
  Test: test tokens on a local or testnet hub, the NEAR wallet, Budgets and a simulated any-chain checkout, `sk_test_` keys, `livemode: false`, and an amber "Test mode: test tokens ... No real money moves." strip on every dashboard screen.
  Live: real USDC on NEAR mainnet from other chains through NEAR Intents (or a mainnet hub), `sk_live_` keys, `livemode: true` on every payment and event, production checks at boot, the test-money methods locked off, and a red "Live mode: real money ..." strip.
  The server says which in `/v1/info` `mode: { livemode, any_chain }`; `pnpm local` is Test and `pnpm local --intents live --intents-payout <account>` is Live.
  A Stripe-style switch between both on one server was considered and left out: several days of work across every table and screen.

## Order of work

1. A3, A4, A5, A6, B1, B2, C1 (small, independent, test first).
2. Q1, Q2 and Q3 as decided.
3. C2, C3, C4, B4.
4. D1 alongside each item, then C5 docs.
5. Walk every use case in the table again on `pnpm local`, then the full verification matrix (typecheck, all tests, lint, dashboard build, demo, contract suite unchanged, sandbox suites, `pnpm local --check`, Docker).

Done means: every row of the use-case table either works and has a test, or is listed as deferred with its reason; `pnpm local --check` covers the top-up, excess, refund guard and live-mode separation; nothing in this list touches mainnet or signs a transaction.
