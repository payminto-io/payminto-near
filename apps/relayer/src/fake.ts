import { createHash } from "node:crypto";
import type { AccountId, PublicKey } from "@payminto/chain";
import { gasless } from "@payminto/near-addons";
import { base58 } from "@scure/base";
import { SubmitError, type KeyPermission, type RelayChain, type SenderKey } from "./chain.ts";

/**
 * An in-memory `RelayChain` for tests and for `pnpm --filter @payminto/relayer dev:fake`. It touches no network.
 *
 * It behaves like NEAR where the relayer depends on it: a submitted delegate must carry a nonce above the key's, and a
 * successful submission moves the key's nonce to it. Everything else is a knob the test sets.
 */
export class FakeRelayChain implements RelayChain {
  chainIdValue = "localnet";
  height = 1_000n;
  /** Set to make every read reject, like an RPC outage. */
  readsFail = false;
  /** The next submission rejects with this once, then it is cleared. */
  failNextSubmit: Error | null = null;
  /** Hub methods that panic, by method name, with the panic text. */
  hubRefuses = new Map<string, string>();
  /** When set, a submission waits for this before it answers. Lets a test hold a relay in flight. */
  hold: Promise<void> | null = null;
  /** Every delegate that reached `submitDelegate`, in order. */
  readonly submissions: Uint8Array[] = [];
  readonly #keys = new Map<string, SenderKey>();
  readonly #balances = new Map<string, bigint>();

  addKey(account: AccountId, publicKey: PublicKey, nonce = 0n, permission: KeyPermission = { kind: "full_access" }): this {
    this.#keys.set(`${account}|${publicKey}`, { nonce, permission });
    return this;
  }

  setBalance(account: AccountId, yocto: bigint): this {
    this.#balances.set(account, yocto);
    return this;
  }

  async chainId(): Promise<string> {
    this.#read();
    return this.chainIdValue;
  }

  async blockHeight(): Promise<bigint> {
    this.#read();
    return this.height;
  }

  async accessKey(account: AccountId, publicKey: PublicKey): Promise<SenderKey | null> {
    this.#read();
    const k = this.#keys.get(`${account}|${publicKey}`);
    return k ? { ...k } : null;
  }

  async balance(account: AccountId): Promise<bigint> {
    this.#read();
    return this.#balances.get(account) ?? 0n;
  }

  async submitDelegate(signedDelegate: Uint8Array): Promise<string> {
    this.submissions.push(signedDelegate);
    if (this.hold) await this.hold;
    const fail = this.failNextSubmit;
    if (fail) {
      this.failNextSubmit = null;
      throw fail;
    }
    const txHash = base58.encode(createHash("sha256").update(signedDelegate).digest());
    const d = gasless.decodeSignedDelegate(signedDelegate).delegateAction;
    const key = this.#keys.get(`${d.senderId}|${d.publicKey}`);
    if (!key) throw new SubmitError("key_error", "DelegateActionAccessKeyError", txHash);
    if (d.nonce <= key.nonce) throw new SubmitError("nonce_used", "DelegateActionInvalidNonce", txHash);
    if (d.maxBlockHeight < this.height) throw new SubmitError("expired", "DelegateActionExpired", txHash);
    // The protocol takes the nonce before the hub runs, so a refused call still uses it.
    key.nonce = d.nonce;
    for (const a of d.actions) {
      const panic = a.type === "FunctionCall" ? this.hubRefuses.get(a.methodName) : undefined;
      if (panic) throw new SubmitError("call_failed", panic, txHash);
    }
    return txHash;
  }

  #read(): void {
    if (this.readsFail) throw new Error("fake RPC is down");
  }
}
