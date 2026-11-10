# Operating a clearing node

This is the runbook for a Payminto clearing node on NEAR testnet.
Setting one up is in [SELF_HOST.md](SELF_HOST.md), and what the operator can and cannot do with funds is in [SECURITY.md](SECURITY.md).

The node holds no tokens.
Budget funds are escrowed in the hub contract, which is unaudited, and the node has no method that moves them to itself.
What the node does hold is the settler key, the signing seed, the admin token, and the SQLite database of accepted calls, receipts and Merkle paths.
This page is about protecting those four.
What the node and the hub refuse, with the test for each rule, is in [REFUSALS.md](REFUSALS.md).

## 1. Shape of a deployment

```text
internet --TLS--> reverse proxy --http--> node 127.0.0.1:8787
                                \--http--> dashboard 127.0.0.1:3000
```

- The node binds `HOST=127.0.0.1` by default.
  Only the Docker image binds `0.0.0.0`, and `docker-compose.yml` publishes its ports on 127.0.0.1.
- Run exactly one node process per `DB_PATH`.
  SQLite and the settler key's nonce are single-writer by design, and every hub write goes out one at a time.
- A database is pinned to one network, hub and token.
  The node refuses to start against another, so use a separate `DB_PATH` or Docker volume per hub.

## 2. TLS with a reverse proxy

The node speaks plain HTTP, so terminate TLS in front of it.
This Caddy configuration is an example to adapt; it was not run for this page.

```caddyfile
node.example.com {
	# EventSource cannot send headers, so a client may pass the recovery key as ?token= on /v1/events.
	# Move it into the Authorization header and drop it from the URL before it reaches the node or any log.
	@events path /v1/events
	handle @events {
		request_header Authorization "Bearer {http.request.uri.query.token}"
		uri query -token
		reverse_proxy 127.0.0.1:8787 {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
	log {
		output file /var/log/caddy/node.log
		format filter {
			request>uri query {
				delete token
			}
			request>headers>Authorization delete
		}
	}
}

dashboard.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Then set, for the node:

| Variable | Value | Why |
|---|---|---|
| `PUBLIC_URL` | `https://node.example.com` | Advertised to agents in payment requirements |
| `PUBLIC_CHECKOUT_URL` | `https://dashboard.example.com` | Must be a public https origin on testnet when the gateway is on |
| `CORS_ORIGINS` | `https://dashboard.example.com` | The dashboard's origin |
| `TRUST_PROXY_HOPS` | `1` | So per-IP limits see the client, not the proxy |

Build the dashboard with `NEXT_PUBLIC_NODE_URL=https://node.example.com`.
In Docker, set it in `.env` before `docker compose build`.

### Trusted proxy hops

`TRUST_PROXY_HOPS` is how many `X-Forwarded-For` entries, counted from the right, the node trusts.
The client address is the entry that many places from the end.
The node uses it for per-IP rate limits and to tell apart agents that pay the same payment link, so a wrong value either lets clients fake their address or makes every client look like the proxy.

- Use `0` only when clients reach the node directly, because any client can then write the header.
- The dashboard forwards agents' `/l/*` and `/pay/*` requests to the node and adds the address it saw, so a node behind the dashboard needs at least `1`.
  `docker-compose.yml` defaults to `1`.
- With a TLS proxy in front of both, direct API calls arrive through one hop and forwarded agent calls through two.
  One value cannot be right for both: with `1`, direct calls see the real client, and agents paying through the dashboard are keyed by the proxy's address.
  Set `2` only if every request to the node passes through both.

### The SSE `?token=` caveat

`GET /v1/events` accepts a session cookie, or the recovery key in the `Authorization` header, or the recovery key as `?token=` while it is active.
A token in a URL can leak into proxy access logs, browser history and monitoring tools.
The node never logs query strings, but anything in front of it might.
Behind a proxy, do what the Caddy example does: move `?token=` into the header, strip it from the URL, and filter it out of the log format.
Rotate `ADMIN_TOKEN` if it ever appeared in a log.
After first-run setup the recovery key is off unless `ADMIN_TOKEN_BREAK_GLASS=true`, and the dashboard uses the session cookie.

### Event streams must not be buffered

The dashboard's live screens (Live Calls, the payee approvals on a Budget's page, the checkout's status) read server-sent events: `GET /v1/events` and the checkout's event stream, both `Content-Type: text/event-stream`.
The node answers them with `Cache-Control: no-cache, no-transform` (`apps/node/src/sse.ts`).
`no-transform` tells a proxy not to compress or otherwise rewrite the stream; compression buffers it, and then no event reaches the browser until the buffer fills.
The dashboard reaches the node through its own `/api` path, and the Next.js server leaves a `no-transform` response alone, so live updates pass through it.

Any proxy you put in front of the node or the dashboard must do the same for `text/event-stream`: no buffering, no compression, and no read timeout shorter than the stream's life.

- Caddy: the example above sets `flush_interval -1` on `/v1/events`; do the same for any other route that streams.
- nginx: `proxy_buffering off;`, `gzip off;` and a long `proxy_read_timeout` on the streaming locations.
- A CDN or load balancer: turn off response buffering and compression for `text/event-stream`.

Neither proxy configuration was run for this page.
Through the dashboard of `pnpm local`, `GET /api/v1/events` answered `200` with `content-type: text/event-stream`, `cache-control: no-cache, no-transform` and no `content-encoding`, checked in a browser on 2026-11-10.

## 3. Keys and secrets

| Secret | What it can do | How to keep it |
|---|---|---|
| Settler key (`OPERATOR_KEY`) | Call `settle_batch` and `payout` on the hub, and nothing else | A function-call key on the node account, used for nothing else |
| Node account's full-access key | Everything the node account can do, including adding keys, registering a receipt key on the hub and withdrawing the storage balance | Offline; the running node never needs it. You use it from a wallet for those few transactions |
| Signing seed (`NODE_SIGNING_SEED`) | Sign receipts (acceptances), refusal records and checkout terms | Generated with `openssl rand -hex 32`; the public development value is refused on testnet |
| Admin token (`ADMIN_TOKEN`) | Everything, before setup or with break-glass on; `/metrics` always | `openssl rand -hex 32`; at least 32 characters on testnet |
| Hub admin key | Add or remove settlers, set the checkout key | Offline; it has no path to funds, but it decides who may settle |
| Hub account key | Nothing after locking | The hub account has no keys once `deploy-hub.ts` locks it |
| Agent secrets key (`AGENT_SECRETS_KEY`) | Open every business's stored model API key | With the other secrets, and never where the database backups are |

Keep secrets in `apps/node/.env` or the compose `.env`, both git-ignored and readable by the service user only (`chmod 600`).
Startup errors name the variable and never its value, logs never contain keys or tokens, and credentials in `RPC_URL` are redacted in the startup log.

Notes on each:

- The settler key is a NEAR function-call key, and such a key carries an allowance of NEAR it may spend on gas.
  When the allowance runs out, settlements and payouts fail until you add a new key.
  The node does not track the remaining allowance, so watch it and the account balance yourself.
- The signing seed is a trust anchor for sellers: its signature on a receipt is the node's acceptance.
  A node that signs acceptances for more than a Budget's escrow is misbehaving in a way its signatures prove.
- The hub stores receipt keys per settler, and `settle_own` takes a seller's voucher only with an acceptance signed by one of them.
  The settler registers its own key with `register_receipt_key({ key })` and exactly one yoctoNEAR attached, signed with the node account's full-access key; `registerReceiptKeyTx` in `packages/chain/src/actions.ts` builds the transaction, and `receipt_keys({ settler })` lists what is registered.
  A new signing seed therefore means registering the new public key, and the old one stays valid for the receipts it signed.
- Receipt keys are only ever added, and a settler holds at most 4.
  So one settler account can change its signing seed three times, and a leaked receipt key cannot be removed.
  If the seed leaks, the remedy is a new settler account, and owners opening new Budgets that name it.
- The checkout key on the hub is the same public key.
  Changing the seed also needs the hub admin to call `set_checkout_key({ key, settler })`, or the hub returns every wallet payment.

Rotation:

| Secret | Steps |
|---|---|
| Admin token | Change it and restart. People sign in again only if they used it; sessions are separate |
| Settler key | Add a new function-call key to the node account for `settle_batch` and `payout`, set `OPERATOR_KEY`, restart, then delete the old key. A shutdown waits for a settlement in flight |
| Signing seed | Register the new key on the hub with `register_receipt_key` and have the admin set the checkout key (above), then set `NODE_SIGNING_SEED` and restart. Check the startup log for a `hub_readiness` error. Tell agents that pin the node key (`TRUSTED_NODE_KEY`) |
| Agent secrets key | See "Rotating `AGENT_SECRETS_KEY`" in section 8 |

## 4. Backups and restore

The node's state is one SQLite file in WAL mode at `DB_PATH`.
Back it up while the node runs:

```sh
pnpm --filter @payminto/node backup
pnpm --filter @payminto/node backup --out /srv/payminto-backups
docker compose exec node node scripts/backup.ts
```

The first form reads `DB_PATH` from the environment or `apps/node/.env` and writes to `BACKUP_DIR` or `./backups`.
`pnpm backup` from the repository root is the same.
In Docker the backup lands in `/data/backups` in the `node-data` volume.

The second form was run for this page on 2026-11-10 against the disposable database of a `pnpm demo` run and printed:

```text
backup ok: <out dir>/clearing-20261110T075652Z.db
  1441792 bytes, integrity_check ok, 6 migrations, 188 calls, 189 journals
```

The Docker form was not run.

The backup uses SQLite `VACUUM INTO` to write `clearing-<UTC timestamp>.db`, a consistent snapshot.
It never touches the source and refuses to overwrite a file.
It verifies the copy when it is made, not when you need it: the file is not empty, `PRAGMA integrity_check` is ok, and it has no fewer migrations, calls and journals than the source.
A failed check exits non-zero, so a cron job or timer can alert on it.

Copy backups off the host and keep at least a week of dailies.
Copying the `.db` file with `cp` while the node runs is not a backup: it can miss the WAL.

Restore:

1. Stop the node.
2. Move the current `DB_PATH` and its `-wal` and `-shm` files aside.
   Do not delete them until the restore is confirmed.
3. Copy the backup to `DB_PATH`.
4. Start the node.
   It checks that the database belongs to the configured network, hub and token, and resolves interrupted batches (section 9).
5. Check `/healthz`, the dashboard overview and `GET /v1/ledger/trial-balance`, whose `balanced` field must be true.

What a restore loses and keeps:

- Calls accepted after the backup are missing from the node.
  Their sellers still hold the vouchers and receipts, and can settle them with `settle_own`.
- A batch that settled after the backup is on the hub but not in the restored database.
  The node's pre-checks compare each position with the hub's `settled` amount and drop a claim that disagrees, so the node does not settle it twice; it also cannot serve Merkle paths for that batch.
- A seller that settles a call the restored database does not hold makes the hub's settled position run ahead of the node's.
  The node then follows the hub, books the amount as `uncleared`, and raises the operator alert `seller_settled_uncleared`.
  If the hub's settled position is behind the node's instead, the alert is `settled_position_behind`: the database and the hub do not belong together.
- A restore rewinds positions, and nothing repairs that automatically.
  For a Budget with calls accepted after the backup, the node's position is behind what its agent signed and what its sellers hold.
  Stop such a Budget at the node (`POST /v1/budgets/:id/revoke`), let its sellers settle what they hold, and have the owner open a new one.
  This advice follows from the code and was not tested as a drill.

The only tool that deletes a database is `pnpm --filter @payminto/node db:reset <path>`.
It refuses unless the file name ends in `.test.db` or `.demo.db`, or the path is in the OS temp directory, or `--i-know-this-is-disposable` is passed.
Run against `./data/clearing.db` for this page, it refused with exit code 1.

## 5. Upgrades and migrations

1. Take a backup (section 4).
2. Pull the new version and compare `apps/node/.env.example` with your `.env`.
3. Docker: `docker compose build`, then `docker compose up -d`.
   Bare metal: `pnpm install --frozen-lockfile`, then restart the service.
4. Watch the startup log: the `clearing node listening` line reports `migrationsApplied`.

Migrations are SQL files in `apps/node/migrations`, applied in order at startup, each in one transaction, and forward-only.
This build ships six: `001_near.sql`, `002_request_parts.sql`, `003_seller_settlements.sql`, `004_denial_signatures.sql`, `005_nearai_provider.sql` and `006_payee_check.sql`.
A database created by `001_near.sql` is brought up to date in place, and `apps/node/test/db-guard.test.ts` checks that every row survives.
The node refuses to start on a database with migration entries it does not ship, and never drops one.
To roll back, stop the node, restore the pre-upgrade backup, and start the previous version.

A node that receives SIGTERM stops accepting requests, closes event streams, and lets a settlement or payout in flight finish booking, for up to 60 seconds.
Give it that time: `docker compose stop -t 75`, or `TimeoutStopSec=75` in systemd.
A second signal exits at once.

The hub has no upgrade path.
A new contract version is a new deployment at a new account, with a new `DB_PATH`, and Budgets do not move between hubs.

## 6. Monitoring

- `GET /healthz` is public and never rate limited: `200` when the RPC answers, `503` otherwise.
  The Docker images use it as their health check.
- `GET /metrics` returns Prometheus text and needs a bearer: `ADMIN_TOKEN`, or `METRICS_TOKEN` when set.
  Unlike other routes, `/metrics` accepts `ADMIN_TOKEN` after setup too.

```yaml
scrape_configs:
  - job_name: payminto-node
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/payminto-metrics-token
    static_configs:
      - targets: [node.example.com]
```

| Metric | Alert when |
|---|---|
| `payminto_rpc_up` | 0 for 2 minutes |
| `payminto_unsettled_calls` | Keeps growing while `SETTLE_INTERVAL_SEC` is set |
| `payminto_batches{status="failed"}`, `payminto_batches{status="unknown"}` | Either increases |
| `payminto_operator_alerts_total{kind}` | Any increase; the kinds are in the next table |
| `payminto_unsigned_vouchers_total{reason}` | Sustained increase: someone is sending vouchers no Budget's agent signed |
| `payminto_rate_limited_total` | Sustained increase: abuse, or limits too tight for a real seller |
| `payminto_denials` | Sudden jump: an attack, or a misconfigured agent |
| `payminto_auth_failures_total` | Sudden jump |
| `payminto_db_size_bytes` | Unexpected growth |

Operator alerts are conditions only you can resolve.
Each is an error log line and an increase of `payminto_operator_alerts_total{kind}`, and the three settlement kinds are also emitted as `operator.alert` events.

| `kind` | Meaning | What to do |
|---|---|---|
| `hub_readiness` | At startup, the node's receipt key is not registered for its account on the hub, or its prepaid storage balance is below one full batch | Register the key with `register_receipt_key`, or top the balance up with `fund_storage` (section 12) |
| `batch_mismatch` | The hub holds another settler's batch, or another root, under this node's batch id | Stop settling and investigate; the batch is never booked, and its calls are back in the queue |
| `seller_settled_uncleared` | A seller settled a voucher this node has no record of accepting | Check whether the signing seed leaked or the database was restored from an old backup |
| `settled_position_behind` | The hub's settled position is behind this node's | The database and the hub do not belong together; check `HUB_ACCOUNT` and the restore history |

Also exposed: `payminto_node_info`, `payminto_http_requests_total`, `payminto_calls`, `payminto_denial_rows`, `payminto_event_rows`, `payminto_sse_clients`, `payminto_ratelimit_keys`, `process_resident_memory_bytes` and `process_uptime_seconds`.
No metric reports the node account's NEAR balance, the settler key's remaining allowance, or the settler's storage balance on the hub.
The node reads the storage balance once, at startup, for the `hub_readiness` check; watch all three from outside.
Logs are JSON lines on stdout.

For alerts on refused calls, add a platform webhook endpoint for `budget.refused` ([DEVELOPERS.md](DEVELOPERS.md)).
It needs the gateway on.

## 7. Abuse limits and growth bounds

| Limit | Setting | Default |
|---|---|---|
| Per provider key on `POST /v1/vouchers` | `RATE_LIMIT_PROVIDER_RPS`, `RATE_LIMIT_PROVIDER_BURST` | 200 per second, burst 1000 |
| Per client IP, for requests without a credential | `RATE_LIMIT_IP_RPS`, `RATE_LIMIT_IP_BURST` | 100 per second, burst 1000 |
| Vouchers not signed by their Budget's agent key, per provider key, and per client IP on the public pay routes | `RATE_LIMIT_UNSIGNED_RPS`, `RATE_LIMIT_UNSIGNED_BURST` | 5 per second, burst 50 |
| Auth routes per IP | `AUTH_RATE_LIMIT_PER_MIN` | 20 per minute |
| Request body | fixed | 512 KiB |
| Refusal records | `DENIALS_MAX_ROWS` | Newest 100000 kept |
| Live event log | `EVENTS_MAX_ROWS` | Newest 200000 kept |

- Over a limit the node answers `429 RATE_LIMITED` with `Retry-After` in seconds.
  An RPS of `0` disables that limiter.
- Agents read their position before each paid call, so an agent host makes about as many public reads as paid calls.
- Identical refusals within `DENIAL_DEDUP_SEC` fold into one record with a `repeats` count, so a replay flood costs one row and one webhook.
- The node checks the voucher signature before any rule.
  A voucher that is not signed by the Budget's agent key, or one for a Budget the node does not know, gets a plain 402 error (`BAD_SIGNATURE` or `UNKNOWN_BUDGET`) and creates no refusal record, no event and no webhook, so a stranger cannot fill an owner's refusal log.
  Such vouchers count against the unsigned limit above and in `payminto_unsigned_vouchers_total`, and never slow down signed ones.
- When the hub cannot be read and a Budget's funds snapshot is older than `FUNDS_MAX_AGE_MS` (10 seconds by default), the node refuses that Budget's calls with `NET_EXPOSURE` and a retry hint of 5 seconds.
  A slow or failing RPC therefore shows up as refusals with `reason: "hub_unreadable"`, not as calls accepted on stale data.
- Calls, batches and the ledger are never pruned.
- Limits are per node process and in memory; they reset on restart.
  For an internet-facing node, add connection limits at the proxy as well.

## 8. Hosted business agents

Businesses can run their own AI agents on the node with their own model keys ([AGENTS.md](AGENTS.md)).
The feature is on by default on a sandbox when the gateway is on, and off on testnet until `AGENTS_ENABLED=true`.
Its settings are listed in [SELF_HOST.md](SELF_HOST.md).

The secrets key:

- Generate it with `openssl rand -base64 32`.
- On testnet the node refuses to start with agents on and no `AGENT_SECRETS_KEY`, or with the development key.
- Each model key is sealed with AES-256-GCM and bound to its business and row, so a database backup without the secrets key reveals no model key.
- Losing the secrets key loses the stored model keys, not the businesses' data: each business adds its key again.
- Model keys are never returned by the API or written to logs, the activity log, events, webhooks or run errors.

### Rotating `AGENT_SECRETS_KEY`

1. Take a backup (section 4).
2. Set `AGENT_SECRETS_KEY_PREVIOUS` to the current key, `AGENT_SECRETS_KEY` to a new one, and raise `AGENT_SECRETS_KEY_VERSION` by one.
3. Restart the node.
   It reads keys of both versions and seals new ones with the new version.
4. Run `pnpm --filter @payminto/node agents:reencrypt` to see how many keys would be re-sealed, then `pnpm --filter @payminto/node agents:reencrypt -- --apply`.
   The re-seal runs in one transaction and checks that every key opens again before it commits, so a wrong key changes nothing.
5. Remove `AGENT_SECRETS_KEY_PREVIOUS` and restart.

The re-encrypt commands were not run for this page.

Runs:

- The run worker is inside the node process.
  A node that shuts down aborts runs in flight and puts them back in the queue without counting the attempt.
- A run whose worker died is picked up again when its 60 second lease expires.
- Model calls are billed to each business's own provider account.

## 9. Restart recovery

The node resolves unfinished work at startup, before it listens, and again before every settlement.
It never needs a manual repair step.

| Left over | What the node does |
|---|---|
| A batch still `building` | The node stopped before sending it: the batch is marked `failed` and its calls return to the queue |
| A batch still `submitted` | The node stopped while it was in flight: the node asks the hub. If the hub has it, it is booked `confirmed`; if not, it becomes `unknown` |
| A batch `unknown` | See section 10 |
| A payout still `submitted` | It is marked `unknown`; its accounts stay due, and the next run reads each account's credit from the hub again |
| An agent run in flight | Returned to the queue |
| Accepted calls not yet in a batch | Unchanged; the next settlement picks them up |

If the hub cannot be read during recovery, the node leaves those batches as they are and asks again before the next settlement.

## 10. Batch status `unknown`

A batch is `unknown` when the send ended without a verdict: a timeout, a dropped connection, or a restart while it was in flight.
The hub may have it, or may still get it.

What the node does, with no action from you:

1. It returns the batch's calls to the queue, so they are not stranded.
2. Before every later settlement it asks the hub for that batch id.
3. If the hub has the batch, the node adopts it: it claims the same calls again, checks that they rebuild the stored root, and books the batch `confirmed`.
4. If the hub does not have it after 2 days, the batch is marked `failed`.
   NEAR drops a transaction whose reference block is about a day old, so by then it cannot land.

Why this cannot settle twice:

- The node never signs a write a second time with a new nonce.
- The hub refuses a known batch id with `BATCH_EXISTS` and changes nothing.
- A later batch that claims the same positions is refused by the hub as stale, and the node's pre-checks drop such a claim first.

A seller can settle its own voucher with `settle_own` at any time, including while a batch with the same voucher is in flight.
The hub then refuses that batch with `STALE_VOUCHER` or `NET_MISMATCH`.
The node reads the settled positions again and rebuilds the batch without what is already settled, at most 3 times a run; the cost is one failed transaction, and no funds move twice.
Calls a seller settled itself are booked as a seller settlement (`sst_...`), `settled` with `settledBy: "seller"`, in no batch and with no Merkle proof.

What you should do:

- Check `payminto_rpc_up` and the RPC provider: `unknown` batches usually mean the RPC is slow or down.
- Look at the batch in the dashboard or `GET /v1/batches/:id`; its `error` field holds the reason.
- If the log says a landed batch cannot be adopted because a position moved or its calls no longer rebuild its root, stop and investigate before settling again.
  That means the database and the hub disagree, which a restore from an old backup can cause.

A batch the hub refused outright is `failed`, with the hub's error code in `error`, and its calls are back in the queue.
A batch refused with `INSUFFICIENT_STORAGE` means the settler's storage balance on the hub ran out (section 12).
A batch id the hub holds for another settler, or with another root, is never booked: the batch fails and the `batch_mismatch` alert fires.
Calls the node dropped before sending are listed in the settlement result under `dropped`, with a reason such as `owner escrow cannot cover its net debit` or `budget is past its settlement deadline`.

## 11. Payouts waiting for registration

`GET /v1/payouts` lists each creditor account with a status.

| Status | Meaning | What to do |
|---|---|---|
| `due` | Queued for the next payout run | Nothing; `PAYOUT_INTERVAL_SEC` or `POST /v1/payouts` pays it |
| `waiting_registration` | The account is not registered with the token, so the hub skips it and its credit stays on the hub | Ask the account holder to register with the token (NEP-145 `storage_deposit`); the node checks again every 10 minutes |
| `clear` | No credit left | Nothing |

The hub never pays token registration for anyone.
Nothing is lost while an account waits: the credit is the account's own, and anyone can call `payout` for it once it registers.

A payout is safe to repeat.
The hub zeroes an account's credit before the transfer and restores it if the transfer fails, and the node reads what was paid back from the hub as credit before minus credit after.
A payout that paid nothing is retried with a backoff of 1, 2, 4 minutes and so on, up to an hour, and the reason is in the account's `lastError`.
Each payout call covers at most 10 accounts.

## 12. Gas and storage

- The node account pays gas for `settle_batch` and `payout`.
  Keep it funded.
- Hub storage is not paid by the hub account.
  The settler prepays a NEAR storage balance on the hub that `settle_batch`, `register_receipt_key` and checkout payments draw from.
  `settle_own` uses a reserve the owner paid for at `open_budget`, and then its caller's deposit.
- Owners pay the storage of their own Budgets when they call `open_budget`.

The settler's storage balance:

| Task | Hub method | Notes |
|---|---|---|
| Read the balance | `storage_of({ account })`, a view | The unused balance in yoctoNEAR |
| Top it up | `fund_storage({ account })`, with the NEAR attached as the deposit | Anyone may fund any account; `fundStorageTx` in `packages/chain/src/actions.ts` builds it |
| Take the unused part back | `withdraw_storage({ amount })`, with exactly one yoctoNEAR | Only the account itself, so it needs the node account's full-access key; `withdrawStorageTx` builds it |

When the balance cannot pay for a batch, the hub refuses the whole batch with `INSUFFICIENT_STORAGE` and changes nothing.
Settlement stops until the balance is topped up, and the same batch then settles.
One full batch of 100 claims to new 64-character payees can cost 0.36913 NEAR, which is the minimum the startup check asks for.
Measured on a sandbox (a local NEAR node), a batch of 100 one-unit claims to 100 new payees wrote 22,841 bytes and took exactly 0.22841 NEAR from the settler's balance, and the hub's own balance did not change.
In the `pnpm demo --chain sandbox` run for this page, the one batch of 183 calls took 0.01029 NEAR (1,029 bytes) from the node's balance, and the hub's own NEAR balance changed by 0.
Storage that a `credits` entry frees when it is paid out goes back to the balance of the settler that paid for it.

## 13. The payee check

The payee check is on by default (`PAYEE_CHECK=on`), and the startup log says `payee check on` with the indexer it uses.

- It reads accounts through `RPC_URL`.
  On a network's public default endpoint it also tries the second public endpoint when the first refuses, because both are rate limited; with your own `RPC_URL` it reads that endpoint and no other.
- Account ages come from NearBlocks on `near:testnet`, which learns the account ids that are checked.
  The keyless tier is rate limited; set `PAYEE_CHECK_INDEXER_KEY` for real traffic.
- A payee the owner approved, or one the Budget has paid 3 times, is decided on the verdict the node holds, with no network read on the call path.
  Any other payee is looked at within 3 seconds, and verdicts are reused for 30 seconds.
- When the look cannot finish, the node decides on the verdict it holds.
  Only a payee it has never seen is refused for that reason, with `PAYEE_BLOCKED` and a retry hint of 30 seconds, so a failing RPC endpoint or indexer shows up as refusals of first payments to new payees.
- Payees that wait for the owner are in `GET /v1/budgets/:id/payee-approvals` under `waiting`, and each new one is a `payee.approval_requested` event on `/v1/events`.
  Owners see and decide them on the Budget's page in the dashboard, which updates from that stream, so a proxy that buffers it (section 2) leaves them waiting on a page that does not change.
- Reports filed on this node carry the node's operator account, so this node is one reporter; `filedBy` says which signed-in person filed each one.
- Approvals, denials, withdrawals, block overrides and reports are written to the activity log.

## 14. The optional relayer

`apps/relayer` is a separate process with its own account and key, and the node does not depend on it.

- Give the relayer account a full-access key that only this service holds, and keep its NEAR balance small: the balance is the most a stolen key or a bug could cost.
- It pays only for zero-deposit calls to its own hub, to the methods in `ALLOWED_METHODS` (`revoke_budget`, `reclaim` and `payout` by default), up to `DAILY_GAS_BUDGET_TGAS` per UTC day.
- `GET /health` reports the gas used today, relays in flight and the relayer's balance, with `balance.low` true below `LOW_BALANCE_NEAR`.
- Set `GAS_LEDGER_PATH` to keep the daily gas count across restarts, and run one instance per relayer account.
- For the dashboard's "Revoke without gas", build the dashboard with `NEXT_PUBLIC_RELAYER_URL` and list the dashboard's origin in the relayer's `CORS_ORIGINS`.
- `apps/relayer/README.md` has every variable, every error code and the security model.
