//! Hub v2 rules beyond the audit's proofs of concept: key validation, explicit payee terms, owner-paid settlement
//! storage and `prune`, the two-step admin transfer, and the storage balance refusals.

use super::*;
use crate::crypto::{SMALL_ORDER_Y, has_small_order, is_acceptable_public_key, is_canonical};
use curve25519_dalek::constants::EIGHT_TORSION;

// ---- keys (F3) ----

#[test]
fn small_order_list_is_exactly_the_eight_torsion_points() {
    let mut ys: Vec<[u8; 32]> = EIGHT_TORSION
        .iter()
        .map(|t| {
            let mut y = t.compress().to_bytes();
            y[31] &= 0x7f;
            y
        })
        .collect();
    ys.sort();
    ys.dedup();
    let mut listed = SMALL_ORDER_Y.to_vec();
    listed.sort();
    assert_eq!(ys, listed);
    for t in EIGHT_TORSION.iter() {
        let mut bytes = t.compress().to_bytes();
        assert!(has_small_order(&bytes) && !is_acceptable_public_key(&bytes));
        // The other sign is refused too.
        bytes[31] ^= 0x80;
        assert!(has_small_order(&bytes) && !is_acceptable_public_key(&bytes));
    }
}

#[test]
fn ordinary_keys_are_accepted_and_non_canonical_encodings_refused() {
    for n in 1..=255u8 {
        assert!(
            is_acceptable_public_key(&agent(n).verifying_key().to_bytes()),
            "key {n}"
        );
    }
    // y = p + k for k < 19 encodes the same y as k, and is never canonical.
    for k in 0..19u8 {
        let mut y = [0xffu8; 32];
        y[0] = 0xed + k;
        y[31] = 0x7f;
        assert!(!is_canonical(&y), "p + {k}");
        assert!(!is_acceptable_public_key(&y));
    }
    let mut below = [0xffu8; 32];
    below[0] = 0xec;
    below[31] = 0x7f;
    assert!(is_canonical(&below), "p - 1 is canonical (and of order 2)");
    let mut high = [0xffu8; 32];
    assert!(!is_canonical(&high));
    high[31] = 0x7f;
    assert!(!is_canonical(&high));
}

#[test]
fn non_canonical_agent_receipt_and_checkout_keys_are_refused() {
    let mut h = Harness::new();
    let mut bad = [0xffu8; 32];
    bad[31] = 0x7f;
    let mut t = h.terms(&agent(1), 1000, vec![]);
    t.agent_pk = Id32(bad);
    h.expect_code(INVALID_BUDGET, |h| {
        h.open(A, t);
    });
    h.expect_code(INVALID_KEY, |h| {
        h.ctx(node(), 1);
        h.hub.register_receipt_key(Id32(bad));
    });
    h.expect_code(INVALID_KEY, |h| {
        h.ctx(admin(), plenty());
        h.hub.set_checkout_key(Id32([0; 32]), node());
    });
}

// ---- explicit payee terms (hardening item 12) ----

#[test]
fn an_empty_list_alone_never_means_any_payee() {
    let mut h = Harness::new();
    let key = agent(1);
    let refused = |h: &mut Harness, f: &dyn Fn(&mut BudgetTerms)| {
        let mut t = h.terms(&key, 1000, vec![S]);
        f(&mut t);
        h.expect_code(INVALID_BUDGET, |h| {
            h.open(A, t);
        });
    };
    refused(&mut h, &|t| t.payees.clear()); // no list and no flag
    refused(&mut h, &|t| t.max_payees = 1); // max_payees is only for allow_any_payee
    refused(&mut h, &|t| t.allow_any_payee = true); // a flag and a list
    refused(&mut h, &|t| {
        t.payees.clear();
        t.allow_any_payee = true;
        t.max_payees = 0;
    });
    refused(&mut h, &|t| {
        t.payees.clear();
        t.allow_any_payee = true;
        t.max_payees = crate::MAX_ANY_PAYEES + 1;
    });
    refused(&mut h, &|t| {
        t.payees = (0..17).map(|i| acct(&format!("p{i}.test"))).collect()
    });

    let mut t = h.terms(&key, 1000, vec![]);
    t.max_payees = crate::MAX_ANY_PAYEES;
    let any = h.open(A, t);
    assert!(h.budget(&any).allow_any_payee);
    assert_eq!(
        h.budget(&any).storage_reserve_bytes.0,
        u64::from(crate::MAX_ANY_PAYEES) * crate::PAIR_BYTES
    );
    let listed = h.open_with_payees(B, &key, vec![S, "x.test"]);
    assert!(!h.budget(&listed).allow_any_payee);
    assert_eq!(h.budget(&listed).storage_reserve_bytes.0, 2 * crate::PAIR_BYTES);
}

impl Harness {
    fn open_with_payees(&mut self, owner: &str, key: &SigningKey, payees: Vec<&str>) -> Id32 {
        let t = self.terms(key, 1000, payees);
        self.open(owner, t)
    }
}

#[test]
fn open_budget_charges_the_record_a_revoke_and_every_payee_pair() {
    let mut h = Harness::new();
    let key = agent(1);
    let t = h.terms(&key, 1000, vec![S, "x.test", "y.test"]);
    let deposit = plenty();
    h.ctx(acct(A), deposit);
    let before = h.usage();
    let a = h.hub.open_budget(t);
    let record = h.usage() - before;
    let kept = deposit - transferred(&near_sdk::test_utils::get_created_receipts()[0]);
    assert_eq!(
        kept,
        u128::from(record + REVOKE_BYTES + 3 * crate::PAIR_BYTES) * byte_cost()
    );
    h.ctx(
        acct(A),
        u128::from(record + REVOKE_BYTES + 3 * crate::PAIR_BYTES) * byte_cost() - 1,
    );
    let t2 = h.terms(&key, 1000, vec![S, "x.test", "y.test"]);
    h.expect_code(INSUFFICIENT_DEPOSIT, |h| {
        h.hub.open_budget(t2);
    });
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, 3 * crate::PAIR_BYTES);
}

fn transferred(receipt: &near_sdk::mock::Receipt) -> u128 {
    receipt
        .actions
        .iter()
        .map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

// ---- owner-paid settlement storage (F4) ----

#[test]
fn each_budget_pays_its_own_new_pairs_and_the_settler_only_its_batch_record() {
    let mut h = Harness::new();
    let (ka, kb) = (agent(1), agent(2));
    let a = h.open_simple(A, &ka, 1000);
    let b = h.open_simple(B, &kb, 1000);
    h.deposit(A, &a, 100);
    h.deposit(B, &b, 100);
    let (ra, rb) = (
        h.budget(&a).storage_reserve_bytes.0,
        h.budget(&b).storage_reserve_bytes.0,
    );
    let node_before = h.storage_of("node.test");
    let usage = h.usage();
    // A pays S and T; B pays S (an existing pair in this batch for S's credit entry, which A's claim created first).
    h.settle(
        id(1),
        vec![
            claim(&a, S, &ka, 5, 5),
            claim(&a, "t.test", &ka, 5, 5),
            claim(&b, S, &kb, 5, 5),
        ],
        entries(&[(A, S, 5), (A, "t.test", 5), (B, S, 5)]),
    );
    let grown = h.usage() - usage;
    let settled = |payee: &str| 1 + 32 + 4 + payee.len() as u64 + 16 + 40;
    let credit_by_budget = |payee: &str| 1 + 4 + payee.len() as u64 + 16 + 16 + 1 + 1 + 32 + 40;
    let batch = 1 + 4 + 9 + 32 + 32 + 4 + 9 + 16 + 16 + 8 + 40;
    let used_a = ra - h.budget(&a).storage_reserve_bytes.0;
    let used_b = rb - h.budget(&b).storage_reserve_bytes.0;
    assert_eq!(
        used_a,
        settled(S) + settled("t.test") + credit_by_budget(S) + credit_by_budget("t.test")
    );
    assert_eq!(used_b, settled(S), "S's credit entry is A's: A's claim to S came first");
    assert_eq!(node_before - h.storage_of("node.test"), u128::from(batch) * byte_cost());
    assert_eq!(grown, used_a + used_b + batch, "the hub paid for nothing");

    // Paying S out removes its entry and returns the bytes to A's reserve, which paid for them.
    h.payout(&[S]);
    h.finish_payout(S, 10, true);
    assert_eq!(ra - h.budget(&a).storage_reserve_bytes.0, used_a - credit_by_budget(S));
    h.assert_solvent();
}

#[test]
fn a_listed_budget_of_sixteen_long_payees_never_runs_out_of_reserve() {
    let mut h = Harness::new();
    let key = agent(1);
    let payees: Vec<String> = (0..16u32).map(|i| format!("{i:064x}")).collect();
    let t = h.terms(&key, 1_000_000, payees.iter().map(|s| s.as_str()).collect());
    let a = h.open(A, t);
    h.deposit(A, &a, 1000);
    let claims: Vec<Claim> = payees.iter().map(|p| claim(&a, p, &key, 1, 1)).collect();
    let lines: Vec<(&str, &str, u128)> = payees.iter().map(|p| (A, p.as_str(), 1u128)).collect();
    h.settle(id(1), claims, entries(&lines));
    assert_eq!(
        h.budget(&a).storage_reserve_bytes.0,
        0,
        "exactly a pair per listed payee"
    );
    // Later claims to the same payees write nothing new.
    let claims: Vec<Claim> = payees.iter().map(|p| claim(&a, p, &key, 1, 2)).collect();
    h.settle(id(2), claims, entries(&lines));
}

#[test]
fn settle_own_draws_on_the_same_reserve_and_marks_the_credit_entry_as_the_budgets() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_with_payees(A, &key, vec![S]);
    h.deposit(A, &a, 100);
    h.ctx(acct(S), 0);
    h.own(claim(&a, S, &key, 5, 5));
    assert_eq!(
        h.budget(&a).storage_reserve_bytes.0,
        crate::PAIR_BYTES - (157 - 64 + 11) - (175 - 64 + 11)
    );
    assert_eq!(h.hub.credits.get(&acct(S)).unwrap().funder, Some(Funder::Budget(a)));
}

// ---- prune (F4, hardening item 10) ----

#[test]
fn prune_after_the_deadline_refunds_freed_bytes_and_the_unused_reserve_to_the_owner() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);
    h.settle(id(1), vec![claim(&a, S, &key, 5, 5)], entries(&[(A, S, 5)]));
    h.expect_code(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.prune(a, vec![acct(S)]);
    });
    h.expect_code(TOO_MANY_ACCOUNTS, |h| {
        h.ctx(acct(A), 0);
        h.hub.prune(
            a,
            (0..=crate::MAX_PRUNE_PAYEES)
                .map(|i| acct(&format!("p{i}.test")))
                .collect(),
        );
    });

    h.advance(DAY + EXPIRY_GRACE_MS + 1);
    let reserve = h.budget(&a).storage_reserve_bytes.0;
    let usage = h.usage();
    h.ctx(acct(A), 0);
    h.hub.prune(a, vec![acct(S), acct("never-paid.test")]);
    let freed = usage - h.usage();
    assert_eq!(freed, 1 + 32 + 4 + S.len() as u64 + 16 + 40);
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(receipts[0].receiver_id, acct(A));
    assert_eq!(transferred(&receipts[0]), u128::from(freed + reserve) * byte_cost());
    assert_eq!(h.hub.settled_of(a, acct(S)).0, 0);
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, 0);

    // The record stays: the id can never be opened again, so the old vouchers can never settle twice.
    assert!(h.hub.budget(a).is_some());

    // S's credit entry was the Budget's. Paid out later, its bytes return to the reserve, and a second prune refunds them.
    h.payout(&[S]);
    h.finish_payout(S, 5, true);
    let back = h.budget(&a).storage_reserve_bytes.0;
    assert_eq!(back, 1 + 4 + S.len() as u64 + 16 + 16 + 1 + 1 + 32 + 40);
    h.ctx(acct(A), 0);
    h.hub.prune(a, vec![]);
    assert_eq!(
        transferred(&near_sdk::test_utils::get_created_receipts()[0]),
        u128::from(back) * byte_cost()
    );
    h.assert_solvent();
}

#[test]
fn prune_after_a_revoke_waits_for_the_revoke_grace_only() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    h.advance(REVOKE_GRACE_MS);
    h.expect_code(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.prune(a, vec![]);
    });
    h.advance(1);
    h.ctx(acct(A), 0);
    h.hub.prune(a, vec![]);
    // After the deadline nothing reopens the Budget: no deposit, no revoke, no settlement.
    assert_eq!(h.transfer_in(A, 5, &budget_msg(&a)), 5);
    h.expect_code(ALREADY_REVOKED, |h| {
        h.ctx(acct(A), 0);
        h.hub.revoke_budget(a);
    });
}

// ---- revoke (F5) ----

#[test]
fn revoke_is_allowed_up_to_valid_until_inclusive() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.advance(DAY);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    assert_eq!(h.budget(&a).revoked_at.unwrap().0, T0 + DAY);
}

// ---- storage balances (hardening item 9) ----

#[test]
fn fund_storage_refuses_the_hub_and_the_token() {
    let mut h = Harness::new();
    for reserved in [hub_id(), token()] {
        h.expect_code(RESERVED_ACCOUNT, |h| {
            h.ctx(acct("anyone.test"), plenty());
            h.hub.fund_storage(reserved.clone());
        });
    }
}

// ---- admin transfer (hardening item 14) ----

#[test]
fn the_admin_moves_in_two_steps_and_only_to_an_account_that_accepts() {
    let mut h = Harness::new();
    let next = acct("next-admin.test");
    h.expect_code(ADMIN_IS_HUB, |h| {
        h.ctx(admin(), plenty());
        h.hub.propose_admin(Some(hub_id()));
    });
    h.ctx(admin(), plenty());
    h.hub.propose_admin(Some(next.clone()));
    assert_eq!(h.hub.config().pending_admin, Some(next.clone()));
    // Proposing changes nothing yet.
    assert_eq!(h.hub.config().admin, admin());
    // The admin can withdraw the proposal.
    h.ctx(admin(), plenty());
    h.hub.propose_admin(None);
    h.expect_code(NOT_PENDING_ADMIN, |h| {
        h.ctx(next.clone(), 1);
        h.hub.accept_admin();
    });
    h.ctx(admin(), plenty());
    h.hub.propose_admin(Some(next.clone()));
    h.ctx(next.clone(), 1);
    h.hub.accept_admin();
    assert_eq!(h.hub.config().admin, next);
    assert_eq!(h.hub.config().pending_admin, None);
    h.expect_code(NOT_ADMIN, |h| {
        h.ctx(admin(), plenty());
        h.hub.set_settler(acct("x.test"), true);
    });
    h.ctx(next, plenty());
    h.hub.set_settler(acct("x.test"), true);
    assert!(h.hub.is_settler(acct("x.test")));
}

#[test]
fn proposing_an_admin_charges_the_root_record_growth_to_the_admin() {
    let mut h = Harness::new();
    let next = acct("next-admin.test");
    let deposit = plenty();
    h.ctx(admin(), deposit);
    h.hub.propose_admin(Some(next.clone()));
    let refunded = transferred(&near_sdk::test_utils::get_created_receipts()[0]);
    assert_eq!(deposit - refunded, u128::from(4 + next.len() as u64) * byte_cost());
}
