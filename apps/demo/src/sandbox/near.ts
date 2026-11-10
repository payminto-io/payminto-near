/**
 * The demo's only direct use of near-kit: account keys and one signer per account for the sandbox run.
 *
 * packages/chain is meant to be the only importer of NEAR libraries, but it offers no way to build a wallet signer or
 * a new account, so this file does exactly that and nothing more. Every transaction is still sent through
 * `sendWalletTx` or `sendBuiltOnce` from @payminto/chain/node: signed once, sent once, waited on to final.
 */
import { generateKey, Near, parseKey, type TransactionBuilder } from "near-kit";
import { NearRpcError, sendBuiltOnce, sendWalletTx } from "@payminto/chain/node";
import type { AccountId, TxHash, WalletTx } from "@payminto/protocol";

/** A fresh `ed25519:<base58>` NEAR secret key. */
export const newNearSecretKey = (): string => generateKey().secretKey;
/** The public half of a secret key, derived locally. */
export const publicKeyOf = (secretKey: string): string => parseKey(secretKey).publicKey.toString();

export type Account = { id: AccountId; secretKey: string; near: Near };

/** Write deadline for one sandbox transaction, including final execution. */
const WRITE_TIMEOUT_MS = 60_000;

/** One near-kit client per account, each holding only that account's key. */
export class Signers {
  readonly rpcUrl: string;
  readonly #accounts = new Map<AccountId, Account>();

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  add(id: AccountId, secretKey: string): Account {
    const a = { id, secretKey, near: new Near({ network: { rpcUrl: this.rpcUrl, networkId: "localnet" }, keyStore: { [id]: secretKey }, retryConfig: { maxRetries: 0, initialDelayMs: 0 } }) };
    this.#accounts.set(id, a);
    return a;
  }

  get(id: AccountId): Account {
    const a = this.#accounts.get(id);
    if (!a) throw new Error(`no key for ${id} in this sandbox run`);
    return a;
  }

  /** Signs and sends one wallet transaction built by @payminto/chain's action builders. */
  wallet(signer: AccountId, tx: WalletTx): Promise<TxHash> {
    return retryNonce(() => sendWalletTx(this.get(signer).near, signer, tx, WRITE_TIMEOUT_MS));
  }

  /** Signs and sends one transaction built with near-kit's builder (account creation, keys, contract deploys). */
  built(signer: AccountId, label: string, build: (b: TransactionBuilder) => TransactionBuilder): Promise<TxHash> {
    return retryNonce(() => sendBuiltOnce(this.get(signer).near, signer, build, label, WRITE_TIMEOUT_MS));
  }

  /**
   * A view with a deadline. near-kit's fetch has no timeout of its own, so an RPC that never answers would hold the
   * call for Node's 300 s default, once per retry.
   */
  async view<T>(contract: AccountId, method: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`view ${contract}.${method} did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
    });
    try {
      return (await Promise.race([this.#reader().view<T>(contract, method, args, { finality: "final" }), deadline])) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  #readerNear: Near | null = null;
  #reader(): Near {
    this.#readerNear ??= new Near({ network: { rpcUrl: this.rpcUrl, networkId: "localnet" }, retryConfig: { maxRetries: 2, initialDelayMs: 250 } });
    return this.#readerNear;
  }
}

/**
 * Transactions from one key sent concurrently can reach the node out of nonce order, and the later nonce then makes
 * the earlier one invalid. Such a transaction never executed, so signing it again with a fresh nonce is safe.
 */
async function retryNonce<T>(send: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await send();
    } catch (err) {
      const nonce = err instanceof NearRpcError && err.kind === "rejected" && /nonce/i.test(err.message);
      if (!nonce || i >= attempts) throw err;
    }
  }
}
