//! Shared helpers for the sandbox integration tests.
//! Every test starts its own `near-sandbox` node, deploys `out/hub.wasm` and `out/mock_ft.wasm`, and funds fresh accounts.
//! The node prepays its settlement storage and registers its receipt key, as a real deployment does.

#![allow(dead_code)]

use ed25519_dalek::{Signer as _, SigningKey};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use payminto_hub::encoding::{acceptance_digest, checkout_digest, voucher_digest};
use payminto_hub::types::{Id32, Sig64};
use serde_json::{Value, json};
use std::sync::Arc;
use testresult::TestResult;

pub const NETWORK: &str = "near:sandbox";
pub const MAX_GAS: NearGas = NearGas::from_tgas(300);
/// yoctoNEAR per byte of storage.
pub const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// What the node prepays for settlement storage in every test world.
pub const NODE_STORAGE: NearToken = NearToken::from_near(5);

/// The key the node signs acceptances with, registered on the hub by `World::start`.
pub fn node_key() -> SigningKey {
    agent(200)
}

pub fn hub_wasm() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/out/hub.wasm")).expect("run cargo near build first")
}

pub fn ft_wasm() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/out/mock_ft.wasm")).expect("run cargo near build first")
}

/// Installs the mocked environment that the host-function-backed digest helpers need in a test process.
pub fn init_env() {
    testing_env!(VMContextBuilder::new().build());
}

pub struct World {
    pub sandbox: Sandbox,
    pub net: NetworkConfig,
    pub signer: Arc<Signer>,
    pub hub: AccountId,
    pub token: AccountId,
    pub admin: AccountId,
    pub node: AccountId,
    /// Every Budget opened through `open_budget`, so `hub_own_balance` can leave out their storage reserves.
    pub budgets: std::sync::Mutex<Vec<Id32>>,
}

pub fn id32(n: u8) -> Id32 {
    Id32([n; 32])
}

pub fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

impl World {
    pub async fn start() -> TestResult<Self> {
        init_env();
        let sandbox = Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

        let token = acct("usdc.sandbox");
        let hub = acct("hub.sandbox");
        let admin = acct("admin.sandbox");
        let node = acct("node.sandbox");
        for name in [&token, &hub, &admin, &node] {
            sandbox
                .create_account(name.as_str().parse()?)
                .initial_balance(NearToken::from_near(50))
                .send()
                .await?;
        }

        Contract::deploy(token.clone())
            .use_code(ft_wasm())
            .with_init_call("new", json!({}))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        Contract::deploy(hub.clone())
            .use_code(hub_wasm())
            .with_init_call("new", json!({ "admin": admin, "token": token, "network": NETWORK }))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        let world = Self {
            sandbox,
            net,
            signer,
            hub,
            token,
            admin,
            node,
            budgets: std::sync::Mutex::new(Vec::new()),
        };
        // A real deployment registers the hub at the token with `storage_deposit` before accepting deposits.
        world
            .call(
                &world.token.clone(),
                &world.token.clone(),
                "register",
                json!({ "account_id": world.hub }),
            )
            .await?
            .assert_success();
        // The admin's deposit pays for the allowlist entry, and the excess comes back.
        world
            .call_with_deposit(
                &world.admin.clone(),
                &world.hub.clone(),
                "set_settler",
                json!({ "account": world.node, "allowed": true }),
                NearToken::from_millinear(10),
            )
            .await?
            .assert_success();
        // The node prepays the storage its settlements write, then registers the key it signs acceptances with.
        world
            .call_with_deposit(
                &world.node.clone(),
                &world.hub.clone(),
                "fund_storage",
                json!({ "account": world.node }),
                NODE_STORAGE,
            )
            .await?
            .assert_success();
        world
            .call_with_deposit(
                &world.node.clone(),
                &world.hub.clone(),
                "register_receipt_key",
                json!({ "key": Id32(node_key().verifying_key().to_bytes()) }),
                NearToken::from_yoctonear(1),
            )
            .await?
            .assert_success();
        Ok(world)
    }

    /// Unused NEAR the account has prepaid at the hub for settlement storage, in yoctoNEAR.
    pub async fn storage_of(&self, account: &AccountId) -> TestResult<u128> {
        let raw: String = self
            .view(&self.hub, "storage_of", json!({ "account": account }))
            .await?;
        Ok(raw.parse()?)
    }

    /// An account's NEAR balance in yoctoNEAR and the storage it uses in bytes.
    pub async fn near_account(&self, account: &AccountId) -> TestResult<(u128, u64)> {
        let view = near_api::Account(account.clone())
            .view()
            .fetch_from(&self.net)
            .await?
            .data;
        Ok((view.amount.as_yoctonear(), view.storage_usage))
    }

    /// The hub's own NEAR: its balance, less what its storage locks, less the storage balance it holds for the node
    /// and the storage reserves it holds for the Budgets. A charge moves prepaid NEAR from a balance or a reserve to the
    /// storage lock and leaves this unchanged. If it falls, the hub paid for someone's storage.
    pub async fn hub_own_balance(&self) -> TestResult<u128> {
        let (amount, storage) = self.near_account(&self.hub.clone()).await?;
        let held_for_node = self.storage_of(&self.node.clone()).await?;
        let ids: Vec<Id32> = self.budgets.lock().unwrap().clone();
        let mut reserves = 0u128;
        for id in ids {
            reserves += u128::from(self.reserve_bytes(&id).await?) * BYTE_COST;
        }
        Ok(amount - u128::from(storage) * BYTE_COST - held_for_node - reserves)
    }

    /// Storage bytes the Budget's owner prepaid and the Budget has not used yet.
    pub async fn reserve_bytes(&self, budget_id: &Id32) -> TestResult<u64> {
        Ok(self.budget(budget_id).await?["storage_reserve_bytes"]
            .as_str()
            .unwrap()
            .parse()?)
    }

    /// The batch the node settled under `batch_id`.
    pub async fn batch(&self, batch_id: Id32) -> TestResult<Value> {
        self.view(
            &self.hub,
            "batch",
            json!({ "settler": self.node, "batch_id": batch_id }),
        )
        .await
    }

    /// `settle_own` signed by the payee, with the node's acceptance of that claim.
    pub async fn settle_own(
        &self,
        payee: &AccountId,
        claim: &Value,
        accepted: &Value,
    ) -> TestResult<TransactionResult> {
        self.call(
            payee,
            &self.hub.clone(),
            "settle_own",
            json!({ "claim": claim, "acceptance": accepted }),
        )
        .await
    }

    pub async fn create(&self, name: &str) -> TestResult<AccountId> {
        let account = acct(&format!("{name}.sandbox"));
        self.sandbox
            .create_account(account.as_str().parse()?)
            .initial_balance(NearToken::from_near(10))
            .send()
            .await?;
        self.mint(&account, 0).await?;
        Ok(account)
    }

    /// Like `create`, but funds the account with less NEAR and takes the name by value, for concurrent setup.
    pub async fn create_quiet(&self, name: String) -> TestResult<AccountId> {
        let account = acct(&format!("{name}.sandbox"));
        self.sandbox
            .create_account(account.as_str().parse()?)
            .initial_balance(NearToken::from_near(3))
            .send()
            .await?;
        self.mint(&account, 1_000).await?;
        Ok(account)
    }

    /// Registers the account at the token and mints to it.
    pub async fn mint(&self, account: &AccountId, amount: u128) -> TestResult<()> {
        let token = self.token.clone();
        self.call(
            &token,
            &token,
            "mint",
            json!({ "account_id": account, "amount": amount.to_string() }),
        )
        .await?
        .assert_success();
        Ok(())
    }

    pub async fn call(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<TransactionResult> {
        self.call_with_deposit(signer, contract, method, args, NearToken::from_yoctonear(0))
            .await
    }

    pub async fn call_with_deposit(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .gas(MAX_GAS)
            .deposit(deposit)
            .with_signer(signer.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    /// A call with an explicit gas limit and no deposit, for gas measurements.
    pub async fn call_with_gas(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        gas: NearGas,
    ) -> TestResult<TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .gas(gas)
            .with_signer(signer.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    pub async fn view<T: serde::de::DeserializeOwned + Send + Sync>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    pub async fn token_balance(&self, account: &AccountId) -> TestResult<u128> {
        let raw: String = self
            .view(&self.token, "ft_balance_of", json!({ "account_id": account }))
            .await?;
        Ok(raw.parse()?)
    }

    pub async fn credit(&self, account: &AccountId) -> TestResult<u128> {
        let raw: String = self.view(&self.hub, "credit_of", json!({ "account": account })).await?;
        Ok(raw.parse()?)
    }

    pub async fn budget(&self, budget_id: &Id32) -> TestResult<Value> {
        self.view(&self.hub, "budget", json!({ "budget_id": budget_id })).await
    }

    pub async fn totals(&self) -> TestResult<(u128, u128, u128)> {
        let v: Value = self.view(&self.hub, "totals", json!({})).await?;
        let get = |k: &str| v[k].as_str().unwrap().parse::<u128>().unwrap();
        Ok((get("escrow"), get("credits"), get("in_flight")))
    }

    /// Token balance of the hub equals the sum of escrow, credits and in-flight payouts.
    pub async fn assert_solvent(&self) -> TestResult<()> {
        let balance = self.token_balance(&self.hub.clone()).await?;
        let (escrow, credits, in_flight) = self.totals().await?;
        assert_eq!(
            balance,
            escrow + credits + in_flight,
            "solvency: balance {balance} != escrow {escrow} + credits {credits} + in flight {in_flight}"
        );
        Ok(())
    }

    pub async fn open_budget(
        &self,
        owner: &AccountId,
        key: &SigningKey,
        cap: u128,
        valid_ms_from_now: u64,
        payees: &[&AccountId],
        salt: u8,
    ) -> TestResult<Id32> {
        let max = if payees.is_empty() { 16 } else { 0 };
        self.open_budget_for(owner, key, cap, valid_ms_from_now, payees, max, salt)
            .await
    }

    /// `open_budget` with an explicit `max_payees`. An empty `payees` list opens a Budget with `allow_any_payee`.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_budget_for(
        &self,
        owner: &AccountId,
        key: &SigningKey,
        cap: u128,
        valid_ms_from_now: u64,
        payees: &[&AccountId],
        max_payees: u32,
        salt: u8,
    ) -> TestResult<Id32> {
        let terms = json!({
            "agent_pk": Id32(key.verifying_key().to_bytes()),
            "settler": self.node,
            "cap": cap.to_string(),
            "valid_until": (now_ms() + valid_ms_from_now).to_string(),
            "payees": payees,
            "policy_hash": id32(0xaa),
            "salt": id32(salt),
            "allow_any_payee": payees.is_empty(),
            "max_payees": max_payees,
        });
        let result = self
            .call_with_deposit(
                owner,
                &self.hub.clone(),
                "open_budget",
                json!({ "terms": terms }),
                NearToken::from_near(1),
            )
            .await?
            .assert_success();
        let raw: Id32 = result.json().expect("budget id");
        self.budgets.lock().unwrap().push(raw);
        Ok(raw)
    }

    pub async fn deposit(&self, owner: &AccountId, budget_id: &Id32, amount: u128) -> TestResult<()> {
        let msg = json!({ "budget": { "budget_id": budget_id } }).to_string();
        self.ft_transfer_call(owner, amount, &msg).await?.assert_success();
        Ok(())
    }

    pub async fn ft_transfer_call(&self, sender: &AccountId, amount: u128, msg: &str) -> TestResult<TransactionResult> {
        self.call_with_deposit(
            sender,
            &self.token.clone(),
            "ft_transfer_call",
            json!({ "receiver_id": self.hub, "amount": amount.to_string(), "msg": msg }),
            NearToken::from_yoctonear(1),
        )
        .await
    }

    pub async fn settle(
        &self,
        caller: &AccountId,
        batch: Id32,
        claims: Vec<Value>,
        expected: Vec<Value>,
    ) -> TestResult<TransactionResult> {
        self.call(
            caller,
            &self.hub.clone(),
            "settle_batch",
            json!({ "batch_id": batch, "root": id32(0xee), "claims": claims, "expected_net": expected }),
        )
        .await
    }

    pub async fn near_block_timestamp_ms(&self) -> TestResult<u64> {
        let block = near_api::Chain::block().fetch_from(&self.net).await?;
        Ok(block.header.timestamp_nanosec.parse::<u64>()? / 1_000_000)
    }

    /// Rewrites a Budget's `revoked_at` in the hub's storage with `sandbox_patch_state`, then waits until a final view
    /// shows it. The key is the `Budgets` map prefix (variant 1 of `StorageKey`) followed by the Borsh budget id.
    pub async fn patch_revoked_at(&self, budget_id: &Id32, revoked_at_ms: u64) -> TestResult<()> {
        use near_sdk::base64::Engine as _;
        let b64 = near_sdk::base64::engine::general_purpose::STANDARD;
        let mut budget: payminto_hub::types::Budget = serde_json::from_value(self.budget(budget_id).await?)?;
        budget.revoked_at = Some(near_sdk::json_types::U64(revoked_at_ms));
        let mut key = vec![1u8];
        key.extend_from_slice(&budget_id.0);
        let value = near_sdk::borsh::to_vec(&budget)?;
        self.sandbox
            .patch_state(self.hub.as_str().parse()?)
            .storage(b64.encode(key), b64.encode(value))
            .send()
            .await?;
        let expected = revoked_at_ms.to_string();
        for _ in 0..100 {
            if self.budget(budget_id).await?["revoked_at"] == expected.as_str() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Err("patched revoked_at never became visible".into())
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub fn agent(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

pub fn voucher(
    hub: &AccountId,
    key: &SigningKey,
    budget_id: &Id32,
    payee: &AccountId,
    amount: u128,
    cumulative: u128,
) -> Value {
    let request_hash = id32(0xcd);
    let digest = voucher_digest(
        hub.as_str(),
        NETWORK,
        budget_id,
        payee.as_str(),
        amount,
        cumulative,
        &request_hash,
    );
    json!({
        "budget_id": budget_id,
        "payee": payee,
        "amount": amount.to_string(),
        "cumulative": cumulative.to_string(),
        "request_hash": request_hash,
        "signature": Sig64(key.sign(&digest).to_bytes()),
    })
}

/// The acceptance the node signs for a voucher built by [`voucher`], at `timestamp_s` Unix seconds.
pub fn acceptance(claim: &Value, key: &SigningKey, timestamp_s: u64) -> Value {
    let text = |k: &str| claim[k].as_str().unwrap_or_else(|| panic!("claim has no {k}"));
    let digest = acceptance_digest(
        &Id32::from_hex(text("budget_id")).unwrap(),
        text("payee"),
        text("amount").parse().unwrap(),
        text("cumulative").parse().unwrap(),
        &Id32::from_hex(text("request_hash")).unwrap(),
        timestamp_s,
        &Sig64::from_hex(text("signature")).unwrap(),
    );
    json!({
        "node_key": Id32(key.verifying_key().to_bytes()),
        "timestamp_s": timestamp_s.to_string(),
        "signature": Sig64(key.sign(&digest).to_bytes()),
    })
}

/// The node's acceptance of `claim`, signed now.
pub fn accepted_now(claim: &Value) -> Value {
    acceptance(claim, &node_key(), now_ms() / 1000)
}

pub fn net_entry(account: &AccountId, debit: u128, credit: u128) -> Value {
    json!({ "account": account, "debit": debit.to_string(), "credit": credit.to_string() })
}

pub fn checkout_msg(
    hub: &AccountId,
    key: &SigningKey,
    payment_id: Id32,
    merchant: &AccountId,
    amount: u128,
    expiry_ms: u64,
) -> String {
    let digest = checkout_digest(hub.as_str(), NETWORK, &payment_id, merchant.as_str(), amount, expiry_ms);
    json!({
        "payment": {
            "payment_id": payment_id,
            "merchant": merchant,
            "amount": amount.to_string(),
            "expiry_ms": expiry_ms.to_string(),
            "signature": Sig64(key.sign(&digest).to_bytes()),
        }
    })
    .to_string()
}
