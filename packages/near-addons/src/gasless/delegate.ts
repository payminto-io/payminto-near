import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  isAccountId,
  payoutTx,
  publicKeyBytes,
  publicKeyToString,
  reclaimTx,
  revokeBudgetTx,
  type AccountId,
  type FunctionCallAction,
  type Id32,
  type PublicKey,
} from "@payminto/chain";
import type { ViewRpc } from "../rpc.ts";
import { BorshReader, BorshWriter } from "./borsh.ts";

/**
 * NEP-366 meta transactions, as nearcore encodes them (`core/primitives/src/action/delegate.rs`):
 *
 *   DelegateAction { sender_id: String, receiver_id: String, actions: Vec<NonDelegateAction>, nonce: u64,
 *                    max_block_height: u64, public_key: PublicKey }
 *   SignedDelegateAction { delegate_action: DelegateAction, signature: Signature }
 *
 * `NonDelegateAction` is an `Action` without the Delegate variants, so each action is its `Action` Borsh with the enum
 * index first: CreateAccount = 0, FunctionCall = 2 { method_name: String, args: Vec<u8>, gas: u64, deposit: u128 },
 * Delegate = 8. `PublicKey` and `Signature` are a key-type byte (ED25519 = 0) then 32 or 64 bytes.
 *
 * The user signs sha256 of the NEP-461 signable message: the u32 discriminant 2^30 + 366 followed by the DelegateAction
 * Borsh (`signable_message.rs`, `get_nep461_hash`). This is version 1 (`Action::Delegate`); `Action::DelegateV2` (index
 * 14, NEP-611 gas keys) uses a different tag and is not built here.
 */
export const NEP_366 = 366;
export const DELEGATE_ACTION_PREFIX = 2 ** 30 + NEP_366; // 1073742190
export const ACTION_CREATE_ACCOUNT = 0;
export const ACTION_FUNCTION_CALL = 2;
export const ACTION_DELEGATE = 8;
const ED25519 = 0;

export type DelegateFunctionCall = { type: "FunctionCall"; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
/** Only the action kinds this module needs: function calls, and CreateAccount for nearcore's own test vector. */
export type DelegateInnerAction = DelegateFunctionCall | { type: "CreateAccount" };

export type DelegateAction = {
  senderId: AccountId;
  receiverId: AccountId;
  actions: DelegateInnerAction[];
  /** Must be greater than the current nonce of `publicKey` on `senderId`. */
  nonce: bigint;
  /** The delegate is valid only while the chain is below this height. */
  maxBlockHeight: bigint;
  publicKey: PublicKey;
};

export type SignedDelegate = { delegateAction: DelegateAction; signature: Uint8Array };

/** Converts wallet function-call actions from `@payminto/chain` into delegate actions with JSON args bytes. */
export function fromWalletActions(actions: readonly FunctionCallAction[]): DelegateFunctionCall[] {
  return actions.map((a) => ({
    type: "FunctionCall",
    methodName: a.params.methodName,
    args: new TextEncoder().encode(JSON.stringify(a.params.args)),
    gas: BigInt(a.params.gas),
    deposit: BigInt(a.params.deposit),
  }));
}

function writeAction(w: BorshWriter, a: DelegateInnerAction): void {
  if (a.type === "CreateAccount") {
    w.u8(ACTION_CREATE_ACCOUNT);
    return;
  }
  w.u8(ACTION_FUNCTION_CALL).string(a.methodName).bytes(a.args).u64(a.gas).u128(a.deposit);
}

function writeDelegate(w: BorshWriter, d: DelegateAction): void {
  if (!isAccountId(d.senderId) || !isAccountId(d.receiverId)) throw new Error("sender and receiver must be NEAR account ids");
  w.string(d.senderId).string(d.receiverId).u32(d.actions.length);
  for (const a of d.actions) writeAction(w, a);
  w.u64(d.nonce).u64(d.maxBlockHeight).u8(ED25519).fixed(publicKeyBytes(d.publicKey), 32);
}

/** Borsh of the DelegateAction alone. */
export function encodeDelegateAction(d: DelegateAction): Uint8Array {
  const w = new BorshWriter();
  writeDelegate(w, d);
  return w.done();
}

/** The NEP-461 signable message: the u32 tag 2^30 + 366, then the DelegateAction Borsh. */
export function delegateSigningPayload(d: DelegateAction): Uint8Array {
  const w = new BorshWriter().u32(DELEGATE_ACTION_PREFIX);
  writeDelegate(w, d);
  return w.done();
}

/** The 32 bytes the user's key signs. */
export const delegateHash = (d: DelegateAction): Uint8Array => sha256(delegateSigningPayload(d));

/**
 * Signs a delegate with a 32-byte ed25519 seed. For tests and for owners who keep their key in Node; a browser wallet
 * signs delegates itself. Refuses a key that is not the delegate's `publicKey`.
 */
export function signDelegate(d: DelegateAction, seed: Uint8Array): SignedDelegate {
  if (publicKeyToString(ed25519.getPublicKey(seed)) !== d.publicKey) throw new Error("the seed does not match the delegate's public key");
  return { delegateAction: d, signature: ed25519.sign(delegateHash(d), seed) };
}

/** Checks the signature against the delegate's own `publicKey`, as the runtime does. Never throws. */
export function verifySignedDelegate(s: SignedDelegate): boolean {
  try {
    return s.signature.length === 64 && ed25519.verify(s.signature, delegateHash(s.delegateAction), publicKeyBytes(s.delegateAction.publicKey));
  } catch {
    return false;
  }
}

/** Borsh of SignedDelegateAction. This is what a client sends to a relayer, base64-encoded. */
export function encodeSignedDelegate(s: SignedDelegate): Uint8Array {
  const w = new BorshWriter();
  writeDelegate(w, s.delegateAction);
  w.u8(ED25519).fixed(s.signature, 64);
  return w.done();
}

/** Borsh of `Action::Delegate(SignedDelegateAction)`: the one action in the relayer's outer transaction. */
export function encodeDelegateTxAction(s: SignedDelegate): Uint8Array {
  const inner = encodeSignedDelegate(s);
  const out = new Uint8Array(inner.length + 1);
  out[0] = ACTION_DELEGATE;
  out.set(inner, 1);
  return out;
}

function readKeyType(r: BorshReader): void {
  const t = r.u8();
  if (t !== ED25519) throw new Error(`unsupported key type ${t}; only ed25519 delegates are accepted`);
}

/** Parses a SignedDelegateAction, as a relayer receives it. Throws on any action kind other than FunctionCall or CreateAccount. */
export function decodeSignedDelegate(bytes: Uint8Array): SignedDelegate {
  const r = new BorshReader(bytes);
  const senderId = r.string();
  const receiverId = r.string();
  const n = r.u32();
  if (n > 100) throw new Error("too many actions");
  const actions: DelegateInnerAction[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    if (kind === ACTION_CREATE_ACCOUNT) actions.push({ type: "CreateAccount" });
    else if (kind === ACTION_FUNCTION_CALL) actions.push({ type: "FunctionCall", methodName: r.string(), args: r.bytes(), gas: r.u64(), deposit: r.u128() });
    else throw new Error(`unsupported inner action ${kind}`);
  }
  const nonce = r.u64();
  const maxBlockHeight = r.u64();
  readKeyType(r);
  const publicKey = publicKeyToString(r.fixed(32));
  readKeyType(r);
  const signature = r.fixed(64);
  r.end();
  return { delegateAction: { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey }, signature };
}

/** The JSON body the relayer in the NEAR docs tutorial accepts on `/relay`. */
export const relayRequestBody = (s: SignedDelegate): { signedDelegate: string } => ({ signedDelegate: Buffer.from(encodeSignedDelegate(s)).toString("base64") });

export type DelegateParams = { nonce: bigint; maxBlockHeight: bigint };

/** Reads the key's nonce and the final height read-only, and returns the next nonce and a short validity window. */
export async function delegateParams(rpc: ViewRpc, account: AccountId, publicKey: PublicKey, ttlBlocks = 120n): Promise<DelegateParams> {
  const key = await rpc.accessKey(account, publicKey);
  if (!key) throw new Error(`${publicKey} is not an access key of ${account}`);
  const height = await rpc.finalHeight();
  return { nonce: key.nonce + 1n, maxBlockHeight: height + ttlBlocks };
}

type HubDelegate = { owner: AccountId; hub: AccountId; publicKey: PublicKey } & DelegateParams;

/** A gasless `revoke_budget`: the owner signs it, a relayer pays the gas. The call needs no deposit. */
export const revokeBudgetDelegate = (p: HubDelegate & { budgetId: Id32 }): DelegateAction => ({
  senderId: p.owner,
  receiverId: p.hub,
  actions: fromWalletActions(revokeBudgetTx(p.hub, p.budgetId).actions),
  nonce: p.nonce,
  maxBlockHeight: p.maxBlockHeight,
  publicKey: p.publicKey,
});

/** A gasless `reclaim` after the settlement deadline. */
export const reclaimDelegate = (p: HubDelegate & { budgetId: Id32 }): DelegateAction => ({
  senderId: p.owner,
  receiverId: p.hub,
  actions: fromWalletActions(reclaimTx(p.hub, p.budgetId).actions),
  nonce: p.nonce,
  maxBlockHeight: p.maxBlockHeight,
  publicKey: p.publicKey,
});

/** A gasless `payout` for a payee with no NEAR. */
export const payoutDelegate = (p: HubDelegate & { accounts: AccountId[] }): DelegateAction => ({
  senderId: p.owner,
  receiverId: p.hub,
  actions: fromWalletActions(payoutTx(p.hub, p.accounts).actions),
  nonce: p.nonce,
  maxBlockHeight: p.maxBlockHeight,
  publicKey: p.publicKey,
});

export type RelayPolicy = {
  /** The only receiver the relayer sponsors: our own hub. */
  hub: AccountId;
  /** Zero-deposit hub methods the relayer pays for. */
  methods: readonly string[];
  maxGasPerAction: bigint;
  /** How far past the current height a delegate may stay valid. */
  maxTtlBlocks: bigint;
};

/** Revoke, reclaim and payout: the zero-deposit calls an owner or payee without NEAR needs. */
export const DEFAULT_RELAY_METHODS = ["revoke_budget", "reclaim", "payout"] as const;

/**
 * What a relayer checks before wrapping a delegate in its own transaction. It sponsors only signed, unexpired,
 * zero-deposit calls to its own hub. Returns the reasons to refuse; empty means relay.
 */
export function checkRelayPolicy(s: SignedDelegate, policy: RelayPolicy, currentHeight: bigint): string[] {
  const d = s.delegateAction;
  const problems: string[] = [];
  if (!verifySignedDelegate(s)) problems.push("signature does not verify against the delegate's public key");
  if (d.receiverId !== policy.hub) problems.push(`receiver ${d.receiverId} is not the hub ${policy.hub}`);
  if (d.senderId === policy.hub) problems.push("the hub itself cannot be a sender");
  if (d.actions.length === 0) problems.push("no actions");
  for (const a of d.actions) {
    if (a.type !== "FunctionCall") {
      problems.push(`${a.type} is not sponsored`);
      continue;
    }
    if (!policy.methods.includes(a.methodName)) problems.push(`${a.methodName} is not sponsored`);
    if (a.deposit !== 0n) problems.push(`${a.methodName} attaches ${a.deposit} yoctoNEAR; only zero-deposit calls are sponsored`);
    if (a.gas > policy.maxGasPerAction) problems.push(`${a.methodName} asks for ${a.gas} gas, above ${policy.maxGasPerAction}`);
  }
  if (d.maxBlockHeight <= currentHeight) problems.push("expired: max_block_height is not above the current height");
  if (d.maxBlockHeight > currentHeight + policy.maxTtlBlocks) problems.push("max_block_height is too far ahead");
  return problems;
}
