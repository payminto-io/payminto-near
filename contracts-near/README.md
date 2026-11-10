# Payminto hub contract

The hub escrows a NEP-141 token for Budget owners, settles batches of agent vouchers, and pays out net credits.
It is unaudited and testnet only.

Design source: `docs/superpowers/specs/2026-11-10-near-clearing-design.md`, section "Roundtable decisions".
Encoding and argument shapes follow `packages/chain/README.md`, and the JSON vectors in `packages/chain/vectors` pin both sides.

## Layout

- `src/lib.rs` is the contract, with state and every public method.
- `src/encoding.rs` holds the Borsh digests, the text digest of the node's acceptance, and Merkle hashing.
- `src/netting.rs` is pure account-level netting.
- `src/errors.rs` holds the panic codes the node maps to refusals.
- `src/tests/` holds unit tests, including vector conformance.
  `src/tests/review.rs` holds one test per security review finding, each of which failed before its fix.
- `mock_ft/` is a mock NEP-141 token for sandbox tests only.
- `tests/sandbox.rs` runs the real wasm in `near-sandbox`, and `tests/gas_profile.rs` measures gas.
- `out/hub.wasm` and `out/mock_ft.wasm` are the built artifacts.

## Build and test

`rust-toolchain.toml` pins Rust 1.99.1.

```sh
cargo near build non-reproducible-wasm --locked
cargo near build non-reproducible-wasm --locked --manifest-path mock_ft/Cargo.toml
cp target/near/payminto_hub.wasm out/hub.wasm
cp target/near/mock_ft/mock_ft.wasm out/mock_ft.wasm
cargo test
cargo test --test gas_profile -- --nocapture --ignored --test-threads=1
```

`cargo test` needs the files in `out/`, because the sandbox tests deploy them.
The sandbox tests start their own `near-sandbox` 2.14.0; set `NEAR_SANDBOX_BIN_PATH` to reuse a binary instead of downloading one.

The current `out/hub.wasm` has sha256 `a8a5339259dfb01b48b2d04b319aa357aead63f3e47e7a69855fed095a152c37`, which is NEAR code hash `CMKbhRxTnjQsgFZpDPsEqTz55h6iDvxy8qYXpAhJUtqc`.
It was built with `cargo near build non-reproducible-wasm --locked`, cargo-near 0.23.0 and Rust 1.99.1.

The TypeScript side has its own sandbox suite, which deploys this wasm with the deploy script and drives the hub only through `NearRpcChain`:

```sh
pnpm --filter @payminto/chain test:sandbox
```

## Deploy and lock

`packages/chain/scripts/deploy-hub.ts` deploys the hub and locks it, on `near-sandbox` or NEAR testnet.
It refuses mainnet accounts and mainnet RPC URLs.
The human runs it against testnet; no assistant run has used it outside the sandbox.

It runs these steps in order, and skips any step the chain already shows as done, so a run that stopped halfway can be repeated:

0. It checks that the hub account holds enough NEAR for the wasm, its state and a margin of its own (`--min-hub-balance`, default 0.1 NEAR).
   With the current wasm that is about 3.02 NEAR.
1. The hub account signs `DeployContract` and `new({ admin, token, network })` in one transaction, because `new` is private.
2. The hub account signs `storage_deposit({ account_id: hub, registration_only: true })` at the token, so the first Budget deposit cannot fail for want of registration.
   The deposit is the larger of `--storage-deposit` (default 0.00125 NEAR) and the token's `storage_balance_bounds.min`.
3. The admin signs `set_settler({ account: settler, allowed: true })`.
   The deposit pays for the allowlist entry, and the hub refunds what it does not use.
4. The admin signs `set_checkout_key({ key, settler })`, with a deposit that pays for the entry.
   Payments accepted under checkout terms draw on that settler's storage balance.
5. Prefund: the admin signs `fund_storage({ account: settler })` with `--settler-storage` (default 1 NEAR), unless the settler already holds `--min-settler-storage`.
   The default minimum is 0.36913 NEAR, which is one batch of 100 claims to new 64-character payees.
   Anyone may fund a settler, and the settler can take the unused part back with `withdraw_storage`.
6. The settler signs `register_receipt_key({ key })` with one yoctoNEAR, if `PAYMINTO_SETTLER_KEY` is set.
   Without that key the script prints the transaction for the node operator to sign and carries on.
   `--receipt-key` names the key, and it defaults to the checkout key, because a standard node signs both with one key.
7. The script checks the on-chain code hash against the local wasm, the config, the settler, the checkout key and its settler, the token registration, the settler's storage balance and the hub's own NEAR balance, and refuses to continue on any mismatch.
8. The hub account signs one transaction that deletes every access key on the hub account, and the script then checks that none is left.

Step 8 removes function-call keys as well as full-access keys.
A function-call key on the hub account calls the hub as the hub itself, which would pass the `#[private]` check on `on_payout` and `on_reclaim`.
After step 8 the code can never change, because the contract has no upgrade method and the account has no key, so a bug means deploying a new hub.

The hub's own balance is its NEAR, less what its storage locks, less the storage balances it holds for settlers.
The hub pays for its own code and for nothing else, so that balance does not fall as the hub is used, apart from the one yoctoNEAR that NEP-141 requires on each token transfer.

Keys come from `PAYMINTO_HUB_KEY` and `PAYMINTO_ADMIN_KEY` (`ed25519:...`) if they are set, and otherwise from near-cli credentials in `~/.near-credentials/testnet/<account>.json` (or `--credentials-dir`).
`PAYMINTO_SETTLER_KEY` is optional and is used for step 6 only.
The hub, admin, settler and token accounts must already exist.
The hub account needs NEAR for the wasm, and the admin needs the prefund.

```sh
# Print every transaction without signing anything. This needs no key and works offline.
node packages/chain/scripts/deploy-hub.ts --network testnet \
  --hub hub.example.testnet --admin admin.example.testnet --settler node.example.testnet \
  --token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af \
  --checkout-key ed25519:<node checkout public key> --dry-run

# The same command without --dry-run, plus --confirm-lock, deploys and locks for real.
# On a local sandbox, pass --network sandbox --rpc-url http://127.0.0.1:<port> instead.
```

Other flags are `--rpc-url`, `--wasm` (default `contracts-near/out/hub.wasm`), `--receipt-key`, and `--storage-deposit`, `--settler-storage`, `--min-settler-storage` and `--min-hub-balance` in yoctoNEAR.
The dry run prints every step, including the balance check, the prefund and the receipt key, with their deposits.
The script prints a JSON report with the wasm sha256, the code hash, each step's transaction hash, the settler's storage balance, whether its receipt key is registered and whether the hub is locked.
If a step fails after its transaction was sent, the error names the transaction hash; check it before running again.

## Deployment notes

The hub needs a NEP-145 `storage_deposit` at the token before its first deposit, and it never pays token registration for anyone else.
The hub account needs NEAR for its own code only.
The node settles with a function-call key on its own account, limited to `settle_batch` and `payout` on the hub.
The node's account itself, with a full-access key, registers the receipt key and withdraws storage balance, because both need one yoctoNEAR.
A node should alert when `storage_of(settler)` runs low: `settle_batch` is refused with `INSUFFICIENT_STORAGE` once the balance cannot pay for a batch.

## Rules enforced on chain

- `open_budget` sets `cap`, and the predecessor is the owner, so a DAO contract works with no key assumptions.
- `ft_on_transfer` accepts `{"budget":{"budget_id"}}` from the owner only, and it raises only `escrow`.
- `settle_batch` is one atomic receipt, and all checks run before any write.
  The settler is the caller, and the batch needs nothing but the claims.
- The `cap` limits gross spending, and each owner's net debit must fit within escrow.
- `expected_net` must match the recomputed netting exactly, sorted by account and omitting zero entries.
- Settlement closes at `min(valid_until + 3 days, revoked_at + 24 hours)`, and `reclaim` opens strictly after that.
- A Budget with an empty payee list allows any payee, and a non-empty list holds at most 16 sorted payees.
- The hub's own account and the token account are never payees or merchants.
  A claim that names one is refused with `RESERVED_ACCOUNT`, a Budget that lists one with `INVALID_BUDGET`, and a checkout payment to one is returned.
  Credit in their name could never be paid out.
- `fund_from_credit(budget_id, amount)` moves the caller's own credit into the escrow of one of the caller's open Budgets.
  It raises escrow only, never cap, moves no tokens, and leaves `total_escrow + total_credits` unchanged.
  The caller must own the Budget, the Budget must be neither revoked nor expired, and `0 < amount <= credit`.
- Settlement never draws credit by itself, because `payout` is open to anyone, so a third party could empty an owner's credit and break a pending batch.
  An owner who wants to spend earned credit moves it into escrow first.
- `settle_batch` and `payout` need no attached deposit, so a function-call key can call them.
  `fund_from_credit`, `register_receipt_key` and `withdraw_storage` need exactly one yoctoNEAR, and `set_settler` and `set_checkout_key` need at least one.
  The yoctoNEAR on `fund_from_credit` means a function-call key cannot turn withdrawable credit into agent spending power.
- Every panic is a code from `src/errors.rs`, and `ALL` there equals `HUB_ERRORS` in `packages/chain`; both sides test against `packages/chain/vectors/errors.json`.

## settle_own and the node's acceptance

`settle_own(claim, acceptance)` is the seller's escape hatch: it settles the seller's latest voucher with no node involved.
It takes the voucher only together with the acceptance the node signed for that exact call.

The reason is that the Budget's owner chooses the agent key.
Without the acceptance an owner could sign a voucher to itself, or to an accomplice, call `settle_own`, and empty the escrow ahead of the sellers whose calls the node had accepted.
A leaked agent key could do the same during the revoke grace period, and for three days after expiry, because a voucher carries no time.
The node's exposure rule could stop neither, since `settle_own` never passes through the node.

- The node signs one acceptance per call it accepts, and returns it to the seller in the receipt.
  The digest is `sha256` of the text `payminto.accepted.v1|call_id|budget_id|payee|amount|cumulative|request_hash|timestamp|voucher_sig`.
  `call_id` is `sha256` of the text `payminto.call.v1|budget_id|payee|cumulative|request_hash`.
  Ids and signatures are lowercase hex, numbers are decimal, and `timestamp` is Unix seconds.
  The hub rebuilds both texts from the claim, so the acceptance covers that claim and no other.
  `packages/chain/vectors/acceptance.json` pins the bytes for the contract and for TypeScript.
- A settler registers the keys it signs with: `register_receipt_key({ key })`.
  Only an allowlisted settler can register, only for itself, and with exactly one yoctoNEAR, so its function-call key cannot.
  Keys are only ever added, at most 4 per settler, so a node cannot strand its sellers by replacing its key and vanishing.
  A settler removed from the allowlist keeps its keys.
  `receipt_keys({ settler })` lists them.
- `settle_own` checks, in this order: the caller is the payee, the Budget exists, the payee is not the Budget's owner, the settlement deadline has not passed, the payee is not reserved and is on the payee list, the voucher signature, the voucher is not stale, the acceptance key is one the Budget's settler registered (`ACCEPTANCE_KEY_UNKNOWN`), the acceptance signature covers this claim (`BAD_ACCEPTANCE`), the acceptance is in time (`ACCEPTANCE_TOO_LATE`), the cap, the escrow, and the storage deposit.
- The acceptance is in time when it is dated no later than the Budget's `revoked_at` and no later than its `valid_until`.
  The acceptance carries seconds and the Budget milliseconds.
  A second counts from its first millisecond: the test is `timestamp * 1000 <= limit`.
  So a call the node accepted in the same second as the revoke still settles, which gives up to 999 ms after the revoke, and a call accepted one second later does not.
  A timestamp too large to express in milliseconds is late.
- `settle_own` refuses a payee that is the Budget's owner (`PAYEE_IS_OWNER`), whatever acceptance comes with it.
- `settle_batch` is unchanged: the settler is the caller, so its own call is its acceptance.

## Storage

The hub never pays for storage that someone else causes.
Every method that grows state measures the growth with `env::storage_usage()` and charges exactly that many bytes, at the protocol's price of 1 NEAR per 100 kB.

| Method | Who pays for the bytes it writes |
|---|---|
| `open_budget` | The owner's deposit: the record, 8 bytes for a later revoke, and 4,800 bytes reserved for `settle_own`. The excess is refunded. |
| `revoke_budget` | Prepaid by the owner at `open_budget`. |
| `settle_batch` | The settler's storage balance: new `settled` and `credits` entries and the batch record. |
| `ft_on_transfer`, checkout payment | The storage balance of the settler named in `set_checkout_key`. |
| `register_receipt_key` | The calling settler's storage balance. |
| `settle_own` | The Budget's reserve, then the caller's deposit. The excess is refunded. |
| `set_settler`, `set_checkout_key` | The admin's deposit. The excess is refunded. |
| `fund_storage` | The deposit itself pays for a new balance entry. |
| `payout`, `reclaim`, `fund_from_credit`, deposits | They write nothing new. |

- `fund_storage({ account })` adds the attached NEAR to an account's storage balance, and anyone may fund any account.
- `withdraw_storage({ amount })` returns unused balance to the caller, with exactly one yoctoNEAR attached.
- `storage_of({ account })` is the unused balance in yoctoNEAR.
- A call that the balance cannot pay for panics with `INSUFFICIENT_STORAGE` and changes nothing.
  For a checkout payment the panic makes the token return the payment to the payer.
- A `credits` entry is removed once it holds no credit and nothing is in flight to its account.
  The storage that frees goes back to the storage balance of the settler that paid for the entry, which the entry records.
  An entry that a `settle_own` caller or a Budget's reserve paid for has no balance to return to, so that storage stays with the hub.
  `settled` entries and batch records are never removed.
- Record sizes are in `packages/chain/src/storage.ts`, and `packages/chain/vectors/storage.json` pins them: the contract's tests write each record and measure it.
  A `settled` entry is 93 bytes plus the payee's length, a `credits` entry 78 bytes plus the account's length plus 4 bytes and the settler's length, and a batch record 149 bytes plus the settler's length.
- Measured on sandbox: a batch of 100 one-unit claims to 100 new payees wrote 22,841 bytes, the settler's balance fell by exactly 0.22841 NEAR, and the hub's own balance did not change.

## Async and callback review

Reviewed against the `docs.near.org` security pages on reentrancy, callbacks and callback panics, and the security checklist.

- `payout` and `reclaim` deduct first and record the amount as `in_flight` before the promise.
- Both callbacks are `#[private]`, read only the promise status, use saturating arithmetic, and never panic.
- `payout` keeps the `credits` entry, with the amount in the entry's own `in_flight`, so a restoring callback never needs new storage.
  The callback removes the entry only when it holds no credit and nothing is in flight, so two overlapping payouts of one account are safe in either order.
- Other methods can run between a transfer and its callback, and they see credits and escrow already deducted, so no amount can be spent twice.
- Each transfer has a static 15 Tgas and each callback a static 8 Tgas.
  A transfer that runs out of gas fails safely, because the callback restores the amount.
  A callback must not run out, so its static gas is about four times what it burns.
- `payout` and `reclaim` refuse to start, with `INSUFFICIENT_GAS`, unless the gas left covers 26 Tgas for each account plus 10 Tgas.
  The 26 Tgas are the two static amounts and 3 Tgas for creating the two receipts.
- Attached deposits are refunded to the predecessor beyond what a call's storage costs.
- `ft_on_transfer` is guarded by the token check, returns the full amount on bad input, and any panic there still refunds through NEP-141 resolution.

## Gas profile

Measured with `tests/gas_profile.rs` on `near-sandbox` 2.14.0 on macOS ARM, using `out/hub.wasm`.
Each figure is the total gas burnt by one `settle_batch` transaction, in Tgas.
Every claim settles to a payee with no prior `settled` or `credits` entry, which is the storage-heavy case.

| Claims | One Budget, new payees | Distinct owners and Budgets, new payees |
|---|---|---|
| 1 | 3.2 | 3.2 |
| 10 | 9.1 | 11.0 |
| 50 | 36.1 | 45.9 |
| 100 | 71.4 | 90.2 |

`NearRpcChain` attaches `30 + 2 * claims` Tgas to `settle_batch`, which is 230 Tgas for 100 claims.

`payout` to 10 accounts burnt 50.4 Tgas in total, with 10.7 Tgas in the hub call and about 1.85 Tgas in each callback against a static 8 Tgas.
The gas a payout needs attached is far more than it burns, because every transfer and callback reserves its static gas up front.

| `payout` to 10 accounts | Tgas |
|---|---|
| The hub's own requirement, `26 * 10 + 10` | 270 |
| Least attached gas that works | 272 |
| Refused below that with | `INSUFFICIENT_GAS` |
| What `NearRpcChain` attaches, `payoutGasTgas(10)` | 300 |
| Real need: static gas, the hub call's burn and the prepaid receipt fees | about 258 |

Before this fix the hub asked for 210 Tgas and the least that worked was 228 Tgas, while the client attached 230 Tgas.
A call between 210 and 228 Tgas ran out of gas in the runtime instead of being refused, and the client's margin was under 1 percent.
`payoutGasTgas(n)` is `20 + 28 * n`, capped at 300: the hub's requirement, 10 Tgas, and 2 Tgas for each account.
`tests/sandbox.rs` and `packages/chain/test/sandbox.test.ts` both pay out to 10 accounts, the second through `NearRpcChain` with its own gas value.

`fund_from_credit` burnt 2.3 Tgas in total, measured by `fund_from_credit_moves_earned_credit_into_escrow` in `tests/sandbox.rs`, and the wallet builder attaches 30 Tgas.

Safe `MAX_CLAIMS` stays at 100.
The worst measured case uses 90 Tgas of the 300 Tgas a transaction can attach, which leaves room for the deeper tries of a long-lived testnet hub.
The slope of about 0.9 Tgas per claim suggests that around 250 claims would still fit, but that is not measured and the constant is not raised.

## Known limits

- This code is unaudited, and it is meant for testnet only.
- A plain `ft_transfer` to the hub, instead of `ft_transfer_call`, is not tracked.
  The hub never sees it, nobody is credited, and the sender cannot recover it, because no method can move tokens that are not escrow or credit.
  The hub's token balance then exceeds its tracked liabilities by that amount, so solvency checks compare with "at least", not "equal", on a public hub.
- An agent key can still sign vouchers during the 24 hour revoke grace period.
  Such a voucher cannot be settled through `settle_own`, which needs the node's acceptance dated no later than the revoke.
  It can still be settled by `settle_batch`, where the settler is the caller, so the node must refuse new calls on a Budget as soon as it sees the revoke.
  A settler that keeps accepting after a revoke, or a settler that colludes with whoever holds the agent key, is not stopped by the chain: an owner trusts the settler it names.
- The acceptance carries seconds, so `settle_own` takes a call the node accepted up to 999 ms after the revoke, within the same second.
- The acceptance time is the node's clock, and the revoke time is the block's.
  A node that accepts a call just before it sees a revoke on chain may date that acceptance after the revoke.
  The seller then cannot settle that call by itself, and since vouchers are cumulative and the seller keeps the latest one, not the earlier calls to that payee either.
  The node's own `settle_batch` still settles it.
- A receipt key cannot be removed.
  If a settler's receipt key leaks, whoever holds it and an agent key can pass `settle_own` for that settler's Budgets.
  The remedy is a new settler account, and owners opening new Budgets that name it.
- A Budget can name a settler that has registered no receipt key.
  Its sellers cannot use `settle_own` until that settler registers one.
- `settle_own` can front-run a pending batch.
  A seller that settles its own voucher while the node's batch with the same voucher is in flight makes that batch fail with `STALE_VOUCHER`, and the node has to rebuild it without that claim.
  The cost to the node is one failed transaction, and no funds move twice.
- Batch ids are global to the hub, not per settler.
  A batch id is 16 random bytes chosen by the node, so another settler guessing one first is not practical.
  A batch id that is already taken is refused with `BATCH_EXISTS`.
- Storage freed from a `credits` entry that no settler paid for stays on the hub account and cannot be withdrawn by anyone.
  The same is true of a Budget's unused `settle_own` reserve.
- Each `payout` and `reclaim` transfer attaches the one yoctoNEAR that NEP-141 requires, from the hub's own balance.
  0.1 NEAR covers 10^23 transfers.
- There is no NEP-330 reproducible build.
  Docker was not available when this wasm was built (the CLI is installed but no daemon runs), so `out/hub.wasm` is reproducible only in the sense of a pinned toolchain, cargo-near version and `Cargo.lock`.
  The image named in `Cargo.toml` is for cargo-near 0.22.0 and has not been checked against 0.23.0.
- The chain proves the settler committed to a root, and it does not prove the root covers every voucher.
- `settle_own` is rejected when the voucher exceeds escrow, so a payee of a Budget funded below its gross exposure may be unable to settle until the owner adds funds.
- An owner's hub credit cannot pay a net debit until the owner moves it into escrow with `fund_from_credit`, which is why the node's exposure rule counts escrow only.
