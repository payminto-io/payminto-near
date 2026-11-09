/**
 * Payminto Gateway shared protocol (docs/GATEWAY.md): ids, EIP-3009 checkout authorizations, per-payment deposit
 * forwarders, webhook signatures, EIP-681 URIs, and the public JSON types the node, dashboard and SDK exchange.
 * Runtime-neutral (Node, browsers, edge): Web Crypto and TextEncoder only, no Buffer.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  sha256,
  toBytes,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { depositFactoryAbi, paymentRouterAbi } from "./abi.ts";
import type { CheckoutHsp, PaymentHsp } from "./hsp-agentic.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Ids and secrets

/** Id prefixes, GATEWAY.md section 4. The random part is 24 lowercase base32 characters (15 random bytes). */
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

/** Payment link slug: 8 url-safe characters (40 random bits); uniqueness is the store's job. */
export function newLinkSlug(): string {
  return base32(randomBytes(5));
}

/** Webhook signing secret: `whsec_` + 32 random bytes base64url. */
export function newWebhookSecret(): string {
  return `whsec_${base64url(randomBytes(32))}`;
}

/** Merchant API secret: `sk_live_` on 177, `sk_test_` elsewhere, + 32 random bytes base32. Store only its hash. */
export function newApiKeySecret(livemode: boolean): string {
  return `${livemode ? "sk_live_" : "sk_test_"}${base32(randomBytes(32))}`;
}

/** SHA-256 of the secret's UTF-8 bytes, the only form an API key is stored in. */
export function hashApiKeySecret(secret: string): Hex {
  return sha256(toBytes(secret));
}

/** What a payout proof is bound to: the node's chain and its ClearingHub, so a proof is good on one node only. */
export type PayoutProofScope = { chainId: number; hub: Address };

/**
 * The EIP-191 message a payout wallet signs to prove control when a merchant is created or its payout changes
 * (GATEWAY.md section 14.3). A merchant that does not exist yet signs with the literal id "new". The chain id and the
 * node's hub are part of the text, so a proof signed for one node cannot be replayed on another.
 */
export function payoutChangeMessage(merchantId: string, payout: Address, timestamp: number, scope: PayoutProofScope): string {
  return `Payminto payout change ${merchantId} ${getAddress(payout)} ${timestamp} chain ${scope.chainId} hub ${getAddress(scope.hub)}`;
}

/** Payout proofs older than this (seconds) are refused. */
export const PAYOUT_PROOF_MAX_AGE_SECONDS = 600;

/** Public objects carry `livemode`, true only on HashKey Chain mainnet. */
export function isLivemode(chainId: number): boolean {
  return chainId === 177;
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment rules shared by every component

export const PAYMENT_STATUSES = [
  "open",
  "processing",
  "partially_paid",
  "paid",
  "overpaid",
  "underpaid",
  "expired",
  "canceled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Terminal states. `expired` and `canceled` still take late deposits, which move them to paid, overpaid or underpaid. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ["paid", "overpaid", "underpaid", "expired", "canceled"];

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/** `hsp` is HashKey's HSP Agentic Payment into the payment's forwarder (section 17); off until a business enables it. */
export const PAYMENT_METHODS = ["wallet", "deposit", "x402", "voucher", "hsp"] as const;
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
// Nonce and salt derivation (GATEWAY.md sections 2.1 and 3)

function tagged(tag: string, chainId: number, paymentId: string): Hex {
  // Solidity: keccak256(abi.encode(tag, uint256(chainId), paymentId)), tag and id as dynamic strings.
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "string" }], [tag, BigInt(chainId), paymentId]),
  );
}

/** `PaymentTerms.paymentRef` for a payment: binds a router authorization to one payment on one chain. */
export function paymentRef(chainId: number, paymentId: string): Hex {
  return tagged("payminto.payment.v1", chainId, paymentId);
}

/** `PaymentTerms.paymentRef` for a gasless refund the payout wallet signs. */
export function refundRef(chainId: number, refundId: string): Hex {
  return tagged("payminto.refund.v1", chainId, refundId);
}

/**
 * The EIP-3009 nonce of a checkout `wallet` TransferWithAuthorization: deterministic per payment and per amount
 * already paid, keccak256(abi.encode("payminto.wallet.v1", paymentRef, paid)), so each payable state of a payment has
 * exactly one wallet authorization.
 */
export function walletPaymentNonce(paymentRefHex: Hex, paid: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "uint256" }], ["payminto.wallet.v1", paymentRefHex, paid]));
}

/** The per-payment CREATE2 salt passed to DepositFactory. */
export function depositSalt(chainId: number, paymentId: string): Hex {
  return tagged("payminto.deposit.v1", chainId, paymentId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Deposit forwarders (GATEWAY.md section 14.2)

/** DepositForwarder.Terms: what a deposit address is bound to. `fee` (base units of `token`) is at most `amountDue`. */
export type DepositTerms = {
  token: Address;
  payout: Address;
  /** Zero address allowed only when `fee` is 0. */
  feeRecipient: Address;
  fee: bigint;
  amountDue: bigint;
};

const depositTermsParams = [
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
] as const;

/** Throws exactly where DepositFactory.addressOf reverts, so no address is handed out for terms that cannot flush. */
export function assertDepositTerms(t: DepositTerms): void {
  if (BigInt(t.payout) === 0n) throw new Error("deposit terms: payout is the zero address");
  if (t.amountDue <= 0n) throw new Error("deposit terms: amountDue must be positive");
  if (t.fee < 0n || t.fee > t.amountDue) throw new Error("deposit terms: fee must be between 0 and amountDue");
  if (t.fee !== 0n && BigInt(t.feeRecipient) === 0n) throw new Error("deposit terms: a non-zero fee needs a feeRecipient");
}

/** abi.encode(terms): the clone's immutable args. */
export function encodeDepositTerms(t: DepositTerms): Hex {
  return encodeAbiParameters(depositTermsParams, [t.token, t.payout, t.feeRecipient, t.fee, t.amountDue]);
}

/** DepositForwarder.Terms as viem contract args. */
export function depositTermsArg(t: DepositTerms) {
  return { token: t.token, payout: t.payout, feeRecipient: t.feeRecipient, fee: t.fee, amountDue: t.amountDue };
}

/** EIP-1167 clone with immutable args, as OpenZeppelin Clones.cloneDeterministicWithImmutableArgs deploys it. */
function cloneCreationCode(implementation: Address, args: Hex): Hex {
  const impl = getAddress(implementation).slice(2).toLowerCase();
  const runtimeLength = ((args.length - 2) / 2 + 0x2d).toString(16).padStart(4, "0");
  return `0x61${runtimeLength}3d81600a3d39f3363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3${args.slice(2)}`;
}

/** Off-chain DepositFactory.addressOf(terms, salt): needs no RPC once the implementation address is known. */
export function predictForwarder(factory: Address, implementation: Address, terms: DepositTerms, salt: Hex): Address {
  assertDepositTerms(terms);
  return getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt,
    bytecode: cloneCreationCode(implementation, encodeDepositTerms(terms)),
  });
}

/** Reads DepositFactory.implementation(), for callers without depositForwarderImplementation from deployments. */
export async function readForwarderImplementation(client: Pick<PublicClient, "readContract">, factory: Address): Promise<Address> {
  return client.readContract({ address: factory, abi: depositFactoryAbi, functionName: "implementation" });
}

/** Calldata for DepositFactory.flush(terms, salt, token). Permissionless; deploys the forwarder when needed. */
export function depositFlushData(terms: DepositTerms, salt: Hex, token: Address = terms.token): Hex {
  return encodeFunctionData({ abi: depositFactoryAbi, functionName: "flush", args: [depositTermsArg(terms), salt, token] });
}

/**
 * Cumulative fee owed once `paid` has arrived toward a payment: min(fee, floor(paid * fee / amountDue)). This is the
 * forwarder's on-chain rule; a router payment toward a partly paid payment should carry
 * proRataFee(paid + value) - proRataFee(paid) so every rail splits the same way.
 */
export function proRataFee(p: { fee: bigint; amountDue: bigint; paid: bigint }): bigint {
  if (p.amountDue <= 0n) throw new Error("amountDue must be positive");
  if (p.paid <= 0n) return 0n;
  const share = (p.paid * p.fee) / p.amountDue;
  return share < p.fee ? share : p.fee;
}

// ---------------------------------------------------------------------------------------------------------------------
// EIP-3009 (Circle FiatToken v2)

/** The token's own EIP-712 domain, e.g. `{name: "Bridged USDC", version: "2"}` for USDC.e (see chains.ts). */
export type TokenDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

const authorizationFields = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export const transferWithAuthorizationTypes = { TransferWithAuthorization: authorizationFields } as const;
export const receiveWithAuthorizationTypes = { ReceiveWithAuthorization: authorizationFields } as const;

/** The six signed fields of an EIP-3009 transfer or receive authorization. */
export type TransferAuthorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};
export type ReceiveAuthorization = TransferAuthorization;

/** JSON-safe authorization: uint256 fields as decimal strings. */
export type TransferAuthorizationJson = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};
export type ReceiveAuthorizationJson = TransferAuthorizationJson;

export function transferAuthorizationTypedData(domain: TokenDomain, message: TransferAuthorization) {
  return { domain, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization" as const, message };
}

export function receiveAuthorizationTypedData(domain: TokenDomain, message: ReceiveAuthorization) {
  return { domain, types: receiveWithAuthorizationTypes, primaryType: "ReceiveWithAuthorization" as const, message };
}

export function transferAuthorizationToJson(m: TransferAuthorization): TransferAuthorizationJson {
  return { ...m, value: m.value.toString(), validAfter: m.validAfter.toString(), validBefore: m.validBefore.toString() };
}

export function transferAuthorizationFromJson(j: TransferAuthorizationJson): TransferAuthorization {
  return { ...j, value: BigInt(j.value), validAfter: BigInt(j.validAfter), validBefore: BigInt(j.validBefore) };
}

/** Recovers the EOA that signed a TransferWithAuthorization. Throws on a malformed signature. */
export async function recoverTransferAuthorizer(domain: TokenDomain, message: TransferAuthorization, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...transferAuthorizationTypedData(domain, message), signature });
}

/** Recovers the EOA that signed a ReceiveWithAuthorization. Throws on a malformed signature. */
export async function recoverReceiveAuthorizer(domain: TokenDomain, message: ReceiveAuthorization, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...receiveAuthorizationTypedData(domain, message), signature });
}

async function signedBy(recover: () => Promise<Address>, from: Address): Promise<boolean> {
  try {
    return isAddressEqual(await recover(), from);
  } catch {
    return false;
  }
}

/**
 * EOA checks that `message.from` signed. FiatToken v2.2 also accepts ERC-1271 wallets on chain; the node's simulation
 * before relaying covers those.
 */
export async function isTransferAuthorizationSignedBy(domain: TokenDomain, message: TransferAuthorization, signature: Hex): Promise<boolean> {
  return signedBy(() => recoverTransferAuthorizer(domain, message, signature), message.from);
}

export async function isReceiveAuthorizationSignedBy(domain: TokenDomain, message: ReceiveAuthorization, signature: Hex): Promise<boolean> {
  return signedBy(() => recoverReceiveAuthorizer(domain, message, signature), message.from);
}

// ---------------------------------------------------------------------------------------------------------------------
// PaymentRouter (GATEWAY.md section 14.2)

/** PaymentRouter.PaymentTerms. `fee` goes to `feeRecipient` (zero address allowed only when fee is 0). */
export type PaymentTerms = { paymentRef: Hex; payout: Address; feeRecipient: Address; fee: bigint };
export type PaymentTermsJson = Omit<PaymentTerms, "fee"> & { fee: string };

export function paymentTermsToJson(t: PaymentTerms): PaymentTermsJson {
  return { ...t, fee: t.fee.toString() };
}

export function paymentTermsFromJson(j: PaymentTermsJson): PaymentTerms {
  return { ...j, fee: BigInt(j.fee) };
}

/** The EIP-3009 nonce for router terms: keccak256(abi.encode(terms)), PaymentRouter.termsNonce. */
export function paymentTermsNonce(t: PaymentTerms): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [t.paymentRef, t.payout, t.feeRecipient, t.fee],
    ),
  );
}

/**
 * The ReceiveWithAuthorization a payer signs to pay through the router: to the router, nonce bound to the terms,
 * valid from 0 until `validBefore` (the payment expiry, unix seconds).
 */
export function routerAuthorization(p: {
  router: Address;
  terms: PaymentTerms;
  from: Address;
  value: bigint;
  validBefore: bigint | number;
}): ReceiveAuthorization {
  if (p.terms.fee > p.value) throw new Error("router terms: fee exceeds value");
  return {
    from: p.from,
    to: p.router,
    value: p.value,
    validAfter: 0n,
    validBefore: BigInt(p.validBefore),
    nonce: paymentTermsNonce(p.terms),
  };
}

/** Calldata for PaymentRouter.payWithAuthorization (packed-signature overload, which also takes ERC-1271 signatures). */
export function payWithAuthorizationData(token: Address, terms: PaymentTerms, message: ReceiveAuthorization, signature: Hex): Hex {
  return encodeFunctionData({
    abi: paymentRouterAbi,
    functionName: "payWithAuthorization",
    args: [token, terms, message.from, message.value, message.validAfter, message.validBefore, signature],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhook signatures (GATEWAY.md section 7)

export const WEBHOOK_SIGNATURE_HEADER = "Payminto-Signature";
export const WEBHOOK_EVENT_ID_HEADER = "Payminto-Event-Id";
export const WEBHOOK_EVENT_TYPE_HEADER = "Payminto-Event-Type";
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Delay before each attempt, in seconds: immediately, then 1 m, 5 m, 30 m, 2 h, 6 h, 24 h. */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS = [0, 60, 300, 1800, 7200, 21_600, 86_400] as const;

const utf8 = new TextEncoder();

async function hmacSha256Hex(secret: string, t: number, body: string | Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const prefix = utf8.encode(`${t}.`);
  const raw = typeof body === "string" ? utf8.encode(body) : body;
  const payload = new Uint8Array(prefix.length + raw.length);
  payload.set(prefix, 0);
  payload.set(raw, prefix.length);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, payload));
  let hex = "";
  for (const b of mac) hex += b.toString(16).padStart(2, "0");
  return hex;
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
 * True when the header carries a v1 signature of `rawBody` under `secret` and its timestamp is within
 * `toleranceSec` (default 300) of `now` (unix seconds, default the current time) in either direction.
 * Verify the raw request bytes, never a re-serialized JSON object.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<boolean> {
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
// Order commitment (GATEWAY.md section 13.2)

export type LineItem = { name: string; quantity: number; unit_amount: string };

/**
 * What a payment commits to, and exactly what `GET /v1/checkout/{id}/order` returns. `amount` is the merchant price.
 * Metadata is merchant-private, so the order carries only its hash (`metadataHash`), never the metadata itself.
 */
export type OrderCommitment = {
  payment_id: string;
  amount: string;
  token: Address;
  payout: Address;
  reference: string | null;
  description: string | null;
  line_items: LineItem[];
  metadata_hash: Hex;
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

/** keccak256 of the canonical JSON of the metadata, or the zero hash when there is none (absent or no keys). */
export function metadataHash(metadata: Record<string, string> | null | undefined): Hex {
  if (!metadata || Object.keys(metadata).length === 0) return zeroHash;
  return keccak256(toBytes(canonicalJson(metadata)));
}

/** The order as committed: addresses checksummed so every party serializes the same bytes. */
export function canonicalOrder(o: OrderCommitment): string {
  return canonicalJson({ ...o, token: getAddress(o.token), payout: getAddress(o.payout) });
}

/** `order_hash = keccak256(canonical JSON)` of the order a payment commits to. */
export function orderHash(o: OrderCommitment): Hex {
  return keccak256(toBytes(canonicalOrder(o)));
}

/** Sum of quantity x unit_amount, in base units. */
export function lineItemsTotal(items: readonly LineItem[]): bigint {
  return items.reduce((acc, i) => acc + BigInt(i.quantity) * BigInt(i.unit_amount), 0n);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fees (GATEWAY.md section 14.1)

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
 * The fee math of section 14.1, integers only:
 * platform_fee = clamp(fixed + floor(amount * bps / 10000), min_fee, max_fee);
 * method_fee = fee_fixed + floor(amount * fee_bps / 10000), added to amount_due as the surcharge when the customer
 * bears it. When fees would exceed amount_due, method_fee is kept (it is what the surcharge line shows) and
 * platform_fee is cut, so fee_total == amount_due at most. `method: null` means no method fee.
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
  return {
    amount,
    surcharge,
    amount_due: amountDue,
    platform_fee: platform,
    method_fee: methodFee,
    fee_total: feeTotal,
    net_amount: amountDue - feeTotal,
  };
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
// EIP-681

/** `ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<amount>` for wallets that scan a QR code. */
export function erc20TransferUri(p: { token: Address; chainId: number; to: Address; amount: bigint | string }): string {
  const amount = BigInt(p.amount);
  if (amount < 0n) throw new Error("amount must be non-negative");
  return `ethereum:${getAddress(p.token)}@${p.chainId}/transfer?address=${getAddress(p.to)}&uint256=${amount}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Public JSON types (GATEWAY.md section 8). Amounts are decimal strings of token base units; `*_at` fields are
// ISO 8601 strings like the rest of the node; `created` on webhook events is unix seconds.

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
/** Events an endpoint can subscribe to. `ping` is only sent by the test route. */
export const WEBHOOK_EVENT_TYPES = [...PAYMENT_EVENT_TYPES, ...REFUND_EVENT_TYPES] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];
export type RefundEventType = (typeof REFUND_EVENT_TYPES)[number];
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
  chain_id: number;
  token: Address;
  /** The payment's DepositForwarder address (deterministic; may have no code yet). */
  deposit_address: Address;
  description: string | null;
  reference: string | null;
  customer_email: string | null;
  customer_name: string | null;
  metadata: Record<string, string>;
  /** Items the order is made of (may be empty); their total equals amount_due. */
  line_items: LineItem[];
  /** keccak256 of the canonical order JSON (section 13.2). */
  order_hash: Hex;
  link_id: string | null;
  /** Payer of the first credit, once there is one. */
  payer: Address | null;
  /** The method the fees were quoted for: set at creation for API and x402 payments, at checkout for people. */
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
  /** HSP order and status (section 17); null when the payment never had an HSP order. */
  hsp: PaymentHsp | null;
};

/** One on-chain transfer (or accepted voucher) toward a payment. Unique by (tx_hash, log_index). */
export type Credit = {
  payment_id: string;
  method: PaymentMethod;
  payer: Address | null;
  amount: string;
  /** Null for a voucher until its clearing batch settles. */
  tx_hash: Hex | null;
  log_index: number | null;
  block_number: number | null;
  /** Clearing batch for a voucher credit. */
  batch_id: Hex | null;
  /** Confirmed means at or below the node's finality tag. Pending credits do not count toward amount_paid. */
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
  /** Shown in the service directory (section 13.4). */
  listed: boolean;
  max_payments: number | null;
  payments_count: number;
  paid_total: string;
  created_at: string;
  updated_at: string;
};

export type Refund = {
  id: string;
  livemode: boolean;
  payment_id: string;
  amount: string;
  reason: string | null;
  to: Address;
  status: RefundStatus;
  /** How the payout wallet executed it, once submitted. */
  method: "authorization" | "transfer" | null;
  tx_hash: Hex | null;
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
  /** Platform treasury (env PLATFORM_FEE_ADDRESS); required once any fee is non-zero. */
  fee_recipient: Address | null;
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
  payout: Address;
  support_email: string | null;
  brand_color: string | null;
  logo_url: string | null;
  fee_plan_id: string;
  created_at: string;
  updated_at: string;
};

/** `GET /v1/merchant`: the merchant plus read-only node facts. */
export type MerchantProfile = Merchant & {
  chain_id: number;
  token: Address;
  deposit_factory: Address;
  payment_router: Address;
  checkout_base_url: string;
};

/**
 * EIP-3009 ReceiveWithAuthorization a checkout asks the wallet to sign, to the PaymentRouter with the nonce bound to
 * `terms`; `from` is filled in once the payer's wallet connects. The node relays it with the same `terms`.
 */
export type CheckoutAuthorizationTemplate = {
  domain: TokenDomain;
  types: typeof receiveWithAuthorizationTypes;
  primaryType: "ReceiveWithAuthorization";
  message: Omit<ReceiveAuthorizationJson, "from">;
  router: Address;
  terms: PaymentTermsJson;
};

/**
 * EIP-3009 TransferWithAuthorization a checkout asks the wallet to sign (GATEWAY.md section 3): to the payment's
 * fee-splitting forwarder (whose address commits to payout, fee recipient, fee and amount due), for the remaining
 * amount, valid until the payment expires, with `walletPaymentNonce`. `from` is filled in once the wallet connects.
 */
export type CheckoutTransferTemplate = {
  domain: TokenDomain;
  types: typeof transferWithAuthorizationTypes;
  primaryType: "TransferWithAuthorization";
  message: Omit<TransferAuthorizationJson, "from">;
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
  chain_id: number;
  token: { address: Address; symbol: string; decimals: number };
  deposit_address: Address;
  /** EIP-681 URI for the remaining amount to deposit_address. */
  deposit_uri: string;
  /** The method the amounts are quoted for; null until a person picks one. Re-quote with /quote?method=. */
  method: PaymentMethod | null;
  /** Methods a person can use on this page right now. */
  methods: PaymentMethod[];
  /** Null once the payment is terminal or expired, or when `wallet` is not offered. */
  authorization: CheckoutTransferTemplate | null;
  success_url: string | null;
  /** Latest confirmed credit transaction, for the success screen. */
  tx_hash: Hex | null;
  /** keccak256 of the canonical order JSON (section 13.2). */
  order_hash: Hex;
  expires_at: string;
  created_at: string;
  /** HSP availability and status (section 17); null when this node has no HSP. */
  hsp: CheckoutHsp | null;
};

/** Builds the sign-ready typed data from a checkout template (either kind) and the connected payer. */
export function checkoutTypedData(template: CheckoutTransferTemplate, from: Address): ReturnType<typeof transferAuthorizationTypedData>;
export function checkoutTypedData(template: CheckoutAuthorizationTemplate, from: Address): ReturnType<typeof receiveAuthorizationTypedData>;
export function checkoutTypedData(template: CheckoutTransferTemplate | CheckoutAuthorizationTemplate, from: Address) {
  const message = transferAuthorizationFromJson({ ...template.message, from });
  return template.primaryType === "TransferWithAuthorization"
    ? transferAuthorizationTypedData(template.domain, message)
    : receiveAuthorizationTypedData(template.domain, message);
}

/** The TransferWithAuthorization template a node puts in CheckoutView.authorization for the `wallet` method. */
export function checkoutTransferTemplate(p: {
  domain: TokenDomain;
  /** The payment's current deposit forwarder. */
  forwarder: Address;
  /** paymentRef of the payment. */
  paymentRef: Hex;
  /** Confirmed amount already paid (base units); part of the nonce. */
  paid: bigint;
  /** The remaining amount. */
  value: bigint;
  /** Payment expiry, unix seconds. */
  expiresAt: bigint | number;
}): CheckoutTransferTemplate {
  const { from: _from, ...message } = transferAuthorizationToJson(walletTransferAuthorization({ ...p, from: "0x0000000000000000000000000000000000000000" }));
  return { domain: p.domain, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message };
}

/** The full TransferWithAuthorization behind checkoutTransferTemplate, for a known payer (what the node relays). */
export function walletTransferAuthorization(p: { forwarder: Address; paymentRef: Hex; paid: bigint; value: bigint; expiresAt: bigint | number; from: Address }): TransferAuthorization {
  return { from: p.from, to: getAddress(p.forwarder), value: p.value, validAfter: 0n, validBefore: BigInt(p.expiresAt), nonce: walletPaymentNonce(p.paymentRef, p.paid) };
}

/** The template a node puts in CheckoutView.authorization for `value` (the remaining amount) under `terms`. */
export function checkoutAuthorizationTemplate(p: {
  domain: TokenDomain;
  router: Address;
  terms: PaymentTerms;
  value: bigint;
  /** Payment expiry, unix seconds. */
  expiresAt: bigint | number;
}): CheckoutAuthorizationTemplate {
  const { from: _from, ...message } = transferAuthorizationToJson(
    routerAuthorization({ router: p.router, terms: p.terms, from: "0x0000000000000000000000000000000000000000", value: p.value, validBefore: p.expiresAt }),
  );
  return {
    domain: p.domain,
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message,
    router: p.router,
    terms: paymentTermsToJson(p.terms),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reconciliation report (docs/GATEWAY.md section 16): `GET /v1/reports/reconciliation`.
// Amounts are decimal token units with the token's decimals ("12.500000"); `base_units` repeats them in base units.

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
  "hsp_flow_id",
  "hsp_status",
  "screening_rules",
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
  tx_hash: Hex | null;
  explorer_url: string | null;
  created_at: string;
};

/** One credit of the payment: an on-chain transfer, or an agent charge settled in a clearing batch. */
export type ReconciliationTransaction = {
  /** The method that paid this credit, read as stored (never a fixed list). */
  method: string;
  amount: string;
  amount_base_units: string;
  status: "pending" | "confirmed";
  /** The payer's transfer, or the batch settlement transaction for an agent charge. */
  tx_hash: Hex | null;
  explorer_url: string | null;
  batch_id: Hex | null;
  call_id: Hex | null;
  /** Public JSON proof of an agent charge: its Merkle path to the batch's receipts root on chain. */
  receipt_proof_url: string | null;
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
  payer: Address | null;
  currency: string;
  refunds: ReconciliationRefund[];
  transactions: ReconciliationTransaction[];
  batch_ids: Hex[];
  /** The public payment proof page, for paid and overpaid payments. */
  proof_url: string | null;
  hsp_flow_id: string | null;
  hsp_status: string | null;
  /** Screening rules that refused a payer for this payment (for example PAYER_DENIED). */
  screening_rules: string[];
};

export type ReconciliationReport = {
  object: "reconciliation_report";
  merchant_id: string;
  business_name: string;
  /** Inclusive start and exclusive end of the range, ISO 8601 UTC. Rows are the payments created in it. */
  from: string;
  to: string;
  generated_at: string;
  chain_id: number;
  livemode: boolean;
  token: { address: Address; symbol: string; decimals: number };
  totals: ReportAmounts<ReportTotalField> & { payments: number };
  counts: Record<string, number>;
  by_method: Record<string, ReportAmounts<"gross" | "fees" | "net" | "refunds"> & { payments: number }>;
  /** Agent charges of the range against the clearing ledger's call.accepted journals for the same calls. */
  ledger: { calls: number; charges: string; ledger_accepted: string; base_units: { charges: string; ledger_accepted: string }; matches: boolean };
  rows: ReconciliationRow[];
};
