import type { Context, Hono } from "hono";
import { streamSSE } from "../sse.ts";
import { z } from "zod";
import {
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  linkUrl,
  MAX_EXPIRES_IN_SECONDS,
  MIN_EXPIRES_IN_SECONDS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  isId,
  type AccountId,
  type PaymentMethod,
  type PaymentStatus,
  type PublicKey,
  type Refusal,
} from "@payminto/protocol";
import { ApiError } from "../errors.ts";
import { UnsignedVoucherError, type VoucherInput } from "../vouchers.ts";
import { body, cursorOf, limitOf, parse, rawBody, zAccount, zAmount, zPublicKey, zTxHash, zUint, zUrl } from "./http.ts";
import type { Gateway } from "./index.ts";
import { parsePaymentSignature, paymentFailure, paymentSuccess, sameRequirement, type ParsedPayment, type PaymentRequiredV2 } from "./x402-wire.ts";
import { feePlanJson, merchantJson, methodJson, type MerchantRow } from "./merchants.ts";
import type { PaymentRow } from "./model.ts";
import { auditActor, type Access, type Actor } from "../auth/actor.ts";
import type { BusinessPermission } from "../auth/permissions.ts";
import type { AuthService } from "../auth/service.ts";
import type { CustomerService } from "./customers.ts";
import { mountReports } from "./reports.ts";

type AuthedActor = Exclude<Actor, { type: "anonymous" }>;

// ---------------------------------------------------------------------------
// Request schemas (GATEWAY.md sections 8 and 14). Request bodies are snake_case like the objects, except the refund
// bodies, which section 6 spells in camelCase.
// ---------------------------------------------------------------------------

const zMethod = z.enum(PAYMENT_METHODS);
const zText = (max: number) => z.string().trim().min(1).max(max);
const zMetadata = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, "at most 50 metadata keys");
const zLineItems = z
  .array(z.object({ name: zText(200), quantity: z.number().int().min(1).max(1_000_000), unit_amount: zUint }))
  .max(100);
const zEmail = z.email().max(254);

const createPaymentSchema = z.object({
  amount: zAmount,
  method: zMethod.optional(),
  description: z.string().max(1000).nullish(),
  reference: z.string().max(200).nullish(),
  customer_email: zEmail.nullish(),
  customer_name: z.string().max(200).nullish(),
  metadata: zMetadata.optional(),
  line_items: zLineItems.optional(),
  success_url: zUrl.nullish(),
  expires_in: z.number().int().min(MIN_EXPIRES_IN_SECONDS).max(MAX_EXPIRES_IN_SECONDS).optional(),
});

const createLinkSchema = z.object({
  title: zText(200),
  description: z.string().max(1000).nullish(),
  amount: zAmount.nullish(),
  min_amount: zAmount.nullish(),
  max_amount: zAmount.nullish(),
  collect_email: z.boolean().optional(),
  collect_name: z.boolean().optional(),
  success_url: zUrl.nullish(),
  max_payments: z.number().int().min(1).nullish(),
  listed: z.boolean().optional(),
  expires_at: z.iso.datetime({ offset: true }).nullish(),
});

const updateLinkSchema = z.object({
  title: zText(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  active: z.boolean().optional(),
  success_url: zUrl.nullable().optional(),
  max_payments: z.number().int().min(1).nullable().optional(),
  listed: z.boolean().optional(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
});

const createRefundSchema = z.object({
  paymentId: z.string().refine((v) => isId("payment", v), "must be a payment id"),
  amount: zAmount,
  reason: z.string().max(500).nullish(),
  to: zAccount.optional(),
  note: z.string().max(1000).nullish(),
  /** Always ask an Admin to approve, even when the caller could issue it (the merchant MCP server sends true). */
  requestApproval: z.boolean().optional(),
});

/** The merchant's own refund transaction, sent from its payout account. */
const submitRefundSchema = z.object({ txHash: zTxHash });

const zEvents = z.array(z.string().min(1).max(60)).min(1).max(50);
const createWebhookSchema = z.object({ url: zUrl, description: z.string().max(500).nullish(), events: zEvents });
const updateWebhookSchema = z.object({ url: zUrl.optional(), description: z.string().max(500).nullable().optional(), events: zEvents.optional(), active: z.boolean().optional() });

const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb");
const merchantPatchSchema = z.object({
  name: zText(120).optional(),
  support_email: zEmail.nullable().optional(),
  brand_color: zColor.nullable().optional(),
  logo_url: zUrl.nullable().optional(),
});
const operatorMerchantPatchSchema = merchantPatchSchema.extend({ status: z.enum(["active", "suspended"]).optional(), fee_plan_id: z.string().min(1).optional() });

/** A NEP-413 proof: what NEAR Connect `signMessage` returns for `payoutProofRequest`, plus the account and the time signed. */
const payoutProofSchema = z.object({ payout: zAccount, timestamp: z.number().int().positive(), public_key: zPublicKey, signature: z.string().min(1).max(200) });
const createMerchantSchema = merchantPatchSchema.extend({
  name: zText(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes").optional(),
  fee_plan_id: z.string().min(1).optional(),
  payout: payoutProofSchema,
});

const methodsSchema = z.object({
  methods: z
    .array(
      z.object({
        method: zMethod,
        enabled: z.boolean().optional(),
        fee_bps: z.number().int().min(0).max(1000).optional(),
        fee_fixed: zUint.optional(),
        bearer: z.enum(["merchant", "customer"]).optional(),
        min_amount: zUint.nullable().optional(),
        max_amount: zUint.nullable().optional(),
      }),
    )
    .min(1)
    .max(PAYMENT_METHODS.length),
});

const feePlanSchema = z.object({
  name: zText(120),
  platform_fee_bps: z.number().int().min(0).max(1000),
  platform_fee_fixed: zUint.default("0"),
  min_fee: zUint.nullish().transform((v) => v ?? "0"),
  max_fee: zUint.nullable().default(null),
});
const feePlanPatchSchema = z.object({
  name: zText(120).optional(),
  platform_fee_bps: z.number().int().min(0).max(1000).optional(),
  platform_fee_fixed: zUint.optional(),
  min_fee: zUint.optional(),
  max_fee: zUint.nullable().optional(),
});
const platformPatchSchema = z.object({
  name: zText(120).optional(),
  default_fee_plan_id: z.string().min(1).optional(),
  signup_mode: z.enum(["off", "approval", "open"]).optional(),
  agent_budgets_for_businesses: z.boolean().optional(),
});

const walletSentSchema = z.object({ tx_hash: zTxHash.optional() });
const emailSchema = z.object({ email: zEmail });
const linkPaymentSchema = z.object({ amount: zAmount.optional(), email: zEmail.optional(), name: z.string().trim().min(1).max(200).optional(), method: zMethod.optional() });
const denySchema = z.object({ address: zAccount, reason: z.string().max(300).nullish() });

const idParam = (c: Context, kind: Parameters<typeof isId>[0], name = "id"): string => {
  const v = c.req.param(name);
  if (!isId(kind, v)) throw new ApiError(404, "NOT_FOUND", `no ${kind} with this id`);
  return v;
};

export type GatewayRouteDeps = {
  access: Access;
  auth: AuthService;
  customers: CustomerService | null;
  /** The client address used for per-IP limits (trusted proxy hops applied). */
  clientIp: (c: Context) => string;
  sseClosers: Set<() => void>;
  /** Public URL of this node, for receipt proof links in reports. */
  publicUrl?: string;
  /** Counts a voucher nobody signed against the caller's unsigned limit; a Response (429) replaces the plain error. */
  unsignedVoucher?: (c: Context, err: UnsignedVoucherError) => Response | null;
};

type Who = { merchant: MerchantRow; actor: AuthedActor };

/** Mounts every gateway route (GATEWAY.md sections 8, 13 and 14) on the node's Hono app. */
export function mountGateway(app: Hono<any>, g: Gateway, d: GatewayRouteDeps): void {
  const a = d.access;
  const audit = (who: AuthedActor, action: string, o: { merchantId?: string | null; target?: string | null; meta?: Record<string, unknown> } = {}) => d.auth.audit.write(auditActor(who), action, o);

  /** The business a request acts on, with a permission (PRODUCT.md 10.12). */
  const caller = (c: Context, perm: BusinessPermission): Who => a.business(c, perm);

  /** Runs `fn` under the Idempotency-Key header when one is sent. */
  const idempotent = async (c: Context, who: Who, fn: () => Promise<{ status: number; body: unknown }>) => {
    const key = c.req.header("idempotency-key");
    if (!key) {
      const out = await fn();
      return c.json(out.body as object, out.status as 200);
    }
    const out = await g.idempotency.run(`${who.merchant.id} ${c.req.method} ${c.req.routePath}`, key, await rawBody(c), fn);
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(out.body as object, out.status as 200);
  };

  // ================================================================ platform (platform roles, or the recovery key)

  const platformJson = () => ({
    ...g.merchants.platformJson(),
    smtp_configured: d.auth.mailer.configured,
    recovery_key_enabled: d.auth.settings.breakGlass && d.auth.ownerExists(),
    dashboard_url: d.auth.settings.dashboardUrl,
  });
  app.get("/v1/platform", (c) => (a.platform(c, "platform.read"), c.json(platformJson())));
  app.patch("/v1/platform", async (c) => {
    const b = await body(c, platformPatchSchema);
    const who = a.platform(c, "platform.manage");
    if (b.default_fee_plan_id) {
      a.platform(c, "pricing.manage");
      a.stepUp(who);
    }
    g.db.tx(() => {
      g.merchants.updatePlatform(b);
      audit(who, b.default_fee_plan_id ? "pricing.changed" : "platform.updated", { target: "platform", meta: { ...b, what: b.default_fee_plan_id ? "default plan" : undefined } });
    });
    return c.json(platformJson());
  });
  app.get("/v1/platform/fees", (c) => (a.platform(c, "earnings.read"), c.json(g.merchants.earnings())));

  app.get("/v1/fee-plans", (c) => (a.platform(c, "pricing.read"), c.json({ items: g.merchants.feePlans().map((p) => g.merchants.planJson(p)) })));
  app.post("/v1/fee-plans", async (c) => {
    const who = a.platform(c, "pricing.manage");
    a.stepUp(who);
    const b = await body(c, feePlanSchema);
    const plan = g.db.tx(() => {
      const p = g.merchants.createFeePlan(b);
      audit(who, "pricing.changed", { target: p.id, meta: { what: "plan created", name: p.name, platform_fee_bps: p.platform_fee_bps } });
      return p;
    });
    return c.json(g.merchants.planJson(plan), 201);
  });
  app.get("/v1/fee-plans/:id", (c) => (a.platform(c, "pricing.read"), c.json(g.merchants.planJson(g.merchants.feePlan(c.req.param("id"))))));
  app.patch("/v1/fee-plans/:id", async (c) => {
    const who = a.platform(c, "pricing.manage");
    a.stepUp(who);
    const b = await body(c, feePlanPatchSchema);
    const plan = g.db.tx(() => {
      const p = g.merchants.updateFeePlan(c.req.param("id"), b);
      audit(who, "pricing.changed", { target: p.id, meta: { what: "plan updated", ...b } });
      return p;
    });
    return c.json(g.merchants.planJson(plan));
  });

  app.get("/v1/merchants", (c) => (a.platform(c, "businesses.read"), c.json({ items: g.merchants.merchants().map((m) => ({ ...merchantJson(m, g.ctx), ...g.merchants.stats30d(m.id) })) })));
  app.post("/v1/merchants", async (c) => {
    const who = a.platform(c, "businesses.manage");
    const b = await body(c, createMerchantSchema);
    if (b.fee_plan_id) a.platform(c, "pricing.manage");
    // The proof names the merchant id, which does not exist yet: a new merchant signs with the literal "new".
    const proof = await g.verifyPayoutProof("new", b.payout);
    const m = g.db.tx(() => {
      const m = g.merchants.create({ ...b, payout: b.payout.payout, proof });
      audit(who, "business.created", { merchantId: m.id, target: m.id, meta: { name: m.name, payout: m.payout } });
      return m;
    });
    return c.json(g.merchants.profileJson(m), 201);
  });
  app.get("/v1/merchants/:id", (c) => {
    a.platform(c, "businesses.read");
    const m = g.merchants.merchant(c.req.param("id"));
    return c.json({ ...g.merchants.profileJson(m), stats: g.overview(m.id) });
  });
  app.patch("/v1/merchants/:id", async (c) => {
    const who = a.platform(c, "businesses.manage");
    const b = await body(c, operatorMerchantPatchSchema);
    if (b.fee_plan_id) a.platform(c, "pricing.manage");
    const m = g.db.tx(() => {
      const before = g.merchants.merchant(c.req.param("id"));
      const m = g.merchants.update(before.id, b);
      const action = b.status === "suspended" && before.status !== "suspended" ? "business.suspended" : b.fee_plan_id && b.fee_plan_id !== before.fee_plan_id ? "pricing.changed" : "business.updated";
      audit(who, action, { merchantId: m.id, target: m.id, meta: { name: m.name, ...b, what: action === "pricing.changed" ? "business plan" : undefined } });
      return m;
    });
    return c.json(g.merchants.profileJson(m));
  });
  // Payout change: the platform owner or the business's Admin, with a NEP-413 signature by a full-access key of the new account.
  app.post("/v1/merchants/:id/payout", async (c) => {
    const { merchant: m, actor } = a.business(c, "payout.change", c.req.param("id"));
    a.verified(actor);
    a.stepUp(actor);
    const id = m.id;
    const proof = await body(c, payoutProofSchema);
    const record = await g.verifyPayoutProof(id, proof);
    const { merchant, old } = g.db.tx(() => {
      const out = g.merchants.changePayout(id, proof.payout, record);
      g.webhooks.emit(id, "merchant.payout_changed", id, null, { ...merchantJson(out.merchant, g.ctx), previous_payout: out.old });
      audit(actor, "payout.changed", { merchantId: id, target: id, meta: { from: m.payout_set === 0 ? null : out.old, to: out.merchant.payout } });
      return out;
    });
    g.log.info("merchant payout changed", { merchantId: id, from: old, to: merchant.payout });
    return c.json(g.merchants.profileJson(merchant));
  });
  app.get("/v1/merchants/:id/methods", (c) => {
    const { merchant } = a.business(c, "payments.read", c.req.param("id"));
    return c.json({ items: g.merchants.methods(merchant.id).map(methodJson) });
  });
  // Platform roles set fees and limits; a business Admin or a merchant key may only enable or disable its own methods.
  app.put("/v1/merchants/:id/methods", async (c) => {
    const { merchant, actor } = a.business(c, "business.update", c.req.param("id"));
    const b = await body(c, methodsSchema);
    const terms = a.canBusiness(actor, "methods.terms", merchant.id);
    if (!terms && b.methods.some((m) => Object.keys(m).some((k) => k !== "method" && k !== "enabled"))) {
      throw new ApiError(403, "OPERATOR_ONLY", "fees and limits are set by the platform; a business can only enable or disable methods");
    }
    const items = g.db.tx(() => {
      const items = g.merchants.setMethods(merchant.id, b.methods, !terms);
      audit(actor, terms ? "pricing.changed" : "business.updated", { merchantId: merchant.id, target: merchant.id, meta: { what: "payment methods", methods: b.methods } });
      return items;
    });
    return c.json({ items: items.map(methodJson) });
  });

  // API keys: people only (not other keys), for the business named by Merchant-Id; create and revoke need a fresh password check.
  const keyAdmin = (c: Context, mutate: boolean) => {
    const who = caller(c, "developers.manage");
    if (who.actor.type === "api_key") throw new ApiError(401, "UNAUTHORIZED", "API keys are managed by people in the dashboard, not by other keys");
    if (mutate) {
      a.verified(who.actor);
      a.stepUp(who.actor);
    }
    return who;
  };
  app.post("/v1/api-keys", async (c) => {
    const who = keyAdmin(c, true);
    const b = await body(c, z.object({ name: z.string().trim().min(1).max(120).nullish() }));
    const key = g.db.tx(() => {
      const k = g.keys.create(who.merchant.id, b.name ?? null);
      audit(who.actor, "api_key.created", { merchantId: who.merchant.id, target: k.id, meta: { prefix: k.prefix, name: k.name } });
      return k;
    });
    return c.json(key, 201);
  });
  app.get("/v1/api-keys", (c) => c.json({ items: g.keys.list(keyAdmin(c, false).merchant.id) }));
  app.delete("/v1/api-keys/:id", (c) => {
    const who = keyAdmin(c, true);
    const out = g.db.tx(() => {
      const k = g.keys.revoke(who.merchant.id, idParam(c, "apiKey"));
      audit(who.actor, "api_key.revoked", { merchantId: who.merchant.id, target: k.id, meta: { prefix: k.prefix } });
      return k;
    });
    return c.json(out);
  });

  // ================================================================ business API (session, API key, or the recovery key + Merchant-Id)

  app.get("/v1/merchant", (c) => c.json(g.merchants.profileJson(caller(c, "payments.read").merchant)));
  app.patch("/v1/merchant", async (c) => {
    const who = caller(c, "business.update");
    const b = await body(c, merchantPatchSchema);
    const m = g.db.tx(() => {
      const m = g.merchants.update(who.merchant.id, b);
      audit(who.actor, "business.updated", { merchantId: m.id, target: m.id, meta: { name: m.name, ...b } });
      return m;
    });
    return c.json(g.merchants.profileJson(m));
  });

  app.get("/v1/gateway/overview", (c) => c.json(g.overview(caller(c, "payments.read").merchant.id)));
  // Reconciliation report (section 16).
  mountReports(app, g, { access: a, publicUrl: d.publicUrl ?? "" });

  app.post("/v1/payments", async (c) => {
    const who = caller(c, "payments.write");
    return idempotent(c, who, async () => {
      const b = await body(c, createPaymentSchema);
      const p = await g.payments.create(who.merchant, b);
      return { status: 201, body: g.payments.json(p) };
    });
  });
  app.get("/v1/payments", (c) => {
    const { merchantIds } = a.scope(c, "payments.read");
    const statusRaw = c.req.query("status");
    const status = statusRaw ? statusRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    if (status?.some((s) => !PAYMENT_STATUSES.includes(s as PaymentStatus))) throw new ApiError(400, "VALIDATION_ERROR", `status must be among ${PAYMENT_STATUSES.join(", ")}`);
    const methodRaw = c.req.query("method");
    const method = methodRaw ? methodRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    if (method?.some((m) => !PAYMENT_METHODS.includes(m as PaymentMethod))) throw new ApiError(400, "VALIDATION_ERROR", `method must be among ${PAYMENT_METHODS.join(", ")}`);
    const refunded = c.req.query("refunded");
    return c.json(
      g.payments.list(merchantIds, {
        status: status as PaymentStatus[] | undefined,
        method: method as PaymentMethod[] | undefined,
        link_id: c.req.query("link_id") || undefined,
        email: c.req.query("email") || undefined,
        q: c.req.query("q") || undefined,
        refunded: refunded === undefined || refunded === "" ? undefined : refunded === "true",
        limit: limitOf(c),
        cursor: cursorOf(c),
      }),
    );
  });
  /** A record of any business the actor sees: without Merchant-Id the record's own business is used when visible. */
  const ownerOf = (c: Context, perm: BusinessPermission, merchantId: string | undefined): Who => {
    const actor = a.authed(c);
    if (merchantId && !c.req.header("merchant-id") && actor.type !== "api_key" && a.canBusiness(actor, "payments.read", merchantId)) return a.business(c, perm, merchantId);
    return caller(c, perm);
  };
  app.get("/v1/payments/:id", (c) => {
    const id = idParam(c, "payment");
    return c.json(g.payments.detail(ownerOf(c, "payments.read", g.payments.row(id)?.merchant_id).merchant.id, id));
  });
  app.post("/v1/payments/:id/cancel", (c) => {
    const id = idParam(c, "payment");
    return c.json(g.payments.json(g.payments.cancel(ownerOf(c, "payments.write", g.payments.row(id)?.merchant_id).merchant.id, id)));
  });

  const linkOwner = (id: string) => g.db.get<{ merchant_id: string; created_by: string | null }>("SELECT merchant_id, created_by FROM payment_links WHERE id = ?", id);
  app.post("/v1/links", async (c) => {
    const who = caller(c, "links.write");
    return idempotent(c, who, async () => {
      const b = await body(c, createLinkSchema);
      const l = g.links.create(who.merchant.id, { ...b, created_by: who.actor.type === "user" ? who.actor.user.id : null });
      return { status: 201, body: g.links.json(l) };
    });
  });
  app.get("/v1/links", (c) => c.json(g.links.list(a.scope(c, "payments.read").merchantIds, limitOf(c), cursorOf(c))));

  // ---------------------------------------------------------------- public link routes (before /v1/links/:id)

  app.get("/v1/links/public/:slug", (c) => c.json(g.publicLink(g.links.bySlug(c.req.param("slug")))));
  app.post("/v1/links/public/:slug/payments", async (c) => {
    const l = g.links.bySlug(c.req.param("slug"));
    const b = await body(c, linkPaymentSchema);
    if (l.collect_email && !b.email) throw new ApiError(400, "EMAIL_REQUIRED", "this link asks for an email");
    if (l.collect_name && !b.name) throw new ApiError(400, "NAME_REQUIRED", "this link asks for a name");
    const m = g.merchants.merchant(l.merchant_id);
    const amount = g.links.amountFor(l, b.amount ?? null);
    const p = await g.payments.create(m, {
      amount,
      method: b.method ?? null,
      link_id: l.id,
      description: l.title,
      success_url: l.success_url,
      customer_email: b.email ?? null,
      customer_name: b.name ?? null,
    });
    return c.json({ ...g.checkoutView(p), checkout_url: g.payments.json(p).checkout_url }, 201);
  });

  app.get("/v1/links/:id", (c) => {
    const id = idParam(c, "link");
    const who = ownerOf(c, "payments.read", linkOwner(id)?.merchant_id);
    return c.json(g.links.json(g.links.get(who.merchant.id, id)));
  });
  app.patch("/v1/links/:id", async (c) => {
    const id = idParam(c, "link");
    const owner = linkOwner(id);
    const who = ownerOf(c, "links.write", owner?.merchant_id);
    // Staff edit only the links they created (PRODUCT.md 3.4).
    const staff = who.actor.type === "user" && !who.actor.user.platform_role && d.auth.membership(who.actor.user.id, who.merchant.id)?.role === "staff";
    if (staff && owner && who.actor.type === "user" && owner.created_by !== who.actor.user.id) {
      throw new ApiError(403, "FORBIDDEN", "Staff can edit only the payment links they created", { permission: "links.write" });
    }
    return c.json(g.links.json(g.links.update(who.merchant.id, id, await body(c, updateLinkSchema))));
  });

  const refundOwner = (id: string) => g.db.get<{ merchant_id: string; requested_by: string | null }>("SELECT merchant_id, requested_by FROM refunds WHERE id = ?", id);
  app.post("/v1/refunds", async (c) => {
    // The refund's business is the payment's, so a platform role needs no Merchant-Id here either.
    const paymentId = await rawBody(c)
      .then((t) => (t ? (JSON.parse(t) as { paymentId?: unknown }).paymentId : undefined))
      .catch(() => undefined);
    const who = ownerOf(c, "refunds.request", typeof paymentId === "string" ? g.payments.row(paymentId)?.merchant_id : undefined);
    return idempotent(c, who, async () => {
      const b = await body(c, createRefundSchema);
      // Staff request; an Admin approves before the payout wallet's signature can be submitted.
      const needsApproval = b.requestApproval === true || !a.canBusiness(who.actor, "refunds.issue", who.merchant.id);
      const r = g.db.tx(() => {
        const r = g.refunds.create(who.merchant.id, b, { requestedBy: who.actor.type === "user" ? who.actor.user.id : null, needsApproval });
        audit(who.actor, needsApproval ? "refund.requested" : "refund.issued", { merchantId: who.merchant.id, target: r.id, meta: { payment_id: r.payment_id, amount: r.amount } });
        return r;
      });
      return { status: 201, body: { ...g.refunds.json(r), transfer: needsApproval ? null : g.refunds.transferFor(r) } };
    });
  });
  app.get("/v1/refunds", (c) => {
    const { merchantIds } = a.scope(c, "payments.read");
    return c.json(g.refunds.list(merchantIds, { payment_id: c.req.query("payment_id") || undefined, limit: limitOf(c), cursor: cursorOf(c) }));
  });
  app.get("/v1/refunds/:id", (c) => {
    const id = idParam(c, "refund");
    const r = g.refunds.get(ownerOf(c, "payments.read", refundOwner(id)?.merchant_id).merchant.id, id);
    
    return c.json({ ...g.refunds.json(r), transfer: g.refunds.transferFor(r) });
  });
  app.patch("/v1/refunds/:id", async (c) => {
    const id = idParam(c, "refund");
    const who = ownerOf(c, "refunds.request", refundOwner(id)?.merchant_id);
    const { note } = await body(c, z.object({ note: z.string().max(1000).nullable() }));
    return c.json(g.refunds.json(g.refunds.setNote(who.merchant.id, id, note)));
  });
  app.post("/v1/refunds/:id/approve", (c) => {
    const id = idParam(c, "refund");
    const who = ownerOf(c, "refunds.approve", refundOwner(id)?.merchant_id);
    const r = g.db.tx(() => {
      const r = g.refunds.approve(who.merchant.id, id, who.actor.type === "user" ? who.actor.user.id : null);
      audit(who.actor, "refund.approved", { merchantId: who.merchant.id, target: r.id, meta: { payment_id: r.payment_id, amount: r.amount } });
      return r;
    });
    return c.json({ ...g.refunds.json(r), transfer: g.refunds.transferFor(r) });
  });
  app.post("/v1/refunds/:id/submit", async (c) => {
    const id = idParam(c, "refund");
    const who = ownerOf(c, "refunds.issue", refundOwner(id)?.merchant_id);
    const b = await body(c, submitRefundSchema);
    return c.json(g.refunds.json(await g.refunds.submit(who.merchant.id, id, b)));
  });
  app.post("/v1/refunds/:id/cancel", (c) => {
    const id = idParam(c, "refund");
    const owner = refundOwner(id);
    // A requester may withdraw their own request; otherwise canceling needs refunds.issue.
    const who = ownerOf(c, "refunds.request", owner?.merchant_id);
    if (!a.canBusiness(who.actor, "refunds.issue", who.merchant.id) && !(who.actor.type === "user" && owner?.requested_by === who.actor.user.id)) {
      throw new ApiError(403, "FORBIDDEN", "your role cannot cancel this refund", { permission: "refunds.issue" });
    }
    return c.json(g.refunds.json(g.refunds.cancel(who.merchant.id, id)));
  });

  // Customers (PRODUCT.md 10.14), derived from payments.
  app.get("/v1/customers", (c) => {
    const { merchantIds } = a.scope(c, "payments.read");
    const raw = c.req.query("cursor");
    if (raw && !/^\d+$/.test(raw)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    return c.json(d.customers!.list(merchantIds, { q: c.req.query("q") || undefined, limit: limitOf(c), cursor: raw ? Number(raw) : undefined }));
  });
  app.get("/v1/customers/:id", (c) => {
    const actor = a.authed(c);
    const header = c.req.header("merchant-id");
    const out = d.customers!.get(c.req.param("id"), (mid) => (header ? header === mid : true) && a.canBusiness(actor, "payments.read", mid));
    return c.json({ ...out.customer, recent_payments: out.recentPaymentIds.map((id) => g.payments.json(g.payments.row(id)!)) });
  });

  const dev = (c: Context) => caller(c, "developers.manage");
  app.post("/v1/webhooks", async (c) => {
    const who = dev(c);
    const out = await g.webhooks.create(who.merchant.id, await body(c, createWebhookSchema));
    audit(who.actor, "webhook.created", { merchantId: who.merchant.id, target: out.id, meta: { url: out.url } });
    return c.json(out, 201);
  });
  app.get("/v1/webhooks", (c) => c.json({ items: g.webhooks.endpoints(dev(c).merchant.id).map((e) => g.webhooks.json(e)) }));
  app.get("/v1/webhooks/:id", (c) => c.json(g.webhooks.json(g.webhooks.endpoint(dev(c).merchant.id, idParam(c, "webhookEndpoint")))));
  app.get("/v1/webhooks/:id/secret", (c) => c.json({ secret: g.webhooks.endpoint(dev(c).merchant.id, idParam(c, "webhookEndpoint")).secret }));
  app.patch("/v1/webhooks/:id", async (c) => {
    const who = dev(c);
    return c.json(await g.webhooks.update(who.merchant.id, idParam(c, "webhookEndpoint"), await body(c, updateWebhookSchema)));
  });
  app.delete("/v1/webhooks/:id", (c) => {
    const who = dev(c);
    g.db.tx(() => {
      g.webhooks.remove(who.merchant.id, idParam(c, "webhookEndpoint"));
      audit(who.actor, "webhook.deleted", { merchantId: who.merchant.id, target: c.req.param("id") });
    });
    return c.json({ id: c.req.param("id"), deleted: true });
  });
  app.post("/v1/webhooks/:id/rotate-secret", (c) => c.json(g.webhooks.rotateSecret(dev(c).merchant.id, idParam(c, "webhookEndpoint"))));
  app.post("/v1/webhooks/:id/test", async (c) => c.json(await g.webhooks.test(dev(c).merchant.id, idParam(c, "webhookEndpoint"))));
  app.get("/v1/webhooks/:id/deliveries", (c) => c.json(g.webhooks.deliveries(dev(c).merchant.id, idParam(c, "webhookEndpoint"), limitOf(c), cursorOf(c))));
  app.post("/v1/webhook-deliveries/:id/retry", async (c) => c.json(await g.webhooks.retry(dev(c).merchant.id, idParam(c, "delivery"))));

  // Platform alert endpoints (no business): budget.refused for every refusal on this node (decision 8). Budgets are the
  // platform's agents scope, so the agents permissions guard them.
  const alerts = (c: Context, mutate: boolean) => a.platform(c, mutate ? "agents.manage" : "agents.read");
  app.post("/v1/platform/webhooks", async (c) => {
    const who = alerts(c, true);
    const out = await g.webhooks.create(null, await body(c, createWebhookSchema));
    audit(who, "webhook.created", { target: out.id, meta: { url: out.url, scope: "platform" } });
    return c.json(out, 201);
  });
  app.get("/v1/platform/webhooks", (c) => (alerts(c, false), c.json({ items: g.webhooks.endpoints(null).map((e) => g.webhooks.json(e)) })));
  app.get("/v1/platform/webhooks/:id", (c) => (alerts(c, false), c.json(g.webhooks.json(g.webhooks.endpoint(null, idParam(c, "webhookEndpoint"))))));
  app.get("/v1/platform/webhooks/:id/secret", (c) => (alerts(c, true), c.json({ secret: g.webhooks.endpoint(null, idParam(c, "webhookEndpoint")).secret })));
  app.patch("/v1/platform/webhooks/:id", async (c) => {
    alerts(c, true);
    return c.json(await g.webhooks.update(null, idParam(c, "webhookEndpoint"), await body(c, updateWebhookSchema)));
  });
  app.delete("/v1/platform/webhooks/:id", (c) => {
    const who = alerts(c, true);
    g.db.tx(() => {
      g.webhooks.remove(null, idParam(c, "webhookEndpoint"));
      audit(who, "webhook.deleted", { target: c.req.param("id"), meta: { scope: "platform" } });
    });
    return c.json({ id: c.req.param("id"), deleted: true });
  });
  app.post("/v1/platform/webhooks/:id/rotate-secret", (c) => (alerts(c, true), c.json(g.webhooks.rotateSecret(null, idParam(c, "webhookEndpoint")))));
  app.post("/v1/platform/webhooks/:id/test", async (c) => (alerts(c, true), c.json(await g.webhooks.test(null, idParam(c, "webhookEndpoint")))));
  app.get("/v1/platform/webhooks/:id/deliveries", (c) => (alerts(c, false), c.json(g.webhooks.deliveries(null, idParam(c, "webhookEndpoint"), limitOf(c), cursorOf(c)))));
  app.post("/v1/platform/webhook-deliveries/:id/retry", async (c) => (alerts(c, true), c.json(await g.webhooks.retry(null, idParam(c, "delivery")))));

  // Intake screening (section 13.1): decisions for the Blocked page, and the business's blocked wallets.
  app.get("/v1/screening/decisions", (c) => {
    // Platform actors without Merchant-Id see every business's decisions.
    const { merchantIds } = a.scope(c, "screening.read");
    return c.json(g.screening.decisions(merchantIds, limitOf(c), cursorOf(c)));
  });
  app.get("/v1/screening/deny-list", (c) => c.json(g.screening.denyList(caller(c, "screening.read").merchant.id)));
  app.post("/v1/screening/deny-list", async (c) => {
    const who = caller(c, "screening.manage");
    const b = await body(c, denySchema);
    return c.json(g.screening.deny(who.merchant.id, b.address, b.reason ?? null), 201);
  });
  app.delete("/v1/screening/deny-list/:address", (c) => {
    const who = caller(c, "screening.manage");
    const address = parse(c.req.param("address"), zAccount, "invalid account");
    if (!g.screening.allow(who.merchant.id, address)) throw new ApiError(404, "NOT_FOUND", "address is not on the deny list");
    return c.json({ address, deleted: true });
  });


  // ================================================================ public checkout (no auth, per-IP limited)

  const publicPayment = (c: Context): PaymentRow => {
    const p = g.payments.row(idParam(c, "payment"));
    if (!p) throw new ApiError(404, "NOT_FOUND", "payment not found");
    return p;
  };

  app.get("/v1/checkout/:id", (c) => c.json(g.checkoutView(publicPayment(c))));

  app.get("/v1/checkout/:id/quote", (c) => {
    const p = publicPayment(c);
    const method = parse(c.req.query("method"), zMethod, `method must be one of ${PAYMENT_METHODS.join(", ")}`);
    const q = g.payments.quote(g.merchants.merchant(p.merchant_id), BigInt(p.amount), method);
    return c.json({ payment_id: p.id, method, amount: q.amount.toString(), surcharge: q.surcharge.toString(), amount_due: q.amount_due.toString() });
  });
  // A person picking the wallet re-quotes the open payment, so the page shows the right total and the terms to sign.
  app.post("/v1/checkout/:id/method", async (c) => {
    const p = publicPayment(c);
    const { method } = await body(c, z.object({ method: z.enum(["wallet"]) }));
    return c.json(g.checkoutView(g.payments.requote(p, method)));
  });

  // The payer's wallet sent the checkout transaction: the node asks the hub now. The hash is kept for display only.
  app.post("/v1/checkout/:id/wallet", async (c) => {
    const p = publicPayment(c);
    const b = await body(c, walletSentSchema);
    const row = await g.walletSent(p, b.tx_hash ?? null);
    return c.json({ status: row.status, recorded: g.payments.credits(row.id).some((x) => x.method === "wallet"), payment: g.checkoutView(row) });
  });

  app.post("/v1/checkout/:id/email", async (c) => {
    const p = publicPayment(c);
    const { email } = await body(c, emailSchema);
    g.payments.setEmail(p.id, email);
    return c.json({ id: p.id, ok: true });
  });

  // The canonical JSON itself, byte for byte what order_hash hashes, so anyone can recompute it.
  app.get("/v1/checkout/:id/order", (c) => c.body(g.order(publicPayment(c)), 200, { "content-type": "application/json; charset=utf-8" }));
  app.get("/v1/checkout/:id/proof", async (c) => c.json(await g.proof(publicPayment(c))));

  app.get("/v1/checkout/:id/events", async (c) => {
    const p = publicPayment(c);
    const first = g.checkoutView(p);
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      let latest: PaymentRow | null = null;
      let closed = false;
      const close = () => {
        closed = true;
        wake?.();
      };
      const unsubscribe = g.payments.subscribe(p.id, (row) => {
        latest = row;
        wake?.();
      });
      d.sseClosers.add(close);
      stream.onAbort(close);
      try {
        await stream.writeSSE({ event: "status", data: JSON.stringify(first), retry: 3000 });
        while (!closed && !stream.aborted) {
          if (!latest) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 15_000);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = null;
            if (!latest && !closed) await stream.write(": ping\n\n");
          }
          if (latest && !closed) {
            const row: PaymentRow = latest;
            latest = null;
            await stream.writeSSE({ event: "status", data: JSON.stringify(g.checkoutView(row)) });
          }
        }
      } finally {
        unsubscribe();
        d.sseClosers.delete(close);
      }
    });
  });

  // ================================================================ x402 v2: agents pay links and payments with vouchers

  type Problem = { code: string; message: string; details?: Record<string, unknown>; refusal?: Refusal };

  /**
   * 402 with PAYMENT-REQUIRED (and, after a failed payment, PAYMENT-RESPONSE with `success: false`). The JSON body
   * repeats the requirements and carries the full error object, like the SDK paywall.
   */
  const paymentRequired = (c: Context, pr: PaymentRequiredV2, problem: Problem, attempted: boolean) => {
    c.header(HEADER_REQUIRED, encodeHeader({ ...pr, error: problem.code }));
    if (attempted) c.header(HEADER_RESPONSE, encodeHeader(paymentFailure(g.network, problem.code, problem.refusal)));
    const { refusal, ...error } = problem;
    return c.json({ ...pr, error, ...(refusal ? { refusal } : {}) }, 402);
  };

  const paid = (c: Context, p: PaymentRow, payer: PublicKey, results: Array<{ receipt: Parameters<typeof paymentSuccess>[2][number]; position: Parameters<typeof paymentSuccess>[3][number] }>) => {
    c.header(HEADER_RESPONSE, encodeHeader(paymentSuccess(g.network, payer, results.map((r) => r.receipt), results.map((r) => r.position))));
    const last = results[results.length - 1]!;
    return c.json({
      payment_id: p.id,
      status: p.status,
      amount_due: p.amount_due,
      amount_paid: p.amount_paid,
      order_hash: p.order_hash,
      checkout_url: g.payments.json(p).checkout_url,
      proof_url: `${g.ctx.checkoutBaseUrl}/receipt/${p.id}`,
      // receipt and position keep agent clients working: they verify the clearing receipt of the voucher they signed.
      receipt: last.receipt,
      position: last.position,
      receipts: results.map((r) => r.receipt),
    });
  };

  /** Accepts the vouchers of a parsed PAYMENT-SIGNATURE for payment `p`, answering 200 or a 402 with the refusal. */
  const settleVouchers = async (c: Context, p: PaymentRow, signed: ParsedPayment, requirements: () => PaymentRequiredV2) => {
    try {
      const out = await g.payVouchers(p, signed.vouchers);
      if (out.ok) return paid(c, out.payment, signed.payer, out.receipts);
      const d = out.denial;
      return paymentRequired(c, requirements(), { code: d.rule, message: d.message, details: d.details, refusal: d.refusal }, true);
    } catch (err) {
      if (err instanceof UnsignedVoucherError) {
        const limited = d.unsignedVoucher?.(c, err);
        if (limited) return limited;
      }
      if (err instanceof ApiError && (err.status === 402 || err.status === 403 || err.status === 409)) {
        return paymentRequired(c, requirements(), { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, true);
      }
      throw err;
    }
  };

  /**
   * The PAYMENT-SIGNATURE of this request, checked against what the gateway offers now. A retry of vouchers a payment
   * already accepted skips the check (nothing is offered once it is paid) and gets the receipts it was given.
   */
  const signedPayment = (c: Context, requirements: () => PaymentRequiredV2, replayOf: (vouchers: VoucherInput[]) => boolean = () => false) => {
    const parsed = parsePaymentSignature(c.req.header(HEADER_SIGNATURE), g.network);
    if (!parsed) return null;
    if (!replayOf(parsed.vouchers) && !requirements().accepts.some((r) => sameRequirement(r, parsed.accepted))) {
      throw new ApiError(402, "REQUIREMENT_MISMATCH", "the accepted requirement is not one this resource offers now; request a fresh 402");
    }
    return parsed;
  };

  app.on(["GET", "POST"], "/v1/pay/l/:slug", async (c) => {
    const l = g.links.bySlug(c.req.param("slug"));
    const m = g.merchants.merchant(l.merchant_id);
    const amountRaw = c.req.query("amount");
    const amount = g.links.amountFor(l, amountRaw === undefined ? null : parse(amountRaw, zAmount, "amount must be a positive integer of base units"));
    const resource = `${linkUrl(g.ctx.checkoutBaseUrl, l.slug)}${amountRaw ? `?amount=${amount}` : ""}`;
    const requirements = () => g.requirements({ merchant: m, amount, payment: null, resource, description: l.title });
    let signed;
    try {
      signed = signedPayment(c, requirements, (vs) => g.paymentForVouchers(l.id, vs) !== undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) return paymentRequired(c, requirements(), { code: err.code, message: err.message }, true);
      throw err;
    }
    if (!signed) return paymentRequired(c, requirements(), { code: "PAYMENT_REQUIRED", message: `pay ${l.title}` }, false);
    // A retry of vouchers already accepted goes back to their payment and gets the same receipts. Drafts are keyed by
    // link and requester, so repeated attempts from one client reuse one payment.
    const requester = `${d.clientIp(c)}\n${c.req.header("user-agent") ?? ""}`;
    const p = g.paymentForVouchers(l.id, signed.vouchers) ?? (await g.draftFor(l, m, amount, requester));
    return settleVouchers(c, p, signed, requirements);
  });

  app.on(["GET", "POST"], "/v1/pay/:id", async (c) => {
    const p = publicPayment(c);
    const m = g.merchants.merchant(p.merchant_id);
    const resource = g.payments.json(p).checkout_url;
    const requirements = () => {
      const cur = g.payments.row(p.id)!;
      return g.requirements({ merchant: m, amount: BigInt(cur.amount), payment: cur, resource, description: cur.description ?? m.name });
    };
    let signed;
    try {
      signed = signedPayment(c, requirements, (vs) => g.acceptedVouchers(p.id, vs));
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) return paymentRequired(c, requirements(), { code: err.code, message: err.message }, true);
      throw err;
    }
    if (!signed) return paymentRequired(c, requirements(), { code: "PAYMENT_REQUIRED", message: `pay ${p.id}` }, false);
    return settleVouchers(c, p, signed, requirements);
  });

  // ================================================================ service directory

  app.get("/.well-known/payminto.json", (c) => c.json(g.directory()));
  app.get("/v1/directory", (c) => c.json(g.directory()));
}
