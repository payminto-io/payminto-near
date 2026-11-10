# Payminto hub contract

The hub escrows a NEP-141 token for Budget owners, settles batches of agent vouchers, and pays out net credits.
It is unaudited and testnet only.

Design source: `docs/superpowers/specs/2026-11-10-near-clearing-design.md`, section "Roundtable decisions".
Encoding and argument shapes follow `packages/chain/README.md`, and the JSON vectors in `packages/chain/vectors` pin both sides.

## Layout

Hub v2 keeps one invariant per file, and every file states its invariant at the top.

- `src/lib.rs` holds the state, the constants, `new` and the token receiver `ft_on_transfer`, which dispatches to the modules.
- `src/auth.rs` holds one guard per role (admin, pending admin, owner, settler, payee, token, the hub itself, anyone), each returning a context value only it can build, and the authorization table.
- `src/budgets.rs`: `open_budget`, `revoke_budget`, `reclaim` and its callback, `fund_from_credit`, `prune` and Budget deposits.
- `src/settlement.rs`: `settle_batch` and `settle_own`, with the voucher and acceptance checks.
- `src/payouts.rs`: `payout`, its callback, and credit entries.
- `src/storage.rs`: storage charging, `fund_storage` and `withdraw_storage`.
- `src/checkout.rs`: checkout payments, `set_checkout_key`, `accept_checkout` and `set_min_payment`.
- `src/admin.rs`: `set_settler`, `register_receipt_key`, `propose_admin` and `accept_admin`.
- `src/views.rs`: every read-only method.
- `src/events.rs`: the NEP-297 events.
- `src/crypto.rs`: `verify_signature` and the public key check.
- `src/encoding.rs` holds the Borsh digests, the text digest of the node's acceptance, and Merkle hashing.
- `src/netting.rs` is pure account-level netting.
- `src/errors.rs` holds the panic codes the node maps to refusals.
- `src/tests/` holds unit tests, including vector conformance.
  `src/tests/review.rs` holds one test per security review finding, each of which failed before its fix.
  `src/tests/audit.rs` ports the internal audit's proofs of concept (`docs/audit/2026-11-10-internal-audit.md`) as regression tests.
  `src/tests/auth.rs` calls every guarded method as every wrong caller and checks the exact code, and fails when a public method is neither guarded nor listed as open to anyone.
  `src/tests/events.rs` checks the event of every state change, and `src/tests/v2.rs` the other hub v2 rules.
- `mock_ft/` is a mock NEP-141 token for sandbox tests only.
- `tests/sandbox.rs` runs the real wasm in `near-sandbox`, and `tests/gas_profile.rs` measures gas.
- `out/hub.wasm` and `out/mock_ft.wasm` are the built artifacts.

## Build and test

`rust-toolchain.toml` pins Rust 1.99.1.

```sh
sh build.sh
cargo test
cargo test --test gas_profile -- --nocapture --ignored --test-threads=1
```

`build.sh` runs `cargo near build non-reproducible-wasm --locked` for the hub and for `mock_ft`, copies both into `out/`, and prints their sha256.

`cargo test` needs the files in `out/`, because the sandbox tests deploy them.
The sandbox tests start their own `near-sandbox` 2.14.0; set `NEAR_SANDBOX_BIN_PATH` to reuse a binary instead of downloading one.

The current `out/hub.wasm` is hub v2 (crate version 0.2.0) with the pre-audit fixes: 345,682 bytes, sha256 `ef9e1fcee61b4dbd89f9a2051c673c39a2eec480376128a93f23b107f552ea09`, which is NEAR code hash `H8NHZwWQPwgdYCku8kUR7AqcnbvY28BQGaRU5LhuARFN`.
The hub v2 build before the pre-audit fixes was 337,826 bytes with code hash `EyMRXoHdTQHLadE1dJzcGC5jY5XwmWsEdaeVeV9fHDmx`; it was never deployed.
`out/mock_ft.wasm` is 148,597 bytes with sha256 `4afb0fa6ec9c5d345687af8b374f69196a83ac129be739c97c076427f14d33e8`.
They were built with `sh build.sh`, cargo-near 0.23.0 and Rust 1.99.1.
`packages/chain/scripts/deploy-hub.ts` pins the code hash as `HUB_CODE_HASH` and refuses to deploy the default wasm when it differs.
Hub v1 was 289,790 bytes with code hash `CMKbhRxTnjQsgFZpDPsEqTz55h6iDvxy8qYXpAhJUtqc`; it was never deployed.

### Reproducible build

rustc writes the paths of dependency sources into panic locations, and those sources live under `$CARGO_HOME`, usually inside the builder's home directory.
`build.sh` remaps `$CARGO_HOME` to `/cargo` with `--remap-path-prefix`, so no home path reaches the wasm: `strings -n 6 out/hub.wasm | grep -c /Users/` is 0, and the script refuses to finish if any path from `$CARGO_HOME` or `$HOME` is left.
cargo-near ignores `RUSTFLAGS` from the shell and from `.cargo/config.toml`, so the flag goes through its `--env` option.
The bytes then depend only on the sources, `Cargo.lock`, Rust 1.99.1 and cargo-near 0.23.0: a rebuild from a copy of `contracts-near` in another directory gave the same sha256.
A build on a second machine has not been compared yet.

`Cargo.toml` also carries the NEP-330 Docker build parameters, for verifying a pushed commit (for example on SourceScan): the image `sourcescan/cargo-near:0.23.0-rust-1.99.1` with digest `sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc`.
That build embeds the image and the commit in the contract metadata, so its hash differs from `out/hub.wasm` by design.

`near-sdk` is used with `default-features = false`, in both dependency sections and in `mock_ft`, which drops `wee_alloc` (RUSTSEC-2022-0054, unmaintained); Rust's own allocator for wasm32 takes over.

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
   With the current wasm that is about 3.58 NEAR.
1. The hub account signs `DeployContract` and `new({ admin, token, network })` in one transaction, because only the hub account itself may call `new` (`NOT_SELF`).
2. The hub account signs `storage_deposit({ account_id: hub, registration_only: true })` at the token, so the first Budget deposit cannot fail for want of registration.
   The deposit is the larger of `--storage-deposit` (default 0.00125 NEAR) and the token's `storage_balance_bounds.min`.
3. The admin signs `set_settler({ account: settler, allowed: true })`.
   The deposit pays for the allowlist entry, and the hub refunds what it does not use.
4. The admin signs `set_checkout_key({ key, settler })`, with a deposit that pays for the entry.
   This is only a proposal: nothing draws on the settler's storage balance until the settler accepts in step 6b.
5. Prefund: the admin signs `fund_storage({ account: settler })` with `--settler-storage` (default 1 NEAR), unless the settler already holds `--min-settler-storage`.
   The default minimum is 0.281 NEAR, which is the records of 100 batches by a 64-character settler: in hub v2 a settler pays only for its own batch records, receipt keys and checkout payments, and each Budget's owner prepays its payees' settlement storage.
   Anyone may fund a settler, and the settler can take the unused part back with `withdraw_storage`.
6. The settler signs `register_receipt_key({ key })` with one yoctoNEAR, if `PAYMINTO_SETTLER_KEY` is set.
   Without that key the script prints the transaction for the node operator to sign and carries on.
   `--receipt-key` names the key, and it defaults to the checkout key, because a standard node signs both with one key.
6b. The settler signs `accept_checkout({ key })` with one yoctoNEAR, which makes it the checkout settler, if `PAYMINTO_SETTLER_KEY` is set.
   Without that key the script prints the transaction for the node operator to sign, as in step 6.
7. The script checks the on-chain code hash against the local wasm, the config, the settler, the checkout key and its settler (or the pending proposal when step 6b was left to the operator), the token registration, the settler's storage balance and the hub's own NEAR balance, and refuses to continue on any mismatch.
   It also refuses to lock while an admin transfer is pending (`config().pending_admin` is not null), because the proposed account could still accept after the lock.
8. The hub account signs one transaction that deletes every access key on the hub account, and the script then checks that none is left.

Step 8 removes function-call keys as well as full-access keys.
A function-call key on the hub account calls the hub as the hub itself, which would pass the `require_self` check on `on_payout` and `on_reclaim`.
After step 8 the code can never change, because the contract has no upgrade method and the account has no key, so a bug means deploying a new hub.

The hub's own balance is its NEAR, less what its storage locks, less the storage balances it holds for settlers and the storage reserves it holds for Budgets.
The hub pays for its own code and for nothing else, so that balance does not fall as the hub is used, apart from the one yoctoNEAR that NEP-141 requires on each token transfer.

Keys come from `PAYMINTO_HUB_KEY` and `PAYMINTO_ADMIN_KEY` (`ed25519:...`) if they are set, and otherwise from near-cli credentials in `~/.near-credentials/testnet/<account>.json` (or `--credentials-dir`).
`PAYMINTO_SETTLER_KEY` is optional and is used for steps 6 and 6b only.
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
The script prints a JSON report with the wasm sha256, the code hash, each step's transaction hash, the settler's storage balance, whether its receipt key is registered, whether it accepted the checkout role and whether the hub is locked.
If a step fails after its transaction was sent, the error names the transaction hash; check it before running again.

## Deployment notes

The hub needs a NEP-145 `storage_deposit` at the token before its first deposit, and it never pays token registration for anyone else.
The hub account needs NEAR for its own code only.
The node settles with a function-call key on its own account, limited to `settle_batch` and `payout` on the hub.
The node's account itself, with a full-access key, registers the receipt key, accepts the checkout role and withdraws storage balance, because all three need one yoctoNEAR.
A node should alert when `storage_of(settler)` runs low: `settle_batch` is refused with `INSUFFICIENT_STORAGE` once the balance cannot pay for a batch record.

## Rules enforced on chain

- `open_budget` sets `cap`, and the predecessor is the owner, so a DAO contract works with no key assumptions.
- `open_budget` refuses, with `INVALID_BUDGET`, a settler that is the hub or the token account, which could never settle.
  It also refuses a `valid_until` above `MAX_VALID_UNTIL_MS` = 10^13 ms (the year 2286), so a client that sends microseconds or nanoseconds is refused instead of opening a Budget that never expires.
- `ft_on_transfer` accepts `{"budget":{"budget_id"}}` from the owner only, and it raises only `escrow`.
- `settle_batch` is one atomic receipt, and all checks run before any write.
  The settler is the caller, and the batch needs nothing but the claims.
- The `cap` limits gross spending, and each owner's net debit must fit within escrow.
- `expected_net` must match the recomputed netting exactly, sorted by account and omitting zero entries.
- Netting is by account, so an owner's earnings that offset its own spending in the same batch are booked as escrow, not as withdrawable credit.
  That escrow is spendable by the owner's agent and returned to the owner at `reclaim`, after the settlement deadline.
  How much is booked this way depends on how the settler groups claims into batches.
  If A's agent spends 10 and A earns 15, one batch leaves A with escrow 100 and credit 5, and two batches leave escrow 90 and credit 15 (pre-audit P3, pinned by `p3_netting_turns_an_owners_earnings_into_locked_escrow`).
  No funds are lost either way.
- Settlement closes at `min(valid_until + 3 days, revoked_at + 24 hours)`, and `reclaim` and `prune` open strictly after that.
- `revoke_budget` is refused with `BUDGET_NOT_OPEN` once `valid_until` has passed, so a revoke can never shorten the 3-day expiry grace sellers rely on.
- A Budget either lists 1 to 16 payees, sorted and unique, or sets `allow_any_payee` with an empty list and declares in `max_payees` (1 to 256) how many distinct payees it can ever pay.
  An empty list without the flag, the flag with a list, or `max_payees` on a listed Budget is `INVALID_BUDGET`.
  Neither field is part of the Budget id: the hub only accepts the flag with an empty list, so the list fixes it.
- `max_payees` is a count: the Budget records `max_payees` (the list's length for a listed Budget) and `payees_paid`, and each payee it has never paid before counts once.
  One payee more than `max_payees` is refused with `TOO_MANY_PAYEES`, in `settle_batch` and in `settle_own` (pre-audit P4).
- The agent key must be canonical and not of small order, or `open_budget` is refused with `INVALID_BUDGET`; receipt keys and the checkout key with `INVALID_KEY`.
  With a small-order key anyone could forge signatures without a secret (audit finding F3).
- A claim's signed `amount` must not exceed its cumulative step, `cumulative - settled`, or the claim is refused with `AMOUNT_ABOVE_STEP`.
  `cumulative` stays the authority, and a lower `amount` is allowed, because a payee may settle only its latest voucher and skip earlier ones.
- Batch ids belong to their settler: the hub keys batches by `(settler, batch_id)`, so `batch({ settler, batch_id })` and `verify_receipt({ settler, batch_id, fields, proof })` name the settler, and one settler can never take another's id.
- The checkout settler opts in: the admin's `set_checkout_key({ key, settler })` only proposes, and the named settler takes the role with `accept_checkout({ key })` and exactly one yoctoNEAR.
  Anyone else, or another key, is refused with `NOT_PENDING_CHECKOUT`, so the admin can never spend a settler's storage balance on checkout payments without its consent (pre-audit P2).
  A payment is refunded once the checkout settler is no longer allowlisted, and `pending_checkout()` shows an open proposal.
- A checkout payment below `min_payment` is refunded.
  It is 10,000 base units (0.01 USDC) on a new hub, the admin can change it with `set_min_payment({ amount })`, and `config()` shows it.
- The hub's own account and the token account are never payees or merchants.
  A claim that names one is refused with `RESERVED_ACCOUNT`, a Budget that lists one with `INVALID_BUDGET`, and a checkout payment to one is returned.
  Credit in their name could never be paid out.
- `fund_from_credit(budget_id, amount)` moves the caller's own credit into the escrow of one of the caller's open Budgets.
  It raises escrow only, never cap, moves no tokens, and leaves `total_escrow + total_credits` unchanged.
  The caller must own the Budget, the Budget must be neither revoked nor expired, and `0 < amount <= credit`.
- Settlement never draws credit by itself, because `payout` is open to anyone, so a third party could empty an owner's credit and break a pending batch.
  An owner who wants to spend earned credit moves it into escrow first.
- `settle_batch` and `payout` need no attached deposit, so a function-call key can call them.
  `fund_from_credit`, `register_receipt_key`, `accept_checkout`, `withdraw_storage` and `accept_admin` need exactly one yoctoNEAR (`ONE_YOCTO_REQUIRED`), and `set_settler`, `set_checkout_key`, `set_min_payment` and `propose_admin` need at least one (`DEPOSIT_REQUIRED`).
  The yoctoNEAR on `fund_from_credit` means a function-call key cannot turn withdrawable credit into agent spending power.
  `revoke_budget` stays callable from a function-call key, for gasless and emergency revokes.
- The admin moves in two steps: `propose_admin({ new_admin })` by the admin names the account (or withdraws the proposal with `null`), and `accept_admin()` by that account, with exactly one yoctoNEAR, makes it the admin.
  `config()` shows `pending_admin`.
- Every panic the hub raises is a code from `src/errors.rs`, and `ALL` there equals `HUB_ERRORS` in `packages/chain`; both sides test against `packages/chain/vectors/errors.json`.
  Only near-sdk's own checks that run before the hub's code still panic with a library message: initializing twice, malformed JSON arguments, and a deposit on a method that takes none.
- Every state change logs a NEP-297 event, `EVENT_JSON:{"standard":"payminto","version":"1.0.0","event":...,"data":[...]}`: `budget_opened`, `budget_funded`, `credit_moved_to_escrow`, `budget_revoked`, `reclaim_started`, `reclaim_finished`, `budget_pruned`, `batch_settled`, `claim_settled_by_payee`, `payout_started`, `payout_finished`, `storage_reserve_returned`, `payment_received`, `settler_set`, `checkout_key_proposed`, `checkout_key_set`, `min_payment_set`, `receipt_key_registered`, `storage_funded`, `storage_withdrawn`, `admin_proposed` and `admin_transferred`.
  Amounts and times are decimal strings and ids hex, as in the views, and logging never panics.
  A call that changes nothing logs nothing: `set_settler` for an account already in that state, `propose_admin` with the proposal already pending, and `set_min_payment` with the current amount.
  `batch_settled` is a summary (settler, batch id, root, number of claims, gross, net).
  The per-Budget and per-account amounts of a batch are its `claims` and `expected_net` arguments, which are public in the transaction, so an indexer reads them there or reads the views.
  `claim_settled_by_payee` and `storage_reserve_returned` carry the Budget's `storage_reserve_bytes` after the change.

### Who may call what

`src/auth.rs` holds one guard per role, and every entry point calls exactly one of them first.

| Role | Methods | Refused with |
|---|---|---|
| The hub itself | `new`, `on_payout`, `on_reclaim` | `NOT_SELF` |
| Admin | `set_settler`, `set_checkout_key`, `set_min_payment`, `propose_admin` | `NOT_ADMIN`, `DEPOSIT_REQUIRED` |
| Pending admin | `accept_admin` | `NOT_PENDING_ADMIN`, `ONE_YOCTO_REQUIRED` |
| Owner of the Budget | `revoke_budget`, `reclaim`, `prune`; `fund_from_credit` with exactly one yoctoNEAR | `NOT_OWNER`, `ONE_YOCTO_REQUIRED` |
| Allowlisted settler | `settle_batch` (and the Budget must name it); `register_receipt_key` with exactly one yoctoNEAR | `NOT_SETTLER`, `NOT_BUDGET_SETTLER`, `ONE_YOCTO_REQUIRED` |
| The settler `set_checkout_key` proposed | `accept_checkout` with exactly one yoctoNEAR | `NOT_PENDING_CHECKOUT`, `ONE_YOCTO_REQUIRED`, `NOT_SETTLER` |
| The claim's payee, not the owner | `settle_own` | `NOT_PAYEE`, `PAYEE_IS_OWNER` |
| The token | `ft_on_transfer` | none: any other caller gets the full amount back |
| Anyone, by decision | `open_budget`, `payout`, `fund_storage`, `withdraw_storage` (own balance, exactly one yoctoNEAR), every view including `pending_checkout` | none |

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
- `settle_own` checks, in this order: the Budget exists, the caller is the payee, the payee is not the Budget's owner, the settlement deadline has not passed, the payee is not reserved and is on the payee list, the voucher signature, the voucher is not stale, the amount is within the step, the acceptance key is one the Budget's settler registered (`ACCEPTANCE_KEY_UNKNOWN`), the acceptance signature covers this claim (`BAD_ACCEPTANCE`), the acceptance is in time (`ACCEPTANCE_TOO_LATE`), the cap, the escrow, and the storage deposit.
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

The owner pays for every byte its Budget's settlements can write.
`open_budget` reserves `PAIR_BYTES` = 332 bytes per payee the Budget can pay (each listed payee, or `max_payees` for a Budget with `allow_any_payee`): one `settled` entry (157 bytes) and one credit entry the Budget pays for (175 bytes), both for a 64-character account, the longest NEAR allows.
The Budget view shows what is left as `storage_reserve_bytes`.
A settler pays only for its own batch records, so an owner and a set of throwaway payee accounts can no longer drain a settler's storage balance (audit finding F4).

| Method | Who pays for the bytes it writes |
|---|---|
| `open_budget` | The owner's deposit: the record, 8 bytes for a later revoke, and 332 bytes for each payee slot. The excess is refunded. |
| `revoke_budget` | Prepaid by the owner at `open_budget`. |
| `settle_batch` | Each Budget's reserve: its own new `settled` entries, and the credit entries of payees whose first claim in the batch is that Budget's. A Budget whose reserve is short fails the whole batch with `INSUFFICIENT_RESERVE`. The settler's storage balance: the batch record only. |
| `ft_on_transfer`, checkout payment | The storage balance of the checkout settler, which accepted the role itself with `accept_checkout`. A payment below `min_payment` is refunded and writes nothing. |
| `register_receipt_key` | The calling settler's storage balance. |
| `settle_own` | The `settled` entry: the Budget's reserve first, then the caller's deposit. A new credit entry: the reserve when what is left of it covers the whole entry, otherwise the caller's deposit for all of it. The excess is refunded. |
| `set_settler`, `set_checkout_key`, `propose_admin` | The admin's deposit. The excess is refunded. |
| `accept_checkout`, `set_min_payment` | Nothing new: the proposal moves into place, and the minimum is a fixed-width field. |
| `fund_storage` | The deposit itself pays for a new balance entry. |
| `payout`, `reclaim`, `fund_from_credit`, `prune`, deposits | They write nothing new. |

- `prune({ budget_id, payees })`, by the owner after the settlement deadline, removes the Budget's `settled` entries for up to 100 payees and refunds the owner the storage they freed plus whatever is left of the reserve.
  Nothing can settle against the Budget any more, so those entries are no longer needed.
  The Budget record stays, so its id can never be opened again and its old vouchers can never settle twice.
  After a prune `settled_of` returns 0 for those payees.
  What remains as evidence of what was settled is the `claim_settled_by_payee` events (with the final `cumulative`), the `batch_settled` events, the batch roots that `verify_receipt` reads, and the transactions themselves.
- `fund_storage({ account })` adds the attached NEAR to an account's storage balance, and anyone may fund any account except the hub and the token, which could never withdraw it (`RESERVED_ACCOUNT`).
- `withdraw_storage({ amount })` returns unused balance to the caller, with exactly one yoctoNEAR attached.
- `storage_of({ account })` is the unused balance in yoctoNEAR.
- A call that the balance cannot pay for panics with `INSUFFICIENT_STORAGE` and changes nothing.
  For a checkout payment the panic makes the token return the payment to the payer.
- A `credits` entry is removed once it holds no credit and nothing is in flight to its account.
  The storage that frees goes back to whoever paid for the entry, which the entry records: the Budget's reserve for an entry a settlement created, or the checkout settler's storage balance for a checkout payment.
  An entry that a `settle_own` caller's deposit paid for has no one to return to, so that storage stays with the hub.
  No entry is ever paid for by a reserve and owned by nobody: `settle_own` marks a new credit entry as the Budget's exactly when the reserve pays for it (pre-audit P1).
  So over any mix of batches, payouts and `settle_own`, every byte a reserve gives comes back, and `prune` returns the owner's prepayment in full once its payees are paid out (`p1_the_reserve_is_conserved_over_mixed_settlement_and_returned_in_full_at_prune`).
  `settled` entries are removed only by `prune`, and batch records are kept, because `verify_receipt` reads them.
- Record sizes are in `packages/chain/src/storage.ts`, and `packages/chain/vectors/storage.json` pins them: the contract's tests write each record and measure it.
  A `settled` entry is 93 bytes plus the payee's length.
  A `credits` entry is 78 bytes plus the account's length with no funder, 111 bytes plus the account's length when a Budget paid, and 83 bytes plus the account's and the settler's lengths when a settler paid.
  A batch record is 153 bytes plus twice the settler's length, since the settler is in its key too.
  A Budget record carries `max_payees` and `payees_paid`, 8 bytes more than before the pre-audit fixes.
- Measured on sandbox: a batch of 100 one-unit claims to 100 new 64-character payees wrote 33,200 bytes from the Budget's reserve and one batch record from the settler's balance, the hub's own balance did not change, and a 101st new payee was refused with `TOO_MANY_PAYEES`.

## Async and callback review

Reviewed against the `docs.near.org` security pages on reentrancy, callbacks and callback panics, and the security checklist.

- `payout` and `reclaim` deduct first and record the amount as `in_flight` before the promise.
- Both callbacks start with the `require_self` guard (`NOT_SELF` for any other caller), read only the promise status, use saturating arithmetic, and never panic after that.
  A call with other than exactly one promise result counts as a failed transfer rather than a panic.
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

Measured with `tests/gas_profile.rs` on `near-sandbox` 2.14.0 on macOS ARM, using `out/hub.wasm`, for hub v1 and the current hub v2, with the pre-audit fixes, on the same machine.
Each figure is the total gas burnt by one `settle_batch` transaction, in Tgas.
Every claim settles to a payee with no prior `settled` or `credits` entry, which is the storage-heavy case.

| Claims | One Budget, new payees, v1 | v2 | Distinct owners and Budgets, new payees, v1 | v2 |
|---|---|---|---|---|
| 1 | 3.2 | 3.4 | 3.2 | 3.4 |
| 10 | 9.1 | 9.3 | 11.0 | 11.2 |
| 50 | 36.1 | 36.1 | 45.9 | 47.1 |
| 100 | 71.2 | 71.0 | 90.2 | 93.9 |

The worst case the hub allows in one batch, `profile_settle_batch_worst_case`: 100 owners with 64-character account names, each with its own Budget listing 16 payees of 64 characters, and one claim per Budget to a new 64-character payee.
It burnt 114.3 Tgas on hub v1 and 119.8 Tgas on hub v2.
Charging each Budget its own bytes costs hub v2 about 3.7 Tgas on 100 distinct Budgets, about 4 percent.
The pre-audit fixes (the payee count and the `settle_own` rule) moved the hub v2 figures by at most 0.2 Tgas: before them the distinct-Budget rows read 47.0 and 93.7 and the worst case 119.6.

`NearRpcChain` attaches `30 + 2 * claims` Tgas to `settle_batch`, which is 230 Tgas for 100 claims.

`payout` to 10 accounts burnt 53.5 Tgas in total on hub v2, 52.4 before the pre-audit fixes and 50.4 on v1.
Each callback burns about 2 Tgas against a static 8 Tgas, and now logs a `storage_reserve_returned` event when it removes an entry a Budget paid for.
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
The worst measured case uses 120 Tgas of the 300 Tgas a transaction can attach, and `NearRpcChain` attaches 230 Tgas for 100 claims, which leaves room for the deeper tries of a long-lived testnet hub.
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
- Storage freed from a `credits` entry that a `settle_own` caller's deposit paid for stays on the hub account and cannot be withdrawn by anyone.
  `prune` refunds to the owner every byte it frees, including a `settled` entry that a `settle_own` caller's deposit paid for.
- A Budget cannot pay more distinct payees than its `max_payees`, its list's length or the declared count; the owner opens a new Budget for more.
- Checkout payment records stay on the checkout settler's balance for good, and batch records on their settler's.
  The checkout settler accepted the role itself, and a payment below `min_payment` (10,000 base units by default) is refunded, so one-unit payments cannot burn the settler's balance.
  The node also refuses open-amount links and payer amounts below its own `MIN_CHECKOUT_AMOUNT`, and signs no checkout terms below it.
  Payment records cannot be pruned.
- `open_budget` charges 8 bytes for a later revoke, and `prune` does not refund them when the Budget was never revoked (0.00008 NEAR).
- After `prune`, `settled_of` returns 0 for the pruned payees; the events, the batch roots and the transactions remain.
- `register_receipt_key` takes no proof that the settler holds the key's secret.
  The key check closes forgery; a settler that registers a key it does not hold only stops its own sellers from using `settle_own`.
- Each `payout` and `reclaim` transfer attaches the one yoctoNEAR that NEP-141 requires, from the hub's own balance.
  0.1 NEAR covers 10^23 transfers.
- The NEP-330 Docker build named in `Cargo.toml` has not been run; it needs a pushed commit and gives a different hash from `out/hub.wasm`, see "Reproducible build".
- The chain proves the settler committed to a root, and it does not prove the root covers every voucher.
- `settle_own` is rejected when the voucher exceeds escrow, so a payee of a Budget funded below its gross exposure may be unable to settle until the owner adds funds.
- An owner's hub credit cannot pay a net debit until the owner moves it into escrow with `fund_from_credit`, which is why the node's exposure rule counts escrow only.
