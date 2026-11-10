//! Integration tests that run the real hub and mock NEP-141 wasm inside `near-sandbox`.

mod common;

use common::*;
use serde_json::json;
use testresult::TestResult;

const DAY_MS: u64 = 86_400_000;

#[tokio::test]
async fn offset_settles_more_gross_than_escrow_and_payout_balances() -> TestResult<()> {
    let w = World::start().await?;
    let a = w.create("alice").await?;
    let b = w.create("bob").await?;
    w.mint(&a, 1_000).await?;
    w.mint(&b, 1_000).await?;
    let (ka, kb) = (agent(1), agent(2));
    let ba = w.open_budget(&a, &ka, 1_000, DAY_MS, &[], 1).await?;
    let bb = w.open_budget(&b, &kb, 1_000, DAY_MS, &[], 2).await?;
    w.deposit(&a, &ba, 5).await?;
    w.deposit(&b, &bb, 5).await?;
    assert_eq!(w.budget(&ba).await?["cap"], "1000", "deposit does not raise the cap");
    assert_eq!(w.budget(&ba).await?["escrow"], "5");
    w.assert_solvent().await?;

    // Offsetting is off in this batch: it has only one side, so the gross debit exceeds escrow.
    let one_side = voucher(&w.hub, &ka, &ba, &b, 100, 100);
    w.settle(
        &w.node,
        id32(1),
        vec![one_side.clone()],
        vec![net_entry(&a, 100, 0), net_entry(&b, 0, 100)],
    )
    .await?
    .assert_failure();
    assert_eq!(
        w.budget(&ba).await?["spent"],
        "0",
        "a rejected batch leaves no partial state"
    );

    let back = voucher(&w.hub, &kb, &bb, &a, 98, 98);
    let expected = vec![net_entry(&a, 2, 0), net_entry(&b, 0, 2)];
    w.settle(&w.node, id32(2), vec![one_side, back], expected.clone())
        .await?
        .assert_success();
    assert_eq!(w.budget(&ba).await?["escrow"], "3");
    assert_eq!(w.budget(&ba).await?["spent"], "100");
    assert_eq!(w.budget(&bb).await?["escrow"], "5");
    assert_eq!(w.credit(&b).await?, 2);
    let batch: serde_json::Value = w.view(&w.hub, "batch", json!({ "batch_id": id32(2) })).await?;
    assert_eq!(
        (batch["gross"].as_str().unwrap(), batch["net"].as_str().unwrap()),
        ("198", "2")
    );
    w.assert_solvent().await?;

    // Replay and stale vouchers are refused and change nothing.
    w.settle(
        &w.node,
        id32(2),
        vec![voucher(&w.hub, &ka, &ba, &b, 1, 101)],
        vec![net_entry(&a, 1, 0), net_entry(&b, 0, 1)],
    )
    .await?
    .assert_failure();
    w.settle(&w.node, id32(3), vec![voucher(&w.hub, &ka, &ba, &b, 100, 100)], vec![])
        .await?
        .assert_failure();

    // Payout is real: the creditor's token balance rises and the invariant holds at the end.
    let before = w.token_balance(&b).await?;
    w.call(&acct("usdc.sandbox"), &w.hub, "payout", json!({ "accounts": [b] }))
        .await?
        .assert_success();
    assert_eq!(w.token_balance(&b).await?, before + 2);
    assert_eq!(w.credit(&b).await?, 0);
    let (_, _, in_flight) = w.totals().await?;
    assert_eq!(in_flight, 0);
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn fund_from_credit_moves_earned_credit_into_escrow() -> TestResult<()> {
    let w = World::start().await?;
    let a = w.create("alice").await?;
    let b = w.create("bob").await?;
    let s = w.create("seller").await?;
    w.mint(&a, 1_000).await?;
    w.mint(&b, 1_000).await?;
    let (ka, kb) = (agent(1), agent(2));
    let ba = w.open_budget(&a, &ka, 1_000, DAY_MS, &[], 1).await?;
    let bb = w.open_budget(&b, &kb, 1_000, DAY_MS, &[], 2).await?;
    w.deposit(&a, &ba, 5).await?;
    w.deposit(&b, &bb, 100).await?;

    // B's agent pays A 30, so A earns hub credit.
    w.settle(
        &w.node,
        id32(1),
        vec![voucher(&w.hub, &kb, &bb, &a, 30, 30)],
        vec![net_entry(&a, 0, 30), net_entry(&b, 30, 0)],
    )
    .await?
    .assert_success();
    assert_eq!(w.credit(&a).await?, 30);

    // A's own batch to the seller needs 30 and escrow holds only 5.
    let spend = voucher(&w.hub, &ka, &ba, &s, 30, 30);
    let spend_net = vec![net_entry(&a, 30, 0), net_entry(&s, 0, 30)];
    w.settle(&w.node, id32(2), vec![spend.clone()], spend_net.clone())
        .await?
        .assert_failure();

    // Only the owner, with exactly one yoctoNEAR, and only up to the credit.
    let one = near_api::NearToken::from_yoctonear(1);
    let args = |amount: &str| json!({ "budget_id": ba, "amount": amount });
    w.call_with_deposit(&b, &w.hub, "fund_from_credit", args("1"), one)
        .await?
        .assert_failure();
    w.call(&a, &w.hub, "fund_from_credit", args("1"))
        .await?
        .assert_failure();
    w.call_with_deposit(&a, &w.hub, "fund_from_credit", args("31"), one)
        .await?
        .assert_failure();
    w.call_with_deposit(&a, &w.hub, "fund_from_credit", args("0"), one)
        .await?
        .assert_failure();
    assert_eq!(w.credit(&a).await?, 30);

    let before = w.totals().await?;
    let result = w
        .call_with_deposit(&a, &w.hub, "fund_from_credit", args("25"), one)
        .await?;
    let near_api::types::transaction::result::TransactionResult::Full(full) = result else {
        return Err("fund_from_credit is still pending".into());
    };
    println!(
        "fund_from_credit gas burnt: {:.2} Tgas",
        full.total_gas_burnt.as_gas() as f64 / 1e12
    );
    full.into_result().map_err(|e| format!("{e:?}"))?;
    let after = w.totals().await?;
    assert_eq!(
        after.0 + after.1,
        before.0 + before.1,
        "escrow plus credits is unchanged"
    );
    assert_eq!(w.credit(&a).await?, 5);
    assert_eq!(w.budget(&ba).await?["escrow"], "30");
    assert_eq!(w.budget(&ba).await?["cap"], "1000", "funding never raises the cap");
    w.assert_solvent().await?;

    w.settle(&w.node, id32(3), vec![spend], spend_net)
        .await?
        .assert_success();
    assert_eq!(w.budget(&ba).await?["escrow"], "0");
    assert_eq!(w.credit(&s).await?, 30);

    // A revoked Budget can no longer be funded from credit.
    w.call(&a, &w.hub, "revoke_budget", json!({ "budget_id": ba }))
        .await?
        .assert_success();
    w.call_with_deposit(&a, &w.hub, "fund_from_credit", args("1"), one)
        .await?
        .assert_failure();
    assert_eq!(w.credit(&a).await?, 5);
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn payout_failure_restores_credit_through_the_real_callback() -> TestResult<()> {
    let w = World::start().await?;
    let a = w.create("alice").await?;
    w.mint(&a, 1_000).await?;
    let unregistered = acct("nobody.sandbox");
    w.sandbox
        .create_account(unregistered.as_str().parse()?)
        .initial_balance(near_api::NearToken::from_near(5))
        .send()
        .await?;

    let ka = agent(1);
    let ba = w.open_budget(&a, &ka, 1_000, DAY_MS, &[], 1).await?;
    w.deposit(&a, &ba, 40).await?;
    let claim = voucher(&w.hub, &ka, &ba, &unregistered, 40, 40);
    w.settle(
        &w.node,
        id32(1),
        vec![claim],
        vec![net_entry(&a, 40, 0), net_entry(&unregistered, 0, 40)],
    )
    .await?
    .assert_success();
    assert_eq!(w.credit(&unregistered).await?, 40);

    // The transaction succeeds because the transfer failure is handled, and the callback restores the credit.
    w.call(&a, &w.hub, "payout", json!({ "accounts": [unregistered] }))
        .await?
        .assert_success();
    assert_eq!(
        w.credit(&unregistered).await?,
        40,
        "credit is restored after the failed transfer"
    );
    let (_, _, in_flight) = w.totals().await?;
    assert_eq!(in_flight, 0);
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn callbacks_cannot_be_called_directly() -> TestResult<()> {
    let w = World::start().await?;
    let attacker = w.create("attacker").await?;
    let result = w
        .call(
            &attacker,
            &w.hub,
            "on_payout",
            json!({ "account": attacker, "amount": "1000" }),
        )
        .await?;
    result.assert_failure();
    assert_eq!(w.credit(&attacker).await?, 0);
    let result = w
        .call(
            &attacker,
            &w.hub,
            "on_reclaim",
            json!({ "budget_id": id32(1), "amount": "1000" }),
        )
        .await?;
    result.assert_failure();
    Ok(())
}

#[tokio::test]
async fn ft_on_transfer_refunds_the_sender_on_bad_input() -> TestResult<()> {
    let w = World::start().await?;
    let a = w.create("alice").await?;
    w.mint(&a, 1_000).await?;
    let start = w.token_balance(&a).await?;
    for msg in ["not json", "{}", r#"{"budget":{"budget_id":"zz"}}"#, r#"{"nope":1}"#] {
        w.ft_transfer_call(&a, 10, msg).await?.assert_success();
        assert_eq!(w.token_balance(&a).await?, start, "msg: {msg}");
    }
    w.assert_solvent().await?;

    // Only the owner can fund a Budget, and a stranger's transfer comes back in full.
    let owner = w.create("owner").await?;
    w.mint(&owner, 100).await?;
    let budget = w.open_budget(&owner, &agent(1), 100, DAY_MS, &[], 9).await?;
    let msg = json!({ "budget": { "budget_id": budget } }).to_string();
    w.ft_transfer_call(&a, 7, &msg).await?.assert_success();
    assert_eq!(w.token_balance(&a).await?, start);
    assert_eq!(w.budget(&budget).await?["escrow"], "0");
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn checkout_payment_credits_the_merchant_and_rejects_repeats() -> TestResult<()> {
    let w = World::start().await?;
    let payer = w.create("payer").await?;
    let merchant = w.create("merchant").await?;
    w.mint(&payer, 100).await?;
    let key = agent(50);
    w.call_with_deposit(
        &w.admin,
        &w.hub,
        "set_checkout_key",
        json!({ "key": payminto_hub::types::Id32(key.verifying_key().to_bytes()), "settler": w.node }),
        near_api::NearToken::from_millinear(10),
    )
    .await?
    .assert_success();

    let expiry = now_ms() + 600_000;
    let msg = checkout_msg(&w.hub, &key, id32(1), &merchant, 25, expiry);
    w.ft_transfer_call(&payer, 25, &msg).await?.assert_success();
    assert_eq!(w.credit(&merchant).await?, 25);
    let rows: Vec<serde_json::Value> = w.view(&w.hub, "payments", json!({ "ids": [id32(1), id32(2)] })).await?;
    assert_eq!(rows[0]["merchant"], merchant.to_string());
    assert!(rows[1].is_null());
    w.assert_solvent().await?;

    let before = w.token_balance(&payer).await?;
    w.ft_transfer_call(&payer, 25, &msg).await?.assert_success();
    assert_eq!(
        w.token_balance(&payer).await?,
        before,
        "a repeated payment id is refunded"
    );

    let bad = checkout_msg(&w.hub, &agent(51), id32(3), &merchant, 25, expiry);
    w.ft_transfer_call(&payer, 25, &bad).await?.assert_success();
    assert_eq!(w.token_balance(&payer).await?, before, "a bad signature is refunded");
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn revoke_reclaim_and_settle_own_flow_after_the_grace_period() -> TestResult<()> {
    let w = World::start().await?;
    let a = w.create("alice").await?;
    let s = w.create("seller").await?;
    w.mint(&a, 1_000).await?;
    let ka = agent(1);
    let ba = w.open_budget(&a, &ka, 1_000, DAY_MS, &[], 1).await?;
    w.deposit(&a, &ba, 100).await?;

    // The payee settles its own voucher, showing the acceptance the node gave it. The node takes no part.
    let v1 = voucher(&w.hub, &ka, &ba, &s, 30, 30);
    let accepted = accepted_now(&v1);
    w.settle_own(&s, &v1, &accepted).await?.assert_success();
    assert_eq!(w.budget(&ba).await?["escrow"], "70");
    assert_eq!(w.credit(&s).await?, 30);
    w.assert_solvent().await?;

    // Only the payee may call it, and the same voucher is stale in a following batch.
    w.settle_own(&a, &v1, &accepted).await?.assert_failure();
    w.settle(
        &w.node,
        id32(1),
        vec![v1],
        vec![net_entry(&a, 30, 0), net_entry(&s, 0, 30)],
    )
    .await?
    .assert_failure();
    assert_eq!(w.credit(&s).await?, 30);
    w.assert_solvent().await?;

    w.call(&a, &w.hub, "revoke_budget", json!({ "budget_id": ba }))
        .await?
        .assert_success();
    w.call(&a, &w.hub, "reclaim", json!({ "budget_id": ba }))
        .await?
        .assert_failure();

    let v2 = voucher(&w.hub, &ka, &ba, &s, 10, 40);
    w.settle(
        &w.node,
        id32(2),
        vec![v2],
        vec![net_entry(&a, 10, 0), net_entry(&s, 0, 10)],
    )
    .await?
    .assert_success();
    assert_eq!(w.budget(&ba).await?["escrow"], "60");

    // End the revoke grace period by moving the stored revoke time back, rather than fast-forwarding 12,000 blocks:
    // a fast-forward that long stalled near-sandbox 2.14.0 under load and hung this test. The hub still compares the
    // real block time against `revoked_at + REVOKE_GRACE_MS`, so the deadline check itself is unchanged.
    let now = w.near_block_timestamp_ms().await?;
    w.patch_revoked_at(&ba, now - payminto_hub::REVOKE_GRACE_MS - 60_000)
        .await?;

    let v3 = voucher(&w.hub, &ka, &ba, &s, 10, 50);
    w.settle(
        &w.node,
        id32(3),
        vec![v3],
        vec![net_entry(&a, 10, 0), net_entry(&s, 0, 10)],
    )
    .await?
    .assert_failure();

    let owner_before = w.token_balance(&a).await?;
    w.call(&a, &w.hub, "reclaim", json!({ "budget_id": ba }))
        .await?
        .assert_success();
    assert_eq!(w.token_balance(&a).await?, owner_before + 60);
    assert_eq!(w.budget(&ba).await?["escrow"], "0");
    w.assert_solvent().await?;
    Ok(())
}

/// The reason a transaction failed, as text, or `None` when it succeeded.
fn failure_of(result: near_api::types::transaction::result::TransactionResult) -> Option<String> {
    let near_api::types::transaction::result::TransactionResult::Full(full) = result else {
        return Some("pending".to_string());
    };
    full.into_result().err().map(|e| format!("{e:?}"))
}

fn assert_refused(result: near_api::types::transaction::result::TransactionResult, code: &str) {
    let failure = failure_of(result).unwrap_or_else(|| panic!("expected {code}, but the call succeeded"));
    assert!(
        failure.contains(code),
        "expected {code}, got: {}",
        failure.chars().take(400).collect::<String>()
    );
}

/// Review findings F1 and F2 against the real wasm: `settle_own` needs the node's acceptance of that exact call.
#[tokio::test]
async fn settle_own_refuses_vouchers_the_node_never_accepted() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("owner").await?;
    let seller = w.create("seller").await?;
    let mallory = w.create("mallory").await?;
    w.mint(&owner, 1_000).await?;
    let key = agent(1);
    let budget = w.open_budget(&owner, &key, 1_000, DAY_MS, &[], 1).await?;
    w.deposit(&owner, &budget, 100).await?;
    let keys: Vec<String> = w.view(&w.hub, "receipt_keys", json!({ "settler": w.node })).await?;
    assert_eq!(keys.len(), 1, "the node registered one receipt key");

    // The seller holds a voucher the node accepted.
    let served = voucher(&w.hub, &key, &budget, &seller, 60, 60);
    let served_acceptance = accepted_now(&served);

    // F1: the owner chose the agent key, so it can sign a voucher to itself or to an accomplice. Neither settles.
    let to_self = voucher(&w.hub, &key, &budget, &owner, 100, 100);
    assert_refused(
        w.settle_own(&owner, &to_self, &accepted_now(&to_self)).await?,
        "PAYEE_IS_OWNER",
    );
    let to_accomplice = voucher(&w.hub, &key, &budget, &mallory, 100, 100);
    let now_s = now_ms() / 1000;
    assert_refused(
        w.settle_own(&mallory, &to_accomplice, &acceptance(&to_accomplice, &key, now_s))
            .await?,
        "ACCEPTANCE_KEY_UNKNOWN",
    );
    assert_refused(
        w.settle_own(&mallory, &to_accomplice, &served_acceptance).await?,
        "BAD_ACCEPTANCE",
    );
    assert_eq!(w.budget(&budget).await?["escrow"], "100");

    // F2: after the revoke a leaked agent key signs a voucher. Even an acceptance by the node's own key is too late.
    w.call(&owner, &w.hub, "revoke_budget", json!({ "budget_id": budget }))
        .await?
        .assert_success();
    let revoked_ms: u64 = w.budget(&budget).await?["revoked_at"].as_str().unwrap().parse()?;
    let stolen = voucher(&w.hub, &key, &budget, &mallory, 100, 100);
    assert_refused(
        w.settle_own(
            &mallory,
            &stolen,
            &acceptance(&stolen, &node_key(), revoked_ms / 1000 + 1),
        )
        .await?,
        "ACCEPTANCE_TOO_LATE",
    );
    assert_eq!(w.budget(&budget).await?["escrow"], "100");
    assert_eq!(w.credit(&mallory).await?, 0);

    // The seller the node served before the revoke settles by itself inside the grace period.
    w.settle_own(&seller, &served, &served_acceptance)
        .await?
        .assert_success();
    assert_eq!(w.credit(&seller).await?, 60);
    assert_eq!(w.budget(&budget).await?["escrow"], "40");
    w.assert_solvent().await?;
    Ok(())
}

/// Review finding F3: 100 one-unit claims to 100 new payees write about 23 kB, and the hub pays for none of it.
/// The hub's own balance is what it holds beyond its storage lock and the node's prepaid storage balance.
#[tokio::test]
async fn one_hundred_claims_to_new_payees_do_not_reduce_the_hubs_free_balance() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("owner").await?;
    w.mint(&owner, 1_000).await?;
    let key = agent(1);
    let budget = w.open_budget(&owner, &key, 1_000, DAY_MS, &[], 1).await?;
    w.deposit(&owner, &budget, 100).await?;

    let mut claims = Vec::new();
    let mut expected: std::collections::BTreeMap<String, serde_json::Value> = Default::default();
    for i in 0..100 {
        let payee = acct(&format!("new-payee-{i}.sandbox"));
        claims.push(voucher(&w.hub, &key, &budget, &payee, 1, 1));
        expected.insert(payee.to_string(), net_entry(&payee, 0, 1));
    }
    expected.insert(owner.to_string(), net_entry(&owner, 100, 0));

    let free_before = w.hub_own_balance().await?;
    let (_, storage_before) = w.near_account(&w.hub).await?;
    let prepaid_before = w.storage_of(&w.node).await?;
    w.settle(&w.node, id32(1), claims, expected.into_values().collect())
        .await?
        .assert_success();
    let free_after = w.hub_own_balance().await?;
    let (_, storage_after) = w.near_account(&w.hub).await?;
    let prepaid_after = w.storage_of(&w.node).await?;

    let grown = storage_after - storage_before;
    assert!(grown > 100 * 200, "100 settled and 100 credit entries: {grown} bytes");
    assert_eq!(
        prepaid_before - prepaid_after,
        u128::from(grown) * BYTE_COST,
        "the settler's storage balance paid for exactly the bytes written"
    );
    assert!(
        free_after >= free_before,
        "the hub's own balance fell by {} yoctoNEAR",
        free_before - free_after.min(free_before)
    );
    println!(
        "100 claims to new payees: {grown} bytes, {} yoctoNEAR from the settler's storage balance, hub own balance +{} yoctoNEAR",
        prepaid_before - prepaid_after,
        free_after - free_before
    );
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn settlement_storage_is_prepaid_refused_without_it_and_returned_on_payout() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("owner").await?;
    let seller = w.create("seller").await?;
    w.mint(&owner, 1_000).await?;
    let key = agent(1);
    let budget = w.open_budget(&owner, &key, 1_000, DAY_MS, &[], 1).await?;
    w.deposit(&owner, &budget, 100).await?;
    let one = near_api::NearToken::from_yoctonear(1);

    // The node withdraws all it prepaid. Its function-call-style call with no deposit cannot do that.
    let prepaid = w.storage_of(&w.node).await?;
    w.call(
        &w.node,
        &w.hub,
        "withdraw_storage",
        json!({ "amount": prepaid.to_string() }),
    )
    .await?
    .assert_failure();
    let (near_before, _) = w.near_account(&w.node).await?;
    w.call_with_deposit(
        &w.node,
        &w.hub,
        "withdraw_storage",
        json!({ "amount": prepaid.to_string() }),
        one,
    )
    .await?
    .assert_success();
    assert_eq!(w.storage_of(&w.node).await?, 0);
    let (near_after, _) = w.near_account(&w.node).await?;
    assert!(near_after > near_before + prepaid - near_api::NearToken::from_millinear(10).as_yoctonear());

    // With nothing prepaid the batch is refused whole: the real runtime reverts every write.
    let claim = voucher(&w.hub, &key, &budget, &seller, 40, 40);
    let net = vec![net_entry(&owner, 40, 0), net_entry(&seller, 0, 40)];
    let (_, storage_before) = w.near_account(&w.hub).await?;
    assert_refused(
        w.settle(&w.node, id32(1), vec![claim.clone()], net.clone()).await?,
        "INSUFFICIENT_STORAGE",
    );
    assert_eq!(w.budget(&budget).await?["spent"], "0");
    assert_eq!(w.credit(&seller).await?, 0);
    assert_eq!(w.near_account(&w.hub).await?.1, storage_before);

    // Anyone may fund the settler, and the same batch then settles.
    w.call_with_deposit(
        &owner,
        &w.hub,
        "fund_storage",
        json!({ "account": w.node }),
        near_api::NearToken::from_millinear(100),
    )
    .await?
    .assert_success();
    let funded = w.storage_of(&w.node).await?;
    assert_eq!(funded, near_api::NearToken::from_millinear(100).as_yoctonear());
    w.settle(&w.node, id32(1), vec![claim], net).await?.assert_success();
    let (_, storage_settled) = w.near_account(&w.hub).await?;
    let charged = funded - w.storage_of(&w.node).await?;
    assert_eq!(charged, u128::from(storage_settled - storage_before) * BYTE_COST);

    // The payout's real callback removes the emptied credit entry and returns its storage to the settler.
    let free_before = w.hub_own_balance().await?;
    w.call(&owner, &w.hub, "payout", json!({ "accounts": [seller] }))
        .await?
        .assert_success();
    assert_eq!(w.token_balance(&seller).await?, 40);
    let (_, storage_paid) = w.near_account(&w.hub).await?;
    let freed = storage_settled - storage_paid;
    assert!(freed > 0, "the credit entry is removed");
    assert_eq!(
        w.storage_of(&w.node).await? + charged - funded,
        u128::from(freed) * BYTE_COST,
        "the settler got back exactly the freed bytes"
    );
    // The one thing the hub spends is the single yoctoNEAR that NEP-141 requires on each transfer.
    assert_eq!(w.hub_own_balance().await? + 1, free_before);
    w.assert_solvent().await?;
    Ok(())
}

#[tokio::test]
async fn checkout_payment_draws_on_the_checkout_settlers_storage_and_is_refunded_without_it() -> TestResult<()> {
    let w = World::start().await?;
    let payer = w.create("payer").await?;
    let merchant = w.create("merchant").await?;
    w.mint(&payer, 100).await?;
    let key = agent(50);
    w.call_with_deposit(
        &w.admin,
        &w.hub,
        "set_checkout_key",
        json!({ "key": payminto_hub::types::Id32(key.verifying_key().to_bytes()), "settler": w.node }),
        near_api::NearToken::from_millinear(10),
    )
    .await?
    .assert_success();
    let settler: Option<String> = w.view(&w.hub, "checkout_settler", json!({})).await?;
    assert_eq!(settler, Some(w.node.to_string()));

    let expiry = now_ms() + 600_000;
    let free_before = w.hub_own_balance().await?;
    let prepaid = w.storage_of(&w.node).await?;
    let (_, storage_before) = w.near_account(&w.hub).await?;
    w.ft_transfer_call(&payer, 25, &checkout_msg(&w.hub, &key, id32(1), &merchant, 25, expiry))
        .await?
        .assert_success();
    assert_eq!(w.credit(&merchant).await?, 25);
    let (_, storage_after) = w.near_account(&w.hub).await?;
    assert_eq!(
        prepaid - w.storage_of(&w.node).await?,
        u128::from(storage_after - storage_before) * BYTE_COST
    );
    assert!(w.hub_own_balance().await? >= free_before);

    // The hub and the token are never merchants: such a payment comes straight back.
    let balance = w.token_balance(&payer).await?;
    for (n, reserved) in [w.hub.clone(), w.token.clone()].iter().enumerate() {
        let msg = checkout_msg(&w.hub, &key, id32(10 + n as u8), reserved, 25, expiry);
        w.ft_transfer_call(&payer, 25, &msg).await?.assert_success();
        assert_eq!(w.token_balance(&payer).await?, balance);
        assert_eq!(w.credit(reserved).await?, 0);
    }

    // With nothing prepaid the hub refuses the payment, and NEP-141 resolution returns the tokens to the payer.
    let left = w.storage_of(&w.node).await?;
    w.call_with_deposit(
        &w.node,
        &w.hub,
        "withdraw_storage",
        json!({ "amount": left.to_string() }),
        near_api::NearToken::from_yoctonear(1),
    )
    .await?
    .assert_success();
    let refused = w
        .ft_transfer_call(&payer, 25, &checkout_msg(&w.hub, &key, id32(2), &merchant, 25, expiry))
        .await?;
    let near_api::types::transaction::result::TransactionResult::Full(refused) = refused else {
        return Err("the refused payment is still pending".into());
    };
    let outcomes = format!("{:?}", refused.outcomes());
    assert!(
        outcomes.contains("INSUFFICIENT_STORAGE"),
        "the hub names the reason in its receipt"
    );
    assert_eq!(w.token_balance(&payer).await?, balance, "the payment was refunded");
    assert_eq!(w.credit(&merchant).await?, 25);
    let rows: Vec<serde_json::Value> = w.view(&w.hub, "payments", json!({ "ids": [id32(2)] })).await?;
    assert!(rows[0].is_null());
    w.assert_solvent().await?;
    Ok(())
}

/// Review finding F4: the hub asks for the gas a payout really needs, and ten accounts fit in one transaction.
#[tokio::test]
async fn payout_to_ten_accounts_states_its_gas_need_and_fits_in_one_transaction() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("owner").await?;
    w.mint(&owner, 1_000).await?;
    let key = agent(1);
    let budget = w.open_budget(&owner, &key, 1_000, DAY_MS, &[], 1).await?;
    w.deposit(&owner, &budget, 100).await?;
    let mut payees = Vec::new();
    let mut claims = Vec::new();
    let mut expected: std::collections::BTreeMap<String, serde_json::Value> = Default::default();
    for i in 0..10 {
        let payee = w.create(&format!("pay{i}")).await?;
        claims.push(voucher(&w.hub, &key, &budget, &payee, 1, 1));
        expected.insert(payee.to_string(), net_entry(&payee, 0, 1));
        payees.push(payee);
    }
    expected.insert(owner.to_string(), net_entry(&owner, 10, 0));
    w.settle(&w.node, id32(1), claims, expected.into_values().collect())
        .await?
        .assert_success();

    // Less than the hub's own count is refused before anything changes, with the hub's code and not a runtime
    // out-of-gas. Before the fix the hub asked for 210 Tgas and really needed 228.
    let stated = (payminto_hub::PAYOUT_ACCOUNT_GAS * 10 + payminto_hub::BASE_GAS) / 1_000_000_000_000;
    assert_refused(
        w.call_with_gas(
            &owner,
            &w.hub,
            "payout",
            json!({ "accounts": payees }),
            near_api::NearGas::from_tgas(stated),
        )
        .await?,
        "INSUFFICIENT_GAS",
    );
    for payee in &payees {
        assert_eq!(w.credit(payee).await?, 1);
    }

    w.call(&owner, &w.hub, "payout", json!({ "accounts": payees }))
        .await?
        .assert_success();
    for payee in &payees {
        assert_eq!(w.token_balance(payee).await?, 1);
        assert_eq!(w.credit(payee).await?, 0);
    }
    let (_, _, in_flight) = w.totals().await?;
    assert_eq!(in_flight, 0);
    w.assert_solvent().await?;
    Ok(())
}
