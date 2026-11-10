//! The security review's findings, each as a test that failed before the fix.
//! F1, F2 and the first F3 test are ports of the reviewer's proofs of concept.

use super::*;

const MALLORY: &str = "mallory.test";

fn funded(escrow: u128) -> (Harness, Id32, SigningKey) {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, escrow);
    (h, a, key)
}

fn settle_own_as(h: &mut Harness, caller: &str, claim: Claim, accepted: Acceptance) {
    h.ctx(acct(caller), 0);
    h.accounts.insert(acct(caller));
    h.hub.settle_own(claim, accepted);
}

// ---- F1: an owner cannot drain its own escrow ahead of sellers ----

/// The owner chooses the agent key, so it can always sign a voucher. Before the fix it signed one to itself, called
/// `settle_own` with no node involved, and the seller's accepted voucher then failed with INSUFFICIENT_ESCROW.
#[test]
fn f1_owner_cannot_self_settle_ahead_of_the_seller() {
    let (mut h, a, key) = funded(100);
    let seller_voucher = claim(&a, S, &key, 60, 60);
    let seller_acceptance = h.accept(&seller_voucher);

    // To itself: refused whatever acceptance it shows, even one the node really signed.
    let to_self = claim(&a, A, &key, 100, 100);
    let genuine = h.accept(&to_self);
    h.expect_err(PAYEE_IS_OWNER, |h| {
        settle_own_as(h, A, to_self.clone(), genuine.clone())
    });

    // To a colluding payee: the node never accepted that call, so there is no acceptance to show.
    let colluding = claim(&a, MALLORY, &key, 100, 100);
    let self_signed = acceptance(&colluding, &key, h.now_s());
    h.expect_err(ACCEPTANCE_KEY_UNKNOWN, |h| {
        settle_own_as(h, MALLORY, colluding.clone(), self_signed.clone())
    });
    let mut forged = self_signed.clone();
    forged.node_key = pk(&node_key());
    h.expect_err(BAD_ACCEPTANCE, |h| {
        settle_own_as(h, MALLORY, colluding.clone(), forged.clone())
    });
    h.expect_err(BAD_ACCEPTANCE, |h| {
        settle_own_as(h, MALLORY, colluding.clone(), seller_acceptance.clone())
    });
    assert_eq!(h.budget(&a).escrow.0, 100, "nothing left the escrow");

    // The honest seller still settles, through the node or by itself.
    settle_own_as(&mut h, S, seller_voucher, seller_acceptance);
    assert_eq!(h.hub.credit_of(acct(S)).0, 60);
    assert_eq!(h.budget(&a).escrow.0, 40);
    h.assert_solvent();
}

// ---- F2: a leaked agent key cannot drain escrow after a revoke or an expiry ----

/// Before the fix a leaked agent key drained the escrow through `settle_own` for the whole revoke grace, and for three
/// days after expiry, because a voucher carries no time and `settle_own` involved no node.
#[test]
fn f2_leaked_agent_key_cannot_drain_after_revoke() {
    let (mut h, a, key) = funded(500);
    // A call the node accepted before the revoke.
    let served = claim(&a, S, &key, 30, 30);
    let served_acceptance = h.accept(&served);

    h.advance(5_000);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    let revoked_s = h.now_s();
    h.advance(59 * 60 * 1000);

    // The thief signs a voucher with the leaked key. It holds no acceptance of its own.
    let stolen = claim(&a, MALLORY, &key, 500, 500);
    let self_signed = acceptance(&stolen, &key, revoked_s - 1);
    h.expect_err(ACCEPTANCE_KEY_UNKNOWN, |h| {
        settle_own_as(h, MALLORY, stolen.clone(), self_signed.clone())
    });
    h.expect_err(BAD_ACCEPTANCE, |h| {
        settle_own_as(h, MALLORY, stolen.clone(), served_acceptance.clone())
    });
    // Even the node's own signature does not help when it is dated after the revoke.
    let late = acceptance(&stolen, &node_key(), revoked_s + 1);
    h.expect_err(ACCEPTANCE_TOO_LATE, |h| {
        settle_own_as(h, MALLORY, stolen.clone(), late.clone())
    });
    assert_eq!(h.budget(&a).escrow.0, 500);

    // The seller the node served before the revoke still settles inside the grace period.
    settle_own_as(&mut h, S, served, served_acceptance);
    assert_eq!(h.hub.credit_of(acct(S)).0, 30);
    h.assert_solvent();
}

#[test]
fn f2_leaked_agent_key_cannot_drain_after_expiry() {
    let (mut h, a, key) = funded(500);
    let valid_until_s = h.budget(&a).valid_until.0 / 1000;
    let served = claim(&a, S, &key, 30, 30);
    let served_acceptance = acceptance(&served, &node_key(), valid_until_s);

    h.advance(DAY + 2 * DAY);
    let stolen = claim(&a, MALLORY, &key, 500, 500);
    let late = acceptance(&stolen, &node_key(), valid_until_s + 1);
    h.expect_err(ACCEPTANCE_TOO_LATE, |h| {
        settle_own_as(h, MALLORY, stolen.clone(), late.clone())
    });
    settle_own_as(&mut h, S, served, served_acceptance);
    assert_eq!(h.budget(&a).escrow.0, 470);
    h.assert_solvent();
}

/// The acceptance carries Unix seconds and the Budget Unix milliseconds. A second counts from its first millisecond,
/// so a call the node accepted in the same second as the revoke settles, and one a second later does not.
#[test]
fn acceptance_time_is_compared_in_milliseconds_at_the_boundaries() {
    // T0 is a whole second, so the revoke lands 250 ms into second `T0 / 1000 + 7`.
    let (mut h, a, key) = funded(500);
    h.advance(7_250);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    let revoked_ms = h.budget(&a).revoked_at.unwrap().0;
    assert_eq!(revoked_ms % 1000, 250);
    let revoked_s = revoked_ms / 1000;

    let mut cumulative = 0;
    let mut try_at = |h: &mut Harness, timestamp_s: u64| -> bool {
        cumulative += 1;
        let c = claim(&a, S, &key, 1, cumulative);
        let accepted = acceptance(&c, &node_key(), timestamp_s);
        let saved = h.snapshot();
        let outcome = catch_unwind(AssertUnwindSafe(|| settle_own_as(h, S, c, accepted)));
        if outcome.is_err() {
            h.rollback(saved);
            cumulative -= 1;
        }
        outcome.is_ok()
    };
    assert!(try_at(&mut h, revoked_s - 1), "the second before the revoke");
    assert!(
        try_at(&mut h, revoked_s),
        "the second of the revoke, which starts before it"
    );
    assert!(!try_at(&mut h, revoked_s + 1), "the second after the revoke");
    assert!(!try_at(&mut h, u64::MAX), "a timestamp that overflows milliseconds");
    assert!(
        !try_at(&mut h, u64::MAX / 1000 + 1),
        "the first timestamp that overflows"
    );

    // A revoke exactly on a second boundary: that second is still accepted, one millisecond earlier it is not.
    let (mut h, a, key) = funded(500);
    h.advance(3_000);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    let on_boundary = claim(&a, S, &key, 1, 1);
    let exact = acceptance(&on_boundary, &node_key(), h.now_s());
    settle_own_as(&mut h, S, on_boundary, exact);

    let (mut h, a, key) = funded(500);
    h.advance(2_999);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    let just_after = claim(&a, S, &key, 1, 1);
    let next_second = acceptance(&just_after, &node_key(), (h.now_ms + 1) / 1000);
    h.expect_err(ACCEPTANCE_TOO_LATE, |h| {
        settle_own_as(h, S, just_after.clone(), next_second.clone())
    });

    // The same rule at `valid_until`, which here is a whole second.
    let (mut h, a, key) = funded(500);
    let valid_until = h.budget(&a).valid_until.0;
    assert_eq!(valid_until % 1000, 0);
    h.advance(DAY + 1);
    let last = claim(&a, S, &key, 1, 1);
    let at_expiry = acceptance(&last, &node_key(), valid_until / 1000);
    settle_own_as(&mut h, S, last, at_expiry);
    let after = claim(&a, S, &key, 1, 2);
    let past_expiry = acceptance(&after, &node_key(), valid_until / 1000 + 1);
    h.expect_err(ACCEPTANCE_TOO_LATE, |h| {
        settle_own_as(h, S, after.clone(), past_expiry.clone())
    });

    // After expiry a revoke is refused (F5), and acceptances after expiry stay too late.
    let (mut h, a, key) = funded(500);
    let valid_until = h.budget(&a).valid_until.0;
    h.advance(DAY + 10_000);
    h.expect_code(BUDGET_NOT_OPEN, |h| {
        h.ctx(acct(A), 0);
        h.hub.revoke_budget(a);
    });
    let between = claim(&a, S, &key, 1, 1);
    let after_expiry = acceptance(&between, &node_key(), valid_until / 1000 + 5);
    h.expect_err(ACCEPTANCE_TOO_LATE, |h| {
        settle_own_as(h, S, between.clone(), after_expiry.clone())
    });
}

#[test]
fn acceptance_covers_exactly_one_claim() {
    let (mut h, a, key) = funded(500);
    let b = h.open_simple(B, &key, 1000);
    h.deposit(B, &b, 500);
    let c = claim(&a, S, &key, 10, 10);
    let accepted = h.accept(&c);

    // Every field the node signed is bound: a voucher that differs in any of them needs its own acceptance.
    let variants = [
        claim(&a, S, &key, 9, 10),
        claim(&a, S, &key, 10, 11),
        claim(&a, MALLORY, &key, 10, 10),
        claim(&b, S, &key, 10, 10),
        {
            let mut other = claim(&a, S, &key, 10, 10);
            other.request_hash = id(0x77);
            let digest = voucher_digest(hub_id().as_str(), NET, &a, S, 10, 10, &other.request_hash);
            other.signature = Sig64(key.sign(&digest).to_bytes());
            other
        },
    ];
    for other in variants {
        let caller = other.payee.to_string();
        let reused = accepted.clone();
        h.expect_err(BAD_ACCEPTANCE, |h| {
            settle_own_as(h, &caller, other.clone(), reused.clone())
        });
    }
    // The signed time is bound too.
    let mut shifted = accepted.clone();
    shifted.timestamp_s = U64(accepted.timestamp_s.0 - 1);
    h.expect_err(BAD_ACCEPTANCE, |h| settle_own_as(h, S, c.clone(), shifted.clone()));

    settle_own_as(&mut h, S, c, accepted);
    assert_eq!(h.hub.credit_of(acct(S)).0, 10);
    h.assert_solvent();
}

#[test]
fn acceptance_must_come_from_the_budgets_own_settler() {
    let (mut h, a, key) = funded(100);
    // Another allowlisted settler registers its own key. It cannot vouch for a Budget that names the node.
    let other = "other-node.test";
    let other_key = agent(201);
    h.ctx(admin(), plenty());
    h.hub.set_settler(acct(other), true);
    h.ctx(acct("anyone.test"), plenty());
    h.hub.fund_storage(acct(other));
    h.ctx(acct(other), 1);
    h.hub.register_receipt_key(pk(&other_key));

    let c = claim(&a, S, &key, 10, 10);
    let wrong_settler = acceptance(&c, &other_key, h.now_s());
    h.expect_err(ACCEPTANCE_KEY_UNKNOWN, |h| {
        settle_own_as(h, S, c.clone(), wrong_settler.clone())
    });
    let right = h.accept(&c);
    settle_own_as(&mut h, S, c, right);
    assert_eq!(h.hub.credit_of(acct(S)).0, 10);
}

// ---- Receipt keys ----

#[test]
fn receipt_keys_are_registered_by_the_settler_itself_and_only_appended() {
    let mut h = Harness::new();
    assert_eq!(h.hub.receipt_keys(node()), vec![pk(&node_key())]);
    assert_eq!(h.hub.receipt_keys(acct(S)), vec![]);

    // Not the admin, not a stranger: only an allowlisted settler, for itself.
    h.expect_err(NOT_SETTLER, |h| {
        h.ctx(admin(), 1);
        h.hub.register_receipt_key(id(1));
    });
    h.expect_err(NOT_SETTLER, |h| {
        h.ctx(acct(MALLORY), 1);
        h.hub.register_receipt_key(id(1));
    });
    // Exactly one yoctoNEAR, so the node's function-call key cannot register a key.
    for deposit in [0, 2] {
        h.expect_code(ONE_YOCTO_REQUIRED, |h| {
            h.ctx(node(), deposit);
            h.hub.register_receipt_key(id(1));
        });
    }
    h.expect_err(RECEIPT_KEY_EXISTS, |h| {
        h.ctx(node(), 1);
        h.hub.register_receipt_key(pk(&node_key()));
    });

    // Rotation appends. A voucher accepted under the first key still settles after the node moved to another.
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);
    let old = claim(&a, S, &key, 10, 10);
    let old_acceptance = h.accept(&old);
    for n in 0..(MAX_RECEIPT_KEYS as u8 - 1) {
        h.ctx(node(), 1);
        h.hub.register_receipt_key(pk(&agent(210 + n)));
    }
    let keys = h.hub.receipt_keys(node());
    assert_eq!(keys.len(), MAX_RECEIPT_KEYS);
    assert_eq!(keys[0], pk(&node_key()), "the first key is still there, in order");
    h.expect_err(TOO_MANY_RECEIPT_KEYS, |h| {
        h.ctx(node(), 1);
        h.hub.register_receipt_key(id(9));
    });
    settle_own_as(&mut h, S, old, old_acceptance);
    let newer = claim(&a, S, &key, 5, 15);
    let newer_acceptance = acceptance(&newer, &agent(212), h.now_s());
    settle_own_as(&mut h, S, newer, newer_acceptance);
    assert_eq!(h.hub.credit_of(acct(S)).0, 15);

    // A settler taken off the allowlist keeps its keys, so its sellers can still settle by themselves.
    h.ctx(admin(), 1);
    h.hub.set_settler(node(), false);
    assert_eq!(h.hub.receipt_keys(node()).len(), MAX_RECEIPT_KEYS);
    let last = claim(&a, S, &key, 5, 20);
    let last_acceptance = h.accept(&last);
    settle_own_as(&mut h, S, last, last_acceptance);
    assert_eq!(h.hub.credit_of(acct(S)).0, 20);
    h.assert_solvent();
}

#[test]
fn registering_a_receipt_key_draws_on_the_settlers_storage_balance() {
    let mut h = Harness::new();
    let other = "other-node.test";
    h.ctx(admin(), plenty());
    h.hub.set_settler(acct(other), true);
    h.expect_err(INSUFFICIENT_STORAGE, |h| {
        h.ctx(acct(other), 1);
        h.hub.register_receipt_key(id(1));
    });
    assert_eq!(h.hub.receipt_keys(acct(other)), vec![]);

    h.ctx(acct("anyone.test"), plenty());
    h.hub.fund_storage(acct(other));
    for n in 1..=2u8 {
        let (balance, before) = (h.storage_of(other), h.usage());
        h.ctx(acct(other), 1);
        h.hub.register_receipt_key(id(n));
        let grown = h.usage() - before;
        assert!(grown >= 32);
        assert_eq!(balance - h.storage_of(other), u128::from(grown) * byte_cost());
    }
}

// ---- F7: the hub and the token are never payees or merchants ----

#[test]
fn f7_hub_and_token_accounts_are_never_credited() {
    let (mut h, a, key) = funded(100);
    for reserved in [hub_id(), token()] {
        let name = reserved.to_string();
        let c = claim(&a, &name, &key, 10, 10);
        let net = entries(&[(A, &name, 10)]);
        let batch = c.clone();
        h.expect_err(RESERVED_ACCOUNT, |h| h.settle(id(1), vec![batch.clone()], net.clone()));
        let accepted = h.accept(&c);
        h.expect_err(RESERVED_ACCOUNT, |h| {
            h.ctx(reserved.clone(), 0);
            h.hub.settle_own(c.clone(), accepted.clone());
        });
        // A Budget cannot even list them.
        let terms = h.terms(&key, 100, vec![S, &name]);
        h.expect_err(INVALID_BUDGET, |h| {
            h.open(B, terms.clone());
        });
        assert_eq!(h.hub.credit_of(reserved.clone()).0, 0);
    }

    // A checkout payment naming one of them as merchant is refunded in full.
    let checkout = agent(50);
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(pk(&checkout), node());
    for (n, reserved) in [hub_id(), token()].into_iter().enumerate() {
        let name = reserved.to_string();
        let digest = checkout_digest(hub_id().as_str(), NET, &id(n as u8), &name, 25, T0 + 1000);
        let msg = format!(
            r#"{{"payment":{{"payment_id":"{}","merchant":"{name}","amount":"25","expiry_ms":"{}","signature":"{}"}}}}"#,
            id(n as u8).to_hex(),
            T0 + 1000,
            Sig64(checkout.sign(&digest).to_bytes()).to_hex()
        );
        assert_eq!(h.transfer_in(B, 25, &msg), 25, "{name} as merchant");
        assert_eq!(h.hub.credit_of(reserved).0, 0);
    }
    h.assert_solvent();
}

// ---- F3: nobody grows the hub's storage at the hub's expense ----

/// The reviewer's case: the payee netted to zero in an earlier batch, so its `settled` entry existed and its
/// `credits` entry did not. Before the fix `settle_own` then wrote the `credits` entry and charged nobody.
#[test]
fn f3_settle_own_never_writes_storage_the_hub_pays_for() {
    let mut h = Harness::new();
    let a = h.open_simple(A, &agent(1), 1000);
    let b = h.open_simple(B, &agent(2), 1000);
    h.deposit(A, &a, 100);
    h.deposit(B, &b, 100);
    h.settle(
        id(1),
        vec![claim(&a, S, &agent(1), 10, 10), claim(&b, A, &agent(2), 10, 10)],
        entries(&[(A, S, 10), (B, A, 10)]),
    );
    // The seller is paid out, so its credit entry is gone while its settled entry stays.
    h.payout(&[S]);
    h.finish_payout(S, 10, true);
    assert!(h.hub.credits.get(&acct(S)).is_none());

    let reserve = h.budget(&a).storage_reserve_bytes.0;
    let before = h.usage();
    h.ctx(acct(S), 0);
    h.own(claim(&a, S, &agent(1), 5, 15));
    let grown = h.usage() - before;
    assert!(grown > 0, "a new credits entry was written");
    assert_eq!(
        reserve - h.budget(&a).storage_reserve_bytes.0,
        grown,
        "and the Budget's reserve paid for it"
    );
    h.assert_solvent();
}

#[test]
fn f3_settle_batch_charges_every_byte_to_the_budgets_reserve_or_the_settlers_balance() {
    let (mut h, a, key) = funded(1_000);
    let payees: Vec<String> = (0..20).map(|i| format!("payee-{i}.test")).collect();
    let claims: Vec<Claim> = payees.iter().map(|p| claim(&a, p, &key, 1, 1)).collect();
    let lines: Vec<(&str, &str, u128)> = payees.iter().map(|p| (A, p.as_str(), 1)).collect();

    let (balance, reserve, before) = (
        h.storage_of(node().as_str()),
        h.budget(&a).storage_reserve_bytes.0,
        h.usage(),
    );
    h.settle(id(1), claims, entries(&lines));
    let grown = h.usage() - before;
    assert!(
        grown > 20 * 100,
        "20 settled entries, 20 credit entries and a batch record: {grown} bytes"
    );
    let from_reserve = reserve - h.budget(&a).storage_reserve_bytes.0;
    let from_balance = balance - h.storage_of(node().as_str());
    assert_eq!(
        u128::from(from_reserve) * byte_cost() + from_balance,
        u128::from(grown) * byte_cost(),
        "the Budget and the settler paid for exactly the bytes written"
    );
    assert!(
        from_balance < 300 * byte_cost(),
        "the settler paid for its batch record only"
    );

    // A second voucher for the same pairs overwrites the entries, so only the batch record is new.
    let again: Vec<Claim> = payees.iter().map(|p| claim(&a, p, &key, 1, 2)).collect();
    let (balance, reserve, before) = (
        h.storage_of(node().as_str()),
        h.budget(&a).storage_reserve_bytes.0,
        h.usage(),
    );
    h.settle(id(2), again, entries(&lines));
    let record = h.usage() - before;
    assert!(record < 300, "only the batch record: {record} bytes");
    assert_eq!(
        balance - h.storage_of(node().as_str()),
        u128::from(record) * byte_cost()
    );
    assert_eq!(h.budget(&a).storage_reserve_bytes.0, reserve);
    h.assert_solvent();
}

#[test]
fn f3_settle_batch_without_storage_balance_is_refused_whole() {
    let (mut h, a, key) = funded(100);
    // The node withdraws everything it prepaid.
    let balance = h.storage_of(node().as_str());
    h.ctx(node(), 1);
    h.hub.withdraw_storage(U128(balance));
    assert_eq!(h.storage_of(node().as_str()), 0);

    let c = claim(&a, S, &key, 10, 10);
    let before = h.usage();
    h.expect_err(INSUFFICIENT_STORAGE, |h| {
        h.settle(id(1), vec![c.clone()], entries(&[(A, S, 10)]))
    });
    assert_eq!(h.usage(), before, "nothing was written");
    assert_eq!(h.budget(&a).spent.0, 0);
    assert!(h.batch(id(1)).is_none());

    // Anyone can top the settler up, and the same batch then settles.
    h.ctx(acct(MALLORY), byte_cost() * 1_000);
    h.hub.fund_storage(node());
    h.settle(id(1), vec![c], entries(&[(A, S, 10)]));
    assert_eq!(h.hub.credit_of(acct(S)).0, 10);
    h.assert_solvent();
}

#[test]
fn f3_checkout_payment_storage_is_charged_to_the_checkout_settler() {
    let mut h = Harness::new();
    let checkout = agent(50);
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(pk(&checkout), node());
    let msg = |n: u8| {
        let digest = checkout_digest(hub_id().as_str(), NET, &id(n), S, 25, T0 + 1000);
        format!(
            r#"{{"payment":{{"payment_id":"{}","merchant":"{S}","amount":"25","expiry_ms":"{}","signature":"{}"}}}}"#,
            id(n).to_hex(),
            T0 + 1000,
            Sig64(checkout.sign(&digest).to_bytes()).to_hex()
        )
    };

    let (balance, before) = (h.storage_of(node().as_str()), h.usage());
    assert_eq!(h.transfer_in(A, 25, &msg(1)), 0);
    h.accounts.insert(acct(S));
    let grown = h.usage() - before;
    assert!(grown > 150, "a payment record and a credits entry: {grown} bytes");
    assert_eq!(balance - h.storage_of(node().as_str()), u128::from(grown) * byte_cost());

    // With nothing prepaid the payment is not accepted. On chain the panic makes the token refund the payer.
    let balance = h.storage_of(node().as_str());
    h.ctx(node(), 1);
    h.hub.withdraw_storage(U128(balance));
    h.expect_err(INSUFFICIENT_STORAGE, |h| {
        h.transfer_in(A, 25, &msg(2));
    });
    assert_eq!(h.hub.payments(vec![id(2)]), vec![None]);
    assert_eq!(h.hub.credit_of(acct(S)).0, 25);
    h.assert_solvent();
}

#[test]
fn f3_payout_removes_empty_credit_entries_and_returns_their_storage_to_the_budget_that_paid() {
    let (mut h, a, key) = funded(100);
    let (start, reserve) = (h.storage_of(node().as_str()), h.budget(&a).storage_reserve_bytes.0);
    let base = h.usage();
    h.settle(id(1), vec![claim(&a, S, &key, 40, 40)], entries(&[(A, S, 40)]));
    let with_entry = h.usage();

    // In flight the entry stays, so a failed transfer restores into it and needs no new storage.
    h.payout(&[S]);
    assert_eq!(h.usage(), with_entry);
    h.finish_payout(S, 40, false);
    assert_eq!(h.usage(), with_entry);
    assert_eq!(h.hub.credit_of(acct(S)).0, 40);

    // A successful payout removes the entry, and the Budget whose settlement created it gets that storage back.
    let before_release = h.budget(&a).storage_reserve_bytes.0;
    h.payout(&[S]);
    h.finish_payout(S, 40, true);
    let freed = with_entry - h.usage();
    assert!(freed > 0, "the credits entry is gone");
    assert!(h.hub.credits.get(&acct(S)).is_none());
    assert_eq!(h.budget(&a).storage_reserve_bytes.0 - before_release, freed);
    // What the Budget and the settler have paid in the end is exactly what is still stored: the settled entry and the
    // batch record.
    let paid = u128::from(reserve - h.budget(&a).storage_reserve_bytes.0) * byte_cost() + start
        - h.storage_of(node().as_str());
    assert_eq!(paid, u128::from(h.usage() - base) * byte_cost());
    h.assert_solvent();
}

/// Two payouts of one account can be in flight at once. The entry must outlive both callbacks, in either order.
#[test]
fn f3_overlapping_payouts_keep_the_entry_until_nothing_is_in_flight() {
    let (mut h, a, key) = funded(100);
    h.settle(id(1), vec![claim(&a, S, &key, 40, 40)], entries(&[(A, S, 40)]));
    h.payout(&[S]);
    h.settle(id(2), vec![claim(&a, S, &key, 10, 50)], entries(&[(A, S, 10)]));
    h.payout(&[S]);
    assert_eq!(h.hub.totals().in_flight.0, 50);
    let with_entry = h.usage();

    // The first transfer lands. The second is still out, so the entry must stay to take a restore.
    h.finish_payout(S, 40, true);
    assert_eq!(
        h.usage(),
        with_entry,
        "an entry with an amount in flight is not removed"
    );
    h.finish_payout(S, 10, false);
    assert_eq!(h.usage(), with_entry, "the restore wrote no new storage");
    assert_eq!(h.hub.credit_of(acct(S)).0, 10);
    assert_eq!(h.hub.totals().in_flight.0, 0);
    h.assert_solvent();

    h.payout(&[S]);
    h.finish_payout(S, 10, true);
    assert!(h.hub.credits.get(&acct(S)).is_none());
    h.assert_solvent();
}

#[test]
fn f3_storage_released_from_a_settle_own_entry_goes_back_to_the_budgets_reserve() {
    let (mut h, a, key) = funded(100);
    let c = claim(&a, S, &key, 10, 10);
    let accepted = h.accept(&c);
    settle_own_as(&mut h, S, c, accepted);
    let node_balance = h.storage_of(node().as_str());
    let reserve = h.budget(&a).storage_reserve_bytes.0;
    let before = h.usage();
    h.payout(&[S]);
    h.finish_payout(S, 10, true);
    let freed = before - h.usage();
    assert!(freed > 0, "the entry is removed");
    assert_eq!(
        h.budget(&a).storage_reserve_bytes.0,
        reserve + freed,
        "the reserve that paid gets it back"
    );
    assert_eq!(
        h.storage_of(node().as_str()),
        node_balance,
        "the node did not pay for it and gets nothing"
    );
    assert_eq!(h.storage_of(S), 0);
    h.assert_solvent();
}

#[test]
fn f3_fund_from_credit_releases_an_emptied_entry_too() {
    let mut h = Harness::new();
    let a = h.open_simple(A, &agent(1), 1000);
    let b = h.open_simple(B, &agent(2), 1000);
    h.deposit(B, &b, 100);
    h.settle(id(1), vec![claim(&b, A, &agent(2), 30, 30)], entries(&[(B, A, 30)]));
    let (balance, reserve, before) = (
        h.storage_of(node().as_str()),
        h.budget(&b).storage_reserve_bytes.0,
        h.usage(),
    );
    h.ctx(acct(A), 1);
    h.hub.fund_from_credit(a, U128(30));
    let freed = before - h.usage();
    assert!(freed > 0);
    // B's settlement created A's credit entry, so B's reserve gets the bytes back, and the node nothing.
    assert_eq!(h.budget(&b).storage_reserve_bytes.0, reserve + freed);
    assert_eq!(h.storage_of(node().as_str()), balance);
    assert_eq!(h.budget(&a).escrow.0, 30);
    h.assert_solvent();
}

#[test]
fn f3_a_revoke_is_paid_for_when_the_budget_opens() {
    let mut h = Harness::new();
    let terms = h.terms(&agent(1), 100, vec![S]);
    let before = h.usage();
    h.ctx(acct(A), plenty());
    let a = h.hub.open_budget(terms);
    h.budgets.push(a);
    let record = h.usage() - before;
    let refund = match &near_sdk::test_utils::get_created_receipts()[0].actions[0] {
        near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
        other => panic!("expected a refund, got {other:?}"),
    };
    assert_eq!(
        plenty() - refund,
        u128::from(record + REVOKE_BYTES + crate::PAIR_BYTES) * byte_cost()
    );

    let before = h.usage();
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    assert_eq!(h.usage() - before, REVOKE_BYTES, "exactly the bytes the owner prepaid");
}

#[test]
fn storage_balance_is_funded_by_anyone_and_withdrawn_only_by_its_account() {
    let mut h = Harness::new();
    let other = "other-node.test";
    h.expect_err(ZERO_AMOUNT, |h| {
        h.ctx(acct(MALLORY), 0);
        h.hub.fund_storage(acct(other));
    });
    // The first deposit pays for the balance entry itself, so it must at least cover that.
    h.expect_err(INSUFFICIENT_DEPOSIT, |h| {
        h.ctx(acct(MALLORY), 1);
        h.hub.fund_storage(acct(other));
    });
    let before = h.usage();
    h.ctx(acct(MALLORY), plenty());
    h.hub.fund_storage(acct(other));
    let entry = u128::from(h.usage() - before) * byte_cost();
    assert!(entry > 0);
    assert_eq!(h.storage_of(other), plenty() - entry);
    // Later deposits add in full.
    h.ctx(acct(A), 5);
    h.hub.fund_storage(acct(other));
    assert_eq!(h.storage_of(other), plenty() - entry + 5);

    // Only the account itself withdraws, with exactly one yoctoNEAR, and never more than it has.
    h.expect_err(INSUFFICIENT_STORAGE, |h| {
        h.ctx(acct(MALLORY), 1);
        h.hub.withdraw_storage(U128(1));
    });
    h.expect_code(ONE_YOCTO_REQUIRED, |h| {
        h.ctx(acct(other), 0);
        h.hub.withdraw_storage(U128(1));
    });
    h.expect_err(ZERO_AMOUNT, |h| {
        h.ctx(acct(other), 1);
        h.hub.withdraw_storage(U128(0));
    });
    let balance = h.storage_of(other);
    h.expect_err(INSUFFICIENT_STORAGE, |h| {
        h.ctx(acct(other), 1);
        h.hub.withdraw_storage(U128(balance + 1));
    });
    let before = h.usage();
    h.ctx(acct(other), 1);
    h.hub.withdraw_storage(U128(balance));
    assert_eq!(h.storage_of(other), 0);
    assert_eq!(
        h.usage(),
        before,
        "the entry stays, so a later refund never needs new storage"
    );
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, acct(other));
}

// ---- F4: `payout` asks for the gas it really needs ----

#[test]
fn f4_payout_counts_the_gas_each_account_really_needs() {
    let (mut h, a, key) = funded(100);
    let payees: Vec<String> = (0..10).map(|i| format!("p{i}.test")).collect();
    let claims: Vec<Claim> = payees.iter().map(|p| claim(&a, p, &key, 1, 1)).collect();
    let lines: Vec<(&str, &str, u128)> = payees.iter().map(|p| (A, p.as_str(), 1)).collect();
    h.settle(id(1), claims, entries(&lines));
    let accounts: Vec<AccountId> = payees.iter().map(|p| acct(p)).collect();

    // Before the fix the hub asked for 210 Tgas for ten accounts, while the least that worked on sandbox was 228,
    // so a call between the two ran out of gas in the runtime instead of being refused up front.
    // The mocked runtime charges older, higher fees, so the call that succeeds is measured on sandbox, in
    // `tests/gas_profile.rs` and through `NearRpcChain` in `packages/chain/test/sandbox.test.ts`.
    let needed = PAYOUT_ACCOUNT_GAS * 10 + BASE_GAS;
    assert!(
        needed > Gas::from_tgas(228).as_gas(),
        "above what the old hub really needed"
    );
    assert!(needed <= Gas::from_tgas(300).as_gas(), "and within one transaction");
    h.expect_err(INSUFFICIENT_GAS, |h| {
        h.ctx_full(acct("anyone.test"), 0, Gas::from_gas(needed - 1), vec![]);
        h.hub.payout(accounts.clone());
    });
    for p in &payees {
        assert_eq!(h.hub.credit_of(acct(p)).0, 1, "a refused payout changes nothing");
    }
    assert_eq!(h.hub.totals().in_flight.0, 0);
}

// ---- F5: sellers get a day after a revoke ----

#[test]
fn f5_settlement_stays_open_for_24_hours_after_a_revoke() {
    assert_eq!(REVOKE_GRACE_MS, 24 * 3_600_000);
    let (mut h, a, key) = funded(100);
    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    h.advance(24 * 3_600_000);
    h.settle(id(1), vec![claim(&a, S, &key, 10, 10)], entries(&[(A, S, 10)]));
    h.expect_err(TOO_EARLY, |h| {
        h.ctx(acct(A), 0);
        h.hub.reclaim(a);
    });
    h.advance(1);
    let late = claim(&a, S, &key, 10, 20);
    h.expect_err(BUDGET_CLOSED, |h| {
        h.settle(id(2), vec![late.clone()], entries(&[(A, S, 10)]))
    });
    h.ctx(acct(A), 0);
    h.hub.reclaim(a);
    assert_eq!(h.hub.totals().in_flight.0, 90);
}
