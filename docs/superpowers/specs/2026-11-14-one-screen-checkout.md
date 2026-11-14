# One-screen checkout

Date: 2026-11-14.
Status: approved direction from Sagar ("direct 1 screen, people scan the QR and pay, no refund address, no steps").

## Why

Buyers did not know which address to send to.
The link page showed a QR of the page itself, then three more screens (choose a token, type a refund address, get an address), then a list of internal steps.
Research across nine crypto gateways (Coinbase, Stripe, BitPay, NOWPayments, Cryptomus, CoinPayments, MoonPay Commerce, Request, Daimo) says the same thing: show one payment target, only once it exists, with the amount, token, network and address together, and make "pay with a connected wallet" the easy path.
How NEAR Intents converts the money is our job, not the buyer's.

## Goals

- A buyer opens a payment link and sees, on one screen, the amount and a QR plus address that is ready to pay.
- The buyer can switch the chain they pay from (Base, Ethereum, Arbitrum, Solana, Polygon, and USDT or ETH) on the same screen.
- No refund address is asked for.
- No internal steps (deposit received, converting, delivered) are shown while waiting; one status line is enough.
- The deadline shown is the real one.

## Non-goals

- No new chains or tokens.
- No change to the hub contract, the NEAR wallet method or vouchers.
- No mobile deep links that rely on EIP-681 for ERC-20 tokens (unsafe, see the research notes in the checkout code).

## Anti-goals

- A QR that is not the payment target.
- A wallet asked to pay a simulated (fake) deposit address.
- Telling a buyer money "may be lost" at a time that is not the real deadline.

## Design

### Refunds without a buyer address

- `POST /v1/checkout/{id}/intents/quotes` takes `refund_to` as optional.
- Without it, the node asks 1Click for `refundType: "INTENTS"` with `refundTo` set to the business's verified NEAR account.
  A failed or short deposit then goes back to the business's NEAR Intents balance, and the business returns it to the buyer on request (the BitPay and NOWPayments pattern).
  1Click accepted this in a free dry quote on 2026-11-14, with a refund fee of 0.
- With `refund_to`, behaviour is unchanged (`ORIGIN_CHAIN`), so SDK and agent callers keep working.
- The quote stores `refund_type`; the API shows it; the dashboard says where a returned deposit went.
- One active quote per origin is allowed (8), so switching chains never hits the limit.

### Link page

- A fixed-amount link that asks for no email or name opens the checkout directly: the page creates the payment and replaces itself with `/pay/<id>`.
- A link that needs an amount, email or name keeps its short form, then opens the same checkout.

### Checkout (any-chain)

One screen, top to bottom:
1. The order (business, title, amount).
2. "Pay with": the token and chain picker, the business's default selected; each option shows the exact amount.
3. The send block: QR (bare address for tokens; a payment request only for native coins and Solana Pay), "Send exactly 1.501807 USDC on Base", the amount and address with copy buttons.
4. "Pay with your wallet" when the browser has an Ethereum wallet (live money only).
5. One status line: "Waiting for your payment" with the time left, then "Payment received, finishing up", then the success screen.
6. A folded "Details" section: fees, the wrong-deposit contact, "I've sent it" with a transaction hash, and where a returned deposit goes.

The quote for the selected chain is created as soon as the screen opens and when the buyer switches chain; addresses are reused per chain.

### Deadline

The time shown is the earlier of the quote's deadline and the payment's expiry, everywhere (countdown, warning text).

## Testing

- Unit: payment URI and EVM transaction builders; quote request with `INTENTS` refunds; the fake 1Click accepts it.
- Node API: a quote without `refund_to` is checked, stored with `refund_type`, reused, and shown to the merchant.
- Dashboard components: link auto-open, one-screen checkout (auto quote, chain switch, no refund field, no step list), wallet pay live only, deadline.
- Full suites: dashboard, node, protocol, near-addons, local, sdk, mcp; typecheck and lint.
- Local stack scripts: `pnpm local --check`, the demo and the sandbox demo.
- Browser, phone and desktop widths, against the live stack: open the link and see the QR on the first screen; switch chain; no money is sent by me.
- The live payment itself is done by Sagar.
