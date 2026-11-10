//! NEP-297 events: every state change logs exactly the event it should, with its data.

use super::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The single event the last call logged, after checking the envelope.
fn only(h: &Harness, name: &str) -> Value {
    let events = h.events();
    let named: Vec<&Value> = events.iter().filter(|e| e["event"] == name).collect();
    assert_eq!(named.len(), 1, "{name} in {events:?}");
    let e = named[0];
    assert_eq!(e["standard"], "payminto");
    assert_eq!(e["version"], "1.0.0");
    assert_eq!(e["data"].as_array().unwrap().len(), 1);
    e["data"][0].clone()
}

#[test]
fn every_state_change_logs_its_event() {
    let mut seen = BTreeSet::new();
    let mut note = |h: &Harness| {
        for e in h.events() {
            seen.insert(e["event"].as_str().unwrap().to_string());
        }
    };

    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    let opened = only(&h, "budget_opened");
    assert_eq!(opened["budget_id"], a.to_hex());
    assert_eq!(opened["owner"], A);
    assert_eq!(opened["cap"], "1000");
    assert_eq!(opened["allow_any_payee"], true);
    assert_eq!(opened["storage_reserve_bytes"], (16 * crate::PAIR_BYTES).to_string());
    note(&h);

    h.deposit(A, &a, 100);
    assert_eq!(
        only(&h, "budget_funded"),
        json!({ "budget_id": a.to_hex(), "owner": A, "amount": "100", "escrow": "100" })
    );
    note(&h);

    h.settle(id(1), vec![claim(&a, S, &key, 10, 10)], entries(&[(A, S, 10)]));
    assert_eq!(
        only(&h, "batch_settled"),
        json!({ "settler": "node.test", "batch_id": id(1).to_hex(), "root": id(0xee).to_hex(), "claims": 1, "gross": "10", "net": "10" })
    );
    note(&h);

    h.ctx(acct(S), 0);
    h.own(claim(&a, S, &key, 5, 15));
    assert_eq!(
        only(&h, "claim_settled_by_payee"),
        json!({
            "budget_id": a.to_hex(),
            "payee": S,
            "cumulative": "15",
            "amount": "5",
            "storage_reserve_bytes": h.budget(&a).storage_reserve_bytes.0.to_string()
        })
    );
    note(&h);

    h.payout(&[S]);
    assert_eq!(only(&h, "payout_started"), json!({ "account": S, "amount": "15" }));
    note(&h);
    h.finish_payout(S, 15, false);
    assert_eq!(
        only(&h, "payout_finished"),
        json!({ "account": S, "amount": "15", "success": false })
    );
    note(&h);

    // The owner earns credit as a payee of B, then moves it into its own escrow.
    let kb = agent(2);
    let b = h.open_simple(B, &kb, 1000);
    h.deposit(B, &b, 50);
    h.settle(id(2), vec![claim(&b, A, &kb, 20, 20)], entries(&[(B, A, 20)]));
    h.ctx(acct(A), 1);
    h.hub.fund_from_credit(a, U128(20));
    assert_eq!(
        only(&h, "credit_moved_to_escrow"),
        json!({ "budget_id": a.to_hex(), "owner": A, "amount": "20", "escrow": "105" })
    );
    note(&h);

    h.ctx(acct(A), 0);
    h.hub.revoke_budget(a);
    let revoked = only(&h, "budget_revoked");
    assert_eq!(revoked["revoked_at"], T0.to_string());
    assert_eq!(revoked["settle_deadline"], (T0 + REVOKE_GRACE_MS).to_string());
    note(&h);

    h.advance(REVOKE_GRACE_MS + 1);
    h.ctx(acct(A), 0);
    h.hub.reclaim(a);
    assert_eq!(
        only(&h, "reclaim_started"),
        json!({ "budget_id": a.to_hex(), "owner": A, "amount": "105" })
    );
    note(&h);
    h.finish_reclaim(a, 105, true);
    assert_eq!(
        only(&h, "reclaim_finished"),
        json!({ "budget_id": a.to_hex(), "amount": "105", "success": true })
    );
    note(&h);

    h.ctx(acct(A), 0);
    h.hub.prune(a, vec![acct(S)]);
    let pruned = only(&h, "budget_pruned");
    assert_eq!(pruned["owner"], A);
    assert_eq!(pruned["payees"], 1);
    note(&h);

    let checkout_key = agent(50);
    h.ctx(admin(), plenty());
    h.hub.set_checkout_key(pk(&checkout_key), node());
    assert_eq!(
        only(&h, "checkout_key_proposed"),
        json!({ "key": pk(&checkout_key).to_hex(), "settler": "node.test" })
    );
    note(&h);
    h.ctx(node(), 1);
    h.hub.accept_checkout(pk(&checkout_key));
    assert_eq!(
        only(&h, "checkout_key_set"),
        json!({ "key": pk(&checkout_key).to_hex(), "settler": "node.test" })
    );
    note(&h);
    h.ctx(admin(), 1);
    h.hub.set_min_payment(U128(1));
    assert_eq!(only(&h, "min_payment_set"), json!({ "amount": "1" }));
    note(&h);

    let expiry = h.now_ms + DAY;
    let digest = checkout_digest(hub_id().as_str(), NET, &id(9), "shop.test", 7, expiry);
    let msg = format!(
        r#"{{"payment":{{"payment_id":"{}","merchant":"shop.test","amount":"7","expiry_ms":"{expiry}","signature":"{}"}}}}"#,
        id(9).to_hex(),
        Sig64(checkout_key.sign(&digest).to_bytes()).to_hex()
    );
    assert_eq!(h.transfer_in("payer.test", 7, &msg), 0);
    h.accounts.insert(acct("shop.test"));
    assert_eq!(
        only(&h, "payment_received"),
        json!({ "payment_id": id(9).to_hex(), "merchant": "shop.test", "amount": "7", "payer": "payer.test" })
    );
    note(&h);

    h.ctx(admin(), plenty());
    h.hub.set_settler(acct("node3.test"), true);
    assert_eq!(
        only(&h, "settler_set"),
        json!({ "account": "node3.test", "allowed": true })
    );
    note(&h);

    h.ctx(node(), 1);
    h.hub.register_receipt_key(pk(&agent(201)));
    assert_eq!(
        only(&h, "receipt_key_registered"),
        json!({ "settler": "node.test", "key": pk(&agent(201)).to_hex() })
    );
    note(&h);

    let before = h.storage_of("node.test");
    h.ctx(acct("anyone.test"), 1_000);
    h.hub.fund_storage(node());
    assert_eq!(
        only(&h, "storage_funded"),
        json!({ "account": "node.test", "amount": "1000", "balance": (before + 1000).to_string() })
    );
    note(&h);
    h.ctx(node(), 1);
    h.hub.withdraw_storage(U128(1000));
    assert_eq!(
        only(&h, "storage_withdrawn"),
        json!({ "account": "node.test", "amount": "1000", "balance": before.to_string() })
    );
    note(&h);

    h.ctx(admin(), plenty());
    h.hub.propose_admin(Some(acct("next-admin.test")));
    assert_eq!(
        only(&h, "admin_proposed"),
        json!({ "admin": "admin.test", "pending_admin": "next-admin.test" })
    );
    note(&h);
    h.ctx(acct("next-admin.test"), 1);
    h.hub.accept_admin();
    assert_eq!(
        only(&h, "admin_transferred"),
        json!({ "from": "admin.test", "to": "next-admin.test" })
    );
    note(&h);

    let all: BTreeSet<String> = crate::events::ALL.iter().map(|s| s.to_string()).collect();
    assert_eq!(seen, all, "every event is logged by some state change");
    h.assert_solvent();
}

#[test]
fn a_refused_call_and_a_view_log_nothing() {
    let mut h = Harness::new();
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.ctx(acct(S), 0);
    let _ = h.hub.budget(a);
    let _ = h.hub.totals();
    assert!(h.events().is_empty());
    // A refund by the token receiver is not a state change either.
    assert_eq!(h.transfer_in(B, 5, &budget_msg(&a)), 5);
    assert!(h.events().is_empty());
}
