//! Read-only methods. Anyone may call them, by decision.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

use crate::Hub;
#[allow(unused_imports)]
use crate::HubExt;
use crate::encoding::{receipt_leaf, verify_proof};
use crate::types::*;

#[near]
impl Hub {
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

    /// The batch `settler` settled under `batch_id`. Batch ids belong to their settler.
    pub fn batch(&self, settler: AccountId, batch_id: Id32) -> Option<BatchRecord> {
        self.batches.get(&(settler, batch_id)).cloned()
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

    /// The checkout key and settler the admin proposed, until that settler calls `accept_checkout`.
    pub fn pending_checkout(&self) -> Option<Checkout> {
        self.pending_checkout.clone()
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
            pending_admin: self.pending_admin.clone(),
            token: self.token.clone(),
            network: self.network.clone(),
            min_payment: U128(self.min_payment),
        }
    }

    /// Proves that a receipt with exactly these fields is in the committed Merkle root of the batch `settler`
    /// settled under `batch_id`. This proves inclusion only: the chain does not prove that a root covers every voucher.
    pub fn verify_receipt(&self, settler: AccountId, batch_id: Id32, fields: ReceiptFields, proof: Vec<Id32>) -> bool {
        let Some(batch) = self.batches.get(&(settler, batch_id)) else {
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
}
