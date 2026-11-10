# Payminto Clearing dashboard

Console for a Payminto clearing node on NEAR: Budgets, Payees, live Calls and Refusals, netting, settlement batches, Call proofs, the double-entry ledger, and the hosted checkout for people.

Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui on Radix, TanStack Query, Recharts, NEAR Connect (`@hot-labs/near-connect` 0.12.0).

## Run

```bash
pnpm install                                  # from the repo root
pnpm --filter dashboard dev:mock              # in-browser mock node with fixtures, http://localhost:3000
NEXT_PUBLIC_MOCK=empty pnpm --filter dashboard dev   # fresh mock node, shows the first-run guide
NEXT_PUBLIC_NODE_URL=http://localhost:8787 pnpm --filter dashboard dev   # a live clearing node
```

Against a live node, open `/setup` the first time and enter the one-time setup code from the node's log (`ADMIN_TOKEN` also works), then create the owner account.
After that, sign in at `/login` with email and password.
The node must allow the dashboard origin in `CORS_ORIGINS` (default `http://localhost:3000`).
Owners open, fund, stop and reclaim Budgets from their own NEAR wallet; every transaction is shown before the wallet asks.
The wallet network is testnet unless `NEXT_PUBLIC_NEAR_NETWORK=mainnet`.
In mock mode a labeled demo wallet applies each transaction to the in-browser hub, and nothing reaches a chain.

Call proofs and payment proofs are checked in the browser against NEAR with `NearReader` from `@payminto/chain`: read-only JSON-RPC at final finality, never the server's word.
The RPC is `NEXT_PUBLIC_NEAR_RPC_URL` when set, otherwise the network's public RPC (`https://rpc.testnet.near.org` on testnet).
A remote node never chooses the RPC its own claims are checked against; only on a local sandbox does the page use the node's RPC.
Each read times out after 8 seconds and the page offers to read again; a read that did not finish is shown as not checked, never as verified.
In mock mode the same reader talks to the demo hub inside the browser, and the page says "Demo, no network".

## Any-chain checkout (NEAR Intents)

When the node runs the any-chain checkout (`INTENTS_CHECKOUT=simulated` or `live`, docs/DEVELOPERS.md "Any-chain checkout") and the business turned it on, the hosted checkout shows two tabs: "NEAR wallet", first and unchanged, and "Any chain".
The buyer's steps:

1. Pick a token and chain from one list: USDC on Base, Ethereum, Arbitrum, Solana or Polygon, USDT on Ethereum, ETH on Base or Ethereum.
   Each row shows the indicative amount and time from the node's signed dry quote; a route 1Click refuses is greyed with the reason.
2. Enter a refund address on that chain; it is checked for the chain's format before the button enables.
3. Press "Get deposit address" (`POST .../intents/quotes` with an `Idempotency-Key`, so a retry gets the same address).
4. Send exactly the amount shown to the address or its QR code before the deadline; the fee lines and the warning come from the signed quote.
   "I've sent it" takes the transaction hash, which only speeds up detection.
5. Watch the steps (waiting, received, converting, delivered) live on the checkout's event stream, with polling when the stream is down.
   The success screen says "Paid from Base through NEAR Intents" with the deposit and the NEAR delivery transactions; a returned, failed or expired deposit has its own screen and "Try again".

Every screen with intents data carries "Simulated" or "Live - NEAR mainnet".
In simulated mode the deposit screen has "Simulate deposit (local only)" and "Send too little", which shows a returned deposit.

The business sets it up in Settings, Payment methods, "Accept any chain (NEAR Intents)": the NEAR account the USDC lands in, its three checks (it exists, it is registered with USDC, it signed a NEP-413 message for this server), the storage deposit when it is not registered, and the switch.
The server refuses the switch until the checks pass, and the page says why.
A payment paid this way has a "NEAR Intents" card with the origin, the amount sent, the addresses, both transactions, how the delivery was checked, returned deposits and the signed quote.

In mock mode Acme Store takes any-chain payments, simulated, and one earlier payment was paid from USDC on Base; `?demo=intents-setup` starts with nothing set up.
The mock waives Acme's platform fee on this rail so the flow can be clicked; a node offers it only for a payment that carries no platform fee.

Captures from `pnpm local` are in `docs/screenshots`: `anychain-choose-1280-light.png`, `anychain-deposit-1280-light.png` and `-375-light.png`, `anychain-incomplete-1280-light.png`, `anychain-returned-1280-light.png` and `-375-light.png`, `anychain-paid-1280-light.png` and `-375-light.png`, `intents-card-1280-light.png`, `anychain-settings-1280-light.png` and `embed-demo-paid-1280-light.png`.

## Drop-in pay button

`public/embed.js` is served by the dashboard, has no dependencies and no build step:

```html
<script src="https://pay.example.com/embed.js" defer></script>
<button data-payminto-link="coffee-5usd">Pay with crypto</button>
```

A click opens the hosted checkout (`/l/<slug>`, or `/pay/<id>` with `data-payminto-payment`) in a centered popup, or in the same tab on a phone or when the popup is blocked.
The checkout posts `{ type: "payminto:payment", id, status }` to the page that opened it, at the origin the script put in the URL fragment and nowhere else, and the button receives `payminto:payment` and `payminto:paid` events.
They are a convenience for the page; fulfil orders from the signed webhook.
A payment link's page shows the two lines with its slug filled in, and `/embed-demo.html?link=<slug>` shows the button working.

## Revoke and reclaim without gas

An owner with no NEAR for gas can still stop an agent.
Set `NEXT_PUBLIC_RELAYER_URL` to a Payminto relayer (`apps/relayer`) and the Budget page offers "Revoke without gas" next to "Revoke on NEAR", and "Reclaim without gas" next to "Reclaim escrow" when the relayer lists `reclaim`.
The relayer's `CORS_ORIGINS` must include the dashboard's origin.
Without the variable the page says in one line that the option is off and how to turn it on; it never shows a button that cannot work.

How it works, in order:

1. The page reads the relayer's `GET /info` and refuses when the relayer sponsors another hub, another network or not this method, before any wallet is asked.
   Nothing that attaches a deposit is ever offered.
2. The review shows exactly what is signed (the hub, the method, the Budget id, no deposit) and that the relayer pays the gas.
3. The wallet signs a NEP-366 delegate action through NEAR Connect: `wallet.signDelegateActions({ network, delegateActions: [{ receiverId, actions }] })`, which answers `{ signedDelegateActions: string[] }`, each a base64 Borsh `SignedDelegateAction`.
   The wallet, not the page, picks the access key, its next nonce and the block height the signature expires at.
4. The page decodes what the wallet signed with `@payminto/near-addons`, compares it with the call that was reviewed, and reads the key's nonce and the final block height from NEAR with the add-on's read-only `ViewRpc`.
   A signature over anything else, from a key that is not on the account, with a used nonce or already expired is refused here and never reaches the relayer.
5. The page posts `{ signedDelegate }` to `POST /relay` and waits, for up to a minute, while the relayer sends it.
6. The page then reads the Budget from the hub itself.
   It says "Final on NEAR" only when the hub shows the revoke: neither the relayer's answer nor the outer transaction's status is taken as proof.

What a person sees when it does not go through:

- `CALL_FAILED`: the transaction ran and the hub refused the call. The page shows the hub's reason and the transaction, and never shows the Budget as revoked.
- `RPC_FAILED` with an unknown outcome, or an answer the page cannot read: "The result is unknown", a read of the hub, and "Check again". No retry is offered until the hub has been read.
- `NONCE_USED` with a transaction: that first transaction is shown and the hub is read.
- `NOT_SPONSORED`, `RATE_LIMITED`, `BAD_SIGNATURE`, `EXPIRED`, `MALFORMED`, an unreachable relayer: nothing was sent, with what to do next, which is usually to revoke from a wallet that holds NEAR.

Wallets whose NEAR Connect manifest entry had both `signDelegateActions` and `testnet` on 2026-11-10: Meteor Wallet, Intear Wallet, Ledger and NEAR CLI.
HOT Wallet and NEAR Mobile sign delegates on mainnet only.
Support is read from the connected wallet's manifest at the time of the click, and a wallet that cannot sign is told so with the names of the ones that can.

## A DAO treasury as the owner

A Budget's owner can be a Sputnik DAO v2 (`<name>.sputnik-v2.testnet` on testnet), so a treasury that several people control funds an agent and no single member can drain or stop it alone.
"New Budget" asks for the owner first: "Owner: my account" or "Owner: a DAO I am a member of".
For a DAO, every owner action is a proposal the connected member signs with the DAO's exact bond: opening the Budget, each deposit (`ft_transfer_call`), moving credit into escrow, the revoke and the reclaim.
Every proposal and every vote is built by `@payminto/near-addons` (`dao.openBudgetProposal`, `dao.depositProposal`, `dao.voteTx` and the rest), never by hand.
The flow uses standard Sputnik DAO proposals; it is not tied to any DAO interface.

- The DAO is read from NEAR in the browser with the same read-only reader as the proofs: `get_policy`, `get_last_proposal_id` and `get_proposals({ from_index, limit })` (the newest 50), and `delegation_balance_of` when the policy has a token role.
- The policy decides what is shown: whether the connected account may propose or vote on `call` proposals, the bond, and how many approvals run a proposal.
- A Budget owned by a DAO has a "Proposals" panel: each proposal that concerns this Budget in plain words ("Deposit 25.00 USDC into this Budget"), the votes so far, and Approve and Reject, which sign `act_proposal` with the proposal kind.
- A proposal to the hub or the token that the add-on's `auditBudgetProposal` does not pass is labeled "Unrecognized call, review on chain" and cannot be approved from the dashboard.
- A Budget proposed to a DAO is not on the hub yet, so the server cannot register it. `/budgets/proposed/<id>` follows it: members approve there, the page reads the hub until it holds the Budget, then registers it with the server.
  Until then its rules and name are kept in this browser's localStorage (`lib/dao-drafts.ts`), because only the hash of the rules is on chain.
- Gasless revoke is not offered for a DAO owner: a DAO acts by proposal.

## Payee approvals

When the server runs the payee check, a Budget's page shows it without hunting, at the top when something waits:

- "Waiting for your approval": each Call the agent made to a Payee the check has a warning about, with the amount, the attempts and every reason, and Approve or Deny with an optional note. It updates live on `payee.approval_requested` and `payee.approval_decided`.
- A badge beside every Payee with its standing (no concerns, approved, waiting, do not pay, denied), and the full verdict from `@payminto/payee-check` one click away.
- A Payee the check blocks never offers Approve. "Approve anyway" needs the account id typed exactly and sends `overrideBlock`; a `409 PAYEE_BLOCKED` to a plain approval opens the same step.
- "Payee decisions": who decided what and when, with Withdraw.
- "Report this account" with a reason and a transaction hash or https link. Reports are quoted as plain text and their evidence is never a link.
- With the check off on the server (`409 PAYEE_CHECK_OFF`, or `payeeChecks: null`), this browser checks a Payee on request and says so.

Refusals with `PAYEE_NEEDS_APPROVAL` and `PAYEE_BLOCKED` link to the Budget's own page; the `approveAt` the server sends is shown, never followed.
In mock mode the Budget "Vendor Agent - supplier payments" holds a waiting Call, an approved Payee, a blocked one and a reported one; `?demo=payee-check-off` plays a server with the check off, and `?demo=payee-request-arrives` sends a new request a few seconds after the page opens.

## Mock mode switches

`pnpm --filter dashboard dev:mock` has a demo wallet, a demo relayer and a demo DAO (`northwind-ops.sputnik-v2.testnet`, three council members, 2 of 3 to approve), all in the browser.
The Budget "Ops Agent - DAO treasury" is owned by the DAO, with one approved and one pending proposal.
The Proposals panel has a "Demo only" control that makes the demo wallet act as another member, or as an account that is not a member.
Failure states are switched on in the address bar and stay for the tab until `?demo=off`:

| `?demo=` | What it plays |
| --- | --- |
| `wallet-rejects` | The person cancels every wallet request. |
| `wallet-no-delegate` | A wallet that cannot sign delegate actions. |
| `relayer-down` | The relayer cannot be reached. |
| `relayer-wrong-hub` | The relayer sponsors another hub. |
| `relayer-not-sponsored` | `403 NOT_SPONSORED`. |
| `relayer-rate-limited` | `429 RATE_LIMITED`, as when the daily gas budget is spent. |
| `relayer-call-failed` | `422 CALL_FAILED`: the hub refused the call. |
| `relayer-unknown` | `502 RPC_FAILED` with an unknown outcome. |
| `relayer-slow` | The relayer takes nine seconds, to see the waiting state. |
| `dao-edge` | The DAO also holds a proposal whose voting period has ended and a call Payminto does not expect. |
| `intents-setup` | Acme Store has not set up the any-chain checkout yet; read when the page loads. |

Several can be combined with commas.

## Check

```bash
pnpm --filter dashboard lint
pnpm --filter dashboard typecheck
pnpm --filter dashboard test
pnpm --filter dashboard build
```

## Layout

- `lib/api.ts` typed client for the node's HTTP API (`docs/DEVELOPERS.md`), every response parsed with the zod schemas in `lib/schemas.ts`.
- `lib/mock/server.ts` the mock node, built on `@payminto/protocol` so Merkle proofs and netting are real.
- `lib/live.tsx` SSE subscription (`/v1/events?token=`) that refreshes the affected screens.
- `lib/netting.ts` the hub's netting algorithm, the two-column flow layout and the before-versus-after figures used on the Netting screen.
- `lib/denials.ts` plain-language names for each policy rule and the per-rule summary on Blocked calls.
- `lib/agents-api.ts` the hosted business agent routes (`docs/DEVELOPERS.md`, "Hosted business agents"); `lib/agents.ts` plain words, the run timeline, polling rules and who may do what; `lib/run-follower.ts` follows one run from the live stream, falling back to `?wait=25` long polls and `events?after=`; `lib/mock/agents.ts` the demo connections, agents and runs with a step-by-step worker.
- `lib/spend.ts` the Budget bar and validity countdown; `lib/proof.ts` the individual checks behind a receipt verdict.
- `lib/seller-settlement.ts` a Call its seller settled on the hub (`settle_own`): settled, in no batch, with no Merkle proof, checked against the hub's settled position that `lib/use-hub-position.ts` reads in the browser.
- `lib/operator-alerts.ts` the server's `operator.alert` events as warnings that say what happened and what to do; `lib/hub-readiness.ts` the server's receipt key and prepaid storage on the hub, which `lib/use-hub-readiness.ts` reads from the hub because the server reports them only in its log and metrics.
- Mock mode shows these states with `?demo=hub-not-ready`, `?demo=operator-alert` and `?demo=seller-settles` (`lib/mock/scenario.ts`); `?demo=off` clears them.
- `lib/wallet.ts` the only module that talks to a NEAR wallet (NEAR Connect), including `signDelegateActions`; `lib/mock/wallet.ts` the demo wallet that applies transactions to the mock hub.
- `lib/relayer.ts` the relayer's two routes and its error codes in plain words; `lib/gasless.ts` one gasless action from review to the hub; `lib/use-gasless.ts` whether the option can be offered right now.
- `lib/dao.ts` a Sputnik DAO's policy and proposals, parsed and decoded for one Budget; `lib/use-dao.ts` the reads; `lib/dao-drafts.ts` Budgets proposed to a DAO and not yet on the hub.
- `lib/mock/dao.ts`, `lib/mock/relayer.ts` and `lib/mock/scenario.ts` the demo DAO, the demo relayer and the `?demo=` switches.
- `lib/intents.ts` the any-chain checkout's screens and words, the refund address check and the business's checklist; `components/checkout/intents.tsx` the buyer's screens; `components/gateway/any-chain-settings.tsx` and `intents-card.tsx` the business's; `lib/mock/intents.ts` the simulated flow of the mock node.
- `lib/embed.ts` the opener message of the drop-in button and its snippet; `public/embed.js` the script itself.
- `lib/grace.ts` the revoke grace period, read from the chain package in one place and put into words for every screen.
- `components/ds/` the design-system components (AccountId, Amount, StatusPill, BudgetMeter, RefusalReason, CallRow, BatchSummary, ProofPanel, TxFlow, PayeeVerdict).
- `docs/screenshots/` captures from the mock server at 375px and 1280px, light and dark, named `<screen>-<width>-<theme>.png`.
- `docs/DESIGN_REFERENCES.md` the Mobbin references behind each screen.
