import { DEFAULT_MAX_PAYEES } from "./constants.ts";
import type { AccountId } from "./types.ts";

/**
 * The hub's storage, byte for byte. The hub charges for the storage a call really writes, measured with
 * `env::storage_usage()`, and never pays for it itself. The owner prepays at `open_budget` a storage reserve of
 * `PAIR_BYTES` per payee the Budget can pay; `settle_batch` and `settle_own` draw each Budget's new `settled` and
 * credit entries from it (`settle_own` then from the caller's deposit). The settler's prepaid storage balance pays for
 * its batch records, its receipt keys and checkout payments.
 *
 * These formulas are what the contract's records cost: key bytes plus value bytes plus the protocol's 40 bytes per
 * record. `vectors/storage.json` pins them, and the contract's tests measure the same records against that file.
 */

/** yoctoNEAR per byte of contract storage. A NEAR protocol parameter: 1 NEAR per 100 kB. */
export const STORAGE_BYTE_COST = 10n ** 19n;
/** Bytes the protocol counts for every record on top of its key and value. */
export const STORAGE_RECORD_BYTES = 40;
/**
 * Bytes an owner prepays at `open_budget` per payee its Budget can pay: one `settled` entry (157 bytes) and one credit
 * entry the Budget pays for (175 bytes), both for a 64-character account, the longest NEAR allows.
 */
export const PAIR_BYTES = 157 + 175;
/** Bytes a revoke adds to a Budget record, prepaid by the owner at `open_budget`. */
export const REVOKE_BYTES = 8;

/** A Borsh string: a u32 length and the bytes. NEAR account ids are ASCII, so characters are bytes. */
const str = (s: string): number => 4 + s.length;
/** A record whose key is a one-byte collection prefix and a Borsh key. */
const record = (key: number, value: number): number => 1 + key + value + STORAGE_RECORD_BYTES;

/**
 * Who paid for a credit entry's storage and gets it back when the entry is removed: a settler's storage balance
 * (checkout payments), the reserve of the Budget whose settlement created it, or nobody the hub can repay (a payee's
 * own deposit in `settle_own`).
 */
export type CreditFunder = { settler: AccountId } | { budget: string } | null;

/** Borsh `Option<Funder>`: the option tag, then the enum tag and an account id or a 32-byte Budget id. */
const funderBytes = (f: CreditFunder): number => (f === null ? 1 : "settler" in f ? 1 + 1 + str(f.settler) : 1 + 1 + 32);

export const storageBytes = {
  /** `settled[(budget_id, payee)]`: the last settled cumulative. */
  settled: (payee: AccountId): number => record(32 + str(payee), 16),
  /** `credits[account]`: amount, amount in flight, and who paid for the entry. */
  credit: (account: AccountId, funder: CreditFunder): number => record(str(account), 16 + 16 + funderBytes(funder)),
  /** `batches[(settler, batch_id)]`: root, settler, gross, net and block time. */
  batch: (settler: AccountId): number => record(str(settler) + 32, 32 + str(settler) + 16 + 16 + 8),
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
  /**
   * A Budget record before any revoke: owner, settler, agent key, cap, spent, escrow, valid until, revoked at (none),
   * payees, policy hash, allow-any flag, the payee limit and count (two u32) and storage reserve. `open_budget` charges
   * this plus `REVOKE_BYTES` and the reserve.
   */
  budget: (b: { owner: AccountId; settler: AccountId; payees: readonly AccountId[] }): number =>
    record(32, str(b.owner) + str(b.settler) + 32 + 16 + 16 + 16 + 8 + 1 + 4 + b.payees.reduce((sum, p) => sum + str(p), 0) + 32 + 1 + 4 + 4 + 8),
} as const;

/** What `bytes` of storage cost, in yoctoNEAR. */
export const storageCost = (bytes: number | bigint): bigint => BigInt(bytes) * STORAGE_BYTE_COST;

/** Payees a Budget can pay, and so the `PAIR_BYTES` its owner prepays: one per listed payee, or `maxPayees`. */
export const payeeSlots = (b: { payees: readonly AccountId[]; maxPayees?: number }): number =>
  b.payees.length > 0 ? new Set(b.payees).size : (b.maxPayees ?? DEFAULT_MAX_PAYEES);

/** The storage reserve `open_budget` gives a Budget, in bytes. */
export const storageReserveBytes = (b: { payees: readonly AccountId[]; maxPayees?: number }): number => payeeSlots(b) * PAIR_BYTES;

/** What `open_budget` keeps from the attached deposit, in yoctoNEAR: record, revoke bytes and storage reserve. */
export const openBudgetStorageCost = (b: { owner: AccountId; settler: AccountId; payees: readonly AccountId[]; maxPayees?: number }): bigint =>
  storageCost(storageBytes.budget({ ...b, payees: [...new Set(b.payees)] }) + REVOKE_BYTES + storageReserveBytes(b));

/**
 * An upper bound on what `batches` calls of `settle_batch` draw from the settler's storage balance, in yoctoNEAR: one
 * batch record each, for a 64-character settler. The `settled` and credit entries of new payees come from the Budgets'
 * reserves. Use it to size a prefund or a low-balance alert, never as the charge itself.
 */
export function maxSettleBatchStorageCost(batches = 1): bigint {
  return storageCost(batches * storageBytes.batch("a".repeat(64)));
}
