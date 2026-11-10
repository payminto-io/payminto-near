//! Wire and storage types for the hub.
//! Amounts are decimal strings in JSON and fixed-width integers in Borsh.
//! Hashes and signatures are lowercase hex in JSON and raw bytes in Borsh.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::{Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::{AccountId, NearSchema, near};

macro_rules! fixed_bytes {
    ($(#[$doc:meta])* $name:ident, $len:expr) => {
        $(#[$doc])*
        #[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, NearSchema)]
        #[abi(json, borsh)]
        #[borsh(crate = "near_sdk::borsh")]
        pub struct $name(#[schemars(with = "String")] pub [u8; $len]);

        impl $name {
            /// Parses lowercase hex of exactly twice the byte length.
            pub fn from_hex(s: &str) -> Option<Self> {
                from_hex::<$len>(s).map(Self)
            }

            pub fn to_hex(&self) -> String {
                to_hex(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.to_hex())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let s = <String as Deserialize>::deserialize(deserializer)?;
                Self::from_hex(&s).ok_or_else(|| near_sdk::serde::de::Error::custom("invalid hex"))
            }
        }
    };
}

fixed_bytes!(
    /// 32 bytes, as 64 lowercase hex digits in JSON and raw in Borsh.
    Id32,
    32
);
fixed_bytes!(
    /// A 64-byte ed25519 signature, as 128 lowercase hex digits in JSON and raw in Borsh.
    Sig64,
    64
);

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

fn from_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let bytes = s.as_bytes();
    if bytes.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = (hex_value(bytes[2 * i])? << 4) | hex_value(bytes[2 * i + 1])?;
    }
    Some(out)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Everything the owner fixes when opening a Budget.
/// The owner is the predecessor of `open_budget`, so it is not part of the arguments.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BudgetTerms {
    pub agent_pk: Id32,
    pub settler: AccountId,
    pub cap: U128,
    pub valid_until: U64,
    pub payees: Vec<AccountId>,
    pub policy_hash: Id32,
    pub salt: Id32,
}

/// A spending authority on one owner's escrow.
/// `cap` is authority over gross spending and `escrow` is funding, and only deposits raise escrow.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Budget {
    pub owner: AccountId,
    pub settler: AccountId,
    pub agent_pk: Id32,
    pub cap: U128,
    pub spent: U128,
    pub escrow: U128,
    pub valid_until: U64,
    pub revoked_at: Option<U64>,
    pub payees: Vec<AccountId>,
    pub policy_hash: Id32,
    /// Storage bytes already paid for by the owner, which `settle_own` consumes before charging the payee.
    pub reserved_settle_own_bytes: u64,
}

/// The latest voucher for a `(budget, payee)` pair, as submitted for settlement.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub budget_id: Id32,
    pub payee: AccountId,
    pub amount: U128,
    pub cumulative: U128,
    pub request_hash: Id32,
    pub signature: Sig64,
}

/// The node's signed acceptance of one call, which `settle_own` requires next to the claim.
/// The node returns it to the seller in the receipt of every call it accepts.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Acceptance {
    /// The receipt key that signed, which must be registered on the hub by the Budget's settler.
    pub node_key: Id32,
    /// Unix seconds at which the node accepted the call, as signed.
    pub timestamp_s: U64,
    pub signature: Sig64,
}

/// Withdrawable token credit of one account.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Credit {
    pub amount: u128,
    /// Sent by `payout` and not yet confirmed or restored by its callback. The entry stays while this is non-zero.
    pub in_flight: u128,
    /// The settler whose storage balance paid for this entry, which gets that storage back when the entry is removed.
    pub funder: Option<AccountId>,
}

/// The node key that signs checkout terms, and the settler whose storage balance pays for accepted payments.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Checkout {
    pub key: Id32,
    pub settler: AccountId,
}

/// One account's net position in a batch; exactly one of `debit` and `credit` is non-zero.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct NetEntry {
    pub account: AccountId,
    pub debit: U128,
    pub credit: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchRecord {
    pub root: Id32,
    pub settler: AccountId,
    pub gross: U128,
    pub net: U128,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentRecord {
    pub merchant: AccountId,
    pub amount: U128,
    pub payer: AccountId,
    pub at: U64,
}

/// A stored payment with its id, as returned by `payments`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentView {
    pub id: Id32,
    pub merchant: AccountId,
    pub amount: U128,
    pub payer: AccountId,
    pub at: U64,
}

/// The fields of one call receipt, which `verify_receipt` turns into a leaf.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ReceiptFields {
    pub call_id: Id32,
    pub budget_id: Id32,
    pub payee: AccountId,
    pub amount: U128,
    pub cumulative: U128,
    pub request_hash: Id32,
    pub timestamp_ms: U64,
    pub voucher_sig: Sig64,
}

/// Aggregate liabilities, for checking the solvency invariant against the token balance.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Totals {
    pub escrow: U128,
    pub credits: U128,
    pub in_flight: U128,
}

/// The immutable deployment parameters.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: AccountId,
    pub token: AccountId,
    pub network: String,
}

/// The tagged JSON accepted as `msg` by `ft_on_transfer`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug)]
pub enum TransferMsg {
    Budget {
        budget_id: Id32,
    },
    Payment {
        payment_id: Id32,
        merchant: AccountId,
        amount: U128,
        expiry_ms: U64,
        signature: Sig64,
    },
}
