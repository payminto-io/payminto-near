# Developer guide

This page is the reference for building on a Payminto clearing node: the x402 v2 wire, the refusal rules, the HTTP API, webhooks, the SDK and the MCP server.
How the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md), running a node is in [SELF_HOST.md](SELF_HOST.md), and the limits are in [SECURITY.md](SECURITY.md).
Every refusal, in every layer, with the test that proves it, is in [REFUSALS.md](REFUSALS.md).

Every JSON example on this page was captured from a node running in-process on the simulated hub (`FakeChain`, an in-memory model of the contract, not NEAR).
That is why the network reads `near:sandbox`, the accounts are demo names, and transaction hashes read `fake-tx-1`.
The shapes are the ones the zod schemas in `packages/protocol/src/x402.ts` and `packages/protocol/src/gateway.ts` define.
The examples were captured in several runs, so Budget ids and account names differ between sections.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | The node's `PUBLIC_URL`, by default `http://localhost:8787` |
| Bodies | JSON, at most 512 KiB (`413 PAYLOAD_TOO_LARGE` above that) |
| Amounts | Whole atomic units of the token as decimal strings; USDC has 6 decimals, so `"2000"` is 0.002 USDC |
| Ids | Budget, call, batch and request hashes are 32 bytes as 64 lowercase hex characters, with no `0x`; signatures are 128 hex characters; agent and node keys are `ed25519:<base58>` |
| Gateway ids | A prefix and 24 base32 characters: `pay_`, `plink_`, `re_`, `we_`, `evt_`, `whd_`, `key_`, `mer_`, `fp_` |
| Errors | `{ "error": { "code": "...", "message": "...", "details": { } } }` with a matching HTTP status |
| Lists | `GET /v1/calls` returns `items` and `nextCursor`, and the other clearing lists return plain arrays; gateway lists return `items` and `next_cursor`; pass the cursor back as `cursor`, and `limit` caps the page |
| Field names | Clearing routes use camelCase; gateway, account and webhook objects use snake_case |
| Rate limits | `429 RATE_LIMITED` with `Retry-After` in seconds; per provider key on `POST /v1/vouchers`, per IP for requests without a credential, and a separate, tighter bucket for vouchers no Budget's agent signed |

### Credentials

| Credential | How it is sent | What it is for |
|---|---|---|
| Session cookie | Set by `POST /v1/auth/login`; every mutating request also sends `X-Payminto-CSRF` with the `csrf_token` from `GET /v1/auth/session` | People in the dashboard; platform roles (`owner`, `admin`) and business roles (`admin`, `staff`, `viewer`) |
| Business API key | `Authorization: Bearer sk_test_...` | Server-to-server calls for one business: payments, links, refunds, webhooks |
| Provider key | `Authorization: Bearer pmk_...`, returned once by `POST /v1/providers` | A seller's paywall posting vouchers to `POST /v1/vouchers` |
| Recovery key | `Authorization: Bearer <ADMIN_TOKEN>` | Every route before first-run setup; afterwards only with `ADMIN_TOKEN_BREAK_GLASS=true`, and every use is written to the activity log |

Clearing routes (Budgets, providers, calls, batches, the ledger) need a platform role.
A business API key is never a platform credential.
So a script that registers Budgets or providers uses the recovery key, which works before setup or with break-glass on.

A request for one business names it with `Merchant-Id: mer_...` when the caller can see more than one.
`POST /v1/payments`, `POST /v1/links` and `POST /v1/refunds` accept `Idempotency-Key`: the same key and body within 24 hours returns the stored response with `Idempotent-Replayed: true`, and the same key with another body is `409 IDEMPOTENCY_MISMATCH`.

An unauthenticated call to a protected route:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "sign in, or send a merchant API key",
    "details": { "reason": "missing" }
  }
}
```

## The x402 v2 wire

Payminto uses the standard x402 v2 headers with its own scheme, `payminto-voucher`.
Every header is base64 of a JSON object.
A header whose `x402Version` is not `2` is refused as unsupported, never guessed at.

| Header | Direction | Carries |
|---|---|---|
| `PAYMENT-REQUIRED` | seller to agent, on 402 | The offer: resource, and one or more `accepts` entries |
| `PAYMENT-SIGNATURE` | agent to seller, on the retry | The entry the agent accepted, and the signed voucher |
| `PAYMENT-RESPONSE` | seller to agent | `success: true` with receipts, or `success: false` with the rule in `errorReason` |

Budget routes never offer the `exact` scheme, because a direct transfer would bypass the Budget policy.
Several `accepts` entries are always alternatives, never a split.

### 1. The 402

`GET /v1/quote?symbol=NEAR` with no payment answers `402` with this `PAYMENT-REQUIRED` (decoded):

```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://127.0.0.1:49941/v1/quote?symbol=NEAR",
    "description": "NEAR, BTC and ETH spot quotes"
  },
  "accepts": [
    {
      "scheme": "payminto-voucher",
      "network": "near:sandbox",
      "amount": "2000",
      "asset": "usdc.demo.testnet",
      "payTo": "globex.testnet",
      "maxTimeoutSeconds": 60,
      "extra": {
        "clearingHub": "hub.demo.testnet",
        "clearingNode": "http://127.0.0.1:49940",
        "providerId": "prv_68d00002feaf",
        "tokenSymbol": "USDC",
        "tokenDecimals": 6
      }
    }
  ]
}
```

The JSON body repeats the offer and adds `"error": { "code": "PAYMENT_REQUIRED", "message": "pay with payminto-voucher" }`.
`extra.clearingNode` is informational: an agent talks only to the node it was configured with.

### 2. The voucher

The agent signs a voucher and retries with `PAYMENT-SIGNATURE` (decoded):

```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://127.0.0.1:49941/v1/quote?symbol=NEAR",
    "description": "NEAR, BTC and ETH spot quotes"
  },
  "accepted": {
    "scheme": "payminto-voucher",
    "network": "near:sandbox",
    "amount": "2000",
    "asset": "usdc.demo.testnet",
    "payTo": "globex.testnet",
    "maxTimeoutSeconds": 60,
    "extra": {
      "clearingHub": "hub.demo.testnet",
      "clearingNode": "http://127.0.0.1:49940",
      "providerId": "prv_68d00002feaf",
      "tokenSymbol": "USDC",
      "tokenDecimals": 6
    }
  },
  "payload": {
    "budgetId": "ac2551352f9963247ad794a91dc6553d8231268fea5f67457158a05450673438",
    "payee": "globex.testnet",
    "amount": "2000",
    "cumulative": "2000",
    "requestHash": "447a71864339bec3b7b1f37737f1c8e11ad472431ac7d65c0c7159b834319a7e",
    "publicKey": "ed25519:4NiczFuuxWaP7xc8vUF38U951WCqeVgcD19ANry15Q3P",
    "signature": "660e5738052038afb07045352d35603bfcdc462bbb19cc3eafafe743f6ac292f84db9576303dc02c13cef0392b48d550a1b14b14eb59de57aaf1699fc6791805"
  }
}
```

| Field | Meaning |
|---|---|
| `accepted` | The `accepts` entry the agent chose, unchanged; the seller refuses one it does not offer now (`REQUIREMENT_MISMATCH`) |
| `amount` | The price of this call; it must equal the price registered for the provider |
| `cumulative` | The running total for this (Budget, payee) pair after this call; it must equal the node's latest accepted cumulative plus `amount` |
| `requestHash` | `sha256` of the four lines `payminto.request.v1`, the upper-case method, the path with query, and the hex `sha256` of the body, joined by newlines (`computeRequestHash` in `packages/sdk/src/util.ts`) |
| `publicKey` | The agent key that signed; the node checks it is the Budget's agent key |
| `signature` | Raw ed25519 over `sha256(borsh(tag, "payminto.voucher.v1", hub, network, budget_id, payee, amount, cumulative, request_hash))`, with `tag` 2147504402 |

The `payload` object is strict: an unknown field makes the header invalid.
The exact Borsh layout is in `packages/chain/README.md`.

A split payment is one `accepts` entry with `extra.splits` (at most 2 entries that sum to `amount`, the first paying `payTo`) and `payload: { "vouchers": [ ... ] }` with one voucher per split, in order.

### 3. Success

The seller forwards the voucher to its node and, when the node accepts, serves the response with `PAYMENT-RESPONSE` (decoded):

```json
{
  "success": true,
  "transaction": "",
  "network": "near:sandbox",
  "payer": "ed25519:4NiczFuuxWaP7xc8vUF38U951WCqeVgcD19ANry15Q3P",
  "receipts": [
    {
      "callId": "3dcd5d6fb69a8270672c8a65cbbfc3ed8d9c28861796586a70a5be174a08ef2c",
      "budgetId": "ac2551352f9963247ad794a91dc6553d8231268fea5f67457158a05450673438",
      "payee": "globex.testnet",
      "amount": "2000",
      "cumulative": "2000",
      "requestHash": "447a71864339bec3b7b1f37737f1c8e11ad472431ac7d65c0c7159b834319a7e",
      "timestamp": 1794283795,
      "voucherSig": "660e5738052038afb07045352d35603bfcdc462bbb19cc3eafafe743f6ac292f84db9576303dc02c13cef0392b48d550a1b14b14eb59de57aaf1699fc6791805",
      "digest": "a1413e6a3d4c51c1d79558e6cf51d10b5944617064be0c0a723fcf05e7728560",
      "nodeSignature": "05df5d4ca42238f25cac08231fe072e19a4e52351f3be1093ebc415bdbcf6445c4f6fa18568416630bf67e74fa9f428f1fc5d0f9220293ce8b1e78b3fbe00602",
      "node": "ed25519:Goat9CKkxpBrVi7fuT2knLWgpPHa4qVvNAVwaL6Hyp7w"
    }
  ],
  "positions": [
    {
      "budgetId": "ac2551352f9963247ad794a91dc6553d8231268fea5f67457158a05450673438",
      "payee": "globex.testnet",
      "cumulative": "2000",
      "settled": "0"
    }
  ]
}
```

An empty `transaction` means the call is cleared now and settles later in a netted batch.
`timestamp` is Unix seconds, set by the node and not proven on chain.
`nodeSignature` is the node's acceptance: its ed25519 signature over `digest`, by the key in `node`, which is also `nodeKey` in `GET /v1/info`.
Its digest is `sha256` of the text `payminto.accepted.v1|call_id|budget_id|payee|amount|cumulative|request_hash|timestamp|voucher_sig`, and `call_id` is `sha256` of the text `payminto.call.v1|budget_id|payee|cumulative|request_hash`.
A seller keeps this receipt, because the seller exit needs it (see "Seller vouchers and `settle_own`").
A response with status 402, or a `PAYMENT-RESPONSE` that does not parse as a v2 success carrying this voucher's receipt, is never treated as paid.

### 4. Refusal

When the node refuses, the seller answers `402` again.
`PAYMENT-REQUIRED` repeats the offer with `"error": "<rule>"`, and `PAYMENT-RESPONSE` (decoded) is:

```json
{
  "success": false,
  "errorReason": "PAYEE_NOT_ALLOWED",
  "transaction": "",
  "network": "near:sandbox",
  "payer": "ed25519:4NiczFuuxWaP7xc8vUF38U951WCqeVgcD19ANry15Q3P",
  "refusal": {
    "rule": "PAYEE_NOT_ALLOWED",
    "message": "Payee is not on the Budget allowlist",
    "attemptedAmount": "2000",
    "remainingBudget": "4993000",
    "retry": { "kind": "never" }
  }
}
```

The JSON body carries the same `refusal`, plus `error: { code, message, details }`.
A refusal that reaches the agent through a seller is relayed text: the seller could have altered it.
An agent can read the node's own record of a refusal instead of trusting the relay, with `GET /v1/budgets/:id/refusals?requestHash=<hash>`; see "Refusal records an agent can confirm".

## Refusal rules

The node checks the voucher signature first, then evaluates the rules in the order of `evaluateVoucher` in `apps/node/src/policy-engine.ts`, and the first rule that fails wins.
The table is in that order.
Every refusal carries `rule`, `attemptedAmount`, `remainingBudget` and a `retry` hint, so an agent loop can act without parsing English.
[REFUSALS.md](REFUSALS.md) names the test for each row.

| Rule | Fires when | `retry` |
|---|---|---|
| `UNKNOWN_BUDGET` | No Budget with this id is registered on this node. A plain error, not a recorded refusal (see below) | `never` |
| `BAD_SIGNATURE` | The voucher is not signed by the Budget's agent key. A plain error, not a recorded refusal (see below) | `never` |
| `BUDGET_REVOKED` | The owner revoked the Budget; this applies at once, even inside the hub's 24 hour grace period | `never` |
| `BUDGET_NOT_ACTIVE` | The Budget is not open yet, or the first millisecond after `validUntil` has passed | `never` |
| `PAYEE_NOT_ALLOWED` | The payee is not on a non-empty payee list | `never` |
| `PRICE_MISMATCH` | The voucher amount is not the provider's registered price | `never` |
| `PER_CALL_CAP` | The price of the request exceeds `perCallCap` | `never` |
| `STALE_CUMULATIVE` | `cumulative` does not extend the latest accepted voucher | `resign` with `expectedCumulative` |
| `RATE_LIMIT` | `maxCallsPerMinute` requests were already accepted in the last 60 seconds | `after` the real seconds until the call fits, or `never` |
| `REPEAT_REQUEST` | The same request hash was already paid `maxRepeatsPerRequest` times in the last hour | `after` the real seconds until the call fits, or `never` |
| `HOURLY_CAP` | The request would exceed the rolling one-hour cap | `after` the real seconds until the call fits, or `never` |
| `DAILY_CAP` | The request would exceed the rolling 24 hour cap | `after` the real seconds until the call fits, or `never` |
| `TOTAL_CAP` | The request would exceed the Budget cap | `never` |
| `NET_EXPOSURE` | The hub cannot be read and the node's funds snapshot is older than `FUNDS_MAX_AGE_MS`, or was never read | `after` 5 seconds with `reason: "hub_unreadable"` |
| `NET_EXPOSURE` | The Budget's unsettled spending plus this request would exceed its escrow | `after_settlement`, or `fund` with `shortBy` |

Two more rules, `PAYEE_BLOCKED` and `PAYEE_NEEDS_APPROVAL`, come from the payee check.
It runs after the signature check and before the rules above, and it is described under "The payee check".

A retry hint never invites a retry that cannot work.
For the four rolling limits, `seconds` is the time until the call fits every rolling limit it breaks now, counted from the calls that have to leave the window.
The hint is `never` when no wait helps: the call alone is larger than the cap, the Budget cap has no room left, or the Budget expires before the wait is over.

A request paid with several vouchers (a payment split between a business and a platform fee) is one call.
Every cap is checked against the total of the request, `attemptedAmount` is that total, and the request counts once toward the per-minute and same-request limits.

The `retry` shapes:

| `kind` | Extra fields | What to do |
|---|---|---|
| `never` | none | Changing the timing will not help |
| `after` | `seconds`, and `reason: "hub_unreadable"` when the wait is not for a window | The same call can succeed once that many seconds have passed |
| `after_settlement` | none | Retry after the next batch confirms |
| `fund` | `shortBy`, and `fromCredit` when the owner holds hub credit | Retry after `shortBy` atomic units are added to escrow |
| `resign` | `expectedCumulative` | Sign a new voucher with that cumulative |
| `approval` | `payee`, `approveAt` | The same call can succeed once the Budget's owner has approved `payee`. Waiting does not help, and an agent cannot approve it. `approveAt` is the page of the node's own dashboard where the owner decides; it is for a person to open, never an address for an agent to call |

`fromCredit` is `{ "action": "fund_from_credit", "budgetId", "amount", "credit" }`: the owner wallet action that moves earned credit into this Budget's escrow.
The node returns it in `POST /v1/vouchers`, in recorded refusals and in the `budget.refused` webhook.
The wire schema `retryHintSchema` in `packages/protocol/src/x402.ts` lists it, so it also reaches an agent through `paywall()` and `AgentClient`.

A real `NET_EXPOSURE` refusal, as the node answers `POST /v1/vouchers` with status 402:

```json
{
  "error": {
    "code": "NET_EXPOSURE",
    "message": "Unsettled spending of this Budget would exceed its escrow",
    "details": {
      "projected": "2000",
      "escrow": "1500",
      "outstanding": "1000",
      "amount": "1000",
      "credit": "0",
      "incoming": "0",
      "fundsKnown": true,
      "refusal": {
        "rule": "NET_EXPOSURE",
        "message": "Unsettled spending of this Budget would exceed its escrow",
        "attemptedAmount": "1000",
        "remainingBudget": "99999000",
        "retry": { "kind": "fund", "shortBy": "500" }
      },
      "position": {
        "budgetId": "996dee72e0cb9cd63d7cdaff20cbc54fc343c057be02f5685e8b84dd765d598b",
        "payee": "seller.testnet",
        "cumulative": "1000",
        "settled": "0"
      },
      "record": {
        "id": "dny_b5520aead0642f38",
        "timestamp": 1794296486,
        "digest": "84c034c6029e12de71d061d1584116e9381cab334db437a20faebc1a293e45aa",
        "nodeSignature": "26c47f0f063c3ea26bfaa10d64b692360f2354796be68ac623984fbc5d381608614c5dfe10cf4ff9294e068522d0cd057a63377624b7a621a0fd2891883ebd0c",
        "node": "ed25519:F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4"
      }
    }
  },
  "refusal": {
    "rule": "NET_EXPOSURE",
    "message": "Unsettled spending of this Budget would exceed its escrow",
    "attemptedAmount": "1000",
    "remainingBudget": "99999000",
    "retry": { "kind": "fund", "shortBy": "500" }
  }
}
```

`error.details.record` is the node's signature on its own record of this refusal, so a seller can relay it and an agent can check it.

### Vouchers nobody signed

The node verifies the voucher signature against the Budget's agent key before any rule.
A voucher that key did not sign, or one for a Budget the node does not know, is nobody's refusal.
It gets a plain 402 error with no `refusal`, and leaves no refusal record, no event, no webhook and no screening decision in the owner's name:

```json
{
  "error": {
    "code": "BAD_SIGNATURE",
    "message": "Voucher is not signed by the Budget agent"
  }
}
```

Such vouchers count against the sender's unsigned limit (`RATE_LIMIT_UNSIGNED_RPS`, `RATE_LIMIT_UNSIGNED_BURST`), and past it the answer is `429 RATE_LIMITED` with `details.scope: "unsigned"`.

### When the hub cannot be read

The funds check fails closed.
A hub snapshot (escrow, credit, revoked or not) older than `FUNDS_MAX_AGE_MS` is read again before a call is decided on it.
If the hub cannot be read, the call is refused with rule `NET_EXPOSURE`, the message "The node could not read this Budget's escrow from the hub, so it refuses until it can; retry shortly", and this hint:

```json
{ "kind": "after", "seconds": 5, "reason": "hub_unreadable" }
```

It does not ask for a deposit, because nothing is wrong with the Budget.
This shape is from `evaluateVoucher` and `apps/node/test/funds-freshness.test.ts`; it was not captured from a run for this page.

### The payee check

Before a Budget pays an account, the node judges that account as allow, warn or block, with reasons.
The judgment is `@payminto/payee-check`: a missing account, a name that imitates an allowed payee, reports, a new account, changed contract code, and more.
The node adds the two rules around it, and the owner's decisions.
It is on by default (`PAYEE_CHECK=on`) on a node that reads NEAR through `RPC_URL`.
A node handed a chain object, as in the tests and in `pnpm swarm` on the simulated hub, has nothing to read accounts with, so the check is off there unless it is also handed a reader: `pnpm demo` hands it a scripted stand-in for the chain's accounts.

| Rule | Fires when | `retry` |
|---|---|---|
| `PAYEE_BLOCKED` | The verdict is block, or the Budget's owner denied the payee | `never` |
| `PAYEE_BLOCKED` | The payee could not be checked and the node has never seen it | `after` 30 seconds |
| `PAYEE_NEEDS_APPROVAL` | The verdict is warn and the owner has not approved the warnings it carries | `approval`, with `payee` and `approveAt` |

Each is an ordinary refusal: the 402 with the machine-readable `refusal`, a row in the refusals list, the `budget.refused` webhook and a signed record.
`error.details.payeeCheck` carries the verdict and its signals.
A Budget that is revoked or expired is refused by its own rule, and the payee is not looked at.
A payee that is not on a non-empty payee list is refused with `PAYEE_NOT_ALLOWED` as before, unless the check blocks it: a lookalike of an allowed payee gets `PAYEE_BLOCKED` with that reason.

The hint of a `PAYEE_NEEDS_APPROVAL` refusal:

```json
{ "kind": "approval", "payee": "fresh-vendor.testnet", "approveAt": "http://localhost:3000/budgets/<Budget id>" }
```

`approveAt` is `<PUBLIC_DASHBOARD_URL>/budgets/<Budget id>`, built from the node's own configuration and from nothing a seller or a payee sent.
This block shows the shape from `retryHintSchema` and `apps/node/test/payee-check.test.ts`; it was not captured from a run for this page.

The routes.
Reads need a platform role with `agents.read` and changes one with `agents.manage`, or the recovery key, like the Budget routes; one route is for the agent's wallet.

| Method and path | Credential | Does |
|---|---|---|
| `GET /v1/payees/check?account=&budget=` | Platform, `agents.read` | The verdict for an account as JSON, with every signal, what was checked and what was not; `budget` judges it for that Budget's owner and payee list |
| `GET /v1/budgets/:id/payee-approvals` | Platform, `agents.read` | `{ budgetId, approveAt, approvals, waiting }`: the owner's decisions, and the payees that wait for one |
| `POST /v1/budgets/:id/payee-approvals` | Platform, `agents.manage` | Body `{ "payee", "decision": "approve" or "deny", "note"?, "overrideBlock"? }`. Records who decided and when. `409 PAYEE_BLOCKED` for approving a payee the check blocks without `overrideBlock: true`, and `400 NOTHING_TO_OVERRIDE` for the flag where nothing is blocked |
| `DELETE /v1/budgets/:id/payee-approvals/:payee` | Platform, `agents.manage` | Withdraws a decision |
| `POST /v1/budgets/:id/payee-approvals/requests` | The Budget's agent key | Body `{ "payee", "amount", "signature" }`. The wallet asks whether the owner approved a payee; the answer's `status` is `approved`, `denied`, `waiting` or `blocked`. It records the waiting request and sends the live event, and it cannot approve anything. `403 BAD_REQUEST_SIGNATURE` for any other signer |
| `POST /v1/payees/reports` | Platform, `agents.manage` | Body `{ "account", "reason", "evidence" }`, where `reason` is one line of at most 280 characters and `evidence` is a transaction hash or an https URL. Answers `201`. A `reporter` field is refused: every report carries this node's operator account |
| `GET /v1/payees/reports?account=` | Platform, `agents.read` | The reports, and how many distinct reporters |

`POST /v1/budgets` also answers with `payeeChecks`, one verdict per payee on the list.
A blocked payee does not stop the registration, because the owner decides.

The signature of the wallet's question is by the Budget's agent key over `payeeApprovalRequestDigest(hub, network, { budgetId, payee, amount })` in `@payminto/protocol`: `sha256` of the text `payminto.payee-approval-request.v1|hub|network|budgetId|payee|amount`.
It shows that the question comes from the Budget's own agent, and it approves nothing.

| Fact about approvals | Detail |
|---|---|
| Scope | One Budget and one payee |
| What it covers | The warnings the owner saw: its `signals` list holds their ids. A warning that appears later, such as changed contract code, asks again |
| Blocks | An approval does not stand against a block unless it was sent with `overrideBlock: true`, and then only against the blocks the owner saw; the override is written to the activity log |
| Deny | `decision: "deny"` refuses the payee for that Budget whatever the check says |
| Established payees | A payee the owner approved, or one the Budget has paid 3 times, is decided on the verdict the node holds, with no network read on the call path |

Design limits, stated plainly:

- The check is heuristics, not a guarantee.
  An allow means nothing that was checked speaks against the payee.
- Reports filed on one node all carry that node's operator account.
  So one node is one reporter, and reports from one node alone lead to `reported`, a warning, never to a block.
- When a payee the node has never seen cannot be checked, the call is refused with `PAYEE_BLOCKED` and `retry: { "kind": "after", "seconds": 30 }`.
  A payee the node already holds a verdict for is decided on that verdict.
- Account ages come from NearBlocks on `near:testnet`, which learns the account ids that are checked.
  A local sandbox has no indexer, so ages are not checked there and every verdict says so.
- The text of a report is untrusted data: it never appears in a signal's reason, in a refusal or in anything an agent reads.

The settings are `PAYEE_CHECK` (`on` or `off`), `PAYEE_CHECK_INDEXER` (`nearblocks` or `off`) and `PAYEE_CHECK_INDEXER_KEY`; [SELF_HOST.md](SELF_HOST.md) has the table.
Migration `006_payee_check.sql` adds the tables: `payee_verdicts`, `payee_approvals`, `payee_approval_requests`, `payee_reports` and `payee_code_seen`.
`apps/node/README.md` has a "do X, see Y" table for these routes.

### Refusal records an agent can confirm

`GET /v1/budgets/:id/refusals?requestHash=<hash>` is public, like the position read.
It returns the node's own record of the refusals of that request, at most 20, and `payee` and `cumulative` narrow it.
A real answer:

```json
{
  "budgetId": "996dee72e0cb9cd63d7cdaff20cbc54fc343c057be02f5685e8b84dd765d598b",
  "requestHash": "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4",
  "hub": "hub.payminto.testnet",
  "network": "near:sandbox",
  "node": "ed25519:F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4",
  "refusals": [
    {
      "id": "dny_b5520aead0642f38",
      "budgetId": "996dee72e0cb9cd63d7cdaff20cbc54fc343c057be02f5685e8b84dd765d598b",
      "payee": "seller.testnet",
      "amount": "1000",
      "cumulative": "2000",
      "requestHash": "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4",
      "timestamp": 1794296486,
      "refusal": {
        "rule": "NET_EXPOSURE",
        "message": "Unsettled spending of this Budget would exceed its escrow",
        "attemptedAmount": "1000",
        "remainingBudget": "99999000",
        "retry": { "kind": "fund", "shortBy": "500" }
      },
      "callId": "10d87fcf87315557ec783ceaa72177530ab34cf0578c3ffdd32d0ed9b62420f7",
      "lastSeen": 1794296486,
      "repeats": 1,
      "digest": "84c034c6029e12de71d061d1584116e9381cab334db437a20faebc1a293e45aa",
      "nodeSignature": "26c47f0f063c3ea26bfaa10d64b692360f2354796be68ac623984fbc5d381608614c5dfe10cf4ff9294e068522d0cd057a63377624b7a621a0fd2891883ebd0c",
      "node": "ed25519:F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4"
    }
  ]
}
```

| Fact | Detail |
|---|---|
| Signature | `nodeSignature` is by the node's receipt key, the `nodeKey` of `GET /v1/info`, over `digest` |
| Digest | `refusalDigest` in `@payminto/protocol`: `sha256` of the text `payminto.refused.v1\|hub\|network\|id\|budgetId\|payee\|amount\|cumulative\|requestHash\|rule\|attemptedAmount\|remainingBudget\|retry kind\|retry value\|timestamp`, with an empty field for a null remaining Budget or a hint without a number |
| Not a receipt | The domain differs from the acceptance digest's (`payminto.accepted.v1`), so a refusal signature can never be used as a receipt |
| Check it | `refusalSignedBy(hub, network, record, nodeSignature, nodeKey)` in `@payminto/protocol` |
| Replays | An identical refusal within `DENIAL_DEDUP_SEC` folds into the same record and raises `repeats` |
| What it cannot confirm | The node keeps no record of a voucher the agent did not sign, so a relayed `BAD_SIGNATURE` or `UNKNOWN_BUDGET` is not in this list |
| Errors | `404 UNKNOWN_BUDGET` for a Budget this node does not have |

### Client-side codes

The agent's own client applies the Budget's rules before it signs, in `packages/sdk/src/policy-guard.ts`.
Such a refusal has `details.enforcedBy: "agent"` and never produced a signature.
Its rolling-limit hints are whole windows (`after` 60, 3600 or 86400 seconds), except `REPEAT_REQUEST`, which carries the real seconds.
Codes only the client side produces:

| Code | Produced by | Meaning |
|---|---|---|
| `POSITION_UNVERIFIED` | `AgentClient` | The node reports a position above the highest cumulative this agent has signed |
| `TOKEN_MISMATCH` | `AgentClient` | The requirement's `asset` is not the token the hub clears |
| `CLIENT_MAX_PRICE` | `AgentClient`, MCP wallet | The price exceeds the client's `maxPrice`, the wallet's `MAX_PRICE_ATOMIC` or the call's `maxAmountAtomic` |
| `POLICY_UNAVAILABLE`, `POLICY_MISMATCH` | `AgentClient` | The Budget policy could not be fetched, or does not hash to the Budget id |
| `PAYEE_NOT_ALLOWED` with `details.allowlist: "empty"` | `AgentClient` | The Budget's payee list is empty and the client was not built with `allowAnyPayee: true` |
| `PAYEE_BLOCKED`, `PAYEE_NEEDS_APPROVAL` | MCP wallet | The wallet's own payee check before signing: a blocked payee is refused, and a warned one waits for the owner's approval on the node. The node applies the same two rules again |
| `CLIENT_TARGET_NOT_ALLOWED`, `CLIENT_TARGET_MISMATCH` | MCP wallet | The target is not in the node's directory or on a host in `PAYABLE_HOSTS`, or a `url` does not belong to the `serviceId` it came with |
| `SELLER_REFUSED` | `AgentClient`, MCP wallet | A seller relayed a refusal whose code is not a clearing rule; it is the seller's unauthenticated word |
| `TASK_SPEND_CEILING`, `NOT_IN_DIRECTORY` | Agent runtime (`apps/agent`) | The runtime's own guards |

Codes the seller's paywall produces before the node sees anything: `INVALID_PAYMENT`, `UNSUPPORTED_X402_VERSION`, `REQUIREMENT_MISMATCH`, `REQUEST_HASH_MISMATCH`, `BAD_SIGNATURE`, and `CLEARING_UNAVAILABLE` (503) when the paywall cannot reach its node.

## HTTP API

Routes come from `apps/node/src/api.ts`, `apps/node/src/auth/routes.ts`, `apps/node/src/gateway/routes.ts`, `apps/node/src/gateway/reports.ts` and `apps/node/src/agents/routes.ts`.
"Platform" means a platform role with the named permission, or the recovery key.

### Public

| Method and path | Returns |
|---|---|
| `GET /healthz` | `200` when the RPC answers, else `503`; never rate limited |
| `GET /v1/info` | Version, network, hub, token, operator account, `nodeKey`, public URL, settlement settings, whether the gateway is on |
| `GET /v1/providers` | The provider catalog: id, name, description, payee, price, resource, category. The gateway's own rows (category `gateway`), which merchant payments clear against, are not listed |
| `GET /v1/budgets/:id/policy` | The Budget terms, its policy and payee list, for an agent to verify against the Budget id |
| `GET /v1/budgets/:id/position?payee=` | `{ budgetId, payee, cumulative, settled }` |
| `GET /v1/budgets/:id/refusals?requestHash=` | The node's own signed records of the refusals of one request; `payee` and `cumulative` narrow it |
| `POST /v1/budgets/:id/payee-approvals/requests` | Answered only for the Budget's agent key: whether the owner approved a payee; see "The payee check" |
| `GET /v1/receipts/:callId/proof` | The receipt, how it was settled, its batch, Merkle path and whether the hub verifies it |
| `POST /v1/budgets/:id/revoke` | Stops new vouchers at the node; body `{ "signature" }` signed by the agent key, or a platform credential with an empty body |

`GET /healthz`:

```json
{
  "ok": true,
  "network": "near:sandbox",
  "hub": "hub.demo.testnet",
  "token": "usdc.demo.testnet",
  "operator": "node.demo.testnet"
}
```

`GET /v1/info`:

```json
{
  "version": "0.1.0",
  "network": {
    "id": "near:sandbox",
    "name": "Local NEAR sandbox",
    "explorer": null,
    "testnet": true,
    "rpc_url": "http://127.0.0.1:3030"
  },
  "hub": "hub.demo.testnet",
  "hubExplorerUrl": null,
  "token": { "address": "usdc.demo.testnet", "symbol": "USDC", "decimals": 6 },
  "explorer": null,
  "operator": "node.demo.testnet",
  "nodeKey": "ed25519:Goat9CKkxpBrVi7fuT2knLWgpPHa4qVvNAVwaL6Hyp7w",
  "publicUrl": "http://127.0.0.1:49940",
  "settleIntervalSec": 0,
  "gateway": { "enabled": false },
  "settlement": { "intervalSec": 0, "minCalls": 1, "maxClaimsPerBatch": 100 }
}
```

The agent-signed revoke signs `sha256` of the text `Payminto Clearing: revoke budget <budgetId>`.
It only stops the node: an agent cannot revoke on chain.
The response carries the owner's `revoke_budget` wallet transaction under `onchain.call` while the hub still shows the Budget open.

### Seller

| Method and path | Credential | Does |
|---|---|---|
| `POST /v1/vouchers` | Provider key | Submits one voucher; `200` with `{ receipt, position }`, `402` with `{ error, refusal }` for a recorded refusal, or `402` with `{ error }` alone for a voucher nobody signed |

The body, as `paywall()` sends it:

```json
{
  "x402Version": 2,
  "scheme": "payminto-voucher",
  "network": "near:sandbox",
  "payload": {
    "budgetId": "ac2551352f9963247ad794a91dc6553d8231268fea5f67457158a05450673438",
    "payee": "globex.testnet",
    "amount": "2000",
    "cumulative": "2000",
    "requestHash": "447a71864339bec3b7b1f37737f1c8e11ad472431ac7d65c0c7159b834319a7e",
    "publicKey": "ed25519:4NiczFuuxWaP7xc8vUF38U951WCqeVgcD19ANry15Q3P",
    "signature": "660e5738052038afb07045352d35603bfcdc462bbb19cc3eafafe743f6ac292f84db9576303dc02c13cef0392b48d550a1b14b14eb59de57aaf1699fc6791805"
  },
  "providerId": "prv_68d00002feaf",
  "requestHash": "447a71864339bec3b7b1f37737f1c8e11ad472431ac7d65c0c7159b834319a7e"
}
```

Other answers: `403 PROVIDER_MISMATCH`, `400 NETWORK_MISMATCH`, `400 PAYEE_MISMATCH`, `400 REQUEST_HASH_MISMATCH`, `401 UNAUTHORIZED` for an unknown key.

### Clearing (platform)

`GET` routes need `agents.read`, and writes need `agents.manage`, unless a row says otherwise.

| Method and path | Does |
|---|---|
| `GET /v1/overview` | Totals: volume, calls, refusals, Budgets, batches |
| `GET /v1/budgets` | Every Budget with its policy, spend and last known escrow |
| `GET /v1/budgets/:id` | One Budget with on-chain state, positions, recent calls and refusals |
| `POST /v1/budgets` | Registers a Budget that is already open on the hub; body `{ budget, policy, label }`; the answer carries `payeeChecks` when the payee check is on |
| `GET /v1/payees/check`, `GET`, `POST` and `DELETE` on `/v1/budgets/:id/payee-approvals`, `POST` and `GET /v1/payees/reports` | The payee check: verdicts, the owner's approvals and reports; see "The payee check" |
| `POST /v1/providers` | Registers a paid service; returns the provider with its `apiKey`, shown once |
| `GET /v1/providers/:id` | One provider with revenue and recent calls |
| `GET /v1/calls` | Accepted calls; filters `budgetId`, `payee`, `providerId`, `status` (`accepted`, `settling`, `settled`) |
| `GET /v1/denials` | Recorded refusals, newest first |
| `GET /v1/netting/preview` | What settling now would do: gross, net, transfers |
| `POST /v1/settlements` | Settles now (`settlements.run`); returns batches, or `{ "skipped": "nothing to settle" }` |
| `GET /v1/batches`, `GET /v1/batches/:id` | Batches; the detail lists claims, net entries and calls |
| `GET /v1/settlements/export` | Gross per counterparty next to net; `from`, `to`, `account`, `format=json` or `csv` |
| `GET /v1/payouts` | Payout accounts and payout runs |
| `POST /v1/payouts` | Pays out hub credit now (`settlements.run`) |
| `GET /v1/ledger`, `GET /v1/ledger/trial-balance` | Double-entry journal lines, and the trial balance |
| `GET /v1/events` | Server-sent events; see "Live events" |
| `GET /metrics` | Prometheus text; bearer `ADMIN_TOKEN` or `METRICS_TOKEN` |

`POST /v1/budgets` takes the terms the owner opened on chain, the policy they hash to, and a label.
`budget` here is the `budget` object that `GET /v1/budgets/:id/policy` returns:

```json
{
  "budget": {
    "owner": "acme.testnet",
    "agentPk": "ed25519:4NiczFuuxWaP7xc8vUF38U951WCqeVgcD19ANry15Q3P",
    "settler": "node.demo.testnet",
    "cap": "5000000",
    "validUntil": "1794326995161",
    "payees": ["globex.testnet", "scan.testnet"],
    "policyHash": "c44d42a4460e539546092d8d2ae8bae6d4e823ef9bb383d4364c3c0ad1585c10",
    "salt": "9aca2bb369ff68750764208ce54094d10a1ced5fde5a9938c7c32c3b5952d882"
  },
  "policy": {
    "dailyCap": "5000000",
    "hourlyCap": "0",
    "maxCallsPerMinute": 0,
    "maxRepeatsPerRequest": 0,
    "perCallCap": "5000",
    "purpose": "Acme research agent: buys quotes and scans"
  },
  "label": "acme agent"
}
```

`validUntil` is Unix milliseconds.
`hourlyCap`, `maxCallsPerMinute` and `maxRepeatsPerRequest` are off at `0`.
The node answers `400 POLICY_HASH_MISMATCH`, `400 WRONG_SETTLER`, `400 INVALID_PAYEES`, or `409 BUDGET_NOT_ON_CHAIN` when the hub does not have the Budget yet.
On success it reads the Budget's escrow and the owner's credit from the hub before it answers, so the Budget shows its funds before its first call; a failed read is logged and does not fail the registration.

`POST /v1/settlements`:

```json
{
  "batchIds": ["8d5578e7a155d8b4fde29038048d8e263219e71bd95e31b7dd1f8e5aef6a5b65"],
  "batches": [
    {
      "id": "8d5578e7a155d8b4fde29038048d8e263219e71bd95e31b7dd1f8e5aef6a5b65",
      "seq": 1,
      "status": "confirmed",
      "token": "usdc.fake.testnet",
      "receiptsRoot": "74f40d2d7c899c30dec6ee8c3ca4ab5ae7f67fe9d04059800b485fa2305f7dc7",
      "claims": 2,
      "calls": 22,
      "transfers": 2,
      "gross": "22000",
      "net": "22000",
      "projectedGross": "22000",
      "projectedNet": "22000",
      "compression": 11,
      "reconciled": true,
      "txHash": "fake-tx-1",
      "explorerUrl": null,
      "error": null,
      "trigger": "manual",
      "createdAt": "2026-11-10T07:41:26.671Z",
      "submittedAt": "2026-11-10T07:41:26.676Z",
      "confirmedAt": "2026-11-10T07:41:26.680Z"
    }
  ],
  "dropped": [],
  "sellerSettled": []
}
```

Batch `status` is `building`, `submitted`, `confirmed`, `failed` or `unknown`.
`dropped` lists claims the node left out after its on-chain pre-checks, each with a reason.
`sellerSettled` lists what payees settled themselves on the hub with `settle_own` since the last run, which this run booked outside any batch.
Before it builds a batch, the node reads the hub's settled position of every (Budget, payee) pair it would claim.
A batch the hub refuses with `STALE_VOUCHER` or `NET_MISMATCH`, because a `settle_own` raced it, is rebuilt without what is already settled, at most 3 times a run.

`POST /v1/payouts`:

```json
{
  "payouts": [
    {
      "seq": 1,
      "status": "confirmed",
      "trigger": "manual",
      "txHash": "fake-tx-2",
      "explorerUrl": null,
      "error": null,
      "createdAt": "2026-11-10T04:09:55.895Z",
      "finishedAt": "2026-11-10T04:09:55.896Z",
      "items": [
        { "account": "globex.testnet", "creditBefore": "2000", "creditAfter": "0", "paid": "2000", "outcome": "paid" },
        { "account": "scan.testnet", "creditBefore": "105000", "creditAfter": "0", "paid": "105000", "outcome": "paid" }
      ]
    }
  ],
  "waitingRegistration": []
}
```

A payout account's status in `GET /v1/payouts` is `due`, `waiting_registration` or `clear`.

The settlement export gives each party's books separately from the cash movement.
One party of the JSON form:

```json
{
  "account": "acme.testnet",
  "grossOut": "7000",
  "grossIn": "0",
  "netDebit": "7000",
  "netCredit": "0",
  "counterparties": [
    { "counterparty": "globex.testnet", "paid": "2000", "received": "0", "callsPaid": 1, "callsReceived": 0 },
    { "counterparty": "scan.testnet", "paid": "5000", "received": "0", "callsPaid": 1, "callsReceived": 0 }
  ]
}
```

The CSV form has the header `batch_id,confirmed_at,tx_hash,account,line,counterparty,expense,revenue,calls,net_debit,net_credit`, with `gross` lines per counterparty and one `net` line per account.

### Receipts and proofs

`GET /v1/receipts/:callId/proof`, after the batch confirmed:

```json
{
  "receipt": {
    "callId": "2ceced432510e1b7954d15305d096f3c584dce5f4cf3430e1a53066fb69c6f9f",
    "budgetId": "99d597cd4716e6f92bd33e2f3222dad24368915b1aff5510e5f043ff0a92ffa6",
    "payee": "seller.testnet",
    "amount": "1000",
    "cumulative": "1000",
    "requestHash": "a42ac5108869b599bcbac21069f63fb47f07452fcc4b87e89b3c06a945612d0b",
    "timestamp": 1794296486,
    "voucherSig": "0fc4b41cbc593c439354374701cad3e325ccb87898a9e66606121043fdffa3564cf23db0e9f794ba54ab94513d18be922449aa47327a47860929f1a7bd70f60f",
    "digest": "e1fc805bed2becff108bc1cf8decf23ffe885e95654acbf8af885f84beb0f004",
    "nodeSignature": "53b7247b903ab2f15b1be31e2e2c072b0eee55f1b94d4973fbf42f1e6012579d8d1c41c4b117e01b62d1169421922bf23140df6134d27dbf8974d9b5da17010d",
    "node": "ed25519:F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4"
  },
  "status": "settled",
  "settledBy": "batch",
  "sellerSettlement": null,
  "batchId": "8d5578e7a155d8b4fde29038048d8e263219e71bd95e31b7dd1f8e5aef6a5b65",
  "batchStatus": "confirmed",
  "receiptsRoot": "74f40d2d7c899c30dec6ee8c3ca4ab5ae7f67fe9d04059800b485fa2305f7dc7",
  "leaf": "46e7f4145f1f04f9e5154d05ad98d9e09f9c689dde0b41daa13225b92cf2ca68",
  "proof": [
    "ddff19327a8e9bd50cf833d074419c373c6c888b23c57cf98ce309af1714cb85",
    "7576b1aef66f15f6d219c7059b12c3dd2c83c35aad49d4780f7af0e546aa0620"
  ],
  "txHash": "fake-tx-1",
  "explorerUrl": null,
  "onchainVerified": true
}
```

The `proof` array is shortened here to its first 2 of 5 entries.
Before the call is settled, `settledBy` is null; before it is in a batch, `batchId`, `receiptsRoot` and `leaf` are null, `proof` is empty and `onchainVerified` is null.
`onchainVerified` is true only when this node settled the batch, its key signed the acceptance, and the hub's `verify_receipt` accepts the path.

A call its payee settled itself with `settle_own` is `settled` with `settledBy: "seller"`.
It is in no batch, so it has no root, no leaf and no Merkle proof: `batchId`, `receiptsRoot` and `leaf` are null, `proof` is empty and `onchainVerified` stays null.
What can be checked on chain is the hub's settled position, which the node reads again for the answer:

| `sellerSettlement` field | Meaning |
|---|---|
| `id` | The node's id of the seller settlement, `sst_...` |
| `previous`, `cumulative` | The settled position of the (Budget, payee) pair before and after it |
| `detectedAt` | When the node found it on the hub |
| `hubSettled` | The hub's settled position now, or null if the hub could not be read |
| `covered` | True when the hub's settled position is at or past this call's cumulative; null if unreadable |

The field list is from `apps/node/src/api.ts` and `apps/node/test/seller-settlement.test.ts`; no seller-settled answer was captured for this page.

To check a receipt without trusting the node, use the standalone verifier.
It reads only the chain:

```sh
pnpm verify:near --rpc-url <url> --hub <account> --receipt <receipt.json>
```

`pnpm demo` writes `receipt.json` and `receipt.tampered.json` into its run directory; `apps/demo/README.md` lists every check the verifier makes and its exit codes.

### Accounts

| Group | Routes |
|---|---|
| First-run setup | `GET /v1/setup`, `POST /v1/setup/check`, `POST /v1/setup` |
| Sign-in and sessions | `POST /v1/auth/login`, `GET /v1/auth/session`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`, `POST /v1/auth/step-up`, `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`, `POST /v1/auth/sessions/revoke-others` |
| Your account | `PATCH /v1/auth/me`, `POST /v1/auth/password`, `POST /v1/auth/verify/resend` |
| Sign-up and recovery | `POST /v1/auth/signup`, `POST /v1/auth/verify`, `POST /v1/auth/forgot`, `POST /v1/auth/reset/check`, `POST /v1/auth/reset` |
| Team | `GET /v1/members`, `PATCH /v1/members/:userId`, `DELETE /v1/members/:userId`, `GET /v1/invites`, `POST /v1/invites`, `POST /v1/invites/:id/resend`, `DELETE /v1/invites/:id`, `POST /v1/invites/lookup`, `POST /v1/invites/accept` |
| Platform | `GET /v1/platform/team`, `PATCH /v1/platform/team/:userId`, `GET /v1/users`, `PATCH /v1/users/:id`, `POST /v1/users/:id/unlock`, `POST /v1/users/:id/revoke-sessions`, `GET /v1/platform/signup-requests`, `POST /v1/platform/signup-requests/:id/approve`, `POST /v1/platform/signup-requests/:id/decline`, `GET /v1/platform/outbox`, `POST /v1/platform/email/test` |
| Activity log | `GET /v1/audit` |
| Search | `GET /v1/search?q=&types=&limit=`, `GET /v1/search/recent`, `POST /v1/search/recent` |

Roles, from `apps/node/src/auth/permissions.ts`:

| Role | Scope | Can |
|---|---|---|
| `owner` | Platform | Everything, on the platform and on every business |
| `admin` | Platform | Manage businesses, Budgets, paid services and settlements; read pricing and the team; not change platform settings, pricing or a payout account |
| `admin` | One business | Everything for that business except fee and limit terms of payment methods |
| `staff` | One business | Read payments, create payments and links, request refunds |
| `viewer` | One business | Read payments, screening decisions and the member list |

A business API key can read and write payments, links and refunds, update the business, manage webhooks and screening, and nothing about people or other keys.

`POST /v1/setup` takes `{ code, name, email, password, platform_name? }`.
`code` is the setup code the node printed to its log at start, or `ADMIN_TOKEN`.
Sensitive actions (API keys, payout changes, fee plans) answer `403 STEP_UP_REQUIRED` until the user confirms the password with `POST /v1/auth/step-up`.
Request schemas are at the top of `apps/node/src/auth/routes.ts`.

### Gateway (business)

These routes exist only when the gateway is on (`GATEWAY_PAYOUT_ACCOUNT` or `GATEWAY_ENABLED=true`).
The permission is the business permission the route checks.

| Method and path | Permission | Does |
|---|---|---|
| `GET /v1/merchant`, `PATCH /v1/merchant` | `payments.read`, `business.update` | The business profile, its fee plan, methods and payout history |
| `GET /v1/gateway/overview` | `payments.read` | 30 day volume and counts |
| `POST /v1/payments` | `payments.write` | Creates a payment; returns it with `checkout_url` |
| `GET /v1/payments`, `GET /v1/payments/:id` | `payments.read` | List (filters `status`, `method`, `link_id`, `email`, `q`, `refunded`) and detail with credits, refunds and timeline |
| `POST /v1/payments/:id/cancel` | `payments.write` | Cancels an open payment |
| `POST /v1/links`, `GET /v1/links`, `GET /v1/links/:id`, `PATCH /v1/links/:id` | `links.write` to change, `payments.read` to read | Payment links with a fixed amount, or a payer-chosen amount between `min_amount` and `max_amount` |
| `POST /v1/refunds` | `refunds.request` | Creates a refund; with `refunds.issue` the answer carries the `transfer` to sign |
| `GET /v1/refunds`, `GET /v1/refunds/:id`, `PATCH /v1/refunds/:id` | `payments.read`, `refunds.request` | List, read, set the internal note |
| `POST /v1/refunds/:id/approve` | `refunds.approve` | An Admin approves a requested refund |
| `POST /v1/refunds/:id/submit` | `refunds.issue` | Body `{ "txHash" }`: the merchant's own refund transaction, which the node then checks |
| `POST /v1/refunds/:id/cancel` | `refunds.issue`, or the requester | Cancels a pending refund |
| `GET /v1/customers`, `GET /v1/customers/:id` | `payments.read` | Customers derived from payments |
| `GET /v1/reports/reconciliation?from=&to=&format=json\|csv` | `payments.read` | One row per payment in the range, with fees, refunds and proofs |
| `POST /v1/api-keys`, `GET /v1/api-keys`, `DELETE /v1/api-keys/:id` | `developers.manage`, people only | Business API keys; the secret is shown once |
| Webhook endpoints | `developers.manage` | See "Webhooks" |
| `GET /v1/screening/decisions`, `GET /v1/screening/deny-list`, `POST /v1/screening/deny-list`, `DELETE /v1/screening/deny-list/:address` | `screening.read`, `screening.manage` | Refused payment attempts, and the business's blocked accounts |
| `GET /v1/merchants/:id/methods`, `PUT /v1/merchants/:id/methods` | `payments.read`, `business.update` | Payment methods; a business may only enable or disable them |
| `POST /v1/merchants/:id/payout` | `payout.change` | Changes the payout account with a NEP-413 proof |

`POST /v1/payments` with `{ "amount": "2500000", "description": "Pro plan", "reference": "inv-9" }` answers `201`:

```json
{
  "id": "pay_7biph4lmgtfttyklulpn5opi",
  "merchant_id": "mer_5dz53nbagpd6gleyoc5cwbki",
  "livemode": false,
  "status": "open",
  "amount": "2500000",
  "surcharge": "0",
  "amount_due": "2500000",
  "platform_fee": "0",
  "method_fee": "0",
  "fee_total": "0",
  "net_amount": "2500000",
  "amount_paid": "0",
  "amount_refunded": "0",
  "refund_status": "none",
  "network": "near:sandbox",
  "token": "usdc.fake.testnet",
  "hub": "hub.payminto.testnet",
  "checkout_id": "fa6c60e92aee2448dbf5f4cbe9ad43500ae2aa6e00cb2948e91047a21a132a85",
  "description": "Pro plan",
  "reference": "inv-9",
  "customer_email": null,
  "customer_name": null,
  "metadata": {},
  "line_items": [],
  "order_hash": "00af6a335379ad98ae5e7b7c49062c8fe6b8c446ec32a015582f9b7214a3539e",
  "link_id": null,
  "payer": null,
  "payout": "shop.testnet",
  "method": null,
  "late": false,
  "success_url": null,
  "checkout_url": "http://localhost:3000/pay/pay_7biph4lmgtfttyklulpn5opi",
  "expires_at": "2026-11-10T04:40:43.000Z",
  "paid_at": null,
  "canceled_at": null,
  "created_at": "2026-11-10T04:10:43.000Z",
  "updated_at": "2026-11-10T04:10:43.000Z",
  "fee_recipient": null
}
```

Other accepted fields are `method` (`wallet` or `voucher`), `customer_email`, `customer_name`, `metadata`, `line_items`, `success_url` and `expires_in` (300 to 604800 seconds, default 1800).
Payment `status` is `open`, `processing`, `partially_paid`, `paid`, `overpaid`, `underpaid`, `expired` or `canceled`.
The fee lines are zero because the default fee plan is "No fee".

A refund is the merchant's own transfer.
`POST /v1/refunds` with `{ "paymentId": "pay_...", "amount": "500000", "reason": "partial refund" }` answers with the refund and, when the caller may issue it, the transaction for the payout account to sign:

```json
{
  "receiverId": "usdc.fake.testnet",
  "actions": [
    {
      "type": "FunctionCall",
      "params": {
        "methodName": "ft_transfer",
        "args": {
          "receiver_id": "shopper.testnet",
          "amount": "500000",
          "memo": "payminto refund re_ijgmaseieqsvezskvpi5k36r"
        },
        "gas": "30000000000000",
        "deposit": "1"
      }
    }
  ]
}
```

The refund request bodies use camelCase (`paymentId`, `requestApproval`, `txHash`), unlike the snake_case objects.

### Gateway (platform)

| Method and path | Permission | Does |
|---|---|---|
| `GET /v1/platform`, `PATCH /v1/platform` | `platform.read`, `platform.manage` | Platform name, default fee plan, sign-up mode (`off`, `approval`, `open`) |
| `GET /v1/platform/fees` | `earnings.read` | Fees collected; zero under the default plan |
| `GET /v1/fee-plans`, `POST /v1/fee-plans`, `GET /v1/fee-plans/:id`, `PATCH /v1/fee-plans/:id` | `pricing.read`, `pricing.manage` | Fee plans; `platform_fee_bps` from 0 to 1000 |
| `GET /v1/merchants`, `POST /v1/merchants`, `GET /v1/merchants/:id`, `PATCH /v1/merchants/:id` | `businesses.read`, `businesses.manage` | Businesses; creating one needs a NEP-413 payout proof |
| Platform webhook endpoints under `/v1/platform/webhooks` | `agents.read`, `agents.manage` | Alert endpoints for `budget.refused` and `payment.deposit_failed`; see "Webhooks" |

A payout proof is `{ payout, timestamp, public_key, signature }`: a NEP-413 `signMessage` result over the text `Payminto payout change <merchant id or "new"> <payout> <timestamp> network <network> hub <hub>`, signed by a full-access key of the payout account, at most 600 seconds old.
`payoutProofRequest` in `packages/protocol/src/gateway.ts` builds the exact request.

### Hosted checkout (public)

| Method and path | Does |
|---|---|
| `GET /v1/checkout/:id` | The public view of a payment, with the wallet transaction to send |
| `GET /v1/checkout/:id/quote?method=` | The amount due for a method |
| `POST /v1/checkout/:id/method` | Re-quotes an open payment for `wallet` |
| `POST /v1/checkout/:id/wallet` | The payer's wallet sent the transaction; the node asks the hub now; body `{ "tx_hash"? }` |
| `POST /v1/checkout/:id/email` | Stores the payer's email on the payment |
| `GET /v1/checkout/:id/order` | The canonical order JSON that `order_hash` hashes |
| `GET /v1/checkout/:id/proof` | The evidence that the payment was paid, read from the chain now |
| `GET /v1/checkout/:id/events` | Server-sent `status` events for the checkout page |
| `GET /v1/links/public/:slug`, `POST /v1/links/public/:slug/payments` | The public view of a link, and a new payment from it |

The `wallet` object of `GET /v1/checkout/:id`:

```json
{
  "terms": {
    "payment_id": "fa6c60e92aee2448dbf5f4cbe9ad43500ae2aa6e00cb2948e91047a21a132a85",
    "merchant": "shop.testnet",
    "amount": "2500000",
    "expiry_ms": "1794285643000"
  },
  "signature": "fd34e4e126e3d7d55f1bc5cfbc2624b478f7d11c096907ec04a55bf14cc785342ba95adc777f0bd62d18e6667ac50673b7e8fa540b8668be3f5d522238e96a0e",
  "checkout_key": "ed25519:F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4",
  "transaction": {
    "receiverId": "usdc.fake.testnet",
    "actions": [
      {
        "type": "FunctionCall",
        "params": {
          "methodName": "ft_transfer_call",
          "args": {
            "receiver_id": "hub.payminto.testnet",
            "amount": "2500000",
            "msg": "{\"payment\":{\"payment_id\":\"fa6c60e92aee2448dbf5f4cbe9ad43500ae2aa6e00cb2948e91047a21a132a85\",\"merchant\":\"shop.testnet\",\"amount\":\"2500000\",\"expiry_ms\":\"1794285643000\",\"signature\":\"fd34e4e126e3d7d55f1bc5cfbc2624b478f7d11c096907ec04a55bf14cc785342ba95adc777f0bd62d18e6667ac50673b7e8fa540b8668be3f5d522238e96a0e\"}}"
          },
          "gas": "100000000000000",
          "deposit": "1"
        }
      }
    ]
  }
}
```

The hub records the payment under `terms.payment_id`, and that record is the proof.
A credit in `GET /v1/checkout/:id/proof` for a wallet payment:

```json
{
  "method": "wallet",
  "amount": "2500000",
  "payer": "shopper.testnet",
  "checkout_id": "fa6c60e92aee2448dbf5f4cbe9ad43500ae2aa6e00cb2948e91047a21a132a85",
  "tx_hash": "8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx",
  "hub_record": {
    "merchant": "shop.testnet",
    "amount": "2500000",
    "payer": "shopper.testnet",
    "at_ms": "1794283842900"
  },
  "verified": true
}
```

`tx_hash` is the transaction that paid, as the node recorded it or as the payer's wallet reported it, and `null` when neither is known.
`verified` means the hub credited the merchant's payout account with this amount; the payout that sends it on is a separate step.

### Agents paying links and payments

| Method and path | Does |
|---|---|
| `GET` or `POST /v1/pay/l/:slug` | Pays a payment link over x402; `?amount=` for a payer-chosen amount |
| `GET` or `POST /v1/pay/:id` | Pays one payment over x402 |
| `GET /v1/directory`, `GET /.well-known/payminto.json` | The service directory: listed links and registered paid endpoints |

Without `PAYMENT-SIGNATURE` these answer `402` in the shape shown under "The 402", with `maxTimeoutSeconds` 300 and the link's own URL as the resource.
The dashboard forwards non-browser requests for `/l/:slug` and `/pay/:id` to these routes, so one link works for people and agents.
A retry with vouchers the node already accepted returns the same receipts.

One entry of `GET /v1/directory`:

```json
{
  "type": "endpoint",
  "id": "prv_48b0b3d5c4e0",
  "title": "Quotes",
  "description": "Spot quotes",
  "category": "market-data",
  "price": { "amount": "1000" },
  "payee": "seller.testnet",
  "token": { "address": "usdc.fake.testnet", "symbol": "USDC", "decimals": 6 },
  "network": "near:sandbox",
  "schemes": ["payminto-voucher"],
  "pay_url": "https://seller.example/v1/quote"
}
```

### Any-chain checkout (NEAR Intents)

A buyer pays from another chain and the merchant receives exactly the invoice amount of USDC in its own NEAR mainnet account, through the 1Click API.
The method is `oneclick`.
It is an add-on: the core `PAYMENT_METHODS` stay `wallet` and `voucher`, and `CHECKOUT_METHODS` in `@payminto/protocol` adds `oneclick`.
Clients that parse `method` or `methods` must accept `oneclick` on a node that runs it.
Every type below is exported from `@payminto/protocol` (`packages/protocol/src/intents.ts`).

The node runs it only with `INTENTS_CHECKOUT=simulated` or `live` (default `off`; see `apps/node/.env.example`).
`simulated` talks to the fake 1Click server and delivers on a local chain; `pnpm local` sets it up.
`live` moves real money on NEAR mainnet and is only ever turned on by the operator.
Every object that carries intents data has `mode` and `label`: `Live - NEAR mainnet` or `Simulated - no real money`.
Show the label wherever intents data is shown.
With `INTENTS_CHECKOUT=off` every route below answers `404 INTENTS_CHECKOUT_OFF`, except `GET /v1/platform/intents`, which answers `{ "object": "intents_status", "mode": "off", "label": null }`.

Public checkout routes (no auth):

| Method and path | Does |
|---|---|
| `GET /v1/checkout/:id/intents/options` | `IntentsOptions`: each offered origin with an indicative price from a signed dry quote, or greyed with a reason; cached 30 seconds |
| `POST /v1/checkout/:id/intents/quotes` | Body `{ "origin_asset", "refund_to" }`; `201` with a new `IntentsQuote`, or `200` with the active one for the same origin and refund address when 10 minutes or more are left; `Idempotency-Key` honored; 10 per client address per minute |
| `GET /v1/checkout/:id/intents/quotes/:qid` | One `IntentsQuote` |
| `POST /v1/checkout/:id/intents/quotes/:qid/deposit` | Body `{ "tx_hash" }` (the buyer's transaction on the origin chain); forwards it to 1Click to speed detection and checks now; answers the `IntentsQuote` |
| `POST /v1/checkout/:id/intents/quotes/:qid/simulate` | Simulated mode only, `404` in live mode: body `{ "amount"? }` in the origin token's base units (default `send_exactly`); the fake server receives that deposit; answers the `IntentsQuote` |

`GET /v1/checkout/:id` and every `status` event of `GET /v1/checkout/:id/events` carry `methods` with `oneclick` when the payment can be paid from another chain now, and an `intents` object (null when the node runs with `INTENTS_CHECKOUT=off`):

```json
{
  "methods": ["wallet", "oneclick"],
  "intents": {
    "mode": "simulated",
    "label": "Simulated - no real money",
    "available": true,
    "reason": null,
    "settlement_network": "near:mainnet (simulated)",
    "active_quote": null
  }
}
```

`active_quote` is the newest quote of the payment that has not expired, whatever its state, so the page can show progress, success or a returned deposit.
`reason` says in plain words why `available` is false (for example "This checkout expires too soon to pay from another chain.").
A payment can be paid from another chain while it is open, has 10 minutes or more left, carries no fee, and the business turned `oneclick` on with a verified NEAR account.

The origins are USDC on Base, Ethereum, Arbitrum, Solana and Polygon, USDT on Ethereum, and ETH on Base and Ethereum.
One row of `IntentsOptions.options`:

```json
{
  "origin": { "asset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "chain": "base", "chain_name": "Base", "symbol": "USDC", "decimals": 6 },
  "available": true,
  "reason": null,
  "slippage_bps": 10,
  "amount_in": { "amount": "4509585", "formatted": "4.509585", "symbol": "USDC" },
  "amount_in_usd": "4.507570845505",
  "time_estimate_sec": 35,
  "fees": { "...": "the same IntentsFeeLines as on a quote" }
}
```

A greyed row has `available: false`, `reason` (for example "The minimum on this network is $100."), and null amounts.

An `IntentsQuote`, the deposit screen:

```json
{
  "id": "iq_ccbq7ktq3ypx2m3l3wmbqcbb",
  "object": "intents_quote",
  "payment_id": "pay_boxykimcem2hjper3q3nb53l",
  "mode": "simulated",
  "label": "Simulated - no real money",
  "status": "awaiting_deposit",
  "provider_status": null,
  "origin": { "asset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "chain": "base", "chain_name": "Base", "symbol": "USDC", "decimals": 6 },
  "deposit_address": "0x87151c5ac911a4459762ce215649313cd369dc05",
  "deposit_memo": null,
  "send_exactly": { "amount": "4509585", "formatted": "4.509585", "symbol": "USDC" },
  "min_amount_in": { "amount": "4505080", "formatted": "4.505080", "symbol": "USDC" },
  "amount_out": { "amount": "4500000", "formatted": "4.500000", "symbol": "USDC" },
  "amount_in_usd": "4.507570845505",
  "fees": {
    "send_exactly": { "amount": "4509585", "formatted": "4.509585", "symbol": "USDC" },
    "merchant_receives": { "amount": "4500000", "formatted": "4.500000", "symbol": "USDC" },
    "swap_cost": { "amount": "5080", "formatted": "0.005080", "unit": "USDC" },
    "price_buffer": { "amount": "4505", "formatted": "0.004505", "symbol": "USDC" },
    "refund_fee": { "amount": "2402", "formatted": "0.002402", "symbol": "USDC" },
    "delivery_fee": { "amount": "4628", "formatted": "0.004628", "symbol": "USDC" },
    "time_estimate_sec": 35
  },
  "slippage_bps": 10,
  "time_estimate_sec": 35,
  "refund_to": "0x5f2b...554f",
  "recipient": "anychain.test.near",
  "settlement_network": "near:mainnet (simulated)",
  "deadline": "2026-11-10T22:38:01.000Z",
  "deadline_passed": false,
  "inactive_at": "2026-11-10T22:38:01.000Z",
  "deposited": null,
  "delivered": null,
  "refunded": null,
  "refund_reason": null,
  "origin_txs": [],
  "destination_txs": [],
  "near_txs": [],
  "delivery_tx": null,
  "verification": null,
  "steps": [
    { "key": "waiting", "label": "Waiting for deposit", "state": "current" },
    { "key": "received", "label": "Deposit received", "state": "pending" },
    { "key": "converting", "label": "Converting to USDC", "state": "pending" },
    { "key": "delivered", "label": "Delivered to merchant", "state": "pending" }
  ],
  "warning": "Send only USDC on the Base network, to this address. Other tokens, other networks, or a deposit after 22:38 UTC may be lost.",
  "correlation_id": "0f8b2c1e-6a43-4c1b-9d61-3f0c8f0d2a77",
  "signature_valid": true,
  "created_at": "2026-11-10T22:08:01.512Z",
  "updated_at": "2026-11-10T22:08:01.512Z"
}
```

Show `deadline` (when the deposit address goes inactive), never the payment's `expires_at`.
`swap_cost` is in the origin token for a stablecoin and in USD (`unit: "USD"`, `amount` in micro-dollars) for ETH.
`price_buffer` goes back to the refund address when the price holds.
Every fee number comes from the signed quote; none is a constant.
On the public routes `refund_to` is masked; the merchant sees it in full.
`steps[].state` is `done`, `current`, `pending` or `failed`.
`explorer_url` on a transaction is null when there is no explorer (simulated mode, and 1Click sends none).

States of a quote (`status`):

| Status | Meaning | Payment |
|---|---|---|
| `awaiting_deposit` | Nothing arrived yet | open |
| `deposit_detected` | 1Click saw the deposit | processing (a pending `oneclick` credit holds expiry) |
| `incomplete_deposit` | Less than `min_amount_in` arrived; top it up before `deadline` or it is returned | processing |
| `processing` | The swap runs | processing |
| `delivered` | 1Click says the USDC was delivered; the node is reading it on NEAR | processing |
| `confirmed` | The node read the delivery on NEAR (`verification: rpc_checked`), or could not read it for 10 minutes and took 1Click's word (`provider_only`) | paid (overpaid when two quotes delivered) |
| `refunded` | The deposit went back to `refund_to`; `refunded`, `refund_reason` say how much and why | open again, or expired |
| `failed` | The swap failed | open again, or expired |
| `expired` | The address never saw a deposit, a day after its deadline | unchanged |

The node confirms only after it read the NEP-141 `ft_transfer` event of the USDC contract to the merchant's account for at least the invoice amount in the delivery transaction.
A transaction that shows less, or another recipient, is never confirmed and stays `delivered`.
`deadline_passed` turns true at `deadline`; the quote stays watched for a day, because a late deposit can still be swapped or returned, so offer "Get a new address" then.

Errors of `POST .../quotes` (all `{ "error": { "code", "message", "details"? } }`, `message` in plain words for the buyer):

| Status and code | When |
|---|---|
| `400 ORIGIN_NOT_OFFERED`, `400 INVALID_REFUND_ADDRESS` | Not one of the origins; not an address of the origin chain |
| `409 INTENTS_UNAVAILABLE` | `message` is the same plain reason as `intents.reason` |
| `409 INTENTS_QUOTE_LIMIT` | 5 deposit addresses of this payment are waiting already |
| `502 INTENTS_QUOTE_FAILED` | 1Click refused the route (for example a minimum); `details.provider_message` has its words |
| `502 INTENTS_QUOTE_REFUSED` | 1Click's quote failed a check (signature, echoed fields, `minAmountOut`, recipient, deposit address, memo, deadline); `details.refusals` lists them; no deposit address is shown or stored |
| `503 INTENTS_BUSY` | 1Click rate limited the node or could not be reached |
| `429 RATE_LIMITED` | More than 10 deposit addresses a minute from one client address |

Merchant and platform routes:

| Method and path | Does |
|---|---|
| `GET /v1/merchant/intents-payout` | `IntentsPayout`: the business's NEAR account for any-chain payments and its checks, read now (`payments.read`) |
| `PUT /v1/merchant/intents-payout` | Body `{ "account", "proof": { "timestamp", "public_key", "signature" } }`: checks the NEP-413 signature, that the key is a full-access key of the account, that the account exists, and its USDC registration (`payout.change`, a verified email and a fresh password check, like a payout change); answers the `IntentsPayout` read from the chain again, so no check is `null` after a save |
| `PUT /v1/merchants/:id/methods` | Turns `oneclick` on or off; turning it on is refused with `409 INTENTS_PAYOUT_REQUIRED` or `INTENTS_PAYOUT_NOT_REGISTERED` until the account is verified |
| `GET /v1/merchants/:id/methods`, `GET /v1/merchant` | `methods` list the `oneclick` row too when the node runs the any-chain checkout |
| `GET /v1/payments/:id` | Adds `intents: { mode, label, quotes: IntentsQuote[] }`, null when the payment has no quote; merchant quotes carry the full `refund_to` and `quote_response`, the whole signed 1Click answer, for disputes |
| `GET /v1/payments` | Each item (`PaymentListItem`) adds `intents`, an `IntentsSummary` of its confirmed quote, else its newest one: `{ mode, label, status, origin: { asset, chain, chain_name, symbol } }`, so a list can say "Any chain - USDC on Base"; null for a payment with no quote and on a node with the rail off |
| `GET /v1/platform/intents` | `IntentsPlatformStatus`: mode, base URL, whether an API key is set, which manager key checks quotes, the last 1Click call, the rate limit left and quote counts by state (`platform.read`) |

The proof is a NEP-413 `signMessage` of `intentsPayoutProofRequest(merchantId, account, timestamp, { settlementNetwork, hub })` from `@payminto/protocol`, signed by the account itself within 10 minutes.
The message reads `Payminto intents payout <merchant id> <account> <timestamp> network <settlement network> hub <hub>`, with the hub as the recipient.
`settlementNetwork` and `hub` are in `IntentsPayout.proof_scope`.
`IntentsPayout`:

```json
{
  "object": "intents_payout",
  "mode": "simulated",
  "label": "Simulated - no real money",
  "settlement_network": "near:mainnet (simulated)",
  "account": "anychain.test.near",
  "verified": false,
  "checks": { "exists": true, "usdc_registered": false, "proven": true, "proven_at": "2026-11-10T22:01:12.044Z" },
  "usdc": { "contract": "usdc.test.near", "asset_id": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "decimals": 6 },
  "storage_step": {
    "why": "anychain.test.near is not registered with USDC yet, so a delivery to it would fail. Send this storage_deposit from anychain.test.near (it costs 0.00125 NEAR, once).",
    "deposit_near": "0.00125",
    "transaction": { "receiverId": "usdc.test.near", "actions": [{ "type": "FunctionCall", "params": { "methodName": "storage_deposit", "args": { "account_id": "anychain.test.near", "registration_only": true }, "gas": "30000000000000", "deposit": "1250000000000000000000" } }] }
  },
  "enabled": false,
  "proof_scope": { "settlement_network": "near:mainnet (simulated)", "hub": "hub.test.near" },
  "checked_at": "2026-11-10T22:01:12.101Z"
}
```

`storage_step` is the one human step when the account is not registered with USDC; the account sends it from its own wallet, and the next `GET` sees it.

`GET /v1/links/public/:slug` adds `intents` (`PublicLinkIntents`), null when the rail is off: `{ "mode", "label", "offered", "reason" }`.
`offered` is true when the business has `oneclick` on with a verified account, is active, and the link's fixed amount carries no platform fee; `reason` says why not in plain words.
Each payment made from the link still checks its own expiry window, so a page says "Any chain" only when `offered` is true.

`GET /v1/checkout/:id/proof` proves a credit paid from another chain with an `IntentsProofCredit` (method `oneclick`), never a hub record or a Merkle proof:

```json
{
  "method": "oneclick",
  "amount": "1500000",
  "payer": "base:0x5f2b...554f",
  "quote_id": "iq_ccbq7ktq3ypx2m3l3wmbqcbb",
  "mode": "live",
  "label": "Live - NEAR mainnet",
  "settlement_network": "near:mainnet",
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "recipient": "northwind-usdc.near",
  "origin": { "asset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "chain": "base", "chain_name": "Base", "symbol": "USDC", "decimals": 6 },
  "deposited": { "amount": "1501678", "formatted": "1.501678", "symbol": "USDC" },
  "origin_txs": [{ "hash": "0x...", "explorer_url": "https://basescan.org/tx/0x..." }],
  "delivery_tx": { "hash": "4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q", "explorer_url": "https://nearblocks.io/txns/4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q" },
  "delivery_senders": ["northwind-usdc.near"],
  "oneclick": { "status": "SUCCESS", "correlation_id": "0f8b2c1e-6a43-4c1b-9d61-3f0c8f0d2a77", "deposit_address": "0x8715...dc05", "read_at": "2026-11-14T10:05:00.000Z" },
  "verification": "rpc_checked",
  "delivered_on_chain": "1500000",
  "verified": true
}
```

The node reads the delivery transaction again when asked: `delivered_on_chain` is what its NEP-141 `ft_transfer` events of `token` paid `recipient`, and `verified` is true when that is at least `amount`, false when it is less, and null when the transaction could not be read.
`oneclick` is 1Click's status as the node last read it, kept beside the evidence and never counted as evidence.
`delivery_senders` are the accounts NEAR RPC can find the transaction under (`INTENTS_DELIVERY_SENDERS`, then the recipient), so a browser can read it again; the dashboard's proof page does, from NEAR mainnet when live.
The top-level `network`, `hub` and `token` of the proof stay the node's own.

Webhooks: `payment.processing`, `payment.paid`, `payment.overpaid` and `payment.expired` come as for any payment.
`payment.deposit_returned` (1Click returned a deposit) and `payment.deposit_failed` (the swap failed; also sent to platform alert endpoints) are new; their object is the payment with `intents` and `deposit`, the quote they are about (`IntentsDepositEvent`).
Subscribe to them like any other event.

Reconciliation: an any-chain payment is one row with `method` `oneclick`, `payer` the buyer's refund address prefixed by its chain (`base:0x...`), `currency` `USDC (NEAR mainnet)`, and four columns at the end of the CSV: `settlement_network`, `origin_asset`, `origin_amount` and `deposit_address`.
Its `transactions` have a `leg`: `origin_deposit` (the buyer's deposit, in the origin token's units) and `near_delivery` (the credit, in USDC).
The buyer bears the swap cost, so `fee_total` is 0 and `net_amount` equals the amount.

`packages/near-addons/README.md` section 1 has the 1Click side: the quote checks, the fake server and the `quote-in` command.

### Hosted business agents

These routes exist when the gateway is on and `AGENTS_ENABLED` is true; see [AGENTS.md](AGENTS.md).

| Method and path | Does |
|---|---|
| `GET /v1/ai/providers` | Supported model providers |
| `GET /v1/ai/connections`, `POST /v1/ai/connections`, `GET /v1/ai/connections/:id`, `PATCH /v1/ai/connections/:id`, `DELETE /v1/ai/connections/:id` | A business's own model keys, never returned |
| `POST /v1/ai/connections/:id/verify`, `GET /v1/ai/connections/:id/models`, `GET /v1/ai/usage` | Check a key, list models, token usage |
| `GET /v1/agents`, `POST /v1/agents`, `GET /v1/agents/:id`, `PATCH /v1/agents/:id`, `DELETE /v1/agents/:id` | Agents of kind `ops` or `skill` |
| `POST /v1/agents/:id/runs`, `GET /v1/agent-runs`, `GET /v1/agent-runs/:id`, `GET /v1/agent-runs/:id/events`, `POST /v1/agent-runs/:id/cancel` | Runs; `?wait=` long-polls up to 30 seconds |
| `POST /v1/skills/:slug`, `GET /v1/skills/:slug/runs/:id` | A paid skill behind the paywall, and its result |

The supported model providers are `anthropic`, `openai`, `google`, `openai_compatible`, `replicate` and `nearai` (NEAR AI Cloud).
For a `nearai` connection, each model step of a run carries `attestation`: what the enclave attestation of that turn showed, as a status (`verified`, `partially_verified` or `failed`), a summary, the request and response hashes and the signer.
With the default settings the status is `partially_verified` at best; `packages/models/README.md` says what is and is not checked.

## Webhooks

An endpoint is a URL, a list of event types and a secret.

| Method and path | Does |
|---|---|
| `POST /v1/webhooks`, `GET /v1/webhooks`, `GET /v1/webhooks/:id`, `PATCH /v1/webhooks/:id`, `DELETE /v1/webhooks/:id` | Manage a business's endpoints; body `{ url, events, description? }` |
| `GET /v1/webhooks/:id/secret`, `POST /v1/webhooks/:id/rotate-secret` | Reveal or rotate the secret |
| `POST /v1/webhooks/:id/test` | Sends a `ping` event |
| `GET /v1/webhooks/:id/deliveries`, `POST /v1/webhook-deliveries/:id/retry` | Delivery attempts, and a manual retry |
| The same routes under `/v1/platform/webhooks` and `/v1/platform/webhook-deliveries` | Platform alert endpoints, which have no business |

Webhook routes are part of the gateway, so `budget.refused` webhooks need the gateway on.

| Endpoint kind | Events it can subscribe to |
|---|---|
| Business | `payment.created`, `payment.processing`, `payment.partially_paid`, `payment.paid`, `payment.overpaid`, `payment.underpaid`, `payment.expired`, `payment.canceled`, `payment.deposit_returned` and `payment.deposit_failed` (any-chain checkout), `refund.succeeded`, `refund.failed`, `budget.refused` (refusals of payments to this business), `merchant.payout_changed`, `agent_run.succeeded`, `agent_run.failed`, `agent_run.cancelled`, `agent_run.timed_out`, or `*` |
| Platform | `budget.refused` (every refusal on this node), `payment.deposit_failed` (any-chain swaps that failed), or `*` |

A real `budget.refused` delivery.
The request headers:

```text
content-type: application/json
user-agent: Payminto-Webhooks/1.0
payminto-signature: t=1794283843,v1=f806bc4c15e837197df44c3537f799dc140ed2310ece66adb96180ab98511a37
payminto-event-id: evt_pm3syflmoopvcp2icoahidtk
payminto-event-type: budget.refused
```

The body:

```json
{
  "id": "evt_pm3syflmoopvcp2icoahidtk",
  "type": "budget.refused",
  "created": 1794283843,
  "livemode": false,
  "data": {
    "object": {
      "id": "dny_88db03c44ca7a040",
      "object": "refusal",
      "rule": "NET_EXPOSURE",
      "message": "Unsettled spending of this Budget would exceed its escrow",
      "budget_id": "7b24ab4fb324f08428958567dab9b0ea4fb75261cb3bd718ca77a698e1c1b9bb",
      "owner": "bob.testnet",
      "agent": "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
      "payee": "seller.testnet",
      "provider_id": "prv_48b0b3d5c4e0",
      "attempted_amount": "1000",
      "remaining_budget": "99999000",
      "retry": { "kind": "fund", "shortBy": "1000" },
      "request_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cumulative": "2000",
      "created_at": "2026-11-10T04:10:43.001Z"
    }
  }
}
```

For payment events `data.object` is the payment, in the shape `POST /v1/payments` returns; for refund events it is the refund.

### Checking the signature

`Payminto-Signature` is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 with the whole secret string (including `whsec_`) as the key, over `<t>.<raw body>`.
Check it against the exact bytes received, never against re-serialized JSON, and refuse a timestamp more than 300 seconds from now.

```ts
import { constructEvent, WEBHOOK_SIGNATURE_HEADER } from "@payminto/sdk";

export async function handle(req: Request): Promise<Response> {
  const raw = await req.text();
  try {
    const event = await constructEvent(raw, req.headers.get(WEBHOOK_SIGNATURE_HEADER), process.env.WEBHOOK_SECRET!);
    if (event.type === "budget.refused") console.log(event.data.object.rule, event.data.object.retry);
    return new Response("ok");
  } catch {
    return new Response("bad signature", { status: 400 });
  }
}
```

`constructEvent` throws `WebhookSignatureError` for a missing header, a wrong signature or a stale timestamp.
`verifyWebhook(rawBody, header, secret)` from the same package returns a boolean instead.

### Delivery

- An event and its first delivery attempt are written in the same database transaction as the state change, so an event is never lost between the two.
- A delivery succeeds on any 2xx answer within 10 seconds; redirects are not followed.
- A failed attempt is retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 24 hours.
- An endpoint whose every attempt failed for 3 days is disabled.
- On `near:testnet` a webhook URL must be https and resolve to public addresses only.
- Identical refusals within `DENIAL_DEDUP_SEC` fold into one record, and only a new record sends a webhook.
- Deliveries can arrive more than once and out of order; use `Payminto-Event-Id` to deduplicate.

## Live events

`GET /v1/events` is a server-sent event stream for the dashboard.
It needs a platform role with `agents.read`; `EventSource` cannot send headers, so the recovery key may be passed as `?token=` while it is active.
`Last-Event-ID` or `?since=` replays from the event log.
The node answers every event stream, this one and the checkout's, with `Cache-Control: no-cache, no-transform`, so a proxy that honors it passes the stream through without compressing or buffering it; [OPERATIONS.md](OPERATIONS.md#event-streams-must-not-be-buffered) says what a proxy in front needs.
Business members and API keys receive only their own business's `agent_run.*` events.

| Event | Payload key |
|---|---|
| `call.accepted` | `call` |
| `call.denied` | `denial` |
| `budget.opened`, `budget.revoked` | `budget` |
| `batch.started`, `batch.submitted`, `batch.confirmed`, `batch.failed` | `batch` |
| `payout.confirmed`, `payout.failed` | `payout` |
| `seller.settled` | A payee settled its own voucher on the hub, and the node booked it |
| `payee.approval_requested` | A call waits for the owner's decision about a payee: `request` and `approveAt`. Sent once per waiting payee |
| `payee.approval_decided` | An owner decided or withdrew a decision: `approval`, and `withdrawn: true` for a withdrawal |
| `operator.alert` | A condition only the operator can resolve: `batch_mismatch`, `seller_settled_uncleared` or `settled_position_behind` |
| `funds.warning` | A Budget whose exposure exceeds its escrow, or a claim dropped before settlement |
| `agent_run.*` | `run` or `step`, with `merchant_id` and `run_id` |

A `batch.failed` event is also sent when a batch becomes `unknown`.

## SDK

`@payminto/sdk` is a workspace package (`packages/sdk`); inside this repository, import it by name.

### Seller: `paywall()`

A seller registers its service once (`POST /v1/providers`), then puts the paywall in front of the route.
This is how the demo's quote service does it (`apps/demo/src/providers.ts`):

```ts
import { Hono } from "hono";
import { paywall, FileVoucherStore } from "@payminto/sdk";

const pay = paywall({
  nodeUrl: "http://localhost:8787",
  providerId: process.env.PROVIDER_ID!,
  apiKey: process.env.PROVIDER_API_KEY!,
  vouchers: new FileVoucherStore("./seller.vouchers.json"),
});

const app = new Hono();
app.get("/v1/quote", pay.hono(), (c) => c.json({ symbol: "NEAR", receipt: c.get("payminto").receipt.callId }));
```

`pay.wrap(handler)` does the same for any fetch-style handler.
The paywall reads the price, payee, hub and token from the node, so the 402 always matches what the node enforces.
It serves only after the node accepted the call.

### Seller vouchers and `settle_own`

The paywall keeps the latest voucher the node accepted for each (hub, Budget, payee), together with the node's acceptance of it, so a seller can settle its own earnings if the node is gone.
The hub takes a voucher through `settle_own` only with that acceptance.
The paywall does not store a voucher whose acceptance does not verify, so the latest voucher that can be settled is never replaced by one that cannot.
Use `FileVoucherStore` to keep them across restarts; the default store is in memory.

```ts
import { parseVoucherExport, settleOwnClaims, settleOwnTxs } from "@payminto/sdk";

const exp = await pay.exportVouchers("seller.testnet");                // the latest voucher per Budget, each with its acceptance
const checked = await parseVoucherExport(exp, chain);                  // checkedAgainst: "hub"
const plan = await settleOwnClaims(checked, "seller.testnet", chain);  // skips what the hub already settled
const txs = settleOwnTxs(exp.hub, plan.claims);                        // for the seller's own wallet to sign
for (const u of plan.unsettleable) console.warn(u.voucher.callId, u.reason);
```

`chain` is a reader of the hub, for example a `NearRpcChain` with no operator key.
`txs` are wallet transactions for the seller's own wallet to sign.

| Helper | What it checks |
|---|---|
| `parseVoucherExport(exp, chain)` | Every voucher against its Budget's agent key on the hub, and every acceptance against the receipt keys the Budget's settler registered there; the result says `checkedAgainst: "hub"`. Without a reader it can only check each signature against the key the export itself names, which anyone can forge, and the result says `checkedAgainst: "declared-keys"` |
| `settleOwnClaims(checked, payee, chain)` | Returns `claims`, each with its acceptance, and `unsettleable`: every voucher the hub would refuse, with the reason (no acceptance, an acceptance dated after the Budget's revoke or expiry, a payee that is the Budget's owner, or a closed Budget) |
| `settleOwnTxs(hub, claims)` | One `settle_own({ claim, acceptance })` transaction per claim |

One voucher of an export, from the `pnpm demo` run for this page (`format` is `payminto.vouchers.v2`; the parser still reads `payminto.vouchers.v1`, whose vouchers carry no acceptance and so cannot be settled by the seller):

```json
{
  "budgetId": "0547df791e3407f0f50de6bc5e2e0dca65e7327f47747425a0f2629a332b3b0e",
  "payee": "scan.testnet",
  "amount": "5000",
  "cumulative": "100000",
  "requestHash": "4ab19f2659a09d948a8c5799a130b5ce4bea16548d7d4e770de624e6236ad008",
  "publicKey": "ed25519:BCHDSPCcoDG3TXhuxmthUzwtxDCVZVGyZhpbd65KwkSr",
  "signature": "491907d1e5d04c303fdf7b3dcec9b4c77f06af672eb50049e85dde275a248fbc2f9e3582652938ba02a124cd0c882771b4361d1ba82dd3540ea9dfa1f92bc20c",
  "hub": "hub.demo.testnet",
  "network": "near:sandbox",
  "callId": "fed5cf2dadc658fdfd8579c96d53fdbc1a8ed967870010144eda0bb47df3743d",
  "acceptedAt": "2026-11-10T07:21:40.000Z",
  "acceptance": {
    "nodeKey": "ed25519:DmmPSvVGc3dQ17zpowXBwLztpUdTzKjh445mHMkBFspy",
    "timestampS": "1794295300",
    "signature": "8ea27fa8175856334cc5af443bda80a85628a91903a7e24af22fe6cd51f3996f3e6f5a3c4de9500cf5d259fc715e1dd1a4d804c0d100182b925eaa89e1469002"
  }
}
```

The export itself is `{ format, hub, network, exportedAt, vouchers }`.
`acceptance.nodeKey` is the receipt key that signed, `timestampS` is Unix seconds as a decimal string, and `signature` is the `nodeSignature` of the receipt.

`settle_own` takes two arguments, which `settleOwnTx` in `packages/chain/src/actions.ts` builds from a claim and its acceptance:

```json
{
  "claim": { "budget_id": "<64 hex>", "payee": "scan.testnet", "amount": "5000", "cumulative": "100000", "request_hash": "<64 hex>", "signature": "<128 hex, the agent's>" },
  "acceptance": { "node_key": "<64 hex, the receipt key>", "timestamp_s": "1794295300", "signature": "<128 hex, the node's>" }
}
```

This block shows the argument names with placeholders; it is not a captured call.
The hub refuses a caller that is not the payee (`NOT_PAYEE`), a payee that is the Budget's owner (`PAYEE_IS_OWNER`), an acceptance from a key the Budget's settler did not register (`ACCEPTANCE_KEY_UNKNOWN`), an acceptance that does not cover this claim (`BAD_ACCEPTANCE`), and an acceptance dated after the Budget's revoke or expiry (`ACCEPTANCE_TOO_LATE`).

### Agent: `AgentClient`

```ts
import { AgentClient, readAgentKeyFile } from "@payminto/sdk";

const agent = new AgentClient({
  network: "near:testnet",
  hub: "hub.example.testnet",
  nodeUrl: "http://localhost:8787",
  keypair: readAgentKeyFile("/home/me/.payminto/agent/agent-key.json"),
  budgetId: process.env.BUDGET_ID!,
  storePath: "./agent-receipts.db",
});

agent.on("denied", (d) => console.log(d.code, d.refusal?.retry));
const res = await agent.fetch("https://seller.example/v1/quote?symbol=NEAR");
```

`agent.fetch` behaves like `fetch`, pays a `payminto-voucher` 402 from the Budget, and returns the seller's response.
A refusal returns a 402 whose body has `success: false`, `errorReason` and `refusal`.
The client fetches the Budget policy from its node, checks that it hashes to its Budget id, and applies it before signing.
It never takes a node URL, a position or a receipt key from a seller.

`agent.pay(url, init, { maxPrice })` is `fetch` plus the answer to "what did this cost":

```ts
const { response, payment } = await agent.pay(url, init, { maxPrice: 5_000n });
payment.status; // "none" | "paid" | "unverified"
payment.paid; // bigint, booked on this agent's node
payment.unverified; // bigint, sent with an unknown outcome
payment.refusal; // { source: "agent" | "seller", code, message, refusal, sellerCode, sellerText } or null
```

| Rule of the client | Detail |
|---|---|
| A position advances only on a receipt the node signed | After anything else (a receipt that does not verify, an error, a refusal, a stale answer, a request that died) the agent asks its own node what became of each voucher, by call id |
| Open vouchers count as spend | Every signed voucher whose outcome is open counts in the hourly and daily windows and in the repeat limit until the node resolves it |
| An empty payee list pays nobody | The agent refuses every payee under a Budget that allows any payee, unless it was built with `allowAnyPayee: true` |
| A relayed refusal is the seller's word | A `denied` event has `source: "seller"` for a refusal a seller's 402 relayed; only a known rule code is kept, and any other becomes `SELLER_REFUSED` |

`packages/sdk/README.md` explains each guard.

#### `beforeSign`: your own check before anything is signed

`beforeSign` is an optional hook the client asks about every payee of an offer before it signs any voucher of that offer.
The MCP wallet's payee check is this hook.

```ts
import { AgentClient, type BeforeSign } from "@payminto/sdk";

const beforeSign: BeforeSign = async ({ payer, payee, amount, total, budgetPayees, requirement, url, budgetId }) => {
  if (await looksWrong(payee)) {
    return { rule: "PAYEE_BLOCKED", message: `${payee} failed my check`, retry: { kind: "never" } };
  }
  return null; // go on: the client applies its own rules and signs
};

const agent = new AgentClient({ /* as above */ beforeSign });
```

| Field | What it is |
|---|---|
| `payer` | The Budget's owner, from the terms the client verified against the Budget id |
| `payee`, `amount` | This payee and its part of the offer, in atomic units |
| `total` | The whole offer, every payee together; a refusal reports it as the attempted amount |
| `budgetPayees` | The Budget's allowed payees, from the verified terms; empty means any payee |
| `requirement` | The requirement the client accepted from the seller's 402 |
| `url`, `budgetId` | The request and the Budget |

- It runs after the client's maximum price and before the Budget rules, and before the payees are locked, so a hook that waits for a person holds up no other call.
- It returns null (or nothing) to go on, or `{ rule, message, retry, details? }` to refuse.
  A refusal becomes the client's own structured refusal with `source: "agent"` and `enforcedBy: "agent"`, and no voucher leaves the process.
- A hook that throws refuses the call with `CLIENT_CHECK_FAILED` and a retry after 30 seconds: it fails closed.
- `looksWrong` above stands for your own code; the types are `BeforeSign`, `BeforeSignRequest` and `BeforeSignRefusal`, exported from `@payminto/sdk`.

### Owner: `OwnerClient`

`OwnerClient` builds Budget terms and wallet transactions, and never signs anything.

```ts
import { OwnerClient } from "@payminto/sdk";

const owner = new OwnerClient({ nodeUrl, network: "near:testnet", hub, token, owner: "acme.testnet", settler, adminToken });
const policy = { perCallCap: "5000", dailyCap: "5000000", maxCallsPerMinute: 0, purpose: "research agent" };
const { terms, budgetId } = owner.createBudget({ agentPk, cap: 5_000_000n, validForSeconds: 12 * 3600, payees: ["globex.testnet"], policy });

const open = owner.openTx(terms);                  // the owner's wallet signs: open_budget
const fund = owner.depositTx(budgetId, 2_000_000n); // the owner's wallet signs: ft_transfer_call
await owner.submit({ terms, policy, label: "research agent" }); // after both are final: POST /v1/budgets
```

`settler` is `operator` from `GET /v1/info`.
`revokeTx` and `reclaimTx` build the other two owner transactions, and `fundFromCreditTx` in `@payminto/chain` builds `fund_from_credit`.
`openTx` attaches 0.1 NEAR for storage by default, and the hub refunds the excess.

### Merchant: `GatewayClient`

`GatewayClient` wraps the gateway routes of the node on NEAR: payments, links, refunds, webhooks, the merchant profile, screening, the reconciliation report and the public directory with a business API key, and merchants, fee plans and the platform with the operator's token.
Its types are the NEAR shapes in `@payminto/protocol`: accounts are NEAR account ids, and the payment methods are `wallet` and `voucher`.
`signPayoutProof(signer, merchantIdOrNew, scope)` builds the NEP-413 payout proof, with `scope` from `client.payoutScope()`.
The merchant tools in `packages/sdk/src/merchant-tools.ts`, which the merchant MCP server serves, act through this client.
`packages/sdk/README.md` has the example.

## MCP

`apps/mcp` gives any MCP client a wallet bound to one Budget.

| Tool | Spends | Does |
|---|---|---|
| `list_paid_services` | no | The node's service directory, or its provider catalog |
| `call_paid_service` | yes | Calls a service and pays its 402 from the Budget |
| `pay_link` | yes | Pays a gateway payment link with vouchers |
| `get_budget` | no | Cap, spent, remaining, limits, expiry, payees, and escrow when the chain is readable |
| `get_receipts` | no | Receipts this wallet holds, newest first |
| `prove_receipt` | no | Proves a call against the root the hub stores |
| `check_payee` | no | The wallet's own verdict about a NEAR account before paying it: allow, warn or block, with the reasons |
| `quote_market_agent` | no | Asks an agent on the NEAR AI Agent Market for its price and checks it against the wallet's limits and the payee check. It quotes and decides only: nothing here pays the market |

No tool signs a NEAR transaction, and no tool approves a payee.

The wallet checks every payee by default, through the SDK's `beforeSign` hook.
Used as a library (`AgentWallet` in `apps/mcp/src/wallet.ts`), a wallet built without a `payeeCheck` still checks payees, read-only, against the public RPC of its node's network, with NearBlocks on testnet and no indexer elsewhere.
`signWithoutPayeeCheck: true` is the explicit opt-out; the node's own check still applies, and the option cannot be combined with `payeeCheck`.
The server (`main.ts`) opts out only when `PAYEE_CHECK=off` or `CHAIN_READER=off` is set.

| Setting | Variable | Default |
|---|---|---|
| The node and the Budget | `NODE_URL`, `BUDGET_ID` | required |
| The agent key file | `AGENT_KEY_FILE` | `$PAYMINTO_DATA_DIR/agent/agent-key.json` |
| Highest price per call | `MAX_PRICE_ATOMIC` | The Budget's per-call cap |
| Hosts the wallet may pay besides the node's directory | `PAYABLE_HOSTS` | unset: only what the directory lists |
| Paying under a Budget with an empty payee list | `ALLOW_ANY_PAYEE` | `0`: the wallet refuses to start with such a Budget |
| The wallet's own payee check before signing | `PAYEE_CHECK`, `PAYEE_CHECK_INDEXER`, `PAYEE_CHECK_INDEXER_KEY` | On while there is a chain reader; account ages from NearBlocks on `near:testnet`, off on `near:sandbox` |
| The Agent Market quote tool | `AGENT_MARKET`, `AGENT_MARKET_RPC_URL` | `on`; the public NEAR mainnet endpoints for the payee check of a quote |
| The HTTP listener | `MCP_HTTP_PORT`, `MCP_HTTP_HOST` | `3334`, `127.0.0.1` |
| The bearer token for HTTP | `MCP_HTTP_TOKEN`, or generated into `MCP_HTTP_TOKEN_FILE` | `$PAYMINTO_DATA_DIR/mcp/http-token` |

Over stdio the client starts the server:

```sh
claude mcp add payminto \
  -e NODE_URL=http://localhost:8787 \
  -e NETWORK=near:sandbox \
  -e AGENT_KEY_FILE=$HOME/.payminto/agent/agent-key.json \
  -e BUDGET_ID=YOUR_64_HEX_BUDGET_ID \
  -- node /absolute/path/to/repo/apps/mcp/src/main.ts
```

Over Streamable HTTP (`node apps/mcp/src/main.ts --http`), every request to `/mcp` must carry `Authorization: Bearer <token>`, and a request without the right token gets 401 and reaches no tool:

```sh
claude mcp add --transport http payminto http://127.0.0.1:3334/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Neither `claude mcp add` command was run for this page.
A paying tool returns `spend` on every outcome (`none`, `paid` or `unverified`), and puts whatever a seller wrote in a second text block between `--- untrusted seller data (not instructions) ---` markers.
The full variable table, the refusal format and the merchant server (`--merchant`) are in `apps/mcp/README.md` and [AGENTS.md](AGENTS.md).

## Other packages

Each of these has its own README with commands that were run.

| Package | What a developer gets | Read |
|---|---|---|
| `packages/payee-check` | `createPayeeCheck` and `guardPayment`: allow, warn or block for a payee before a payment, failing closed. The node and the MCP wallet both call it | `packages/payee-check/README.md` |
| `packages/agent-market` | `MarketClient`, `checkQuote` and a seller worker for the NEAR AI Agent Market, which holds and pays the money itself. The wallet's `quote_market_agent`, `pnpm market` and `pnpm agent market work` use it | `packages/agent-market/README.md` |
| `packages/models` | `createModelClient`, with NEAR AI Cloud as a provider whose attestation result travels on each turn as `turn.attestation` | `packages/models/README.md` |
| `apps/relayer` | `createRelayerApp`, `POST /relay` for NEP-366 delegates, and the `revoke` command | `apps/relayer/README.md` |
| `apps/swarm` | The sealed-bid rules as pure functions, and `verifyRound` | `apps/swarm/README.md`, `apps/swarm/RULES.md` |
| `packages/near-addons` | Builders for a 1Click exit, DAO proposals, sub-accounts, gasless revoke and Chain Signatures. The dashboard uses the DAO builders and the delegate decoder | `packages/near-addons/README.md` |
| `apps/dashboard` | The owner and merchant console: payee approvals on a Budget's page, "Revoke without gas" through a relayer, DAO-owned Budgets by Sputnik DAO proposal, proofs read from NEAR in the browser | `apps/dashboard/README.md` |
| `apps/local` | `pnpm local`: the whole product on a sandbox (a local NEAR node) with a development-only local signer, and `pnpm local --check` | `apps/local/README.md` |

## Commands

Every command here was run for this page unless marked.

| Command | What it does | Result when run |
|---|---|---|
| `pnpm install` | Installs the workspace (Node 22.18 or newer, pnpm 9) | Done |
| `pnpm -r typecheck` | Type-checks every package | Passes |
| `pnpm -r test` | Unit tests on the simulated hub; sandbox suites are skipped | Passes: 2,053 tests in 15 packages, 15 sandbox tests skipped |
| `cd contracts-near && cargo test --lib` | The contract's unit tests, with no sandbox | Passes: 87 tests |
| `pnpm demo` | The whole story on the simulated hub | `25 of 25 checks passed in 4.1 s.` |
| `pnpm demo --chain sandbox` | The same on a sandbox (a local NEAR node) | `26 of 26 checks passed in 97.2 s.` |
| `pnpm local` | The whole product on a sandbox, with the dashboard and local test accounts, until Ctrl-C | Run on spare ports: `Ready in 107.5 s.`; Ctrl-C stopped everything with exit code 130 |
| `pnpm local --check` | The same stack, the browser guide as a script, checked against the chain | `24 of 24 checks passed in 194.5 s.` |
| `pnpm local --intents live --intents-payout <account>` | LIVE - real money: the any-chain checkout on the real 1Click API and NEAR mainnet, everything else local (docs/LIVE_RUN.md) | Run only far enough to print the banner, then stopped; without `--intents-payout` it refuses with exit code 2 |
| `pnpm live:capture <payment id>` | Saves a live run's quote, 1Click status and NEAR delivery transaction as a dated fixture | Unit-tested with a fake node, 1Click and RPC; not run live |
| `pnpm verify:near --rpc-url <url> --hub <account> --receipt <file>` | Checks a receipt with no node and no keys | Run by the sandbox demo as its own process, on this commit too: `VERIFIED: 8 checks passed` for the receipt, `NOT VERIFIED: 3 check(s) failed` for the tampered copy |
| `pnpm swarm` | 20 buyers and 5 sellers on the simulated hub | `17 of 17 checks passed.` in 4.7 s |
| `pnpm agent market work --dry-run` | The Agent Market seller flow with no market account: four paid calls on an in-process node on the simulated hub, and a deliverable with their receipts | Exit code 0; 4 receipts, each `VERIFIED` in process |
| `pnpm market quote <handle> --max 0.10` | A live, read-only quote from the Agent Market, checked against a limit | `Decision   REFUSE by rule PER_HIRE_MAX`, exit code 3 |
| `pnpm swarm verify apps/swarm/data/last-run/round-1.json` | Re-checks a round from its signed messages | `VERIFIED: 8 of 8 checks passed.` |
| `node packages/chain/scripts/deploy-hub.ts ... --dry-run` | Prints every deploy transaction and signs nothing | Run with placeholder accounts; every step `planned` |
| `pnpm --filter @payminto/relayer dev:fake` | The relayer over an in-memory chain | Run, with the curl calls in `apps/relayer/README.md` |
| `pnpm agent keygen --out <path>` | Writes an agent key file with mode 0600 and prints the public key | Run against a scratch path; a second run on the same path refused with exit code 2 |
| `cd contracts-near && cargo test` | The contract's unit tests and its sandbox tests | Only `--lib` was run for this page |
| `pnpm --filter @payminto/chain test:sandbox`, `pnpm --filter @payminto/demo test:sandbox` | Sandbox suites | Not run for this page |
