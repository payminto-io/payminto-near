/**
 * In-browser account and search server for NEXT_PUBLIC_MOCK (docs/PRODUCT.md section 10), so every account screen,
 * role and the palette can be built and demoed without a node. Server-shaped objects go through the same zod schemas
 * the HTTP client uses, so the mock also checks the contract.
 */
import { ApiError } from "../http";
import {
  auditEventSchema,
  customerSchema,
  inviteSchema,
  memberSchema,
  outboxEmailSchema,
  platformMemberSchema,
  sessionRowSchema,
  sessionSchema,
  signupRequestSchema,
  type AccountApi,
  type AccountSession,
  type AuditQuery,
  type BusinessScope,
  type InviteResult,
  type InviteRole,
  type Paged,
  type SetupBody,
  type SignupBody,
} from "../account";
import { grantsFor, type BusinessRole, type PlatformRole } from "../permissions";
import type { SearchApi } from "../search-api";
import { GROUP_LABEL, detect, type RecordType, type SearchGroup, type SearchItem, type SearchResponse } from "../search";
import { formatMoney, shortAddress } from "../format";
import type { ClearingApi } from "../api";
import { mockBusinesses } from "./gateway";
import { getMerchantScope } from "../merchant-scope";

export const MOCK_PASSWORD = "demo-password-2026";
export const MOCK_SETUP_CODE = "MOCK-SETU-PCOD-E000";
const EMPTY = process.env.NEXT_PUBLIC_MOCK === "empty";
const USER_KEY = "payminto.mock.user";
const SETUP_KEY = "payminto.mock.setupDone";

type MockUser = {
  id: string;
  email: string;
  name: string;
  platform_role: PlatformRole | null;
  status: "active" | "pending" | "disabled";
  email_verified: boolean;
  last_business_id: string | null;
  memberships: { merchant_id: string; role: BusinessRole; created_at: string }[];
  last_active_at: string;
};

const delay = (ms = 140 + Math.round(Math.random() * 160)) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let seq = 1;
const rid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

function biz() {
  const list = mockBusinesses();
  return { acme: list[0]!, northwind: list[1]!, globex: list[2]!, all: list };
}

function seedUsers(): MockUser[] {
  const b = biz();
  const m = (id: string, role: BusinessRole) => ({ merchant_id: id, role, created_at: iso(40 * DAY) });
  return [
    { id: "usr_owner", email: "owner@demo.local", name: "Priya Shah", platform_role: "owner", status: "active", email_verified: true, last_business_id: null, memberships: [], last_active_at: iso(2 * MIN) },
    { id: "usr_padmin", email: "ken@demo.local", name: "Ken Adams", platform_role: "admin", status: "active", email_verified: true, last_business_id: null, memberships: [], last_active_at: iso(3 * HOUR) },
    { id: "usr_ana", email: "ana@acme.example", name: "Ana Lopez", platform_role: null, status: "active", email_verified: true, last_business_id: b.acme.id, memberships: [m(b.acme.id, "admin")], last_active_at: iso(20 * MIN) },
    { id: "usr_sam", email: "sam@acme.example", name: "Sam Lee", platform_role: null, status: "active", email_verified: true, last_business_id: b.acme.id, memberships: [m(b.acme.id, "staff")], last_active_at: iso(5 * HOUR) },
    { id: "usr_vic", email: "vic@acme.example", name: "Vic Moreno", platform_role: null, status: "active", email_verified: false, last_business_id: b.acme.id, memberships: [m(b.acme.id, "viewer")], last_active_at: iso(2 * DAY) },
    { id: "usr_noor", email: "noor@northwind.example", name: "Noor Haddad", platform_role: null, status: "active", email_verified: true, last_business_id: b.northwind.id, memberships: [m(b.northwind.id, "admin"), m(b.acme.id, "viewer")], last_active_at: iso(1 * DAY) },
    { id: "usr_lee", email: "lee@sprout.example", name: "Lee Park", platform_role: null, status: "pending", email_verified: true, last_business_id: null, memberships: [], last_active_at: iso(30 * MIN) },
  ];
}

/** The accounts the mock sign-in screen offers, one per role. */
export const MOCK_ACCOUNTS: { email: string; label: string }[] = [
  { email: "owner@demo.local", label: "Platform owner" },
  { email: "ken@demo.local", label: "Platform admin" },
  { email: "ana@acme.example", label: "Business Admin" },
  { email: "sam@acme.example", label: "Staff" },
  { email: "vic@acme.example", label: "Viewer" },
  { email: "noor@northwind.example", label: "Two businesses" },
  { email: "lee@sprout.example", label: "Waiting for approval" },
];

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Mock state then lasts for this page only.
  }
}

type MockInvite = { id: string; email: string; role: InviteRole; merchant_id: string | null; status: "pending" | "expired"; expires_at: string; created_at: string; token: string; invited_by: string };
type MockSignup = { id: string; status: "pending" | "approved" | "declined"; business_name: string; user: { id: string; email: string; name: string; email_verified: boolean }; merchant_id: string | null; reason: string | null; created_at: string; decided_at: string | null };

class Store {
  users = seedUsers();
  platformName = "Acme Payments (demo)";
  signupMode: "off" | "approval" | "open" = "approval";
  agentBudgets = false;
  setupDone = !EMPTY || readLocal(SETUP_KEY) === "1";
  invites: MockInvite[] = [];
  signups: MockSignup[] = [];
  outbox: { id: string; to: string; subject: string; kind: string; link: string | null; created_at: string; sent_at: null; error: null }[] = [];
  audit: Record<string, unknown>[] = [];
  sessions = [
    { id: "ses_this", current: true, ip: "127.0.0.1", user_agent: typeof navigator === "undefined" ? "Mozilla/5.0 Chrome/131" : navigator.userAgent, created_at: iso(2 * HOUR), last_seen_at: iso(0), expires_at: iso(-30 * DAY) },
    { id: "ses_phone", current: false, ip: "203.0.113.24", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1", created_at: iso(3 * DAY), last_seen_at: iso(6 * HOUR), expires_at: iso(-27 * DAY) },
    { id: "ses_office", current: false, ip: "198.51.100.7", user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0", created_at: iso(9 * DAY), last_seen_at: iso(2 * DAY), expires_at: iso(-21 * DAY) },
  ];
  recent: { type: string; id: string; title: string; href: string; at: string }[] = [];

  constructor() {
    const b = biz();
    const owner = this.users[0]!;
    this.invites = [
      { id: "inv_1", email: "jordan@acme.example", role: "staff", merchant_id: b.acme.id, status: "pending", expires_at: iso(-5 * DAY), created_at: iso(2 * DAY), token: "mock-invite-staff", invited_by: "Ana Lopez" },
      { id: "inv_2", email: "ops@demo.local", role: "platform_admin", merchant_id: null, status: "pending", expires_at: iso(-6 * DAY), created_at: iso(1 * DAY), token: "mock-invite-platform", invited_by: owner.name },
      { id: "inv_3", email: "mira@acme.example", role: "viewer", merchant_id: b.acme.id, status: "expired", expires_at: iso(1 * DAY), created_at: iso(8 * DAY), token: "mock-invite-expired", invited_by: "Ana Lopez" },
    ];
    this.signups = [
      { id: "sur_1", status: "pending", business_name: "Sprout Labs", user: { id: "usr_lee", email: "lee@sprout.example", name: "Lee Park", email_verified: true }, merchant_id: null, reason: null, created_at: iso(30 * MIN), decided_at: null },
      { id: "sur_2", status: "pending", business_name: "Kite Analytics", user: { id: "usr_kite", email: "dev@kite.example", name: "Dev Rao", email_verified: false }, merchant_id: null, reason: null, created_at: iso(5 * HOUR), decided_at: null },
      { id: "sur_3", status: "declined", business_name: "Fast Cash 4U", user: { id: "usr_fc", email: "x@fastcash.example", name: "X", email_verified: true }, merchant_id: null, reason: "Not a real business", created_at: iso(4 * DAY), decided_at: iso(3 * DAY) },
    ];
    const link = (kind: string, token: string) => `${typeof window === "undefined" ? "http://localhost:3000" : window.location.origin}/${kind}/${token}`;
    this.outbox = [
      { id: "1", to: "jordan@acme.example", subject: "Ana invited you to Acme Store on Payminto", kind: "invite", link: link("invite", "mock-invite-staff"), created_at: iso(2 * DAY), sent_at: null, error: null },
      { id: "2", to: "ops@demo.local", subject: "You were invited to run Acme Payments (demo)", kind: "invite", link: link("invite", "mock-invite-platform"), created_at: iso(1 * DAY), sent_at: null, error: null },
      { id: "3", to: "vic@acme.example", subject: "Verify your email for Payminto", kind: "verify_email", link: link("verify", "mock-verify"), created_at: iso(3 * DAY), sent_at: null, error: null },
      { id: "4", to: "lee@sprout.example", subject: "We received your sign-up", kind: "signup_received", link: null, created_at: iso(30 * MIN), sent_at: null, error: null },
    ];
    const ev = (at: number, actor: MockUser | null, action: string, summary: string, merchant: string | null, ip = "203.0.113.7", meta: Record<string, unknown> = {}) => ({
      id: String(5000 - this.audit.length),
      at: iso(at),
      actor: actor ? { type: "user", id: actor.id, email: actor.email, name: actor.name } : { type: "system", id: null },
      merchant_id: merchant,
      action,
      target: merchant,
      summary,
      ip,
      meta,
    });
    const [o, k, ana, sam] = [this.users[0]!, this.users[1]!, this.users[2]!, this.users[3]!];
    this.audit = [
      ev(2 * MIN, o, "auth.signed_in", "Priya Shah signed in", null),
      ev(20 * MIN, ana, "refund.issued", "Ana Lopez refunded 4.00 USDC on pay_7Q2M", b.acme.id),
      ev(35 * MIN, sam, "refund.requested", "Sam Lee asked to refund 12.50 USDC on pay_3KX9", b.acme.id),
      ev(50 * MIN, null, "auth.sign_in_failed", "Sign-in failed for sam@acme.example", null, "198.51.100.77"),
      ev(2 * HOUR, ana, "api_key.created", "Ana Lopez created the API key Production server", b.acme.id),
      ev(3 * HOUR, k, "business.updated", "Ken Adams changed the support email of Northwind Coffee", b.northwind.id),
      ev(5 * HOUR, o, "pricing.changed", "Priya Shah changed the Volume pricing plan to 0.25%", null),
      ev(8 * HOUR, ana, "invite.sent", "Ana Lopez invited jordan@acme.example as Staff", b.acme.id),
      ev(1 * DAY, o, "invite.sent", "Priya Shah invited ops@demo.local as Platform admin", null),
      ev(1 * DAY + HOUR, ana, "payout.changed", "Ana Lopez changed the payout wallet to 0x4f2a...91cd", b.acme.id, "203.0.113.7", { from: "0x8a1d...", to: "0x4f2a..." }),
      ev(2 * DAY, o, "settlement.run", "Priya Shah ran a settlement now", null),
      ev(2 * DAY + HOUR, ana, "webhook.created", "Ana Lopez added the webhook https://acme.example/hooks/payminto", b.acme.id),
      ev(3 * DAY, o, "outbox.viewed", "Priya Shah opened the Email outbox", null),
      ev(4 * DAY, k, "signup.declined", "Ken Adams declined the sign-up of Fast Cash 4U", null),
      ev(6 * DAY, o, "business.created", "Priya Shah added the business Globex Data API", b.globex.id),
      ev(9 * DAY, o, "auth.password_changed", "Priya Shah changed their password", null),
      ev(12 * DAY, null, "setup.completed", "This server was set up", null, "127.0.0.1"),
    ];
    this.recent = [
      { type: "page", id: "/payments", title: "Payments", href: "/payments", at: iso(5 * MIN) },
      { type: "page", id: "/netting", title: "Next settlement", href: "/netting", at: iso(1 * HOUR) },
    ];
  }

  current(): MockUser | null {
    const id = readLocal(USER_KEY);
    return this.users.find((u) => u.id === id) ?? null;
  }
}

let store: Store | null = null;
function db(): Store {
  store ??= new Store();
  return store;
}

function sessionFor(u: MockUser | null, actor: "user" | "recovery_key" = "user"): AccountSession {
  const s = db();
  const b = biz();
  const grants =
    actor === "recovery_key"
      ? grantsFor("recovery_key")
      : grantsFor({ platformRole: u!.platform_role, memberships: u!.memberships.map((m) => ({ merchantId: m.merchant_id, role: m.role })) });
  return sessionSchema.parse({
    actor_type: actor,
    user: u && { id: u.id, email: u.email, name: u.name, email_verified: u.email_verified, status: u.status, platform_role: u.platform_role, last_business_id: u.last_business_id, created_at: iso(60 * DAY) },
    memberships: (u?.memberships ?? []).map((m) => {
      const x = b.all.find((y) => y.id === m.merchant_id)!;
      return { merchant_id: m.merchant_id, business_name: x.name, business_slug: x.slug, business_status: x.status, role: m.role, created_at: m.created_at };
    }),
    permissions: grants,
    csrf_token: actor === "user" ? "mock-csrf" : null,
    session: { id: "ses_this", created_at: iso(2 * HOUR), expires_at: iso(-30 * DAY), idle_expires_at: iso(-12 * HOUR), step_up_until: iso(-10 * MIN) },
    signup_request: u?.status === "pending" ? { id: "sur_1", status: "pending", business_name: "Sprout Labs", reason: null } : null,
    platform: { name: s.platformName, signup_mode: s.signupMode, smtp_configured: false, recovery_key_enabled: actor === "recovery_key", agent_budgets_for_businesses: s.agentBudgets },
  });
}

function err(status: number, code: string, message: string, details?: unknown): never {
  throw new ApiError(status, code, message, details);
}

function checkPasswordServer(pw: string, email: string) {
  if (pw.length < 12) err(400, "WEAK_PASSWORD", "Password too short", { reason: "too_short" });
  if (pw.length > 256) err(400, "WEAK_PASSWORD", "Password too long", { reason: "too_long" });
  if (pw.toLowerCase() === email.toLowerCase()) err(400, "WEAK_PASSWORD", "Password equals email", { reason: "equals_email" });
}

function me(): MockUser {
  const u = db().current();
  if (!u) err(401, "UNAUTHORIZED", "Sign in", { reason: "missing" });
  return u;
}

export class MockAccountApi implements AccountApi {
  readonly mock = true;

  async setupInfo() {
    await delay();
    const s = db();
    return s.setupDone
      ? { needed: false, signupMode: s.signupMode, platformName: s.platformName, network: null, payoutDefault: null, feeWallet: null }
      : { needed: true, signupMode: null, platformName: "Payminto", network: { chainId: null, name: "NEAR testnet", testnet: true }, payoutDefault: null, feeWallet: "acme-payments.testnet" };
  }
  async setupCheck(code: string) {
    await delay(400);
    if (db().setupDone) err(409, "SETUP_DONE", "Setup was already completed");
    if (code.replace(/[\s-]/g, "").toUpperCase() !== MOCK_SETUP_CODE.replace(/-/g, "")) err(400, "SETUP_CODE_INVALID", "Wrong setup code");
  }
  async setup(body: SetupBody) {
    await this.setupCheck(body.code);
    checkPasswordServer(body.password, body.email);
    const s = db();
    s.setupDone = true;
    writeLocal(SETUP_KEY, "1");
    if (body.platform_name) s.platformName = body.platform_name;
    const owner = s.users[0]!;
    Object.assign(owner, { email: body.email.toLowerCase(), name: body.name });
    writeLocal(USER_KEY, owner.id);
    return sessionFor(owner);
  }
  async session(recoveryKey?: string | null) {
    await delay(80);
    if (recoveryKey) return sessionFor(null, "recovery_key");
    return sessionFor(me());
  }
  async login(body: { email: string; password: string }) {
    await delay(500);
    const u = db().users.find((x) => x.email === body.email.trim().toLowerCase());
    if (!u || body.password !== MOCK_PASSWORD || u.status === "disabled") err(401, "INVALID_CREDENTIALS", "Wrong email or password");
    writeLocal(USER_KEY, u.id);
    return sessionFor(u);
  }
  async logout() {
    await delay(120);
    writeLocal(USER_KEY, null);
  }
  async logoutAll() {
    await delay(200);
    db().sessions = db().sessions.filter((x) => x.current);
    writeLocal(USER_KEY, null);
  }
  async stepUp(password: string) {
    await delay(300);
    if (password !== MOCK_PASSWORD) err(401, "INVALID_CREDENTIALS", "Wrong password");
  }
  async signup(body: SignupBody) {
    await delay(500);
    const s = db();
    if (s.signupMode === "off") err(403, "SIGNUP_DISABLED", "Sign-up is off");
    checkPasswordServer(body.password, body.email);
    s.outbox.unshift({ id: rid("em"), to: body.email, subject: "Verify your email for Payminto", kind: "verify_email", link: `${window.location.origin}/verify/mock-verify`, created_at: iso(0), sent_at: null, error: null });
  }
  async verifyEmail(token: string) {
    await delay(600);
    if (token === "mock-verify-expired") err(410, "TOKEN_EXPIRED", "Expired");
    if (token === "mock-verify-used") err(409, "TOKEN_USED", "Used");
    if (!token.startsWith("mock-verify")) err(400, "TOKEN_INVALID", "Unknown token");
    const u = db().current();
    if (u) u.email_verified = true;
    return { email: u?.email ?? "you@example.com", status: (u?.status === "pending" ? "pending" : "active") as "active" | "pending" };
  }
  async resendVerification() {
    await delay(300);
  }
  async forgot() {
    await delay(500);
  }
  async resetCheck(token: string) {
    await delay(300);
    if (token === "mock-reset-expired") err(410, "TOKEN_EXPIRED", "Expired");
    if (!token.startsWith("mock-reset")) err(400, "TOKEN_INVALID", "Unknown token");
    return { email: "owner@demo.local" };
  }
  async reset(token: string, password: string) {
    await this.resetCheck(token);
    checkPasswordServer(password, "owner@demo.local");
  }
  async inviteLookup(token: string) {
    await delay(300);
    const inv = db().invites.find((i) => i.token === token);
    if (!inv) err(400, "TOKEN_INVALID", "Unknown invite");
    const u = db().current();
    return {
      email: inv.email,
      role: inv.role,
      businessName: inv.merchant_id ? biz().all.find((b) => b.id === inv.merchant_id)?.name ?? null : null,
      platform: !inv.merchant_id,
      status: inv.status,
      userExists: db().users.some((x) => x.email === inv.email),
      signedInAs: u?.email ?? null,
    };
  }
  async acceptInvite(body: { token: string; name?: string; password?: string }) {
    await delay(500);
    const s = db();
    const inv = s.invites.find((i) => i.token === body.token);
    if (!inv) err(400, "TOKEN_INVALID", "Unknown invite");
    if (inv.status === "expired") err(410, "TOKEN_EXPIRED", "Expired");
    const cur = s.current();
    if (cur && cur.email !== inv.email) err(409, "WRONG_ACCOUNT", "Signed in as someone else");
    checkPasswordServer(body.password ?? "", inv.email);
    const u: MockUser = {
      id: rid("usr"),
      email: inv.email,
      name: body.name || inv.email.split("@")[0]!,
      platform_role: inv.role === "platform_admin" ? "admin" : null,
      status: "active",
      email_verified: true,
      last_business_id: inv.merchant_id,
      memberships: inv.merchant_id && inv.role !== "platform_admin" ? [{ merchant_id: inv.merchant_id, role: inv.role, created_at: iso(0) }] : [],
      last_active_at: iso(0),
    };
    s.users.push(u);
    s.invites = s.invites.filter((i) => i.id !== inv.id);
    writeLocal(USER_KEY, u.id);
    return sessionFor(u);
  }
  async updateMe(body: { name?: string; last_business_id?: string | null }) {
    await delay(200);
    const u = me();
    if (body.name !== undefined) u.name = body.name;
    if (body.last_business_id !== undefined) u.last_business_id = body.last_business_id;
    return sessionFor(u);
  }
  async changePassword(body: { current_password: string; new_password: string }) {
    await delay(600);
    const u = me();
    if (body.current_password !== MOCK_PASSWORD) err(401, "INVALID_CREDENTIALS", "Wrong password");
    checkPasswordServer(body.new_password, u.email);
    db().sessions = db().sessions.filter((x) => x.current);
    return sessionFor(u);
  }
  async sessions() {
    await delay();
    me();
    return db().sessions.map((x) => sessionRowSchema.parse(x));
  }
  async revokeSession(id: string) {
    await delay(300);
    db().sessions = db().sessions.filter((x) => x.id !== id);
  }
  async revokeOtherSessions() {
    await delay(300);
    const before = db().sessions.length;
    db().sessions = db().sessions.filter((x) => x.current);
    return before - db().sessions.length;
  }
  async members(merchantId: string) {
    await delay();
    return db()
      .users.filter((u) => u.memberships.some((m) => m.merchant_id === merchantId))
      .map((u) => {
        const m = u.memberships.find((x) => x.merchant_id === merchantId)!;
        return memberSchema.parse({ user_id: u.id, email: u.email, name: u.name, role: m.role, status: u.status, email_verified: u.email_verified, joined_at: m.created_at, last_active_at: u.last_active_at });
      });
  }
  async setMemberRole(merchantId: string, userId: string, role: BusinessRole) {
    await delay(400);
    const s = db();
    const admins = s.users.filter((u) => u.memberships.some((m) => m.merchant_id === merchantId && m.role === "admin"));
    const u = s.users.find((x) => x.id === userId);
    const m = u?.memberships.find((x) => x.merchant_id === merchantId);
    if (!u || !m) err(404, "NOT_FOUND", "No such member");
    if (m.role === "admin" && role !== "admin" && admins.length <= 1) err(409, "LAST_ADMIN", "Last admin");
    m.role = role;
    return memberSchema.parse({ user_id: u.id, email: u.email, name: u.name, role, status: u.status, joined_at: m.created_at, last_active_at: u.last_active_at });
  }
  async removeMember(merchantId: string, userId: string) {
    await delay(400);
    const s = db();
    const admins = s.users.filter((u) => u.memberships.some((m) => m.merchant_id === merchantId && m.role === "admin"));
    const u = s.users.find((x) => x.id === userId);
    if (!u) err(404, "NOT_FOUND", "No such member");
    if (admins.length <= 1 && admins[0]?.id === userId) err(409, "LAST_ADMIN", "Last admin");
    u.memberships = u.memberships.filter((m) => m.merchant_id !== merchantId);
  }
  async invites(scope: BusinessScope) {
    await delay();
    return db()
      .invites.filter((i) => i.merchant_id === scope)
      .map((i) => inviteSchema.parse({ ...i, invited_by: { name: i.invited_by } }));
  }
  async invite(scope: BusinessScope, body: { emails: string[]; role: InviteRole }): Promise<InviteResult[]> {
    await delay(500);
    const s = db();
    return body.emails.map((email): InviteResult => {
      const e = email.trim().toLowerCase();
      const already = scope ? s.users.some((u) => u.email === e && u.memberships.some((m) => m.merchant_id === scope)) : s.users.some((u) => u.email === e && u.platform_role);
      if (already) return { ok: false, email: e, code: "ALREADY_MEMBER", message: "Already a member" };
      const token = `mock-invite-${rid("t")}`;
      const inv: MockInvite = { id: rid("inv"), email: e, role: body.role, merchant_id: scope, status: "pending", expires_at: iso(-7 * DAY), created_at: iso(0), token, invited_by: s.current()?.name ?? "You" };
      s.invites.unshift(inv);
      const link = `${window.location.origin}/invite/${token}`;
      s.outbox.unshift({ id: rid("em"), to: e, subject: "You were invited to Payminto", kind: "invite", link, created_at: iso(0), sent_at: null, error: null });
      return { ok: true, invite: inviteSchema.parse({ ...inv, link, invited_by: { name: inv.invited_by } }) };
    });
  }
  async resendInvite(_scope: BusinessScope, id: string) {
    await delay(300);
    const inv = db().invites.find((i) => i.id === id);
    if (!inv) err(404, "NOT_FOUND", "No such invite");
    inv.status = "pending";
    inv.expires_at = iso(-7 * DAY);
    return inviteSchema.parse({ ...inv, link: `${window.location.origin}/invite/${inv.token}`, invited_by: { name: inv.invited_by } });
  }
  async revokeInvite(_scope: BusinessScope, id: string) {
    await delay(300);
    db().invites = db().invites.filter((i) => i.id !== id);
  }
  async platformTeam() {
    await delay();
    return db()
      .users.filter((u) => u.platform_role)
      .map((u) => platformMemberSchema.parse({ user_id: u.id, email: u.email, name: u.name, platform_role: u.platform_role, status: u.status, last_active_at: u.last_active_at }));
  }
  async setPlatformRole(userId: string, role: "admin" | null) {
    await delay(400);
    const u = db().users.find((x) => x.id === userId);
    if (!u) err(404, "NOT_FOUND", "No such user");
    if (u.platform_role === "owner") err(409, "OWNER_PROTECTED", "Owner");
    u.platform_role = role;
  }
  async signupRequests(status: "pending" | "approved" | "declined" | "all" = "pending") {
    await delay();
    const all = db().signups;
    return { items: all.filter((r) => status === "all" || r.status === status).map((r) => signupRequestSchema.parse(r)), pending: all.filter((r) => r.status === "pending").length };
  }
  async approveSignup(id: string) {
    await delay(500);
    const r = db().signups.find((x) => x.id === id);
    if (!r) err(404, "NOT_FOUND", "No such request");
    Object.assign(r, { status: "approved", decided_at: iso(0), merchant_id: `mer_${r.business_name.toLowerCase().replace(/[^a-z]/g, "")}` });
    const u = db().users.find((x) => x.id === r.user.id);
    if (u) u.status = "active";
    return signupRequestSchema.parse(r);
  }
  async declineSignup(id: string, reason: string) {
    await delay(500);
    const r = db().signups.find((x) => x.id === id);
    if (!r) err(404, "NOT_FOUND", "No such request");
    Object.assign(r, { status: "declined", decided_at: iso(0), reason: reason || null });
    return signupRequestSchema.parse(r);
  }
  async outbox() {
    await delay();
    return {
      smtpConfigured: false,
      notice: "No email server is set up, so these emails were not sent. As the platform owner you can see every link here; each view is written to the activity log.",
      items: db().outbox.map((e) => outboxEmailSchema.parse(e)),
      nextCursor: null,
    };
  }
  async testEmail() {
    await delay(500);
    return { delivered: "outbox" as const };
  }
  async audit(q: AuditQuery = {}): Promise<Paged<ReturnType<typeof auditEventSchema.parse>>> {
    await delay();
    let rows = db().audit.map((e) => auditEventSchema.parse(e));
    const u = db().current();
    // A business Admin sees only rows of their business (10.10).
    if (u && !u.platform_role) {
      const own = new Set(u.memberships.filter((m) => m.role === "admin").map((m) => m.merchant_id));
      rows = rows.filter((r) => r.merchantId && own.has(r.merchantId));
    }
    if (q.merchant_id) rows = rows.filter((r) => r.merchantId === q.merchant_id);
    if (q.actor_id) rows = rows.filter((r) => r.actorId === q.actor_id);
    if (q.action) rows = rows.filter((r) => (q.action!.endsWith(".") ? r.action.startsWith(q.action!) : r.action === q.action));
    if (q.from) rows = rows.filter((r) => r.at >= q.from!);
    if (q.to) rows = rows.filter((r) => r.at <= q.to!);
    return { items: rows.slice(0, q.limit ?? 50), nextCursor: null };
  }
  auditCsvUrl() {
    return null;
  }
  async customers(q: { q?: string } = {}) {
    await delay();
    const api = await clearing();
    const page = await api.gateway.payments({ limit: 500 });
    const by = new Map<string, { email: string | null; name: string | null; wallets: Set<string>; payments: number; paid: number; total: bigint; refunded: bigint; first: string; last: string; merchant: string | null }>();
    for (const p of page.items) {
      const key = (p.customer_email ?? p.payer ?? "").toLowerCase();
      if (!key) continue;
      const c = by.get(key) ?? { email: p.customer_email ?? null, name: p.customer_name ?? null, wallets: new Set<string>(), payments: 0, paid: 0, total: 0n, refunded: 0n, first: p.created_at, last: p.created_at, merchant: p.merchant_id ?? getMerchantScope() };
      if (p.payer) c.wallets.add(p.payer);
      c.payments += 1;
      if (p.status === "paid" || p.status === "overpaid") c.paid += 1;
      c.total += BigInt(p.amount_paid);
      c.refunded += BigInt(p.amount_refunded);
      if (p.created_at < c.first) c.first = p.created_at;
      if (p.created_at > c.last) c.last = p.created_at;
      by.set(key, c);
    }
    let items = [...by.entries()].map(([key, c]) =>
      customerSchema.parse({ id: `cus_${btoa(`${c.merchant ?? ""}:${key}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`, merchant_id: c.merchant, email: c.email, name: c.name, wallets: [...c.wallets], payments: c.payments, paid_payments: c.paid, total_paid: c.total.toString(), total_refunded: c.refunded.toString(), first_payment_at: c.first, last_payment_at: c.last }),
    );
    const text = q.q?.trim().toLowerCase();
    if (text) items = items.filter((c) => (c.email ?? "").toLowerCase().startsWith(text) || c.wallets.some((w) => w.toLowerCase().startsWith(text)) || (c.name ?? "").toLowerCase().includes(text));
    items.sort((a, b) => (b.lastPaymentAt ?? "").localeCompare(a.lastPaymentAt ?? ""));
    return { items, nextCursor: null };
  }
}

// ---------------------------------------------------------------------------
// Search over the mock node's own data
// ---------------------------------------------------------------------------

let clearingApi: Promise<ClearingApi> | null = null;
function clearing(): Promise<ClearingApi> {
  clearingApi ??= import("./server").then((m) => new m.MockClearingApi());
  return clearingApi;
}

const usdc = (v: string) => `${formatMoney(v, 6)} USDC`;
const has = (hay: (string | null | undefined)[], q: string) => hay.some((h) => h && h.toLowerCase().includes(q));

export class MockSearchApi implements SearchApi {
  async search(q: string, opts: { types?: RecordType[] | null; limit?: number } = {}): Promise<SearchResponse> {
    const started = performance.now();
    await delay(90);
    const text = q.trim();
    const lower = text.toLowerCase();
    const d = detect(text);
    if (d.kind === "short") return { detected: null, tookMs: 0, groups: [] };
    const api = await clearing();
    const limit = opts.limit ?? 8;
    const want = (t: RecordType) => !opts.types || opts.types.includes(t);
    const u = db().current();
    const platform = Boolean(u?.platform_role) || !u;
    const groups: SearchGroup[] = [];
    const push = (type: RecordType, items: SearchItem[]) => {
      if (items.length) groups.push({ type, total: items.length, items: items.slice(0, limit) });
    };
    const amount = d.kind === "amount" ? Number(text) : null;
    // Load every source at once so the mock answers about as fast as the real index.
    const [paymentsPage, linksList, customersPage, refundsPage, merchantsList, budgetsList, catalog, batchesList] = await Promise.all([
      want("payment") ? api.gateway.payments({ limit: 500 }) : null,
      want("link") ? api.gateway.links() : null,
      want("customer") ? new MockAccountApi().customers({}) : null,
      want("refund") ? api.gateway.refunds({ limit: 200 }) : null,
      platform && want("business") ? api.operator.merchants() : null,
      platform && want("budget") ? api.budgets() : null,
      platform && want("paid_service") ? api.providerCatalog() : null,
      platform && want("settlement") ? api.batches() : null,
    ]);

    if (want("payment")) {
      const page = paymentsPage!;
      push(
        "payment",
        page.items
          .filter((p) =>
            amount !== null
              ? Number(formatMoney(p.amount, 6).replace(/,/g, "")) === amount
              : has([p.id, p.reference, p.description, p.customer_email, p.payer], lower),
          )
          .slice(0, amount !== null ? 5 : 50)
          .map((p) => {
            const field = amount !== null ? "amount" : p.customer_email?.toLowerCase().includes(lower) ? "customer_email" : p.payer?.toLowerCase().includes(lower) ? "payer" : p.id.toLowerCase().includes(lower) ? "id" : "description";
            const snippet = field === "amount" ? usdc(p.amount) : field === "customer_email" ? p.customer_email! : field === "payer" ? shortAddress(p.payer!) : field === "id" ? p.id : (p.description ?? p.reference ?? "");
            return { key: `payment:${p.id}`, type: "payment" as const, id: p.id, title: p.reference || p.description || p.id, subtitle: `${p.status.replace(/_/g, " ")} - ${usdc(p.amount)}`, href: `/payments/${p.id}`, status: p.status, matched: { field, snippet }, merchantId: p.merchant_id ?? null };
          }),
      );
    }
    if (want("link") && d.kind !== "amount") {
      const links = linksList!;
      push(
        "link",
        links.filter((l) => has([l.id, l.slug, l.title, l.description], lower)).map((l) => ({ key: `link:${l.id}`, type: "link" as const, id: l.id, title: l.title, subtitle: `${l.active ? "Active" : "Off"} - ${l.amount ? usdc(l.amount) : "Customer chooses"}`, href: `/links/${l.id}`, status: l.active ? "active" : "inactive", matched: { field: "title", snippet: l.title } })),
      );
    }
    if (want("customer") && d.kind !== "amount") {
      const cs = customersPage!;
      push(
        "customer",
        cs.items.filter((c) => has([c.email, c.name, ...c.wallets], lower)).map((c) => ({ key: `customer:${c.id}`, type: "customer" as const, id: c.id, title: c.email ?? shortAddress(c.wallets[0] ?? ""), subtitle: `${c.payments} payment${c.payments === 1 ? "" : "s"} - ${usdc(c.totalPaid)}`, href: `/customers?q=${encodeURIComponent(c.email ?? c.wallets[0] ?? "")}`, matched: { field: c.email ? "email" : "wallet", snippet: c.email ?? c.wallets[0] ?? "" } })),
      );
    }
    if (want("refund") && d.kind !== "amount") {
      const rs = refundsPage!;
      push(
        "refund",
        rs.items.filter((r) => has([r.id, r.payment_id, r.tx_hash, r.to], lower)).map((r) => ({ key: `refund:${r.id}`, type: "refund" as const, id: r.id, title: `Refund ${usdc(r.amount)}`, subtitle: `${r.status} - ${r.payment_id}`, href: `/payments/${r.payment_id}`, status: r.status, matched: { field: "id", snippet: r.id } })),
      );
    }
    if (platform && want("business") && d.kind !== "amount") {
      const ms = merchantsList!;
      push(
        "business",
        ms.filter((m) => has([m.id, m.name, m.slug, m.payout, m.support_email], lower)).map((m) => ({ key: `business:${m.id}`, type: "business" as const, id: m.id, title: m.name, subtitle: m.status === "suspended" ? "Suspended" : "Active", href: `/platform/businesses/${m.id}`, status: m.status, matched: { field: "name", snippet: m.name } })),
      );
    }
    if (platform && want("budget") && d.kind !== "amount") {
      const ms = budgetsList!;
      push(
        "budget",
        ms.filter((m) => has([m.id, m.label, m.agent, m.owner], lower)).map((m) => ({ key: `budget:${m.id}`, type: "budget" as const, id: m.id, title: m.label, subtitle: `${m.status === "open" ? "Active" : m.status} - limit ${usdc(m.cap)}`, href: `/budgets/${m.id}`, status: m.status, matched: { field: "label", snippet: m.label } })),
      );
    }
    if (platform && want("paid_service") && d.kind !== "amount") {
      const ps = catalog!;
      push(
        "paid_service",
        ps.filter((p) => has([p.id, p.name, p.resource, p.payee], lower)).map((p) => ({ key: `paid_service:${p.id}`, type: "paid_service" as const, id: p.id, title: p.name, subtitle: `${usdc(p.priceAtomic)} per charge`, href: `/providers#${p.id}`, matched: { field: "name", snippet: p.name } })),
      );
    }
    if (platform && want("settlement") && (d.kind === "tx_hash" || d.kind === "id" || d.kind === "text" || d.kind === "amount")) {
      const bs = batchesList!;
      push(
        "settlement",
        bs.filter((b) => has([b.id, b.txHash, `#${b.seq}`, `settlement ${b.seq}`], lower)).map((b) => ({ key: `settlement:${b.id}`, type: "settlement" as const, id: b.id, title: `Settlement #${b.seq}`, subtitle: `${b.status} - ${b.calls} charges`, href: `/batches/${b.id}`, status: b.status, matched: { field: "id", snippet: `#${b.seq}` } })),
      );
    }
    const detected = d.kind === "id" ? "id" : d.kind;
    return { detected, tookMs: Math.round(performance.now() - started), groups };
  }
  async recent() {
    await delay(60);
    return db().recent.map((i) => ({ key: `recent:${i.type}:${i.id}`, type: "recent" as const, id: i.id, title: i.title, href: i.href, subtitle: GROUP_LABEL[i.type as RecordType] ?? "Page" }));
  }
  async record(item: { type: string; id: string; title: string; href: string }) {
    const s = db();
    s.recent = [{ ...item, at: iso(0) }, ...s.recent.filter((r) => r.href !== item.href)].slice(0, 20);
  }
}

