//! Budgets: opening, funding, revoking, reclaiming and pruning.
//!
//! Invariant owned here: a Budget's escrow only rises by its owner's own token deposits and credit, only its owner
//! can take it back, and only after the settlement deadline. `cap` is set once at `open_budget` and never rises.
//! The owner also prepays every byte of settlement storage its Budget can cause, and gets back what it did not use.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, env, near, require};

#[allow(unused_imports)]
use crate::HubExt;
use crate::crypto::is_acceptable_public_key;
use crate::encoding::budget_id;
use crate::errors::*;
use crate::events::{
    BudgetFunded, BudgetOpened, BudgetPruned, BudgetRevoked, CreditMovedToEscrow, ReclaimFinished, ReclaimStarted,
};
use crate::storage::{refund, storage_cost};
use crate::types::*;
use crate::{
    BASE_GAS, CALLBACK_GAS, Hub, MAX_ANY_PAYEES, MAX_PAYEES, MAX_PRUNE_PAYEES, MAX_VALID_UNTIL_MS, PAIR_BYTES,
    PAYOUT_ACCOUNT_GAS, REVOKE_BYTES, add, canonicalize_payees, now_ms, require_gas, settle_deadline, sub,
};

#[near]
impl Hub {
    /// Opens a Budget owned by the predecessor, which may be any account or contract.
    /// `cap` is authority over gross spending and is set only here; deposits raise only escrow.
    /// A Budget either lists 1 to 16 payees, or sets `allow_any_payee` with an empty list and declares in
    /// `max_payees` how many distinct payees it can ever pay. The attached deposit covers the record, the bytes a
    /// later revoke adds, and the settlement storage of every payee the Budget can pay; the excess is refunded.
    #[payable]
    pub fn open_budget(&mut self, terms: BudgetTerms) -> Id32 {
        let ctx = Self::anyone();
        let owner = ctx.caller().clone();
        let mut terms = terms;
        let now = now_ms();
        require!(
            terms.cap.0 > 0 && terms.valid_until.0 > now && terms.valid_until.0 <= MAX_VALID_UNTIL_MS,
            INVALID_BUDGET
        );
        // The hub and the token can never call `settle_batch`, so a Budget naming them could only be settled by its
        // payees.
        require!(!self.is_reserved(&terms.settler), INVALID_BUDGET);
        terms.payees = canonicalize_payees(terms.payees);
        let slots = if terms.allow_any_payee {
            require!(
                terms.payees.is_empty() && terms.max_payees >= 1 && terms.max_payees <= MAX_ANY_PAYEES,
                INVALID_BUDGET
            );
            u64::from(terms.max_payees)
        } else {
            require!(
                !terms.payees.is_empty() && terms.payees.len() <= MAX_PAYEES && terms.max_payees == 0,
                INVALID_BUDGET
            );
            terms.payees.len() as u64
        };
        require!(!terms.payees.iter().any(|p| self.is_reserved(p)), INVALID_BUDGET);
        require!(is_acceptable_public_key(&terms.agent_pk.0), INVALID_BUDGET);

        let id = budget_id(
            env::current_account_id().as_str(),
            &self.network,
            owner.as_str(),
            &terms,
        );
        require!(!self.budgets.contains_key(&id), BUDGET_EXISTS);

        let reserve = slots * PAIR_BYTES;
        let before = self.storage_mark();
        let payees = terms.payees.len() as u32;
        self.budgets.insert(
            id,
            Budget {
                owner: owner.clone(),
                settler: terms.settler.clone(),
                agent_pk: terms.agent_pk,
                cap: terms.cap,
                spent: U128(0),
                escrow: U128(0),
                valid_until: terms.valid_until,
                revoked_at: None,
                payees: terms.payees,
                policy_hash: terms.policy_hash,
                allow_any_payee: terms.allow_any_payee,
                max_payees: slots as u32,
                payees_paid: 0,
                storage_reserve_bytes: U64(reserve),
            },
        );
        let used = self.storage_growth(before);
        let cost = storage_cost(used + REVOKE_BYTES + reserve);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, INSUFFICIENT_DEPOSIT);
        refund(&owner, deposit - cost);
        BudgetOpened {
            budget_id: id,
            owner,
            settler: terms.settler,
            cap: terms.cap,
            valid_until: terms.valid_until,
            allow_any_payee: terms.allow_any_payee,
            payees,
            storage_reserve_bytes: U64(reserve),
        }
        .emit();
        id
    }

    /// Starts the settlement grace period: settlement stays open 24 hours from now, or until the expiry grace ends if
    /// that is earlier. Only before `valid_until`: after expiry the 3-day expiry grace is already running, and a
    /// revoke could only shorten what sellers were promised. Agents cannot call this; the node stops accepting their
    /// vouchers on request.
    pub fn revoke_budget(&mut self, budget_id: Id32) {
        let (ctx, mut budget) = self.require_owner(&budget_id);
        require!(budget.revoked_at.is_none(), ALREADY_REVOKED);
        let now = now_ms();
        require!(now <= budget.valid_until.0, BUDGET_NOT_OPEN);
        budget.revoked_at = Some(U64(now));
        let deadline = settle_deadline(&budget);
        self.budgets.insert(budget_id, budget);
        BudgetRevoked {
            budget_id,
            owner: ctx.owner().clone(),
            revoked_at: U64(now),
            settle_deadline: U64(deadline),
        }
        .emit();
    }

    /// Returns the remaining escrow after the settlement deadline.
    /// Escrow is zeroed before the promise, and a callback restores it if the transfer fails.
    pub fn reclaim(&mut self, budget_id: Id32) {
        let (ctx, mut budget) = self.require_owner(&budget_id);
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
        let owner = ctx.owner().clone();
        self.transfer_with_callback(
            owner.clone(),
            amount,
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_gas(CALLBACK_GAS))
                .on_reclaim(budget_id, U128(amount)),
        );
        ReclaimStarted {
            budget_id,
            owner,
            amount: U128(amount),
        }
        .emit();
    }

    /// Settles a reclaim outcome. Only the hub calls it, and it never panics after that check, so a failed transfer
    /// always restores the escrow.
    pub fn on_reclaim(&mut self, budget_id: Id32, amount: U128) {
        let ctx = Self::require_self();
        self.in_flight = self.in_flight.saturating_sub(amount.0);
        if !ctx.success() {
            if let Some(budget) = self.budgets.get_mut(&budget_id) {
                budget.escrow = U128(budget.escrow.0.saturating_add(amount.0));
            }
            self.total_escrow = self.total_escrow.saturating_add(amount.0);
        }
        ReclaimFinished {
            budget_id,
            amount,
            success: ctx.success(),
        }
        .emit();
    }

    /// Moves the caller's own hub credit into the escrow of one of the caller's open Budgets.
    /// It raises escrow only, never cap, and changes no token balance, so `total_escrow + total_credits` is unchanged.
    /// Settlement never draws credit by itself, because `payout` is open to anyone and could empty it under a pending batch.
    /// Exactly one yoctoNEAR is required, so a function-call key cannot turn withdrawable credit into agent spending power.
    #[payable]
    pub fn fund_from_credit(&mut self, budget_id: Id32, amount: U128) {
        let (ctx, mut budget) = self.require_owner_full_key(&budget_id);
        let owner = ctx.owner().clone();
        require!(amount.0 > 0, ZERO_AMOUNT);
        require!(
            budget.revoked_at.is_none() && now_ms() <= budget.valid_until.0,
            BUDGET_NOT_OPEN
        );
        let credit = self.credit_amount(&owner);
        require!(credit >= amount.0, INSUFFICIENT_CREDIT);

        budget.escrow = U128(add(budget.escrow.0, amount.0));
        let escrow = budget.escrow;
        let total_escrow = add(self.total_escrow, amount.0);
        if let Some(entry) = self.credits.get_mut(&owner) {
            entry.amount = credit - amount.0;
        }
        self.budgets.insert(budget_id, budget);
        self.release_credit_if_empty(&owner);
        self.total_credits = sub(self.total_credits, amount.0);
        self.total_escrow = total_escrow;
        CreditMovedToEscrow {
            budget_id,
            owner,
            amount,
            escrow,
        }
        .emit();
    }

    /// After the settlement deadline, removes the Budget's `settled` entries for `payees` and refunds to the owner
    /// the storage they freed plus whatever is left of the Budget's storage reserve. Nothing can settle against the
    /// Budget any more, so those entries are no longer needed. The Budget record stays, so its id can never be
    /// opened again and its old vouchers can never settle twice. A credit entry the Budget paid for returns its bytes
    /// to the reserve when it is paid out, and a later `prune`, with an empty list if need be, refunds them too.
    pub fn prune(&mut self, budget_id: Id32, payees: Vec<AccountId>) {
        let (ctx, mut budget) = self.require_owner(&budget_id);
        require!(payees.len() <= MAX_PRUNE_PAYEES, TOO_MANY_ACCOUNTS);
        require!(now_ms() > settle_deadline(&budget), TOO_EARLY);

        let before = self.storage_mark();
        let mut removed = 0u32;
        for payee in payees {
            if self.settled.remove(&(budget_id, payee)).is_some() {
                removed += 1;
            }
        }
        self.settled.flush();
        let freed = before.saturating_sub(env::storage_usage());
        let bytes = freed.saturating_add(budget.storage_reserve_bytes.0);
        budget.storage_reserve_bytes = U64(0);
        // The Budget record has a fixed width, so writing it back never grows storage.
        self.budgets.insert(budget_id, budget);
        let owner = ctx.owner().clone();
        let refunded = storage_cost(bytes);
        refund(&owner, refunded);
        BudgetPruned {
            budget_id,
            owner,
            payees: removed,
            refunded_bytes: U64(bytes),
            refunded: U128(refunded),
        }
        .emit();
    }
}

impl Hub {
    /// A deposit into an open Budget by its owner. Anything else is refused, and the token returns the amount.
    pub(crate) fn accept_deposit(&mut self, budget_id: Id32, sender: &AccountId, amount: u128) -> bool {
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
        BudgetFunded {
            budget_id,
            owner: sender.clone(),
            amount: U128(amount),
            escrow: U128(escrow),
        }
        .emit();
        true
    }
}
