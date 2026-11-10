# Payminto Relayer

An optional service that pays the NEAR gas for a small, fixed set of calls to the Payminto hub, so an owner who holds only USDC can still stop an agent.

An owner must always be able to revoke a Budget.
A revoke is a transaction, and a transaction needs NEAR for gas.
With this relayer the owner signs a NEP-366 delegate action off chain, and the relayer wraps it in its own transaction and pays.
The hub still sees the owner as the caller, so `revoke_budget` works unchanged.

It pays only for zero-deposit calls to its own hub, to the methods on its list.
It never holds user funds, and it cannot change what the owner signed.
Nothing else in Payminto depends on it: without a relayer, an owner revokes from a wallet with their own gas.

## Do this, see that

You can try the whole thing in two terminals with no NEAR node, no network and no real key.

Terminal 1 starts the real HTTP service over an in-memory chain:

```sh
pnpm install
pnpm --filter @payminto/relayer dev:fake
```

It prints the commands below with full paths, and writes a public test key and two signed sample requests to `apps/relayer/data/dev-fake/` (git-ignored, deleted on Ctrl-C).

Terminal 2, from the repository root:

```sh
# What this relayer pays for.
curl -s http://127.0.0.1:8790/info

# The owner's revoke of a Budget on the hub: relayed.
curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' \
  -d @apps/relayer/data/dev-fake/revoke-hub.json

# The same owner, the same call, any other contract: refused.
curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' \
  -d @apps/relayer/data/dev-fake/revoke-other-contract.json
```

You see, in order:

```json
{"relayer":"relayer.test.near","hub":"hub.test.near","network":"near:sandbox","methods":["revoke_budget","reclaim","payout"],"maxGasTgas":300}
```

```json
{"txHash":"6mYnuaNBup6Zf29v7zHsym9HfqVRpySqBVWnrFwCfho6","sender":"alice.test.near","receiver":"hub.test.near","methods":["revoke_budget"]}
```

```json
{"error":{"code":"NOT_SPONSORED","message":"receiver usdc.test.near is not the hub hub.test.near; this relayer only pays for calls to hub.test.near. Send this call with your own gas, or sign a delegate whose receiver is hub.test.near."}}
```

A few more, each with the answer it gets:

```sh
# The same signed delegate a second time: 409 NONCE_USED, with the hash of the first transaction. Never sent twice.
curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' \
  -d @apps/relayer/data/dev-fake/revoke-hub.json

# Not a signed delegate: 400 MALFORMED.
curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' -d 'not json'

# A body over the size cap: 413 PAYLOAD_TOO_LARGE.
head -c 20000 /dev/zero | curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' --data-binary @-

# Gas used today, relays in flight, and the relayer's balance.
curl -s http://127.0.0.1:8790/health
```

## Revoke from the command line

For an owner without the dashboard.
It builds the delegate for the hub's `revoke_budget`, signs it with the owner's key, posts it to the relayer once and prints the result.

```sh
pnpm --filter @payminto/relayer revoke --budget <id> --owner <account> --relayer <url>
```

Against the fake relayer from the section above (the Budget id is any 64 hex characters there):

```sh
pnpm --filter @payminto/relayer revoke \
  --budget abababababababababababababababababababababababababababababababab \
  --owner alice.test.near \
  --relayer http://127.0.0.1:8790 \
  --rpc-url http://127.0.0.1:8791 \
  --key-file "$PWD/apps/relayer/data/dev-fake/alice.test.near.json" \
  --dry-run
```

```text
Dry run: nothing was sent. Only GET /info and two read-only RPC queries were made.
Delegate (NEP-366), decoded from the signed bytes:
  sender:           alice.test.near
  receiver:         hub.test.near
  action 1:         revoke_budget({"budget_id":"abababababababababababababababababababababababababababababababab"})  gas 30 Tgas  deposit 0 yoctoNEAR
  nonce:            6
  max block height: 1120 (valid for about 120 blocks from now)
  public key:       ed25519:7rpDt11nvidzpRJRz8UiCndE4z58YqdktV5KYYpTMQ2P
  signature:        valid (not shown)
  key file:         /path/to/apps/relayer/data/dev-fake/alice.test.near.json
  relayer:          http://127.0.0.1:8790 (relayer.test.near on near:sandbox, pays the gas)
To send it, run the same command without --dry-run.
```

Without `--dry-run`:

```text
Revoked: Budget abababababababababababababababababababababababababababababababab of alice.test.near.
  transaction: Cj1EkvjBAm4qX2JKCUP8ZBb3aVZ9vJRiTQa74MDDDGin
  gas paid by: relayer.test.near
```

| Option | Meaning |
|---|---|
| `--budget <id>` | The Budget id, 64 lowercase hex characters |
| `--owner <account>` | The NEAR account that owns the Budget |
| `--relayer <url>` | The relayer's base URL; the hub and the network are read from its `/info` |
| `--key-file <path>` | The owner's NEAR credentials file (JSON with `private_key`), or a file with one `ed25519:<base58>` line |
| `--credentials-dir <dir>` | Use this instead of `~/.near-credentials` |
| `--rpc-url <url>` | NEAR JSON-RPC for the two reads; default is the public RPC of the relayer's network |
| `--ttl-blocks <n>` | How long the delegate stays valid; default 120 blocks |
| `--dry-run` | Build, sign and print the decoded delegate; post nothing |

Where the key comes from:

- With `--key-file`, from that file.
- Otherwise from `~/.near-credentials/<network>/<owner>.json`, where `<network>` is `testnet`, or `localnet` for a sandbox.
- Otherwise from the single key file in `~/.near-credentials/<network>/<owner>/`.
  If that directory holds several keys, the CLI lists them and asks for `--key-file`.

The key is read from a file only.
It is never accepted as an argument or an environment variable, and it is never printed or logged.
If something that looks like a secret key appears on the command line, the CLI stops before doing anything and tells you to rotate that key.

The CLI makes two read-only RPC queries (the key's nonce and the block height) and never sends a transaction itself.
It exits `0` when the Budget is revoked or the dry run is printed, `1` when the relayer or the hub refused or something failed, and `2` for wrong usage.
When the relayer answers that the outcome is unknown, the CLI says so and tells you to check the Budget before trying again.

## Run it

```sh
cp apps/relayer/.env.example apps/relayer/.env   # then fill in the three required values
pnpm --filter @payminto/relayer start            # loads apps/relayer/.env; shell variables win
```

Node 22.18 or newer is required.
Stop it with Ctrl-C or SIGTERM: it stops accepting requests and lets a relay in flight get its answer.

Before it accepts anything, the relayer checks that:

- every variable is present and well-formed (all problems are listed at once, each with what to put there);
- the RPC node answers, and serves the configured network and not mainnet;
- `RELAYER_KEY` is a full-access key of `RELAYER_ACCOUNT`.

If a check fails it prints the reason and exits with status 2.
For example, with nothing configured:

```text
Invalid relayer configuration:
  - RELAYER_ACCOUNT: is required: the account that pays the gas, for example relayer.example.testnet
  - RELAYER_KEY: is required: the relayer account's secret key, ed25519:<base58>, from its credentials file
  - HUB_ACCOUNT: is required: the Payminto hub contract, for example hub.example.testnet
See apps/relayer/README.md and apps/relayer/.env.example.
```

It then reads its own balance and logs a warning when it is below `LOW_BALANCE_NEAR`.
A low balance does not stop it from starting.

### The relayer account

Create a dedicated account for the relayer and use it for nothing else.

- Give it a **full-access key that only this service holds**.
  The outer transaction carries a `Delegate` action, and a function-call key cannot sign that.
- Keep its **NEAR balance small**: a few NEAR is plenty.
  The balance is the most that a stolen key or a bug in this service could cost.
  At the default budget the relayer attaches at most 3,000 Tgas a day, about 0.3 NEAR at the minimum gas price, and most of the attached gas is refunded.
- Do not reuse the hub's account, the node's operator account, or any account that holds tokens.
  The service refuses to start when `RELAYER_ACCOUNT` equals `HUB_ACCOUNT`.

## HTTP API

Errors are always `{ "error": { "code", "message" } }`, and every message says what the caller should do next.
Some errors carry extra fields: `txHash` when a transaction was signed, `outcomeUnknown` on `RPC_FAILED`, `retryAfterSec` on `RATE_LIMITED` (also sent as the `Retry-After` header).

### `GET /info`

```json
{ "relayer": "relayer.example.testnet", "hub": "hub.example.testnet", "network": "near:testnet", "methods": ["revoke_budget", "reclaim", "payout"], "maxGasTgas": 300 }
```

### `POST /relay`

Body: `{ "signedDelegate": "<base64 of the Borsh SignedDelegateAction>" }`.
`gasless.relayRequestBody(signed)` from `@payminto/near-addons` produces exactly this.

Success is `200` with `{ "txHash", "sender", "receiver", "methods" }`.
It is sent once the relayer's transaction is final and the hub ran the call.
A relay normally answers within a few seconds; the connection stays open until then, up to `SEND_TIMEOUT_MS`.

| Status | Code | When |
|---|---|---|
| 400 | `MALFORMED` | The body is not JSON, has no `signedDelegate`, or it is not a Borsh `SignedDelegateAction` |
| 403 | `NOT_SPONSORED` | The receiver is not the hub; a method is not on the list; a deposit is attached; more gas than the limit; any action that is not a function call; the window is longer than `MAX_TTL_BLOCKS` |
| 403 | `BAD_SIGNATURE` | The signature does not verify against the key in the delegate; that key is not an access key of the sender; or it is a function-call key that may not make this call |
| 409 | `EXPIRED` | `max_block_height` has passed, or is closer than `EXPIRY_MARGIN_BLOCKS` |
| 409 | `NONCE_USED` | The key's nonce on chain is already at or above the delegate's, or this relayer already submitted this delegate (then with `txHash`) |
| 413 | `PAYLOAD_TOO_LARGE` | The body is larger than `MAX_BODY_BYTES` |
| 422 | `CALL_FAILED` | The transaction ran and the hub refused the call, for example `NOT_OWNER` or `ALREADY_REVOKED`; carries `txHash` |
| 429 | `RATE_LIMITED` | Too many requests from the address or for the sender, too many relays in flight, or the daily gas budget is spent |
| 502 | `RPC_FAILED` | The relayer could not read NEAR or could not send; carries `outcomeUnknown` |

`RPC_FAILED` with `"outcomeUnknown": false` means nothing was sent, and the same request can be tried again.
With `"outcomeUnknown": true` a transaction was sent and its result is not known: it may still land.
The response carries its `txHash`.
The relayer never sends it again, and it answers a repeat of the same delegate with `409 NONCE_USED` and that hash.
Look the transaction up, or read the Budget on the hub, before signing anything new.

`CALL_FAILED` is the one code that is not in the first version of this contract.
The network reports a relayed transaction as a success even when the hub panics inside it, so without this code a refused revoke would have been answered `200`.
The relayer reads the hub's own receipt and reports the refusal.

A delegate carries exactly one receiver, and a request carries exactly one delegate, so a request can never reach more than one receiver.
Any bytes after that one delegate make the body `MALFORMED`.

### `GET /health`

```json
{
  "ok": true,
  "service": "payminto-relayer",
  "version": "0.1.0",
  "network": "near:testnet",
  "relayer": "relayer.example.testnet",
  "hub": "hub.example.testnet",
  "gas": { "day": "2026-11-10", "usedTgas": 35, "budgetTgas": 3000, "resetsAt": "2026-11-11T00:00:00.000Z" },
  "pending": 0,
  "balance": { "yocto": "3000000000000000000000000", "near": "3.0000", "low": false, "checkedAt": "2026-11-10T05:16:19.975Z", "error": null }
}
```

`balance` is the last value read; `/health` starts a new read in the background when it is older than a minute, and never waits for the RPC.
`balance.low` is `true` below `LOW_BALANCE_NEAR`, and `balance.error` says why the last read failed.

## What is checked before anything is sent

Every check fails closed: a delegate the relayer does not fully understand is refused.

1. The body decodes as a canonical `SignedDelegateAction`, with no trailing bytes.
2. The receiver equals `HUB_ACCOUNT`, and the sender is neither the hub nor the relayer.
3. Every action is a function call to a method in `ALLOWED_METHODS`, with zero deposit and some gas, and the total gas is at most `MAX_GAS_TGAS`.
   Transfers, key changes, deploys, account deletion, staking and account creation are refused wherever they appear in the list.
4. The signature verifies against the public key in the delegate.
5. Read from the chain: that key is an access key of the sender today, and may make this call.
   A function-call key must be for the hub, allow the method, and sign exactly one call.
6. Read from the chain: the delegate is still valid for more than `EXPIRY_MARGIN_BLOCKS` and for at most `MAX_TTL_BLOCKS`, and its nonce is above the key's.
7. The add-on's own `checkRelayPolicy` is run last, and anything it objects to is refused.

Steps 5 and 6 are there so the relayer does not pay for a transaction that must fail.

The encoder, the decoder and the default method list come from `@payminto/near-addons` (`gasless`), which is verified against nearcore's vectors.
The method list lives in one place: `ALLOWED_METHODS` when set, the add-on's `DEFAULT_RELAY_METHODS` when not.

## How it sends

Verified against near-kit 0.20.2 and against a near-sandbox 2.14.0 node:

```ts
const decoded = decodeSignedDelegateAction(bytes);            // { signedDelegate: { delegateAction, signature } }
const signed = await near.transaction(relayerAccount).signedDelegateAction(decoded).sign();
const outcome = await near.rpc.sendTransaction(signed.serialize(), "FINAL");
```

`signedDelegateAction` sets the transaction's receiver to the delegate's sender and adds the one `Action::Delegate`.
Before signing, the relayer re-encodes what near-kit decoded and requires it to equal the bytes the policy approved, byte for byte.
The transaction is signed once and those bytes are sent once.
near-kit's own retries are switched off for sends, and its `.send()` helper, which signs again with a new nonce after a nonce error, is not used.
Sends go out one after another, so the relayer's nonces stay in order.

## Configuration

All variables are validated once at startup with zod.
`apps/relayer/.env.example` lists every variable with its default.

| Variable | Default | Meaning |
|---|---|---|
| `RELAYER_ACCOUNT` | required | The account that signs the outer transaction and pays the gas |
| `RELAYER_KEY` | required | Its full-access secret key, `ed25519:<base58>`; never logged |
| `HUB_ACCOUNT` | required | The only contract the relayer pays for |
| `NETWORK` | `near:sandbox` | `near:sandbox` or `near:testnet`; mainnet is refused |
| `RPC_URL` | network default | NEAR JSON-RPC; a URL that names mainnet is refused, and so is a node whose chain id is mainnet |
| `PORT`, `HOST` | `8790`, `127.0.0.1` | Where it listens; loopback by default |
| `ALLOWED_METHODS` | `revoke_budget,reclaim,payout` | Comma-separated hub methods to pay for |
| `MAX_GAS_TGAS` | `300` | Most gas one delegate may attach, summed over its calls |
| `MAX_TTL_BLOCKS` | `600` | Longest validity window accepted |
| `EXPIRY_MARGIN_BLOCKS` | `5` | A delegate must have more blocks than this left |
| `DAILY_GAS_BUDGET_TGAS` | `3000` | Gas the relayer may attach per UTC day, across all senders |
| `GAS_LEDGER_PATH` | unset | JSON file that keeps the daily count across restarts |
| `RATE_LIMIT_IP_PER_MIN`, `RATE_LIMIT_IP_BURST` | `30`, `30` | Per client address on `POST /relay`; `0` per minute disables |
| `RATE_LIMIT_SENDER_PER_MIN`, `RATE_LIMIT_SENDER_BURST` | `6`, `6` | Per sender account; `0` per minute disables |
| `MAX_PENDING_RELAYS` | `16` | Relays in flight at once before `429` |
| `MAX_BODY_BYTES` | `16384` | Request body cap |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front whose `X-Forwarded-For` is trusted |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed to call from a browser |
| `LOW_BALANCE_NEAR` | `0.5` | Warn below this balance |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `READ_TIMEOUT_MS`, `SEND_TIMEOUT_MS` | `15000`, `60000` | Deadlines for one chain read and for one relay |

Only add a method to `ALLOWED_METHODS` if it takes no deposit and is safe for anyone to call, because the relayer will pay for any account's call to it.

### Trusted proxy hops

`TRUST_PROXY_HOPS` is how many `X-Forwarded-For` entries, counted from the right, the relayer trusts.
The client address is the entry that many places from the end.
The relayer uses it for the per-address rate limit, so a wrong value either lets clients fake their address or makes every client look like the proxy.

- Use `0` only when clients reach the relayer directly, because any client can then write the header.
  With `0` the header is ignored and the socket address is used.
- Behind one TLS proxy (Caddy, nginx), set `1`.
- Set `2` only if every request passes through two proxies that each append the address they saw.

### Logs

Logs are JSON lines on stdout.
Each relay writes one line, `relayed` or `relay refused`, with the client address, the sender, the receiver, the methods, the error code and the transaction hash.
The relayer's key, signatures and the raw `signedDelegate` are never written, and any string shaped like a NEAR secret key is masked wherever it appears.

## Security model and its limits

What the relayer can lose:

- **Only its own gas, and only up to the daily budget.**
  Every relay reserves the gas it attaches plus 5 Tgas for fees before anything is signed, and the relayer refuses with `429` once `DAILY_GAS_BUDGET_TGAS` is reserved for the UTC day.
  A reservation is given back only when the relayer knows nothing was sent, so an unknown outcome counts as spent.
- **It never holds user funds.**
  The outer transaction carries no deposit and one `Delegate` action.
  The calls it wraps carry no deposit either.
- **It cannot change what the owner signed.**
  The delegate's bytes are covered by the owner's signature, which the network checks again.
  The relayer can only relay them or not.
- **It cannot act for an owner.**
  It has no owner key.
  A relayer that is down or hostile can refuse to relay, and then the owner revokes from a wallet with their own gas.

What an abuser can do, and what stops them:

- Anyone with a NEAR account can make the relayer pay for a sponsored call that the hub then refuses, for example a revoke of a Budget they do not own.
  The relayer cannot know the hub's answer in advance.
  Each such call costs the relayer a few Tgas, is limited per sender and per address, and counts against the daily budget.
- A stranger cannot use up an owner's per-sender limit: a request counts against a sender only after its signature verifies against a key that is on that sender's account.
- Spending the whole daily budget stops gasless revokes for everyone until 00:00 UTC.
  Owners can still revoke with their own gas; the limit protects the relayer's balance, not availability.

Limits you should know:

- The 5 Tgas added per relay is a margin for the fees of the outer transaction and the delegate receipt.
  One sandbox run burned about 1.5 Tgas outside the attached gas; the margin is not a guarantee under a different gas schedule.
- The budget counts gas units, not NEAR.
  When the network's gas price rises, the same budget costs more NEAR; the small account balance is the hard stop.
- Rate limits and the memory of submitted delegates live in the process.
  Without `GAS_LEDGER_PATH` the daily count does too, and starts from zero on a restart.
- Run one instance per relayer account.
  Two instances with the same key would race on nonces and would each keep their own limits.
- The relayer reports the result of the hub call itself.
  What the hub does afterwards in its own receipts, such as the token transfers inside `payout`, is handled by the hub and is not part of the answer.
- Only version 1 delegates (`Action::Delegate`) signed with ed25519 keys are accepted.
  Gas-key delegates (`DelegateV2`) are refused.
- Sandbox and testnet only in this submission.

## Mount it in another service

```ts
import { createRelayerApp, NearRelayChain } from "@payminto/relayer";

const chain = new NearRelayChain({ rpcUrl, network: "near:testnet", relayer, relayerKey });
parent.route("/relayer", createRelayerApp(appConfig, { chain, logger }));
```

`createRelayerApp(config, deps)` takes no key: signing lives behind `deps.chain`, the `RelayChain` interface.
`startRelayer(config)` is the same app with the startup checks and a listener.
`@payminto/relayer/fake` exports `FakeRelayChain`, the in-memory chain the tests and `dev:fake` use.

## Tests

```sh
pnpm --filter @payminto/relayer test          # no network
pnpm --filter @payminto/relayer typecheck
pnpm --filter @payminto/relayer test:sandbox  # a real near-sandbox node; needs PAYMINTO_SANDBOX=1, which the script sets
```

The default suite uses real delegates, built by the add-on's encoder or byte by byte and signed with test keys.
It covers every policy rule and attack case, the rate limits, the daily gas budget, every send outcome, the startup checks, the CLI, and the near-kit send path against a JSON-RPC stub on the loopback interface.

The sandbox test deploys the hub from `contracts-near/out/hub.wasm` and proves a revoke for which the owner's NEAR balance does not change by one yoctoNEAR.
It also shows that the same owner's call to another contract is refused before the relayer spends anything, and that a stranger's revoke is reported as `CALL_FAILED`.
It uses the sandbox binary named by `NEAR_SANDBOX_BIN_PATH`, else the copy the contract's cargo tests downloaded, else near-kit downloads near-sandbox 2.14.0.
