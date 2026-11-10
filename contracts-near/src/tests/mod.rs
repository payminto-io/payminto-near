//! Unit tests against the mocked NEAR runtime.
//! `Harness` keeps a separate token ledger, so the solvency invariant is checked against an independent number.
//! A panicking call is rolled back to the state before it, as the real runtime does.

mod review;
mod scenarios;
mod vectors;

use crate::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{U64, U128};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, Gas, MockedBlockchain, NearToken, PromiseResult, testing_env};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};

pub const T0: u64 = 1_800_000_000_000;
pub const DAY: u64 = 86_400_000;
pub const NET: &str = "near:testnet";

pub fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

pub fn hub_id() -> AccountId {
    acct("hub.test")
}
pub fn token() -> AccountId {
    acct("usdc.test")
}
pub fn admin() -> AccountId {
    acct("admin.test")
}
pub fn node() -> AccountId {
    acct("node.test")
}
pub const A: &str = "a.test";
pub const B: &str = "b.test";
pub const S: &str = "seller.test";

pub fn agent(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

/// The key the node signs acceptances with, registered on the hub by `Harness::new`.
pub fn node_key() -> SigningKey {
    agent(200)
}

pub fn byte_cost() -> u128 {
    near_sdk::env::storage_byte_cost().as_yoctonear()
}

/// Enough NEAR for any storage a test writes.
pub fn plenty() -> u128 {
    NearToken::from_near(10).as_yoctonear()
}

/// The hub's storage and its use, as saved before a call that may panic.
pub struct Snapshot {
    storage: HashMap<Vec<u8>, Vec<u8>>,
    usage: u64,
}

pub fn pk(key: &SigningKey) -> Id32 {
    Id32(key.verifying_key().to_bytes())
}

pub fn id(n: u8) -> Id32 {
    Id32([n; 32])
}

pub struct Harness {
    pub hub: Hub,
    pub token_balance: u128,
    pub now_ms: u64,
    pub budgets: Vec<Id32>,
    pub accounts: BTreeSet<AccountId>,
    pub seq: u8,
}

impl Harness {
    pub fn new() -> Self {
        let mut h = Self {
            hub: unsafe_placeholder(),
            token_balance: 0,
            now_ms: T0,
            budgets: vec![],
            accounts: BTreeSet::new(),
            seq: 0,
        };
        h.ctx(hub_id(), 0);
        h.hub = Hub::new(admin(), token(), NET.to_string());
        h.ctx(admin(), plenty());
        h.hub.set_settler(node(), true);
        // The node prepays its settlement storage, then registers the key it signs acceptances with.
        h.ctx(acct("anyone.test"), plenty());
        h.hub.fund_storage(node());
        h.ctx(node(), 1);
        h.hub.register_receipt_key(pk(&node_key()));
        h.usage();
        h
    }

    pub fn now_s(&self) -> u64 {
        self.now_ms / 1000
    }

    /// The node's acceptance of `claim`, signed now.
    pub fn accept(&self, claim: &Claim) -> Acceptance {
        acceptance(claim, &node_key(), self.now_s())
    }

    /// `settle_own` with the node's acceptance signed now. Set the caller with `ctx` first.
    pub fn own(&mut self, claim: Claim) {
        let accepted = self.accept(&claim);
        self.hub.settle_own(claim, accepted);
    }

    /// Unused NEAR the account has prepaid for settlement storage.
    pub fn storage_of(&self, account: &str) -> u128 {
        self.hub.storage_of(acct(account)).0
    }

    /// Storage in use, with every cached write and the contract's root record on disk, as after a real call.
    pub fn usage(&mut self) -> u64 {
        self.hub.flush();
        near_sdk::env::state_write(&self.hub);
        near_sdk::env::storage_usage()
    }

    /// Saves the hub's storage, so a panicking call can be undone as the runtime would undo it.
    pub fn snapshot(&mut self) -> Snapshot {
        let usage = self.usage();
        let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        self.install(storage.clone(), usage);
        Snapshot { storage, usage }
    }

    pub fn rollback(&mut self, saved: Snapshot) {
        self.install(saved.storage, saved.usage);
        self.hub = near_sdk::env::state_read().expect("state was written by snapshot");
    }

    fn install(&self, storage: HashMap<Vec<u8>, Vec<u8>>, usage: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(hub_id())
            .predecessor_account_id(hub_id())
            .block_timestamp(self.now_ms * 1_000_000)
            .account_balance(NearToken::from_near(1_000))
            .storage_usage(usage);
        near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            vec![],
            storage,
            Default::default(),
            None,
        ));
    }

    pub fn ctx(&self, predecessor: AccountId, deposit: u128) {
        self.ctx_full(predecessor, deposit, Gas::from_tgas(300), vec![])
    }

    pub fn ctx_full(&self, predecessor: AccountId, deposit: u128, gas: Gas, results: Vec<PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(hub_id())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .block_timestamp(self.now_ms * 1_000_000)
            .account_balance(NearToken::from_near(1_000))
            .storage_usage(near_sdk::env::storage_usage())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(gas);
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    pub fn advance(&mut self, ms: u64) {
        self.now_ms += ms;
    }

    fn salt(&mut self) -> Id32 {
        self.seq += 1;
        id(self.seq)
    }

    pub fn terms(&mut self, key: &SigningKey, cap: u128, payees: Vec<&str>) -> BudgetTerms {
        BudgetTerms {
            agent_pk: pk(key),
            settler: node(),
            cap: U128(cap),
            valid_until: U64(self.now_ms + DAY),
            payees: payees.into_iter().map(acct).collect(),
            policy_hash: id(0xaa),
            salt: self.salt(),
        }
    }

    pub fn open(&mut self, owner: &str, terms: BudgetTerms) -> Id32 {
        self.ctx(acct(owner), near_sdk::env::storage_byte_cost().as_yoctonear() * 20_000);
        let budget_id = self.hub.open_budget(terms);
        self.budgets.push(budget_id);
        self.accounts.insert(acct(owner));
        budget_id
    }

    pub fn open_simple(&mut self, owner: &str, key: &SigningKey, cap: u128) -> Id32 {
        let t = self.terms(key, cap, vec![]);
        self.open(owner, t)
    }

    /// Simulates `ft_transfer_call` into the hub and returns the refunded amount.
    pub fn transfer_in(&mut self, sender: &str, amount: u128, msg: &str) -> u128 {
        self.token_balance += amount;
        self.ctx(token(), 0);
        let refunded = self.hub.ft_on_transfer(acct(sender), U128(amount), msg.to_string()).0;
        self.token_balance -= refunded;
        refunded
    }

    pub fn deposit(&mut self, owner: &str, budget_id: &Id32, amount: u128) {
        let refunded = self.transfer_in(owner, amount, &budget_msg(budget_id));
        assert_eq!(refunded, 0, "deposit was refunded");
    }

    pub fn budget(&self, budget_id: &Id32) -> Budget {
        self.hub.budget(*budget_id).expect("budget")
    }

    pub fn settle(&mut self, batch_id: Id32, claims: Vec<Claim>, expected: Vec<NetEntry>) {
        self.ctx(node(), 0);
        for claim in &claims {
            self.accounts.insert(claim.payee.clone());
        }
        self.hub.settle_batch(batch_id, id(0xee), claims, expected);
    }

    /// Runs a call that should panic, asserts its message contains `code`, and undoes whatever it wrote.
    pub fn expect_err<F: FnOnce(&mut Self)>(&mut self, code: &str, f: F) {
        let saved = self.snapshot();
        let token_balance = self.token_balance;
        let result = catch_unwind(AssertUnwindSafe(|| f(self)));
        let payload = result.err().unwrap_or_else(|| panic!("expected panic with {code}"));
        let message = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(message.contains(code), "expected {code}, got: {message}");
        self.rollback(saved);
        self.token_balance = token_balance;
        self.assert_solvent();
    }

    /// The solvency invariant, checked from individually summed state rather than the running totals.
    pub fn assert_solvent(&self) {
        let escrow: u128 = self.budgets.iter().map(|b| self.budget(b).escrow.0).sum();
        let credits: u128 = self.accounts.iter().map(|a| self.hub.credit_of(a.clone()).0).sum();
        let totals = self.hub.totals();
        assert_eq!(totals.escrow.0, escrow, "escrow total drifted");
        assert_eq!(totals.credits.0, credits, "credit total drifted");
        assert_eq!(
            self.token_balance,
            escrow + credits + totals.in_flight.0,
            "solvency broken"
        );
    }

    pub fn payout(&mut self, accounts: &[&str]) {
        self.ctx(acct("anyone.test"), 0);
        for a in accounts {
            self.accounts.insert(acct(a));
        }
        self.hub.payout(accounts.iter().map(|a| acct(a)).collect());
    }

    pub fn finish_payout(&mut self, account: &str, amount: u128, success: bool) {
        let result = if success {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        };
        self.ctx_full(hub_id(), 0, Gas::from_tgas(10), vec![result]);
        self.hub.on_payout(acct(account), U128(amount));
        if success {
            self.token_balance -= amount;
        }
    }

    pub fn finish_reclaim(&mut self, budget_id: Id32, amount: u128, success: bool) {
        let result = if success {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        };
        self.ctx_full(hub_id(), 0, Gas::from_tgas(10), vec![result]);
        self.hub.on_reclaim(budget_id, U128(amount));
        if success {
            self.token_balance -= amount;
        }
    }
}

fn unsafe_placeholder() -> Hub {
    // A test can build more than one harness, and each needs an empty mocked store.
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(hub_id())
            .predecessor_account_id(hub_id())
            .build()
    );
    near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(hub_id())
            .predecessor_account_id(hub_id())
            .build()
    );
    Hub::new(admin(), token(), NET.to_string())
}

pub fn budget_msg(budget_id: &Id32) -> String {
    format!(r#"{{"budget":{{"budget_id":"{}"}}}}"#, budget_id.to_hex())
}

pub fn claim(budget_id: &Id32, payee: &str, key: &SigningKey, amount: u128, cumulative: u128) -> Claim {
    let request_hash = id(0xcd);
    let digest = voucher_digest(
        hub_id().as_str(),
        NET,
        budget_id,
        payee,
        amount,
        cumulative,
        &request_hash,
    );
    Claim {
        budget_id: *budget_id,
        payee: acct(payee),
        amount: U128(amount),
        cumulative: U128(cumulative),
        request_hash,
        signature: Sig64(key.sign(&digest).to_bytes()),
    }
}

/// A node acceptance of `claim`, signed by `key` at `timestamp_s` Unix seconds.
pub fn acceptance(claim: &Claim, key: &SigningKey, timestamp_s: u64) -> Acceptance {
    let digest = acceptance_digest(
        &claim.budget_id,
        claim.payee.as_str(),
        claim.amount.0,
        claim.cumulative.0,
        &claim.request_hash,
        timestamp_s,
        &claim.signature,
    );
    Acceptance {
        node_key: pk(key),
        timestamp_s: U64(timestamp_s),
        signature: Sig64(key.sign(&digest).to_bytes()),
    }
}

pub fn entries(lines: &[(&str, &str, u128)]) -> Vec<NetEntry> {
    let mut map: BTreeMap<AccountId, i128> = BTreeMap::new();
    for (debtor, creditor, amount) in lines {
        *map.entry(acct(debtor)).or_default() -= *amount as i128;
        *map.entry(acct(creditor)).or_default() += *amount as i128;
    }
    map.into_iter()
        .filter(|(_, v)| *v != 0)
        .map(|(account, v)| NetEntry {
            account,
            debit: U128(if v < 0 { (-v) as u128 } else { 0 }),
            credit: U128(if v > 0 { v as u128 } else { 0 }),
        })
        .collect()
}
