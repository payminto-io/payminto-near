import type { Context, Hono } from "hono";
import { z } from "zod";
import { networkFor } from "@payminto/protocol";
import { ApiError } from "../errors.ts";
import type { Metrics } from "../metrics.ts";
import { TokenBuckets } from "../ratelimit.ts";
import { body } from "../gateway/http.ts";
import { Access, auditActor, CSRF_HEADER, setSessionCookie, type Actor } from "./actor.ts";
import type { AuthService, IssuedSession, UserRow } from "./service.ts";
import { safeEqual } from "./tokens.ts";

export type AuthLimits = {
  /** Requests per minute per IP across /v1/auth/*, /v1/setup* and the invite routes. */
  authPerMin: number;
  /** Setup code attempts per minute per IP. */
  setupPerMin: number;
  /** Reset, verify and resend emails per address per hour. */
  emailPerHour: number;
};

export const DEFAULT_AUTH_LIMITS: AuthLimits = { authPerMin: 20, setupPerMin: 5, emailPerHour: 3 };

const zEmail = z.email().max(254);
const zPassword = z.string().min(1).max(1024);
const zName = z.string().trim().min(1).max(120);
const zToken = z.string().min(16).max(200);

const setupSchema = z.object({ code: z.string().min(8).max(200), platform_name: zName.optional(), name: zName, email: zEmail, password: zPassword });
const loginSchema = z.object({ email: zEmail, password: zPassword });
const signupSchema = z.object({ email: zEmail, password: zPassword, name: zName, business_name: zName });
const inviteSchema = z.object({ emails: z.array(zEmail).min(1).max(50), role: z.enum(["admin", "staff", "viewer", "platform_admin"]) });
const acceptSchema = z.object({ token: zToken, name: zName.optional(), password: zPassword.optional() });

/** The pre-session routes skip the CSRF token (there is no session yet) but keep the Origin check. */
export function mountAuth(app: Hono<any>, a: Access, o: { metrics: Metrics; limits: AuthLimits; chainId: number; tooMany: (c: Context, scope: string, retryAfterSec: number) => Response }) {
  const auth: AuthService = a.auth;
  const ipBucket = new TokenBuckets({ rps: o.limits.authPerMin / 60, burst: o.limits.authPerMin });
  const setupBucket = new TokenBuckets({ rps: o.limits.setupPerMin / 60, burst: o.limits.setupPerMin });
  const emailBucket = new TokenBuckets({ rps: o.limits.emailPerHour / 3600, burst: o.limits.emailPerHour });
  const net = networkFor(o.chainId);
  const client = (c: Context) => {
    const x = a.actor(c);
    return { ip: x.ip, userAgent: x.userAgent };
  };
  /** Per-IP limit on every auth route; failures are counted as metrics by the service. */
  app.use("/v1/auth/*", async (c, next) => {
    const r = ipBucket.take(a.actor(c).ip);
    if (!r.ok) return o.tooMany(c, "auth", r.retryAfterSec);
    return next();
  });
  for (const path of ["/v1/setup", "/v1/setup/*", "/v1/invites/lookup", "/v1/invites/accept"]) {
    app.use(path, async (c, next) => {
      if (c.req.method === "GET") return next();
      const r = (path.startsWith("/v1/setup") ? setupBucket : ipBucket).take(a.actor(c).ip);
      if (!r.ok) return o.tooMany(c, "auth", r.retryAfterSec);
      return next();
    });
  }
  /** At most emailPerHour emails per address: the request still answers 202 and sends nothing. */
  const emailAllowed = (email: string) => emailBucket.take(email.trim().toLowerCase()).ok;
  const signedIn = (c: Context): Extract<Actor, { type: "user" }> | null => {
    const x = a.actor(c);
    return x.type === "user" ? x : null;
  };
  const sessionBody = (c: Context, user: UserRow, issued: IssuedSession, status = 200) => {
    setSessionCookie(c, auth, issued);
    return c.json(auth.sessionJson(user, issued.session), status as 200);
  };

  // ------------------------------------------------------------------ setup

  app.get("/v1/setup", (c) => {
    const info = auth.setupInfo();
    // Public: lets the sign-in page hide "Create an account" and the sign-up page say up front when sign-up is off.
    if (!info.needed) return c.json({ ...info, signup_mode: auth.signupMode() });
    return c.json({ ...info, network: { chain_id: o.chainId, name: net.chain.name, testnet: !!net.chain.testnet } });
  });
  app.post("/v1/setup/check", async (c) => {
    a.checkOrigin(c);
    const { code } = await body(c, z.object({ code: z.string().min(1).max(200) }));
    auth.checkSetupCode(code);
    return c.json({ ok: true });
  });
  app.post("/v1/setup", async (c) => {
    a.checkOrigin(c);
    const b = await body(c, setupSchema);
    const out = await auth.completeSetup(b, client(c));
    return sessionBody(c, out.user, out, 201);
  });

  // ------------------------------------------------------------------ sign-in and sessions

  app.post("/v1/auth/login", async (c) => {
    a.checkOrigin(c);
    const b = await body(c, loginSchema);
    const out = await auth.login(b.email, b.password, client(c), signedIn(c)?.session ?? null);
    return sessionBody(c, out.user, out);
  });
  app.get("/v1/auth/session", (c) => {
    const x = a.authed(c);
    if (x.type === "recovery_key") return c.json(auth.recoverySessionJson());
    if (x.type === "api_key") throw new ApiError(401, "UNAUTHORIZED", "API keys have no session; sign in", { reason: "missing" });
    return c.json(auth.sessionJson(x.user, x.session));
  });
  app.post("/v1/auth/logout", (c) => {
    const x = a.user(c);
    auth.logout(x.user, x.session, client(c));
    setSessionCookie(c, auth, null);
    return c.json({ ok: true });
  });
  app.post("/v1/auth/logout-all", (c) => {
    const x = a.user(c);
    const revoked = auth.logoutAll(x.user, client(c));
    setSessionCookie(c, auth, null);
    return c.json({ ok: true, revoked });
  });
  app.post("/v1/auth/step-up", async (c) => {
    const x = a.user(c);
    const { password } = await body(c, z.object({ password: zPassword }));
    const until = await auth.stepUp(x.user, x.session, password);
    return c.json({ step_up_until: new Date(until * 1000).toISOString() });
  });
  app.get("/v1/auth/sessions", (c) => {
    const x = a.user(c);
    return c.json({ items: auth.sessionsOf(x.user.id, x.session.id) });
  });
  app.delete("/v1/auth/sessions/:id", (c) => {
    const x = a.user(c);
    const id = c.req.param("id");
    if (!auth.sessionsOf(x.user.id, x.session.id).some((s) => s.id === id)) throw new ApiError(404, "NOT_FOUND", "session not found");
    auth.revokeSession(id);
    auth.audit.write(auditActor(x), "session.revoked", { target: id, meta: { count: 1 } });
    if (id === x.session.id) setSessionCookie(c, auth, null);
    return c.json({ id, revoked: true });
  });
  app.post("/v1/auth/sessions/revoke-others", (c) => {
    const x = a.user(c);
    const revoked = auth.revokeAll(x.user.id, x.session.id);
    auth.audit.write(auditActor(x), "session.revoked", { target: x.user.id, meta: { count: revoked } });
    return c.json({ revoked });
  });
  app.patch("/v1/auth/me", async (c) => {
    const x = a.user(c);
    const b = await body(c, z.object({ name: zName.optional(), last_business_id: z.string().min(1).max(64).nullable().optional() }));
    const user = auth.updateMe(x.user, b);
    return c.json(auth.sessionJson(user, x.session));
  });
  app.post("/v1/auth/password", async (c) => {
    const x = a.user(c);
    const b = await body(c, z.object({ current_password: zPassword, new_password: zPassword }));
    const issued = await auth.changePassword(x.user, x.session, b.current_password, b.new_password, client(c));
    return sessionBody(c, auth.user(x.user.id)!, issued);
  });
  app.post("/v1/auth/verify/resend", (c) => {
    const x = a.user(c);
    if (emailAllowed(x.user.email)) auth.resendVerification(x.user);
    return c.json({ ok: true }, 202);
  });

  // ------------------------------------------------------------------ sign-up, verification, reset

  app.post("/v1/auth/signup", async (c) => {
    a.checkOrigin(c);
    const b = await body(c, signupSchema);
    if (auth.signupMode() === "off") throw new ApiError(403, "SIGNUP_DISABLED", "Sign-up is off on this server; ask the platform owner for an invite");
    if (emailAllowed(b.email)) await auth.signup(b, client(c));
    return c.json({ ok: true }, 202);
  });
  app.post("/v1/auth/verify", async (c) => {
    a.checkOrigin(c);
    const { token } = await body(c, z.object({ token: zToken }));
    return c.json({ ok: true, ...auth.verify(token, client(c)) });
  });
  app.post("/v1/auth/forgot", async (c) => {
    a.checkOrigin(c);
    const { email } = await body(c, z.object({ email: zEmail }));
    if (emailAllowed(email)) auth.forgot(email, client(c));
    return c.json({ ok: true }, 202);
  });
  app.post("/v1/auth/reset/check", async (c) => {
    a.checkOrigin(c);
    const { token } = await body(c, z.object({ token: zToken }));
    return c.json({ ok: true, ...auth.checkReset(token) });
  });
  app.post("/v1/auth/reset", async (c) => {
    a.checkOrigin(c);
    const b = await body(c, z.object({ token: zToken, password: zPassword }));
    await auth.reset(b.token, b.password, client(c));
    setSessionCookie(c, auth, null);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ invites and members

  const inviteScope = (c: Context, role?: string): { merchantId: string | null; actor: Exclude<Actor, { type: "anonymous" }> } => {
    const platform = role === "platform_admin" || (role === undefined && c.req.query("scope") === "platform");
    if (platform) return { merchantId: null, actor: a.platform(c, "team.manage") };
    const { merchant, actor } = a.business(c, "members.manage");
    return { merchantId: merchant.id, actor };
  };
  const notApiKey = (x: Actor) => {
    if (x.type === "api_key") throw new ApiError(403, "FORBIDDEN", "API keys cannot manage people", { permission: "members.manage" });
  };

  app.get("/v1/members", (c) => {
    const { merchant, actor } = a.business(c, "members.read");
    notApiKey(actor);
    return c.json(auth.members(merchant.id));
  });
  app.patch("/v1/members/:userId", async (c) => {
    const { merchant, actor } = a.business(c, "members.manage");
    notApiKey(actor);
    a.stepUp(actor);
    const { role } = await body(c, z.object({ role: z.enum(["admin", "staff", "viewer"]) }));
    return c.json(auth.setMemberRole(merchant.id, c.req.param("userId"), role, auditActor(actor)));
  });
  app.delete("/v1/members/:userId", (c) => {
    const { merchant, actor } = a.business(c, "members.manage");
    notApiKey(actor);
    return c.json(auth.removeMember(merchant.id, c.req.param("userId"), auditActor(actor)));
  });

  app.get("/v1/invites", (c) => {
    const { merchantId, actor } = inviteScope(c);
    notApiKey(actor);
    return c.json(auth.invites(merchantId));
  });
  app.post("/v1/invites", async (c) => {
    const b = await body(c, inviteSchema);
    const { merchantId, actor } = inviteScope(c, b.role);
    notApiKey(actor);
    a.verified(actor);
    return c.json(auth.invite(merchantId, b.emails, b.role, auditActor(actor)), 201);
  });
  const ownInvite = (c: Context) => {
    const inv = auth.inviteRow(c.req.param("id")!);
    const { merchantId, actor } = inviteScope(c, inv.merchant_id === null ? "platform_admin" : (inv.role ?? undefined));
    notApiKey(actor);
    if (merchantId !== inv.merchant_id) throw new ApiError(404, "NOT_FOUND", "invite not found");
    return { inv, actor };
  };
  app.post("/v1/invites/:id/resend", (c) => {
    const { inv, actor } = ownInvite(c);
    a.verified(actor);
    return c.json(auth.resendInvite(inv.id, auditActor(actor)));
  });
  app.delete("/v1/invites/:id", (c) => {
    const { inv, actor } = ownInvite(c);
    return c.json(auth.revokeInvite(inv.id, auditActor(actor)));
  });
  app.post("/v1/invites/lookup", async (c) => {
    a.checkOrigin(c);
    const { token } = await body(c, z.object({ token: zToken }));
    return c.json(auth.lookupInvite(token, signedIn(c)?.user ?? null));
  });
  app.post("/v1/invites/accept", async (c) => {
    a.checkOrigin(c);
    const b = await body(c, acceptSchema);
    const me = signedIn(c);
    // Adding a membership to a signed-in account is a cookie-authenticated change, so it needs the CSRF header.
    if (me) {
      const sent = c.req.header(CSRF_HEADER);
      if (!sent || !safeEqual(sent, me.session.csrf_token)) throw new ApiError(403, "CSRF_FAILED", "missing or wrong X-Payminto-CSRF header");
    }
    const out = await auth.acceptInvite(b, me ? { user: me.user, session: me.session } : null, client(c));
    return sessionBody(c, out.user, out.issued!);
  });

  // ------------------------------------------------------------------ platform team, users, sign-ups, outbox

  app.get("/v1/platform/team", (c) => (a.platform(c, "team.read"), c.json(auth.team())));
  app.patch("/v1/platform/team/:userId", async (c) => {
    const x = a.platform(c, "team.manage");
    a.stepUp(x);
    const { platform_role } = await body(c, z.object({ platform_role: z.enum(["admin"]).nullable() }));
    return c.json(auth.setPlatformRole(c.req.param("userId"), platform_role, auditActor(x)));
  });
  app.get("/v1/users", (c) => {
    a.platform(c, "team.read");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const cursor = c.req.query("cursor");
    return c.json(auth.users(c.req.query("q") || undefined, limit, cursor && /^\d+$/.test(cursor) ? Number(cursor) : undefined));
  });
  app.patch("/v1/users/:id", async (c) => {
    const x = a.platform(c, "team.manage");
    const { status } = await body(c, z.object({ status: z.enum(["active", "disabled"]) }));
    return c.json(auth.setUserStatus(c.req.param("id"), status, auditActor(x)));
  });
  app.post("/v1/users/:id/unlock", (c) => {
    const x = a.platform(c, "team.manage");
    return c.json(auth.unlock(c.req.param("id"), auditActor(x)));
  });
  app.post("/v1/users/:id/revoke-sessions", (c) => {
    const x = a.platform(c, "team.manage");
    return c.json(auth.revokeUserSessions(c.req.param("id"), auditActor(x)));
  });

  app.get("/v1/platform/signup-requests", (c) => {
    a.platform(c, "signups.review");
    const status = z.enum(["pending", "approved", "declined", "all"]).catch("pending").parse(c.req.query("status") ?? "pending");
    return c.json(auth.signupRequests(status));
  });
  app.post("/v1/platform/signup-requests/:id/approve", (c) => {
    const x = a.platform(c, "signups.review");
    return c.json(auth.approveSignup(c.req.param("id"), auditActor(x), client(c)));
  });
  app.post("/v1/platform/signup-requests/:id/decline", async (c) => {
    const x = a.platform(c, "signups.review");
    const { reason } = await body(c, z.object({ reason: z.string().trim().max(500).nullish() }));
    return c.json(auth.declineSignup(c.req.param("id"), reason ?? null, auditActor(x)));
  });

  app.get("/v1/platform/outbox", (c) => {
    const x = a.platform(c, "outbox.read");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const cursor = c.req.query("cursor");
    // Every view is on the record: the owner can read sign-in links here, and everyone can see that they did.
    auth.audit.write(auditActor(x), "outbox.viewed", { target: "outbox" });
    return c.json({
      smtp_configured: auth.mailer.configured,
      notice: "Emails are stored here because no email server is configured. The platform owner can see these links, and every view of this page is written to the activity log.",
      ...auth.mailer.outbox(limit, cursor && /^\d+$/.test(cursor) ? Number(cursor) : undefined),
    });
  });
  app.post("/v1/platform/email/test", async (c) => {
    const x = a.platform(c, "platform.manage");
    const { to } = await body(c, z.object({ to: zEmail.optional() }));
    const dest = to ?? (x.type === "user" ? x.user.email : null);
    if (!dest) throw new ApiError(400, "VALIDATION_ERROR", "pass `to`");
    const r = await auth.mailer.sendNow({ to: dest, kind: "test", subject: `${auth.platformName()} test email`, text: "This is a test email from your Payminto server.\n" });
    if (r.error) throw new ApiError(502, "EMAIL_FAILED", `the email server refused the message: ${r.error}`);
    return c.json({ ok: true, delivered: r.delivered });
  });

  // ------------------------------------------------------------------ activity log

  app.get("/v1/audit", (c) => {
    const x = a.authed(c);
    const q = (k: string) => c.req.query(k) || undefined;
    const cursor = q("cursor");
    if (cursor && !/^\d+$/.test(cursor)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    for (const k of ["from", "to"]) if (q(k) && Number.isNaN(Date.parse(q(k)!))) throw new ApiError(400, "VALIDATION_ERROR", `${k} must be an ISO time`);
    let merchantIds: string[] | null;
    if (a.hasPlatform(x, "audit.read")) merchantIds = q("merchant_id") ? [q("merchant_id")!] : null;
    else {
      if (x.type === "api_key") throw new ApiError(403, "FORBIDDEN", "API keys cannot read the activity log", { permission: "audit.read" });
      merchantIds = [a.business(c, "audit.read", q("merchant_id")).merchant.id];
    }
    const filter = { merchantIds, actorId: q("actor_id"), action: q("action"), from: q("from"), to: q("to") };
    if (c.req.query("format") === "csv") {
      return c.body(auth.audit.csv(filter), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="activity.csv"' });
    }
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    return c.json(auth.audit.list({ ...filter, limit, cursor: cursor ? Number(cursor) : undefined }));
  });
}
