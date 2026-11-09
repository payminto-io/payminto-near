# Payminto Clearing - build spec

Payminto Clearing is a self-hosted clearinghouse for agent-to-agent payments on HashKey Chain.
It is the shared contract between everyone building this repo.
If something here is wrong, fix it here first, then in code.

## 1. The product in one paragraph

An owner (a person, a company treasury, or a Safe) signs one Mandate that gives an AI agent a bounded budget: total cap, per-call cap, daily cap, rate limit, allowed payees and an expiry.
The agent then pays any API, MCP tool or other agent per call with a gas-free signed cumulative Voucher, carried over the x402 v2 HTTP flow.
The provider's self-hosted Clearing Node checks every voucher against the mandate atomically, records it in a double-entry ledger, and returns a signed receipt.
Periodically, or on demand, the node clears hundreds of vouchers in one `settleBatch` transaction on the ClearingHub contract.
The hub verifies every signature and cap on chain, nets all obligations between all agents, and moves only the net amounts directly wallet to wallet.
Every net transfer is wrapped as an HSP payment whose `settlementBinding` is the batch id, and every individual call is provable against the batch Merkle root stored on chain.
Nobody, including the node operator, ever holds user funds.

## 2. Repository layout

| Path | Owner role | What |
|---|---|---|
| `contracts/` | Principal engineer | `ClearingHub.sol`, `MockStablecoin.sol` (local only), Foundry tests and deploy scripts. Done. |
| `packages/protocol/` | Principal engineer | Shared TS: ABI, chains, EIP-712 types, Merkle trees, policy, HSP wire v1, x402 headers, money. Done. |
| `packages/sdk/` | Backend engineer | `@payminto/sdk`: agent client, provider paywall, owner helpers. |
| `apps/node/` | Backend engineer | Clearing Node: HTTP API, SQLite store, policy engine, settlement worker, HSP adapter, SSE. |
| `apps/dashboard/` | Frontend engineer + UI/UX | Next.js operator console. |
| `apps/mcp/` | Agent engineer | MCP server that gives any MCP-capable agent a budgeted wallet. |
| `apps/demo/` | Agent engineer | Three paid provider services, three agents, and the scripted judge demo. |
| `docs/` | Marketing + hackathon strategist | Pitch, submission text, demo script, architecture. |

Runtime: Node 22.13 or newer (we develop on Node 26), pnpm 9, Foundry 1.5.
TypeScript runs directly through Node type stripping where possible (`node src/index.ts`), so only erasable syntax is allowed: no `enum`, no parameter properties, no namespaces.
Import local files with the `.ts` extension.
Shared code is imported as `@payminto/protocol` (workspace dependency `"@payminto/protocol": "workspace:*"`).

## 3. Contract facts (already implemented and tested)

`ClearingHub` EIP-712 domain: name `Payminto Clearing`, version `1`, chainId, verifyingContract = hub.

- `openMandate(Mandate m, bytes ownerSig) -> bytes32 mandateId` - anyone may submit; owner may be an EOA or ERC-1271 wallet.
- `openMandateWithPermit(Mandate m, bytes ownerSig, uint256 permitValue, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) -> bytes32 mandateId` - opens the mandate and calls the token's EIP-2612 `permit(agent, hub, ...)` in a try/catch, so the agent needs no native token and sends no transaction.
  If the permit call fails (front-run, expired, token without permit) the mandate still opens when the agent's allowance already covers `permitValue`; otherwise it reverts with `PermitFailed` and nothing is opened.
- `revokeMandate(bytes32 id)` - owner or agent; vouchers stay settleable for `REVOKE_GRACE` (1 hour).
- `settleBatch(bytes32 batchId, bytes32 receiptsRoot, address token, Claim[] claims) -> uint256 transfers` - permissionless; at most 64 claims; one token per batch; reverts `NothingToSettle` when the claims settle nothing (gross 0); stores `msg.sender` as the batch `settler`.
- `verifyReceipt(bytes32 batchId, bytes32 leaf, bytes32[] proof) -> bool` - only says the leaf is under the stored root; a proof counts only if `batches[batchId].settler` is the trusted node operator and that operator signed the leaf.
- Views: `mandates(id)`, `settled(id, payee)`, `batches(batchId)`, `mandateDigest`, `voucherDigest`, `settleDeadline`.
- Events: `MandateOpened`, `MandateRevoked`, `VoucherSettled(batchId, mandateId, payee, delta)`, `NetTransfer(batchId, from, to, amount)`, `BatchSettled(batchId, receiptsRoot, token, claims, gross, net, transfers)`.
- A Claim carries only the latest cumulative voucher per (mandate, payee); the hub pays `cumulative - settled[mandate][payee]`.
- Net transfers are `transferFrom(debtor, creditor)` so agents must `approve(hub, ...)` the token once, or sign a permit that the node submits with `openMandateWithPermit`.

All TS helpers for these live in `packages/protocol/src` and are tested against a live anvil deployment.
Use them; do not re-derive EIP-712 types or Merkle encodings anywhere else.

## 4. Networks

| Network | chainId | RPC | Token |
|---|---|---|---|
| HashKey Chain mainnet | 177 | https://mainnet.hsk.xyz | USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a` (6 dp) |
| HashKey Chain testnet | 133 | https://testnet.hsk.xyz | USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` (6 dp) |
| Local anvil | 31337 | http://127.0.0.1:8545 | `MockStablecoin`, address in `contracts/deployments/31337.json` |

`contracts/deployments/<chainId>.json` holds `{ clearingHub, token?, chainId, blockNumber }` after a deploy.
Local dev: `anvil` then `forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>`.

## 5. Clearing Node (`apps/node`)

### 5.1 Configuration (environment)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `CHAIN_ID` | `31337` | 31337, 133 or 177 |
| `RPC_URL` | network default | JSON-RPC |
| `HUB_ADDRESS` | from deployments file | ClearingHub |
| `TOKEN_ADDRESS` | network default or deployments file | settlement token |
| `OPERATOR_KEY` | required | node key: signs receipts, submits settlement txs (pays gas only) |
| `ADMIN_TOKEN` | required | bearer token for operator endpoints and the dashboard |
| `DB_PATH` | `./data/clearing.db` | SQLite file |
| `SETTLE_INTERVAL_SEC` | `0` (manual) | auto-settle period |
| `SETTLE_MIN_CALLS` | `1` | skip auto-settle below this many unsettled calls |
| `PUBLIC_URL` | `http://localhost:8787` | advertised in x402 requirements |
| `HSP_MODE` | `local` | `local` (built-in HSP adapter + verifier) or `coordinator` |
| `HSP_COORDINATOR_URL`, `HSP_API_KEY` | unset | required for `coordinator` mode |
| `HSP_CHAIN_NAME` | unset | coordinator mode: registry name used only when `GET /chains` has no entry for `CHAIN_ID` |
| `HSP_VERIFYING_CONTRACT` | the hub (local mode) | coordinator mode: a pin; the node refuses to start when `GET /chains` reports another contract for `CHAIN_ID` |
| `HSP_REQUIRED_CAPABILITIES` | empty | coordinator mode: comma-separated capabilities committed to in every HSP mandate and sent with each registration |
| `HSP_COSIGN_TIMEOUT_SEC` | `20` | how long a batch waits for debtor agents to co-sign HSP mandates |
| `CONFIRM_TAG` | `safe` on 133/177, `latest` on 31337 | head a settlement block must reach before the batch is `confirmed`: `latest`, `safe` or `finalized` |
| `TX_BUMP_AFTER_BLOCKS` | `5` | send a same-nonce replacement with fees raised 12.5 % when a transaction is not included after this many blocks |
| `TX_MAX_BUMPS` | `5` | replacements per transaction |
| `TX_INCLUSION_TIMEOUT_SEC` | `300` | how long the sender waits for inclusion before leaving the batch to the finality tracker |
| `RPC_RETRIES` | `4` | retries for transient JSON-RPC errors (network, timeouts, 429, 5xx) with exponential backoff and jitter |
| `RPC_FALLBACK_URLS` | network defaults | comma-separated fallback RPCs, `none` disables |
| `EAS_ATTEST` | `false` | attest every confirmed batch on the EAS predeploy (needs EAS code on the chain) |

Config is parsed and validated once at startup (zod), with clear errors, and never logged with secrets.

### 5.2 Storage

SQLite via `node:sqlite` (`DatabaseSync`), WAL mode, `PRAGMA foreign_keys=ON`, forward-only numbered SQL migrations in `apps/node/migrations/`.
Amounts are stored as decimal TEXT of atomic units and handled as `bigint` in code; never floats.
Every voucher acceptance runs in one `BEGIN IMMEDIATE` transaction so parallel calls cannot overspend.

Data safety (non-negotiable):
- Tests use a fresh temp-file database per test file (`mkdtemp`), never `DB_PATH`.
- Any reset or seed tool must refuse to run unless the target path ends in `.test.db` / `.demo.db`, or lives in the OS temp dir, or `--i-know-this-is-disposable` is passed. Put this guard in code.

Tables (suggested; refine as needed): `mandates`, `providers`, `calls`, `denials`, `batches`, `batch_claims`, `net_transfers`, `hsp_payments`, `ledger_entries`, `events`.

### 5.3 Lifecycle

1. Owner creates a mandate (SDK `OwnerClient` or dashboard) and posts it: `POST /v1/mandates` with `{ mandate: MandateJson, ownerSignature, policy, payees: Address[], label, permit? }`.
   The node checks `mandateId`, signature (EOA via `isMandateSignedBy`; for contract owners accept if `openMandate` succeeds), `policyHash(policy) == mandate.policyHash`, `payeesRoot(payees) == mandate.payeesRoot`.
   The node submits `openMandate` on chain itself (gas paid by operator) unless already open, then status becomes `open`.
   With `permit: { value, deadline, signature }` (an EIP-2612 permit by the agent for the hub, from `AgentClient.signPermit`) it submits `openMandateWithPermit` instead; a permit that fails without enough allowance is a `400 BAD_PERMIT`.
2. Agent wallet must hold the token and an allowance for the hub (`approve(hub, cap)`, or the permit above); the node tracks balance and allowance (refreshed on demand and every 30 s while there are unsettled calls).
3. Provider registers: `POST /v1/providers` (admin) with `{ name, description, payee, priceAtomic, resource, category }` -> `{ id, apiKey }`.
   The API key is shown once and stored hashed (sha256).
4. Call: agent hits provider -> 402 with requirements -> agent signs voucher with `cumulative = position + price` -> provider middleware calls `POST /v1/vouchers` (provider key) -> node validates and returns a `ClearingReceipt` or a denial -> provider serves or refuses.
5. Settle: `POST /v1/settlements` (admin) or the interval worker.
   The node takes all `accepted` calls for the token, the latest voucher per (mandate, payee), builds the receipts tree over every call, and picks `batchId = keccak256(abi.encode(chainId, hub, receiptsRoot, batchSeq))`.
   It computes net positions off chain, pre-checks each debtor's balance and allowance, and drops mandates that cannot pay (those calls stay `accepted` and a denial-style warning event is emitted).
   It screens every agent and payee with the token's `isBlacklisted` (FiatToken, as USDC.e) in one Multicall3 read and drops claims that touch a blacklisted address with a `funds.warning`; tokens without the function have no blacklist.
   Pairs that still have calls in an unconfirmed batch wait for the next batch.
   It splits into chunks of at most 64 claims.
   HSP co-sign phase: for each projected net transfer it creates an HSP mandate (`buildNetTransferMandate`) and waits up to `HSP_COSIGN_TIMEOUT_SEC` for the debtor agent to co-sign (see 5.5).
   It simulates, checks the operator can pay gas plus the OP Stack L1 data fee, and sends `settleBatch` (status `submitted`, the signed transaction is stored); if it is not included after `TX_BUMP_AFTER_BLOCKS` blocks it sends a same-nonce replacement with fees raised 12.5 %.
   At one confirmation the batch is `included`: block, gas used and `l1Fee` (from the OP Stack receipt) are recorded and nothing is booked yet.
   Once the block is at or below the `CONFIRM_TAG` head (immediately for `latest`) the batch is `confirmed`: it decodes `NetTransfer` events, compares them with the projection, marks calls `settled`, writes ledger entries, attests on EAS when `EAS_ATTEST=true`, then runs the HSP step for each net transfer.
   A finality tracker (every 2 s and at startup) does the promotion; when a reorg removes the transaction it rebroadcasts the stored signed transaction with the same nonce, and fails the batch (returning its calls to `accepted`) only when the hub has no record of it and its nonce now belongs to another transaction.
6. Revoke: `POST /v1/mandates/:id/revoke` (admin, or agent-signed) stops new vouchers immediately and submits `revokeMandate` when the operator is the owner's delegate; otherwise the dashboard shows the owner the call to make.

### 5.4 Voucher validation order (each failure -> a recorded denial with a `DenialRule`)

UNKNOWN_MANDATE, MANDATE_REVOKED, MANDATE_NOT_ACTIVE, TOKEN_MISMATCH, PAYEE_NOT_ALLOWED, PRICE_MISMATCH, PER_CALL_CAP, BAD_SIGNATURE, STALE_CUMULATIVE, RATE_LIMIT, DAILY_CAP, TOTAL_CAP, INSUFFICIENT_FUNDS.
STALE_CUMULATIVE responses include the current position so the SDK can re-sign and retry.
TOTAL_CAP counts settled plus accepted-unsettled spend.
INSUFFICIENT_FUNDS compares the agent's outstanding unsettled total plus this call with min(balance, allowance).

### 5.5 HSP integration

Every net transfer of a batch becomes one HSP payment.
- The HSP mandate (wire v1) is built with `buildNetTransferMandate({ payer: debtor, recipient: creditor, token, amount, chainId, batchId, deadline })`, so `settlementBinding = batchId`.
- Debtor agents co-sign: the SDK `AgentClient` polls `GET /v1/agents/:address/cosign` (or receives it in the voucher response as `pendingCosign`) and posts `POST /v1/cosign/:hspPaymentId` with `{ signerProof }`.
  The node verifies with `isHspMandateSignedBy`.
  If a debtor does not co-sign in time, the batch still settles on the strength of its vouchers, and that transfer's HSP record is `UNSIGNED` (shown clearly, never hidden).
- `HSP_MODE=local`: after the batch is confirmed, the node acts as the HSP adapter: it checks the `NetTransfer` log matches (payer, recipient, token, amount, batchId), signs a Receipt with the operator key over `{ paymentId, txHash, logIndex, satisfiedCapabilities }`, and runs `hspVerify(required, satisfied)` with satisfied = `proves:settlement-verified:v1`, `proves:payminto-mandate-bound:v1`, `proves:payminto-netting-batch:v1`, plus `attests:payminto-batch-settled:v1` when the batch's EAS attestation (schema `bytes32 batchId,bytes32 receiptsRoot,uint256 gross,uint256 net,uint256 transfers`, attester the operator, recipient the hub) verifies on chain. Status `ACCEPT` or `REJECT`.
- `HSP_MODE=coordinator`: at startup `GET {coordinator}/chains`, resolve this chain by `chainId` (registry name and `verifyingContract`; `HSP_CHAIN_NAME` only as a fallback) and refuse to start when a pinned `HSP_VERIFYING_CONTRACT` differs.
  Per payment `POST {coordinator}/payments` with `{ chain, mandate: { body: wire, signerProof, requiredCapabilities }, attestations: [] }` where `requiredCapabilities` is `HSP_REQUIRED_CAPABILITIES` (the same set hashed into the mandate), then `POST /payments/:id/observe` with `{ txHash }` retrying with backoff on 202, then `GET /payments/:id` until `SETTLED`. Bearer `HSP_API_KEY`. Failures are recorded, retried by a worker, and never block the clearing ledger.
- Implement both behind one `HspPort` interface so swapping in the official `@hsp/sdk` later is mechanical.

### 5.6 HTTP API

All JSON. Amounts are decimal strings of atomic units. Addresses are checksummed. Errors are `{ error: { code, message, details? } }` with proper status codes.
Auth: `Authorization: Bearer <ADMIN_TOKEN>` for admin routes, `Authorization: Bearer <provider apiKey>` for provider routes. Public routes need none. CORS allows the dashboard origin.

Public:
- `GET /healthz` -> `{ ok, chainId, hub, token, operator, blockNumber, hspMode }`
- `GET /v1/info` -> network, hub, token `{ address, symbol, decimals }`, explorer base, node operator address, version, `hsp: { mode, verifyingContract, requiredCapabilities, cosignTimeoutSec }` (the resolved HSP domain) and `settlement: { intervalSec, minCalls, maxClaimsPerBatch, confirmTag, easAttest }`.
- `GET /v1/providers` -> public catalog `[{ id, name, description, payee, priceAtomic, resource, category, calls24h }]`.
- `GET /v1/mandates/:id/position?payee=0x..` -> `{ mandateId, payee, cumulative, settled }` (agents use this to sign the next voucher).
- `GET /v1/mandates/:id/policy` -> `{ id, status, mandate: MandateJson, policy, payees }`, so agents can enforce their own policy before signing (they verify `policyHash` and `payeesRoot` against the mandate).
- `GET /v1/receipts/:callId/proof` -> `{ receipt, batchId, receiptsRoot, proof, leaf, txHash, explorerUrl, onchainVerified? }` (`onchainVerified` is true only if the batch settler is this node's operator, the operator signed the leaf, and `verifyReceipt` accepts the proof).
- `GET /v1/agents/:address/cosign` -> pending HSP mandates to sign `[{ hspPaymentId, typedData }]` (typed data JSON-safe: bigints as strings).
- `POST /v1/cosign/:hspPaymentId` `{ signerProof }`.
- `GET /v1/events` -> Server-Sent Events stream (see 5.7). Requires the admin token: `Authorization: Bearer` or `?token=<ADMIN_TOKEN>` (EventSource cannot set headers).

Provider:
- `POST /v1/vouchers` body `VoucherPayment` (from `x402.ts`) plus `{ providerId, requestHash }` -> `200 { receipt: ClearingReceipt, position }` or `402 { error: { code: <DenialRule>, message, details: { position? } } }`.

Admin:
- `GET /v1/overview` -> totals: volume settled/pending, calls (24h, all), denials (24h), active mandates, providers, batches, gas saved estimate, compression ratio (calls per on-chain transfer), last batch.
- `GET /v1/mandates` / `GET /v1/mandates/:id` (with spend: settled, pending, today, remaining, recent calls, denials).
- `POST /v1/mandates` (see 5.3), `POST /v1/mandates/:id/revoke`.
- `GET /v1/providers/:id`, `POST /v1/providers`.
- `GET /v1/calls?mandateId=&payee=&status=&limit=&cursor=`.
- `GET /v1/denials?limit=`.
- `GET /v1/batches`, `GET /v1/batches/:id` (claims, net transfers with HSP status, tx hash, explorer link, gross, net, calls).
- `POST /v1/settlements` -> starts a settlement; returns `{ batchIds }` or `{ skipped: reason }`.
- `POST /v1/mandates` takes an optional `permit: { value, deadline, signature }` (EIP-2612 by the agent for the hub); errors `400 BAD_PERMIT`.
- `GET /v1/ledger?account=&limit=` and `GET /v1/ledger/trial-balance` (must always balance to zero).
- `GET /v1/netting/preview` -> what settling now would do: gross obligations graph `[{ from, to, amount, calls }]`, net transfers, compression.

### 5.7 SSE events

`event: <type>` with JSON `data`. Types: `call.accepted`, `call.denied`, `mandate.opened`, `mandate.revoked`, `batch.started`, `batch.submitted`, `batch.included`, `batch.confirmed`, `batch.failed`, `hsp.updated`, `funds.warning`.
`batch.submitted` repeats for every same-nonce replacement and when a reorg sends a batch back to `submitted`; `batch.confirmed` repeats once more when the batch's EAS attestation lands.
Every payload carries `id`, `at` (ISO time) and the relevant entity in its API shape.

### 5.8 Ledger

Double-entry, every journal balances.
Accounts: `agent:<addr>:payable`, `provider:<addr>:receivable`, `agent:<addr>:wallet`, `provider:<addr>:wallet`.
Call accepted: debit `provider:<payee>:receivable`, credit `agent:<agent>:payable`.
Batch settled: for each voucher delta, debit `agent:<agent>:payable`, credit `provider:<payee>:receivable`; for each net transfer, debit `<creditor>:wallet`, credit `<debtor>:wallet`.
Refunds (if implemented) are a negative call that offsets the next batch.

### 5.9 Response shapes (pinned)

These are the exact JSON shapes `apps/node` serves and `apps/dashboard` parses; change them here first.
Ids (mandate, call, batch, HSP payment) are lowercase 0x hex; addresses are checksummed; amounts are decimal strings of atomic units; `*At` fields are ISO-8601 UTC; `timestamp` fields are unix seconds.
List routes return bare arrays, except `GET /v1/calls` which returns `{ items, nextCursor }` (pass `cursor=<nextCursor>` for the next page).

```ts
Call = { id, seq, mandateId, agent, payee, providerId, amount, cumulative, requestHash, timestamp, createdAt,
         status: "accepted" | "settling" | "settled", batchId: string | null, leaf }
Denial = { id, rule: DenialRule, message, mandateId, agent: string | null, payee, providerId, amount, cumulative,
           requestHash, details: { position?: Position, ...ruleSpecific }, timestamp, createdAt }
Position = { mandateId, payee, cumulative, settled }
Mandate = { id, label, status: "pending" | "open" | "revoked" | "expired", mandate: MandateJson, owner, agent, token,
            totalCap, expiresAt, payees, policy, openTxHash, revokedAt, createdAt, calls: number,
            spend: { settled, pending, total, today, remaining }, agentBalance: string | null, agentAllowance: string | null }
MandateDetail = Mandate & { ownerSignature, revokedBy, revokeTxHash, openTxExplorerUrl,
            onchain: { open: false } | { open: true, spent, totalCap, revokedAt: number | null, validUntil: number } | null,
            positions: [{ payee, cumulative, settled, pending }], recentCalls: Call[], denials: Denial[],
            spendSeries: [{ day: "YYYY-MM-DD", amount, calls }],           // last 14 UTC days
            spendRecent: [{ at: ISO minute, amount, calls }],              // last 30 minutes
            onboarding: { gaslessPermit: boolean, agentTransactions: number, agentNativeBalance } | null }  // read from chain
Provider = { id, name, description, payee, priceAtomic, resource, category, calls24h }
ProviderDetail = Provider & { createdAt, callsTotal, denials: number, revenue: { settled, pending }, recentCalls: Call[] }
ProviderCreated = Provider & { createdAt, apiKey }                           // apiKey shown once
Batch = { id, seq, status: "building" | "cosigning" | "submitted" | "included" | "confirmed" | "failed", token, receiptsRoot,
          claims, calls, transfers, gross, net, projectedGross, projectedNet, compression: number | null,
          reconciled: boolean | null, txHash, explorerUrl, blockNumber, gasUsed, l1Fee: string | null, replacements: number,
          error, trigger, createdAt, submittedAt, includedAt: string | null, confirmedAt,
          attestation: { uid, txHash, explorerUrl } | null }
// included = one confirmation (nothing booked yet); confirmed = block at or below the CONFIRM_TAG head (ledger, HSP, EAS done).
// l1Fee is the OP Stack L1 data fee in wei from the receipt (null off OP Stack chains); replacements counts same-nonce fee bumps.
BatchDetail = Batch & { claimList: [{ index, mandateId, agent, payee, cumulative, previous, delta, calls }],
          netTransfers: [{ index, from, to, amount, logIndex, hsp: Hsp | null }], callList: Call[] }
Hsp = { paymentId, batchId, transferIndex, payer, recipient, token, amount, deadline,
        status: "PENDING" | "COSIGNED" | "UNSIGNED" | "SUBMITTED" | "ACCEPT" | "REJECT" | "SETTLED" | "FAILED",
        cosigned: boolean, reason: string | null, requiredCapabilities, satisfiedCapabilities, receipt, coordinatorId,
        coordinatorStatus, txHash, logIndex, attempts, createdAt, updatedAt }
```

- `GET /v1/overview` -> `{ volume: { settled, pending, last24h }, calls: { all, last24h, pending, settled }, denials24h, denialsTotal, activeMandates, mandates, providers, batches, batchesConfirmed, batchesFailed, transfers, gasSaved: { gas, native: string | null, used, naive, perTransferAssumption }, compressionRatio, lastBatch: Batch | null, unsettledCalls, token: { address, symbol, decimals } }`.
  `compressionRatio` is settled calls per on-chain transfer and is `0` before the first transfer; `gasSaved` compares against one ERC-20 transfer per call at the gas measured in `docs/GAS.md` (34,444).
- `GET /v1/netting/preview` -> `{ calls, claims, batches, grossTotal, netTotal, gross: [{ from, to, amount, calls }], net: [{ from, to, amount }], transfers, compression, savedTransfers }` (`compression` is `0` when there is nothing to settle).
- `POST /v1/settlements` -> `{ batchIds, batches: Batch[], dropped: [{ mandateId, payee, reason }] }` or `{ skipped: reason }`; it returns once each batch is included (and already confirmed when `CONFIRM_TAG=latest`, the anvil default) or failed; the finality tracker confirms the rest.
  `dropped[].reason` includes `agent 0x.. is blacklisted by the settlement token` and `payee 0x.. is blacklisted by the settlement token`.
- `GET /v1/receipts/:callId/proof` -> `{ receipt: ClearingReceipt, status, batchId, batchStatus, receiptsRoot, proof, leaf, txHash, explorerUrl, onchainVerified }`; batch fields are `null` and `proof` is `[]` until the call is batched, and `onchainVerified` is `null` until the batch is confirmed.
- `GET /v1/ledger` -> `[{ id, journalId, kind, ref, account, debit, credit, memo, createdAt }]`; `account` also matches a prefix such as `agent:0x...`.
- `GET /v1/ledger/trial-balance` -> `{ balanced, totalDebit, totalCredit, balance, journals, accounts: [{ account, debit, credit, balance }] }`, where `balance` is always `"0"`.
- `GET /v1/agents/:address/cosign` -> `[{ hspPaymentId, batchId, payer, recipient, token, amount, deadline, calls: [{ callId, mandateId, payee, amount, cumulative }], typedData: { domain, types, primaryType: "Mandate", message: HspWireMandate } }]`.
- `POST /v1/mandates/:id/revoke` -> `{ mandate: Mandate, onchain: { revoked, submitted, txHash, call: { to, functionName, args, data, allowedSenders } | null } }`.
  Without the admin token the body must be `{ signature }`: an EIP-191 signature by the agent or owner over `Payminto Clearing: revoke mandate <lowercase mandateId>`.
- SSE: `event: <type>`, `id: <event id>` and `data: { id, at, type, <entity> }` where the entity key is `call` (call.accepted), `denial` (call.denied), `mandate` (mandate.*), `batch` (batch.*, a `Batch`), `hspPayment` (hsp.updated, an `Hsp`) or `warning` (funds.warning: `{ agent?, mandateId?, payee?, reason, required?, outstanding?, balance?, allowance? }`).
  A `ready` event opens the stream, `: ping` comments keep it alive every 15 s, and `Last-Event-ID` (or `?since=<id>`) replays missed events.
- Provider-route errors that are not denials: `400 NETWORK_MISMATCH | PAYEE_MISMATCH | REQUEST_HASH_MISMATCH | VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 PROVIDER_MISMATCH`.

## 6. SDK (`packages/sdk`, `@payminto/sdk`)

```ts
// Owner side
const owner = new OwnerClient({ nodeUrl, chainId, hub, account /* viem Account */, publicClient? });
const { mandate, mandateId, ownerSignature } = await owner.createMandate({
  agent, token, totalCap, validForSeconds, payees, policy,
});
await owner.submit({ mandate, ownerSignature, policy, payees, label }); // POST /v1/mandates

// Agent side
const agent = new AgentClient({ nodeUrl, chainId, hub, account, mandateId, storePath: "./agent.receipts.db", autoCosign: true });
await agent.ensureAllowance(walletClient, amount); // one-time approve(hub), the agent pays gas
// or gasless: an EIP-2612 permit (read-only calls), which the node submits with openMandateWithPermit
const permit = await agent.signPermit({ token, value: cap, publicClient });
await owner.submit({ mandate, ownerSignature, policy, payees, label, permit }); // the agent sends 0 transactions
const res = await agent.fetch("https://provider.example/quote?pair=HSK-USDC"); // handles 402 -> voucher -> retry
agent.on("receipt", r => ...); agent.on("denied", d => ...);
agent.startCosignLoop(); // signs pending HSP mandates for its own net debits, verifying amounts against its own receipts
// signPermit takes the token's EIP-712 domain from chains.ts for the network token (USDC.e: "Bridged USDC", version "2"),
// else from ERC-5267 eip712Domain(), and refuses unless it matches the token's DOMAIN_SEPARATOR().

// Provider side (framework-agnostic fetch handler wrapper, plus a Hono middleware)
const pay = paywall({ nodeUrl, providerId, apiKey, price, description });
app.get("/quote", pay.hono(), handler);            // Hono
export default { fetch: pay.wrap(handler) };       // any fetch handler
```

Agent `fetch` behaviour: on 402 with a `payminto-voucher` requirement, read position from the configured node, sign `cumulative = position + amount`, retry once with `PAYMENT-SIGNATURE`; on `STALE_CUMULATIVE` re-read the position from the configured node and retry up to 3 times with jitter; serialize vouchers per (mandate, payee) inside the client to avoid self-races.
`nodeUrl` is required; the agent never reads a position or a node identity from a provider response.
The agent never signs a cumulative above the highest cumulative it has signed for that (mandate, payee), from its own durable store, plus the amount; a node position above that is refused with `POSITION_UNVERIFIED` and nothing is signed.
A paid receipt is accepted only if it matches the signed voucher and is signed by the operator address from the configured node's `GET /v1/info`.
Receipts, signed positions and co-sign totals live in a `ReceiptStore`; `storePath` selects the durable `SqliteReceiptStore`, and processes sharing one agent key must share one store.
Policy is enforced twice: by the agent before signing and by the node before accepting; total cap, allowlist and expiry a third time on chain.
`AgentClient` checks MANDATE_NOT_ACTIVE, TOKEN_MISMATCH, PAYEE_NOT_ALLOWED, PER_CALL_CAP, RATE_LIMIT, DAILY_CAP and TOTAL_CAP before signing, using a policy verified against the mandate, and a refused call emits `denied` with that rule and produces no signature.
The agent co-sign loop must refuse to sign an HSP mandate whose amount exceeds what its own accepted receipts justify for that batch (defence against a malicious node).

## 7. MCP server (`apps/mcp`)

MCP SDK (latest 1.x), `registerTool` API, stdio transport plus Streamable HTTP on port 3334.
Tools: `list_paid_services`, `call_paid_service { serviceId | url, method, query, body }`, `get_budget` (caps, spent, remaining, today), `get_receipts { limit }`, `prove_receipt { callId }`.
Configured with an agent key and mandate id via env; spending goes through `AgentClient`, so every MCP tool call is mandate-bound.
Receipts and signed positions persist in `RECEIPT_STORE_PATH` (default under `PAYMINTO_DATA_DIR`, `~/.payminto`), so a restarted server keeps co-signing and paying.
`prove_receipt` reports a call as proven only if the batch settler is the node operator, the operator signed the leaf, and `verifyReceipt` accepts the path.

## 8. Demo (`apps/demo`)

Three provider services on ports 4101-4103, each with its own payee wallet and price:
- `Market Data` (0.002 USDC per quote): HSK and BTC prices; uses a live public price source with a deterministic fallback.
- `Risk Scan` (0.01 USDC per address): wallet risk score (deterministic heuristic, labelled as such).
- `Research Writer` (0.05 USDC per brief): itself an agent that buys Market Data and Risk Scan to compose a brief, so it is both payee and payer and netting is visible.
Agents: `Treasury Agent` (owner-capped) and `Trading Agent`, plus a scripted "prompt injection" step that tries to pay an unlisted payee and a step that exceeds the per-call cap; both must be denied with the rule shown.
`pnpm demo` runs: start anvil, deploy, start node, start providers, create mandates, run ~500 calls in parallel, settle, print a summary (calls, gross, net, transfers, compression ratio, gas saved, explorer links) and one Merkle proof checked on chain.

## 9. Dashboard (`apps/dashboard`)

Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui, lucide icons, Recharts, TanStack Query, live updates through SSE.
Pages:
- **Overview**: KPI row (settled volume, calls today, compression ratio "N calls per on-chain transfer", gas saved, denials today, active mandates), live call stream, settlement timeline.
- **Mandates**: list with spend bars; detail with policy, on-chain state, spend over time, calls, denials, revoke button. Create-mandate wizard that signs with the connected wallet (EIP-1193) or a dev key in local mode.
- **Providers**: catalog, register provider (shows API key once), per-provider revenue.
- **Netting**: the signature view. Left: gross obligations graph between agents and providers. Right: the net transfers the hub will execute. A "Settle now" button, then the animated result with tx link.
- **Batches**: list and detail with claims, net transfers, HSP status per transfer (ACCEPT, SETTLED, UNSIGNED, REJECT), explorer links.
- **Receipt proof**: paste or click a call id, see the receipt, Merkle path and the on-chain `verifyReceipt` result.
- **Ledger**: journal and trial balance (shows it is zero).
- **Settings**: node info, network, hub, token, HSP mode, operator address and gas balance.
Design bar: calm, precise, institutional fintech; not a crypto casino look. Light and dark themes. Every number has units. Addresses are truncated with copy and explorer links. Empty, loading and error states are designed, not default.

## 10. Quality bar

- TypeScript strict, no `any` in exported APIs, zod at every trust boundary.
- Unit tests for the policy engine (every DenialRule), netting projection (matches contract results), ledger balance, HSP adapter, SDK retry logic.
- One end-to-end test that boots anvil, deploys, runs node + a provider + an agent in-process, makes calls, settles, and verifies balances and a proof on chain.
- Lint and typecheck clean. No em dash characters anywhere in code, UI copy or docs (use "-").
- In Markdown, one sentence per line.
