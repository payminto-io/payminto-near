//! Stable error codes.
//! They match `HUB_ERRORS` in `packages/chain`, so that the node can map a panic string to a refusal.
//! `packages/chain/vectors/errors.json` holds the shared list, and tests on both sides fail if either list drifts.

pub const ACCEPTANCE_KEY_UNKNOWN: &str = "ACCEPTANCE_KEY_UNKNOWN";
pub const ACCEPTANCE_TOO_LATE: &str = "ACCEPTANCE_TOO_LATE";
pub const ADMIN_IS_HUB: &str = "ADMIN_IS_HUB";
pub const ALREADY_REVOKED: &str = "ALREADY_REVOKED";
pub const BAD_ACCEPTANCE: &str = "BAD_ACCEPTANCE";
pub const BAD_SIGNATURE: &str = "BAD_SIGNATURE";
pub const BATCH_EXISTS: &str = "BATCH_EXISTS";
pub const BUDGET_CLOSED: &str = "BUDGET_CLOSED";
pub const BUDGET_EXISTS: &str = "BUDGET_EXISTS";
pub const BUDGET_NOT_OPEN: &str = "BUDGET_NOT_OPEN";
pub const CAP_EXCEEDED: &str = "CAP_EXCEEDED";
pub const INSUFFICIENT_CREDIT: &str = "INSUFFICIENT_CREDIT";
pub const INSUFFICIENT_DEPOSIT: &str = "INSUFFICIENT_DEPOSIT";
pub const INSUFFICIENT_ESCROW: &str = "INSUFFICIENT_ESCROW";
pub const INSUFFICIENT_GAS: &str = "INSUFFICIENT_GAS";
pub const INSUFFICIENT_STORAGE: &str = "INSUFFICIENT_STORAGE";
pub const INVALID_BUDGET: &str = "INVALID_BUDGET";
pub const NET_MISMATCH: &str = "NET_MISMATCH";
pub const NOT_ADMIN: &str = "NOT_ADMIN";
pub const NOT_BUDGET_SETTLER: &str = "NOT_BUDGET_SETTLER";
pub const NOT_OWNER: &str = "NOT_OWNER";
pub const NOT_PAYEE: &str = "NOT_PAYEE";
pub const NOT_SETTLER: &str = "NOT_SETTLER";
pub const ONE_BUDGET_PER_OWNER: &str = "ONE_BUDGET_PER_OWNER";
pub const OVERFLOW: &str = "OVERFLOW";
pub const PAYEE_IS_OWNER: &str = "PAYEE_IS_OWNER";
pub const PAYEE_NOT_ALLOWED: &str = "PAYEE_NOT_ALLOWED";
pub const RECEIPT_KEY_EXISTS: &str = "RECEIPT_KEY_EXISTS";
pub const RESERVED_ACCOUNT: &str = "RESERVED_ACCOUNT";
pub const STALE_VOUCHER: &str = "STALE_VOUCHER";
pub const TOO_EARLY: &str = "TOO_EARLY";
pub const TOO_MANY_ACCOUNTS: &str = "TOO_MANY_ACCOUNTS";
pub const TOO_MANY_CLAIMS: &str = "TOO_MANY_CLAIMS";
pub const TOO_MANY_RECEIPT_KEYS: &str = "TOO_MANY_RECEIPT_KEYS";
pub const UNKNOWN_BUDGET: &str = "UNKNOWN_BUDGET";
pub const ZERO_AMOUNT: &str = "ZERO_AMOUNT";
pub const ZERO_GROSS: &str = "ZERO_GROSS";

/// Every code above, sorted. The conformance test checks this list against the constants in this file and against
/// the shared vector file.
pub const ALL: &[&str] = &[
    ACCEPTANCE_KEY_UNKNOWN,
    ACCEPTANCE_TOO_LATE,
    ADMIN_IS_HUB,
    ALREADY_REVOKED,
    BAD_ACCEPTANCE,
    BAD_SIGNATURE,
    BATCH_EXISTS,
    BUDGET_CLOSED,
    BUDGET_EXISTS,
    BUDGET_NOT_OPEN,
    CAP_EXCEEDED,
    INSUFFICIENT_CREDIT,
    INSUFFICIENT_DEPOSIT,
    INSUFFICIENT_ESCROW,
    INSUFFICIENT_GAS,
    INSUFFICIENT_STORAGE,
    INVALID_BUDGET,
    NET_MISMATCH,
    NOT_ADMIN,
    NOT_BUDGET_SETTLER,
    NOT_OWNER,
    NOT_PAYEE,
    NOT_SETTLER,
    ONE_BUDGET_PER_OWNER,
    OVERFLOW,
    PAYEE_IS_OWNER,
    PAYEE_NOT_ALLOWED,
    RECEIPT_KEY_EXISTS,
    RESERVED_ACCOUNT,
    STALE_VOUCHER,
    TOO_EARLY,
    TOO_MANY_ACCOUNTS,
    TOO_MANY_CLAIMS,
    TOO_MANY_RECEIPT_KEYS,
    UNKNOWN_BUDGET,
    ZERO_AMOUNT,
    ZERO_GROSS,
];
