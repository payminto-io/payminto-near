# Payminto Clearing Node

The self-hosted node that checks every agent voucher against its Budget, records it in a double-entry ledger, nets calls between Budget owners, and settles batches through the clearing hub on NEAR.
Budget funds are escrowed in the hub contract (unaudited, testnet by default); the node holds no funds and has no method that moves them.
It also runs the Payminto Gateway: a hosted checkout paid from a NEAR wallet, and payment links agents pay by voucher.
The design is `docs/superpowers/specs/2026-11-10-near-clearing-design.md`.

## Run it

```sh
cp apps/node/.env.example apps/node/.env   # edit as needed
pnpm --filter @payminto/node start         # or dev; both load apps/node/.env, shell variables win
```

Node 22.18 or newer is required (type stripping and `node:sqlite`).
`pnpm demo` runs the whole story locally without secrets.
Production concerns (TLS, backups with `pnpm --filter @payminto/node backup`, `/metrics`, key handling) are in `docs/OPERATIONS.md`.
Stop with Ctrl-C or SIGTERM: the node stops accepting requests, closes SSE streams, lets an in-flight settlement or payout finish booking, and closes the database.

## Configuration

All variables are validated once at startup with zod.
Errors name the variable and never print its value, and logs never contain keys or tokens.
`apps/node/.env.example` lists every variable with its default; the important ones:

| Var | Default | Meaning |
|---|---|---|
| `NETWORK` | `near:sandbox` | `near:sandbox` or `near:testnet`; there is no mainnet node mode |
| `RPC_URL` | network default | NEAR JSON-RPC; also used for access-key and refund-transaction reads |
| `HUB_ACCOUNT` | required | The clearing hub contract |
| `OPERATOR_ACCOUNT`, `OPERATOR_KEY` | required | The settler account and its function-call key, limited to `settle_batch` and `payout` |
| `NODE_SIGNING_SEED` | required | Signs per-call receipts and checkout terms; the hub's `checkout_key` must be its public key |
| `ADMIN_TOKEN` | required | Recovery key for admin routes before the first owner exists |
| `DB_PATH` | `./data/clearing.db` | SQLite file (WAL mode) |
| `SETTLE_INTERVAL_SEC`, `SETTLE_MIN_CALLS` | `0`, `1` | Auto-settle period (0 = manual) and the minimum number of unsettled calls |
| `PAYOUT_INTERVAL_SEC` | `300` | Scheduled payouts of hub credit (0 = only `POST /v1/payouts`) |
| `FUNDS_MAX_AGE_MS` | `10000` | Oldest hub snapshot (escrow, credit, revoked or not) a call may be decided on; 500 to 60000 |
| `RATE_LIMIT_UNSIGNED_RPS`, `RATE_LIMIT_UNSIGNED_BURST` | `5`, `50` | Vouchers not signed by their Budget's agent key, per provider key or client IP; past the bucket the answer is 429 |
| `GATEWAY_PAYOUT_ACCOUNT` | unset | Turns the gateway on and seeds the first business's payout account |
| `PAYEE_CHECK` | `on` | The payee check: `on` or `off`. Off, vouchers are judged by the Budget alone |
| `PAYEE_CHECK_INDEXER` | `nearblocks` on `near:testnet`, `off` on `near:sandbox` | Where account ages come from. A local chain has no indexer, and `nearblocks` is refused there |
| `PAYEE_CHECK_INDEXER_KEY` | unset | Optional NearBlocks API key; the keyless tier is rate limited |

## How a call is cleared

1. The provider's paywall (`@payminto/sdk`) forwards the agent's voucher to `POST /v1/vouchers`.
2. The node first verifies the ed25519 voucher signature against the Budget's agent key.
   It then runs the payee check, which can refuse with `PAYEE_BLOCKED` or `PAYEE_NEEDS_APPROVAL` (see "The payee check").
   A voucher that key did not sign, or one for a Budget the node does not know, is nobody's refusal: it gets a plain 402 error (`BAD_SIGNATURE` or `UNKNOWN_BUDGET`, no `refusal`), counts against the sender's unsigned limit, and leaves no denial row, event, webhook or screening decision in the owner's name.
3. The node then evaluates every rule inside one `BEGIN IMMEDIATE` transaction, so parallel calls cannot overspend.
   A revoked or expired Budget is refused at once, even inside the hub's settlement grace period.
   Net exposure counts escrow only: this Budget's unsettled spending plus the call must fit its escrow, because the hub debits only escrow at settlement.
   The funds check fails closed: a hub snapshot older than `FUNDS_MAX_AGE_MS` is read again first, and if the hub cannot be read the call is refused with `NET_EXPOSURE`, a message that says so, and the retry hint `{ kind: "after", seconds: 5, reason: "hub_unreadable" }`.
   A request paid with several vouchers (a payment split between a business and a platform fee) is one call: every cap is checked against its total, and it counts once toward the per-minute and same-request limits.
4. An accepted call gets a node-signed receipt and a ledger journal; a refusal is recorded with its rule, attempted amount, remaining Budget and retry hint, and goes out as a `budget.refused` webhook.
   A retry hint never invites a retry that cannot work: a rolling limit answers with the real seconds until the call fits every rolling limit it breaks, and with `never` when no wait helps.
5. `POST /v1/settlements` (or the interval worker) first reads the hub's settled position of every (Budget, payee) pair it would claim, and books what a payee settled itself with `settle_own`.
   It then takes the latest voucher per pair, checks each Budget on the hub, packs claims into batches of at most 100 with one Budget per owner, and calls `settle_batch` with the canonical netting result.
6. A send the hub refuses fails its batch; a send that ends without a verdict marks the batch `unknown` and returns its calls to the queue, and the node adopts the batch if the hub turns out to have it.
   A refusal with `STALE_VOUCHER` or `NET_MISMATCH` means a settled position moved under the batch (a `settle_own` raced it): the node reads the positions again and rebuilds the batch without what is already settled, at most 3 times a run.
   A batch is booked from the hub's record only when that record names this node as settler and stores this batch's root; anything else under the node's batch id fails the batch and pages the operator.
7. Net creditors are queued for payout and paid in calls of at most 10 accounts; unregistered accounts keep their credit on the hub until they register with the token.

`GET /v1/settlements/export` gives each party's gross expense and revenue per counterparty next to its net cash movement, as JSON or CSV.

## Calls a seller settles itself

`settle_own` is the seller's escape hatch, and the node does not get in its way or lose track because of it.
The node reads `settledOf` before every settlement and on the funds interval, and books each movement that none of its batches made as a seller settlement (`sst_...`).
Those calls are `settled` with `settledBy: "seller"`: they are in no batch, so they have no Merkle proof, and `GET /v1/receipts/:callId/proof` says so (`batchId`, `proof` and `onchainVerified` stay empty, and `sellerSettlement.covered` tells whether the hub's settled position covers the call).
The ledger posts a `seller.settled` journal that moves the amount from the owner's escrow to the seller's hub credit, as the hub did, and the export and overview list these amounts next to the batches.
If a seller settles a voucher the node never accepted, the node's position follows the hub, the amount is booked as `uncleared`, and the operator is paged.

## Refusals an agent can confirm

A seller relays the node's refusal to the agent, and a seller can say anything.
`GET /v1/budgets/:id/refusals?requestHash=<hash>` (public, like the position read; `payee` and `cumulative` narrow it) returns the node's own record of the refusals of that request.
Each record is signed with the node's receipt key (`nodeKey` in `/v1/info`), and the same signature travels with the 402 in `error.details.record`.
The digest is `refusalDigest` in `@payminto/protocol`: SHA-256 of the text `payminto.refused.v1|hub|network|id|budgetId|payee|amount|cumulative|requestHash|rule|attemptedAmount|remainingBudget|retry kind|retry value|timestamp`, with an empty field for a null remaining Budget or a hint without a number.
Its domain differs from the acceptance digest's (`payminto.accepted.v1`), so a refusal signature can never be used as a receipt.
The node keeps no record of a voucher the agent did not sign, so a relayed `BAD_SIGNATURE` or `UNKNOWN_BUDGET` cannot be confirmed this way.

## The payee check

Before a Budget pays an account, the node judges that account as allow, warn or block, with reasons.
The judgment is `@payminto/payee-check`: a missing account, a name that imitates an allowed payee, reports, a new account, changed contract code, and more.
The node adds the rules around it, and the owner's decisions.

### Do X, see Y

| Do | See |
|---|---|
| Start the node on `near:testnet` with the defaults | The log line `payee check on`, with `indexer: nearblocks` |
| `POST /v1/budgets` with a payee list | `payeeChecks` in the answer: one verdict per payee. A blocked payee does not stop the registration, because the owner decides |
| `GET /v1/payees/check?account=wrap.testnet&budget=<id>` | The verdict as JSON, with every signal, what was checked and what was not |
| Let an agent pay a payee with warnings | A 402 with `PAYEE_NEEDS_APPROVAL`, the event `payee.approval_requested` on `/v1/events`, and the request under `waiting` in `GET /v1/budgets/<id>/payee-approvals` |
| `POST /v1/budgets/<id>/payee-approvals` with `{ "payee": "wrap.testnet", "decision": "approve" }` | The approval with who decided and when. The same call is then accepted |
| Approve a payee the check blocks | `409 PAYEE_BLOCKED`, and the hint to send `overrideBlock: true`, which is written to the activity log |
| `POST /v1/payees/reports` with `{ "account", "reason", "evidence" }` | The report, filed in the name of this node's operator account. The next check of that account says `reported` |

These calls need a signed-in platform role (`agents.read` for reads, `agents.manage` for changes) or the recovery key, like the Budget routes.

### The two refusals

They are decided after the voucher's signature is checked and before the Budget's own rules run.
Each is an ordinary refusal: the 402 with the machine-readable `refusal`, a row in the refusals list, the `budget.refused` webhook and a signed record.

| Rule | Fires when | `retry` |
|---|---|---|
| `PAYEE_BLOCKED` | The verdict is block, or the Budget's owner denied the payee | `never` |
| `PAYEE_BLOCKED` | The payee could not be checked and the node has never seen it | `after` 30 seconds |
| `PAYEE_NEEDS_APPROVAL` | The verdict is warn and the owner has not approved the warnings it carries | `approval`, with `payee` and `approveAt` |

`approveAt` is `<PUBLIC_DASHBOARD_URL>/budgets/<Budget id>`.
It is built from the node's own configuration and from nothing a seller or a payee sent.
It tells a person where to decide; it is not an address for an agent to call.

A Budget that is revoked or expired is refused by its own rule, and the payee is not looked at.
A payee that is not on a non-empty payee list is refused with `PAYEE_NOT_ALLOWED` as before, unless the check blocks it: a lookalike of an allowed payee gets `PAYEE_BLOCKED` with that reason.

### Approvals

An approval belongs to one Budget and one payee, and records who decided and when.
It covers the warnings the owner saw: its `signals` list holds their ids.
A warning that appears later, such as changed contract code, asks again.
An approval does not stand against a block unless it was sent with `overrideBlock: true`, and then only against the blocks the owner saw.
`decision: "deny"` refuses the payee for that Budget whatever the check says.
`DELETE /v1/budgets/<id>/payee-approvals/<payee>` withdraws a decision.

An agent's wallet asks about an approval with `POST /v1/budgets/<id>/payee-approvals/requests` and a signature of the Budget's agent key (`payeeApprovalRequestDigest` in `@payminto/protocol`).
The answer is `approved`, `denied`, `waiting` or `blocked`.
That route records the waiting request and sends the live event; it cannot approve anything.

### What the call path reads

- A payee the owner approved, or one the Budget has paid 3 times, is decided on the verdict the node holds.
  The call path reads nothing from the network for it, and the node looks again in the background when that verdict is older than 5 minutes.
- Any other payee is looked at within 3 seconds, and verdicts are reused for 30 seconds.
- When the look cannot finish (the chain or the indexer does not answer), the node decides on the verdict it holds.
  Registration stores one for every payee on the list, so a slow indexer does not stop a listed payee.
- Only a payee the node has never seen is refused for that reason, with `PAYEE_BLOCKED` and `retry: { "kind": "after", "seconds": 30 }`.
  A patient look (20 seconds) runs behind the refused call, so the retry is decided on its verdict.

### Reports

A report is a claim by a third party, and its text is untrusted data.
It is validated (one line of at most 280 characters, evidence that is a transaction hash or an https URL), stored, and returned as plain JSON strings only.
It never appears in a signal's reason, in a refusal or in anything an agent reads.
The reporter is never taken from the request body: every report filed here carries this node's operator account, and `filedBy` says which signed-in person filed it.
So one node is one voice, and reports from this node alone lead to `reported` (warn), not to a block.

### Limits

- The check reads accounts through `RPC_URL`.
  On a network's public default endpoint it also tries the second public endpoint when the first refuses, because both are rate limited; with your own `RPC_URL` it reads that endpoint and no other.
- Account ages come from NearBlocks on `near:testnet`, which learns the account ids that are checked.
  A local chain has no indexer, so ages are not checked there and every verdict says so.
- A node handed a chain object (the tests, `pnpm demo` on the simulated hub) has nothing to read accounts with, so the check is off there unless the caller passes sources (`startNode(config, { payeeCheck })`).
- These are heuristics, not a guarantee.
  The limits of each signal are in `packages/payee-check/README.md`.

## Operator alerts

Conditions only the operator can resolve are logged as errors, emitted as `operator.alert` events, and counted in `payminto_operator_alerts_total{kind}`; alert on any increase.
The kinds are `batch_mismatch` (the hub holds another settler's batch or another root under this node's batch id), `seller_settled_uncleared` (a seller settled a voucher this node never accepted) and `settled_position_behind` (the hub's settled position is behind this node's, which means the database and the hub do not belong together).
`src/hub-readiness.ts` checks at startup what the hub requires of a settler: that this node's receipt key is registered for its account (`receiptKeys`), and that its prepaid `settle_batch` storage balance (`storageOf`) covers at least one full batch.
Each failed check is an error log line and an increase of `payminto_operator_alerts_total{kind="hub_readiness"}`.

## Gateway

A hosted checkout hands the shopper's wallet terms the node signed with its checkout key, as a ready `ft_transfer_call` to the hub.
The node polls the hub's record of each payment id (`Chain.payments`) and books what the hub recorded; the payment proof is that record, read again when asked.
Refunds are sent by the merchant from its own payout account and checked against the submitted transaction.
A payout account change needs a NEP-413 signature by a full-access key of the new account.
Agents pay links and payments over x402 v2 with `payminto-voucher` vouchers.

## Data safety

Tests always use a fresh `mkdtemp` directory and never `DB_PATH`.
The only destructive tool is `pnpm --filter @payminto/node db:reset <path>`, which refuses unless the path ends in `.test.db` or `.demo.db`, lives in the OS temp dir, or `--i-know-this-is-disposable` is passed (guard in `src/db/guard.ts`).
Startup refuses a database with migration entries this build does not ship, and never drops one.
Migrations are numbered and forward only: a database created by `001_near.sql` is brought up to date in place at startup, each file in one transaction, and `test/db-guard.test.ts` checks that every row survives.

## Tests

```sh
pnpm --filter @payminto/node test
pnpm --filter @payminto/node typecheck
```

Every suite runs on `FakeChain`, an in-memory model of the hub, with no network.
`test/e2e.test.ts` tells the demo story: three owners (one a DAO), refusals, a restart, offset settlement, a proven call, payouts and the books.
