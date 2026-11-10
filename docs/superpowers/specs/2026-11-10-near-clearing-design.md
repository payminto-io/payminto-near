# Payminto on NEAR: design

Status: draft for owner approval.
Date: 2026-11-10.
Hackathon deadline: 2026-11-14 23:59 UTC.

## Roundtable decisions

These decisions come from a simulated roundtable, with AI stand-ins for an API seller, an agent developer, a finance controller, a marketplace operator and a hackathon judge.
It is not real customer feedback and is never presented as such.
Where this section conflicts with a later section, this section wins.

Cross-examination:

- The judge said offset frees no capital because a deposit raises the cap, while the controller said funding and authority are different decisions.
  Both are fixed by the same change, below.
- The seller and developer called offsetting irrelevant because they only buy or only sell.
  So the buyer-facing promise is safe per-call spending with few transfers, and offsetting is the capital advantage for agents that both buy and sell.
- The operator showed that sellers lose delivered work if a node dies, while the plan had the escape hatch on the cut list.
  The escape hatch is no longer cuttable.
- The controller and the judge both rejected the retained upgrade key.
  Disclosure was not enough, so the submitted hub is locked.
- The judge said per-operator hubs prevent any clearing network, while the operator wanted isolation.
  One shared public testnet hub is the default, and deploying a private hub stays possible.

Decisions:

1. Authority and funding are separate.
   `open_budget` sets `cap`, and deposits raise only `escrow`.
   `cap` limits gross spending, and `settle_batch` requires each owner's net debit to fit within `escrow`, so a Budget can clear more gross than it has escrowed when obligations offset.
   The demo shows gross cleared against tokens moved, and transfers against calls.
   Ruling of 2026-11-10: the demo does not show a batch that clears only because of offset, because rule 2 caps unsettled outgoing at escrow.
2. The node refuses a call when the owner's unsettled outgoing plus the call exceeds escrow.
   Hub credit does not count, because `settle_batch` debits escrow only.
   Owners move earned credit into a Budget with the owner-signed `fund_from_credit`, which needs one yoctoNEAR so a function-call key cannot use it.
   Settlement never draws credit by itself, because anyone can trigger a payout and could empty that credit under a pending batch.
   This fail-closed limit on unsettled exposure stops new calls when settlement stalls.
3. A shared testnet hub is the demo target, with three independent owners, one of them a DAO.
   Each Budget names its `settler`, and `settle_batch` rejects a Budget whose settler is not the caller.
   Sandbox is the fallback path for machine judges.
4. `settle_own` cannot be cut.
   The seller SDK stores the latest voucher for each Budget and offers an export.
5. The submitted hub has no full-access key and no upgrade path.
   Admin is a separate account that can manage settlers only.
   A bug means deploying a new hub.
6. One node serves many businesses, so `platform/businesses`, `requests`, `team` and `outbox` stay.
   `platform/pricing` and `platform/earnings` are removed, and an operator take rate is roadmap.
7. New policy rules: a per-hour limit, and a same-request repeat limit for agent loops.
8. Refusals return the rule, attempted amount, remaining Budget and a machine-readable retry hint, and emit a webhook for alerts.
9. Export includes gross per counterparty alongside net, so books record expense and revenue separately from the cash movement.
10. Add-on order becomes: NEAR Intents exit for net creditors with one human-run mainnet transaction, DAO Budget owner, named agent sub-accounts, gasless actions, Omni Bridge funding, then Chain Signatures payout.
    NEAR AI Cloud moves behind the add-ons.
11. The tracks are `agents`, `swarms`, `realworld` and `security`.
12. The README limits "per-call proof" to inclusion and agent authorization, and does not claim completeness or delivery.

Security review rulings of 2026-11-10, which override the decisions above and the sections below where they differ:

13. `settle_own` requires the settler's acceptance signature for the call, the one the node already returns in each receipt.
    The owner picks the agent key, so an agent signature alone lets an owner drain its own escrow ahead of sellers, or lets a leaked key drain it after a revoke.
    The hub stores receipt keys per settler, registered by the settler itself with one yoctoNEAR, append-only, so a node cannot strand sellers by rotating its key.
    An acceptance dated after the Budget's revoke or expiry is refused.
    Escrow therefore protects sellers for calls the node accepted, and a node that accepts beyond escrow is misbehaving in a way its signatures prove.
14. The hub refuses the Budget owner, the hub account and the token account as payee or merchant.
15. The revoke grace is 24 hours, so a seller without a chain watcher still has time to settle.
16. No path grows hub storage at the hub's expense.
    Settlers prepay a NEAR storage balance that `settle_batch` and checkout payments draw from, `settle_own` charges its caller, and deployment prefunds the hub and checks a minimum balance.
17. The node verifies the agent signature before it records a refusal, refuses calls when it cannot read the hub and its funds snapshot is too old, books calls a seller settled itself, and checks the settler and root before adopting an existing batch.
18. The agent client advances a position only on a receipt it verified, treats an unknown outcome as possibly paid, and counts it against every limit.
    The MCP wallet enforces its own host allowlist, maximum price and bearer token, and labels seller-relayed text as unauthenticated.

Open before any real-money use: an audit, and a real pair of counterparties who owe each other within one settlement window.

## Intent

Payminto on NEAR is a self-hosted clearing layer for agent payments.
A business gives an AI agent a bounded Budget.
The agent pays APIs per call over HTTP 402 with signed vouchers.
A node refuses any call that breaks the Budget and records the rule that fired.
Many calls settle as a few USDC transfers on NEAR.
Anyone can prove one call against a root stored on NEAR.

Spending firewalls, any-token checkout and basic x402 are crowded on NEAR.
The differentiator is netting across payers plus per-call on-chain proof, inside one stack with books, webhooks, MCP and SDK.
The competitor scan found no shipped example of that combination, at medium confidence.

## Goals

1. A real user can run a node, open a Budget, connect an agent through MCP, see calls and refusals, settle, withdraw, and prove a call.
2. A machine judge can run `pnpm demo` with no secrets, and run `pnpm verify:near` read-only against public testnet.
3. The README gives numbered "do X, see Y" steps and separates baseline code from hackathon work.
4. Submit to tracks `agents` and `realworld`, with `security` as a third track.

## Non-goals

- A security audit.
- Real-money mainnet operation of the clearing contract.
- A tested mobile wallet matrix.
- Multisig owners.
- NEAR AI Agent Market integration, which has its own escrow and is mainnet-only.
- The `near-intents` x402 method, which swaps per call and defeats netting.

## Anti-goals

- Claiming the contract never holds funds.
- Reusing EVM gas savings numbers.
- Claiming the agent, MCP server or node runs in a TEE.
- Showing simulated data without labeling it simulated.
- Any admin method that can move escrowed funds.
- Using another project's names, API paths or product terms as ours.

The product word for an agent's limit is Budget, and the refused rule names stay our own.
NEAR's protocol term "allowance" for function-call keys stays allowed in technical text about those keys.

## Constraints

- NEP-141 has no approve or transferFrom, so Budget funds are escrowed in the contract.
- NEAR Intents has no testnet, so the core runs on NEAR testnet and Intents is a separate mainnet path.
- The assistant never moves real funds; the human sends every mainnet transaction from their own wallet.
- The human creates and funds the testnet operator account, requests faucet USDC, publishes the repository, posts the X video and approves the submission payload.
- Database reset tooling keeps `assertDisposableTarget`, and startup never drops data.
- The original `hashkey-horizon` directory is not modified.

## Baseline and disclosure

The baseline is commit `49b9749` of `hashkey-horizon`, tagged `pre-hackathon` in a new repository.
The new repository starts from a clean snapshot so that older history is not published.
Work ends at tag `hackathon-submission`, and the README links the diff.
The README discloses that the product first ran on HashKey and Sepolia testnets, was entered in a HashKey event, and that only the NEAR integration is judged.
The earliest source commit is 2026-10-24, after the 2026-10-19 announcement.

## Contract

A new Rust contract lives in `contracts-near/`, created with `cargo near new`, using near-sdk 5.x.

State:

- `budgets`: `owner`, `agent_pk`, `cap`, `spent`, `escrow`, `valid_until`, `revoked_at`, `payees`, `policy_hash`.
- `settled[(budget_id, payee)]`: last settled cumulative.
- `credits[account]`: withdrawable USDC.
- `batches[batch_id]`: `root`, `settler`, `gross`, `net`, `at`.
- `settlers`: allowlisted node accounts.
- `payments[payment_id]`: `merchant`, `amount`, `payer`, `at`.
- `checkout_key`: the node's ed25519 key for signing checkout terms.

Each operator deploys their own hub and is its admin.
Deployment scripts and the deployment guide cover this.

Methods:

| Method | Caller | Behavior |
|---|---|---|
| `open_budget` | owner | Payable, covers storage, predecessor is the authority |
| `ft_on_transfer` | USDC contract only | `msg` is tagged JSON: `budget` raises escrow and cap when sender is the owner; `payment` carries node-signed terms; anything else returns the full amount |
| `set_settler`, `set_checkout_key` | hub admin | Manage node access only, with no path to funds |
| `revoke_budget` | owner | Starts the settlement grace period |
| `reclaim` | owner | After the deadline, zeroes escrow before the promise |
| `settle_batch(batch_id, root, claims, expected_net)` | allowlisted settler | One atomic receipt |
| `payout(accounts)` | anyone | Zeroes credit, sends `ft_transfer`, restores credit in a callback on failure |
| `settle_own(claim)` | payee | Escape hatch if the node dies |
| `verify_receipt(batch_id, fields, proof)` | view | Takes receipt fields, never a raw leaf |

`settle_batch` rejects replayed batch IDs, stale vouchers and a zero gross.
It verifies each voucher with `env::ed25519_verify`.
It recomputes netting and asserts it equals `expected_net`.
It allows one Budget per owner per batch.

Netting party is the Budget owner account, and netting offsets real obligations.
If owner A's agent owes owner B's agent 10 and B owes A 7, `spent` rises by the gross amount on each Budget, A's escrow falls by 3, and B's account gains a credit of 3.
Escrow falls only by an owner's net debit, and net creditors gain credit, so the sum of escrow and credits changes only through deposits and payouts.
An account that receives payments and owns no Budget is a pure creditor.
Single-direction aggregation is also useful, but it is described as aggregation, not offset.
Larger batches are split into separate transactions, each atomic with its own root.

`MAX_CLAIMS` starts at 100 and is raised only after sandbox gas profiling.
Payout is capped at 10 accounts per transaction.
Unregistered payees keep their credit, and the dashboard shows it as waiting for registration.
The hub never pays token registration.

Solvency invariant, tested always: token balance equals the sum of escrow, credits and in-flight payouts.

Keys:

- The node settles with a function-call key limited to `settle_batch` and `payout` on the hub.
- That key has an explicit generous allowance, and the node alerts on the remainder.
- The node account keeps its full-access key offline.
- The hub's keys are not removed until the final deployment is tested.
- The submitted hub is then locked by `deploy-hub.ts`, which deletes every access key on the hub account, function-call keys included, per roundtable decision 5.
  A function-call key on the hub account would call the hub as itself and pass the `#[private]` check on its callbacks.

Honesty limit, stated in the README: the chain proves the settler committed to a root; it does not prove the root covers every voucher.
Including the voucher signature in each leaf lets a verifier confirm that the agent signed that call.

## Signatures and proofs

Vouchers use raw ed25519 with a dedicated agent key, not NEP-413.
NEP-413 expects a full-access key and cannot be bound to an account on chain.
The agent holds a bare keypair with no NEAR account and no gas.
Its only power is signing vouchers within its Budget.

Voucher digest: `sha256(borsh(tag, "payminto.voucher.v1", hub, network, budget_id, payee, amount, cumulative, request_hash))`, with a tag of at least 2^31 so it cannot parse as a transaction.
Each claim passes the `amount` and `request_hash` of the latest voucher so the contract can verify the digest.
Binding `request_hash` means a leaf's voucher signature proves the agent authorized that specific call.
The timestamp stays node-attested and is labeled that way.

Budget ID: `sha256(borsh(terms))`, with terms including the agent public key.

Merkle tree:

- Leaf: `sha256(0x00 || borsh(domain, hub, network, batch_id, call_id, budget_id, payee, amount, cumulative, request_hash, timestamp_ms, voucher_sig))`.
- Node: `sha256(0x01 || min(a,b) || max(a,b))`.
- Leaves sort by `call_id`, an odd node is promoted, and depth is capped at 32.

Shared JSON test vectors cover Borsh digests and Merkle roots in TypeScript and Rust, and are frozen before parallel work starts.

Settlement token: Circle testnet USDC at `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`.
A mock NEP-141 is used only in sandbox, or as a labeled fallback if the faucet fails.

## Agent protocol

The 402 flow uses standard x402 v2 headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`.
The scheme is our own, `payminto-voucher`, on network `near:testnet`.
The `accepts` entry carries `amount`, `asset`, `payTo`, `maxTimeoutSeconds`, and `extra` with the clearing contract, node and token details.
The agent returns `accepted` and a payload with `budgetId`, `payee`, `amount`, `cumulative`, `requestHash`, `publicKey` and `signature`.
Success returns `success: true` with an empty `transaction`, meaning settlement is deferred.
Refusal returns 402 with `success: false` and the rule name in `errorReason`.
Budget routes never offer `exact`, because it would bypass policy.

Existing v2 deviations in `paywall.ts`, `x402.ts` and `agent.ts` are fixed, including treating any `PAYMENT-RESPONSE` as paid.
Split payments use one `accepts` entry with `extra.splits` and `payload.vouchers[]`.

MCP keeps its six tools: `list_paid_services`, `call_paid_service`, `pay_link`, `get_budget`, `get_receipts` and `prove_receipt`.
No MCP tool signs a mainnet transaction.
`payminto-agent keygen` writes a mode 0600 key under `~/.payminto/agent/`, never exposed to model environment variables.

NEAR AI Cloud is added as a model preset with a Private model.
The dashboard shows per-turn request and response hashes and the signature kind.
The claim is limited to that model turn.
This is cut if no API key is available.

## Chain seam

New package `packages/chain` is the only importer of NEAR libraries.

- `.` is pure and browser-safe: types, Borsh digests, wallet action builders.
- `./node` holds the RPC client and operator signer.
- `./fake` is an in-memory chain for tests.

The interface covers `budget`, `settledOf`, `creditOf`, `balanceOf`, `batch`, `payments`, `isRegistered`, `settle`, `payout` and `txState`.
Types are `AccountId`, `TxHash`, `PublicKey` and `Id32`.
Amounts remain atomic bigints, serialized as decimal strings.
The watcher polls `payments(openIds)` at final finality, replacing log cursors, reorg handling and gas bumping.

## Cuts

Deleted:

- `contracts/` and Foundry tooling.
- `apps/node/src/eas.ts`, `apps/node/src/hsp/`, `gateway/hsp.ts`, `gateway/relay.ts` and fork tests.
- `packages/protocol/src/{abi,hashkey,hsp,hsp-agentic,permit}.ts`.
- `packages/sdk/src/{hsp,exact}.ts`.
- HashKey docs, gas docs, `research/` and `media/`.
- Dashboard `developers/hashkey`, `settings/platform`, `platform/pricing` and `platform/earnings`.

Payment methods reduce to NEAR wallet, voucher and optional 1Click.

Moved rather than deleted, so onboarding survives: team moves to settings, outbox moves to developers, business creation happens automatically at signup, and signup approval is removed so one account owns its business.

`Mandate` becomes `Budget` across API, SDK, MCP, routes and database.

## Database

No production data exists for this product, so migrations squash into one `001_near.sql`.
Dropped tables: `hsp_quotes`, `hsp_payments`, `payment_forwarders`, `payment_relays`, `gateway_cursors`, `wallet_logins`, `siwe_nonces`.
Renamed: `mandates` to `budgets`.
Kept: `fee_plans` with a seeded zero plan.
Added: `oneclick_quotes`.
Startup refuses a database with older migration entries and never drops it automatically.

## Payments for people

Primary: hosted checkout calls `ft_transfer_call(hub, amount, msg)` from a NEAR wallet, where `msg` carries `payment_id`, `merchant`, `amount` and `expiry`, signed by the node's checkout key.
No on-chain pre-registration is needed.
The hub verifies the signature and returns funds for unknown tokens, wrong amounts, expired terms and repeated payment IDs, otherwise records the payment and credits the merchant.

Any-chain checkout with 1Click needs mainnet, and this submission has no mainnet node mode.
On a testnet node, the hosted checkout shows the any-chain option as simulated, driven by the labeled mock.
The live mainnet path is `scripts/intents-mainnet.ts`, sending with `recipientType: DESTINATION_CHAIN` directly to a merchant account that is already token-registered.
`customRecipientMsg` is never used.

Refunds are sent from the merchant's own wallet and verified by the node.

## Intents

`scripts/intents-mainnet.ts` defaults to a dry quote.
A wet quote needs `--mainnet`, prints the deposit details, and holds no key.
The human sends the deposit, and the script polls status.
The node refuses `nep141:` asset IDs on testnet.
Tests use a mock 1Click clearly labeled simulated.
The README states that mainnet funds do not reach the testnet Budget.

## NEAR-native add-ons

These features live in a separate package, `packages/near-addons`, behind feature flags.
Core clearing never imports this package, so the core ships and runs with every add-on off.
Each add-on can be dropped alone, and each is labeled testnet, mainnet or simulated in the UI.

| Add-on | What a user gets | Priority |
|---|---|---|
| DAO or multisig Budget owner | A Sputnik DAO or Trezu treasury opens a Budget, because the contract treats the calling account as the owner | 1 |
| Named agent sub-accounts | `research.acme.testnet` gives each agent a readable identity for receipts and the dashboard | 1 |
| Gasless owner and payee actions | A NEP-366 meta transaction relayer pays gas, restricted to calls on our own hub | 2 |
| Bridge funding | Omni Bridge moves USDC from another chain to a NEAR account, which then funds a Budget | 2 |
| Chain Signatures payout | A merchant receives net settlement on an EVM chain from a NEAR-controlled address | 3 |

Any add-on that moves value stays within the Budget and escrow rules and adds no way around them.
Bridge and Chain Signatures network support is confirmed against official docs before work starts on them.
Work on add-ons starts only after the core demo passes.

## Dashboard and design

The UI follows the Payminto Design System, built from the existing dashboard tokens, IBM Plex type and shadcn components.
Wallet connection uses NEAR Connect behind one `lib/wallet.ts`.
Wallet redirects resume from server payment state, not React state.
Mobile-first screens: new Budget, Budget detail, approval sheet, receipt and hosted checkout.

Wording is corrected everywhere: funds are escrowed in an unaudited contract, the contract has no method that lets the operator move them, the hub account holds no keys so its code cannot be replaced, and the deployment is testnet by default.

## Demo and tests

`pnpm demo` runs `near-sandbox`, committed `hub.wasm` and mock token wasm, generated keys and the scripted model.
`DEMO_CHAIN=fake` is the fallback if sandbox fails on a machine, and the output labels it.
`pnpm verify:near` replays committed receipts against the deployed testnet contract using no keys.

Demo story:

1. Owner sets a Budget with caps and payees.
2. Three agents with different owners make 200 paid calls through MCP, and two of them also sell services to each other.
3. A paid response injects a request to pay an attacker, which is refused with `PAYEE_NOT_ALLOWED`, and an over-cap call is refused.
4. The node offsets what the agents owe each other and settles the calls as a few USDC transfers, showing gross and net.
5. A random call is proven against the on-chain root.

Never cut: hub tests, the solvency invariant, on-chain signature checks, `pnpm demo`, and the database guard.

## Work order

Before parallel work, one owner runs `git init`, applies cuts, compiles with stubs, runs the rename, and freezes seam types and test vectors.

| Stream | Owns | 11 Nov | 12 Nov | 13 Nov |
|---|---|---|---|---|
| Contract | `contracts-near/` | Escrow, vouchers, settle, gas profile | Payout, tests | Testnet deploy, wasm |
| Chain | `packages/chain`, `packages/protocol` | Types, fake | RPC client | Sandbox hardening |
| Node | `apps/node` | Schema, fake-chain tests | Settlement, polling | Checkout, refunds |
| Clients | `packages/sdk`, `apps/mcp`, `apps/agent`, `apps/demo` | SDK | MCP, agent | Demo |
| Dashboard | `apps/dashboard` | Wallet, Budgets | Checkout | Mobile pass |

14 Nov is integration, CI, README, video and submission.

Cut in this order if time runs out:

1. NEAR-native add-ons, in reverse priority order.
2. Live 1Click.
3. NEAR AI Cloud verification display.
4. On-chain payee list, leaving node enforcement, and saying so.
5. `settle_own`, and state that a dead node strands vouchers until reclaim.
6. MCP merchant tools.
7. Receipt mobile polish.
8. Full docs rewrite, leaving README and deployment guide.

## Risks

- An unaudited custody contract written in days: testnet by default, per-Budget limit on any mainnet use.
- Unmeasured gas: profile on the first contract day.
- TypeScript and Rust encoding mismatch: vectors first.
- Key lockout or exhausted allowance: separate keys, alerting.
- Storage drain: owners pay Budget storage, and the hub is prefunded for settlement entries.
- `near-sandbox` on macOS ARM is unconfirmed: fake-chain fallback.
- Faucet limits: mock token fallback, labeled.

## Calls made by the team

These were settled by the team and can be changed by the owner.

- Payees are a short on-chain list capped at 16, not a Merkle root.
- Owners open a Budget in two transactions so that they pay their own storage.
- Agents cannot revoke on chain; the node stops accepting their vouchers on request.
- A new public repository is used instead of the private `payminto-clearing` repository.
- Netting offsets across Budget owner accounts.
- Each voucher signature binds the specific request.
- Each operator deploys their own hub.
- Checkout terms are signed by the node, not registered on chain.
- The submitted hub is locked with no access keys, superseding the earlier call to keep an upgrade key (roundtable decision 5).
- The exposure limit counts escrow only, and earned credit reaches a Budget through `fund_from_credit` (ruling of 2026-11-10).
- There is no mainnet node mode in this submission.
