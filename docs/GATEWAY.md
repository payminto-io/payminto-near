# Payminto Gateway - build spec

Payminto Gateway is the self-hosted payment gateway that sits next to Payminto Clearing in the same node, dashboard and contract set.
A merchant shares one link, and both people and AI agents can pay it.
People open the link in a browser and get a hosted checkout.
Agents request the same link and get an HTTP 402 they can pay over x402.
Every payment lands directly in the merchant's own wallet: the node never holds funds or private keys of payers or merchants.
This file is the contract between everyone building the gateway.
If something here is wrong, fix it here first, then in code.

What it reuses from the earlier Payminto gateway (`../backend`, `../checkout`):
- The payment state machine (open, partially paid, paid, overpaid, expired) and the locked "sum confirmed deposits, then pick the state" step, done in token base units instead of USD floats.
- Per-payment deposit addresses with conditional-update idempotency, rebuilt as keyless CREATE2 forwarders instead of HD-derived hot keys.
- HMAC webhooks with a retry schedule, fixed: a timestamped signature, one delivery row per attempt, and a transactional outbox.
- Hashed API keys shown once.
- The hosted checkout flow and its pieces: QR with an EIP-681 URI, copy address and amount, countdown, progress, terminal states, live status over SSE.

What it deliberately leaves out: fiat and card rails, KYC, referrals, BTC and Tron, multi-asset pricing, custody (hot or cold wallets), products and carts.

## 1. Scope and units

- One merchant per node (self-hosted, single tenant). The node operator is the merchant.
- One token per node: the node's configured `TOKEN` (USDC.e on HashKey mainnet, USDC on testnet, MockStablecoin locally).
- All amounts are decimal strings of token base units (6 decimals), like the rest of the node. Display currency is the token symbol, shown as USD-equivalent only in copy, never converted.
- The gateway is enabled when `GATEWAY_PAYOUT_ADDRESS` is set. It is env-only on purpose: a stolen dashboard session must not be able to redirect payouts.

## 2. Contracts

### 2.1 `DepositFactory` and `DepositForwarder` (new, `contracts/src/`)

A keyless per-payment deposit address that can only ever pay the merchant.
Superseded by the fee-splitting version in section 14.2: the signatures below are the first, fee-free version and are kept only as history.

- `DepositForwarder` is an EIP-1167 clone implementation with `initialize(address payout)` (callable once, only by the factory) and `flush(address token) returns (uint256 amount)` which transfers its whole token balance to `payout` and emits `Flushed(token, amount)`. It also has `flushNative()` (emits `Flushed(address(0), amount)`) and a `receive()` so HSK sent by mistake is not stuck. Both are permissionless, and a zero balance is a no-op (returns 0, no event) so an early or repeated flush never reverts.
- `DepositFactory` deploys the implementation in its constructor and exposes:
  - `implementation() view returns (address)`.
  - `addressOf(address payout, bytes32 salt) view returns (address)` - `Clones.predictDeterministicAddress(impl, keccak256(abi.encode(payout, salt)))`.
  - `flush(address payout, bytes32 salt, address token) returns (address forwarder, uint256 amount)` - permissionless; deploys and initializes the clone in the same call if it has no code, then flushes. Emits `ForwarderDeployed(payout, salt, forwarder)` once.
  - `flushNative(address payout, bytes32 salt) returns (address forwarder, uint256 amount)` - the same for HSK.
- The payout is part of the CREATE2 salt, so a forwarder address is bound to exactly one payout: nobody (including the node operator) can redirect funds sent to it.
- Per-payment `salt = keccak256(abi.encode("payminto.deposit.v1", chainId, paymentId))`, encoded as `(string, uint256, string)` with `paymentId` the id string (`depositSalt` in `packages/protocol/src/gateway.ts`).
- Deployed deterministically through the canonical CREATE2 deployer with salt `keccak256("payminto.deposits.v1")`, next to the hub; `contracts/deployments/<chainId>.json` gains `depositFactory`, `depositFactoryBlock` and `depositForwarderImplementation` (so `predictForwarder` needs no RPC). `Deploy.s.sol` keeps a hub or factory that already exists at its address, so the factory can be added to a chain where the hub is live.

### 2.2 `MockStablecoin` (local only)

Gains EIP-3009 exactly as FiatToken v2 does it: `transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`, `authorizationState(address,bytes32)`, events `AuthorizationUsed` and `AuthorizationCanceled`, EIP-712 typehashes identical to Circle's.
Both the `(v, r, s)` and the FiatToken v2.2 `bytes signature` overloads exist, with Circle's revert strings and check order (balance errors are OpenZeppelin's custom errors).
USDC.e on HashKey mainnet and USDC on testnet already support EIP-3009; `verify:hashkey` checks `authorizationState` on both and that both `transferWithAuthorization` overloads exist (verified live 2026-11-01: both chains run FiatToken v2.2 semantics).
The local mock's EIP-712 domain is `("USD Coin", "1")`, Circle's USDC on HashKey testnet is `("USD Coin", "2")`, Payminto Test USDC on HashKey testnet is `("Payminto Test USDC", "1")`, Circle's USDC on Sepolia is `("USDC", "2")` and USDC.e is `("Bridged USDC", "2")`.
Never hard-code it: the node reads it from the token and checks it against `DOMAIN_SEPARATOR()` at startup (`ChainClient.tokenMeta`), and `chains.ts` holds the known ones.

## 3. Payment methods

| Method id | Who | How | Gas paid by |
|---|---|---|---|
| `wallet` | Person with a browser wallet | Signs an EIP-3009 `TransferWithAuthorization` from payer to the payment's forwarder; the node relays `transferWithAuthorization`, then flushes. | Node operator |
| `deposit` | Person paying from an exchange or any wallet | Sends the token to the payment's forwarder address (QR, copy, or "send from wallet" button). | Payer, plus operator for the flush |
| `x402` | Agent with a plain wallet | Standard x402 `exact` scheme: the agent signs the same EIP-3009 authorization and retries with `PAYMENT-SIGNATURE`. | Node operator |
| `voucher` | Agent with a Payminto mandate | Existing `payminto-voucher` scheme against the merchant's provider record; funds move at the next clearing batch. | Node operator (batch) |
| `hsp` | Person or agent through HashKey's HSP | Signs the EIP-712 data HSP prepares; HSP's gateway sends the transfer to the payment's forwarder (section 16). | HSP gateway, plus operator for the flush |

EIP-3009 binding: superseded by section 14.2. Every customer payment goes to the payment's fee-splitting deposit forwarder, the only destination of customer money.
The `wallet` method signs a `TransferWithAuthorization` to the forwarder for the remaining amount, valid until the payment's `expires_at`, with the deterministic nonce `walletPaymentNonce(paymentRef, amount_paid)` = `keccak256(abi.encode("payminto.wallet.v1", paymentRef, amount_paid))` (`checkoutTransferTemplate` and `walletTransferAuthorization` in `gateway.ts`); the node relays it gaslessly, credits the Transfer, then flushes the forwarder like any deposit.
The forwarder address commits to payout, fee recipient, fee and amount due, so the payer's signature still binds the fee split.
`x402` pays the same forwarder with the client's own nonce. `paymentNonce` and `checkoutAuthorization` are gone from `gateway.ts`.
The node verifies the signature off chain (recover against the token's EIP-712 domain), checks the payer's balance, simulates, then relays through the existing serial operator sender.

An agent that holds a mandate must pay with `voucher`, never `x402`: only the voucher path is checked against the owner's policy (caps, allowlist, expiry).
The MCP server therefore only offers voucher payments.

## 4. Payment lifecycle

Payment id: `pay_` + 24 lowercase base32 characters (15 random bytes). Link id `plink_`, refund `re_`, webhook endpoint `we_`, event `evt_`, delivery `whd_`, API key `key_`.

States:

| Status | Meaning |
|---|---|
| `open` | Waiting for money. |
| `processing` | Money seen (relayed tx included, deposit seen, or voucher accepted) but not yet final. |
| `partially_paid` | Confirmed total is above zero and below the amount due, before expiry. |
| `paid` | Confirmed total equals the amount due. Terminal. |
| `overpaid` | Confirmed total is above the amount due. Terminal; the excess is shown and refundable. |
| `underpaid` | Expired while partially paid. Terminal; refundable. |
| `expired` | Expired with nothing confirmed. Terminal unless money arrives late. |
| `canceled` | Merchant canceled while `open`. Terminal unless money arrives late. |

Rules:
- `amount_paid` is always the sum of confirmed credits, in one `BEGIN IMMEDIATE` transaction that also writes the status change and the webhook outbox row.
- Confirmed means the credit's block is at or below the node's finality tag (`CONFIRM_TAG`, default `safe`), exactly like settlements. A credit whose block disappears in a reorg is dropped before it is confirmed.
- A deposit that arrives after `expired` or `canceled` is still credited (the money is already the merchant's) and moves the payment to `paid`, `overpaid` or `underpaid` with `late = 1`.
- Credits are unique by `(tx_hash, log_index)`; replays are no-ops.
- `wallet` and `x402` authorizations are refused once the payment is terminal or expired; `deposit` cannot be refused, which is why late credits exist.
- Expiry default `CHECKOUT_TTL_SECONDS = 1800`; API callers may pass `expires_in` between 300 and 604800.

Detection:
- `wallet` and `x402`: the node owns the relay tx; it reads the receipt, checks `AuthorizationUsed(payer, nonce)` and the `Transfer` to the payout, and credits it. A signed authorization can be submitted by anyone, so if the relay reverts with "authorization is used or canceled" the node must look up the `AuthorizationUsed(payer, nonce)` log and credit that transaction instead of failing the payment.
- `deposit`: a watcher polls `eth_getLogs` for `Transfer(_, to)` where `to` is any open, recent or late-window forwarder, in chunks of at most 5,000 blocks from a stored cursor, starting at the factory deploy block. Watched set: all non-terminal payments plus terminal ones for 7 days. After a credit is confirmed, a flush job calls `DepositFactory.flush` (batched per forwarder, retried with backoff); the flush is housekeeping and does not change payment state.
- `voucher`: the payment is `processing` when the voucher is accepted and becomes `paid` when the clearing batch containing it is confirmed.

## 5. Payment links

Fields: `id`, `slug` (8 url-safe characters, unique), `title`, `description`, `amount` (fixed, base units) or `null` with `min_amount` and `max_amount` (payer chooses), `collect_email` (bool), `collect_name` (bool), `success_url`, `active`, `max_payments` (optional), `created_at`, plus counters (`payments_count`, `paid_total`).
Link URL: `${PUBLIC_CHECKOUT_URL}/l/${slug}`.

One link, two audiences:
- A browser (`Accept` includes `text/html`) gets the hosted link page, which collects amount, email and name as configured, creates a payment and moves to `/pay/{paymentId}`.
- Anything else (an agent, curl, an x402 client) is proxied by the dashboard's `proxy.ts` to the node's `GET /v1/pay/l/{slug}`, which answers `402 Payment Required` with a `PAYMENT-REQUIRED` header listing `exact` (EIP-3009) and, if the merchant has a provider record, `payminto-voucher`. Open-amount links require `?amount=` in base units. On retry with `PAYMENT-SIGNATURE` the node creates the payment, relays or books it, and answers `200` with a JSON receipt and a `PAYMENT-RESPONSE` header carrying `paymentId`, `status` and `txHash`.
- The same works for a single payment: `${PUBLIC_CHECKOUT_URL}/pay/{paymentId}`.

## 6. Refunds

Refunds are non-custodial: the merchant's payout wallet sends them; the node only tracks and verifies.
- `POST /v1/refunds {paymentId, amount, reason?, to?}` creates a `pending` refund. `to` defaults to the payer address recorded on the credit. `amount <= amount_paid - refunded`.
- The dashboard executes it by asking the connected payout wallet to sign an EIP-3009 authorization (gasless, the node relays; `nonce = keccak256(abi.encode("payminto.refund.v1", chainId, refundId))`, `refundNonce` in `gateway.ts`) or, as a fallback, to send a plain `transfer`; it then posts `POST /v1/refunds/{id}/submit` with `{authorization}` or `{txHash}`.
- The node verifies that the transfer is from the payout, to `to`, for exactly `amount`, and confirmed; then the refund is `succeeded`. `failed` and `canceled` are the other terminal states.
- Payments carry `amount_refunded` and `refund_status` (`none`, `partial`, `full`).

## 7. Webhooks

- Endpoints: `url`, `description`, `events` (list or `*`), `active`, `secret` (`whsec_` + 32 random bytes base64url, shown at creation and on explicit reveal; rotatable).
- Events: `payment.created`, `payment.processing`, `payment.partially_paid`, `payment.paid`, `payment.overpaid`, `payment.underpaid`, `payment.expired`, `payment.canceled`, `refund.succeeded`, `refund.failed`.
- Body: `{"id":"evt_...","type":"payment.paid","created":<unix>,"livemode":<bool>,"data":{"object":<the full public payment or refund object>}}`.
- Header `Payminto-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. The HMAC key is the whole secret string including `whsec_`, as UTF-8. Receivers reject `t` more than 300 s from their clock in either direction and accept the header if any `v1` matches (`signWebhook` and `verifyWebhook` in `gateway.ts`, constant-time compare). Also sent: `Payminto-Event-Id`, `Payminto-Event-Type`.
- Transactional outbox: the event row is written in the same transaction as the state change; a worker delivers per endpoint.
- Attempt schedule: immediately, then 1 m, 5 m, 30 m, 2 h, 6 h, 24 h; after that the delivery is `failed`. Success is any 2xx within 10 s. Every attempt is one row with status code, duration and the first 2 KB of the response body.
- Manual resend from the dashboard or `POST /v1/webhook-deliveries/{id}/retry`; `POST /v1/webhooks/{id}/test` sends a `ping` event.
- SSRF guard: on chains 133 and 177, URLs must be `https` and must not resolve to private, loopback or link-local addresses. Locally (31337) `http://localhost` is allowed.

## 8. HTTP API

Auth:
- Merchant API: `Authorization: Bearer sk_test_...` (31337, 133) or `sk_live_...` (177). Keys are stored as SHA-256, shown once, revocable, with `last_used_at`. The admin token is also accepted.
- Key management (`/v1/api-keys`) needs the admin token.
- Public checkout routes need no auth and are rate limited per IP like the other public routes.
- `Idempotency-Key` header on `POST /v1/payments`, `POST /v1/links` and `POST /v1/refunds`: same key and body within 24 h returns the stored response; same key, different body is `409 IDEMPOTENCY_MISMATCH`.
- Errors use the node's existing `{error: {code, message}}` shape.
- Objects are snake_case. Amounts are decimal strings of base units, `*_at` fields are ISO 8601 strings like the rest of the node, and only the webhook envelope's `created` is unix seconds. The exact shapes (`Payment`, `Credit`, `PaymentLink`, `Refund`, `WebhookEndpoint`, `WebhookEvent`, `WebhookDelivery`, `ApiKey`, `MerchantProfile`, `CheckoutView`) are the exported types in `packages/protocol/src/gateway.ts`; change them there first.

Merchant routes:

| Route | Purpose |
|---|---|
| `POST /v1/payments` | `{amount, description?, reference?, customer_email?, customer_name?, metadata?, success_url?, expires_in?}` returns the payment with `checkout_url`. |
| `GET /v1/payments` | Filters `status`, `link_id`, `email`, `q` (id, reference, payer), `limit`, `cursor`. |
| `GET /v1/payments/{id}` | Payment with `credits` (each tx), `refunds` and `events` (timeline). |
| `POST /v1/payments/{id}/cancel` | Only while `open`. |
| `POST /v1/links`, `GET /v1/links`, `GET /v1/links/{id}`, `PATCH /v1/links/{id}` | Links; PATCH changes `title`, `description`, `active`, `success_url`, `max_payments`. |
| `POST /v1/refunds`, `GET /v1/refunds`, `GET /v1/refunds/{id}`, `POST /v1/refunds/{id}/submit`, `POST /v1/refunds/{id}/cancel` | Refunds. |
| `POST /v1/webhooks`, `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, `PATCH /v1/webhooks/{id}`, `DELETE /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/rotate-secret`, `POST /v1/webhooks/{id}/test` | Endpoints. |
| `GET /v1/webhooks/{id}/deliveries`, `POST /v1/webhook-deliveries/{id}/retry` | Delivery log. |
| `POST /v1/api-keys`, `GET /v1/api-keys`, `DELETE /v1/api-keys/{id}` | Admin token only. |
| `GET /v1/merchant`, `PATCH /v1/merchant` | Profile: `name`, `support_email`, `brand_color`, `logo_url`; read-only `payout`, `token`, `deposit_factory`, `checkout_base_url`. |
| `GET /v1/gateway/overview` | Volume, counts by status, conversion, last 30 days by day. |

Public routes:

| Route | Purpose |
|---|---|
| `GET /v1/checkout/{paymentId}` | Public payment view: merchant profile, amounts, status, `deposit_address`, `expires_at`, accepted methods, the EIP-3009 typed data to sign, token domain. Never metadata or email. |
| `GET /v1/checkout/{paymentId}/events` | SSE: `status` events with the public view. |
| `POST /v1/checkout/{paymentId}/authorize` | `{payer, signature}` for the `wallet` method; returns `processing` and `txHash`. |
| `POST /v1/checkout/{paymentId}/email` | Lets the payer add a receipt email while `open`, only when none is set (`409 EMAIL_ALREADY_SET`); it never replaces the merchant's or an earlier one. |
| `GET /v1/links/public/{slug}` | Public link view. |
| `POST /v1/links/public/{slug}/payments` | `{amount?, email?, name?}` creates a payment from the link. |
| `GET /v1/pay/l/{slug}`, `GET /v1/pay/{paymentId}` | x402 endpoints described in section 5. |

Every public object carries `livemode` (true only on 177).

## 9. Dashboard and hosted checkout

Same Next.js app (`apps/dashboard`), so one self-hosted deploy serves both.
- Public, no sign-in: `/l/[slug]` (link page) and `/pay/[id]` (checkout, success and terminal states), styled with the merchant `brand_color`, mobile-first, with a "Secured by Payminto" footer.
- Checkout: summary column (merchant, title, amount, reference), method tabs `Wallet` (connect injected EIP-1193 wallet, switch or add the HashKey chain, sign, done) and `Send manually` (QR with EIP-681 `ethereum:<token>@<chainId>/transfer?address=<forwarder>&uint256=<amount>`, copy address, copy amount, network warning), countdown, live status over SSE, success screen with tx link and "Return to merchant" when `success_url` is set.
- `proxy.ts` sends non-HTML requests for `/l/*` and `/pay/*` to the node's x402 routes, so the link a merchant shares is the same for people and agents.
- Merchant pages (signed in): a Gateway group with Payments (list, detail with timeline, credits, refunds), Payment links (list, create, detail with share sheet: copy, QR, agent snippet), Refunds; a Developers group with API keys and Webhooks (endpoints, deliveries, retry, test); Settings gains the merchant profile and gateway contracts. The Overview shows gateway volume next to clearing.
- UI follows `apps/dashboard/docs/DESIGN_REFERENCES.md` (section "Gateway (checkout, links, developers)").

## 10. SDK, MCP and demo

- `@payminto/sdk` adds `GatewayClient({nodeUrl, apiKey, merchantId?})` (payments, links, refunds, webhooks, screening and the directory with a merchant key; merchants, fee plans, the platform and API keys with the admin token; `Idempotency-Key` through `{idempotencyKey}`), `verifyWebhook` re-exported, `constructEvent(rawBody, header, secret)` which throws `WebhookSignatureError` on a bad signature and returns the parsed event, `signPayoutProof(account, merchantId, {chainId, hub})` for payout proofs, and `payExact(url, {account, maxAmount})` for plain x402 agents (returns the parsed `PAYMENT-RESPONSE`).
- `AgentClient.fetch` pays `payminto-voucher` 402s. When a 402 lists two voucher requirements for the same resource and asset with different payees (merchant net and platform fee, section 14.2), it signs one voucher per payee in one `{vouchers: [...]}` header: both payees must be on the mandate allowlist, the combined price is held against the per-call cap, and both are reserved against the daily and total caps before either is signed. A single requirement is paid exactly as before.
- MCP: `list_paid_services` reads the directory (section 13.4, falling back to `/v1/providers` on a node without the gateway), and `pay_link(url, amountAtomic?)` pays through `AgentClient.fetch` only, never `exact`, and returns the payment id, status, amount, fee breakdown (merchant net and platform fee, from the verified receipts) and the proof URL.
- `pnpm demo` (and `pnpm demo:stage` as step 8) ends with a gateway act, local only: the operator creates the merchant "Northwind Data" with a 0.5 % + 0.01 USDC plan and a customer-borne deposit fee, the merchant creates a link and a webhook endpoint with its API key, a person pays with `wallet`, a second person pays with `deposit`, a plain x402 agent pays the node's `/v1/pay/l/{slug}` with `payExact`, an MCP mandate agent pays with two vouchers settled in the next batch, the merchant payout refunds gaslessly through the router (the only router use), and a deny-listed payer is refused. Checks: statuses, fees equal `computeFees`, merchant and platform balance deltas equal the fee breakdowns, forwarders, router and hub at zero, every webhook verified with `constructEvent`, the screening decision recorded, and a proof check of the wallet payment.

## 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_PAYOUT_ADDRESS` | unset (gateway off) | Merchant wallet that receives every payment. |
| `PUBLIC_CHECKOUT_URL` | `http://localhost:3000` | Origin of the hosted checkout (the dashboard). |
| `DEPOSIT_FACTORY_ADDRESS` | from deployments json | Factory address override. |
| `CHECKOUT_TTL_SECONDS` | 1800 | Default payment expiry. |
| `WEBHOOK_ALLOW_PRIVATE` | true on 31337, false elsewhere | SSRF guard switch. |
| `GATEWAY_WATCH_INTERVAL_MS` | 2000 | Deposit watcher poll interval. |

## 12. Ownership

| Area | Owner |
|---|---|
| Contracts, MockStablecoin EIP-3009, deploy scripts, `packages/protocol/src/gateway.ts` (ids, typed data, nonce and salt derivation, forwarder prediction, webhook sign and verify, public types) | Principal engineer |
| `apps/node` gateway modules, migration `004_gateway.sql`, workers, routes, tests | Backend engineer |
| `apps/dashboard` checkout, link page, merchant pages, `proxy.ts` | Frontend engineer + UI/UX |
| SDK, MCP, demo act, docs | Agent engineer |

## 13. Trust features for agent commerce

These four features make every gateway payment checkable by anyone, not just recorded by the node.

### 13.1 Intake screening

Before the node returns x402 requirements, relays an EIP-3009 authorization, accepts a voucher for a gateway payment, or shows a deposit address, it screens the payer (when known) and the payout.
- Token blacklist: `isBlacklisted` on USDC.e and testnet USDC, read through Multicall3, the same check settlement already uses, moved to intake.
- Merchant deny list: addresses the merchant blocks in the dashboard (`GET/POST/DELETE /v1/screening/deny-list`).
- Optional minimum payer history: `SCREEN_MIN_PAYER_NONCE` (default 0, off) refuses brand-new payer wallets by their transaction count.
- A refused request gets no signature, no requirements and no relay, and is stored as a screening decision with a rule code: `PAYER_BLACKLISTED`, `PAYOUT_BLACKLISTED`, `PAYER_DENIED`, `PAYER_TOO_NEW`.
- Decisions appear on the dashboard's Blocked calls page next to the clearing denials, with source `gateway`.
- Every check is a real chain read or a merchant rule; nothing is simulated.

### 13.2 Order commitment

Every payment carries `order_hash = keccak256` of the canonical JSON of `{payment_id, amount, token, payout, reference, description, line_items, metadata_hash}` (keys sorted at every level, no whitespace, addresses checksummed; `canonicalOrder` and `orderHash` in `gateway.ts`).
- `metadata_hash = keccak256` of the canonical JSON of the payment's metadata, or the zero hash when it has none (absent or no keys) (`metadataHash` in `gateway.ts`). Metadata is merchant-private: public views never carry it, only its hash.
- API callers may pass `line_items: [{name, quantity, unit_amount}]`; their sum must equal `amount`.
- The hash is returned on the payment, shown on the receipt, and included in the attestation below, so a receipt proves what was bought, not only that money moved.
- `GET /v1/checkout/{id}/order` returns the canonical JSON itself, byte for byte what `order_hash` hashes, so anyone can recompute it. It contains `metadata_hash`, never `metadata`; the merchant API still returns `metadata` on the payment.

### 13.3 Payment proof page

Public page `/receipt/{paymentId}` (and `GET /v1/checkout/{id}/proof`) for a `paid` or `overpaid` payment.
It shows the transaction, the block and its finality state, the decoded `Transfer` (and `AuthorizationUsed` for wallet and x402 payments), the payout, the order hash, and the EAS attestation UID.
The page re-verifies in the browser straight from the chain RPC (receipt logs, finality tag, attestation fields) and says which checks passed, so the reader does not have to trust the node.
The node attests each confirmed gateway payment through the existing EAS predeploy with schema `bytes32 paymentRef, bytes32 orderHash, address payer, address payout, address token, uint256 amount, bytes32 txHash`, through the same attester the clearing batches use; when EAS is off locally, the page says so instead of faking it.

### 13.4 Service directory

`GET /.well-known/payminto.json` and `GET /v1/directory` list what this node sells to agents: active payment links and registered paid endpoints, each with title, price (or range), token, chain id, the accepted schemes (`exact`, `payminto-voucher`), and the pay URL.
The MCP server gains `list_paid_services` (reads the directory) next to `pay_link`, so an agent can discover, choose, pay and prove without a human.
Links can opt out of the directory with `listed: false`.

## 14. Merchants, fees and payment methods

This section supersedes the single-merchant parts of sections 1, 2, 3 and 8.
A self-hosted node is a payment platform: the operator (admin token) creates and runs any number of merchants, each with its own payout wallet, fee plan, payment methods, links, payments, refunds, webhooks and API keys.
A node that only serves itself simply has one merchant.

### 14.1 Model

| Entity | Key fields |
|---|---|
| `platform` (one row) | `name`, `fee_recipient` (platform treasury wallet, env `PLATFORM_FEE_ADDRESS`, required when any fee is non-zero), default fee plan. |
| `merchant` (`mer_`) | `name`, `slug`, `status` (`active`, `suspended`), `payout` (wallet), `support_email`, `brand_color`, `logo_url`, `fee_plan_id`, `created_at`. |
| `fee_plan` (`fp_`) | `name`, `platform_fee_bps` (0-1000), `platform_fee_fixed` (base units), `min_fee`, `max_fee` (nullable). |
| `merchant_method` | Per merchant and method (`wallet`, `deposit`, `x402`, `voucher`): `enabled`, `fee_bps`, `fee_fixed`, `bearer` (`merchant` or `customer`), `min_amount`, `max_amount`. |
| Payment fee breakdown | `amount` (merchant price), `surcharge` (method fee when the customer bears it), `amount_due = amount + surcharge`, `platform_fee`, `method_fee`, `fee_total = platform_fee + method_fee`, `net_amount = amount_due - fee_total`. All fixed at creation; the method is chosen at creation for API and x402 payments, and at checkout for people (switching method re-quotes while `open`). |

Fee math (all integers in base units): `platform_fee = clamp(fixed + floor(amount * bps / 10000), min_fee, max_fee)` (a null `min_fee` is 0, a null `max_fee` is no cap); `method_fee = method.fee_fixed + floor(amount * method.fee_bps / 10000)`; both are computed on `amount`, never on the surcharge; `fee_total` can never exceed `amount_due`: when it would, `method_fee` is kept (it is what the customer's surcharge line shows) and `platform_fee` is cut to `amount_due - method_fee`.
`computeFees({amount, plan, method})` in `packages/protocol/src/gateway.ts` is the one implementation; the node and dashboard must not re-derive it.
Fees are not returned on refunds; the refund dialog says so.
Seeded defaults: a `Standard` plan (0.5 %, no fixed), all four methods enabled with zero method fee, so the out-of-the-box demo still pays merchants the full amount unless a plan says otherwise.

### 14.2 Non-custodial fee splitting on chain

Fees are taken in the same transaction that pays the merchant, by contracts that cannot send money anywhere else.
- `PaymentRouter` (new): `payWithAuthorization(address token, PaymentTerms t, address from, uint256 value, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)`, plus the same with `bytes signature` in place of `v, r, s` (FiatToken v2.2, also ERC-1271), where `PaymentTerms = {bytes32 paymentRef, address payout, address feeRecipient, uint256 fee}`.
  The token is an argument because one router serves every token; the payer's signature is bound to the token through its EIP-712 domain.
  It calls the token's `receiveWithAuthorization(from, router, value, validAfter, validBefore, nonce, ...)` with `nonce = keccak256(abi.encode(t))` (also exposed as `termsNonce(t)`), then transfers `fee` to `feeRecipient` and `value - fee` to `payout`, and emits `PaymentRouted(paymentRef indexed, from indexed, payout indexed, value, fee)`.
  It reverts `FeeExceedsValue`, `ZeroPayout`, or `ZeroFeeRecipient` (a non-zero fee with no recipient).
  Because the payer's signature commits to the nonce, and the nonce is the hash of the terms, the node cannot change the payout or the fee after the payer signs. The router holds nothing between calls.
  `paymentRef = keccak256(abi.encode("payminto.payment.v1", chainId, paymentId))` (`paymentRef` in `gateway.ts`); a gasless refund uses `refundRef` (`"payminto.refund.v1"`, refund id), `payout = to`, `fee = 0`.
  Only gasless refunds use the router (`payout = to`, `fee = 0`). Customer payments never do: when a router payment and a forwarder both collected a fee for one payment, each counted its own share, so a later overpayment to the forwarder could take the fee again (up to about twice `fee_total`). With the forwarder as the only destination of customer money, its cumulative fee counter is the single source of truth: pro-rata on a partial payment, capped at `fee` on an overpayment, whatever mix of `deposit`, `wallet` and `x402` paid it.
- `wallet` (section 3) is a `TransferWithAuthorization` to the payment's current forwarder, relayed by the node and flushed like a deposit.
- `x402` cannot use the router: a standard x402 `exact` client signs a `TransferWithAuthorization` to `payTo` with a nonce of its own choosing, never a `ReceiveWithAuthorization` with ours. So the 402 lists the payment's deposit forwarder as `payTo`; the node relays the client's `transferWithAuthorization` to it and then flushes, and the forwarder enforces the split.
- `DepositForwarder` gains a fee split. Each forwarder is an EIP-1167 clone with immutable args `abi.encode(Terms)`, `Terms = {address token, address payout, address feeRecipient, uint256 fee, uint256 amountDue}`, deployed by CREATE2 under the per-payment `depositSalt`. The args are part of the init code, so the address binds every split field (no initializer, nothing to front-run).
  `DepositFactory` exposes `implementation()`, `addressOf(Terms, bytes32 salt)`, `flush(Terms, bytes32 salt, address token) returns (address forwarder, uint256 amount, uint256 fee)` and `flushNative(Terms, bytes32 salt) returns (address forwarder, uint256 amount)`; `addressOf` and both flushes revert `ZeroPayout`, `ZeroAmountDue`, `FeeExceedsAmountDue` or `ZeroFeeRecipient` for terms that could never flush, so no address is handed out for them.
  The forwarder's `flush(token)` sends the fee recipient `min(fee, floor(received * fee / amountDue)) - feePaid`, where `received` is everything of `Terms.token` flushed so far, and the rest to `payout`, so partial and over payments split fairly and the total fee does not depend on how many flushes happen. Any other token, and HSK via `flushNative`, go entirely to the payout. `Flushed(token, amount, fee)` is emitted per flush.
- `voucher` payments with a non-zero fee carry two requirements in the 402 (merchant payout for `net_amount`, platform `fee_recipient` for `fee_total`); the agent signs one voucher per payee and both payees must be on its mandate allowlist. The platform fee recipient is registered as a provider for this.
- `fee == 0` uses the same contracts with a zero fee, so there is one code path.
- `PaymentRouter` is deployed through the canonical CREATE2 deployer with salt `keccak256("payminto.router.v1")`; `contracts/deployments/<chainId>.json` gains `paymentRouter` and `paymentRouterBlock`.

### 14.3 API changes

- Admin (operator) routes: `POST/GET /v1/merchants`, `GET/PATCH /v1/merchants/{id}` (name, status, profile, fee plan), `POST /v1/merchants/{id}/payout` (change payout; requires an EIP-191 signature from the new payout wallet over `Payminto payout change {merchantId} {newPayout} {timestamp} chain {chainId} hub {hub}`, where `chainId` and `hub` are the node's (its `/v1/info`), so a proof is good on one node only; logged as an audit event and a `merchant.payout_changed` webhook), `GET/PUT /v1/merchants/{id}/methods`, `POST/GET/PATCH /v1/fee-plans`, `GET /v1/platform` and `PATCH /v1/platform`, `GET /v1/platform/fees` (fees earned by merchant and method).
- Merchant scoping: every merchant route from section 8 is scoped to the API key's merchant. The admin token may act on any merchant by passing `Merchant-Id: mer_...`. Keys, webhooks, links, payments and refunds always belong to exactly one merchant.
- `POST /v1/payments` gains optional `method` (required for agent-created payments) and returns the fee breakdown; `GET /v1/checkout/{id}/quote?method=` re-quotes for the checkout method picker.
- Checkout view shows `amount`, the surcharge line (named after the method) when present, and `amount_due`; merchants see `fee_total` and `net_amount` on every payment.
- Webhook payloads include the fee breakdown.

### 14.4 Dashboard

- Operator area (admin token): Merchants list and create wizard (profile, payout with wallet-signature proof, fee plan, methods), merchant detail (stats, fee plan, methods, payout history, suspend), Fee plans, Platform settings (fee recipient, defaults), Platform earnings report.
- Merchant switcher in the shell for the operator; a merchant signing in with its own secret key sees only its own data and cannot change its fee plan.
- Merchant settings gain Payment methods (enable or disable, read-only fees set by the operator) and the fee breakdown on payments.
- UI references for these screens come from Mobbin (onboarding wizards, pricing and fee tables, multi-account switchers) and are added to the design references doc.

## 15. Node implementation notes (backend)

Where `apps/node` fills a gap in this spec or deviates from it.
Fix it here first if any of it is wrong.

- Lists are `{items, next_cursor}` everywhere (payments also carry `counts` by status plus `refunded` and `all`); unpaged lists (`/v1/webhooks`, `/v1/api-keys`, `/v1/fee-plans`, `/v1/merchants`) return `{items}`.
- `GET /v1/payments` takes `method=wallet,deposit,x402,voucher` (one or more, matched against the method shown on the payment); `counts` are within that filter.
- A platform role needs no `Merchant-Id` for one record: payment, link and refund routes, and `POST /v1/refunds` (from `paymentId`), act for the record's own business, so any detail URL works on the platform view.
- The admin token without `Merchant-Id` acts for the merchant only when the node has exactly one; otherwise it is `400 MERCHANT_REQUIRED`. `/v1/api-keys` needs the admin token and acts for that merchant.
- `GET /v1/webhooks/{id}/secret` is the explicit reveal; `GET /v1/webhooks/{id}` never carries the secret.
- `POST /v1/checkout/{id}/method {method: wallet|deposit}` re-quotes an open, untouched payment for the method a person picked (section 14.1); `GET /v1/checkout/{id}/quote?method=` only quotes.
  A re-quote that moves the deposit forwarder keeps the old one watched with its own terms (migration 006, `payment_forwarders`), because the checkout may already have shown it to a payer whose transfer is on its way.
  A deposit to it on a payment nothing has paid yet restores that quote; otherwise it is credited anyway. The flush job flushes every forwarder of the payment that holds a balance, each with its own terms.
- `POST /v1/refunds` and `GET /v1/refunds/{id}` include `authorization: {router, terms, to, value, nonce}`: what the payout wallet signs as a `ReceiveWithAuthorization` for a gasless refund (terms `refundRef`, payout = `to`, fee 0).
- Screening: decisions are served at `GET /v1/screening/decisions` (each item has `source: "gateway"`, `rule`, `stage`, `payer`, `payment_id`); the admin token without `Merchant-Id` sees all merchants. The deny list is `GET/POST /v1/screening/deny-list` and `DELETE /v1/screening/deny-list/{address}`, per merchant. A refusal is `403 SCREENING_REFUSED` with `details.rule`.
- x402 on a link: `exact` pays a payment's own forwarder, so the unpaid `GET /v1/pay/l/{slug}` needs a payment for its `payTo` (with `extra.paymentId`). It is a draft (migration 005):
  - not listed, not retrievable through the merchant API (404), no webhooks, not in stats, link counters or `max_payments`;
  - reused for the same link and requester (sha256 of link id, client IP and User-Agent) while at least 60 s of its 300 s TTL is left;
  - promoted to a normal payment on its first credit or on a valid `exact` signature, which emits `payment.created` then its states;
  - deleted by the expiry worker once expired with no credit.
  A voucher retry on a link uses its own draft the same way, or the payment that already accepted those vouchers.
- `PAYMENT-SIGNATURE` for vouchers is one `payminto-voucher` payment, an array of them, or `{vouchers: [...]}`; a payment with a fee needs both (merchant net and fee recipient), from one mandate.
  Both are evaluated and booked, with their payment credits, in one BEGIN IMMEDIATE transaction, or neither is: if either is denied nothing is accepted and only that denial is recorded.
  A retry of vouchers the payment already accepted returns the same receipts and books nothing.
- `PAYMENT-RESPONSE` carries `success, network, paymentId, status, txHash, transaction, payer`; for vouchers also `receipt` and `position` (what `AgentClient` verifies).
- New merchants prove the payout with the message `Payminto payout change new {payout} {timestamp} chain {chainId} hub {hub}` (the id does not exist yet); later changes use the merchant id. Proofs older than 600 s, or signed for another chain or hub, are refused. `signPayoutProof(account, merchantId, {chainId, hub})` in the SDK.
- A voucher retry gets the stored receipts back only when every presented voucher carries a valid signature by the mandate's agent and the same amount; otherwise it is treated as a new payment attempt.
- Webhook SSRF guard also refuses IPv4-compatible (`::/96`) and NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) addresses.
- Behind the dashboard's `proxy.ts` the node needs `TRUST_PROXY_HOPS` of at least 1 (the compose default), or every proxied agent shares the dashboard's address for rate limits and x402 draft keys (docs/OPERATIONS.md, "Trusted proxy hops").
- `PLATFORM_FEE_ADDRESS` is env-only like the payout used to be: `PATCH /v1/platform` changes `name` and `default_fee_plan_id` only. Seeding makes `Standard` (0.5 %) the default plan when a fee address is set, else `No fee`, so a zero-config node pays merchants in full.
- `AgentClient.fetch` signs both requirements of a fee-carrying voucher payment (section 10). The node books a pair atomically (above), so a pair is either fully accepted or not at all: on `STALE_CUMULATIVE` the client re-reads both positions from its node and re-signs and retries the whole pair (up to `maxRetries`).
- Webhook endpoints carry `success_rate_7d` (succeeded attempts over attempts in the last 7 days, null with none), `last_delivery_at` and `disabled_reason`. An endpoint whose every attempt failed for 3 days is disabled (pending attempts fail, no event is emitted); `PATCH {active: true}` re-enables it and clears the streak.
- `GET /v1/platform/fees` adds `days`: the last 30 UTC days by the day payments were paid, each `{day, fee_total, by_method: {wallet, deposit, x402, voucher, hsp}}`.
- Merchants carry `volume_30d` and `payments_30d` (list and detail); the detail and `GET /v1/merchant` also carry `payout_history` (newest first, `proven` false only for the seed payout).
- Request casing: section 8 bodies are snake_case; the refund bodies are camelCase, consistently: `POST /v1/refunds {paymentId, amount, reason?, to?}` and `POST /v1/refunds/{id}/submit {authorization: {from, to, value, validAfter, validBefore, nonce, signature}, terms?}` or `{txHash}`. `terms` (`{paymentRef, payout, feeRecipient, fee}`) is optional; when sent it must equal the refund's terms (`400 REFUND_TERMS_MISMATCH`).
- `payoutChangeMessage` and `PAYOUT_PROOF_MAX_AGE_SECONDS` live in `gateway.ts`.
- `GET` and `PUT /v1/merchants/{id}/methods` also take a merchant key, so the admin token must name the merchant with `Merchant-Id` there too once the node has more than one; `GatewayClient` sends it.
- `GET /v1/links/public/{slug}` carries `methods: [{method, enabled, surcharge_bps, surcharge_fixed, quote}]` for the enabled methods, so the link page can show "Pay X" with the fee before a payment exists. Only the customer-borne part is shown (`bearer: customer`; zero when the merchant bears the fee), never platform fees or the merchant's net. A fixed-amount link adds `quote: {amount, surcharge, amount_due}` per method (null when the amount is outside that method's limits).
- `CORS_ORIGINS` defaults to the dashboard origin (`PUBLIC_DASHBOARD_URL`, `PUBLIC_CHECKOUT_URL`) plus `http://localhost:3000`. Dashboard calls go through its `/api` proxy (same origin, session cookie), so CORS matters only for browsers calling the node directly (checkout, x402 clients).
- Accounts, sessions, roles, search and customers: contract in `PRODUCT.md` section 10.

## 16. Reconciliation report

One report per business and date range that ties each payment to its fees, refunds and on-chain record (`docs/PRODUCT_PLAN.md` section 6.2).
The code is `apps/node/src/gateway/reports.ts`; the shapes are `ReconciliationReport` and `REPORT_CSV_COLUMNS` in `packages/protocol/src/gateway.ts`.

### 16.1 Route

- `GET /v1/reports/reconciliation?from=&to=&format=json|csv` (`format` defaults to `json`).
- Auth is the business API like section 8: a business API key, or a session with the business named by `Merchant-Id` or `merchant_id`, with `payments.read`, so Viewers may read it.
  A key or member of another business gets `404 UNKNOWN_MERCHANT`.
- `from` and `to` are ISO 8601 times with a zone (`Z` or an offset), or `YYYY-MM-DD` dates in UTC.
  A plain `to` date covers that whole day, so `from=2026-10-01&to=2026-10-31` is October.
  The range is `[from, to)` and at most 366 days; anything else is `400 VALIDATION_ERROR`.
  More than 100,000 payments in the range is `400 REPORT_TOO_LARGE`.
- The dashboard's "Download report" on Payments sends the person's local midnights as ISO times, so the days are theirs.
- CSV comes as `text/csv; charset=utf-8` with `Content-Disposition: attachment`.

### 16.2 Rows

- One row per payment created in the range (drafts excluded), oldest first.
- Columns: payment id, reference, link id, description, created and paid times, status, method, payer, currency, then the amounts, then refund ids, transaction hashes with explorer URLs, batch ids, receipt proof URLs, the payment proof URL, `hsp_flow_id`, `hsp_status` and the screening rules that refused a payer for the payment.
- `method` is the method shown on the payment (quoted, else the one that paid), read as stored, so a new method such as `hsp` appears without a code change.
  HSP columns are read when the payment table has them and are empty otherwise.
- Fee lines are what was charged on what was received, split like the forwarder splits it (section 14.2): `fee_total = min(fee_total quoted, floor(amount_paid * fee_total / amount_due))`, divided between platform and method fee in the quote's proportion.
  They equal the quote for an exact payment, are pro rata on a partial payment, and are capped on an overpayment.
  `net_amount = amount_paid - fee_total`.
- Refunds are reported on their payment's row, whatever day they were made: `refunded` is succeeded refunds, `refunds_pending` is refunds still pending, and `net_after_refunds = net_amount - refunded`.
  Fees are not returned on refunds, so a full refund leaves `net_after_refunds` at minus the fee.
  `refund_ids` lists succeeded and pending refunds; JSON `refunds` lists every refund with its status and approval.
- Transactions are the payment's credits: the payer's transfer for `wallet`, `deposit` and `x402`, and the clearing batch's settlement transaction for agent charges (`voucher`), with the batch id and a public receipt proof URL (`{PUBLIC_URL}/v1/receipts/{callId}/proof`).
- `proof_url` is the public payment proof page (section 13.3) for paid and overpaid payments.

### 16.3 Amounts and totals

- CSV amounts are decimal token units with the token's 6 decimals (`12.500000`).
  JSON rows carry the same decimals and repeat them in base units under `base_units`.
- Totals: `payments`, `gross` (sum of `amount_paid`), `platform_fee`, `method_fee`, `fees`, `net`, `refunds`, `refunds_pending` and `net_after_refunds`, with `gross - fees = net`.
  JSON adds `counts` by status and `by_method` (payments that have a method).
  CSV ends with a `TOTAL` line that fills only the money columns.
- `ledger` (JSON) checks the agent charges of the range (voucher credits) against the clearing ledger's `call.accepted` journals for the same calls; `matches` is true when they are equal.
  The ledger only books agent charges, so on-chain payments are checked against the chain instead: the tests prove the fee wallet received exactly the report's fees and the payout wallet the report's net minus refunds.

### 16.4 CSV safety

- RFC 4180: every cell is quoted, quotes are doubled, records end with CRLF.
- A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe so a spreadsheet shows it as text; plain numbers, negative ones included, stay numbers (`reportCsvCell`).

### 16.5 Refund requests from agents

- `POST /v1/refunds` takes an optional `requestApproval: true` that files the refund with `approval: "requested"` even when the caller holds `refunds.issue`.
  The merchant MCP server (`apps/mcp`, `--merchant`) always sends it, so an agent can only request a refund; an Admin approves it and the payout wallet signs it in the dashboard.

## 17. HSP payment method

`hsp` is HashKey's HSP Agentic Payment as one more way into a payment's fee-splitting forwarder.
HSP's gateway broadcasts a transfer the payer signed into the payment's own DepositForwarder, so the deposit watcher credits it like any deposit, the flush splits the fee, and webhooks, refunds and reports work unchanged.
The HSP status is stored next to the payment and never makes it paid on its own: only the transfer reaching the forwarder does.

### 17.1 HashKey's server

- MCP over Streamable HTTP at `HSP_MCP_URL` (QA: `https://mcp-qa.hashkeymerchant.com/`), health at `GET /health` answering `{"status":"ok"}`.
- Access needs the caller's public egress IP on HashKey's allowlist; App Key and Secret live on HashKey's side.
- Eight tools: `get_chain_config`, `create_order`, `get_order`, `prepare_payment`, `finalize_payment`, `estimate_fee`, `submit_payment`, `query_payment`.
- The client is `apps/node/src/hsp/agentic.ts`.
  It checks the live tool list on connect, refuses a call when a live input schema requires an argument it does not send, validates every result with zod, and maps failures to `not_allowlisted` (HTTP 401 or 403), `unreachable`, `requote` (error 30043), `tool_error`, `tools_missing` and `invalid_response`.
- This is separate from the HSP port in `apps/node/src/hsp/port.ts`, which attests netted clearing batches.

### 17.2 Configuration and availability

| Variable | Default | Meaning |
|---|---|---|
| `HSP_MCP_URL` | unset (method off) | HashKey's HSP Agentic Payment MCP server. |
| `HSP_MERCHANT_NAME` | required with the URL | The team's reporting name, sent identically on every `create_order` and `query_payment`; HashKey aggregates payments by it. |
| `HSP_POLL_INTERVAL_MS` | 15000 | How often each payment in flight is queried (HashKey asks for 15 s). |

- At startup (in the background) and again on use, at most once a minute while unavailable, the node calls `GET /health`, lists the tools and calls `get_chain_config`.
- The method is available only when `get_chain_config` lists the node's chain id and its token address with the same decimals; the token's `payment_protocol` (`eip3009` or `permit2`) is what `prepare_payment` is asked for.
- Otherwise the availability is `unavailable` with a reason (`not_allowlisted`, `network_mismatch`, `token_mismatch`, `unreachable`, `tools_missing` or `error`) and plain words for people, such as "Waiting for HSP access: HashKey has not allowlisted this server yet."
- An unreachable HSP never delays or stops the node.
- Availability is served at `GET /v1/hsp/status` (business key) and as `gateway.hspPayments` in `GET /v1/info`.
- Each business turns `hsp` on in Settings, Payment methods (`PUT /v1/merchants/{id}/methods`); it starts off, for existing and new businesses.
- While HSP is unavailable, quotes refuse the method with `409 METHOD_UNAVAILABLE`, the checkout does not list it, the 402 has no `hsp` offer, and the HSP routes answer `503 HSP_UNAVAILABLE` with `details.reason`.

### 17.3 One payment

1. The payment is quoted for `hsp` like any method (its own method fees, so its own forwarder).
2. The first prepare creates one HSP order for the payment, reused on every retry: `merchant_name` is `HSP_MERCHANT_NAME`, `pay_to` is the payment's forwarder, and the cart mandate has `contents.id` (the payment id), `contents.cart_expiry` (the payment's `expires_at`), one method `{supported_methods: ["https://www.x402.org/"], data: {x402Version: 2, network, token}}` from `get_chain_config`, and `details.total.amount = {currency: "USD", value}`.
   The value is the amount due in token units: the node's token is a USD stablecoin, so one token is quoted as one dollar (`hspUsdAmount` in `packages/protocol/src/hsp-agentic.ts`).
3. `prepare_payment(flow_id, payer, protocol)` locks a quote for 5 minutes.
   The node refuses the quote (`502 HSP_QUOTE_MISMATCH`) unless it is for this payer and pays this payment's forwarder exactly the amount due, on this chain, in this token.
   It stores the quote (`hsp_quotes`, migration 010); a newer quote of the same payment supersedes an older one.
4. The payer signs HSP's `eip712` exactly as returned (`hspAgenticTypedData` only turns JSON integers into bigints).
5. Submit checks the signature recovers to the payer, then calls `finalize_payment` with the quote's values unchanged and `submit_payment` with the `payment_mandate_json` it returns.
6. The poller calls `query_payment(flow_id, expected_merchant_name)` for every payment in flight and stores the status, `status_reason`, `tx_signature` and `attribution_verified`; it stops at `payment-finalized` or `payment-failed`.
7. The deposit watcher sees the transfer in the forwarder, the payment becomes paid, and the flush splits the fee exactly as for a deposit.
   The credit's method is `deposit`; the payment's `method` is `hsp`.

Rules:
- One HSP order per payment, and HSP needs an untouched payment (nothing paid, no credits), else `409 PAYMENT_PARTIALLY_PAID`.
- A signature is submitted once.
  The same signature again returns the current status without calling `submit_payment`; another signature while one is in flight is `409 HSP_ALREADY_SUBMITTED`.
- An expired quote (past `quote_expires_at`, or HSP error 30043) is marked expired and answered `409 HSP_QUOTE_EXPIRED`: the payer prepares again and signs the new data, and an old signature is never resent.
- A submit whose quote no longer matches the payment (another forwarder or amount after a method switch, money paid since, another order) is `409 HSP_QUOTE_MISMATCH`.
  A payer that did not prepare gets `409 HSP_NOT_PREPARED`; a signature by anyone else gets `400 BAD_SIGNATURE`.
- If `submit_payment` gets no answer, the node queries first and adopts what HSP reports; it never sends the signature again and never creates a second order.
  A submission HSP never confirms is marked `payment-failed` ten minutes after its quote expired, so the payer can try again.
- While an HSP payment is in flight the checkout holds the payment: wallet and x402 payments are refused with `409 PAYMENT_PROCESSING`, and the page shows the HSP progress.
- Payers are screened at prepare and at submit with stage `hsp` (section 13.1).

### 17.4 API

| Route | Purpose |
|---|---|
| `POST /v1/checkout/{id}/hsp/prepare` | `{payer}` returns `{payment_id, flow_id, payment_request_id, protocol, eip712, token_total_raw, quote_expires_at, recipient, payer}`; re-quotes an untouched payment for `hsp`. |
| `POST /v1/checkout/{id}/hsp/submit` | `{payer, signature}` returns `{status, hsp, payment}`: the payment status, its HSP fields and the checkout view. |
| `GET /v1/checkout/{id}/hsp` | `{payment_id, status, amount_due, amount_paid, flow_id, hsp}`, what an agent polls. |
| `GET /v1/hsp/status` | Business key: `{configured, merchant_name, state, reason, message, checked_at, network, protocol}`. |
| `POST /v1/checkout/{id}/method` | Also takes `hsp`. |

- Payments carry `hsp: {flow_id, payment_request_id, status, status_reason, tx_hash, attribution_verified, payer, submitted_at, updated_at}` or `null` (`PaymentHsp` in `packages/protocol`), so webhooks carry it too.
- `status` is `order-created` until a submission, then HSP's own: `payment-submitted`, `payment-verified`, `payment-processing`, `payment-included`, `payment-timeout` (HSP still trying), `payment-safe` (on chain, not final), `payment-finalized` (final) or `payment-failed`.
- `attribution_verified` is true only once HSP confirmed the payment counts under the team's merchant name.
- The checkout view carries `hsp: {availability, message, status, status_reason, tx_hash, attribution_verified}` for a business that offers HSP (or a payment that used it), else `null`, and lists `hsp` in `methods` when it can be used now.
- The 402 of a link or payment lists an `hsp` offer next to `exact` and `payminto-voucher` (`HspRequirement`): `amount` (the HSP quote's amount due), `asset`, `payTo` (the forwarder of the HSP quote) and `extra.{paymentId, prepareUrl, submitUrl, statusUrl}`, absolute URLs on `PUBLIC_URL`.
- A link whose `exact` offer is off gets an HSP draft payment of its own; a draft becomes a normal payment on its first HSP submission.
- The directory lists the `hsp` scheme for links that can take it.

### 17.5 SDK, MCP and dashboard

- `payHsp(url, {account, maxAmount})` in `@payminto/sdk` requests the URL, picks the `hsp` offer, prepares, checks the quote pays exactly the offer into the offered forwarder in the offered token for this account, signs, submits (preparing again on an expired quote), and waits until the payment is paid (`waitFor: "submitted" | "paid" | "finalized"`).
  It refuses before signing anything above `maxAmount`.
- The MCP `pay_link` tool stays vouchers only: like `exact`, `hsp` is not checked against an owner's mandate, so an agent with a mandate never pays through it.
- The hosted checkout shows Pay with HSP next to the wallet and the address, with the same wallet steps, then Submitted, On chain and Final with HSP's transaction, and says when HSP is waiting for access.
- The payment page shows the HSP status, flow id, attribution and transaction; Settings, Payment methods shows the switch and whether HSP is ready.

### 17.6 Tests and live access

- `apps/node/test/support/hsp-standin.ts` is a local stand-in with the same transport, tools and result shapes, backed by anvil: `submit_payment` really broadcasts the payer's EIP-3009 `transferWithAuthorization`, and `query_payment` moves from included to safe to finalized.
- `apps/node/test/hsp-payments.test.ts` covers availability (403, network and token mismatch, unreachable at boot), the method switch, a payment from prepare to fee split and a webhook with the HSP fields, `payHsp` on a link, requote on 30043 and on an expired quote, duplicate submits and mismatched submits.
- No test calls HashKey.
- HashKey's QA server answers 403 to our egress IP until it is allowlisted.
  The key names inside `cart_mandate.payment_request.method_data[].data` follow HashKey's guide and must be checked against the live input schemas once access is granted.
