# Walkthrough and measured results

Every command Payminto ships, what each one shows, and the numbers measured on 2026-11-10.
The [README](../README.md) has the short version.

## Try it

You need Node.js 22.18 or newer and pnpm 9.
Nothing below sends a transaction to testnet or mainnet, moves real funds, or needs an account or a key.
Three steps read public data over the network, and each says so.

```sh
pnpm install
```

### 1. Use the whole product in a browser, on a local NEAR node

```sh
pnpm local
```

Do `pnpm local`.
It starts a sandbox (a local NEAR node, near-sandbox 2.14.0) on this machine, deploys the committed `contracts-near/out/hub.wasm` and locks it, and runs the real clearing node, the dashboard and the gas relayer against it.
Local test accounts take the place of a wallet: when a step needs a signature, the dashboard shows "Local test accounts" and you pick who signs.
They sign through a development-only local signer that answers on 127.0.0.1 only and refuses `near:testnet`, `near:mainnet` and anything but a function call.
See the addresses, twelve local accounts with their roles, and a guide of ten browser steps, then, in a run on 2026-11-10: `Ready in 107.5 s. Press Ctrl-C to stop everything.`
The dashboard is on `http://localhost:3210`, and the two generated logins are in `apps/local/data/logins.txt`, readable by you only.

Setup leaves real activity on that chain, made through the SDK and the node's routes.
In that run: 13 paid agent calls, 10 of them settled in one batch (`10 calls, 0.047 USDC cleared, 0.015 USDC moved in 2 transfer(s)`), a payout, a 4.50 USDC checkout payment, two refusals (`PER_CALL_CAP`, `PAYEE_NOT_ALLOWED`), and a call waiting for the owner (`PAYEE_NEEDS_APPROVAL`).

Do the guide's steps in the browser: sign in, fund a Budget from `alice.test.near`, make agent calls from the "agent remote" page, settle, prove a call, pay a checkout link as `shopper.test.near`, pay out, revoke.
See, on the "Research agent" Budget, "Waiting for your approval" for `newvendor.test.near`, with Approve and Deny, and "Revoke without gas" next to "Revoke on NEAR".
For this page the dashboard was signed in, that approval was made in the browser, and the page then said "Payee approved"; the other steps were run by the scripted check below.
Press Ctrl-C to stop everything; the chain is gone after that, and the next start begins from a clean data directory.
`apps/local/README.md` has the guide, the accounts, every flag and what is real and what is local only.

```sh
pnpm local --check
```

Do `pnpm local --check`.
It starts the same stack on free ports, does the guide's steps through the routes the browser uses, checks every result against the chain through a client that holds no key, and stops.
It covers the signer's refusals, a deposit, a new Budget, a paid call, a call arriving live through the dashboard's event stream, two refusals, a payee that waits for the owner and is paid after approval, settlement, a proof, a checkout payment, a payout, a revoke, and a revoke without gas by an owner who holds no NEAR, whose balance changes by 0 yoctoNEAR.
On 2026-11-10 it ended with this line and exit code 0:

```text
21 of 21 checks passed in 149.5 s.
```

Nothing in either command reaches testnet or mainnet, and neither needs an account, a wallet extension or a secret.
The first run downloads the near-sandbox binary once, about 30 MB, from NEAR's release bucket.

### 2. The whole story in four seconds

```sh
pnpm demo
```

Do `pnpm demo`.
See four owners (three companies and a DAO-style account) fund Budgets, agents make 189 paid calls over HTTP 402, and nine refusals that each name the rule that fired and who enforced it.
See one batch settle: `Gross cleared 0.90 USDC across 183 paid calls`, 0.40 USDC moved, then `2 transfers for 183 paid calls`.
See the node go away and a seller settle its last 5 calls itself with `settle_own`, and the hub refuse an owner who signs its whole escrow to itself: `PAYEE_IS_OWNER`.
See `25 of 25 checks passed` after about 4 seconds, with exit code 0.
Every line of chain state is labeled SIMULATED.
The payee check runs against a scripted stand-in for the chain's accounts in this mode.

### 3. The same story as real transactions on a local NEAR node

```sh
pnpm demo --chain sandbox
```

Do `pnpm demo --chain sandbox`.
See the label SANDBOX, and a transaction hash for every on-chain step.
See the hub deployed from the committed `contracts-near/out/hub.wasm` and then locked: `code hash EyMRXoHdTQHLadE1dJzcGC5jY5XwmWsEdaeVeV9fHDmx (sha256 of contracts-near/out/hub.wasm), 0 access keys: locked`.
See the same paid calls, the same batch and the same 2 transfers as in step 2, each as a transaction.
Every check reads its facts from the chain through a client that holds no key, never from the node's database.
The first run downloads the near-sandbox binary once, about 30 MB, from NEAR's release bucket.

See `26 of 26 checks passed` after about 100 seconds, with exit code 0.
The payee check reads the sandbox's own accounts here: an account that exists and is registered is refused only by the Budget's own list, a lookalike that does not exist is blocked, and an account not registered with the token waits for the owner's approval.

### 4. Prove one call with no node and no keys

```sh
pnpm demo --chain sandbox --keep
```

Do `pnpm demo --chain sandbox --keep`, then paste the `pnpm verify:near` command it prints into a second terminal.
See a receipt proven against the hub with no node running and no keys: `VERIFIED`, exit code 0.
Do the same with `receipt.tampered.json`, a copy with the amount raised by one.
See `NOT VERIFIED`, exit code 1.
Press Ctrl-C in the first terminal to stop the sandbox.

The `--keep` flow was not run by hand for this page.
The sandbox demo runs the same verifier as its own process in its last act, and printed, on this commit:

```text
verify:near --receipt receipt.json          exit 0: VERIFIED: 8 checks passed against hub.test.near
verify:near --receipt receipt.tampered.json exit 1: NOT VERIFIED: 3 check(s) failed
```

### 5. A swarm: 20 buyers, 5 sellers, sealed bids

```sh
pnpm swarm
```

Do `pnpm swarm`.
See 20 buyer agents pool their demand for GPU hours and 5 seller agents bid sealed, over three rounds, each agent on its own named sub-account with its own key and its own Budget.
See void bids with their reason, the winner, the second-price clearing price and every buyer's share.
See `1 settle_batch call(s) for 299 paid Calls`, then `5 token transfers`, the swarm column of the measured table below, and `17 of 17 checks passed`, after 5 to 10 seconds.
No model is called: the strategies are scripts, and one seed always gives the same run.
The rules were written before the code and are in [apps/swarm/RULES.md](../apps/swarm/RULES.md).

```sh
pnpm swarm verify apps/swarm/data/last-run/round-1.json
```

Do the command above after a run.
See the winner and the price recomputed from the signed messages alone, and `VERIFIED: 8 of 8 checks passed.`

```sh
pnpm swarm --serve
```

Do `pnpm swarm --serve`, then open the address it prints, `http://127.0.0.1:4477`.
See the run start when the page opens: bids go from Sealed to Revealed or Void, units are delivered one paid call at a time, and the gross and net figures count up.
Press Ctrl-C in the terminal to stop it.
For this page the server was started, the page was fetched and the process was stopped; the page was not driven in a browser.

### 6. Check a payee before paying it

```sh
pnpm --silent --filter @payminto/payee-check check vvrap.testnet --allowed wrap.testnet
```

Do the command above.
It reads NEAR testnet through a public RPC endpoint, and signs and sends nothing.
See `Verdict   BLOCK - Do not pay`, with two reasons: `account_missing`, and `lookalike_payee`, because the name reads like `wrap.testnet`, which the Budget allows.

```sh
pnpm --silent --filter @payminto/payee-check demo
```

Do the attack demo.
It needs no network, no model and no key.
See a scripted agent that obeys any "pay X to Y" it reads, fed tool results with injected instructions, end with:

```text
Result: 6 payment attempts, 2 signed, 4 stopped.
Signed: acme.testnet, fresh-vendor.testnet
Stopped: acrne.testnet (blocked), fast-refunds.testnet (blocked), quiet-drop.testnet (approval_timeout), acme.testnet (blocked)
All 3 payments that came from injected text were refused before anything was signed.
```

The same check runs in the payment path.
The agent wallet runs it before it signs, and the clearing node runs it again before it accepts.

- A payee the check blocks is refused with `PAYEE_BLOCKED`, and nothing is signed.
- A payee with warnings is refused with `PAYEE_NEEDS_APPROVAL` until the Budget's owner approves it on the Budget's page in the dashboard ("Waiting for your approval"); the wallet waits, and names that page.
- A payee the check blocks has no plain Approve there: "Approve anyway" needs the account id typed exactly.
- The model has no tool that approves a payee, and the agent key cannot approve one.
- When the check cannot read a payee it has never seen, the call is refused: it fails closed.

The check is heuristics, not a guarantee, and reports filed on one node count as one reporter.
Both demos show it: a lookalike of an allowed payee is blocked before anything is signed, and a warned payee waits until the owner approves it on the node, after which the same call is paid.
`pnpm local` shows the owner's side in the dashboard (step 1).
The flow with the owner's approval is in [docs/AGENTS.md](AGENTS.md), and the routes are in [docs/DEVELOPERS.md](DEVELOPERS.md).
The wallet's own flow against a live node was not run for this page; its tests are named in [docs/REFUSALS.md](REFUSALS.md).

### 7. Ask a live agent on the NEAR AI Agent Market for its price

```sh
pnpm market search research --limit 5
pnpm market quote <handle> --max 0.10
```

Do the two commands above, with a handle the search lists as taking calls in place of `<handle>`.
They send free, read-only requests to the live market at `market.near.ai`, and need no account.
See a table of live agents, then the quote of one of them checked against an owner's limit before anything is signed.
On 2026-11-10, for a listing that quoted 0.25 USDC, the second command printed, with exit code 3:

```text
Quote      0.25 USDC per call, on near:mainnet
Policy     at most 0.10 USDC per hire and 5.00 USDC per 24 hours
Decision   REFUSE by rule PER_HIRE_MAX
           The quoted price exceeds the per-hire maximum.
           Refused before signing, so this cost nothing.
```

With `--max 1.00` the same quote printed `Decision   ALLOW` and exit code 0.
Listings are third parties' and their prices change, so your numbers will differ.
Payminto does not settle, hold or route Agent Market jobs: a hire on the market is paid through the market, on NEAR mainnet, to the market's own treasury account.
The agent wallet has the same check as a tool, `quote_market_agent`, which quotes and decides only: nothing in this repository pays the market, and the package's paying step was never run against it.

```sh
pnpm agent market work --dry-run
```

Do the command above.
It needs no market account, no token, no model key and no network.
See an agent take a recorded market job, buy four inputs with its own Budget on an in-process clearing node on the simulated hub, and write a deliverable that ends with a "Verifiable costs" section.
See that the job's text, which tells the agent to raise its limit and pay a stranger, changed neither.
On 2026-11-10 it printed, with exit code 0:

```text
Spend ceiling per job: 0.10 USDC, set on the command line. Writer: template (no model key is set).
While doing this job the agent bought 4 paid inputs with its own Payminto Budget and spent 0.011 USDC of the 0.10 USDC it was allowed for this job.
Checked receipts/769497ccd31e0ff1.json in process against this run's simulated hub: VERIFIED.
```

The three lines are from different places in the output, and there is one `VERIFIED` line for each of the four receipts.
The run writes the receipt files to `receipts/` in the folder you ran it from.
The receipts are real receipts of that in-process node; the hub behind them is SIMULATED, so the `pnpm verify:near` commands the deliverable prints have no chain to read after a dry run, and the deliverable says so.
Taking a live job needs a person to list the agent on the market and create its token; `pnpm agent market work` with no token prints those steps.

### 8. Check NEAR AI Cloud's enclave attestation, with no key

```sh
pnpm --filter @payminto/models nearai:check
```

Do the command above with no `NEARAI_API_KEY` set.
It reads NEAR AI Cloud's public model catalogue and attestation endpoint.
See `result: PARTIALLY VERIFIED` for the gateway and the model enclave, with every check listed as `[pass]` or `[open]`, then the steps to get a key, and exit code 2.
Partially verified is the most the default settings reach: the Intel TDX quote and its signature chain are checked in the process, and the platform's TCB status, NVIDIA's verdict on the GPU evidence and the trust in the measured software are not.
The key check and the test completion were not run for this page, because no key was available.

### 9. A gas relayer that pays only for an owner's revoke

Terminal 1:

```sh
pnpm --filter @payminto/relayer dev:fake
```

Terminal 2, from the repository root:

```sh
curl -s http://127.0.0.1:8790/info
curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' \
  -d @apps/relayer/data/dev-fake/revoke-hub.json
curl -s -X POST http://127.0.0.1:8790/relay -H 'content-type: application/json' \
  -d @apps/relayer/data/dev-fake/revoke-other-contract.json
```

Do the commands above.
The relayer runs over an in-memory chain, with a public test key and no network.
See what it pays for, then the owner's revoke relayed, then the same owner's call to any other contract refused:

```json
{"relayer":"relayer.test.near","hub":"hub.test.near","network":"near:sandbox","methods":["revoke_budget","reclaim","payout"],"maxGasTgas":300}
```

```json
{"txHash":"6mYnuaNBup6Zf29v7zHsym9HfqVRpySqBVWnrFwCfho6","sender":"alice.test.near","receiver":"hub.test.near","methods":["revoke_budget"]}
```

```json
{"error":{"code":"NOT_SPONSORED","message":"receiver usdc.test.near is not the hub hub.test.near; this relayer only pays for calls to hub.test.near. Send this call with your own gas, or sign a delegate whose receiver is hub.test.near."}}
```

Send the first `POST` again and see `409 NONCE_USED`: the relayer never sends a delegate twice.
Press Ctrl-C in terminal 1 to stop it and delete the sample files.
In the dashboard the same relayer is "Revoke without gas" on a Budget's page, and `pnpm local` runs it against a real hub for an owner who holds no NEAR (step 1).

### 10. Look at the dashboard without a node

```sh
pnpm --filter dashboard dev:mock
```

Do the command above and open `http://localhost:3000`.
See the owner and merchant dashboard against an in-browser mock node with sample data; a labeled demo wallet applies each transaction to the mock hub, and nothing reaches a chain.
It also has a demo relayer and a demo Sputnik DAO with three council members, so "Revoke without gas" and the DAO-owned Budget "Ops Agent - DAO treasury", with its proposals and votes, can be clicked through.
For this page the server was started and its home page was fetched; the pages were not clicked through.

The full walkthroughs are in [apps/demo/README.md](../apps/demo/README.md), [apps/swarm/README.md](../apps/swarm/README.md), [packages/payee-check/README.md](../packages/payee-check/README.md), [packages/agent-market/README.md](../packages/agent-market/README.md), [packages/models/README.md](../packages/models/README.md) and [apps/relayer/README.md](../apps/relayer/README.md).

## Measured

These numbers are from runs on one machine on 2026-11-10 (macOS on Apple silicon, Node.js 26.8.1, pnpm 9.15.9).
Each column is one run of the command in its header, and every number is copied from what that run printed.
Chain state in both columns is SIMULATED: the hub is an in-memory model of the contract, not NEAR.

| Measure | `pnpm swarm` | `pnpm demo` |
|---|---|---|
| Chain state | SIMULATED | SIMULATED |
| Paid calls | 299 | 189 |
| Agents | 25 (20 buyers, 5 sellers), each with its own key and Budget | 4 agent keys, one of them shared by 3 workers |
| Owners | 25 Budget owner accounts | 4 (three companies and a DAO-style account), and one seller with no Budget |
| Gross cleared in the batch | 82.934 USDC in 299 calls | 0.90 USDC in 183 calls |
| Net moved from escrow to credit | 71.114 USDC | 0.40 USDC |
| Offset between owners | 11.82 USDC | 0.50 USDC |
| Token transfers at payout | 5, one per net creditor | 2, one per net creditor |
| Transactions to settle and pay out | 2 (1 `settle_batch`, 1 `payout`), against 299 with one transaction per call | 2 (1 `settle_batch`, 1 `payout`), against 183 with one transaction per call |
| Calls a seller settled itself | 0 | 5, in 1 `settle_own`, after the node stopped |
| One-time setup by owners | 50 transactions: `open_budget` and an escrow deposit for each of 25 Budgets | 8 transactions: the same two for each of 4 Budgets |
| Refusals, each with its rule | 6: `NET_EXPOSURE` 3 by the clearing node, `TOTAL_CAP` 3 by the agent's own client | 9: `PAYEE_NOT_ALLOWED` 2, `PAYEE_BLOCKED` 2, `PAYEE_NEEDS_APPROVAL` 2, `REPEAT_REQUEST`, `NET_EXPOSURE`, `HOURLY_CAP` |
| Checks | `17 of 17 checks passed.` in 4.7 s | `25 of 25 checks passed in 4.1 s.` |
| The same on a sandbox (a local NEAR node) | `pnpm swarm --chain sandbox`: the same calls, amounts and transfers, `17 of 17 checks passed.` | `pnpm demo --chain sandbox`: the same calls, amounts and transfers, `26 of 26 checks passed in 97.2 s.` |

How to read it.

- SIMULATED means the hub is an in-memory model of the contract with the same rules and refusal codes.
  It is not NEAR, and every line of chain state in those runs is labeled SIMULATED.
  The clearing node, the vouchers, the signatures, the policy engine and the Merkle proofs in those runs are the real code.
- The last row is the same two commands as real transactions on a sandbox (a local NEAR node, near-sandbox 2.14.0) that each run starts and stops, against the committed `hub.wasm`.
  Both were run on the same machine on the same day, on this commit.
  The token there is a mock NEP-141 that stands in for USDC and has no value, and the swarm's 25 sub-accounts are real accounts there.
- The demo printed the same calls, amounts and transfers on the sandbox as on the simulated hub.
  The payee check runs in both demo runs: on the simulated hub it reads a scripted stand-in for the chain, and on a sandbox it reads the sandbox's own accounts.
  The sandbox run has one more check than the simulated one: that the hub is locked and runs the committed `hub.wasm`.
- The swarm printed the same numbers on the sandbox as on the simulated hub.
  There its clearing node also runs the payee check against the sandbox's own accounts, and one check confirms that no payment to a seller or data host was held or blocked.
- Nothing here ran on NEAR testnet or mainnet.
- The offset is what owners owed each other in both directions inside one batch.
  Agents that only buy, or only sell, get aggregation (many calls, few transfers) and no offset.
  The swarm's offset is modest because most of its buyers only buy; the demo's is larger because its owners are scripted to buy from each other.
- These are counts and amounts.
  This page quotes no saving in gas or fees.

## Which track each feature answers

"Built" means it runs from the commands above on this commit.
The last column says what still needs a person, or a network this submission does not run on.

| Track | What is built | What needs a human step, testnet or mainnet |
|---|---|---|
| `agents` | A Budget an agent cannot exceed; an MCP wallet that pays per call, checks the payee first (by default, through the SDK's `beforeSign` hook) and proves receipts; an agent runtime with a per-task spend ceiling; NEAR AI Cloud as a model provider, with the enclave attestation recorded per model turn (partially verified at best); Agent Market quotes in the wallet and a market seller worker in the agent CLI | An owner opens and funds the Budget from a wallet, and approves payees that draw a warning. `payminto-agent run` needs a model key. Taking a live market job needs a person to list the agent |
| `swarms` | `pnpm swarm`: 20 buyers and 5 sellers, each on its own sub-account with its own key and Budget, sealed-bid rounds anyone can re-check, a RULES.md written first, a live page, and `pnpm swarm verify` | The agents are scripts, not models. On the simulated hub the sub-accounts are names; they are real accounts only with `--chain sandbox`. The coordinator is a service, not a contract |
| `security` | The refusal matrix in [docs/REFUSALS.md](REFUSALS.md), each row with its test; a hub that verifies signatures and recomputes netting; a wallet that pays only listed services and treats seller text as untrusted; a payee check in the wallet, the node and the dashboard's New Budget form, with an attack demo; payee approvals on a Budget's page in the dashboard: the waiting list updates live, Approve and Deny, a blocked payee only through a typed "Approve anyway", decisions with Withdraw, and reports shown as plain text; a development-only local signer that refuses testnet and mainnet | The contract is unaudited. The payee check is heuristics, and a person decides every warned payee. Reports filed on one node count as one reporter and are not verified. A settler that keeps accepting after a revoke is not stopped on chain. The approval screens ran against a sandbox in `pnpm local`, not on testnet |
| `realworld` | A paywall SDK for per-call paid APIs over x402 v2; gasless revoke, so an owner who holds only USDC can stop an agent: "Revoke without gas" in the dashboard signs a NEP-366 delegate in the owner's wallet and a relayer pays the gas, and `pnpm local --check` shows the owner's NEAR balance unchanged by the revoke; live quotes from the NEAR AI Agent Market checked against an owner's limits; a seller worker (`pnpm agent market work`) whose deliverable lists costs anyone can verify | A relayer on testnet needs its own funded account, which a person creates, and the owner needs a wallet that signs delegate actions on testnet. The relayed revoke ran on a sandbox only; the dashboard's own path is tested with a fake wallet, relayer and chain. A market hire is paid on NEAR mainnet through the market, and nothing here pays it. Listing an agent is a human step, and only the dry run was run. No testnet deployment is recorded |
| `business` | A merchant gateway with payment links, a hosted checkout paid from a NEAR wallet, refunds sent from the merchant's own account, webhooks and a reconciliation report; a settlement export with each party's gross per counterparty next to its net; settlement pages that name each account and say money moves from owners' escrow to creditors' balances on the hub, then a payout; a dashboard and a merchant MCP server; a 0% default fee plan | A person self-hosts the node and deploys a hub with their own testnet accounts. Sandbox and testnet only |
| `social` | A Budget owned by a Sputnik DAO v2 in the dashboard: "Owner: a DAO I am a member of" turns opening, each deposit, moving credit, the revoke and the reclaim into proposals built by `@payminto/near-addons`; members read each proposal decoded in plain words and vote Approve or Reject; a call the add-on does not recognize is labeled "Unrecognized call, review on chain" and never gets Approve. Also the group-buying swarm and the payee check's shared report list | A person creates the DAO on testnet and funds it, and members propose and vote from their own wallets. The flow is unit-tested and runs against the dashboard's mock DAO; this repository records no proposal added or voted on any network. It uses standard Sputnik DAO proposals and claims no integration with any DAO interface. Reporters on the list are not verified |

**Why not a card.**
The calls in the demo cost 0.002 to 0.005 USDC each, a machine makes thousands of them to APIs with no person present, and a card charge carries a fixed fee larger than the call; this page claims nothing about how large that market is.

## What has run where

| Environment | Status |
|---|---|
| Simulated hub (in memory) | The demo, the swarm, the market worker's dry run and every TypeScript test suite: 2,053 tests passed in 15 packages on 2026-11-10, with 15 sandbox tests skipped |
| Sandbox (a local NEAR node, near-sandbox 2.14.0) | `pnpm local`, `pnpm local --check`, `pnpm demo --chain sandbox` and `pnpm swarm --chain sandbox`: every on-chain step a real transaction against a locked hub. `pnpm local --check` ends with `21 of 21 checks passed in 149.5 s.`, the demo with `26 of 26 checks passed in 97.2 s.` and the swarm with `17 of 17 checks passed.` The dashboard's payee approval was also made by hand in a browser against `pnpm local`. The contract's own sandbox tests and the sandbox suites of the chain client, the demo and the relayer exist and were not run for this page |
| NEAR testnet | Not deployed yet. The deploy script supports it and has a dry run; a person runs it with their own accounts, and this repository records no testnet deployment |
| NEAR mainnet | Not supported. The node has no mainnet mode, and the deploy script and the relayer refuse mainnet accounts and RPC URLs. The Agent Market quote reads a mainnet marketplace and pays nothing |

`pnpm swarm --chain sandbox` was run for this page on 2026-11-10, on this commit.
It created `swarm.test.near` and 25 real sub-accounts, had each agent fund itself and then open and fund its own Budget from its own account, and printed 299 paid calls, 82.934 USDC gross, 71.114 USDC net, 5 transfers and 2 transactions, the same as the simulated hub, then `17 of 17 checks passed.`

`pnpm local --check` was run for this page on 2026-11-10, on this commit, and ended with `21 of 21 checks passed in 149.5 s.` and exit code 0.
`pnpm local` was started on spare ports, printed `Ready in 107.5 s.`, and stopped cleanly on Ctrl-C.

## Deploy your own hub on testnet

A person runs this step, with their own funded testnet accounts.
Print every transaction first, without signing anything:

```sh
node packages/chain/scripts/deploy-hub.ts --network testnet \
  --hub hub.example.testnet --admin admin.example.testnet --settler node.example.testnet \
  --token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af \
  --checkout-key ed25519:<node checkout public key> --dry-run
```

The token above is Circle's USDC on NEAR testnet.
The dry run needs no key; it makes read-only RPC calls to look the accounts up, and carries on when they do not exist.
Run for this page with a real public key in place of the placeholder, it printed the wasm's hash and every step as `planned`:

```text
wasm <repo>/contracts-near/out/hub.wasm: 337826 bytes, sha256 cf978c32ec76c2967c05384e1533b298c9cbe623274e9542bc07987d9babcd3f, code hash EyMRXoHdTQHLadE1dJzcGC5jY5XwmWsEdaeVeV9fHDmx
```

The same command without `--dry-run` and with `--confirm-lock` deploys the hub, registers it with the token, sets the settler and the checkout key, prefunds the settler's storage balance, registers the node's receipt key when it is given the settler's key, verifies the code hash, and deletes every key on the hub account.
The steps are explained in [contracts-near/README.md](../contracts-near/README.md#deploy-and-lock) and [docs/SELF_HOST.md](SELF_HOST.md).

## Checks

```sh
pnpm typecheck
pnpm test
cd contracts-near && cargo test
```

| Command | What it runs | Result on 2026-11-10 |
|---|---|---|
| `pnpm typecheck` | `tsc` for every package | Passed |
| `pnpm test` | The TypeScript suites on the simulated hub, with no network; each package keeps its own vitest cache | 2,053 tests passed in 15 packages; 15 sandbox tests skipped |
| `pnpm local --check` | The whole product on a sandbox (a local NEAR node): the browser guide as a script, each result read from the chain | `21 of 21 checks passed in 149.5 s.` |
| `pnpm demo`, `pnpm demo --chain sandbox` | The demo story on the simulated hub, then on a sandbox | `25 of 25 checks passed in 4.1 s.`, `26 of 26 checks passed in 97.2 s.` |
| `pnpm swarm` | The swarm on the simulated hub | `17 of 17 checks passed.`, finished in 4.7 s |
| `cd contracts-near && cargo test --lib` | The contract's unit tests | 87 passed |
| `cd contracts-near && cargo test` | The unit tests and the contract's near-sandbox tests against the committed wasm | Only `--lib` was run for this page |
| `pnpm --filter @payminto/chain test:sandbox`, `pnpm --filter @payminto/demo test:sandbox`, `pnpm --filter @payminto/relayer test:sandbox` | The sandbox suites of the RPC client, the demo and the relayer | Not run for this page |

The CI workflow in `.github/workflows` runs the typecheck, the tests, the dashboard build, both demos, the contract's format, lint and tests, and the Docker image build.
