/**
 * The one module that talks to a NEAR wallet (spec: "Dashboard and design"). NEAR Connect (@hot-labs/near-connect) is
 * loaded on first use in the browser only. Every screen goes through the functions here, never the connector, so tests
 * swap in a fake wallet with `setWalletDriver` and nothing else changes.
 *
 * Transactions are `WalletTx` values from the pure builders in @payminto/chain; this module never names a contract method.
 */
import type { AccountId, TxHash, WalletTx } from "@payminto/protocol";
import { LOCAL_SIGNER } from "./config";

export type WalletNetwork = "testnet" | "mainnet";

/** The parts of a NEAR FinalExecutionOutcome this dashboard reads. */
export type ExecutionStatus = { SuccessValue?: string; Failure?: unknown } | string;
export type ExecutionOutcome = {
  transaction?: { hash?: string } | null;
  transaction_outcome?: { id?: string } | null;
  status?: ExecutionStatus;
  receipts_outcome?: Array<{ id?: string; outcome?: { status?: ExecutionStatus } }>;
};

export type SignedMessage = { accountId: AccountId; publicKey: string; signature: string };

/** NEP-413 inputs. The nonce is 32 random bytes chosen here, so a signature cannot be replayed for another request. */
export type SignMessageInput = { message: string; recipient: string; nonce: Uint8Array };

/** What this dashboard needs from a wallet. NEAR Connect implements it in the browser; tests pass a fake. */
export interface WalletDriver {
  /** `expected` is the account the screen needs; a real wallet lets the person choose and may ignore it. */
  connect(expected?: AccountId): Promise<AccountId>;
  disconnect(): Promise<void>;
  /** The account the wallet already shared with this site, without prompting; null when none. */
  account(): Promise<AccountId | null>;
  signAndSendTransaction(tx: WalletTx): Promise<ExecutionOutcome>;
  signAndSendTransactions(txs: readonly WalletTx[]): Promise<ExecutionOutcome[]>;
  signMessage(input: SignMessageInput): Promise<SignedMessage>;
  /**
   * Asks the wallet to sign NEP-366 delegate actions and send nothing. The wallet picks the access key, its next nonce
   * and the block height the signature expires at. Returns one base64 Borsh `SignedDelegateAction` per delegate, in order.
   */
  signDelegateActions(delegates: readonly WalletTx[]): Promise<string[]>;
  /** Whether the connected wallet can do that, and which wallets on this network can. Never prompts. */
  delegateSupport(): Promise<DelegateSupport>;
  /** Calls back when the wallet signs in or out on its own (another tab, the wallet app). Returns an unsubscribe. */
  onAccountChange(cb: (account: AccountId | null) => void): () => void;
}

/**
 * `wallet` is the connected wallet's name, or null when none is connected. `capable` names the wallets on this network
 * that can sign delegate actions, from the wallet list NEAR Connect loaded; empty when that list is not known.
 */
export type DelegateSupport = { wallet: string | null; supported: boolean; capable: string[] };

/**
 * Wallets whose NEAR Connect manifest entry had `signDelegateActions` and `testnet` on 2026-11-10. Used in the
 * explanation only when the live list could not be read; support itself is always read from the connected wallet.
 */
export const DELEGATE_WALLETS_TESTNET: readonly string[] = ["Meteor Wallet", "Intear Wallet", "Ledger", "NEAR CLI"];

export type WalletErrorKind = "rejected" | "not_connected" | "unavailable" | "wrong_account" | "unsupported" | "failed";

/** A wallet failure in plain words. `rejected` is the person's own choice and never shown as an error. */
export class WalletError extends Error {
  readonly kind: WalletErrorKind;
  constructor(kind: WalletErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WalletError";
    this.kind = kind;
  }
}

const REJECTED = /user (rejected|denied|cancel+ed|closed)|rejected (the )?request|request (was )?rejected|cancel+ed by user|user abort|popup closed|window closed/i;
const NOT_CONNECTED = /no accounts found|no wallet selected|not signed in|wallet not found|not connected/i;

/**
 * A failure in a signing flow that is not the wallet's own, such as a relayer refusing, already in plain words with
 * what to do next. Screens show its message as it is.
 */
export class FlowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FlowError";
  }
}

/** Maps anything a wallet throws onto a WalletError, so every screen shows the same words for the same failure. */
export function toWalletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (REJECTED.test(msg)) return new WalletError("rejected", "You canceled in your wallet. Nothing was sent.", { cause: e });
  if (NOT_CONNECTED.test(msg)) return new WalletError("not_connected", "Connect a NEAR wallet first.", { cause: e });
  return new WalletError("failed", msg ? `Your wallet could not finish: ${msg}` : "Your wallet could not finish the request.", { cause: e });
}

/** Plain words for wallet failures; a rejected prompt is the person's choice, not an error. */
export function walletErrorMessage(e: unknown): string {
  return toWalletError(e).message;
}

export const isWalletRejection = (e: unknown): boolean => toWalletError(e).kind === "rejected";

// ---------------------------------------------------------------------------------------------------------------------
// Driver selection

/** No mainnet node mode in this submission, so the wallet defaults to testnet. */
export const WALLET_NETWORK: WalletNetwork = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

let override: WalletDriver | null = null;
let driverPromise: Promise<WalletDriver> | null = null;

/** Tests and the mock server install their own wallet here; null restores NEAR Connect. Resets the shared state. */
export function setWalletDriver(driver: WalletDriver | null): void {
  override = driver;
  driverPromise = null;
  unsubscribeDriver?.();
  unsubscribeDriver = null;
  setState({ status: "idle", account: null });
}

/** Whether this browser can reach a NEAR wallet at all (false during server rendering). */
export function walletAvailable(): boolean {
  return override !== null || typeof window !== "undefined";
}

async function driver(): Promise<WalletDriver> {
  if (override) return override;
  if (typeof window === "undefined") throw new WalletError("unavailable", "A NEAR wallet is only available in the browser.");
  // `pnpm local` only: LOCAL_SIGNER is null unless the wallet network is the sandbox, so testnet and mainnet never load it.
  const local = LOCAL_SIGNER;
  driverPromise ??= (local ? import("./wallet-local").then((m) => m.localSignerDriver(local)) : nearConnectDriver(WALLET_NETWORK)).catch((e: unknown) => {
    driverPromise = null;
    throw new WalletError("unavailable", local ? "The local signer's wallet could not load. Reload the page and try again." : "NEAR Connect could not load. Check your connection and try again.", { cause: e });
  });
  return driverPromise;
}

/** NEAR Connect behind the WalletDriver interface. Loaded lazily because it touches window, IndexedDB and storage. */
async function nearConnectDriver(network: WalletNetwork): Promise<WalletDriver> {
  const { NearConnector } = await import("@hot-labs/near-connect");
  const connector = new NearConnector({
    network,
    autoConnect: false,
    features: network === "mainnet" ? { signAndSendTransaction: true, mainnet: true } : { signAndSendTransaction: true, testnet: true },
    footerBranding: { heading: "Payminto", link: "https://wallet.near.org", linkText: "Need a NEAR wallet?" },
  });
  const firstAccount = (accounts: ReadonlyArray<{ accountId: string }> | undefined): AccountId | null => accounts?.[0]?.accountId ?? null;
  const toTx = (tx: WalletTx) => ({ receiverId: tx.receiverId, actions: tx.actions });
  return {
    async connect() {
      const wallet = await connector.connect();
      const account = firstAccount(await wallet.getAccounts({ network }));
      if (!account) throw new WalletError("not_connected", "The wallet connected but shared no account. Try again.");
      return account;
    },
    async disconnect() {
      await connector.disconnect();
    },
    async account() {
      try {
        const { accounts } = await connector.getConnectedWallet();
        return firstAccount(accounts);
      } catch {
        return null;
      }
    },
    async signAndSendTransaction(tx) {
      const wallet = await connector.wallet();
      return (await wallet.signAndSendTransaction({ network, ...toTx(tx) })) as ExecutionOutcome;
    },
    async signAndSendTransactions(txs) {
      const wallet = await connector.wallet();
      return (await wallet.signAndSendTransactions({ network, transactions: txs.map(toTx) })) as ExecutionOutcome[];
    },
    async signMessage(input) {
      const wallet = await connector.wallet();
      return wallet.signMessage({ ...input, network });
    },
    async signDelegateActions(delegates) {
      const wallet = await connector.wallet();
      const { signedDelegateActions } = await wallet.signDelegateActions({ network, delegateActions: delegates.map(toTx) });
      return signedDelegateActions;
    },
    async delegateSupport() {
      await connector.whenManifestLoaded.catch(() => undefined);
      const can = (w: { manifest: { features?: { signDelegateActions?: boolean } } }) => w.manifest.features?.signDelegateActions === true;
      const capable = connector.availableWallets.filter(can).map((w) => w.manifest.name);
      try {
        const { wallet } = await connector.getConnectedWallet();
        return { wallet: wallet.manifest.name, supported: can(wallet), capable };
      } catch {
        return { wallet: null, supported: false, capable };
      }
    },
    onAccountChange(cb) {
      const onIn = (e: { accounts: Array<{ accountId: string }> }) => cb(firstAccount(e.accounts));
      const onOut = () => cb(null);
      connector.on("wallet:signIn", onIn);
      connector.on("wallet:signOut", onOut);
      return () => {
        connector.off("wallet:signIn", onIn);
        connector.off("wallet:signOut", onOut);
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared connection state, for useWallet()

export type WalletState = { status: "idle" | "restoring" | "connecting" | "connected"; account: AccountId | null };

let state: WalletState = { status: "idle", account: null };
const listeners = new Set<() => void>();
let unsubscribeDriver: (() => void) | null = null;

function setState(next: WalletState): void {
  if (next.status === state.status && next.account === state.account) return;
  state = next;
  for (const l of listeners) l();
}

export function walletState(): WalletState {
  return state;
}

export function subscribeWallet(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function watch(d: WalletDriver): void {
  if (unsubscribeDriver) return;
  unsubscribeDriver = d.onAccountChange((account) => setState({ status: account ? "connected" : "idle", account }));
}

/** Restores a connection the wallet already shared, without a prompt. Safe to call on every page load. */
export async function restoreWallet(): Promise<AccountId | null> {
  if (!walletAvailable()) return null;
  if (state.status === "idle") setState({ status: "restoring", account: null });
  try {
    const d = await driver();
    watch(d);
    const account = await d.account();
    setState({ status: account ? "connected" : "idle", account });
    return account;
  } catch {
    setState({ status: "idle", account: null });
    return null;
  }
}

export async function connectWallet(expected?: AccountId): Promise<AccountId> {
  setState({ status: "connecting", account: state.account });
  try {
    const d = await driver();
    watch(d);
    const account = await d.connect(expected);
    setState({ status: "connected", account });
    return account;
  } catch (e) {
    setState({ status: state.account ? "connected" : "idle", account: state.account });
    throw toWalletError(e);
  }
}

export async function disconnectWallet(): Promise<void> {
  try {
    const d = await driver();
    await d.disconnect();
  } catch (e) {
    const err = toWalletError(e);
    // Already signed out is the state the person asked for.
    if (err.kind !== "not_connected") throw err;
  } finally {
    setState({ status: "idle", account: null });
  }
}

/** The account the wallet already shared with this site, without prompting. */
export async function connectedAccount(): Promise<AccountId | null> {
  return restoreWallet();
}

/**
 * Connects first when needed and returns the account that will sign. With `expected`, any other account is refused
 * before a transaction is built, so an owner action is never signed by the wrong account.
 */
export async function ensureConnected(expected?: AccountId): Promise<AccountId> {
  let account = state.status === "connected" && state.account ? state.account : (await restoreWallet()) ?? (await connectWallet(expected));
  // Another account is connected: open the wallet once more so the person can pick the right one.
  if (expected && account !== expected) account = await connectWallet(expected);
  if (expected && account !== expected) {
    throw new WalletError("wrong_account", `This needs ${expected}, and your wallet is connected as ${account}. Switch accounts in your wallet, then try again.`);
  }
  return account;
}

// ---------------------------------------------------------------------------------------------------------------------
// Signing and sending

/**
 * Where a sent transaction ended: `final` once NEAR executed it, `failed` with the reason, or `pending` when someone
 * else sent it (a relayer) and NEAR has not reported it final yet.
 */
export type TxResult =
  | { hash: TxHash; status: "final" }
  | { hash: TxHash; status: "failed"; error: string }
  /** `unknown`: whoever sent it could not say how it ended, so the thing it changes must be checked before any retry. */
  | { hash: TxHash; status: "pending"; unknown?: boolean };

function decodeSuccessValue(v: string | undefined): string | null {
  if (v === undefined) return null;
  try {
    return typeof atob === "function" ? atob(v) : Buffer.from(v, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function failureText(f: unknown): string {
  const text = JSON.stringify(f ?? "");
  const panic = /"(?:ExecutionError|PanicMsg|panic_msg|FunctionCallError)"\s*:\s*"([^"]+)"/.exec(text);
  return panic?.[1] ?? "The transaction failed on NEAR.";
}

/**
 * Reads an outcome against the transaction that produced it. A plain Failure fails it. An `ft_transfer_call` is final
 * only when the receiver kept the whole amount: the hub returns funds it refuses (unknown Budget, wrong amount, expired
 * checkout terms) and the token then reports the used amount, which is less than what was sent.
 */
export function readOutcome(tx: WalletTx, outcome: ExecutionOutcome): TxResult {
  const hash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "";
  const status = outcome.status;
  if (status && typeof status === "object" && "Failure" in status && status.Failure !== undefined) return { hash, status: "failed", error: failureText(status.Failure) };
  if (typeof status === "string" && status !== "SuccessValue") return { hash, status: "failed", error: `NEAR reported ${status}.` };
  const call = tx.actions.find((a) => a.params.methodName === "ft_transfer_call");
  if (call && status && typeof status === "object") {
    const sent = BigInt(String(call.params.args.amount ?? "0"));
    const raw = decodeSuccessValue(status.SuccessValue);
    let used: bigint | null = null;
    try {
      used = raw === null ? null : BigInt(JSON.parse(raw) as string);
    } catch {
      used = null;
    }
    if (used !== null && used < sent) {
      const inner = outcome.receipts_outcome?.map((r) => r.outcome?.status).find((s) => s && typeof s === "object" && s.Failure !== undefined);
      const why = inner && typeof inner === "object" ? failureText(inner.Failure) : "The hub did not accept the transfer.";
      return { hash, status: "failed", error: `${why} The tokens were returned to your wallet.` };
    }
  }
  return { hash, status: "final" };
}

export async function signAndSendTransaction(tx: WalletTx): Promise<TxResult> {
  try {
    const d = await driver();
    return readOutcome(tx, await d.signAndSendTransaction(tx));
  } catch (e) {
    throw toWalletError(e);
  }
}

/**
 * Sends several transactions in order with one wallet approval, for flows such as open_budget followed by the first
 * deposit. A wallet that stops part way returns fewer outcomes; the missing ones are reported as not sent.
 */
export async function signAndSendTransactions(txs: readonly WalletTx[]): Promise<TxResult[]> {
  try {
    const d = await driver();
    const outcomes = await d.signAndSendTransactions(txs);
    return txs.map((tx, i) => {
      const o = outcomes[i];
      return o ? readOutcome(tx, o) : { hash: "", status: "failed", error: "This transaction was not sent, because an earlier one stopped." };
    });
  } catch (e) {
    throw toWalletError(e);
  }
}

/** "Meteor Wallet, Intear Wallet, Ledger or NEAR CLI". */
function anyOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Why the connected wallet cannot sign a gasless action, and which wallets can. Null when it can, or none is connected. */
export function delegateUnsupportedText(s: DelegateSupport): string | null {
  if (!s.wallet || s.supported) return null;
  const capable = s.capable.length > 0 ? s.capable : WALLET_NETWORK === "testnet" ? DELEGATE_WALLETS_TESTNET : [];
  const others = capable.filter((n) => n !== s.wallet);
  return `${s.wallet} cannot sign an action for a relayer to send.${others.length > 0 ? ` Connect ${anyOf(others)} to do this without gas.` : ""}`;
}

/** Whether the connected wallet can sign delegate actions. Never prompts; reports "no wallet" rather than failing. */
export async function delegateSupport(): Promise<DelegateSupport> {
  try {
    const d = await driver();
    return await d.delegateSupport();
  } catch {
    return { wallet: null, supported: false, capable: [] };
  }
}

/**
 * Has the wallet sign NEP-366 delegate actions (meta transactions) and returns them as base64 Borsh
 * `SignedDelegateAction`s. Nothing is sent: a relayer wraps each one in its own transaction and pays the gas. A wallet
 * that cannot do this is refused before it is asked.
 */
export async function signDelegateActions(delegates: readonly WalletTx[]): Promise<string[]> {
  let signed: string[];
  try {
    const d = await driver();
    const support = await d.delegateSupport();
    const why = delegateUnsupportedText(support);
    if (why) throw new WalletError("unsupported", why);
    signed = await d.signDelegateActions(delegates);
  } catch (e) {
    throw toWalletError(e);
  }
  if (!Array.isArray(signed) || signed.length !== delegates.length || signed.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new WalletError("failed", "Your wallet did not return a signed action for each request. Nothing was sent.");
  }
  return signed;
}

/** A NEP-413 signed message plus everything a verifier needs to repeat the check. */
export type Nep413Proof = SignedMessage & { message: string; recipient: string; nonce: string };

const toBase64 = (b: Uint8Array): string => (typeof btoa === "function" ? btoa(String.fromCharCode(...b)) : Buffer.from(b).toString("base64"));

/**
 * Signs `message` for `recipient` with NEP-413, with a fresh random nonce unless the protocol fixes one (the payout
 * proof derives it from the message). When `expected` is given, a signature from another account is refused here,
 * before anything is sent to the node.
 */
export async function signMessage(message: string, recipient: string, expected?: AccountId, fixedNonce?: Uint8Array): Promise<Nep413Proof> {
  const nonce = fixedNonce ?? crypto.getRandomValues(new Uint8Array(32));
  if (nonce.length !== 32) throw new WalletError("failed", "A NEP-413 nonce must be 32 bytes.");
  let signed: SignedMessage;
  try {
    const d = await driver();
    signed = await d.signMessage({ message, recipient, nonce });
  } catch (e) {
    throw toWalletError(e);
  }
  if (expected && signed.accountId !== expected) {
    throw new WalletError("wrong_account", `Your wallet signed as ${signed.accountId}. Connect ${expected} and sign again.`);
  }
  return { ...signed, message, recipient, nonce: toBase64(nonce) };
}
