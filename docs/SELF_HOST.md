# Run your own Payminto

This guide takes you from a clean checkout to a clearing node and dashboard of your own.
It is written for a person or for an AI coding agent working for one.

Funds are escrowed in an unaudited contract, and the node runs on a local sandbox or NEAR testnet only.
There is no mainnet node mode.
Read [SECURITY.md](SECURITY.md) before you rely on any of it.

## Rules for an AI agent following this guide

- Steps marked "human step" send transactions or create accounts on NEAR testnet.
  Do not run them: print the command and stop.
- Never write a secret into a file that git tracks, and never print one.
  `apps/node/.env` and the root `.env` are git-ignored.
- The only tool that deletes a database is `pnpm --filter @payminto/node db:reset`, and it refuses any path not marked disposable.
  Do not pass `--i-know-this-is-disposable` for a database you did not create in this session.

## What you run

| Piece | What it is | Default address |
|---|---|---|
| Hub | The contract on NEAR that escrows Budgets and stores batch roots | An account you deploy to, or an existing hub |
| Clearing node | `apps/node`: checks vouchers, settles, pays out, serves the API | `http://localhost:8787` |
| Dashboard | `apps/dashboard`: the console and the hosted checkout | `http://localhost:3000` |
| Relayer (optional) | `apps/relayer`: pays the gas for an owner's revoke, so an owner who holds only USDC can stop an agent | `http://127.0.0.1:8790` |

`pnpm local` runs all four on a sandbox (a local NEAR node) with one command, for development and evaluation; section 1 explains it.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22.18 or newer (`.nvmrc` says 22) | Everything; the code runs as TypeScript through Node's type stripping and uses `node:sqlite` |
| pnpm | 9 (`packageManager` pins 9.15.9) | Installing the workspace |
| Docker with Compose | any recent | Only for the Docker path |
| Rust 1.99.1 and cargo-near | pinned in `contracts-near/rust-toolchain.toml` | Only to rebuild the contract; the built `hub.wasm` is committed |

```sh
pnpm install
```

## 1. See it run once

### The whole product on this machine: `pnpm local`

```sh
pnpm local
```

`pnpm local` (`apps/local`) starts the whole product on a sandbox (a local NEAR node) for a person to use in a browser.
It needs no testnet account, no wallet extension and no secret, and it never reaches testnet or mainnet.

What it starts, in order:

1. A fresh near-sandbox 2.14.0 node on 127.0.0.1.
2. The mock USDC token, and the hub from the committed `contracts-near/out/hub.wasm`, deployed and locked by `packages/chain/scripts/deploy-hub.ts`.
3. Named local accounts (`alice.test.near`, `bob.test.near`, `carol.test.near`, `shopper.test.near` and others), each with a key that exists only on this chain.
4. The real clearing node (`@payminto/node`) with its `NearRpcChain`, the gateway and the payee check on, and its database in `apps/local/data/`.
5. A local signer that signs for the local accounts in place of a browser wallet.
6. The real gas relayer (`@payminto/relayer`) with its own funded account.
7. Six small paid services behind the SDK paywall, and an "agent remote" page that makes paid agent calls.
8. First-run setup through the node's HTTP API, an invite and a business API key, and a little real activity: paid calls, refusals, a settled batch, a payout and a checkout payment.
9. The dashboard (`next dev`), pointed at that node, signer and relayer.

Then it prints the addresses, the local accounts and a guide of ten browser steps, and waits for Ctrl-C.
The two generated logins are in `apps/local/data/logins.txt` with mode 0600; the command prints the path and never a password.
Run for this guide on 2026-11-10 on spare ports, it printed `Ready in 107.5 s. Press Ctrl-C to stop everything.`, and Ctrl-C stopped the dashboard, the node, the signer and the sandbox with exit code 130.
`apps/local/README.md` has the guide, every flag, the data rules and troubleshooting.

**The local signer is for development only.**
It holds full-access keys and signs what a caller with the run's token asks for, which is acceptable only because those keys exist on a throwaway chain on this machine.
It is built so that it cannot sign for testnet or mainnet:

- It binds to 127.0.0.1 and answers only requests addressed to a loopback host, with a random token made for the run.
- A browser request is accepted only from the dashboard's own origin.
- Every signing request must name the network `near:sandbox`; `near:testnet`, `near:mainnet` and a missing network are refused.
- It refuses to start unless the RPC it signs against is a loopback address that reports the sandbox chain id (`localnet`).
- It signs function calls only: no key changes, no deploys, no account deletion and no plain transfers.
- The dashboard loads its driver only when `NEXT_PUBLIC_NEAR_NETWORK` is exactly `sandbox` and the signer URL is plain http on a loopback address (`localSigner` in `apps/dashboard/lib/config.ts`); on any other network it uses a NEAR wallet.

`pnpm local --check` starts the same stack on free ports, runs the guide's steps as a script through the routes the browser uses, asserts each result against the chain through a client that holds no key, prints a checks block and stops.
The exit code is 0 only when every check passes.
Run for this guide on 2026-11-11, it ended with:

```text
24 of 24 checks passed in 193.5 s.
```

`pnpm local --reset` deletes `apps/local/data` and exits.
Every database there must be named `*.demo.db` and pass the node's reset guard (`apps/node/src/db/guard.ts`), or nothing is deleted, and it refuses while a stack is running.
Every start also begins from a clean data directory, because the chain does not survive a stop.
Only one `pnpm local` runs at a time per checkout; a second start names the process that holds the lock.

### The story in four seconds: `pnpm demo`

```sh
pnpm demo
```

This runs the whole story in one process on the simulated hub: an in-memory model of the contract, not NEAR.
It needs no accounts, keys or network.
Expect four Budgets, 189 paid calls, nine refusals with their rules, one settled batch, a payout, receipt proofs and a `settle_own`, then:

```text
25 of 25 checks passed in 4.1 s.
```

The exit code is 0 only when every check passes.

The same story on a real NEAR runtime is `pnpm demo --chain sandbox`.
It starts near-sandbox (a local NEAR node) on 127.0.0.1, deploys and locks the committed `hub.wasm`, runs every step as a transaction, and stops the sandbox at the end.
Run on 2026-11-10, it ended with `26 of 26 checks passed in 97.1 s.` and exit code 0.

The first run downloads the near-sandbox binary once, about 30 MB, unless the contract's tests already did.
Neither mode touches testnet.

## 2. Look at the dashboard without a node

```sh
pnpm --filter dashboard dev:mock
```

This serves the dashboard on `http://localhost:3000` against an in-browser mock node with fixtures.
A labeled demo wallet applies each transaction to the mock hub, and nothing reaches a chain.
It also has a demo relayer and a demo Sputnik DAO, so the gasless revoke and the DAO-owned Budget can be clicked through; `apps/dashboard/README.md` lists the `?demo=` switches for their failure states.
It was not run for this guide.

## 3. What a node needs

A node cannot start without a hub to talk to.
It needs these five things:

| Need | Variable | Where it comes from |
|---|---|---|
| A hub account | `HUB_ACCOUNT` | A hub you deploy (section 6), or one that already exists and lists your account as a settler |
| The settler account | `OPERATOR_ACCOUNT` | A NEAR account you create; Budgets name it as `settler` |
| The settler's key | `OPERATOR_KEY` | A function-call key on that account, limited to `settle_batch` and `payout` on the hub |
| A signing seed | `NODE_SIGNING_SEED` | 32 random bytes: `openssl rand -hex 32`; it signs receipts and checkout terms |
| An admin token | `ADMIN_TOKEN` | `openssl rand -hex 32`; the recovery key |

`OPERATOR_KEY` is a function-call key, not the account's full-access key.
Keep the full-access key offline.
The demo adds the function-call key with method names `settle_batch` and `payout`, the hub as receiver and an access-key allowance of 1 NEAR (`apps/demo/src/sandbox/hub.ts`); do the same from your wallet or near-cli.
The node account also needs NEAR for gas.

The public key that belongs to `NODE_SIGNING_SEED` is the hub's checkout key.
Print it without starting the node:

```sh
cd apps/node
NODE_SIGNING_SEED=<your 64 hex characters> node --input-type=module -e 'import { keypairFromSeed } from "@payminto/protocol"; console.log(keypairFromSeed(Buffer.from(process.env.NODE_SIGNING_SEED, "hex")).publicKey)'
```

With the public development seed (64 times `1`) it prints `ed25519:F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4`.
The node also reports it as `nodeKey` in `GET /v1/info`.

Two more things are needed on the hub before a settler can settle and its sellers can leave without it:

| Need | Hub method | Who signs | Detail |
|---|---|---|---|
| A prepaid storage balance | `fund_storage({ account })`, with the NEAR attached as the deposit | Anyone; the deploy script has the admin do it | `settle_batch` draws on it for its batch record, and `register_receipt_key` and checkout payments for the bytes they write; each Budget's owner prepays its payees' settlement storage at `open_budget`. A batch record of a 64-character settler is 281 bytes (0.00281 NEAR), the deploy script and the node's startup check ask for at least 100 of them (0.281 NEAR), and the deploy script puts in 1 NEAR by default. `storage_of({ account })` reports the balance, and `withdraw_storage({ amount })` returns the unused part with one yoctoNEAR attached |
| A registered receipt key | `register_receipt_key({ key })`, with exactly one yoctoNEAR attached | The settler account itself, with its full-access key; a function-call key cannot attach a deposit | The key is the public key of `NODE_SIGNING_SEED`, as 64 hex characters. `settle_own` takes a seller's voucher only with an acceptance signed by a registered key. Keys are only ever added, at most 4 per settler, and `receipt_keys({ settler })` lists them |

`fundStorageTx`, `registerReceiptKeyTx` and `withdrawStorageTx` in `packages/chain/src/actions.ts` build these transactions for a wallet.
Fund the storage balance first: registering a key draws on it.

The node checks both at startup (`apps/node/src/hub-readiness.ts`).
A receipt key that is not registered, or a storage balance below 100 batch records (0.281 NEAR), is an error log line and an increase of `payminto_operator_alerts_total{kind="hub_readiness"}`.
It does not stop the node.

## 4. Run the node and the dashboard

```sh
cp apps/node/.env.example apps/node/.env
```

Edit `apps/node/.env`: set `NETWORK`, `HUB_ACCOUNT`, `OPERATOR_ACCOUNT`, `OPERATOR_KEY`, `NODE_SIGNING_SEED` and `ADMIN_TOKEN`.
The example file's `OPERATOR_KEY=ed25519:replace-me` is a placeholder and fails validation.

```sh
pnpm --filter @payminto/node start
```

`pnpm node` from the repository root runs the same command.
Variables set in the shell win over the file.
Run with no configuration, the node exits with code 2 and names what is missing:

```text
Invalid configuration:
  - HUB_ACCOUNT: Invalid input: expected string, received undefined
  - OPERATOR_ACCOUNT: Invalid input: expected string, received undefined
  - OPERATOR_KEY: Invalid input: expected string, received undefined
  - NODE_SIGNING_SEED: Invalid input: expected string, received undefined
  - ADMIN_TOKEN: Invalid input: expected string, received undefined
```

Then, in another terminal:

```sh
NEXT_PUBLIC_NODE_URL=http://localhost:8787 pnpm --filter dashboard dev
```

Starting a node against a real chain was not run for this guide, because it needs a deployed hub.
What follows comes from the code.

### Local sandbox or testnet

`NETWORK=near:testnet` is the supported way to run a node that stays up.
The human creates the accounts and deploys the hub (section 6).

`NETWORK=near:sandbox` is the default, with `RPC_URL` defaulting to `http://127.0.0.1:3030`.
The one-command way to keep a node running on a sandbox is `pnpm local` (section 1): it starts the sandbox, deploys and locks the hub, and runs the node, the dashboard and the relayer until Ctrl-C, and its chain is gone when it stops.
`pnpm demo --chain sandbox` starts and stops its own sandbox and node, `pnpm demo --chain sandbox --keep` keeps the sandbox up for the verifier only, and `docker-compose.yml` targets testnet.
To run a node by hand on a sandbox you need a running near-sandbox, accounts on it, and a hub deployed with `deploy-hub.ts --network sandbox --rpc-url http://127.0.0.1:<port>`.

### First-run setup

1. Read the node's log.
   When no owner account exists, it logs a warning that contains `[setup] Open`, with the dashboard's `/setup` URL and a one-time setup code that is valid for 24 hours.
   A restart prints a new code, and the old one stops working.
2. Open `http://localhost:3000/setup`, enter the code (`ADMIN_TOKEN` also works), and create the owner account with a name, email and password.
3. Sign in at `/login` with that email and password.

After setup, `ADMIN_TOKEN` no longer works as a credential unless `ADMIN_TOKEN_BREAK_GLASS=true`.
If the owner is locked out, this prints a one-time password reset link on the server:

```sh
pnpm --filter @payminto/node account reset-owner --email <email>
```

### Turn on the gateway

Set `GATEWAY_PAYOUT_ACCOUNT` to the NEAR account that should receive checkout payments, or `GATEWAY_ENABLED=true` to create businesses later.
The gateway adds payment links, the hosted checkout, refunds, webhooks (including `budget.refused`), the service directory and the reconciliation report.
The hub's checkout key must be the public key of `NODE_SIGNING_SEED`, proposed by the admin and accepted by the node's own account with `accept_checkout`, or the hub returns every wallet payment.
The hub also returns a payment below its minimum, 10,000 base units (0.01 USDC) unless the admin changes it with `set_min_payment`, and the node offers no payment below `MIN_CHECKOUT_AMOUNT`.
A payout account must be registered with the token (NEP-145 `storage_deposit`) to receive payouts; the hub never pays that registration.

## 5. Configuration reference

Every variable is validated once at startup by `apps/node/src/config.ts`.
Errors name the variable and never print its value.
"Testnet" in this table means `NETWORK=near:testnet`.

### Core

| Variable | Default | Meaning |
|---|---|---|
| `NETWORK` | `near:sandbox` | `near:sandbox` or `near:testnet` |
| `RPC_URL` | The network's public RPC (`https://rpc.testnet.near.org`, or `http://127.0.0.1:3030` for sandbox) | NEAR JSON-RPC; credentials in it are redacted in logs |
| `HUB_ACCOUNT` | required | The hub contract |
| `TOKEN_ACCOUNT` | Circle testnet USDC on testnet, `usdc.sandbox` on sandbox | The NEP-141 token the hub clears |
| `OPERATOR_ACCOUNT` | required | The account that settles |
| `OPERATOR_KEY` | required | Its function-call key, `ed25519:<base58>` |
| `NODE_SIGNING_SEED` | required | 64 lowercase hex characters; the public development value is refused on testnet |
| `ADMIN_TOKEN` | required | At least 12 characters; on testnet at least 32 and not `dev-admin-token` |
| `ADMIN_TOKEN_BREAK_GLASS` | `false` | `true` keeps the recovery key working after setup; every use is logged |
| `DB_PATH` | `./data/clearing.db` | The SQLite file |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

### HTTP

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address; the Docker image sets `0.0.0.0` |
| `PUBLIC_URL` | `http://localhost:8787` | The node's URL as agents and sellers reach it |
| `CORS_ORIGINS` | The dashboard origin plus `http://localhost:3000` | Comma-separated origins; `*` only for local experiments |
| `PUBLIC_DASHBOARD_URL` | `PUBLIC_CHECKOUT_URL` | The dashboard origin for email links, the CSRF Origin check and the cookie's Secure flag; must be https on testnet |
| `PUBLIC_RPC_URL` | `RPC_URL` when it carries no key, else the network default | The RPC a browser wallet should use |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front whose `X-Forwarded-For` is trusted |
| `METRICS_TOKEN` | unset | A separate bearer for `/metrics`, at least 16 characters |

### Settlement and limits

| Variable | Default | Meaning |
|---|---|---|
| `SETTLE_INTERVAL_SEC` | `0` | Auto-settle period; `0` settles only on `POST /v1/settlements` |
| `SETTLE_MIN_CALLS` | `1` | Unsettled calls needed before an automatic settlement |
| `PAYOUT_INTERVAL_SEC` | `300` | Scheduled payouts of hub credit; `0` pays only on `POST /v1/payouts` |
| `FUNDS_REFRESH_SEC` | `30` | How often escrow and credit are re-read for Budgets with unsettled spend |
| `FUNDS_MAX_AGE_MS` | `10000` | The oldest hub snapshot (escrow, credit, revoked or not) a call may be decided on, from 500 to 60000. An older one is read again first, and if the hub cannot be read the call is refused with `NET_EXPOSURE` and a short retry |
| `MIN_CHECKOUT_AMOUNT` | `10000` | The smallest checkout payment the node offers, in atomic token units (`10000` is 0.01 USDC, the hub's own default minimum): it signs no wallet terms below it, and refuses an open-amount link or a payer amount below it with `AMOUNT_TOO_SMALL`. Keep it at or above the hub's `min_payment`, or the hub returns the payment |
| `NEW_PAYEE_MIN_AMOUNT` | `1000` | The least first payment from a Budget to a payee it has never paid, in atomic token units (`1000` is 0.001 USDC); a smaller one is refused with `NEW_PAYEE_MIN_AMOUNT`. The first settlement of each (Budget, payee) pair makes your settler pay permanent hub storage, about 3 milliNEAR, whatever the amount. `0` disables it |
| `NEW_PAYEES_PER_HOUR` | `20` | How many payees one Budget may pay for the first time in a rolling hour; past it the call is refused with `NEW_PAYEE_RATE` and the seconds until a slot frees. A Budget with a payee list has at most 16 payees, so only a Budget open to any payee can reach it. `0` disables it |
| `RATE_LIMIT_PROVIDER_RPS`, `RATE_LIMIT_PROVIDER_BURST` | `200`, `1000` | Token bucket per provider key on `POST /v1/vouchers`; `0` rps disables it |
| `RATE_LIMIT_IP_RPS`, `RATE_LIMIT_IP_BURST` | `100`, `1000` | Token bucket per client IP for requests without a credential |
| `RATE_LIMIT_UNSIGNED_RPS`, `RATE_LIMIT_UNSIGNED_BURST` | `5`, `50` | Token bucket for vouchers not signed by their Budget's agent key, per provider key, and per client IP on the public pay routes. They get a plain error and are never recorded as refusals; past the bucket the answer is 429 |
| `DENIAL_DEDUP_SEC` | `60` | Identical refusals within this window fold into one record |
| `DENIALS_MAX_ROWS` | `100000` | Oldest refusal records beyond this are pruned |
| `EVENTS_MAX_ROWS` | `200000` | Oldest rows of the live event log beyond this are pruned |
| `AUTH_RATE_LIMIT_PER_MIN` | `20` | Auth requests per minute per IP |
| `PASSWORD_HASH_COST` | `17` | scrypt cost as log2(N); at least 17 on testnet |

### Payee check

| Variable | Default | Meaning |
|---|---|---|
| `PAYEE_CHECK` | `on` | The payee check: `on` or `off`. On, the node judges every payee as allow, warn or block before a Budget pays it, and can refuse with `PAYEE_BLOCKED` or `PAYEE_NEEDS_APPROVAL`. Off, vouchers are judged by the Budget alone |
| `PAYEE_CHECK_INDEXER` | `nearblocks` on testnet, `off` on sandbox | Where account ages come from. The account ids that are checked are sent to that indexer. A local chain has no indexer, and `nearblocks` is refused there |
| `PAYEE_CHECK_INDEXER_KEY` | unset | Optional NearBlocks API key; the keyless tier is rate limited |

The check reads accounts through `RPC_URL` and signs nothing.
An owner approves or denies a payee with warnings on the Budget's page in the dashboard, under "Waiting for your approval", which sends `POST /v1/budgets/:id/payee-approvals`; [DEVELOPERS.md](DEVELOPERS.md) has the routes.

### Gateway

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_PAYOUT_ACCOUNT` | unset | Turns the gateway on and seeds the first business's payout account |
| `GATEWAY_ENABLED` | on when a payout account is set | `true` turns the gateway on without a seeded business |
| `PLATFORM_NAME` | `Payminto` | Shown in the dashboard and emails |
| `PLATFORM_FEE_ACCOUNT` | unset | The account that would receive fees; needed before any fee is non-zero. The default plan charges 0% |
| `PUBLIC_CHECKOUT_URL` | `http://localhost:3000` | The dashboard origin that serves the checkout; a public https origin on testnet |
| `CHECKOUT_TTL_SECONDS` | `1800` | Lifetime of a new payment, from 300 to 604800 |
| `WEBHOOK_ALLOW_PRIVATE` | `true` on sandbox | Lets webhook URLs reach private addresses; refused on testnet |
| `GATEWAY_WATCH_INTERVAL_MS` | `2000` | How often open wallet payments are looked up on the hub |

On testnet, `GATEWAY_PAYOUT_ACCOUNT` and `PLATFORM_FEE_ACCOUNT` must not be the operator account.

### Email

Without SMTP, every account email is kept in the node's outbox, logged, and shown to the platform owner in the dashboard.

| Variable | Meaning |
|---|---|
| `SMTP_URL` | `smtp://user:pass@host:587` or `smtps://...:465` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | The same in parts; the port defaults to 587 |
| `SMTP_FROM` | The sender address |

### Hosted business agents

| Variable | Default | Meaning |
|---|---|---|
| `AGENTS_ENABLED` | on with the gateway on sandbox, off on testnet | Turns the agents API, skills and run worker on |
| `AGENT_SECRETS_KEY` | A documented development key on sandbox; required on testnet | Base64 of 32 bytes; seals each business's model API keys |
| `AGENT_SECRETS_KEY_VERSION` | `1` | The version new secrets are sealed with |
| `AGENT_SECRETS_KEY_PREVIOUS` | unset | The previous key during a rotation |
| `AGENT_ALLOW_PRIVATE_MODEL_URLS` | `false` | Lets OpenAI-compatible base URLs point at private addresses |
| `AGENT_WORKERS` | `2` | Runs at once in this node; `0` runs no worker |
| `AGENT_MAX_PER_MERCHANT` | `1` | Runs at once per business |
| `AGENT_POLL_MS` | `1000` | Worker poll interval |

### Scripts

| Variable | Used by | Meaning |
|---|---|---|
| `BACKUP_DIR` | `pnpm --filter @payminto/node backup` | Where backups are written; default `./backups` |

### Dashboard

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_NODE_URL` | `http://localhost:8787` | The node URL as the browser reaches it; fixed at build time |
| `NODE_INTERNAL_URL` | `NEXT_PUBLIC_NODE_URL` | Where the dashboard's own proxy reaches the node; read at runtime |
| `NEXT_PUBLIC_NEAR_NETWORK` | testnet | The wallet network |
| `NEXT_PUBLIC_NEAR_RPC_URL` | unset | The RPC this browser reads proofs, the hub and DAOs from; unset, the network's public RPC, never one the node chooses (on a local sandbox, the node's RPC). `NEXT_PUBLIC_RPC_URL` is read as a fallback |
| `NEXT_PUBLIC_RELAYER_URL` | unset | A Payminto relayer; set, a Budget page offers "Revoke without gas" and, when the relayer lists `reclaim`, "Reclaim without gas" |
| `NEXT_PUBLIC_LOCAL_SIGNER_URL`, `NEXT_PUBLIC_LOCAL_SIGNER_TOKEN` | unset | Set by `pnpm local` only; used only when the network is `sandbox` and the URL is loopback http |
| `NEXT_PUBLIC_MOCK` | unset | `1` serves fixtures from an in-browser mock node; `empty` serves a fresh one |
| `NEXT_PUBLIC_DOCS_URL` | unset | The docs link shown in the dashboard's help sheet |

## 6. Deploy and lock a hub on testnet (human step)

`packages/chain/scripts/deploy-hub.ts` deploys the committed `contracts-near/out/hub.wasm`, configures it and locks it.
It works on a sandbox or on NEAR testnet, and refuses mainnet accounts and mainnet RPC URLs.
The human runs it against testnet with their own keys.

Before you start, create and fund these testnet accounts yourself:

| Account | Role | Needs |
|---|---|---|
| Hub | Holds the contract | About 3.58 NEAR: the wasm's storage and 0.1 NEAR of its own; this account ends with no keys |
| Admin | Manages settlers, proposes the checkout key and sets the minimum checkout payment | NEAR for gas, the small deposits of `set_settler` and `set_checkout_key`, and the settler's prefund (1 NEAR by default); must not be the hub account |
| Settler | The node's `OPERATOR_ACCOUNT` | NEAR for gas; its storage balance and receipt key are described in section 3, and it accepts the checkout role itself with `accept_checkout` |
| Token | The NEP-141 token | On testnet, Circle USDC: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` |

First print the plan.
A dry run signs nothing and needs no key:

```sh
node packages/chain/scripts/deploy-hub.ts --network testnet \
  --hub hub.example.testnet --admin admin.example.testnet --settler node.example.testnet \
  --token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af \
  --checkout-key ed25519:<node checkout public key> --dry-run
```

This was run for this guide on 2026-11-10 with the placeholder accounts above.
It prints the wasm's sha256 and code hash, then each transaction with its signer, receiver, actions, gas and deposit, then a JSON report with every step `planned`.
A dry run does make read-only RPC calls to look the accounts up, and carries on when they fail.
Its first line and the wasm line, as printed:

```text
DRY RUN: nothing is signed or sent on near:testnet
wasm <repo>/contracts-near/out/hub.wasm: 345682 bytes, sha256 ef9e1fcee61b4dbd89f9a2051c673c39a2eec480376128a93f23b107f552ea09, code hash H8NHZwWQPwgdYCku8kUR7AqcnbvY28BQGaRU5LhuARFN
```

The steps it plans, in order, with the names the report uses:

| Step | Signer | Action |
|---|---|---|
| `check_hub_balance` | none | The hub account must hold enough NEAR for the wasm, its state and `--min-hub-balance` of its own: 3.5768 NEAR with the current wasm and the default margin |
| `deploy_and_init` | hub | `DeployContract` and `new({ admin, token, network })` in one transaction, because `new` is private |
| `register_hub_at_token` | hub | `storage_deposit({ account_id: hub, registration_only: true })` at the token, so the first deposit cannot bounce; the deposit is the larger of `--storage-deposit` and the token's own minimum |
| `set_settler` | admin | `set_settler({ account, allowed: true })`, with a deposit that pays for the entry; the hub refunds the excess |
| `set_checkout_key` | admin | `set_checkout_key({ key, settler })`, with a deposit that pays for the entry; this only proposes the settler, and no checkout payment draws on its storage balance until it accepts |
| `check_settler_storage` | none | Reads the settler's storage balance and compares it with `--min-settler-storage` |
| `fund_settler_storage` | admin | `fund_storage({ account: settler })` with `--settler-storage` attached; skipped when the settler already holds the minimum |
| `register_receipt_key` | settler | `register_receipt_key({ key })` with one yoctoNEAR, if `PAYMINTO_SETTLER_KEY` is set; without it the script prints the transaction for the node operator to sign and carries on |
| `accept_checkout` | settler | `accept_checkout({ key })` with one yoctoNEAR, which makes the settler the checkout settler, if `PAYMINTO_SETTLER_KEY` is set; without it the script prints the transaction for the node operator to sign and carries on |
| `verify` | none | The on-chain code hash, the config, the settler, the checkout key and its settler (or the pending proposal when `accept_checkout` was left to the operator), the token registration, the settler's storage balance and the hub's own balance must match, and no admin transfer may be pending, or the script stops |
| `lock` | hub | `DeleteKey` for every access key on the hub account, then a check that none is left |

The live run is the same command without `--dry-run` and with `--confirm-lock`.
It reads keys from `PAYMINTO_HUB_KEY` and `PAYMINTO_ADMIN_KEY`, or from near-cli credentials in `~/.near-credentials/testnet/<account>.json`.
`PAYMINTO_SETTLER_KEY` is optional and is used for `register_receipt_key` and `accept_checkout` only; it is the settler's full-access key, so the safer path is to leave it unset and sign those two transactions from the settler's own wallet.
Until the receipt key is registered, sellers cannot use `settle_own` for calls this node accepts, and until the settler accepts the checkout role, the hub returns every wallet payment.
The live run was not run for this guide, and no assistant should run it.

| Flag | Meaning |
|---|---|
| `--network` | `sandbox` or `testnet` |
| `--rpc-url` | Required for sandbox; optional for testnet |
| `--hub`, `--admin`, `--settler`, `--token` | The four accounts |
| `--checkout-key` | The node's checkout public key, `ed25519:<base58>` or 64 hex characters |
| `--receipt-key` | The key the settler registers; defaults to the checkout key, because a standard node signs both with one key |
| `--wasm` | Another wasm file; default `contracts-near/out/hub.wasm` |
| `--storage-deposit` | Lower bound in yoctoNEAR for the hub's token registration; default 0.00125 NEAR |
| `--settler-storage` | yoctoNEAR the admin puts into the settler's storage balance; default 1 NEAR |
| `--min-settler-storage` | The storage balance below which the prefund runs, in yoctoNEAR; default 0.281 NEAR, the records of 100 batches by a 64-character settler |
| `--min-hub-balance` | NEAR the hub account must keep beyond its storage, in yoctoNEAR; default 0.1 NEAR |
| `--credentials-dir` | Another near-cli credentials directory |
| `--dry-run` | Print the plan and sign nothing |
| `--confirm-lock` | Required for a live testnet run |

The script has no `--help` flag.
A step the chain already shows as done is skipped, so a run that stopped halfway can be repeated.

Locking is irreversible.
After it, no key can sign for the hub account and the contract has no upgrade method, so the code can never change.
A function-call key would not be safe to leave either: a key on the hub account calls the hub as itself and would pass the private check on its callbacks.
A bug found after locking means deploying a new hub and opening new Budgets on it.

## 7. Docker Compose

`docker-compose.yml` builds and runs the node and the dashboard for NEAR testnet.

```sh
cp .env.docker.example .env
```

Fill in `HUB_ACCOUNT`, `OPERATOR_ACCOUNT`, `OPERATOR_KEY`, `NODE_SIGNING_SEED` and `ADMIN_TOKEN`, and set `PUBLIC_URL`, `CORS_ORIGINS` and `NEXT_PUBLIC_NODE_URL` to your own URLs.
Then:

```sh
docker compose up -d --build
```

| Fact | Detail |
|---|---|
| Required variables | Compose refuses every command, `build` included, until `HUB_ACCOUNT`, `OPERATOR_ACCOUNT`, `OPERATOR_KEY` and `NODE_SIGNING_SEED` are set |
| Admin token | The compose file falls back to `dev-admin-token`, which the node refuses on testnet, so set `ADMIN_TOKEN` |
| Ports | `127.0.0.1:8787` and `127.0.0.1:3000` by default; change with `NODE_PUBLISH` and `DASHBOARD_PUBLISH` |
| Data | The `node-data` volume holds `/data/clearing.db` and `/data/backups` |
| Dashboard build | `NEXT_PUBLIC_NODE_URL` is fixed into the dashboard image at build time, so rebuild after changing it |
| Proxy hops | `TRUST_PROXY_HOPS` defaults to 1, because the dashboard forwards agents' link requests to the node |
| Health | Both images have a health check; the dashboard waits for the node to be healthy |
| Local chain | There is no sandbox profile in the compose file |

The images were not built for this guide: no Docker daemon was available.
`docker compose config` was run with the required variables set, and it parses.
Put a TLS reverse proxy in front before exposing either port; [OPERATIONS.md](OPERATIONS.md) has an example.

## 8. Optional: a gas relayer

`apps/relayer` lets an owner who holds no NEAR revoke a Budget.
The owner signs a NEP-366 delegate action off chain, and the relayer wraps it in its own transaction and pays the gas.
It pays only for zero-deposit calls to its own hub, to the methods on its list, and nothing else in Payminto depends on it.

Try it with no NEAR node, no network and no real key:

```sh
pnpm --filter @payminto/relayer dev:fake
```

Then, in a second terminal:

```sh
curl -s http://127.0.0.1:8790/info
```

Run for this guide, it answered:

```json
{"relayer":"relayer.test.near","hub":"hub.test.near","network":"near:sandbox","methods":["revoke_budget","reclaim","payout"],"maxGasTgas":300}
```

To run a real one, copy `apps/relayer/.env.example` to `apps/relayer/.env`, set `RELAYER_ACCOUNT`, `RELAYER_KEY` and `HUB_ACCOUNT`, and start it with `pnpm --filter @payminto/relayer start`.
The relayer account needs a full-access key that only this service holds and a small NEAR balance, and it must not be the hub account or the node's account.
Creating that account on testnet is a human step.
`apps/relayer/README.md` has every variable, the HTTP API and the security model.

To offer it in the dashboard, build the dashboard with `NEXT_PUBLIC_RELAYER_URL` set to the relayer, and add the dashboard's origin to the relayer's `CORS_ORIGINS`.
A Budget's page then offers "Revoke without gas" next to "Revoke on NEAR".
The page reads the relayer's `GET /info` and refuses before any wallet is asked when the relayer sponsors another hub, another network or not this method.
The owner's wallet signs a NEP-366 delegate action; the page decodes it, compares it with the reviewed call, and checks the key's nonce and the expiry on NEAR before it posts `POST /relay`.
It says "Final on NEAR" only after it reads the revoke from the hub.
Wallets that sign delegate actions on testnet are listed in `apps/dashboard/README.md`; a wallet that cannot is told so.
From a terminal the same is `pnpm --filter @payminto/relayer revoke --budget <id> --owner <account> --relayer <url>`.
`pnpm local` runs the relayer and an owner with no NEAR, and `pnpm local --check` asserts that her relayed revoke lands while her NEAR balance changes by 0 yoctoNEAR.

## 9. After the node is up

1. Open the dashboard, connect a NEAR wallet, and open a Budget.
   The wallet signs two transactions, `open_budget` and the escrow deposit, and the dashboard shows each one before the wallet asks.
   For a Budget owned by a Sputnik DAO v2, pick "Owner: a DAO I am a member of": each step becomes a proposal the members vote on, and the dashboard registers the Budget once the hub holds it.
   Creating the DAO and voting on testnet are human steps, and this repository records no DAO proposal sent on any network.
2. Give an agent that Budget: [AGENTS.md](AGENTS.md).
   When the payee check warns about a payee, the agent's call waits until an owner approves it on the Budget's page.
3. Put a paywall in front of an API: [DEVELOPERS.md](DEVELOPERS.md).
4. Set up backups and monitoring: [OPERATIONS.md](OPERATIONS.md).
5. Read what the node and the hub refuse, and why: [REFUSALS.md](REFUSALS.md).
