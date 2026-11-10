import {
  nep413Digest,
  payoutChangeMessage,
  payoutProofRequest,
  signDigest,
  verifyWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  type AccountId,
  type ApiKey,
  type ApiKeyWithSecret,
  type CheckoutView,
  type Credit,
  type FeeBearer,
  type FeePlan,
  type Keypair,
  type LineItem,
  type Merchant,
  type MerchantMethod,
  type MerchantProfile,
  type MerchantStatus,
  type Network,
  type Payment,
  type PaymentLink,
  type PaymentMethod,
  type PaymentProof,
  type PaymentStatus,
  type PayoutProof,
  type PayoutProofScope,
  type Platform,
  type PublicKey,
  type ReconciliationReport,
  type Refund,
  type WalletTx,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
  type WebhookEventType,
} from "@payminto/protocol";
import { errorSchema, NodeApiError } from "./node-api.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Response types. Objects are the protocol types (docs/GATEWAY.md section 8); the extras are what the node adds (section 15).

/** Amounts are decimal strings of token base units; bigints are accepted on input and sent as strings. */
type Units = string | bigint;

/** The settlement token as the gateway describes it: a NEP-141 contract account. */
type Token = { address: AccountId; symbol: string; decimals: number };

export type List<T> = { items: T[]; next_cursor: string | null };

/** A payment as the merchant API returns it: the public object plus the account its platform fee is paid to. */
export type GatewayPayment = Payment & { fee_recipient: AccountId | null };

export type PaymentTimelineEvent = {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: { status: PaymentStatus | null; amount_paid: string | null; amount: string | null };
};

/** A refund as the merchant API returns it: the public object plus its approval state and who asked for it. */
export type GatewayRefund = Refund & {
  merchant_id: string;
  note: string | null;
  /** `requested`: waits for an Admin of the business. `approved` or `not_required`: the payout account can send it. */
  approval: "not_required" | "requested" | "approved";
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
};

/**
 * A refund with the transaction that pays it: an `ft_transfer` of the refund amount to the payer, for the merchant's
 * payout account to send from its own wallet (the node never holds the money). Null while the refund waits for
 * approval, and once it is no longer pending.
 */
export type RefundWithTransfer = GatewayRefund & { transfer: WalletTx | null };

/** `GET /v1/payments/{id}`: the payment with every credit, refund and event. */
export type PaymentDetail = GatewayPayment & { credits: Credit[]; refunds: GatewayRefund[]; events: PaymentTimelineEvent[] };

export type PaymentList = List<GatewayPayment> & { counts: Record<string, number> };

/** One change of a merchant's payout account. `proven` is false only for the account the node was seeded with. */
export type PayoutChange = { old_payout: AccountId | null; new_payout: AccountId; proven: boolean; public_key: PublicKey | null; signed_at: number | null; changed_at: string };

export type MerchantDetail = MerchantProfile & { fee_plan: FeePlan; methods: MerchantMethod[]; volume_30d: string; payments_30d: number; payout_history: PayoutChange[] };

/** The last 30 days of one business (`GET /v1/gateway/overview`). */
export type MerchantOverview = { volume: string; payments: number; counts: Record<string, number>; conversion: number; days: Array<{ day: string; volume: string; count: number }> };

export type PlatformEarnings = {
  fee_recipient: AccountId | null;
  totals: { platform_fee: string; method_fee: string; fee_total: string };
  items: Array<{ merchant_id: string; merchant_name: string; method: PaymentMethod | null; payments: number; volume: string; platform_fee: string; method_fee: string; fee_total: string }>;
  /** The last 30 days by the day a payment was paid (UTC), each split by method. */
  days: Array<{ day: string; fee_total: string; by_method: Record<string, string> }>;
};

export type ScreeningDecision = {
  id: string;
  source: "gateway";
  rule: string;
  message: string;
  stage: string;
  payer: AccountId | null;
  payout: AccountId | null;
  payment_id: string | null;
  link_id: string | null;
  merchant_id: string | null;
  amount: string | null;
  created_at: string;
} & Record<string, unknown>;

export type DirectoryService =
  | {
      type: "link";
      id: string;
      merchant: { id: string; name: string };
      title: string;
      description: string | null;
      price: { amount: string } | { min_amount: string | null; max_amount: string | null };
      token: Token;
      network: Network;
      /** x402 schemes the link accepts. Empty when the business takes no voucher payments. */
      schemes: string[];
      pay_url: string;
    }
  | {
      type: "endpoint";
      id: string;
      title: string;
      description: string;
      category: string;
      price: { amount: string };
      payee: AccountId;
      token: Token;
      network: Network;
      schemes: string[];
      pay_url: string;
    };

/** `GET /v1/directory` (and `/.well-known/payminto.json`), section 13.4. */
export type Directory = {
  version: number;
  node: { url: string; network: Network; hub: AccountId; checkout_base_url: string };
  platform: { name: string };
  generated_at: string;
  services: DirectoryService[];
};

// ---------------------------------------------------------------------------------------------------------------------
// Request types (snake_case like the objects, except refunds, which section 6 spells in camelCase).

export type CreatePaymentParams = {
  amount: Units;
  /** `wallet`: a person pays from a NEAR wallet. `voucher`: an agent pays from its Budget over x402. */
  method?: PaymentMethod;
  description?: string | null;
  reference?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  metadata?: Record<string, string>;
  line_items?: LineItem[];
  success_url?: string | null;
  expires_in?: number;
};

export type ListPaymentsParams = {
  status?: PaymentStatus | PaymentStatus[];
  link_id?: string;
  email?: string;
  q?: string;
  refunded?: boolean;
  limit?: number;
  cursor?: string;
};

export type CreateLinkParams = {
  title: string;
  description?: string | null;
  /** Fixed price; leave out and pass min_amount and max_amount to let the payer choose. */
  amount?: Units | null;
  min_amount?: Units | null;
  max_amount?: Units | null;
  collect_email?: boolean;
  collect_name?: boolean;
  success_url?: string | null;
  max_payments?: number | null;
  /** Shown in the service directory (default true). */
  listed?: boolean;
  /** ISO 8601 time with a zone after which the link takes no new payments. */
  expires_at?: string | null;
};

export type UpdateLinkParams = Partial<Pick<PaymentLink, "title" | "description" | "active" | "success_url" | "max_payments" | "listed">> & { expires_at?: string | null };

export type CreateRefundParams = {
  paymentId: string;
  amount: Units;
  reason?: string | null;
  /** The account to refund. Default: the account that paid. */
  to?: AccountId;
  /** A note for the business's own records. */
  note?: string | null;
  /** Always ask an Admin of the business to approve it, even when this key could issue it. */
  requestApproval?: boolean;
};

/** `from` and `to`: ISO 8601 times with a zone, or YYYY-MM-DD dates (UTC); a date `to` covers that whole day. */
export type ReconciliationParams = { from: string | Date; to: string | Date };

/** The hash of the transaction the payout account sent with the refund's `transfer`. */
export type SubmitRefundParams = { txHash: string };

export type CreateWebhookParams = { url: string; description?: string | null; events: Array<WebhookEventType | "*"> };
export type UpdateWebhookParams = Partial<CreateWebhookParams & { active: boolean }>;

export type MerchantProfileParams = { name?: string; support_email?: string | null; brand_color?: string | null; logo_url?: string | null };

export type CreateMerchantParams = MerchantProfileParams & { name: string; slug?: string; fee_plan_id?: string; payout: PayoutProof };
export type UpdateMerchantParams = MerchantProfileParams & { status?: MerchantStatus; fee_plan_id?: string };

export type MethodSettings = {
  method: PaymentMethod;
  enabled?: boolean;
  fee_bps?: number;
  fee_fixed?: Units;
  bearer?: FeeBearer;
  min_amount?: Units | null;
  max_amount?: Units | null;
};

export type CreateFeePlanParams = { name: string; platform_fee_bps: number; platform_fee_fixed?: Units; min_fee?: Units | null; max_fee?: Units | null };
export type UpdateFeePlanParams = Partial<CreateFeePlanParams>;

export type RequestOptions = {
  /** `Idempotency-Key` header (payments, links and refunds): the same key and body within 24 h return the stored response. */
  idempotencyKey?: string;
};

// ---------------------------------------------------------------------------------------------------------------------
// Payout proofs (NEP-413)

/** The message a payout account signs (section 14.3), and the proof the node takes, re-exported from the protocol. */
export { payoutChangeMessage, payoutProofRequest, type PayoutProof, type PayoutProofScope };

/** What a NEP-413 `signMessage` is asked to sign: the payout message, the hub as recipient, and a 32-byte nonce. */
export type PayoutSignRequest = { message: string; recipient: string; nonce: Uint8Array };

/**
 * Whoever can sign for the payout account. It has the shape of a NEAR wallet's `signMessage` (NEAR Connect, wallet
 * selector): given the request, it returns the base64 ed25519 signature and the key that made it. That key must be a
 * full-access key of `accountId`; the node checks that on chain, so a function-call key is refused.
 */
export type PayoutSigner = {
  accountId: AccountId;
  signMessage(request: PayoutSignRequest): Promise<{ signature: string; publicKey: PublicKey }>;
};

function base64(hex: string): string {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

/**
 * A PayoutSigner over a key held in this process, for a server or a script that controls the payout account's
 * full-access key. A browser uses the account's wallet instead.
 */
export function payoutSignerFromKey(accountId: AccountId, key: Keypair): PayoutSigner {
  return { accountId, signMessage: async (request) => ({ signature: base64(signDigest(key.secretKey, nep413Digest(request))), publicKey: key.publicKey }) };
}

/**
 * Proves control of a payout account to one node: the account signs a NEP-413 message that names the merchant, the
 * account, the time, and that node's network and hub (`scope`, from `GatewayClient.payoutScope()`), so the proof cannot
 * be replayed on another node. `merchantId` is "new" for a merchant being created. The node accepts proofs up to 600 s
 * old.
 */
export async function signPayoutProof(signer: PayoutSigner, merchantId: string, scope: PayoutProofScope, timestamp = Math.floor(Date.now() / 1000)): Promise<PayoutProof> {
  const signed = await signer.signMessage(payoutProofRequest(merchantId, signer.accountId, timestamp, scope));
  return { payout: signer.accountId, timestamp, public_key: signed.publicKey, signature: signed.signature };
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhooks

export { verifyWebhook, WEBHOOK_SIGNATURE_HEADER };

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * Verifies a `Payminto-Signature` header over the raw request body and returns the parsed event. Throws
 * WebhookSignatureError on a missing, stale or wrong signature, so nothing unverified is ever parsed.
 * Pass the exact bytes received (`await req.text()`, `express.raw()`), never a re-serialized object.
 */
export async function constructEvent(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<WebhookEvent> {
  if (!secret?.startsWith("whsec_")) throw new WebhookSignatureError("the webhook secret must be the whsec_ value shown when the endpoint was created");
  if (!header) throw new WebhookSignatureError(`missing ${WEBHOOK_SIGNATURE_HEADER} header`);
  if (!(await verifyWebhook(rawBody, header, secret, opts))) {
    throw new WebhookSignatureError("webhook signature does not match the body, or its timestamp is outside the tolerance");
  }
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    throw new WebhookSignatureError("signed webhook body is not JSON");
  }
  if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") throw new WebhookSignatureError("signed webhook body is not an event");
  return event as WebhookEvent;
}

// ---------------------------------------------------------------------------------------------------------------------
// Client

export type GatewayClientOptions = {
  /** Base URL of the Payminto node. */
  nodeUrl: string;
  /** A merchant secret key (`sk_test_...`, `sk_live_...`), or the operator's admin token. */
  apiKey: string;
  /** Sent as `Merchant-Id`: the merchant the admin token acts for (needed once the node has more than one). */
  merchantId?: string;
  fetch?: typeof fetch;
};

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

function wire(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/**
 * Merchant and operator client for the Payminto Gateway API (docs/GATEWAY.md sections 8 and 14): payments, links,
 * refunds, webhooks, the merchant profile, screening and the directory with a merchant key; merchants, fee plans,
 * the platform and API keys with the operator's admin token. Errors are NodeApiError with the node's code.
 */
export class GatewayClient {
  readonly nodeUrl: string;
  readonly merchantId: string | undefined;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(o: GatewayClientOptions) {
    if (typeof o.nodeUrl !== "string" || !/^https?:\/\/[^/]/i.test(o.nodeUrl)) throw new TypeError("GatewayClient requires nodeUrl: the http(s) URL of the node");
    if (!o.apiKey) throw new TypeError("GatewayClient requires apiKey: a merchant secret key or the admin token");
    this.nodeUrl = o.nodeUrl.replace(/\/+$/, "");
    this.merchantId = o.merchantId;
    this.#apiKey = o.apiKey;
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Merchant-Id for a per-merchant route: only the admin token sends it (a merchant key is scoped already). */
  #adminFor(id: string): string | undefined {
    return this.#apiKey.startsWith("sk_") ? undefined : id;
  }

  /** The same credentials acting for another merchant (admin token only). */
  forMerchant(merchantId: string): GatewayClient {
    return new GatewayClient({ nodeUrl: this.nodeUrl, apiKey: this.#apiKey, merchantId, fetch: this.#fetch });
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, o: { body?: unknown; query?: Query; idempotencyKey?: string; auth?: boolean; merchantId?: string } = {}): Promise<T> {
    const url = new URL(`${this.nodeUrl}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (o.auth !== false) headers.authorization = `Bearer ${this.#apiKey}`;
    const actingFor = o.merchantId ?? this.merchantId;
    if (o.auth !== false && actingFor) headers["merchant-id"] = actingFor;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
    const res = await this.#fetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(wire(o.body)) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new NodeApiError(res.status, "BAD_RESPONSE", `node returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const e = errorSchema.safeParse(json);
      if (e.success) throw new NodeApiError(res.status, e.data.error.code, e.data.error.message, e.data.error.details);
      throw new NodeApiError(res.status, "HTTP_ERROR", `HTTP ${res.status} for ${method} ${path}`);
    }
    return json as T;
  }

  readonly payments = {
    /** Creates a payment; the result carries `checkout_url` and the fee breakdown. */
    create: (p: CreatePaymentParams, o: RequestOptions = {}) => this.request<GatewayPayment>("POST", "/v1/payments", { body: p, idempotencyKey: o.idempotencyKey }),
    list: (p: ListPaymentsParams = {}) => this.request<PaymentList>("GET", "/v1/payments", { query: p as Query }),
    retrieve: (id: string) => this.request<PaymentDetail>("GET", `/v1/payments/${encodeURIComponent(id)}`),
    /** Only while `open`. */
    cancel: (id: string) => this.request<GatewayPayment>("POST", `/v1/payments/${encodeURIComponent(id)}/cancel`, { body: {} }),
  };

  readonly links = {
    create: (p: CreateLinkParams, o: RequestOptions = {}) => this.request<PaymentLink>("POST", "/v1/links", { body: p, idempotencyKey: o.idempotencyKey }),
    list: (p: { limit?: number; cursor?: string } = {}) => this.request<List<PaymentLink>>("GET", "/v1/links", { query: p }),
    retrieve: (id: string) => this.request<PaymentLink>("GET", `/v1/links/${encodeURIComponent(id)}`),
    update: (id: string, p: UpdateLinkParams) => this.request<PaymentLink>("PATCH", `/v1/links/${encodeURIComponent(id)}`, { body: p }),
  };

  /**
   * Refunds are non-custodial: the node never holds the money. `create` files a pending refund and returns `transfer`,
   * the `ft_transfer` the merchant's payout account sends from its own wallet (null while the refund waits for an Admin
   * to approve it). `submit` reports that transaction's hash, and the node checks it on chain before the refund succeeds.
   */
  readonly refunds = {
    create: (p: CreateRefundParams, o: RequestOptions = {}) => this.request<RefundWithTransfer>("POST", "/v1/refunds", { body: p, idempotencyKey: o.idempotencyKey }),
    list: (p: { payment_id?: string; limit?: number; cursor?: string } = {}) => this.request<List<GatewayRefund>>("GET", "/v1/refunds", { query: p }),
    retrieve: (id: string) => this.request<RefundWithTransfer>("GET", `/v1/refunds/${encodeURIComponent(id)}`),
    /** An Admin of the business approves a requested refund (a person or the operator; an API key cannot). */
    approve: (id: string) => this.request<RefundWithTransfer>("POST", `/v1/refunds/${encodeURIComponent(id)}/approve`, { body: {} }),
    /** Reports the transaction the payout account sent. Pending until it is final; failed if it does not pay the refund. */
    submit: (id: string, p: SubmitRefundParams) => this.request<GatewayRefund>("POST", `/v1/refunds/${encodeURIComponent(id)}/submit`, { body: p }),
    cancel: (id: string) => this.request<GatewayRefund>("POST", `/v1/refunds/${encodeURIComponent(id)}/cancel`, { body: {} }),
  };

  readonly webhooks = {
    /** The result carries `secret` (`whsec_...`), shown here and on reveal or rotation only. */
    create: (p: CreateWebhookParams) => this.request<WebhookEndpoint & { secret: string }>("POST", "/v1/webhooks", { body: p }),
    list: () => this.request<{ items: WebhookEndpoint[] }>("GET", "/v1/webhooks"),
    retrieve: (id: string) => this.request<WebhookEndpoint>("GET", `/v1/webhooks/${encodeURIComponent(id)}`),
    revealSecret: (id: string) => this.request<{ secret: string }>("GET", `/v1/webhooks/${encodeURIComponent(id)}/secret`),
    update: (id: string, p: UpdateWebhookParams) => this.request<WebhookEndpoint>("PATCH", `/v1/webhooks/${encodeURIComponent(id)}`, { body: p }),
    delete: (id: string) => this.request<{ id: string; deleted: true }>("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`),
    rotateSecret: (id: string) => this.request<WebhookEndpoint & { secret: string }>("POST", `/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`, { body: {} }),
    /** Sends a `ping` event now and returns its delivery. */
    test: (id: string) => this.request<WebhookDelivery>("POST", `/v1/webhooks/${encodeURIComponent(id)}/test`, { body: {} }),
    deliveries: (id: string, p: { limit?: number; cursor?: string } = {}) => this.request<List<WebhookDelivery>>("GET", `/v1/webhooks/${encodeURIComponent(id)}/deliveries`, { query: p }),
    retryDelivery: (deliveryId: string) => this.request<WebhookDelivery>("POST", `/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/retry`, { body: {} }),
  };

  /** The merchant this key (or `merchantId`) acts for. */
  readonly merchant = {
    retrieve: () => this.request<MerchantDetail>("GET", "/v1/merchant"),
    update: (p: MerchantProfileParams) => this.request<MerchantDetail>("PATCH", "/v1/merchant", { body: p }),
    overview: () => this.request<MerchantOverview>("GET", "/v1/gateway/overview"),
  };

  readonly screening = {
    decisions: (p: { limit?: number; cursor?: string } = {}) => this.request<List<ScreeningDecision>>("GET", "/v1/screening/decisions", { query: p }),
    denyList: () => this.request<{ items: Array<{ address: AccountId; reason: string | null; created_at: string }> }>("GET", "/v1/screening/deny-list"),
    /** Blocks a NEAR account from paying this business. */
    deny: (address: AccountId, reason?: string) => this.request<{ address: AccountId; reason: string | null }>("POST", "/v1/screening/deny-list", { body: { address, reason: reason ?? null } }),
    allow: (address: AccountId) => this.request<{ address: AccountId; deleted: true }>("DELETE", `/v1/screening/deny-list/${encodeURIComponent(address)}`),
  };

  /**
   * The reconciliation report for a date range (section 16): one row per payment created in it with fees, net,
   * refunds, transactions and proofs, plus totals. Amounts are decimal token units with base units alongside.
   */
  reconciliation(p: ReconciliationParams): Promise<ReconciliationReport> {
    const at = (v: string | Date) => (v instanceof Date ? v.toISOString() : v);
    return this.request<ReconciliationReport>("GET", "/v1/reports/reconciliation", { query: { from: at(p.from), to: at(p.to), format: "json" } });
  }

  // ------------------------------------------------------------------ operator (admin token)

  readonly merchants = {
    /** Creates a merchant; `payout` is a proof from `signPayoutProof(payoutSigner, "new", await client.payoutScope())`. */
    create: (p: CreateMerchantParams) => this.request<MerchantDetail>("POST", "/v1/merchants", { body: p }),
    list: () => this.request<{ items: Merchant[] }>("GET", "/v1/merchants"),
    retrieve: (id: string) => this.request<MerchantDetail & { stats: MerchantOverview }>("GET", `/v1/merchants/${encodeURIComponent(id)}`),
    update: (id: string, p: UpdateMerchantParams) => this.request<MerchantDetail>("PATCH", `/v1/merchants/${encodeURIComponent(id)}`, { body: p }),
    /** Changes the payout; `proof` from `signPayoutProof(newPayoutSigner, id, await client.payoutScope())`. */
    changePayout: (id: string, proof: PayoutProof) => this.request<MerchantDetail>("POST", `/v1/merchants/${encodeURIComponent(id)}/payout`, { body: proof }),
    // The methods routes also take a merchant key, so the admin token names the merchant with Merchant-Id as well.
    methods: (id: string) => this.request<{ items: MerchantMethod[] }>("GET", `/v1/merchants/${encodeURIComponent(id)}/methods`, { merchantId: this.#adminFor(id) }),
    /** The operator sets fees and limits; a merchant key may only enable or disable its own methods. */
    setMethods: (id: string, methods: MethodSettings[]) =>
      this.request<{ items: MerchantMethod[] }>("PUT", `/v1/merchants/${encodeURIComponent(id)}/methods`, { body: { methods }, merchantId: this.#adminFor(id) }),
  };

  readonly feePlans = {
    create: (p: CreateFeePlanParams) => this.request<FeePlan>("POST", "/v1/fee-plans", { body: p }),
    list: () => this.request<{ items: FeePlan[] }>("GET", "/v1/fee-plans"),
    retrieve: (id: string) => this.request<FeePlan>("GET", `/v1/fee-plans/${encodeURIComponent(id)}`),
    update: (id: string, p: UpdateFeePlanParams) => this.request<FeePlan>("PATCH", `/v1/fee-plans/${encodeURIComponent(id)}`, { body: p }),
  };

  readonly platform = {
    retrieve: () => this.request<Platform>("GET", "/v1/platform"),
    update: (p: { name?: string; default_fee_plan_id?: string }) => this.request<Platform>("PATCH", "/v1/platform", { body: p }),
    /** Fees earned, by merchant and method (paid and overpaid payments). */
    fees: () => this.request<PlatformEarnings>("GET", "/v1/platform/fees"),
  };

  /** Admin token only; acts for `merchantId` (or the node's only merchant). The secret is shown once, at creation. */
  readonly apiKeys = {
    create: (name?: string) => this.request<ApiKeyWithSecret & { merchant_id: string }>("POST", "/v1/api-keys", { body: { name: name ?? null } }),
    list: () => this.request<{ items: ApiKey[] }>("GET", "/v1/api-keys"),
    revoke: (id: string) => this.request<ApiKey>("DELETE", `/v1/api-keys/${encodeURIComponent(id)}`),
  };

  // ------------------------------------------------------------------ public

  /** What this node sells to agents (section 13.4). Needs no key. */
  directory(): Promise<Directory> {
    return this.request<Directory>("GET", "/v1/directory", { auth: false });
  }

  /** The network and hub a payout proof for this node must name (from its public `/v1/info`). Needs no key. */
  async payoutScope(): Promise<PayoutProofScope> {
    const info = await this.request<{ network: { id: Network }; hub: AccountId }>("GET", "/v1/info", { auth: false });
    return { network: info.network.id, hub: info.hub };
  }

  /** The public side of one payment: what the hosted checkout shows, and its proof once it is paid. Needs no key. */
  readonly checkout = {
    retrieve: (paymentId: string) => this.request<CheckoutView>("GET", `/v1/checkout/${encodeURIComponent(paymentId)}`, { auth: false }),
    /** Chain evidence for a paid payment: the hub's record of a wallet payment, or the settled batch of a voucher. */
    proof: (paymentId: string) => this.request<PaymentProof>("GET", `/v1/checkout/${encodeURIComponent(paymentId)}/proof`, { auth: false }),
  };
}
