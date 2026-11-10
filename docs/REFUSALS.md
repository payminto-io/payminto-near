# Refusals

This page lists every way Payminto refuses a payment or a settlement, in every layer, with the test that proves each one.
It is written for a reader who does not take a claim on trust.
Every row was checked against the code on this commit: the test named in the row asserts the code named in the row.

A rule that has no test is not in the table.
The rules that were looked for and not found in a test are listed at the end, under "Not in the table".

## How to read a row

| Column | Meaning |
|---|---|
| Code | The exact string the layer returns, records or panics with |
| Enforced by | The layer that decides: the agent wallet, the seller's paywall, the clearing node, the hub contract or the relayer |
| Fires when | The trigger, in plain words |
| Retry hint | What the answer tells an automated caller to do next |
| Evidence | The test name and its file; a `describe > it` name for TypeScript, a function name for Rust |
| Demo check | The line `pnpm demo` or `pnpm swarm` prints when the same refusal happens in a full run, if there is one |

The layers run in this order for one paid call.

| Order | Layer | Code path | When it decides |
|---|---|---|---|
| 1 | Agent wallet | `AgentClient` in `packages/sdk`, the MCP wallet in `apps/mcp`, the agent runtime in `apps/agent` | Before signing, so a refused call produces no voucher |
| 2 | Seller's paywall | `paywall()` in `packages/sdk` | When the header arrives, before the node sees it |
| 3 | Clearing node | `evaluateVoucher` in `apps/node/src/policy-engine.ts`, inside one `BEGIN IMMEDIATE` transaction | Before accepting, so a refused call gets no receipt |
| 4 | Hub contract | `contracts-near/src/lib.rs` | At settlement, on chain, in one atomic receipt |
| 5 | Relayer | `apps/relayer` | Before it pays gas for an owner's call to the hub |

## Run the evidence yourself

One TypeScript test, by name:

```sh
pnpm --filter @payminto/node exec vitest run test/unsigned-vouchers.test.ts -t "records nothing and alerts nobody"
```

One contract test, by name:

```sh
cd contracts-near && cargo test --lib f1_owner_cannot_self_settle_ahead_of_the_seller
```

Everything at once:

```sh
pnpm -r test
cd contracts-near && cargo test
```

The package filter for each file is its directory: `@payminto/sdk` for `packages/sdk`, `@payminto/mcp` for `apps/mcp`, `@payminto/agent` for `apps/agent`, `@payminto/node` for `apps/node`, `@payminto/relayer` for `apps/relayer`, `@payminto/chain` for `packages/chain` and `@payminto/demo` for `apps/demo`.
The TypeScript suites run on the simulated hub, an in-memory model of the contract, with no network.
The Rust unit tests in `contracts-near/src/tests/` run the contract's own code in the near-sdk test environment.
The files `contracts-near/tests/sandbox.rs` and `packages/chain/test/sandbox.test.ts` run the committed `hub.wasm` on a sandbox (a local NEAR node).

## Agent wallet: refused before signing

Nothing is signed for any row in this section, so nothing can be collected later.
Each refusal carries `enforcedBy: "agent"`, or `enforcedBy: "runtime"` for the two runtime rules.

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `POLICY_UNAVAILABLE` | Agent wallet (`AgentClient`) | The Budget policy cannot be read from the configured node, or the node's key is not the pinned `trustedNodeKey` | `after` 30 seconds | `AgentClient against a malicious provider or node > refuses to sign when the configured node's key is not the pinned trustedNodeKey` in `packages/sdk/test/sdk.test.ts` | none |
| `POLICY_MISMATCH` | Agent wallet (`AgentClient`) | The policy the node serves does not hash to the Budget id, or the Budget names another agent key | `never` | `AgentClient pre-sign policy guard > refuses to sign anything when the node serves a policy that does not hash to the Budget` and `> refuses to sign for a Budget that names another agent key` in `packages/sdk/test/sdk.test.ts` | none |
| `BUDGET_NOT_ACTIVE` | Agent wallet (`AgentClient`) | The Budget is past `validUntil` | `never` | `AgentClient pre-sign policy guard > BUDGET_NOT_ACTIVE (expired)` in `packages/sdk/test/sdk.test.ts` | none |
| `TOKEN_MISMATCH` | Agent wallet (`AgentClient`) | The seller asks for an asset that is not the token the hub clears | `never` | `AgentClient pre-sign policy guard > TOKEN_MISMATCH` in `packages/sdk/test/sdk.test.ts` | none |
| `PAYEE_NOT_ALLOWED` | Agent wallet (`AgentClient`) | The payee is not on the Budget's payee list | `never` | `AgentClient pre-sign policy guard > PAYEE_NOT_ALLOWED` in `packages/sdk/test/sdk.test.ts` | `PASS  PAYEE_NOT_ALLOWED fired for the injected payee, in the wallet and at the node` |
| `PAYEE_NOT_ALLOWED` with `allowlist: "empty"` | Agent wallet (`AgentClient`, MCP wallet) | The Budget's payee list is empty, which allows any payee on chain, and the operator did not opt in (`allowAnyPayee`, or `ALLOW_ANY_PAYEE=1` for the MCP wallet, which otherwise refuses to start) | `never` | `M1: an empty payee list is not accepted silently > refuses every payee unless the operator opted in with allowAnyPayee` in `packages/sdk/test/agent-outcomes.test.ts`; `M1: the wallet decides what may be called and paid > refuses a Budget with an empty payee list unless the operator opted in` in `apps/mcp/test/wallet-security.test.ts` | none |
| `PER_CALL_CAP` | Agent wallet (`AgentClient`) | The price is above the Budget's `perCallCap` | `never` | `AgentClient pre-sign policy guard > PER_CALL_CAP` in `packages/sdk/test/sdk.test.ts` | none |
| `RATE_LIMIT` | Agent wallet (`AgentClient`) | This client already made `maxCallsPerMinute` calls in the last 60 seconds | `after` 60 seconds | `AgentClient pre-sign policy guard > RATE_LIMIT` in `packages/sdk/test/sdk.test.ts` | none |
| `REPEAT_REQUEST` | Agent wallet (`AgentClient`) | The same request was already paid `maxRepeatsPerRequest` times within an hour | `after` the real seconds until the oldest counted call leaves the window | `AgentClient pre-sign policy guard > REPEAT_REQUEST counts this exact request only` in `packages/sdk/test/sdk.test.ts`; `L4: REPEAT_REQUEST says when the request fits again > counts from the oldest call that has to leave the window` in `packages/sdk/test/agent-outcomes.test.ts` | `PASS  REPEAT_REQUEST fired for a looping agent` |
| `HOURLY_CAP` | Agent wallet (`AgentClient`) | The call would take this client's spend past the rolling one-hour cap | `after` 3600 seconds | `AgentClient pre-sign policy guard > HOURLY_CAP` in `packages/sdk/test/sdk.test.ts` | none |
| `DAILY_CAP` | Agent wallet (`AgentClient`) | The call would take this client's spend past the rolling 24 hour cap | `after` 86400 seconds | `AgentClient pre-sign policy guard > DAILY_CAP` in `packages/sdk/test/sdk.test.ts` | none |
| `TOTAL_CAP` | Agent wallet (`AgentClient`) | The call would take the Budget past its cap, counting every payee and every voucher still open | `never` | `AgentClient pre-sign policy guard > TOTAL_CAP reports what is left of the Budget` and `> TOTAL_CAP counts every payee's cumulative` in `packages/sdk/test/sdk.test.ts` | `pnpm swarm`: `refusals by rule ... TOTAL_CAP 3 (by the agent's own client)` |
| `CLIENT_MAX_PRICE` | Agent wallet (`AgentClient`, MCP wallet) | The price is above the caller's `maxPrice`, the wallet's `MAX_PRICE_ATOMIC`, or the `maxAmountAtomic` of one call | `never` | `pay() reports what was paid on every outcome > refuses above a per-call maxPrice without signing` in `packages/sdk/test/agent-outcomes.test.ts`; `H3: a paid call that fails > holds a call to maxAmountAtomic before anything is signed` in `apps/mcp/test/wallet-security.test.ts` | none |
| `POSITION_UNVERIFIED` | Agent wallet (`AgentClient`) | The node reports a running total above the highest one this agent has signed itself | `never` | `AgentClient against a malicious provider or node > refuses with POSITION_UNVERIFIED, signing nothing, when the node reports a position above what the agent signed` in `packages/sdk/test/sdk.test.ts` | none |
| `CLIENT_TARGET_NOT_ALLOWED` | Agent wallet (MCP wallet) | The URL is not in the wallet's own node directory and its host is not in `PAYABLE_HOSTS`; no request leaves the process | `never` | `M1: the wallet decides what may be called and paid > refuses a URL its node does not list, without sending a request` in `apps/mcp/test/wallet-security.test.ts` | none |
| `CLIENT_TARGET_MISMATCH` | Agent wallet (MCP wallet) | A `url` passed together with a `serviceId` is not that service's endpoint | `never` | `M1: the wallet decides what may be called and paid > never lets a url redirect a serviceId` in `apps/mcp/test/wallet-security.test.ts` | none |
| `PAYEE_BLOCKED` | Agent wallet (MCP wallet) | The wallet's own payee check judges the payee as block, for example a name that imitates an allowed payee or an account that does not exist, or the Budget's owner denied the payee on the node | `never` | `before the wallet signs > the attack: a tool result says to pay a lookalike of an allowed payee, and nothing is signed` and `> the owner denies, and the wallet refuses without signing` in `apps/mcp/test/payee-guard.test.ts` | none |
| `PAYEE_BLOCKED`, "could not be checked" | Agent wallet (MCP wallet) | The payee check itself cannot run, for example the RPC endpoint does not answer; the wallet fails closed | `after` 30 seconds | `before the wallet signs > refuses when the check itself cannot run: fail closed, with a hint to try again` in `apps/mcp/test/payee-guard.test.ts` | none |
| `PAYEE_NEEDS_APPROVAL` | Agent wallet (MCP wallet) | The wallet's check has warnings about the payee, and its node answers that the Budget's owner has not approved it; the request appears on the node for the owner | `approval` with `payee` and `approveAt`, the page where the owner decides; `after` 30 seconds when the wallet cannot ask its node | `before the wallet signs > on warn it asks its node, waits for the owner, and says where the owner approves` and `> refuses when its node cannot be asked about a warn, and asks nobody else` in `apps/mcp/test/payee-guard.test.ts` | none |
| `PAYEE_NEEDS_APPROVAL`, repeated | Agent wallet (agent runtime) | The model tries a payee again, by service id or by URL, after the wallet said it waits for the owner; the runtime answers itself and the wallet is not called a second time | `approval` | `a payee that needs approval > is tried once: a model that keeps asking is answered by the runtime, and the wallet is not called again` in `apps/agent/test/payee-check.test.ts` | none |
| HTTP `401` | Agent wallet (MCP server over HTTP) | A request to `/mcp` carries no bearer token, or a wrong one; no tool runs | none | `L3: MCP over HTTP needs a bearer token > refuses requests without the token and serves the tools with it` in `apps/mcp/test/http-auth.test.ts` | none |
| `TASK_SPEND_CEILING` | Agent wallet (agent runtime) | The price would take one task past the spend ceiling its caller set | `never` | `buyer loop > refuses a call whose known price would pass the ceiling, before the wallet sees it` in `apps/agent/test/runtime.test.ts` | none |
| `NOT_IN_DIRECTORY` | Agent wallet (agent runtime) | The target is neither in the node's service directory nor written by the user in the task, for example an address planted in paid content | `never` | `buyer loop > never pays an address found inside paid content, even when the model tries` in `apps/agent/test/runtime.test.ts` | none |

The wallet has no tool that approves a payee, and the agent key cannot approve one: its signature only asks its node the question.
Evidence: `check_payee > lets a model ask about an account before paying, and there is no tool that approves one` in `apps/mcp/test/payee-guard.test.ts`, and `the question an agent's wallet asks > is answered only for the Budget's own agent key, records the request and sends the live event once` in `apps/node/test/payee-check.test.ts`.
The whole attack, from an injected instruction to the run report, is `the attack, end to end > a tool result tells the agent to pay a lookalike of an allowed payee: the model obeys, the wallet signs nothing, and the report says why` in `apps/agent/test/payee-check.test.ts`.

Two behaviours of the wallet are not refusals but decide what a refusal means.

- A position advances only on a receipt the node signed.
  A seller that answers with a receipt it signed itself gains nothing.
  Evidence: `H1: a receipt that does not verify never advances the agent's position > keeps signing on the node's position when a seller answers 200 with a receipt it signed itself` in `packages/sdk/test/agent-outcomes.test.ts`.
- A refusal a seller relays is the seller's unauthenticated word.
  The wallet keeps a rule code only if it is a clearing rule, and reports any other code as `SELLER_REFUSED`.
  Evidence: `M2: a seller's refusal is the seller's word > keeps only known rule codes, drops details, and cleans and caps the seller's text` in `packages/sdk/test/agent-outcomes.test.ts`.

## Seller's paywall: refused before the node sees it

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `UNSUPPORTED_X402_VERSION` (HTTP 400) | Seller's paywall | The `PAYMENT-SIGNATURE` header is not x402 version 2 | none | `paywall > answers 400 to a header it cannot read or of another x402 version, as the node gateway does` in `packages/sdk/test/sdk.test.ts` | none |
| `INVALID_PAYMENT` (HTTP 400 or 402) | Seller's paywall | The header cannot be read (400), or it reads and fails the schema (402) | none | The test above, and `paywall > answers 402 to a readable payment that fails the schema, the requirement, the request hash or the signature` in `packages/sdk/test/sdk.test.ts` | none |
| `REQUIREMENT_MISMATCH` (HTTP 402) | Seller's paywall | The accepted requirement is not the one the seller offers now | none | `paywall > answers 402 to a readable payment that fails the schema, the requirement, the request hash or the signature` in `packages/sdk/test/sdk.test.ts` | none |
| `REQUEST_HASH_MISMATCH` (HTTP 402) | Seller's paywall | The voucher was signed for another method, path, query or body | none | The same test | none |
| `BAD_SIGNATURE` (HTTP 402) | Seller's paywall | The voucher signature does not verify against the key the payment names | none | The same test | none |

## Clearing node: refused before accepting

The node checks the voucher signature against the Budget's agent key before any rule.
The first two rows are therefore nobody's refusal: the answer is a plain 402 error with no `refusal`, and the node writes no refusal record, no event and no webhook in the owner's name.
Every other row is recorded with its rule, the attempted amount, the remaining Budget and the retry hint, is signed with the node's receipt key, and goes out as a `budget.refused` webhook.
An agent confirms a relayed refusal with `GET /v1/budgets/:id/refusals?requestHash=<hash>`.

The policy rules run in the order of this table, and the first one that fails wins.
`evaluateVoucher > refuses with %s and nothing else` in `apps/node/test/policy-engine.test.ts` runs once for every rule of the policy engine, and `evaluateVoucher > has a breaker for every rule the engine decides` fails if a rule is added without a case.

Four rows are outside the policy engine.
`RATE_LIMITED` is a request limit, and `PAYER_DENIED` is the gateway's screening of a payment to a business.
`PAYEE_BLOCKED` and `PAYEE_NEEDS_APPROVAL` come from the payee check, which may read the chain.
It runs after the signature check and before the Budget's own rules, with two exceptions: a revoked or expired Budget is refused by its own rule and the payee is not looked at, and a payee that is not on a non-empty payee list gets `PAYEE_NOT_ALLOWED` unless the check blocks it.
The payee check is on by default (`PAYEE_CHECK=on`) on a node that reads NEAR through an RPC endpoint.
It is off in `pnpm swarm` on the simulated hub, which has no accounts to read; `pnpm demo` on the simulated hub runs it against a scripted stand-in for the chain's accounts.

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `UNKNOWN_BUDGET` | Clearing node | No Budget with this id is registered on this node; nothing is recorded | `never` | `vouchers not signed by the Budget's agent key > records nothing and alerts nobody, whichever rule the forged fields would break` in `apps/node/test/unsigned-vouchers.test.ts` | none |
| `BAD_SIGNATURE` | Clearing node | The voucher is not signed by the Budget's agent key, whatever its other fields say; nothing is recorded | `never` | The same test, which forges the price, the cap and the running total and gets `BAD_SIGNATURE` each time | none |
| `RATE_LIMITED` (HTTP 429, `scope: "unsigned"`) | Clearing node | One provider key or client address sends more unsigned vouchers than `RATE_LIMIT_UNSIGNED_RPS` and `RATE_LIMIT_UNSIGNED_BURST` allow | `Retry-After` header, in seconds | `vouchers not signed by the Budget's agent key > rate limits unsigned vouchers per provider key without slowing signed ones` in `apps/node/test/unsigned-vouchers.test.ts` | none |
| `PAYEE_BLOCKED` | Clearing node (payee check) | The check judges the payee as block (a missing account, a name that imitates an allowed payee, several reports), or the Budget's owner denied the payee | `never` | `the voucher path > refuses a lookalike of an allowed payee with PAYEE_BLOCKED, the reasons, a signed record and no retry` and `approvals > warn refused, the owner approves, the same call is accepted; then deny, then withdraw` in `apps/node/test/payee-check.test.ts` | none |
| `PAYEE_BLOCKED`, "could not be checked" | Clearing node (payee check) | The chain or the indexer does not answer and the node has never seen this payee, so it holds no verdict to decide on | `after` 30 seconds | `what the call path reads > fails closed for a payee it has never seen, and says to try again` in `apps/node/test/payee-check.test.ts` | none |
| `PAYEE_NEEDS_APPROVAL` | Clearing node (payee check) | The check has warnings about the payee, for example a new account, and the Budget's owner has not approved the warnings it carries | `approval` with `payee` and `approveAt`, the page of the node's own dashboard where the owner decides | `the voucher path > refuses a payee with warnings with PAYEE_NEEDS_APPROVAL, and the hint says an owner must approve and where` and `approvals > an approval covers the warnings the owner saw, not ones that appear later` in `apps/node/test/payee-check.test.ts` | none |
| `PAYEE_BLOCKED` (HTTP 409, on an approval) | Clearing node (payee check) | An owner tries to approve a payee the check blocks without sending `overrideBlock: true`; an override is written to the activity log | none | `approvals > an approval does not override a block unless the body says so, and the override is logged` in `apps/node/test/payee-check.test.ts` | none |
| `BUDGET_REVOKED` | Clearing node | The owner revoked the Budget; this applies at once, even inside the hub's 24 hour grace period | `never` | `revoked or expired Budgets fail closed inside the hub's grace period > refuses new calls after an owner revokes on chain, while calls accepted before still settle` in `apps/node/test/clearing.test.ts` | none |
| `BUDGET_NOT_ACTIVE` | Clearing node | The Budget is not open yet, or the first millisecond after `validUntil` has passed | `never` | `revoked or expired Budgets fail closed inside the hub's grace period > refuses new calls once validUntil passes, while the earlier call still settles` in `apps/node/test/clearing.test.ts` | none |
| `PAYEE_NOT_ALLOWED` | Clearing node | The payee is not on a non-empty payee list | `never` | `clearing through FakeChain > refuses a payee outside the on-chain list with the structured refusal` in `apps/node/test/clearing.test.ts` | `PASS  PAYEE_NOT_ALLOWED fired for the injected payee, in the wallet and at the node` |
| `PRICE_MISMATCH` | Clearing node | The voucher amount is not the price registered for the provider | `never` | `vouchers not signed by the Budget's agent key > still records a refusal of a voucher the agent did sign, and sends its webhook` in `apps/node/test/unsigned-vouchers.test.ts` | none |
| `PER_CALL_CAP` | Clearing node | The price of the whole request, split or not, is above `perCallCap` | `never` | `a split payment is one call for the Budget's limits > applies the per-call cap to the total of the request, not to each voucher` in `apps/node/test/gateway.test.ts` | none |
| `STALE_CUMULATIVE` | Clearing node | The voucher's running total does not extend the latest accepted voucher by exactly its amount, which is also what a replayed voucher looks like | `resign` with `expectedCumulative` | `evaluateVoucher > tells a client with a stale cumulative which cumulative to sign` in `apps/node/test/policy-engine.test.ts` | none |
| `RATE_LIMIT` | Clearing node | The Budget already has `maxCallsPerMinute` accepted requests in the last 60 seconds | `after` the real seconds until the call fits every rolling limit it breaks, or `never` when no wait helps | `rolling-limit retry hints > answers RATE_LIMIT with the seconds until the oldest call of the minute leaves it` in `apps/node/test/retry-hints.test.ts` | none |
| `REPEAT_REQUEST` | Clearing node | The same request hash was already paid `maxRepeatsPerRequest` times within an hour | The same as `RATE_LIMIT` | `clearing through FakeChain > refuses the third payment for the same request` in `apps/node/test/clearing.test.ts`; `rolling-limit retry hints > answers REPEAT_REQUEST with the seconds until the oldest counted repeat leaves its window` in `apps/node/test/retry-hints.test.ts` | none |
| `HOURLY_CAP` | Clearing node | The request would take the Budget's accepted spend past the rolling one-hour cap, for all agents that share the key together | The same as `RATE_LIMIT` | `rolling-limit retry hints > answers HOURLY_CAP with the seconds until enough spend leaves the hour for this call` in `apps/node/test/retry-hints.test.ts` | `PASS  HOURLY_CAP fired at the node for the swarm's shared Budget` |
| `DAILY_CAP` | Clearing node | The request would take the Budget's accepted spend past the rolling 24 hour cap | The same as `RATE_LIMIT` | `evaluateVoucher > refuses with %s and nothing else`, case `DAILY_CAP`, in `apps/node/test/policy-engine.test.ts` | none |
| `TOTAL_CAP` | Clearing node | The request would take settled plus unsettled spend past the Budget cap | `never` | `the clearing story > refuses the DAO's call over its cap even with escrow left` in `apps/node/test/e2e.test.ts` | none |
| `NET_EXPOSURE` with `reason: "hub_unreadable"` | Clearing node | The hub cannot be read and the node's funds snapshot is older than `FUNDS_MAX_AGE_MS`, or was never read | `after` 5 seconds with `reason: "hub_unreadable"`; it does not ask for a deposit | `funds check while the hub is unreadable > refuses with NET_EXPOSURE and a short retry once the snapshot is too old and the refresh fails` and `> refuses a Budget whose funds were never read, without asking for a deposit` in `apps/node/test/funds-freshness.test.ts` | none |
| `NET_EXPOSURE` | Clearing node | The Budget's unsettled spending plus this request would exceed its escrow; hub credit and money the owner is owed do not count | `after_settlement` when the next batch leaves room, else `fund` with `shortBy`, and `fromCredit` when the owner holds hub credit | `clearing through FakeChain > stops new calls fail-closed once unsettled spending exceeds escrow` and `> never counts hub credit as room, and names fund_from_credit when the owner has credit` in `apps/node/test/clearing.test.ts` | `PASS  NET_EXPOSURE fired at the node before settlement`; `pnpm swarm`: `NET_EXPOSURE 3 (by the clearing node)` |
| `PAYER_DENIED` | Clearing node (gateway screening) | The paying account is on the business's blocked list | none | `carry-over API changes > link expiry, fee plan merchant_count, platform name, rpc_url, screening copy and delivery schedule` in `apps/node/test/accounts.test.ts`, which asserts that the check throws and that the decision is recorded with rule `PAYER_DENIED` | none |

The same rules apply to an agent that pays a payment link.
Evidence: `agents paying links over x402 v2 > refuses with PAYMENT-RESPONSE success false and the refusal the rule produced` in `apps/node/test/gateway.test.ts`.

The refusal record an agent reads back is signed.
Evidence: `the node's own record of a refusal > is signed with the node's receipt key over a digest that is not an acceptance` in `apps/node/test/refusal-lookup.test.ts`.

## Hub contract: refused at settlement

Every row in this section is a panic with a code from `contracts-near/src/errors.rs`.
A panic changes nothing: `settle_batch` runs all of its checks before any write, in one atomic receipt.
The hub gives no retry hint, so that column says what the caller can do.
Unless a row says otherwise, the evidence is a function in `contracts-near/src/tests/scenarios.rs` or `contracts-near/src/tests/review.rs`.

### `settle_batch`, called by the node

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `NOT_SETTLER` | Hub contract | The caller is not on the hub's settler list | none; the hub admin decides who settles | `caller_must_be_allowlisted_and_named_by_the_budget` and `settler_removed_from_allowlist_cannot_settle` in `scenarios.rs` | none |
| `NOT_BUDGET_SETTLER` | Hub contract | The caller is an allowed settler, but not the settler this Budget names | none | `caller_must_be_allowlisted_and_named_by_the_budget` in `scenarios.rs` | none |
| `BATCH_EXISTS` | Hub contract | The batch id is already stored: a replayed or resent batch, so a batch never settles twice | none; the node asks the hub for the batch and adopts it | `replayed_batch_id_is_rejected` in `scenarios.rs`; on a sandbox, `hub on near-sandbox through NearRpcChain > sends a settlement exactly once when the RPC drops or stalls the reply, and a retry is refused cleanly` in `packages/chain/test/sandbox.test.ts` | none |
| `ZERO_GROSS` | Hub contract | The batch holds no claim | none | `empty_and_oversized_batches_are_rejected` in `scenarios.rs` | none |
| `TOO_MANY_CLAIMS` | Hub contract | The batch holds more than 100 claims | none; the node packs at most 100 | `empty_and_oversized_batches_are_rejected` in `scenarios.rs` | none |
| `UNKNOWN_BUDGET` | Hub contract | A claim names a Budget the hub does not have | none | `unknown_budget_is_rejected` in `scenarios.rs` | none |
| `BUDGET_CLOSED` | Hub contract | The settlement deadline has passed: expiry plus 3 days, or revoke plus 24 hours, whichever is earlier | none; the owner can reclaim what is left | `revoked_budget_settles_during_grace_only` and `expired_budget_settles_during_grace_then_closes` in `scenarios.rs`; `f5_settlement_stays_open_for_24_hours_after_a_revoke` in `review.rs` | none |
| `RESERVED_ACCOUNT` | Hub contract | A claim names the hub account or the token account as payee | none | `f7_hub_and_token_accounts_are_never_credited` in `review.rs` | none |
| `PAYEE_NOT_ALLOWED` | Hub contract | A claim pays an account that is not on the Budget's non-empty payee list | none | `payee_outside_the_list_is_rejected_and_empty_list_means_any` in `scenarios.rs` | none |
| `BAD_SIGNATURE` | Hub contract | A voucher was not signed by the Budget's agent key, or its amount or request hash was changed after signing: a forged voucher | none | `bad_signature_is_rejected` in `scenarios.rs` | none |
| `STALE_VOUCHER` | Hub contract | A voucher's running total does not extend what the hub already settled for that Budget and payee: a replayed voucher, or one already settled | none; the node reads the settled position again and rebuilds the batch without that claim | `stale_vouchers_are_rejected` and `claims_apply_in_order_within_a_batch` in `scenarios.rs`; the node's side is `a settle_own that lands between the node's pre-checks and its batch > rebuilds the batch without the claim the hub calls stale, and retries` in `apps/node/test/seller-settlement.test.ts` | none |
| `CAP_EXCEEDED` | Hub contract | The claims would take a Budget's gross spending past its cap, even when escrow would cover it | none | `over_cap_is_rejected_even_when_escrow_would_allow_it` in `scenarios.rs` | none |
| `ONE_BUDGET_PER_OWNER` | Hub contract | One batch holds two Budgets of the same owner | none; the node packs one Budget per owner | `one_budget_per_owner_per_batch` in `scenarios.rs` | none |
| `NET_MISMATCH` | Hub contract | The net positions the node claims differ from what the hub recomputes from the claims: a missing entry, a wrong amount or a wrong order | none | `expected_net_is_asserted` in `scenarios.rs`; the node's side is `a settle_own that lands between the node's pre-checks and its batch > rebuilds a batch the hub refuses with NET_MISMATCH because the seller settled part of a claim` in `apps/node/test/seller-settlement.test.ts` | none |
| `INSUFFICIENT_ESCROW` | Hub contract | An owner's net debit is larger than the escrow of its Budget | none; the owner adds escrow | `escrow_cannot_cover_net_debit` and `same_claims_fail_without_offset_and_clear_with_offset` in `scenarios.rs` | none |
| `INSUFFICIENT_STORAGE` | Hub contract | The settler's prepaid storage balance cannot pay for the bytes the batch would write; the whole batch is refused | none; anyone calls `fund_storage` for the settler | `f3_settle_batch_without_storage_balance_is_refused_whole` in `review.rs`; on a sandbox, `settlement_storage_is_prepaid_refused_without_it_and_returned_on_payout` in `contracts-near/tests/sandbox.rs` | none |

### `settle_own`, called by a seller

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `NOT_PAYEE` | Hub contract | The caller is not the payee the voucher names | none | `settle_own_is_payee_only_and_debits_gross` in `scenarios.rs` | none |
| `PAYEE_IS_OWNER` | Hub contract | The payee is the Budget's own owner, whatever acceptance comes with the voucher: an owner settling to itself | none | `f1_owner_cannot_self_settle_ahead_of_the_seller` in `review.rs`; on a sandbox, `settle_own_refuses_vouchers_the_node_never_accepted` in `contracts-near/tests/sandbox.rs` | `PASS  an owner's self-signed voucher with no node acceptance is refused by settle_own` |
| `BUDGET_CLOSED` | Hub contract | The settlement deadline has passed | none | `settle_own_after_deadline_is_closed` in `scenarios.rs` | none |
| `RESERVED_ACCOUNT` | Hub contract | The payee is the hub account or the token account | none | `f7_hub_and_token_accounts_are_never_credited` in `review.rs` | none |
| `BAD_SIGNATURE` | Hub contract | The voucher was not signed by the Budget's agent key, or was changed after signing | none | `settle_own_respects_escrow_signature_and_stale` in `scenarios.rs` | none |
| `STALE_VOUCHER` | Hub contract | The voucher is already settled, by the seller or by a batch: a replay, or a double settlement | none | `settle_own_respects_escrow_signature_and_stale` and `settle_own_racing_a_batch_cannot_double_count` in `scenarios.rs` | `PASS  a replayed settle_own is refused: STALE_VOUCHER` |
| `ACCEPTANCE_KEY_UNKNOWN` | Hub contract | The acceptance is signed by a key the Budget's settler never registered: a voucher with no node acceptance, or with one the caller signed itself | none | `f1_owner_cannot_self_settle_ahead_of_the_seller` and `acceptance_must_come_from_the_budgets_own_settler` in `review.rs` | `PASS  an owner's self-signed voucher with no node acceptance is refused by settle_own` |
| `BAD_ACCEPTANCE` | Hub contract | The acceptance names a registered key, but its signature does not cover this exact claim | none | `acceptance_covers_exactly_one_claim` and `f1_owner_cannot_self_settle_ahead_of_the_seller` in `review.rs` | none |
| `ACCEPTANCE_TOO_LATE` | Hub contract | The node's acceptance is dated after the Budget's revoke or after its `validUntil`, compared in whole seconds | none; the node's own `settle_batch` can still settle the call inside the grace period | `f2_leaked_agent_key_cannot_drain_after_revoke`, `f2_leaked_agent_key_cannot_drain_after_expiry` and `acceptance_time_is_compared_in_milliseconds_at_the_boundaries` in `review.rs` | `PASS  a voucher signed by the agent key after the revoke cannot be settled` |
| `INSUFFICIENT_ESCROW` | Hub contract | The voucher is larger than the Budget's escrow; `settle_own` applies no netting and debits the full amount | none; the owner adds escrow | `settle_own_respects_escrow_signature_and_stale` in `scenarios.rs` | none |
| `INSUFFICIENT_DEPOSIT` | Hub contract | The Budget's storage reserve is used up and the seller attached too little NEAR for the new entry | none; attach a deposit, and the hub refunds the excess | `settle_own_uses_owner_reserved_storage_then_charges_the_payee` in `scenarios.rs` | none |

### Payout, reclaim, deposits and checkout payments

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `TOO_MANY_ACCOUNTS` | Hub contract | One `payout` call names more than 10 accounts | none | `payout_is_capped_at_10_accounts` in `scenarios.rs` | none |
| `INSUFFICIENT_GAS` | Hub contract | A `payout` or `reclaim` call attaches less gas than its transfers and callbacks need; refused before any state changes | none; attach more gas | `payout_refuses_too_little_gas_before_changing_state` in `scenarios.rs`; `f4_payout_counts_the_gas_each_account_really_needs` in `review.rs` | none |
| `TOO_EARLY` | Hub contract | An owner calls `reclaim` before the settlement deadline has passed | none; wait for the deadline | `reclaim_timing_and_authority` and `reclaim_after_expiry_grace` in `scenarios.rs` | none |
| `NOT_OWNER` | Hub contract | Someone other than the owner calls `reclaim`, `revoke_budget` or `fund_from_credit` | none | `reclaim_timing_and_authority`, `only_the_owner_can_revoke_and_only_once` and `fund_from_credit_is_owner_only_and_bounded_by_credit` in `scenarios.rs` | none |
| `INSUFFICIENT_CREDIT`, `BUDGET_NOT_OPEN` | Hub contract | `fund_from_credit` asks for more than the owner's credit, or targets a revoked or expired Budget | none | `fund_from_credit_is_owner_only_and_bounded_by_credit` and `fund_from_credit_refuses_revoked_and_expired_budgets` in `scenarios.rs` | none |
| No code: the tokens are returned | Hub contract | A deposit comes from an account that is not the Budget's owner, or targets a revoked or expired Budget | none | `deposit_from_non_owner_returns_full_amount` and `deposit_to_revoked_or_expired_budget_is_refunded` in `scenarios.rs` | none |
| No code: the tokens are returned | Hub contract | A checkout payment has a wrong amount, expired terms, terms signed by another key, or a payment id the hub already recorded | none | `payment_returns_full_amount_on_every_bad_case` in `scenarios.rs` | none |

A payout that fails does not lose the credit.
Evidence: `payout_failure_restores_credit` and `payout_cannot_double_spend_while_in_flight` in `scenarios.rs`, and `payout_failure_restores_credit_through_the_real_callback` in `contracts-near/tests/sandbox.rs`.

## Relayer: refused before it pays gas

The relayer is optional.
It pays the NEAR gas for an owner's zero-deposit call to the hub, such as `revoke_budget`, and it refuses everything else.
Its refusals protect the relayer's balance; an owner can always send the same call from a wallet with its own gas.
Unless a row says otherwise, the evidence is in `apps/relayer/test/relay.test.ts`.
The tests in the groups named "nothing sent" also assert that no transaction was submitted.

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `MALFORMED` (HTTP 400) | Relayer | The body is not JSON, has no `signedDelegate`, or is not exactly one Borsh `SignedDelegateAction` | none; fix the request | `POST /relay: malformed requests (400 MALFORMED, nothing sent) > refuses %s` and `> refuses a truncated delegate and one with trailing bytes` | none |
| `NOT_SPONSORED` (HTTP 403) | Relayer | The receiver is not the hub, a method is not on the list, a deposit is attached, the gas is above the limit, an action is not a function call, or the validity window is too long | none; send the call with your own gas | `POST /relay: what is not sponsored (403 NOT_SPONSORED, nothing sent) > refuses the same owner's call to any other contract`, `> refuses a transfer hidden among function calls`, `> refuses a deposit of 1 yoctoNEAR`, `> refuses a method that is not on the list`, `> refuses more gas than the limit, per delegate` and `> refuses a window that stays open too long` | none |
| `BAD_SIGNATURE` (HTTP 403) | Relayer | The signature does not verify, the key is not on the sender's account, or it is a function-call key that may not make this call | none | `POST /relay: signatures and keys (403 BAD_SIGNATURE, nothing sent) > refuses a tampered signature`, `> refuses a key that is not on the sender's account, however valid its signature` and `> refuses a function-call key for another contract, for another method, or with two calls` | none |
| `EXPIRED` (HTTP 409) | Relayer | The delegate's `max_block_height` has passed, or is too close to land | none; sign a new delegate | `POST /relay: windows and nonces (409, nothing sent) > refuses an expired window` and `> refuses a window too short to land, and accepts one block more` | none |
| `NONCE_USED` (HTTP 409) | Relayer | The key's nonce on chain is already at or past the delegate's, or this relayer already sent this delegate; it never sends one twice | none; the answer carries the first transaction's hash | `POST /relay: windows and nonces (409, nothing sent) > refuses a nonce the key has already used` and `> does not send the same delegate twice` | none |
| `PAYLOAD_TOO_LARGE` (HTTP 413) | Relayer | The body is larger than `MAX_BODY_BYTES` | none | `POST /relay: malformed requests (400 MALFORMED, nothing sent) > refuses a body over the size cap with 413` | none |
| `CALL_FAILED` (HTTP 422) | Relayer | The transaction ran and the hub refused the call, for example `NOT_OWNER`; the relayer reports the hub's code instead of a success | none; the answer carries the hub's code and the transaction hash | `POST /relay: when the send goes wrong > the hub refuses the call: 422 CALL_FAILED with the hub's code, never a 200` in `apps/relayer/test/outcomes.test.ts`; on a sandbox, `a gasless revoke through the relayer on near-sandbox > relays a stranger's revoke, the hub refuses it, and the relayer says so instead of reporting success` in `apps/relayer/test/sandbox.test.ts` | none |
| `RATE_LIMITED` (HTTP 429) | Relayer | Too many requests from one address or for one sender, too many relays in flight, or the day's gas budget is spent | `retryAfterSec`, also sent as `Retry-After` | `rate limits > limits requests per client address and says when to retry` and `daily gas budget > refuses with a clear message once the day's gas is spent, and starts again the next UTC day` in `apps/relayer/test/limits.test.ts` | none |
| `RPC_FAILED` (HTTP 502) | Relayer | The relayer could not read NEAR or could not send | `outcomeUnknown: false` means nothing was sent and the request can be repeated; `outcomeUnknown: true` means check the transaction hash first | `POST /relay: when the send goes wrong > nothing sent: 502 RPC_FAILED with outcomeUnknown false, and the same delegate may be tried again` and `> unknown outcome: 502 RPC_FAILED with outcomeUnknown true and the tx hash, and never a second send` in `apps/relayer/test/outcomes.test.ts` | none |

`pnpm --filter @payminto/relayer dev:fake` shows `NOT_SPONSORED`, `NONCE_USED` and `MALFORMED` with curl against an in-memory chain; the commands are in the [walkthrough](WALKTHROUGH.md#try-it).
On a sandbox (a local NEAR node), `pnpm local --check` relays a revoke for an owner with no NEAR and then sends the same delegate again; its check line, from a run on 2026-11-10, ends with `the same delegate again: 409 NONCE_USED`.
The dashboard's "Revoke without gas" shows each of these codes in plain words; `apps/dashboard/test/relayer.test.ts` and `apps/dashboard/test/gasless.test.ts` test that.

## The demo as evidence

`pnpm demo` ends with a checks block, and the exit code is 0 only when every check passes.
These are the check lines that are about refusals, copied from a run on 2026-11-10 on the simulated hub.
`pnpm demo --chain sandbox` prints the hub's lines from a sandbox (a local NEAR node), where the hub's answers are read from the chain through a client that holds no key.
Both runs pass every check: `25 of 25` on the simulated hub and `26 of 26` on a sandbox.

```text
PASS  HOURLY_CAP fired at the node for the swarm's shared Budget: 3 workers paid 25 of 25 allowed
PASS  REPEAT_REQUEST fired for a looping agent: same request paid 3 times, the 4th refused
PASS  NET_EXPOSURE fired at the node before settlement: retry fund
PASS  PAYEE_NOT_ALLOWED fired for an unlisted payee the payee check has nothing against, in the wallet and at the node: rogue.testnet: exists on chain, node's check allow; refused by the Budget's own list
PASS  PAYEE_BLOCKED stopped a lookalike of an allowed payee: the wallet signed nothing, the node refused a guard-off runtime, and no position moved: 5can.testnet imitates scan.testnet, does not exist on chain; node block (account_missing, lookalike_payee); wallet signed 0, node position 0, signed record verifies
PASS  PAYEE_NEEDS_APPROVAL held a warned payee until the owner approved it on the node, the same call was then paid, and it waited again once the approval was withdrawn: newdesk.testnet: node warn (token_unregistered); position 0 -> 0 waiting -> 2000 approved -> 2000 withdrawn
PASS  every refusal carries the attempted amount and a retry hint: 9 refusals
PASS  a replayed settle_own is refused: STALE_VOUCHER
PASS  an owner's self-signed voucher with no node acceptance is refused by settle_own: to itself PAYEE_IS_OWNER, to an accomplice ACCEPTANCE_KEY_UNKNOWN, escrow untouched
PASS  a voucher signed by the agent key after the revoke cannot be settled: alone ACCEPTANCE_KEY_UNKNOWN, with the node's signature dated after the revoke ACCEPTANCE_TOO_LATE
```

The demo's own tests assert these lines.
Evidence: `the demo story on the simulated hub > shows each refusal with the rule that fired and who enforced it` and `the checks themselves > fail when settle_own takes a voucher the node never accepted, or when the hub pays for storage` in `apps/demo/test/demo.test.ts`.

## The NEAR AI Agent Market: a quote is checked, nothing is paid

The wallet tool `quote_market_agent`, the command `pnpm market quote` and the agent's `market work` command use `packages/agent-market`.
They ask a market agent for its price and decide allow or refuse before anything is signed.
Nothing in this repository pays the market: Payminto does not settle, hold or route Agent Market jobs, and a hire on the market is paid through the market, on NEAR mainnet.
So the rows below refuse a quote or a purchase of inputs, never a Payminto payment to the market.

| Code | Enforced by | Fires when | Retry hint | Evidence | Demo check |
|---|---|---|---|---|---|
| `PER_HIRE_MAX` | Agent wallet (`quote_market_agent`), and `checkQuote` in `packages/agent-market` | The quoted price is above the per-hire maximum: the Budget's per-call cap, `MAX_PRICE_ATOMIC` when lower, or a lower `max_usdc` the model passed | `never` | `quote_market_agent > takes the per-hire maximum from the wallet: a lower per-call cap, or the operator's lower maximum, refuses the same quote` and `> lets the model tighten the maximum for one check, never raise it` in `apps/mcp/test/market.test.ts`; `checkQuote > refuses a price above the per-hire maximum before anything is signed` in `packages/agent-market/test/quote.test.ts` | `pnpm market quote <handle> --max 0.10`: `Decision   REFUSE by rule PER_HIRE_MAX` |
| `DAILY_MAX` | `checkQuote` in `packages/agent-market` | The hire would take the last 24 hours past the daily maximum | `after` seconds, or `never` when the price alone is above it | `checkQuote > refuses when the last 24 hours are full, and says when to retry` and `> says never when the price alone is above the daily maximum` in `packages/agent-market/test/quote.test.ts` | none |
| `PAYEE_BLOCKED` | Agent wallet (`quote_market_agent`), and `checkQuote` | The payee check blocks the account the quote pays, which is the market's treasury on NEAR mainnet | `never` | `quote_market_agent > asks the payee check about the account the quote pays, and refuses a blocked one` in `apps/mcp/test/market.test.ts` | none |
| `PAYEE_WARNED`, `PAYEE_VERDICT_MISMATCH` | `checkQuote` in `packages/agent-market` | A payee verdict says warn under `refuseOnWarn`, or is about another account than the quote pays | `never` | `checkQuote > follows the payee verdict: block refuses, warn is carried or refused, allow passes` and `> refuses a verdict that is about some other account` in `packages/agent-market/test/quote.test.ts` | none |
| `NETWORK_NOT_ALLOWED`, `ASSET_NOT_ALLOWED`, `VALIDITY_TOO_LONG` | `checkQuote` in `packages/agent-market` | The quote is on another network, in another asset, or would stay chargeable for too long | `never` | `checkQuote > refuses a quote on the wrong network`, `> refuses a quote in the wrong asset` and `> refuses a payment that would stay chargeable for too long` in `packages/agent-market/test/quote.test.ts` | none |
| `JOB_SPEND_CEILING` | `SpendGuard` in `packages/agent-market`, used by `pnpm agent market work` | A market job's purchases of inputs would pass the ceiling its worker was started with; job text cannot change the ceiling | none | `SpendGuard > refuses in Payminto's refusal shape` in `packages/agent-market/test/worker.test.ts`; `market work --dry-run > holds the purchases to the ceiling: what does not fit is not bought, and the deliverable says so` and `> a job that tells the agent to pay a stranger and raise its ceiling changes neither` in `apps/agent/test/market.test.ts` | `pnpm agent market work --dry-run --ceiling 0.005` |

## The payee check as a library

The wallet's guard is `guardPayment` in `packages/payee-check`, and the node's verdicts come from the same package.
Its outcomes are tested on their own, with no wallet and no node.

| Outcome | Fires when | Evidence |
|---|---|---|
| `blocked` | The check answers block | `guardPayment > refuses on block without asking anyone` in `packages/payee-check/test/guard.test.ts` |
| `denied`, `approval_timeout`, `no_approver`, `approval_error` | The check answers warn and no person gives an explicit approval | `guardPayment > refuses on warn when the person denies`, `> refuses on warn when nobody answers in time` and `> refuses on warn when there is nobody to ask, when asking throws, or when the answer is not a clear approval` in `packages/payee-check/test/guard.test.ts` |
| `check_failed` | The check throws, hangs, answers nothing or answers about another payee | `guardPayment fails closed > refuses when <case>`, one test per failure case, in `packages/payee-check/test/guard.test.ts` |

`pnpm --silent --filter @payminto/payee-check demo` shows these outcomes for six scripted payments and ends with `All 3 payments that came from injected text were refused before anything was signed.`

An owner lifts a `PAYEE_NEEDS_APPROVAL` refusal on the Budget's page in the dashboard ("Waiting for your approval", then Approve), which sends `POST /v1/budgets/:id/payee-approvals`.
A blocked payee has no plain Approve there: "Approve anyway" needs the account id typed exactly and sends `overrideBlock: true`.
The page's rules are tested in `apps/dashboard/test/payee-approvals.test.ts`, and the loop of refusal, approval and a paid next call is a check of `pnpm local --check`: `a payee the check warns about waits for the owner: refused until approved, and paid on the next call`.

## Not in the table

These refusals exist in the code, and no test that asserts their code was found, so they are not claimed above.

| Code | Where | What the code does |
|---|---|---|
| `PROVIDER_MISMATCH` (403), `NETWORK_MISMATCH` (400), `PAYEE_MISMATCH` (400) | `POST /v1/vouchers` in `apps/node/src/api.ts` | Refuses a voucher whose provider id, network or payee is not the calling provider's own |
| `REQUEST_HASH_MISMATCH` (400) at the node | `POST /v1/vouchers` in `apps/node/src/api.ts` | Refuses a body whose two request hashes differ; the paywall's own `REQUEST_HASH_MISMATCH` is tested and is in the table |
| `CAP_EXCEEDED` in `settle_own` | `contracts-near/src/lib.rs` | The cap check runs in `settle_own` too; the tests assert it for `settle_batch` only |
| `SCREENING_REFUSED` (403) | `apps/node/src/gateway/screening.ts` | The HTTP code of a `PAYER_DENIED` refusal; the test asserts the thrown check and the recorded rule, not the HTTP code |

## What a refusal does not tell you

- A refusal by the agent wallet protects only an agent that runs the wallet.
  The clearing node applies the same Budget rules again, and the hub applies the cap, the payee list, the deadline and the escrow a third time.
- The hub cannot tell a voucher signed before a revoke from one signed after it.
  `settle_own` refuses an acceptance dated after the revoke, but a settler that keeps accepting calls after a revoke can still settle them with `settle_batch` during the 24 hour grace period.
  The chain does not stop that; the settler's own signatures prove it.
- Acceptance timestamps are whole seconds, set by the node's clock.
  A call accepted in the same second as a revoke still settles through `settle_own`.
- The payee check is a set of heuristics, not a guarantee.
  An allow means nothing that was checked speaks against the payee; it does not mean the payee is honest.
  Reports filed on one node all carry that node's operator account, so they count as one reporter and lead to a warning, never to a block.
  When a payee the node has never seen cannot be checked, the call is refused, so a failing RPC endpoint or indexer stops first payments to new payees until it answers again.
- The full trust model and the known limits are in [SECURITY.md](SECURITY.md).
