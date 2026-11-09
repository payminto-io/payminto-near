/**
 * Accounts, sessions, teams, activity and customers (docs/PRODUCT.md section 4, API in section 10).
 * The dashboard reaches the server through its own `/api/*` path (proxy.ts), so the session cookie is first-party.
 * Every body is parsed with zod at this boundary; in mock mode lib/mock/accounts.ts serves the same interface.
 */
import { z } from "zod";
import { requestJson } from "./http";
import { getMerchantScope } from "./merchant-scope";
import type { BusinessRole, Grants, PlatformRole } from "./permissions";

// ---------------------------------------------------------------------------
// Shapes (section 10)
// ---------------------------------------------------------------------------

const time = z.union([z.string(), z.number()]).transform((v) => (typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v).toISOString() : v));
const nullableTime = time.nullable().optional().transform((v) => v ?? null);
const platformRole = z.enum(["owner", "admin"]).nullable().optional().transform((v) => (v ?? null) as PlatformRole | null);
const businessRole = z.enum(["admin", "staff", "viewer"]);
const signupMode = z.enum(["off", "approval", "open"]);
export type SignupMode = z.infer<typeof signupMode>;

export const membershipSchema = z
  .object({
    merchant_id: z.string(),
    business_name: z.string().optional(),
    business_slug: z.string().optional(),
    business_status: z.string().optional(),
    role: businessRole,
    created_at: nullableTime,
  })
  .passthrough()
  .transform((m) => ({ merchantId: m.merchant_id, name: m.business_name ?? m.merchant_id, slug: m.business_slug ?? null, status: m.business_status ?? "active", role: m.role as BusinessRole }));
export type Membership = z.infer<typeof membershipSchema>;

export const userSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
    email_verified: z.boolean().optional(),
    status: z.enum(["active", "pending", "disabled"]).optional(),
    platform_role: platformRole,
    last_business_id: z.string().nullable().optional(),
    created_at: nullableTime,
  })
  .passthrough()
  .transform((u) => ({
    id: u.id,
    email: u.email,
    name: u.name || u.email.split("@")[0]!,
    emailVerified: u.email_verified ?? false,
    platformRole: u.platform_role,
    status: u.status ?? "active",
    lastBusinessId: u.last_business_id ?? null,
  }));
export type User = z.infer<typeof userSchema>;

const permissionsSchema = z
  .object({ platform: z.array(z.string()).default([]), businesses: z.record(z.string(), z.array(z.string())).default({}) })
  .default({ platform: [], businesses: {} });

export const sessionSchema = z
  .object({
    actor_type: z.enum(["user", "recovery_key"]).default("user"),
    user: userSchema.nullable().optional(),
    memberships: z.array(membershipSchema).default([]),
    permissions: permissionsSchema,
    csrf_token: z.string().nullable().optional(),
    session: z.object({ id: z.string().optional(), expires_at: nullableTime, idle_expires_at: nullableTime, step_up_until: nullableTime }).passthrough().nullable().optional(),
    signup_request: z
      .object({ id: z.string(), status: z.enum(["unverified", "pending", "declined", "approved"]), business_name: z.string().nullable().optional(), reason: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    platform: z
      .object({
        name: z.string().optional(),
        signup_mode: signupMode.optional(),
        smtp_configured: z.boolean().optional(),
        recovery_key_enabled: z.boolean().optional(),
        agent_budgets_for_businesses: z.boolean().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .transform((s) => ({
    actorType: s.actor_type,
    user: s.user ?? null,
    memberships: s.memberships,
    grants: s.permissions as Grants,
    csrf: s.csrf_token ?? null,
    sessionId: s.session?.id ?? null,
    expiresAt: s.session?.expires_at ?? null,
    stepUpUntil: s.session?.step_up_until ?? null,
    signupRequest: s.signup_request ? { id: s.signup_request.id, status: s.signup_request.status, businessName: s.signup_request.business_name ?? null, reason: s.signup_request.reason ?? null } : null,
    platformName: s.platform?.name ?? "Payminto",
    signupMode: (s.platform?.signup_mode ?? "off") as SignupMode,
    smtpConfigured: s.platform?.smtp_configured ?? false,
    recoveryKeyEnabled: s.platform?.recovery_key_enabled ?? false,
    agentBudgetsForBusinesses: s.platform?.agent_budgets_for_businesses ?? false,
  }));
export type AccountSession = z.infer<typeof sessionSchema>;

/** GET /v1/setup: what the setup screen shows before the owner exists. */
export const setupInfoSchema = z
  .object({
    needed: z.boolean(),
    platform_name: z.string().nullable().optional(),
    network: z.object({ chain_id: z.number().optional(), name: z.string().optional(), testnet: z.boolean().optional() }).passthrough().nullable().optional(),
    payout_default: z.string().nullable().optional(),
    fee_wallet: z.string().nullable().optional(),
    signup_mode: signupMode.optional(),
  })
  .passthrough()
  .transform((s) => ({
    needed: s.needed,
    signupMode: s.signup_mode ?? null,
    platformName: s.platform_name ?? "Payminto",
    network: s.network ? { chainId: s.network.chain_id ?? null, name: s.network.name ?? null, testnet: s.network.testnet ?? false } : null,
    payoutDefault: s.payout_default ?? null,
    feeWallet: s.fee_wallet ?? null,
  }));
export type SetupInfo = z.infer<typeof setupInfoSchema>;

export const sessionRowSchema = z
  .object({
    id: z.string(),
    current: z.boolean().optional(),
    ip: z.string().nullable().optional(),
    user_agent: z.string().nullable().optional(),
    created_at: time,
    last_seen_at: nullableTime,
    expires_at: nullableTime,
  })
  .passthrough()
  .transform((r) => ({ id: r.id, current: r.current ?? false, ip: r.ip ?? null, userAgent: r.user_agent ?? null, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at }));
export type SessionRow = z.infer<typeof sessionRowSchema>;

export const memberSchema = z
  .object({
    user_id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
    role: businessRole,
    status: z.enum(["active", "pending", "disabled"]).optional(),
    email_verified: z.boolean().optional(),
    joined_at: nullableTime,
    last_active_at: nullableTime,
  })
  .passthrough()
  .transform((m) => ({
    userId: m.user_id,
    email: m.email,
    name: m.name || m.email.split("@")[0]!,
    role: m.role as BusinessRole,
    status: m.status ?? "active",
    emailVerified: m.email_verified ?? true,
    joinedAt: m.joined_at,
    lastActiveAt: m.last_active_at,
  }));
export type Member = z.infer<typeof memberSchema>;

export const platformMemberSchema = z
  .object({
    user_id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
    platform_role: platformRole,
    status: z.enum(["active", "pending", "disabled"]).optional(),
    last_active_at: nullableTime,
  })
  .passthrough()
  .transform((m) => ({ userId: m.user_id, email: m.email, name: m.name || m.email.split("@")[0]!, platformRole: m.platform_role, status: m.status ?? "active", lastActiveAt: m.last_active_at }));
export type PlatformMember = z.infer<typeof platformMemberSchema>;

export type InviteRole = BusinessRole | "platform_admin";

export const inviteSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: z.enum(["admin", "staff", "viewer", "platform_admin"]),
    merchant_id: z.string().nullable().optional(),
    status: z.enum(["pending", "expired", "accepted", "revoked", "used"]).optional(),
    expires_at: nullableTime,
    created_at: nullableTime,
    link: z.string().nullable().optional(),
    invited_by: z.object({ id: z.string().optional(), email: z.string().optional(), name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough()
  .transform((i) => ({
    id: i.id,
    email: i.email,
    role: i.role as InviteRole,
    merchantId: i.merchant_id ?? null,
    status: i.status ?? "pending",
    expiresAt: i.expires_at,
    createdAt: i.created_at,
    link: i.link ?? null,
    invitedBy: i.invited_by?.name || i.invited_by?.email || null,
  }));
export type Invite = z.infer<typeof inviteSchema>;

/** POST /v1/invites returns one row per email: the invite, or the error for that email. */
const inviteResultSchema = z.union([
  inviteSchema.transform((invite) => ({ ok: true as const, invite })),
  z.object({ email: z.string(), error: z.object({ code: z.string(), message: z.string() }).passthrough() }).transform((e) => ({ ok: false as const, email: e.email, code: e.error.code, message: e.error.message })),
]);
export type InviteResult = z.infer<typeof inviteResultSchema>;

export const invitePreviewSchema = z
  .object({
    email: z.string(),
    role: z.string(),
    business_name: z.string().nullable().optional(),
    platform: z.boolean().optional(),
    status: z.enum(["pending", "expired", "used", "revoked"]).default("pending"),
    user_exists: z.boolean().optional(),
    signed_in_as: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((i) => ({ email: i.email, role: i.role, businessName: i.business_name ?? null, platform: i.platform ?? false, status: i.status, userExists: i.user_exists ?? false, signedInAs: i.signed_in_as ?? null }));
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const signupRequestSchema = z
  .object({
    id: z.string(),
    status: z.enum(["pending", "approved", "declined"]),
    business_name: z.string().nullable().optional(),
    user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable().optional(), email_verified: z.boolean().optional() }).passthrough(),
    merchant_id: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    created_at: time,
    decided_at: nullableTime,
  })
  .passthrough()
  .transform((r) => ({
    id: r.id,
    status: r.status,
    businessName: r.business_name ?? "Unnamed business",
    email: r.user.email,
    name: r.user.name || r.user.email.split("@")[0]!,
    emailVerified: r.user.email_verified ?? false,
    merchantId: r.merchant_id ?? null,
    reason: r.reason ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const outboxEmailSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    to: z.string(),
    subject: z.string(),
    kind: z.string().optional(),
    link: z.string().nullable().optional(),
    created_at: time,
    sent_at: nullableTime,
    error: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((e) => ({ id: e.id, to: e.to, subject: e.subject, kind: e.kind ?? "email", link: e.link ?? null, createdAt: e.created_at, sentAt: e.sent_at, error: e.error ?? null }));
export type OutboxEmail = z.infer<typeof outboxEmailSchema>;

export const auditEventSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    at: time,
    actor: z.object({ type: z.enum(["user", "api_key", "recovery_key", "system"]), id: z.string().nullable().optional(), email: z.string().nullable().optional(), name: z.string().nullable().optional() }).passthrough(),
    merchant_id: z.string().nullable().optional(),
    action: z.string(),
    target: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    ip: z.string().nullable().optional(),
    meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough()
  .transform((e) => ({
    id: e.id,
    at: e.at,
    actorType: e.actor.type,
    actorId: e.actor.id ?? null,
    actorName: e.actor.name || e.actor.email || null,
    actorEmail: e.actor.email ?? null,
    merchantId: e.merchant_id ?? null,
    action: e.action,
    target: e.target ?? null,
    summary: e.summary ?? null,
    ip: e.ip ?? null,
    meta: e.meta ?? {},
  }));
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const customerSchema = z
  .object({
    id: z.string(),
    merchant_id: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    wallets: z.array(z.string()).default([]),
    payments: z.number().default(0),
    paid_payments: z.number().optional(),
    total_paid: z.string().default("0"),
    total_refunded: z.string().default("0"),
    first_payment_at: nullableTime,
    last_payment_at: nullableTime,
  })
  .passthrough()
  .transform((c) => ({
    id: c.id,
    merchantId: c.merchant_id ?? null,
    email: c.email ?? null,
    name: c.name ?? null,
    wallets: c.wallets,
    payments: c.payments,
    paidPayments: c.paid_payments ?? c.payments,
    totalPaid: c.total_paid,
    totalRefunded: c.total_refunded,
    firstPaymentAt: c.first_payment_at,
    lastPaymentAt: c.last_payment_at,
  }));
export type Customer = z.infer<typeof customerSchema>;

/** List envelopes are `{ items, next_cursor }` throughout section 10. */
function page<T extends z.ZodType>(item: T) {
  return z
    .object({ items: z.array(item), next_cursor: z.union([z.string(), z.number()]).nullable().optional() })
    .passthrough()
    .transform((o) => ({ items: o.items as z.infer<T>[], nextCursor: o.next_cursor == null ? null : String(o.next_cursor) }));
}
export type Paged<T> = { items: T[]; nextCursor: string | null };
const anyBody = z.unknown();

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type SetupBody = { code: string; platform_name?: string; name: string; email: string; password: string };
export type SignupBody = { email: string; name: string; password: string; business_name: string };
export type AuditQuery = { actor_id?: string; action?: string; merchant_id?: string; from?: string; to?: string; limit?: number; cursor?: string };
/** Business-scoped calls name the business in Merchant-Id; null means the platform. */
export type BusinessScope = string | null;

export interface AccountApi {
  readonly mock: boolean;
  setupInfo(): Promise<SetupInfo>;
  setupCheck(code: string): Promise<void>;
  setup(body: SetupBody): Promise<AccountSession>;
  /** A recovery key session sends the key as a bearer token; null for the cookie. */
  session(recoveryKey?: string | null): Promise<AccountSession>;
  login(body: { email: string; password: string }): Promise<AccountSession>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  stepUp(password: string): Promise<void>;
  signup(body: SignupBody): Promise<void>;
  verifyEmail(token: string): Promise<{ email: string; status: "active" | "pending" }>;
  resendVerification(): Promise<void>;
  forgot(email: string): Promise<void>;
  resetCheck(token: string): Promise<{ email: string }>;
  reset(token: string, password: string): Promise<void>;
  inviteLookup(token: string): Promise<InvitePreview>;
  acceptInvite(body: { token: string; name?: string; password?: string }): Promise<AccountSession>;
  updateMe(body: { name?: string; last_business_id?: string | null }): Promise<AccountSession>;
  changePassword(body: { current_password: string; new_password: string }): Promise<AccountSession>;
  sessions(): Promise<SessionRow[]>;
  revokeSession(id: string): Promise<void>;
  revokeOtherSessions(): Promise<number>;
  members(merchantId: string): Promise<Member[]>;
  setMemberRole(merchantId: string, userId: string, role: BusinessRole): Promise<Member>;
  removeMember(merchantId: string, userId: string): Promise<void>;
  invites(scope: BusinessScope): Promise<Invite[]>;
  invite(scope: BusinessScope, body: { emails: string[]; role: InviteRole }): Promise<InviteResult[]>;
  resendInvite(scope: BusinessScope, id: string): Promise<Invite>;
  revokeInvite(scope: BusinessScope, id: string): Promise<void>;
  platformTeam(): Promise<PlatformMember[]>;
  setPlatformRole(userId: string, role: "admin" | null): Promise<void>;
  signupRequests(status?: "pending" | "approved" | "declined" | "all"): Promise<{ items: SignupRequest[]; pending: number }>;
  approveSignup(id: string): Promise<SignupRequest>;
  declineSignup(id: string, reason: string): Promise<SignupRequest>;
  outbox(cursor?: string): Promise<{ smtpConfigured: boolean; notice: string | null; items: OutboxEmail[]; nextCursor: string | null }>;
  testEmail(to?: string): Promise<{ delivered: "smtp" | "outbox" }>;
  audit(q?: AuditQuery): Promise<Paged<AuditEvent>>;
  auditCsvUrl(q?: AuditQuery): string | null;
  customers(q?: { q?: string; cursor?: string }): Promise<Paged<Customer>>;
}

/** Error codes the account screens turn into plain sentences (section 10.1). */
export const AUTH_ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: "Wrong email or password, or the account is temporarily locked. Try again later.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  SETUP_CODE_INVALID: "That setup code is not right. Copy it again from the server log.",
  SETUP_CODE_EXPIRED: "That setup code has expired. The server printed a new one to its log.",
  SETUP_DONE: "This server is already set up. Sign in instead.",
  WEAK_PASSWORD: "Pick a longer or less common password (at least 12 characters, not your email).",
  TOKEN_EXPIRED: "This link has expired.",
  TOKEN_USED: "This link was already used.",
  TOKEN_INVALID: "This link is not valid. Check that you copied all of it.",
  SIGNUP_DISABLED: "Sign-up is off on this server. Ask your platform owner for an invite.",
  SIGN_IN_REQUIRED: "You already have an account. Sign in to accept this invite.",
  WRONG_ACCOUNT: "You are signed in as someone else. Sign out, then open the invite again.",
  ALREADY_MEMBER: "Already a member of this team.",
  LAST_ADMIN: "A business needs at least one Admin. Make someone else Admin first.",
  OWNER_PROTECTED: "The platform owner cannot be changed or removed here.",
  EMAIL_NOT_VERIFIED: "Verify your email first. Check your inbox for the link.",
  RECOVERY_KEY_DISABLED: "The recovery key is turned off on this server. Sign in with your email instead.",
  NODE_UNREACHABLE: "Cannot reach the Payminto server. Check that it is running.",
};

export function authErrorText(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    if (code === "WEAK_PASSWORD") {
      const reason = (err as { details?: { reason?: string } }).details?.reason;
      if (reason === "too_short") return "Use at least 12 characters.";
      if (reason === "too_long") return "Use at most 256 characters.";
      if (reason === "common") return "This password is too common. Pick another.";
      if (reason === "equals_email") return "Do not use your email as your password.";
    }
    if (AUTH_ERRORS[code]) return AUTH_ERRORS[code]!;
    if ("message" in err && typeof (err as { message: unknown }).message === "string") return (err as { message: string }).message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// HTTP client: the dashboard's own /api path (proxy.ts), so the session cookie is first-party.
// ---------------------------------------------------------------------------

export const API_BASE = "/api";

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class HttpAccountApi implements AccountApi {
  readonly mock = false;
  constructor(private readonly base = API_BASE) {}

  private get<T>(path: string, schema: z.ZodType<T>, headers?: Record<string, string>) {
    return requestJson(this.base, path, schema, { headers });
  }
  private send<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, headers?: Record<string, string>) {
    return requestJson(this.base, path, schema, { method, body: body === undefined ? undefined : JSON.stringify(body), headers });
  }
  private biz(scope: BusinessScope): Record<string, string> | undefined {
    return scope ? { "Merchant-Id": scope } : undefined;
  }

  setupInfo() {
    return this.get("/v1/setup", setupInfoSchema);
  }
  async setupCheck(code: string) {
    await this.send("POST", "/v1/setup/check", anyBody, { code });
  }
  setup(body: SetupBody) {
    return this.send("POST", "/v1/setup", sessionSchema, body);
  }
  session(recoveryKey?: string | null) {
    return requestJson(this.base, "/v1/auth/session", sessionSchema, { token: recoveryKey ?? null });
  }
  login(body: { email: string; password: string }) {
    return this.send("POST", "/v1/auth/login", sessionSchema, body);
  }
  async logout() {
    await this.send("POST", "/v1/auth/logout", anyBody, {});
  }
  async logoutAll() {
    await this.send("POST", "/v1/auth/logout-all", anyBody, {});
  }
  async stepUp(password: string) {
    await this.send("POST", "/v1/auth/step-up", anyBody, { password });
  }
  async signup(body: SignupBody) {
    await this.send("POST", "/v1/auth/signup", anyBody, body);
  }
  verifyEmail(token: string) {
    return this.send("POST", "/v1/auth/verify", z.object({ email: z.string(), status: z.enum(["active", "pending"]).default("active") }).passthrough(), { token });
  }
  async resendVerification() {
    await this.send("POST", "/v1/auth/verify/resend", anyBody, {});
  }
  async forgot(email: string) {
    await this.send("POST", "/v1/auth/forgot", anyBody, { email });
  }
  resetCheck(token: string) {
    return this.send("POST", "/v1/auth/reset/check", z.object({ email: z.string() }).passthrough(), { token });
  }
  async reset(token: string, password: string) {
    await this.send("POST", "/v1/auth/reset", anyBody, { token, password });
  }
  inviteLookup(token: string) {
    return this.send("POST", "/v1/invites/lookup", invitePreviewSchema, { token });
  }
  acceptInvite(body: { token: string; name?: string; password?: string }) {
    return this.send("POST", "/v1/invites/accept", sessionSchema, body);
  }
  updateMe(body: { name?: string; last_business_id?: string | null }) {
    return this.send("PATCH", "/v1/auth/me", sessionSchema, body);
  }
  changePassword(body: { current_password: string; new_password: string }) {
    return this.send("POST", "/v1/auth/password", sessionSchema, body);
  }
  async sessions() {
    return (await this.get("/v1/auth/sessions", page(sessionRowSchema))).items;
  }
  async revokeSession(id: string) {
    await this.send("DELETE", `/v1/auth/sessions/${encodeURIComponent(id)}`, anyBody);
  }
  async revokeOtherSessions() {
    const r = await this.send("POST", "/v1/auth/sessions/revoke-others", z.object({ revoked: z.number().default(0) }).passthrough(), {});
    return r.revoked;
  }
  async members(merchantId: string) {
    return (await this.get("/v1/members", page(memberSchema), this.biz(merchantId))).items;
  }
  setMemberRole(merchantId: string, userId: string, role: BusinessRole) {
    return this.send("PATCH", `/v1/members/${encodeURIComponent(userId)}`, memberSchema, { role }, this.biz(merchantId));
  }
  async removeMember(merchantId: string, userId: string) {
    await this.send("DELETE", `/v1/members/${encodeURIComponent(userId)}`, anyBody, undefined, this.biz(merchantId));
  }
  async invites(scope: BusinessScope) {
    return (await this.get(`/v1/invites${scope ? "" : "?scope=platform"}`, page(inviteSchema), this.biz(scope))).items;
  }
  async invite(scope: BusinessScope, body: { emails: string[]; role: InviteRole }) {
    const r = await this.send("POST", "/v1/invites", z.object({ items: z.array(inviteResultSchema) }).passthrough(), body, this.biz(scope));
    return r.items;
  }
  resendInvite(scope: BusinessScope, id: string) {
    return this.send("POST", `/v1/invites/${encodeURIComponent(id)}/resend`, inviteSchema, {}, this.biz(scope));
  }
  async revokeInvite(scope: BusinessScope, id: string) {
    await this.send("DELETE", `/v1/invites/${encodeURIComponent(id)}`, anyBody, undefined, this.biz(scope));
  }
  async platformTeam() {
    return (await this.get("/v1/platform/team", page(platformMemberSchema))).items;
  }
  async setPlatformRole(userId: string, role: "admin" | null) {
    await this.send("PATCH", `/v1/platform/team/${encodeURIComponent(userId)}`, anyBody, { platform_role: role });
  }
  async signupRequests(status: "pending" | "approved" | "declined" | "all" = "pending") {
    const r = await this.get(
      `/v1/platform/signup-requests${qs({ status })}`,
      z.object({ items: z.array(signupRequestSchema), counts: z.object({ pending: z.number().default(0) }).passthrough().optional() }).passthrough(),
    );
    return { items: r.items, pending: r.counts?.pending ?? r.items.filter((i) => i.status === "pending").length };
  }
  approveSignup(id: string) {
    return this.send("POST", `/v1/platform/signup-requests/${encodeURIComponent(id)}/approve`, signupRequestSchema, {});
  }
  declineSignup(id: string, reason: string) {
    return this.send("POST", `/v1/platform/signup-requests/${encodeURIComponent(id)}/decline`, signupRequestSchema, reason ? { reason } : {});
  }
  async outbox(cursor?: string) {
    const r = await this.get(
      `/v1/platform/outbox${qs({ cursor })}`,
      z.object({ smtp_configured: z.boolean().default(false), notice: z.string().nullable().optional(), items: z.array(outboxEmailSchema), next_cursor: z.union([z.string(), z.number()]).nullable().optional() }).passthrough(),
    );
    return { smtpConfigured: r.smtp_configured, notice: r.notice ?? null, items: r.items, nextCursor: r.next_cursor == null ? null : String(r.next_cursor) };
  }
  testEmail(to?: string) {
    return this.send("POST", "/v1/platform/email/test", z.object({ delivered: z.enum(["smtp", "outbox"]) }).passthrough(), to ? { to } : {});
  }
  audit(q: AuditQuery = {}) {
    return this.get(`/v1/audit${qs(q)}`, page(auditEventSchema));
  }
  auditCsvUrl(q: AuditQuery = {}) {
    return `${this.base}/v1/audit${qs({ ...q, cursor: undefined, limit: undefined, format: "csv" })}`;
  }
  customers(q: { q?: string; cursor?: string } = {}) {
    // The open business, like the gateway routes; none on the platform view, which lists every business.
    return this.get(`/v1/customers${qs(q)}`, page(customerSchema), this.biz(getMerchantScope()));
  }
}

// ---------------------------------------------------------------------------
// Passwords (section 4.3): length rules only, plus a strength hint. The server has the common-password list.
// ---------------------------------------------------------------------------

export type PasswordCheck = { ok: boolean; score: 0 | 1 | 2 | 3 | 4; message: string };

const TOO_COMMON = new Set(["password1234", "123456789012", "qwertyuiopas", "passwordpassword", "iloveyou1234", "letmein12345", "adminadmin12", "welcome12345"]);

export function checkPassword(pw: string, email = ""): PasswordCheck {
  if (pw.length === 0) return { ok: false, score: 0, message: "At least 12 characters. A short sentence works well." };
  if (pw.length < 12) return { ok: false, score: 1, message: `${12 - pw.length} more character${12 - pw.length === 1 ? "" : "s"} needed.` };
  if (pw.length > 256) return { ok: false, score: 1, message: "At most 256 characters." };
  if (email && pw.toLowerCase() === email.toLowerCase()) return { ok: false, score: 1, message: "Do not use your email as your password." };
  if (TOO_COMMON.has(pw.toLowerCase())) return { ok: false, score: 1, message: "This password is too common. Pick another." };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  let score: PasswordCheck["score"] = 2;
  if (pw.length >= 16 || (classes >= 3 && unique >= 8)) score = 3;
  if (pw.length >= 20 && unique >= 10) score = 4;
  if (unique <= 3) score = 2;
  return { ok: true, score, message: score >= 4 ? "Strong password." : score === 3 ? "Good password." : "Fine. Longer is stronger." };
}

/** "Chrome on macOS" from a user agent, for the sessions list. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
