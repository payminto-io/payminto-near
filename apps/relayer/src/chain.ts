import type { AccountId, PublicKey } from "@payminto/chain";

/** What an access key may sign. `other` covers key kinds this relayer does not sponsor (gas keys). */
export type KeyPermission =
  | { kind: "full_access" }
  | { kind: "function_call"; receiverId: string; methodNames: readonly string[] }
  | { kind: "other"; name: string };

export type SenderKey = { nonce: bigint; permission: KeyPermission };

/**
 * How a submission ended, as far as the relayer can tell.
 *
 * - `not_sent`: nothing reached the network (signing failed, or the RPC could not be reached before the send).
 * - `rejected`: the network refused the relayer's own transaction before it ran (its balance or its nonce). No gas was spent.
 * - `nonce_used`, `expired`, `key_error`: the transaction ran and the protocol refused the delegate inside it.
 * - `call_failed`: the transaction ran and the hub refused the call.
 * - `unknown`: the transaction was sent and its result is not known. It may still land. Never sent again.
 */
export type SubmitFailure = "not_sent" | "rejected" | "nonce_used" | "expired" | "key_error" | "call_failed" | "unknown";

export class SubmitError extends Error {
  readonly failure: SubmitFailure;
  readonly txHash: string | undefined;
  constructor(failure: SubmitFailure, message: string, txHash?: string) {
    super(message);
    this.name = "SubmitError";
    this.failure = failure;
    this.txHash = txHash;
  }
}

/**
 * The relayer's whole view of NEAR. The service uses `NearRelayChain`; tests pass a fake.
 * Reads may be retried by the implementation. `submitDelegate` must send at most one transaction per call.
 */
export interface RelayChain {
  /** The chain id the RPC node reports, for example `testnet`. */
  chainId(): Promise<string>;
  /** The latest block height the RPC node knows. */
  blockHeight(): Promise<bigint>;
  /** One access key of an account, or null when the account or the key does not exist. */
  accessKey(account: AccountId, publicKey: PublicKey): Promise<SenderKey | null>;
  /** The NEAR balance of an account in yoctoNEAR. */
  balance(account: AccountId): Promise<bigint>;
  /**
   * Wraps the Borsh `SignedDelegateAction` in one transaction signed by the relayer, sends it once and waits for the
   * final result. Resolves with the transaction hash, or rejects with `SubmitError`.
   */
  submitDelegate(signedDelegate: Uint8Array): Promise<string>;
}
