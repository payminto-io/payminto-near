# @payminto/chain

The only package that imports NEAR libraries.

- `.` is pure and browser-safe: types, Borsh digests, Merkle tree, netting, wallet action builders, and `NearReader`, a read-only client over plain `fetch`.
- `./node` is `NearRpcChain`, the RPC client built on near-kit 0.20.2, plus `sendWalletTx` and `sendBuiltOnce` for sending from a key held in Node.
- `./fake` is `FakeChain`, an in-memory model of the hub with the same rules and refusal codes.

The files in `vectors/` are frozen and are the contract between this package and `contracts-near/`.
`pnpm --filter @payminto/chain vectors` regenerates them, and `test/vectors.test.ts` fails if the code and the files disagree.
`vectors/errors.json` lists every hub error code, and both `HUB_ERRORS` here and `ALL` in `contracts-near/src/errors.rs` must equal it.
`vectors/signatures.json` pins the hub's ed25519 rule: a torsioned R, non-canonical R and A encodings, small-order keys including the all-zero key, and `s >= L`, each with what `env::ed25519_verify` returns and what `verifyDigest` returns.
`test/signatures.test.ts` runs it through `verifyDigest`, and `contracts-near/src/tests/vectors.rs` runs it through the hub's own verify function.

## Signatures

`verifyDigest` is the one signature rule for every decision that stands in for the hub: the node's voucher intake and batch pre-check, and the SDK's acceptance and receipt checks.
It returns true only when `ed25519VerifyAsHub` (exactly `env::ed25519_verify`: cofactorless, `s < L`, R compared byte for byte with `[s]B - [k]A`) accepts and the key passes `publicKeyProblem` (canonical and not of small order).
A cofactored verifier, such as noble's `ed25519.verify` with or without ZIP-215, accepts signatures whose R carries a torsion component, which the hub refuses; that is internal audit finding F1.
A small-order key lets anyone forge signatures with no secret, so the node and the SDK refuse to register or create a Budget for one (F3).

## NearRpcChain

- Every read uses final finality.
- Without `operatorKey` the client is read-only: views, `verifyReceipt` and `txState` work, and `settle` and `payout` reject with `NearRpcError` of kind `read_only` before anything is signed.
- A write is signed once, sent once with those exact bytes, and awaited to final execution.
  The client never retries a write or re-signs it with a new nonce, and operator writes run one at a time.
- A hub panic becomes `ChainError` with its code (`hubErrorOf` does the mapping).
  Anything else becomes `NearRpcError` with a `kind` (`read_only`, `rejected`, `failed`, `timeout`, `unavailable`, `invalid_response`), the transaction hash when one exists, and `outcomeUnknown` when a sent transaction may still land.
- `settle` is safe to call again with the same arguments: the hub refuses a batch id this settler already used with `BATCH_EXISTS` and changes nothing, so after an `outcomeUnknown` error read `batch(batchId, operator)` or call `settle` again and treat `BATCH_EXISTS` as "the first one landed".
- Batch ids belong to their settler on hub v2, so `batch(id, settler)` and `verifyReceipt(batchId, settler, fields, proof)` take the settler, on `Chain`, `NearRpcChain`, `FakeChain` and `NearReader` alike.
  A verifier that has only a receipt reads the settler from the Budget: `settle_batch` takes only Budgets that name the caller.
- `readTimeoutMs` (default 15 s) and `writeTimeoutMs` (default 60 s) bound each call.
- `txState(hash, sender?)` looks the transaction up with the operator as sender unless another sender is given.
- Extra reads beyond `Chain`: `config()` (with `pendingAdmin` and `minPayment`), `totals()`, `isSettler(account)`, `checkoutSettler()` and `pendingCheckout()`.
- `receiptKeys(settler)` and `storageOf(account)` are part of `Chain`: the keys a settler registered for signing acceptances, and the NEAR an account has prepaid for storage.
  A node reads both at startup, and sellers read the first before they rely on `settle_own`.
- `settle` attaches `30 + 2 * claims` Tgas.
  `payout` attaches `payoutGasTgas(n)`, which is `20 + 28 * n` capped at 300 Tgas: the hub's own requirement of `10 + 26 * n` (`payoutGasNeededTgas`), 10 Tgas, and 2 Tgas for each account.
  Ten accounts get 300 Tgas against a requirement of 270, and the least that works on sandbox is 272.

## NearReader

A read-only client for browsers and verifiers, with no keys, no near-kit and no Node built-ins.
It posts JSON-RPC `query` with `call_function` at `finality: "final"` through `fetch`, and aborts each request after `timeoutMs` (default 10 s).

- `batch(id, settler)`, `payments(ids)` and `verifyReceipt(batchId, settler, fields, proof)` return `{ value, blockHeight, blockHash }`, so a page can show which final block it read.
- `txState(hash, sender)` reads the `tx` method without waiting and answers `unknown`, `pending`, `final` or `failed` with the hub code.
- `view(contract, method, args)` is the general call behind them.
- `checkReceiptOnChain(reader, { network, settler, batchId, fields, proof })` rebuilds the leaf and root locally, reads the stored root, asks the hub's `verify_receipt`, and is verified only when both agree.
- Errors are `NearReadError` with a `kind`: `timeout`, `unavailable`, `not_found`, `contract_error` (with `hubCode`) or `invalid_response`.
- `PUBLIC_RPC_URLS` holds the public testnet and mainnet endpoints as defaults.

`test/reader.test.ts` replays the JSON-RPC answers in `test/fixtures/rpc/`, and each fixture also pins the exact request the reader must send.
The fixtures follow the public RPC's answer shape and are built from the Merkle vectors by `node scripts/gen-rpc-fixtures.ts`, so no test touches a network.

`pnpm --filter @payminto/chain test:sandbox` runs `test/sandbox.test.ts` against a real `near-sandbox`: the deploy script deploys and locks the hub, owners act through the action builders, and the node acts only through `NearRpcChain`.
The default `pnpm test` skips it.
`scripts/deploy-hub.ts` is documented in `contracts-near/README.md`.

## Wire types

| Type | Text form | Bytes in Borsh |
|---|---|---|
| `AccountId` | NEAR account id | Borsh `string` (u32 length plus UTF-8) |
| `Id32` | 64 lowercase hex characters, no `0x` | `[u8; 32]` |
| `Sig64` | 128 lowercase hex characters, no `0x` | `[u8; 64]` |
| `PublicKey` | `ed25519:<base58>` in the TypeScript API, 64 lowercase hex in contract JSON args | `[u8; 32]` |
| amounts | decimal string in JSON, `bigint` in TypeScript | `u128` little-endian |
| times | Unix milliseconds, decimal string in JSON | `u64` little-endian |

`network` is one of `near:testnet`, `near:sandbox` or `near:mainnet`, used verbatim as a string in every digest.
The contract needs it as an init parameter, and takes `hub` from `env::current_account_id()`.

## Tags

`VOUCHER_TAG` is `2147504402` (`2147484000 + 20402`), and `CHECKOUT_TAG` is `2147504403` (`2147484000 + 20403`).
Both are `u32` at or above 2^31, so the bytes cannot parse as a NEAR transaction.
They stay clear of NEP-413 (`2^31 + 413`) and of the NEP-461 range for any assigned NEP number.

## Borsh layouts

The field order below is the wire format, and every field is written with no padding.

Voucher digest is `sha256(borsh(VoucherPreimage))`.
The agent signs the 32 digest bytes with raw ed25519, which is what `env::ed25519_verify` checks.

```rust
struct VoucherPreimage {
    tag: u32,                 // 2147504402
    domain: String,           // "payminto.voucher.v1"
    hub: String,
    network: String,
    budget_id: [u8; 32],
    payee: String,
    amount: u128,
    cumulative: u128,
    request_hash: [u8; 32],
}
```

Budget id is `sha256(borsh(BudgetPreimage))`.

```rust
struct BudgetPreimage {
    domain: String,           // "payminto.budget.v1"
    hub: String,
    network: String,
    owner: String,            // the predecessor of open_budget
    agent_pk: [u8; 32],
    settler: String,
    cap: u128,
    valid_until: u64,         // Unix ms
    payees: Vec<String>,      // sorted by bytes, unique, at most 16; empty for a Budget with allow_any_payee
    policy_hash: [u8; 32],
    salt: [u8; 32],
}
```

`allow_any_payee` and `max_payees` are terms of `open_budget` but not part of the id: the hub accepts the flag only with an empty list, so the list fixes it.

Receipt leaf is `sha256(0x00 || borsh(ReceiptPreimage))`.

```rust
struct ReceiptPreimage {
    domain: String,           // "payminto.receipt.v1"
    hub: String,
    network: String,
    batch_id: [u8; 32],
    call_id: [u8; 32],
    budget_id: [u8; 32],
    payee: String,
    amount: u128,
    cumulative: u128,
    request_hash: [u8; 32],
    timestamp_ms: u64,
    voucher_sig: [u8; 64],
}
```

Checkout terms digest is `sha256(borsh(CheckoutPreimage))`, signed by the node's checkout key.

```rust
struct CheckoutPreimage {
    tag: u32,                 // 2147504403
    domain: String,           // "payminto.checkout.v1"
    hub: String,
    network: String,
    payment_id: [u8; 32],
    merchant: String,
    amount: u128,
    expiry_ms: u64,
}
```

## The node's acceptance

When the node accepts a call it signs an acceptance and returns it to the seller in the receipt.
The hub's `settle_own` takes a voucher only with that acceptance, so the digest is rebuilt on chain from the claim.
It is text, not Borsh, because the node has signed this form since before the hub checked it.

```text
call_id = sha256("payminto.call.v1|" budget_id "|" payee "|" cumulative "|" request_hash)
digest  = sha256("payminto.accepted.v1|" call_id "|" budget_id "|" payee "|" amount "|" cumulative "|" request_hash "|" timestamp "|" voucher_sig)
```

- `budget_id`, `request_hash` and `call_id` are 64 lowercase hex characters, and `voucher_sig` is 128.
- `amount` and `cumulative` are decimal with no sign and no leading zeros.
- `timestamp` is Unix seconds, decimal.
  Everything else on the hub is in milliseconds, so the hub multiplies by 1000 before it compares.
- The node signs the 32 digest bytes with raw ed25519, with its receipt key.

The text is unambiguous.
It always has nine fields, no field can contain `|`, and each value has exactly one text form, so two different calls can never produce the same text.
The hub and the network are not fields of their own: `budget_id` and the voucher signature both hash them.
The preimage starts with ASCII letters, so it can be mistaken neither for a Borsh preimage with a tag at or above 2^31 nor for a NEAR transaction.

`voucherCallId`, `acceptancePreimage`, `acceptanceDigest`, `signAcceptance`, `acceptanceSignedFor` and `acceptanceInTime` implement this.
`acceptanceDigest` equals `nodeDigest` in `@payminto/protocol`, and `voucherCallId` equals `callIdOf` in the node and the SDK; `vectors/acceptance.json` pins all of them and the contract.

## Storage

`src/storage.ts` holds the size in bytes of every record the hub writes, and what it costs at 10^19 yoctoNEAR per byte.
The hub charges for the bytes a call really writes and never pays for them itself.
`vectors/storage.json` pins the sizes, and the contract's tests write each record and measure it against that file.
`FakeChain` uses the same sizes, so a settler with no storage balance is refused there exactly as on chain.
On hub v2 the owner prepays its Budget's settlement storage at `open_budget`: `PAIR_BYTES` (332) per payee slot, one slot per listed payee or `maxPayees` (default `DEFAULT_MAX_PAYEES`, 16) for a Budget open to any payee (`payeeSlots`, `storageReserveBytes`).
`openBudgetStorageCost(terms)` is the record, `REVOKE_BYTES` and that reserve.
The Budget record carries `max_payees` and `payees_paid` (8 bytes), which the TypeScript `Budget` exposes as `maxPayees` and `payeesPaid`.
A settler pays only for its own batch records, receipt keys and checkout payments, so `maxSettleBatchStorageCost(batches)` is the cost of that many batch records of a 64-character settler, for sizing a prefund or an alert, never the charge itself.
A credit entry records who paid for it (`CreditFunder`: a settler, a Budget or nobody) and returns its bytes there when it is removed.

## Merkle tree

- Internal node: `sha256(0x01 || min(a,b) || max(a,b))`, comparing the 32 bytes.
- Leaves are sorted by `call_id` bytes ascending, and duplicate call ids are invalid.
- Pairs are taken left to right on each level, and an odd last node is promoted unchanged.
- A single leaf is its own root, with an empty proof.
- A proof is the sibling list from leaf to root, and a promoted node adds no sibling at that level.
- `MAX_MERKLE_DEPTH` is 32, and longer proofs are refused.
- `verify_receipt` takes fields and rebuilds the leaf, never a raw leaf.

## Hub rules that `FakeChain` models

- `open_budget` sets `cap`, and deposits raise only `escrow`.
  A payee list or a settler that names the hub or the token is `INVALID_BUDGET`, and so are a `valid_until` above `MAX_VALID_UNTIL_MS` (10^13 ms, which catches microseconds and nanoseconds), an empty list without `allow_any_payee`, `max_payees` outside 1 to 256 (`MAX_ANY_PAYEES`), and an agent key that is of small order or not canonical (`publicKeyProblem`; the hub does not detect a key that is not a point at all).
- `settle_batch` panics with a code from `HUB_ERRORS` as the start of the message, and the RPC client maps that code onto `ChainError`.
- Check order is settler allowlist, replayed batch id for this settler, `MAX_CLAIMS`, then per claim: known Budget, Budget settler is the caller, one Budget per owner, inside the settlement deadline, payee not the hub or the token (`RESERVED_ACCOUNT`), payee allowed, signature, not stale, signed amount within the cumulative step (`AMOUNT_ABOVE_STEP`), a payee new to the Budget within its `max_payees` (`TOO_MANY_PAYEES`), cap.
- Then `ZERO_GROSS`, `NET_MISMATCH`, `INSUFFICIENT_ESCROW` for each net debtor, `INSUFFICIENT_RESERVE` if a Budget's reserve cannot pay for its new payees (a safety net: with the payee count it does not happen in ordinary use), and finally `INSUFFICIENT_STORAGE` if the settler's storage balance cannot pay for the batch record.
- A claim with `cumulative <= settled` is `STALE_VOUCHER`.
- Claims apply in order, so a later claim for the same pair is measured against the earlier one.
- Netting parties are the Budget owner account and the payee account.
- `expected_net` is sorted by account bytes and omits zero entries, as `{ account, debit, credit }`, with exactly one of the two positive.
- `net` on the batch is the sum of credits, which is the cash that moves.
- Net creditors gain `credits`, including a Budget owner who nets positive.
- Settlement closes after `min(valid_until + 3 days, revoked_at + 24 hours)` (`settleDeadline`), and `reclaim` and `prune` open after that.
- `revoke_budget` checks `NOT_OWNER`, `ALREADY_REVOKED`, then `BUDGET_NOT_OPEN` after `valid_until`.
- `prune(owner, id, payees)` checks `NOT_OWNER`, `TOO_MANY_ACCOUNTS` (100), `TOO_EARLY`, then removes the Budget's settled entries for those payees and empties its reserve, which the hub refunds to the owner.
- `settle_own` applies no offset and debits the full delta from escrow.
  It needs the node's acceptance of the claim.
  Its check order is: known Budget, caller is the payee (`NOT_PAYEE`), payee is not the Budget's owner (`PAYEE_IS_OWNER`), inside the settlement deadline, `RESERVED_ACCOUNT`, payee allowed, signature, not stale, `AMOUNT_ABOVE_STEP`, `TOO_MANY_PAYEES`, the acceptance key is a receipt key of the Budget's settler (`ACCEPTANCE_KEY_UNKNOWN`), the acceptance signature covers this claim (`BAD_ACCEPTANCE`), the acceptance is dated no later than the Budget's revoke and expiry (`ACCEPTANCE_TOO_LATE`), cap, escrow, and `INSUFFICIENT_DEPOSIT` for storage beyond the Budget's reserve.
  The `settled` entry comes from the reserve first and the deposit for the rest; a new credit entry comes from the reserve, and is the Budget's, only when what is left covers all of it, and otherwise from the deposit alone with no funder.
- The acceptance time test is `timestampS * 1000 <= min(revokedAt, validUntil)`, so the second of the revoke still settles and the next one does not.
- `register_receipt_key` checks `NOT_SETTLER`, exactly one yoctoNEAR (`ONE_YOCTO_REQUIRED`), `INVALID_KEY`, `RECEIPT_KEY_EXISTS`, `TOO_MANY_RECEIPT_KEYS` (4 keys), and `INSUFFICIENT_STORAGE`.
  Keys are never removed, and a settler taken off the allowlist keeps its keys.
- `fund_storage` checks `ZERO_AMOUNT`, `RESERVED_ACCOUNT` for the hub and the token, then `INSUFFICIENT_DEPOSIT` when a first deposit does not cover the balance entry.
  `withdraw_storage` needs exactly one yoctoNEAR (`ONE_YOCTO_REQUIRED`), then checks `ZERO_AMOUNT` and `INSUFFICIENT_STORAGE`.
- A `budget` deposit from anyone but the owner, or to a revoked or expired Budget, is refunded in full.
- A checkout payment is refunded in full when the merchant is the hub or the token, when the amount is below the minimum (`minPayment`, default `DEFAULT_MIN_PAYMENT` = 10,000 base units), when the checkout settler is no longer allowlisted, and when the checkout settler's storage balance cannot pay for it.
  On chain the second case is an `INSUFFICIENT_STORAGE` panic, which the token resolves as the same refund.
- `payout` is capped at 10 accounts, skips unregistered accounts and accounts with no credit, and restores credit if the transfer fails.
  A credit entry left empty is removed, and its storage goes back to whoever paid for it: the Budget's reserve or the settler's balance.
- `fund_from_credit` checks in order: `UNKNOWN_BUDGET`, `NOT_OWNER`, exactly one yoctoNEAR (`ONE_YOCTO_REQUIRED`), `ZERO_AMOUNT`, `BUDGET_NOT_OPEN` (revoked, or past `valid_until`), `INSUFFICIENT_CREDIT`.
  It moves the caller's credit into that Budget's escrow, never its cap, and moves no tokens.

`FakeChain.addSettler(account)` also prepays 10 NEAR of storage for that settler, so tests that are not about storage need no setup.
Pass a second argument of `0n` to model a settler that has not prepaid.
Admin calls, `set_settler`, `set_checkout_key` and `setMinPayment`, are test controls there, and their deposits are not modelled; `propose_admin` and `accept_admin` are not modelled at all.
`setCheckoutKey(key, settler)` proposes and, by default, also has the settler accept at once, so a test enables checkout in one call; pass `{ accept: false }` to model the proposal alone, then `acceptCheckout(settler, key)`, which checks `NOT_PENDING_CHECKOUT`, `ONE_YOCTO_REQUIRED` and `NOT_SETTLER` as the hub does.

Solvency invariant: token balance equals the sum of escrow, credits and in-flight payouts, checked by `FakeChain.solvency()`.

## Contract JSON

`src/actions.ts` is the reference for argument names and JSON shapes.

- `open_budget({ terms: { agent_pk, settler, cap, valid_until, payees, policy_hash, salt, allow_any_payee, max_payees } })`.
  `budgetTermsArgs` sets `allow_any_payee` for an empty list and `max_payees` from `terms.maxPayees` (default 16), or 0 for a listed Budget.
- `ft_transfer_call` `msg` is `{"budget":{"budget_id":"<Id32>"}}` or `{"payment":{"payment_id","merchant","amount","expiry_ms","signature"}}`.
- `settle_batch({ batch_id, root, claims, expected_net })`, where each claim is `{ budget_id, payee, amount, cumulative, request_hash, signature }`.
- `settle_own({ claim, acceptance })`, where `acceptance` is `{ node_key, timestamp_s, signature }`: the receipt key as 64 hex characters, Unix seconds as a decimal string, and the signature as 128 hex characters.
  Built by `settleOwnTx(hub, claim, acceptance, storageDeposit?)`.
- `revoke_budget({ budget_id })`, `reclaim({ budget_id })` and `payout({ accounts })`.
- `prune({ budget_id, payees })` by the owner after the settlement deadline, built by `pruneTx`.
- `propose_admin({ new_admin })` by the admin with at least one yoctoNEAR (`proposeAdminTx`), and `accept_admin()` by the proposed account with exactly one yoctoNEAR (`acceptAdminTx`).
- `fund_from_credit({ budget_id, amount })` with one yoctoNEAR attached, built by `fundFromCreditTx`.
- `register_receipt_key({ key })` with one yoctoNEAR attached, signed by the settler account, built by `registerReceiptKeyTx`.
- `fund_storage({ account })` with the amount attached, built by `fundStorageTx`, and `withdraw_storage({ amount })` with one yoctoNEAR attached, built by `withdrawStorageTx`.
- `set_settler({ account, allowed })` and `set_checkout_key({ key, settler })`, signed by the admin with a deposit that covers the entry; `set_checkout_key` only proposes.
- `accept_checkout({ key })` by the proposed settler with exactly one yoctoNEAR, built by `acceptCheckoutTx`, and `set_min_payment({ amount })` by the admin with at least one yoctoNEAR, built by `setMinPaymentTx`.
- Views: `receipt_keys({ settler })`, `storage_of({ account })`, `checkout_key()`, `checkout_settler()`, `pending_checkout()`, `batch({ settler, batch_id })`, `verify_receipt({ settler, batch_id, fields, proof })`, and `config()` with `pending_admin` and `min_payment`.
  The Budget view carries `storage_reserve_bytes` (a decimal string), `allow_any_payee`, `max_payees` and `payees_paid`.
