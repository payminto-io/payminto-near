//! Configuration: the settler allowlist, receipt keys and the admin itself.
//!
//! Invariant owned here: configuration grants no access to funds. The admin decides which accounts may settle and
//! which key signs checkout terms; a settler decides which keys sign its acceptances. None of them can move escrow,
//! credit or another account's storage balance, and the admin can only be replaced by an account that accepts.

use near_sdk::{AccountId, env, near, require};

#[allow(unused_imports)]
use crate::HubExt;
use crate::crypto::is_acceptable_public_key;
use crate::errors::*;
use crate::events::{AdminProposed, AdminTransferred, ReceiptKeyRegistered, SettlerSet};
use crate::storage::borsh_len;
use crate::types::Id32;
use crate::{Hub, MAX_RECEIPT_KEYS};

#[near]
impl Hub {
    /// Manages which accounts may call `settle_batch`. This grants no access to funds.
    /// The deposit must cover the storage a new entry writes, at least one yoctoNEAR, and the excess is refunded.
    #[payable]
    pub fn set_settler(&mut self, account: AccountId, allowed: bool) {
        let ctx = self.require_admin();
        let before = self.storage_mark();
        let changed = if allowed {
            self.settlers.insert(account.clone())
        } else {
            self.settlers.remove(&account)
        };
        let grown = self.storage_growth(before);
        self.charge_deposit_keep_one(ctx.admin(), grown);
        if changed {
            SettlerSet { account, allowed }.emit();
        }
    }

    /// Registers a key the calling settler signs acceptances with, which `settle_own` checks.
    /// Only an allowlisted settler registers its own keys, and exactly one yoctoNEAR is required so a function-call
    /// key cannot do it. Keys are append-only: a settler cannot strand sellers by replacing its key and vanishing.
    /// The key must be canonical and not of small order, or anyone could sign acceptances with it.
    #[payable]
    pub fn register_receipt_key(&mut self, key: Id32) {
        let ctx = self.require_settler_full_key();
        let settler = ctx.settler().clone();
        require!(is_acceptable_public_key(&key.0), INVALID_KEY);
        let mut keys = self.receipt_keys.get(&settler).cloned().unwrap_or_default();
        require!(!keys.contains(&key), RECEIPT_KEY_EXISTS);
        require!(keys.len() < MAX_RECEIPT_KEYS, TOO_MANY_RECEIPT_KEYS);
        keys.push(key);
        let before = self.storage_mark();
        self.receipt_keys.insert(settler.clone(), keys);
        self.charge_storage_balance(&settler, before);
        ReceiptKeyRegistered { settler, key }.emit();
    }

    /// Step one of replacing the admin: names the account that may take over, or withdraws the proposal with `None`.
    /// Nothing changes until that account calls `accept_admin`, so a typo can never lock the admin out.
    /// The deposit pays for the name in the contract's root record, and the excess is refunded.
    #[payable]
    pub fn propose_admin(&mut self, new_admin: Option<AccountId>) {
        let ctx = self.require_admin();
        if let Some(account) = &new_admin {
            require!(*account != env::current_account_id(), ADMIN_IS_HUB);
        }
        let before = borsh_len(&self.pending_admin);
        let changed = self.pending_admin != new_admin;
        self.pending_admin = new_admin.clone();
        let after = borsh_len(&self.pending_admin);
        self.charge_deposit_keep_one(ctx.admin(), after.saturating_sub(before));
        if changed {
            AdminProposed {
                admin: ctx.admin().clone(),
                pending_admin: new_admin,
            }
            .emit();
        }
    }

    /// Step two: the proposed account becomes the admin. Exactly one yoctoNEAR, so only a full-access key can accept.
    /// The root record shrinks here, since the old name and the proposal are both replaced by the new name.
    #[payable]
    pub fn accept_admin(&mut self) {
        let ctx = self.require_pending_admin();
        let to = ctx.account().clone();
        let from = std::mem::replace(&mut self.admin, to.clone());
        self.pending_admin = None;
        AdminTransferred { from, to }.emit();
    }
}
