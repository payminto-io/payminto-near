import type { AccountId } from "./types.ts";

/**
 * The hub's storage, byte for byte. The hub charges for the storage a call really writes, measured with
 * `env::storage_usage()`, and never pays for it itself: `settle_batch`, `register_receipt_key` and checkout payments
 * draw on the settler's prepaid storage balance, `settle_own` on the Budget's reserve and then the caller's deposit.
 *
 * These formulas are what the contract's records cost: key bytes plus value bytes plus the protocol's 40 bytes per
 * record. `vectors/storage.json` pins them, and the contract's tests measure the same records against that file.
 */

/** yoctoNEAR per byte of contract storage. A NEAR protocol parameter: 1 NEAR per 100 kB. */
export const STORAGE_BYTE_COST = 10n ** 19n;
/** Bytes the protocol counts for every record on top of its key and value. */
export const STORAGE_RECORD_BYTES = 40;
/** Bytes an owner prepays at `open_budget` for `settle_own` claims: room for about 16 new payees. */
export const RESERVED_SETTLE_OWN_BYTES = 4_800;
/** Bytes a revoke adds to a Budget record, prepaid by the owner at `open_budget`. */
export const REVOKE_BYTES = 8;

/** A Borsh string: a u32 length and the bytes. NEAR account ids are ASCII, so characters are bytes. */
const str = (s: string): number => 4 + s.length;
/** A record whose key is a one-byte collection prefix and a Borsh key. */
const record = (key: number, value: number): number => 1 + key + value + STORAGE_RECORD_BYTES;

export const storageBytes = {
  /** `settled[(budget_id, payee)]`: the last settled cumulative. */
  settled: (payee: AccountId): number => record(32 + str(payee), 16),
  /** `credits[account]`: amount, amount in flight, and the settler that paid for the entry, if one did. */
  credit: (account: AccountId, funder: AccountId | null): number => record(str(account), 16 + 16 + 1 + (funder === null ? 0 : str(funder))),
  /** `batches[batch_id]`: root, settler, gross, net and block time. */
  batch: (settler: AccountId): number => record(32, 32 + str(settler) + 16 + 16 + 8),
  /** `payments[payment_id]`: merchant, amount, payer and block time. */
  payment: (merchant: AccountId, payer: AccountId): number => record(32, str(merchant) + 16 + str(payer) + 8),
  /** `receipt_keys[settler]` holding `keys` keys. Each further key adds 32 bytes. */
  receiptKeys: (settler: AccountId, keys: number): number => (keys === 0 ? 0 : record(str(settler), 4 + 32 * keys)),
  /** `storage_balances[account]`. The first deposit pays for this entry. */
  storageBalance: (account: AccountId): number => record(str(account), 16),
  /** One entry on the settler allowlist, paid by the admin's deposit. */
  settler: (account: AccountId): number => record(str(account), 0),
  /** The checkout key and its settler in the contract's root record, paid by the admin's deposit. */
  checkout: (settler: AccountId): number => 32 + str(settler),
  /** A Budget record before any revoke. `open_budget` charges this plus `REVOKE_BYTES` and `RESERVED_SETTLE_OWN_BYTES`. */
  budget: (b: { owner: AccountId; settler: AccountId; payees: readonly AccountId[] }): number =>
    record(32, str(b.owner) + str(b.settler) + 32 + 16 + 16 + 16 + 8 + 1 + 4 + b.payees.reduce((sum, p) => sum + str(p), 0) + 32 + 8),
} as const;

/** What `bytes` of storage cost, in yoctoNEAR. */
export const storageCost = (bytes: number | bigint): bigint => BigInt(bytes) * STORAGE_BYTE_COST;

/** What `open_budget` keeps from the attached deposit, in yoctoNEAR. The rest is refunded. */
export const openBudgetStorageCost = (b: { owner: AccountId; settler: AccountId; payees: readonly AccountId[] }): bigint =>
  storageCost(storageBytes.budget(b) + REVOKE_BYTES + RESERVED_SETTLE_OWN_BYTES);

/**
 * An upper bound on what one `settle_batch` of `claims` claims can draw from the settler's storage balance, in
 * yoctoNEAR: every claim writes a new `settled` entry and a new `credits` entry for 64-character accounts, plus the
 * batch record. Use it to size a prefund or a low-balance alert, never as the charge itself.
 */
export function maxSettleBatchStorageCost(claims: number): bigint {
  const longest = "a".repeat(64);
  return storageCost(claims * (storageBytes.settled(longest) + storageBytes.credit(longest, longest)) + storageBytes.batch(longest));
}
