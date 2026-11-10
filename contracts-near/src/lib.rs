//! The Payminto clearing hub.
//!
//! The hub escrows a NEP-141 token for Budget owners, settles batches of agent vouchers with on-chain signature
//! checks and account-level netting, and holds net credits until they are paid out.
//! It has no upgrade method, no admin path to funds, and no key-based assumption about Budget owners.
//!
//! One file per invariant:
//!
//! | File | Owns |
//! |---|---|
//! | `auth.rs` | who may call what: one guard per role, each returning a context only it can build |
//! | `budgets.rs` | a Budget's escrow only rises by its owner's deposits and credit, and only its owner gets it back |
//! | `settlement.rs` | escrow only falls by a verified net debit, and a voucher settles at most once |
//! | `payouts.rs` | credit plus in-flight is conserved: a payout either lands or is restored |
//! | `storage.rs` | the hub never pays for storage: every byte written is charged to whoever caused it |
//! | `checkout.rs` | a payment credits the merchant only under terms the checkout key signed |
//! | `admin.rs` | configuration grants no access to funds |
//! | `views.rs` | read-only methods |
//! | `events.rs` | every state change is logged as a NEP-297 event, and logging never panics |
//! | `crypto.rs` | every stored key is canonical and not of small order |
//! | `encoding.rs`, `netting.rs` | the digests, Merkle hashing and netting shared with `packages/chain` |

pub mod admin;
pub mod auth;
pub mod budgets;
pub mod checkout;
pub mod crypto;
pub mod encoding;
pub mod errors;
pub mod events;
pub mod netting;
pub mod payouts;
pub mod settlement;
pub mod storage;
pub mod types;
pub mod views;

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, BorshStorageKey, Gas, PanicOnDefault, env, near, require};

use crate::errors::*;
use crate::types::*;

pub const MAX_CLAIMS: usize = 100;
/// Payees a Budget can list.
pub const MAX_PAYEES: usize = 16;
/// Distinct payees a Budget with `allow_any_payee` can declare it will ever pay.
pub const MAX_ANY_PAYEES: u32 = 256;
pub const MAX_PAYOUT_ACCOUNTS: usize = 10;
/// Payees one `prune` call can clear.
pub const MAX_PRUNE_PAYEES: usize = 100;
/// The smallest checkout payment a new hub accepts, in token base units: 0.01 USDC. Every accepted payment writes a
/// permanent record on the checkout settler's storage balance, so a floor keeps one-unit payments from burning it.
/// The admin can change it with `set_min_payment`.
pub const DEFAULT_MIN_PAYMENT: u128 = 10_000;
/// The latest `valid_until` the hub accepts, in Unix milliseconds: 10^13 ms is in the year 2286. Any real expiry in
/// milliseconds is far below it, while the same time in microseconds (about 1.8 * 10^15 today) or nanoseconds
/// (1.8 * 10^18) is far above it, so a client that sends the wrong unit is refused instead of opening a Budget that
/// never expires.
pub const MAX_VALID_UNTIL_MS: u64 = 10_000_000_000_000;

/// Receipt keys one settler can register. Keys are append-only, so the cap bounds what a settler can make the hub
/// store and what a seller has to look through.
pub const MAX_RECEIPT_KEYS: usize = 4;

/// Settlement stays open this long after a revoke, so payees can claim calls already served.
pub const REVOKE_GRACE_MS: u64 = 86_400_000;
/// Settlement stays open this long after a Budget expires.
pub const EXPIRY_GRACE_MS: u64 = 3 * 86_400_000;

/// Storage the owner prepays at `open_budget` for each payee the Budget can pay: one `settled` entry and one credit
/// entry the Budget pays for, both for a 64-character account, the longest NEAR allows. `settled` is
/// 1 + (32 + 4 + 64) + 16 + 40 = 157 bytes and the credit entry 1 + (4 + 64) + 16 + 16 + 1 + 1 + 32 + 40 = 175.
pub const PAIR_BYTES: u64 = 157 + 175;
/// `revoke_budget` turns `revoked_at` from `None` into `Some(u64)`, which grows the record by this much.
/// The owner pays for it at `open_budget`, so a revoke never needs a deposit.
pub const REVOKE_BYTES: u64 = 8;

/// Static gas for one `ft_transfer`. A transfer that runs out fails safely: the callback restores the amount.
pub(crate) const FT_TRANSFER_GAS: u64 = Gas::from_tgas(15).as_gas();
/// Static gas for one callback. A callback must never run out, so this is several times what it burns.
pub(crate) const CALLBACK_GAS: u64 = Gas::from_tgas(8).as_gas();
/// Gas the hub call itself spends per paid account: the fees for creating the two receipts, and its own work.
const PROMISE_GAS: u64 = Gas::from_tgas(3).as_gas();
/// Everything one paid account needs from the gas attached to `payout`.
pub const PAYOUT_ACCOUNT_GAS: u64 = FT_TRANSFER_GAS + CALLBACK_GAS + PROMISE_GAS;
/// What `payout` and `reclaim` need on top, for loading the contract and their own bookkeeping.
pub const BASE_GAS: u64 = Gas::from_tgas(10).as_gas();

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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hub {
    admin: AccountId,
    /// Named by `propose_admin`; becomes `admin` when it calls `accept_admin`.
    pending_admin: Option<AccountId>,
    token: AccountId,
    network: String,
    settlers: LookupSet<AccountId>,
    checkout: Option<Checkout>,
    /// Named by the admin's `set_checkout_key`; becomes `checkout` when its settler calls `accept_checkout`.
    pending_checkout: Option<Checkout>,
    /// The smallest checkout payment accepted, in token base units.
    min_payment: u128,
    budgets: LookupMap<Id32, Budget>,
    settled: LookupMap<(Id32, AccountId), u128>,
    credits: LookupMap<AccountId, Credit>,
    /// Keyed by settler and batch id, so one settler can never take another's batch id.
    batches: LookupMap<(AccountId, Id32), BatchRecord>,
    payments: LookupMap<Id32, PaymentRecord>,
    /// The keys each settler signs acceptances with. Append-only, at most `MAX_RECEIPT_KEYS` per settler.
    receipt_keys: LookupMap<AccountId, Vec<Id32>>,
    /// NEAR prepaid per account for the storage its batches, keys and checkout payments write. Never removed.
    storage_balances: LookupMap<AccountId, u128>,
    total_escrow: u128,
    total_credits: u128,
    in_flight: u128,
}

#[near]
impl Hub {
    /// Deployment parameters. `token` and `network` never change, and `admin` must be separate from the hub account.
    /// Only the hub account can call it, in the deploy transaction.
    #[init]
    pub fn new(admin: AccountId, token: AccountId, network: String) -> Self {
        Self::require_self();
        require!(admin != env::current_account_id(), ADMIN_IS_HUB);
        Self {
            admin,
            pending_admin: None,
            token,
            network,
            settlers: LookupSet::new(StorageKey::Settlers),
            checkout: None,
            pending_checkout: None,
            min_payment: DEFAULT_MIN_PAYMENT,
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

    /// The token receiver. Accepts deposits to a Budget and signed checkout payments, and returns the full amount on
    /// anything else, including any call that is not from the token. A payment whose storage the checkout settler's
    /// balance cannot cover panics with `INSUFFICIENT_STORAGE`, which NEP-141 resolves as a full refund to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let Some(_token) = self.token_caller() else {
            return amount;
        };
        if amount.0 == 0 {
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
}

impl Hub {
    pub(crate) fn load_budget(&self, budget_id: &Id32) -> Budget {
        self.budgets
            .get(budget_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(UNKNOWN_BUDGET))
    }

    /// The hub and the token can never be paid or hold a storage balance: neither could ever use it.
    pub(crate) fn is_reserved(&self, account: &AccountId) -> bool {
        *account == env::current_account_id() || *account == self.token
    }
}

/// Sorts and deduplicates payees, matching the client's canonical form so the Budget id agrees.
pub fn canonicalize_payees(mut payees: Vec<AccountId>) -> Vec<AccountId> {
    payees.sort();
    payees.dedup();
    payees
}

/// The last millisecond at which a Budget can still be settled.
pub(crate) fn settle_deadline(budget: &Budget) -> u64 {
    let expiry = budget.valid_until.0.saturating_add(EXPIRY_GRACE_MS);
    match budget.revoked_at {
        Some(revoked) => expiry.min(revoked.0.saturating_add(REVOKE_GRACE_MS)),
        None => expiry,
    }
}

pub(crate) fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

pub(crate) fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str(OVERFLOW))
}

pub(crate) fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str(OVERFLOW))
}

pub(crate) fn require_gas(needed: u64) {
    let remaining = env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas());
    require!(remaining >= needed, INSUFFICIENT_GAS);
}

#[cfg(test)]
mod tests;
