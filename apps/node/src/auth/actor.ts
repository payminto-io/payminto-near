import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { ApiError } from "../errors.ts";
import type { ApiKeyRow } from "../gateway/model.ts";
import type { ApiKeyService } from "../gateway/keys.ts";
import type { MerchantRow, MerchantService } from "../gateway/merchants.ts";
import type { AuditActor } from "./audit.ts";
import { API_KEY_PERMISSIONS, type BusinessPermission, type PlatformPermission } from "./permissions.ts";
import type { AuthService, IssuedSession, SessionRow, UserRow } from "./service.ts";
import { safeEqual } from "./tokens.ts";

export const SESSION_COOKIE_SECURE = "__Host-pm_session";
export const SESSION_COOKIE_PLAIN = "pm_session";
export const CSRF_HEADER = "x-payminto-csrf";

export type Actor =
  | { type: "user"; user: UserRow; session: SessionRow; ip: string; userAgent: string | null }
  | { type: "api_key"; key: ApiKeyRow; ip: string; userAgent: string | null }
  | { type: "recovery_key"; ip: string; userAgent: string | null }
  | { type: "anonymous"; ip: string; userAgent: string | null; reason: "missing" | "expired" | "revoked" | "recovery_key_disabled" };

export type AuthVars = { Variables: { actor: Actor } };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Recovery-key reads are written to the activity log at most this often per path. */
const RECOVERY_READ_AUDIT_SEC = 60;

export type AuthDeps = {
  auth: AuthService;
  keys: () => ApiKeyService | null;
  merchants: () => MerchantService | null;
  clientIp: (c: Context) => string;
  bearer: (c: Context) => string | null;
};

export function cookieName(dashboardUrl: string): string {
  return dashboardUrl.startsWith("https:") ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

/** Writes the session cookie (or clears it with `null`). */
export function setSessionCookie(c: Context, auth: AuthService, issued: IssuedSession | null): void {
  const secure = auth.settings.dashboardUrl.startsWith("https:");
  const name = cookieName(auth.settings.dashboardUrl);
  const maxAge = issued ? Math.max(0, issued.session.expires_unix - auth.clock()) : 0;
  const value = issued ? issued.token : "";
  c.header("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`, { append: true });
}

export function auditActor(a: Actor): AuditActor & { userId: string | null } {
  switch (a.type) {
    case "user":
      return { type: "user", id: a.user.id, ip: a.ip, userId: a.user.id };
    case "api_key":
      return { type: "api_key", id: a.key.id, ip: a.ip, userId: null };
    case "recovery_key":
      return { type: "recovery_key", id: null, ip: a.ip, userId: null };
    default:
      return { type: "system", id: null, ip: a.ip, userId: null };
  }
}

/**
 * Resolves every request into one actor (PRODUCT.md 10.1): an API key, the recovery key, or the session cookie.
 * CSRF is checked where a route uses the actor (`Access.authed`), so public routes keep working for a browser that
 * also happens to carry a session cookie.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveActor(d: AuthDeps): MiddlewareHandler<any> {
  const recoveryReads = new Map<string, number>();
  return async (c, next) => {
    const ip = d.clientIp(c);
    const userAgent = c.req.header("user-agent") ?? null;
    const t = d.bearer(c);
    let actor: Actor;
    if (t !== null) {
      if (safeEqual(t, d.auth.settings.adminToken)) {
        if (d.auth.recoveryKeyActive()) {
          actor = { type: "recovery_key", ip, userAgent };
          const target = `${c.req.method} ${c.req.path}`;
          const now = d.auth.clock();
          const last = recoveryReads.get(target) ?? 0;
          if (MUTATING.has(c.req.method) || now - last >= RECOVERY_READ_AUDIT_SEC) {
            if (!MUTATING.has(c.req.method)) {
              recoveryReads.set(target, now);
              if (recoveryReads.size > 5_000) recoveryReads.clear();
            }
            d.auth.audit.write({ type: "recovery_key", id: null, ip }, "recovery_key.used", { target, meta: { bootstrap: !d.auth.ownerExists() } });
          }
        } else actor = { type: "anonymous", ip, userAgent, reason: "recovery_key_disabled" };
      } else {
        const key = t.startsWith("sk_") ? (d.keys()?.authenticate(t) ?? null) : null;
        actor = key ? { type: "api_key", key, ip, userAgent } : { type: "anonymous", ip, userAgent, reason: "missing" };
      }
    } else {
      const token = getCookie(c, SESSION_COOKIE_SECURE) ?? getCookie(c, SESSION_COOKIE_PLAIN);
      if (!token) actor = { type: "anonymous", ip, userAgent, reason: "missing" };
      else {
        const r = d.auth.resolveSession(token, { ip, userAgent });
        if (r.ok) {
          actor = { type: "user", user: r.user, session: r.session, ip, userAgent };
          if (r.rotated) setSessionCookie(c, d.auth, r.rotated);
        } else {
          actor = { type: "anonymous", ip, userAgent, reason: r.reason };
          setSessionCookie(c, d.auth, null);
        }
      }
    }
    c.set("actor", actor);
    await next();
  };
}

/** Permission checks for routes (PRODUCT.md 10.4 and 10.12). */
export class Access {
  readonly #d: AuthDeps;

  constructor(d: AuthDeps) {
    this.#d = d;
  }

  get auth(): AuthService {
    return this.#d.auth;
  }

  actor(c: Context): Actor {
    return (c.get("actor") as Actor | undefined) ?? { type: "anonymous", ip: this.#d.clientIp(c), userAgent: null, reason: "missing" };
  }

  /** The request's `Origin`, when present, must be the dashboard or a configured origin. */
  checkOrigin(c: Context): void {
    const origin = c.req.header("origin");
    if (origin === undefined) return;
    const s = this.#d.auth.settings;
    if (origin === s.dashboardUrl || s.allowedOrigins.includes(origin)) return;
    throw new ApiError(403, "CSRF_FAILED", "this request comes from an origin that is not allowed");
  }

  /** CSRF for a cookie-authenticated request: the per-session header plus the Origin check. */
  checkCsrf(c: Context, session: SessionRow): void {
    this.checkOrigin(c);
    const sent = c.req.header(CSRF_HEADER);
    if (!sent || !safeEqual(sent, session.csrf_token)) {
      throw new ApiError(403, "CSRF_FAILED", "missing or wrong X-Payminto-CSRF header; read csrf_token from GET /v1/auth/session");
    }
  }

  /** Any authenticated actor; cookie-authenticated mutations must pass the CSRF check. */
  authed(c: Context): Exclude<Actor, { type: "anonymous" }> {
    const a = this.actor(c);
    if (a.type === "anonymous") {
      if (a.reason === "recovery_key_disabled") {
        throw new ApiError(401, "RECOVERY_KEY_DISABLED", "the recovery key works only before setup or with ADMIN_TOKEN_BREAK_GLASS=true; sign in instead");
      }
      throw new ApiError(401, "UNAUTHORIZED", "sign in, or send a merchant API key", { reason: a.reason });
    }
    if (a.type === "user" && MUTATING.has(c.req.method)) this.checkCsrf(c, a.session);
    return a;
  }

  user(c: Context): Extract<Actor, { type: "user" }> {
    const a = this.authed(c);
    if (a.type !== "user") throw new ApiError(401, "UNAUTHORIZED", "this route needs a signed-in user", { reason: "missing" });
    return a;
  }

  hasPlatform(a: Actor, perm: PlatformPermission): boolean {
    if (a.type === "recovery_key") return true;
    if (a.type !== "user") return false;
    return this.#d.auth.platformPermissions(a.user).includes(perm);
  }

  /** Requires a platform permission. */
  platform(c: Context, perm: PlatformPermission) {
    const a = this.authed(c);
    // An API key is never a platform credential: the credential is wrong, not the role.
    if (a.type === "api_key") throw new ApiError(401, "UNAUTHORIZED", "API keys act for one business; platform routes need a signed-in platform role", { reason: "missing" });
    if (!this.hasPlatform(a, perm)) throw new ApiError(403, "FORBIDDEN", "your role cannot do this", { permission: perm });
    return a;
  }

  /** True when the actor sees every business (platform roles, the recovery key). */
  isPlatformActor(a: Actor): boolean {
    return a.type === "recovery_key" || (a.type === "user" && a.user.platform_role !== null && a.user.status === "active");
  }

  canBusiness(a: Actor, perm: BusinessPermission, merchantId: string): boolean {
    switch (a.type) {
      case "recovery_key":
        return true;
      case "api_key":
        // A run-scoped agent key carries a narrower list (docs/AGENTS.md section 4).
        return a.key.merchant_id === merchantId && API_KEY_PERMISSIONS.includes(perm) && (!a.key.permissions || (JSON.parse(a.key.permissions) as string[]).includes(perm));
      case "user":
        return this.#d.auth.businessPermissions(a.user, merchantId).includes(perm);
      default:
        return false;
    }
  }

  /** Can the actor see this business at all (otherwise it is 404, so ids of other businesses are not confirmed)? */
  #visible(a: Actor, merchantId: string): boolean {
    if (this.isPlatformActor(a)) return true;
    if (a.type === "api_key") return a.key.merchant_id === merchantId;
    if (a.type === "user") return !!this.#d.auth.membership(a.user.id, merchantId);
    return false;
  }

  #merchants(): MerchantService {
    const m = this.#d.merchants();
    if (!m) throw new ApiError(404, "NOT_FOUND", "the payment gateway is off on this node");
    return m;
  }

  /**
   * The business a request acts on (`Merchant-Id`, else the only or last-used business) with a business permission.
   * Returns the merchant and the actor.
   */
  business(c: Context, perm: BusinessPermission, explicitId?: string): { merchant: MerchantRow; actor: Exclude<Actor, { type: "anonymous" }> } {
    const a = this.authed(c);
    const ms = this.#merchants();
    let merchant: MerchantRow | undefined;
    const header = explicitId ?? c.req.header("merchant-id");
    if (a.type === "api_key") {
      if (header && header !== a.key.merchant_id) throw new ApiError(404, "UNKNOWN_MERCHANT", "Merchant-Id names no merchant on this node");
      merchant = ms.merchant(a.key.merchant_id);
    } else if (header) {
      merchant = ms.maybeMerchant(header);
      if (!merchant || !this.#visible(a, merchant.id)) throw new ApiError(404, "UNKNOWN_MERCHANT", "Merchant-Id names no merchant on this node");
    } else if (this.isPlatformActor(a)) {
      merchant = ms.soleMerchant();
      if (!merchant) throw new ApiError(400, "MERCHANT_REQUIRED", "pass Merchant-Id: mer_... to act for a business");
    } else if (a.type === "user") {
      if (a.user.status === "pending") throw new ApiError(403, "ACCOUNT_PENDING", "your account is waiting for approval");
      const mine = this.#d.auth.memberships(a.user.id);
      if (mine.length === 0) throw new ApiError(403, "FORBIDDEN", "you are not a member of any business", { permission: perm });
      const pick = mine.length === 1 ? mine[0] : mine.find((m) => m.merchant_id === a.user.last_business_id);
      if (!pick) throw new ApiError(400, "MERCHANT_REQUIRED", "pass Merchant-Id: mer_... to choose one of your businesses");
      merchant = ms.merchant(pick.merchant_id);
    }
    if (!merchant) throw new ApiError(404, "UNKNOWN_MERCHANT", "merchant not found");
    if (a.type === "user" && a.user.status === "pending") throw new ApiError(403, "ACCOUNT_PENDING", "your account is waiting for approval");
    if (!this.canBusiness(a, perm, merchant.id)) throw new ApiError(403, "FORBIDDEN", "your role cannot do this", { permission: perm });
    return { merchant, actor: a };
  }

  /**
   * The businesses a list covers: the one named by Merchant-Id (or the actor's business), or null for every business
   * when a platform actor sends no Merchant-Id.
   */
  scope(c: Context, perm: BusinessPermission): { merchantIds: string[] | null; actor: Exclude<Actor, { type: "anonymous" }> } {
    const a = this.authed(c);
    if (this.isPlatformActor(a) && !c.req.header("merchant-id")) {
      this.#merchants();
      if (a.type === "user" && !this.#d.auth.businessPermissions(a.user, "*").includes(perm)) throw new ApiError(403, "FORBIDDEN", "your role cannot do this", { permission: perm });
      return { merchantIds: null, actor: a };
    }
    const { merchant } = this.business(c, perm);
    return { merchantIds: [merchant.id], actor: a };
  }

  /** Sensitive actions: a password check within the last 10 minutes (users only). */
  stepUp(a: Actor): void {
    if (a.type === "user" && !this.#d.auth.stepUpOk(a.session)) {
      throw new ApiError(403, "STEP_UP_REQUIRED", "confirm your password to continue (POST /v1/auth/step-up)");
    }
  }

  /** Payout changes, API keys and invites need a verified email (users only). */
  verified(a: Actor): void {
    if (a.type === "user" && !a.user.email_verified_at) throw new ApiError(403, "EMAIL_NOT_VERIFIED", "verify your email first");
  }
}
