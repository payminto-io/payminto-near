<!-- Internal audit of the hub contract as of 2026-11-10 (commit 6e69a9b), before hub v2. The proof-of-concept tests named here become regression tests in contracts-near as each finding is fixed. -->
# Payminto hub contract: internal pre-audit review

Scope: `contracts-near/` (src/lib.rs, encoding.rs, netting.rs, types.rs, errors.rs, src/tests, tests/sandbox.rs, tests/gas_profile.rs), read against `contracts-near/README.md`, `docs/SECURITY.md` and `docs/REFUSALS.md`.
Reviewed on 2026-11-10 against the tree whose `out/hub.wasm` has sha256 `a8a53392...2c37` (code hash `CMKbhRxTnjQsgFZpDPsEqTz55h6iDvxy8qYXpAhJUtqc`).
No file in the repository was edited.
PoCs live in the copy at `a copy of contracts-near/src/tests/audit.rs` (run with `cargo test --lib tests::audit -- --test-threads=1`; the copy adds dev-deps `curve25519-dalek 4.1.3` and `sha2 0.10.9` only).

Baseline checks:

- `cargo test --lib`: 87 passed in the repo copy (the 8 `vectors` tests read `../packages/chain/vectors` and fail only when the crate is moved out of the repo, which is expected).
- `cargo clippy --all-targets`: clean.
  `-W clippy::pedantic`: 34 warnings in non-test code, all stylistic (`must_use`, `needless_pass_by_value` on `#[near]` entry points, wildcard imports, missing `# Panics` docs). None points at a defect.
- Rebuilding with `cargo near build non-reproducible-wasm --locked` from a different directory on the same machine reproduced the committed sha256 exactly.

Overall: the on-chain accounting is in good shape.
I found no way to move escrow or credit to the wrong account, no double payout, no unchecked arithmetic on a value path, no callback that can be called by anyone else, and no write the hub pays for.
The most serious defect is not in the Rust arithmetic but in the signature rule the hub enforces, which the off-chain side does not reproduce (F1, F2).

## 1. Findings

| ID | Severity | Where | What is wrong | Exploit or failure scenario | Recommended fix | Test that proves the fix | Status |
|---|---|---|---|---|---|---|---|
| F1 | High | `src/encoding.rs:247-249` (`verify_signature`), used by `src/lib.rs:813-816` (`verify_claim`); off-chain `packages/chain/src/crypto.ts` `verifyDigest`, used by `apps/node/src/vouchers.ts` `#signatureValid` | The hub verifies vouchers with `env::ed25519_verify`, which is ed25519-dalek `verify`: cofactorless, compares the recomputed R bytes. The node verifies the same vouchers with `@noble/curves` 2.4.0 `ed25519.verify`, which always uses the cofactored equation (`[8]([s]B) == [8](R + [k]A)`), with `zip215: true` by default and also with `zip215: false`. A signature whose R carries an 8-torsion component passes the node and fails the hub. | The owner controls the agent key. Its agent signs every voucher with R' = rB + T (T a torsion point) and s = r + k'a. The node accepts each call and signs an acceptance, the seller serves it, and then: `settle_batch` panics `BAD_SIGNATURE` for the whole batch (every other claim in it is delayed until the node bisects), and `settle_own` panics `BAD_SIGNATURE`. Because vouchers are cumulative, an agent that signs every voucher this way never pays any seller. The node's `NET_EXPOSURE` rule bounds the free service to the Budget's escrow per Budget, and the owner reclaims that escrow after the deadline. It breaks the core promise "escrow protects a seller for calls the node accepted". | The hub is locked, so the fix is off-chain: every verifier that decides on behalf of the hub (node voucher check, SDK acceptance check, wallet) must apply the hub's exact rule. Concretely: reject `s >= L`, decode A, compute `R' = [s]B - [k]A`, and require `R'.toBytes()` to equal the signature's first 32 bytes byte for byte (that is dalek's check). Also reject small-order A (see F3). Add the torsioned and non-canonical-R cases to `packages/chain/vectors` with `valid: false`, so the Rust vector test and the TS vector test both pin them. | `audit.rs::a1_torsioned_voucher_passes_cofactored_check_but_hub_rejects_it` already shows the hub side (`BAD_SIGNATURE` in both paths) and writes `a1-voucher.json`; `js/noble-check.mjs` prints `noble default verify: true, zip215:false: true` for it. The fix is proven when a TS test feeding that vector to `verifyDigest` (and to the node's voucher intake) gets `false` and the node refuses the call before it signs an acceptance. | CONFIRMED. FIXED off-chain: one hub-exact verifier (`verifyDigest`) in node, SDK and wallet, with shared vectors. Hub v2 keeps refusing torsioned signatures in both paths (regression test `audit.rs::a1`) |
| F2 | Medium | `src/lib.rs:785-788` (`verify_acceptance`); off-chain `packages/chain/src/digest.ts:201` | Same divergence on the acceptance. The seller SDK checks the node's acceptance with noble, so a node can hand out acceptances that the seller's SDK reports as valid and that `settle_own` refuses with `BAD_ACCEPTANCE`. | `settle_own` exists for a node that disappears or misbehaves. A node that signs every acceptance with a torsioned R keeps serving normally while silently removing every seller's escape hatch; when it then stops settling, no seller can settle. The node still cannot take funds, and owners reclaim after the deadline, so the loss is the sellers' unpaid service. | Same verifier fix as F1, applied in the SDK where it stores acceptances (`FileVoucherStore` and the receipt check). A seller SDK should refuse to treat a call as paid-for when the acceptance fails the hub rule. | `audit.rs::a1b_torsioned_acceptance_is_rejected_by_settle_own` (hub side, writes `a1b-acceptance.json`, noble returns `true`). Fix proof: SDK test that the stored-receipt check rejects that vector. | CONFIRMED. FIXED off-chain by the same verifier in the SDK. Hub v2 keeps refusing torsioned acceptances (regression test `audit.rs::a1b`) |
| F3 | Low | `src/lib.rs:139-149` (`open_budget` takes `agent_pk` unchecked), `src/lib.rs:545-556` (`register_receipt_key` takes any 32 bytes, no proof of possession) | Small-order public keys, including the all-zero key (an order-4 point), are accepted. With a small-order A, `[k]A` takes one of at most 8 values, so a signature with s = 0 and R a torsion point verifies for about one message in 8. | Anyone, with no secret, forges vouchers for a Budget whose `agent_pk` is small-order by varying `request_hash` until one of 8 candidates fits (PoC finds one within 256 tries), and the node (noble, `zip215: true`) accepts them too. A client bug that leaves the key zeroed turns a Budget into one anyone can spend up to its cap and escrow. The same holds for a settler that registers a small-order receipt key: any seller can then forge acceptances. Self-inflicted in both cases, which is why it is Low. | Off-chain now: the dashboard, SDK and node refuse a Budget or receipt key whose key is small-order or non-canonical (noble `Point.fromHex(pk).isSmallOrder()`, and canonical re-encoding equals input). Next hub: reject those keys in `open_budget` and `register_receipt_key` (`INVALID_BUDGET`, a new `INVALID_KEY`), and have `register_receipt_key` take a signature by the key over `(hub, network, settler)`. | `audit.rs::a2_small_order_agent_key_lets_anyone_forge_a_voucher` and `a2b_the_all_zero_public_key_...` pass today; after the fix `open_budget` with those keys must panic `INVALID_BUDGET`. | CONFIRMED. FIXED in hub v2: `open_budget` refuses small-order and non-canonical agent keys (`INVALID_BUDGET`), `register_receipt_key` and `set_checkout_key` such keys (`INVALID_KEY`) (`audit.rs::a2`, `a2b`, `a2c`). Proof of possession for receipt keys not added |
| F4 | Medium | `src/lib.rs:339-363` (`settle_batch` charges all new `settled`, `credits` and batch bytes to the settler), `src/lib.rs:876-890` (checkout payment records); `settled`, `payments` and batch records are never removed | The settler pays permanent storage for every new (Budget, payee) pair regardless of the amount, and no minimum amount exists. A `credits` entry for an account that can never receive the token is never released either, so its storage never comes back. | Measured in the PoC: 100 one-unit claims to 100 new 64-character payees cost the settler 0.31358 NEAR of storage for 100 base units of USDC (0.0001 USDC). Failed payouts return nothing. An owner plus a set of throwaway seller accounts can drain a settler's storage balance at roughly the cost of creating the accounts, after which every `settle_batch` of that settler fails with `INSUFFICIENT_STORAGE` until someone refunds it. Checkout payments of one base unit do the same to the checkout settler (about 150 bytes each, permanent). | Node now: a minimum amount for the first voucher to a new payee, a per-Budget cap on distinct new payees per window, and alerting on storage burn per Budget. Next hub: charge per-pair storage to the owner (extend the `open_budget` reserve idea to settlement, or let the settler bill the escrow at a fixed per-pair fee recorded in the Budget terms), and add `prune(budget_id, payees)` after `reclaim` that deletes `settled` entries and refunds the settler that paid. | `audit.rs::a5_one_unit_claims_to_new_payees_cost_the_settler_permanent_storage` (passes today). After a hub fix: same scenario, the settler's balance is unchanged net of fees and the owner's deposit pays. | CONFIRMED. FIXED in hub v2: the owner prepays 332 bytes per payee slot at `open_budget`, each Budget pays its own new pairs from that reserve (`INSUFFICIENT_RESERVE` when short), the settler pays only its batch record, and `prune` refunds freed and unused bytes after the deadline (`audit.rs::a5`). The node limits stay as defence in depth |
| F5 | Low | `src/lib.rs:185-192` (`revoke_budget` allowed after expiry), `src/lib.rs:912-918` (`settle_deadline`) | A revoke after `valid_until` still sets `revoked_at`, and the deadline becomes `min(valid_until + 3 days, revoked_at + 24 h)`. So the documented 3-day expiry grace is not a guarantee: the owner can cut it to about 24 h at will. | Budget expires; one millisecond later the owner revokes; 24 h + 1 ms later `settle_own` and `settle_batch` fail `BUDGET_CLOSED` and the owner reclaims, about two days before sellers expected. A seller that reads "3 days after expiry" in SECURITY.md and settles on day 2 loses accepted calls. The existing test `revoking_after_expiry_cannot_shorten_or_extend_past_the_earlier_deadline` encodes this behaviour. | Next hub: refuse `revoke_budget` once `now > valid_until` (`BUDGET_NOT_OPEN`), or compute the deadline as `max(valid_until + 3 d, ...)` for post-expiry revokes. Now: fix the docs to say sellers are guaranteed 24 h after a revoke, at any time, and nothing more; the SDK should settle within 24 h of seeing a revoke or an expiry. | `audit.rs::a3_revoke_after_expiry_cuts_the_expiry_grace_to_24_hours` passes today; after the fix the revoke panics and `settle_own` succeeds at expiry + 2 days. | CONFIRMED. FIXED in hub v2: `revoke_budget` after `valid_until` is refused with `BUDGET_NOT_OPEN` (`audit.rs::a3`) |
| F6 | Low | `src/lib.rs:95`, `src/lib.rs:291` (`batches` keyed by `batch_id` alone) | Batch ids are global. Any other allowlisted settler can take an id first. The README says guessing is impractical, but the id does not need guessing: it is in the pending transaction. | Settler B sees settler A's `settle_batch` (for example when A's transaction and the hub are on different shards, the receipt executes a block later) and submits a one-claim batch with the same id. A's batch fails `BATCH_EXISTS`, and any receipt A already issued that names that id now verifies, or fails, against B's root through `verify_receipt`. Needs a second admin-approved settler, so Low. | Next hub: key batches by `(settler, batch_id)`, or derive the stored id as `sha256(settler, batch_id)`, and include the settler in `verify_receipt`'s lookup. Now: the node should only issue receipts that name a batch id after the batch is final. | `audit.rs::a4_another_settler_can_squat_a_batch_id` passes today; after the fix both batches settle. | CONFIRMED. FIXED in hub v2: batches keyed by `(settler, batch_id)`, and `batch` and `verify_receipt` take the settler (`audit.rs::a4`) |
| F7 | Info | `src/lib.rs:817-818` | `claim.amount` is signed but never checked against the cumulative step. | A voucher that says "this call costs 1" while moving cumulative from 0 to 400 settles 400. Only the owner's own agent can sign it, so this matters only for a buggy agent or a node that trusts `amount`. | Document that `cumulative` is the only authority on chain; the node must check `cumulative == previous + amount` (it should already). Next hub: `require!(claim.amount.0 <= delta)` is the strongest rule that still allows skipped vouchers. | `audit.rs::a6_voucher_amount_is_not_bound_to_the_cumulative_delta`. | CONFIRMED. FIXED in hub v2: `AMOUNT_ABOVE_STEP` when `amount` exceeds the cumulative step (`audit.rs::a6`) |
| F8 | Info | `out/hub.wasm` | The committed wasm embeds 17 absolute paths of the form `/Users/<builder>/.cargo/registry/src/index.crates.io-.../` (panic locations from borsh, serde_json, near-sdk, wee_alloc and others). The code hash therefore depends on the builder's home directory, and the builder's OS user name is published on chain. | Anyone trying to reproduce `CMKbhRxT...` on another machine gets a different hash, so the "pinned toolchain" reproducibility claim holds only on the original machine (I reproduced it there, from a different project directory). | Use the NEP-330 Docker build (`cargo near build reproducible-wasm`), whose paths are fixed, or add `--remap-path-prefix=$HOME/.cargo/registry/src=/cargo` in `.cargo/config.toml` for the wasm target. Also fix the `reproducible_build.image` in Cargo.toml, which names cargo-near 0.22.0 while the build used 0.23.0. | `strings -n 6 out/hub.wasm | grep -c '^/Users/'` returns 0, and a build on a second machine matches the hash. | CONFIRMED. FIXED: `contracts-near/build.sh` remaps `$CARGO_HOME`, so the wasm holds no home path, a rebuild from another directory gives the same hash, and `Cargo.toml` names cargo-near 0.23.0. Not yet compared on a second machine |

Status update, 2026-11-10: hub v2 (`contracts-near/out/hub.wasm` sha256 `cf978c32...bcd3f`, code hash `EyMRXoHdTQHLadE1dJzcGC5jY5XwmWsEdaeVeV9fHDmx`) fixes F3 to F8 on chain; F1 and F2 are fixed off-chain.
Each proof of concept above is ported to `contracts-near/src/tests/audit.rs` and asserts the fixed behaviour; the tests for F3 to F7 fail against hub v1.
Of the hardening items in section 2, hub v2 does 6, 7, 9, 12, 13, 14 and 15, does 8 without proof of possession, does 10 through `prune` (batch records are kept), and does the settler half of 11; binding the acceptance text to hub and network is not done, because the Budget id already commits both.
Status update, 2026-11-11: an independent pre-audit of hub v2 ([2026-11-11-hub-v2-pre-audit.md](2026-11-11-hub-v2-pre-audit.md)) led to a fix round (code hash `H8NHZwWQPwgdYCku8kUR7AqcnbvY28BQGaRU5LhuARFN`), in which F4's checkout half is now bounded too: the checkout settler must accept the role itself, and the hub refunds checkout payments below a minimum of 10,000 base units.
The findings below are unchanged from the review.

### Items checked and found correct

These were on the checklist; I looked for a defect and did not find one.

- Callbacks: `on_payout` and `on_reclaim` are `#[private]`, never panic (saturating math, `is_promise_success` only fails on a wrong result count, which only a direct call could cause, and only the hub can call). Amounts are moved to `in_flight` before the promise and restored on failure. `payout` keeps the entry so a restore never needs new storage. Two overlapping payouts of one account are safe in either order (existing test).
- Promises use near-sdk's default unused-gas weight of 1 (`near-sdk-core 4.4.2 GasWeight::default()`), so the static 15 Tgas for `ft_transfer` and 8 Tgas for the callback are floors, not caps. A token whose `ft_transfer` needs more than 15 Tgas can still be paid out by attaching more gas to a payout of fewer accounts. The hard-coded gas in a locked hub is therefore not a stuck-funds risk.
- A payout to an account not registered at the token fails, the callback restores the credit and the entry, and the 1 yoctoNEAR deposit is refunded to the hub. Anyone may retry later.
- `ft_on_transfer` checks `predecessor == token`, ignores `sender_id` for anything but matching the owner or recording the payer, returns the full amount on every refusal, and a panic (only `INSUFFICIENT_STORAGE` on the payment path) is resolved as a full refund by NEP-141.
- Netting: `entries()` omits zero accounts and is compared exactly; the sum of debits equals the sum of credits, so `total_escrow - net + net` holds. Self-pay nets to zero and counts toward `spent` only (documented). Duplicate claims for one pair must strictly increase cumulative. `ONE_BUDGET_PER_OWNER` closes the "debit checked against the wrong Budget" hole. A debit entry can only belong to an owner present in `owners`, so the `env::abort()` at `lib.rs:331` is unreachable.
- `settle_batch` vs `settle_own` races cannot double count (existing tests); `reclaim` needs `now > deadline` and both settlement paths need `now <= deadline`.
- Arithmetic on value paths uses `add`/`sub` that panic with `OVERFLOW`, and the release profile has `overflow-checks = true`. `add_credit` saturates instead of checking (`lib.rs:731`) while `total_credits` is checked, so they could only diverge above about 3.4e38 base units, which the token supply cannot reach.
- Storage: every growing write is charged (open_budget, settle_batch, settle_own, checkout, register_receipt_key, set_settler, set_checkout_key including the root record, fund_storage). Writes that do not grow (revoke, escrow and credit updates, in-flight) are fixed width. I found no path where the hub pays.
- Voucher domain separation: tag above 2^31, text domain with a version, hub id, network, Budget id (itself bound to hub, network and owner), payee, amount, cumulative, request hash. The acceptance text has no hub or network, but it is bound through the Budget id. Replay across Budgets, hubs and networks is not possible. Signature malleability in the `s` half is rejected by both libraries; replay protection never depends on signature bytes.
- Authorization: see the matrix in section 3. Every method that moves value to someone other than its own caller (`payout`) sends only to the creditor.
- Panics revert the whole receipt, and every refund promise is created after the last check.

## 2. Hardening items that are not bugs

Worth doing off-chain now (they need no new hub):

1. One shared signature rule (F1 to F3) implemented once in `packages/chain` and used by node, SDK, wallet and dashboard, with vectors that include torsioned R, non-canonical R, non-canonical A, small-order A and `s >= L`.
2. The node's batch builder should pre-verify every claim with the hub rule before submitting, so one bad claim never fails a 100-claim batch.
3. SECURITY.md and README: state that the guaranteed seller window is 24 h after a revoke, which the owner can trigger at any time, including just after expiry (F5); state that batch ids can be taken by another settler (F6).
4. Node policy against storage drain (F4): minimum first-voucher amount per new payee, cap on new payees per Budget per hour, and a storage-burn alert per Budget.
5. Build: Docker reproducible build or `--remap-path-prefix` (F8); drop wee_alloc (section 4).

Worth doing in the next hub (each needs a redeploy, because the current one cannot change):

6. NEP-297 events (`EVENT_JSON:{"standard":"payminto","version":"1.0.0","event":...}`) for every state change: `budget_opened`, `budget_funded`, `credit_moved_to_escrow`, `budget_revoked`, `reclaim_started`, `reclaim_finished`, `batch_settled` (with batch id, root, gross, net), `claim_settled_by_payee`, `payout_started`, `payout_finished`, `payment_received`, `settler_set`, `checkout_key_set`, `receipt_key_registered`, `storage_funded`, `storage_withdrawn`. Today the hub logs nothing, so an indexer must poll views.
7. Every panic as a code from `errors.rs`. `require_admin` panics with a literal string (`lib.rs:655-658`), `assert_one_yocto` with near-sdk's message, and `encoding.rs` uses `.expect("borsh")`; the node cannot map these.
8. Reject small-order and non-canonical keys in `open_budget` and `register_receipt_key`, with proof of possession for receipt keys.
9. Refuse `fund_storage` for the hub and token accounts (the NEAR is stranded, since neither can call `withdraw_storage`).
10. Return the unused `settle_own` reserve to the owner at `reclaim`, and add `prune` for `settled` entries and batch records after a Budget's deadline, refunding the settler that paid.
11. Key batches by settler (F6), and bind the acceptance text to hub and network explicitly rather than through the Budget id.
12. An explicit `allow_any_payee: bool` in `BudgetTerms` instead of "empty list means any".
13. `Budget.reserved_settle_own_bytes` is a bare `u64` in JSON while every other number is a string; use `U64` for consistency.
14. A rotatable admin (two-step transfer) or an admin that is a DAO. Today a lost admin key means no new settlers and no new checkout key, forever.
15. Measure worst-case `settle_batch` gas with 100 distinct Budgets, each with 16 payees of 64 characters, and 64-character payees; the published profile uses empty payee lists.

## 3. Modularity and authorization proposal

### Authorization today

| Method | Caller check | Deposit | Callable with a function-call key | Moves value to |
|---|---|---|---|---|
| `new` | `#[init] #[private]` | none | hub only | nothing |
| `open_budget` | anyone (becomes owner) | storage, refund excess | no (deposit) | refund to caller |
| `revoke_budget` | owner | none | yes | nothing |
| `reclaim` | owner, after deadline | none | yes | owner |
| `fund_from_credit` | owner | exactly 1 yocto | no | escrow (internal) |
| `ft_on_transfer` | token | none | n/a | escrow or merchant credit |
| `settle_batch` | allowlisted settler named by each Budget | none | yes (intended) | payee credits |
| `settle_own` | the payee | optional storage | yes when the reserve covers storage | caller's credit |
| `payout` | anyone | none | yes | each creditor |
| `on_payout`, `on_reclaim` | `#[private]` | none | hub only (no keys after lock) | nothing |
| `set_settler`, `set_checkout_key` | admin | at least 1 yocto, storage | no | refund to admin |
| `fund_storage` | anyone | the amount | no | storage balance |
| `withdraw_storage` | the balance holder | exactly 1 yocto | no | caller |
| `register_receipt_key` | allowlisted settler | exactly 1 yocto | no | nothing |

What the settler's function-call key reaches: `settle_batch` and `payout` only.
It cannot withdraw storage or register keys.
It can, however, settle any agent-signed voucher the node holds, including vouchers the node refused (post-revoke, blocked payee, over exposure), because `settle_batch` checks no acceptance: a leaked settlement key equals a settler that has dropped its policy engine.
That is inside the documented trust in the settler, but the node should keep refused vouchers out of the process that holds that key.

Things that change behaviour and need no 1 yocto: `revoke_budget` and `reclaim` (owner function-call keys can call them; harmless because value goes to the owner, but a leaked owner function-call key can revoke every Budget).

### Proposed role model

Roles, each with exactly one guard function that every entry point calls first, and that returns a typed proof value so the body cannot forget it:

- `Admin` (config owner): `fn require_admin(&self) -> AdminCtx` asserts predecessor and `attached >= 1 yocto`.
- `Owner(budget_id)`: `fn require_owner(&self, id) -> (OwnerCtx, Budget)`; variants `require_owner_full_key` that also asserts exactly 1 yocto for value-moving calls (`fund_from_credit`; propose adding it to `revoke_budget` too, since revocation is irreversible).
- `Settler`: `fn require_settler(&self) -> SettlerCtx` (allowlist), plus `SettlerCtx::require_names(&Budget)`; `require_settler_full_key` for `register_receipt_key` and `withdraw_storage`.
- `Payee(claim)`: `fn require_payee(&self, claim) -> PayeeCtx` (predecessor == payee, payee != owner, not reserved).
- `Token`: `fn require_token(&self) -> Option<TokenCtx>` returning `None` (refund) rather than panicking.
- `SelfCallback`: `#[private]` stays; add a debug assertion that `promise_results_count() == 1` before any read.
- `Anyone`: explicitly marked (`payout`, `fund_storage`, views) so a reviewer sees that the absence of a guard is a decision.

A table like the one above, generated from these guards (a unit test that iterates every method and asserts the expected panic for each wrong caller), replaces prose as the source of truth.

### Proposed module split

```
src/
  lib.rs          Hub struct, StorageKey, #[near] impl that only dispatches to the modules
  auth.rs         the role guards above and their ctx types
  budgets.rs      open_budget, revoke_budget, reclaim (+ on_reclaim), fund_from_credit, accept_deposit
  settlement.rs   settle_batch, settle_own, verify_claim, verify_acceptance (uses netting.rs)
  payouts.rs      payout, on_payout, credit entries (add_credit, release_credit_if_empty)
  storage.rs      storage_mark/growth, charge_storage_balance, fund_storage, withdraw_storage, refund
  checkout.rs     accept_payment, set_checkout_key
  admin.rs        set_settler, register_receipt_key
  views.rs        every read-only method
  events.rs       NEP-297 event types and emit()
  crypto.rs       verify_signature plus key validation (small order, canonical), split out of encoding.rs
  encoding.rs     digests and Merkle only
  netting.rs, types.rs, errors.rs  unchanged
```

`near-sdk` 5 allows several `#[near] impl Hub` blocks across files, so the public ABI stays identical and the wasm should change only by code layout.
The value is that each file owns one invariant: `storage.rs` owns "the hub never pays", `payouts.rs` owns "credit + in_flight is conserved", `settlement.rs` owns "escrow only falls by a verified net debit".

### What to do in the next four days versus after the hackathon

The hub on testnet is locked, so any contract change means a new hub, new code hash, new deploy and new vectors.

Next four days (no new hub needed, or a cheap one):

1. F1 and F2: shared hub-exact verifier in `packages/chain` plus vectors, used by node intake, SDK acceptance check and wallet. This is the only finding with a direct loss to sellers.
2. F3 off-chain: refuse small-order or non-canonical keys in dashboard, SDK and node.
3. F5 and F6 doc corrections, and the node rule "never name a batch id in a receipt before the batch is final".
4. F4 node policy: minimum first-voucher amount and new-payee rate limit.
5. If a new hub is deployed anyway for the demo: drop wee_alloc and fix the path leak (F8) in the same build, so the new code hash is reproducible on any machine.

After the hackathon (one new hub that collects them):

6. Module split and role guards with the generated authorization test.
7. NEP-297 events.
8. Contract-side key validation, `revoke` after expiry refused, batches keyed by settler, prune and reserve refund, owner-paid per-pair storage, panic codes everywhere, `allow_any_payee` flag.
9. An external audit of that hub, not of the current one.

## 4. wee_alloc

- Is it in `hub.wasm`? Yes.
  near-sdk 5.30.1 has `default = ["wee_alloc"]`, and `src/lib.rs:1662-1664` of near-sdk installs `#[global_allocator] static ALLOC: wee_alloc::WeeAlloc` when `feature = "wee_alloc"` and `target_arch = "wasm32"`.
  `cargo tree --target wasm32-unknown-unknown -i wee_alloc` shows it reached through `payminto-hub -> near-sdk feature "default"`, and `out/hub.wasm` contains the panic-location strings of `wee_alloc-0.4.5/src/lib.rs` and `imp_wasm32.rs`.
- Real risk in a NEAR contract: low.
  RUSTSEC-2022-0054 is an "unmaintained" advisory, not a memory-safety CVE.
  The known wee_alloc problems are unbounded memory growth and fragmentation for some allocation patterns.
  In NEAR every function call runs in a fresh wasm instance whose memory is discarded at the end, so a leak cannot accumulate across calls, and the worst outcome inside one call is running out of memory, which aborts and reverts that receipt.
  The hub's allocations are small and bounded (at most 100 claims, 16 payees, 10 payout accounts), so a call-level OOM is not plausible.
  The residual cost is supply-chain and audit friction: an unmaintained crate inside the trusted code, a Dependabot alert that will not clear, and an auditor's question every time.
- What replacing it takes: in `Cargo.toml`
  `near-sdk = { version = "5.30.1", default-features = false }` and, for consistency, `near-sdk = { version = "5.30.1", default-features = false, features = ["unit-testing"] }` in dev-dependencies.
  No other feature needs to be kept, because `default` contains only `wee_alloc`.
  Rust's standard allocator for `wasm32-unknown-unknown` (dlmalloc) then takes over with no code change.
  `mock_ft` keeps wee_alloc unless it gets the same change; it is test-only, but Dependabot will keep flagging `Cargo.lock` until it does.
- Effect on the artifact (built in `the reviewer's scratch folder/audit-nowee` with the same toolchain and `--locked`):

| | wasm size | sha256 | NEAR code hash |
|---|---|---|---|
| Committed / rebuilt baseline | 289,790 bytes | `a8a5339259dfb01b48b2d04b319aa357aead63f3e47e7a69855fed095a152c37` | `CMKbhRxTnjQsgFZpDPsEqTz55h6iDvxy8qYXpAhJUtqc` |
| `default-features = false` | 296,411 bytes (+6,621) | `6baa5c8212f2543e83a0988136f11a5428d9ab40d84753bdc0ad83af03688cab` | `8FHHwfJ9BXwmLEavEmR6XW4sr3eS7DTyZqXJR6dXKys8` |

  The extra 6.6 kB costs the hub account about 0.066 NEAR more storage stake.
  Because the deployed hub is locked, the change only applies to a new hub: `out/hub.wasm`, the sha256 and code hash in `contracts-near/README.md`, the deploy script's code-hash check, any vectors or docs that quote the hash, and the gas profile (dlmalloc has a different per-allocation cost; re-run `tests/gas_profile.rs`) all have to be updated together.
  The existing testnet hub keeps wee_alloc for its lifetime.
  I did not run the unit or sandbox suites against the no-wee_alloc wasm.

## 5. What I did not check

- The sandbox suites (`tests/sandbox.rs`, `tests/gas_profile.rs`) and the TS sandbox suite were not run; I relied on the unit tests and on the published gas profile.
  The PoCs use the mocked runtime, which calls the same `near-vm-runner` 0.38.0 host implementation of `ed25519_verify` (`ed25519_dalek::VerifyingKey::verify`); I did not replay F1 against a live `near-sandbox` node.
- The real Circle USDC contract on NEAR (pause, blacklist, gas use of `ft_transfer`). If the hub account is ever blacklisted, every payout and reclaim fails and restores forever; nothing in the hub can route around that.
- Node, SDK, wallet and dashboard code beyond the signature call sites named in F1 to F3 (exposure rule, refusal handling, batch bisection on failure, whether the node pre-checks claims before `settle_batch`).
- `packages/chain/scripts/deploy-hub.ts` beyond the README's description, including whether a client refuses a hub whose account still has access keys during the deploy window, when `#[private]` callbacks are still callable by the hub's own key.
- Worst-case gas for `settle_batch` with long payee lists and long account ids (hardening item 15).
- Formal review of the Merkle construction beyond the domain prefixes and depth limit, and of the TS-side Merkle builder.
- Economic behaviour of netting across many owners over time (for example that netting turns a net-creditor owner's withdrawable credit into escrow locked until its Budget's deadline); noted, not analysed.
