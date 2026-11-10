import type { AccountId, Batch, Budget, Id32, Network, Payment, PublicKey, ReceiptFields, SettleArgs, TxHash, TxState } from "./types.ts";

/**
 * The seam between the product and NEAR. Implemented by the RPC client in `./node` and by the in-memory hub in `./fake`.
 * Reads return bigints. Writes resolve at final finality and reject with ChainError when the hub refuses.
 */
export interface Chain {
  readonly hub: AccountId;
  /** The settlement token contract, a NEP-141. */
  readonly token: AccountId;
  readonly network: Network;
  /** The account this client settles and pays out from. */
  readonly operator: AccountId;

  budget(id: Id32): Promise<Budget | null>;
  settledOf(budgetId: Id32, payee: AccountId): Promise<bigint>;
  /** Withdrawable USDC held for this account in the hub. */
  creditOf(account: AccountId): Promise<bigint>;
  /** Token balance of an account at the settlement token. */
  balanceOf(account: AccountId): Promise<bigint>;
  /** The batch `settler` settled under `id`, or null. Batch ids belong to their settler. */
  batch(id: Id32, settler: AccountId): Promise<Batch | null>;
  /** Aligned with `ids`; null for a payment the hub has not recorded. Polled at final finality by the watcher. */
  payments(ids: readonly Id32[]): Promise<Array<Payment | null>>;
  /** Whether the account can receive the settlement token (NEP-145 storage registered). */
  isRegistered(account: AccountId): Promise<boolean>;
  /**
   * The keys `settler` registered on the hub for signing acceptances, oldest first. `settle_own` accepts a voucher only
   * with an acceptance signed by one of the keys of its Budget's settler. Keys are never removed.
   */
  receiptKeys(settler: AccountId): Promise<PublicKey[]>;
  /**
   * Unused NEAR, in yoctoNEAR, that `account` has prepaid at the hub for storage. `settle_batch` draws on the
   * settler's balance for the bytes it writes and is refused with INSUFFICIENT_STORAGE when it runs out.
   */
  storageOf(account: AccountId): Promise<bigint>;
  /** Calls `settle_batch` as `operator`. Safe to retry: a replayed batch id is refused and `batch(id, operator)` shows the first result. */
  settle(args: SettleArgs): Promise<TxHash>;
  /** Calls `payout`. Read `creditOf` afterwards: unregistered accounts keep their credit, and a failed transfer restores it. */
  payout(accounts: readonly AccountId[]): Promise<TxHash>;
  txState(hash: TxHash): Promise<TxState>;
  /**
   * View of `verify_receipt` for the batch `settler` settled under `batchId`: the hub rebuilds the leaf from these
   * fields, and never accepts a raw leaf. The settler of a receipt's batch is its Budget's settler.
   */
  verifyReceipt(batchId: Id32, settler: AccountId, fields: ReceiptFields, proof: readonly Id32[]): Promise<boolean>;
}
