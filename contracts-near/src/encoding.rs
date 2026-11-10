//! The canonical Borsh digests and Merkle hashing shared with `packages/chain`.
//! Every preimage is laid out to match that package, and the JSON vectors pin both sides together.

use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::env;

use crate::errors::ENCODING_FAILED;
use crate::types::{BudgetTerms, Id32, Sig64};

/// Borsh bytes of a preimage. Writing into a `Vec` cannot fail for these types; if it ever did, the hub panics with a
/// code rather than a library message.
fn encode<T: BorshSerialize>(value: &T) -> Vec<u8> {
    borsh::to_vec(value).unwrap_or_else(|_| env::panic_str(ENCODING_FAILED))
}

/// Above 2^31 so that a voucher preimage cannot parse as a Borsh-encoded NEAR transaction.
pub const VOUCHER_TAG: u32 = 2_147_504_402;
pub const CHECKOUT_TAG: u32 = 2_147_504_403;

pub const VOUCHER_DOMAIN: &str = "payminto.voucher.v1";
pub const BUDGET_DOMAIN: &str = "payminto.budget.v1";
pub const CHECKOUT_DOMAIN: &str = "payminto.checkout.v1";
pub const RECEIPT_DOMAIN: &str = "payminto.receipt.v1";
/// Text domains of the node's call id and of the acceptance it signs for each call it accepts.
pub const CALL_DOMAIN: &str = "payminto.call.v1";
pub const ACCEPTANCE_DOMAIN: &str = "payminto.accepted.v1";

pub const MAX_MERKLE_DEPTH: usize = 32;

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct VoucherPreimage<'a> {
    tag: u32,
    domain: &'a str,
    hub: &'a str,
    network: &'a str,
    budget_id: &'a [u8; 32],
    payee: &'a str,
    amount: u128,
    cumulative: u128,
    request_hash: &'a [u8; 32],
}

/// `sha256(borsh(tag, domain, hub, network, budget_id, payee, amount, cumulative, request_hash))`.
#[allow(clippy::too_many_arguments)]
pub fn voucher_digest(
    hub: &str,
    network: &str,
    budget_id: &Id32,
    payee: &str,
    amount: u128,
    cumulative: u128,
    request_hash: &Id32,
) -> [u8; 32] {
    env::sha256_array(encode(&VoucherPreimage {
        tag: VOUCHER_TAG,
        domain: VOUCHER_DOMAIN,
        hub,
        network,
        budget_id: &budget_id.0,
        payee,
        amount,
        cumulative,
        request_hash: &request_hash.0,
    }))
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct BudgetPreimage<'a> {
    domain: &'a str,
    hub: &'a str,
    network: &'a str,
    owner: &'a str,
    agent_pk: &'a [u8; 32],
    settler: &'a str,
    cap: u128,
    valid_until: u64,
    payees: Vec<&'a str>,
    policy_hash: &'a [u8; 32],
    salt: &'a [u8; 32],
}

/// The Budget id for canonical terms: `payees` must already be sorted and deduplicated.
pub fn budget_id(hub: &str, network: &str, owner: &str, terms: &BudgetTerms) -> Id32 {
    Id32(env::sha256_array(encode(&BudgetPreimage {
        domain: BUDGET_DOMAIN,
        hub,
        network,
        owner,
        agent_pk: &terms.agent_pk.0,
        settler: terms.settler.as_str(),
        cap: terms.cap.0,
        valid_until: terms.valid_until.0,
        payees: terms.payees.iter().map(|p| p.as_str()).collect(),
        policy_hash: &terms.policy_hash.0,
        salt: &terms.salt.0,
    })))
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct CheckoutPreimage<'a> {
    tag: u32,
    domain: &'a str,
    hub: &'a str,
    network: &'a str,
    payment_id: &'a [u8; 32],
    merchant: &'a str,
    amount: u128,
    expiry_ms: u64,
}

pub fn checkout_digest(
    hub: &str,
    network: &str,
    payment_id: &Id32,
    merchant: &str,
    amount: u128,
    expiry_ms: u64,
) -> [u8; 32] {
    env::sha256_array(encode(&CheckoutPreimage {
        tag: CHECKOUT_TAG,
        domain: CHECKOUT_DOMAIN,
        hub,
        network,
        payment_id: &payment_id.0,
        merchant,
        amount,
        expiry_ms,
    }))
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct LeafPreimage<'a> {
    domain: &'a str,
    hub: &'a str,
    network: &'a str,
    batch_id: &'a [u8; 32],
    call_id: &'a [u8; 32],
    budget_id: &'a [u8; 32],
    payee: &'a str,
    amount: u128,
    cumulative: u128,
    request_hash: &'a [u8; 32],
    timestamp_ms: u64,
    voucher_sig: &'a [u8; 64],
}

#[allow(clippy::too_many_arguments)]
pub fn receipt_leaf(
    hub: &str,
    network: &str,
    batch_id: &Id32,
    call_id: &Id32,
    budget_id: &Id32,
    payee: &str,
    amount: u128,
    cumulative: u128,
    request_hash: &Id32,
    timestamp_ms: u64,
    voucher_sig: &[u8; 64],
) -> [u8; 32] {
    let body = encode(&LeafPreimage {
        domain: RECEIPT_DOMAIN,
        hub,
        network,
        batch_id: &batch_id.0,
        call_id: &call_id.0,
        budget_id: &budget_id.0,
        payee,
        amount,
        cumulative,
        request_hash: &request_hash.0,
        timestamp_ms,
        voucher_sig,
    });
    let mut preimage = Vec::with_capacity(body.len() + 1);
    preimage.push(0x00);
    preimage.extend_from_slice(&body);
    env::sha256_array(preimage)
}

/// The node's id for one call: `sha256` of the text `payminto.call.v1|budget_id|payee|cumulative|request_hash`.
/// Ids are lowercase hex and the number is decimal, exactly as the node writes them.
pub fn call_id(budget_id: &Id32, payee: &str, cumulative: u128, request_hash: &Id32) -> Id32 {
    Id32(env::sha256_array(
        format!(
            "{CALL_DOMAIN}|{}|{payee}|{cumulative}|{}",
            budget_id.to_hex(),
            request_hash.to_hex()
        )
        .as_bytes(),
    ))
}

/// What the node signs when it accepts a call: `sha256` of the text
/// `payminto.accepted.v1|call_id|budget_id|payee|amount|cumulative|request_hash|timestamp|voucher_sig`.
/// `timestamp_s` is Unix seconds. No field can contain `|`, and each has one text form, so the text is unambiguous.
#[allow(clippy::too_many_arguments)]
pub fn acceptance_digest(
    budget_id: &Id32,
    payee: &str,
    amount: u128,
    cumulative: u128,
    request_hash: &Id32,
    timestamp_s: u64,
    voucher_sig: &Sig64,
) -> [u8; 32] {
    let budget = budget_id.to_hex();
    let request = request_hash.to_hex();
    env::sha256_array(
        format!(
            "{ACCEPTANCE_DOMAIN}|{}|{budget}|{payee}|{amount}|{cumulative}|{request}|{timestamp_s}|{}",
            call_id(budget_id, payee, cumulative, request_hash).to_hex(),
            voucher_sig.to_hex()
        )
        .as_bytes(),
    )
}

/// `sha256(0x01 || min(a, b) || max(a, b))`.
pub fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut preimage = [0u8; 65];
    preimage[0] = 0x01;
    preimage[1..33].copy_from_slice(lo);
    preimage[33..65].copy_from_slice(hi);
    env::sha256_array(preimage)
}

/// Folds a proof over a leaf and compares the result with the root.
/// Over-deep proofs are refused before hashing.
pub fn verify_proof(root: &[u8; 32], leaf: [u8; 32], proof: &[Id32]) -> bool {
    if proof.len() > MAX_MERKLE_DEPTH {
        return false;
    }
    let computed = proof.iter().fold(leaf, |acc, sibling| hash_pair(&acc, &sibling.0));
    &computed == root
}

/// Builds the Merkle root of leaves already sorted by `call_id`, promoting odd nodes.
#[cfg(test)]
pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| {
                if pair.len() == 2 {
                    hash_pair(&pair[0], &pair[1])
                } else {
                    pair[0]
                }
            })
            .collect();
    }
    level[0]
}

/// Builds the proof for the leaf at `index` in a tree built by [`merkle_root`].
#[cfg(test)]
pub fn merkle_proof(leaves: &[[u8; 32]], mut index: usize) -> Vec<Id32> {
    let mut proof = Vec::new();
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        let sibling = if index.is_multiple_of(2) { index + 1 } else { index - 1 };
        if sibling < level.len() {
            proof.push(Id32(level[sibling]));
        }
        level = level
            .chunks(2)
            .map(|pair| {
                if pair.len() == 2 {
                    hash_pair(&pair[0], &pair[1])
                } else {
                    pair[0]
                }
            })
            .collect();
        index /= 2;
    }
    proof
}
