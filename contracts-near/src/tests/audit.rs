//! The internal audit's proofs of concept (docs/audit/2026-11-10-internal-audit.md), ported as regression tests.
//! A1 and A1b pin the hub's side of F1 and F2, whose fix is off-chain: the hub refuses a torsioned signature in both
//! settlement paths, before and after hub v2. Every other test failed against hub v1 and passes against hub v2.

use super::*;
use curve25519_dalek::constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION};
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::scalar::Scalar;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha512};

fn k_of(r: &[u8; 32], a: &[u8; 32], msg: &[u8]) -> Scalar {
    Scalar::from_hash(Sha512::new().chain_update(r).chain_update(a).chain_update(msg))
}

/// A signature that passes the cofactored (ZIP-215 / RFC 8032 cofactored) equation but not the cofactorless one
/// that `env::ed25519_verify` (ed25519-dalek `verify`) uses: R carries an 8-torsion component.
fn torsioned_sign(key: &SigningKey, msg: &[u8; 32]) -> [u8; 64] {
    let a = key.to_scalar();
    let a_bytes = key.verifying_key().to_bytes();
    let r = Scalar::from_bytes_mod_order([7u8; 32]);
    let big_r = ED25519_BASEPOINT_POINT * r + EIGHT_TORSION[1];
    let r_bytes = big_r.compress().to_bytes();
    let k = k_of(&r_bytes, &a_bytes, msg);
    let s = r + k * a;
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r_bytes);
    sig[32..].copy_from_slice(&s.to_bytes());
    // Cofactored equation holds: [8][s]B == [8](R + [k]A).
    let a_point = CompressedEdwardsY(a_bytes).decompress().unwrap();
    assert_eq!(
        (ED25519_BASEPOINT_POINT * s).mul_by_cofactor(),
        (big_r + a_point * k).mul_by_cofactor()
    );
    sig
}

fn voucher_digest_of(budget: &Id32, payee: &str, amount: u128, cumulative: u128, request: &Id32) -> [u8; 32] {
    voucher_digest(hub_id().as_str(), NET, budget, payee, amount, cumulative, request)
}

/// A voucher for `weak`, a small-order key, forged with no secret: s = 0 and R a torsion point equal to -[k]A.
/// About one request hash in eight admits one; the search finds it within 256 tries.
fn forge_for_small_order_key(weak_point: EdwardsPoint, budget: &Id32) -> Claim {
    let weak = weak_point.compress().to_bytes();
    for n in 0..=255u8 {
        let request = id(n);
        let digest = voucher_digest_of(budget, S, 50, 50, &request);
        for cand in EIGHT_TORSION.iter() {
            let r_bytes = cand.compress().to_bytes();
            let k = k_of(&r_bytes, &weak, &digest);
            if (-(weak_point * k)).compress().to_bytes() == r_bytes {
                let mut sig = [0u8; 64];
                sig[..32].copy_from_slice(&r_bytes);
                assert!(
                    near_sdk::env::ed25519_verify(&sig, digest, &weak),
                    "the forgery verifies under the host function"
                );
                return Claim {
                    budget_id: *budget,
                    payee: acct(S),
                    amount: U128(50),
                    cumulative: U128(50),
                    request_hash: request,
                    signature: Sig64(sig),
                };
            }
        }
    }
    panic!("no forgery within 256 tries")
}

// ---- A1 (F1): cofactored vs cofactorless ed25519, voucher side ----

#[test]
fn a1_torsioned_voucher_passes_cofactored_check_but_hub_rejects_it() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);

    let request = id(0xcd);
    let digest = voucher_digest_of(&a, S, 10, 10, &request);
    let sig = torsioned_sign(&key, &digest);

    // ed25519-dalek, which nearcore's host function uses, refuses it.
    let vk = VerifyingKey::from_bytes(&key.verifying_key().to_bytes()).unwrap();
    assert!(vk.verify(&digest, &Signature::from_bytes(&sig)).is_err());

    let bad = Claim {
        budget_id: a,
        payee: acct(S),
        amount: U128(10),
        cumulative: U128(10),
        request_hash: request,
        signature: Sig64(sig),
    };
    // A node that verifies cofactored would accept it, but neither settlement path takes it.
    let accepted = h.accept(&bad);
    let b2 = bad.clone();
    h.expect_code(BAD_SIGNATURE, |h| h.settle(id(1), vec![b2], entries(&[(A, S, 10)])));
    h.expect_code(BAD_SIGNATURE, |h| {
        h.ctx(acct(S), 0);
        h.hub.settle_own(bad, accepted);
    });
}

// ---- A1b (F2): the same divergence on the acceptance side ----

#[test]
fn a1b_torsioned_acceptance_is_rejected_by_settle_own() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);
    let c = claim(&a, S, &key, 10, 10);
    let ts = h.now_s();
    let digest = acceptance_digest(
        &c.budget_id,
        c.payee.as_str(),
        c.amount.0,
        c.cumulative.0,
        &c.request_hash,
        ts,
        &c.signature,
    );
    let sig = torsioned_sign(&node_key(), &digest);
    let acc = Acceptance {
        node_key: pk(&node_key()),
        timestamp_s: U64(ts),
        signature: Sig64(sig),
    };
    h.expect_code(BAD_ACCEPTANCE, |h| {
        h.ctx(acct(S), 0);
        h.hub.settle_own(c, acc);
    });
}

// ---- A2 (F3): a small-order agent key would let anyone forge vouchers, so the hub refuses it ----

#[test]
fn a2_small_order_agent_key_lets_anyone_forge_a_voucher() {
    let mut h = Harness::new();
    let t: EdwardsPoint = EIGHT_TORSION[1];
    let mut terms = h.terms(&agent(1), 1000, vec![]);
    terms.agent_pk = Id32(t.compress().to_bytes());

    // Why it matters: for the Budget id these terms would get, a voucher forged with no secret verifies.
    let would_be = budget_id(hub_id().as_str(), NET, A, &terms);
    let _forged = forge_for_small_order_key(t, &would_be);

    h.expect_code(INVALID_BUDGET, |h| {
        h.open(A, terms);
    });
}

#[test]
fn a2b_the_all_zero_public_key_is_a_small_order_point_the_hub_accepts_as_agent_pk() {
    let p = CompressedEdwardsY([0u8; 32]).decompress().expect("decompresses");
    assert!(p.is_small_order());
    let mut h = Harness::new();
    let mut terms = h.terms(&agent(1), 1000, vec![]);
    terms.agent_pk = Id32([0u8; 32]);
    h.expect_code(INVALID_BUDGET, |h| {
        h.open(A, terms);
    });
}

#[test]
fn a2c_small_order_receipt_keys_are_refused_too() {
    let mut h = Harness::new();
    for t in EIGHT_TORSION.iter() {
        let weak = Id32(t.compress().to_bytes());
        h.expect_code(INVALID_KEY, |h| {
            h.ctx(node(), 1);
            h.hub.register_receipt_key(weak);
        });
    }
}

// ---- A3 (F5): a revoke right after expiry no longer cuts the 3-day expiry grace to 24 hours ----

#[test]
fn a3_revoke_after_expiry_cuts_the_expiry_grace_to_24_hours() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);
    let c = claim(&a, S, &key, 10, 10);
    // The node accepted the call before expiry.
    let accepted = h.accept(&c);
    h.advance(DAY + 1); // expired; the grace runs to valid_until + 3 days
    h.expect_code(BUDGET_NOT_OPEN, |h| {
        h.ctx(acct(A), 0);
        h.hub.revoke_budget(a);
    });
    h.advance(2 * DAY); // two days after expiry, well past what a revoke could have cut it to
    h.expect_code(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.reclaim(a);
    });
    h.ctx(acct(S), 0);
    h.accounts.insert(acct(S));
    h.hub.settle_own(c, accepted);
    assert_eq!(h.hub.credit_of(acct(S)).0, 10);
    h.assert_solvent();
}

// ---- A4 (F6): batch ids belong to their settler ----

#[test]
fn a4_another_settler_can_squat_a_batch_id() {
    let mut h = Harness::new();
    let node2 = acct("node2.test");
    h.ctx(admin(), plenty());
    h.hub.set_settler(node2.clone(), true);
    h.ctx(acct("anyone.test"), plenty());
    h.hub.fund_storage(node2.clone());

    let mut t = h.terms(&agent(2), 1000, vec![]);
    t.settler = node2.clone();
    let b = h.open(B, t);
    h.deposit(B, &b, 1);
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 10);

    let shared_id = id(0x77);
    h.ctx(node2.clone(), 0);
    h.hub.settle_batch(
        shared_id,
        id(0x66),
        vec![claim(&b, S, &agent(2), 1, 1)],
        entries(&[(B, S, 1)]),
    );

    // The node's batch with the same id settles too, and each id resolves to its own settler's record.
    h.settle(shared_id, vec![claim(&a, S, &key, 10, 10)], entries(&[(A, S, 10)]));
    assert_eq!(h.hub.batch(node2.clone(), shared_id).unwrap().root, id(0x66));
    assert_eq!(h.hub.batch(node2, shared_id).unwrap().gross.0, 1);
    assert_eq!(h.batch(shared_id).unwrap().settler, node());
    assert_eq!(h.batch(shared_id).unwrap().gross.0, 10);
    // A settler's own id is still refused the second time.
    h.expect_code(BATCH_EXISTS, |h| {
        h.settle(shared_id, vec![claim(&a, S, &key, 1, 11)], entries(&[(A, S, 1)]));
    });
}

// ---- A5 (F4): dust claims no longer make the settler pay permanent storage ----

#[test]
fn a5_one_unit_claims_to_new_payees_cost_the_settler_permanent_storage() {
    let mut h = Harness::new();
    let key = agent(1);
    let mut t = h.terms(&key, 1_000_000, vec![]);
    t.max_payees = 100;
    let a = h.open(A, t);
    h.deposit(A, &a, 200);
    let reserve_before = h.budget(&a).storage_reserve_bytes.0;
    let payees: Vec<String> = (0..100u32).map(|i| format!("{i:064x}")).collect();
    let claims: Vec<Claim> = payees.iter().map(|p| claim(&a, p, &key, 1, 1)).collect();
    let lines: Vec<(&str, &str, u128)> = payees.iter().map(|p| (A, p.as_str(), 1u128)).collect();
    let before = h.storage_of("node.test");
    let usage = h.usage();
    h.settle(id(1), claims, entries(&lines));
    let grown = h.usage() - usage;

    // The settler paid for its batch record only; the owner's prepaid reserve paid for every payee.
    let paid = before - h.storage_of("node.test");
    let batch_bytes = 1 + 4 + "node.test".len() as u64 + 32 + 32 + 4 + "node.test".len() as u64 + 16 + 16 + 8 + 40;
    assert_eq!(paid, u128::from(batch_bytes) * byte_cost());
    let from_reserve = reserve_before - h.budget(&a).storage_reserve_bytes.0;
    assert_eq!(
        from_reserve + batch_bytes,
        grown,
        "every byte is paid by the reserve or the settler"
    );
    assert_eq!(
        from_reserve,
        100 * crate::PAIR_BYTES,
        "64-character payees cost exactly a pair each"
    );

    // A 101st new payee is beyond what the owner prepaid, and the batch is refused whole.
    let extra = format!("{:064x}", 1000);
    h.expect_code(INSUFFICIENT_RESERVE, |h| {
        h.settle(
            id(2),
            vec![claim(&a, &extra, &key, 1, 1)],
            entries(&[(A, extra.as_str(), 1)]),
        );
    });

    // None of the payees is registered at the token, so every payout fails and the entries stay, on the owner's bytes.
    let first: Vec<&str> = payees.iter().take(3).map(|s| s.as_str()).collect();
    h.payout(&first);
    for p in &first {
        h.finish_payout(p, 1, false);
    }
    assert_eq!(
        before - h.storage_of("node.test"),
        paid,
        "the settler paid nothing more"
    );
    h.assert_solvent();
}

// ---- A6 (F7): the signed per-call amount can no longer exceed the cumulative step ----

#[test]
fn a6_voucher_amount_is_not_bound_to_the_cumulative_delta() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 500);
    // A voucher that says "this call costs 401" while moving cumulative from 0 to 400.
    h.expect_code(AMOUNT_ABOVE_STEP, |h| {
        h.settle(id(1), vec![claim(&a, S, &key, 401, 400)], entries(&[(A, S, 400)]));
    });
    let over = claim(&a, S, &key, 401, 400);
    let accepted = h.accept(&over);
    h.expect_code(AMOUNT_ABOVE_STEP, |h| {
        h.ctx(acct(S), 0);
        h.hub.settle_own(over, accepted);
    });
    // `cumulative` stays the authority: a price below the step settles the whole step, as skipped vouchers need.
    h.settle(id(1), vec![claim(&a, S, &key, 1, 400)], entries(&[(A, S, 400)]));
    assert_eq!(h.hub.credit_of(acct(S)).0, 400);
    // Equal to the step is fine too.
    h.settle(id(2), vec![claim(&a, S, &key, 50, 450)], entries(&[(A, S, 50)]));
    assert_eq!(h.hub.credit_of(acct(S)).0, 450);
}
