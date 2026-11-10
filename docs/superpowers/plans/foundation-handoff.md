# Foundation handoff

Status: foundation pass done, nothing committed.
Date: 2026-11-10.
The design is docs/superpowers/specs/2026-11-10-near-clearing-design.md, and its "Roundtable decisions" section wins.

## What is frozen

These are the seam between streams.
Change them only with every stream agreeing, and regenerate the vectors in the same change.

- `packages/chain/src/types.ts`: `AccountId`, `TxHash`, `PublicKey`, `Id32`, `Sig64`, `Network`, `BudgetTerms`, `Budget`, `Voucher`, `Claim`, `NetEntry`, `SettleArgs`, `Batch`, `Payment`, `CheckoutTerms`, `ReceiptFields`, `TxState`.
- `packages/chain/src/chain.ts`: the `Chain` interface (`budget`, `settledOf`, `creditOf`, `balanceOf`, `batch`, `payments`, `isRegistered`, `settle`, `payout`, `txState`, `verifyReceipt`).
- `packages/chain/src/constants.ts`: tags, domains, `MAX_CLAIMS` 100, `MAX_PAYEES` 16, `MAX_PAYOUT_ACCOUNTS` 10, `MAX_MERKLE_DEPTH` 32, grace periods, and `HUB_ERRORS`.
- `packages/chain/src/digest.ts`, `merkle.ts`, `netting.ts`: Borsh layouts, Merkle rules and canonical `expected_net`.
- `packages/chain/src/actions.ts`: contract method names and JSON argument shapes.
- `packages/chain/vectors/*.json`: the files the Rust contract tests against.
- `packages/chain/README.md`: the same layouts written out for Rust.

Tag choice: `VOUCHER_TAG` is `2147484000 + 20402` and `CHECKOUT_TAG` is `2147484000 + 20403`, both above 2^31 and clear of NEP-413.
The checkout terms digest was not in the brief, but the hub verifies node-signed terms in `ft_on_transfer`, so it is frozen here too.

## Decisions taken in this pass

- The netting party is the Budget owner account, and a batch holds one Budget per owner, as the spec says.
- `expected_net` is `[{ account, debit, credit }]`, sorted by account bytes, zero entries omitted, with `debit` and `credit` as U128 strings.
- A Budget with an empty payee list allows any payee, as before; the node and `FakeChain` both treat it that way.
- Budget ids hash `domain`, `hub` and `network` as well as the terms, so ids never collide across hubs.
- The node signs a per-call acceptance digest (`nodeDigest` in protocol) with `NODE_SIGNING_SEED`, because a Merkle leaf needs the batch id and does not exist at acceptance.
- `GET /v1/receipts/:id/proof` returns `leaf` once the call is in a batch.
- Owners open and revoke Budgets from their own wallet; `POST /v1/budgets` only registers a Budget already open on the hub, and refuses one whose settler is not this node.
- `fee_plans` keeps one seeded row, `fp_zero`, and every business starts on it.
- `payment_credits` and `merchant_methods` still accept `deposit`, because the EVM-era gateway code still names it; the Node stream drops it with the checkout rewrite.
- Gas savings were removed from `/v1/overview` (anti-goal: no EVM gas numbers); it reports confirmed gross and net instead.

## Open question for the owner

Decision 2 says the exposure limit counts "only incoming amounts from confirmed batches".
The node implements that as: unsettled outgoing plus this call, minus the owner's hub credit, must not exceed escrow.
On chain, credit cannot pay a net debit, so a batch whose offsets were already confirmed earlier still needs escrow.
Calls that offset inside one unsettled window are therefore limited to escrow before settlement, which makes "a batch that clears only because of offset" hard to show from fresh calls.
The Demo stream needs a ruling before scripting that scene.

## Stubs and owners

Every stub below is typed, and either throws a clear "not implemented" error, returns an empty result, or is a skipped test with a `TODO(<stream>)` comment.

### Chain stream

- `packages/chain/src/node.ts` - `NearRpcChain`: every method throws "not implemented"; implement with near-kit 0.20.2 at final finality, map hub panics onto `ChainError` by `HUB_ERRORS` prefix, and support a read-only client when `operatorKey` is absent (MCP proofs need it).
- `packages/chain/src/fake.ts` - complete; keep it in lockstep with the contract when its rules change.

### Node stream

- `apps/node/src/chain.ts` - `headOf`, `receiptOf` and `blacklisted` are EVM leftovers for the gateway; remove them with the rewrites below.
- `apps/node/src/gateway/rails.ts` - `GatewayRails` and `AuthorizationRelay`: placeholder deposit addresses, every EVM call throws; replace with the NEAR checkout rail (`checkoutPayTx`, `checkoutDigest`, node checkout key).
- `apps/node/src/gateway/watcher.ts` - `chainTransferSource` returns nothing and `Flusher` is a no-op; poll `Chain.payments(openIds)` instead.
- `apps/node/src/gateway/refunds.ts` - `submit` answers 501; verify the merchant's own NEAR refund transaction.
- `apps/node/src/gateway/index.ts` - wallet authorization payments answer 501, `trackRelays` and `attestDue` are no-ops, the payment proof lists credits without chain evidence, and the gateway keeps `chainId = 0` and EVM `Address` types.
- `apps/node/src/gateway/payments.ts` - forwarder history (`previousForwarders`, `restoreForwarder`, `#rememberForwarder`) is a no-op.
- `apps/node/src/gateway/routes.ts` - payout changes are still proven with an EVM signature; move to a NEAR proof.
- `apps/node/src/gateway/screening.ts` - the payer-age rule never fires on NEAR.
- `apps/node/src/server.ts` - the token is cast to the gateway's EVM token type.
- `apps/node/src/settlement.ts` - settles through `Chain.settle` and recovers from the hub after a restart, but payout scheduling, gross-per-counterparty export (decision 9) and the refusal webhook (decision 8) are not built.
- `apps/node/migrations/001_near.sql` - the `payments` table still has EVM-era columns (`deposit_address`, `deposit_salt`, `flush_*`, `attest_*`, `created_block`); reshape with checkout.
- `apps/node/test/agents.test.ts` - the paid-skill block is skipped, and the key-rotation test expects 0 skill agents until that block runs again.
- Deleted EVM suites to rebuild on FakeChain: `gateway.test.ts`, `reports.test.ts`, `netting.test.ts` (replaced in part by `clearing.test.ts`), `proofs.test.ts`, `rpc.test.ts`, `token-meta.test.ts`, `e2e.test.ts` and `settlement.test.ts` (replaced by `clearing.test.ts`).
- `docker-compose.yml` and `.github/workflows/ci.yml` - no local chain profile and no stack health step until near-sandbox is wired.

### Clients stream

- `packages/sdk/src/paywall.ts` - the seller store of the latest voucher per Budget with an export (decision 4).
- `packages/sdk/src/gateway.ts` - gateway wire types are plain strings, and the payout signer is still EVM-shaped.
- `packages/sdk/test/gateway.test.ts`, `apps/mcp/test/merchant.test.ts`, `apps/mcp/test/mcp.test.ts` - gateway, merchant-tool and `pay_link` cases are `todo` until the gateway runs on NEAR.
- `apps/mcp/src/main.ts` - no chain reader is passed, so `prove_receipt` cannot check the hub yet.
- `apps/mcp/src/config.ts` - the agent key comes from the environment, not from the `payminto-agent keygen` file.
- `apps/agent/test/e2e.test.ts` - skipped; `agent-stack.ts` and `live.test.ts` were deleted.
- `apps/demo/src/{chain,stack,scenario,cli,config}.ts` - a minimal FakeChain demo labeled simulated; no near-sandbox path and no full story.
- `.github/workflows/ci.yml` - the demo step runs the FakeChain demo.

### Dashboard stream

- `apps/dashboard/lib/wallet.ts` - every NEAR Connect action throws `WalletNotConnectedError`.
- `apps/dashboard/lib/sign.ts` - opening a Budget on chain and the first deposit.
- `apps/dashboard/components/app/agent-wallet.tsx` - escrow funding.
- `apps/dashboard/components/checkout/checkout.tsx` - wallet pay and send-from-wallet.
- `apps/dashboard/components/gateway/refund-dialog.tsx` - the refund transaction.
- `apps/dashboard/components/operator/payout-proof.tsx` - the payout signature.
- `apps/dashboard/lib/payment-proof.ts` - NEAR chain checks are skipped, and the order hash still uses viem keccak.
- `apps/dashboard/lib/mock/gateway.ts` - `chain_id` 0, 0x accounts, no checkout authorization.

### Docs

- `README.md` and `docs/*.md` still describe HashKey and EVM; the spec puts the full rewrite last.

## Where viem remains

viem is gone from `packages/chain`, `packages/protocol` hub, policy, x402, chains and money, from the node clearing core (`chain`, `budgets`, `vouchers`, `policy-engine`, `settlement`, `funds`, `netting`, `proofs`, `store`, `ledger`, `config`, `api`), and from sdk, mcp, agent and demo.
It remains in `packages/protocol/src/gateway.ts`, the node gateway files listed above, `apps/node/src/search.ts` (address detection for gateway payers) and `apps/node/src/auth/service.ts` (a zero-address payout placeholder), the dashboard payment proof, and a few gateway tests, all owned by the Node and Dashboard streams.
