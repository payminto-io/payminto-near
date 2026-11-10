import {
  checkoutUrl,
  linkUrl,
  type AccountId,
  type ApiKey,
  type BudgetRefusal,
  type Credit,
  type Id32,
  type LineItem,
  type Network,
  type Payment,
  type PaymentLink,
  type CheckoutMethod,
  type PaymentMethod,
  type PaymentRefundStatus,
  type PaymentStatus,
  type Refund,
  type RefundStatus,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
} from "@payminto/protocol";
import type { DenialNotice } from "../vouchers.ts";

// ---------------------------------------------------------------------------
// Rows (migrations/001_near.sql). Amounts are decimal text of base units, accounts are NEAR account ids.
// ---------------------------------------------------------------------------

export type PaymentRow = {
  id: string;
  merchant_id: string;
  status: PaymentStatus;
  amount: string;
  quote_method: CheckoutMethod | null;
  surcharge: string;
  amount_due: string;
  platform_fee: string;
  method_fee: string;
  fee_total: string;
  net_amount: string;
  fee_recipient: AccountId | null;
  amount_paid: string;
  amount_refunded: string;
  /** The hub's payment id in the checkout terms. */
  checkout_id: Id32;
  payout: AccountId;
  description: string | null;
  reference: string | null;
  customer_email: string | null;
  customer_name: string | null;
  metadata: string;
  line_items: string;
  order_hash: Id32;
  link_id: string | null;
  payer: AccountId | null;
  method: CheckoutMethod | null;
  late: number;
  success_url: string | null;
  /** Reported by the payer's wallet after it sent the checkout transaction; display only. */
  wallet_tx_hash: string | null;
  expires_at: string;
  expires_unix: number;
  paid_at: string | null;
  canceled_at: string | null;
  closed_at: string | null;
  /** 1 while this is a draft an unpaid x402 request created. */
  draft: number;
  draft_key: string | null;
  created_at: string;
  updated_at: string;
};

export type CreditRow = {
  id: number;
  payment_id: string;
  method: CheckoutMethod;
  payer: AccountId | null;
  amount: string;
  tx_hash: string | null;
  checkout_id: Id32 | null;
  recorded_at_ms: number | null;
  call_id: Id32 | null;
  batch_id: Id32 | null;
  status: "pending" | "confirmed";
  late: number;
  created_at: string;
  confirmed_at: string | null;
  /** Any-chain credits: the 1Click quote whose deposit this is. */
  intents_quote_id?: string | null;
};

export type LinkRow = {
  id: string;
  merchant_id: string;
  slug: string;
  title: string;
  description: string | null;
  amount: string | null;
  min_amount: string | null;
  max_amount: string | null;
  collect_email: number;
  collect_name: number;
  success_url: string | null;
  active: number;
  listed: number;
  max_payments: number | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RefundRow = {
  id: string;
  merchant_id: string;
  payment_id: string;
  amount: string;
  reason: string | null;
  to_addr: AccountId;
  status: RefundStatus;
  method: "transfer" | null;
  tx_hash: string | null;
  verification: "transfer_checked" | "finality_only" | null;
  submitted_unix: number | null;
  failure_reason: string | null;
  note: string | null;
  approval: "not_required" | "requested" | "approved";
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EndpointRow = {
  id: string;
  /** Null for a platform endpoint. */
  merchant_id: string | null;
  url: string;
  description: string | null;
  events: string;
  active: number;
  secret: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  failing_since: number | null;
  disabled_reason: string | null;
};

export type GatewayEventRow = {
  seq: number;
  id: string;
  /** Null for a platform event. */
  merchant_id: string | null;
  type: WebhookEventType | "ping";
  object_id: string;
  payment_id: string | null;
  body: string;
  created: number;
  created_at: string;
};

export type DeliveryRow = {
  seq: number;
  id: string;
  event_id: string;
  endpoint_id: string;
  url: string;
  attempt: number;
  manual: number;
  status: "pending" | "succeeded" | "failed";
  scheduled_unix: number;
  response_status: number | null;
  response_body: string | null;
  duration_ms: number | null;
  error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  attempted_at: string | null;
};

export type ApiKeyRow = {
  id: string;
  merchant_id: string;
  name: string | null;
  livemode: number;
  prefix: string;
  secret_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** JSON array narrowing the key (run-scoped agent keys); null = every API key permission. */
  permissions?: string | null;
  /** Set on a run-scoped key of an ops agent run (docs/AGENTS.md section 4); such keys are not listed. */
  agent_run_id?: string | null;
  expires_at?: string | null;
};

// ---------------------------------------------------------------------------
// API shapes: exactly the exported types in packages/protocol/src/gateway.ts.
// ---------------------------------------------------------------------------

export type ModelContext = { network: Network; livemode: boolean; hub: AccountId; token: AccountId; checkoutBaseUrl: string };

export function refundStatusOf(paid: bigint, refunded: bigint): PaymentRefundStatus {
  if (refunded === 0n) return "none";
  return refunded >= paid ? "full" : "partial";
}

/** Payment (protocol type) plus the fee recipient its fee is bound to. */
export type PaymentJson = Payment & { fee_recipient: AccountId | null };

export function paymentJson(r: PaymentRow, m: ModelContext): PaymentJson {
  return {
    id: r.id,
    merchant_id: r.merchant_id,
    livemode: m.livemode,
    status: r.status,
    amount: r.amount,
    surcharge: r.surcharge,
    amount_due: r.amount_due,
    platform_fee: r.platform_fee,
    method_fee: r.method_fee,
    fee_total: r.fee_total,
    net_amount: r.net_amount,
    amount_paid: r.amount_paid,
    amount_refunded: r.amount_refunded,
    refund_status: refundStatusOf(BigInt(r.amount_paid), BigInt(r.amount_refunded)),
    network: m.network,
    token: m.token,
    hub: m.hub,
    checkout_id: r.checkout_id,
    description: r.description,
    reference: r.reference,
    customer_email: r.customer_email,
    customer_name: r.customer_name,
    metadata: JSON.parse(r.metadata) as Record<string, string>,
    line_items: JSON.parse(r.line_items) as LineItem[],
    order_hash: r.order_hash,
    link_id: r.link_id,
    payer: r.payer,
    payout: r.payout,
    // The method the fees were quoted for; a person who never picked one is shown the method that paid. With the
    // any-chain checkout on, this can be `oneclick` (CHECKOUT_METHODS), which the core Payment type does not list.
    method: (r.quote_method ?? r.method) as PaymentMethod | null,
    late: r.late === 1,
    success_url: r.success_url,
    checkout_url: checkoutUrl(m.checkoutBaseUrl, r.id),
    expires_at: r.expires_at,
    paid_at: r.paid_at,
    canceled_at: r.canceled_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    fee_recipient: r.fee_recipient,
  };
}

export function creditJson(r: CreditRow): Credit {
  return {
    payment_id: r.payment_id,
    // `oneclick` on a node with the any-chain checkout on (see paymentJson).
    method: r.method as PaymentMethod,
    payer: r.payer,
    amount: r.amount,
    tx_hash: r.tx_hash,
    batch_id: r.batch_id,
    call_id: r.call_id,
    recorded_at_ms: r.recorded_at_ms === null ? null : String(r.recorded_at_ms),
    status: r.status,
    late: r.late === 1,
    created_at: r.created_at,
    confirmed_at: r.confirmed_at,
  };
}

export function linkJson(
  r: LinkRow,
  m: ModelContext,
  counters: { payments_count: number; paid_total: string },
): PaymentLink & { merchant_id: string; expires_at: string | null; expired: boolean; created_by: string | null } {
  return {
    merchant_id: r.merchant_id,
    expires_at: r.expires_at ?? null,
    expired: r.expires_at ? Date.parse(r.expires_at) <= Date.now() : false,
    created_by: r.created_by ?? null,
    id: r.id,
    livemode: m.livemode,
    slug: r.slug,
    url: linkUrl(m.checkoutBaseUrl, r.slug),
    title: r.title,
    description: r.description,
    amount: r.amount,
    min_amount: r.min_amount,
    max_amount: r.max_amount,
    collect_email: r.collect_email === 1,
    collect_name: r.collect_name === 1,
    success_url: r.success_url,
    active: r.active === 1,
    listed: r.listed === 1,
    max_payments: r.max_payments,
    payments_count: counters.payments_count,
    paid_total: counters.paid_total,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function refundJson(r: RefundRow, m: ModelContext): Refund & { note: string | null; approval: RefundRow["approval"]; requested_by: string | null; approved_by: string | null; approved_at: string | null; merchant_id: string } {
  return {
    merchant_id: r.merchant_id,
    note: r.note ?? null,
    approval: r.approval ?? "not_required",
    requested_by: r.requested_by ?? null,
    approved_by: r.approved_by ?? null,
    approved_at: r.approved_at ?? null,
    id: r.id,
    livemode: m.livemode,
    payment_id: r.payment_id,
    amount: r.amount,
    reason: r.reason,
    to: r.to_addr,
    status: r.status,
    method: r.method,
    tx_hash: r.tx_hash,
    verification: r.verification,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function endpointJson(r: EndpointRow, m: Pick<ModelContext, "livemode">, withSecret = false): WebhookEndpoint {
  return {
    id: r.id,
    livemode: m.livemode,
    url: r.url,
    description: r.description,
    events: JSON.parse(r.events) as WebhookEndpoint["events"],
    active: r.active === 1,
    ...(withSecret ? { secret: r.secret } : {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function deliveryJson(r: DeliveryRow & { event_type: WebhookDelivery["event_type"]; body?: string }): WebhookDelivery & { request_body: string | null; scheduled_at: string } {
  return {
    id: r.id,
    event_id: r.event_id,
    event_type: r.event_type,
    endpoint_id: r.endpoint_id,
    url: r.url,
    attempt: r.attempt,
    status: r.status,
    response_status: r.response_status,
    response_body: r.response_body,
    duration_ms: r.duration_ms,
    error: r.error,
    created_at: r.created_at,
    next_attempt_at: r.status === "pending" ? isoOf(r.scheduled_unix) : r.next_attempt_at,
    scheduled_at: isoOf(r.scheduled_unix),
    // Dashboard extra: the exact body that was signed and sent.
    request_body: r.body ?? null,
  };
}

export function apiKeyJson(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    name: r.name,
    livemode: r.livemode === 1,
    prefix: r.prefix,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
  };
}

export const isoOf = (unix: number) => new Date(unix * 1000).toISOString();

/** The `budget.refused` webhook object: the rule, attempted amount, remaining Budget and retry hint of one refusal. */
export function refusalJson(n: DenialNotice): BudgetRefusal {
  const d = n.denial;
  return {
    id: d.id,
    object: "refusal",
    rule: d.rule,
    message: d.message,
    budget_id: d.budget_id,
    owner: n.owner,
    agent: d.agent,
    payee: d.payee,
    provider_id: d.provider_id,
    attempted_amount: n.refusal?.attemptedAmount ?? d.amount,
    remaining_budget: n.refusal?.remainingBudget ?? null,
    retry: n.refusal?.retry ?? { kind: "never" },
    request_hash: d.request_hash,
    cumulative: d.cumulative,
    created_at: d.at,
  };
}
