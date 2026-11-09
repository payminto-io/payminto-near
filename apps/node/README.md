# Payminto Clearing Node

The self-hosted node that checks every agent voucher against its mandate, records it in a double-entry ledger, and clears batches of vouchers on the `ClearingHub` contract.
It never holds user funds: settlement moves net amounts directly wallet to wallet through the hub.
The build contract is `docs/SPEC.md` section 5; this file covers running and configuring it.

## Run it locally

From the repository root:

```sh
pnpm install
scripts/dev-local.sh
```

The script starts `anvil` on port 8545 if nothing answers there, deploys `ClearingHub` and `MockStablecoin` with `forge script script/DeployLocal.s.sol` (anvil key 0), and starts the node with anvil key 9 as `OPERATOR_KEY` and `ADMIN_TOKEN=dev-admin-token`.
It refuses to run against anything that is not chain 31337.
Each deployment gets its own SQLite file under `apps/node/data/`, because a database is bound to one chain, hub and token and the node refuses to mix them.

To run the node alone against an existing deployment:

```sh
cp apps/node/.env.example apps/node/.env   # edit as needed
pnpm --filter @payminto/node start         # or dev; both load apps/node/.env, shell variables win
```

Node 22.18 or newer is required (type stripping and `node:sqlite`); `start` and `dev` check the runtime first and say so clearly.
Production concerns (TLS, backups with `pnpm --filter @payminto/node backup`, upgrades, `/metrics`, key handling) are in `docs/OPERATIONS.md`.

`dev` reads `contracts/deployments/<CHAIN_ID>.json` for `HUB_ADDRESS` and `TOKEN_ADDRESS` unless they are set.
Stop with Ctrl-C or SIGTERM: the node stops accepting requests, closes SSE streams, lets an in-flight settlement finish booking, and closes the database.

## Configuration

All variables are validated once at startup with zod.
Errors name the variable and never print its value, and logs never contain keys or tokens.

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (the Docker image uses `0.0.0.0`) |
| `CHAIN_ID` | `31337` | 31337, 133 or 177 |
| `RPC_URL` | network default | JSON-RPC endpoint |
| `RPC_FALLBACK_URLS` | network fallbacks on 133/177 | Comma-separated endpoints tried when `RPC_URL` fails; `none` disables |
| `DEPLOY_BLOCK` | deployments file `blockNumber` | First block of the on-chain revocation scan; required on 133/177 without it |
| `HUB_ADDRESS` | deployments file | ClearingHub address |
| `TOKEN_ADDRESS` | deployments file, then network default | Settlement token |
| `OPERATOR_KEY` | required | Signs receipts and HSP adapter receipts, submits `openMandate` and `settleBatch` (gas only); public anvil/hardhat keys are refused on 133/177 |
| `ADMIN_TOKEN` | required (12+ chars) | Bearer token for admin routes, `/metrics`, the dashboard and SSE; 32+ chars and not `dev-admin-token` on 133/177 |
| `DB_PATH` | `./data/clearing.db` | SQLite file (WAL mode) |
| `SETTLE_INTERVAL_SEC` | `0` | Auto-settle period; 0 means manual only |
| `SETTLE_MIN_CALLS` | `1` | Auto-settle skips below this many unsettled calls |
| `PUBLIC_URL` | `http://localhost:8787` | Node URL advertised to agents in x402 requirements |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated dashboard origins |
| `HSP_MODE` | `local` | `local` (built-in adapter and verifier) or `coordinator` |
| `HSP_COORDINATOR_URL`, `HSP_API_KEY` | unset | Required in `coordinator` mode |
| `HSP_CHAIN_NAME` | unset | Coordinator mode: registry name used only when `GET /chains` has no entry for `CHAIN_ID` |
| `HSP_VERIFYING_CONTRACT` | the hub (local mode) | Coordinator mode: pin checked against `GET /chains`; the node refuses to start on a mismatch |
| `HSP_REQUIRED_CAPABILITIES` | empty | Coordinator mode: comma-separated capabilities committed to in every HSP mandate |
| `CONFIRM_TAG` | `safe` on 133/177, `latest` on 31337 | Head (`latest`, `safe`, `finalized`) a settlement block must reach before the batch is confirmed and booked |
| `TX_BUMP_AFTER_BLOCKS`, `TX_MAX_BUMPS` | `5`, `5` | Same-nonce replacement with fees +12.5 % when a transaction is not included after this many blocks |
| `TX_INCLUSION_TIMEOUT_SEC` | `300` | The sender gives up waiting after this; the finality tracker keeps watching the batch |
| `RPC_RETRIES` | `4` | Retries on network errors, timeouts, 429 and 5xx, with exponential backoff and jitter |
| `EAS_ATTEST` | `false` | Attest every confirmed batch on the EAS predeploy (HashKey Chain only) |
| `HSP_COSIGN_TIMEOUT_SEC` | `20` | How long a batch waits for debtor agents to co-sign HSP mandates |
| `FUNDS_REFRESH_SEC` | `30` | Balance and allowance refresh period while calls are unsettled |
| `DEPLOYMENTS_DIR` | `contracts/deployments` | Where `<chainId>.json` is read from |
| `RATE_LIMIT_PROVIDER_RPS`, `RATE_LIMIT_PROVIDER_BURST` | `200`, `1000` | Token bucket per provider key on `POST /v1/vouchers` (0 rps disables) |
| `RATE_LIMIT_IP_RPS`, `RATE_LIMIT_IP_BURST` | `100`, `1000` | Token bucket per client IP for requests without the admin token (0 rps disables) |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies whose `X-Forwarded-For` entries are trusted for the client IP |
| `DENIAL_DEDUP_SEC` | `60` | Identical denials within this window fold into one row with a `repeats` count |
| `DENIALS_MAX_ROWS`, `EVENTS_MAX_ROWS` | `100000`, `200000` | Oldest denial and event rows beyond these are pruned every minute |
| `BACKUP_DIR` | `./backups` | Output directory of `pnpm --filter @payminto/node backup` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (JSON lines on stdout) |

## How a call is cleared

Policy is enforced twice: by the agent before signing and by the node before accepting; total cap, allowlist and expiry a third time on chain.
Agents fetch the policy they enforce from the public `GET /v1/mandates/:id/policy` and verify it against the mandate hashes (see `packages/sdk/README.md`).

1. The provider's paywall (`@payminto/sdk`) forwards the agent's voucher to `POST /v1/vouchers`.
2. The node verifies the voucher signature (EOA, or ERC-1271 for contract agents), then loads mandate state and evaluates every rule in the SPEC 5.4 order inside one `BEGIN IMMEDIATE` transaction, so parallel calls cannot overspend.
3. An accepted call gets a receipt signed by the operator over its Merkle leaf, a ledger journal (debit provider receivable, credit agent payable), and a `call.accepted` event; a refused call gets a recorded denial with its rule.
4. `POST /v1/settlements` (or the interval worker) takes the latest voucher per (mandate, payee) of pairs with no batch in flight, checks each mandate and settled position on chain, screens every party against the token blacklist (USDC.e `isBlacklisted`, one Multicall3 read), drops agents whose wallet cannot fund their projected net debit, and splits the claims into chunks of at most 64.
5. Per chunk it builds the receipts tree, derives `batchId = keccak256(abi.encode(chainId, hub, receiptsRoot, seq))`, creates one HSP mandate per projected net transfer and waits for debtor co-signatures, simulates, preflights the operator balance against gas plus the L1 data fee, and sends `settleBatch` (replacing it with the same nonce and higher fees if it is not included in time).
   At one confirmation the batch is `included`; once its block is at or below the `CONFIRM_TAG` head the node decodes `NetTransfer` events, reconciles them with the off-chain projection, books the ledger and marks the batch `confirmed`. With `EAS_ATTEST=true` it then attests the batch on EAS.
6. HSP: in `local` mode the node observes the settlement, signs an adapter receipt and runs the verifier (`ACCEPT` or `REJECT`); transfers whose debtor did not co-sign are `UNSIGNED`.
   In `coordinator` mode co-signed mandates are registered with the HashKey Coordinator and observed until `SETTLED`; failures are retried in the background and never block the ledger.

Interrupted batches are recovered on restart: unsent batches are failed and their calls return to `accepted`, sent ones are handed to the finality tracker.
The tracker (every 2 s) confirms batches, follows a transaction into a different block after a reorg, rebroadcasts a reorged-out settlement's stored signed transaction, and fails a batch only when the hub has no record of it and its nonce belongs to another transaction.
`POST /v1/mandates` with a `permit` (EIP-2612 by the agent) opens the mandate with `openMandateWithPermit`, so the agent needs no HSK.

## Data safety

Tests always use a fresh `mkdtemp` directory and never `DB_PATH`.
The only destructive tool is `pnpm --filter @payminto/node db:reset <path>`, which deletes a database file and refuses unless the path ends in `.test.db` or `.demo.db`, lives in the OS temp dir, or `--i-know-this-is-disposable` is passed (guard in `src/db/guard.ts`).
It also refuses the `DB_PATH` of the current environment unless that flag is given.

## Tests

```sh
pnpm --filter @payminto/node test        # unit, integration and end-to-end (boots its own anvil on a random port)
pnpm --filter @payminto/node typecheck
pnpm --filter @payminto/node test:fork   # opt-in: HashKey Chain testnet fork (anvil --fork-url), see docs/HASHKEY.md section 9
```

`test/hashkey.test.ts` covers finality at the safe head, both reorg outcomes, same-nonce replacement, blacklist screening, permit onboarding, the operator fee preflight and the Coordinator chain registry against a real anvil.

`test/e2e.test.ts` deploys the contracts, starts the node in-process on a temp database, serves two provider apps behind the SDK paywall, runs about 50 parallel paid calls from two agents (one of them also a payee, so netting happens) plus denied calls, settles, and checks balances, netting, HSP records, the trial balance and an on-chain `verifyReceipt` proof.
