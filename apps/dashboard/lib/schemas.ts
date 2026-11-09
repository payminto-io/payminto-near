/**
 * Wire shapes of the Clearing Node HTTP API (docs/SPEC.md 5.6 and 5.7).
 * Every response is parsed with these schemas at the trust boundary, so a backend shape change
 * surfaces as a clear "unexpected response" error instead of a silently wrong number.
 * Amounts are decimal strings of atomic units; they are only ever converted with BigInt.
 */
import { z } from "zod";
import { DENIAL_RULES, HSP_PAYMENT_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, type DenialRule } from "@payminto/protocol";
import type * as P from "@payminto/protocol";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex");
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an address");
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected bytes32");
/** Atomic units. Numbers are accepted and normalised so a backend that sends JSON numbers still parses. */
export const atomicSchema = z
  .union([z.string().regex(/^-?\d+$/, "expected an integer amount"), z.number().int(), z.bigint()])
  .transform((v) => v.toString());
/** ISO time or unix seconds, normalised to ISO. */
export const timeSchema = z.union([z.string(), z.number()]).transform((v) => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return /^\d+$/.test(v) ? new Date(Number(v) * 1000).toISOString() : v;
});

const denialRuleKeys = Object.keys(DENIAL_RULES) as [DenialRule, ...DenialRule[]];
export const denialRuleSchema = z.enum(denialRuleKeys);

export const tokenSchema = z.object({
  address: addressSchema,
  symbol: z.string(),
  decimals: z.number().int(),
  /** The token's own EIP-712 domain, as the node verified it on chain (newer nodes only). */
  eip712: z.object({ name: z.string(), version: z.string() }).optional(),
});
export type Token = z.infer<typeof tokenSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  chainId: z.number(),
  hub: addressSchema,
  token: z.union([addressSchema, tokenSchema]),
  operator: addressSchema,
  /** Null when the node cannot reach its RPC (the node then answers 503). */
  blockNumber: z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v))),
  hspMode: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

export const infoSchema = z.object({
  network: z.union([
    z.object({ chainId: z.number(), name: z.string() }).passthrough(),
    z.string().transform((name) => ({ chainId: 0, name })),
  ]),
  chainId: z.number().optional(),
  hub: addressSchema,
  token: tokenSchema,
  explorer: z.string().nullable().optional(),
  operator: addressSchema,
  version: z.string(),
  hspMode: z.string().optional(),
  operatorGasBalance: atomicSchema.optional(),
  settleIntervalSec: z.number().optional(),
  publicUrl: z.string().optional(),
  /** confirmTag: the head a batch must reach to count as final ("safe" on HashKey Chain, "latest" on a local chain). */
  settlement: z.object({ confirmTag: z.string().optional() }).passthrough().optional(),
  /** hspPayments: whether HashKey's HSP can take payments on this server now (GATEWAY.md section 17). */
  gateway: z
    .object({
      hspPayments: z
        .object({
          state: z.enum(["off", "checking", "available", "unavailable"]),
          reason: z.string().nullable().optional(),
          message: z.string().nullable().optional(),
          network: z.string().nullable().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});
export type Info = z.infer<typeof infoSchema>;

export const policySchema = z.object({
  perCallCap: atomicSchema,
  dailyCap: atomicSchema,
  maxCallsPerMinute: z.number(),
  purpose: z.string(),
});

export const mandateJsonSchema = z.object({
  owner: addressSchema,
  agent: addressSchema,
  token: addressSchema,
  totalCap: atomicSchema,
  validAfter: atomicSchema,
  validUntil: atomicSchema,
  payeesRoot: bytes32Schema,
  policyHash: bytes32Schema,
  salt: bytes32Schema,
});

export const mandateStatusSchema = z.enum(["pending", "open", "revoked", "expired", "failed"]);
export type MandateStatus = z.infer<typeof mandateStatusSchema>;

export const spendSchema = z.object({
  settled: atomicSchema,
  pending: atomicSchema,
  today: atomicSchema,
  remaining: atomicSchema,
});

export const callStatusSchema = z.enum(["accepted", "settled", "settling"]);

export const callSchema = z.object({
  id: bytes32Schema,
  mandateId: bytes32Schema,
  agent: addressSchema,
  payee: addressSchema,
  providerId: z.string().nullable().optional(),
  amount: atomicSchema,
  cumulative: atomicSchema,
  requestHash: bytes32Schema,
  status: callStatusSchema,
  batchId: bytes32Schema.nullable().optional(),
  createdAt: timeSchema,
});
export type Call = z.infer<typeof callSchema>;

export const denialSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  rule: denialRuleSchema,
  message: z.string(),
  mandateId: bytes32Schema.nullable().optional(),
  agent: addressSchema.nullable().optional(),
  payee: addressSchema.nullable().optional(),
  providerId: z.string().nullable().optional(),
  amount: atomicSchema.nullable().optional(),
  createdAt: timeSchema,
});
export type Denial = z.infer<typeof denialSchema>;

export const mandateSchema = z.object({
  id: bytes32Schema,
  label: z.string(),
  status: mandateStatusSchema,
  mandate: mandateJsonSchema,
  policy: policySchema,
  payees: z.array(addressSchema),
  spend: spendSchema,
  openTxHash: hex.nullable().optional(),
  revokedAt: timeSchema.nullable().optional(),
  createdAt: timeSchema,
  /** Wallet health the node tracks for the agent (balance and hub allowance, atomic units). */
  agentBalance: atomicSchema.nullable().optional(),
  agentAllowance: atomicSchema.nullable().optional(),
});
export type MandateRecord = z.infer<typeof mandateSchema>;

export const mandateDetailSchema = mandateSchema.extend({
  recentCalls: z.array(callSchema).default([]),
  denials: z.array(denialSchema).default([]),
  /** The hub's view of the mandate, when the node could read it. */
  onchain: z
    .object({ open: z.boolean(), revokedAt: z.number().nullable().optional(), spent: atomicSchema.optional() })
    .nullable()
    .optional(),
  /** Daily spend buckets for the chart; optional because the SPEC does not pin it. */
  spendSeries: z.array(z.object({ day: z.string(), amount: atomicSchema })).optional(),
  /** Per-minute spend for the last 30 minutes, so a fresh mandate shows a real curve. */
  spendRecent: z.array(z.object({ at: z.string(), amount: atomicSchema, calls: z.number().optional() })).optional(),
  /** Read from chain: opened from an EIP-2612 permit (no agent gas) and the agent wallet's transaction count. */
  onboarding: z.object({ gaslessPermit: z.boolean(), agentTransactions: z.number(), agentNativeBalance: atomicSchema.optional() }).nullable().optional(),
});
export type MandateDetail = z.infer<typeof mandateDetailSchema>;

export const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  payee: addressSchema,
  priceAtomic: atomicSchema,
  resource: z.string(),
  category: z.string(),
  calls24h: z.number().default(0),
  revenue: z
    .object({ settled: atomicSchema, pending: atomicSchema })
    .optional(),
  callsTotal: z.number().optional(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerCreatedSchema = z.object({ id: z.string(), apiKey: z.string() });

export const hspStatusSchema = z.enum(["PENDING", "COSIGNED", "UNSIGNED", "SUBMITTED", "SETTLED", "ACCEPT", "REJECT", "FAILED"]);
export type HspStatus = z.infer<typeof hspStatusSchema>;

export const netTransferSchema = z.object({
  from: addressSchema,
  to: addressSchema,
  amount: atomicSchema,
  logIndex: z.number().nullable().optional(),
  hsp: z
    .object({
      paymentId: hex.nullable().optional(),
      status: hspStatusSchema,
      reason: z.string().nullable().optional(),
      cosigned: z.boolean().optional(),
      updatedAt: timeSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type NetTransfer = z.infer<typeof netTransferSchema>;

export const claimSchema = z.object({
  mandateId: bytes32Schema,
  agent: addressSchema,
  payee: addressSchema,
  cumulative: atomicSchema,
  delta: atomicSchema,
  calls: z.number().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

/** included: one confirmation; confirmed: at or below the node's finality head (CONFIRM_TAG, safe on HashKey Chain). */
export const batchStatusSchema = z.enum(["building", "cosigning", "submitted", "included", "confirmed", "failed"]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const batchSchema = z.object({
  id: bytes32Schema,
  seq: z.number(),
  status: batchStatusSchema,
  receiptsRoot: bytes32Schema.nullable(),
  token: addressSchema,
  txHash: hex.nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
  gross: atomicSchema,
  net: atomicSchema,
  calls: z.number(),
  claims: z.number(),
  transfers: z.number(),
  gasUsed: atomicSchema.nullable().optional(),
  /** OP Stack L1 data fee in wei; null off OP Stack chains. */
  l1Fee: atomicSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: timeSchema,
  submittedAt: timeSchema.nullable().optional(),
  blockNumber: z.number().nullable().optional(),
  includedAt: timeSchema.nullable().optional(),
  confirmedAt: timeSchema.nullable().optional(),
  attestation: z.object({ uid: bytes32Schema, txHash: hex.nullable(), explorerUrl: z.string().nullable() }).nullable().optional(),
});
export type Batch = z.infer<typeof batchSchema>;

export const batchDetailSchema = batchSchema.extend({
  claimList: z.array(claimSchema),
  netTransfers: z.array(netTransferSchema),
});
export type BatchDetail = z.infer<typeof batchDetailSchema>;

export const overviewSchema = z.object({
  volume: z.object({ settled: atomicSchema, pending: atomicSchema }),
  calls: z.object({ last24h: z.number(), all: z.number() }),
  denials24h: z.number(),
  activeMandates: z.number(),
  providers: z.number(),
  batches: z.number(),
  gasSaved: z.object({
    /** Gas units avoided versus one ERC-20 transfer per call. */
    gas: atomicSchema,
    /** Same, priced in the native token (atomic, 18 dp) at the observed gas price, when known. */
    native: atomicSchema.nullable().optional(),
  }),
  compressionRatio: z.number(),
  lastBatch: batchSchema.nullable(),
});
export type Overview = z.infer<typeof overviewSchema>;

export const nettingPreviewSchema = z.object({
  token: addressSchema.optional(),
  gross: z.array(z.object({ from: addressSchema, to: addressSchema, amount: atomicSchema, calls: z.number() })),
  net: z.array(z.object({ from: addressSchema, to: addressSchema, amount: atomicSchema })),
  grossTotal: atomicSchema.optional(),
  netTotal: atomicSchema.optional(),
  calls: z.number().optional(),
  compression: z.number(),
  skipped: z
    .array(z.object({ mandateId: bytes32Schema, reason: z.string() }))
    .optional(),
});
export type NettingPreview = z.infer<typeof nettingPreviewSchema>;

export const settlementResultSchema = z.union([
  z.object({ batchIds: z.array(bytes32Schema) }),
  z.object({ skipped: z.string() }),
]);
export type SettlementResult = z.infer<typeof settlementResultSchema>;

export const receiptSchema = z.object({
  callId: bytes32Schema,
  mandateId: bytes32Schema,
  payee: addressSchema,
  amount: atomicSchema,
  cumulative: atomicSchema,
  requestHash: bytes32Schema,
  timestamp: z.number(),
  leaf: bytes32Schema,
  nodeSignature: hex,
  node: addressSchema,
});
export type Receipt = z.infer<typeof receiptSchema>;

export const proofSchema = z.object({
  receipt: receiptSchema,
  batchId: bytes32Schema.nullable(),
  receiptsRoot: bytes32Schema.nullable(),
  proof: z.array(bytes32Schema),
  leaf: bytes32Schema,
  txHash: hex.nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
  onchainVerified: z.boolean().nullable().optional(),
});
export type ReceiptProof = z.infer<typeof proofSchema>;

export const ledgerEntrySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  journalId: z.union([z.string(), z.number()]).transform(String),
  /** Journal kind, e.g. call.accepted or batch.settled, when the node reports it. */
  kind: z.string().nullable().optional(),
  account: z.string(),
  debit: atomicSchema,
  credit: atomicSchema,
  memo: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  createdAt: timeSchema,
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const trialBalanceSchema = z.object({
  accounts: z.array(z.object({ account: z.string(), debit: atomicSchema, credit: atomicSchema, balance: atomicSchema })),
  totalDebit: atomicSchema,
  totalCredit: atomicSchema,
  balance: atomicSchema,
});
export type TrialBalance = z.infer<typeof trialBalanceSchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.union([
    z.object({ items: z.array(item), nextCursor: z.string().nullable().optional() }),
    z.array(item).transform((items) => ({ items, nextCursor: null })),
  ]);

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export type EventType =
  | "call.accepted"
  | "call.denied"
  | "mandate.opened"
  | "mandate.revoked"
  | "batch.started"
  | "batch.submitted"
  | "batch.included"
  | "batch.confirmed"
  | "batch.failed"
  | "hsp.updated"
  | "funds.warning"
  | AgentRunEventType;

/**
 * Run updates on `/v1/events` (docs/AGENTS.md section 6): `data` carries `run_id` (or `id`), `agent_id`, `status` and,
 * for a new step, `event` with the step itself. The run page re-reads the run and its steps on each one.
 */
export const AGENT_RUN_EVENT_TYPES = [
  "agent_run.queued",
  "agent_run.started",
  "agent_run.step",
  "agent_run.updated",
  "agent_run.succeeded",
  "agent_run.failed",
  "agent_run.cancelled",
  "agent_run.timed_out",
] as const;
export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number];

export const EVENT_TYPES: readonly EventType[] = [
  "call.accepted",
  "call.denied",
  "mandate.opened",
  "mandate.revoked",
  "batch.started",
  "batch.submitted",
  "batch.included",
  "batch.confirmed",
  "batch.failed",
  "hsp.updated",
  "funds.warning",
  ...AGENT_RUN_EVENT_TYPES,
];

export type NodeEvent = { type: EventType; id: string; at: string; data: Record<string, unknown> };

export const revokeResultSchema = z.union([
  z.object({
    mandate: mandateSchema,
    onchain: z
      .object({
        revoked: z.boolean(),
        submitted: z.boolean().optional(),
        txHash: hex.nullable().optional(),
        call: z.object({ to: addressSchema, data: hex, allowedSenders: z.array(addressSchema).optional() }).nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  mandateSchema.transform((mandate) => ({ mandate, onchain: null })),
]);
export type RevokeResult = z.infer<typeof revokeResultSchema>;

// ---------------------------------------------------------------------------
// Gateway (docs/GATEWAY.md section 8). The wire shapes are the types in @payminto/protocol gateway.ts; the checks at
// the end of this section fail typecheck if a protocol type stops parsing with these schemas.
// Fields marked "dashboard extra" are optional additions the UI uses when the node sends them.
// ---------------------------------------------------------------------------

export { PAYMENT_STATUSES, PAYMENT_METHODS };
export { WEBHOOK_EVENT_TYPES } from "@payminto/protocol";
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

/** HSP status of a payment (GATEWAY.md section 17): order-created, then what HSP's query_payment reports. */
export const hspPaymentStatusSchema = z.enum(["order-created", ...HSP_PAYMENT_STATUSES]);
export type HspPaymentStatus = z.infer<typeof hspPaymentStatusSchema>;

/** The HSP part of the public checkout view; null when the business does not offer HSP. */
export const checkoutHspSchema = z.object({
  availability: z.enum(["off", "checking", "available", "unavailable"]),
  message: z.string().nullable(),
  status: hspPaymentStatusSchema.nullable(),
  status_reason: z.string().nullable(),
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]*$/).nullable(),
  attribution_verified: z.boolean(),
});
export type CheckoutHsp = z.infer<typeof checkoutHspSchema>;

/** The HSP fields of a payment on the merchant API and in webhooks. */
export const paymentHspSchema = z.object({
  flow_id: z.string(),
  payment_request_id: z.string().nullable(),
  status: hspPaymentStatusSchema,
  status_reason: z.string().nullable(),
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]*$/).nullable(),
  attribution_verified: z.boolean(),
  payer: addressSchema.nullable(),
  submitted_at: timeSchema.nullable(),
  updated_at: timeSchema.nullable(),
});
export type PaymentHsp = z.infer<typeof paymentHspSchema>;

/** POST /v1/checkout/{id}/hsp/prepare: HSP's EIP-712 data for the payer to sign, exactly as HSP returned it. */
export const hspPrepareSchema = z.object({
  payment_id: z.string(),
  flow_id: z.string(),
  protocol: z.string(),
  eip712: z.object({
    domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    primaryType: z.string(),
    message: z.record(z.string(), z.unknown()),
  }),
  token_total_raw: z.string(),
  quote_expires_at: z.string(),
  recipient: addressSchema,
  payer: addressSchema,
});
export type HspPrepared = z.infer<typeof hspPrepareSchema>;

export const hspSubmitResultSchema = z.object({ status: z.enum(PAYMENT_STATUSES), hsp: paymentHspSchema.nullable() }).passthrough();
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

const nullableTime = timeSchema.nullable().optional();
const nullableString = z.string().nullable().optional();

export const merchantBrandSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  support_email: nullableString,
  brand_color: nullableString,
  logo_url: nullableString,
});
export type MerchantBrand = z.infer<typeof merchantBrandSchema>;

export const creditSchema = z.object({
  payment_id: z.string().optional(),
  method: paymentMethodSchema,
  payer: addressSchema.nullable(),
  amount: atomicSchema,
  tx_hash: hex.nullable(),
  log_index: z.number().nullable().optional(),
  block_number: z.number().nullable().optional(),
  batch_id: hex.nullable().optional(),
  status: z.enum(["pending", "confirmed"]),
  late: z.boolean().default(false),
  created_at: timeSchema,
  confirmed_at: nullableTime,
});
export type Credit = z.infer<typeof creditSchema>;

export const tokenDomainSchema = z.object({ name: z.string(), version: z.string(), chainId: z.number(), verifyingContract: addressSchema });

/** PaymentRouter terms (GATEWAY.md section 14.2); the authorization nonce is their hash. */
export const paymentTermsSchema = z.object({ paymentRef: bytes32Schema, payout: addressSchema, feeRecipient: addressSchema, fee: atomicSchema });

const authorizationMessageSchema = z.object({ to: addressSchema, value: atomicSchema, validAfter: atomicSchema, validBefore: atomicSchema, nonce: bytes32Schema });

/**
 * What the payer's wallet signs for the `wallet` method, without `from`: either a TransferWithAuthorization to the
 * payment's fee-splitting forwarder (CheckoutTransferTemplate) or a ReceiveWithAuthorization to the PaymentRouter with
 * its terms (CheckoutAuthorizationTemplate). Both are accepted so the checkout follows whichever the node serves.
 */
export const authorizationTemplateSchema = z.discriminatedUnion("primaryType", [
  z.object({
    domain: tokenDomainSchema,
    primaryType: z.literal("TransferWithAuthorization"),
    types: z.unknown().optional(),
    message: authorizationMessageSchema,
  }),
  z.object({
    domain: tokenDomainSchema,
    primaryType: z.literal("ReceiveWithAuthorization"),
    types: z.unknown().optional(),
    message: authorizationMessageSchema,
    router: addressSchema,
    terms: paymentTermsSchema,
  }),
]);

/** Fee breakdown (section 14.1), on every payment. */
const feeFields = {
  amount: atomicSchema,
  surcharge: atomicSchema.default("0"),
  amount_due: atomicSchema,
  platform_fee: atomicSchema.default("0"),
  method_fee: atomicSchema.default("0"),
  fee_total: atomicSchema.default("0"),
  net_amount: atomicSchema,
};
export type AuthorizationTemplate = z.infer<typeof authorizationTemplateSchema>;

/** GET /v1/checkout/{id}: the public payment view. Never carries metadata, email or name. */
export const checkoutViewSchema = z.object({
  id: z.string(),
  livemode: z.boolean(),
  status: paymentStatusSchema,
  late: z.boolean().default(false),
  merchant: merchantBrandSchema,
  description: nullableString,
  reference: nullableString,
  amount: atomicSchema,
  surcharge: atomicSchema.default("0"),
  amount_due: atomicSchema,
  amount_paid: atomicSchema,
  amount_remaining: atomicSchema,
  chain_id: z.number(),
  token: tokenSchema,
  deposit_address: addressSchema,
  deposit_uri: z.string().optional(),
  method: paymentMethodSchema.nullable().default(null),
  methods: z.array(paymentMethodSchema),
  authorization: authorizationTemplateSchema.nullable(),
  success_url: nullableString,
  tx_hash: hex.nullable().optional(),
  order_hash: bytes32Schema,
  expires_at: timeSchema,
  created_at: timeSchema,
  /** Dashboard extra: confirmation depth of the credit being confirmed, shown while processing. */
  confirmations: z.object({ current: z.number(), required: z.number() }).nullable().optional(),
  /** Dashboard extra: the link the payment came from, so an expired payment can offer "Start a new payment". */
  link: z.object({ slug: z.string(), active: z.boolean() }).nullable().optional(),
  /** Dashboard extras for the receipt. */
  paid_at: nullableTime,
  payer: addressSchema.nullable().optional(),
  payout: addressSchema.nullable().optional(),
  hsp: checkoutHspSchema.nullable().optional(),
});
export type CheckoutView = z.infer<typeof checkoutViewSchema>;

export const authorizeResultSchema = z
  .object({ status: paymentStatusSchema, txHash: hex.nullable().optional(), tx_hash: hex.nullable().optional() })
  .transform((r) => ({ status: r.status, txHash: r.txHash ?? r.tx_hash ?? null }));
export type AuthorizeResult = z.infer<typeof authorizeResultSchema>;

/** GET /v1/links/public/{slug}. Not pinned in gateway.ts; this is what the link page needs. */
export const publicLinkSchema = z.object({
  slug: z.string(),
  livemode: z.boolean().default(false),
  title: z.string(),
  description: nullableString,
  amount: atomicSchema.nullable(),
  min_amount: atomicSchema.nullable().optional(),
  max_amount: atomicSchema.nullable().optional(),
  collect_email: z.boolean().default(false),
  collect_name: z.boolean().default(false),
  active: z.boolean(),
  merchant: merchantBrandSchema,
  chain_id: z.number(),
  token: tokenSchema,
});
export type PublicLink = z.infer<typeof publicLinkSchema>;

export const createdPaymentRefSchema = z.object({ id: z.string(), checkout_url: z.string().optional() }).passthrough();

export const refundStatusSchema = z.enum(["pending", "succeeded", "failed", "canceled"]);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

export const refundSchema = z.object({
  id: z.string(),
  merchant_id: z.string().optional(),
  livemode: z.boolean(),
  payment_id: z.string(),
  amount: atomicSchema,
  reason: nullableString,
  to: addressSchema,
  status: refundStatusSchema,
  method: z.enum(["authorization", "transfer"]).nullable().optional(),
  tx_hash: hex.nullable(),
  failure_reason: nullableString,
  /** Internal note, never shown to the customer (PRODUCT.md section 10.12). */
  note: nullableString,
  /** Staff refunds wait for an Admin (10.12): not_required, requested or approved. */
  approval: z.enum(["not_required", "requested", "approved"]).optional(),
  requested_by: nullableString,
  approved_by: nullableString,
  /** What the payout wallet signs for a gasless refund (GATEWAY.md section 15). */
  authorization: z.object({ router: addressSchema, terms: paymentTermsSchema, to: addressSchema, value: atomicSchema, nonce: bytes32Schema }).nullable().optional(),
  created_at: timeSchema,
  updated_at: timeSchema.optional(),
});
export type Refund = z.infer<typeof refundSchema>;

export const timelineEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created_at: timeSchema,
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const paymentSchema = z.object({
  ...feeFields,
  id: z.string(),
  merchant_id: z.string().optional(),
  livemode: z.boolean(),
  status: paymentStatusSchema,
  amount_paid: atomicSchema,
  amount_refunded: atomicSchema,
  refund_status: z.enum(["none", "partial", "full"]),
  chain_id: z.number(),
  token: addressSchema,
  deposit_address: addressSchema,
  description: nullableString,
  reference: nullableString,
  customer_email: nullableString,
  customer_name: nullableString,
  metadata: z.record(z.string(), z.unknown()).nullable().default({}),
  line_items: z.array(z.lazy(() => lineItemSchema)).default([]),
  order_hash: bytes32Schema,
  link_id: nullableString,
  payer: addressSchema.nullable(),
  method: paymentMethodSchema.nullable(),
  late: z.boolean(),
  success_url: nullableString,
  checkout_url: z.string(),
  expires_at: timeSchema,
  paid_at: nullableTime,
  canceled_at: nullableTime,
  created_at: timeSchema,
  updated_at: timeSchema.optional(),
  hsp: paymentHspSchema.nullable().optional(),
});
export type Payment = z.infer<typeof paymentSchema>;

/** GET /v1/payments/{id}: the payment with each credit, its refunds and the timeline. */
export const paymentDetailSchema = paymentSchema.extend({
  credits: z.array(creditSchema).default([]),
  refunds: z.array(refundSchema).default([]),
  events: z.array(timelineEventSchema).default([]),
});
export type PaymentDetail = z.infer<typeof paymentDetailSchema>;

export const PAYMENT_TABS = ["all", "paid", "pending", "underpaid", "expired", "refunded"] as const;
export type PaymentTab = (typeof PAYMENT_TABS)[number];

/** Cursor pages; `counts` (by status, plus `refunded`) is a dashboard extra that feeds the status tabs. */
export const gatewayPageSchema = <T extends z.ZodType>(item: T) =>
  z.union([
    z
      .object({
        items: z.array(item),
        next_cursor: z.string().nullable().optional(),
        nextCursor: z.string().nullable().optional(),
        counts: z.record(z.string(), z.number()).nullable().optional(),
      })
      .transform((o) => ({ items: o.items, nextCursor: o.next_cursor ?? o.nextCursor ?? null, counts: o.counts ?? null })),
    z.array(item).transform((items) => ({ items, nextCursor: null as string | null, counts: null as Record<string, number> | null })),
  ]);

export const paymentLinkSchema = z.object({
  id: z.string(),
  livemode: z.boolean(),
  slug: z.string(),
  url: z.string(),
  title: z.string(),
  description: nullableString,
  amount: atomicSchema.nullable(),
  min_amount: atomicSchema.nullable().optional(),
  max_amount: atomicSchema.nullable().optional(),
  collect_email: z.boolean(),
  collect_name: z.boolean(),
  success_url: nullableString,
  active: z.boolean(),
  /** Shown in the service directory (GATEWAY.md section 13.4). */
  listed: z.boolean().default(true),
  max_payments: z.number().nullable().optional(),
  /** After this the link answers like an inactive link (10.12). */
  expires_at: z.union([z.string(), z.number()]).nullable().optional(),
  expired: z.boolean().optional(),
  merchant_id: z.string().optional(),
  payments_count: z.number(),
  paid_total: atomicSchema,
  created_at: timeSchema,
  updated_at: timeSchema.optional(),
});
export type PaymentLink = z.infer<typeof paymentLinkSchema>;

export const webhookEndpointSchema = z.object({
  id: z.string(),
  livemode: z.boolean(),
  url: z.string(),
  description: nullableString,
  events: z.array(z.string()),
  active: z.boolean(),
  /** Only in the create, reveal and rotate-secret responses. */
  secret: z.string().optional(),
  created_at: timeSchema,
  updated_at: timeSchema.optional(),
  /** Dashboard extras: delivery health, and why the worker disabled the endpoint. */
  success_rate_7d: z.number().nullable().optional(),
  last_delivery_at: nullableTime,
  disabled_reason: nullableString,
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

export const webhookSecretSchema = z.union([z.object({ secret: z.string() }).transform((o) => o.secret), webhookEndpointSchema.transform((e) => e.secret ?? "")]);

export const webhookDeliverySchema = z.object({
  id: z.string(),
  event_id: z.string(),
  event_type: z.string(),
  endpoint_id: z.string(),
  url: z.string(),
  attempt: z.number(),
  status: z.enum(["pending", "succeeded", "failed"]),
  response_status: z.number().nullable(),
  response_body: nullableString,
  duration_ms: z.number().nullable(),
  error: nullableString,
  created_at: timeSchema,
  next_attempt_at: nullableTime,
  /** Dashboard extra: the JSON body that was sent. */
  request_body: nullableString,
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  livemode: z.boolean(),
  /** First characters of the secret, e.g. "sk_test_ab12". */
  prefix: z.string(),
  created_at: timeSchema,
  last_used_at: nullableTime,
  revoked_at: nullableTime,
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const createdApiKeySchema = apiKeySchema.extend({ secret: z.string() });
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;

// ---------------------------------------------------------------------------
// Merchants, fees and methods (GATEWAY.md section 14)
// ---------------------------------------------------------------------------

export const feeBearerSchema = z.enum(["merchant", "customer"]);
export type FeeBearer = z.infer<typeof feeBearerSchema>;

export const merchantSchema = z.object({
  id: z.string(),
  livemode: z.boolean(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(["active", "suspended"]),
  payout: addressSchema,
  support_email: nullableString,
  brand_color: nullableString,
  logo_url: nullableString,
  fee_plan_id: z.string(),
  created_at: timeSchema,
  updated_at: timeSchema.optional(),
  /** Dashboard extras for the operator list: last 30 days, when the node sends them. */
  volume_30d: atomicSchema.optional(),
  payments_30d: z.number().optional(),
});
export type Merchant = z.infer<typeof merchantSchema>;

export const merchantProfileSchema = merchantSchema.extend({
  chain_id: z.number(),
  token: addressSchema,
  deposit_factory: addressSchema,
  payment_router: addressSchema.optional(),
  checkout_base_url: z.string(),
});
export type MerchantProfile = z.infer<typeof merchantProfileSchema>;

export const feePlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform_fee_bps: z.number().int(),
  platform_fee_fixed: atomicSchema,
  min_fee: atomicSchema.nullable(),
  max_fee: atomicSchema.nullable(),
  created_at: timeSchema,
  updated_at: timeSchema.optional(),
  /** Dashboard extra: how many merchants use the plan. */
  merchants: z.number().optional(),
  /** PRODUCT.md section 10.12: businesses on this plan. */
  merchant_count: z.number().optional(),
});
export type FeePlan = z.infer<typeof feePlanSchema>;

export const merchantMethodSchema = z.object({
  merchant_id: z.string(),
  method: paymentMethodSchema,
  enabled: z.boolean(),
  fee_bps: z.number().int(),
  fee_fixed: atomicSchema,
  bearer: feeBearerSchema,
  min_amount: atomicSchema.nullable(),
  max_amount: atomicSchema.nullable(),
});
export type MerchantMethod = z.infer<typeof merchantMethodSchema>;

export const platformSchema = z.object({
  name: z.string(),
  fee_recipient: addressSchema.nullable(),
  default_fee_plan_id: z.string(),
  /** PRODUCT.md section 10.9; optional so older servers still parse. */
  signup_mode: z.enum(["off", "approval", "open"]).optional(),
  agent_budgets_for_businesses: z.boolean().optional(),
  require_2fa_platform: z.boolean().optional(),
  smtp_configured: z.boolean().optional(),
  recovery_key_enabled: z.boolean().optional(),
  dashboard_url: z.string().nullable().optional(),
});
export type Platform = z.infer<typeof platformSchema>;

/** The dashboard's earnings view, by merchant and by method. */
const platformFeesViewSchema = z.object({
  total: atomicSchema,
  volume: atomicSchema,
  payments: z.number(),
  by_merchant: z.array(z.object({ merchant_id: z.string(), name: z.string(), volume: atomicSchema, fees: atomicSchema, payments: z.number() })),
  by_method: z.array(z.object({ method: paymentMethodSchema, volume: atomicSchema, fees: atomicSchema, payments: z.number() })),
  days: z.array(z.object({ day: z.string(), fees: atomicSchema })).default([]),
});
export type PlatformFees = z.infer<typeof platformFeesViewSchema>;

const METHOD_ORDER = ["wallet", "deposit", "hsp", "x402", "voucher"];

/** GET /v1/platform/fees as the node serves it: one row per merchant and method, folded into both views. */
const nodeFeesSchema = z
  .object({
    totals: z.object({ fee_total: atomicSchema }).passthrough(),
    items: z.array(z.object({ merchant_id: z.string(), merchant_name: z.string(), method: paymentMethodSchema.nullable(), payments: z.number(), volume: atomicSchema, fee_total: atomicSchema }).passthrough()),
    /** GATEWAY.md section 15: the last 30 UTC days by the day payments were paid. */
    days: z.array(z.object({ day: z.string(), fee_total: atomicSchema }).passthrough()).default([]),
  })
  .passthrough()
  .transform((n): PlatformFees => {
    const byM = new Map<string, PlatformFees["by_merchant"][number]>();
    const byMethod = new Map<string, PlatformFees["by_method"][number]>();
    for (const r of n.items) {
      const m = byM.get(r.merchant_id) ?? { merchant_id: r.merchant_id, name: r.merchant_name, volume: "0", fees: "0", payments: 0 };
      byM.set(r.merchant_id, { ...m, volume: (BigInt(m.volume) + BigInt(r.volume)).toString(), fees: (BigInt(m.fees) + BigInt(r.fee_total)).toString(), payments: m.payments + r.payments });
      if (r.method) {
        const k = byMethod.get(r.method) ?? { method: r.method, volume: "0", fees: "0", payments: 0 };
        byMethod.set(r.method, { ...k, volume: (BigInt(k.volume) + BigInt(r.volume)).toString(), fees: (BigInt(k.fees) + BigInt(r.fee_total)).toString(), payments: k.payments + r.payments });
      }
    }
    const merchants = [...byM.values()];
    return {
      total: n.totals.fee_total,
      volume: merchants.reduce((a, m) => a + BigInt(m.volume), 0n).toString(),
      payments: merchants.reduce((a, m) => a + m.payments, 0),
      by_merchant: merchants,
      by_method: [...byMethod.values()].sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)),
      days: n.days.map((d) => ({ day: d.day, fees: d.fee_total })),
    };
  });

/** GET /v1/platform/fees: the node's per-merchant-and-method rows, or the folded view the mock serves. */
export const platformFeesSchema = z.union([nodeFeesSchema, platformFeesViewSchema]);

/** GET /v1/gateway/overview, last 30 days. Not pinned in gateway.ts; this is the shape the overview card reads. */
export const gatewayOverviewSchema = z.object({
  volume: atomicSchema,
  payments: z.number(),
  counts: z.record(z.string(), z.number()),
  /** Paid (or overpaid) share of payments that reached a terminal state, 0 to 1. */
  conversion: z.number(),
  days: z.array(z.object({ day: z.string(), volume: atomicSchema, count: z.number() })),
});
export type GatewayOverview = z.infer<typeof gatewayOverviewSchema>;

// ---------------------------------------------------------------------------
// Trust features (GATEWAY.md section 13)
// ---------------------------------------------------------------------------

export const lineItemSchema = z.object({ name: z.string(), quantity: z.number().int(), unit_amount: atomicSchema });
export type LineItem = z.infer<typeof lineItemSchema>;

/** GET /v1/checkout/{id}/order: the canonical order JSON, so anyone can recompute order_hash. */
export const orderCommitmentSchema = z.object({
  payment_id: z.string(),
  amount: atomicSchema,
  token: addressSchema,
  payout: addressSchema,
  reference: z.string().nullable(),
  description: z.string().nullable(),
  line_items: z.array(lineItemSchema),
  /** Metadata stays merchant-private; the order commits to its hash only. */
  metadata_hash: bytes32Schema,
});
export type OrderCommitment = z.infer<typeof orderCommitmentSchema>;

/** What the receipt page checks: the node's claims about a paid payment, re-read from the chain in the browser. */
export const paymentProofSchema = z.object({
  payment_id: z.string(),
  status: paymentStatusSchema,
  chain_id: z.number(),
  token: addressSchema,
  payout: addressSchema,
  /** The forwarder, for deposit credits; the receipt page fills it from the checkout view when absent. */
  deposit_address: addressSchema.nullable().optional(),
  amount_due: atomicSchema,
  amount_paid: atomicSchema,
  /** Amount of the credit in `tx_hash`; the transfer check compares against it. */
  credit_amount: atomicSchema.nullable().optional(),
  method: paymentMethodSchema.nullable(),
  payer: addressSchema.nullable(),
  tx_hash: hex.nullable(),
  block_number: z.number().nullable(),
  /** The finality tag the node confirms against (latest, safe or finalized). */
  finality_tag: z.string().default("safe"),
  order_hash: bytes32Schema,
  /** EIP-3009 nonce the payer's authorization used, for the AuthorizationUsed check on wallet and x402 payments. */
  authorization_nonce: bytes32Schema.nullable().optional(),
  eas_enabled: z.boolean(),
  attestation: z.object({ uid: bytes32Schema, schema: bytes32Schema.nullable().optional(), attester: addressSchema.nullable().optional(), eas: addressSchema.nullable().optional() }).nullable(),
  paid_at: nullableTime,
});
export type PaymentProof = z.infer<typeof paymentProofSchema>;

/** GET /v1/checkout/{id}/proof as the node serves it (credits with decoded logs), mapped to PaymentProof. */
export const nodeProofSchema = z
  .object({
    payment_id: z.string(),
    status: paymentStatusSchema,
    chain_id: z.number(),
    confirm_tag: z.string().optional(),
    token: z.union([addressSchema, tokenSchema.passthrough()]),
    payout: addressSchema,
    amount_due: atomicSchema,
    amount_paid: atomicSchema,
    order_hash: bytes32Schema,
    paid_at: nullableTime,
    credits: z.array(
      z
        .object({
          method: paymentMethodSchema,
          amount: atomicSchema,
          payer: addressSchema.nullable(),
          tx_hash: hex.nullable(),
          block_number: z.number().nullable(),
          authorization_used: z.array(z.object({ authorizer: addressSchema, nonce: bytes32Schema }).passthrough()).default([]),
        })
        .passthrough(),
    ),
    attestation: z
      .object({ enabled: z.boolean(), uid: bytes32Schema.nullable().optional(), eas: addressSchema.nullable().optional(), schema_uid: bytes32Schema.nullable().optional(), attester: addressSchema.nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .transform((n): PaymentProof => {
    const c = n.credits.filter((x) => x.tx_hash).at(-1) ?? n.credits.at(-1) ?? null;
    const a = n.attestation;
    return {
      payment_id: n.payment_id,
      status: n.status,
      chain_id: n.chain_id,
      token: typeof n.token === "string" ? n.token : n.token.address,
      payout: n.payout,
      deposit_address: null,
      amount_due: n.amount_due,
      amount_paid: n.amount_paid,
      credit_amount: c?.amount ?? null,
      method: c?.method ?? null,
      payer: c?.payer ?? null,
      tx_hash: c?.tx_hash ?? null,
      block_number: c?.block_number ?? null,
      finality_tag: n.confirm_tag ?? "safe",
      order_hash: n.order_hash,
      authorization_nonce: c?.authorization_used[0]?.nonce ?? null,
      eas_enabled: Boolean(a?.enabled),
      attestation: a?.enabled && a.uid ? { uid: a.uid, schema: a.schema_uid ?? null, attester: a.attester ?? null, eas: a.eas ?? null } : null,
      paid_at: n.paid_at,
    };
  });

/** Either shape: the node's (with credits) or the flat one the mock serves. */
export const anyProofSchema = z.union([nodeProofSchema, paymentProofSchema]);

export const SCREENING_RULES = ["PAYER_BLACKLISTED", "PAYOUT_BLACKLISTED", "PAYER_DENIED", "PAYER_TOO_NEW"] as const;
export type ScreeningRule = (typeof SCREENING_RULES)[number];

export const denyListEntrySchema = z
  .object({ address: addressSchema, note: nullableString, reason: nullableString, created_at: timeSchema.optional() })
  .transform((d) => ({ address: d.address, note: d.note ?? d.reason ?? null, created_at: d.created_at ?? new Date().toISOString() }));
export type DenyListEntry = z.infer<typeof denyListEntrySchema>;

/** A refused gateway request, shown with source `gateway` next to clearing denials. */
export const screeningDecisionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  merchant_id: nullableString,
  source: z.literal("gateway").default("gateway"),
  rule: z.enum(SCREENING_RULES),
  /** Where the request was refused, e.g. x402, authorize or deposit. */
  stage: nullableString,
  message: nullableString,
  payer: addressSchema.nullable().optional(),
  address: addressSchema.nullable().optional(),
  payment_id: nullableString,
  link_id: nullableString,
  method: paymentMethodSchema.nullable().optional(),
  amount: atomicSchema.nullable().optional(),
  created_at: timeSchema,
});
export type ScreeningDecision = z.infer<typeof screeningDecisionSchema>;

// Compile-time contract checks against packages/protocol/src/gateway.ts.
type Parses<S extends z.ZodType, T> = [T] extends [z.input<S>] ? true : false;
const contract: [
  Parses<typeof paymentSchema, P.Payment>,
  Parses<typeof creditSchema, P.Credit>,
  Parses<typeof paymentLinkSchema, P.PaymentLink>,
  Parses<typeof refundSchema, P.Refund>,
  Parses<typeof webhookEndpointSchema, P.WebhookEndpoint>,
  Parses<typeof webhookDeliverySchema, P.WebhookDelivery>,
  Parses<typeof apiKeySchema, P.ApiKey>,
  Parses<typeof createdApiKeySchema, P.ApiKeyWithSecret>,
  Parses<typeof merchantProfileSchema, P.MerchantProfile>,
  Parses<typeof checkoutViewSchema, P.CheckoutView>,
  Parses<typeof orderCommitmentSchema, P.OrderCommitment>,
  Parses<typeof merchantSchema, P.Merchant>,
  Parses<typeof feePlanSchema, P.FeePlan>,
  Parses<typeof merchantMethodSchema, P.MerchantMethod>,
  Parses<typeof platformSchema, P.Platform>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void contract;

// ---------------------------------------------------------------------------
// Merchant AI agents (docs/AGENTS.md sections 2, 4, 5 and 6): AI connections, agents, runs and run steps.
// Objects keep only the fields listed here, so fields a newer server adds are tolerated. Keys never appear: the server
// returns only `key_hint`, the last four characters.
// ---------------------------------------------------------------------------

/** Token counts as numbers; a server that sends them as decimal strings still parses. */
const countSchema = z.union([z.number(), z.string().regex(/^\d+$/, "expected a count")]).transform(Number);

/** Accepts a bare array, `{ items }` or `{ <key>: [] }`, since list envelopes for these routes are not pinned. */
function itemsOf<T extends z.ZodType>(item: T, key: string) {
  return z.union([
    z.array(item),
    z.object({ items: z.array(item) }).transform((o) => o.items),
    z.object({ [key]: z.array(item) }).transform((o) => (o as Record<string, z.infer<T>[]>)[key]!),
  ]) as unknown as z.ZodType<z.infer<T>[]>;
}

/** Single objects may come bare or wrapped as `{ <key>: object }` (for example `202 { run }`). */
function wrappedOrBare<T extends z.ZodType>(item: T, key: string) {
  return z.union([z.object({ [key]: item }).transform((o) => (o as Record<string, z.infer<T>>)[key]!), item]) as unknown as z.ZodType<z.infer<T>>;
}

export const AI_PROVIDER_IDS = ["anthropic", "openai", "google", "openai_compatible", "replicate"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/**
 * GET /v1/ai/providers: one supported provider, whether it needs a base URL, models to suggest and a note to show.
 * The node serves the model layer's catalogue as is (camelCase: needsBaseUrl, defaultBaseUrl, suggestedModels), so
 * both spellings are read.
 */
export const aiProviderSchema = z
  .object({
    id: z.string().optional(),
    provider: z.string().optional(),
    name: nullableString,
    needs_base_url: z.boolean().optional(),
    needsBaseUrl: z.boolean().optional(),
    requires_base_url: z.boolean().optional(),
    /** The provider's own endpoint, shown as the placeholder where a base URL may be overridden. */
    default_base_url: nullableString,
    defaultBaseUrl: nullableString,
    suggested_models: z.array(z.string()).optional(),
    suggestedModels: z.array(z.string()).optional(),
    models: z.array(z.string()).optional(),
    /** Something to know before choosing the provider (for example that tools are emulated). */
    note: nullableString,
  })
  .refine((p) => Boolean(p.id ?? p.provider), "expected a provider id")
  .transform((p) => ({
    id: (p.id ?? p.provider)!,
    name: p.name ?? null,
    needs_base_url: p.needs_base_url ?? p.needsBaseUrl ?? p.requires_base_url ?? false,
    default_base_url: p.default_base_url ?? p.defaultBaseUrl ?? null,
    suggested_models: p.suggested_models ?? p.suggestedModels ?? p.models ?? [],
    note: p.note ?? null,
  }));
export type AiProvider = z.infer<typeof aiProviderSchema>;
export const aiProvidersSchema = itemsOf(aiProviderSchema, "providers");

export const aiConnectionStatusSchema = z.enum(["active", "invalid", "disabled"]);
export type AiConnectionStatus = z.infer<typeof aiConnectionStatusSchema>;

const tokenTotalsSchema = z.object({ input_tokens: countSchema.default(0), output_tokens: countSchema.default(0), runs: countSchema.optional() });
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

export const aiConnectionSchema = z.object({
  id: z.string(),
  merchant_id: z.string().optional(),
  provider: z.string(),
  label: z.string(),
  base_url: nullableString,
  default_model: z.string(),
  key_hint: nullableString,
  status: aiConnectionStatusSchema,
  verified_at: nullableTime,
  last_error: nullableString,
  monthly_token_limit: countSchema.nullable().optional(),
  created_at: timeSchema,
  created_by: nullableString,
  rotated_at: nullableTime,
  /** Dashboard extra: this month's tokens when the server includes them; otherwise read from /v1/ai/usage. */
  usage: tokenTotalsSchema.nullable().optional(),
});
export type AiConnection = z.infer<typeof aiConnectionSchema>;
export const aiConnectionsSchema = itemsOf(aiConnectionSchema, "connections");
export const aiConnectionOneSchema = wrappedOrBare(aiConnectionSchema, "connection");

/** GET /v1/ai/connections/:id/models: null when the provider has no model list. */
export const aiModelsSchema = z.union([
  z.array(z.string()),
  z.object({ models: z.array(z.string()).nullable() }).transform((o) => o.models),
  z.object({ items: z.array(z.string()) }).transform((o) => o.items),
  z.null(),
]);

const connectionUsageRowSchema = tokenTotalsSchema.extend({ connection_id: z.string() });
const agentUsageRowSchema = tokenTotalsSchema.extend({ agent_id: z.string() });

/** GET /v1/ai/usage?month=YYYY-MM: tokens per connection and per agent, as rows or as a map keyed by id. */
export const aiUsageSchema = z.object({
  month: z.string(),
  connections: z
    .union([z.array(connectionUsageRowSchema), z.record(z.string(), tokenTotalsSchema).transform((m) => Object.entries(m).map(([connection_id, u]) => ({ ...u, connection_id })))])
    .default([]),
  agents: z.union([z.array(agentUsageRowSchema), z.record(z.string(), tokenTotalsSchema).transform((m) => Object.entries(m).map(([agent_id, u]) => ({ ...u, agent_id })))]).default([]),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

export const agentKindSchema = z.enum(["ops", "skill", "buyer"]);
export type AgentKind = z.infer<typeof agentKindSchema>;
export const agentStatusSchema = z.enum(["active", "paused"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const AGENT_LIMIT_DEFAULTS = { max_turns: 12, max_output_tokens: 20_000, timeout_seconds: 180 } as const;
export const agentLimitsSchema = z.object({
  max_turns: countSchema.default(AGENT_LIMIT_DEFAULTS.max_turns),
  max_output_tokens: countSchema.default(AGENT_LIMIT_DEFAULTS.max_output_tokens),
  timeout_seconds: countSchema.default(AGENT_LIMIT_DEFAULTS.timeout_seconds),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

export const agentRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentSchema = z.object({
  id: z.string(),
  merchant_id: z.string().optional(),
  kind: agentKindSchema,
  name: z.string(),
  description: nullableString,
  connection_id: z.string().nullable(),
  model: z.string(),
  instructions: nullableString,
  tools: z.array(z.string()).nullable().optional(),
  limits: agentLimitsSchema.default(AGENT_LIMIT_DEFAULTS),
  status: agentStatusSchema,
  /** Skill only. `price` is in token base units. */
  slug: nullableString,
  price: atomicSchema.nullable().optional(),
  input_hint: nullableString,
  created_at: timeSchema,
  updated_at: nullableTime,
  /** Dashboard extras: the latest run, and the public skill URL when the server knows its own public address. */
  last_run: z.object({ id: z.string(), status: agentRunStatusSchema, created_at: timeSchema }).nullable().optional(),
  skill_url: nullableString,
});
export type Agent = z.infer<typeof agentSchema>;
export const agentsSchema = itemsOf(agentSchema, "agents");
export const agentOneSchema = wrappedOrBare(agentSchema, "agent");

export const agentRunSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  merchant_id: z.string().optional(),
  trigger: z.string().default("dashboard"),
  input: z.string().nullable().default(""),
  status: agentRunStatusSchema,
  attempt: countSchema.default(0),
  max_attempts: countSchema.default(3),
  next_attempt_at: nullableTime,
  cancel_requested: z.boolean().default(false),
  result: z.object({ answer: z.string().nullable().optional(), data: z.unknown().optional() }).nullable().optional(),
  error_code: nullableString,
  error_message: nullableString,
  usage: z.object({ input_tokens: countSchema.default(0), output_tokens: countSchema.default(0), model: nullableString, provider: nullableString }).nullable().optional(),
  created_at: timeSchema,
  started_at: nullableTime,
  finished_at: nullableTime,
});
export type AgentRun = z.infer<typeof agentRunSchema>;
export const agentRunOneSchema = wrappedOrBare(agentRunSchema, "run");

/** One step of a run (`agent_run_events`). `type` stays a string so a new kind of step still renders as a plain row. */
export const agentRunEventSchema = z.object({
  seq: countSchema,
  run_id: z.string().optional(),
  type: z.string(),
  data: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .transform((d) => d ?? {}),
  at: timeSchema,
});
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
export const agentRunEventsSchema = itemsOf(agentRunEventSchema, "events");
