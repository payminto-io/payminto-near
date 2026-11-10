//! Storage accounting.
//!
//! Invariant owned here: the hub account never pays for storage. Every method that grows state measures the growth
//! with `env::storage_usage()` and charges exactly that many bytes to whoever caused it: the caller's deposit, the
//! Budget's prepaid storage reserve, or a settler's prepaid storage balance. Records that shrink return their bytes to
//! whoever paid for them where the hub knows who that was.

use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, Promise, env, near, require};

#[allow(unused_imports)]
use crate::HubExt;
use crate::errors::*;
use crate::events::{StorageFunded, StorageWithdrawn};
use crate::{Hub, add};

#[near]
impl Hub {
    /// Adds NEAR to an account's storage balance. Anyone may fund any account except the hub and the token, which
    /// could never withdraw it. `settle_batch`, `register_receipt_key` and payments accepted under checkout terms
    /// draw from the settler's balance for the bytes they write. A new balance entry is paid for out of the deposit.
    #[payable]
    pub fn fund_storage(&mut self, account: AccountId) {
        let _anyone = Self::anyone();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, ZERO_AMOUNT);
        require!(!self.is_reserved(&account), RESERVED_ACCOUNT);
        let before = self.storage_mark();
        let balance = self.storage_amount(&account);
        self.storage_balances.insert(account.clone(), add(balance, deposit));
        let cost = storage_cost(self.storage_growth(before));
        require!(deposit >= cost, INSUFFICIENT_DEPOSIT);
        let after = balance + deposit - cost;
        if cost > 0 {
            self.storage_balances.insert(account.clone(), after);
        }
        StorageFunded {
            account,
            amount: U128(deposit - cost),
            balance: U128(after),
        }
        .emit();
    }

    /// Returns unused storage balance to the caller. Exactly one yoctoNEAR is required, so a function-call key such
    /// as the node's settlement key cannot move the balance. The entry stays, at zero if need be.
    #[payable]
    pub fn withdraw_storage(&mut self, amount: U128) {
        let ctx = Self::anyone_full_key();
        let account = ctx.caller().clone();
        require!(amount.0 > 0, ZERO_AMOUNT);
        let balance = self.storage_amount(&account);
        require!(balance >= amount.0, INSUFFICIENT_STORAGE);
        self.storage_balances.insert(account.clone(), balance - amount.0);
        refund(&account, amount.0);
        StorageWithdrawn {
            account,
            amount,
            balance: U128(balance - amount.0),
        }
        .emit();
    }
}

impl Hub {
    /// Storage in use once every cached write is on disk. Take it before a method's first write.
    pub(crate) fn storage_mark(&mut self) -> u64 {
        self.flush();
        env::storage_usage()
    }

    /// Bytes written to storage since `before`.
    pub(crate) fn storage_growth(&mut self, before: u64) -> u64 {
        self.flush();
        env::storage_usage().saturating_sub(before)
    }

    pub(crate) fn flush(&mut self) {
        self.budgets.flush();
        self.settled.flush();
        self.credits.flush();
        self.batches.flush();
        self.payments.flush();
        self.receipt_keys.flush();
        self.storage_balances.flush();
    }

    /// Charges `payer`'s prepaid storage balance for every byte written since `before`.
    pub(crate) fn charge_storage_balance(&mut self, payer: &AccountId, before: u64) {
        let cost = storage_cost(self.storage_growth(before));
        if cost == 0 {
            return;
        }
        let balance = self.storage_amount(payer);
        require!(balance >= cost, INSUFFICIENT_STORAGE);
        // The entry exists, because its balance is positive, so this write has the same size.
        self.storage_balances.insert(payer.clone(), balance - cost);
    }

    /// Returns the cost of `bytes` to a settler's storage balance, when it has one. It never panics, as a callback
    /// uses it; without a balance entry the bytes stay with the hub.
    pub(crate) fn return_to_storage_balance(&mut self, account: &AccountId, bytes: u64) {
        if let Some(balance) = self.storage_balances.get_mut(account) {
            *balance = balance.saturating_add(storage_cost(bytes));
        }
    }

    pub(crate) fn storage_amount(&self, account: &AccountId) -> u128 {
        self.storage_balances.get(account).copied().unwrap_or(0)
    }

    /// Takes the cost of `grown` bytes from the caller's deposit and refunds the rest to `to`, keeping at least the
    /// one yoctoNEAR an admin call must attach.
    pub(crate) fn charge_deposit_keep_one(&self, to: &AccountId, grown: u64) {
        let cost = storage_cost(grown);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, INSUFFICIENT_DEPOSIT);
        refund(to, deposit - cost.max(1));
    }
}

pub fn storage_cost(bytes: u64) -> u128 {
    u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
}

pub(crate) fn refund(account: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(account.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }
}

/// The Borsh length of a value, for a field of the contract's root record, which is written after the method returns
/// and so cannot be measured with `env::storage_usage()`.
pub(crate) fn borsh_len<T: BorshSerialize>(value: &T) -> u64 {
    borsh::object_length(value).unwrap_or_else(|_| env::panic_str(ENCODING_FAILED)) as u64
}
