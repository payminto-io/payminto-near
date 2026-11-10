//! Behavior of each hub method, with the solvency invariant checked after every scenario.

use super::*;

fn one_budget(h: &mut Harness, escrow: u128, cap: u128) -> Id32 {
    let key = agent(1);
    let b = h.open_simple(A, &key, cap);
    if escrow > 0 {
        h.deposit(A, &b, escrow);
    }
    b
}

fn pair(h: &mut Harness, escrow_a: u128, escrow_b: u128) -> (Id32, Id32) {
    let a = h.open_simple(A, &agent(1), 1000);
    let b = h.open_simple(B, &agent(2), 1000);
    if escrow_a > 0 {
        h.deposit(A, &a, escrow_a);
    }
    if escrow_b > 0 {
        h.deposit(B, &b, escrow_b);
    }
    (a, b)
}

// ---- open_budget ----

#[test]
fn open_sets_cap_and_zero_escrow_and_deposit_raises_escrow_only() {
    let mut h = Harness::new();
    let b = h.open_simple(A, &agent(1), 500);
    let budget = h.budget(&b);
    assert_eq!((budget.cap.0, budget.spent.0, budget.escrow.0), (500, 0, 0));
    assert_eq!(budget.owner, acct(A));
    assert_eq!(budget.settler, node());
    h.deposit(A, &b, 80);
    let budget = h.budget(&b);
    assert_eq!((budget.cap.0, budget.escrow.0), (500, 80));
    h.assert_solvent();
}

#[test]
fn open_uses_predecessor_as_owner_for_dao_style_callers() {
    let mut h = Harness::new();
    let dao = "treasury.sputnik-dao.test";
    let t = h.terms(&agent(1), 100, vec![]);
    let mut b = VMContextBuilder::new();
    // The signer is a council member and the predecessor is the DAO, so no key belongs to the owner.
    b.current_account_id(hub_id())
        .signer_account_id(acct("member.test"))
        .predecessor_account_id(acct(dao))
        .block_timestamp(h.now_ms * 1_000_000)
        .account_balance(NearToken::from_near(1_000))
        .storage_usage(near_sdk::env::storage_usage())
        .attached_deposit(NearToken::from_near(1))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
    let id = h.hub.open_budget(t);
    h.budgets.push(id);
    h.accounts.insert(acct(dao));
    assert_eq!(h.budget(&id).owner, acct(dao));

    h.deposit(dao, &id, 7);
    assert_eq!(h.budget(&id).escrow.0, 7);

    // Revoke also keys on the predecessor.
    h.ctx(acct(dao), 0);
    h.hub.revoke_budget(id);
    assert!(h.budget(&id).revoked_at.is_some());
    h.assert_solvent();
}

#[test]
fn open_rejects_invalid_terms_and_duplicates() {
    let mut h = Harness::new();
    let key = agent(1);
    let mut t = h.terms(&key, 0, vec![]);
    h.expect_err(INVALID_BUDGET, |h| {
        h.open(A, t.clone());
    });
    t = h.terms(&key, 100, vec![]);
    t.valid_until = U64(T0);
    h.expect_err(INVALID_BUDGET, |h| {
        h.open(A, t.clone());
    });
    t = h.terms(&key, 100, vec![]);
    t.valid_until = U64(u64::MAX);
    h.expect_err(INVALID_BUDGET, |h| {
        h.open(A, t.clone());
    });
    let many: Vec<String> = (0..17).map(|i| format!("p{i}.test")).collect();
    let refs: Vec<&str> = many.iter().map(|s| s.as_str()).collect();
    t = h.terms(&key, 100, refs);
    h.expect_err(INVALID_BUDGET, |h| {
        h.open(A, t.clone());
    });
    let terms = h.terms(&key, 100, vec![]);
    h.open(A, terms.clone());
    h.expect_err(BUDGET_EXISTS, |h| {
        h.open(A, terms.clone());
    });
}

#[test]
fn open_charges_storage_and_refunds_the_excess() {
    let mut h = Harness::new();
    let terms = h.terms(&agent(1), 100, vec![]);
    h.ctx(acct(A), 1);
    let t = terms.clone();
    h.expect_err(INSUFFICIENT_DEPOSIT, |h| {
        h.hub.open_budget(t);
    });

    let deposit = NearToken::from_near(1).as_yoctonear();
    let fresh = h.terms(&agent(1), 100, vec![]);
    h.ctx(acct(A), deposit);
    let id = h.hub.open_budget(fresh);
    h.budgets.push(id);
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(receipts.len(), 1, "excess deposit is refunded");
    assert_eq!(receipts[0].receiver_id, acct(A));
}

#[test]
fn open_canonicalizes_payees_so_the_id_matches_the_client() {
    let mut h = Harness::new();
    let mut t = h.terms(&agent(1), 100, vec!["b.test", "a.test", "b.test"]);
    let id = h.open(A, t.clone());
    t.payees = vec![acct("a.test"), acct("b.test")];
    let expected = budget_id(hub_id().as_str(), NET, A, &t);
    assert_eq!(id, expected);
    assert_eq!(h.budget(&id).payees, vec![acct("a.test"), acct("b.test")]);
}

// ---- ft_on_transfer ----

#[test]
fn deposit_from_non_owner_returns_full_amount() {
    let mut h = Harness::new();
    let b = h.open_simple(A, &agent(1), 100);
    let refunded = h.transfer_in(B, 50, &budget_msg(&b));
    assert_eq!(refunded, 50);
    assert_eq!(h.budget(&b).escrow.0, 0);
    h.assert_solvent();
}

#[test]
fn ft_on_transfer_returns_full_amount_on_bad_input() {
    let mut h = Harness::new();
    let b = h.open_simple(A, &agent(1), 100);
    for msg in [
        "not json",
        "{}",
        r#"{"nope":1}"#,
        r#"{"budget":{"budget_id":"zz"}}"#,
        r#"{"budget":{}}"#,
    ] {
        assert_eq!(h.transfer_in(A, 9, msg), 9, "msg: {msg}");
    }
    assert_eq!(h.transfer_in(A, 9, &budget_msg(&id(0x77))), 9, "unknown budget");
    assert_eq!(h.budget(&b).escrow.0, 0);
    h.assert_solvent();
}

#[test]
fn ft_on_transfer_from_wrong_token_returns_full_amount_without_crediting() {
    let mut h = Harness::new();
    let b = h.open_simple(A, &agent(1), 100);
    h.ctx(acct("fake-usdc.test"), 0);
    let refunded = h.hub.ft_on_transfer(acct(A), U128(10), budget_msg(&b));
    assert_eq!(refunded.0, 10);
    assert_eq!(h.budget(&b).escrow.0, 0);
    h.assert_solvent();
}

#[test]
fn deposit_to_revoked_or_expired_budget_is_refunded() {
    let mut h = Harness::new();
    let b = h.open_simple(A, &agent(1), 100);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(b);
    assert_eq!(h.transfer_in(A, 5, &budget_msg(&b)), 5);

    let mut h = Harness::new();
    let b = h.open_simple(A, &agent(1), 100);
    h.advance(DAY + 1);
    assert_eq!(h.transfer_in(A, 5, &budget_msg(&b)), 5);
    h.assert_solvent();
}

fn set_checkout(h: &mut Harness, key: &SigningKey) {
    h.enable_checkout(key);
}

fn payment_msg(key: &SigningKey, payment_id: Id32, merchant: &str, amount: u128, expiry_ms: u64) -> String {
    let digest = checkout_digest(hub_id().as_str(), NET, &payment_id, merchant, amount, expiry_ms);
    let signature: Sig64 = Sig64(key.sign(&digest).to_bytes());
    format!(
        r#"{{"payment":{{"payment_id":"{}","merchant":"{}","amount":"{}","expiry_ms":"{}","signature":"{}"}}}}"#,
        payment_id.to_hex(),
        merchant,
        amount,
        expiry_ms,
        signature.to_hex()
    )
}

#[test]
fn payment_with_valid_terms_credits_the_merchant() {
    let mut h = Harness::new();
    let key = agent(50);
    set_checkout(&mut h, &key);
    let msg = payment_msg(&key, id(1), S, 25, T0 + 1000);
    assert_eq!(h.transfer_in(A, 25, &msg), 0);
    h.accounts.insert(acct(S));
    assert_eq!(h.hub.credit_of(acct(S)).0, 25);
    let [view] = <[Option<PaymentView>; 1]>::try_from(h.hub.payments(vec![id(1)])).unwrap();
    let view = view.unwrap();
    assert_eq!(
        (view.merchant, view.amount.0, view.payer, view.at.0),
        (acct(S), 25, acct(A), T0)
    );
    assert_eq!(h.hub.payments(vec![id(9)]), vec![None]);
    h.assert_solvent();
}

#[test]
fn payment_returns_full_amount_on_every_bad_case() {
    let mut h = Harness::new();
    let key = agent(50);
    let msg_any = payment_msg(&key, id(1), S, 25, T0 + 1000);
    assert_eq!(h.transfer_in(A, 25, &msg_any), 25, "no checkout key set");

    set_checkout(&mut h, &key);
    assert_eq!(h.transfer_in(A, 24, &msg_any), 24, "wrong amount");
    assert_eq!(
        h.transfer_in(A, 25, &payment_msg(&key, id(2), S, 25, T0 - 1)),
        25,
        "expired"
    );
    assert_eq!(
        h.transfer_in(A, 25, &payment_msg(&agent(51), id(3), S, 25, T0 + 1000)),
        25,
        "wrong key"
    );
    assert_eq!(h.transfer_in(A, 25, &msg_any), 0, "valid");
    assert_eq!(h.transfer_in(A, 25, &msg_any), 25, "repeated id");
    h.accounts.insert(acct(S));
    assert_eq!(h.hub.credit_of(acct(S)).0, 25);
    h.assert_solvent();
}

// ---- settle_batch and netting ----

#[test]
fn offset_lets_a_batch_clear_more_gross_than_escrow() {
    let mut h = Harness::new();
    let (a, b) = pair(&mut h, 5, 5);
    let claims = vec![claim(&a, B, &agent(1), 100, 100), claim(&b, A, &agent(2), 98, 98)];
    h.settle(id(1), claims, entries(&[(A, B, 100), (B, A, 98)]));
    let (ba, bb) = (h.budget(&a), h.budget(&b));
    assert_eq!((ba.spent.0, ba.escrow.0), (100, 3));
    assert_eq!((bb.spent.0, bb.escrow.0), (98, 5));
    assert_eq!(h.hub.credit_of(acct(B)).0, 2);
    assert_eq!(h.hub.credit_of(acct(A)).0, 0);
    let batch = h.batch(id(1)).unwrap();
    assert_eq!((batch.gross.0, batch.net.0), (198, 2));
    h.assert_solvent();
}

#[test]
fn same_claims_fail_without_offset_and_clear_with_offset() {
    let mut h = Harness::new();
    let (a, b) = pair(&mut h, 5, 5);
    h.expect_err(INSUFFICIENT_ESCROW, |h| {
        h.settle(id(1), vec![claim(&a, B, &agent(1), 100, 100)], entries(&[(A, B, 100)]));
    });
    assert_eq!(h.batch(id(1)), None);
    h.settle(
        id(2),
        vec![claim(&a, B, &agent(1), 100, 100), claim(&b, A, &agent(2), 98, 98)],
        entries(&[(A, B, 100), (B, A, 98)]),
    );
    assert_eq!(h.budget(&a).escrow.0, 3);
    h.assert_solvent();
}

#[test]
fn a_owes_b_10_b_owes_a_7_spec_example() {
    let mut h = Harness::new();
    let (a, b) = pair(&mut h, 100, 100);
    h.settle(
        id(1),
        vec![claim(&a, B, &agent(1), 10, 10), claim(&b, A, &agent(2), 7, 7)],
        entries(&[(A, B, 10), (B, A, 7)]),
    );
    assert_eq!(h.budget(&a).spent.0, 10);
    assert_eq!(h.budget(&a).escrow.0, 97);
    assert_eq!(h.budget(&b).spent.0, 7);
    assert_eq!(h.budget(&b).escrow.0, 100);
    assert_eq!(h.hub.credit_of(acct(B)).0, 3);
    h.assert_solvent();
}

#[test]
fn net_creditor_needs_no_escrow_and_pure_payee_gains_credit() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 40, 1000);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 40, 40)], entries(&[(A, S, 40)]));
    assert_eq!(h.budget(&a).escrow.0, 0);
    assert_eq!(h.hub.credit_of(acct(S)).0, 40);
    h.assert_solvent();
}

#[test]
fn fully_offset_batch_moves_no_cash_and_self_payment_is_gross_only() {
    let mut h = Harness::new();
    let (a, b) = pair(&mut h, 0, 0);
    h.settle(
        id(1),
        vec![claim(&a, B, &agent(1), 6, 6), claim(&b, A, &agent(2), 6, 6)],
        vec![],
    );
    assert_eq!(h.batch(id(1)).unwrap().net.0, 0);
    assert_eq!(h.budget(&a).spent.0, 6);
    h.assert_solvent();

    let mut h = Harness::new();
    let a = h.open_simple(A, &agent(1), 100);
    h.settle(id(1), vec![claim(&a, A, &agent(1), 4, 4)], vec![]);
    assert_eq!(h.budget(&a).spent.0, 4);
    assert_eq!(h.batch(id(1)).unwrap().gross.0, 4);
    assert_eq!(h.batch(id(1)).unwrap().net.0, 0);
    h.assert_solvent();
}

#[test]
fn replayed_batch_id_is_rejected() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 1, 1)], entries(&[(A, S, 1)]));
    h.expect_err(BATCH_EXISTS, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 1, 2)], entries(&[(A, S, 1)]));
    });
    assert_eq!(h.hub.settled_of(a, acct(S)).0, 1);
}

#[test]
fn stale_vouchers_are_rejected() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 5, 5)], entries(&[(A, S, 5)]));
    h.expect_err(STALE_VOUCHER, |h| {
        h.settle(id(2), vec![claim(&a, S, &agent(1), 5, 5)], vec![]);
    });
    h.expect_err(STALE_VOUCHER, |h| {
        h.settle(id(3), vec![claim(&a, S, &agent(1), 1, 4)], vec![]);
    });
}

#[test]
fn bad_signature_is_rejected() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    let mut c = claim(&a, S, &agent(1), 3, 3);
    c.amount = U128(4);
    h.expect_err(BAD_SIGNATURE, |h| {
        h.settle(id(1), vec![c.clone()], entries(&[(A, S, 3)]));
    });
    let mut c = claim(&a, S, &agent(1), 3, 3);
    c.request_hash = id(0);
    h.expect_err(BAD_SIGNATURE, |h| {
        h.settle(id(1), vec![c.clone()], entries(&[(A, S, 3)]));
    });
    let c = claim(&a, S, &agent(9), 3, 3);
    h.expect_err(BAD_SIGNATURE, |h| {
        h.settle(id(1), vec![c.clone()], entries(&[(A, S, 3)]));
    });
}

#[test]
fn caller_must_be_allowlisted_and_named_by_the_budget() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    let c = claim(&a, S, &agent(1), 1, 1);
    let c2 = c.clone();
    h.expect_err(NOT_SETTLER, |h| {
        h.ctx(acct("stranger.test"), 0);
        h.hub.settle_batch(id(1), id(0xee), vec![c2], entries(&[(A, S, 1)]));
    });

    h.ctx(admin(), plenty());
    h.hub.set_settler(acct("other.test"), true);
    h.expect_err(NOT_BUDGET_SETTLER, |h| {
        h.ctx(acct("other.test"), 0);
        h.hub.settle_batch(id(1), id(0xee), vec![c], entries(&[(A, S, 1)]));
    });
}

#[test]
fn settler_removed_from_allowlist_cannot_settle() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.ctx(admin(), 1);
    h.hub.set_settler(node(), false);
    h.expect_err(NOT_SETTLER, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 1, 1)], entries(&[(A, S, 1)]));
    });
}

#[test]
fn payee_outside_the_list_is_rejected_and_empty_list_means_any() {
    let mut h = Harness::new();
    let terms = h.terms(&agent(1), 100, vec![S]);
    let a = h.open(A, terms);
    h.deposit(A, &a, 10);
    h.expect_err(PAYEE_NOT_ALLOWED, |h| {
        h.settle(
            id(1),
            vec![claim(&a, "attacker.test", &agent(1), 1, 1)],
            entries(&[(A, "attacker.test", 1)]),
        );
    });
    h.settle(id(2), vec![claim(&a, S, &agent(1), 1, 1)], entries(&[(A, S, 1)]));
    h.assert_solvent();
}

#[test]
fn over_cap_is_rejected_even_when_escrow_would_allow_it() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 500, 50);
    h.expect_err(CAP_EXCEEDED, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 51, 51)], entries(&[(A, S, 51)]));
    });
    h.settle(id(2), vec![claim(&a, S, &agent(1), 50, 50)], entries(&[(A, S, 50)]));
    h.expect_err(CAP_EXCEEDED, |h| {
        h.settle(id(3), vec![claim(&a, S, &agent(1), 1, 51)], entries(&[(A, S, 1)]));
    });
}

#[test]
fn escrow_cannot_cover_net_debit() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 5, 1000);
    h.expect_err(INSUFFICIENT_ESCROW, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 6, 6)], entries(&[(A, S, 6)]));
    });
    assert_eq!(h.budget(&a).spent.0, 0);
    assert_eq!(h.hub.settled_of(a, acct(S)).0, 0);
}

#[test]
fn expected_net_is_asserted() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.expect_err(NET_MISMATCH, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 3, 3)], vec![]);
    });
    h.expect_err(NET_MISMATCH, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 3, 3)], entries(&[(A, S, 2)]));
    });
    let mut wrong_order = entries(&[(A, S, 3)]);
    wrong_order.reverse();
    h.expect_err(NET_MISMATCH, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 3, 3)], wrong_order);
    });
}

#[test]
fn one_budget_per_owner_per_batch() {
    let mut h = Harness::new();
    let a1 = h.open_simple(A, &agent(1), 100);
    let a2 = h.open_simple(A, &agent(3), 100);
    h.deposit(A, &a1, 10);
    h.deposit(A, &a2, 10);
    h.expect_err(ONE_BUDGET_PER_OWNER, |h| {
        h.settle(
            id(1),
            vec![claim(&a1, S, &agent(1), 1, 1), claim(&a2, S, &agent(3), 1, 1)],
            entries(&[(A, S, 2)]),
        );
    });
}

#[test]
fn empty_and_oversized_batches_are_rejected() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 100_000);
    h.expect_err(ZERO_GROSS, |h| {
        h.settle(id(1), vec![], vec![]);
    });
    let many: Vec<Claim> = (0..=MAX_CLAIMS as u128)
        .map(|i| claim(&a, S, &agent(1), 1, i + 1))
        .collect();
    h.expect_err(TOO_MANY_CLAIMS, |h| {
        h.settle(id(1), many, vec![]);
    });
}

#[test]
fn claims_apply_in_order_within_a_batch() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.settle(
        id(1),
        vec![claim(&a, S, &agent(1), 3, 3), claim(&a, S, &agent(1), 2, 5)],
        entries(&[(A, S, 5)]),
    );
    assert_eq!(h.budget(&a).spent.0, 5);
    assert_eq!(h.hub.settled_of(a, acct(S)).0, 5);
    h.expect_err(STALE_VOUCHER, |h| {
        h.settle(
            id(2),
            vec![claim(&a, S, &agent(1), 1, 6), claim(&a, S, &agent(1), 1, 6)],
            entries(&[(A, S, 1)]),
        );
    });
}

#[test]
fn unknown_budget_is_rejected() {
    let mut h = Harness::new();
    h.expect_err(UNKNOWN_BUDGET, |h| {
        h.settle(id(1), vec![claim(&id(7), S, &agent(1), 1, 1)], entries(&[(A, S, 1)]));
    });
}

#[test]
fn revoked_budget_settles_during_grace_only() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    assert_eq!(h.budget(&a).revoked_at.unwrap().0, T0);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 10, 10)], entries(&[(A, S, 10)]));

    h.advance(REVOKE_GRACE_MS);
    h.settle(id(2), vec![claim(&a, S, &agent(1), 1, 11)], entries(&[(A, S, 1)]));

    h.advance(1);
    h.expect_err(BUDGET_CLOSED, |h| {
        h.settle(id(3), vec![claim(&a, S, &agent(1), 1, 12)], entries(&[(A, S, 1)]));
    });
}

#[test]
fn expired_budget_settles_during_grace_then_closes() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.advance(DAY + EXPIRY_GRACE_MS);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 1, 1)], entries(&[(A, S, 1)]));
    h.advance(1);
    h.expect_err(BUDGET_CLOSED, |h| {
        h.settle(id(2), vec![claim(&a, S, &agent(1), 1, 2)], entries(&[(A, S, 1)]));
    });
    h.assert_solvent();
}

#[test]
fn revoking_after_expiry_is_refused_so_the_expiry_grace_always_stands() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.advance(DAY + 1);
    h.expect_code(BUDGET_NOT_OPEN, |h| {
        h.ctx(acct(A), 0);
        h.hub.revoke_budget(a);
    });
    h.advance(EXPIRY_GRACE_MS - 1);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 1, 1)], entries(&[(A, S, 1)]));
    h.advance(1);
    h.expect_err(BUDGET_CLOSED, |h| {
        h.settle(id(2), vec![claim(&a, S, &agent(1), 1, 2)], entries(&[(A, S, 1)]));
    });
}

#[test]
fn only_the_owner_can_revoke_and_only_once() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 0, 100);
    h.expect_err(NOT_OWNER, |h| {
        h.ctx(acct(B), 0);
        h.hub.revoke_budget(a);
    });
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    h.expect_err(ALREADY_REVOKED, |h| {
        h.ctx(acct(A), 0);
        h.hub.revoke_budget(a);
    });
}

// ---- payout ----

fn credited(amount: u128) -> Harness {
    let mut h = Harness::new();
    let a = one_budget(&mut h, amount, 1000);
    h.settle(
        id(1),
        vec![claim(&a, S, &agent(1), amount, amount)],
        entries(&[(A, S, amount)]),
    );
    h
}

#[test]
fn payout_deducts_first_and_tracks_in_flight() {
    let mut h = credited(40);
    h.payout(&[S]);
    assert_eq!(h.hub.credit_of(acct(S)).0, 0);
    assert_eq!(h.hub.totals().in_flight.0, 40);
    h.assert_solvent();

    h.finish_payout(S, 40, true);
    assert_eq!(h.hub.totals().in_flight.0, 0);
    assert_eq!(h.hub.credit_of(acct(S)).0, 0);
    h.assert_solvent();
}

#[test]
fn payout_failure_restores_credit() {
    let mut h = credited(40);
    h.payout(&[S]);
    assert_eq!(h.hub.credit_of(acct(S)).0, 0);
    h.finish_payout(S, 40, false);
    assert_eq!(h.hub.credit_of(acct(S)).0, 40);
    assert_eq!(h.hub.totals().in_flight.0, 0);
    h.assert_solvent();
}

#[test]
fn payout_cannot_double_spend_while_in_flight() {
    let mut h = credited(40);
    h.payout(&[S]);
    let before = h.hub.totals().in_flight.0;
    h.payout(&[S, S]);
    assert_eq!(
        h.hub.totals().in_flight.0,
        before,
        "no second transfer while the first is pending"
    );
    h.finish_payout(S, 40, true);
    h.assert_solvent();
}

#[test]
fn payout_skips_empty_credit_and_duplicates() {
    let mut h = credited(40);
    h.payout(&[S, S, "nobody.test"]);
    assert_eq!(h.hub.totals().in_flight.0, 40);
    assert_eq!(
        near_sdk::test_utils::get_created_receipts().len(),
        2,
        "one transfer and one callback"
    );
    h.finish_payout(S, 40, true);
    h.assert_solvent();
}

#[test]
fn payout_is_capped_at_10_accounts() {
    let mut h = credited(10);
    let names: Vec<String> = (0..11).map(|i| format!("p{i}.test")).collect();
    let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
    h.expect_err(TOO_MANY_ACCOUNTS, |h| h.payout(&refs));
    h.payout(&[]);
    assert_eq!(h.hub.credit_of(acct(S)).0, 10);
}

#[test]
fn payout_refuses_too_little_gas_before_changing_state() {
    let mut h = credited(40);
    h.expect_err(INSUFFICIENT_GAS, |h| {
        h.ctx_full(acct("anyone.test"), 0, Gas::from_tgas(5), vec![]);
        h.hub.payout(vec![acct(S)]);
    });
    assert_eq!(h.hub.credit_of(acct(S)).0, 40);
}

// ---- reclaim ----

#[test]
fn reclaim_timing_and_authority() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.expect_err(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.reclaim(a);
    });
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    h.advance(REVOKE_GRACE_MS);
    h.expect_err(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.reclaim(a);
    });
    h.advance(1);
    h.expect_err(NOT_OWNER, |h| {
        h.ctx(acct(B), 0);
        h.hub.reclaim(a);
    });
    h.ctx(acct(A), 0);
    h.hub.reclaim(a);
    assert_eq!(h.budget(&a).escrow.0, 0);
    assert_eq!(h.hub.totals().in_flight.0, 100);
    h.assert_solvent();
    h.finish_reclaim(a, 100, true);
    assert_eq!(h.hub.totals().in_flight.0, 0);
    h.assert_solvent();
}

#[test]
fn reclaim_after_expiry_grace() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 30, 1000);
    h.advance(DAY + EXPIRY_GRACE_MS);
    h.expect_err(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.reclaim(a);
    });
    h.advance(1);
    h.ctx(acct(A), 0);
    h.hub.reclaim(a);
    assert_eq!(h.budget(&a).escrow.0, 0);
    h.finish_reclaim(a, 30, true);
    h.assert_solvent();
}

#[test]
fn reclaim_failure_restores_escrow_and_a_second_reclaim_cannot_double_spend() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 30, 1000);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    h.advance(REVOKE_GRACE_MS + 1);
    h.ctx(acct(A), 0);
    h.hub.reclaim(a);
    assert_eq!(h.budget(&a).escrow.0, 0);

    // While the first transfer is pending a second call finds nothing to send.
    h.ctx(acct(A), 0);
    h.hub.reclaim(a);
    assert_eq!(h.hub.totals().in_flight.0, 30);

    h.finish_reclaim(a, 30, false);
    assert_eq!(h.budget(&a).escrow.0, 30);
    assert_eq!(h.hub.totals().in_flight.0, 0);
    h.assert_solvent();
}

// ---- settle_own ----

#[test]
fn settle_own_is_payee_only_and_debits_gross() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    let v = claim(&a, S, &agent(1), 30, 30);
    let v2 = v.clone();
    h.expect_err(NOT_PAYEE, |h| {
        h.ctx(acct(B), 0);
        h.own(v2);
    });
    h.ctx(acct(S), 0);
    h.own(v);
    h.accounts.insert(acct(S));
    let budget = h.budget(&a);
    assert_eq!((budget.spent.0, budget.escrow.0), (30, 70));
    assert_eq!(h.hub.credit_of(acct(S)).0, 30);
    assert_eq!(h.hub.settled_of(a, acct(S)).0, 30);
    h.assert_solvent();
}

#[test]
fn settle_own_respects_escrow_signature_and_stale() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 10, 1000);
    h.expect_err(INSUFFICIENT_ESCROW, |h| {
        h.ctx(acct(S), 0);
        h.own(claim(&a, S, &agent(1), 20, 20));
    });
    let v = claim(&a, S, &agent(1), 5, 5);
    let mut tampered = v.clone();
    tampered.amount = U128(6);
    h.expect_err(BAD_SIGNATURE, |h| {
        h.ctx(acct(S), 0);
        h.own(tampered);
    });
    h.ctx(acct(S), 0);
    h.accounts.insert(acct(S));
    h.own(v.clone());
    h.expect_err(STALE_VOUCHER, |h| {
        h.ctx(acct(S), 0);
        h.own(v);
    });
    h.assert_solvent();
}

#[test]
fn settle_own_racing_a_batch_cannot_double_count() {
    // The payee wins the race: the batch carrying the same voucher then fails as a whole.
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.ctx(acct(S), 0);
    h.accounts.insert(acct(S));
    h.own(claim(&a, S, &agent(1), 10, 10));
    h.expect_err(STALE_VOUCHER, |h| {
        h.settle(id(1), vec![claim(&a, S, &agent(1), 10, 10)], entries(&[(A, S, 10)]));
    });
    // A later voucher settles only the remainder.
    h.settle(id(2), vec![claim(&a, S, &agent(1), 5, 15)], entries(&[(A, S, 5)]));
    assert_eq!(h.budget(&a).spent.0, 15);
    assert_eq!(h.hub.credit_of(acct(S)).0, 15);
    assert_eq!(h.budget(&a).escrow.0, 85);
    h.assert_solvent();

    // The batch wins the race: the payee's own settlement of the same voucher is stale.
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.settle(id(1), vec![claim(&a, S, &agent(1), 10, 10)], entries(&[(A, S, 10)]));
    h.expect_err(STALE_VOUCHER, |h| {
        h.ctx(acct(S), 0);
        h.own(claim(&a, S, &agent(1), 10, 10));
    });
}

#[test]
fn settle_own_after_deadline_is_closed() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    h.advance(DAY + EXPIRY_GRACE_MS + 1);
    h.expect_err(BUDGET_CLOSED, |h| {
        h.ctx(acct(S), 0);
        h.own(claim(&a, S, &agent(1), 1, 1));
    });
}

#[test]
fn settle_own_draws_every_new_payee_from_the_owners_reserve_up_to_max_payees() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 1_000, 1_000_000);
    assert_eq!(
        h.budget(&a).storage_reserve_bytes.0,
        u64::from(DEFAULT_ANY_PAYEES) * crate::PAIR_BYTES
    );

    // Each new payee writes a `settled` and a `credits` entry, all drawn from the bytes the owner prepaid, and the
    // payee attaches nothing.
    for i in 0..DEFAULT_ANY_PAYEES {
        let payee = format!("p{i:02}.test");
        let reserve = h.budget(&a).storage_reserve_bytes.0;
        let before = h.usage();
        h.ctx(acct(&payee), 0);
        h.accounts.insert(acct(&payee));
        h.own(claim(&a, &payee, &agent(1), 1, 1));
        let grown = h.usage() - before;
        assert_eq!(
            reserve - h.budget(&a).storage_reserve_bytes.0,
            grown,
            "the reserve pays every byte"
        );
        assert!(
            near_sdk::test_utils::get_created_receipts().is_empty(),
            "nothing to refund"
        );
    }
    assert_eq!(h.budget(&a).payees_paid, DEFAULT_ANY_PAYEES);

    // One payee more than the owner declared is refused, whatever the payee attaches.
    let extra = "pxx.test";
    h.expect_code(TOO_MANY_PAYEES, |h| {
        h.ctx(acct(extra), plenty());
        h.own(claim(&a, extra, &agent(1), 1, 1));
    });

    // A repeat payee writes no new entry, so the whole deposit comes back.
    h.ctx(acct("p00.test"), 7);
    let before = h.usage();
    h.own(claim(&a, "p00.test", &agent(1), 1, 2));
    assert_eq!(h.usage(), before);
    assert_eq!(
        near_sdk::test_utils::get_created_receipts().len(),
        1,
        "unused deposit is refunded"
    );
    h.assert_solvent();
}

// ---- verify_receipt ----

fn leaf_fields(i: u8, budget_id: Id32, key: &SigningKey) -> (ReceiptFields, Vec<u8>) {
    let voucher = claim(&budget_id, S, key, i as u128 + 1, (i as u128 + 1) * 10);
    let fields = ReceiptFields {
        call_id: id(i),
        budget_id,
        payee: voucher.payee.clone(),
        amount: voucher.amount,
        cumulative: voucher.cumulative,
        request_hash: voucher.request_hash,
        timestamp_ms: U64(T0),
        voucher_sig: voucher.signature,
    };
    let leaf = receipt_leaf(
        hub_id().as_str(),
        NET,
        &id(0xb0),
        &fields.call_id,
        &fields.budget_id,
        fields.payee.as_str(),
        fields.amount.0,
        fields.cumulative.0,
        &fields.request_hash,
        fields.timestamp_ms.0,
        &fields.voucher_sig.0,
    );
    (fields, leaf.to_vec())
}

#[test]
fn verify_receipt_proves_inclusion_only_against_the_stored_root() {
    let mut h = Harness::new();
    let a = one_budget(&mut h, 100, 1000);
    let key = agent(1);
    let built: Vec<(ReceiptFields, [u8; 32])> = (0..3)
        .map(|i| {
            let (fields, leaf) = leaf_fields(i, a, &key);
            (fields, <[u8; 32]>::try_from(leaf).unwrap())
        })
        .collect();
    let leaves: Vec<[u8; 32]> = built.iter().map(|(_, l)| *l).collect();
    let root = merkle_root(&leaves);

    h.ctx(node(), 0);
    h.hub.settle_batch(
        id(0xb0),
        Id32(root),
        vec![claim(&a, S, &key, 1, 1)],
        entries(&[(A, S, 1)]),
    );
    h.accounts.insert(acct(S));

    for (i, (fields, _)) in built.iter().enumerate() {
        let proof = merkle_proof(&leaves, i);
        assert!(
            h.hub.verify_receipt(node(), id(0xb0), fields.clone(), proof.clone()),
            "leaf {i}"
        );

        let mut tampered = fields.clone();
        tampered.amount = U128(fields.amount.0 + 1);
        assert!(!h.hub.verify_receipt(node(), id(0xb0), tampered, proof.clone()));
        let mut wrong_sig = fields.clone();
        wrong_sig.voucher_sig = Sig64([0x11; 64]);
        assert!(!h.hub.verify_receipt(node(), id(0xb0), wrong_sig, proof.clone()));
        assert!(!h.hub.verify_receipt(node(), id(0xb1), fields.clone(), proof.clone()));
        // The batch id is the node's: under another settler's name it proves nothing.
        assert!(
            !h.hub
                .verify_receipt(acct("other-node.test"), id(0xb0), fields.clone(), proof)
        );
    }

    let deep = vec![id(0); MAX_MERKLE_DEPTH + 1];
    assert!(!h.hub.verify_receipt(node(), id(0xb0), built[0].0.clone(), deep));
    h.assert_solvent();
}

// ---- admin ----

#[test]
fn admin_methods_are_admin_only_and_need_a_deposit_that_covers_their_storage() {
    let mut h = Harness::new();
    h.expect_err(NOT_ADMIN, |h| {
        h.ctx(acct("attacker.test"), 1);
        h.hub.set_settler(acct("x.test"), true);
    });
    h.expect_err(NOT_ADMIN, |h| {
        h.ctx(acct("attacker.test"), 1);
        h.hub.set_checkout_key(id(1), node());
    });
    h.expect_code(DEPOSIT_REQUIRED, |h| {
        h.ctx(admin(), 0);
        h.hub.set_settler(acct("x.test"), true);
    });
    // One yoctoNEAR proves a full-access key, and it does not pay for a new entry.
    h.expect_err(INSUFFICIENT_DEPOSIT, |h| {
        h.ctx(admin(), 1);
        h.hub.set_settler(acct("x.test"), true);
    });
    h.expect_err(INSUFFICIENT_DEPOSIT, |h| {
        h.ctx(admin(), 1);
        h.hub.set_checkout_key(id(1), node());
    });

    let before = h.usage();
    h.ctx(admin(), plenty());
    h.hub.set_settler(acct("x.test"), true);
    assert!(h.hub.is_settler(acct("x.test")));
    let cost = u128::from(h.usage() - before) * byte_cost();
    let refunds = near_sdk::test_utils::get_created_receipts();
    assert_eq!(refunds.len(), 1, "the excess goes back to the admin");
    assert_eq!(refunds[0].receiver_id, admin());
    assert_eq!(transferred(&refunds[0]), plenty() - cost);

    // Removing a settler and repeating an entry write nothing, so one yoctoNEAR is enough.
    h.ctx(admin(), 1);
    h.hub.set_settler(acct("x.test"), true);
    h.ctx(admin(), 1);
    h.hub.set_settler(acct("x.test"), false);
    assert!(!h.hub.is_settler(acct("x.test")));

    // The checkout settler must be on the allowlist, because its storage balance pays for payments.
    h.expect_err(NOT_SETTLER, |h| {
        h.ctx(admin(), plenty());
        h.hub.set_checkout_key(id(1), acct("x.test"));
    });
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(id(1), node());
    // A proposal, paid by the admin; the node accepts it, which moves it into place and writes nothing new.
    assert_eq!(h.hub.checkout_key(), None);
    let first = plenty() - transferred(&near_sdk::test_utils::get_created_receipts()[0]);
    assert_eq!(first, (32 + 4 + node().as_str().len() as u128) * byte_cost());
    h.ctx(node(), 1);
    h.hub.accept_checkout(id(1));
    assert_eq!(h.hub.checkout_key(), Some(id(1)));
    assert_eq!(h.hub.checkout_settler(), Some(node()));
    // Proposing a replacement of the same size costs the admin nothing more than the proposal record.
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(id(2), node());
    let second = plenty() - transferred(&near_sdk::test_utils::get_created_receipts()[0]);
    assert_eq!(second, first);
    h.ctx(node(), 1);
    h.hub.accept_checkout(id(2));
    assert_eq!(h.hub.checkout_key(), Some(id(2)));
}

/// The NEAR moved by a plain transfer receipt.
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

#[test]
fn init_rejects_admin_equal_to_the_hub_account() {
    let h = Harness::new();
    h.ctx(hub_id(), 0);
    let result = catch_unwind(|| Hub::new(hub_id(), token(), NET.to_string()));
    let payload = result.err().expect("init must refuse");
    let message = payload.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(message.contains(ADMIN_IS_HUB), "got: {message}");
}

// ---- random walk solvency ----

#[test]
fn solvency_holds_across_a_random_sequence_of_operations() {
    let mut h = Harness::new();
    let (ka, kb) = (agent(1), agent(2));
    let a = h.open_simple(A, &ka, u64::MAX as u128);
    let b = h.open_simple(B, &kb, u64::MAX as u128);
    h.deposit(A, &a, 500);
    h.deposit(B, &b, 500);
    h.accounts.insert(acct(S));

    let mut seed = 42u64;
    let mut roll = move |n: u64| {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345) & 0x7fff_ffff;
        seed % n
    };
    let mut cumulative: BTreeMap<(Id32, String), u128> = BTreeMap::new();
    let mut batch = 0u8;
    // Every byte written in this walk is charged to a Budget's reserve or the node's storage balance, and every byte
    // freed is returned to whichever paid, so the balance, the reserves and the cost of the storage in use add up to
    // the same amount throughout: the hub pays for nothing.
    let paid_for = |h: &mut Harness| {
        let reserves = h.budget(&a).storage_reserve_bytes.0 + h.budget(&b).storage_reserve_bytes.0;
        h.storage_of(node().as_str()) + u128::from(h.usage() + reserves) * byte_cost()
    };
    let storage_invariant = paid_for(&mut h);
    for _ in 0..300 {
        match roll(6) {
            0 => {
                let (owner, target) = if roll(2) == 0 { (A, a) } else { (B, b) };
                h.deposit(owner, &target, roll(5) as u128 + 1);
            }
            5 => {
                let (owner, target) = if roll(2) == 0 { (A, a) } else { (B, b) };
                let credit = h.hub.credit_of(acct(owner)).0;
                if credit > 0 {
                    h.ctx(acct(owner), 1);
                    h.hub.fund_from_credit(target, U128(roll(credit as u64) as u128 + 1));
                }
            }
            1 => {
                let target = [A, B, S][roll(3) as usize];
                let pending = h.hub.credit_of(acct(target)).0;
                h.payout(&[target]);
                if pending > 0 {
                    h.finish_payout(target, pending, roll(2) == 0);
                }
            }
            _ => {
                let mut claims = vec![];
                let mut lines: Vec<(&str, &str, u128)> = vec![];
                for (owner, target, key, payees) in [(A, a, &ka, [B, S]), (B, b, &kb, [A, S])] {
                    if roll(3) == 0 {
                        continue;
                    }
                    let payee = payees[roll(2) as usize];
                    let delta = roll(4) as u128 + 1;
                    let next = cumulative.get(&(target, payee.to_string())).copied().unwrap_or(0) + delta;
                    cumulative.insert((target, payee.to_string()), next);
                    claims.push(claim(&target, payee, key, delta, next));
                    lines.push((owner, payee, delta));
                }
                if !claims.is_empty() {
                    batch = batch.wrapping_add(1);
                    let net = entries(&lines);
                    let mut bytes = [0u8; 32];
                    bytes[0] = batch;
                    bytes[1] = (roll(255) + 1) as u8;
                    h.settle(Id32(bytes), claims, net);
                }
            }
        }
        h.assert_solvent();
        assert_eq!(
            paid_for(&mut h),
            storage_invariant,
            "the hub paid for storage, or kept a refund"
        );
    }
    assert!(h.hub.totals().in_flight.0 == 0);
}

// ---- fund_from_credit ----

/// A has credit 30 from B's Budget, and an open Budget `a` of its own with escrow 5.
fn owner_with_credit() -> (Harness, Id32, Id32) {
    let mut h = Harness::new();
    let (a, b) = pair(&mut h, 5, 100);
    h.settle(id(1), vec![claim(&b, A, &agent(2), 30, 30)], entries(&[(B, A, 30)]));
    assert_eq!(h.hub.credit_of(acct(A)).0, 30);
    (h, a, b)
}

fn fund(h: &mut Harness, caller: &str, budget_id: Id32, amount: u128) {
    h.ctx(acct(caller), 1);
    h.hub.fund_from_credit(budget_id, U128(amount));
}

#[test]
fn fund_from_credit_moves_credit_into_escrow_only() {
    let (mut h, a, _) = owner_with_credit();
    let before = h.hub.totals();
    fund(&mut h, A, a, 20);
    let budget = h.budget(&a);
    assert_eq!(
        (budget.escrow.0, budget.cap.0, budget.spent.0),
        (25, 1000, 0),
        "escrow rises, cap does not"
    );
    assert_eq!(h.hub.credit_of(acct(A)).0, 10);
    let after = h.hub.totals();
    assert_eq!(after.escrow.0, before.escrow.0 + 20);
    assert_eq!(after.credits.0, before.credits.0 - 20);
    assert_eq!(after.escrow.0 + after.credits.0, before.escrow.0 + before.credits.0);
    h.assert_solvent();

    // The whole remaining credit can be moved, which leaves a zero entry.
    fund(&mut h, A, a, 10);
    assert_eq!(h.hub.credit_of(acct(A)).0, 0);
    assert_eq!(h.budget(&a).escrow.0, 35);
    h.assert_solvent();
}

#[test]
fn funded_escrow_lets_a_batch_settle_that_failed_before() {
    let (mut h, a, _) = owner_with_credit();
    h.expect_err(INSUFFICIENT_ESCROW, |h| {
        h.settle(id(2), vec![claim(&a, S, &agent(1), 30, 30)], entries(&[(A, S, 30)]));
    });
    fund(&mut h, A, a, 25);
    h.settle(id(3), vec![claim(&a, S, &agent(1), 30, 30)], entries(&[(A, S, 30)]));
    assert_eq!(h.budget(&a).escrow.0, 0);
    assert_eq!(h.hub.credit_of(acct(S)).0, 30);
    h.assert_solvent();
}

#[test]
fn fund_from_credit_is_owner_only_and_bounded_by_credit() {
    let (mut h, a, b) = owner_with_credit();
    h.expect_err(ZERO_AMOUNT, |h| fund(h, A, a, 0));
    h.expect_err(INSUFFICIENT_CREDIT, |h| fund(h, A, a, 31));
    // B is not the owner of `a`, and A cannot fund B's Budget with A's credit.
    h.expect_err(NOT_OWNER, |h| fund(h, B, a, 1));
    h.expect_err(NOT_OWNER, |h| fund(h, A, b, 1));
    h.expect_err(UNKNOWN_BUDGET, |h| fund(h, A, id(0x77), 1));
    // B owns `b` but has no credit.
    h.expect_err(INSUFFICIENT_CREDIT, |h| fund(h, B, b, 1));
    assert_eq!(h.hub.credit_of(acct(A)).0, 30);
    assert_eq!(h.budget(&a).escrow.0, 5);
}

#[test]
fn fund_from_credit_needs_exactly_one_yocto() {
    let (mut h, a, _) = owner_with_credit();
    h.expect_code(ONE_YOCTO_REQUIRED, |h| {
        h.ctx(acct(A), 0);
        h.hub.fund_from_credit(a, U128(1));
    });
    h.expect_code(ONE_YOCTO_REQUIRED, |h| {
        h.ctx(acct(A), 2);
        h.hub.fund_from_credit(a, U128(1));
    });
    assert_eq!(h.hub.credit_of(acct(A)).0, 30);
}

#[test]
fn fund_from_credit_refuses_revoked_and_expired_budgets() {
    let (mut h, a, _) = owner_with_credit();
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    h.expect_err(BUDGET_NOT_OPEN, |h| fund(h, A, a, 1));

    let (mut h, a, _) = owner_with_credit();
    h.advance(DAY);
    fund(&mut h, A, a, 1);
    h.advance(1);
    h.expect_err(BUDGET_NOT_OPEN, |h| fund(h, A, a, 1));
    assert_eq!(h.hub.credit_of(acct(A)).0, 29);
    h.assert_solvent();
}

#[test]
fn fund_from_credit_uses_checkout_credit_and_cannot_race_a_payout() {
    let mut h = Harness::new();
    let a = h.open_simple(A, &agent(1), 1000);
    let key = agent(50);
    set_checkout(&mut h, &key);
    assert_eq!(h.transfer_in(B, 40, &payment_msg(&key, id(9), A, 40, T0 + 1000)), 0);
    assert_eq!(h.hub.credit_of(acct(A)).0, 40);

    // A payout in flight has already zeroed the credit, so the owner cannot also fund escrow with it.
    h.payout(&[A]);
    h.expect_err(INSUFFICIENT_CREDIT, |h| fund(h, A, a, 1));
    // The transfer fails and the callback restores the credit, which can then fund escrow.
    h.finish_payout(A, 40, false);
    fund(&mut h, A, a, 40);
    assert_eq!(h.budget(&a).escrow.0, 40);
    assert_eq!(h.hub.credit_of(acct(A)).0, 0);
    h.assert_solvent();
}

#[test]
fn error_codes_are_sorted_unique_and_none_is_a_prefix_of_another() {
    let mut sorted = crate::errors::ALL.to_vec();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted, crate::errors::ALL, "ALL is sorted and unique");
    for a in crate::errors::ALL {
        for b in crate::errors::ALL {
            assert!(a == b || !b.starts_with(a), "{a} is a prefix of {b}");
        }
    }
}
