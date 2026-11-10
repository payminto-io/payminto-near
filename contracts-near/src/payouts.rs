//! Credits and payouts.
//!
//! Invariant owned here: for every account, credit plus the amount in flight only changes by settlement, checkout
//! payments, `fund_from_credit` and confirmed transfers. A payout moves credit to in-flight before its promise, and its
//! callback either confirms the transfer or restores the credit; it never panics after its guard.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, NearToken, Promise, env, ext_contract, near, require};

#[allow(unused_imports)]
use crate::HubExt;
use crate::errors::*;
use crate::events::{PayoutFinished, PayoutStarted, StorageReserveReturned};
use crate::types::*;
use crate::{
    BASE_GAS, CALLBACK_GAS, FT_TRANSFER_GAS, Hub, MAX_PAYOUT_ACCOUNTS, PAYOUT_ACCOUNT_GAS, add, require_gas, sub,
};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Hub {
    /// Pays credits out to the accounts, at most ten per call. Anyone can call it, and funds go only to the creditor.
    /// Credit is moved to the entry's `in_flight` before the promise, and a callback confirms or restores it.
    pub fn payout(&mut self, accounts: Vec<AccountId>) {
        let _anyone = Self::anyone();
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
            self.transfer_with_callback(account.clone(), amount, callback);
            PayoutStarted {
                account,
                amount: U128(amount),
            }
            .emit();
        }
    }

    /// Settles a payout outcome. Only the hub calls it, and it never panics after that check, so a failed transfer
    /// always restores the credit. Once an entry holds no credit and nothing in flight it is removed, and the storage
    /// it frees goes back to whoever paid for it.
    pub fn on_payout(&mut self, account: AccountId, amount: U128) {
        let ctx = Self::require_self();
        let restore = !ctx.success();
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
        PayoutFinished {
            account,
            amount,
            success: !restore,
        }
        .emit();
    }
}

impl Hub {
    pub(crate) fn credit_amount(&self, account: &AccountId) -> u128 {
        self.credits.get(account).map_or(0, |c| c.amount)
    }

    /// Adds credit. A new entry records `funder`, who paid for its storage, if anyone the hub can repay did.
    pub(crate) fn add_credit(&mut self, account: &AccountId, amount: u128, funder: Option<Funder>) {
        match self.credits.get_mut(account) {
            Some(entry) => entry.amount = entry.amount.saturating_add(amount),
            None => {
                self.credits.insert(
                    account.clone(),
                    Credit {
                        amount,
                        in_flight: 0,
                        funder,
                    },
                );
            }
        }
    }

    /// Removes a credit entry that holds nothing and has nothing in flight, and returns the freed storage to whoever
    /// paid for it: a settler's storage balance, or the storage reserve of the Budget whose settlement created it.
    /// Storage that a `settle_own` caller's deposit paid for has nobody to return to and stays with the hub.
    /// It never panics, as a callback uses it.
    pub(crate) fn release_credit_if_empty(&mut self, account: &AccountId) {
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
        match funder {
            Some(Funder::Settler(settler)) => self.return_to_storage_balance(&settler, freed),
            Some(Funder::Budget(id)) => {
                // Fixed-width record: adding to the reserve never grows storage.
                if let Some(budget) = self.budgets.get_mut(&id) {
                    budget.storage_reserve_bytes.0 = budget.storage_reserve_bytes.0.saturating_add(freed);
                    StorageReserveReturned {
                        budget_id: id,
                        bytes: U64(freed),
                        storage_reserve_bytes: budget.storage_reserve_bytes,
                    }
                    .emit();
                }
            }
            None => {}
        }
    }

    pub(crate) fn transfer_with_callback(&self, receiver: AccountId, amount: u128, callback: Promise) {
        ext_ft::ext(self.token.clone())
            .with_static_gas(Gas::from_gas(FT_TRANSFER_GAS))
            .with_attached_deposit(ONE_YOCTO)
            .ft_transfer(receiver, U128(amount), None)
            .then(callback)
            .detach();
    }
}
