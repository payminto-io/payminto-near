//! Pure netting of bilateral obligations between accounts.
//! The netting party is the account: a Budget owner on the debit side and a payee on the credit side.

use near_sdk::AccountId;
use std::collections::BTreeMap;

use crate::errors::OVERFLOW;
use crate::types::NetEntry;
use near_sdk::json_types::U128;

/// Gross debits and credits per account, and the net positions they produce.
#[derive(Default)]
pub struct Netting {
    positions: BTreeMap<AccountId, Position>,
}

#[derive(Default, Clone, Copy)]
struct Position {
    owes: u128,
    owed: u128,
}

impl Netting {
    /// Records that `debtor` owes `creditor` the given amount.
    pub fn record(&mut self, debtor: &AccountId, creditor: &AccountId, amount: u128) {
        let owes = &mut self.positions.entry(debtor.clone()).or_default().owes;
        *owes = owes.checked_add(amount).unwrap_or_else(overflow);
        let owed = &mut self.positions.entry(creditor.clone()).or_default().owed;
        *owed = owed.checked_add(amount).unwrap_or_else(overflow);
    }

    /// Net positions sorted by account, leaving out accounts that net to zero.
    pub fn entries(&self) -> Vec<NetEntry> {
        let mut entries = Vec::new();
        for (account, position) in &self.positions {
            let (debit, credit) = if position.owes > position.owed {
                (position.owes - position.owed, 0)
            } else if position.owed > position.owes {
                (0, position.owed - position.owes)
            } else {
                continue;
            };
            entries.push(NetEntry {
                account: account.clone(),
                debit: U128(debit),
                credit: U128(credit),
            });
        }
        entries
    }
}

fn overflow() -> u128 {
    near_sdk::env::panic_str(OVERFLOW)
}
