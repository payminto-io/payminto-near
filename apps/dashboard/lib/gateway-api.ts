/**
 * Typed clients for the gateway routes in docs/GATEWAY.md section 8.
 * GatewayApi is the merchant side (admin token, used inside the console); CheckoutApi is the public side used by the
 * hosted checkout with no sign-in. In mock mode both are served by lib/mock/gateway.ts from one in-browser store.
 */
import { z } from "zod";
import type { AccountId, Network } from "@payminto/protocol";
import {
  apiKeySchema,
  checkoutViewSchema,
  createdApiKeySchema,
  createdPaymentRefSchema,
  gatewayOverviewSchema,
  gatewayPageSchema,
  infoSchema,
  intentsOptionsSchema,
  intentsPayoutSchema,
  intentsQuoteSchema,
  merchantProfileSchema,
  paymentDetailSchema,
  paymentLinkSchema,
  paymentSchema,
  publicLinkSchema,
  refundSchema,
  webhookDeliverySchema,
  webhookEndpointSchema,
  webhookSecretSchema,
  denyListEntrySchema,
  orderCommitmentSchema,
  anyProofSchema,
  screeningDecisionSchema,
  type DenyListEntry,
  type PaymentProof,
  type ScreeningDecision,
  type ApiKey,
  type CheckoutView,
  type CreatedApiKey,
  type GatewayOverview,
  type Info,
  type IntentsOptions,
  type IntentsPayout,
  type IntentsQuote,
  type MerchantProfile,
  type Payment,
  type PaymentDetail,
  type PaymentLink,
  type PaymentMethod,
  type PaymentStatus,
  type PublicLink,
  type Refund,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "./schemas";
import { MOCK_MODE, NODE_URL } from "./config";
import { isSameOrigin, requestJson, type RequestOptions } from "./http";
import type { ServedOrder } from "./payment-proof";
import { liveReader, type ReaderSource } from "./near-reader";
import { ApiError } from "./http";
import { getMerchantScope, roleOf } from "./merchant-scope";

/** Account ids and hashes are opaque text at this boundary; the node validates them. */
type Address = string;

export type GatewayPage<T> = { items: T[]; nextCursor: string | null; counts: Record<string, number> | null };

/** `merchant_id` narrows the platform view to one business (sent as Merchant-Id); `method` is the way it was paid. */
export type PaymentsQuery = { status?: PaymentStatus[]; method?: PaymentMethod[]; merchant_id?: string; refunded?: boolean; link_id?: string; email?: string; q?: string; limit?: number; cursor?: string };

export type CreateLinkBody = {
  title: string;
  description?: string;
  amount?: string | null;
  min_amount?: string | null;
  max_amount?: string | null;
  collect_email?: boolean;
  collect_name?: boolean;
  success_url?: string | null;
  max_payments?: number | null;
  listed?: boolean;
  /** ISO time at least 60 s ahead, or null for no expiry (PRODUCT.md section 10.12). */
  expires_at?: string | null;
};
export type UpdateLinkBody = Partial<Pick<PaymentLink, "title" | "description" | "active" | "success_url" | "max_payments" | "listed">> & { expires_at?: string | null };

/** Request bodies follow GATEWAY.md section 6 literally (camelCase), unlike the snake_case response objects. */
export type CreateRefundBody = { paymentId: string; amount: string; reason?: string; to?: Address; note?: string };
/** The merchant's own NEAR refund transaction (an ft_transfer from the payout account), which the node verifies. */
export type SubmitRefundBody = { txHash: string };

export type CreateWebhookBody = { url: string; description?: string; events: string[] };
export type UpdateWebhookBody = Partial<Pick<WebhookEndpoint, "url" | "description" | "events" | "active">>;
export type MerchantPatch = Partial<Pick<MerchantProfile, "name" | "support_email" | "brand_color" | "logo_url">>;

export interface GatewayApi {
  overview(): Promise<GatewayOverview>;
  payments(q?: PaymentsQuery): Promise<GatewayPage<Payment>>;
  payment(id: string): Promise<PaymentDetail>;
  cancelPayment(id: string): Promise<Payment>;
  links(): Promise<PaymentLink[]>;
  link(id: string): Promise<PaymentLink>;
  createLink(body: CreateLinkBody, idempotencyKey: string): Promise<PaymentLink>;
  updateLink(id: string, patch: UpdateLinkBody): Promise<PaymentLink>;
  refunds(q?: { payment_id?: string; limit?: number; cursor?: string }): Promise<GatewayPage<Refund>>;
  createRefund(body: CreateRefundBody, idempotencyKey: string): Promise<Refund>;
  submitRefund(id: string, body: SubmitRefundBody): Promise<Refund>;
  cancelRefund(id: string): Promise<Refund>;
  /** An Admin approves a Staff refund request (refunds.approve, PRODUCT.md section 10.12). */
  approveRefund(id: string): Promise<Refund>;
  updateRefundNote(id: string, note: string): Promise<Refund>;
  webhooks(): Promise<WebhookEndpoint[]>;
  webhook(id: string): Promise<WebhookEndpoint>;
  /** The signing secret on explicit reveal (admin token). */
  revealWebhookSecret(id: string): Promise<string>;
  createWebhook(body: CreateWebhookBody): Promise<WebhookEndpoint>;
  updateWebhook(id: string, patch: UpdateWebhookBody): Promise<WebhookEndpoint>;
  deleteWebhook(id: string): Promise<void>;
  rotateWebhookSecret(id: string): Promise<WebhookEndpoint>;
  testWebhook(id: string): Promise<void>;
  deliveries(endpointId: string, q?: { limit?: number; cursor?: string }): Promise<GatewayPage<WebhookDelivery>>;
  retryDelivery(id: string): Promise<WebhookDelivery>;
  apiKeys(): Promise<ApiKey[]>;
  createApiKey(body: { name: string }): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<void>;
  /** The open business, or `merchantId` (a detail page on the platform view names the record's own business). */
  merchant(merchantId?: string): Promise<MerchantProfile>;
  updateMerchant(patch: MerchantPatch): Promise<MerchantProfile>;
  denyList(): Promise<DenyListEntry[]>;
  addDeny(body: { address: Address; note?: string }): Promise<DenyListEntry>;
  removeDeny(address: Address): Promise<void>;
  /** Refused gateway requests (GATEWAY.md section 13.1). */
  screeningDecisions(): Promise<ScreeningDecision[]>;
  /** The reconciliation report as CSV (section 16) for [from, to), ISO instants, for the open business or `merchantId`. */
  reconciliationCsv(range: { from: string; to: string }, merchantId?: string): Promise<string>;
  /** The business's NEAR account for any-chain payments and its checks, read now (`GET /v1/merchant/intents-payout`). */
  intentsPayout(): Promise<IntentsPayout>;
  /** Sets and proves that account (`PUT /v1/merchant/intents-payout`); the server asks for a fresh password check. */
  setIntentsPayout(body: IntentsPayoutBody): Promise<IntentsPayout>;
}

/** The account and its NEP-413 answer to `intentsPayoutProofRequest`. */
export type IntentsPayoutBody = { account: string; proof: { timestamp: number; public_key: string; signature: string } };

export type CheckoutUpdate = { view: CheckoutView } | { live: boolean };

/**
 * Whose webhook endpoints: one business's (payments, refunds, refusals to it), or the platform's own, which receive
 * `budget.refused` for every refusal on this server (`/v1/platform/webhooks`).
 */
export type WebhookScope = "business" | "platform";

/** The endpoint and delivery routes, the same shape in both scopes. */
export type WebhookApi = Pick<
  GatewayApi,
  "webhooks" | "webhook" | "revealWebhookSecret" | "createWebhook" | "updateWebhook" | "deleteWebhook" | "rotateWebhookSecret" | "testWebhook" | "deliveries" | "retryDelivery"
>;

/** What a reader is built for: the payment's network and hub, and the RPC the node advertises (used only on a sandbox). */
export type ReaderContext = { network: Network; hub: AccountId; rpcUrl?: string | null };

export interface CheckoutApi {
  readonly mock: boolean;
  info(): Promise<Info>;
  checkout(id: string): Promise<CheckoutView>;
  /** Picks the method for an open, untouched payment; the node re-quotes fees and surcharge for it. */
  chooseMethod(id: string, method: "wallet"): Promise<CheckoutView>;
  /** The canonical order JSON behind order_hash, as served (raw bytes) and parsed. */
  order(id: string): Promise<ServedOrder>;
  /** The node's claims about a paid payment, re-checked on chain by the receipt page. */
  proof(id: string): Promise<PaymentProof>;
  link(slug: string): Promise<PublicLink>;
  payFromLink(slug: string, body: { amount?: string; email?: string; name?: string }): Promise<{ id: string }>;
  addEmail(id: string, email: string): Promise<void>;
  /** SSE stream of `status` events carrying the public view; null when the browser has no EventSource. */
  eventsUrl(id: string): string | null;
  /** In-process stream (mock mode). */
  subscribe?(id: string, listener: (view: CheckoutView) => void): () => void;
  /**
   * The NEAR reader the receipt page checks a payment with: the configured RPC (the network's public one by default),
   * or the demo hub in mock mode. Null only when no RPC is known for the network; the chain checks then report skipped.
   */
  reader(ctx: ReaderContext): ReaderSource | null;
  /** Reports the transaction the payer's wallet sent (`POST /v1/checkout/{id}/wallet`). Display only: the hub record is the evidence. */
  walletSent(id: string, txHash: string): Promise<void>;
  /** The origins a buyer can pay from, each with an indicative price from a signed dry quote, or greyed with a reason. */
  intentsOptions(id: string): Promise<IntentsOptions>;
  /** A deposit address for one origin (`POST .../intents/quotes`); the same key makes a retry safe. */
  createIntentsQuote(id: string, body: { origin_asset: string; refund_to: string }, idempotencyKey: string): Promise<IntentsQuote>;
  intentsQuote(id: string, quoteId: string): Promise<IntentsQuote>;
  /** "I've sent it": the buyer's transaction on the origin chain, which only speeds up detection. */
  submitIntentsDeposit(id: string, quoteId: string, txHash: string): Promise<IntentsQuote>;
  /** Simulated mode only: the fake 1Click server receives a deposit of `amount` base units (default: the full amount). */
  simulateIntentsDeposit(id: string, quoteId: string, amount?: string): Promise<IntentsQuote>;
}

/** Bare arrays or `{ items }` envelopes, since list envelopes for unpaged routes are not pinned in the spec. */
function listOf<T extends z.ZodType>(item: T) {
  return z.union([z.array(item), z.object({ items: z.array(item) }).transform((o) => o.items)]) as unknown as z.ZodType<z.infer<T>[]>;
}

const anyBody = z.unknown();

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class HttpGatewayApi implements GatewayApi {
  /** Only the admin token sends Merchant-Id; a merchant key is already scoped. */
  private readonly scoped: boolean;
  /** "/v1" for a business's endpoints, "/v1/platform" for the platform's. */
  private readonly hooks: string;
  constructor(
    private readonly nodeUrl: string,
    private readonly token: string,
    webhooks: WebhookScope = "business",
  ) {
    this.scoped = roleOf(token) === "operator" && webhooks === "business";
    this.hooks = webhooks === "platform" ? "/v1/platform" : "/v1";
  }

  private req<T>(path: string, schema: z.ZodType<T>, init: RequestOptions = {}): Promise<T> {
    const scope = this.scoped ? getMerchantScope() : null;
    return requestJson(this.nodeUrl, path, schema, { ...init, token: this.token, headers: { ...(scope ? { "Merchant-Id": scope } : {}), ...init.headers } });
  }
  private post<T>(path: string, schema: z.ZodType<T>, body: unknown = {}, idempotencyKey?: string): Promise<T> {
    return this.req(path, schema, { method: "POST", body: JSON.stringify(body), idempotencyKey });
  }
  private patch<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    return this.req(path, schema, { method: "PATCH", body: JSON.stringify(body) });
  }

  overview() {
    return this.req("/v1/gateway/overview", gatewayOverviewSchema);
  }
  payments(q: PaymentsQuery = {}) {
    const { status, method, refunded, merchant_id, ...rest } = q;
    return this.req(`/v1/payments${qs({ ...rest, status: status?.join(","), method: method?.join(","), refunded })}`, gatewayPageSchema(paymentSchema), merchant_id ? { headers: { "Merchant-Id": merchant_id } } : {});
  }
  payment(id: string) {
    return this.req(`/v1/payments/${encodeURIComponent(id)}`, paymentDetailSchema);
  }
  cancelPayment(id: string) {
    return this.post(`/v1/payments/${encodeURIComponent(id)}/cancel`, paymentSchema);
  }
  links() {
    return this.req("/v1/links", listOf(paymentLinkSchema));
  }
  link(id: string) {
    return this.req(`/v1/links/${encodeURIComponent(id)}`, paymentLinkSchema);
  }
  createLink(body: CreateLinkBody, idempotencyKey: string) {
    return this.post("/v1/links", paymentLinkSchema, body, idempotencyKey);
  }
  updateLink(id: string, patch: UpdateLinkBody) {
    return this.patch(`/v1/links/${encodeURIComponent(id)}`, paymentLinkSchema, patch);
  }
  refunds(q: { payment_id?: string; limit?: number; cursor?: string } = {}) {
    return this.req(`/v1/refunds${qs(q)}`, gatewayPageSchema(refundSchema));
  }
  createRefund(body: CreateRefundBody, idempotencyKey: string) {
    return this.post("/v1/refunds", refundSchema, body, idempotencyKey);
  }
  submitRefund(id: string, body: SubmitRefundBody) {
    return this.post(`/v1/refunds/${encodeURIComponent(id)}/submit`, refundSchema, body);
  }
  cancelRefund(id: string) {
    return this.post(`/v1/refunds/${encodeURIComponent(id)}/cancel`, refundSchema);
  }
  approveRefund(id: string) {
    return this.post(`/v1/refunds/${encodeURIComponent(id)}/approve`, refundSchema);
  }
  updateRefundNote(id: string, note: string) {
    return this.patch(`/v1/refunds/${encodeURIComponent(id)}`, refundSchema, { note });
  }
  webhooks() {
    return this.req(`${this.hooks}/webhooks`, listOf(webhookEndpointSchema));
  }
  webhook(id: string) {
    return this.req(`${this.hooks}/webhooks/${encodeURIComponent(id)}`, webhookEndpointSchema);
  }
  revealWebhookSecret(id: string) {
    return this.req(`${this.hooks}/webhooks/${encodeURIComponent(id)}/secret`, webhookSecretSchema);
  }
  createWebhook(body: CreateWebhookBody) {
    return this.post(`${this.hooks}/webhooks`, webhookEndpointSchema, body);
  }
  updateWebhook(id: string, patch: UpdateWebhookBody) {
    return this.patch(`${this.hooks}/webhooks/${encodeURIComponent(id)}`, webhookEndpointSchema, patch);
  }
  async deleteWebhook(id: string) {
    await this.req(`${this.hooks}/webhooks/${encodeURIComponent(id)}`, anyBody, { method: "DELETE" });
  }
  rotateWebhookSecret(id: string) {
    return this.post(`${this.hooks}/webhooks/${encodeURIComponent(id)}/rotate-secret`, webhookEndpointSchema);
  }
  async testWebhook(id: string) {
    await this.post(`${this.hooks}/webhooks/${encodeURIComponent(id)}/test`, anyBody);
  }
  deliveries(endpointId: string, q: { limit?: number; cursor?: string } = {}) {
    return this.req(`${this.hooks}/webhooks/${encodeURIComponent(endpointId)}/deliveries${qs(q)}`, gatewayPageSchema(webhookDeliverySchema));
  }
  retryDelivery(id: string) {
    return this.post(`${this.hooks}/webhook-deliveries/${encodeURIComponent(id)}/retry`, webhookDeliverySchema);
  }
  apiKeys() {
    return this.req("/v1/api-keys", listOf(apiKeySchema));
  }
  createApiKey(body: { name: string }) {
    return this.post("/v1/api-keys", createdApiKeySchema, body);
  }
  async revokeApiKey(id: string) {
    await this.req(`/v1/api-keys/${encodeURIComponent(id)}`, anyBody, { method: "DELETE" });
  }
  merchant(merchantId?: string) {
    return this.req("/v1/merchant", merchantProfileSchema, merchantId ? { headers: { "Merchant-Id": merchantId } } : {});
  }
  updateMerchant(patch: MerchantPatch) {
    return this.patch("/v1/merchant", merchantProfileSchema, patch);
  }
  denyList() {
    return this.req("/v1/screening/deny-list", listOf(denyListEntrySchema));
  }
  addDeny(body: { address: Address; note?: string }) {
    return this.post("/v1/screening/deny-list", denyListEntrySchema, { address: body.address, reason: body.note });
  }
  async removeDeny(address: Address) {
    await this.req(`/v1/screening/deny-list/${address}`, anyBody, { method: "DELETE" });
  }
  screeningDecisions() {
    return this.req("/v1/screening/decisions", listOf(screeningDecisionSchema));
  }
  /** CSV is not JSON, so this reads the body as text; errors still come back as the node's JSON error. */
  async reconciliationCsv(range: { from: string; to: string }, merchantId?: string) {
    const scope = merchantId ?? (this.scoped ? getMerchantScope() : null);
    let res: Response;
    try {
      res = await fetch(`${this.nodeUrl}/v1/reports/reconciliation${qs({ ...range, format: "csv" })}`, {
        headers: { Accept: "text/csv", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(scope ? { "Merchant-Id": scope } : {}) },
        ...(isSameOrigin(this.nodeUrl) ? { credentials: "same-origin" as const } : {}),
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "NODE_UNREACHABLE", "Cannot reach the Payminto server. Check that it is running.");
    }
    const text = await res.text();
    if (res.ok) return text;
    let error: { code?: string; message?: string; details?: unknown } | undefined;
    try {
      error = (JSON.parse(text) as { error?: typeof error }).error;
    } catch {
      // Not the node's JSON error (a proxy page, for example).
    }
    throw new ApiError(res.status, error?.code ?? "HTTP_ERROR", error?.message ?? `The report could not be made (status ${res.status}).`, error?.details);
  }
  intentsPayout() {
    return this.req("/v1/merchant/intents-payout", intentsPayoutSchema);
  }
  setIntentsPayout(body: IntentsPayoutBody) {
    return this.req("/v1/merchant/intents-payout", intentsPayoutSchema, { method: "PUT", body: JSON.stringify(body) });
  }
}

export class HttpCheckoutApi implements CheckoutApi {
  readonly mock = false;
  constructor(private readonly nodeUrl: string) {}

  info() {
    return requestJson(this.nodeUrl, "/v1/info", infoSchema);
  }
  checkout(id: string) {
    return requestJson(this.nodeUrl, `/v1/checkout/${encodeURIComponent(id)}`, checkoutViewSchema);
  }
  chooseMethod(id: string, method: "wallet") {
    return requestJson(this.nodeUrl, `/v1/checkout/${encodeURIComponent(id)}/method`, checkoutViewSchema, { method: "POST", body: JSON.stringify({ method }) });
  }
  async order(id: string): Promise<ServedOrder> {
    let res: Response;
    try {
      res = await fetch(`${this.nodeUrl}/v1/checkout/${encodeURIComponent(id)}/order`, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      throw new ApiError(0, "NODE_UNREACHABLE", "The payment service did not answer.");
    }
    const raw = await res.text();
    if (!res.ok) throw new ApiError(res.status, "HTTP_ERROR", `The order could not be loaded (HTTP ${res.status}).`);
    const parsed = orderCommitmentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new ApiError(res.status, "SHAPE_MISMATCH", "Unexpected order shape.");
    return { raw, order: parsed.data };
  }
  proof(id: string) {
    return requestJson(this.nodeUrl, `/v1/checkout/${encodeURIComponent(id)}/proof`, anyProofSchema);
  }
  link(slug: string) {
    return requestJson(this.nodeUrl, `/v1/links/public/${encodeURIComponent(slug)}`, publicLinkSchema);
  }
  payFromLink(slug: string, body: { amount?: string; email?: string; name?: string }) {
    return requestJson(this.nodeUrl, `/v1/links/public/${encodeURIComponent(slug)}/payments`, createdPaymentRefSchema, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  private readonly readers = new Map<string, ReaderSource | null>();
  reader(ctx: ReaderContext): ReaderSource | null {
    const key = `${ctx.network} ${ctx.hub} ${ctx.rpcUrl ?? ""}`;
    if (!this.readers.has(key)) this.readers.set(key, liveReader(ctx.network, ctx.hub, ctx.rpcUrl));
    return this.readers.get(key) ?? null;
  }
  async walletSent(id: string, txHash: string) {
    await requestJson(this.nodeUrl, `/v1/checkout/${encodeURIComponent(id)}/wallet`, anyBody, { method: "POST", body: JSON.stringify({ tx_hash: txHash }) });
  }
  async addEmail(id: string, email: string) {
    await requestJson(this.nodeUrl, `/v1/checkout/${encodeURIComponent(id)}/email`, anyBody, { method: "POST", body: JSON.stringify({ email }) });
  }
  eventsUrl(id: string) {
    return typeof EventSource === "undefined" ? null : `${this.nodeUrl}/v1/checkout/${encodeURIComponent(id)}/events`;
  }
  private intents(id: string, rest = "") {
    return `/v1/checkout/${encodeURIComponent(id)}/intents${rest}`;
  }
  intentsOptions(id: string) {
    return requestJson(this.nodeUrl, this.intents(id, "/options"), intentsOptionsSchema);
  }
  createIntentsQuote(id: string, body: { origin_asset: string; refund_to: string }, idempotencyKey: string) {
    return requestJson(this.nodeUrl, this.intents(id, "/quotes"), intentsQuoteSchema, { method: "POST", body: JSON.stringify(body), idempotencyKey });
  }
  intentsQuote(id: string, quoteId: string) {
    return requestJson(this.nodeUrl, this.intents(id, `/quotes/${encodeURIComponent(quoteId)}`), intentsQuoteSchema);
  }
  submitIntentsDeposit(id: string, quoteId: string, txHash: string) {
    return requestJson(this.nodeUrl, this.intents(id, `/quotes/${encodeURIComponent(quoteId)}/deposit`), intentsQuoteSchema, { method: "POST", body: JSON.stringify({ tx_hash: txHash }) });
  }
  simulateIntentsDeposit(id: string, quoteId: string, amount?: string) {
    return requestJson(this.nodeUrl, this.intents(id, `/quotes/${encodeURIComponent(quoteId)}/simulate`), intentsQuoteSchema, { method: "POST", body: JSON.stringify(amount ? { amount } : {}) });
  }
}

let checkoutApi: Promise<CheckoutApi> | null = null;

/** The public client for the hosted checkout. One per tab. */
export function getCheckoutApi(): Promise<CheckoutApi> {
  checkoutApi ??= MOCK_MODE
    ? Promise.all([import("./mock/gateway"), import("./mock/install-wallet")]).then(([m, w]): CheckoutApi => {
        w.installMockWallet();
        return new m.MockCheckoutApi();
      })
    : Promise.resolve<CheckoutApi>(new HttpCheckoutApi(NODE_URL));
  return checkoutApi;
}
