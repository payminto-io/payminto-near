# Rules of the Payminto group-buying swarm

This file was written before any code in `apps/swarm`.
The code implements these rules, and `pnpm swarm verify <round.json>` re-checks a published round against them.
Every rule below can be checked by hand from a round file with a calculator and `shasum -a 256`.

## 1. Parties

| Party | Account (simulated run) | What it is |
|---|---|---|
| Buyer agent | `buyer-1.swarm.testnet` ... `buyer-20.swarm.testnet` | Represents one user who wants GPU hours |
| Seller agent | `seller-1.swarm.testnet` ... `seller-5.swarm.testnet` | Sells GPU hours and bids in each round |
| Coordinator | none, it is an HTTP service | Opens rounds, collects demand and sealed bids, publishes the result and the round log |
| Clearing node | `node.demo.testnet` | The Payminto node: checks every payment against a Budget and settles on the hub |
| Hub | `hub.demo.testnet` | The Payminto hub contract (simulated in `pnpm swarm`): escrow, `settle_batch`, payouts, the Merkle root |

Every agent is a direct sub-account of one parent account, `swarm.<parent>`.
Every agent has its own ed25519 key and its own Budget on the hub.
The sub-account is the owner of that Budget, so escrow, net debit, credit and payout on the hub all name exactly one agent.
The same ed25519 key signs the agent's payment vouchers and its messages to the coordinator.

## 2. Units and money

One unit is one GPU-hour slice.
A unit is indivisible.
All money is in atomic USDC units: 1 USDC is 1,000,000 atomic units.
Every price, share and payment is a non-negative integer number of atomic units.
No rule in this file divides money, so no amount is ever rounded.

## 3. Round lifecycle and timing

A round is opened with a round id, a reserve unit price `R`, a roster and three deadlines.
The roster lists every agent that may take part: its account, its role and its ed25519 public key.
Time is the coordinator's clock `t`, an integer number of milliseconds.
In a simulation run the clock is a counter that the runner advances, so a run does not depend on wall time.

| Phase | When | What is accepted |
|---|---|---|
| Pooling | `t < poolDeadline` | Buyer demand |
| Commit | `poolDeadline <= t < commitDeadline` | Seller commitments |
| Reveal | `commitDeadline <= t < revealDeadline` | Seller reveals |
| Late | `t >= revealDeadline`, before the close | Seller reveals, recorded as late and therefore void |
| Closed | after the close | Nothing |

The deadlines satisfy `openedAt < poolDeadline < commitDeadline < revealDeadline`.
A message outside its phase is rejected with HTTP 409 and is not recorded.
The one exception is a reveal that arrives after `revealDeadline` and before the close: it is recorded with its time and is void (rule 6).
A reveal is never accepted before `commitDeadline`, so every commitment is published before any reveal.
A close request is accepted only when `t >= revealDeadline`.
Every accepted message gets the next sequence number `seq` (1, 2, 3 ...) and the clock time `at`.

Every message is signed by the sender's ed25519 key.
The signed digest is the SHA-256 of the UTF-8 text `payminto.swarm.msg.v1`, the message kind, the round id, the sender account and the message fields in the order given below, joined by single newline characters.
A message from an account that is not on the roster, with the wrong role, or with a signature that does not verify against the roster key, is rejected and not recorded.

## 4. Demand and pooling

A buyer's demand is `{ round, buyer, units, maxUnitPrice }`, signed over the fields `units`, `maxUnitPrice`.
`units` is an integer from 1 to 1000: how many GPU-hours the buyer wants in this round.
`maxUnitPrice` is the most the buyer will pay for one unit.
A demand with `maxUnitPrice < R` is rejected: the buyer is not in the pool.
A buyer in the pool has agreed to pay any clearing price up to `R`.
The buyer's own Budget enforces that limit: its limit per Call is `maxUnitPrice`, so the clearing node refuses a unit priced above it whatever the coordinator says.
One demand per buyer per round is accepted; a second one is rejected.
Buyers find each other through the coordinator: `GET /rounds` lists open rounds, and `GET /rounds/<id>` shows the pool so far.
The pooled demand is `Q`, the sum of `units` over all accepted demands.
`Q` is fixed at `poolDeadline` and is public before any seller commits.

## 5. Sealed bids: commit, then reveal

A seller's bid is `{ unitPrice, capacity, salt }`.
`unitPrice` is the price the seller asks for one unit, an integer of at least 1.
`capacity` is how many units the seller can deliver in this round, an integer from 1 to 1,000,000.
`salt` is 64 lowercase hex characters chosen by the seller.

The commitment is the SHA-256, as 64 lowercase hex characters, of this UTF-8 text with single newline characters between the six parts and no trailing newline:

```text
payminto.swarm.bid.v1
<round id>
<seller account>
<unitPrice as a decimal integer>
<capacity as a decimal integer>
<salt>
```

In the commit phase the seller sends `{ round, seller, commitment }`, signed over the field `commitment`.
One commitment per seller per round is accepted; a second one is rejected.
In the reveal phase the seller sends `{ round, seller, unitPrice, capacity, salt }`, signed over those three fields in that order.
Only the first reveal of a seller is recorded; a second one is rejected.
A reveal from a seller with no commitment is rejected.

To check a commitment by hand:

```sh
printf 'payminto.swarm.bid.v1\n%s\n%s\n%s\n%s\n%s' "$ROUND" "$SELLER" "$UNIT_PRICE" "$CAPACITY" "$SALT" | shasum -a 256
```

## 6. Void bids

Each commitment is either valid or void.
The first matching reason in this order applies:

| Reason | Condition |
|---|---|
| `NOT_REVEALED` | No reveal was recorded for the commitment |
| `LATE_REVEAL` | The reveal's time `at` is `>= revealDeadline` |
| `COMMITMENT_MISMATCH` | The SHA-256 of the revealed fields (rule 5) is not the commitment |
| `ABOVE_RESERVE` | `unitPrice > R` |

A void bid cannot win and does not set the price.

## 7. Winner

The winner is the valid bid with the lowest `unitPrice`.
If several valid bids share the lowest price, the one whose commitment has the lowest `seq` wins, that is the one committed first.
If there is no valid bid, the round ends with status `no-winner`: nothing is awarded and nothing is paid.
If `Q` is 0, the round ends with status `no-demand`.

## 8. Clearing price

The clearing price `P` is uniform: every unit of the round is paid at `P`.
`P` is the lowest `unitPrice` among the valid bids other than the winner's.
This is the second-lowest valid price; when two bids tie for the lowest price it equals the winner's own price.
If the winner's bid is the only valid one, `P = R`.
So `winner.unitPrice <= P <= R` always holds.

Incentive property, stated honestly.
This is a second-price (Vickrey) reverse auction with a single winner.
The winner's own bid decides whether it wins, and never what it is paid.
For a seller with a fixed cost per unit, in one round taken alone, bidding that cost is a dominant strategy: a higher bid can only lose a round it would have won at a profit, and a lower bid can only win a round at a loss.
Reporting a larger capacity than the seller has gains nothing, because undelivered units are not paid (rule 10).
The property does not cover collusion between sellers, a seller that weighs future rounds, or a coordinator that invents bids.
The cost of this rule to buyers is that they pay the second-lowest price, not the lowest.

## 9. Allocation and shares

The awarded quantity is `A = min(Q, winner.capacity)`.
When `A = Q`, every buyer `i` is allocated `a_i = q_i`, its full demand.
When `A < Q`, the units are split in proportion to demand with exact integer arithmetic (the largest remainder method):

1. `base_i = floor(A * q_i / Q)` for every pooled buyer.
2. `left = A - sum(base_i)`, which is at least 0 and less than the number of buyers.
3. Order the buyers by `(A * q_i) mod Q`, largest first; break ties by buyer account, ascending in ASCII byte order.
4. The first `left` buyers in that order get one more unit: `a_i = base_i + 1`; the others get `a_i = base_i`.

Then `sum(a_i) = A` and `a_i <= q_i` for every buyer.
The same formula gives `a_i = q_i` when `A = Q`, so there is one rule, not two.

A buyer's share is `share_i = a_i * P`.
The shares sum to `A * P` exactly.
The remainder rule acts on whole units, never on money, which is why no atomic unit is ever left over or rounded.
A buyer pays at most its share, and exactly `P` for each unit it actually receives (rule 10).

## 10. Delivery and metering

Nothing is paid up front.
Each delivered unit is one paid HTTP Call through a Payminto paywall on the winner's server.

1. The node operator lists the winner's delivery endpoint for the round at the clearing node, with price `P` and the winner's account as Payee.
   The node refuses any voucher for another amount (`PRICE_MISMATCH`), so a unit cannot be paid at any price but `P`.
2. Delivery runs in passes.
   In pass `k` (1, 2, 3 ...), every buyer with `a_i >= k` requests its `k`-th unit, in roster order.
3. The buyer calls `GET /gpu/<round>/unit?buyer=<account>&n=<k>` on the winner.
   The paywall answers HTTP 402 with the price.
   The buyer's client checks the Budget policy, signs an ed25519 voucher for exactly `P` and retries.
   The paywall sends the voucher to the clearing node, and serves the unit only after the node accepted it.
4. A buyer never requests more than `a_i` units, so it never pays more than `share_i`.
5. A buyer stops for the round at its first unit that does not arrive, whatever the cause.
   Its remaining units are not delivered, not paid and not given to another buyer in this round.

Payment follows delivery Call by Call, so a seller that stops delivering stops being paid.
A seller that is out of capacity answers HTTP 503 before the paywall, so no voucher is signed and no money moves.
The winner is paid exactly `P` times the units it delivered.
A dishonest seller could accept one voucher and return nothing; the buyer then stops, so its loss is at most `P`, once.
A receipt proves that the buyer's key signed the Call and that the Call is in a settled batch; it does not prove that the GPU work was done.

## 11. When a buyer's Budget refuses during delivery

A refusal comes from the buyer's own client before it signs, or from the clearing node, and it names the rule that fired.
Examples are `TOTAL_CAP` (the Budget's cap would be exceeded) and `NET_EXPOSURE` (unsettled spending would exceed the Budget's escrow).
No money moves for a refused Call and the seller does not serve that unit.
The buyer stops for the round (rule 10.5) and keeps the units it already paid for.
The seller keeps the payments for the units it delivered.
Other buyers are not affected: their allocations and shares do not change.
The refusal is recorded in the round file with the rule, the attempted amount and what was left of the Budget.

## 12. Input purchases: why sellers also buy

The economy is two-sided by rule, so the clearing node has real amounts to offset.
A seller does not hold its own checkpoints and does not own the training data.

| Rule | Trigger | Purchase | From whom | Price |
|---|---|---|---|---|
| I1 storage | After each 2nd, 4th, 6th ... unit the seller delivers in a round | One checkpoint storage block | Its storage supplier | `STORAGE_PRICE`, posted in the round file |
| I2 data | After each 4th, 8th, 12th ... unit the seller delivers in a round | One dataset shard | The round's data host | `DATA_PRICE`, posted in the round file |

The two intervals, 2 and 4 units, are the defaults; like the two prices, the values a round uses are posted in its round file.
The storage supplier of a seller is the next seller on the roster, and the supplier of the last seller is the first one: `seller-1` buys from `seller-2`, and `seller-5` buys from `seller-1`.
With one seller there is no supplier and rule I1 is off.
Some buyers are data hosts; the roster marks them.
The data host of round number `n` is `hosts[(n - 1) mod H]`, with the `H` hosts in roster order.
With no host, rule I2 is off.

Each input purchase is a paid Call through the supplier's Payminto paywall, signed by the seller's own key against the seller's own Budget.
So for `d` delivered units the seller makes `floor(d / 2)` storage Calls and `floor(d / 4)` data Calls.
If an input purchase is refused, the seller stops delivering for the round; units already delivered stay paid.

These rules create amounts that offset: a seller both earns (GPU units, storage blocks) and spends (storage, data), and a data host both spends (GPU units) and earns (shards).
How much offsets depends on who wins, which the sealed bids decide.

## 13. Settlement

Nothing in the swarm moves tokens.
Agents only sign vouchers; the coordinator only publishes results.
After the rounds, the clearing node builds settlement batches from the latest voucher of each (Budget, Payee) pair.
For each batch the node computes every owner account's net position, and `settle_batch` on the hub debits only each net debtor's escrow and credits only each net creditor.
The hub verifies every voucher signature and recomputes the net positions itself, and refuses the batch if they differ.
The hub stores a Merkle root of the batch's Calls, so any single Call can be proven against it.
Net creditors are then paid by `payout`: one token transfer per creditor, not per Call.

Two totals are reported for a run:

- gross cleared: the sum of all paid Calls in the settled batches;
- net moved: the sum of the net credits of those batches, which equals the sum of the net debits.

## 14. The round file

The coordinator publishes one JSON file per round.
It holds the round parameters and roster, every accepted message with `seq`, `at` and signature, and the result: void bids with reasons, the winner, `P`, `Q`, `A`, and each buyer's allocation and share.
The runner adds a delivery section: units delivered and amount paid per buyer, refusals, and the seller's input purchases.

`verifyRound` recomputes from the messages alone: every signature, every commitment, the void reasons, the winner, `P`, `A`, the allocations and the shares.
It then compares them with the published result, and checks the delivery section against rules 10 and 12.
The delivery section is the runner's record of what happened; the payments in it are backed by receipts that can be proven against the hub, the delivery itself is not provable.

## 15. One round as a sequence

```text
buyers (20)        coordinator          sellers (5)         winner's paywall      clearing node          hub
    |                   |                    |                     |                    |                  |
    |   open round: id, R, roster, poolDeadline, commitDeadline, revealDeadline         |                  |
    |                   |                    |                     |                    |                  |
    | demand(units, maxUnitPrice), signed    |                     |                    |                  |
    |------------------>|  seq 1..n          |                     |                    |                  |
    |                   |                    |                     |                    |                  |
    |      t = poolDeadline: pool fixed, Q published               |                    |                  |
    |                   |                    |                     |                    |                  |
    |                   | commit(sha256(bid)), signed              |                    |                  |
    |                   |<-------------------|                     |                    |                  |
    |                   |                    |                     |                    |                  |
    |      t = commitDeadline: all commitments are public          |                    |                  |
    |                   |                    |                     |                    |                  |
    |                   | reveal(unitPrice, capacity, salt), signed|                    |                  |
    |                   |<-------------------|                     |                    |                  |
    |                   |                    |                     |                    |                  |
    |      t = revealDeadline: later reveals are void              |                    |                  |
    |                   |                    |                     |                    |                  |
    |                   | close: void bids, winner, P, A, allocations, shares; round file published        |
    |                   |                    |                     |                    |                  |
    |                   |       operator lists the winner's endpoint at price P ------->|                  |
    |                   |                    |                     |                    |                  |
    | pass k: GET /gpu/<round>/unit?buyer&n=k                      |                    |                  |
    |------------------------------------------------------------->|                    |                  |
    | 402 PAYMENT-REQUIRED (price P)         |                     |                    |                  |
    |<-------------------------------------------------------------|                    |                  |
    | Budget policy check, sign voucher for P, retry               |                    |                  |
    |------------------------------------------------------------->| POST /v1/vouchers  |                  |
    |                   |                    |                     |------------------->| rules, record    |
    |                   |                    |                     | receipt or refusal |                  |
    |                   |                    |                     |<-------------------|                  |
    | 200 + unit + receipt   (or 402 with the rule that refused)   |                    |                  |
    |<-------------------------------------------------------------|                    |                  |
    |                   |                    |                     |                    |                  |
    |                   |      every 2nd unit: winner buys a storage block from its supplier (paid Call)   |
    |                   |      every 4th unit: winner buys a dataset shard from the data host (paid Call)  |
    |                   |                    |                     |                    |                  |
    |      after the last round                                    |                    |                  |
    |                   |                    |                     |                    | settle_batch(root, claims, net)
    |                   |                    |                     |                    |----------------->|
    |                   |                    |                     |                    | payout(creditors)|
    |                   |                    |                     |                    |----------------->|
    | GET /v1/receipts/<callId>/proof, then verify the path against the hub's root      |                  |
    |---------------------------------------------------------------------------------->|                  |
```

## 16. What these rules do not give

The coordinator is a service, not a contract.
Its fairness is checkable after the fact from the round file; it is not enforced on chain.
A coordinator could refuse a message, close its eyes to a commitment, or order messages to its liking, and the round file would only show the result.
The signatures stop it from inventing or changing a demand or a bid of an agent whose key it does not hold.
The strategies in the simulation are scripts, not learning agents, and no model is called.
