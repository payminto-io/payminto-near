# @payminto/sdk

Client side of Payminto Clearing on NEAR: `OwnerClient` (Budgets), `AgentClient` (paying agents) and `paywall()` (sellers).
This file explains how spending is bounded.

## Keys and transactions

An agent holds a bare ed25519 `Keypair` with no NEAR account and no gas.
It signs vouchers only: `signDigest(secretKey, voucherDigest(hub, network, voucher))`, where the voucher binds the Budget, payee, amount, cumulative and request hash.
`OwnerClient` never signs anything on chain.
It builds `BudgetTerms` and returns wallet transactions (`openTx`, `depositTx`, `revokeTx`, `reclaimTx`) for the owner's own wallet, then registers the opened Budget with `submit`.

## Policy is enforced twice, and the hard limits a third time

| Layer | Where | Rules |
|---|---|---|
| Agent, before signing | `AgentClient` (`src/policy-guard.ts`) | BUDGET_NOT_ACTIVE, TOKEN_MISMATCH, PAYEE_NOT_ALLOWED, PER_CALL_CAP, RATE_LIMIT, REPEAT_REQUEST, HOURLY_CAP, DAILY_CAP, TOTAL_CAP, plus POSITION_UNVERIFIED (agent only) |
| Node, before accepting | Clearing Node policy engine, one transaction | the same rules in the same order, plus BAD_SIGNATURE, STALE_CUMULATIVE, PRICE_MISMATCH and NET_EXPOSURE |
| Chain, at settlement | the hub's `settle_batch` | agent signature, cap, payee list, settlement deadline, escrow |

A voucher is a signed claim a payee can settle on chain itself with `settle_own`.
If the agent signed a call that breaks its daily or per-call cap, the node would refuse it, but the payee would still hold a settleable signature.
So `AgentClient` checks the policy before it signs, and a refused call never produces a signature.

How the agent gets a policy it can trust:

- It takes `policy: { budget, policy }` in the constructor, or fetches it from the public `GET /v1/budgets/:id/policy`.
- It checks that the terms hash to its `budgetId`, that `policyHash(policy)` equals the terms' `policyHash`, and that the terms name its own key.
- If the policy cannot be fetched or does not verify, the agent fails closed with `POLICY_UNAVAILABLE` or `POLICY_MISMATCH`, and nothing is signed.

## What the agent never takes from a provider or the node

`nodeUrl` is required: the agent talks to that clearing node only, and ignores the `clearingNode` a provider advertises.
On `STALE_CUMULATIVE` the agent re-reads its position from the configured node, never from the provider's 402 body.
The agent never signs a cumulative above the highest cumulative it has signed itself for that (Budget, payee) plus the call price.
If the node reports a higher position, the agent signs nothing and refuses with `POSITION_UNVERIFIED`.
A receipt is kept only if it matches the signed voucher and carries a valid signature by the `nodeKey` that the configured node reports in `GET /v1/info`, checked against `trustedNodeKey` when set.
A `PAYMENT-RESPONSE` that does not parse as a v2 success with this voucher's receipt, or any response with status 402, is never treated as paid.

## What a call paid

A seller's answer does not decide what was paid.
The agent's position for a payee advances only on a receipt that carries the node's signature.
After anything else (a receipt that does not verify, an error, a refusal, a stale answer, a request that died) the agent asks its own node what became of each voucher it sent, by the call id the node derives from the voucher's own fields (`callIdOf`, `GET /v1/receipts/:callId/proof`).

`pay()` is `fetch()` plus the answer:

```ts
const { response, payment } = await agent.pay(url, init, { maxPrice: 5_000n });
payment.status; // "none" | "paid" | "unverified"
payment.paid; // bigint, booked on this agent's node
payment.unverified; // bigint, sent with an unknown outcome
payment.vouchers; // one entry per voucher: payee, amount, cumulative, callId, state, receipt, note
payment.refusal; // { source: "agent" | "seller", code, message, refusal, sellerCode, sellerText } or null
```

- `none`: nothing was signed, or every voucher signed is void. Only then is "nothing was paid" true.
- `paid`: the node booked the vouchers and its receipts verified, even when the seller answered an error or a refusal.
- `unverified`: a voucher was signed and sent and the agent could not confirm either way. The seller holds a voucher it can still collect, through the node or on the hub with `settle_own`, so treat the amount as possibly spent.
- A voucher is `void` when the node moved to or past its cumulative without booking it (a real stale race with another process of the same agent). Only then does the agent sign again.

A seller that forwards a voucher and then answers `STALE_CUMULATIVE` to be paid again is paid once: the agent finds the call on its node, keeps the node's receipt and stops.
A seller that never forwards vouchers and answers with a receipt it signed itself gains nothing by repeating it: every new voucher is signed on the node's position, so the seller never holds more than one call above it.
Every signed voucher whose outcome is open counts in the hourly and daily windows and in the repeat limit until the node resolves it.
`pay()` throws `PayFailed` when the call could not finish; it carries the same `payment` report.

## Proofs

`verifyReceiptOnchain` takes a `Pick<Chain, "hub" | "network" | "batch" | "verifyReceipt">`.
It checks the node's signature, the agent's voucher signature when `agentPk` is given, that the trusted operator settled the batch, the Merkle path against the batch root locally, and the hub's `verify_receipt`.
It proves inclusion and agent authorization only.
It does not prove that the root covers every voucher, or that the service was delivered.

## Durable receipt store

The agent keeps receipts and the signed high-water mark per (Budget, payee) in a `ReceiptStore`.
Pass `storePath` to use `SqliteReceiptStore` (node:sqlite, WAL, `synchronous = FULL`); without it the store is in memory and lost on restart.
Two processes that share one agent key must share one store, or each sees the other's vouchers as unverified positions.
Call `client.close()` on shutdown to close a store the client opened.

## Refusals

A refusal emits `denied` with the rule code and a `refusal`, and `fetch()` returns a 402 whose body has `success: false`, `errorReason`, `error: { code, message, details }` and `refusal`.
`refusal` is the same machine-readable shape whether the agent or the node refused: `rule`, `attemptedAmount`, `remainingBudget` (null when unknown) and a `retry` hint (`never`, `after` seconds, `after_settlement`, `fund` with `shortBy`, or `resign`).
`REPEAT_REQUEST` from the agent's own guard carries `after` with the seconds until the request fits again.

Every `denied` event says whose word the refusal is in `source`.
`agent` is a refusal this client decided before signing, from the policy it verified against the Budget id; it carries `details` with `enforcedBy: "agent"`.
`seller` is a refusal a seller's 402 relayed after a voucher was sent.
Nothing in that answer is signed, so the client keeps only a rule code that is in `DENIAL_RULES`, with its own text for it, and reports any other code as `SELLER_REFUSED`.
The seller's free-form `details` are dropped, and its words survive only as `sellerCode` and `sellerText`, cleaned of control characters and capped at 200 characters, for a caller to show as unauthenticated seller text.
A refusal counts as the node's only when the agent can read it from its own node; until the node signs refusals, a relayed one stays the seller's word.
No `denied` event is emitted for a "refused" call the node in fact booked: that call is paid.

A Budget whose payee list is empty allows any payee on chain.
The agent refuses every payee under such a Budget (`PAYEE_NOT_ALLOWED`, `details.allowlist: "empty"`) unless it was built with `allowAnyPayee: true`.
Caps count this client's accepted spend plus the vouchers it is signing right now, so parallel calls to different payees cannot jointly overspend.
Agents that share one Budget key (a swarm) share one receipt store, but each sees only its own recent spend: the node enforces the hourly, daily and rate limits on their combined spend.
`enforcePolicy: false` turns the agent layer off and leaves enforcement to the node and the hub.

`beforeSign` is a hook the client asks about every payee of an offer before it signs anything for that offer.
It gets `{ payer, payee, amount, total, budgetPayees, requirement, url, budgetId }`: the payer is the Budget's owner and the payees are the Budget's list, both from the terms the client verified against the Budget id.
It runs after the client's maximum price and before the Budget rules, and before the payees are locked, so a hook that waits for a person holds up no other call.
It returns null to go on, or `{ rule, message, retry, details? }` to refuse: the client then answers with its own structured refusal (`source: "agent"`, the whole offer as `attemptedAmount`) and no voucher leaves the process.
A hook that throws refuses the call with `CLIENT_CHECK_FAILED` and `retry: { kind: "after", seconds: 30 }`.
The MCP wallet's payee check is this hook.

## x402 v2 on the wire

The schemas live in `@payminto/protocol` (`src/x402.ts`), and every header is parsed with them.
A header whose `x402Version` is not 2 is refused as unsupported, never guessed at.

| Header | Shape |
|---|---|
| `PAYMENT-REQUIRED` | `{ x402Version: 2, resource: { url, description }, accepts: [requirement], error? }` |
| requirement | `{ scheme: "payminto-voucher", network: "near:testnet", amount, asset, payTo, maxTimeoutSeconds, extra: { clearingHub, clearingNode, providerId, tokenSymbol, tokenDecimals, splits? } }` |
| `PAYMENT-SIGNATURE` | `{ x402Version: 2, resource, accepted: requirement, payload: { budgetId, payee, amount, cumulative, requestHash, publicKey, signature } }`, or `payload: { vouchers: [...] }` for a requirement with `extra.splits` |
| `PAYMENT-RESPONSE` | `{ success: true, transaction: "", network, payer, receipts: [...], positions }`, or `{ success: false, errorReason: <rule>, transaction: "", network, refusal }` on a 402 |

Several `accepts` entries are alternatives, never a split.
An empty `transaction` means the call is cleared now and settles later in a netted batch.

## Seller vouchers and `settle_own`

`paywall()` keeps the latest voucher the node accepted for each (hub, Budget, payee) in a `VoucherStore`, together with the node's acceptance of it, so a seller can settle its own earnings with `settle_own` even when the node is gone.
The hub takes a voucher through `settle_own` only with that acceptance, which the node signs for every call it accepts and returns in the receipt.
A voucher with no acceptance cannot be settled by the seller, and only the node that accepted the call can sign one.
The paywall does not store a voucher whose acceptance does not verify, so the latest voucher that can be settled is never replaced by one that cannot, and it reports that through `onError`.

The default store is in memory; pass `vouchers: new FileVoucherStore(path)` to keep it across restarts.
The file store writes a temporary file, fsyncs it and renames it over the old one, so a crash leaves either the old or the new file, and a file that does not parse is never overwritten.
Several processes may share one file, for example two containers on one volume.
Each write takes `<path>.lock`, an exclusive lock file created with `O_EXCL` that holds a random token, reads the file again, and merges it with what it knows before it rewrites it, so no writer drops a voucher another writer stored.
Who holds the lock is decided by the token, never by a process id, because two containers often both run as pid 1.
A lock left by a writer that died is taken over once it is 10 seconds old (`lockStaleMs`), by an atomic rename that only one waiting writer wins.

```ts
const pay = paywall({ nodeUrl, providerId, apiKey, vouchers: new FileVoucherStore("./seller.vouchers.json") });
const exp = await pay.exportVouchers("seller.testnet");            // the latest voucher per Budget, each with its acceptance
const checked = await parseVoucherExport(exp, chain);              // checkedAgainst: "hub"
const plan = await settleOwnClaims(checked, "seller.testnet", chain); // skips what the hub already settled
const txs = settleOwnTxs(exp.hub, plan.claims);                    // for the seller's own wallet to sign
for (const u of plan.unsettleable) console.warn(u.voucher.callId, u.reason);
```

`parseVoucherExport` refuses a forged or edited export before it reaches a wallet.
Given a chain reader, it checks every voucher against its Budget's agent key on the hub, and every acceptance against the receipt keys the Budget's settler registered there, and the result says `checkedAgainst: "hub"`.
Without a reader it can only check each signature against the key the export itself names, which anyone can forge, and the result says `checkedAgainst: "declared-keys"`.
`settleOwnClaims` returns the claims with their acceptances, and lists in `unsettleable` every voucher the hub would refuse, with the reason: no acceptance, an acceptance dated after the Budget's revoke or expiry, a payee that is the Budget's owner, or a closed Budget.

The paywall answers a `PAYMENT-SIGNATURE` it cannot read, or one that is not x402 version 2, with a 400 and no payment headers, as the node's gateway does.
A readable payment that fails the schema, the requirement, the request hash or the signature is a failed payment: a 402 with `PAYMENT-RESPONSE`.

## Agent key files

`writeAgentKeyFile` writes a new ed25519 key as JSON with mode 0600 in a 0700 directory, refusing to replace a key unless forced, and returns only the public key.
`readAgentKeyFile` refuses a file other users can read, and a file whose secret does not match its public key; its errors never contain the key.
`payminto-agent keygen` and the MCP wallet use these, with the default path `~/.payminto/agent/agent-key.json` (`defaultAgentKeyPath`).

## Gateway client

`GatewayClient` is the merchant and operator client for the node's gateway on NEAR: payments, links, refunds, webhooks, the merchant profile, screening, the reconciliation report and the public directory with a business API key, and merchants, fee plans and the platform with the operator's token.
Its types are the NEAR shapes in `@payminto/protocol`: accounts are NEAR account ids, a payment names its `network`, `hub` and `token`, and the payment methods are `wallet` (a person's NEAR wallet pays through the hub) and `voucher` (an agent pays from its Budget over x402).

A payout account is proven with a NEP-413 signed message, bound to the merchant and to one node's network and hub:

```ts
const client = new GatewayClient({ nodeUrl, apiKey });
const scope = await client.payoutScope(); // { network, hub } from the node's /v1/info
const proof = await signPayoutProof(signer, "new", scope); // { payout, timestamp, public_key, signature }
await client.merchants.create({ name: "Northwind Data", payout: proof });
```

`signer` is a `PayoutSigner`: the account id and a `signMessage` with the shape of a NEAR wallet's (NEAR Connect, wallet selector), which returns the base64 signature and the key that signed.
`payoutSignerFromKey(accountId, keypair)` builds one over a key held in the process.
The key must be a full-access key of the account; the node checks that on chain and refuses a function-call key.

Refunds are non-custodial.
`refunds.create` returns `transfer`, the `ft_transfer` the merchant's payout account sends from its own wallet (null while the refund waits for an Admin to approve it).
`refunds.submit(id, { txHash })` reports that transaction, and the node checks its sender, token, recipient and amount on chain before the refund succeeds.

`checkout.retrieve(paymentId)` and `checkout.proof(paymentId)` read the public side of a payment: what the hosted checkout shows, and the chain evidence once it is paid.
Agents pay a link at the node's `/v1/pay/l/<slug>` on the x402 v2 wire with `AgentClient`; a link with a platform fee is one requirement with two splits, paid with two vouchers at once.

## Tests

```sh
pnpm --filter @payminto/sdk test
```
