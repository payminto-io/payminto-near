# Payminto demo

One command runs the whole Payminto story and ends with a checks block.
It runs on a simulated hub in a few seconds, or on a real NEAR runtime: a fresh near-sandbox node started for the run.

```sh
pnpm demo                          # simulated hub, about 190 paid calls, a few seconds
pnpm demo --chain sandbox          # a fresh local near-sandbox node, the same story, about 70 seconds
pnpm demo --chain sandbox --keep   # the same, then the sandbox stays up for pnpm verify:near until Ctrl-C
pnpm verify:near --rpc-url <url> --hub <account> --receipt <receipt.json>   # check a receipt yourself
```

Both modes run the same acts and the same checks, and the exit code is 0 only when every check passes.
Nothing in either mode touches testnet or mainnet, moves real funds, or creates accounts outside the run.

## Simulated hub: `pnpm demo`

Do `pnpm demo`.
See every line that shows chain state labeled SIMULATED: the hub is an in-memory model of the contract with the same rules and refusal codes.
See `25 of 25 checks passed` at the end, a few seconds after the start.
This mode needs nothing but Node.js 22.18 or newer, and it is what CI runs.

## Sandbox: `pnpm demo --chain sandbox`

Do `pnpm demo --chain sandbox`.
See the label SANDBOX: a local NEAR node (near-sandbox 2.14.0) that the demo starts on 127.0.0.1, and stops when it ends.
See a transaction hash for every on-chain step, then `26 of 26 checks passed` after about 100 seconds.

What happens, in order, all as real transactions on the sandbox:

1. Do nothing, see section 0: the sandbox root creates the hub, admin, token, node, owner and seller accounts, each with its own key.
   The lookalike account of section 7 is never created, so the chain itself says it does not exist.
   The token account deploys `contracts-near/out/mock_ft.wasm`, a mock NEP-141 that stands in for USDC in the sandbox only.
2. See `packages/chain/scripts/deploy-hub.ts` run as its own process: it deploys `contracts-near/out/hub.wasm`, registers the hub at the token, sets the settler and the checkout key, prefunds the node's storage balance, and locks the hub by deleting every key on its account.
   See the hub's code hash, which is the sha256 of the committed `hub.wasm`, and `0 access keys: locked`.
3. See the node account add 2 NEAR to its own storage balance with `fund_storage`, and register its receipt key with `register_receipt_key`, both built by `fundStorageTx` and `registerReceiptKeyTx` in `packages/chain/src/actions.ts`.
   The hub never pays for the storage a batch writes, and `settle_own` takes a voucher only with an acceptance signed by a registered key.
   See the node account add a function-call key that can call only `settle_batch` and `payout` on the hub.
   The clearing node runs with that key and builds its own `NearRpcChain` from `RPC_URL` and `OPERATOR_KEY`, as it does in production.
4. See each owner mint mock USDC, `open_budget` and `ft_transfer_call` into escrow from its own wallet, through the wallet action builders in `packages/chain/src/actions.ts`.
5. See the same acts as the simulated story: paid calls over HTTP 402, the refusals, one netted batch settled by the node, the payee check, `fund_from_credit` from Acme's wallet, the node's payout through `POST /v1/payouts`, receipt proofs, and `settle_own` from the scan seller's exported vouchers after the node stops.
   In section 4, see the storage line: the batch's bytes came out of the node's prepaid storage balance, the hub account grew by exactly that many bytes, and the hub's own NEAR balance changed by 0.
   In section 7, see the payee check read accounts this run created on the sandbox: the lookalike blocked because the chain has no such account, and the new vendor warned because the mock token has no registration for it.
   In section 8, see the seller's `settle_own` carry the node's acceptance, and then see the hub refuse vouchers the node never accepted.
   Acme's owner signs its whole escrow to itself with its agent key and gets `PAYEE_IS_OWNER`, and to an accomplice with an acceptance it signed itself and gets `ACCEPTANCE_KEY_UNKNOWN`.
   Initech revokes its Budget, and a voucher signed with its agent key afterwards gets `ACCEPTANCE_KEY_UNKNOWN`, and `ACCEPTANCE_TOO_LATE` even with the node's own signature dated one second after the revoke.
6. See section 9: `pnpm verify:near` runs as a separate process with no node and no keys, proves `receipt.json`, and rejects `receipt.tampered.json`, a copy with the amount raised by one.

Every check reads its facts from the hub through a `NearRpcChain` that holds no key: Budgets, batches and their transaction status, credits, token balances, the Merkle root, the node's receipt keys and storage balance, the hub account's storage and NEAR balance, the hub's answers to the refused `settle_own` calls, solvency and the hub's access keys.
Calls and refusals are what the agents saw over HTTP, and nothing is read from the node's database.
The sandbox-only check confirms that the hub is locked and runs the committed `hub.wasm`.

The demo finds the near-sandbox binary in this order: `NEAR_SANDBOX_BIN_PATH`; the copy the contract's cargo tests downloaded under `contracts-near/target`, in this checkout or, from a git worktree, in the main checkout; then near-kit's cache in `~/.near-kit/sandbox/bin`.
If none exists, near-kit downloads near-sandbox 2.14.0 once from NEAR's release bucket, about 30 MB.

## The payee check: section 7

Before a Budget pays an account, the agent's wallet and the clearing node look at that account on chain.
Both modes run this with the check on: the node is started with `startNode(config, { payeeCheck })`, and Globex's MCP wallet runs its guard before it signs.
On the sandbox both read the sandbox's own RPC through the read-only reader of `@payminto/payee-check`, with no indexer, so account ages are not checked and every verdict says so.
On the simulated hub they read the package's fake reader, which the story's wallets keep in step: an account is registered with the token once it mints or registers.

Three accounts show the three answers:

| Account | On chain | The node's check | What the story shows |
|---|---|---|---|
| `rogue` | Exists and is registered with the token | allow | Act 3: the wallet and the node refuse it with `PAYEE_NOT_ALLOWED`, the Budget's own allowed-payee rule |
| `5can` | Does not exist | block: `account_missing`, `lookalike_payee` of `scan` | A planted note in a paid brief says the scan service moved there. The wallet refuses with `PAYEE_BLOCKED` and signs nothing, and a guard-off runtime is refused by the node with `PAYEE_BLOCKED` |
| `newdesk` | Exists and is not registered with the token | warn: `token_unregistered` | It is on Globex's list. The call waits with `PAYEE_NEEDS_APPROVAL`, the owner approves on the node, the same call is paid, and after the approval is withdrawn the next call waits again |

Do `pnpm demo`, see section 7.
See the node's verdict for each account, read from `GET /v1/payees/check`.
See the wallet's refusal of the lookalike, its signed position for that payee at 0, and the node's positions for Globex's Budget unchanged.
See the node's own signed record of the guard-off runtime's refusal, read from `GET /v1/budgets/<id>/refusals` and verified against the node's receipt key.
See the waiting call listed by `GET /v1/budgets/<id>/payee-approvals`, the approval sent to `POST /v1/budgets/<id>/payee-approvals`, the paid call booked at the node, and the withdrawal sent to `DELETE /v1/budgets/<id>/payee-approvals/<payee>`.
The three checks named `PAYEE_NOT_ALLOWED`, `PAYEE_BLOCKED` and `PAYEE_NEEDS_APPROVAL` read their facts from the node's routes and from the chain, never from the node's database.

## Check a receipt yourself: `pnpm verify:near`

Do `pnpm demo --chain sandbox --keep`.
See the checks, then a ready-to-paste `pnpm verify:near` command with the sandbox's RPC URL, the hub account and the path of `receipt.json`.
Do that command in another terminal.
See each check it makes, read from the chain, and `VERIFIED` with exit code 0:

- the receipt names this hub and network;
- the batch is stored on the hub, with its root, settler, gross and net;
- the Budget is on the hub, and the batch was settled by the Budget's own settler;
- the voucher signature verifies against the Budget's agent key as stored on chain;
- the payee is allowed by the Budget;
- the Merkle path folds from the receipt's leaf to the stored root, computed by the verifier itself;
- the hub's own `verify_receipt` view agrees.

Do the same command with `receipt.tampered.json` instead.
See three checks fail, `NOT VERIFIED` and exit code 1.
Do `pnpm verify:near --rpc-url <url> --hub <account> --batch <batch id>` to see what the hub stores for one batch.
Press Ctrl-C in the demo's terminal to stop the sandbox.

The verifier needs only an RPC URL, a hub account and a receipt file or batch id; `NEAR_RPC_URL` and `HUB_ACCOUNT` work in place of the flags.
It reads the hub's network and token from the hub itself, and reports whether the hub account still has any access key.
It exits 0 when every check passes, 1 on any mismatch, and 2 for bad arguments, an unreadable file, or a hub it cannot read.
A proof shows that the call is in a batch root its settler committed to on chain, and that the Budget's agent key signed it.
It does not prove delivery, or that the root covers every voucher.

## Shutdown, timeouts and stalls

The demo stops the node and the sandbox on success, on failure, on Ctrl-C and on the overall timeout, and a second Ctrl-C kills the sandbox at once.
The sandbox runs in its own process group with its output in `sandbox.log` in the run directory, never in a pipe.
Each sandbox is recorded under the OS temp directory, so a run that was killed outright has its sandbox stopped by the next run.
The overall timeout is 120 seconds for the simulated hub and 600 seconds for the sandbox, and `--timeout <seconds>` changes it.
When it passes, the demo prints `TIMEOUT`, the last step it reached and where the sandbox log is, then shuts down and exits with code 3.
While the story runs, the demo watches block production and prints a warning if the sandbox produces no block for 15 seconds.
Every sandbox transaction and view has its own deadline, because near-kit's RPC client sets none and Node's fetch would otherwise wait 300 seconds per attempt.

## Data

Each run writes a disposable directory under `apps/demo/data` (git-ignored), or under `DEMO_DATA_DIR`.
Every database in it ends in `.demo.db` and passes the node's reset guard before it is opened.
The directory also holds the scan seller's voucher store (`scan.vouchers.json`) and its export for `settle_own`, each voucher with the node's acceptance, `receipt.json` and `receipt.tampered.json`, and in sandbox mode `sandbox.log`.
The sandbox's own chain data lives in a temporary directory that is deleted when the sandbox stops.

## Options

| Flag | Variable | Default | Meaning |
|---|---|---|---|
| `--chain fake\|sandbox` | `DEMO_CHAIN` | `fake` | The simulated hub, or a fresh local near-sandbox node |
| `--scale <n>` | `DEMO_SCALE` | `1` | Multiplies the calls in each act |
| `--timeout <seconds>` | `DEMO_TIMEOUT_SEC` | `120` or `600` | Deadline for the whole run |
| `--keep` | `DEMO_KEEP=1` | off | Sandbox only: keep the sandbox up after the checks until Ctrl-C |
| | `NEAR_SANDBOX_BIN_PATH` | | The near-sandbox binary to use |

Exit codes: 0 every check passed, 1 a check failed or the run broke, 2 a configuration error, 3 the timeout passed, 130 interrupted.

## Tests

```sh
pnpm --filter @payminto/demo test           # fast: the simulated story, the checks, the verifier, the reaper
pnpm --filter @payminto/demo test:sandbox   # about 70 seconds: the story on near-sandbox
```

The fast suite runs the story at a quarter of the calls, asserts that every check passes and that the checks fail when an invariant breaks, and runs the verifier against the receipt the story wrote, genuine and tampered.
The sandbox suite runs only with `PAYMINTO_SANDBOX=1`, which `test:sandbox` sets, and asserts every check, steady block production, and that no sandbox process is left.
