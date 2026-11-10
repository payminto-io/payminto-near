import type { AccountId, WalletTx } from "@payminto/protocol";
import type { DelegateSupport, ExecutionOutcome, SignMessageInput, SignedMessage, WalletDriver } from "@/lib/wallet";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** An outcome where the receiver kept `used` of an ft_transfer_call (the token returns the used amount as JSON). */
export function ftOutcome(hash: string, used: bigint | string): ExecutionOutcome {
  return { transaction: { hash }, status: { SuccessValue: b64(JSON.stringify(String(used))) } };
}

export function okOutcome(hash: string): ExecutionOutcome {
  return { transaction: { hash }, status: { SuccessValue: "" } };
}

export function failedOutcome(hash: string, panic: string): ExecutionOutcome {
  return { transaction: { hash }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } } } };
}

/**
 * A wallet in memory: no network, no keys, no funds. It records every request, and each behaviour can be replaced to
 * play a rejection, a failure or a partial batch.
 */
export class FakeWallet implements WalletDriver {
  account_: AccountId | null;
  readonly sent: WalletTx[] = [];
  readonly signed: SignMessageInput[] = [];
  /** Every batch of delegate actions the wallet was asked to sign. Nothing here is ever sent. */
  readonly delegated: WalletTx[][] = [];
  /** What the wallet says about delegate signing; a test flips `supported` to play a wallet that cannot. */
  support: DelegateSupport = { wallet: "Fake Wallet", supported: true, capable: ["Fake Wallet", "Other Wallet"] };
  delegateImpl: (delegates: readonly WalletTx[]) => Promise<string[]> = async (delegates) => delegates.map(() => "ZmFrZS1kZWxlZ2F0ZQ==");
  #listeners = new Set<(a: AccountId | null) => void>();
  connectImpl: () => Promise<AccountId>;
  sendImpl: (tx: WalletTx, i: number) => Promise<ExecutionOutcome>;
  signImpl: (input: SignMessageInput) => Promise<SignedMessage>;
  /** How many transactions of a batch the wallet sends before it stops; Infinity sends all. */
  batchLimit = Infinity;

  constructor(opts: { account?: AccountId | null; connectAs?: AccountId } = {}) {
    this.account_ = opts.account ?? null;
    const connectAs = opts.connectAs ?? "owner.testnet";
    this.connectImpl = async () => connectAs;
    this.sendImpl = async (tx, i) => {
      const call = tx.actions.find((a) => a.params.methodName === "ft_transfer_call");
      return call ? ftOutcome(`tx${i}`, String(call.params.args.amount)) : okOutcome(`tx${i}`);
    };
    this.signImpl = async () => ({ accountId: this.account_ ?? connectAs, publicKey: "ed25519:fakeKey", signature: "ZmFrZS1zaWduYXR1cmU=" });
  }

  async connect() {
    const a = await this.connectImpl();
    this.account_ = a;
    this.emit(a);
    return a;
  }
  async disconnect() {
    if (!this.account_) throw new Error("No accounts found");
    this.account_ = null;
    this.emit(null);
  }
  async account() {
    return this.account_;
  }
  async signAndSendTransaction(tx: WalletTx) {
    this.sent.push(tx);
    return this.sendImpl(tx, this.sent.length - 1);
  }
  async signAndSendTransactions(txs: readonly WalletTx[]) {
    const out: ExecutionOutcome[] = [];
    for (const tx of txs.slice(0, this.batchLimit)) out.push(await this.signAndSendTransaction(tx));
    return out;
  }
  async signDelegateActions(delegates: readonly WalletTx[]) {
    this.delegated.push([...delegates]);
    return this.delegateImpl(delegates);
  }
  async delegateSupport() {
    return this.account_ ? this.support : { ...this.support, wallet: null, supported: false };
  }
  async signMessage(input: SignMessageInput) {
    this.signed.push(input);
    return this.signImpl(input);
  }
  onAccountChange(cb: (a: AccountId | null) => void) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  /** The wallet signs in or out on its own, as from another tab. */
  emit(a: AccountId | null) {
    for (const l of this.#listeners) l(a);
  }
}
