//! NEP-297 events: every state change the hub makes is logged as
//! `EVENT_JSON:{"standard":"payminto","version":"1.0.0","event":"<name>","data":[...]}`, so an indexer can follow the
//! hub without polling its views. Amounts and times are decimal strings, ids and keys lowercase hex, as in the views.
//!
//! Invariant owned here: logging never panics, so a callback that emits an event can still never fail.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Serialize;
use near_sdk::{AccountId, env};

use crate::types::Id32;

pub const STANDARD: &str = "payminto";
pub const VERSION: &str = "1.0.0";
pub const PREFIX: &str = "EVENT_JSON:";

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: &'a [T],
}

/// Logs one event. A serialization failure, which cannot happen for these types, drops the log rather than panic.
pub fn emit<T: Serialize>(event: &str, data: &[T]) {
    let envelope = Envelope {
        standard: STANDARD,
        version: VERSION,
        event,
        data,
    };
    if let Ok(json) = near_sdk::serde_json::to_string(&envelope) {
        env::log_str(&format!("{PREFIX}{json}"));
    }
}

macro_rules! event {
    ($(#[$doc:meta])* $name:ident, $event:literal { $($field:ident: $ty:ty),* $(,)? }) => {
        $(#[$doc])*
        #[derive(Serialize, Clone, Debug)]
        #[serde(crate = "near_sdk::serde")]
        pub struct $name { $(pub $field: $ty),* }

        impl $name {
            pub const EVENT: &'static str = $event;

            pub fn emit(self) {
                emit(Self::EVENT, &[self]);
            }
        }
    };
}

event!(
    /// `open_budget`.
    BudgetOpened, "budget_opened" {
        budget_id: Id32,
        owner: AccountId,
        settler: AccountId,
        cap: U128,
        valid_until: U64,
        allow_any_payee: bool,
        payees: u32,
        storage_reserve_bytes: U64,
    }
);
event!(
    /// A deposit into a Budget's escrow through `ft_on_transfer`.
    BudgetFunded, "budget_funded" { budget_id: Id32, owner: AccountId, amount: U128, escrow: U128 }
);
event!(
    /// `fund_from_credit`.
    CreditMovedToEscrow, "credit_moved_to_escrow" { budget_id: Id32, owner: AccountId, amount: U128, escrow: U128 }
);
event!(
    /// `revoke_budget`. `settle_deadline` is the last millisecond settlement stays open.
    BudgetRevoked, "budget_revoked" { budget_id: Id32, owner: AccountId, revoked_at: U64, settle_deadline: U64 }
);
event!(
    /// `reclaim` sent the escrow to the owner.
    ReclaimStarted, "reclaim_started" { budget_id: Id32, owner: AccountId, amount: U128 }
);
event!(
    /// The reclaim transfer's outcome. On failure the escrow is restored.
    ReclaimFinished, "reclaim_finished" { budget_id: Id32, amount: U128, success: bool }
);
event!(
    /// `prune`: settled entries removed and storage refunded to the owner.
    BudgetPruned, "budget_pruned" { budget_id: Id32, owner: AccountId, payees: u32, refunded_bytes: U64, refunded: U128 }
);
event!(
    /// `settle_batch`.
    BatchSettled, "batch_settled" {
        settler: AccountId,
        batch_id: Id32,
        root: Id32,
        claims: u32,
        gross: U128,
        net: U128,
    }
);
event!(
    /// `settle_own`.
    ClaimSettledByPayee, "claim_settled_by_payee" { budget_id: Id32, payee: AccountId, cumulative: U128, amount: U128 }
);
event!(
    /// One account `payout` sent credit to.
    PayoutStarted, "payout_started" { account: AccountId, amount: U128 }
);
event!(
    /// A payout transfer's outcome. On failure the credit is restored.
    PayoutFinished, "payout_finished" { account: AccountId, amount: U128, success: bool }
);
event!(
    /// A checkout payment accepted through `ft_on_transfer`.
    PaymentReceived, "payment_received" { payment_id: Id32, merchant: AccountId, amount: U128, payer: AccountId }
);
event!(
    /// `set_settler`.
    SettlerSet, "settler_set" { account: AccountId, allowed: bool }
);
event!(
    /// `set_checkout_key`.
    CheckoutKeySet, "checkout_key_set" { key: Id32, settler: AccountId }
);
event!(
    /// `register_receipt_key`.
    ReceiptKeyRegistered, "receipt_key_registered" { settler: AccountId, key: Id32 }
);
event!(
    /// `fund_storage`. `amount` is what reached the balance, after the cost of a new balance entry.
    StorageFunded, "storage_funded" { account: AccountId, amount: U128, balance: U128 }
);
event!(
    /// `withdraw_storage`.
    StorageWithdrawn, "storage_withdrawn" { account: AccountId, amount: U128, balance: U128 }
);
event!(
    /// `propose_admin`. `pending_admin` is null when the proposal was withdrawn.
    AdminProposed, "admin_proposed" { admin: AccountId, pending_admin: Option<AccountId> }
);
event!(
    /// `accept_admin`.
    AdminTransferred, "admin_transferred" { from: AccountId, to: AccountId }
);

/// Every event name, for the tests that check each state change logs one.
pub const ALL: &[&str] = &[
    BudgetOpened::EVENT,
    BudgetFunded::EVENT,
    CreditMovedToEscrow::EVENT,
    BudgetRevoked::EVENT,
    ReclaimStarted::EVENT,
    ReclaimFinished::EVENT,
    BudgetPruned::EVENT,
    BatchSettled::EVENT,
    ClaimSettledByPayee::EVENT,
    PayoutStarted::EVENT,
    PayoutFinished::EVENT,
    PaymentReceived::EVENT,
    SettlerSet::EVENT,
    CheckoutKeySet::EVENT,
    ReceiptKeyRegistered::EVENT,
    StorageFunded::EVENT,
    StorageWithdrawn::EVENT,
    AdminProposed::EVENT,
    AdminTransferred::EVENT,
];
