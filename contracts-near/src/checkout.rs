//! Hosted-checkout payments.
//!
//! Invariant owned here: a token transfer credits a merchant only under terms the checkout key signed for exactly
//! that payment id, merchant, amount and expiry, each payment id is accepted once, and no payment is below the
//! minimum. The checkout settler's storage balance pays for the records, and only a settler that accepted the role
//! itself, and is still allowlisted, can be the checkout settler; a payment it cannot cover is refunded in full.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env, near, require};

#[allow(unused_imports)]
use crate::HubExt;
use crate::crypto::{is_acceptable_public_key, verify_signature};
use crate::encoding::checkout_digest;
use crate::errors::*;
use crate::events::{CheckoutKeyProposed, CheckoutKeySet, MinPaymentSet, PaymentReceived};
use crate::storage::borsh_len;
use crate::types::*;
use crate::{Hub, now_ms};

#[near]
impl Hub {
    /// Proposes the node key that signs checkout terms, and the allowlisted settler whose storage balance would pay
    /// for the payments accepted under those terms. Nothing changes until that settler calls `accept_checkout`, so
    /// the admin can never spend a settler's storage balance without its consent. This grants no access to funds.
    #[payable]
    pub fn set_checkout_key(&mut self, key: Id32, settler: AccountId) {
        let ctx = self.require_admin();
        require!(self.settlers.contains(&settler), NOT_SETTLER);
        require!(is_acceptable_public_key(&key.0), INVALID_KEY);
        // The proposal lives in the contract's root record, which is written after this method returns, so its growth
        // is the change in its serialized length.
        let before = borsh_len(&self.pending_checkout);
        self.pending_checkout = Some(Checkout {
            key,
            settler: settler.clone(),
        });
        let after = borsh_len(&self.pending_checkout);
        self.charge_deposit_keep_one(ctx.admin(), after.saturating_sub(before));
        CheckoutKeyProposed { key, settler }.emit();
    }

    /// The proposed settler takes the checkout role for exactly the key it names, which must be the proposed key.
    /// Exactly one yoctoNEAR, so only the settler's full-access key can accept. The root record never grows here: the
    /// proposal moves into place.
    #[payable]
    pub fn accept_checkout(&mut self, key: Id32) {
        let ctx = self.require_pending_checkout_settler();
        let proposed = self
            .pending_checkout
            .take()
            .unwrap_or_else(|| env::panic_str(NOT_PENDING_CHECKOUT));
        require!(proposed.key == key, NOT_PENDING_CHECKOUT);
        require!(self.settlers.contains(ctx.settler()), NOT_SETTLER);
        self.checkout = Some(proposed);
        CheckoutKeySet {
            key,
            settler: ctx.settler().clone(),
        }
        .emit();
    }

    /// Sets the smallest checkout payment the hub accepts, in token base units. A fixed-width field: no storage.
    #[payable]
    pub fn set_min_payment(&mut self, amount: U128) {
        let _ctx = self.require_admin();
        require!(amount.0 > 0, ZERO_AMOUNT);
        if self.min_payment != amount.0 {
            self.min_payment = amount.0;
            MinPaymentSet { amount }.emit();
        }
    }
}

impl Hub {
    /// A payment under signed checkout terms. Any mismatch returns `false`, and the token refunds the payer.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn accept_payment(
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
            || amount < self.min_payment
            || !self.settlers.contains(&checkout.settler)
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
        self.add_credit(&merchant, amount, Some(Funder::Settler(checkout.settler.clone())));
        self.total_credits = total;
        self.payments.insert(
            payment_id,
            PaymentRecord {
                merchant: merchant.clone(),
                amount: U128(amount),
                payer: payer.clone(),
                at: U64(now),
            },
        );
        // The settler that signed the terms pays for the record. A panic here undoes the writes above, and the token
        // then refunds the payer.
        self.charge_storage_balance(&checkout.settler, before);
        PaymentReceived {
            payment_id,
            merchant,
            amount: U128(amount),
            payer: payer.clone(),
        }
        .emit();
        true
    }
}
