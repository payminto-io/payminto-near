//! The hub v2 pre-audit's proofs of concept (docs/audit/2026-11-11-hub-v2-pre-audit.md), ported as regression tests
//! with the assertion that showed the bug inverted. P3 is a decision, not a fix: its test pins the documented
//! behaviour.

use super::*;

/// Sizes for a 64-character account.
const SETTLED_64: u64 = 157;
const CREDIT_BUDGET_64: u64 = 175;
const CREDIT_NONE_64: u64 = 142;

fn long(n: u32) -> String {
    format!("{n:064x}")
}

fn sent(receipt: &near_sdk::mock::Receipt) -> u128 {
    receipt
        .actions
        .iter()
        .map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

fn pay_msg(key: &SigningKey, payment_id: Id32, merchant: &str, amount: u128, expiry_ms: u64) -> String {
    let digest = checkout_digest(hub_id().as_str(), NET, &payment_id, merchant, amount, expiry_ms);
    format!(
        r#"{{"payment":{{"payment_id":"{}","merchant":"{}","amount":"{}","expiry_ms":"{}","signature":"{}"}}}}"#,
        payment_id.to_hex(),
        merchant,
        amount,
        expiry_ms,
        Sig64(key.sign(&digest).to_bytes()).to_hex()
    )
}

// ---- P1: settle_own never takes reserve bytes for an entry nobody owns ----

#[test]
fn p1_settle_own_after_a_payout_leaks_the_reserve_and_breaks_batches() {
    let mut h = Harness::new();
    let key = agent(1);
    let kb = agent(2);
    let p = long(7);
    let t = h.terms(&key, 1_000_000, vec![p.as_str()]);
    let a = h.open(A, t);
    h.deposit(A, &a, 1000);
    let tb = h.terms(&kb, 1_000_000, vec![S]);
    let b = h.open(B, tb);
    h.deposit(B, &b, 1000);

    // 1. The node settles a's first call to p: a whole pair comes out of the reserve.
    h.settle(id(1), vec![claim(&a, &p, &key, 1, 1)], entries(&[(A, p.as_str(), 1)]));
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, 0);

    // 2. Anyone pays p out; the credit entry's bytes go back to a's reserve.
    h.payout(&[p.as_str()]);
    h.finish_payout(&p, 1, true);
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, CREDIT_BUDGET_64);

    // 3. p settles its next voucher itself with zero deposit. The reserve pays for the credit entry, so the entry is
    // the Budget's.
    h.ctx(acct(&p), 0);
    h.own(claim(&a, &p, &key, 1, 2));
    assert_eq!(h.hub.credits.get(&acct(&p)).unwrap().funder, Some(Funder::Budget(a)));
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, 0);

    // 4. Paid out again: the bytes go back to the reserve.
    h.payout(&[p.as_str()]);
    h.finish_payout(&p, 1, true);
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, CREDIT_BUDGET_64);

    // 5. The node's next batch, which also carries an unrelated Budget b, settles.
    h.settle(
        id(2),
        vec![claim(&a, &p, &key, 1, 3), claim(&b, S, &kb, 1, 1)],
        entries(&[(A, p.as_str(), 1), (B, S, 1)]),
    );

    // 6. After the deadline, with p paid out, the owner gets back everything it prepaid.
    h.payout(&[p.as_str()]);
    h.finish_payout(&p, 1, true);
    h.advance(DAY + EXPIRY_GRACE_MS + 1);
    h.ctx(acct(A), 0);
    h.hub.prune(a, vec![acct(&p)]);
    let refunded = sent(&near_sdk::test_utils::get_created_receipts()[0]);
    assert_eq!(
        refunded,
        u128::from(crate::PAIR_BYTES) * byte_cost(),
        "the whole pair comes back"
    );
    assert_eq!(SETTLED_64 + CREDIT_BUDGET_64, crate::PAIR_BYTES);
    h.assert_solvent();
}

/// When the reserve cannot cover the credit entry, the payee's deposit pays for all of it and the reserve none of it,
/// so no entry is ever paid by a reserve and owned by nobody.
#[test]
fn p1_a_credit_entry_the_reserve_cannot_cover_is_paid_by_the_payee_alone() {
    let mut h = Harness::new();
    let key = agent(1);
    let p = long(7);
    let t = h.terms(&key, 1_000_000, vec![p.as_str()]);
    let a = h.open(A, t);
    h.deposit(A, &a, 1000);
    // The node settles, then the payee settles once more while its credit entry still exists: nothing new is written.
    h.settle(id(1), vec![claim(&a, &p, &key, 1, 1)], entries(&[(A, p.as_str(), 1)]));
    // Take a byte out of the reserve by hand, as if anything had: the reserve is now one byte short of a credit entry.
    h.payout(&[p.as_str()]);
    h.finish_payout(&p, 1, true);
    let mut budget = h.budget(&a);
    budget.storage_reserve_bytes = U64(CREDIT_BUDGET_64 - 1);
    h.hub.budgets.insert(a, budget);
    h.usage();

    let c = claim(&a, &p, &key, 1, 2);
    let owed = u128::from(CREDIT_NONE_64) * byte_cost();
    let unpaid = c.clone();
    h.expect_code(INSUFFICIENT_DEPOSIT, |h| {
        h.ctx(acct(&p), owed - 1);
        h.own(unpaid);
    });
    h.ctx(acct(&p), owed);
    h.accounts.insert(acct(&p));
    h.own(c);
    assert_eq!(h.hub.credits.get(&acct(&p)).unwrap().funder, None);
    assert_eq!(
        h.budget(&a).storage_reserve_bytes.0,
        CREDIT_BUDGET_64 - 1,
        "the reserve paid nothing"
    );
    h.assert_solvent();
}

/// The principal's conservation check: over batch, payout, settle_own, payout, batch, every byte the reserve gives
/// comes back, and `prune` returns the owner's prepayment in full.
#[test]
fn p1_the_reserve_is_conserved_over_mixed_settlement_and_returned_in_full_at_prune() {
    let mut h = Harness::new();
    let key = agent(1);
    let payees: Vec<String> = (0..3).map(long).collect();
    let t = h.terms(&key, 1_000_000, payees.iter().map(|s| s.as_str()).collect());
    let a = h.open(A, t);
    h.deposit(A, &a, 1000);
    let prepaid = h.budget(&a).storage_reserve_bytes.0;
    assert_eq!(prepaid, 3 * crate::PAIR_BYTES);
    let all: Vec<&str> = payees.iter().map(|s| s.as_str()).collect();
    let mut cumulative = 0u128;
    let mut batch = 0u8;
    let mut settle_all = |h: &mut Harness, cumulative: &mut u128| {
        *cumulative += 1;
        batch += 1;
        let claims = all.iter().map(|p| claim(&a, p, &key, 1, *cumulative)).collect();
        let lines: Vec<(&str, &str, u128)> = all.iter().map(|p| (A, *p, 1)).collect();
        h.settle(id(batch), claims, entries(&lines));
    };
    let pay_all = |h: &mut Harness| {
        let pending: Vec<(String, u128)> = all
            .iter()
            .map(|p| (p.to_string(), h.hub.credit_of(acct(p)).0))
            .collect();
        h.payout(&all);
        for (p, amount) in pending {
            h.finish_payout(&p, amount, true);
        }
    };
    for _ in 0..2 {
        settle_all(&mut h, &mut cumulative);
        pay_all(&mut h);
        cumulative += 1;
        for p in &all {
            h.ctx(acct(p), 0);
            h.accounts.insert(acct(p));
            h.own(claim(&a, p, &key, 1, cumulative));
        }
        pay_all(&mut h);
    }
    settle_all(&mut h, &mut cumulative);
    pay_all(&mut h);
    // With every credit entry paid out, only the settled entries hold reserve bytes.
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, prepaid - 3 * SETTLED_64);
    h.advance(DAY + EXPIRY_GRACE_MS + 1);
    h.ctx(acct(A), 0);
    h.hub.prune(a, all.iter().map(|p| acct(p)).collect());
    let refunded = sent(&near_sdk::test_utils::get_created_receipts()[0]);
    assert_eq!(
        refunded,
        u128::from(prepaid) * byte_cost(),
        "the owner gets its prepayment back in full"
    );
    h.assert_solvent();
}

// ---- P2: the checkout settler opts in ----

#[test]
fn p2_admin_redirects_checkout_storage_to_a_settler_and_drains_it() {
    let mut h = Harness::new();
    let victim = acct("node2.test");
    h.ctx(admin(), plenty());
    h.hub.set_settler(victim.clone(), true);
    h.ctx(victim.clone(), 2_000 * byte_cost());
    h.hub.fund_storage(victim.clone());
    let balance = h.storage_of("node2.test");

    // The admin names the victim as checkout settler, with a key only the admin holds. That is only a proposal.
    let admin_key = agent(77);
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(pk(&admin_key), victim.clone());
    assert_eq!(h.hub.checkout_settler(), None);
    assert_eq!(h.hub.checkout_key(), None);

    // Payments under the admin's key are refunded, and the victim's balance is untouched.
    let msg = pay_msg(&admin_key, id(1), "admin.test", 20_000, T0 + 1000);
    assert_eq!(h.transfer_in("admin.test", 20_000, &msg), 20_000);
    assert_eq!(h.storage_of("node2.test"), balance);

    // Only the named settler can accept, and only for the key that was proposed.
    for who in [admin(), node(), acct(S)] {
        h.expect_code(NOT_PENDING_CHECKOUT, |h| {
            h.ctx(who.clone(), 1);
            h.hub.accept_checkout(pk(&admin_key));
        });
    }
    h.expect_code(NOT_PENDING_CHECKOUT, |h| {
        h.ctx(victim.clone(), 1);
        h.hub.accept_checkout(pk(&agent(78)));
    });

    // The victim's batches keep working.
    let key = agent(3);
    let mut t = h.terms(&key, 1000, vec![S]);
    t.settler = victim.clone();
    let bud = h.open(A, t);
    h.deposit(A, &bud, 10);
    h.ctx(victim, 0);
    h.hub
        .settle_batch(id(1), id(0xee), vec![claim(&bud, S, &key, 1, 1)], entries(&[(A, S, 1)]));
    h.accounts.insert(acct(S));
    assert_eq!(h.hub.credit_of(admin()).0, 0);
    h.assert_solvent();
}

#[test]
fn p2_the_named_settler_accepts_and_a_removed_settler_takes_no_more_payments() {
    let mut h = Harness::new();
    let key = agent(50);
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(pk(&key), node());
    assert_eq!(h.hub.pending_checkout().unwrap().settler, node());
    h.expect_code(ONE_YOCTO_REQUIRED, |h| {
        h.ctx(node(), 0);
        h.hub.accept_checkout(pk(&key));
    });
    h.ctx(node(), 1);
    h.hub.accept_checkout(pk(&key));
    assert_eq!(h.hub.checkout_key(), Some(pk(&key)));
    assert_eq!(h.hub.checkout_settler(), Some(node()));
    assert_eq!(h.hub.pending_checkout(), None);

    let msg = pay_msg(&key, id(1), S, 20_000, T0 + 1000);
    assert_eq!(h.transfer_in("payer.test", 20_000, &msg), 0);
    h.accounts.insert(acct(S));

    // Once the settler is off the allowlist, its checkout takes no more payments.
    h.ctx(admin(), plenty());
    h.hub.set_settler(node(), false);
    let msg = pay_msg(&key, id(2), S, 20_000, T0 + 1000);
    assert_eq!(h.transfer_in("payer.test", 20_000, &msg), 20_000);
    h.assert_solvent();
}

// ---- P3: netting books an owner's offsetting earnings as escrow (documented, not changed) ----

#[test]
fn p3_netting_turns_an_owners_earnings_into_locked_escrow() {
    let run = |together: bool| -> (u128, u128) {
        let mut h = Harness::new();
        let (ka, kb) = (agent(1), agent(2));
        let a = h.open_simple(A, &ka, 1000);
        let b = h.open_simple(B, &kb, 1000);
        h.deposit(A, &a, 100);
        h.deposit(B, &b, 100);
        if together {
            h.settle(
                id(1),
                vec![claim(&a, S, &ka, 10, 10), claim(&b, A, &kb, 15, 15)],
                entries(&[(A, S, 10), (B, A, 15)]),
            );
        } else {
            h.settle(id(1), vec![claim(&a, S, &ka, 10, 10)], entries(&[(A, S, 10)]));
            h.settle(id(2), vec![claim(&b, A, &kb, 15, 15)], entries(&[(B, A, 15)]));
        }
        h.assert_solvent();
        (h.budget(&a).escrow.0, h.hub.credit_of(acct(A)).0)
    };
    // Documented in SECURITY.md and the README: in one batch, the 10 A earned offsets its own spending and stays escrow.
    assert_eq!(run(false), (90, 15));
    assert_eq!(run(true), (100, 5));
}

// ---- P4: max_payees is a count of distinct payees ----

#[test]
fn p4_max_payees_is_not_a_count_and_a_third_party_payout_breaks_the_next_batch() {
    let mut h = Harness::new();
    let (kx, ky) = (agent(1), agent(2));
    let mut tx = h.terms(&kx, 1000, vec![]);
    tx.max_payees = 1;
    let x = h.open(A, tx);
    let y = h.open_simple(B, &ky, 1000);
    h.deposit(A, &x, 100);
    h.deposit(B, &y, 100);
    let ps = ["p1.test", "p2.test", "p3.test"];
    h.settle(
        id(1),
        ps.iter().map(|p| claim(&y, p, &ky, 1, 1)).collect(),
        entries(&ps.iter().map(|p| (B, *p, 1u128)).collect::<Vec<_>>()),
    );
    // X, which declared at most one payee, cannot pay a second one.
    h.expect_code(TOO_MANY_PAYEES, |h| {
        h.settle(
            id(2),
            ps.iter().map(|p| claim(&x, p, &kx, 1, 1)).collect(),
            entries(&ps.iter().map(|p| (A, *p, 1u128)).collect::<Vec<_>>()),
        );
    });
    h.settle(
        id(2),
        vec![claim(&x, "p1.test", &kx, 1, 1)],
        entries(&[(A, "p1.test", 1)]),
    );
    assert_eq!(h.budget(&x).payees_paid, 1);
    // settle_own counts too.
    let second = claim(&x, "p2.test", &kx, 1, 1);
    let accepted = h.accept(&second);
    h.expect_code(TOO_MANY_PAYEES, |h| {
        h.ctx(acct("p2.test"), plenty());
        h.hub.settle_own(second, accepted);
    });
    // Anyone pays p1 out; X's next batch still settles, because X never relied on another Budget's entry.
    h.payout(&["p1.test"]);
    h.finish_payout("p1.test", 2, true);
    h.settle(
        id(3),
        vec![claim(&x, "p1.test", &kx, 1, 2), claim(&y, "p2.test", &ky, 1, 2)],
        entries(&[(A, "p1.test", 1), (B, "p2.test", 1)]),
    );
}

// ---- P5: a minimum checkout payment ----

#[test]
fn p5_payments_below_the_minimum_are_refunded_and_only_the_admin_sets_it() {
    let mut h = Harness::new();
    let key = agent(50);
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(pk(&key), node());
    h.ctx(node(), 1);
    h.hub.accept_checkout(pk(&key));
    assert_eq!(h.hub.config().min_payment.0, crate::DEFAULT_MIN_PAYMENT);
    assert_eq!(crate::DEFAULT_MIN_PAYMENT, 10_000);

    let balance = h.storage_of("node.test");
    let msg = pay_msg(&key, id(1), S, 9_999, T0 + 1000);
    assert_eq!(
        h.transfer_in("payer.test", 9_999, &msg),
        9_999,
        "below the minimum is refunded"
    );
    assert_eq!(h.storage_of("node.test"), balance, "and writes nothing");
    let msg = pay_msg(&key, id(1), S, 10_000, T0 + 1000);
    assert_eq!(h.transfer_in("payer.test", 10_000, &msg), 0);
    h.accounts.insert(acct(S));

    h.expect_code(NOT_ADMIN, |h| {
        h.ctx(node(), 1);
        h.hub.set_min_payment(U128(1));
    });
    h.expect_code(ZERO_AMOUNT, |h| {
        h.ctx(admin(), 1);
        h.hub.set_min_payment(U128(0));
    });
    h.ctx(admin(), 1);
    h.hub.set_min_payment(U128(1));
    assert_eq!(h.hub.config().min_payment.0, 1);
    let msg = pay_msg(&key, id(2), S, 1, T0 + 1000);
    assert_eq!(h.transfer_in("payer.test", 1, &msg), 0);
    h.assert_solvent();
}

// ---- P6: events ----

#[test]
fn p6_no_op_configuration_calls_log_nothing_and_reserve_moves_are_logged() {
    let mut h = Harness::new();
    h.ctx(admin(), plenty());
    h.hub.set_settler(node(), true);
    assert!(h.events().is_empty(), "the node was already a settler");
    h.ctx(admin(), plenty());
    h.hub.propose_admin(None);
    assert!(h.events().is_empty(), "nothing was pending");

    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);
    h.ctx(acct(S), 0);
    h.own(claim(&a, S, &key, 5, 5));
    let own = h.events();
    assert_eq!(
        own[0]["data"][0]["storage_reserve_bytes"],
        h.budget(&a).storage_reserve_bytes.0.to_string()
    );
    h.payout(&[S]);
    h.finish_payout(S, 5, true);
    let returned: Vec<_> = h
        .events()
        .into_iter()
        .filter(|e| e["event"] == "storage_reserve_returned")
        .collect();
    assert_eq!(returned.len(), 1);
    assert_eq!(returned[0]["data"][0]["budget_id"], a.to_hex());
    assert_eq!(
        returned[0]["data"][0]["storage_reserve_bytes"],
        h.budget(&a).storage_reserve_bytes.0.to_string()
    );
}

// ---- P8: terms a client can only get wrong ----

#[test]
fn p8_the_hub_or_the_token_as_settler_and_a_valid_until_not_in_milliseconds_are_refused() {
    let mut h = Harness::new();
    let key = agent(1);
    for settler in [hub_id(), token()] {
        let mut t = h.terms(&key, 1000, vec![S]);
        t.settler = settler;
        h.expect_code(INVALID_BUDGET, |h| {
            h.open(A, t);
        });
    }
    // A time in nanoseconds or microseconds is far past the bound; a time in milliseconds in a century is not.
    for valid_until in [h.now_ms * 1_000_000, h.now_ms * 1_000, crate::MAX_VALID_UNTIL_MS + 1] {
        let mut t = h.terms(&key, 1000, vec![S]);
        t.valid_until = U64(valid_until);
        h.expect_code(INVALID_BUDGET, |h| {
            h.open(A, t);
        });
    }
    let mut t = h.terms(&key, 1000, vec![S]);
    t.valid_until = U64(h.now_ms + 100 * 365 * DAY);
    h.open(A, t);
}
