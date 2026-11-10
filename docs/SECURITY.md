# Security: trust model and known limits

Payminto is a clearing layer for agent payments on NEAR.
This page says who can do what with the funds, what the software proves and what it does not, and where it is weak.
Read it before you put anything of value behind it.

The hub contract is unaudited.
The node runs on a local sandbox (a local NEAR node) or on NEAR testnet, and there is no mainnet node mode.
Do not use it with real money.

Several rules on this page came out of a security review during the hackathon.
For the contract, `contracts-near/src/tests/review.rs` holds one test per finding, each of which failed before its fix.
Every refusal named here is listed with the test that proves it in [REFUSALS.md](REFUSALS.md).
If a checkout of the code differs from this page, the code in that checkout is what runs, and `contracts-near/README.md` describes it.

## Where the funds are

Budget funds are escrowed in the hub contract (`contracts-near/`), in a NEP-141 token (USDC).
NEP-141 has no approve or transferFrom, so a spending limit cannot be a wallet permission: the tokens sit in the contract.
That means a bug in the contract can lose them, and the contract has not been audited.

What limits the damage is the shape of the contract, not a promise from the operator:

- No method moves escrow or credit to the operator or to the hub admin.
- Escrow leaves a Budget only against vouchers signed by that Budget's agent key, or back to the owner through `reclaim` after the settlement deadline.
- A voucher settles in one of two ways only: in a batch sent by the settler the Budget names (`settle_batch`), or by its payee together with that settler's signed acceptance of the call (`settle_own`).
- Credit leaves the hub only through `payout`, which sends it to the account that owns the credit.
- The submitted hub account has no access keys, and the contract has no upgrade method, so its code cannot be replaced.
  A bug therefore means deploying a new hub; nobody can patch the old one, and nobody can rescue funds from it either.

## Who can do what

| Party | What it holds | What it can do | What it cannot do |
|---|---|---|---|
| Budget owner | A NEAR account (a wallet, or a DAO contract) | Open a Budget and prepay its settlement storage, fund its escrow, move its own hub credit into escrow (`fund_from_credit`), revoke before `valid_until`, reclaim what is left after the settlement deadline, and `prune` its settled entries then for the storage refund | Take escrow back before the deadline, revoke after `valid_until` to shorten the expiry grace, or raise spending past the cap without opening a new Budget |
| Agent | A bare ed25519 key: no NEAR account, no gas | Sign vouchers for its one Budget | Sign a NEAR transaction, move tokens, change the Budget, or revoke on chain (it can ask the node to stop accepting its vouchers) |
| Node operator (the settler) | A function-call key limited to `settle_batch` and `payout` on the hub, the node signing key, and the node account's own full-access key, which it keeps offline | Accept or refuse calls, sign acceptances, settle batches of agent-signed vouchers for Budgets that name it as settler, trigger payouts, set the timestamp on receipts; with the full-access key, register a receipt key and withdraw its unused storage balance | Move escrow or credit to itself, settle a voucher the agent did not sign, pay a payee the Budget does not allow, exceed a Budget's cap or an owner's escrow, settle a Budget that names another settler, or remove a receipt key once it is registered |
| Hub admin | A separate NEAR account | Add or remove settlers, set the checkout key and the settler whose storage balance checkout payments draw on, and hand the role to another account in two steps (`propose_admin`, then `accept_admin` by that account) | Reach funds: none of these methods touches escrow or credit. Remove a settler's receipt keys: a settler taken off the list keeps them. Make an account admin without that account accepting |
| Hub account | No keys | Nothing: no key can sign for it | Have its code changed |
| Seller (payee) | A NEAR account, and the vouchers and acceptances the SDK stores | Settle its own earnings with `settle_own(claim, acceptance)` when the node is gone, for calls the node accepted | Settle a voucher the node never accepted (`ACCEPTANCE_KEY_UNKNOWN`, `BAD_ACCEPTANCE`), or one whose acceptance is dated after the Budget's revoke or expiry (`ACCEPTANCE_TOO_LATE`) |
| Relayer operator (optional) | A full-access key on a relayer account that holds a little NEAR and nothing else | Pay the gas for an owner's signed, zero-deposit call to the hub, or refuse to | Change what the owner signed, act for an owner, or reach escrow or credit |
| Anyone | Nothing | Call `payout` for any account (the credit goes to that account), add NEAR to any account's storage balance with `fund_storage`, and verify a receipt with `verify_receipt` | Redirect a payout, withdraw another account's storage balance, or fund the hub's or the token's storage balance (`RESERVED_ACCOUNT`) |

`contracts-near/src/auth.rs` holds one guard per role, every entry point calls exactly one of them first, and a unit test calls every guarded method as every wrong caller and checks the exact refusal code.
Every state change on the hub logs a NEP-297 event (standard `payminto`, version `1.0.0`), so anyone can follow the hub without polling its views.

The operator can always refuse service.
It can refuse calls, stop settling, or go offline.
It cannot turn that into taking funds: sellers settle accepted calls themselves, and owners reclaim after the deadline.

## What escrow protects, stated plainly

The owner controls the agent key.
An owner, or anyone who holds its agent key, can sign any number of vouchers to any number of sellers, for more than the Budget's escrow in total.
So a voucher alone is not a promise of payment.

Escrow protects a seller only for calls the node accepted.
The node accepts a call only when the Budget's unsettled spending plus that call fits its escrow (rule `NET_EXPOSURE`), and it signs each acceptance.
The seller gets that signature as `nodeSignature` in the receipt it receives in `PAYMENT-RESPONSE`.

What the hub enforces for the seller exit:

- `settle_own(claim, acceptance)` needs the node's acceptance signature for that exact call.
  A voucher with no acceptance cannot be settled by the seller: the hub answers `ACCEPTANCE_KEY_UNKNOWN` for a key the Budget's settler never registered, and `BAD_ACCEPTANCE` for a signature that does not cover this claim.
- The hub stores receipt keys per settler.
  A settler registers its own key with `register_receipt_key({ key })` and exactly one yoctoNEAR attached, which a function-call key cannot do.
  Keys are only ever added, at most 4 per settler, so an old acceptance stays checkable after a key is added, and a node cannot strand its sellers by replacing its key and vanishing.
- An acceptance dated after the Budget's revoke or after its `validUntil` is refused with `ACCEPTANCE_TOO_LATE`.
- A payee that is the Budget's owner is refused with `PAYEE_IS_OWNER`, whatever acceptance comes with it.
  Without that rule an owner, who chooses the agent key, could sign a voucher to itself and empty the escrow ahead of the sellers.
- Sellers must keep their receipts.
  The SDK's voucher store keeps each voucher with its acceptance, and `FileVoucherStore` keeps them across restarts.
- The SDK checks each acceptance with the hub's own signature rule before it keeps it (see "One signature rule" below).
  An acceptance the hub would refuse, such as a node signature with a torsioned R, is not stored, and the seller is told it cannot settle that voucher itself.

What the hub does not enforce, stated as limits:

- A receipt key cannot be removed.
  If a settler's receipt key leaks, whoever holds it and an agent key can pass `settle_own` for that settler's Budgets.
  The remedy is a new settler account, and owners opening new Budgets that name it.
- A Budget can name a settler that has registered no receipt key.
  Its sellers cannot use `settle_own` until that settler registers one; the node checks this at startup and alerts.
- Acceptance timestamps have a resolution of one second, and the Budget's times are in milliseconds.
  A second counts from its first millisecond, so a call the node accepted in the same second as the revoke still settles through `settle_own`, up to 999 ms after the revoke, and a call accepted one second later does not.

A node that signs acceptances for more than a Budget's escrow is misbehaving, and its own signatures prove it: each receipt names the Budget, the cumulative amount and the node key.
The contract cannot stop a node from signing too much.
It can only refuse to pay more than the escrow holds, so in that case some seller holds a signed receipt that does not settle in full.
A seller that wants less exposure to the operator settles more often.

One more consequence follows from these rules.
The node learns of an on-chain revoke by reading the hub, and it re-reads a Budget when its snapshot is older than `FUNDS_MAX_AGE_MS`, 10 seconds by default.
A call the node accepts between the owner's revoke and that read carries an acceptance dated after the revoke, which the hub refuses in `settle_own`.
The acceptance time is the node's clock and the revoke time is the block's, so the same can happen without any delay in reading.
The seller then cannot settle that call by itself, and, because vouchers are cumulative and the seller keeps the latest one, not the earlier calls to that payee either.
The node's own `settle_batch` still settles them inside the grace period.

## What a proof shows

A receipt proof shows three things:

1. The call is a leaf under a Merkle root that the Budget's settler stored on the hub in `settle_batch`.
2. The Budget's agent key signed the voucher for that call, bound to the hash of that exact request.
3. The hub's own `verify_receipt` view agrees with the path.

It does not show that the service was delivered.
It does not show that the root covers every voucher the node accepted: the chain proves the settler committed to a root, not that the root is complete.
Calls a seller settled itself are booked by the node with `settledBy: "seller"`.
They are in no batch, so they have no Merkle proof; what can be checked on chain for them is that the hub's settled position covers the call.

## Known limits

### The contract is unaudited

It was written during a hackathon and has unit tests, sandbox tests, a solvency check and an internal audit ([docs/audit/2026-11-10-internal-audit.md](audit/2026-11-10-internal-audit.md)), whose findings hub v2 fixes, and nothing more.
`contracts-near/build.sh` builds `contracts-near/out/hub.wasm` with a pinned toolchain, cargo-near version and `Cargo.lock`, and keeps every home-directory path out of the wasm, so its hash does not depend on who builds it or where (internal audit F8).
A rebuild from another directory gave the same hash; a build on a second machine has not been compared yet, and the NEP-330 Docker build has not been run.
Because the hub is locked, a bug found later cannot be fixed in place.

### A plain `ft_transfer` to the hub is untracked

Deposits must use `ft_transfer_call`.
A plain `ft_transfer` to the hub account credits nobody, and no method can move tokens that are neither escrow nor credit, so the sender cannot get them back.
On a public hub the token balance can therefore exceed the tracked total, and solvency checks compare with "at least", not "equal".

### Receipt timestamps are node-attested

The node sets the timestamp of each call, in Unix seconds, when it accepts the call.
The Merkle leaf commits to it, but nothing on chain checks it against block time.
Treat it as the node's statement.

### What netting does and does not guarantee

Netting offsets what Budget owners owe each other inside one batch, so fewer tokens move than were cleared.

It guarantees:

- The hub recomputes the netting result from the claims and rejects the batch unless it equals what the node submitted.
- Every claim is still verified one by one: agent signature, cap, payee list, settlement deadline.
- Each owner's net debit must fit that owner's escrow, with one Budget per owner per batch.
- The sum of escrow and credit changes only through deposits and payouts.

It does not guarantee:

- That any offset exists.
  Agents that only buy, or only sell, get aggregation (many calls, few transfers), not offset.
- That an owner needs less escrow up front.
  The node refuses a call when the Budget's unsettled spending plus the call exceeds its escrow, and it does not count money the owner is owed.
  So no batch clears only because of an offset.
- That earned credit pays an owner's debit.
  Settlement debits escrow only; an owner moves earned credit into a Budget with `fund_from_credit`, signed from its own wallet.
- Any saving in gas or fees.
  This page quotes none.

### After a revoke

A revoke starts a 24 hour grace period, and expiry is followed by a 3 day grace period.
Settlement closes at the earlier of the two, and `reclaim` opens strictly after that.

What a seller is guaranteed is 24 hours after a revoke made before `validUntil`, or the full 3 days after expiry when there was no revoke.
Hub v1 also took a revoke after `validUntil`, which cut the 3 day expiry grace to 24 hours after the revoke (internal audit F5).
Hub v2 refuses that revoke with `BUDGET_NOT_OPEN`, so once a Budget has expired its 3 day grace can no longer be shortened.
A seller that relies on `settle_own` should still settle within 24 hours of seeing a revoke.
The grace period exists so that calls accepted before the revoke can still settle.
The node stops accepting calls on a Budget as soon as it sees the revoke, including during the grace period.
The agent key can still sign during the grace period, and the chain cannot tell a voucher signed before the revoke from one signed after it.

The two ways to settle treat such a voucher differently:

- The seller cannot settle it.
  `settle_own` needs the node's acceptance dated no later than the revoke, so an acceptance dated after the revoke is refused (`ACCEPTANCE_TOO_LATE`), and a voucher the node never accepted has no acceptance at all.
- The settler can.
  In `settle_batch` the settler is the caller, so its own call is its acceptance, and the hub checks no acceptance time.
  A settler that keeps accepting calls after a revoke, or that colludes with whoever holds the agent key, is not stopped on chain.
  Its signatures prove it: every acceptance names the Budget, the cumulative amount, the time and the node key.

An owner therefore trusts the settler it names not to accept or batch calls after a revoke.
The exposure is bounded by the Budget's cap and escrow, and it ends when the owner reclaims after the deadline.

### Payees

The hub never credits its own account or the token account.
A claim that names one is refused with `RESERVED_ACCOUNT`, a Budget that lists one with `INVALID_BUDGET`, and a checkout payment to one is returned.
A Budget's owner cannot settle to itself through `settle_own` (`PAYEE_IS_OWNER`).
In a batch sent by the settler, a payment from an owner to itself counts toward the Budget's `spent` and moves no tokens.
A Budget that sets `allow_any_payee` allows any other payee on chain, which removes the main protection against a misdirected or injected payment.
In hub v2 that takes the explicit flag, with an empty list and a `max_payees` of 1 to 256 distinct payees the Budget can ever pay; an empty list without the flag is refused with `INVALID_BUDGET`.
The TypeScript builder in `packages/chain` sets the flag for an empty list and declares 16 payees unless told otherwise, so a client that builds terms some other way must set it on purpose.
The agent wallet refuses such a Budget unless its operator opts in (`ALLOW_ANY_PAYEE=1`, or `allowAnyPayee` in the SDK).
The payee list holds at most 16 accounts.

### The payee check

A payee list says who may be paid; the payee check judges whether an account looks safe to pay: allow, warn or block, with reasons.
The clearing node runs it before it accepts a voucher, and the MCP wallet runs it before it signs one.

- A blocked payee is refused with `PAYEE_BLOCKED`: a missing account, a name that imitates an allowed payee, several reports, or a payee the owner denied.
- A payee with warnings is refused with `PAYEE_NEEDS_APPROVAL` until the Budget's owner approves it on the node.
  An approval covers the warnings the owner saw, so a warning that appears later, such as changed contract code, asks again.
- Only a signed-in owner or the operator can approve.
  The agent key can only ask whether an approval exists, and the wallet has no tool that approves.
- An approval stands against a block only when it was sent with `overrideBlock: true`, and that is written to the activity log.

Its limits:

- The check is heuristics, not a guarantee.
  An allow means nothing that was checked speaks against the payee; it does not mean the payee is honest.
  A new account is not proof of fraud, and an old one is not proof of honesty.
- Reports filed on one node all carry that node's operator account, so one node is one reporter.
  Reports from one node alone lead to a warning, never to a block, and reporters are not verified beyond the node's own sign-in.
- When a payee the node has never seen cannot be checked, the call is refused, with a retry hint of 30 seconds.
  That is fail closed: a failing RPC endpoint or indexer stops first payments to new payees, and whoever can make those fail can cause that.
  A payee the node already holds a verdict for is decided on that verdict.
- Account ages come from an indexer (NearBlocks on `near:testnet`), which is trusted for the age and learns which accounts are checked.
  On a local sandbox there is no indexer, and ages are not checked.
- The check reads at final finality, and an account can change right after it is read.
- The operator can switch the check off (`PAYEE_CHECK=off`), and it is off on the simulated hub unless the node is handed a reader, as `pnpm demo` hands it a scripted stand-in.
  The payee list on chain does not depend on it.

Where the owner decides:

- On the Budget's page in the dashboard, signed in: "Waiting for your approval" with Approve and Deny, live over the node's event stream, and "Payee decisions" with Withdraw.
- A blocked payee never gets a plain Approve; "Approve anyway" needs the account id typed exactly, and sends `overrideBlock: true`.
- Report evidence is rendered as plain text and never as a link, so a report cannot plant a link in the owner's page.
- The `approveAt` address the node puts in a refusal is shown to the person and never followed by the page or the wallet.
- Approving is a decision of a signed-in person on the node: the agent key, the MCP wallet and the model have no way to make it.
- When a payee is added in "New Budget", the browser runs the same package against NEAR; a read that does not finish is a block with its reason, never silence.

### Storage on the hub

Hub storage is not paid by the hub account.
Every method that grows state measures the growth and charges exactly those bytes to whoever caused them.
The owner prepays its Budget's settlement storage at `open_budget`: 332 bytes (3.32 milliNEAR) for each payee the Budget can pay, each listed payee or `max_payees` for a Budget that allows any payee.
`settle_batch` and `settle_own` draw each new (Budget, payee) pair's `settled` and credit entries from that reserve, and a Budget whose reserve is short fails the batch with `INSUFFICIENT_RESERVE`.
`settle_own` then falls back to its caller's deposit.
Settlers prepay a NEAR storage balance with `fund_storage({ account })`, which pays only for their own batch records, their receipt keys and checkout payments.
A settler whose balance cannot pay for a batch record gets `INSUFFICIENT_STORAGE` for the whole batch and cannot settle until it, or anyone else, tops the balance up.
`storage_of({ account })` reports the balance, and `withdraw_storage({ amount })` returns the unused part to its own account only.
A removed credit entry returns its bytes to whoever paid for it: the Budget's reserve or the checkout settler's balance.
After the settlement deadline the owner calls `prune({ budget_id, payees })`, which removes the Budget's `settled` entries and refunds the freed storage and the unused reserve to the owner.
Storage freed from a credit entry that a `settle_own` caller's deposit paid for stays on the hub account and cannot be withdrawn by anyone.

In hub v1 the settler paid for every new (Budget, payee) pair a batch settled, about 3 milliNEAR each, whatever the amount, and never got it back (internal audit F4).
An owner with throwaway payee accounts could therefore make a settler pay for many pairs with dust payments, until its balance ran out and its batches failed with `INSUFFICIENT_STORAGE`.
Hub v2 moves that cost to the owner, so dust payments to new payees spend the owner's own prepaid NEAR and nothing of the settler's.
The node keeps its two limits as defence in depth: a first payment to a payee new to a Budget must be at least `NEW_PAYEE_MIN_AMOUNT` (default 0.001 USDC), and one Budget may pay at most `NEW_PAYEES_PER_HOUR` new payees in a rolling hour (default 20).
Checkout payment records and batch records stay on their settler's balance for good; the node signs every checkout and decides when to batch, so an outsider cannot drive either.

### The node

- The node's database is one SQLite file.
  It holds positions, receipts and Merkle paths.
  Losing it loses the proofs for calls that were not yet settled, although sellers still hold their vouchers and receipts.
- When the hub cannot be read and the node's funds snapshot is older than `FUNDS_MAX_AGE_MS`, the node refuses calls instead of accepting them.
  The rule is `NET_EXPOSURE`, with a message that says the hub could not be read and the retry hint `{ "kind": "after", "seconds": 5, "reason": "hub_unreadable" }`.
- The node checks the voucher signature before any rule, with the hub's own signature rule (see "One signature rule" below).
  A voucher that is not signed by the Budget's agent key gets a plain `BAD_SIGNATURE` error and creates no refusal record, no event and no webhook, so a stranger cannot fill an owner's refusal log.
- Before it builds a batch, the node checks every claim's signature again with the hub's rule, against the agent key the hub holds, and leaves out a claim that fails, so one bad claim cannot make the hub refuse a whole batch.
  The claim stays accepted and the operator is alerted once (`claim_signature_invalid`).
  Such vouchers are also rate limited per provider key or client address (`RATE_LIMIT_UNSIGNED_RPS`, `RATE_LIMIT_UNSIGNED_BURST`).
- A refusal that reaches an agent through a seller is the seller's unauthenticated word.
  The node signs its own record of every refusal of a voucher the agent signed, and the agent reads it with `GET /v1/budgets/:id/refusals?requestHash=`.
- If a seller settles a voucher this node has no record of accepting, the node's position follows the hub, the amount is booked as `uncleared`, and the operator is paged (`seller_settled_uncleared`).
  That can only happen when the node's receipt key signed an acceptance the database does not hold: the key leaked, or the database was restored from an older backup.
- The recovery key (`ADMIN_TOKEN`) works on every route before first-run setup, and afterwards only with `ADMIN_TOKEN_BREAK_GLASS=true`.
- The live event stream accepts the recovery key as `?token=`, which can leak into proxy logs; see [OPERATIONS.md](OPERATIONS.md).
- On `near:testnet` the node refuses the public development values for `ADMIN_TOKEN` and `NODE_SIGNING_SEED`.
  On the local sandbox it accepts them, so never expose a sandbox node to a network.

### One signature rule

The hub verifies every voucher and every acceptance with `env::ed25519_verify`, which is cofactorless: it requires `s < L`, recomputes `R' = [s]B - [k]A` and compares the bytes of `R'` with the signature's R.
Many ed25519 libraries, including the one the node and the SDK used before, check the cofactored equation instead, and accept a signature whose R carries a small torsion component.
The hub refuses such a signature, so a node that accepted it would sign acceptances for calls that never settle (internal audit F1), and a seller SDK would keep acceptances that `settle_own` refuses (F2).

Every check that stands in for the hub now uses one function, `verifyDigest` in `packages/chain`: the node's voucher intake and batch pre-check, and the SDK's paywall, receipt, export and `verifyReceiptOnchain` checks.
It returns true only when `env::ed25519_verify` would, and only for a key that is the canonical encoding of a point not of small order.
The shared vectors in `packages/chain/vectors/signatures.json` cover a torsioned R, non-canonical R and A encodings, small-order keys including the all-zero key, and `s >= L`.
The TypeScript tests run them through `verifyDigest`, and `contracts-near/src/tests/vectors.rs` runs them through the hub's own verify function, so the two sides cannot drift apart without a test failing.

A small-order agent key, the all-zero key among them, lets anyone sign vouchers for its Budget without a secret, and the hub v1 accepted such a key in `open_budget` (F3).
Hub v2 refuses a small-order or non-canonical agent key in `open_budget` (`INVALID_BUDGET`), and the same keys as a receipt key or the checkout key (`INVALID_KEY`), with the same list of small-order points as libsodium.
The node refuses to register such a Budget and the SDK refuses to create one, both with `WEAK_AGENT_KEY`.
The hub does not check that 32 bytes decode to a curve point at all; nobody can sign for such a key, and the off-chain check refuses it too.
`register_receipt_key` takes no proof that the settler holds the key's secret: a settler that registers a key it does not hold only stops its own sellers from using `settle_own`.

### Batch ids belong to their settler

The hub v1 stored batches by batch id alone, and any allowlisted settler could use any id that was not taken yet (internal audit F6).
The id did not need to be guessed: it is visible in a pending transaction, so a second settler that saw a batch on its way could settle a one-claim batch under the same id first, and `verify_receipt` for that id then checked against the other settler's root.
Hub v2 keys batches by settler and batch id: `batch({ settler, batch_id })` and `verify_receipt({ settler, batch_id, fields, proof })` name the settler, and a settler's id can never be taken by another.
The node still books a batch only when the hub's record holds the root this node built; anything else fails the batch, returns its calls to the queue for a new id, and pages the operator (`batch_mismatch`).
A receipt proof is only as good as the batch record it names, so read it under the settler you trust, as `verifyReceiptOnchain` does with the node operator's account.

### Checkout and refunds

- Wallet payments carry terms signed with the node's checkout key.
  Whoever holds that key can sign terms that name any merchant account, so a payer should read the merchant and amount in the wallet prompt.
- A wallet payment is proven by the hub's own record of the payment id, read again whenever the proof is requested.
- Refunds are sent by the merchant from its own payout account.
  The node checks the submitted transaction; when it has no transaction reader it can only check finality, and it says so in the refund's `verification` field.
- A payout account change needs a NEP-413 signature by a full-access key of the new account.

### Agents and prompt injection

A Budget bounds the damage of a compromised or misled agent; it does not prevent the agent from being misled.
An agent that follows an injected instruction can still spend inside its cap, its rate limits and its allowed payees.
Whoever holds the agent key file can spend up to the Budget, so the file is written with mode 0600 and never placed in a model's environment.

The MCP wallet adds limits that do not depend on the model obeying:

- It calls and pays only what its own node lists in its directory, or a host the operator put in `PAYABLE_HOSTS`.
- It refuses a Budget whose payee list is empty unless the operator set `ALLOW_ANY_PAYEE=1`.
- It advances a position only on a receipt its own node signed, and counts a voucher whose outcome is open as spent.
- It labels text a seller relayed as unauthenticated seller data, apart from what the wallet established itself.
- It runs the payee check before signing: a blocked payee is refused, a payee with warnings waits for the owner's approval, and the model has no tool that approves.
- Over HTTP it needs a bearer token on every request, because loopback is shared by every process on the machine.

The details are in [AGENTS.md](AGENTS.md).

### The optional relayer

`apps/relayer` pays NEAR gas for an owner's signed call to the hub, so an owner who holds only USDC can still revoke.
It pays only for zero-deposit calls to its own hub, to the methods on its list (`revoke_budget`, `reclaim` and `payout` by default).
It never holds user funds and cannot change what the owner signed.
What it can lose is its own gas, up to a daily budget.
A relayer that is down or hostile can refuse to relay, and then the owner revokes from a wallet with its own gas.
It needs a full-access key on its own account, so that account should hold a few NEAR and nothing else.

The dashboard's "Revoke without gas" does not trust the relayer's word:

- Before any wallet is asked, it reads the relayer's `GET /info` and stops when the relayer sponsors another hub, another network or not this method; nothing that attaches a deposit is offered.
- After the wallet signs, it decodes the delegate action and compares it with the call the owner reviewed, and checks on NEAR that the key is on the account, the nonce is unused and the delegate has not expired, before it posts anything.
- It says "Final on NEAR" only when it reads the revoke from the hub; the relayer's answer and the outer transaction's status are not taken as proof.
- An unknown outcome is shown as unknown, with a read of the hub, and no retry is offered until the hub has been read.

### A DAO as the owner

A Sputnik DAO v2 can own a Budget, so no single member can drain or stop it alone.
The dashboard builds every proposal and vote with `@payminto/near-addons`, reads the DAO's policy and proposals from NEAR in the browser, and votes with the proposal's kind, so a member votes on exactly what was read.
A proposal to the hub or the token that the add-on's audit does not recognize is labeled "Unrecognized call, review on chain" and cannot be approved from the dashboard.
The DAO's own policy decides who may propose and vote; Payminto does not change it.
A Budget proposed to a DAO keeps its name and rules in the proposing browser's localStorage until the hub holds it, because only the hash of the rules is on chain.
This flow is unit-tested and runs against a mock DAO in the dashboard; this repository records no proposal added or voted on testnet.

### NEAR AI Cloud attestation

When a business or an agent uses NEAR AI Cloud as its model provider, Payminto checks the enclave attestation around every model turn and records the result with the turn.
With the default settings a result is `partially_verified` at best, never `verified`.
The Intel TDX quote, its signature chain to Intel's root, the nonce and the signing keys are checked in the process.
The platform's TCB status, NVIDIA's verdict on the GPU evidence, and whether the measured software is software you trust are not checked, and each result says so.
An attestation never shows that an answer is correct.
The details are in `packages/models/README.md`.

### The NEAR AI Agent Market

Payminto does not settle, hold or route Agent Market jobs.
A hire on the market is paid through the market, on NEAR mainnet, to the market's own treasury account.
`packages/agent-market` only asks for a quote, checks it against an owner's limits before anything is signed, and lists Payminto receipts in a seller's deliverable.
The wallet's `quote_market_agent` tool quotes and decides only, and no tool pays the market.
The package's paying step was never run against the live market, and nothing in the agent or the wallet calls it.
Text in a market job is written by a buyer and is untrusted: it reaches the writing model as fenced data, and it never chooses who is paid or changes the spend ceiling of a job.

### Simulated, sandbox and testnet

- "Simulated" means `FakeChain`, an in-memory model of the hub with the same rules and refusal codes.
  It is not NEAR.
- "Sandbox" means near-sandbox, a local NEAR node that runs the real contract wasm.
  It is not testnet.
  `pnpm local` runs on one, with a development-only local signer that holds full-access keys of throwaway local accounts; it refuses any network but `near:sandbox`, any RPC that is not loopback and does not report the sandbox chain id, and anything but a function call ([SELF_HOST.md](SELF_HOST.md#the-whole-product-on-this-machine-pnpm-local)).
- Testnet means NEAR testnet, with Circle's testnet USDC, which has no value.

`pnpm demo` labels every chain line with which one it used.

### History

Payminto first ran on EVM testnets; that code is gone, and no measurement from it is quoted in these docs.

## Reporting a problem

Report a vulnerability privately to the maintainers through the repository's security advisory form, not in a public issue.
