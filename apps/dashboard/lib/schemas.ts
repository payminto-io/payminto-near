/**
 * Wire shapes of the Clearing Node HTTP API (docs/SPEC.md 5.6 and 5.7).
 * Every response is parsed with these schemas at the trust boundary, so a backend shape change
 * surfaces as a clear "unexpected response" error instead of a silently wrong number.
 * Amounts are decimal strings of atomic units; they are only ever converted with BigInt.
 */
import { z } from "zod";
import { CHECKOUT_METHODS, DENIAL_RULES, PAYMENT_METHODS, PAYMENT_STATUSES, type DenialRule } from "@payminto/protocol";
import type * as P from "@payminto/protocol";
import type { Verdict } from "@payminto/payee-check";

/** A NEAR transaction hash (base58 text), or a hex signature. Opaque here; the chain package validates them. */
const txHash = z.string().min(1);
/** A NEAR account id or an `ed25519:` public key. The gateway mock still uses 0x-style ids, which this accepts too. */
export const addressSchema = z.string().regex(/^[A-Za-z0-9._:-]{2,128}$/, "expected an account");
/** Id32: 64 hex characters. A 0x prefix is tolerated for gateway fields that are still hashed with keccak. */
export const bytes32Schema = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "expected a 32-byte id");
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
});
export type Token = z.infer<typeof tokenSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  network: z.string(),
  hub: addressSchema,
  token: z.union([addressSchema, tokenSchema]),
  operator: addressSchema,
});
export type Health = z.infer<typeof healthSchema>;

export const infoSchema = z.object({
  network: z.object({ id: z.string(), name: z.string(), explorer: z.string().nullable().optional(), testnet: z.boolean(), rpc_url: z.string().nullable().optional() }),
  hub: addressSchema,
  hubExplorerUrl: z.string().nullable().optional(),
  token: tokenSchema,
  explorer: z.string().nullable().optional(),
  operator: addressSchema,
  /** The key the node signs receipts with. */
  nodeKey: z.string().optional(),
  version: z.string(),
  settleIntervalSec: z.number().optional(),
  publicUrl: z.string().nullable().optional(),
  settlement: z.object({ intervalSec: z.number().optional() }).passthrough().optional(),
  gateway: z.object({ enabled: z.boolean().optional(), checkoutBaseUrl: z.string().optional() }).passthrough().optional(),
});
export type Info = z.infer<typeof infoSchema>;

export const policySchema = z.object({
  perCallCap: atomicSchema,
  dailyCap: atomicSchema,
  hourlyCap: atomicSchema.optional(),
  maxCallsPerMinute: z.number(),
  maxRepeatsPerRequest: z.number().optional(),
  purpose: z.string(),
});

export const budgetJsonSchema = z.object({
  owner: addressSchema,
  /** ed25519 public key in NEAR text form. */
  agentPk: addressSchema,
  settler: addressSchema,
  cap: atomicSchema,
  /** Unix milliseconds. */
  validUntil: atomicSchema,
  payees: z.array(addressSchema),
  policyHash: bytes32Schema,
  salt: bytes32Schema,
});

export const budgetStatusSchema = z.enum(["pending", "open", "revoked", "expired", "failed"]);
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export const spendSchema = z.object({
  settled: atomicSchema,
  pending: atomicSchema,
  total: atomicSchema.optional(),
  today: atomicSchema,
  remaining: atomicSchema,
});

export const callStatusSchema = z.enum(["accepted", "settled", "settling"]);

/**
 * How a settled Call was settled: in one of the server's batches, or by its seller on the hub (`settle_own`). Null until
 * settled. Absent on an older node; a value this dashboard does not know reads as unknown, so the list still parses.
 */
export const settledBySchema = z.enum(["batch", "seller"]).nullable().optional().catch(undefined);
export type SettledBy = "batch" | "seller" | null;

export const callSchema = z.object({
  id: bytes32Schema,
  budgetId: bytes32Schema,
  agent: addressSchema,
  payee: addressSchema,
  providerId: z.string().nullable().optional(),
  amount: atomicSchema,
  cumulative: atomicSchema,
  requestHash: bytes32Schema,
  status: callStatusSchema,
  /** "seller": the seller settled this Call itself on the hub, so it is in no batch and has no Merkle proof. */
  settledBy: settledBySchema,
  batchId: bytes32Schema.nullable().optional(),
  createdAt: timeSchema,
});
export type Call = z.infer<typeof callSchema>;

export const denialSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  rule: denialRuleSchema,
  message: z.string(),
  budgetId: bytes32Schema.nullable().optional(),
  agent: addressSchema.nullable().optional(),
  payee: addressSchema.nullable().optional(),
  providerId: z.string().nullable().optional(),
  amount: atomicSchema.nullable().optional(),
  /** Holds `refusal` (rule, message, attemptedAmount, remainingBudget, retry) when the node recorded one. */
  details: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: timeSchema,
});
export type Denial = z.infer<typeof denialSchema>;

// ---------------------------------------------------------------------------
// The payee check on the node (apps/node/README.md "The payee check"): the verdict it holds per Budget and Payee, the
// owner's decisions, the Calls that wait for one, and reports. A node without the feature sends none of this.
// ---------------------------------------------------------------------------

export const payeeVerdictKindSchema = z.enum(["allow", "warn", "block"]);
export type PayeeVerdictKind = z.infer<typeof payeeVerdictKindSchema>;

/** Keeps the entries of a list that parse and drops the rest, so one odd entry never hides a whole Budget. */
function lenientArray<T>(item: z.ZodType<T, unknown>): z.ZodType<T[], unknown> {
  return z.array(z.unknown()).transform((all) =>
    all.flatMap((v) => {
      const r = item.safeParse(v);
      return r.success ? [r.data] : [];
    }),
  );
}

const payeeEvidenceSchema = z.union([z.object({ type: z.literal("tx"), hash: z.string() }), z.object({ type: z.literal("url"), url: z.string() })]);

/** A signal of the payee check. An id this dashboard does not know still parses: it is shown by its reason. */
export const payeeSignalSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warn", "block"]),
  reason: z.string(),
  facts: z.record(z.string(), z.unknown()).optional().default({}),
});
export type PayeeSignal = { id: string; severity: "info" | "warn" | "block"; reason: string };

/**
 * A verdict of `@payminto/payee-check` as the node sends it, ready for the package's `toView`. Lists a node left out
 * read as empty, and a report that does not parse is dropped: report text is a third party's claim, kept as data.
 */
export const payeeVerdictSchema = z
  .object({
    verdict: payeeVerdictKindSchema,
    payee: z.string(),
    kind: z.enum(["named", "implicit", "eth_implicit"]).nullable().optional().default(null),
    payer: z.string().nullable().optional().default(null),
    signals: z.array(payeeSignalSchema).optional().default([]),
    checked: z.array(z.string()).optional().default([]),
    notChecked: z.array(z.string()).optional().default([]),
    reports: lenientArray(z.object({ account: z.string(), reporter: z.string(), reason: z.string(), evidence: payeeEvidenceSchema, atMs: z.number() })).optional().default([]),
    checkedAtMs: z.number(),
  })
  .transform((v) => v as unknown as Verdict);

/** The verdict the node holds for one Payee of a Budget, and the owner's decision about it, if any. */
export const payeeCheckSchema = z.object({
  payee: addressSchema,
  status: payeeVerdictKindSchema,
  /** False when a source did not answer, so the verdict may be heavier than a full look would be. */
  complete: z.boolean().optional().default(true),
  checkedAt: timeSchema,
  approval: z.enum(["approve", "deny"]).nullable().optional().default(null),
  verdict: payeeVerdictSchema,
});
export type PayeeCheck = z.infer<typeof payeeCheckSchema>;

const decidedBySchema = z.object({ type: z.string(), id: z.string().nullable().optional().default(null) });

/** An owner's decision about one Payee of one Budget. `signals` are the warnings and blocks the owner saw. */
export const payeeApprovalSchema = z.object({
  budgetId: bytes32Schema,
  payee: addressSchema,
  decision: z.enum(["approve", "deny"]),
  overrideBlock: z.boolean().optional().default(false),
  signals: z.array(z.string()).nullable().optional().default(null),
  note: z.string().nullable().optional().default(null),
  decidedBy: decidedBySchema.optional().default({ type: "system", id: null }),
  decidedAt: timeSchema,
});
export type PayeeApproval = z.infer<typeof payeeApprovalSchema>;

/** A Call that waits for the owner: who the agent tried to pay, how much, how often, and why the check hesitates. */
export const payeeApprovalRequestSchema = z.object({
  id: z.string(),
  budgetId: bytes32Schema,
  payee: addressSchema,
  /** The price of the latest Call that waited, atomic units. */
  amount: atomicSchema,
  source: z.enum(["voucher", "wallet"]).catch("voucher"),
  attempts: z.number().int().optional().default(1),
  firstAt: timeSchema,
  lastAt: timeSchema,
  /** Null when the node's own check is off and only the agent's wallet asked. */
  verdict: payeeVerdictKindSchema.nullable().optional().default(null),
  signals: lenientArray(payeeSignalSchema.transform(({ id, severity, reason }): PayeeSignal => ({ id, severity, reason }))).optional().default([]),
});
export type PayeeApprovalRequest = z.infer<typeof payeeApprovalRequestSchema>;

export const payeeApprovalsSchema = z.object({
  budgetId: bytes32Schema,
  approveAt: z.string().nullable().optional(),
  approvals: z.array(payeeApprovalSchema).optional().default([]),
  waiting: z.array(payeeApprovalRequestSchema).optional().default([]),
});
export type PayeeApprovals = z.infer<typeof payeeApprovalsSchema>;

/** A report as the node returns it: plain JSON strings. The reason is a claim by a third party, never markup. */
export const payeeReportSchema = z.object({
  account: addressSchema,
  reporter: addressSchema,
  reason: z.string(),
  evidence: payeeEvidenceSchema,
  at: timeSchema,
  filedBy: decidedBySchema.nullable().optional().default(null),
});
export type PayeeReport = z.infer<typeof payeeReportSchema>;

export const payeeReportsSchema = z.object({
  account: z.string().nullable().optional().default(null),
  reporters: z.number().optional().default(0),
  reports: z.array(payeeReportSchema).optional().default([]),
});
export type PayeeReports = z.infer<typeof payeeReportsSchema>;

export const payeeReportFiledSchema = z.object({ report: payeeReportSchema, reporters: z.number().optional().default(1) });
export type PayeeReportFiled = z.infer<typeof payeeReportFiledSchema>;

export const budgetSchema = z.object({
  id: bytes32Schema,
  label: z.string(),
  status: budgetStatusSchema,
  budget: budgetJsonSchema,
  owner: addressSchema,
  /** The agent's ed25519 public key. */
  agent: addressSchema,
  settler: addressSchema,
  cap: atomicSchema,
  expiresAt: timeSchema,
  policy: policySchema,
  payees: z.array(addressSchema),
  spend: spendSchema,
  calls: z.number().optional(),
  openTxHash: txHash.nullable().optional(),
  revokedAt: timeSchema.nullable().optional(),
  createdAt: timeSchema,
  /** Last observed escrow and the owner's withdrawable credit (atomic units); null until first read. */
  escrow: atomicSchema.nullable().optional(),
  ownerCredit: atomicSchema.nullable().optional(),
  /**
   * The payee check's verdict for each Payee the node holds one for. Null: the node has the feature and it is off.
   * Absent: an older node. Anything else it sends here that does not parse reads as absent, so the Budget still loads.
   */
  payeeChecks: lenientArray(payeeCheckSchema).nullable().optional().catch(undefined),
});
export type BudgetRecord = z.infer<typeof budgetSchema>;

export const budgetDetailSchema = budgetSchema.extend({
  recentCalls: z.array(callSchema).default([]),
  denials: z.array(denialSchema).default([]),
  /** The hub's view of the budget, when the node could read it. */
  onchain: z
    .object({ open: z.boolean(), revokedAt: z.union([z.string(), z.number()]).nullable().optional(), spent: atomicSchema.optional(), cap: atomicSchema.optional(), escrow: atomicSchema.optional(), validUntil: atomicSchema.optional() })
    .nullable()
    .optional(),
  /** Daily spend buckets for the chart; optional because the SPEC does not pin it. */
  spendSeries: z.array(z.object({ day: z.string(), amount: atomicSchema })).optional(),
  /** Per-minute spend for the last 30 minutes, so a fresh budget shows a real curve. */
  spendRecent: z.array(z.object({ at: z.string(), amount: atomicSchema, calls: z.number().optional() })).optional(),
}).transform((b) => ({
  ...b,
  // `escrow` is the node's last periodic read; `onchain.escrow` is what the hub held when this answer was made. The
  // newer one wins, so a deposit shows as soon as the page reads the Budget again, not at the node's next refresh.
  escrow: b.onchain?.open && b.onchain.escrow !== undefined ? b.onchain.escrow : b.escrow,
}));
export type BudgetDetail = Omit<z.infer<typeof budgetDetailSchema>, "escrow"> & { escrow?: string | null };

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

export const netTransferSchema = z.object({
  from: addressSchema,
  to: addressSchema,
  amount: atomicSchema,
  index: z.number().optional(),
});
export type NetTransfer = z.infer<typeof netTransferSchema>;

export const claimSchema = z.object({
  budgetId: bytes32Schema,
  agent: addressSchema,
  payee: addressSchema,
  cumulative: atomicSchema,
  previous: atomicSchema.optional(),
  delta: atomicSchema,
  calls: z.number().optional(),
  index: z.number().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

/** `unknown`: the node sent the batch but cannot yet tell whether the hub recorded it (it recovers from the hub). */
export const batchStatusSchema = z.enum(["building", "submitted", "confirmed", "failed", "unknown"]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const batchSchema = z.object({
  id: bytes32Schema,
  seq: z.number(),
  status: batchStatusSchema,
  receiptsRoot: bytes32Schema.nullable(),
  token: addressSchema,
  txHash: txHash.nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
  gross: atomicSchema,
  net: atomicSchema,
  projectedGross: atomicSchema.optional(),
  projectedNet: atomicSchema.optional(),
  calls: z.number(),
  claims: z.number(),
  transfers: z.number(),
  compression: z.number().nullable().optional(),
  reconciled: z.boolean().nullable().optional(),
  trigger: z.string().optional(),
  error: z.string().nullable().optional(),
  createdAt: timeSchema,
  submittedAt: timeSchema.nullable().optional(),
  confirmedAt: timeSchema.nullable().optional(),
});
export type Batch = z.infer<typeof batchSchema>;

const netEntrySchema = z.object({ account: addressSchema, debit: atomicSchema, credit: atomicSchema });

/** The node's detail route replaces the summary's `net` total with per-account entries; both are kept here. */
export const batchDetailSchema = batchSchema
  .extend({
    claimList: z.array(claimSchema),
    netTransfers: z.array(netTransferSchema),
    net: z.union([atomicSchema, z.array(netEntrySchema)]),
  })
  .transform(({ net, ...b }) => ({
    ...b,
    net: typeof net === "string" ? net : net.reduce((a, e) => a + BigInt(e.debit), 0n).toString(),
    netEntries: typeof net === "string" ? [] : net,
  }));
export type BatchDetail = z.infer<typeof batchDetailSchema>;

export const overviewSchema = z.object({
  volume: z.object({ settled: atomicSchema, pending: atomicSchema }),
  calls: z.object({ last24h: z.number(), all: z.number() }),
  denials24h: z.number(),
  activeBudgets: z.number(),
  providers: z.number(),
  batches: z.number(),
  /** Gross cleared and net cash moved by confirmed batches. */
  settled: z.object({ gross: atomicSchema, net: atomicSchema }).optional(),
  /** What sellers settled themselves on the hub, outside any batch. Nothing offsets, so gross is what the hub moved. */
  settledBySeller: z.object({ gross: atomicSchema, calls: z.number().default(0), settlements: z.number().default(0) }).optional(),
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
    .array(z.object({ budgetId: bytes32Schema, reason: z.string() }))
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
  budgetId: bytes32Schema,
  payee: addressSchema,
  amount: atomicSchema,
  cumulative: atomicSchema,
  requestHash: bytes32Schema,
  timestamp: z.number(),
  voucherSig: z.string(),
  /** What the node signed. Not the Merkle leaf. */
  digest: bytes32Schema,
  nodeSignature: z.string(),
  /** The key the node signs receipts with. */
  node: addressSchema,
});
export type Receipt = z.infer<typeof receiptSchema>;

/**
 * What the server booked when a seller settled a voucher itself, and what the hub said when the proof was asked for.
 * `covered` is true when the hub's settled position of this Budget and Payee is at or past this Call, false when it is
 * not, and null when the server could not read the hub.
 */
export const sellerSettlementProofSchema = z.object({
  id: z.string(),
  /** The settled position before and after, atomic units. */
  previous: atomicSchema,
  cumulative: atomicSchema,
  detectedAt: timeSchema.nullable().optional(),
  hubSettled: atomicSchema.nullable().optional(),
  covered: z.boolean().nullable().optional(),
});
export type SellerSettlementProof = z.infer<typeof sellerSettlementProofSchema>;

export const proofSchema = z.object({
  receipt: receiptSchema,
  status: z.string().optional(),
  /** "seller": settled by its seller on the hub, with no batch, root or Merkle proof to check. */
  settledBy: settledBySchema,
  sellerSettlement: sellerSettlementProofSchema.nullable().optional(),
  batchId: bytes32Schema.nullable(),
  /** The account that settled the batch. The hub keys batches by settler; older nodes leave it out (it is the operator). */
  settler: addressSchema.nullable().optional(),
  batchStatus: z.string().nullable().optional(),
  receiptsRoot: bytes32Schema.nullable(),
  proof: z.array(bytes32Schema),
  /** The Merkle leaf, when the node sends it. Without it the path cannot be replayed in the browser. */
  leaf: bytes32Schema.nullable().optional(),
  txHash: txHash.nullable().optional(),
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
  | "budget.opened"
  | "budget.revoked"
  | "batch.started"
  | "batch.submitted"
  | "batch.included"
  | "batch.confirmed"
  | "batch.failed"
  | "funds.warning"
  | "payout.confirmed"
  | "payout.failed"
  | "seller.settled"
  | "operator.alert"
  | "payee.approval_requested"
  | "payee.approval_decided"
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
  "budget.opened",
  "budget.revoked",
  "batch.started",
  "batch.submitted",
  "batch.included",
  "batch.confirmed",
  "batch.failed",
  "funds.warning",
  "payout.confirmed",
  "payout.failed",
  // A seller settled its own voucher on the hub and the server booked it: `data.sellerSettlement`.
  "seller.settled",
  // Something only the operator can resolve: `data.alert` with `kind` and `message` (lib/operator-alerts.ts).
  "operator.alert",
  // A Call waits for the owner's decision about its Payee: `data.request` and `data.approveAt`.
  "payee.approval_requested",
  // An owner decided, or withdrew a decision: `data.approval`, and `data.withdrawn` when it was withdrawn.
  "payee.approval_decided",
  ...AGENT_RUN_EVENT_TYPES,
];

export type NodeEvent = { type: EventType; id: string; at: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Payouts: the node pays hub credit out to each creditor's own account (GET and POST /v1/payouts).
// ---------------------------------------------------------------------------

/** due: queued for the next payout. waiting_registration: credit stays on the hub until the account registers with the token. */
export const payoutAccountSchema = z.object({
  account: addressSchema,
  status: z.enum(["due", "waiting_registration", "clear"]),
  credit: atomicSchema,
  paidTotal: atomicSchema,
  attempts: z.number(),
  nextAttemptAt: timeSchema.nullable().optional(),
  lastError: z.string().nullable().optional(),
  checkedAt: timeSchema.nullable().optional(),
});
export type PayoutAccount = z.infer<typeof payoutAccountSchema>;

export const payoutSchema = z.object({
  seq: z.number(),
  status: z.enum(["submitted", "confirmed", "failed", "unknown"]),
  trigger: z.string(),
  txHash: txHash.nullable(),
  explorerUrl: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: timeSchema,
  finishedAt: timeSchema.nullable().optional(),
  items: z.array(z.object({ account: addressSchema, creditBefore: atomicSchema, creditAfter: atomicSchema.nullable(), paid: atomicSchema, outcome: z.enum(["pending", "paid", "kept"]) })),
});
export type Payout = z.infer<typeof payoutSchema>;

export const payoutsSchema = z.object({ accounts: z.array(payoutAccountSchema), payouts: z.array(payoutSchema) });
export type Payouts = z.infer<typeof payoutsSchema>;

export const payoutRunSchema = z.union([z.object({ payouts: z.array(payoutSchema), waitingRegistration: z.array(addressSchema) }), z.object({ skipped: z.string() })]);
export type PayoutRun = z.infer<typeof payoutRunSchema>;

export const revokeResultSchema = z.union([
  z.object({
    budget: budgetSchema,
    onchain: z
      .object({
        revoked: z.boolean(),
        submitted: z.boolean().optional(),
        txHash: txHash.nullable().optional(),
        /** The wallet transaction that revokes on chain, when the node could not record the revoke itself. */
        call: z.object({ receiverId: addressSchema, actions: z.array(z.object({ type: z.literal("FunctionCall"), params: z.object({ methodName: z.string(), args: z.record(z.string(), z.unknown()), gas: z.string(), deposit: z.string() }) })) }).nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  budgetSchema.transform((budget) => ({ budget, onchain: null })),
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
export const paymentMethodSchema = z.enum(CHECKOUT_METHODS);

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
  tx_hash: txHash.nullable(),
  /** The accepted clearing Call of a voucher credit. */
  call_id: bytes32Schema.nullable().optional(),
  /** Hub block time of a wallet payment, Unix milliseconds as a decimal string. */
  recorded_at_ms: z.string().nullable().optional(),
  batch_id: txHash.nullable().optional(),
  status: z.enum(["pending", "confirmed"]),
  late: z.boolean().default(false),
  created_at: timeSchema,
  confirmed_at: nullableTime,
});
export type Credit = z.infer<typeof creditSchema>;

/** CheckoutTerms as JSON: what the node signed for one checkout payment. */
export const checkoutTermsSchema = z.object({ payment_id: bytes32Schema, merchant: addressSchema, amount: atomicSchema, expiry_ms: atomicSchema });
export type CheckoutTermsJson = z.infer<typeof checkoutTermsSchema>;

const functionCallSchema = z.object({
  type: z.literal("FunctionCall"),
  params: z.object({ methodName: z.string(), args: z.record(z.string(), z.unknown()), gas: z.string(), deposit: z.string() }),
});

/**
 * What the hosted checkout hands the payer's wallet (`CheckoutWallet`): terms the node signed with its checkout key, and
 * the ready `ft_transfer_call` to the hub. The hub verifies the signature, amount and expiry and returns the tokens for
 * anything else.
 */
export const checkoutWalletSchema = z.object({
  terms: checkoutTermsSchema,
  signature: z.string().regex(/^[0-9a-f]{128}$/, "expected a 64-byte signature"),
  checkout_key: z.string(),
  transaction: z.object({ receiverId: addressSchema, actions: z.array(functionCallSchema).min(1) }),
});
export type CheckoutWalletJson = z.infer<typeof checkoutWalletSchema>;

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

/** The NEAR network a gateway object lives on. Optional until the gateway wire types carry it; testnet by default. */
const networkField = z.string().default("near:testnet");

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
  network: networkField,
  token: tokenSchema,
  /** The hub that receives `ft_transfer_call`. */
  hub: addressSchema,
  method: paymentMethodSchema.nullable().default(null),
  methods: z.array(paymentMethodSchema),
  /** Signed terms and the prebuilt transaction; null once the payment cannot take money, or when `wallet` is not offered. */
  wallet: checkoutWalletSchema.nullable().default(null),
  success_url: nullableString,
  tx_hash: txHash.nullable().optional(),
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
});
export type CheckoutView = z.infer<typeof checkoutViewSchema>;


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
  network: networkField,
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
  method: z.enum(["transfer"]).nullable().optional(),
  /** How the node checked the refund transaction: the whole transfer, or only success at final finality. */
  verification: z.enum(["transfer_checked", "finality_only"]).nullable().optional(),
  tx_hash: txHash.nullable(),
  failure_reason: nullableString,
  /** Internal note, never shown to the customer (PRODUCT.md section 10.12). */
  note: nullableString,
  /** Staff refunds wait for an Admin (10.12): not_required, requested or approved. */
  approval: z.enum(["not_required", "requested", "approved"]).optional(),
  requested_by: nullableString,
  approved_by: nullableString,
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
  network: networkField,
  token: addressSchema,
  /** The hub that records the wallet payment. */
  hub: addressSchema.optional(),
  /** The on-chain payment id the checkout terms carry. */
  checkout_id: bytes32Schema.optional(),
  /** The account fixed at creation that receives this payment. */
  payout: addressSchema.nullable().optional(),
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
  /** Null for a business that has not proven a payout account yet. */
  payout: addressSchema.nullable(),
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
  network: networkField,
  token: addressSchema,
  /** The hub payments are recorded on. */
  hub: addressSchema.nullable().optional(),
  /** The key the hub checks checkout terms against. */
  checkout_key: z.string().nullable().optional(),
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

const METHOD_ORDER = ["wallet", "deposit", "x402", "voucher"];

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

/**
 * What the receipt page checks: the node's claims about a paid payment, re-read from the hub in the browser. On NEAR a
 * checkout payment is one `ft_transfer_call` that the hub records under the checkout terms' payment id.
 */
export const paymentProofSchema = z.object({
  payment_id: z.string(),
  status: paymentStatusSchema,
  network: networkField,
  /** The hub the payment was recorded on. */
  hub: addressSchema.nullable().optional(),
  token: addressSchema,
  payout: addressSchema,
  amount_due: atomicSchema,
  amount_paid: atomicSchema,
  /** Amount of the payment in `tx_hash`; the hub record must show the same. */
  credit_amount: atomicSchema.nullable().optional(),
  method: paymentMethodSchema.nullable(),
  payer: addressSchema.nullable(),
  tx_hash: txHash.nullable(),
  /** The Id32 the hub stores the payment under (`CheckoutTerms.paymentId`). */
  hub_payment_id: bytes32Schema.nullable().optional(),
  order_hash: bytes32Schema,
  paid_at: nullableTime,
});
export type PaymentProof = z.infer<typeof paymentProofSchema>;

/** GET /v1/checkout/{id}/proof as the node serves it (with credits), mapped to PaymentProof. */
export const nodeProofSchema = z
  .object({
    payment_id: z.string(),
    status: paymentStatusSchema,
    network: networkField,
    hub: addressSchema.nullable().optional(),
    token: z.union([addressSchema, tokenSchema.passthrough()]),
    payout: addressSchema,
    amount_due: atomicSchema,
    amount_paid: atomicSchema,
    order_hash: bytes32Schema,
    hub_payment_id: bytes32Schema.nullable().optional(),
    paid_at: nullableTime,
    credits: z.array(
      z
        .object({
          method: paymentMethodSchema,
          amount: atomicSchema,
          payer: addressSchema.nullable(),
          /** Voucher credits: the settling batch's transaction. Wallet credits carry none; the hub record is the evidence. */
          tx_hash: txHash.nullable().optional(),
          /** Wallet credits: the id the hub recorded the payment under. */
          checkout_id: bytes32Schema.nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
  .transform((n): PaymentProof => {
    const c = n.credits.filter((x) => x.method === "wallet" && x.checkout_id).at(-1) ?? n.credits.at(-1) ?? null;
    return {
      payment_id: n.payment_id,
      status: n.status,
      network: n.network,
      hub: n.hub ?? null,
      token: typeof n.token === "string" ? n.token : n.token.address,
      payout: n.payout,
      amount_due: n.amount_due,
      amount_paid: n.amount_paid,
      credit_amount: c?.amount ?? null,
      method: c?.method ?? null,
      payer: c?.payer ?? null,
      tx_hash: c?.tx_hash ?? null,
      hub_payment_id: c?.checkout_id ?? n.hub_payment_id ?? null,
      order_hash: n.order_hash,
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

export const AI_PROVIDER_IDS = ["anthropic", "openai", "google", "openai_compatible", "replicate", "nearai"] as const;
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
