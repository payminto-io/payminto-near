# Payminto swarm

A group-buying swarm on Payminto, built for the AI Swarms track of the NEAR HACKATHON.

Twenty buyer agents each want GPU hours.
They find each other through a coordinator, pool their demand, and run a sealed-bid round against five seller agents.
The winner is paid one signed voucher per delivered unit, each buyer pays only its share, and the Payminto clearing node nets everything and settles on the hub in a few transfers.

Every agent is its own NEAR sub-account under one parent (`buyer-1.swarm.testnet` ... `seller-5.swarm.testnet`), with its own ed25519 key and its own Budget on the hub.
The sub-account is the Budget's owner, so escrow, net debit, credit and payout on the hub all name exactly one agent.

The rules were written before the code and are in [RULES.md](RULES.md).
No model is called anywhere: the strategies are scripts, and one seed always gives the same run.

## Try it

You need Node.js 22.18 or newer and pnpm 9.
Nothing below touches testnet or mainnet, moves real funds, or needs an account or a key.

```sh
pnpm install
pnpm swarm
```

Do `pnpm swarm`.
See three rounds, each with its pool, five sealed commitments, the reveals, the void bids with their reason, the winner, the clearing price and every buyer's share.
See `1 settle_batch call(s) for 299 paid Calls`, then `5 token transfers`.
See the measured table below, then `17 of 17 checks passed`, after about 5 to 10 seconds, with exit code 0.
Every line that shows chain state is labeled SIMULATED, because this mode runs an in-memory model of the hub contract.
The elapsed time goes to stderr, so the same seed prints the same stdout every time.

```sh
pnpm swarm --serve
```

Do `pnpm swarm --serve`, then open the printed address, `http://127.0.0.1:4477`, in a browser.
See the run start when the page opens: bids go from Sealed to Revealed or Void, the winner and the clearing price appear, units are delivered one paid Call at a time, and the "Gross cleared against net moved" figure counts up.
See each round end with a link to its round file, the exact command that verifies it, and "Open Proof of one Call".
Do "Open Proof of one Call".
See "Verified against the hub", checked at that moment against the hub of the running process, and the exact command to check the file yourself.
Do "Replay" once the run is over, or drag the slider.
See the same run again from the start, at 1x, 4x or 16x.
Press Ctrl-C in the terminal.
See the page, the agents and the clearing node stop, with exit code 130 and no process left.

```sh
pnpm swarm verify apps/swarm/data/last-run/round-1.json
```

Do the command above after a run.
See the bids of the round, the winner and the price recomputed from the signed messages alone, eight checks, and `VERIFIED`, with exit code 0.

```sh
sed 's/"clearingPrice": "446000"/"clearingPrice": "445000"/' apps/swarm/data/last-run/round-1.json > apps/swarm/data/last-run/tampered.json
pnpm swarm verify apps/swarm/data/last-run/tampered.json
```

Do the two commands above: the first lowers the published clearing price of round 1 by 0.001 USDC.
See `FAIL  the winner is the lowest valid bid and the clearing price is the second-lowest valid price: published clearing price 445000, the rules give 446000`, then `NOT VERIFIED`, with exit code 1.

```sh
pnpm swarm prove apps/swarm/data/last-run/round-1.receipt.json
pnpm swarm prove apps/swarm/data/last-run/round-1.receipt.tampered.json
```

Do the first command.
See the voucher signature checked against the buyer's key, the Merkle path folded to the batch root, and `VERIFIED against the root recorded in this file`, with exit code 0.
Do the second command, on a copy the run wrote with the amount raised by one atomic unit.
See two `FAIL` lines and `NOT VERIFIED`, with exit code 1.

## Measured in one run

This is the table `pnpm swarm` printed on the author's machine on 2026-11-10, with the default seed 51, on the simulated hub.
It reports counts and amounts only.

| Measure | Value |
|---|---|
| agents | 25 (20 buyers, 5 sellers), each with its own sub-account, key and Budget |
| owners | 25 Budget owner accounts on the hub, all sub-accounts of swarm.testnet |
| rounds | 3 (3 cleared) |
| paid calls | 299 (172 GPU units, 85 storage blocks, 42 dataset shards) |
| refusals by rule | NET_EXPOSURE 3 (by the clearing node), TOTAL_CAP 3 (by the agent's own client) |
| gross amount cleared | 82.934 USDC |
| net amount moved | 71.114 USDC (offset between owners: 11.82 USDC) |
| token transfers at settlement | 5, one per net creditor |
| transactions needed | 2 (1 settle_batch, 1 payout) against 299 with one transaction per call |
| one-time setup | 50 owner transactions before the first call: open_budget and an escrow deposit for each of the 25 Budgets |

What the numbers mean.
299 paid Calls cleared 82.934 USDC of obligations.
At settlement the hub debited 20 net debtors' escrow by 71.114 USDC in total and credited 5 net creditors, and 5 token transfers paid them.
The 11.82 USDC that did not move is what agents owed each other in both directions: a seller that won one round sold storage in another, and a buyer that hosts the dataset was paid for shards.
The offset is modest because the buyers are mostly pure buyers; it comes from the input rules in RULES.md section 12 and from who wins, not from a script.
With one seller and no data host (`--sellers 1 --data-hosts 0`) nothing offsets, net equals gross, and the run says so.

## The rules in five lines

1. Buyers post signed demand; the pool is fixed before any seller bids.
2. Sellers commit to `sha256(domain, round, seller, unitPrice, capacity, salt)` and reveal only after every commitment is public; a reveal that is late, missing, mismatched or above the reserve is void.
3. The lowest valid bid wins (ties go to the earlier commitment) and every unit costs the second-lowest valid price, or the reserve when only one bid is valid.
4. The awarded units are split in proportion to demand by the largest remainder rule, and a buyer's share is its units times the price, so shares sum exactly to price times units.
5. Each delivered unit is one paid Call through a Payminto paywall; sellers buy storage and data from other agents by the same Calls; the clearing node nets all of it and the swarm itself moves no tokens.

## How it is built

| Part | File | What it does |
|---|---|---|
| Rules | [src/rules.ts](src/rules.ts) | Pure functions: the commitment, signed messages, phases, void reasons, winner, price, the largest remainder split, and `verifyRound` |
| Coordinator | [src/coordinator.ts](src/coordinator.ts) | A Hono service: open a round, accept demand, commitments and reveals inside their phases, close, publish the round file |
| Scenario | [src/scenario.ts](src/scenario.ts) | The scripted strategies and every seeded number |
| Agents | [src/agents.ts](src/agents.ts) | Buyers pay with the SDK's `AgentClient`; sellers and data hosts serve behind the SDK's `paywall` |
| World | [src/world.ts](src/world.ts) | The hub from the demo's own factory, the real clearing node on a disposable database, one Budget per agent |
| Run | [src/run.ts](src/run.ts) | The rounds, delivery, settlement, payouts and receipt proofs |
| Checks | [src/checks.ts](src/checks.ts) | The measured table and the invariants |
| Page | [src/serve.ts](src/serve.ts), [public/](public/) | The live page: plain HTML, CSS and one script, fed by server-sent events |

The agents use the real stack end to end: real ed25519 vouchers over x402 v2, the node's real policy engine and refusals, a real `settle_batch` with a Merkle root, real payouts, and receipt proofs checked against the hub.

## Change the scenario

```sh
pnpm swarm --buyers 12 --sellers 4 --rounds 5 --seed 99
pnpm swarm --strategy-mix "sellers=truthful:3,underdeliver:1 buyers=steady:10,capped:2"
pnpm swarm --scenario apps/swarm/scenario.example.json
pnpm swarm --help
```

`pnpm swarm --help` lists every option with its default.
A scenario file sets the same things and the posted prices; every field is optional, and flags override the file.
A mistake in an option or in the file is reported with what to write instead, with exit code 2.

| Strategy | Who | What the script does |
|---|---|---|
| `truthful` | seller | Bids its real cost per unit and reveals on time |
| `shading` | seller | Bids its cost plus 15 percent and reveals on time |
| `late` | seller | Reveals after the deadline in odd rounds, so its bid is void there |
| `withhold` | seller | Never reveals in even rounds, so its bid is void there |
| `underdeliver` | seller | When it wins, stops serving after 60 percent of the awarded units |
| `mismatch` | seller | Reveals a lower price than it committed to, so its bid is void |
| `steady` | buyer | Its Budget covers everything it asks for |
| `capped` | buyer | Its Budget cap is too low; its own client refuses with `TOTAL_CAP` before signing |
| `thin` | buyer | Its Budget escrow is too low; the clearing node refuses with `NET_EXPOSURE` |

Exit codes: 0 every check passed, 1 a check failed or the run broke, 2 a mistake in the options or an unreadable file, 3 the timeout passed, 130 interrupted.

## What is simulated and what is not

| Thing | In `pnpm swarm` | In `pnpm swarm --chain sandbox` |
|---|---|---|
| Hub contract and token | SIMULATED: `FakeChain`, an in-memory model of the hub with the same rules and refusal codes | The committed `hub.wasm`, deployed and locked on a fresh local near-sandbox node, with a mock USDC token |
| Sub-accounts | Names only: the simulated hub has no accounts to create | Real accounts, created by the parent with the sub-account add-on's builder |
| Clearing node, policy engine, settlement, payouts | Real, in process, on a disposable database in the temp directory | The same |
| Vouchers, receipts, Merkle proofs | Real ed25519 signatures and proofs | The same |
| Paywalls and agent clients | The real SDK, over HTTP on 127.0.0.1 | The same |
| Coordinator | Real service, over HTTP on 127.0.0.1 | The same |
| GPU hours, storage blocks, dataset shards | Simulated: each unit is a hash, and the responses say so | The same |
| Agent decisions | Scripted, no model calls | The same |
| Time in a round | A counter the runner advances, so a run does not depend on wall time | The same |
| Agent keys | Derived from the seed, for simulation only | Voucher keys from the seed; account keys generated for the run |

## On a local NEAR node

```sh
pnpm swarm --chain sandbox
```

Do `pnpm swarm --chain sandbox`.
See the label SANDBOX: a fresh near-sandbox node (2.14.0) that the run starts on 127.0.0.1 and stops when it ends.
See the committed `hub.wasm` deployed and locked by the demo's own hub factory, then `swarm.test.near` and 25 real sub-accounts created with the sub-account add-on's builder, each transaction with its hash.
See every agent mint mock USDC first, which registers it with the token, then `open_budget` and `ft_transfer_call` into escrow from its own account, then the same three rounds, one `settle_batch`, one `payout`, and `17 of 17 checks passed` after about two and a half minutes.
The order matters: the clearing node checks each payee when a Budget is registered, and a seller that had not registered with the token yet would have its payments held for the owner's approval.

This was run on the author's machine on 2026-11-10, twice with the default scenario and once with a small one, and passed each time.
With the default seed it printed the same table as the simulated hub: 299 paid Calls, 82.934 USDC gross, 71.114 USDC net, 5 transfers.
The rounds are the same on both chains because demands, costs and capacities are drawn by an agent's role and number; only the commitments differ, since they bind the seller's account name.
The first run downloads the near-sandbox binary once (about 30 MB, from NEAR's release bucket) unless the demo or the contract tests already did.

A buyer's sub-account gets no on-chain agent key at all: it pays with vouchers signed by a key that never goes on chain.
A seller's sub-account gets a function-call key that can call only `settle_own` and `payout` on the hub.
Each account's full-access key is its owner's, and it signs that account's `open_budget` and escrow deposit.

One thing is borrowed from the demo rather than exported by it: the sandbox root account's key, which only the root can use to create `swarm.test.near`.
The swarm reads it from the home directory the demo records for the sandbox it started; see the note at the top of [src/sandbox.ts](src/sandbox.ts).

## Limits

The coordinator is a service, not a contract.
Its fairness is checkable after the fact from each round file; it is not enforced on chain.
It could refuse a message or choose the order and the time of messages, and the round file would only show the result.
Signatures stop it from inventing or changing a demand or a bid of an agent whose key it does not hold.

The strategies are scripts, not learning agents, and nothing here shows how a model-driven agent would bid.

The second-price rule makes truthful bidding a dominant strategy for one seller in one round taken alone.
It does not cover collusion between sellers or a seller that weighs future rounds, and buyers pay the second-lowest price, not the lowest.

A receipt proves that the buyer's key signed the Call and that the Call is in a settled batch.
It does not prove that GPU work was done: the units here are hashes.
A dishonest seller could take one voucher and return nothing; the buyer then stops, so it loses at most one unit's price.

The delivery section of a round file is the runner's record.
`verifyRound` checks it against the rules, and the payments in it are backed by receipts, but the delivery itself is not provable.

On the simulated hub, `pnpm swarm prove` checks a receipt against the root recorded in the same file, because that hub exists only while a run is alive.
The live page checks the same receipt against the running hub.

The agents' keys are derived from the seed, so anyone who knows the seed knows the keys.
That is right for a reproducible simulation and wrong for anything else.

The node operator lists each round's delivery endpoint at the clearing node, and in this app the runner plays that role with the node's admin credential.

Netting happens inside one settlement batch.
A batch holds at most 100 (Budget, Payee) claims, so a much larger swarm settles in several batches and offsets only within each.

## Tests

```sh
pnpm --filter @payminto/swarm test
pnpm --filter @payminto/swarm typecheck
```

The suite covers the rules as pure functions (commitments, the winner, the price, the share split with remainders, each void case), `verifyRound` against tampered round files and delivery records, the coordinator over HTTP, the options and their error messages, determinism for a seed, the page server, and a small end-to-end run that asserts every check.

## Screenshots

The live page after a finished run, at 375 and 1280 pixels, light and dark:

| | Light | Dark |
|---|---|---|
| 1280 | [swarm-1280-light.png](docs/screenshots/swarm-1280-light.png) | [swarm-1280-dark.png](docs/screenshots/swarm-1280-dark.png) |
| 375 | [swarm-375-light.png](docs/screenshots/swarm-375-light.png) | [swarm-375-dark.png](docs/screenshots/swarm-375-dark.png) |

A Proof of one Call, open on the page: [swarm-proof-1280-light.png](docs/screenshots/swarm-proof-1280-light.png) and [swarm-proof-375-dark.png](docs/screenshots/swarm-proof-375-dark.png).
