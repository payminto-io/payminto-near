/**
 * x402 v2 transport for Payminto vouchers on NEAR.
 *
 * A seller answers an unpaid request with HTTP 402 and `PAYMENT-REQUIRED` (base64 JSON `PaymentRequired`).
 * The agent retries with `PAYMENT-SIGNATURE` (base64 JSON `PaymentPayload`): the requirement it `accepted`, and a
 * cumulative voucher signed with its ed25519 Budget key over the frozen voucher digest, bound to the request hash.
 * The seller answers with `PAYMENT-RESPONSE` (base64 JSON settlement response): `success: true` with an empty
 * `transaction`, because settlement is deferred to a netted batch, or `success: false` with the rule in `errorReason`.
 *
 * The scheme is our own, `payminto-voucher`, so standard x402 clients ignore it. Budget routes never offer `exact`,
 * which would bypass the Budget policy. Split payments are one `accepts` entry with `extra.splits` and
 * `payload.vouchers[]`; several `accepts` entries are always alternatives, never a split.
 *
 * Every header is parsed with the zod schemas below. A header with another `x402Version` is refused as
 * UNSUPPORTED_VERSION, never guessed at.
 */
import { z } from "zod";
import {
  isAccountId,
  isPublicKey,
  verifyDigest,
  voucherDigest,
  type AccountId,
  type Claim,
  type Id32,
  type Network,
  type PublicKey,
  type Sig64,
  type Voucher,
} from "@payminto/chain";
import { APPROVE_AT_MAX } from "./policy.ts";

export const X402_VERSION = 2;
export const SCHEME = "payminto-voucher";

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

/** Networks the voucher scheme names. Mainnet is a valid wire value; no node in this repository runs on it. */
export const X402_NETWORKS = ["near:testnet", "near:mainnet", "near:sandbox"] as const satisfies readonly Network[];

/** Most vouchers one payment may carry (a merchant and a platform fee). */
export const MAX_SPLITS = 2;

/** Encoded headers above this size are refused before they are decoded. */
export const MAX_HEADER_CHARS = 16_384;

// ------------------------------------------------------------------------------------------------- primitives

const DECIMAL = /^(0|[1-9]\d{0,77})$/;
const U128_MAX = 2n ** 128n - 1n;

export const zAccountId = z.string().refine((v) => isAccountId(v), "must be a NEAR account id").transform((v) => v as AccountId);
export const zId32 = z.string().regex(/^[0-9a-f]{64}$/, "must be 32 bytes as 64 lowercase hex characters").transform((v) => v as Id32);
export const zSig64 = z.string().regex(/^[0-9a-f]{128}$/, "must be a 64-byte signature as 128 lowercase hex characters").transform((v) => v as Sig64);
export const zPublicKey = z.string().refine((v) => isPublicKey(v), "must be an ed25519:<base58> public key").transform((v) => v as PublicKey);
export const zNetwork = z.enum(X402_NETWORKS);
/**
 * A u128 in atomic units as a canonical decimal string (no sign, no leading zeros).
 * zod runs every check even after one failed, so the size checks test the format themselves: `BigInt("1.5")` throws,
 * and a malformed amount in a header must be a failed parse, never an exception.
 */
const isDecimal = (v: string): boolean => DECIMAL.test(v);
export const zAtomic = z
  .string()
  .regex(DECIMAL, "must be a whole number of atomic units as a decimal string")
  .refine((v) => !isDecimal(v) || BigInt(v) <= U128_MAX, "must fit in u128");
export const zPositiveAtomic = zAtomic.refine((v) => !isDecimal(v) || BigInt(v) > 0n, "must be positive");

// ------------------------------------------------------------------------------------------------- PAYMENT-REQUIRED

export const resourceInfoSchema = z.object({
  url: z.string().min(1).max(2048),
  description: z.string().max(1000),
  mimeType: z.string().max(200).optional(),
});
export type ResourceInfo = z.infer<typeof resourceInfoSchema>;

export const voucherSplitSchema = z.object({ payTo: zAccountId, amount: zPositiveAtomic, providerId: z.string().min(1).max(64) });
export type VoucherSplit = z.infer<typeof voucherSplitSchema>;

export const voucherExtraSchema = z.object({
  /** The clearing contract on NEAR that settles these vouchers. */
  clearingHub: zAccountId,
  /** Base URL of the clearing node that clears this seller. Informational: an agent talks to its own node only. */
  clearingNode: z.string().min(1).max(2048),
  providerId: z.string().min(1).max(64),
  tokenSymbol: z.string().min(1).max(16),
  tokenDecimals: z.number().int().min(0).max(24),
  /** Present only on a split payment: one voucher per entry, in this order, summing to `amount`. */
  splits: z.array(voucherSplitSchema).min(2).max(MAX_SPLITS).optional(),
});

/** One `accepts` entry for the voucher scheme. */
export const voucherRequirementSchema = z
  .object({
    scheme: z.literal(SCHEME),
    network: zNetwork,
    /** Price of this call in atomic units of `asset`; the sum of the splits on a split payment. */
    amount: zPositiveAtomic,
    /** The NEP-141 settlement token contract. */
    asset: zAccountId,
    payTo: zAccountId,
    maxTimeoutSeconds: z.number().int().min(1).max(86_400),
    extra: voucherExtraSchema,
  })
  .superRefine((r, ctx) => {
    const splits = r.extra.splits;
    if (!splits) return;
    if (splits.reduce((s, x) => s + BigInt(x.amount), 0n) !== BigInt(r.amount)) ctx.addIssue({ code: "custom", path: ["extra", "splits"], message: "splits must sum to amount" });
    if (splits[0]!.payTo !== r.payTo) ctx.addIssue({ code: "custom", path: ["extra", "splits"], message: "the first split must pay payTo" });
    if (new Set(splits.map((x) => x.payTo)).size !== splits.length) ctx.addIssue({ code: "custom", path: ["extra", "splits"], message: "split payees must be distinct" });
  });
export type VoucherRequirement = z.infer<typeof voucherRequirementSchema>;

/** `PAYMENT-REQUIRED`. `accepts` may list other schemes too; a voucher client picks entries that parse as its scheme. */
export const paymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().max(200).optional(),
  resource: resourceInfoSchema,
  accepts: z.array(z.unknown()).max(16),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequired = Omit<z.infer<typeof paymentRequiredSchema>, "accepts"> & { accepts: Array<VoucherRequirement | Record<string, unknown>> };

// ------------------------------------------------------------------------------------------------- PAYMENT-SIGNATURE

/** One signed voucher as it travels. Strict: an agent signs exactly these fields and nothing else rides along. */
export const voucherFieldsShape = {
  budgetId: zId32,
  payee: zAccountId,
  amount: zPositiveAtomic,
  cumulative: zPositiveAtomic,
  requestHash: zId32,
  publicKey: zPublicKey,
  signature: zSig64,
};
export const voucherFieldsSchema = z
  .strictObject(voucherFieldsShape)
  .refine((v) => BigInt(v.cumulative) >= BigInt(v.amount), { message: "cumulative must be at least amount", path: ["cumulative"] });
export type VoucherFields = z.infer<typeof voucherFieldsSchema>;

export const splitVouchersSchema = z.strictObject({ vouchers: z.array(voucherFieldsSchema).min(2).max(MAX_SPLITS) });

/** `PAYMENT-SIGNATURE`. */
export const paymentPayloadSchema = z
  .strictObject({
    x402Version: z.literal(X402_VERSION),
    resource: resourceInfoSchema.optional(),
    accepted: voucherRequirementSchema,
    payload: z.union([voucherFieldsSchema, splitVouchersSchema]),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((p, ctx) => {
    const vouchers = "vouchers" in p.payload ? p.payload.vouchers : [p.payload];
    const splits = p.accepted.extra.splits;
    const expected = splits ?? [{ payTo: p.accepted.payTo, amount: p.accepted.amount }];
    if (vouchers.length !== expected.length) {
      ctx.addIssue({ code: "custom", path: ["payload"], message: splits ? "a split payment carries one voucher per split" : "a single requirement carries one voucher" });
      return;
    }
    vouchers.forEach((v, i) => {
      if (v.payee !== expected[i]!.payTo || v.amount !== expected[i]!.amount) ctx.addIssue({ code: "custom", path: ["payload", i], message: "voucher payee and amount must match the accepted requirement" });
      if (v.budgetId !== vouchers[0]!.budgetId || v.requestHash !== vouchers[0]!.requestHash || v.publicKey !== vouchers[0]!.publicKey) {
        ctx.addIssue({ code: "custom", path: ["payload", i], message: "split vouchers must share Budget, request hash and key" });
      }
    });
  });
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;

/** The vouchers a payload carries, in requirement order. */
export const vouchersOf = (p: Pick<PaymentPayload, "payload">): VoucherFields[] => ("vouchers" in p.payload ? p.payload.vouchers : [p.payload]);

// ------------------------------------------------------------------------------------------------- PAYMENT-RESPONSE

export type ClearingReceipt = {
  callId: Id32;
  budgetId: Id32;
  payee: AccountId;
  amount: string;
  cumulative: string;
  requestHash: Id32;
  /** Unix seconds when this node accepted the call. Node-attested, not proven on chain. */
  timestamp: number;
  voucherSig: Sig64;
  /** `nodeDigest` of the fields above: what the node signed. */
  digest: Id32;
  nodeSignature: Sig64;
  /** The key the node signs receipts with. */
  node: PublicKey;
};

export const clearingReceiptSchema = z.object({
  callId: zId32,
  budgetId: zId32,
  payee: zAccountId,
  amount: zAtomic,
  cumulative: zAtomic,
  requestHash: zId32,
  timestamp: z.number().int().nonnegative(),
  voucherSig: zSig64,
  digest: zId32,
  nodeSignature: zSig64,
  node: zPublicKey,
}) satisfies z.ZodType<ClearingReceipt>;

/** The owner wallet action a `fund` hint can offer: move withdrawable hub credit into this Budget's escrow. */
export const creditFundingSchema = z.object({ action: z.literal("fund_from_credit"), budgetId: zId32, amount: zAtomic, credit: zAtomic });

/**
 * Where the owner approves a payee: an http(s) URL without credentials, on one line, at most APPROVE_AT_MAX characters.
 * The node builds it from its own configured dashboard URL. It is shown to people, and nothing here fetches it.
 */
const zApproveAt = z
  .string()
  .max(APPROVE_AT_MAX)
  .refine((v) => {
    // Printable ASCII only: no spaces, line breaks, control characters or look-alike letters.
    if (!/^[\x21-\x7e]+$/.test(v)) return false;
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.hostname !== "";
    } catch {
      return false;
    }
  }, "must be an http(s) URL without credentials");

export const retryHintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }),
  z.object({ kind: z.literal("after"), seconds: z.number().nonnegative(), reason: z.enum(["hub_unreadable"]).optional() }),
  z.object({ kind: z.literal("after_settlement") }),
  z.object({ kind: z.literal("fund"), shortBy: zAtomic, fromCredit: creditFundingSchema.optional() }),
  z.object({ kind: z.literal("resign"), expectedCumulative: zAtomic }),
  // Strict: an approval hint names one payee and one page of the node's dashboard, and nothing else rides along.
  z.strictObject({ kind: z.literal("approval"), payee: zAccountId, approveAt: zApproveAt }),
]);

/** The machine-readable refusal: rule, attempted amount, remaining Budget and retry hint. */
export const refusalSchema = z.object({
  rule: z.string().min(1).max(64),
  message: z.string().max(500),
  attemptedAmount: zAtomic,
  remainingBudget: zAtomic.nullable(),
  retry: retryHintSchema,
});

/** A refusal on the wire. Its rule is any code, so it also carries agent-side rules such as CLIENT_MAX_PRICE. */
export type RefusalWire = z.infer<typeof refusalSchema>;

export const positionSchema = z.object({ budgetId: zId32, payee: zAccountId, cumulative: zAtomic, settled: zAtomic });
export type Position = z.infer<typeof positionSchema>;

export const settlementSuccessSchema = z.object({
  success: z.literal(true),
  /** Empty: the call is cleared now and settles later in a netted batch on NEAR. */
  transaction: z.literal(""),
  network: zNetwork,
  /** The agent key that signed the voucher. */
  payer: zPublicKey.optional(),
  /** One receipt per voucher, in requirement order. */
  receipts: z.array(clearingReceiptSchema).min(1).max(MAX_SPLITS),
  /** The (Budget, payee) positions after this call. */
  positions: z.array(positionSchema).max(MAX_SPLITS).optional(),
});
export type SettlementSuccess = z.infer<typeof settlementSuccessSchema>;

export const settlementFailureSchema = z.object({
  success: z.literal(false),
  /** The rule that fired, for example PAYEE_NOT_ALLOWED, or a transport code such as INVALID_PAYMENT. */
  errorReason: z.string().min(1).max(64),
  transaction: z.literal(""),
  network: zNetwork,
  payer: zPublicKey.optional(),
  refusal: refusalSchema.optional(),
});
export type SettlementFailure = z.infer<typeof settlementFailureSchema>;

export const settlementResponseSchema = z.discriminatedUnion("success", [settlementSuccessSchema, settlementFailureSchema]);
export type SettlementResponse = SettlementSuccess | SettlementFailure;

// ------------------------------------------------------------------------------------------------- codec

// Runtime-neutral base64 (Node, browsers, edge) over UTF-8 bytes.
function toBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeHeader(value: unknown): string {
  return toBase64(JSON.stringify(value));
}

/** Decodes base64 JSON, or null for anything that is not exactly that. Never throws. */
export function decodeHeader<T>(value: string | null | undefined): T | null {
  if (!value || value.length > MAX_HEADER_CHARS || !BASE64.test(value)) return null;
  try {
    return JSON.parse(fromBase64(value)) as T;
  } catch {
    return null;
  }
}

export type HeaderError = { ok: false; code: "MISSING" | "TOO_LARGE" | "MALFORMED" | "UNSUPPORTED_VERSION" | "INVALID"; message: string };
export type HeaderResult<T> = { ok: true; value: T } | HeaderError;

function issue(e: z.ZodError): string {
  const i = e.issues[0];
  return i ? `${i.path.join(".") || "value"}: ${i.message}` : "invalid";
}

/** Validates an already decoded value (a header, or a JSON body that repeats it). */
export function parseValue<S extends z.ZodType>(schema: S, value: unknown, o: { versioned: boolean; what: string }): HeaderResult<z.output<S>> {
  if (o.versioned) {
    const version = value !== null && typeof value === "object" ? (value as { x402Version?: unknown }).x402Version : undefined;
    if (version !== X402_VERSION) {
      return { ok: false, code: "UNSUPPORTED_VERSION", message: `${o.what} has x402Version ${JSON.stringify(version ?? null)}; only ${X402_VERSION} is supported` };
    }
  }
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, code: "INVALID", message: `${o.what} is invalid: ${issue(r.error)}` };
}

function parseHeader<S extends z.ZodType>(schema: S, raw: string | null | undefined, o: { versioned: boolean; what: string }): HeaderResult<z.output<S>> {
  if (!raw) return { ok: false, code: "MISSING", message: `${o.what} header is missing` };
  if (raw.length > MAX_HEADER_CHARS) return { ok: false, code: "TOO_LARGE", message: `${o.what} header is larger than ${MAX_HEADER_CHARS} characters` };
  const value = decodeHeader<unknown>(raw);
  if (value === null) return { ok: false, code: "MALFORMED", message: `${o.what} header is not base64 JSON` };
  return parseValue(schema, value, o);
}

export const parsePaymentRequired = (raw: string | null | undefined) => parseHeader(paymentRequiredSchema, raw, { versioned: true, what: HEADER_REQUIRED });
export const parsePaymentSignature = (raw: string | null | undefined) => parseHeader(paymentPayloadSchema, raw, { versioned: true, what: HEADER_SIGNATURE });
/** Settlement responses carry no x402Version in v2. */
export const parsePaymentResponse = (raw: string | null | undefined) => parseHeader(settlementResponseSchema, raw, { versioned: false, what: HEADER_RESPONSE });

/** The `accepts` entries that are valid voucher requirements for this network and hub, in the seller's order. */
export function voucherRequirements(pr: { accepts: readonly unknown[] }, network: Network, hub: AccountId): VoucherRequirement[] {
  return pr.accepts.flatMap((a) => {
    const r = voucherRequirementSchema.safeParse(a);
    return r.success && r.data.network === network && r.data.extra.clearingHub === hub ? [r.data] : [];
  });
}

/** Two requirements ask for the same payment: same scheme, network, asset, payees, amounts, hub and provider. */
export function sameRequirement(a: VoucherRequirement, b: VoucherRequirement): boolean {
  const splits = (r: VoucherRequirement) => JSON.stringify((r.extra.splits ?? []).map((s) => [s.payTo, s.amount, s.providerId]));
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    a.amount === b.amount &&
    a.extra.clearingHub === b.extra.clearingHub &&
    a.extra.providerId === b.extra.providerId &&
    splits(a) === splits(b)
  );
}

// ------------------------------------------------------------------------------------------------- vouchers

export const voucherOf = (v: VoucherFields): Voucher => ({ budgetId: v.budgetId, payee: v.payee, amount: BigInt(v.amount), cumulative: BigInt(v.cumulative), requestHash: v.requestHash });

/** The claim `settle_batch` or `settle_own` takes for this voucher. */
export const claimOf = (v: VoucherFields): Claim => ({ ...voucherOf(v), signature: v.signature });

/** True when `publicKey` signed this voucher for `hub` and `network`. It does not prove the key is the Budget's agent key. */
export function voucherSignedBy(hub: AccountId, network: Network, v: VoucherFields): boolean {
  try {
    return verifyDigest(v.publicKey, voucherDigest(hub, network, voucherOf(v)), v.signature);
  } catch {
    return false;
  }
}

/** The body a seller posts to its clearing node's `POST /v1/vouchers`, one per voucher. */
export type VoucherPayment = {
  x402Version: typeof X402_VERSION;
  scheme: typeof SCHEME;
  network: Network;
  payload: { budgetId: Id32; payee: AccountId; amount: string; cumulative: string; requestHash: Id32; publicKey: PublicKey; signature: Sig64 };
};

export const nodeVoucherBody = (network: Network, v: VoucherFields): VoucherPayment => ({ x402Version: X402_VERSION, scheme: SCHEME, network, payload: { ...v } });

/**
 * @deprecated The pre-v2 requirement shape, with the resource inside each entry. Only the node gateway still builds
 * it; new code uses `VoucherRequirement` with `PaymentRequired.resource`.
 */
export type PaymentRequirement = {
  scheme: typeof SCHEME;
  network: Network;
  asset: AccountId;
  payTo: AccountId;
  amount: string;
  resource: string;
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra: { clearingNode: string; clearingHub: AccountId; providerId: string; tokenSymbol: string; tokenDecimals: number };
};

