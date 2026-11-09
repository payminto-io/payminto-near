# @payminto/sdk

Client side of Payminto Clearing: `OwnerClient` (mandates), `AgentClient` (paying agents) and `paywall()` (providers).
The full API is in `docs/SPEC.md` section 6; this file explains how spending is bounded.

## Policy is enforced twice, and the hard limits a third time

Policy is enforced twice: by the agent before signing and by the node before accepting; total cap, allowlist and expiry a third time on chain.

| Layer | Where | Rules |
|---|---|---|
| Agent, before signing | `AgentClient` (`src/policy-guard.ts`) | MANDATE_NOT_ACTIVE, TOKEN_MISMATCH, PAYEE_NOT_ALLOWED, PER_CALL_CAP, RATE_LIMIT, DAILY_CAP, TOTAL_CAP, plus POSITION_UNVERIFIED (agent only) |
| Node, before accepting | Clearing Node policy engine, one `BEGIN IMMEDIATE` transaction | the full SPEC 5.4 order, including BAD_SIGNATURE, STALE_CUMULATIVE and INSUFFICIENT_FUNDS |
| Chain, at settlement | `ClearingHub.settleBatch` | owner signature, agent signature, total cap, payee allowlist, validity window |

Why the agent layer matters: a voucher is a signed claim that any provider can settle on chain itself, and the hub only checks the total cap, the allowlist and the validity window.
If the agent signed a call that breaks its daily or per-call cap, the node would deny it, but the provider would still hold a settleable signature.
So `AgentClient` checks the mandate policy before it signs, and a refused call never produces a signature.

How the agent gets a policy it can trust:
- It takes `policy: { mandate, policy, payees }` in the constructor, or fetches it from the public `GET /v1/mandates/:id/policy`.
- Either way it verifies that the mandate hashes to its `mandateId`, that `policyHash(policy) === mandate.policyHash` and that `payeesRoot(payees) === mandate.payeesRoot`, so a lying node cannot loosen it.
- If the policy cannot be fetched or does not verify, the agent fails closed: `POLICY_UNAVAILABLE` or `POLICY_MISMATCH`, and nothing is signed.

## What the agent never takes from a provider or the node

`nodeUrl` is required: the agent talks to that clearing node only, and ignores the `clearingNode` a provider advertises in its 402 requirement.
On `STALE_CUMULATIVE` the agent re-reads its position from the configured node; any position in the provider's 402 body is ignored.
The agent never signs a cumulative above the highest cumulative it has signed itself for that (mandate, payee) plus the call price.
If the node reports a position above that high-water mark, the agent signs nothing and refuses with `POSITION_UNVERIFIED` ("Reported position exceeds what this agent has signed").
A paid receipt is kept only if it matches the signed voucher and is signed by the operator address the configured node reports in `GET /v1/info` (cached, and checked against `trustedNode` when set).
`verifyReceiptOnchain` proves a receipt only if the batch was settled by that operator and the operator signed the leaf, because anyone can call `settleBatch`.

## Durable receipt store

The agent keeps receipts, the signed high-water mark per (mandate, payee) and its HSP co-sign totals in a `ReceiptStore`.
Pass `storePath` to use `SqliteReceiptStore` (node:sqlite, WAL, `synchronous = FULL`); without it the store is in memory and lost on restart.
After a restart with the same file, the agent co-signs HSP settlements for its old receipts and extends its positions.
After a restart without it, the agent refuses to extend positions it no longer remembers signing (`POSITION_UNVERIFIED`).
Multi-process caveat: two processes that share one agent key must share one receipt store (the same file, or the same `receipts` object in one process); otherwise each sees the other's vouchers as unverified positions and refuses to sign.
Call `client.close()` on shutdown to stop the co-sign loop and close a store the client opened.

## Refusals

A refusal emits `denied` with the same `DenialRule` code the node would use (with `details.enforcedBy = "agent"`), and `fetch()` returns a `402` whose body is `{ x402Version: 2, error: { code, message, details } }`.
Caps count this client's accepted spend plus vouchers it is signing right now, so parallel calls to different payees cannot jointly overspend.
The total-cap check counts every payee's signed high-water mark from the store, so it survives restarts; spend by processes that do not share the store is caught by the node and the hub instead.
`enforcePolicy: false` turns the agent layer off and leaves enforcement to the node and the hub.

## Payment gateway

`GatewayClient({ nodeUrl, apiKey, merchantId? })` is the merchant and operator API of the gateway (docs/GATEWAY.md): `payments`, `links`, `refunds`, `webhooks`, `merchant` and `screening` with a merchant key, `merchants`, `feePlans`, `platform` and `apiKeys` with the admin token, and `directory()`.
Results are the protocol types (`Payment`, `PaymentLink`, `Refund`, ...); errors are `NodeApiError` with the node's code; `{ idempotencyKey }` sends `Idempotency-Key`.
`constructEvent(rawBody, header, secret)` verifies a `Payminto-Signature` and returns the event, or throws `WebhookSignatureError`.
`payExact(url, { account, maxAmount })` pays a plain x402 `exact` requirement with one EIP-3009 signature and returns the parsed `PAYMENT-RESPONSE`; it never signs above `maxAmount`.
`AgentClient.fetch` pays a fee-carrying gateway payment with two vouchers (merchant net and platform fee): both payees must be allowlisted and the combined price must fit the per-call cap, or nothing is signed.

## Tests

```sh
pnpm --filter @payminto/sdk test
```

`test/gateway.test.ts` runs the gateway side against anvil and a real node in-process on a temp database.
