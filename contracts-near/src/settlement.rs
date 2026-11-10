//! Settlement: the node's batches and a payee's own claim.
//!
//! Invariant owned here: a Budget's escrow only falls by a net debit recomputed on chain from vouchers its agent key
//! signed, each `(Budget, payee)` pair settles a strictly increasing cumulative amount, and gross spending never
//! passes `cap`. Every check runs before any state changes.

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env, near, require};

#[allow(unused_imports)]
use crate::HubExt;
use crate::crypto::verify_signature;
use crate::encoding::{acceptance_digest, voucher_digest};
use crate::errors::*;
use crate::events::{BatchSettled, ClaimSettledByPayee};
use crate::netting::Netting;
use crate::storage::{refund, storage_cost};
use crate::types::*;
use crate::{Hub, MAX_CLAIMS, PAIR_BYTES, add, now_ms, settle_deadline, sub};

#[near]
impl Hub {
    /// Settles a batch atomically: every check runs before any state changes.
    /// Each claim is the latest voucher for its `(budget, payee)` pair, and `expected_net` is asserted against the
    /// recomputed netting of account-level obligations.
    /// Each Budget pays for the `settled` and credit entries of its own new payees from the storage reserve its owner
    /// prepaid, and the settler pays for its batch record from its storage balance. The hub pays for nothing.
    /// Batch ids belong to the settler: two settlers can use the same id, and neither can take the other's.
    pub fn settle_batch(&mut self, batch_id: Id32, root: Id32, claims: Vec<Claim>, expected_net: Vec<NetEntry>) {
        let ctx = self.require_settler();
        let settler = ctx.settler().clone();
        let batch_key = (settler.clone(), batch_id);
        require!(!self.batches.contains_key(&batch_key), BATCH_EXISTS);
        require!(claims.len() <= MAX_CLAIMS, TOO_MANY_CLAIMS);

        let now = now_ms();
        let mut budgets: BTreeMap<Id32, Budget> = BTreeMap::new();
        let mut owners: BTreeMap<AccountId, Id32> = BTreeMap::new();
        // New settled amounts, grouped by Budget so that each Budget pays for its own entries.
        let mut settled: BTreeMap<Id32, BTreeMap<AccountId, u128>> = BTreeMap::new();
        // The Budget of the first claim to each payee, which pays for the payee's credit entry if one is created.
        let mut first_payer: BTreeMap<AccountId, Id32> = BTreeMap::new();
        let mut netting = Netting::default();
        let mut gross = 0u128;

        for claim in &claims {
            let budget = match budgets.entry(claim.budget_id) {
                Entry::Occupied(entry) => entry.into_mut(),
                Entry::Vacant(slot) => {
                    let budget = self.load_budget(&claim.budget_id);
                    ctx.require_names(&budget);
                    let prior = owners.insert(budget.owner.clone(), claim.budget_id);
                    require!(prior.is_none(), ONE_BUDGET_PER_OWNER);
                    require!(now <= settle_deadline(&budget), BUDGET_CLOSED);
                    slot.insert(budget)
                }
            };

            let pairs = settled.entry(claim.budget_id).or_default();
            let prior = match pairs.get(&claim.payee) {
                Some(amount) => *amount,
                None => self.settled_amount(&(claim.budget_id, claim.payee.clone())),
            };
            let delta = self.verify_claim(budget, claim, prior);
            budget.spent = U128(add(budget.spent.0, delta));
            require!(budget.spent.0 <= budget.cap.0, CAP_EXCEEDED);
            pairs.insert(claim.payee.clone(), claim.cumulative.0);
            first_payer.entry(claim.payee.clone()).or_insert(claim.budget_id);
            netting.record(&budget.owner, &claim.payee, delta);
            gross = add(gross, delta);
        }
        require!(gross > 0, ZERO_GROSS);

        let entries = netting.entries();
        require!(entries == expected_net, NET_MISMATCH);

        // A debit belongs to an owner in `owners`, because only an owner can owe. The fallback cannot run, and if it
        // ever did, the recomputed netting would not be what was settled, so it is a net mismatch.
        let mut net = 0u128;
        for entry in &entries {
            if entry.debit.0 > 0 {
                let id = owners
                    .get(&entry.account)
                    .unwrap_or_else(|| env::panic_str(NET_MISMATCH));
                let budget = budgets.get_mut(id).unwrap_or_else(|| env::panic_str(NET_MISMATCH));
                require!(budget.escrow.0 >= entry.debit.0, INSUFFICIENT_ESCROW);
                budget.escrow = U128(budget.escrow.0 - entry.debit.0);
                net = add(net, entry.debit.0);
            }
        }

        // Writes. Each Budget's new `settled` entries are measured on their own and charged to its reserve.
        let mut charged: BTreeMap<Id32, u64> = BTreeMap::new();
        let mut mark = self.storage_mark();
        for (id, pairs) in settled {
            for (payee, cumulative) in pairs {
                self.settled.insert((id, payee), cumulative);
            }
            self.settled.flush();
            let usage = env::storage_usage();
            *charged.entry(id).or_default() += usage.saturating_sub(mark);
            mark = usage;
        }
        // A new credit entry is charged to the Budget of the first claim that paid its account. Every account with a
        // net credit was paid by some claim, so it has one.
        for entry in &entries {
            if entry.credit.0 == 0 {
                continue;
            }
            if let Some(credit) = self.credits.get_mut(&entry.account) {
                credit.amount = credit.amount.saturating_add(entry.credit.0);
                continue;
            }
            let payer = *first_payer
                .get(&entry.account)
                .unwrap_or_else(|| env::panic_str(NET_MISMATCH));
            self.credits.insert(
                entry.account.clone(),
                Credit {
                    amount: entry.credit.0,
                    in_flight: 0,
                    funder: Some(Funder::Budget(payer)),
                },
            );
            self.credits.flush();
            let usage = env::storage_usage();
            *charged.entry(payer).or_default() += usage.saturating_sub(mark);
            mark = usage;
        }
        for (id, bytes) in charged {
            let budget = budgets.get_mut(&id).unwrap_or_else(|| env::panic_str(NET_MISMATCH));
            require!(budget.storage_reserve_bytes.0 >= bytes, INSUFFICIENT_RESERVE);
            budget.storage_reserve_bytes = U64(budget.storage_reserve_bytes.0 - bytes);
        }
        // Budget records have a fixed width, so writing them back never grows storage.
        for (id, budget) in budgets {
            self.budgets.insert(id, budget);
        }
        self.total_escrow = sub(self.total_escrow, net);
        self.total_credits = add(self.total_credits, net);

        // The settler pays for its own batch record.
        let before = self.storage_mark();
        self.batches.insert(
            batch_key,
            BatchRecord {
                root,
                settler: settler.clone(),
                gross: U128(gross),
                net: U128(net),
                at: U64(now),
            },
        );
        self.charge_storage_balance(&settler, before);
        BatchSettled {
            settler,
            batch_id,
            root,
            claims: claims.len() as u32,
            gross: U128(gross),
            net: U128(net),
        }
        .emit();
    }

    /// The escape hatch: a payee settles its latest voucher with no settler and no offset.
    /// The claim needs the node's acceptance of that exact call, signed by a receipt key the Budget's settler
    /// registered, and accepted no later than the Budget's revoke or expiry. Without it an owner, who chooses the
    /// agent key, could sign vouchers to itself and empty the escrow ahead of the sellers the node accepted calls for.
    /// The owner is refused as payee here for the same reason.
    /// New storage is drawn from the Budget's storage reserve, then from the attached deposit.
    #[payable]
    pub fn settle_own(&mut self, claim: Claim, acceptance: Acceptance) {
        let mut budget = self.load_budget(&claim.budget_id);
        let ctx = self.require_payee(&claim, &budget);
        let payee = ctx.payee().clone();
        require!(now_ms() <= settle_deadline(&budget), BUDGET_CLOSED);

        let key = (claim.budget_id, claim.payee.clone());
        let prior = self.settled_amount(&key);
        let delta = self.verify_claim(&budget, &claim, prior);
        self.verify_acceptance(&budget, &claim, &acceptance);
        budget.spent = U128(add(budget.spent.0, delta));
        require!(budget.spent.0 <= budget.cap.0, CAP_EXCEEDED);
        require!(budget.escrow.0 >= delta, INSUFFICIENT_ESCROW);
        budget.escrow = U128(budget.escrow.0 - delta);

        // A credit entry created here is the Budget's when its reserve covers a whole pair, so the bytes go back to
        // the reserve when it is paid out. Otherwise the payee's deposit pays part of it and the entry has no funder.
        let reserve = budget.storage_reserve_bytes.0;
        let funder = (reserve >= PAIR_BYTES).then_some(Funder::Budget(claim.budget_id));
        let before = self.storage_mark();
        self.settled.insert(key, claim.cumulative.0);
        self.add_credit(&payee, delta, funder);
        let grown = self.storage_growth(before);
        let from_reserve = grown.min(reserve);
        budget.storage_reserve_bytes = U64(reserve - from_reserve);
        let charged = storage_cost(grown - from_reserve);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= charged, INSUFFICIENT_DEPOSIT);

        // The Budget record has a fixed width, so writing it back never grows storage.
        self.budgets.insert(claim.budget_id, budget);
        self.total_escrow = sub(self.total_escrow, delta);
        self.total_credits = add(self.total_credits, delta);
        refund(&payee, deposit - charged);
        ClaimSettledByPayee {
            budget_id: claim.budget_id,
            payee,
            cumulative: claim.cumulative,
            amount: U128(delta),
        }
        .emit();
    }
}

impl Hub {
    pub(crate) fn settled_amount(&self, key: &(Id32, AccountId)) -> u128 {
        self.settled.get(key).copied().unwrap_or(0)
    }

    /// Checks payee, signature, staleness and the per-call amount, and returns the delta over the settled amount.
    fn verify_claim(&self, budget: &Budget, claim: &Claim, prior: u128) -> u128 {
        require!(!self.is_reserved(&claim.payee), RESERVED_ACCOUNT);
        require!(
            budget.allow_any_payee || budget.payees.binary_search(&claim.payee).is_ok(),
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
        let delta = claim.cumulative.0 - prior;
        // `cumulative` is the authority. The signed price of the last call can be below the step, when earlier
        // vouchers were skipped, but never above it.
        require!(claim.amount.0 <= delta, AMOUNT_ABOVE_STEP);
        delta
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
}
