/**
 * The demo wallet for NEXT_PUBLIC_MOCK: it signs nothing and reaches no chain. Each transaction is applied to the
 * in-memory hub of the mock server, so owner and checkout flows can be walked through end to end. Screens label it as
 * simulated. Never installed outside mock mode.
 */
import type { AccountId, WalletTx } from "@payminto/protocol";
import { DELEGATE_WALLETS_TESTNET, type DelegateSupport, type ExecutionOutcome, type SignMessageInput, type SignedMessage, type WalletDriver } from "../wallet";
import { bytesToBase64 } from "../gasless";
import { DEMO_RPC_URL } from "../near-reader";
import type { DemoKeys } from "./relayer";
import { demo } from "./scenario";
import type { MockTxOutcome } from "./server";

export const DEMO_ACCOUNT: AccountId = "treasury.testnet";

type Apply = (tx: WalletTx, signer: AccountId) => MockTxOutcome | null | Promise<MockTxOutcome | null>;

/** What the demo wallet signs delegate actions with: its demo keys, and the demo chain to read a nonce and height from. */
export type DemoSigning = { keys: DemoKeys; rpcFetch: () => typeof fetch };

export const DEMO_WALLET_NAME = "Demo wallet";

const b64 = (s: string) => btoa(s);
let txSeq = 0;
/** A NEAR-shaped transaction hash: 44 base58 characters, deterministic per session. */
function demoHash(): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0x9e3779b9 ^ ++txSeq;
  let out = "";
  for (let i = 0; i < 44; i++) {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    out += alphabet[n % alphabet.length];
  }
  return out;
}

function outcomeOf(tx: WalletTx, r: MockTxOutcome): ExecutionOutcome {
  const hash = demoHash();
  const call = tx.actions.find((a) => a.params.methodName === "ft_transfer_call");
  if (r.ok) {
    const used = call ? (r.used ?? BigInt(String(call.params.args.amount))) : null;
    return { transaction: { hash }, status: { SuccessValue: used === null ? "" : b64(JSON.stringify(used.toString())) } };
  }
  if (call && r.refunded) {
    return { transaction: { hash }, status: { SuccessValue: b64(JSON.stringify("0")) }, receipts_outcome: [{ outcome: { status: { Failure: { ExecutionError: r.error } } } }] };
  }
  return { transaction: { hash }, status: { Failure: { ExecutionError: r.error } } };
}

export class MockWalletDriver implements WalletDriver {
  #account: AccountId | null = null;
  #listeners = new Set<(a: AccountId | null) => void>();
  readonly #apply: Apply[];
  readonly #signing: DemoSigning | null;

  constructor(apply: Apply[], signing: DemoSigning | null = null) {
    this.#apply = apply;
    this.#signing = signing;
  }

  /** As a person pressing Cancel in their wallet, when the demo is switched to play that. */
  #maybeReject() {
    if (demo("wallet-rejects")) throw new Error("User rejected the request");
  }

  /** The demo wallet changes account, as a person picking another one in their wallet. */
  switchAccount(account: AccountId) {
    this.#account = account;
    for (const l of this.#listeners) l(account);
  }

  async connect(expected?: AccountId) {
    await pause(500);
    this.#maybeReject();
    this.#account = expected ?? this.#account ?? DEMO_ACCOUNT;
    for (const l of this.#listeners) l(this.#account);
    return this.#account;
  }
  async disconnect() {
    this.#account = null;
    for (const l of this.#listeners) l(null);
  }
  async account() {
    return this.#account;
  }
  async signAndSendTransaction(tx: WalletTx) {
    await pause(900);
    this.#maybeReject();
    const signer = this.#account ?? DEMO_ACCOUNT;
    for (const a of this.#apply) {
      const r = await a(tx, signer);
      if (r) return outcomeOf(tx, r);
    }
    return outcomeOf(tx, { ok: false, error: "The demo hub does not run this transaction." });
  }
  async signAndSendTransactions(txs: readonly WalletTx[]) {
    const out: ExecutionOutcome[] = [];
    for (const tx of txs) out.push(await this.signAndSendTransaction(tx));
    return out;
  }
  /**
   * Signs NEP-366 delegate actions as a wallet does: it reads its key's next nonce and a block height to expire at
   * from the (demo) chain through the add-on's read-only RPC, builds each delegate with the add-on, and signs it with
   * the demo key. Nothing is sent.
   */
  async signDelegateActions(delegates: readonly WalletTx[]): Promise<string[]> {
    await pause(900);
    this.#maybeReject();
    if (!this.#signing) throw new Error("The demo wallet has no key to sign with here.");
    const account = this.#account ?? DEMO_ACCOUNT;
    const { gasless, ViewRpc } = await import("@payminto/near-addons");
    const f = this.#signing.rpcFetch();
    const rpc = new ViewRpc(DEMO_RPC_URL, async (url, init) => {
      const res = await f(url, init);
      return { status: res.status, text: () => res.text() };
    });
    const pair = this.#signing.keys.pair(account);
    const params = await gasless.delegateParams(rpc, account, pair.publicKey);
    return delegates.map((tx, i) => {
      const delegate = { senderId: account, receiverId: tx.receiverId, actions: gasless.fromWalletActions(tx.actions), nonce: params.nonce + BigInt(i), maxBlockHeight: params.maxBlockHeight, publicKey: pair.publicKey };
      return bytesToBase64(gasless.encodeSignedDelegate(gasless.signDelegate(delegate, pair.secretKey)));
    });
  }
  async delegateSupport(): Promise<DelegateSupport> {
    return { wallet: this.#account ? DEMO_WALLET_NAME : null, supported: this.#signing !== null && !demo("wallet-no-delegate"), capable: [...DELEGATE_WALLETS_TESTNET] };
  }
  async signMessage(input: SignMessageInput): Promise<SignedMessage> {
    await pause(600);
    this.#maybeReject();
    void input;
    return { accountId: this.#account ?? DEMO_ACCOUNT, publicKey: "ed25519:DemoWa11etKeyNotReal1111111111111111111111111", signature: b64("demo signature, not valid on any chain") };
  }
  onAccountChange(cb: (a: AccountId | null) => void) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
