//! Conformance against the frozen vectors in `packages/chain/vectors`.
//! Those files are owned by the chain package and are read here, never written.

use super::*;
use crate::netting::Netting;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use std::path::PathBuf;

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/chain/vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}"))
}

fn u(v: &Value, k: &str) -> u128 {
    s(v, k).parse().unwrap()
}

fn id32(v: &Value, k: &str) -> Id32 {
    Id32::from_hex(s(v, k)).unwrap_or_else(|| panic!("bad id {k}"))
}

fn setup() {
    Harness::new();
}

fn cases(file: &str) -> Vec<Value> {
    load(file)["cases"].as_array().unwrap().clone()
}

fn keys() -> BTreeMap<String, VerifyingKey> {
    load("keys.json")["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            let bytes = Id32::from_hex(s(k, "public_key_hex")).unwrap();
            (s(k, "name").to_string(), VerifyingKey::from_bytes(&bytes.0).unwrap())
        })
        .collect()
}

fn verify_sig(digest: &[u8; 32], sig_hex: &str, key: &VerifyingKey) {
    let sig = Sig64::from_hex(sig_hex).unwrap();
    key.verify(digest, &Signature::from_bytes(&sig.0))
        .expect("vector signature");
    assert!(
        near_sdk::env::ed25519_verify(&sig.0, digest, key.as_bytes()),
        "env::ed25519_verify disagrees"
    );
}

#[test]
fn voucher_digests_match() {
    setup();
    let file = load("voucher.json");
    assert_eq!(file["tag"].as_u64().unwrap(), VOUCHER_TAG as u64);
    assert_eq!(s(&file, "domain"), VOUCHER_DOMAIN);
    let all = cases("voucher.json");
    assert!(!all.is_empty());
    let keys = keys();
    for case in all {
        let i = &case["input"];
        let d = voucher_digest(
            s(i, "hub"),
            s(i, "network"),
            &id32(i, "budget_id"),
            s(i, "payee"),
            u(i, "amount"),
            u(i, "cumulative"),
            &id32(i, "request_hash"),
        );
        assert_eq!(Id32(d).to_hex(), s(&case, "digest_hex"), "{}", s(&case, "name"));
        verify_sig(&d, s(&case, "signature_hex"), &keys[s(&case, "signer")]);
    }
}

#[test]
fn budget_ids_match() {
    setup();
    let all = cases("budget.json");
    assert!(!all.is_empty());
    assert_eq!(load("budget.json")["max_payees"].as_u64().unwrap() as usize, MAX_PAYEES);
    for case in all {
        let i = &case["input"];
        let canonical = canonicalize_payees(
            i["payees_as_given"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| acct(p.as_str().unwrap()))
                .collect(),
        );
        let expected: Vec<AccountId> = i["payees_canonical"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| acct(p.as_str().unwrap()))
            .collect();
        assert_eq!(canonical, expected);
        let terms = BudgetTerms {
            agent_pk: id32(i, "agent_pk_hex"),
            settler: acct(s(i, "settler")),
            cap: U128(u(i, "cap")),
            valid_until: U64(u(i, "valid_until") as u64),
            payees: canonical,
            policy_hash: id32(i, "policy_hash"),
            salt: id32(i, "salt"),
            // Not part of the id: the hub ties the flag to an empty list.
            allow_any_payee: false,
            max_payees: 0,
        };
        let budget = budget_id(s(i, "hub"), s(i, "network"), s(i, "owner"), &terms);
        assert_eq!(budget.to_hex(), s(&case, "budget_id"), "{}", s(&case, "name"));
    }
}

#[test]
fn checkout_digests_match() {
    setup();
    let file = load("checkout.json");
    assert_eq!(file["tag"].as_u64().unwrap(), CHECKOUT_TAG as u64);
    assert_eq!(s(&file, "domain"), CHECKOUT_DOMAIN);
    let all = cases("checkout.json");
    assert!(!all.is_empty());
    let keys = keys();
    for case in all {
        let i = &case["input"];
        let d = checkout_digest(
            s(i, "hub"),
            s(i, "network"),
            &id32(i, "payment_id"),
            s(i, "merchant"),
            u(i, "amount"),
            u(i, "expiry_ms") as u64,
        );
        assert_eq!(Id32(d).to_hex(), s(&case, "digest_hex"), "{}", s(&case, "name"));
        verify_sig(&d, s(&case, "signature_hex"), &keys[s(&case, "signer")]);
    }
}

#[test]
fn merkle_nodes_roots_and_proofs_match() {
    setup();
    let file = load("merkle.json");
    assert_eq!(s(&file, "domain"), RECEIPT_DOMAIN);
    assert_eq!(file["max_depth"].as_u64().unwrap() as usize, MAX_MERKLE_DEPTH);
    let node_cases = file["node_cases"].as_array().unwrap();
    assert!(!node_cases.is_empty());
    for case in node_cases {
        let node = hash_pair(&id32(case, "left").0, &id32(case, "right").0);
        assert_eq!(Id32(node).to_hex(), s(case, "node_hex"), "{}", s(case, "name"));
    }

    let all = file["cases"].as_array().unwrap();
    assert!(!all.is_empty());
    let mut total_leaves = 0;
    for case in all {
        let (hub, network, batch) = (s(case, "hub"), s(case, "network"), id32(case, "batch_id"));
        let root = id32(case, "root");
        let mut leaves = vec![];
        for r in case["receipts_in_leaf_order"].as_array().unwrap() {
            let sig = Sig64::from_hex(s(r, "voucher_sig")).unwrap();
            let leaf = receipt_leaf(
                hub,
                network,
                &batch,
                &id32(r, "call_id"),
                &id32(r, "budget_id"),
                s(r, "payee"),
                u(r, "amount"),
                u(r, "cumulative"),
                &id32(r, "request_hash"),
                u(r, "timestamp_ms") as u64,
                &sig.0,
            );
            assert_eq!(Id32(leaf).to_hex(), s(r, "leaf_hex"), "{}", s(case, "name"));
            let proof: Vec<Id32> = r["proof"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| Id32::from_hex(p.as_str().unwrap()).unwrap())
                .collect();
            assert!(verify_proof(&root.0, leaf, &proof), "proof in {}", s(case, "name"));
            leaves.push(leaf);
            total_leaves += 1;
        }
        assert_eq!(
            Id32(merkle_root(&leaves)).to_hex(),
            root.to_hex(),
            "root of {}",
            s(case, "name")
        );
    }
    assert!(total_leaves > all.len(), "vectors cover trees larger than one leaf");
}

#[test]
fn error_codes_match_the_shared_list() {
    let file = load("errors.json");
    let shared: Vec<&str> = file["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap())
        .collect();
    assert_eq!(
        shared,
        crate::errors::ALL,
        "errors.rs ALL and packages/chain HUB_ERRORS have drifted"
    );

    // Every code constant in errors.rs is listed in ALL, and its name equals its value.
    let source = include_str!("../errors.rs");
    let mut declared: Vec<&str> = source
        .lines()
        .filter_map(|line| line.strip_prefix("pub const "))
        .filter_map(|rest| rest.split_once(": &str = \""))
        .map(|(name, value)| {
            assert_eq!(format!("{name}\";"), value, "constant {name} must equal its own name");
            name
        })
        .collect();
    declared.sort();
    assert_eq!(declared, crate::errors::ALL, "a code constant is missing from ALL");
}

#[test]
fn netting_matches() {
    setup();
    let file = load("netting.json");
    assert_eq!(file["max_claims"].as_u64().unwrap() as usize, MAX_CLAIMS);
    assert_eq!(
        file["max_payout_accounts"].as_u64().unwrap() as usize,
        MAX_PAYOUT_ACCOUNTS
    );
    let all = cases("netting.json");
    assert!(!all.is_empty());
    for case in all {
        let mut net = Netting::default();
        let mut gross = 0u128;
        for line in case["lines"].as_array().unwrap() {
            let delta = u(line, "delta");
            gross += delta;
            net.record(&acct(s(line, "owner")), &acct(s(line, "payee")), delta);
        }
        let computed = net.entries();
        let expected: Vec<NetEntry> = case["expected_net"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| NetEntry {
                account: acct(s(e, "account")),
                debit: U128(u(e, "debit")),
                credit: U128(u(e, "credit")),
            })
            .collect();
        assert_eq!(computed, expected, "{}", s(&case, "name"));
        assert_eq!(gross, u(&case, "gross"));
        let net_total: u128 = computed.iter().map(|e| e.credit.0).sum();
        assert_eq!(net_total, u(&case, "net"));
    }
}

#[test]
fn acceptance_digests_match() {
    setup();
    let file = load("acceptance.json");
    assert_eq!(s(&file, "domain"), ACCEPTANCE_DOMAIN);
    assert_eq!(s(&file, "call_domain"), CALL_DOMAIN);
    assert_eq!(s(&file, "timestamp_unit"), "seconds");
    assert_eq!(file["max_receipt_keys"].as_u64().unwrap() as usize, MAX_RECEIPT_KEYS);
    assert_eq!(u(&file, "revoke_grace_ms") as u64, REVOKE_GRACE_MS);
    assert_eq!(u(&file, "expiry_grace_ms") as u64, EXPIRY_GRACE_MS);
    let all = cases("acceptance.json");
    assert!(!all.is_empty());
    let keys = keys();
    for case in all {
        let i = &case["input"];
        let (budget, request) = (id32(i, "budget_id"), id32(i, "request_hash"));
        let call = call_id(&budget, s(i, "payee"), u(i, "cumulative"), &request);
        assert_eq!(call.to_hex(), s(&case, "call_id"), "{}", s(&case, "name"));
        let d = acceptance_digest(
            &budget,
            s(i, "payee"),
            u(i, "amount"),
            u(i, "cumulative"),
            &request,
            s(i, "timestamp_s").parse().unwrap(),
            &Sig64::from_hex(s(i, "voucher_sig")).unwrap(),
        );
        assert_eq!(Id32(d).to_hex(), s(&case, "digest_hex"), "{}", s(&case, "name"));
        assert_eq!(
            Id32(near_sdk::env::sha256_array(s(&case, "text").as_bytes())).to_hex(),
            s(&case, "digest_hex"),
            "the digest is sha256 of the listed text"
        );
        verify_sig(&d, s(&case, "signature_hex"), &keys[s(&case, "signer")]);
    }
}

/// Writes each record the vector file lists and measures it, so the byte formulas in `packages/chain` are the
/// contract's real storage layout.
#[test]
fn storage_bytes_match() {
    setup();
    let file = load("storage.json");
    assert_eq!(s(&file, "byte_cost_yocto").parse::<u128>().unwrap(), byte_cost());
    assert_eq!(file["pair_bytes"].as_u64().unwrap(), crate::PAIR_BYTES);
    assert_eq!(
        file["max_any_payees"].as_u64().unwrap(),
        u64::from(crate::MAX_ANY_PAYEES)
    );
    assert_eq!(file["revoke_bytes"].as_u64().unwrap(), REVOKE_BYTES);
    let all = cases("storage.json");
    assert!(all.len() >= 10);
    for case in all {
        let mut h = Harness::new();
        let before = h.usage();
        let name = |k: &str| acct(s(&case, k));
        match s(&case, "record") {
            "settled" => {
                h.hub.settled.insert((id(1), name("payee")), 7);
            }
            "credit" => {
                let funder = match &case["funder"] {
                    Value::Null => None,
                    f if f["settler"].is_string() => Some(Funder::Settler(acct(s(f, "settler")))),
                    f => Some(Funder::Budget(id32(f, "budget"))),
                };
                h.hub.credits.insert(
                    name("account"),
                    Credit {
                        amount: 7,
                        in_flight: 0,
                        funder,
                    },
                );
            }
            "batch" => {
                h.hub.batches.insert(
                    (name("settler"), id(1)),
                    BatchRecord {
                        root: id(2),
                        settler: name("settler"),
                        gross: U128(1),
                        net: U128(1),
                        at: U64(T0),
                    },
                );
            }
            "payment" => {
                h.hub.payments.insert(
                    id(1),
                    PaymentRecord {
                        merchant: name("merchant"),
                        amount: U128(1),
                        payer: name("payer"),
                        at: U64(T0),
                    },
                );
            }
            "receipt_keys" => {
                let n = case["keys"].as_u64().unwrap() as u8;
                h.hub.receipt_keys.insert(name("settler"), (0..n).map(id).collect());
            }
            "storage_balance" => {
                h.hub.storage_balances.insert(name("account"), 1);
            }
            "settler" => {
                h.hub.settlers.insert(name("account"));
            }
            "checkout" => {
                h.hub.checkout = Some(Checkout {
                    key: id(1),
                    settler: name("settler"),
                });
            }
            "budget" => {
                let payees: Vec<&str> = case["payees"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap())
                    .collect();
                let mut terms = h.terms(&agent(1), 100, payees);
                terms.settler = name("settler");
                h.ctx(name("owner"), plenty());
                h.hub.open_budget(terms);
            }
            other => panic!("unknown record kind {other}"),
        }
        assert_eq!(h.usage() - before, case["bytes"].as_u64().unwrap(), "{case}");
    }
}
