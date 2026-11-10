import { serialize, type Schema } from "borsh";
import { assertAccountId, compareAscii, id32Bytes, publicKeyBytes } from "./bytes.ts";
import { ACCEPTANCE_DOMAIN, BUDGET_DOMAIN, CALL_DOMAIN, CHECKOUT_DOMAIN, CHECKOUT_TAG, MAX_PAYEES, RECEIPT_DOMAIN, VOUCHER_DOMAIN, VOUCHER_TAG } from "./constants.ts";
import { sha256Hex, sha256Text, signDigest, verifyDigest, type Keypair } from "./crypto.ts";
import { sig64Bytes } from "./bytes.ts";
import type { Acceptance, AccountId, BudgetTerms, CheckoutTerms, Claim, Id32, Network, ReceiptFields, Voucher } from "./types.ts";

const BYTES32 = { array: { type: "u8", len: 32 } } as const;
const BYTES64 = { array: { type: "u8", len: 64 } } as const;

// Field order in these schemas is the wire format. packages/chain/README.md states the same layouts for the Rust contract.
const voucherSchema: Schema = {
  struct: {
    tag: "u32",
    domain: "string",
    hub: "string",
    network: "string",
    budget_id: BYTES32,
    payee: "string",
    amount: "u128",
    cumulative: "u128",
    request_hash: BYTES32,
  },
};

const budgetSchema: Schema = {
  struct: {
    domain: "string",
    hub: "string",
    network: "string",
    owner: "string",
    agent_pk: BYTES32,
    settler: "string",
    cap: "u128",
    valid_until: "u64",
    payees: { array: { type: "string" } },
    policy_hash: BYTES32,
    salt: BYTES32,
  },
};

const receiptSchema: Schema = {
  struct: {
    domain: "string",
    hub: "string",
    network: "string",
    batch_id: BYTES32,
    call_id: BYTES32,
    budget_id: BYTES32,
    payee: "string",
    amount: "u128",
    cumulative: "u128",
    request_hash: BYTES32,
    timestamp_ms: "u64",
    voucher_sig: BYTES64,
  },
};

const checkoutSchema: Schema = {
  struct: {
    tag: "u32",
    domain: "string",
    hub: "string",
    network: "string",
    payment_id: BYTES32,
    merchant: "string",
    amount: "u128",
    expiry_ms: "u64",
  },
};

const U128_MAX = 2n ** 128n - 1n;
const U64_MAX = 2n ** 64n - 1n;

function u128(v: bigint, what: string): bigint {
  if (v < 0n || v > U128_MAX) throw new Error(`${what} is outside u128`);
  return v;
}

function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) throw new Error(`${what} is outside u64`);
  return v;
}

function account(v: AccountId, what: string): AccountId {
  assertAccountId(v, what);
  return v;
}

/** Sorted by account bytes and unique, as the hub stores them. Throws above MAX_PAYEES. */
export function canonicalPayees(payees: readonly AccountId[]): AccountId[] {
  const out = [...new Set(payees.map((p) => account(p, "payee")))].sort(compareAscii);
  if (out.length > MAX_PAYEES) throw new Error(`a Budget allows at most ${MAX_PAYEES} payees`);
  return out;
}

export function voucherPreimage(hub: AccountId, network: Network, v: Voucher): Uint8Array {
  return serialize(voucherSchema, {
    tag: VOUCHER_TAG,
    domain: VOUCHER_DOMAIN,
    hub: account(hub, "hub"),
    network,
    budget_id: id32Bytes(v.budgetId, "budgetId"),
    payee: account(v.payee, "payee"),
    amount: u128(v.amount, "amount"),
    cumulative: u128(v.cumulative, "cumulative"),
    request_hash: id32Bytes(v.requestHash, "requestHash"),
  });
}

export const voucherDigest = (hub: AccountId, network: Network, v: Voucher): Id32 => sha256Hex(voucherPreimage(hub, network, v));

export function budgetPreimage(hub: AccountId, network: Network, t: BudgetTerms): Uint8Array {
  return serialize(budgetSchema, {
    domain: BUDGET_DOMAIN,
    hub: account(hub, "hub"),
    network,
    owner: account(t.owner, "owner"),
    agent_pk: publicKeyBytes(t.agentPk),
    settler: account(t.settler, "settler"),
    cap: u128(t.cap, "cap"),
    valid_until: u64(t.validUntil, "validUntil"),
    payees: canonicalPayees(t.payees),
    policy_hash: id32Bytes(t.policyHash, "policyHash"),
    salt: id32Bytes(t.salt, "salt"),
  });
}

export const budgetIdOf = (hub: AccountId, network: Network, t: BudgetTerms): Id32 => sha256Hex(budgetPreimage(hub, network, t));

/** The bytes after the 0x00 leaf prefix. */
export function receiptLeafPreimage(hub: AccountId, network: Network, batchId: Id32, f: ReceiptFields): Uint8Array {
  return serialize(receiptSchema, {
    domain: RECEIPT_DOMAIN,
    hub: account(hub, "hub"),
    network,
    batch_id: id32Bytes(batchId, "batchId"),
    call_id: id32Bytes(f.callId, "callId"),
    budget_id: id32Bytes(f.budgetId, "budgetId"),
    payee: account(f.payee, "payee"),
    amount: u128(f.amount, "amount"),
    cumulative: u128(f.cumulative, "cumulative"),
    request_hash: id32Bytes(f.requestHash, "requestHash"),
    timestamp_ms: u64(f.timestampMs, "timestampMs"),
    voucher_sig: sig64Bytes(f.voucherSig, "voucherSig"),
  });
}

export function checkoutPreimage(hub: AccountId, network: Network, t: CheckoutTerms): Uint8Array {
  return serialize(checkoutSchema, {
    tag: CHECKOUT_TAG,
    domain: CHECKOUT_DOMAIN,
    hub: account(hub, "hub"),
    network,
    payment_id: id32Bytes(t.paymentId, "paymentId"),
    merchant: account(t.merchant, "merchant"),
    amount: u128(t.amount, "amount"),
    expiry_ms: u64(t.expiryMs, "expiryMs"),
  });
}

export const checkoutDigest = (hub: AccountId, network: Network, t: CheckoutTerms): Id32 => sha256Hex(checkoutPreimage(hub, network, t));

// ---- the node's acceptance of a call ----

/**
 * The node's id for one call: sha256 of the text `payminto.call.v1|budgetId|payee|cumulative|requestHash`.
 * Unique per (Budget, payee, cumulative), because cumulative strictly increases.
 */
export function voucherCallId(v: Pick<Voucher, "budgetId" | "payee" | "cumulative" | "requestHash">): Id32 {
  id32Bytes(v.budgetId, "budgetId");
  id32Bytes(v.requestHash, "requestHash");
  return sha256Text([CALL_DOMAIN, v.budgetId, account(v.payee, "payee"), u128(v.cumulative, "cumulative"), v.requestHash].join("|"));
}

/**
 * The text the node signs when it accepts a call:
 * `payminto.accepted.v1|callId|budgetId|payee|amount|cumulative|requestHash|timestamp|voucherSig`.
 *
 * It is unambiguous: there are always nine fields, none can contain `|` (lowercase hex, a NEAR account id, or a decimal
 * number), and each value has exactly one text form (fixed-length lowercase hex, decimal with no sign or leading
 * zeros), so two different calls can never produce the same text. The hub and the network are bound through
 * `budgetId` and through the voucher signature, which both hash them. `timestampS` is Unix seconds.
 */
export function acceptancePreimage(c: Claim, timestampS: bigint): string {
  sig64Bytes(c.signature, "voucher signature");
  return [ACCEPTANCE_DOMAIN, voucherCallId(c), c.budgetId, c.payee, u128(c.amount, "amount"), c.cumulative, c.requestHash, u64(timestampS, "timestampS"), c.signature].join("|");
}

/** What the node signs for an accepted call, and what the hub rebuilds in `settle_own`. Equal to the protocol's `nodeDigest`. */
export const acceptanceDigest = (c: Claim, timestampS: bigint): Id32 => sha256Text(acceptancePreimage(c, timestampS));

/** Signs an acceptance of `c` with a receipt key. The node does this for every call it accepts. */
export function signAcceptance(key: Keypair, c: Claim, timestampS: bigint): Acceptance {
  return { nodeKey: key.publicKey, timestampS, signature: signDigest(key.secretKey, acceptanceDigest(c, timestampS)) };
}

/** True when `a` is a valid signature by `a.nodeKey` over exactly this claim and time. It does not check the key is registered. */
export function acceptanceSignedFor(c: Claim, a: Acceptance): boolean {
  try {
    return verifyDigest(a.nodeKey, acceptanceDigest(c, a.timestampS), a.signature);
  } catch {
    return false;
  }
}

/**
 * The last moment, in Unix milliseconds, at which the node may have accepted a call that `settle_own` still settles:
 * the Budget's revoke or its expiry, whichever is earlier.
 */
export function acceptanceLimitMs(b: { validUntil: bigint; revokedAt: bigint | null }): bigint {
  return b.revokedAt !== null && b.revokedAt < b.validUntil ? b.revokedAt : b.validUntil;
}

/**
 * The hub's time rule for an acceptance. The acceptance carries Unix seconds and the Budget Unix milliseconds: a second
 * counts from its first millisecond, so a call accepted in the same second as the revoke still settles.
 */
export function acceptanceInTime(a: Pick<Acceptance, "timestampS">, b: { validUntil: bigint; revokedAt: bigint | null }): boolean {
  const ms = a.timestampS * 1000n;
  return a.timestampS >= 0n && ms <= U64_MAX && ms <= acceptanceLimitMs(b);
}
