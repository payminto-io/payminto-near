//! The Payminto clearing hub.
//!
//! The hub escrows a NEP-141 token for Budget owners, settles batches of agent vouchers with on-chain signature
//! checks and account-level netting, and holds net credits until they are paid out.
//! It has no upgrade method, no admin path to funds, and no key-based assumption about Budget owners.
//!
//! Storage is never paid by the hub account: every method that grows state measures the growth with
//! `env::storage_usage()` and charges the caller's deposit, the Budget's prepaid reserve or a settler's prepaid
//! storage balance for exactly that many bytes.

pub mod encoding;
pub mod errors;
pub mod netting;
pub mod types;

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;

use near_sdk::borsh;
use near_sdk::json_types::{U64, U128};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, ext_contract, near,
    require,
};

use crate::encoding::*;
use crate::errors::*;
use crate::netting::Netting;
use crate::types::*;

pub const MAX_CLAIMS: usize = 100;
pub const MAX_PAYEES: usize = 16;
pub const MAX_PAYOUT_ACCOUNTS: usize = 10;

/// Receipt keys one settler can register. Keys are append-only, so the cap bounds what a settler can make the hub
/// store and what a seller has to look through.
pub const MAX_RECEIPT_KEYS: usize = 4;

/// Settlement stays open this long after a revoke, so payees can claim calls already served.
pub const REVOKE_GRACE_MS: u64 = 86_400_000;
/// Settlement stays open this long after a Budget expires.
pub const EXPIRY_GRACE_MS: u64 = 3 * 86_400_000;

/// Storage the owner prepays at `open_budget` for `settle_own` claims: room for about 16 new `settled` and
/// `credits` pairs. `settle_own` draws the bytes it really writes from it before charging the payee.
pub const RESERVED_SETTLE_OWN_BYTES: u64 = 16 * 300;
/// `revoke_budget` turns `revoked_at` from `None` into `Some(u64)`, which grows the record by this much.
/// The owner pays for it at `open_budget`, so a revoke never needs a deposit.
pub const REVOKE_BYTES: u64 = 8;

/// Static gas for one `ft_transfer`. A transfer that runs out fails safely: the callback restores the amount.
const FT_TRANSFER_GAS: u64 = Gas::from_tgas(15).as_gas();
/// Static gas for one callback. A callback must never run out, so this is several times what it burns.
const CALLBACK_GAS: u64 = Gas::from_tgas(8).as_gas();
/// Gas the hub call itself spends per paid account: the fees for creating the two receipts, and its own work.
const PROMISE_GAS: u64 = Gas::from_tgas(3).as_gas();
/// Everything one paid account needs from the gas attached to `payout`.
pub const PAYOUT_ACCOUNT_GAS: u64 = FT_TRANSFER_GAS + CALLBACK_GAS + PROMISE_GAS;
/// What `payout` and `reclaim` need on top, for loading the contract and their own bookkeeping.
pub const BASE_GAS: u64 = Gas::from_tgas(10).as_gas();

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Settlers,
    Budgets,
    Settled,
    Credits,
    Batches,
    Payments,
    ReceiptKeys,
    StorageBalances,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hub {
    admin: AccountId,
    token: AccountId,
    network: String,
    settlers: LookupSet<AccountId>,
    checkout: Option<Checkout>,
    budgets: LookupMap<Id32, Budget>,
    settled: LookupMap<(Id32, AccountId), u128>,
    credits: LookupMap<AccountId, Credit>,
    batches: LookupMap<Id32, BatchRecord>,
    payments: LookupMap<Id32, PaymentRecord>,
    /// The keys each settler signs acceptances with. Append-only, at most `MAX_RECEIPT_KEYS` per settler.
    receipt_keys: LookupMap<AccountId, Vec<Id32>>,
    /// NEAR prepaid per account for the storage its settlements write. Entries are never removed.
    storage_balances: LookupMap<AccountId, u128>,
    total_escrow: u128,
    total_credits: u128,
    in_flight: u128,
}

#[near]
impl Hub {
    /// Deployment parameters are immutable, and `admin` must be separate from the hub account.
    #[init]
    #[private]
    pub fn new(admin: AccountId, token: AccountId, network: String) -> Self {
        require!(admin != env::current_account_id(), ADMIN_IS_HUB);
        Self {
            admin,
            token,
            network,
            settlers: LookupSet::new(StorageKey::Settlers),
            checkout: None,
            budgets: LookupMap::new(StorageKey::Budgets),
            settled: LookupMap::new(StorageKey::Settled),
            credits: LookupMap::new(StorageKey::Credits),
            batches: LookupMap::new(StorageKey::Batches),
            payments: LookupMap::new(StorageKey::Payments),
            receipt_keys: LookupMap::new(StorageKey::ReceiptKeys),
            storage_balances: LookupMap::new(StorageKey::StorageBalances),
            total_escrow: 0,
            total_credits: 0,
            in_flight: 0,
        }
    }

    // ---- Budget owner ----

    /// Opens a Budget owned by the predecessor, which may be any account or contract.
    /// `cap` is authority over gross spending and is set only here; deposits raise only escrow.
    /// The attached deposit covers the record, the bytes a later revoke adds, and the storage reserved for
    /// `settle_own`, and the excess is refunded.
    #[payable]
    pub fn open_budget(&mut self, terms: BudgetTerms) -> Id32 {
        let mut terms = terms;
        let owner = env::predecessor_account_id();
        let now = now_ms();
        require!(
            terms.cap.0 > 0 && terms.valid_until.0 > now && terms.valid_until.0 <= u64::MAX - EXPIRY_GRACE_MS,
            INVALID_BUDGET
        );
        terms.payees = canonicalize_payees(terms.payees);
        require!(terms.payees.len() <= MAX_PAYEES, INVALID_BUDGET);
        require!(!terms.payees.iter().any(|p| self.is_reserved(p)), INVALID_BUDGET);

        let id = budget_id(
            env::current_account_id().as_str(),
            &self.network,
            owner.as_str(),
            &terms,
        );
        require!(!self.budgets.contains_key(&id), BUDGET_EXISTS);

        let before = self.storage_mark();
        self.budgets.insert(
            id,
            Budget {
                owner: owner.clone(),
                settler: terms.settler,
                agent_pk: terms.agent_pk,
                cap: terms.cap,
                spent: U128(0),
                escrow: U128(0),
                valid_until: terms.valid_until,
                revoked_at: None,
                payees: terms.payees,
                policy_hash: terms.policy_hash,
                reserved_settle_own_bytes: RESERVED_SETTLE_OWN_BYTES,
            },
        );
        let used = self.storage_growth(before);
        let cost = storage_cost(used + REVOKE_BYTES + RESERVED_SETTLE_OWN_BYTES);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, INSUFFICIENT_DEPOSIT);
        refund(&owner, deposit - cost);
        id
    }

    /// Starts the settlement grace period. Agents cannot call this; the node stops accepting their vouchers on request.
    pub fn revoke_budget(&mut self, budget_id: Id32) {
        let owner = env::predecessor_account_id();
        let mut budget = self.load_budget(&budget_id);
        require!(budget.owner == owner, NOT_OWNER);
        require!(budget.revoked_at.is_none(), ALREADY_REVOKED);
        budget.revoked_at = Some(U64(now_ms()));
        self.budgets.insert(budget_id, budget);
    }

    /// Returns the remaining escrow after the settlement deadline.
    /// Escrow is zeroed before the promise, and a private callback restores it if the transfer fails.
    pub fn reclaim(&mut self, budget_id: Id32) {
        let owner = env::predecessor_account_id();
        let mut budget = self.load_budget(&budget_id);
        require!(budget.owner == owner, NOT_OWNER);
        require!(now_ms() > settle_deadline(&budget), TOO_EARLY);

        let amount = budget.escrow.0;
        if amount == 0 {
            return;
        }
        require_gas(PAYOUT_ACCOUNT_GAS + BASE_GAS);
        budget.escrow = U128(0);
        self.budgets.insert(budget_id, budget);
        self.total_escrow = sub(self.total_escrow, amount);
        self.in_flight = add(self.in_flight, amount);
        self.transfer_with_callback(
            owner,
            amount,
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_gas(CALLBACK_GAS))
                .on_reclaim(budget_id, U128(amount)),
        );
    }

    /// Moves the caller's own hub credit into the escrow of one of the caller's open Budgets.
    /// It raises escrow only, never cap, and changes no token balance, so `total_escrow + total_credits` is unchanged.
    /// Settlement never draws credit by itself, because `payout` is open to anyone and could empty it under a pending batch.
    /// Exactly one yoctoNEAR is required, so a function-call key cannot turn withdrawable credit into agent spending power.
    #[payable]
    pub fn fund_from_credit(&mut self, budget_id: Id32, amount: U128) {
        assert_one_yocto();
        let owner = env::predecessor_account_id();
        require!(amount.0 > 0, ZERO_AMOUNT);
        let mut budget = self.load_budget(&budget_id);
        require!(budget.owner == owner, NOT_OWNER);
        require!(
            budget.revoked_at.is_none() && now_ms() <= budget.valid_until.0,
            BUDGET_NOT_OPEN
        );
        let credit = self.credit_amount(&owner);
        require!(credit >= amount.0, INSUFFICIENT_CREDIT);

        budget.escrow = U128(add(budget.escrow.0, amount.0));
        let total_escrow = add(self.total_escrow, amount.0);
        if let Some(entry) = self.credits.get_mut(&owner) {
            entry.amount = credit - amount.0;
        }
        self.release_credit_if_empty(&owner);
        self.budgets.insert(budget_id, budget);
        self.total_credits = sub(self.total_credits, amount.0);
        self.total_escrow = total_escrow;
    }

    // ---- Token receiver ----

    /// Accepts deposits to a Budget and signed checkout payments, and returns the full amount on anything else.
    /// A payment whose storage the checkout settler's balance cannot cover panics with `INSUFFICIENT_STORAGE`, which
    /// NEP-141 resolves as a full refund to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if env::predecessor_account_id() != self.token || amount.0 == 0 {
            return amount;
        }
        let Ok(parsed) = near_sdk::serde_json::from_str::<TransferMsg>(&msg) else {
            return amount;
        };
        let accepted = match parsed {
            TransferMsg::Budget { budget_id } => self.accept_deposit(budget_id, &sender_id, amount.0),
            TransferMsg::Payment {
                payment_id,
                merchant,
                amount: terms_amount,
                expiry_ms,
                signature,
            } => self.accept_payment(
                payment_id,
                merchant,
                terms_amount.0,
                expiry_ms.0,
                signature,
                &sender_id,
                amount.0,
            ),
        };
        if accepted { U128(0) } else { amount }
    }

    // ---- Settlement ----

    /// Settles a batch atomically: every check runs before any state changes.
    /// Each claim is the latest voucher for its `(budget, payee)` pair, and `expected_net` is asserted against the
    /// recomputed netting of account-level obligations.
    /// The storage the batch writes is charged to the settler's prepaid storage balance, never to the hub.
    pub fn settle_batch(&mut self, batch_id: Id32, root: Id32, claims: Vec<Claim>, expected_net: Vec<NetEntry>) {
        let settler = env::predecessor_account_id();
        require!(self.settlers.contains(&settler), NOT_SETTLER);
        require!(!self.batches.contains_key(&batch_id), BATCH_EXISTS);
        require!(claims.len() <= MAX_CLAIMS, TOO_MANY_CLAIMS);

        let now = now_ms();
        let mut budgets: BTreeMap<Id32, Budget> = BTreeMap::new();
        let mut owners: BTreeMap<AccountId, Id32> = BTreeMap::new();
        let mut settled: BTreeMap<(Id32, AccountId), u128> = BTreeMap::new();
        let mut netting = Netting::default();
        let mut gross = 0u128;

        for claim in &claims {
            let budget = match budgets.entry(claim.budget_id) {
                Entry::Occupied(entry) => entry.into_mut(),
                Entry::Vacant(slot) => {
                    let budget = self.load_budget(&claim.budget_id);
                    require!(budget.settler == settler, NOT_BUDGET_SETTLER);
                    let prior = owners.insert(budget.owner.clone(), claim.budget_id);
                    require!(prior.is_none(), ONE_BUDGET_PER_OWNER);
                    require!(now <= settle_deadline(&budget), BUDGET_CLOSED);
                    slot.insert(budget)
                }
            };

            let key = (claim.budget_id, claim.payee.clone());
            let prior = settled.get(&key).copied().unwrap_or_else(|| self.settled_amount(&key));
            let delta = self.verify_claim(budget, claim, prior);
            budget.spent = U128(add(budget.spent.0, delta));
            require!(budget.spent.0 <= budget.cap.0, CAP_EXCEEDED);
            settled.insert(key, claim.cumulative.0);
            netting.record(&budget.owner, &claim.payee, delta);
            gross = add(gross, delta);
        }
        require!(gross > 0, ZERO_GROSS);

        let entries = netting.entries();
        require!(entries == expected_net, NET_MISMATCH);

        let mut net = 0u128;
        for entry in &entries {
            if entry.debit.0 > 0 {
                let id = owners.get(&entry.account).unwrap_or_else(|| env::abort());
                let budget = budgets.get_mut(id).unwrap_or_else(|| env::abort());
                require!(budget.escrow.0 >= entry.debit.0, INSUFFICIENT_ESCROW);
                budget.escrow = U128(budget.escrow.0 - entry.debit.0);
                net = add(net, entry.debit.0);
            }
        }

        let before = self.storage_mark();
        for (key, value) in settled {
            self.settled.insert(key, value);
        }
        for (id, budget) in budgets {
            self.budgets.insert(id, budget);
        }
        for entry in &entries {
            if entry.credit.0 > 0 {
                self.add_credit(&entry.account, entry.credit.0, Some(&settler));
            }
        }
        self.total_escrow = sub(self.total_escrow, net);
        self.total_credits = add(self.total_credits, net);
        self.batches.insert(
            batch_id,
            BatchRecord {
                root,
                settler: settler.clone(),
                gross: U128(gross),
                net: U128(net),
                at: U64(now),
            },
        );
        self.charge_storage_balance(&settler, before);
    }

    /// The escape hatch: a payee settles its latest voucher with no settler and no offset.
    /// The claim needs the node's acceptance of that exact call, signed by a receipt key the Budget's settler
    /// registered, and accepted no later than the Budget's revoke or expiry. Without it an owner, who chooses the
    /// agent key, could sign vouchers to itself and empty the escrow ahead of the sellers the node accepted calls for.
    /// The owner is refused as payee here for the same reason.
    /// New storage is drawn from the bytes the owner prepaid at `open_budget`, then from the attached deposit.
    #[payable]
    pub fn settle_own(&mut self, claim: Claim, acceptance: Acceptance) {
        let payee = env::predecessor_account_id();
        require!(claim.payee == payee, NOT_PAYEE);
        let mut budget = self.load_budget(&claim.budget_id);
        require!(payee != budget.owner, PAYEE_IS_OWNER);
        require!(now_ms() <= settle_deadline(&budget), BUDGET_CLOSED);

        let key = (claim.budget_id, claim.payee.clone());
        let prior = self.settled_amount(&key);
        let delta = self.verify_claim(&budget, &claim, prior);
        self.verify_acceptance(&budget, &claim, &acceptance);
        budget.spent = U128(add(budget.spent.0, delta));
        require!(budget.spent.0 <= budget.cap.0, CAP_EXCEEDED);
        require!(budget.escrow.0 >= delta, INSUFFICIENT_ESCROW);
        budget.escrow = U128(budget.escrow.0 - delta);

        let before = self.storage_mark();
        self.settled.insert(key, claim.cumulative.0);
        self.add_credit(&payee, delta, None);
        let grown = self.storage_growth(before);
        let from_reserve = grown.min(budget.reserved_settle_own_bytes);
        budget.reserved_settle_own_bytes -= from_reserve;
        let charged = storage_cost(grown - from_reserve);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= charged, INSUFFICIENT_DEPOSIT);

        // The Budget record has a fixed width, so writing it back never grows storage.
        self.budgets.insert(claim.budget_id, budget);
        self.total_escrow = sub(self.total_escrow, delta);
        self.total_credits = add(self.total_credits, delta);
        refund(&payee, deposit - charged);
    }

    // ---- Payout ----

    /// Pays credits out to the accounts, at most ten per call. Anyone can call it, and funds go only to the creditor.
    /// Credit is moved to the entry's `in_flight` before the promise, and a private callback confirms or restores it.
    pub fn payout(&mut self, accounts: Vec<AccountId>) {
        require!(accounts.len() <= MAX_PAYOUT_ACCOUNTS, TOO_MANY_ACCOUNTS);
        require_gas(PAYOUT_ACCOUNT_GAS * accounts.len() as u64 + BASE_GAS);
        for account in accounts {
            let Some(entry) = self.credits.get_mut(&account) else {
                continue;
            };
            let amount = entry.amount;
            if amount == 0 {
                continue;
            }
            // The entry stays, with the amount in flight, so the callback can never need new storage to restore.
            entry.amount = 0;
            entry.in_flight = add(entry.in_flight, amount);
            self.total_credits = sub(self.total_credits, amount);
            self.in_flight = add(self.in_flight, amount);
            let callback = Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_gas(CALLBACK_GAS))
                .on_payout(account.clone(), U128(amount));
            self.transfer_with_callback(account, amount, callback);
        }
    }

    /// Settles a payout outcome. It never panics, so a failed transfer always restores the credit.
    /// Once an entry holds no credit and nothing in flight it is removed, and the storage it frees goes back to the
    /// storage balance of the settler that paid for it.
    #[private]
    pub fn on_payout(&mut self, account: AccountId, amount: U128) {
        let restore = !near_sdk::is_promise_success();
        self.in_flight = self.in_flight.saturating_sub(amount.0);
        if restore {
            self.total_credits = self.total_credits.saturating_add(amount.0);
        }
        match self.credits.get_mut(&account) {
            Some(entry) => {
                entry.in_flight = entry.in_flight.saturating_sub(amount.0);
                if restore {
                    entry.amount = entry.amount.saturating_add(amount.0);
                }
            }
            // Unreachable, because an entry with an amount in flight is never removed. Restoring is still right.
            None if restore => {
                self.credits.insert(
                    account.clone(),
                    Credit {
                        amount: amount.0,
                        in_flight: 0,
                        funder: None,
                    },
                );
            }
            None => {}
        }
        self.release_credit_if_empty(&account);
    }

    /// Settles a reclaim outcome. It never panics, so a failed transfer always restores the escrow.
    #[private]
    pub fn on_reclaim(&mut self, budget_id: Id32, amount: U128) {
        self.in_flight = self.in_flight.saturating_sub(amount.0);
        if !near_sdk::is_promise_success() {
            if let Some(budget) = self.budgets.get_mut(&budget_id) {
                budget.escrow = U128(budget.escrow.0.saturating_add(amount.0));
            }
            self.total_escrow = self.total_escrow.saturating_add(amount.0);
        }
    }

    // ---- Admin ----

    /// Manages which accounts may call `settle_batch`. This grants no access to funds.
    /// The deposit must cover the storage a new entry writes, at least one yoctoNEAR, and the excess is refunded.
    #[payable]
    pub fn set_settler(&mut self, account: AccountId, allowed: bool) {
        self.require_admin();
        let before = self.storage_mark();
        if allowed {
            self.settlers.insert(account);
        } else {
            self.settlers.remove(&account);
        }
        let grown = self.storage_growth(before);
        self.charge_admin(grown);
    }

    /// Sets the node key that signs checkout terms, and the allowlisted settler whose storage balance pays for the
    /// payments accepted under those terms. This grants no access to funds.
    #[payable]
    pub fn set_checkout_key(&mut self, key: Id32, settler: AccountId) {
        self.require_admin();
        require!(self.settlers.contains(&settler), NOT_SETTLER);
        // `checkout` lives in the contract's root record, which is written after this method returns, so its growth
        // is the change in its serialized length.
        let before = borsh::object_length(&self.checkout).unwrap_or_else(|_| env::abort());
        self.checkout = Some(Checkout { key, settler });
        let after = borsh::object_length(&self.checkout).unwrap_or_else(|_| env::abort());
        self.charge_admin(after.saturating_sub(before) as u64);
    }

    // ---- Settler ----

    /// Adds NEAR to an account's storage balance. Anyone may fund any account.
    /// `settle_batch`, `register_receipt_key` and payments accepted under checkout terms draw from the settler's
    /// balance for the bytes they write. A new balance entry is paid for out of the deposit.
    #[payable]
    pub fn fund_storage(&mut self, account: AccountId) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, ZERO_AMOUNT);
        let before = self.storage_mark();
        let balance = self.storage_amount(&account);
        self.storage_balances.insert(account.clone(), add(balance, deposit));
        let cost = storage_cost(self.storage_growth(before));
        require!(deposit >= cost, INSUFFICIENT_DEPOSIT);
        if cost > 0 {
            self.storage_balances.insert(account, balance + deposit - cost);
        }
    }

    /// Returns unused storage balance to the caller. Exactly one yoctoNEAR is required, so a function-call key such
    /// as the node's settlement key cannot move the balance. The entry stays, at zero if need be.
    #[payable]
    pub fn withdraw_storage(&mut self, amount: U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        require!(amount.0 > 0, ZERO_AMOUNT);
        let balance = self.storage_amount(&account);
        require!(balance >= amount.0, INSUFFICIENT_STORAGE);
        self.storage_balances.insert(account.clone(), balance - amount.0);
        refund(&account, amount.0);
    }

    /// Registers a key the calling settler signs acceptances with, which `settle_own` checks.
    /// Only an allowlisted settler registers its own keys, and exactly one yoctoNEAR is required so a function-call
    /// key cannot do it. Keys are append-only: a settler cannot strand sellers by replacing its key and vanishing.
    #[payable]
    pub fn register_receipt_key(&mut self, key: Id32) {
        assert_one_yocto();
        let settler = env::predecessor_account_id();
        require!(self.settlers.contains(&settler), NOT_SETTLER);
        let mut keys = self.receipt_keys.get(&settler).cloned().unwrap_or_default();
        require!(!keys.contains(&key), RECEIPT_KEY_EXISTS);
        require!(keys.len() < MAX_RECEIPT_KEYS, TOO_MANY_RECEIPT_KEYS);
        keys.push(key);
        let before = self.storage_mark();
        self.receipt_keys.insert(settler.clone(), keys);
        self.charge_storage_balance(&settler, before);
    }

    // ---- Views ----

    pub fn budget(&self, budget_id: Id32) -> Option<Budget> {
        self.budgets.get(&budget_id).cloned()
    }

    pub fn settled_of(&self, budget_id: Id32, payee: AccountId) -> U128 {
        U128(self.settled_amount(&(budget_id, payee)))
    }

    pub fn credit_of(&self, account: AccountId) -> U128 {
        U128(self.credit_amount(&account))
    }

    /// The receipt keys a settler has registered, in the order it registered them.
    pub fn receipt_keys(&self, settler: AccountId) -> Vec<Id32> {
        self.receipt_keys.get(&settler).cloned().unwrap_or_default()
    }

    /// Unused NEAR, in yoctoNEAR, that the account has prepaid for settlement storage.
    pub fn storage_of(&self, account: AccountId) -> U128 {
        U128(self.storage_amount(&account))
    }

    pub fn batch(&self, batch_id: Id32) -> Option<BatchRecord> {
        self.batches.get(&batch_id).cloned()
    }

    pub fn payments(&self, ids: Vec<Id32>) -> Vec<Option<PaymentView>> {
        ids.into_iter()
            .map(|id| {
                self.payments.get(&id).map(|p| PaymentView {
                    id,
                    merchant: p.merchant.clone(),
                    amount: p.amount,
                    payer: p.payer.clone(),
                    at: p.at,
                })
            })
            .collect()
    }

    pub fn is_settler(&self, account: AccountId) -> bool {
        self.settlers.contains(&account)
    }

    pub fn checkout_key(&self) -> Option<Id32> {
        self.checkout.as_ref().map(|c| c.key)
    }

    /// The settler whose storage balance pays for payments accepted under checkout terms.
    pub fn checkout_settler(&self) -> Option<AccountId> {
        self.checkout.as_ref().map(|c| c.settler.clone())
    }

    pub fn totals(&self) -> Totals {
        Totals {
            escrow: U128(self.total_escrow),
            credits: U128(self.total_credits),
            in_flight: U128(self.in_flight),
        }
    }

    pub fn config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            token: self.token.clone(),
            network: self.network.clone(),
        }
    }

    /// Proves that a receipt with exactly these fields is in the batch's committed Merkle root.
    /// This proves inclusion only: the chain does not prove that a root covers every voucher.
    pub fn verify_receipt(&self, batch_id: Id32, fields: ReceiptFields, proof: Vec<Id32>) -> bool {
        let Some(batch) = self.batches.get(&batch_id) else {
            return false;
        };
        let leaf = receipt_leaf(
            env::current_account_id().as_str(),
            &self.network,
            &batch_id,
            &fields.call_id,
            &fields.budget_id,
            fields.payee.as_str(),
            fields.amount.0,
            fields.cumulative.0,
            &fields.request_hash,
            fields.timestamp_ms.0,
            &fields.voucher_sig.0,
        );
        verify_proof(&batch.root.0, leaf, &proof)
    }

    // ---- Internals ----

    /// At least one yoctoNEAR, so a function-call key cannot act as the admin.
    fn require_admin(&self) {
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "Requires attached deposit of at least 1 yoctoNEAR"
        );
        require!(env::predecessor_account_id() == self.admin, NOT_ADMIN);
    }

    /// Takes the cost of `grown` bytes from the admin's deposit and refunds the rest, keeping the one yoctoNEAR.
    fn charge_admin(&self, grown: u64) {
        let cost = storage_cost(grown);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, INSUFFICIENT_DEPOSIT);
        refund(&self.admin, deposit - cost.max(1));
    }

    /// The hub and the token can never be paid: credit in their name could not be paid out.
    fn is_reserved(&self, account: &AccountId) -> bool {
        *account == env::current_account_id() || *account == self.token
    }

    /// Storage in use once every cached write is on disk. Take it before a method's first write.
    fn storage_mark(&mut self) -> u64 {
        self.flush();
        env::storage_usage()
    }

    /// Bytes written to storage since `before`.
    fn storage_growth(&mut self, before: u64) -> u64 {
        self.flush();
        env::storage_usage().saturating_sub(before)
    }

    fn flush(&mut self) {
        self.budgets.flush();
        self.settled.flush();
        self.credits.flush();
        self.batches.flush();
        self.payments.flush();
        self.receipt_keys.flush();
        self.storage_balances.flush();
    }

    /// Charges `payer`'s prepaid storage balance for every byte written since `before`.
    fn charge_storage_balance(&mut self, payer: &AccountId, before: u64) {
        let cost = storage_cost(self.storage_growth(before));
        if cost == 0 {
            return;
        }
        let balance = self.storage_amount(payer);
        require!(balance >= cost, INSUFFICIENT_STORAGE);
        // The entry exists, because its balance is positive, so this write has the same size.
        self.storage_balances.insert(payer.clone(), balance - cost);
    }

    fn storage_amount(&self, account: &AccountId) -> u128 {
        self.storage_balances.get(account).copied().unwrap_or(0)
    }

    fn load_budget(&self, budget_id: &Id32) -> Budget {
        self.budgets
            .get(budget_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(UNKNOWN_BUDGET))
    }

    fn settled_amount(&self, key: &(Id32, AccountId)) -> u128 {
        self.settled.get(key).copied().unwrap_or(0)
    }

    fn credit_amount(&self, account: &AccountId) -> u128 {
        self.credits.get(account).map_or(0, |c| c.amount)
    }

    /// Adds credit. A new entry records `funder`, the settler whose storage balance pays for it, if any.
    fn add_credit(&mut self, account: &AccountId, amount: u128, funder: Option<&AccountId>) {
        match self.credits.get_mut(account) {
            Some(entry) => entry.amount = entry.amount.saturating_add(amount),
            None => {
                self.credits.insert(
                    account.clone(),
                    Credit {
                        amount,
                        in_flight: 0,
                        funder: funder.cloned(),
                    },
                );
            }
        }
    }

    /// Removes a credit entry that holds nothing and has nothing in flight, and returns the freed storage to the
    /// storage balance of the settler that paid for it. Storage that a `settle_own` caller or a Budget's reserve
    /// paid for has no balance to return to and stays with the hub. It never panics, as a callback uses it.
    fn release_credit_if_empty(&mut self, account: &AccountId) {
        let Some(entry) = self.credits.get(account) else {
            return;
        };
        if entry.amount != 0 || entry.in_flight != 0 {
            return;
        }
        let funder = entry.funder.clone();
        let before = self.storage_mark();
        self.credits.remove(account);
        self.credits.flush();
        let freed = before.saturating_sub(env::storage_usage());
        if let Some(funder) = funder
            && let Some(balance) = self.storage_balances.get_mut(&funder)
        {
            *balance = balance.saturating_add(storage_cost(freed));
        }
    }

    /// Checks that the node accepted exactly this claim, with a key the Budget's settler registered, no later than
    /// the Budget's revoke or expiry. The acceptance carries Unix seconds and the Budget Unix milliseconds: the
    /// second is taken at its first millisecond, so a call accepted in the same second as the revoke still settles.
    fn verify_acceptance(&self, budget: &Budget, claim: &Claim, acceptance: &Acceptance) {
        let registered = self
            .receipt_keys
            .get(&budget.settler)
            .is_some_and(|keys| keys.contains(&acceptance.node_key));
        require!(registered, ACCEPTANCE_KEY_UNKNOWN);
        let digest = acceptance_digest(
            &claim.budget_id,
            claim.payee.as_str(),
            claim.amount.0,
            claim.cumulative.0,
            &claim.request_hash,
            acceptance.timestamp_s.0,
            &claim.signature,
        );
        require!(
            verify_signature(&digest, &acceptance.signature.0, &acceptance.node_key.0),
            BAD_ACCEPTANCE
        );
        let limit_ms = match budget.revoked_at {
            Some(revoked) => revoked.0.min(budget.valid_until.0),
            None => budget.valid_until.0,
        };
        let accepted_ms = acceptance.timestamp_s.0.checked_mul(1_000);
        require!(accepted_ms.is_some_and(|ms| ms <= limit_ms), ACCEPTANCE_TOO_LATE);
    }

    /// Checks payee, signature and staleness, and returns the delta over the settled amount.
    fn verify_claim(&self, budget: &Budget, claim: &Claim, prior: u128) -> u128 {
        require!(!self.is_reserved(&claim.payee), RESERVED_ACCOUNT);
        require!(
            budget.payees.is_empty() || budget.payees.binary_search(&claim.payee).is_ok(),
            PAYEE_NOT_ALLOWED
        );
        let digest = voucher_digest(
            env::current_account_id().as_str(),
            &self.network,
            &claim.budget_id,
            claim.payee.as_str(),
            claim.amount.0,
            claim.cumulative.0,
            &claim.request_hash,
        );
        require!(
            verify_signature(&digest, &claim.signature.0, &budget.agent_pk.0),
            BAD_SIGNATURE
        );
        require!(claim.cumulative.0 > prior, STALE_VOUCHER);
        claim.cumulative.0 - prior
    }

    fn accept_deposit(&mut self, budget_id: Id32, sender: &AccountId, amount: u128) -> bool {
        let now = now_ms();
        let Some(budget) = self.budgets.get_mut(&budget_id) else {
            return false;
        };
        if budget.owner != *sender || budget.revoked_at.is_some() || now > budget.valid_until.0 {
            return false;
        }
        let Some(escrow) = budget.escrow.0.checked_add(amount) else {
            return false;
        };
        let Some(total) = self.total_escrow.checked_add(amount) else {
            return false;
        };
        budget.escrow = U128(escrow);
        self.total_escrow = total;
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn accept_payment(
        &mut self,
        payment_id: Id32,
        merchant: AccountId,
        terms_amount: u128,
        expiry_ms: u64,
        signature: Sig64,
        payer: &AccountId,
        amount: u128,
    ) -> bool {
        let Some(checkout) = self.checkout.clone() else {
            return false;
        };
        let now = now_ms();
        if terms_amount != amount
            || now > expiry_ms
            || self.payments.contains_key(&payment_id)
            || self.is_reserved(&merchant)
        {
            return false;
        }
        let digest = checkout_digest(
            env::current_account_id().as_str(),
            &self.network,
            &payment_id,
            merchant.as_str(),
            terms_amount,
            expiry_ms,
        );
        if !verify_signature(&digest, &signature.0, &checkout.key.0) {
            return false;
        }
        let Some(total) = self.total_credits.checked_add(amount) else {
            return false;
        };
        let before = self.storage_mark();
        self.add_credit(&merchant, amount, Some(&checkout.settler));
        self.total_credits = total;
        self.payments.insert(
            payment_id,
            PaymentRecord {
                merchant,
                amount: U128(amount),
                payer: payer.clone(),
                at: U64(now),
            },
        );
        // The settler that signed the terms pays for the record. A panic here undoes the writes above, and the token
        // then refunds the payer.
        self.charge_storage_balance(&checkout.settler, before);
        true
    }

    fn transfer_with_callback(&self, receiver: AccountId, amount: u128, callback: Promise) {
        ext_ft::ext(self.token.clone())
            .with_static_gas(Gas::from_gas(FT_TRANSFER_GAS))
            .with_attached_deposit(ONE_YOCTO)
            .ft_transfer(receiver, U128(amount), None)
            .then(callback)
            .detach();
    }
}

/// Sorts and deduplicates payees, matching the client's canonical form so the Budget id agrees.
pub fn canonicalize_payees(mut payees: Vec<AccountId>) -> Vec<AccountId> {
    payees.sort();
    payees.dedup();
    payees
}

/// The last millisecond at which a Budget can still be settled.
fn settle_deadline(budget: &Budget) -> u64 {
    let expiry = budget.valid_until.0.saturating_add(EXPIRY_GRACE_MS);
    match budget.revoked_at {
        Some(revoked) => expiry.min(revoked.0.saturating_add(REVOKE_GRACE_MS)),
        None => expiry,
    }
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str(OVERFLOW))
}

fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str(OVERFLOW))
}

fn storage_cost(bytes: u64) -> u128 {
    u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
}

fn refund(account: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(account.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }
}

fn require_gas(needed: u64) {
    let remaining = env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas());
    require!(remaining >= needed, INSUFFICIENT_GAS);
}

#[cfg(test)]
mod tests;
