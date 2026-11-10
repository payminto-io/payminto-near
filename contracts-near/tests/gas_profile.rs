//! Measures real gas in `near-sandbox`. Run it on its own, as it creates many accounts:
//! `cargo test --test gas_profile -- --nocapture --ignored --test-threads=1`.

mod common;

use common::*;
use futures::future::join_all;
use near_api::types::transaction::result::TransactionResult;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use testresult::TestResult;

const TGAS: f64 = 1_000_000_000_000.0;
const DAY_MS: u64 = 86_400_000;
/// Where the scan for the least working `payout` gas starts, in Tgas.
const PAYOUT_SCAN_FROM_TGAS: u64 = 262;

/// A batch of `n` claims from one Budget to `n` payees that have no settled or credit entry yet.
async fn one_budget_new_payees(w: &World, owner: &near_api::AccountId, n: usize, batch: u8) -> TestResult<f64> {
    let key = agent(100 + batch);
    let budget = w
        .open_budget_for(owner, &key, 1_000_000, DAY_MS, &[], n as u32, 200 + batch)
        .await?;
    w.deposit(owner, &budget, n as u128).await?;

    let mut claims = Vec::new();
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
    for i in 0..n {
        let payee = acct(&format!("p{batch}x{i}.sandbox"));
        claims.push(voucher(&w.hub, &key, &budget, &payee, 1, 1));
        expected.insert(payee.to_string(), net_entry(&payee, 0, 1));
    }
    expected.insert(owner.to_string(), net_entry(owner, n as u128, 0));
    let entries: Vec<Value> = expected.into_values().collect();
    let result = w.settle(&w.node, id32(batch), claims, entries).await?;
    burnt(result)
}

/// A batch of `n` claims from `n` different owners and Budgets, each to its own new payee.
async fn many_budgets(w: &World, n: usize, batch: u8) -> TestResult<f64> {
    let owners: Vec<near_api::AccountId> = join_all((0..n).map(|i| w.create_quiet(format!("o{batch}x{i}"))))
        .await
        .into_iter()
        .collect::<TestResult<_>>()?;

    let budgets: Vec<_> = join_all(owners.iter().enumerate().map(|(i, owner)| async move {
        let key = agent(1 + (i % 200) as u8);
        let budget = w
            .open_budget(owner, &key, 1_000_000, DAY_MS, &[], (i % 250) as u8)
            .await?;
        w.deposit(owner, &budget, 5).await?;
        let row: TestResult<(
            near_api::AccountId,
            ed25519_dalek::SigningKey,
            payminto_hub::types::Id32,
        )> = Ok((owner.clone(), key, budget));
        row
    }))
    .await
    .into_iter()
    .collect::<TestResult<_>>()?;

    let mut claims = Vec::new();
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
    for (i, (owner, key, budget)) in budgets.iter().enumerate() {
        let payee = acct(&format!("q{batch}x{i}.sandbox"));
        claims.push(voucher(&w.hub, key, budget, &payee, 5, 5));
        expected.insert(payee.to_string(), net_entry(&payee, 0, 5));
        expected.insert(owner.to_string(), net_entry(owner, 5, 0));
    }
    let entries: Vec<Value> = expected.into_values().collect();
    let result = w.settle(&w.node, id32(batch), claims, entries).await?;
    burnt(result)
}

/// The worst case the hub allows in one batch: 100 owners with 64-character accounts, each with its own Budget that
/// lists 16 payees of 64 characters, and one claim per Budget to a payee that has no settled or credit entry yet.
async fn worst_case(w: &World, batch: u8) -> TestResult<f64> {
    let n = 100usize;
    let owners: Vec<near_api::AccountId> =
        join_all((0..n).map(|i| w.create_quiet(format!("w{batch:02}{i:03}{}", "x".repeat(50)))))
            .await
            .into_iter()
            .collect::<TestResult<_>>()?;

    let budgets: Vec<_> = join_all(owners.iter().enumerate().map(|(i, owner)| async move {
        let key = agent(1 + (i % 200) as u8);
        let payees: Vec<near_api::AccountId> = (0..16)
            .map(|j| acct(&format!("{:064x}", (batch as usize) << 24 | i << 8 | j)))
            .collect();
        let refs: Vec<&near_api::AccountId> = payees.iter().collect();
        let budget = w
            .open_budget(owner, &key, 1_000_000, DAY_MS, &refs, (i % 250) as u8)
            .await?;
        w.deposit(owner, &budget, 5).await?;
        let row: TestResult<(
            near_api::AccountId,
            ed25519_dalek::SigningKey,
            payminto_hub::types::Id32,
            near_api::AccountId,
        )> = Ok((owner.clone(), key, budget, payees[15].clone()));
        row
    }))
    .await
    .into_iter()
    .collect::<TestResult<_>>()?;

    let mut claims = Vec::new();
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
    for (owner, key, budget, payee) in &budgets {
        claims.push(voucher(&w.hub, key, budget, payee, 5, 5));
        expected.insert(payee.to_string(), net_entry(payee, 0, 5));
        expected.insert(owner.to_string(), net_entry(owner, 5, 0));
    }
    let entries: Vec<Value> = expected.into_values().collect();
    let result = w.settle(&w.node, id32(batch), claims, entries).await?;
    burnt(result)
}

#[tokio::test]
#[ignore = "creates 100 accounts with 64-character names; run explicitly for profiling"]
async fn profile_settle_batch_worst_case() -> TestResult<()> {
    let w = World::start().await?;
    let gas = worst_case(&w, 60).await?;
    println!(
        "worst case: 100 claims, 100 owners and Budgets of 16 listed 64-character payees, 64-character accounts: {gas:.1} Tgas burnt"
    );
    Ok(())
}

fn burnt(result: TransactionResult) -> TestResult<f64> {
    let TransactionResult::Full(full) = result else {
        return Err("transaction is still pending".into());
    };
    let gas = full.total_gas_burnt.as_gas() as f64 / TGAS;
    let outcome = full.into_result();
    if let Err(e) = outcome {
        return Err(format!("{:?}", e).chars().take(600).collect::<String>().into());
    }
    Ok(gas)
}

#[tokio::test]
#[ignore = "creates hundreds of accounts; run explicitly for profiling"]
async fn profile_settle_batch() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("profiler").await?;
    w.mint(&owner, 1_000_000).await?;

    println!("| Claims | One Budget, new payees (Tgas burnt) | Distinct owners and Budgets, new payees (Tgas burnt) |");
    println!("|---|---|---|");
    for (batch, n) in [(1u8, 1usize), (2, 10), (3, 50), (4, 100)] {
        let single = one_budget_new_payees(&w, &owner, n, batch).await?;
        let multi = many_budgets(&w, n, batch + 10).await?;
        println!("| {n} | {single:.1} | {multi:.1} |");
    }
    Ok(())
}

#[tokio::test]
#[ignore = "profiling only"]
async fn profile_payout_and_reclaim() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("profiler").await?;
    w.mint(&owner, 1_000_000).await?;
    let key = agent(1);
    let budget = w.open_budget(&owner, &key, 1_000_000, DAY_MS, &[], 1).await?;
    w.deposit(&owner, &budget, 1_000).await?;

    let mut payees = Vec::new();
    let mut claims = Vec::new();
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
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

    let result = w.call(&owner, &w.hub, "payout", json!({ "accounts": payees })).await?;
    let TransactionResult::Full(full) = result else {
        return Err("pending".into());
    };
    let burnt_total = full.total_gas_burnt.as_gas() as f64 / TGAS;
    let success = full
        .into_result()
        .map_err(|e| format!("{e:?}").chars().take(300).collect::<String>())?;
    let callback_gas: Vec<f64> = success
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == w.hub)
        .map(|o| o.gas_burnt.as_gas() as f64 / TGAS)
        .collect();
    println!("payout 10 accounts: {burnt_total:.1} Tgas total");
    println!("hub receipts Tgas: {callback_gas:?}");
    w.assert_solvent().await?;
    Ok(())
}

/// Finds the least gas with which `payout` to 10 creditors succeeds, scanning upwards in steps of 2 Tgas.
/// A call with too little gas fails as a whole and changes nothing, so every probe starts from the same state.
#[tokio::test]
#[ignore = "profiling only"]
async fn profile_payout_minimum_gas() -> TestResult<()> {
    let w = World::start().await?;
    let owner = w.create("profiler").await?;
    w.mint(&owner, 1_000_000).await?;
    let key = agent(1);
    let budget = w.open_budget(&owner, &key, 1_000_000, DAY_MS, &[], 1).await?;
    w.deposit(&owner, &budget, 1_000).await?;

    let mut payees = Vec::new();
    let mut claims = Vec::new();
    let mut expected: BTreeMap<String, Value> = BTreeMap::new();
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

    let mut works = None;
    let mut last_failure = String::new();
    for tgas in (PAYOUT_SCAN_FROM_TGAS..=300).step_by(2) {
        let result = w
            .call_with_gas(
                &owner,
                &w.hub,
                "payout",
                json!({ "accounts": payees }),
                near_api::NearGas::from_tgas(tgas),
            )
            .await?;
        let TransactionResult::Full(full) = result else {
            return Err("pending".into());
        };
        match full.into_result() {
            Ok(_) => {
                works = Some(tgas);
                break;
            }
            Err(e) => {
                let text = format!("{e:?}");
                last_failure = if text.contains("INSUFFICIENT_GAS") {
                    format!("{tgas} Tgas: INSUFFICIENT_GAS")
                } else {
                    format!("{tgas} Tgas: the runtime ran out of gas")
                };
            }
        }
    }
    println!("payout to 10 accounts: least working gas {works:?} Tgas, last failure at {last_failure}");
    for payee in &payees {
        println!("credit left for {payee}: {}", w.credit(payee).await?);
    }
    w.assert_solvent().await?;
    Ok(())
}
