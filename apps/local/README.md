# Payminto local

One command starts the whole product on this machine, on a real NEAR runtime, for a person to use in a browser.

```sh
pnpm install
pnpm local
```

It needs Node.js 22.18 or newer and pnpm 9.
It needs no testnet account, no wallet extension and no secret, and it never reaches testnet or mainnet.
It takes about 100 seconds to start, most of it deploying contracts and compiling the dashboard, and then prints a guide and waits for Ctrl-C.

## What it starts

1. A fresh near-sandbox node on 127.0.0.1: a local NEAR node, version 2.14.0.
2. The mock USDC token and the hub contract from the committed `contracts-near/out/hub.wasm`, deployed and locked by `packages/chain/scripts/deploy-hub.ts`.
   This step is the demo's own hub factory (`createHub` in `@payminto/demo`), so it always matches what `pnpm demo --chain sandbox` deploys.
3. Named local accounts, each with its own key that exists only on this chain.
4. The real clearing node (`@payminto/node`) with its real `NearRpcChain`, the gateway on, and its database in `apps/local/data/`.
5. A local signer on 127.0.0.1 that signs for the local accounts in place of a browser wallet.
6. The real gas relayer (`@payminto/relayer`) with its own funded account.
   A fake 1Click server for the any-chain checkout (NEAR Intents, simulated), and the node runs with `INTENTS_CHECKOUT=simulated`; see "Any-chain checkout, simulated" below.
7. Six small paid services behind the SDK paywall, and an agent remote: a page that makes paid agent calls.
8. First-run setup, done through the node's HTTP API exactly as a person would do it in the dashboard.
9. A little real activity, so every page has something true to show.
10. The dashboard (`next dev` in `apps/dashboard`), pointed at that node, signer and relayer.

## The local signer is a development tool

**The local signer is for development only.**
**It holds full-access keys and signs whatever a caller with the run's token asks for.**
That is acceptable for one reason: those keys exist only on a throwaway chain on this machine.
It is built to be useless anywhere else:

- It binds to 127.0.0.1 and answers only requests addressed to a loopback host.
- Every request needs a random token made for this run.
- A browser request is accepted only from the dashboard's own origin, and CORS allows nothing else.
- Every signing request must name the network `near:sandbox`; `near:testnet`, `near:mainnet` and a missing network are refused.
- It refuses to start unless the RPC it signs against is on loopback and reports the sandbox chain id.
- It signs function calls only: no key changes, no deploys, no account deletion, no plain transfers.
- It writes one log line per signature with the account, the receiver and the methods, and never any key material.

The dashboard loads its local signer driver only when `NEXT_PUBLIC_NEAR_NETWORK` is exactly `sandbox`, a signer URL and token are set, and that URL is plain http on a loopback address.
With `testnet`, `mainnet` or anything else, the driver is never loaded and the dashboard uses a NEAR wallet.
Before it shows an account, the driver also asks the signer and the Payminto server behind the dashboard which network they are on, and stops unless both say `near:sandbox`.

## Local accounts

| Account | Role | What it does |
|---|---|---|
| `alice.test.near` | Budget owner | Owns the Budget "Research agent", and sells briefs that Bob's agent buys |
| `bob.test.near` | Budget owner | Owns the Budget "Trading agent", and sells quotes that Alice's agent buys |
| `carol.test.near` | Budget owner, no gas | Owns the Budget "Support agent"; holds USDC and no NEAR for gas, so she can only revoke through the relayer |
| `seller.test.near` | Seller | Is paid for the Risk Scan and Deep Report services |
| `merchant.test.near` | Merchant payout | The payout account of the business Northwind Coffee |
| `anychain.test.near` | Any-chain payout | Northwind Coffee's account for payments from other chains (NEAR Intents, simulated): the USDC lands in it directly |
| `shopper.test.near` | Shopper | Pays checkout links |
| `platform.test.near` | Platform operator | The fee treasury of whoever runs the server |
| `node.test.near` | Settler | The node's own account; the node holds a key limited to `settle_batch` and `payout`, and the signer does not hold it |
| `relayer.test.near` | Gas relayer | Pays gas for `revoke_budget`, `reclaim` and `payout` on the hub; only the relayer holds its key |
| `solver.test.near` | 1Click solver (simulated) | The fake 1Click server delivers any-chain payments from it with a real `ft_transfer` of mock USDC; only the stack holds its key |
| `newvendor.test.near` | New payee | Exists on chain and never registered with the token, so the node's payee check warns about it and its payouts wait |
| `hub.test.near` | Hub | The Payminto contract, locked: it has no access key |
| `usdc.test.near` | Mock USDC | A mock NEP-141 token |

When a step needs a signature, the dashboard shows "Local test accounts" in place of a wallet's window, and you pick who signs.
The choice belongs to the page it was made on: a Budget page asks for its owner, a checkout page asks again.
Every screen still shows the exact transaction before it asks, as it does with a real wallet.

## Any-chain checkout, simulated

The node runs the any-chain checkout (method `oneclick`, docs/DEVELOPERS.md "Any-chain checkout") in simulated mode, labeled "Simulated - no real money" everywhere.
Nothing reaches the live 1Click API or NEAR mainnet:

- A fake 1Click server from `@payminto/near-addons` listens on 127.0.0.1 and signs quotes with a public test key; the node is configured to trust only that key.
- The local chain stands in for NEAR mainnet and the mock USDC for native USDC.
- When a simulated deposit arrives, the fake server's solver account `solver.test.near` sends a real `ft_transfer` of mock USDC to the business's any-chain account, so the node's delivery check reads a real transaction and its NEP-141 event on this chain.

Setup proves `anychain.test.near` as the business's any-chain account with a NEP-413 message it signs, and the Admin turns the method on.
The guide's any-chain step does through the node's API what the checkout's "Any chain" tab will do: get the options, get a deposit address for USDC on Base, simulate the deposit, and watch the quote reach `confirmed`.
A second link, "Gift card, 2 USDC", is for sending too little: the deposit is returned and the payment is open again.
The fake server's log is `apps/local/data/logs/oneclick-fake.log`.

## Transactions and proofs on a local node

A local node has no public explorer, so no page links a sandbox transaction to an explorer.
Every result shows the transaction hash with a copy button, and a note says that it ran on the NEAR node on this machine.
The browser reads receipt proofs straight from the sandbox's own RPC.
near-sandbox answers browser requests from any origin (`Access-Control-Allow-Origin: *`), so no RPC proxy is needed and none is started.

## The guide

`pnpm local` prints this with the real addresses of the run.
The logins are in `apps/local/data/logins.txt`, readable by you only; the command prints the path and never a password.

1. **Sign in.**
   Do: open the dashboard's `/login` and use the "Platform owner" login.
   See: Home, with Live Calls, two refused calls with their rule, one settlement and a payment.
2. **Fund a Budget from a local account.**
   Do: Budgets, then "Research agent"; under Escrow type 2 and press Deposit; read the transaction, confirm, and pick `alice.test.near`.
   See: "Final on NEAR" with the transaction hash; after a reload, "In escrow" is up by 2.00 USDC.
3. **Make an agent call.**
   Do: open the agent remote, keep "Research agent" selected and press "Call Bob's Quotes".
   See: "Paid 0.002 USDC" there, and the same call at the top of Live Calls on the dashboard's Home without a reload.
4. **Trigger a refusal.**
   Do: in the agent remote press "Call Deep Report", which costs 0.25 USDC against a 0.05 USDC limit per call.
   See: "Refused by the node" with the rule `PER_CALL_CAP`; under Blocked in the dashboard, the rule, the attempted amount, what is left of the Budget and "No money moved".
5. **Approve a payee.**
   Do: in the agent remote press "Call New Vendor"; its payee `newvendor.test.near` is on the Budget's list but never registered with the token.
   See: "Waiting for the owner" with the rule `PAYEE_NEEDS_APPROVAL`, and nothing paid.
   Do: approve the payee, then call again.
   See: "Paid 0.003 USDC".
   The owner approves on the Budget's page in the dashboard: "Research agent", then "Waiting for your approval", then Approve or deny, then Approve.
   The agent remote links to that page and has no way to approve a payee itself: only the owner approves.
6. **Settle now.**
   Do: open "Next settlement" and press "Settle now".
   See: how many transfers the calls would take one by one and how few after offsetting; under Settlements, gross cleared next to tokens moved.
7. **Prove a call.**
   Do: on Home, click the amount of a settled call in Live Calls.
   See: "Verified on NEAR" and "Read from http://127.0.0.1:...": the browser read the batch root from the local chain itself.
8. **Pay a checkout link as the shopper.**
   Do: open the payment link, press "Continue to pay", then "Pay 4.50 USDC", and pick `shopper.test.near`.
   See: "Payment complete" and its payment proof; Payments shows it as Paid.
9. **Pay out.**
   Do: open Payouts and press "Pay out now".
   See: the hub credit of `merchant.test.near` and the other creditors arrive in their own accounts, while `newvendor.test.near` is listed as waiting for registration.
10. **Revoke a Budget.**
    Do: Budgets, "Trading agent", "Revoke on NEAR", signed by `bob.test.near`.
    See: a note with the transaction hash and the Budget marked "Stopped"; a call from it in the agent remote is refused with `BUDGET_REVOKED`.
    `carol.test.near` cannot pay gas, so her own "Revoke on NEAR" is turned away by the chain; the relayer is what lets her revoke.

More to try: open a Budget of your own (Budgets, "New Budget", with a spare agent key from the agent remote, signed by `alice.test.near`); it shows up in the agent remote within a few seconds.
The second login is the business admin of Northwind Coffee, who sees what a business sees.
The swarm market is a separate page on its own simulated hub: run `pnpm swarm --serve` in another terminal and open `http://127.0.0.1:4477`.

Screenshots of these steps at 1280 and 375 pixels, light and dark, are in [docs/screenshots](docs/screenshots).

## Options

| Flag | Meaning |
|---|---|
| (none) | Start everything, print the guide, wait for Ctrl-C |
| `--check` | Start everything, run the scripted pass, print a checks block, stop; the exit code is 0 only when every check passes |
| `--reset` | Delete `apps/local/data` through the reset guard and exit |
| `--empty` | Set up the accounts, logins, services and Budgets, and generate no activity |
| `--dashboard-port <n>` | Default 3210 |
| `--node-port <n>` | Default 4210 |
| `--signer-port <n>` | Default 4211 |
| `--services-port <n>` | Default 4212: the paid services and the agent remote |
| `--relayer-port <n>` | Default 4213 |

Exit codes: 0 stopped cleanly or every check passed, 1 a check failed or a part of the stack broke, 2 a usage or start error, 130 interrupted.

## `pnpm local --check`

The scripted pass does the steps of the guide through the routes the browser uses: the node's API through the dashboard's own `/api` path with a signed-in session, the signer over HTTP with the dashboard's origin, the public checkout routes, and the agent remote's route.
Every result is then asserted against the chain through a client that holds no key.
It picks free ports, so it can run on a machine where the default ports are taken.
A full run takes about three minutes and ends with `23 of 23 checks passed`.

It checks, in order:

- the hub is locked and runs the committed `hub.wasm`;
- the node is ready on the hub: its receipt key is registered, its storage is prepaid, and it reported no readiness problem;
- the signer refuses a wrong token, a foreign origin, `near:testnet`, `near:mainnet`, a plain transfer and an account it does not hold;
- both logins work through the dashboard's `/api` path;
- setup left a business, two payment links, six paid services and three funded Budgets, and the hub holds all three;
- a deposit from a local account raises escrow on the hub by exactly its amount;
- a new Budget opened by its owner is on the hub and the agent remote can pay from it;
- an agent call is paid and shows up at the node;
- live updates reach the browser: a second paid call arrives as `call.accepted` on the event stream through the dashboard's `/api` path, which a buffering proxy would hold back;
- two refusals name their rules, are recorded by the node, and move no position;
- a payee the check warns about waits for the owner: the call is refused with `PAYEE_NEEDS_APPROVAL`, the owner approves through the node's route, and the next call is paid;
- "settle now": the hub stores every batch with the node's gross and net, and less moves than was cleared;
- a call's proof verifies against the local chain with the browser's own reader, and a changed amount does not;
- the shopper pays a checkout link and the hub records the payment for the merchant;
- a buyer pays a checkout from USDC on Base through the simulated any-chain path: the business's any-chain account receives exactly the invoice amount on chain, the delivery transaction's NEP-141 event says so, the quote is `confirmed` with `rpc_checked`, the payment is paid, a signed `payment.paid` reaches a local webhook receiver, and the reconciliation row names the origin and the settlement network;
- a buyer sends too little from another chain: the deposit is returned, no USDC moves on chain, the payment is open again and a signed `payment.deposit_returned` arrives;
- a payout empties hub credit into each creditor's own account, and the unregistered payee's credit stays on the hub;
- a revoke by the owner marks the Budget revoked on the hub and the node refuses its next call;
- a NEP-413 message signed by the signer verifies against the account's key;
- revoke without gas: the relayer's `GET /info` names the local hub, the owner's own revoke is refused for lack of NEAR, the relayed one succeeds, and the owner's NEAR balance does not change by one yoctoNEAR;
- the hub is solvent;
- the dashboard serves the pages of the walkthrough;
- data safety: the database is a guarded `*.demo.db`, the logins file has mode 0600, and no log contains a key, a password or the signer token.

## What is real

- **The contracts.**
  The hub is the committed `contracts-near/out/hub.wasm`, deployed and locked with zero access keys by the same script an operator uses.
- **The chain runtime.**
  near-sandbox is NEAR's own node software, so every transaction, receipt, gas charge and view call behaves as on NEAR.
- **The clearing node.**
  It is `@payminto/node` unchanged, with its real `NearRpcChain`, its policy engine, its ledger, its settlement and its payouts.
- **Policy.**
  Every refusal on the screen is the node refusing a real signed voucher.
- **The payee check.**
  It is on, as on any node, and reads the payee's account from the chain; only the account-age source is off, because a sandbox has no indexer (`PAYEE_CHECK_INDEXER=off`).
- **Settlement.**
  Every batch is a `settle_batch` transaction; the hub verifies each voucher signature and recomputes the net positions.
- **Proofs.**
  "Verified on NEAR" is the browser reading the batch root and calling `verify_receipt` on the local chain, not the server's word.
- **The SDK.**
  Agent calls go through `AgentClient.pay`, services sit behind `paywall`, the business uses `GatewayClient` with an API key, and owners use `OwnerClient`.
- **The gas relayer.**
  It is `@payminto/relayer` unchanged, paying real gas from its own account.
- **Sign-in, roles, the invite and the API key.**
  They are made through the node's HTTP API, with the one-time setup code read from the node's log.

## What is local only

- **The chain is a node on this machine.**
  It has no other validators, no explorer, and it is gone when the command stops.
- **USDC is a mock token.**
  Anyone can mint it; it stands in for USDC on this chain only.
- **The signer replaces a wallet.**
  On testnet you sign in your own NEAR wallet, and no service ever holds your key.
- **The agent remote replaces an agent's runtime.**
  In production the agent key lives with the agent; here one page holds the keys so you can make a call from a browser.
- **The paid services return deterministic local data.**
  What is real about a call is the 402, the voucher, the node's decision and the receipt.
- **Carol's missing NEAR is arranged.**
  Setup sends her NEAR back to the sandbox root after she opens her Budget, to make the owner who cannot pay for gas.

## Data

Everything this command writes is in `apps/local/data/`, which is git-ignored.

| Path | What it is |
|---|---|
| `clearing.demo.db` | The node's database |
| `agent-*.receipts.demo.db` | Receipt stores of the agent keys the remote holds |
| `seller.vouchers.json` | The seller's latest vouchers, for `settle_own` |
| `logins.txt` | The two generated logins and the business API key, mode 0600 |
| `run.json` | The lock of the running stack |
| `logs/` | `node.log`, `signer.log`, `relayer.log`, `dashboard.log`, `sandbox.log` |

**Every start begins from a clean data directory.**
Chain state does not survive a stop: each start runs a new chain with a new hub.
A database from an earlier run describes Budgets, batches and payments on a chain that no longer exists, so keeping it could only show things that are not true.
The start says so in one line when it removes the previous run's data.

Data safety rules, enforced in `src/data.ts`:

- The directory is fixed: it is never read from the environment, and the node's `DB_PATH` is never read from the environment either.
- The node's configuration is built from this run's values only; no variable of your shell reaches it.
- Every database must be named `*.demo.db` and pass the node's reset guard (`apps/node/src/db/guard.ts`) before it is opened or deleted.
- One database in the directory that does not pass stops the whole deletion; nothing is removed.
- A symbolic link in place of the directory is refused.
- Only one stack runs at a time, because a second one would delete the first one's database; the second start says which process holds the lock.

`pnpm local --reset` deletes the directory by the same rules and exits.

## Troubleshooting

**"Port 3210 is already in use".**
Something else listens there.
Stop it, or pass the flag the message names, for example `--dashboard-port 3300`.

**"pnpm local is already running".**
Another terminal runs the stack.
Press Ctrl-C there first.

**The near-sandbox binary is missing.**
The binary is looked for in `NEAR_SANDBOX_BIN_PATH`, then where the contract's cargo tests put it under `contracts-near/target`, then in `~/.near-kit/sandbox/bin`.
When it is nowhere, near-kit downloads near-sandbox 2.14.0 once from NEAR's release bucket, about 30 MB, into `~/.near-kit/sandbox/bin`.
That needs a network connection the first time only.

**The dashboard takes a long time on the first page.**
`next dev` compiles each page the first time it is opened.
The second visit is fast.

**"The local signer was restarted, so this page holds an old token".**
The dashboard tab is from an earlier run.
Reload it.

**A part of the stack stopped.**
When the sandbox node or the dashboard dev server dies, the command says which one and where its log is, stops everything else, and exits with code 1.
Run `pnpm local` again for a fresh stack.

**A run was killed outright.**
After `kill -9` or a closed terminal, the next start stops the sandbox node and the dashboard dev server that were left behind, then starts clean.

**Sign-in fails after a restart.**
Each start makes new passwords.
Read `apps/local/data/logins.txt` again.

## Known issues in the product that this stack works around

- **Auth rate limit behind the dashboard.**
  Every browser reaches the node from the dashboard's address, so the default of 20 auth requests a minute is shared by every tab.
  This stack sets `AUTH_RATE_LIMIT_PER_MIN=600`.

## How this differs from `pnpm demo`

| | `pnpm demo --chain sandbox` | `pnpm local` |
|---|---|---|
| For | Proving the machinery from a terminal | Using the product in a browser |
| Runs | A fixed story, then a checks block, then stops | Until Ctrl-C |
| Dashboard | None | The real dashboard, signed in with generated logins |
| Who signs | The script holds every key | You pick an account; the local signer signs |
| Setup | Admin token | The node's first-run setup, an invite and an API key, over HTTP |
| Gateway | Off | On: a business, a payment link, a paid and an unpaid checkout |
| Relayer | None | The real relayer, with an owner who has no gas |
| Checks | The story's invariants, read from the chain | The walkthrough's results, read from the chain |
| Data | A new directory per run | One directory, clean at every start |

Both use the same hub factory, the same node and the same contracts.

## Tests

```sh
pnpm --filter @payminto/local test        # no network: the signer's rules, data safety, arguments, ports, the guide
pnpm --filter @payminto/local typecheck
pnpm local --check                        # the whole stack on near-sandbox
```
