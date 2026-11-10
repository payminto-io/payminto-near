import type { AccountId } from "@payminto/chain";
import { gasless } from "@payminto/near-addons";
import { decodeSignedDelegateAction } from "near-kit";
import type { SenderKey } from "./chain.ts";
import { TGAS } from "./config.ts";
import { badSignature, expired, malformed, nonceUsed, notSponsored, RelayError } from "./errors.ts";

/**
 * What the relayer pays for. Everything else is refused before anything is signed: the policy fails closed, so a
 * delegate this module does not fully understand is never relayed.
 */
export type RelayPolicy = {
  hub: AccountId;
  relayer: AccountId;
  methods: readonly string[];
  /** Upper bound on the gas of one delegate, summed over its actions. */
  maxGas: bigint;
  maxTtlBlocks: bigint;
  expiryMarginBlocks: bigint;
};

export type ParsedDelegate = {
  /** The exact Borsh bytes the client sent. These, and nothing re-encoded, are what gets wrapped. */
  bytes: Uint8Array;
  signed: gasless.SignedDelegate;
};

export type SponsoredCall = ParsedDelegate & {
  sender: AccountId;
  receiver: AccountId;
  /** Method names in the order the delegate calls them. */
  methods: string[];
  totalGas: bigint;
};

/** NEAR refuses an access-key nonce above `height * 1_000_000`. */
const NONCE_RANGE_MULTIPLIER = 1_000_000n;

const tgas = (gas: bigint): string => {
  const whole = gas / TGAS;
  const rest = gas % TGAS;
  return rest === 0n ? `${whole}` : `${whole}.${rest.toString().padStart(12, "0").replace(/0+$/, "")}`;
};

const SIGN_HINT = "Build the delegate with gasless.revokeBudgetDelegate (or reclaimDelegate, payoutDelegate) from @payminto/near-addons, sign it, and send relayRequestBody(signed).";

/**
 * Reads the `signedDelegate` field of a `/relay` body into a delegate. Throws `MALFORMED` when it is not a Borsh
 * `SignedDelegateAction`, and `NOT_SPONSORED` when it is one that carries something other than ed25519-signed function calls.
 */
export function parseSignedDelegate(value: unknown): ParsedDelegate {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(`signedDelegate must be a base64 string holding the Borsh SignedDelegateAction. ${SIGN_HINT}`);
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw malformed("signedDelegate is not standard base64 (A-Z, a-z, 0-9, + and /, padded with =). Encode the Borsh SignedDelegateAction bytes with standard base64 and send it again.");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    throw malformed("signedDelegate is not canonical base64. Encode the Borsh SignedDelegateAction bytes with standard base64 and send it again.");
  }
  try {
    return { bytes, signed: gasless.decodeSignedDelegate(bytes) };
  } catch (err) {
    const refusal = unsupportedDelegate(bytes);
    if (refusal) throw refusal;
    const why = err instanceof Error ? err.message : "decode failed";
    throw malformed(`signedDelegate is not a Borsh SignedDelegateAction (${why}). ${SIGN_HINT}`);
  }
}

/**
 * A second, independent decoder (near-kit) tells a well-formed delegate we do not sponsor from bytes that are no
 * delegate at all. Either way nothing is relayed; only the error code differs.
 */
function unsupportedDelegate(bytes: Uint8Array): RelayError | null {
  let kinds: string[];
  let keyKind: string;
  try {
    const d = decodeSignedDelegateAction(bytes).signedDelegate.delegateAction;
    kinds = d.actions.map((a) => Object.keys(a)[0] ?? "unknown");
    keyKind = Object.keys(d.publicKey)[0] ?? "unknown";
  } catch {
    return null;
  }
  const other = [...new Set(kinds.filter((k) => k !== "functionCall"))];
  if (other.length > 0) {
    return notSponsored(
      `this delegate contains ${other.join(", ")} action(s); the relayer only pays for zero-deposit function calls to the hub. Remove every other action and sign again, or send this transaction with your own gas.`,
    );
  }
  if (keyKind !== "ed25519Key") {
    return notSponsored("this delegate is signed with a key that is not ed25519; the relayer only accepts ed25519 keys. Sign with an ed25519 access key of the account.");
  }
  return null;
}

/**
 * The rules that need no chain read: who is called, what is called, with how much gas and deposit, and that the
 * signature belongs to the key the delegate names. Throws `NOT_SPONSORED` or `BAD_SIGNATURE`.
 */
export function checkSponsored(parsed: ParsedDelegate, policy: RelayPolicy): SponsoredCall {
  const d = parsed.signed.delegateAction;
  const sponsoredList = `Sponsored methods: ${policy.methods.join(", ")} (see GET /info).`;

  if (d.receiverId !== policy.hub) {
    throw notSponsored(
      `receiver ${d.receiverId} is not the hub ${policy.hub}; this relayer only pays for calls to ${policy.hub}. Send this call with your own gas, or sign a delegate whose receiver is ${policy.hub}.`,
    );
  }
  if (d.senderId === policy.hub || d.senderId === policy.relayer) {
    throw notSponsored(`sender ${d.senderId} is the hub or the relayer itself; the relayer only pays for calls signed by other accounts. Sign the delegate with the owner's account.`);
  }
  if (d.actions.length === 0) {
    throw notSponsored(`this delegate has no actions; there is nothing to relay. Sign a delegate with one function call. ${sponsoredList}`);
  }

  const methods: string[] = [];
  let totalGas = 0n;
  for (const a of d.actions) {
    if (a.type !== "FunctionCall") {
      throw notSponsored(`this delegate contains a ${a.type} action; the relayer only pays for zero-deposit function calls to the hub. Remove it and sign again, or send this transaction with your own gas.`);
    }
    if (!policy.methods.includes(a.methodName)) {
      throw notSponsored(`method ${JSON.stringify(a.methodName.slice(0, 64))} is not sponsored. ${sponsoredList} Send this call with your own gas.`);
    }
    if (a.deposit !== 0n) {
      throw notSponsored(`${a.methodName} attaches ${a.deposit} yoctoNEAR; the relayer only pays for calls with no deposit. Sign the call again with deposit 0.`);
    }
    if (a.gas === 0n) {
      throw notSponsored(`${a.methodName} attaches no gas, so it cannot run. Sign the call again with gas (30 Tgas is enough for a revoke).`);
    }
    methods.push(a.methodName);
    totalGas += a.gas;
  }
  if (totalGas > policy.maxGas) {
    throw notSponsored(`this delegate attaches ${tgas(totalGas)} Tgas in total, above the limit of ${tgas(policy.maxGas)} Tgas (maxGasTgas in GET /info). Sign it again with less gas or fewer calls.`);
  }

  if (!gasless.verifySignedDelegate(parsed.signed)) {
    throw badSignature(`the signature does not verify against the public key ${d.publicKey} in the delegate. Sign the exact delegate again with that key and send the new signedDelegate.`);
  }
  return { ...parsed, sender: d.senderId, receiver: d.receiverId, methods, totalGas };
}

/**
 * The rules that need the chain: the validity window, that the signing key is on the sender's account and may make
 * this call, and that the nonce is still unused. A delegate that fails here would fail on chain after the relayer paid
 * for it. Throws `EXPIRED`, `NOT_SPONSORED`, `BAD_SIGNATURE` or `NONCE_USED`.
 */
export function checkAgainstChain(call: SponsoredCall, policy: RelayPolicy, chain: { height: bigint; key: SenderKey | null }): void {
  const d = call.signed.delegateAction;
  const { height, key } = chain;

  if (d.maxBlockHeight <= height) {
    throw expired(`this delegate expired: its max_block_height ${d.maxBlockHeight} is not above the current height ${height}. Build a new delegate with a fresh height, sign it and send it again.`);
  }
  if (d.maxBlockHeight <= height + policy.expiryMarginBlocks) {
    throw expired(
      `this delegate expires in ${d.maxBlockHeight - height} block(s), too soon to land (it needs more than ${policy.expiryMarginBlocks}). Build a new delegate with a later max_block_height, sign it and send it again.`,
    );
  }
  if (d.maxBlockHeight > height + policy.maxTtlBlocks) {
    throw notSponsored(
      `max_block_height ${d.maxBlockHeight} is more than ${policy.maxTtlBlocks} blocks above the current height ${height}. Sign a delegate that expires within ${policy.maxTtlBlocks} blocks (120 is a good window).`,
    );
  }

  if (key === null) {
    throw badSignature(`${d.publicKey} is not an access key of ${d.senderId}, so the network would refuse this delegate. Sign it with an access key that is on ${d.senderId} today.`);
  }
  const p = key.permission;
  if (p.kind === "other") {
    throw badSignature(`${d.publicKey} is a ${p.name} key, which this relayer does not accept. Sign with a full-access key or a function-call key for ${policy.hub}.`);
  }
  if (p.kind === "function_call") {
    // NEP-366: a delegate signed by a function-call key holds exactly one call, to that key's receiver, with a method the key allows.
    if (p.receiverId !== policy.hub) {
      throw badSignature(`${d.publicKey} is a function-call key for ${p.receiverId}, not for ${policy.hub}. Sign with a full-access key or a function-call key for ${policy.hub}.`);
    }
    if (d.actions.length !== 1) {
      throw badSignature(`${d.publicKey} is a function-call key, which may sign a delegate with exactly one call; this one has ${d.actions.length}. Send one call per delegate, or sign with a full-access key.`);
    }
    const method = call.methods[0]!;
    if (p.methodNames.length > 0 && !p.methodNames.includes(method)) {
      throw badSignature(`${d.publicKey} is a function-call key that may not call ${method}. Sign with a full-access key or a key that allows ${method}.`);
    }
  }

  if (d.nonce <= key.nonce) {
    throw nonceUsed(`nonce ${d.nonce} is already used: the key's nonce on chain is ${key.nonce}. Check whether an earlier request with this delegate already landed. If it did not, build a new delegate with nonce ${key.nonce + 1n} and sign it.`);
  }
  if (d.nonce > height * NONCE_RANGE_MULTIPLIER) {
    throw notSponsored(`nonce ${d.nonce} is too large for the network to accept. Build a new delegate with nonce ${key.nonce + 1n} and sign it.`);
  }

  // The add-on's own policy, verified against nearcore vectors, has the last word. Anything it still objects to is refused.
  const problems = gasless.checkRelayPolicy(call.signed, { hub: policy.hub, methods: policy.methods, maxGasPerAction: policy.maxGas, maxTtlBlocks: policy.maxTtlBlocks }, height);
  if (problems.length > 0) {
    throw notSponsored(`this delegate is not sponsored: ${problems.join("; ")}. Send it with your own gas, or sign a zero-deposit call to ${policy.hub}.`);
  }
}
