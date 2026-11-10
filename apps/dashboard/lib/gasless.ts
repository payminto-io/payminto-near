/**
 * Gasless owner actions (NEP-366 meta transactions): the owner's wallet signs a delegate action for a zero-deposit hub
 * call, and the relayer wraps it in its own transaction and pays the gas. The hub still sees the owner as the caller.
 *
 * NEAR Connect lets the wallet choose the access key, its next nonce and the expiry height, so this module cannot set
 * them. It checks them instead: the signed action is decoded with the add-on, compared with the call that was shown,
 * and its key, nonce and expiry are read from NEAR before anything is posted to the relayer. Afterwards the hub is
 * read for the effect, so neither the relayer's word nor the outer transaction's status is what says "revoked".
 *
 * The add-on package is imported on first use, so a dashboard that never sends a gasless action never loads it.
 */
import { canonicalJson, hubErrorOf, type AccountId, type Id32, type Network, type WalletTx } from "@payminto/protocol";
import { FlowError, signDelegateActions, toWalletError, type TxResult } from "./wallet";
import { READ_TIMEOUT_MS, type ReaderSource } from "./near-reader";
import { RelayError, relayErrorText, relayRefusal, type RelayerClient, type RelayerInfo } from "./relayer";

type Addons = typeof import("@payminto/near-addons");
type Gasless = Addons["gasless"];
type SignedDelegate = ReturnType<Gasless["decodeSignedDelegate"]>;

export const loadAddons = (): Promise<Addons> => import("@payminto/near-addons");

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * Decodes what the wallet signed and compares it with the call the person reviewed. Returns the reasons to refuse;
 * empty means the signed action is exactly that call, from that owner, with no deposit and a valid signature.
 */
export function auditSignedDelegate(g: Gasless, signedBase64: string, want: { owner: AccountId; tx: WalletTx }): { signed: SignedDelegate | null; problems: string[] } {
  let signed: SignedDelegate;
  try {
    signed = g.decodeSignedDelegate(base64ToBytes(signedBase64));
  } catch {
    return { signed: null, problems: ["it is not a signed delegate action"] };
  }
  const d = signed.delegateAction;
  const problems: string[] = [];
  if (d.senderId !== want.owner) problems.push(`it is from ${d.senderId}, not ${want.owner}`);
  if (d.receiverId !== want.tx.receiverId) problems.push(`it calls ${d.receiverId}, not ${want.tx.receiverId}`);
  if (d.actions.length !== want.tx.actions.length) problems.push(`it holds ${d.actions.length} actions, not ${want.tx.actions.length}`);
  want.tx.actions.forEach((expected, i) => {
    const a = d.actions[i];
    if (!a) return;
    if (a.type !== "FunctionCall") {
      problems.push(`action ${i + 1} is ${a.type}, not a function call`);
      return;
    }
    if (a.methodName !== expected.params.methodName) problems.push(`it calls ${a.methodName}, not ${expected.params.methodName}`);
    let args: unknown;
    try {
      args = JSON.parse(new TextDecoder().decode(a.args));
    } catch {
      args = undefined;
    }
    if (args === undefined || !sameJson(args, expected.params.args)) problems.push("its arguments differ from the ones shown");
    if (a.deposit !== 0n) problems.push("it attaches a deposit");
    if (a.gas !== BigInt(expected.params.gas)) problems.push("its gas limit differs from the one shown");
  });
  if (!g.verifySignedDelegate(signed)) problems.push("its signature does not verify");
  return { signed, problems };
}

/** The reads the on-chain check needs; the add-on's `ViewRpc` provides them and cannot send. */
export type KeyReader = {
  accessKey(account: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown } | null>;
  finalHeight(): Promise<bigint>;
};

/**
 * Reads the signing key and the final block height from NEAR and says why the relayer's transaction would fail, or
 * null when it would not: the key must be on the owner's account and able to call the hub, the nonce must be unused,
 * and the signature must not have expired.
 */
export async function delegateChainProblem(rpc: KeyReader, signed: SignedDelegate, hub: AccountId): Promise<string | null> {
  const d = signed.delegateAction;
  const [key, height] = await Promise.all([rpc.accessKey(d.senderId, d.publicKey), rpc.finalHeight()]);
  if (!key) return `Your wallet signed with a key that is not on ${d.senderId}, so NEAR would refuse it. Reconnect your wallet and sign again.`;
  const fc = key.permission && typeof key.permission === "object" && "FunctionCall" in key.permission ? (key.permission as { FunctionCall: { receiver_id?: string; method_names?: string[] } }).FunctionCall : null;
  if (fc) {
    const methods = fc.method_names ?? [];
    const blocked = fc.receiver_id !== hub || d.actions.some((a) => a.type !== "FunctionCall" || (methods.length > 0 && !methods.includes(a.methodName)));
    if (blocked) return "Your wallet signed with a limited key that may not make this call on the hub. Connect the wallet with its full-access key and sign again.";
  }
  if (d.nonce <= key.nonce) return "The signature reuses a key nonce NEAR has already seen, so it would be refused. Sign again.";
  if (d.maxBlockHeight <= height) return "The signature has already expired. Sign again and it goes out at once.";
  return null;
}

/** A `ViewRpc` on the same RPC, and with the same per-request deadline, as the proofs on this page. */
function viewRpc(addons: Addons, source: ReaderSource): KeyReader {
  const f = source.fetch ?? globalThis.fetch.bind(globalThis);
  return new addons.ViewRpc(source.reader.rpcUrl, async (url, init) => {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    return { status: res.status, text: () => res.text() };
  });
}

/** One sentence for a key or block read that did not finish; never the RPC's raw error. */
function rpcProblemText(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "NEAR did not answer in time.";
  if (e instanceof TypeError) return "The NEAR RPC could not be reached.";
  return "The NEAR RPC answered with an error.";
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether the hub shows the effect of a call, read from NEAR by this page. The relayer's "done" is never taken on its
 * word, and NEAR reports a relayed transaction as a success even when the hub refused the call inside it, so the only
 * proof is the Budget itself.
 */
export type HubEffect = (source: ReaderSource) => Promise<boolean>;

type HubBudget = { revoked_at?: unknown; escrow?: unknown } | null;
const readBudget = async (source: ReaderSource, hub: AccountId, budgetId: Id32): Promise<HubBudget> => (await source.reader.view<HubBudget>(hub, "budget", { budget_id: budgetId })).value;

/** True once the hub records the Budget as revoked. */
export const revokedOnHub =
  (hub: AccountId, budgetId: Id32): HubEffect =>
  async (source) => {
    const b = await readBudget(source, hub, budgetId);
    return b !== null && b.revoked_at !== null && b.revoked_at !== undefined;
  };

/** True once the hub holds no escrow for the Budget. */
export const reclaimedOnHub =
  (hub: AccountId, budgetId: Id32): HubEffect =>
  async (source) => {
    const b = await readBudget(source, hub, budgetId);
    return b !== null && String(b.escrow) === "0";
  };

/**
 * Reads the hub until it shows the effect, for a short while. Final only when the hub shows it. Otherwise the result
 * is pending: `unknown` marks a transaction nobody could vouch for, so the screen asks for a check, not a retry.
 */
export async function confirmOnHub(source: ReaderSource, effect: HubEffect, hash: string, o: { tries?: number; intervalMs?: number; unknown?: boolean } = {}): Promise<TxResult> {
  const tries = o.tries ?? 5;
  const intervalMs = o.intervalMs ?? 1200;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await pause(intervalMs);
    try {
      if (await effect(source)) return { hash, status: "final" };
    } catch {
      // One read that did not finish proves nothing either way; the next try reads again.
    }
  }
  return o.unknown ? { hash, status: "pending", unknown: true } : { hash, status: "pending" };
}

/** The hub's refusal in words. `what` is "revoke" or "reclaim". */
export function hubRefusalText(what: string, message: string): string {
  const code = hubErrorOf(message);
  const why =
    code === "NOT_OWNER"
      ? "the signing account does not own this Budget"
      : code === "ALREADY_REVOKED"
        ? "the Budget is already revoked on the hub"
        : code === "TOO_EARLY"
          ? "the settlement grace period has not ended yet"
          : code === "UNKNOWN_BUDGET"
            ? "the hub has no Budget with this id"
            : code
              ? `the hub answered ${code}`
              : "the hub did not say why in a form this page knows";
  return `NEAR ran the relayer's transaction, and the hub refused the ${what}: ${why}. Nothing changed on the hub.`;
}

export type GaslessStep = { title: string; body: string; hash?: string; waiting?: string };

export type GaslessRequest = {
  /** The zero-deposit hub call, from the shared builders. */
  tx: WalletTx;
  owner: AccountId;
  node: { hub: AccountId; network: Network };
  client: RelayerClient;
  source: ReaderSource;
  /** How this page sees on the hub that the call took effect. */
  effect: HubEffect;
  /** "revoke" or "reclaim", for sentences. */
  what: string;
  progress: (step: GaslessStep) => void;
  /** Test seams. */
  addons?: () => Promise<Addons>;
  confirm?: { tries?: number; intervalMs?: number };
};

/**
 * One gasless action from review to the hub: check the relayer, have the wallet sign, verify what it signed, post it,
 * and read the hub for the effect. Throws a `FlowError` in plain words when nothing was sent; a cancel in the wallet
 * surfaces as the wallet's own rejection. Once a transaction exists the result carries its hash: final when the hub
 * shows the effect, failed when the hub refused the call, pending when it is not known yet.
 */
export async function sendGasless(r: GaslessRequest): Promise<TxResult> {
  r.progress({ title: "Checking the relayer", body: "Making sure it still sponsors this hub and this call before your wallet is asked.", waiting: "Checking the relayer" });
  let info: RelayerInfo;
  try {
    info = await r.client.info();
  } catch (e) {
    throw new FlowError(e instanceof RelayError ? relayErrorText(e) : "The relayer could not be checked. Nothing was sent.", { cause: e });
  }
  const refusal = relayRefusal(info, r.node, r.tx);
  if (refusal) throw new FlowError(`${refusal} Nothing was signed or sent.`);

  r.progress({ title: "Approve in your wallet", body: "Your wallet shows the same call. Signing it sends nothing and needs no NEAR; the relayer sends it." });
  let signedBase64: string | undefined;
  try {
    [signedBase64] = await signDelegateActions([r.tx]);
  } catch (e) {
    const err = toWalletError(e);
    if (err.kind === "unsupported") throw new FlowError(`${err.message} Nothing was sent. Or close this and use the button beside it, which sends from your own wallet and needs a little NEAR for gas.`, { cause: e });
    throw err;
  }
  if (!signedBase64) throw new FlowError("Your wallet returned no signed action. Nothing was sent.");

  const addons = await (r.addons ?? loadAddons)().catch((cause: unknown) => {
    throw new FlowError("The gasless add-on could not load, so the signed action was not checked or sent. Check your connection and try again.", { cause });
  });
  const audit = auditSignedDelegate(addons.gasless, signedBase64, { owner: r.owner, tx: r.tx });
  if (!audit.signed || audit.problems.length > 0) {
    throw new FlowError(`Your wallet signed something other than the call you reviewed: ${audit.problems.join("; ")}. Nothing was sent to the relayer.`);
  }
  r.progress({ title: "Checking the signature against NEAR", body: "Reading your key's nonce and the current block height, so the relayer is only asked to send something NEAR will accept.", waiting: "Checking the signature" });
  let problem: string | null;
  try {
    problem = await delegateChainProblem(viewRpc(addons, r.source), audit.signed, r.node.hub);
  } catch (e) {
    throw new FlowError(`The signed action could not be checked against NEAR. ${rpcProblemText(e)} Nothing was sent to the relayer; try again.`, { cause: e });
  }
  if (problem) throw new FlowError(`${problem} Nothing was sent to the relayer.`);

  r.progress({
    title: "The relayer is sending it",
    body: `${info.relayer} wraps your signed call in its own transaction, pays the gas and answers once NEAR has made it final. That is usually a few seconds and can take up to a minute. Keep this open.`,
    waiting: "Waiting for the relayer",
  });
  let hash: string;
  try {
    const receipt = await r.client.relay(signedBase64);
    if (receipt.sender !== r.owner || receipt.receiver !== r.node.hub) throw new RelayError("BAD_RESPONSE", "The relayer reported a transaction for another account or contract.", 200, { txHash: receipt.txHash, outcomeUnknown: true });
    hash = receipt.txHash;
  } catch (e) {
    if (!(e instanceof RelayError)) throw e;
    // The transaction ran and the hub said no: never shown as done. The hub's reason and the transaction are shown.
    if (e.code === "CALL_FAILED") return { hash: e.txHash ?? "", status: "failed", error: hubRefusalText(r.what, e.message) };
    // The relayer already submitted this very delegate: that transaction is the one to look at.
    const repeat = e.code === "NONCE_USED" && e.txHash !== null;
    // Something may have been sent and nobody knows how it ended: read the hub, and never offer a blind retry.
    const unknown = e.outcomeUnknown || e.code === "BAD_RESPONSE";
    if (repeat || unknown) {
      r.progress({ title: "Reading the Budget from the hub", body: "The relayer could not say how it ended, so this page reads the hub itself.", hash: e.txHash ?? undefined, waiting: "Reading the hub" });
      return confirmOnHub(r.source, r.effect, e.txHash ?? "", { ...r.confirm, unknown: true });
    }
    throw new FlowError(relayErrorText(e), { cause: e });
  }

  r.progress({ title: "Confirming on the hub", body: "The relayer reports the transaction final. This page reads the Budget from the hub to see it for itself.", hash, waiting: "Reading the hub" });
  return confirmOnHub(r.source, r.effect, hash, r.confirm);
}
