# Architecture

Payminto is a clearing layer for agent payments on NEAR.
A business gives an AI agent a bounded Budget.
The agent pays APIs per call over HTTP 402 with signed vouchers.
A clearing node refuses any call that breaks the Budget and records the rule that fired.
Many calls settle as a few USDC transfers, and anyone can prove one call against a root stored on NEAR.

This page describes the parts, follows one paid call from the 402 to the proof, and states what the operator can and cannot do.
The full list of limits is in [SECURITY.md](SECURITY.md), and every refusal with the test that proves it is in [REFUSALS.md](REFUSALS.md).
The design record is `docs/superpowers/specs/2026-11-10-near-clearing-design.md`.
Where this page and the code differ, the code is what runs; `contracts-near/README.md` and `apps/node/README.md` sit next to it.

## Components

| Part | Path | What it does |
|---|---|---|
| Hub contract | `contracts-near/` | Rust contract on NEAR, one module per invariant. Escrows a NEP-141 token in owner-funded Budgets, verifies vouchers and node acceptances, settles netted batches, stores a Merkle root per settler and batch id, keeps each settler's receipt keys and prepaid storage balance and each Budget's prepaid storage reserve, pays out credit, and logs a NEP-297 event for every state change. Locked: the account has no access keys |
| Chain seam | `packages/chain` | The only package that imports NEAR libraries: types, the `Chain` interface, Borsh digests, the Merkle tree, wallet transaction builders (`actions.ts`), `FakeChain` (simulated hub), `NearRpcChain` (RPC client on near-kit) and `scripts/deploy-hub.ts` |
| Protocol | `packages/protocol` | x402 v2 wire schemas for the `payminto-voucher` scheme, policy rules and refusals, gateway wire types, webhook signatures |
| Clearing node | `apps/node` | Hono HTTP server on `node:sqlite`. Registers Budgets, checks every voucher against policy, signs receipts and refusal records, builds and settles batches, books what sellers settle themselves, runs payouts, sends refusal webhooks, exports settlements, and runs the merchant gateway |
| SDK | `packages/sdk` | `paywall()` for sellers with a voucher store, `AgentClient` for paying agents, `OwnerClient` for Budget owners, `GatewayClient` for merchants, receipt verification |
| MCP server | `apps/mcp` | Gives any MCP client a wallet bound to one Budget: list services, pay, read the Budget, list and prove receipts. A second server (`--merchant`) is a business back office |
| Agent runtime | `apps/agent` | `payminto-agent`: key generation, a buyer agent, a seller skill, an ops agent, on a provider-neutral model loop |
| Model layer | `packages/models` | One `ModelClient` over Anthropic, OpenAI, Google Gemini, Replicate, any OpenAI-compatible endpoint, and NEAR AI Cloud, whose enclave attestation is checked and recorded per model turn |
| Dashboard | `apps/dashboard` | Next.js console: Budgets, refusals, netting, batches, proofs, payouts, ledger, and the hosted checkout. Owners approve or deny payees the check warns about, revoke without gas through a relayer, and run a DAO-owned Budget by Sputnik DAO proposals. Proofs are read from NEAR in the browser. Wallets connect through NEAR Connect |
| Local stack | `apps/local` | `pnpm local`: the whole product on a sandbox (a local NEAR node) with the real contracts deployed and locked, the real node, dashboard and relayer, and a development-only signer for local test accounts in place of a wallet. `pnpm local --check` runs the walkthrough as a script |
| Demo | `apps/demo` | `pnpm demo` (simulated hub), `pnpm demo --chain sandbox` (a local NEAR node), `pnpm verify:near` (prove a receipt with no node and no keys) |
| Swarm | `apps/swarm` | `pnpm swarm`: 20 buyer agents and 5 seller agents on their own sub-accounts run sealed-bid rounds, pay per delivered unit, and clear through the node and the hub; `pnpm swarm verify` re-checks a round from its signed messages |
| Relayer | `apps/relayer` | Optional gas relayer: pays NEAR gas only for listed zero-deposit calls to its own hub (`revoke_budget`, `reclaim`, `payout`), sent as NEP-366 delegate actions |
| Payee check | `packages/payee-check` | Read-only counterparty check that answers allow, warn or block for a payee, with a command line and an attack demo. The node calls it before it accepts a voucher, and the MCP wallet before it signs one |
| Agent Market | `packages/agent-market` | Integration with the NEAR AI Agent Market: live quotes checked against an owner's limits (`pnpm market`, the wallet's `quote_market_agent`), and a seller worker whose deliverable lists verifiable costs (`pnpm agent market work`). The market holds and pays the money; Payminto does not settle, hold or route market jobs |
| Add-ons | `packages/near-addons` | Optional and never imported by the core: 1Click (NEAR Intents) exit, Sputnik DAO owner proposals, agent sub-accounts, NEP-366 gasless revoke, Omni Bridge route check, Chain Signatures payout |

The core is the hub, the chain seam, the protocol, the node and the SDK.
It runs with the swarm, the relayer, the Agent Market package and every add-on absent, and with the payee check switched off (`PAYEE_CHECK=off`).
The dashboard imports two add-ons on its own pages: the DAO proposal builders and the delegate-action decoder for gasless revoke.

## Budgets

A Budget is an owner's standing limit for one agent key.
Its terms are `owner`, `agentPk`, `settler`, `cap`, `validUntil`, `payees`, `policyHash` and `salt`, and the Budget id is `sha256(borsh(terms))`.

Authority and funding are separate:

- `open_budget` sets `cap`, the limit on gross spending.
  The caller becomes the owner and pays the Budget's storage, so a DAO contract works as an owner with no key assumptions.
- A deposit (`ft_transfer_call` to the hub with `{"budget":{"budget_id":"..."}}`) raises `escrow` only.
- `fund_from_credit` moves the owner's own earned credit into escrow.
  It needs one yoctoNEAR, so a function-call key cannot use it.

An owner therefore opens a Budget in two transactions from its own wallet, then registers it with a node (`POST /v1/budgets`).
The node only mirrors what is on chain: it refuses a Budget the hub does not have, and a Budget that names another settler.
At registration the node reads the Budget's escrow and its owner's credit from the hub, so the Budget shows its funds before its first call; a failed read is logged, and the funds check reads again before it decides any call.

### Owners that are a DAO, and owners with no NEAR

Because the caller of `open_budget` becomes the owner, a Sputnik DAO v2 contract can own a Budget.
In the dashboard, "New Budget" asks "Owner: my account" or "Owner: a DAO I am a member of".
For a DAO, every owner action is a proposal that a member signs with the DAO's bond: opening the Budget, each deposit, moving credit into escrow, the revoke and the reclaim.
The proposals and votes are built by `@payminto/near-addons`, the DAO's policy and proposals are read from NEAR in the browser, and a proposal to the hub or the token that the add-on's audit does not recognize is labeled "Unrecognized call, review on chain" and has no Approve button.
A Budget proposed to a DAO is not on the hub until the vote passes, so the server cannot register it before then; the page reads the hub until it holds the Budget, then registers it.
The flow uses standard Sputnik DAO proposals and is not tied to any DAO interface.
It is covered by unit tests and the dashboard's mock DAO; this repository records no proposal added or voted on any NEAR network.

An owner whose account holds no NEAR for gas can still stop an agent.
The owner's wallet signs a NEP-366 delegate action for `revoke_budget` (or `reclaim`), and the optional relayer (`apps/relayer`) wraps it in its own transaction and pays the gas; the hub still sees the owner as the caller.
In the dashboard this is "Revoke without gas", shown when `NEXT_PUBLIC_RELAYER_URL` names a relayer that sponsors this hub and method.
The page decodes what the wallet signed and compares it with the reviewed call before it posts anything, and it says "Final on NEAR" only after it reads the revoke from the hub.
A DAO owner is not offered this path: a DAO acts by proposal.

The cap, the validity window and the payee list (at most 16 accounts) are enforced on chain.
The hub never credits its own account or the token account: a claim that names one is refused with `RESERVED_ACCOUNT`, and a Budget that lists one with `INVALID_BUDGET`.
A Budget's owner cannot settle to itself through `settle_own` (`PAYEE_IS_OWNER`).
In a node's batch a payment from an owner to itself counts toward `spent` and moves no tokens.
The finer policy is enforced by the node and committed to on chain through `policyHash`: a per-call cap, hourly and daily caps, calls per minute, and a limit on repeats of the same request.

## The life of a paid call

```text
agent                seller (paywall)           clearing node                hub on NEAR
  | GET /v1/quote        |                           |                           |
  |--------------------->|                           |                           |
  | 402 PAYMENT-REQUIRED |                           |                           |
  |<---------------------|                           |                           |
  | policy check, sign voucher                       |                           |
  | GET + PAYMENT-SIGNATURE                          |                           |
  |--------------------->| POST /v1/vouchers         |                           |
  |                      |-------------------------->| verify, evaluate rules,   |
  |                      |    receipt or refusal     | record call or refusal    |
  |                      |<--------------------------|                           |
  | 200 + PAYMENT-RESPONSE (receipt)                 |                           |
  |<---------------------|                           |                           |
  |                      |                           | settle_batch(batch_id, root, claims, expected_net)
  |                      |                           |-------------------------->|
  |                      |                           | payout(accounts)          |
  |                      |                           |-------------------------->|
  | GET /v1/receipts/{callId}/proof                  | verify_receipt (view)     |
  |------------------------------------------------->|-------------------------->|
```

1. The agent calls a paid endpoint with no payment.
   The seller's `paywall()` answers 402 with a `PAYMENT-REQUIRED` header: the price, the token, the payee, and the hub and node that clear it.
2. The agent's client checks the Budget policy before it signs.
   A call that breaks the policy is refused there and produces no signature, because a signed voucher is something a payee could try to settle.
   The MCP wallet also runs the payee check here: it refuses a blocked payee, and for a payee with warnings it asks its node whether the owner approved it.
3. The agent signs a voucher with its ed25519 key and retries with `PAYMENT-SIGNATURE`.
   The voucher digest is `sha256(borsh(tag, "payminto.voucher.v1", hub, network, budget_id, payee, amount, cumulative, request_hash))`.
   `cumulative` is the running total for that (Budget, payee) pair, and `request_hash` binds the voucher to the method, path, query and body of this request.
4. The seller checks the header, the request hash and the signature, then forwards the voucher to its node with its provider key (`POST /v1/vouchers`).
5. The node first verifies the signature against the Budget's agent key.
   A voucher that key did not sign, or one for a Budget the node does not know, gets a plain 402 error (`BAD_SIGNATURE` or `UNKNOWN_BUDGET`) and leaves no refusal record, no event and no webhook, so a stranger cannot fill an owner's refusal log.
   Next comes the payee check, when it is on: the node judges the payee as allow, warn or block.
   A blocked payee is refused with `PAYEE_BLOCKED`, and a payee with warnings is refused with `PAYEE_NEEDS_APPROVAL` until the Budget's owner approves it.
   The check may read the chain, so it runs before the transaction below; a revoked or expired Budget is refused by its own rule without it.
   The node then evaluates every rule inside one `BEGIN IMMEDIATE` SQLite transaction, so parallel calls cannot overspend.
   A request paid with several vouchers (a payment split between a business and a platform fee) is one call: every cap sees its total, and it counts once toward the per-minute and same-request limits.
   The last rule is the exposure limit: the Budget's unsettled spending plus this call must fit its escrow.
   Hub credit and money the owner is owed do not count.
   The funds check fails closed: when the hub cannot be read and the node's snapshot is older than `FUNDS_MAX_AGE_MS` (10 seconds by default), the call is refused with `NET_EXPOSURE` and the retry hint `{ "kind": "after", "seconds": 5, "reason": "hub_unreadable" }`.
6. An accepted call gets a receipt and a double-entry journal.
   The receipt carries the node's acceptance: its signature, by the node's receipt key, over `sha256` of the text `payminto.accepted.v1|call_id|budget_id|payee|amount|cumulative|request_hash|timestamp|voucher_sig`.
   A refusal is recorded with its rule, the attempted amount, what is left of the Budget and a machine-readable retry hint, is signed with the same key under another domain (`payminto.refused.v1`), and goes out as a `budget.refused` webhook.
   An agent reads the node's own record of a refusal with `GET /v1/budgets/{id}/refusals?requestHash=`.
7. The seller serves the response with `PAYMENT-RESPONSE`.
   Its `transaction` field is empty, which means the call is cleared now and settles later.
   The paywall keeps the latest accepted voucher per Budget, with the node's acceptance of it, for `settle_own`.
8. On `POST /v1/settlements`, or on a timer, the node first reads the hub's settled position of every (Budget, payee) pair it would claim, and books what a payee settled itself.
   It then takes the latest voucher of each pair, checks each Budget on the hub, and packs claims into batches of at most 100 with one Budget per owner.
   It builds a Merkle tree over every call in the batch and calls `settle_batch(batch_id, root, claims, expected_net)`.
9. The hub checks, in one atomic receipt: the caller is an allowed settler and each Budget's own settler, the batch id is new for this settler, each voucher verifies with `env::ed25519_verify`, each claim's signed amount is within its cumulative step, each claim is inside its cap, payee list and settlement deadline, the netting result equals `expected_net`, and each owner's net debit fits its escrow.
   Then it debits escrow by each owner's net debit, credits each net creditor, and stores the root.
   The bytes each Budget's new payees take are charged to the storage reserve its owner prepaid at `open_budget`, 332 bytes per payee the Budget can pay; a Budget whose reserve is short fails the batch with `INSUFFICIENT_RESERVE`.
   The batch record is charged to a NEAR storage balance the settler prepaid on the hub with `fund_storage`; `storage_of(account)` reports what is left, and a batch the balance cannot pay for is refused whole with `INSUFFICIENT_STORAGE`.
   The hub logs a NEP-297 `batch_settled` event, as it does for every state change.
10. Net creditors are paid by `payout`, at most 10 accounts per call.
    An account that is not registered with the token keeps its credit on the hub until it registers; the hub never pays token registration.
11. Anyone can fetch a call's Merkle path from the node (`GET /v1/receipts/{callId}/proof`) and check it against the hub with `verify_receipt`, or run `pnpm verify:near` with only an RPC URL, the hub account and the receipt file.

## Netting

The netting party is the Budget owner account.
If owner A's agent owes owner B's agent 10 and B's owes A's 7, `spent` rises by the gross amount on each Budget, A's escrow falls by 3, and B's account gains a credit of 3.
An account that receives payments and owns no Budget is a pure creditor.

Numbers from one run of `pnpm demo` on 2026-11-10 on the simulated hub (an in-memory model of the contract, not NEAR):

| Measure | Value |
|---|---|
| Paid calls in the run | 188 |
| Paid calls in the batch | 183; a seller settled the other 5 itself with `settle_own` after the node stopped |
| Gross cleared | 0.90 USDC |
| Tokens moved inside the hub, escrow to credit | 0.40 USDC |
| Offset between owners | 0.50 USDC |
| Token transfers out of the hub | 2, one per net creditor |

`pnpm demo --chain sandbox` printed the same numbers from a sandbox (a local NEAR node) on the same day.
`pnpm swarm` has more owners: 25 agents on their own sub-accounts cleared 82.934 USDC in 299 calls and moved 71.114 USDC in 5 transfers, also on the simulated hub.

Netting needs parties that owe each other inside one batch.
Agents that only buy or only sell get aggregation, not offset.
Because the node caps a Budget's unsettled spending at its escrow, no batch clears only because of an offset.

## Settlement outcomes

Every send of a batch ends one of three ways:

| Outcome | Batch status | What happens to its calls |
|---|---|---|
| The hub has it | `confirmed` | Marked settled, positions and ledger updated, creditors queued for payout |
| The hub refused it | `failed` | Returned to the queue |
| No verdict (timeout, dropped connection, restart in flight) | `unknown` | Returned to the queue; before every later run the node asks the hub again and adopts the batch if it landed |

The node never retries a write with a new nonce.
The hub refuses a batch id this settler already used (`BATCH_EXISTS`) and changes nothing, so a resend cannot settle twice; another settler's batch under the same id is no conflict.
The runbook for each status is in [OPERATIONS.md](OPERATIONS.md).

## Receipts and proofs

| Item | Definition |
|---|---|
| Leaf | `sha256(0x00 \|\| borsh(domain, hub, network, batch_id, call_id, budget_id, payee, amount, cumulative, request_hash, timestamp_ms, voucher_sig))` |
| Inner node | `sha256(0x01 \|\| min(a,b) \|\| max(a,b))` |
| Order | Leaves sorted by `call_id`; an odd node is promoted; depth at most 32 |
| View | `verify_receipt(settler, batch_id, fields, proof)` takes fields and rebuilds the leaf, never a raw leaf; batch ids belong to their settler, so the view names it |

Because each leaf carries the voucher signature and the request hash, a verifier can confirm that the agent signed that specific call.
A proof shows inclusion and agent authorization.
It does not show delivery, and it does not show that the root covers every voucher.

## The seller exit: `settle_own`

If the node disappears, a seller is not stuck.
The paywall stores the latest accepted voucher per Budget together with the node's acceptance of it, exports both, and the seller's own wallet calls `settle_own(claim, acceptance)` on the hub.
`settle_own` applies no netting and debits the full amount from the Budget's escrow.

The two arguments, as `settleOwnTx` in `packages/chain/src/actions.ts` builds them:

| Argument | Fields |
|---|---|
| `claim` | `budget_id`, `payee`, `amount`, `cumulative`, `request_hash`, `signature` (the agent's voucher signature) |
| `acceptance` | `node_key` (the receipt key as 64 hex characters), `timestamp_s` (Unix seconds as a decimal string), `signature` (the node's signature over the acceptance digest) |

The hub rebuilds the acceptance text from the claim, so an acceptance covers that claim and no other.
It takes the acceptance only from a key the Budget's settler registered with `register_receipt_key({ key })`.
A settler registers for itself, with exactly one yoctoNEAR attached, so its function-call key cannot; keys are only ever added, at most 4 per settler, and `receipt_keys({ settler })` lists them.

| `settle_own` refuses | Code |
|---|---|
| A caller that is not the payee | `NOT_PAYEE` |
| A payee that is the Budget's owner, whatever acceptance comes with it | `PAYEE_IS_OWNER` |
| An acceptance from a key the Budget's settler did not register | `ACCEPTANCE_KEY_UNKNOWN` |
| An acceptance whose signature does not cover this claim | `BAD_ACCEPTANCE` |
| An acceptance dated after the Budget's revoke or its `validUntil` | `ACCEPTANCE_TOO_LATE` |
| A voucher the hub already settled | `STALE_VOUCHER` |

So the exit covers calls the node accepted, and a seller must keep its receipts; the SDK voucher store does.
`settle_own` draws its storage from the same reserve the owner paid for when the Budget opened, and then from the caller's deposit.
The node reads `settled_of` before every settlement and books each movement that none of its batches made as a seller settlement.
Those calls are `settled` with `settledBy: "seller"`; they are in no batch, so they have no Merkle proof.

## Payments from people

The gateway is the part of the node that takes payments for a business.
It supports two methods: `wallet` and `voucher`.

For `wallet`, the hosted checkout hands the payer's NEAR wallet a ready `ft_transfer_call` to the hub.
Its `msg` carries the payment id, the merchant account, the amount and an expiry, signed with the node's checkout key.
The hub verifies the signature, returns the tokens for an unknown token, a wrong amount, expired terms or a repeated payment id, and otherwise records the payment and credits the merchant.
The node polls the hub's record of each open payment id at final finality and books what the hub recorded.

For `voucher`, an agent pays a payment link or a payment over x402 with vouchers from its Budget, through the same policy engine as any other call.
One link serves both: the dashboard sends browsers to the hosted page and everything else to the node's x402 route.

Refunds are sent by the merchant from its own payout account, and the node checks the transaction it is given.
The platform fee is 0% by default: the node seeds a "No fee" plan, and a non-zero fee needs `PLATFORM_FEE_ACCOUNT`.

## What the operator can and cannot do

| The operator can | The operator cannot |
|---|---|
| Refuse a call, stop settling, or go offline | Move escrow or credit to itself: no method does that |
| Choose which accepted vouchers go into a batch | Settle a voucher the agent did not sign |
| Set the timestamp on a receipt | Pay a payee the Budget does not allow, or exceed its cap |
| Trigger a payout to a creditor | Redirect a payout: credit goes to the account that owns it |
| Sign acceptances, including more than escrow covers, which its signatures then prove | Change the hub's code: the hub account has no keys |

Sellers leave through `settle_own`, and owners reclaim unspent escrow after the settlement deadline, which is the earlier of expiry plus 3 days and revoke plus 24 hours.
The hub refuses a revoke after `validUntil`, so a revoke can never shorten the 3 days after expiry.
After the deadline the owner can also `prune` the Budget's settled entries and get back the storage it prepaid and did not use.
A settler that keeps accepting calls after a revoke is not stopped on chain during those 24 hours; its signatures prove what it did, and [SECURITY.md](SECURITY.md) says what that means for an owner.
Funds are escrowed in an unaudited contract, so these are properties of the code as written and tested, not of an audit.

## Node storage

The node keeps one SQLite database in WAL mode.
`apps/node/migrations/001_near.sql` creates it, and five forward migrations bring an older database up to date in place at startup, each in one transaction:

| Migration | Adds |
|---|---|
| `002_request_parts.sql` | Which vouchers belong to one request, so a split payment counts once against the caps |
| `003_seller_settlements.sql` | Seller settlements, for calls a payee settled itself with `settle_own` |
| `004_denial_signatures.sql` | What the node needs to sign and serve its own refusal records |
| `005_nearai_provider.sql` | NEAR AI Cloud as a model provider for a business's AI connections |
| `006_payee_check.sql` | The payee check: the latest verdict per Budget and payee, the owner's approvals, waiting requests, reports, and the contract code seen per account |

The database holds Budgets, positions, calls, refusals, payee verdicts and approvals, batches with their claims and net entries, seller settlements, payouts, a double-entry ledger, an event log for the live stream, and the gateway and account tables.
A database belongs to one network, hub and token, and the node refuses to start against another.
Startup also refuses a database with migration entries this build does not ship, and never drops one.
At startup the node also checks what the hub requires of a settler: that its receipt key is registered (`receipt_keys`) and that its prepaid storage balance (`storage_of`) covers at least 100 batch records (0.281 NEAR).
A failed check is an error log line and an operator alert; it does not stop the node.

## Three kinds of chain

| Name in the docs | What it is | Where it is used |
|---|---|---|
| Simulated | `FakeChain`, an in-memory model of the hub with the same rules and refusal codes | Unit tests, `pnpm demo`, `pnpm swarm` |
| Sandbox (a local NEAR node) | near-sandbox running the real `hub.wasm` | `pnpm local`, `pnpm local --check`, `pnpm demo --chain sandbox`, `pnpm swarm --chain sandbox`, the contract's sandbox tests |
| Testnet | NEAR testnet with Circle's testnet USDC | A deployed node; never touched by the demo or the tests |
