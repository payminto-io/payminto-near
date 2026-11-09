# Payminto product spec: naming, navigation, accounts, search, checkout

This file is the product contract for everything a user sees.
It was written by a four-role review panel: product engineer (flows and IA), principal engineer (feasibility and security), marketer (plain words), and a hackathon judge's eye (what lands in 10 seconds).
Where this file and `GATEWAY.md` or `SPEC.md` disagree on user-facing words, this file wins; the technical specs keep their technical words.
If something here is wrong, fix it here first, then in code.

Rules that apply to every screen:
- One product, one name: **Payminto**.
  "Clearing" and "Gateway" are internal module names and never appear in the app.
- Plain words in the UI.
  Technical words appear only in developer docs, API responses, code, and the tooltip under an info icon.
- Functionality first.
  No slogans, hero art or marketing copy inside the signed-in app; the only marketing line lives on the sign-in screen.
- Amounts are shown as `12.50 USDC`, never in base units, except in developer views where both are shown.
- No em dash characters anywhere; use a plain dash.

## 1. What Payminto is

### One paragraph

Payminto lets a business accept stablecoin payments from people and from AI agents, on its own server, without anyone in the middle holding the money.
You share one payment link: a person who opens it gets a simple checkout page and pays from their wallet, and an AI agent that opens it pays automatically.
Every payment goes straight to your own wallet on HashKey Chain, with any fees split off in the same transaction, so there is nothing to withdraw and nothing for anyone to freeze.
If you run AI agents yourself, you can give each one a spending budget with hard limits, and it pays the services it uses call by call, with no fee per call.
Payminto adds those small charges up and settles them in a few bundled transfers, and every single charge can still be checked on chain later.
You can run it for one business, or host many businesses on one server and earn a platform fee from each.

### Three lines for the sign-in and landing screen

Get paid in stablecoins by people and AI agents.
Money goes straight to your wallet. Nobody holds it, not even us.
Self-hosted on HashKey Chain. Set up in minutes.

### The 10-second pitch for judges

One link that both people and AI agents can pay, settled to your own wallet on HashKey Chain, with agent spending bundled into a few provable transfers.

## 2. Naming glossary

### 2.1 Final names for the big pieces

| Internal term | User-facing name | Why |
|---|---|---|
| Payminto Clearing + Payminto Gateway | **Payminto** | One product. Users never choose between halves. |
| Gateway (links, checkout, payments, refunds) | **Payments** (sidebar section) | What a shop owner thinks they are doing: getting paid. |
| Clearing (mandates, vouchers, netting, batches, providers) | **Agents** (sidebar section) | Everything about AI agents spending and being paid per call. |
| Operator area | **Platform** (sidebar section) | The part only the person running the server sees. |
| Clearing Node / node | **Payminto server** (or "your server") | It is a server they run; "node" sounds like blockchain infrastructure. |

### 2.2 Roles

| Internal | User-facing role | Plain explanation (tooltip) |
|---|---|---|
| Operator (admin token) | **Platform owner** | Runs this Payminto server, adds businesses, sets pricing, and earns the platform fee. |
| (new) | **Platform admin** | Helps the platform owner manage businesses; cannot change platform pricing, the fee wallet, or remove the owner. |
| Merchant (secret key) | **Business** | A shop or company that gets paid through this server. |
| (new) | **Admin** (of a business) | Full control of one business: payout wallet, team, API keys, refunds. |
| (new) | **Staff** (of a business) | Creates payment links, views payments, and requests refunds. |
| (new) | **Viewer** (of a business) | Read-only access to payments and reports. |

"Merchant" stays in the API (`merchant_id`, `mer_`), webhooks, and developer docs.
"Business" is used everywhere in the app.

### 2.3 Every term

Columns: internal term, user-facing name, one-line tooltip, where the technical term may still appear.

| Internal | User-facing | Tooltip (plain) | Technical term allowed in |
|---|---|---|---|
| Merchant | Business | A shop or company that gets paid through this server. | API, webhooks, SDK, developer docs |
| Payment | Payment | Money a customer or agent sent you for one order. | Everywhere |
| Payment link (`/l/slug`) | Payment link | A link you share; anyone who opens it can pay you. | Everywhere |
| Hosted checkout (`/pay/id`) | Checkout page | The page your customer pays on. | Developer docs |
| Refund | Refund | Send money back to the customer from your wallet. | Everywhere |
| Payout address / `GATEWAY_PAYOUT_ADDRESS` | Payout wallet | The wallet where your money arrives. | API, env docs |
| `fee_recipient` / `PLATFORM_FEE_ADDRESS` | Platform fee wallet | Where the platform owner's fee arrives. | API, env docs |
| Fee plan | Pricing plan | What the platform charges a business per payment. | API (`fee_plan`) |
| `platform_fee` | Platform fee | The platform owner's cut of a payment. | API |
| `method_fee` | Payment method fee | An extra fee for one way of paying. | API |
| `surcharge` | Fee paid by customer | Added to the customer's total when you choose that they pay the fee. | API |
| `bearer` | Who pays the fee | You, or your customer on top of the price. | API |
| `net_amount` | You receive | What lands in your payout wallet after fees. | API |
| `amount_due` | Total to pay | What the customer sends. | API |
| Method `wallet` | Pay with wallet | Customer connects a wallet and approves with one signature, no gas needed. | API, docs |
| Method `deposit` | Send to address | Customer sends the amount to a one-time address from any wallet or exchange. | API, docs |
| Method `x402` | AI agent | An AI agent pays automatically using the standard web payment protocol. | API, SDK, docs |
| Method `voucher` | AI agent with budget | An agent pays from a budget its owner set up in Payminto. | API, SDK, docs |
| Deposit forwarder / CREATE2 address | Payment address | A one-time address for this payment that can only forward to your wallet. | Developer docs, payment detail "Technical" panel |
| `open` | Waiting for payment | Nothing received yet. | API |
| `partially_paid` | Partly paid | Some money arrived; the customer still owes the rest. | API |
| `paid` | Paid | Fully paid. | API |
| `overpaid` | Paid extra | The customer sent more than asked; you can refund the difference. | API |
| `expired` | Expired | The time to pay ran out. | API |
| Settlement `included` | Sent | In a block; waiting to become final. | API, technical panel |
| Settlement `confirmed` / `safe` head | Final | Can no longer be reversed. | API, technical panel |
| Intake screening | Safety checks | Payminto refuses wallets that are blocked by the token issuer or by you. | Developer docs |
| Deny list | Blocked wallets | Wallets you never want to accept money from. | API |
| Screening decision / denial | Blocked attempt | A payment or agent charge Payminto refused, with the reason. | API |
| Rule codes (`PAYER_BLACKLISTED`, `OVER_DAILY_CAP`) | Plain reason ("Wallet frozen by USDC issuer", "Over daily limit") | One sentence per code. | API, technical panel |
| Order commitment / `order_hash` | Order fingerprint | A code that proves exactly what was bought. | Proof page technical panel, API |
| Payment proof page `/receipt/id` | Payment proof | A public page anyone can use to check this payment on chain. | Everywhere |
| EAS attestation | Public record | A permanent on-chain note that this payment happened. | Proof page technical panel |
| Service directory `/.well-known/payminto.json` | Listed for AI agents | Agents can find this link and its price automatically. | Developer docs |
| Webhook | Webhook | A message Payminto sends to your server when something happens. | Everywhere (developer section) |
| API key `sk_live_` | API key | Lets your own software create payments. | Everywhere (developer section) |
| Admin token `ADMIN_TOKEN` | Recovery key | Emergency access for the server owner; not a login. | Ops docs only |
| Mandate | Budget | Spending limits an owner signs once for one AI agent. | SDK, contracts, docs, technical panel |
| Mandate owner | Budget owner | The person, company or Safe whose money the agent spends. | SDK, docs |
| Total cap / per-call cap / daily cap | Total limit / Limit per charge / Daily limit | The most the agent can spend overall, per call, per day. | SDK |
| Rate limit | Charges per minute | How often the agent may pay. | SDK |
| Payee allowlist | Allowed services | The only services this agent may pay. | SDK |
| Revoke mandate | Stop budget | The agent can no longer spend from it. | SDK |
| Agent | AI agent | Software that pays for services on its own. | Everywhere |
| Provider | Paid service | An API, tool or agent that charges per call. | SDK (`paywall()`), docs |
| Voucher (cumulative, signed) | Charge | One paid call. The agent signs it; no gas, no transaction yet. | SDK, docs, technical panel |
| Call / receipt | Charge receipt | Proof the service delivered and was paid for one call. | API |
| Netting | Bundling | Adding up who owes whom so only the difference moves. | Docs, tooltip only |
| Netting page | Next settlement | What will move in the next bundled transfer. | - |
| Batch / `settleBatch` | Settlement | One on-chain transaction that pays many charges at once. | Contracts, API |
| Batch Merkle root | Settlement fingerprint | Lets anyone prove a single charge was in this settlement. | Proof technical panel |
| `verifyReceipt` / receipt proof | Verify a charge | Check one agent charge against the chain. | SDK, docs |
| HSP / `settlementBinding` | HashKey settlement receipt | HashKey's standard record that the transfer matches this settlement. | Technical panel, docs |
| Ledger (double-entry) | Balances | Who owes what, and what has been paid, with every entry. | Docs |
| Overview | Home | Today at a glance. | - |
| Earnings | Platform earnings | Fees the platform earned, by business and method. | - |
| Platform settings | Platform settings | Platform name, fee wallet, default pricing, sign-up rules. | - |
| Gas, L1 data fee | Network fee | The small HashKey Chain transaction cost. | Technical panel, docs |
| Finality, reorg | (hidden) | Shown only as Sent then Final. | Docs |
| EIP-3009, EIP-2612, EIP-712, x402, ERC-1271 | (hidden) | Never in UI copy. | Developer docs, SDK |
| Mock mode | Demo data | This screen shows sample data; nothing touches a chain. | Dev docs |

### 2.4 Page names

| Route today | Page title | Section |
|---|---|---|
| `/` | Home | top |
| `/payments`, `/payments/[id]` | Payments, Payment | Payments |
| `/links`, `/links/new`, `/links/[id]` | Payment links, New payment link, Payment link | Payments |
| `/refunds` | Refunds | Payments |
| (new) `/customers` | Customers | Payments |
| `/mandates`, `/mandates/new`, `/mandates/[id]` | Budgets, New budget, Budget | Agents |
| `/providers` | Paid services | Agents |
| `/netting` | Next settlement | Agents |
| `/batches`, `/batches/[id]` | Settlements, Settlement | Agents |
| `/denials` + `/developers/screening` | Blocked (tabs: Attempts, Blocked wallets) | Records |
| `/ledger` | Balances | Records |
| `/receipts`, `/receipts/[callId]` | Verify | Records |
| (new) `/activity` | Activity log | Records |
| `/operator/merchants`, `/new`, `/[id]` | Businesses, Add business, Business | Platform |
| `/operator/fee-plans` | Pricing plans | Platform |
| `/operator/earnings` | Platform earnings | Platform |
| (new) `/platform/team` | Platform team | Platform |
| (new) `/platform/requests` | Sign-up requests | Platform |
| (new) `/platform/outbox` | Email outbox | Platform (only when SMTP is not configured) |
| `/operator/platform` | Platform settings | Settings |
| `/developers/keys` | API keys | Developers |
| `/developers/webhooks`, `/[id]` | Webhooks, Webhook | Developers |
| (new) `/developers/hashkey` | HashKey Chain | Developers |
| `/settings` | Settings (tabs per section 3.4) | footer |
| (new) `/account` | Your account | user menu |
| `/l/[slug]`, `/pay/[id]` | Checkout page (public) | - |
| `/receipt/[id]` | Payment proof (public) | - |

Routes move from `/operator/*` to `/platform/*` with permanent redirects; route names follow the UI names so URLs read plainly.

## 3. Information architecture

### 3.1 Shell layout

- Top of the sidebar: the **account switcher** (business or platform), section 3.5.
- Under it: the **search field** ("Search or jump to...", shows the `Ctrl K` hint), opens the command palette (section 5).
- Middle: collapsible sections (section 7).
- Bottom, pinned: Settings, Help (docs link), and the **user menu** (avatar, name, email; Your account, Theme, Sign out, Sign out everywhere).
- Header: page title and breadcrumbs on the left; network pill (HashKey Chain or Testnet), live dot, and a primary action per page on the right ("New payment link" on Payments, "New budget" on Budgets).
- A yellow strip under the header when the server runs on testnet or demo data ("Testnet: no real money"), so nobody mistakes test money for real money.

### 3.2 Platform owner (and platform admin)

The switcher shows "Platform" selected; choosing a business opens that business's view (section 3.3) with a "Back to platform" chip.

| Order | Section | Default | Page | Lucide icon |
|---|---|---|---|---|
| 0 | (none) | - | Home | `house` |
| 1 | Payments | open | Payments | `credit-card` |
| | | | Payment links | `link-2` |
| | | | Refunds | `undo-2` |
| | | | Customers | `users` |
| 2 | Agents | open | Budgets | `wallet-cards` |
| | | | Paid services | `store` |
| | | | Next settlement | `waypoints` |
| | | | Settlements | `layers` |
| 3 | Platform | open | Businesses | `building-2` |
| | | | Pricing plans | `percent` |
| | | | Platform earnings | `trending-up` |
| | | | Platform team | `user-cog` |
| | | | Sign-up requests (badge with count) | `user-plus` |
| | | | Email outbox (only without SMTP) | `inbox` |
| 4 | Records | collapsed | Blocked (badge with 24h count) | `shield-ban` |
| | | | Balances | `book-open-check` |
| | | | Verify | `shield-check` |
| | | | Activity log | `scroll-text` |
| 5 | Developers | collapsed | API keys | `key-round` |
| | | | Webhooks | `webhook` |
| | | | HashKey Chain | `blocks` |
| footer | - | - | Settings | `settings` |
| footer | - | - | Help | `life-buoy` |

On the platform view, Payments and Agents pages show all businesses with a "Business" column and filter.
Platform admins see the same sidebar minus Platform earnings and with read-only Pricing plans.

### 3.3 Business Admin

| Order | Section | Default | Page | Lucide icon |
|---|---|---|---|---|
| 0 | (none) | - | Home | `house` |
| 1 | Payments | open | Payments | `credit-card` |
| | | | Payment links | `link-2` |
| | | | Refunds | `undo-2` |
| | | | Customers | `users` |
| 2 | Agents | collapsed (open once any agent has paid) | Agent payments (payments filtered to AI agent methods) | `bot` |
| 3 | Records | collapsed | Blocked | `shield-ban` |
| | | | Verify | `shield-check` |
| | | | Activity log | `scroll-text` |
| 4 | Developers | collapsed | API keys | `key-round` |
| | | | Webhooks | `webhook` |
| | | | HashKey Chain | `blocks` |
| footer | - | - | Settings | `settings` |
| footer | - | - | Help | `life-buoy` |

Budgets, Paid services and Settlements appear for a business only when the platform owner turns on "Agent budgets" for that business (Platform settings), because most shops only receive payments.

### 3.4 Business Staff and Viewer

| Order | Section | Default | Page | Staff | Viewer |
|---|---|---|---|---|---|
| 0 | (none) | - | Home | yes | yes |
| 1 | Payments | open | Payments | yes | yes |
| | | | Payment links | create, edit own | view |
| | | | Refunds | request (Admin approves) | view |
| | | | Customers | yes | yes |
| 2 | Records | collapsed | Verify | yes | yes |
| 3 | Developers | collapsed | HashKey Chain | yes | yes |
| footer | - | - | Settings (only Your account, Notifications) | yes | yes |

Pages a role cannot open are not shown at all; they are never shown disabled.

### 3.5 Account switcher and settings placement

- The switcher is a button at the top of the sidebar: logo or initial, business name, role under it, and a chevron.
- Its menu lists: "Platform" (platform roles only), then every business the user belongs to with a search field once there are more than 6, then "Add business" (platform roles) and "Create a business" (when self sign-up is on).
- Keyboard: `Ctrl/Cmd K` then type the business name, or `G` then `B` opens the switcher.
- The selected business is stored per user on the server (`users.last_business_id`) and mirrored in the URL as `?b=mer_...` only when shared, so a pasted link opens the right business.
- Settings is one page with a left tab list, grouped:
  - Business: Profile (name, logo, brand color, support email), Payout wallet (signature-proof change), Payment methods, Checkout (expiry, success URL, receipts), Team, Notifications.
  - Platform (platform roles): General (name, logo, public URL), Platform fee wallet, Default pricing, Sign-ups (section 4.8), Email (SMTP status and test), Network (section 8), Security (session lengths, 2-step requirement), Recovery key status.
  - Your account (everyone): Profile, Password, 2-step verification, Wallets (sign in with wallet), Sessions.

## 4. Account system

### 4.1 Model (SQLite, migration `005_accounts.sql`)

| Table | Key fields |
|---|---|
| `users` (`usr_`) | `email` (unique, lowercased), `email_verified_at`, `name`, `password_hash`, `totp_secret_enc`, `platform_role` (`owner`, `admin`, null), `status` (`active`, `pending`, `disabled`), `failed_logins`, `locked_until`, `last_business_id`, `created_at` |
| `memberships` | `user_id`, `merchant_id`, `role` (`admin`, `staff`, `viewer`), `created_at`; unique per pair |
| `sessions` | `id_hash` (sha256 of the token), `user_id`, `created_at`, `last_seen_at`, `expires_at`, `idle_expires_at`, `ip`, `user_agent`, `rotated_from`, `revoked_at`, `step_up_at` |
| `auth_tokens` | `token_hash`, `kind` (`verify_email`, `reset_password`, `invite`, `setup`), `user_id` or `email`, `merchant_id`, `role`, `expires_at`, `used_at`, `created_by` |
| `wallet_logins` | `user_id`, `address`, `chain_id`, `added_at`; unique address |
| `siwe_nonces` | `nonce`, `expires_at`, `used_at` |
| `outbox_emails` | `to`, `subject`, `body_text`, `link`, `kind`, `created_at`, `sent_at`, `error` |
| `audit_events` | `id`, `at`, `actor_type` (`user`, `api_key`, `recovery_key`, `system`), `actor_id`, `merchant_id`, `action`, `target`, `ip`, `meta_json` |
| `platform` (existing) | gains `signup_mode` (`off`, `approval`, `open`), `require_2fa_platform` (bool), `agent_budgets_for_businesses` (bool) |

### 4.2 First-run setup

- On boot, when `users` has no platform owner, the server creates a one-time setup code (32 random bytes, base32), stores only its hash in `auth_tokens` (`kind=setup`, 24 h), and prints it to the server log with the setup URL: `Open https://<dashboard>/setup and enter code XXXX-XXXX-...`.
- `ADMIN_TOKEN` is also accepted as the setup code, so a scripted deploy can finish setup without reading logs.
- `/setup` asks for the code, then the platform name, the owner's name, email and password, and shows the network and payout defaults it read from env.
- On success it creates the owner, marks the email verified (the owner proved server access), signs them in, deletes the setup code, and goes to a three-step checklist on Home: "Add your first business" (or "Use this server for my own business"), "Set the platform fee wallet", "Invite your team".
- A fresh public VPS can therefore never be claimed by whoever reaches `/setup` first, a known weakness of "first registrant becomes admin" designs.
- Recovery: `pnpm --filter node account reset-owner --email <email>` prints a one-time reset link, run on the server itself.

### 4.3 Passwords

- Hash: `scrypt` from `node:crypto`, `N=2^17, r=8, p=1`, 32-byte output, 16-byte random salt, `maxmem` 256 MiB, run with the async API so it never blocks the event loop.
- Stored as `scrypt$17$8$1$<salt b64>$<hash b64>` so parameters can be raised later; a login with old parameters rehashes on success.
- Compare with `timingSafeEqual`; for an unknown email, hash against a fixed dummy so timing does not reveal which emails exist.
- Rules: at least 12 characters, at most 256, not equal to the email, not in a bundled list of the 10,000 most common passwords; no composition rules; show a strength meter and allow paste and password managers.
- Changing or resetting a password revokes every other session and sends a "Your password was changed" notice.

### 4.4 Sessions

- The dashboard talks to the server through a same-origin path (`/api/*` on the dashboard, forwarded by `proxy.ts` to the server), so the session cookie is first-party and the server never needs cross-site cookies or CORS with credentials.
- Cookie: `__Host-pm_session`, `HttpOnly`, `Secure` (except on `localhost`), `SameSite=Lax`, `Path=/`, no `Domain`.
- Token: 32 random bytes, base64url; only its sha256 is stored.
- Lifetimes: idle 12 h for platform roles and 7 days for business roles; absolute 30 days for everyone; both configurable in Platform settings > Security within safe bounds.
- Rotation: a new token on sign-in, on any role or password change, on 2-step verification, and every 24 h of use; the old token stays valid for 60 s to absorb parallel requests.
- CSRF: every state-changing request must carry `X-Payminto-CSRF` (a per-session value the dashboard reads from `GET /v1/auth/session`) and an `Origin` that matches `PUBLIC_DASHBOARD_URL`.
- Step-up: changing the payout wallet, platform fee wallet, pricing, API keys, roles, or 2-step settings needs the password (or a TOTP code) again if the last check is older than 10 minutes.
- Sessions page: device, browser, IP, last active, "This device" tag, "Sign out" per row, and "Sign out everywhere else".
- Sign out everywhere: revokes all sessions for the user; platform owners can also revoke all sessions of any user from Platform team or Businesses > Team.

### 4.5 Sign in with wallet (optional)

- EIP-4361 message built by the server: `domain` = dashboard host, `uri` = dashboard origin, `chainId` = the server's chain (177 or 133), `nonce` from `POST /v1/auth/siwe/nonce` (single use, 5 minutes), `issuedAt`, `expirationTime` +5 minutes, statement "Sign in to Payminto. This does not move any funds."
- Verification checks domain, uri, chain id, nonce, and expiry, then the signature with `ecrecover`, or `isValidSignature` (ERC-1271) for Safe and smart-account wallets through the configured RPC.
- A wallet only signs in to an account that already linked it under Your account > Wallets (linking needs the password); there is no wallet-only account creation, so an account always has a recoverable email.
- 2-step verification still applies after a wallet sign-in.

### 4.6 Two-step verification

- TOTP (RFC 6238, 30 s, 6 digits), secret encrypted at rest with a key derived from `SESSION_SECRET`, plus 10 single-use recovery codes stored hashed.
- Optional for business roles, recommended on the owner checklist, and enforceable for platform roles through `require_2fa_platform`.

### 4.7 Roles and permissions

| Capability | Platform owner | Platform admin | Business Admin | Staff | Viewer |
|---|---|---|---|---|---|
| See payments, links, refunds, customers | all businesses | all businesses | own business | own business | own business |
| Create and edit payment links | yes | yes | yes | yes | no |
| Issue refunds | yes | yes | yes | request only | no |
| Approve refund requests | yes | yes | yes | no | no |
| Change payout wallet (wallet signature proof) | yes | no | yes | no | no |
| Payment methods on/off | yes | yes | yes | no | no |
| API keys and webhooks | yes | yes | yes | no | no |
| Blocked wallets list | yes | yes | yes | view | view |
| Invite and remove business members | yes | yes | yes | no | no |
| Budgets, paid services, settlements | yes | yes | if enabled | view if enabled | view if enabled |
| Run a settlement now | yes | yes | no | no | no |
| Add, suspend businesses | yes | yes | no | no | no |
| Pricing plans and platform fee wallet | yes | view | no | no | no |
| Platform earnings | yes | no | no | no | no |
| Platform team, sign-up rules, SMTP, network | yes | view | no | no | no |
| Email outbox (links without SMTP) | yes | no | no | no | no |
| Activity log | all | all | own business | no | no |

Permissions are checked on the server per route through one `can(actor, action, merchantId)` function; the sidebar and buttons read the same table from `GET /v1/auth/session`, so hiding is cosmetic and never the control.

### 4.8 Invites, sign-up and approval

- Invite: an Admin enters one or more emails and a role; each gets an `invite` token (32 bytes, hash stored, 7 days, single use) and a link `https://<dashboard>/invite/<token>`.
  The pending invite shows in Team with "Copy link", "Resend" and "Revoke".
  Accepting asks for name and password (or signs in an existing user and adds the membership), and marks the email verified because the link proves the inbox.
- Self sign-up is set by the platform owner in Settings > Platform > Sign-ups:
  - `off` (default): no public sign-up; only invites.
  - `approval`: anyone can create an account and a draft business; it sits in Sign-up requests until the platform owner or a platform admin approves it, and the applicant sees a "Waiting for approval" screen.
  - `open`: accounts and businesses are active right after email verification.
- A business created by sign-up gets the default pricing plan and stays unable to receive payments until it sets a payout wallet with a signature proof.

### 4.9 Email verification and password reset without an email server

- When `SMTP_URL` (or `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) is set, emails are sent through it with a plain-text and HTML body.
- When it is not set, every email is written to `outbox_emails` and to the server log (`[email] to=... link=...`), and the platform owner sees it in Platform > Email outbox with "Copy link".
  This page states plainly that the platform owner can see these links, and every view is written to the activity log.
  This is acceptable because the platform owner already controls the server and its database; it is the same trust model, made visible.
- Reset flow: "Forgot password" always answers "If an account exists for that email, we sent a link"; the token is 32 bytes, hash stored, 30 minutes, single use; the reset page asks for the new password twice and then signs out every session.
- Verification: link valid 48 hours; unverified users can sign in and see a banner, but cannot change payout wallets, create API keys, or invite people until verified.
- Settings > Platform > Email shows the SMTP status and a "Send test email" button.

### 4.10 Rate limits, lockout and abuse

- Per IP: 20 auth requests per minute across `/v1/auth/*`, sharing the existing token-bucket limiter.
- Per account: after 5 failed sign-ins in 15 minutes, a lock of 15 minutes, doubling up to 24 hours; the platform owner can unlock from Team.
- The lock message is the same as the wrong-password message plus "or try again later", so it does not confirm that the account exists.
- Reset and verify requests: 3 per email per hour.
- SIWE nonces: 10 per IP per minute.
- Every failure is counted in `/metrics` (`auth_failures_total{reason}`).

### 4.11 Audit log

- Written in the same transaction as the change it records.
- Events: sign-in, sign-in failed, sign-out, sign out everywhere, password changed, reset requested, 2-step on and off, wallet linked, invite sent, accepted and revoked, role changed, member removed, business created, approved and suspended, payout wallet changed, pricing changed, API key created and revoked, webhook created and deleted, refund issued, settlement run, recovery key used, outbox link viewed.
- The Activity log page lists them with actor, action in a plain sentence ("Priya changed the payout wallet to 0x12...ab"), time, IP, and a filter by person, action and date; exportable as CSV.
- Audit rows are append-only; retention follows `retention.ts` but never below 1 year.

### 4.12 API keys and the admin token

- API keys belong to one business, are created only by an Admin after step-up, are shown once, and are stored hashed (as today).
  Kinds: secret (`sk_live_`, `sk_test_`, full access) and restricted read-only (`rk_live_`, `rk_test_`).
  Keys authenticate API calls only; they no longer sign in to the dashboard.
- `ADMIN_TOKEN` becomes the **recovery key**:
  - It completes first-run setup when no owner exists.
  - After that it is refused by the dashboard and by every route unless `ADMIN_TOKEN_BREAK_GLASS=true` is set in env, which needs server access.
  - When enabled, every use is written to the activity log as `recovery_key`, and every signed-in platform owner sees a red banner "The recovery key is enabled" until it is turned off.
  - `/metrics` keeps accepting it (Prometheus scrape) or a separate `METRICS_TOKEN` when set.
- The demo (`pnpm demo`, `demo:stage`) seeds a platform owner `owner@demo.local` with a password printed in the demo output and stored in the demo seed file, plus one Admin per demo business, so the staged walkthrough signs in like a real user.

### 4.13 Screens and states

| Screen | Route | States |
|---|---|---|
| Setup | `/setup` | enter code, code wrong, code expired, create owner form, field errors, creating, done (redirect to Home checklist); already set up (redirects to sign-in) |
| Sign in | `/login` | idle, submitting, wrong email or password, locked (generic), needs 2-step code, wrong code, use recovery code, wallet button (connecting, wrong network, signature declined, wallet not linked), session expired notice, signed out notice, server unreachable |
| Create account | `/signup` | hidden when `signup_mode=off` (shows "Ask your platform owner for an invite"), form, email taken (generic "check your inbox"), submitting, check your inbox |
| Waiting for approval | `/signup/pending` | pending, approved (continue), declined (reason) |
| Verify email | `/verify/[token]` | verifying, verified, expired (resend), already used |
| Forgot password | `/forgot` | idle, sent (generic), rate limited |
| Reset password | `/reset/[token]` | form, weak password, mismatch, expired, done (sign in) |
| Accept invite | `/invite/[token]` | new user form, existing user "Sign in to accept", accepted, expired, revoked, wrong account signed in (switch) |
| Your account | `/account` | profile, password (step-up), 2-step setup (QR, confirm code, recovery codes shown once), wallets (link, unlink), sessions list |
| Team | `/settings/team` | members, pending invites, invite dialog, role change confirm, remove confirm, last-admin guard |
| Sign-up requests | `/platform/requests` | empty, list, approve, decline with reason |
| Email outbox | `/platform/outbox` | empty, list with copy link, SMTP configured (page hidden, link to Settings > Email) |
| Activity log | `/activity` | empty, list, filters, export |

Layout of all auth screens: centered card on a quiet background, product mark and the three lines from section 1 on the left on wide screens, network badge in the corner, no marketing beyond that.

## 5. Global search

### 5.1 Entry points

- `Ctrl K` (Windows, Linux) and `Cmd K` (macOS) open the command palette anywhere in the signed-in app; `/` focuses it when no input has focus.
- The sidebar search field opens the same palette.
- Each list page keeps its own filter bar (status, date, amount, method, business) and a search box scoped to that list; the palette is for jumping, the list filter is for narrowing.

### 5.2 Palette behavior

- Empty query shows: Recent (last 8 records and pages this user opened, stored server-side), Quick actions (New payment link, New budget, Issue refund, Invite teammate, Switch business), and Pages.
- Typing shows grouped results within 150 ms of the last keystroke: Actions, Pages, Payments, Payment links, Customers, Refunds, Businesses, Budgets, Paid services, Settlements, Settings.
- Pattern detection runs before full-text search:
  - `pay_`, `lnk_`, `ref_`, `mer_`, `mnd_`, `bat_` prefixes jump to that record.
  - `0x` + 64 hex: transaction hash, matched against payments, refunds and settlements.
  - `0x` + 40 hex: address, matched as payer, payout wallet, payment address, agent, budget owner or paid service, each labeled with its role.
  - An email: customers and payments.
  - A number like `12.5`: payments of that amount (top 5), labeled "Amount".
- Each row shows an icon per type, title, a muted subtitle (status, amount, business, time), and the matched field highlighted.
- Keyboard: arrows move, `Enter` opens, `Cmd/Ctrl Enter` opens in a new tab, `Tab` switches the group filter, `Esc` closes, `Backspace` on an empty query clears the filter chip.
- Typed prefixes filter one group: `p:` payments, `l:` links, `c:` customers, `b:` businesses, `a:` agents and budgets, `>` actions only.
- Empty result shows "No results for ..." with "Search all payments for ..." which opens Payments with the query applied.

### 5.3 What each role can find

| Type | Fields searched | Platform owner, admin | Business Admin | Staff | Viewer |
|---|---|---|---|---|---|
| Payments | id, reference, customer email, description, payer address, payment address, tx hash, amount | all | own | own | own |
| Payment links | id, slug, title, description | all | own | own | own |
| Customers | email, name, wallet | all | own | own | own |
| Refunds | id, payment id, tx hash, recipient | all | own | own | own |
| Businesses | id, name, slug, payout wallet, support email | yes | - | - | - |
| Budgets and agents | id, agent address, owner address, label | yes | if enabled | if enabled | if enabled |
| Paid services | id, name, endpoint, payee address | yes | if enabled | - | - |
| Settlements | id, tx hash | yes | if enabled | - | - |
| Webhooks, API keys | name, URL, key prefix | yes | yes | - | - |
| Pages and actions | static list | role-filtered | role-filtered | role-filtered | role-filtered |

### 5.4 Backend

- `GET /v1/search?q=<text>&types=payment,link&limit=8&merchant_id=<optional>` (session cookie or API key).
- Response:

```json
{
  "query": "0x9f...",
  "detected": "tx_hash",
  "groups": [
    {
      "type": "payment",
      "total": 2,
      "items": [
        {
          "id": "pay_01H...",
          "title": "Order 1001",
          "subtitle": "Paid - 20.00 USDC - Northwind Data - 2h ago",
          "href": "/payments/pay_01H...",
          "status": "paid",
          "matched": { "field": "tx_hash", "snippet": "0x9f...c2" },
          "merchant_id": "mer_..."
        }
      ]
    }
  ],
  "took_ms": 12
}
```

- Implementation: an SQLite FTS5 table `search_index(type, id, merchant_id, title, body)` kept in sync by the same write paths (insert and update triggers), plus exact-match indexes on addresses and tx hashes for pattern queries.
- Scoping is applied in SQL from the session's memberships, never from client parameters alone.
- Recent items: `GET /v1/search/recent` and `POST /v1/search/recent` (per user, last 20).
- Rate limit 10 queries per second per session; queries shorter than 2 characters return only pages and actions.

## 6. Checkout redesign brief

### 6.1 Goal

A first-time crypto payer finishes in under 30 seconds and never wonders whether it worked.
A judge watching a demo sees money move and land within two blocks, with a clear "Paid" moment.

### 6.2 Layout and hierarchy

- Desktop (768 px and wider): two columns in one card, max width 920 px.
  Left, tinted with the business brand color at 6 percent: business logo and name, what is being bought (title, line items), the amount in large type, fee lines when present, and "Paid directly to <business>" with the shortened payout wallet.
  Right: the pay panel.
- Mobile: single column; a compact summary bar (logo, name, total) that expands to the full breakdown; the pay panel below; the main button sticks to the bottom safe area.
- Pay panel order:
  1. Total to pay, with token icon and network badge ("USDC on HashKey Chain").
  2. Method switcher: segmented control "Wallet" and "Send to address" (and "Pay by QR" folds into Send to address on desktop).
  3. Method body (wallet button, or QR with address and amount copy rows).
  4. Time left, shown as a thin progress bar with "Expires in 24:13", turning amber under 5 minutes.
  5. Footer: "Need help?" (network help, section 8), business support email, and "Secured by Payminto".
- Typography: amount in tabular numerals; addresses in mono with the middle shortened and a copy button.

### 6.3 Motion and micro-interactions

Durations are the target; easing `cubic-bezier(0.2, 0.8, 0.2, 1)` ("out") unless stated; springs only where noted.

| Element | What moves | Duration and easing |
|---|---|---|
| Page load | Card fades in and rises 8 px; left column content staggers by 40 ms | 320 ms out |
| Skeleton | Shimmer on placeholders until the quote arrives | 1.2 s linear loop |
| Method switch | Selected pill slides under the active option; body cross-fades with 6 px horizontal shift; height animates | 220 ms out |
| Fee lines | Re-quote updates numbers with a vertical digit roll | 300 ms out |
| Copy address or amount | Icon morphs to a check, row background flashes positive tint, "Copied" toast slides up | 150 ms in, 1.2 s hold |
| QR code | Fades and scales from 0.96 when ready; a slow light sweep on the frame while watching for payment | 240 ms; sweep 2.4 s loop |
| Wallet connect | Button turns into an inline progress with the wallet icon and the step text ("Open your wallet", "Switching to HashKey Chain", "Approve the signature") | 200 ms per step change |
| Wrong network | Panel shakes once horizontally (4 px) and shows the switch button | 280 ms |
| Countdown | Bar shrinks linearly; color shifts to amber under 5 minutes, red under 1 minute | linear, color 400 ms |
| Payment detected | Panel collapses to a status card; a ring draws around the token icon to show progress through "Seen", "Sent", "Final" | ring 600 ms per step, out |
| Partly paid | Ring fills to the paid fraction, "Still to pay" amount counts down | 500 ms out |
| Success | Ring closes into a check (stroke draw 420 ms), the card background washes to positive tint, amount and "Paid" scale from 0.98, a short burst of 12 particles in the brand color once | spring stiffness 260, damping 22; total under 900 ms |
| Receipt rows | Tx link, time, "View payment proof" stagger in | 40 ms stagger, 200 ms each |
| Return to business | Auto-redirect countdown on the button when `success_url` is set (5 s), cancellable | linear |
| Expired | Card desaturates, timer turns into "Expired" with a single fade | 300 ms |
| Buttons | Press scales to 0.98; hover lifts shadow | 120 ms |
| Live status reconnect | Small dot pulses amber with "Reconnecting" | 1.6 s loop |

Reduced motion (`prefers-reduced-motion: reduce`): no movement, scaling, shake, particles or sweeps; only opacity changes at 120 ms or less; the progress ring becomes three labeled steps with check marks; the countdown bar is replaced by text.
Motion is built with CSS transitions and the Web Animations API, plus one small spring helper; no animation library is required, and no animation blocks input.

### 6.4 States

Loading, ready, quote refreshing, wallet: not installed (show "Send to address" instead and a wallet help link), connecting, wrong network, awaiting signature, signature declined, submitting, payment seen, sent, final (success), partly paid, paid extra (with "The business can refund the extra"), expired (with "Ask the business for a new link"), payment refused by safety checks (neutral: "This wallet cannot be used for this payment", no rule detail), link inactive, business suspended, server unreachable or reconnecting, already paid (opens success with receipt).

### 6.5 Trust cues

- "Paid directly to <business>'s wallet" with the shortened address and an explorer link.
- "Payminto never holds your money" under the amount, one line, linking to a short explainer.
- Network badge with the HashKey Chain mark and "Mainnet" or a yellow "Testnet" badge.
- Every fee line visible before paying; nothing added later.
- After paying: payment proof link that anyone can verify, and the transaction on the explorer.
- The business's support email always visible.
- No countdown pressure copy, no fake urgency.

### 6.6 References (concept only)

- Stripe Checkout: two-column summary and pay panel, brand tint on the summary side.
- Coinbase Commerce hosted checkout: method choice between wallet connect and send-to-address with QR.
- Apple Pay sheet: the success moment, a single drawn check with a short haptic-like settle.
- Square payment links (seen on Mobbin): a live phone and desktop preview while the business edits the link.
- Mercury payer page (seen on Mobbin): calm, minimal payment request card with clear methods.

## 7. Sidebar behavior

- Each section header is a button: label, a chevron that rotates 90 degrees, and when collapsed a count badge summing its children's badges (for example Records shows the Blocked count).
- Expand and collapse animate height and opacity in 180 ms out; reduced motion makes it instant.
- The section holding the current page always opens on navigation, even if the user collapsed it, and the active item scrolls into view (as today).
- Open and closed state per section is stored per user on the server (`user_prefs.sidebar`), with `localStorage` as a fast first paint, so it follows the user across devices.
- Defaults are in section 3; "Reset sidebar" in the user menu restores them.
- Keyboard: `Tab` reaches section headers, `Enter` or `Space` toggles, arrows move between items and headers, `[` collapses the whole sidebar to the rail and back; `G` then a letter jumps to pages (`G P` Payments, `G L` Payment links, `G R` Refunds, `G B` Budgets, `G S` Settings, `G H` Home), listed in the palette under "Keyboard shortcuts" (`?`).
- Collapsed rail (64 px): icons only, a divider between sections, tooltips with the page name and shortcut on hover and focus, badges as dots, the switcher becomes the business initial, the search becomes a magnifier icon; hover over a section divider shows a flyout with that section's pages.
  The rail state is stored like section state; the rail is the default between 1024 and 1280 px.
- Mobile (below 1024 px): bottom tab bar with Home, Payments, Payment links, Search, and More; More opens a full-height sheet with the switcher, search, and the same collapsible sections.
  Platform roles get Home, Payments, Businesses, Search, More.
- The sheet closes on navigation, supports swipe to close, and traps focus while open.

## 8. HashKey Chain resources

The page https://hashfans.io/dev-onepager renders in the browser and returned only its title to a plain fetch, so its content could not be extracted for this review.
The links below come from `docs/HASHKEY.md`, which was measured live on 2026-10-29, and from public chain registries; rows marked "check" must be confirmed against the HashKey docs or the dev one-pager before release.

| Resource | Mainnet (177) | Testnet (133) | Status |
|---|---|---|---|
| RPC | https://mainnet.hsk.xyz | https://testnet.hsk.xyz | measured |
| Fallback RPCs | https://hashkey.drpc.org, https://177.rpc.thirdweb.com | https://133.rpc.thirdweb.com | measured |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hskchain.net | measured (the older testnet-explorer.hsk.xyz does not resolve) |
| Contract verification API | https://hsk.blockscout.com/api/ | https://testnet-explorer.hskchain.net/api/ | measured; Sourcify also verifies |
| Faucet | - | https://faucet.hsk.xyz/faucet | measured |
| Official docs | https://docs.hsk.xyz | same | check |
| Bridge | https://bridge.hsk.xyz | - | check |
| Hosted RPC providers | GetBlock, Chainstack, dRPC, thirdweb | dRPC, thirdweb | public listings |
| Developer one-pager | https://hashfans.io/dev-onepager | same | link only |
| Native token | HSK, 18 decimals, 2 s blocks | same | measured |
| Stablecoins | USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a`, USDT `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` | USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | measured |
| Shared contracts | Multicall3, Permit2, Safe 1.4.1, EAS predeploy, EntryPoint v0.6 and v0.7 (addresses in HASHKEY.md section 5) | same | measured |

Where each piece shows up:
- **Settings > Platform > Network** (platform roles): current chain and id, RPC in use and its health (block height, latency), fallback RPC list, explorer, token in use with its address, finality rule ("Final after the safe head, about 24 s on mainnet"), contract addresses with explorer links, and a "Copy network config" button.
- **Developers > HashKey Chain** (everyone): "Add HashKey Chain to your wallet" buttons (mainnet and testnet, EIP-3085), RPC and explorer table, testnet faucet with a short "Get test HSK and USDC" checklist, bridge, docs, contract verification, token addresses, and SDK snippets (viem chain object, Foundry `--rpc-url` and `--verify` flags).
- **Checkout > Need help?** (customers): a sheet with three plain answers: "Which network?" (HashKey Chain, with a one-click "Add network" button), "Where do I get USDC on HashKey Chain?" (bridge link, exchanges note), "How do I check my payment?" (explorer link to their transaction, payment proof link).
  Testnet checkouts also show the faucet link.
- **Developer docs**: a "HashKey Chain" page that mirrors HASHKEY.md and links the dev one-pager.
- All links live in `packages/protocol/src/chains.ts` (one source), and the dashboard reads them through `GET /v1/info`, so a link changes in one place.

## 9. Build list

### Backend (apps/node, packages/protocol)

P0:
1. Migration `005_accounts.sql`: users, memberships, sessions, auth_tokens, wallet_logins, siwe_nonces, outbox_emails, audit_events, platform sign-up fields.
2. `auth/passwords.ts`: async scrypt hash, verify, rehash, common-password check.
3. `auth/sessions.ts`: create, rotate, revoke, revoke all, idle and absolute expiry, CSRF value.
4. Session middleware that resolves cookie, API key, or (break-glass) recovery key into one `actor`, and `can(actor, action, merchantId)` replacing the `admin` middleware on every route.
5. First-run setup code on boot, `/v1/setup` routes, and the `account reset-owner` CLI.
6. Routes: `/v1/auth/login`, `logout`, `logout-all`, `session`, `signup`, `verify`, `forgot`, `reset`, `invites` (create, list, revoke, accept), `members` (list, role, remove).
7. Mailer with SMTP when configured and the outbox plus log fallback otherwise.
8. Auth rate limits and account lockout on the existing limiter.
9. Audit writer called in-transaction from every sensitive route; `GET /v1/audit`.
10. Recovery-key rules: setup only by default, `ADMIN_TOKEN_BREAK_GLASS` gate, audit and banner flag in `/v1/auth/session`.
11. `GET /v1/search` with FTS5 index, pattern detection, membership scoping; recent items routes.
12. Demo seed of the owner and business admins, printed by `pnpm demo`.

P1:
13. SIWE nonce and verify routes with ERC-1271 support.
14. TOTP with encrypted secret and recovery codes; step-up checks on sensitive routes.
15. Sign-up modes and Sign-up requests approve and decline routes.
16. Refund requests for Staff with Admin approval.
17. Customers view built from payer email and wallet (`GET /v1/customers`).
18. Restricted read-only API keys (`rk_`).
19. Network info in `/v1/info`: RPC health, fallback list, explorer, faucet, bridge, docs links from `chains.ts`.

### Frontend (apps/dashboard)

P0:
1. `proxy.ts` forwards `/api/*` to the server so the session cookie is first-party; drop the token in local storage.
2. Auth screens: setup, sign in, forgot, reset, verify, invite accept, with every state in section 4.13.
3. Rename every user-facing string per section 2; move `/operator/*` to `/platform/*` with redirects; one product name in the brand block.
4. New sidebar: collapsible sections, per-role trees from section 3, persisted state, collapsed rail, mobile tab bar and sheet.
5. Account switcher with Platform and business list; user menu with sign out and sign out everywhere.
6. Command palette (`Cmd/Ctrl K`, `/`) on `GET /v1/search`, with pages, actions, recent, pattern hints, keyboard model.
7. Checkout redesign: layout, method switcher, progress ring, success moment, all states, reduced-motion path.
8. Team settings: members, invites with copy link, roles, remove.
9. Testnet and demo strip under the header; recovery-key banner.

P1:
10. Your account page: profile, password, 2-step, wallets, sessions.
11. Activity log page with filters and CSV export.
12. Sign-up requests and Email outbox pages.
13. Developers > HashKey Chain page and Settings > Network; checkout "Need help?" sheet with add-network button.
14. Customers page.
15. `G` shortcuts and `?` shortcut sheet.
16. Tooltips with the plain explanations from section 2.3 on every technical label.

### Docs

1. README: lead with the 10-second pitch and the one paragraph from section 1; "Payminto" only; sign-in with the demo owner instead of the admin token.
2. `docs/ACCOUNTS.md`: the account and security model in sections 4.2 to 4.12, including the platform owner's visibility of outbox links.
3. `docs/OPERATIONS.md`: setup code, SMTP env, recovery key and break-glass, owner reset CLI, session settings.
4. `GATEWAY.md` and `SPEC.md`: a short note that user-facing names live in this file; keep technical terms.
5. Developer docs page "HashKey Chain" mirroring section 8, with checked bridge and docs links.
6. `DESIGN_REFERENCES.md`: add the auth, sidebar, palette and checkout motion references from this file.
7. Demo script and `SUBMISSION.md`: use the new names (Budgets, Settlements, Payment links) in narration.

## 10. Account and search API

This is the contract the dashboard builds against for sections 4 and 5.
The node owns it (`apps/node/src/auth/*`, `apps/node/src/search.ts`); if the code and this section disagree, this section is fixed first.
Where this section is more specific than section 4, this section wins (deviations are listed in 10.15).

### 10.1 Transport, credentials and errors

- The dashboard calls the node through its own origin: `/api/v1/...` on the dashboard is forwarded by `proxy.ts` to `/v1/...` on the node, so the session cookie is first-party.
  Paths below are node paths (`/v1/...`).
- Bodies are JSON, snake_case, like section 8 of `GATEWAY.md`.
- Every request is resolved into one actor, in this order:
  1. `Authorization: Bearer sk_live_...` or `sk_test_...`: an API key, acting for its business (server-to-server, no cookie, no CSRF).
  2. `Authorization: Bearer <ADMIN_TOKEN>`: the recovery key (10.11).
  3. The session cookie.
- Business scope: the header `Merchant-Id: mer_...` names the business a request acts on.
  Without it a user acts on their only membership, else on `users.last_business_id` when they are still a member, else `400 MERCHANT_REQUIRED`.
  Platform roles without `Merchant-Id` act on the only business when there is exactly one; list endpoints marked "all businesses" in 10.12 return every business instead, each item carrying `merchant_id`.
  A business the actor cannot see is `404 UNKNOWN_MERCHANT`, never 403, so ids of other businesses are not confirmed.
- Errors keep the node shape `{ "error": { "code": "...", "message": "...", "details": { ... } } }`.

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body or query failed validation; `details.issues[]` has `{path, message}`. |
| 400 | `WEAK_PASSWORD` | `details.reason`: `too_short` (under 12), `too_long` (over 256), `common`, `equals_email`. |
| 400 | `MERCHANT_REQUIRED` | The actor belongs to several businesses and sent no `Merchant-Id`. |
| 400 | `SETUP_CODE_INVALID` | Wrong setup code. |
| 400 | `TOKEN_INVALID` | Unknown verify, reset or invite token. |
| 401 | `UNAUTHORIZED` | No valid credential. `details.reason`: `missing`, `expired`, `revoked`. The dashboard sends the user to `/login` (with "Session expired" when the reason is `expired`). |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password, unknown email, disabled account, or a locked account: one message for all, "Wrong email or password, or the account is temporarily locked. Try again later." |
| 401 | `SIGN_IN_REQUIRED` | Accepting an invite for an email that already has an account, while not signed in as it. |
| 401 | `RECOVERY_KEY_DISABLED` | The admin token was sent after setup without `ADMIN_TOKEN_BREAK_GLASS=true`. |
| 401 | `UNAUTHORIZED` | Also: an API key on a platform route (an API key is never a platform credential). |
| 403 | `FORBIDDEN` | The actor's role lacks the permission; `details.permission` names it. |
| 403 | `OPERATOR_ONLY` | A business tried to set method fees or limits (`methods.terms`). |
| 403 | `CSRF_FAILED` | Cookie-authenticated mutating request without a matching `X-Payminto-CSRF`, or with a foreign `Origin`. |
| 403 | `STEP_UP_REQUIRED` | Sensitive action (10.6) and the last password check is older than 10 minutes. |
| 403 | `EMAIL_NOT_VERIFIED` | Payout change, API key creation or invites before the email is verified. |
| 403 | `SIGNUP_DISABLED` | `POST /v1/auth/signup` while `signup_mode` is `off`. |
| 403 | `ACCOUNT_PENDING` | A user waiting for sign-up approval called a business route. |
| 404 | `UNKNOWN_MERCHANT` | The business does not exist or is not visible to the actor. |
| 404 | `NOT_FOUND` | Any other unknown or invisible record. |
| 409 | `SETUP_DONE` | Setup was already completed. |
| 409 | `TOKEN_USED` | The verify, reset or invite token was used, revoked or replaced. |
| 409 | `WRONG_ACCOUNT` | Accepting an invite while signed in as a different email. |
| 409 | `ALREADY_MEMBER` | Inviting or adding someone who is already a member. |
| 409 | `LAST_ADMIN` | Removing or demoting the last Admin of a business. |
| 409 | `OWNER_PROTECTED` | Changing, disabling or removing the platform owner. |
| 409 | `PAYOUT_REQUIRED` | A business created by sign-up has no proven payout wallet yet, so it cannot take payments. |
| 409 | `REFUND_APPROVAL_REQUIRED` | Submitting a Staff refund request that an Admin has not approved. |
| 410 | `SETUP_CODE_EXPIRED` | The setup code is older than 24 h (a new one is printed to the log). |
| 410 | `TOKEN_EXPIRED` | The verify, reset or invite token expired. |
| 429 | `RATE_LIMITED` | With `Retry-After` seconds and `details.scope` (`ip`, `auth`, `email`, `search`). |

### 10.2 Session cookie and CSRF

- Cookie name: `__Host-pm_session` when the dashboard origin (`PUBLIC_DASHBOARD_URL`, default `PUBLIC_CHECKOUT_URL`) is `https`; `pm_session` otherwise (browsers refuse `__Host-` and `Secure` cookies on plain `http`, which local development uses).
- Attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<seconds to the absolute expiry>`, plus `Secure` on https; never `Domain`.
- Value: 32 random bytes, base64url; the node stores only its sha256.
- The node sets the cookie on setup, sign-in, invite acceptance, password change and rotation, and clears it (`Max-Age=0`) on sign-out and when it sees a dead session.
  The dashboard never reads it; `proxy.ts` forwards `Cookie` and `Set-Cookie` unchanged.
- Lifetimes: idle 12 h for platform roles, 7 days for business-only users; absolute 30 days.
  Rotation: a new token on sign-in, password change, role change of that user, and after 24 h of use; the old token keeps working for 60 s.
- CSRF: every cookie-authenticated `POST`, `PUT`, `PATCH` and `DELETE` must send `X-Payminto-CSRF: <csrf_token>`, the value from the session object (10.3).
  The value is per session and changes when the session rotates; on `403 CSRF_FAILED` the dashboard re-reads `GET /v1/auth/session` once and retries.
  When the request has an `Origin` header it must equal the dashboard origin or one of `CORS_ORIGINS`.
  `GET`, `HEAD` and `OPTIONS` never change state and need no token.
  Requests with an API key or the recovery key are not cookie-authenticated and need no token.
  The pre-session routes (`/v1/setup`, `/v1/auth/login`, `signup`, `forgot`, `reset`, `verify`, `/v1/invites/lookup`, `/v1/invites/accept` without a session) need no token but still get the `Origin` check.

### 10.3 Session object

`GET /v1/auth/session` returns this; sign-in, setup, invite acceptance and password change return the same object.

```json
{
  "actor_type": "user",
  "user": {
    "id": "usr_9b1c...",
    "email": "priya@northwind.example",
    "name": "Priya",
    "email_verified": true,
    "status": "active",
    "platform_role": "owner",
    "last_business_id": "mer_01...",
    "created_at": "2026-11-01T10:00:00.000Z"
  },
  "memberships": [
    { "merchant_id": "mer_01...", "business_name": "Northwind Data", "business_slug": "northwind-data", "business_status": "active", "role": "admin", "created_at": "..." }
  ],
  "permissions": {
    "platform": ["platform.read", "platform.manage", "pricing.read", "pricing.manage", "businesses.read", "businesses.manage", "earnings.read", "team.read", "team.manage", "signups.review", "outbox.read", "audit.read", "agents.read", "agents.manage", "settlements.run"],
    "businesses": { "*": ["payments.read", "payments.write", "links.write", "refunds.issue", "refunds.approve"] }
  },
  "csrf_token": "b64url...",
  "session": { "id": "ses_4f...", "created_at": "...", "expires_at": "...", "idle_expires_at": "...", "step_up_until": "..." },
  "signup_request": null,
  "platform": { "name": "Payminto", "signup_mode": "off", "smtp_configured": false, "recovery_key_enabled": false, "agent_budgets_for_businesses": false }
}
```

- `permissions.businesses` maps a `merchant_id` to that business's permissions; `"*"` applies to every business (platform roles).
  The dashboard shows a page or button only when the permission is present; the node checks the same table on every route.
- `user.status` is `active` or `pending` (waiting for sign-up approval: the dashboard shows `/signup/pending`).
  For a pending user `signup_request` is `{ "id", "status": "unverified" or "pending" or "declined", "business_name", "reason" }`, else null.
- `platform.recovery_key_enabled` true means the dashboard shows the red "The recovery key is enabled" banner to platform owners.
- With the recovery key the object is `{ "actor_type": "recovery_key", "user": null, "memberships": [], "permissions": { "platform": [all], "businesses": { "*": [all] } }, "csrf_token": null, ... }`.

### 10.4 Roles and permission names

Platform roles (`users.platform_role`): `owner`, `admin`.
Business roles (`memberships.role`): `admin`, `staff`, `viewer`.
An API key acts as its business with the "API key" column.

| Permission | Owner | Platform admin | Business Admin | Staff | Viewer | API key |
|---|---|---|---|---|---|---|
| `payments.read` (payments, links, refunds, customers, overview) | all | all | own | own | own | own |
| `payments.write` (create, cancel payments) | yes | yes | yes | yes | - | yes |
| `links.write` (create, edit links; Staff only links they created) | yes | yes | yes | own links | - | yes |
| `refunds.request` | yes | yes | yes | yes | - | yes |
| `refunds.issue` (refund without approval, submit, cancel) | yes | yes | yes | - | - | yes |
| `refunds.approve` | yes | yes | yes | - | - | - |
| `payout.change` | yes | - | yes | - | - | - |
| `business.update` (profile, methods on and off) | yes | yes | yes | - | - | yes |
| `methods.terms` (method fees and limits) | yes | yes | - | - | - | - |
| `developers.manage` (API keys, webhooks) | yes | yes | yes | - | - | webhooks only |
| `screening.read` | yes | yes | yes | yes | yes | yes |
| `screening.manage` (blocked wallets list) | yes | yes | yes | - | - | yes |
| `members.read` | yes | yes | yes | yes | yes | - |
| `members.manage` (invite, role, remove) | yes | yes | yes | - | - | - |
| `audit.read` | all | all | own | - | - | - |
| `agents.read` (budgets, paid services, settlements, balances, next settlement, charges) | yes | yes | - | - | - | - |
| `agents.manage` (new budget, stop budget, new paid service) | yes | yes | - | - | - | - |
| `settlements.run` | yes | yes | - | - | - | - |
| `businesses.read` | yes | yes | - | - | - | - |
| `businesses.manage` (add, suspend, pricing plan of a business) | yes | yes | - | - | - | - |
| `pricing.read` | yes | yes | - | - | - | - |
| `pricing.manage` (pricing plans, default plan) | yes | - | - | - | - | - |
| `platform.read` (platform settings) | yes | yes | - | - | - | - |
| `platform.manage` (name, sign-up mode, flags) | yes | - | - | - | - | - |
| `earnings.read` | yes | - | - | - | - | - |
| `team.read` (platform team, all users) | yes | yes | - | - | - | - |
| `team.manage` (platform admins, unlock, disable, revoke sessions) | yes | - | - | - | - | - |
| `signups.review` | yes | yes | - | - | - | - |
| `outbox.read` | yes | - | - | - | - | - |

Platform roles hold every business permission on every business (`"*"`), except that a platform admin has no `payout.change`.
"Agent budgets for businesses" is stored and returned (`platform.agent_budgets_for_businesses`) but grants nothing yet: budgets, paid services and settlements have no business owner in the database, so those pages stay platform-only this round.

### 10.5 First-run setup

| Method and path | Auth | Body | Response |
|---|---|---|---|
| `GET /v1/setup` | none | - | `{ "needed": true, "platform_name": "Payminto", "network": { "chain_id": 133, "name": "HashKey Chain Testnet", "testnet": true }, "payout_default": "0x..." or null, "fee_wallet": "0x..." or null }`; after setup only `{ "needed": false, "signup_mode": "off" \| "approval" \| "open" }`, so the sign-in page can hide "Create an account" |
| `POST /v1/setup/check` | none | `{ "code": "ABCD-EFGH-..." }` | `200 { "ok": true }`; `400 SETUP_CODE_INVALID`, `410 SETUP_CODE_EXPIRED`, `409 SETUP_DONE` |
| `POST /v1/setup` | none | `{ "code", "platform_name"?, "name", "email", "password" }` | `201` session object plus `Set-Cookie`; the same errors plus `WEAK_PASSWORD`, `VALIDATION_ERROR` |

- The code is 32 random bytes in base32 (52 characters), printed in groups of four: `[setup] Open <dashboard>/setup and enter code ABCD-EFGH-...`; dashes, spaces and case are ignored.
- `ADMIN_TOKEN` is accepted as the code.
- Rate limit: 5 attempts per IP per minute (`429`, `details.scope: "auth"`).

### 10.6 Sign-in, sessions and your account

| Method and path | Auth | Body | Response |
|---|---|---|---|
| `POST /v1/auth/login` | none | `{ "email", "password" }` | `200` session object plus `Set-Cookie`; `401 INVALID_CREDENTIALS` |
| `GET /v1/auth/session` | cookie | - | `200` session object; `401 UNAUTHORIZED` |
| `POST /v1/auth/logout` | cookie | - | `200 { "ok": true }`, cookie cleared |
| `POST /v1/auth/logout-all` | cookie | - | `200 { "ok": true, "revoked": 3 }`, every session of the user ends, cookie cleared |
| `POST /v1/auth/step-up` | cookie | `{ "password" }` | `200 { "step_up_until": "..." }`; `401 INVALID_CREDENTIALS` |
| `GET /v1/auth/sessions` | cookie | - | `{ "items": [{ "id": "ses_...", "current": true, "created_at", "last_seen_at", "expires_at", "ip", "user_agent" }] }` |
| `DELETE /v1/auth/sessions/{id}` | cookie | - | `{ "id", "revoked": true }` (own sessions only) |
| `POST /v1/auth/sessions/revoke-others` | cookie | - | `{ "revoked": 2 }` |
| `PATCH /v1/auth/me` | cookie | `{ "name"?, "last_business_id"? }` | session object |
| `POST /v1/auth/password` | cookie | `{ "current_password", "new_password" }` | session object with a rotated cookie; every other session ends |
| `POST /v1/auth/verify/resend` | cookie | - | `202 { "ok": true }` |

- Sensitive actions need a password check within 10 minutes (`403 STEP_UP_REQUIRED`): payout change, creating or revoking API keys, role changes, pricing plans and the default plan, platform team changes.
  Sign-in counts as a check, so the first 10 minutes after sign-in need no extra prompt.
- Lockout: 5 failed sign-ins within 15 minutes lock the account for 15 minutes, doubling per lock up to 24 h; the owner unlocks with `POST /v1/users/{id}/unlock`.
- Rate limits: 20 requests per minute per IP across `/v1/auth/*`, `/v1/setup*` and `/v1/invites/lookup|accept`; reset, verify and resend 3 per email per hour (extra requests still answer `202` and send nothing).

### 10.7 Sign-up, email verification and password reset

| Method and path | Auth | Body | Response |
|---|---|---|---|
| `POST /v1/auth/signup` | none | `{ "email", "password", "name", "business_name" }` | `202 { "ok": true }` always (also for a taken email, which gets a "you already have an account" email instead); `403 SIGNUP_DISABLED`; `WEAK_PASSWORD` |
| `POST /v1/auth/verify` | none | `{ "token" }` | `200 { "ok": true, "email", "status": "active" or "pending" }`; `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_USED` |
| `POST /v1/auth/forgot` | none | `{ "email" }` | `202 { "ok": true }` always |
| `POST /v1/auth/reset/check` | none | `{ "token" }` | `200 { "ok": true, "email" }` or the token errors |
| `POST /v1/auth/reset` | none | `{ "token", "password" }` | `200 { "ok": true }`; every session of the user ends; the token errors, `WEAK_PASSWORD` |

- Links: verify `<dashboard>/verify/<token>` (48 h), reset `<dashboard>/reset/<token>` (30 min), invite `<dashboard>/invite/<token>` (7 days); every token is 32 random bytes, base64url, single use, stored hashed.
- Sign-up modes (`platform.signup_mode`): `off` (default), `approval`, `open`.
  `approval`: the account can sign in after verifying its email, sees `user.status: "pending"`, and a sign-up request waits in 10.9.
  `open`: verifying the email creates the business and makes the user its Admin.
  A business created by sign-up has no payout wallet (`payout_set: false` on the business); creating payments answers `409 PAYOUT_REQUIRED` until an Admin proves one.

### 10.8 Team: members and invites

| Method and path | Permission | Body | Response |
|---|---|---|---|
| `GET /v1/members` | `members.read` | - | `{ "items": [{ "user_id", "email", "name", "role", "status", "email_verified", "joined_at", "last_active_at" }] }` |
| `PATCH /v1/members/{user_id}` | `members.manage` + step-up | `{ "role": "admin" or "staff" or "viewer" }` | the member; `409 LAST_ADMIN` |
| `DELETE /v1/members/{user_id}` | `members.manage` | - | `{ "user_id", "removed": true }`; `409 LAST_ADMIN` |
| `GET /v1/invites` | `members.manage` | query `scope=platform` for platform invites | `{ "items": [{ "id": "inv_...", "email", "role", "merchant_id" or null, "status": "pending" or "expired", "expires_at", "created_at", "invited_by": { "id", "email", "name" } }] }` |
| `POST /v1/invites` | `members.manage` (`team.manage` for `platform_admin`) | `{ "emails": ["a@x.com"], "role": "admin" or "staff" or "viewer" or "platform_admin" }` | `201 { "items": [ { ...invite, "link": "<dashboard>/invite/<token>" } ] }`; `409 ALREADY_MEMBER` per item as `{ "email", "error": {...} }` |
| `POST /v1/invites/{id}/resend` | as create | - | the invite with a new `link`; the old link stops working |
| `DELETE /v1/invites/{id}` | as create | - | `{ "id", "revoked": true }` |
| `POST /v1/invites/lookup` | none | `{ "token" }` | `{ "email", "role", "business_name" or null, "platform": false, "status": "pending" or "expired" or "used" or "revoked", "user_exists": true, "signed_in_as": "email" or null }` |
| `POST /v1/invites/accept` | none or cookie | `{ "token", "name"?, "password"? }` | `200` session object plus `Set-Cookie`; `SIGN_IN_REQUIRED`, `WRONG_ACCOUNT`, token errors, `WEAK_PASSWORD` |

- A new user gives `name` and `password`; an existing user must be signed in as the invited email and sends only the token.
- Accepting marks the email verified.
- The link is returned only by create and resend; "Copy link" on an older pending invite calls resend.

### 10.9 Platform: team, users, sign-up requests, outbox and settings

| Method and path | Permission | Body | Response |
|---|---|---|---|
| `GET /v1/platform` | `platform.read` | - | existing fields plus `signup_mode`, `require_2fa_platform`, `agent_budgets_for_businesses`, `smtp_configured`, `recovery_key_enabled`, `dashboard_url` |
| `PATCH /v1/platform` | `platform.manage` (`pricing.manage` + step-up for `default_fee_plan_id`) | `{ "name"?, "default_fee_plan_id"?, "signup_mode"?, "agent_budgets_for_businesses"? }` | the platform |
| `GET /v1/platform/team` | `team.read` | - | `{ "items": [{ "user_id", "email", "name", "platform_role", "status", "last_active_at" }] }` |
| `PATCH /v1/platform/team/{user_id}` | `team.manage` + step-up | `{ "platform_role": "admin" or null }` | the user; `409 OWNER_PROTECTED` |
| `GET /v1/users` | `team.read` | query `q`, `limit`, `cursor` | `{ "items": [{ "id", "email", "name", "status", "platform_role", "email_verified", "locked_until", "memberships": [{ "merchant_id", "business_name", "role" }], "created_at", "last_active_at" }], "next_cursor" }` |
| `PATCH /v1/users/{id}` | `team.manage` | `{ "status": "active" or "disabled" }` | the user; disabling ends their sessions; `OWNER_PROTECTED` |
| `POST /v1/users/{id}/unlock` | `team.manage` | - | the user |
| `POST /v1/users/{id}/revoke-sessions` | `team.manage` | - | `{ "revoked": 4 }` |
| `GET /v1/platform/signup-requests` | `signups.review` | query `status=pending` (default) or `approved`, `declined`, `all` | `{ "items": [{ "id": "sur_...", "status", "business_name", "user": { "id", "email", "name", "email_verified" }, "merchant_id" or null, "reason" or null, "created_at", "decided_at", "decided_by" }], "counts": { "pending": 2 } }` |
| `POST /v1/platform/signup-requests/{id}/approve` | `signups.review` | - | the request, with `merchant_id`; the user becomes its Admin and gets an email |
| `POST /v1/platform/signup-requests/{id}/decline` | `signups.review` | `{ "reason"? }` | the request; the user gets an email |
| `GET /v1/platform/outbox` | `outbox.read` | query `limit`, `cursor` | `{ "smtp_configured": false, "notice": "...", "items": [{ "id", "to", "subject", "kind", "link", "created_at", "sent_at", "error" }], "next_cursor" }`; every call writes `outbox.viewed` to the activity log |
| `POST /v1/platform/email/test` | `platform.manage` | `{ "to"? }` (default: the caller's email) | `{ "ok": true, "delivered": "smtp" or "outbox" }` |

Email kinds: `verify_email`, `reset_password`, `invite`, `password_changed`, `signup_received`, `signup_approved`, `signup_declined`, `account_exists`, `test`.

### 10.10 Activity log

`GET /v1/audit` (`audit.read`): query `actor_id`, `action` (exact, or a prefix ending in `.` such as `auth.`), `merchant_id`, `from`, `to` (ISO times), `limit` (default 50, max 200), `cursor`, and `format=csv` for a CSV download of up to 10,000 rows.
Business Admins see only rows of their business (and get `404 UNKNOWN_MERCHANT` for another).

```json
{
  "items": [
    {
      "id": 4812,
      "at": "2026-11-01T10:02:11.000Z",
      "actor": { "type": "user", "id": "usr_...", "email": "priya@northwind.example", "name": "Priya" },
      "merchant_id": "mer_...",
      "action": "payout.changed",
      "target": "mer_...",
      "summary": "Priya changed the payout wallet to 0x12...ab",
      "ip": "203.0.113.7",
      "meta": { "from": "0x...", "to": "0x..." }
    }
  ],
  "next_cursor": "4811"
}
```

`actor.type` is `user`, `api_key` (id `key_...`), `recovery_key` or `system`.
Actions: `setup.completed`, `auth.signed_in`, `auth.sign_in_failed`, `auth.signed_out`, `auth.signed_out_everywhere`, `auth.locked`, `auth.password_changed`, `auth.reset_requested`, `auth.password_reset`, `auth.email_verified`, `session.revoked`, `invite.sent`, `invite.accepted`, `invite.revoked`, `member.role_changed`, `member.removed`, `platform_role.changed`, `user.disabled`, `user.enabled`, `user.unlocked`, `signup.requested`, `signup.approved`, `signup.declined`, `business.created`, `business.updated`, `business.suspended`, `payout.changed`, `pricing.changed`, `platform.updated`, `api_key.created`, `api_key.revoked`, `webhook.created`, `webhook.deleted`, `refund.requested`, `refund.approved`, `refund.issued`, `settlement.run`, `recovery_key.used`, `outbox.viewed`.

### 10.11 Recovery key (`ADMIN_TOKEN`)

- Before an owner exists, `Authorization: Bearer <ADMIN_TOKEN>` works on every route (bootstrap, as before) and as the setup code.
- After setup it is refused everywhere (`401 RECOVERY_KEY_DISABLED`) unless the node runs with `ADMIN_TOKEN_BREAK_GLASS=true`; `/metrics` keeps accepting it, or `METRICS_TOKEN` when set.
- Every use is written to the activity log as `recovery_key.used` (mutating requests always, reads at most once per path per minute).
- `platform.recovery_key_enabled` in the session object is true while break-glass is on after setup.

### 10.12 Existing routes and their permissions

Session cookies now work on every route that took the admin token or an API key; the node checks these permissions.

| Routes | Permission |
|---|---|
| `GET /v1/payments` (all businesses), `/v1/payments/{id}`, `/v1/links` (all businesses), `/v1/links/{id}`, `/v1/refunds` (all businesses), `/v1/refunds/{id}`, `/v1/gateway/overview`, `/v1/merchant` | `payments.read` |
| `POST /v1/payments`, `POST /v1/payments/{id}/cancel` | `payments.write` |
| `POST /v1/links`, `PATCH /v1/links/{id}` | `links.write` |
| `POST /v1/refunds` | `refunds.request`; without `refunds.issue` the refund is created with `approval: "requested"` |
| `POST /v1/refunds/{id}/approve` (new) | `refunds.approve` |
| `POST /v1/refunds/{id}/submit`, `/cancel` | `refunds.issue` (a requester may cancel their own request) |
| `PATCH /v1/merchant`, `PUT /v1/merchants/{id}/methods` (on and off) | `business.update`; fees and limits need `methods.terms` |
| `POST /v1/merchants/{id}/payout` | `payout.change` + verified email + step-up |
| `/v1/api-keys` | `developers.manage` + step-up for create and revoke (not for API keys) |
| `/v1/webhooks*`, `/v1/webhook-deliveries/*` | `developers.manage` |
| `GET /v1/screening/decisions` (all businesses), `GET /v1/screening/deny-list` | `screening.read` |
| `POST`, `DELETE /v1/screening/deny-list` | `screening.manage` |
| `GET /v1/merchants`, `GET /v1/merchants/{id}` | `businesses.read` |
| `POST /v1/merchants`, `PATCH /v1/merchants/{id}` | `businesses.manage` (`fee_plan_id` also needs `pricing.manage`) |
| `GET /v1/fee-plans*` | `pricing.read` |
| `POST`, `PATCH /v1/fee-plans*` | `pricing.manage` + step-up |
| `GET /v1/platform/fees` | `earnings.read` |
| `GET /v1/overview`, `/v1/mandates*`, `/v1/providers/{id}`, `/v1/calls`, `/v1/denials`, `/v1/batches*`, `/v1/ledger*`, `/v1/netting/preview`, `GET /v1/events` (SSE) | `agents.read` |
| `POST /v1/mandates`, `POST /v1/providers`, `POST /v1/mandates/{id}/revoke` (or the agent or owner signature, as before) | `agents.manage` |
| `POST /v1/settlements` | `settlements.run` |

Changes to existing objects in this round:
- `GET /v1/payments` `counts` now respect every filter except `status` and `refunded`, which are the tabs themselves (so the tabs show counts for the current link, email or search).
- Payment links take an optional `expires_at` (ISO time, at least 60 s ahead, or null) on create and `PATCH`; after it the link answers like an inactive link (`410 LINK_EXPIRED` on the public routes) and its JSON has `expired: true`.
- Refunds take an optional internal `note` (max 1000 characters, never shown to the customer) on create and `PATCH /v1/refunds/{id} { "note" }`; refunds also carry `approval` (`not_required`, `requested`, `approved`), `requested_by` and `approved_by` (user ids or null).
- Pending webhook deliveries carry `next_attempt_at` (the scheduled time); `scheduled_at` is the same value on every delivery.
- Pricing plans carry `merchant_count`.
- Businesses carry `payout_set` (false for a business created by sign-up until it proves a payout wallet).
- Screening decisions carry a merchant-facing `message` ("This wallet is on your blocked list", "This wallet is frozen by the token issuer", "Your payout wallet is frozen by the token issuer", "This wallet has too little history to accept payments from").
- `GET /v1/links/public/{slug}` adds `methods: [{ method, enabled, surcharge_bps, surcharge_fixed, quote }]` for enabled methods: only what the customer pays on top (zero when the business bears the fee), and for a fixed-amount link `quote: { amount, surcharge, amount_due }` (null when the amount is outside that method's limits).
- `CORS_ORIGINS` defaults to the dashboard origin (`PUBLIC_DASHBOARD_URL`, `PUBLIC_CHECKOUT_URL`) plus `http://localhost:3000`.
- `/v1/info` `network` adds `rpc_url` (the public RPC a browser wallet should use; never the node's private RPC when it carries a key), `fallback_rpc_urls`, `faucet`, `bridge` and `docs`.
- `PATCH /v1/platform { "name" }` renames the platform; the name is shown on checkout, emails and the sign-in screen and is no longer reset by `PLATFORM_NAME` after first boot.

### 10.13 Global search

`GET /v1/search?q=<text>&types=payment,link&limit=8&merchant_id=<optional>` (cookie or API key, `payments.read`), response as in section 5.4.

- `types`: any of `payment`, `link`, `customer`, `refund`, `business`, `budget`, `paid_service`, `settlement`; default all the actor may see.
  `limit` is per group, default 8, max 20; `total` counts matches up to 100.
- `detected`: `id` (prefixes `pay_`, `plink_`, `re_`, `mer_`, `cus_`), `tx_hash` (`0x` + 64 hex: payments, refunds, settlements; a bytes32 is also tried as a budget id), `address` (`0x` + 40 hex: payer, payment address, payout wallet, budget agent or owner, paid service payee, each with `matched.field`), `email`, `amount` (`12.5` matches payments of that amount, top 5), or `text`.
- Text search matches the start of words in titles, descriptions, references, names, emails and slugs (SQLite FTS5 prefix query), newest first.
- Scope is applied in SQL: platform roles see every business, or only `merchant_id` when given; business users see only their memberships (a `merchant_id` they do not belong to is `404 UNKNOWN_MERCHANT`); API keys see their business; `business`, `budget`, `paid_service` and `settlement` groups need the platform permissions in 10.4.
- Item fields: `id`, `type`, `title`, `subtitle`, `href` (dashboard path), `status` or null, `matched: { field, snippet }`, `merchant_id` or null.
- Queries shorter than 2 characters return `{ "groups": [] }`.
- Rate limit 10 queries per second per session (burst 20), `429` with `details.scope: "search"`.
- Recent: `GET /v1/search/recent` returns `{ "items": [{ "type", "id", "title", "href", "at" }] }` (last 20, newest first) and `POST /v1/search/recent { "type", "id", "title", "href" }` records one (cookie only).

### 10.14 Customers

`GET /v1/customers` (`payments.read`, all businesses for platform roles): query `q` (email or wallet prefix), `limit`, `cursor`.
A customer is one email, or one payer wallet for payments without an email, within one business.

```json
{
  "items": [
    {
      "id": "cus_bWVyXzAx...",
      "merchant_id": "mer_...",
      "email": "alice@example.com",
      "name": "Alice",
      "wallets": ["0xAbC..."],
      "payments": 3,
      "paid_payments": 2,
      "total_paid": "4000000",
      "total_refunded": "0",
      "first_payment_at": "...",
      "last_payment_at": "..."
    }
  ],
  "next_cursor": "50"
}
```

`GET /v1/customers/{id}` returns the same fields plus `recent_payments` (the last 20 payments, payment JSON).
The id is opaque and stable (`cus_` plus base64url of the business id and the lowercase email or wallet), so it needs no table and carries its business; use it as is in `/customers/{id}`.

### 10.15 Deviations from section 4 in this round

- The migration is `007_accounts.sql` (`005` and `006` were taken by the gateway).
- Not in this round: two-step verification (4.6), sign in with wallet (4.5), restricted `rk_` keys (4.12); the session object and permission names already leave room for them.
- The common-password check uses a bundled list of common passwords of 12 or more characters plus pattern checks (repeats, sequences, the email or platform name), since shorter ones are already refused by length.
- The account reset CLI is `pnpm --filter @payminto/node account reset-owner --email <email>`.
- The demo signs in as `owner@demo.local` with a generated password written to the demo data directory and printed once in the stage summary.
