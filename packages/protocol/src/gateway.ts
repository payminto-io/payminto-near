/**
 * Payminto Gateway shared protocol on NEAR: ids, the hosted checkout paid with node-signed terms through the hub,
 * NEP-413 payout proofs, merchant refund transfers, webhook signatures, and the public JSON types the node, dashboard and
 * SDK exchange. Runtime-neutral (Node, browsers, edge): Web Crypto and TextEncoder only, no Buffer.
 */
import {
  isAccountId,
  isPublicKey,
  sha256Hex,
  sha256Text,
  verifyDigest,
  type AccountId,
  type CheckoutTerms,
  type Id32,
  type Network,
  type PublicKey,
  type Sig64,
  type WalletTx,
} from "@payminto/chain";
import type { RetryHint } from "./policy.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Ids and secrets

/** Id prefixes. The random part is 24 lowercase base32 characters (15 random bytes). */
export const ID_PREFIXES = {
  payment: "pay",
  link: "plink",
  refund: "re",
  webhookEndpoint: "we",
  event: "evt",
  delivery: "whd",
  apiKey: "key",
  merchant: "mer",
  feePlan: "fp",
  /** A NEAR Intents (1Click) quote of the any-chain checkout. */
  intentsQuote: "iq",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const ID_RANDOM_BYTES = 15;
const ID_BODY = /^[a-z2-7]{24}$/;

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** RFC 4648 base32, lowercase, unpadded. */
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${base32(randomBytes(ID_RANDOM_BYTES))}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ID_BODY.test(value.slice(prefix.length));
}

export const newPaymentId = (): string => newId("payment");
export const newLinkId = (): string => newId("link");
export const newRefundId = (): string => newId("refund");
export const newWebhookEndpointId = (): string => newId("webhookEndpoint");
export const newEventId = (): string => newId("event");
export const newDeliveryId = (): string => newId("delivery");
export const newApiKeyId = (): string => newId("apiKey");
export const newMerchantId = (): string => newId("merchant");
export const newFeePlanId = (): string => newId("feePlan");
export const newIntentsQuoteId = (): string => newId("intentsQuote");

/** Payment link slug: 8 url-safe characters (40 random bits); uniqueness is the store's job. */
export function newLinkSlug(): string {
  return base32(randomBytes(5));
}

/** Webhook signing secret: `whsec_` + 32 random bytes base64url. */
export function newWebhookSecret(): string {
  return `whsec_${base64url(randomBytes(32))}`;
}

/** Merchant API secret: `sk_live_` on mainnet, `sk_test_` elsewhere, + 32 random bytes base32. Store only its hash. */
export function newApiKeySecret(livemode: boolean): string {
  return `${livemode ? "sk_live_" : "sk_test_"}${base32(randomBytes(32))}`;
}

/** SHA-256 of the secret's UTF-8 bytes as 64 lowercase hex characters, the only form an API key is stored in. */
export function hashApiKeySecret(secret: string): string {
  return sha256Text(secret);
}

/** A fresh on-chain checkout payment id: 32 random bytes. The hub refuses a repeated id, so every payment has its own. */
export function newCheckoutId(): Id32 {
  return toHex(randomBytes(32));
}

/** Public objects carry `livemode`, true only on NEAR mainnet (there is no mainnet node mode in this submission). */
export function isLivemode(network: Network): boolean {
  return network === "near:mainnet";
}

// ---------------------------------------------------------------------------------------------------------------------
// Payout proofs: NEP-413 signed messages

/** The NEP-413 tag, 2^31 + 413, which keeps a signed message from parsing as a NEAR transaction. */
export const NEP413_TAG = 2147484061;

export type Nep413Payload = { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null };

const utf8 = new TextEncoder();

/**
 * sha256(borsh(u32 tag, string message, [u8; 32] nonce, string recipient, Option<string> callbackUrl)): the 32 bytes a
 * NEAR wallet's `signMessage` signs with the account's full-access key.
 */
export function nep413Digest(p: Nep413Payload): Id32 {
  if (p.nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    parts.push(b);
  };
  const str = (s: string) => {
    const b = utf8.encode(s);
    u32(b.length);
    parts.push(b);
  };
  u32(NEP413_TAG);
  str(p.message);
  parts.push(p.nonce);
  str(p.recipient);
  if (p.callbackUrl === undefined || p.callbackUrl === null) parts.push(new Uint8Array([0]));
  else {
    parts.push(new Uint8Array([1]));
    str(p.callbackUrl);
  }
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) {
    all.set(x, at);
    at += x.length;
  }
  return sha256Hex(all);
}

/** What a payout proof is bound to: the node's network and hub, so a proof is good on one node only. */
export type PayoutProofScope = { network: Network; hub: AccountId };

/** Payout proofs older than this (seconds) are refused. */
export const PAYOUT_PROOF_MAX_AGE_SECONDS = 600;

/**
 * The message a payout account signs to prove control when a merchant is created or its payout changes. A merchant that
 * does not exist yet signs with the literal id "new". The network and the node's hub are in the text, so a proof signed
 * for one node cannot be replayed on another.
 */
export function payoutChangeMessage(merchantId: string, payout: AccountId, timestamp: number, scope: PayoutProofScope): string {
  return `Payminto payout change ${merchantId} ${payout} ${timestamp} network ${scope.network} hub ${scope.hub}`;
}

/**
 * The exact `signMessage` request for a payout proof (NEAR Connect and NEP-413 wallets): the message, the hub as the
 * recipient, and a nonce derived from the message, so the node can rebuild every byte from the proof alone.
 */
export function payoutProofRequest(merchantId: string, payout: AccountId, timestamp: number, scope: PayoutProofScope): { message: string; recipient: string; nonce: Uint8Array } {
  const message = payoutChangeMessage(merchantId, payout, timestamp, scope);
  return { message, recipient: scope.hub, nonce: hexToBytes(sha256Text(message)) };
}

/** What `POST /v1/merchants` (as `payout`) and `POST /v1/merchants/{id}/payout` take. */
export type PayoutProof = {
  /** The NEAR account that becomes the payout. */
  payout: AccountId;
  /** Unix seconds, as signed in the message. */
  timestamp: number;
  /** The key that signed, as the wallet returns it. The node checks it is a full-access key of `payout`. */
  public_key: PublicKey;
  /** The ed25519 signature, base64 as NEAR wallets return it. */
  signature: string;
};

/** Base64 (standard or url-safe, padded or not) to lowercase hex, or null when it is not 64 bytes. */
export function signatureHex(base64: string): Sig64 | null {
  try {
    const bin = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== 64) return null;
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  } catch {
    return null;
  }
}

/**
 * True when `proof.public_key` signed the payout proof message. This checks the signature only: whether that key is a
 * full-access key of `proof.payout` is a chain read the node makes (view_access_key).
 */
export function verifyPayoutProofSignature(proof: PayoutProof, merchantId: string, scope: PayoutProofScope): boolean {
  if (!isAccountId(proof.payout) || !isPublicKey(proof.public_key)) return false;
  const sig = signatureHex(proof.signature);
  if (!sig) return false;
  return verifyDigest(proof.public_key, nep413Digest(payoutProofRequest(merchantId, proof.payout, proof.timestamp, scope)), sig);
}

/**
 * What an any-chain payout proof is bound to: the network the USDC of the any-chain checkout lands on (`near:mainnet`,
 * or the local chain in simulated mode) and this node's hub, so a proof is good on one node only.
 */
export type IntentsPayoutScope = { settlementNetwork: string; hub: AccountId };

/**
 * The message the merchant's NEAR account signs to receive any-chain checkout payments. Its own prefix keeps a
 * payout-change proof from passing as this one, and the other way round.
 */
export function intentsPayoutMessage(merchantId: string, account: AccountId, timestamp: number, scope: IntentsPayoutScope): string {
  return `Payminto intents payout ${merchantId} ${account} ${timestamp} network ${scope.settlementNetwork} hub ${scope.hub}`;
}

/** The exact `signMessage` request (NEP-413) for an any-chain payout proof: recipient the hub, nonce from the message. */
export function intentsPayoutProofRequest(merchantId: string, account: AccountId, timestamp: number, scope: IntentsPayoutScope): { message: string; recipient: string; nonce: Uint8Array } {
  const message = intentsPayoutMessage(merchantId, account, timestamp, scope);
  return { message, recipient: scope.hub, nonce: hexToBytes(sha256Text(message)) };
}

/** What `PUT /v1/merchant/intents-payout` takes as `proof`: the wallet's answer to `intentsPayoutProofRequest`. */
export type IntentsPayoutProof = {
  /** Unix seconds, as signed in the message. */
  timestamp: number;
  /** The key that signed; the node checks it is a full-access key of the account on the settlement network. */
  public_key: PublicKey;
  /** The ed25519 signature, base64 as NEAR wallets return it. */
  signature: string;
};

/** True when `proof.public_key` signed the any-chain payout message for `account`. The key's owner is a chain read. */
export function verifyIntentsPayoutSignature(account: AccountId, proof: IntentsPayoutProof, merchantId: string, scope: IntentsPayoutScope): boolean {
  if (!isAccountId(account) || !isPublicKey(proof.public_key)) return false;
  const sig = signatureHex(proof.signature);
  if (!sig) return false;
  return verifyDigest(proof.public_key, nep413Digest(intentsPayoutProofRequest(merchantId, account, proof.timestamp, scope)), sig);
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment rules shared by every component

export const PAYMENT_STATUSES = ["open", "processing", "partially_paid", "paid", "overpaid", "underpaid", "expired", "canceled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Terminal states. `expired` and `canceled` still take a late wallet payment the hub recorded, which moves them on. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ["paid", "overpaid", "underpaid", "expired", "canceled"];

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/**
 * How a payment can be paid. `wallet`: a person's NEAR wallet sends `ft_transfer_call` to the hub with node-signed terms.
 * `voucher`: an agent pays from its Budget over x402. Add-on rails (any-chain checkout) are registered by the add-ons
 * layer and are not part of this list.
 */
export const PAYMENT_METHODS = ["wallet", "voucher"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DEFAULT_CHECKOUT_TTL_SECONDS = 1800;
export const MIN_EXPIRES_IN_SECONDS = 300;
export const MAX_EXPIRES_IN_SECONDS = 604_800;

export function checkoutUrl(checkoutBaseUrl: string, paymentId: string): string {
  return `${checkoutBaseUrl.replace(/\/+$/, "")}/pay/${paymentId}`;
}

export function linkUrl(checkoutBaseUrl: string, slug: string): string {
  return `${checkoutBaseUrl.replace(/\/+$/, "")}/l/${slug}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Checkout and refunds on NEAR

/** CheckoutTerms in JSON: amounts and times as decimal strings. */
export type CheckoutTermsJson = { payment_id: Id32; merchant: AccountId; amount: string; expiry_ms: string };

export const checkoutTermsToJson = (t: CheckoutTerms): CheckoutTermsJson => ({ payment_id: t.paymentId, merchant: t.merchant, amount: t.amount.toString(), expiry_ms: t.expiryMs.toString() });

export const checkoutTermsFromJson = (j: CheckoutTermsJson): CheckoutTerms => ({ paymentId: j.payment_id, merchant: j.merchant, amount: BigInt(j.amount), expiryMs: BigInt(j.expiry_ms) });

/**
 * What a hosted checkout hands the payer's wallet for the `wallet` method: terms the node signed with its checkout key,
 * and the ready `ft_transfer_call` to the hub (`checkoutPayTx`). The hub verifies the signature, the amount and the
 * expiry, refuses a repeated payment id, and credits the merchant; it returns the tokens for anything else.
 */
export type CheckoutWallet = {
  terms: CheckoutTermsJson;
  /** The node's ed25519 signature of `checkoutDigest(hub, network, terms)`. */
  signature: Sig64;
  /** The key the hub checks it against (`set_checkout_key`). */
  checkout_key: PublicKey;
  /** Send this from the payer's wallet. */
  transaction: WalletTx;
};

/** NEP-141 `ft_transfer` of `amount` to `to`, sent by the merchant's payout account to refund a payment. 1 yoctoNEAR attached. */
export function refundTransferTx(token: AccountId, to: AccountId, amount: bigint, refundId: string): WalletTx {
  return {
    receiverId: token,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: "ft_transfer", args: { receiver_id: to, amount: amount.toString(), memo: `payminto refund ${refundId}` }, gas: (30n * 1_000_000_000_000n).toString(), deposit: "1" },
      },
    ],
  };
}

/**
 * @deprecated EVM-era refund authorization shapes. The node no longer produces or accepts them (a refund is the
 * merchant's own `ft_transfer`, see `refundTransferTx`); they remain only so packages/sdk compiles until the clients
 * stream moves its gateway client to NEAR. Remove both with that change.
 */
export type PaymentTermsJson = { paymentRef: string; payout: string; feeRecipient: string; fee: string };
/** @deprecated See PaymentTermsJson. */
export type TransferAuthorizationJson = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };

// ---------------------------------------------------------------------------------------------------------------------
// Webhook signatures

export const WEBHOOK_SIGNATURE_HEADER = "Payminto-Signature";
export const WEBHOOK_EVENT_ID_HEADER = "Payminto-Event-Id";
export const WEBHOOK_EVENT_TYPE_HEADER = "Payminto-Event-Type";
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Delay before each attempt, in seconds: immediately, then 1 m, 5 m, 30 m, 2 h, 6 h, 24 h. */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS = [0, 60, 300, 1800, 7200, 21_600, 86_400] as const;

async function hmacSha256Hex(secret: string, t: number, body: string | Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = utf8.encode(`${t}.`);
  const raw = typeof body === "string" ? utf8.encode(body) : body;
  const payload = new Uint8Array(prefix.length + raw.length);
  payload.set(prefix, 0);
  payload.set(raw, prefix.length);
  return toHex(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, payload)));
}

/** Constant-time for equal lengths; a length mismatch reveals nothing secret (every v1 is 64 hex characters). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `Payminto-Signature` header value: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * The key is the whole secret string (including `whsec_`) as UTF-8; `body` must be the exact bytes sent.
 */
export async function signWebhook(secret: string, body: string | Uint8Array, t: number): Promise<string> {
  if (!Number.isSafeInteger(t) || t < 0) throw new Error("webhook timestamp must be a non-negative integer (unix seconds)");
  return `t=${t},v1=${await hmacSha256Hex(secret, t, body)}`;
}

/**
 * True when the header carries a v1 signature of `rawBody` under `secret` and its timestamp is within `toleranceSec`
 * (default 300) of `now` (unix seconds, default the current time). Verify the raw request bytes, never re-serialized JSON.
 */
export async function verifyWebhook(rawBody: string | Uint8Array, header: string | null | undefined, secret: string, opts: { toleranceSec?: number; now?: number } = {}): Promise<boolean> {
  if (!header) return false;
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,15}$/.test(value)) t = Number(value);
    else if (key === "v1") signatures.push(value.toLowerCase());
  }
  if (t === null || signatures.length === 0) return false;
  const tolerance = opts.toleranceSec ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) return false;
  const expected = await hmacSha256Hex(secret, t, rawBody);
  // Check every candidate so the time taken does not depend on which one matched.
  let ok = false;
  for (const s of signatures) ok = timingSafeEqual(s, expected) || ok;
  return ok;
}

// ---------------------------------------------------------------------------------------------------------------------
// Order commitment

export type LineItem = { name: string; quantity: number; unit_amount: string };

/**
 * What a payment commits to, and exactly what `GET /v1/checkout/{id}/order` returns. `amount` is the merchant price.
 * Metadata is merchant-private, so the order carries only its hash (`metadata_hash`), never the metadata itself.
 */
export type OrderCommitment = {
  payment_id: string;
  amount: string;
  token: AccountId;
  payout: AccountId;
  reference: string | null;
  description: string | null;
  line_items: LineItem[];
  metadata_hash: Id32;
};

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

/** The 32 zero bytes, as the metadata hash of a payment without metadata. */
export const ZERO_ID32: Id32 = "00".repeat(32);

/** sha256 of the canonical JSON of the metadata, or ZERO_ID32 when there is none (absent or no keys). */
export function metadataHash(metadata: Record<string, string> | null | undefined): Id32 {
  if (!metadata || Object.keys(metadata).length === 0) return ZERO_ID32;
  return sha256Text(canonicalJson(metadata));
}

/** The order as committed: canonical JSON, so every party serializes the same bytes. NEAR account ids are already canonical. */
export function canonicalOrder(o: OrderCommitment): string {
  return canonicalJson(o);
}

/** `order_hash = sha256(canonical JSON)` of the order a payment commits to. */
export function orderHash(o: OrderCommitment): Id32 {
  return sha256Text(canonicalOrder(o));
}

/** Sum of quantity x unit_amount, in base units. */
export function lineItemsTotal(items: readonly LineItem[]): bigint {
  return items.reduce((acc, i) => acc + BigInt(i.quantity) * BigInt(i.unit_amount), 0n);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fees

/** Fee breakdown of a payment. Strings (base units) in JSON; computeFees returns bigints. */
export type FeeBreakdown<T = string> = {
  /** The merchant's price. */
  amount: T;
  /** The method fee when the customer bears it, else 0. */
  surcharge: T;
  /** amount + surcharge: what the payer pays. */
  amount_due: T;
  platform_fee: T;
  method_fee: T;
  /** platform_fee + method_fee, never above amount_due. */
  fee_total: T;
  /** amount_due - fee_total: what the merchant receives. */
  net_amount: T;
};

type Units = bigint | string;

function units(v: Units | null | undefined, label: string): bigint | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n) throw new Error(`${label} must be non-negative`);
  return n;
}

function bps(v: number, max: number, label: string): bigint {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${label} must be an integer between 0 and ${max}`);
  return BigInt(v);
}

/**
 * The fee math, integers only: platform_fee = clamp(fixed + floor(amount * bps / 10000), min_fee, max_fee);
 * method_fee = fee_fixed + floor(amount * fee_bps / 10000), added to amount_due as the surcharge when the customer bears
 * it. When fees would exceed amount_due, method_fee is kept and platform_fee is cut, so fee_total <= amount_due.
 */
export function computeFees(p: {
  amount: Units;
  plan: { platform_fee_bps: number; platform_fee_fixed: Units; min_fee?: Units | null; max_fee?: Units | null };
  method: { fee_bps: number; fee_fixed: Units; bearer: FeeBearer } | null;
}): FeeBreakdown<bigint> {
  const amount = units(p.amount, "amount")!;
  if (amount === 0n) throw new Error("amount must be positive");
  const minFee = units(p.plan.min_fee, "min_fee") ?? 0n;
  const maxFee = units(p.plan.max_fee, "max_fee");
  if (maxFee !== null && maxFee < minFee) throw new Error("max_fee must not be below min_fee");

  let platform = units(p.plan.platform_fee_fixed, "platform_fee_fixed")! + (amount * bps(p.plan.platform_fee_bps, 1000, "platform_fee_bps")) / 10_000n;
  if (platform < minFee) platform = minFee;
  if (maxFee !== null && platform > maxFee) platform = maxFee;

  let methodFee = 0n;
  if (p.method) methodFee = units(p.method.fee_fixed, "fee_fixed")! + (amount * bps(p.method.fee_bps, 10_000, "fee_bps")) / 10_000n;
  const surcharge = p.method?.bearer === "customer" ? methodFee : 0n;
  const amountDue = amount + surcharge;

  if (methodFee > amountDue) methodFee = amountDue;
  if (platform > amountDue - methodFee) platform = amountDue - methodFee;
  const feeTotal = platform + methodFee;
  return { amount, surcharge, amount_due: amountDue, platform_fee: platform, method_fee: methodFee, fee_total: feeTotal, net_amount: amountDue - feeTotal };
}

export function feeBreakdownToJson(f: FeeBreakdown<bigint>): FeeBreakdown {
  return {
    amount: f.amount.toString(),
    surcharge: f.surcharge.toString(),
    amount_due: f.amount_due.toString(),
    platform_fee: f.platform_fee.toString(),
    method_fee: f.method_fee.toString(),
    fee_total: f.fee_total.toString(),
    net_amount: f.net_amount.toString(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Public JSON types. Amounts are decimal strings of token base units; `*_at` fields are ISO 8601 strings; `created` on
// webhook events is unix seconds. Accounts are NEAR account ids.

export type RefundStatus = "pending" | "succeeded" | "failed" | "canceled";
export type PaymentRefundStatus = "none" | "partial" | "full";

export const PAYMENT_EVENT_TYPES = [
  "payment.created",
  "payment.processing",
  "payment.partially_paid",
  "payment.paid",
  "payment.overpaid",
  "payment.underpaid",
  "payment.expired",
  "payment.canceled",
] as const;
export const REFUND_EVENT_TYPES = ["refund.succeeded", "refund.failed"] as const;
/** Decision 8: one event per refusal of an agent payment. */
export const REFUSAL_EVENT_TYPES = ["budget.refused"] as const;
/** Events an endpoint can subscribe to. `ping` is only sent by the test route. */
export const WEBHOOK_EVENT_TYPES = [...PAYMENT_EVENT_TYPES, ...REFUND_EVENT_TYPES, ...REFUSAL_EVENT_TYPES] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];
export type RefundEventType = (typeof REFUND_EVENT_TYPES)[number];
export type RefusalEventType = (typeof REFUSAL_EVENT_TYPES)[number];
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type Payment = FeeBreakdown & {
  id: string;
  merchant_id: string;
  livemode: boolean;
  status: PaymentStatus;
  /** Sum of confirmed credits. */
  amount_paid: string;
  amount_refunded: string;
  refund_status: PaymentRefundStatus;
  network: Network;
  /** The settlement token contract. */
  token: AccountId;
  /** The hub that records the wallet payment. */
  hub: AccountId;
  /** The on-chain payment id the checkout terms carry; the hub records the wallet payment under it. */
  checkout_id: Id32;
  description: string | null;
  reference: string | null;
  customer_email: string | null;
  customer_name: string | null;
  metadata: Record<string, string>;
  /** Items the order is made of (may be empty); their total equals amount. */
  line_items: LineItem[];
  /** sha256 of the canonical order JSON. */
  order_hash: Id32;
  link_id: string | null;
  /** The account that paid the first credit: the wallet that sent it, or the Budget owner of a voucher payment. */
  payer: AccountId | null;
  /** The account fixed at creation that receives this payment. */
  payout: AccountId;
  /** The method the fees were quoted for: set at creation for API and agent payments, at checkout for people. */
  method: PaymentMethod | null;
  /** True when a credit arrived after the payment expired or was canceled. */
  late: boolean;
  success_url: string | null;
  checkout_url: string;
  expires_at: string;
  /** When the confirmed total first reached amount_due. */
  paid_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Money toward a payment: a wallet payment the hub recorded, or an accepted voucher. */
export type Credit = {
  payment_id: string;
  method: PaymentMethod;
  payer: AccountId | null;
  amount: string;
  /** Wallet: the transaction the payer's wallet reported (display only; the hub record is the evidence). Voucher: the settling batch's transaction. */
  tx_hash: string | null;
  /** Clearing batch of a voucher credit. */
  batch_id: Id32 | null;
  /** The accepted clearing call of a voucher credit. */
  call_id: Id32 | null;
  /** Hub block time of a wallet payment, Unix milliseconds as a decimal string. */
  recorded_at_ms: string | null;
  /** Wallet credits are confirmed once the hub records them at final finality; voucher credits once their batch settles. */
  status: "pending" | "confirmed";
  late: boolean;
  created_at: string;
  confirmed_at: string | null;
};

export type PaymentLink = {
  id: string;
  livemode: boolean;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  /** Fixed amount, or null when the payer chooses between min_amount and max_amount. */
  amount: string | null;
  min_amount: string | null;
  max_amount: string | null;
  collect_email: boolean;
  collect_name: boolean;
  success_url: string | null;
  active: boolean;
  /** Shown in the service directory. */
  listed: boolean;
  max_payments: number | null;
  payments_count: number;
  paid_total: string;
  created_at: string;
  updated_at: string;
};

/**
 * The `budget.refused` webhook object (decision 8): every refusal of an agent payment, with the rule that fired, the
 * attempted amount, what is left of the Budget and the machine-readable retry hint. Platform alert endpoints receive
 * every refusal; a business endpoint receives refusals of payments to that business.
 */
export type BudgetRefusal = {
  /** The denial id, `dny_...`. */
  id: string;
  object: "refusal";
  rule: string;
  message: string;
  budget_id: string;
  /** The Budget owner's account, or null when the Budget is unknown to the node. */
  owner: string | null;
  /** The agent public key, or null when the Budget is unknown. */
  agent: string | null;
  payee: string;
  provider_id: string;
  attempted_amount: string;
  remaining_budget: string | null;
  retry: RetryHint;
  request_hash: string;
  cumulative: string;
  created_at: string;
};

/**
 * A refund the merchant sends from its own payout account (non-custodial): the node prepares `transfer`, the merchant's
 * wallet sends it, and the node checks the transaction on chain before marking the refund succeeded.
 */
export type Refund = {
  id: string;
  livemode: boolean;
  payment_id: string;
  amount: string;
  reason: string | null;
  to: AccountId;
  status: RefundStatus;
  /** `transfer` once the merchant submitted its refund transaction. */
  method: "transfer" | null;
  tx_hash: string | null;
  /**
   * How the node checked the transaction: `transfer_checked` (sender, token, recipient and amount read from the
   * transaction) or `finality_only` (the node had no transaction reader, so only success at final finality was checked).
   */
  verification: "transfer_checked" | "finality_only" | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookEndpoint = {
  id: string;
  livemode: boolean;
  url: string;
  description: string | null;
  events: (WebhookEventType | "*")[];
  active: boolean;
  /** Present only in the create, reveal and rotate-secret responses. */
  secret?: string;
  created_at: string;
  updated_at: string;
};

type EventEnvelope<T extends string, O> = {
  id: string;
  type: T;
  /** Unix seconds. */
  created: number;
  livemode: boolean;
  data: { object: O };
};

/** The webhook request body. */
export type WebhookEvent =
  | EventEnvelope<PaymentEventType, Payment>
  | EventEnvelope<RefundEventType, Refund>
  | EventEnvelope<RefusalEventType, BudgetRefusal>
  | EventEnvelope<"ping", Omit<WebhookEndpoint, "secret">>;

/** One delivery attempt of one event to one endpoint. */
export type WebhookDelivery = {
  id: string;
  event_id: string;
  event_type: WebhookEventType | "ping";
  endpoint_id: string;
  url: string;
  /** 1-based attempt number within WEBHOOK_RETRY_SCHEDULE_SECONDS. */
  attempt: number;
  status: "pending" | "succeeded" | "failed";
  response_status: number | null;
  /** First 2 KB of the response body. */
  response_body: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  /** When the next attempt is scheduled, if this one failed and attempts remain. */
  next_attempt_at: string | null;
};

export type ApiKey = {
  id: string;
  name: string | null;
  livemode: boolean;
  /** First characters of the secret, for recognising a key in lists, e.g. `sk_test_ab12`. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** The create response, the only time the secret is shown. */
export type ApiKeyWithSecret = ApiKey & { secret: string };

export type FeeBearer = "merchant" | "customer";
export type MerchantStatus = "active" | "suspended";

/** The node's single platform row. */
export type Platform = {
  name: string;
  /** Platform treasury (env PLATFORM_FEE_ACCOUNT); required once any fee is non-zero. */
  fee_recipient: AccountId | null;
  default_fee_plan_id: string;
};

export type FeePlan = {
  id: string;
  name: string;
  /** 0-1000. */
  platform_fee_bps: number;
  platform_fee_fixed: string;
  min_fee: string | null;
  max_fee: string | null;
  created_at: string;
  updated_at: string;
};

/** One payment method's settings for one merchant. */
export type MerchantMethod = {
  merchant_id: string;
  method: PaymentMethod;
  enabled: boolean;
  fee_bps: number;
  fee_fixed: string;
  bearer: FeeBearer;
  min_amount: string | null;
  max_amount: string | null;
};

export type Merchant = {
  id: string;
  livemode: boolean;
  name: string;
  slug: string;
  status: MerchantStatus;
  /** The NEAR account checkout payments credit, or null for a business that has not proven one yet. */
  payout: AccountId | null;
  support_email: string | null;
  brand_color: string | null;
  logo_url: string | null;
  fee_plan_id: string;
  created_at: string;
  updated_at: string;
};

/** `GET /v1/merchant`: the merchant plus read-only node facts. */
export type MerchantProfile = Merchant & {
  network: Network;
  hub: AccountId;
  token: AccountId;
  /** The key the hub checks checkout terms against. */
  checkout_key: PublicKey;
  checkout_base_url: string;
};

/** Public payment view for the hosted checkout. Never carries metadata, customer email or name. */
export type CheckoutView = {
  id: string;
  livemode: boolean;
  status: PaymentStatus;
  late: boolean;
  merchant: Pick<Merchant, "id" | "name" | "support_email" | "brand_color" | "logo_url">;
  description: string | null;
  reference: string | null;
  /** The merchant's price. */
  amount: string;
  /** Method fee the customer bears, shown as a line named after `method`; "0" when none. */
  surcharge: string;
  /** amount + surcharge. */
  amount_due: string;
  amount_paid: string;
  /** max(amount_due - amount_paid, 0). */
  amount_remaining: string;
  network: Network;
  hub: AccountId;
  token: { address: AccountId; symbol: string; decimals: number };
  /** The method the amounts are quoted for; null until a person picks one. */
  method: PaymentMethod | null;
  /** Methods a person can use on this page right now. */
  methods: PaymentMethod[];
  /** Null once the payment is terminal or expired, or when `wallet` is not offered. */
  wallet: CheckoutWallet | null;
  success_url: string | null;
  /** Latest transaction behind a confirmed credit, for the success screen (the payer's report for a wallet payment). */
  tx_hash: string | null;
  /** sha256 of the canonical order JSON. */
  order_hash: Id32;
  expires_at: string;
  created_at: string;
};

// ---------------------------------------------------------------------------------------------------------------------
// Reconciliation report: `GET /v1/reports/reconciliation`. Amounts are decimal token units with the token's decimals
// ("12.500000"); `base_units` repeats them in base units.

export const REPORT_AMOUNT_FIELDS = [
  "amount",
  "surcharge",
  "amount_due",
  "amount_paid",
  "platform_fee",
  "method_fee",
  "fee_total",
  "net_amount",
  "refunded",
  "refunds_pending",
  "net_after_refunds",
] as const;
export type ReportAmountField = (typeof REPORT_AMOUNT_FIELDS)[number];

export const REPORT_TOTAL_FIELDS = ["gross", "platform_fee", "method_fee", "fees", "net", "refunds", "refunds_pending", "net_after_refunds"] as const;
export type ReportTotalField = (typeof REPORT_TOTAL_FIELDS)[number];

/** CSV columns, in order: one line per payment, then a TOTAL line. Amounts are decimal token units. */
export const REPORT_CSV_COLUMNS = [
  "payment_id",
  "reference",
  "link_id",
  "description",
  "created_at",
  "paid_at",
  "status",
  "method",
  "payer",
  "currency",
  ...REPORT_AMOUNT_FIELDS,
  "refund_ids",
  "tx_hashes",
  "explorer_urls",
  "batch_ids",
  "receipt_proof_urls",
  "proof_url",
  "screening_rules",
  // Any-chain checkout (NEAR Intents): where the money settled and where it came from. Empty for the other methods
  // except settlement_network.
  "settlement_network",
  "origin_asset",
  "origin_amount",
  "deposit_address",
] as const;
export type ReportCsvColumn = (typeof REPORT_CSV_COLUMNS)[number];

/**
 * One RFC 4180 cell: always quoted, and text a spreadsheet would run as a formula (= + - @ tab, carriage return) is
 * prefixed with an apostrophe first. Plain numbers, negative ones included, are left as numbers.
 */
export function reportCsvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = !/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** A set of amounts in decimal token units, with the same keys in base units under `base_units`. */
export type ReportAmounts<K extends string> = Record<K, string> & { base_units: Record<K, string> };

export type ReconciliationRefund = {
  id: string;
  amount: string;
  amount_base_units: string;
  status: RefundStatus;
  approval: "not_required" | "requested" | "approved";
  tx_hash: string | null;
  explorer_url: string | null;
  created_at: string;
};

/** One credit of the payment: a wallet payment the hub recorded, or an agent charge settled in a clearing batch. */
export type ReconciliationTransaction = {
  /** The method that paid this credit, read as stored (never a fixed list). */
  method: string;
  amount: string;
  amount_base_units: string;
  status: "pending" | "confirmed";
  /** The payer's reported transaction, or the batch settlement transaction for an agent charge. */
  tx_hash: string | null;
  explorer_url: string | null;
  batch_id: Id32 | null;
  call_id: Id32 | null;
  /** Public JSON proof of an agent charge: its Merkle path to the batch's receipts root on chain. */
  receipt_proof_url: string | null;
  /**
   * Any-chain payments only. `near_delivery`: the credit, the USDC delivered on NEAR (amounts in USDC).
   * `origin_deposit`: the buyer's deposit on the origin chain (amounts in `origin_asset`'s own units), for the audit trail.
   */
  leg?: "near_delivery" | "origin_deposit";
  origin_asset?: string;
};

export type ReconciliationRow = ReportAmounts<ReportAmountField> & {
  payment_id: string;
  reference: string | null;
  link_id: string | null;
  description: string | null;
  created_at: string;
  paid_at: string | null;
  status: PaymentStatus;
  /** The method shown on the payment: quoted, else the one that paid. Read as stored, never a fixed list. */
  method: string | null;
  payer: AccountId | null;
  currency: string;
  refunds: ReconciliationRefund[];
  transactions: ReconciliationTransaction[];
  batch_ids: Id32[];
  /** The public payment proof page, for paid and overpaid payments. */
  proof_url: string | null;
  /** Screening rules that refused a payer for this payment (for example PAYER_DENIED). */
  screening_rules: string[];
  /**
   * Where the money settled: the node's network for wallet and voucher payments, `near:mainnet` for an any-chain
   * payment (`near:mainnet (simulated)` in simulated mode), null while nothing was received.
   */
  settlement_network: string | null;
  /** Any-chain payments: the 1Click asset ids the buyer paid with, space separated. Null otherwise. */
  origin_asset: string | null;
  /** Any-chain payments: what the buyer deposited, in the origin token's decimal units ("5.010154 USDC"). */
  origin_amount: string | null;
  /** Any-chain payments: the 1Click deposit addresses that delivered. */
  deposit_address: string | null;
};

export type ReconciliationReport = {
  object: "reconciliation_report";
  merchant_id: string;
  business_name: string;
  /** Inclusive start and exclusive end of the range, ISO 8601 UTC. Rows are the payments created in it. */
  from: string;
  to: string;
  generated_at: string;
  network: Network;
  livemode: boolean;
  token: { address: AccountId; symbol: string; decimals: number };
  totals: ReportAmounts<ReportTotalField> & { payments: number };
  counts: Record<string, number>;
  by_method: Record<string, ReportAmounts<"gross" | "fees" | "net" | "refunds"> & { payments: number }>;
  /** Agent charges of the range against the clearing ledger's call.accepted journals for the same calls. */
  ledger: { calls: number; charges: string; ledger_accepted: string; base_units: { charges: string; ledger_accepted: string }; matches: boolean };
  rows: ReconciliationRow[];
};

/**
 * `GET /v1/checkout/{id}/proof`: the evidence that a payment was paid, read from the chain when asked. A wallet credit
 * is proven by the hub's own record of the checkout payment id; a voucher credit by its clearing receipt, whose Merkle
 * path the hub verifies against the batch root (inclusion and agent authorization, not delivery).
 */
export type PaymentProof = {
  payment_id: string;
  livemode: boolean;
  status: PaymentStatus;
  network: Network;
  hub: AccountId;
  token: { address: AccountId; symbol: string; decimals: number };
  payout: AccountId;
  amount_due: string;
  amount_paid: string;
  order_hash: Id32;
  paid_at: string | null;
  checked_at: string;
  credits: Array<
    | {
        method: "wallet";
        amount: string;
        payer: AccountId | null;
        checkout_id: Id32;
        /**
         * The transaction the payer's wallet reported, so a person can find it; null when the wallet reported none.
         * It is never the evidence: `hub_record` and `verified` are.
         */
        tx_hash: string | null;
        /** The hub's record read now; null when the hub has none (or could not be read, see `verified`). */
        hub_record: { merchant: AccountId; amount: string; payer: AccountId; at_ms: string } | null;
        /** True when the hub's record matches this credit's merchant and amount; null when the chain could not be read. */
        verified: boolean | null;
      }
    | {
        method: "voucher";
        amount: string;
        payer: AccountId | null;
        call_id: Id32;
        batch_id: Id32 | null;
        tx_hash: string | null;
        receipt_proof_url: string;
        /** True when the hub verified the call's Merkle proof against a batch this node settled; null before settlement or on a read failure. */
        verified: boolean | null;
      }
  >;
};
