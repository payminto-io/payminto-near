import { zeroAddress } from "viem";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Metrics } from "../metrics.ts";
import { nowIso } from "../store.ts";
import type { MerchantService } from "../gateway/merchants.ts";
import type { AuditActor, AuditLog } from "./audit.ts";
import type { Mailer } from "./mailer.ts";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords.ts";
import {
  BUSINESS_PERMISSIONS,
  BUSINESS_ROLE_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_BUSINESS_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  type BusinessRole,
  type PlatformRole,
} from "./permissions.ts";
import { newAuthId, newSecret, newSetupCode, normalizeSetupCode, safeEqual, sha256Hex } from "./tokens.ts";

export type AuthSettings = {
  /** Dashboard origin (links in emails, CSRF Origin check, cookie Secure flag). */
  dashboardUrl: string;
  /** Extra origins allowed to send cookie-authenticated requests (CORS_ORIGINS). */
  allowedOrigins: string[];
  adminToken: string;
  /** ADMIN_TOKEN_BREAK_GLASS: the recovery key keeps working after setup (every use audited). */
  breakGlass: boolean;
  scryptLogN: number;
  idlePlatformSec: number;
  idleBusinessSec: number;
  absoluteSec: number;
  /** A session older than this is rotated on its next request. */
  rotateSec: number;
  /** The token a rotation replaced keeps working this long (parallel requests). */
  rotateGraceSec: number;
  stepUpSec: number;
  platformName: string;
  chainId: number;
};

export const DEFAULT_SESSION = {
  idlePlatformSec: 12 * 3600,
  idleBusinessSec: 7 * 86_400,
  absoluteSec: 30 * 86_400,
  rotateSec: 24 * 3600,
  rotateGraceSec: 60,
  stepUpSec: 600,
};

const SETUP_TTL_SEC = 24 * 3600;
const VERIFY_TTL_SEC = 48 * 3600;
const RESET_TTL_SEC = 30 * 60;
const INVITE_TTL_SEC = 7 * 86_400;
const LOCK_AFTER = 5;
const LOCK_WINDOW_SEC = 15 * 60;
const LOCK_BASE_SEC = 15 * 60;
const LOCK_MAX_SEC = 24 * 3600;
const TOUCH_EVERY_SEC = 60;

export const INVALID_CREDENTIALS_MESSAGE = "Wrong email or password, or the account is temporarily locked. Try again later.";

export type UserRow = {
  id: string;
  email: string;
  email_verified_at: string | null;
  name: string;
  password_hash: string | null;
  platform_role: PlatformRole | null;
  status: "active" | "pending" | "disabled";
  failed_logins: number;
  first_failed_unix: number | null;
  lock_count: number;
  locked_until_unix: number | null;
  last_business_id: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  id: string;
  id_hash: string;
  user_id: string;
  csrf_token: string;
  created_unix: number;
  last_seen_unix: number;
  expires_unix: number;
  idle_expires_unix: number;
  step_up_unix: number | null;
  rotated_from: string | null;
  revoked_unix: number | null;
  rotate_due: number;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
};

export type TokenKind = "verify_email" | "reset_password" | "invite" | "setup";

export type TokenRow = {
  id: string;
  token_hash: string;
  kind: TokenKind;
  user_id: string | null;
  email: string | null;
  merchant_id: string | null;
  role: string | null;
  expires_unix: number;
  used_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type MembershipRow = { user_id: string; merchant_id: string; role: BusinessRole; created_at: string };

export type SignupRequestRow = {
  id: string;
  user_id: string;
  business_name: string;
  status: "unverified" | "pending" | "approved" | "declined";
  reason: string | null;
  merchant_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type InviteRole = BusinessRole | "platform_admin";

/** A new session: the cookie value (shown once) and its row. */
export type IssuedSession = { token: string; session: SessionRow };

export type Client = { ip: string | null; userAgent: string | null };

const lowerEmail = (e: string) => e.trim().toLowerCase();

/**
 * Accounts (PRODUCT.md section 4, contract in section 10): users, sessions, setup code, sign-in with lockout,
 * invites, members, sign-up and approval, email verification, password reset and the platform team.
 * Every change that matters is written to the activity log in the same transaction.
 */
export class AuthService {
  readonly #db: Database;
  readonly #log: Logger;
  readonly #mailer: Mailer;
  readonly #audit: AuditLog;
  readonly #metrics: Metrics | null;
  readonly settings: AuthSettings;
  /** The merchant service, when the gateway is on (businesses live there). */
  merchants: MerchantService | null;
  /** Unix seconds; tests move it. */
  clock: () => number = () => Math.floor(Date.now() / 1000);

  constructor(o: { db: Database; log: Logger; mailer: Mailer; audit: AuditLog; settings: AuthSettings; merchants: MerchantService | null; metrics?: Metrics }) {
    this.#db = o.db;
    this.#log = o.log;
    this.#mailer = o.mailer;
    this.#audit = o.audit;
    this.#metrics = o.metrics ?? null;
    this.settings = o.settings;
    this.merchants = o.merchants;
  }

  get mailer(): Mailer {
    return this.#mailer;
  }

  get audit(): AuditLog {
    return this.#audit;
  }

  #fail(reason: string) {
    this.#metrics?.inc("payminto_auth_failures_total", "Failed authentication attempts, by reason.", { reason });
  }

  link(path: string): string {
    return `${this.settings.dashboardUrl}${path}`;
  }

  platformName(): string {
    return this.merchants?.platformRow()?.name ?? this.settings.platformName;
  }

  // ------------------------------------------------------------------ users

  user(id: string): UserRow | undefined {
    return this.#db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
  }

  userByEmail(email: string): UserRow | undefined {
    return this.#db.get<UserRow>("SELECT * FROM users WHERE email = ?", lowerEmail(email));
  }

  ownerExists(): boolean {
    return !!this.#db.get("SELECT 1 FROM users WHERE platform_role = 'owner'");
  }

  /** True while the recovery key works on every route: before setup, or with break-glass on. */
  recoveryKeyActive(): boolean {
    return this.settings.breakGlass || !this.ownerExists();
  }

  memberships(userId: string): Array<MembershipRow & { business_name: string; business_slug: string; business_status: string }> {
    return this.#db.all(
      `SELECT m.*, b.name AS business_name, b.slug AS business_slug, b.status AS business_status
       FROM memberships m JOIN merchants b ON b.id = m.merchant_id WHERE m.user_id = ? ORDER BY b.name, b.id`,
      userId,
    );
  }

  membership(userId: string, merchantId: string): MembershipRow | undefined {
    return this.#db.get<MembershipRow>("SELECT * FROM memberships WHERE user_id = ? AND merchant_id = ?", userId, merchantId);
  }

  checkPassword(password: string, email: string): void {
    const problem = passwordProblem(password, { email, extra: [this.platformName()] });
    if (problem) {
      const text = {
        too_short: "Use at least 12 characters",
        too_long: "Use at most 256 characters",
        common: "This password is too common or too easy to guess",
        equals_email: "The password must not be your email",
      }[problem];
      throw new ApiError(400, "WEAK_PASSWORD", text, { reason: problem });
    }
  }

  #insertUser(u: { email: string; name: string; hash: string | null; platformRole?: PlatformRole | null; status?: UserRow["status"]; verified?: boolean }): UserRow {
    const id = newAuthId("usr");
    const now = nowIso();
    this.#db.run(
      `INSERT INTO users (id, email, email_verified_at, name, password_hash, platform_role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      lowerEmail(u.email),
      u.verified ? now : null,
      u.name,
      u.hash,
      u.platformRole ?? null,
      u.status ?? "active",
      now,
      now,
    );
    return this.user(id)!;
  }

  // ------------------------------------------------------------------ tokens

  #issueToken(kind: TokenKind, o: { userId?: string | null; email?: string | null; merchantId?: string | null; role?: string | null; ttlSec: number; createdBy?: string | null; secret?: string }): { row: TokenRow; secret: string } {
    const secret = o.secret ?? newSecret();
    const id = newAuthId(kind === "invite" ? "inv" : "tok");
    this.#db.run(
      `INSERT INTO auth_tokens (id, token_hash, kind, user_id, email, merchant_id, role, expires_unix, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sha256Hex(kind === "setup" ? normalizeSetupCode(secret) : secret),
      kind,
      o.userId ?? null,
      o.email ? lowerEmail(o.email) : null,
      o.merchantId ?? null,
      o.role ?? null,
      this.clock() + o.ttlSec,
      o.createdBy ?? null,
      nowIso(),
    );
    return { row: this.#db.get<TokenRow>("SELECT * FROM auth_tokens WHERE id = ?", id)!, secret };
  }

  /** The token row and its state, without using it. */
  peekToken(kind: TokenKind, secret: string): { row: TokenRow; state: "valid" | "expired" | "used" | "revoked" } {
    const row = this.#db.get<TokenRow>("SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?", sha256Hex(secret), kind);
    if (!row) throw new ApiError(400, "TOKEN_INVALID", "This link is not valid");
    const state = row.revoked_at ? "revoked" : row.used_at ? "used" : row.expires_unix <= this.clock() ? "expired" : "valid";
    return { row, state };
  }

  #useToken(kind: TokenKind, secret: string): TokenRow {
    const { row, state } = this.peekToken(kind, secret);
    if (state === "used" || state === "revoked") throw new ApiError(409, "TOKEN_USED", "This link was already used or replaced");
    if (state === "expired") throw new ApiError(410, "TOKEN_EXPIRED", "This link has expired");
    const r = this.#db.run("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL", nowIso(), row.id);
    if (r.changes !== 1) throw new ApiError(409, "TOKEN_USED", "This link was already used or replaced");
    return row;
  }

  #revokeTokens(kind: TokenKind, where: { userId?: string; email?: string; merchantId?: string | null }) {
    const conds = ["kind = ?", "used_at IS NULL", "revoked_at IS NULL"];
    const params: Array<string | null> = [kind];
    if (where.userId) (conds.push("user_id = ?"), params.push(where.userId));
    if (where.email) (conds.push("email = ?"), params.push(lowerEmail(where.email)));
    if (where.merchantId !== undefined) {
      if (where.merchantId === null) conds.push("merchant_id IS NULL");
      else (conds.push("merchant_id = ?"), params.push(where.merchantId));
    }
    this.#db.run(`UPDATE auth_tokens SET revoked_at = ? WHERE ${conds.join(" AND ")}`, nowIso(), ...params);
  }

  // ------------------------------------------------------------------ first-run setup

  /** On boot: when no owner exists, makes sure a valid setup code exists and prints it. Returns the new code, if any. */
  ensureSetupCode(): string | null {
    if (this.ownerExists()) return null;
    const live = this.#db.get<TokenRow>("SELECT * FROM auth_tokens WHERE kind = 'setup' AND used_at IS NULL AND revoked_at IS NULL AND expires_unix > ?", this.clock());
    // The code is shown once; a restart issues a fresh one (the old one stops working), so the latest log line is right.
    if (live) this.#revokeTokens("setup", {});
    const code = newSetupCode();
    this.#issueToken("setup", { ttlSec: SETUP_TTL_SEC, secret: code });
    this.#log.warn(`[setup] Open ${this.link("/setup")} and enter code ${code} (valid 24 h; ADMIN_TOKEN also works)`);
    return code;
  }

  setupInfo() {
    if (this.ownerExists()) return { needed: false as const };
    const p = this.merchants?.platformRow();
    const first = this.merchants?.merchants()[0];
    return {
      needed: true as const,
      platform_name: this.platformName(),
      payout_default: first && first.payout_set !== 0 ? first.payout : null,
      fee_wallet: p?.fee_recipient ?? null,
    };
  }

  /** Checks a setup code (or the admin token) without using it. */
  checkSetupCode(code: string): void {
    if (this.ownerExists()) throw new ApiError(409, "SETUP_DONE", "This server is already set up; sign in instead");
    if (safeEqual(code, this.settings.adminToken)) return;
    const norm = normalizeSetupCode(code);
    const row = this.#db.get<TokenRow>("SELECT * FROM auth_tokens WHERE kind = 'setup' AND token_hash = ?", sha256Hex(norm));
    if (!row || row.revoked_at || row.used_at) {
      this.#fail("setup_code");
      throw new ApiError(400, "SETUP_CODE_INVALID", "This setup code is not right; copy it from the server log");
    }
    if (row.expires_unix <= this.clock()) {
      this.ensureSetupCode();
      throw new ApiError(410, "SETUP_CODE_EXPIRED", "This setup code expired; a new one was printed to the server log");
    }
  }

  async completeSetup(b: { code: string; platform_name?: string; name: string; email: string; password: string }, client: Client): Promise<IssuedSession & { user: UserRow }> {
    this.checkSetupCode(b.code);
    this.checkPassword(b.password, b.email);
    const hash = await hashPassword(b.password, this.settings.scryptLogN);
    return this.#db.tx(() => {
      // Checked again inside the write lock: two racing setups cannot both create an owner (the unique index agrees).
      this.checkSetupCode(b.code);
      const existing = this.userByEmail(b.email);
      let user: UserRow;
      if (existing) {
        this.#db.run("UPDATE users SET platform_role = 'owner', password_hash = ?, name = ?, status = 'active', email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?", hash, b.name, nowIso(), nowIso(), existing.id);
        user = this.user(existing.id)!;
      } else {
        user = this.#insertUser({ email: b.email, name: b.name, hash, platformRole: "owner", verified: true });
      }
      if (b.platform_name && this.merchants?.platformRow()) this.merchants.updatePlatform({ name: b.platform_name });
      this.#db.run("UPDATE auth_tokens SET used_at = ? WHERE kind = 'setup' AND used_at IS NULL", nowIso());
      const usedRecovery = safeEqual(b.code, this.settings.adminToken);
      this.#audit.write({ type: usedRecovery ? "recovery_key" : "user", id: usedRecovery ? null : user.id, ip: client.ip }, "setup.completed", { target: user.id, meta: { email: user.email } });
      const s = this.#newSession(user, client, null);
      return { ...s, user };
    });
  }

  // ------------------------------------------------------------------ sessions

  #idleFor(user: UserRow): number {
    return user.platform_role ? this.settings.idlePlatformSec : this.settings.idleBusinessSec;
  }

  #newSession(user: UserRow, client: Client, from: SessionRow | null): IssuedSession {
    const token = newSecret();
    const now = this.clock();
    const id = newAuthId("ses");
    const expires = from ? from.expires_unix : now + this.settings.absoluteSec;
    this.#db.run(
      `INSERT INTO sessions (id, id_hash, user_id, csrf_token, created_unix, last_seen_unix, expires_unix, idle_expires_unix, step_up_unix, rotated_from, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sha256Hex(token),
      user.id,
      newSecret(),
      now,
      now,
      expires,
      Math.min(expires, now + this.#idleFor(user)),
      from ? from.step_up_unix : now,
      from?.id ?? null,
      client.ip,
      client.userAgent?.slice(0, 300) ?? null,
      nowIso(),
    );
    this.#db.run("UPDATE users SET last_active_at = ? WHERE id = ?", nowIso(), user.id);
    return { token, session: this.#db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id)! };
  }

  /**
   * The session behind a cookie value. Rotates it when it is older than rotateSec or a role or password change asked
   * for it (`rotated` carries the new cookie); the replaced token keeps working for rotateGraceSec.
   */
  resolveSession(token: string, client: Client): { ok: true; session: SessionRow; user: UserRow; rotated: IssuedSession | null } | { ok: false; reason: "missing" | "expired" | "revoked" } {
    const s = this.#db.get<SessionRow>("SELECT * FROM sessions WHERE id_hash = ?", sha256Hex(token));
    if (!s) return { ok: false, reason: "missing" };
    const now = this.clock();
    if (s.revoked_unix !== null && s.revoked_unix <= now) return { ok: false, reason: "revoked" };
    if (s.expires_unix <= now || s.idle_expires_unix <= now) return { ok: false, reason: "expired" };
    const user = this.user(s.user_id);
    if (!user || user.status === "disabled") return { ok: false, reason: "revoked" };
    // A token replaced by a rotation is still accepted during the grace period, but is not rotated again.
    if (s.revoked_unix !== null) return { ok: true, session: s, user, rotated: null };
    if (s.rotate_due === 1 || now - s.created_unix >= this.settings.rotateSec) {
      const rotated = this.#db.tx(() => this.#rotate(s, user, client));
      return { ok: true, session: rotated.session, user, rotated };
    }
    if (now - s.last_seen_unix >= TOUCH_EVERY_SEC) {
      this.#db.run("UPDATE sessions SET last_seen_unix = ?, idle_expires_unix = ? WHERE id = ?", now, Math.min(s.expires_unix, now + this.#idleFor(user)), s.id);
      this.#db.run("UPDATE users SET last_active_at = ? WHERE id = ?", nowIso(), user.id);
    }
    return { ok: true, session: s, user, rotated: null };
  }

  #rotate(old: SessionRow, user: UserRow, client: Client): IssuedSession {
    const next = this.#newSession(user, client, old);
    this.#db.run("UPDATE sessions SET revoked_unix = ? WHERE id = ? AND revoked_unix IS NULL", this.clock() + this.settings.rotateGraceSec, old.id);
    return next;
  }

  /** Asks every live session of a user to rotate on its next request (role or membership changed). */
  rotateSessionsOf(userId: string): void {
    this.#db.run("UPDATE sessions SET rotate_due = 1 WHERE user_id = ? AND revoked_unix IS NULL", userId);
  }

  revokeSession(sessionId: string): void {
    this.#db.run("UPDATE sessions SET revoked_unix = ? WHERE id = ? AND (revoked_unix IS NULL OR revoked_unix > ?)", this.clock(), sessionId, this.clock());
  }

  /** Ends every session of a user (except `exceptId`); returns how many. */
  revokeAll(userId: string, exceptId?: string): number {
    const now = this.clock();
    return this.#db.run(
      `UPDATE sessions SET revoked_unix = ? WHERE user_id = ? AND (revoked_unix IS NULL OR revoked_unix > ?) AND expires_unix > ? ${exceptId ? "AND id != ?" : ""}`,
      now,
      userId,
      now,
      now,
      ...(exceptId ? [exceptId] : []),
    ).changes;
  }

  sessionsOf(userId: string, currentId: string) {
    const now = this.clock();
    return this.#db
      .all<SessionRow>(
        "SELECT * FROM sessions WHERE user_id = ? AND (revoked_unix IS NULL OR revoked_unix > ?) AND expires_unix > ? AND idle_expires_unix > ? ORDER BY last_seen_unix DESC",
        userId,
        now,
        now,
        now,
      )
      .filter((s) => s.revoked_unix === null || s.id === currentId)
      .map((s) => ({
        id: s.id,
        current: s.id === currentId,
        created_at: new Date(s.created_unix * 1000).toISOString(),
        last_seen_at: new Date(s.last_seen_unix * 1000).toISOString(),
        expires_at: new Date(Math.min(s.expires_unix, s.idle_expires_unix) * 1000).toISOString(),
        ip: s.ip,
        user_agent: s.user_agent,
      }));
  }

  stepUpOk(s: SessionRow): boolean {
    return s.step_up_unix !== null && this.clock() - s.step_up_unix <= this.settings.stepUpSec;
  }

  async stepUp(user: UserRow, session: SessionRow, password: string): Promise<number> {
    const { ok } = await verifyPassword(password, user.password_hash, this.settings.scryptLogN);
    if (!ok) {
      this.#fail("step_up");
      throw new ApiError(401, "INVALID_CREDENTIALS", "Wrong password");
    }
    const now = this.clock();
    this.#db.run("UPDATE sessions SET step_up_unix = ? WHERE id = ?", now, session.id);
    return now + this.settings.stepUpSec;
  }

  // ------------------------------------------------------------------ sign-in with lockout

  async login(email: string, password: string, client: Client, current: SessionRow | null): Promise<IssuedSession & { user: UserRow }> {
    const user = this.userByEmail(email);
    const now = this.clock();
    const locked = !!user && user.locked_until_unix !== null && user.locked_until_unix > now;
    // Always one hash, so a locked or unknown account takes as long as a wrong password.
    const { ok, rehash } = await verifyPassword(password, user?.password_hash ?? null, this.settings.scryptLogN);
    if (!user || !ok || locked || user.status === "disabled") {
      this.#fail(!user ? "unknown_email" : locked ? "locked" : user.status === "disabled" ? "disabled" : "wrong_password");
      if (user && !locked && !ok) this.#recordFailure(user, client);
      else if (user) this.#db.tx(() => this.#audit.write({ type: "system", id: null, ip: client.ip }, "auth.sign_in_failed", { target: user.id, meta: { email: user.email, reason: locked ? "locked" : "disabled" } }));
      throw new ApiError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
    }
    const newHash = rehash ? await hashPassword(password, this.settings.scryptLogN) : null;
    return this.#db.tx(() => {
      this.#db.run(
        "UPDATE users SET failed_logins = 0, first_failed_unix = NULL, lock_count = 0, locked_until_unix = NULL, password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?",
        newHash,
        nowIso(),
        user.id,
      );
      // Rotation on sign-in: whatever session this browser had ends here.
      if (current) this.revokeSession(current.id);
      const s = this.#newSession(user, client, null);
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "auth.signed_in", { target: s.session.id, meta: { user_agent: client.userAgent?.slice(0, 120) ?? null } });
      return { ...s, user: this.user(user.id)! };
    });
  }

  #recordFailure(user: UserRow, client: Client) {
    this.#db.tx(() => {
      const now = this.clock();
      const cur = this.user(user.id)!;
      const fresh = cur.first_failed_unix === null || now - cur.first_failed_unix > LOCK_WINDOW_SEC;
      const failed = fresh ? 1 : cur.failed_logins + 1;
      this.#audit.write({ type: "system", id: null, ip: client.ip }, "auth.sign_in_failed", { target: user.id, meta: { email: user.email, reason: "wrong_password" } });
      if (failed >= LOCK_AFTER) {
        const lockSec = Math.min(LOCK_MAX_SEC, LOCK_BASE_SEC * 2 ** cur.lock_count);
        this.#db.run(
          "UPDATE users SET failed_logins = 0, first_failed_unix = NULL, lock_count = lock_count + 1, locked_until_unix = ?, updated_at = ? WHERE id = ?",
          now + lockSec,
          nowIso(),
          user.id,
        );
        this.#audit.write({ type: "system", id: null, ip: client.ip }, "auth.locked", { target: user.id, meta: { email: user.email, seconds: lockSec } });
        this.#log.warn("account locked after failed sign-ins", { userId: user.id, seconds: lockSec });
      } else {
        this.#db.run("UPDATE users SET failed_logins = ?, first_failed_unix = ?, updated_at = ? WHERE id = ?", failed, fresh ? now : cur.first_failed_unix, nowIso(), user.id);
      }
    });
  }

  logout(user: UserRow, session: SessionRow, client: Client): void {
    this.#db.tx(() => {
      this.revokeSession(session.id);
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "auth.signed_out", { target: session.id });
    });
  }

  logoutAll(user: UserRow, client: Client): number {
    return this.#db.tx(() => {
      const n = this.revokeAll(user.id);
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "auth.signed_out_everywhere", { target: user.id, meta: { count: n } });
      return n;
    });
  }

  async changePassword(user: UserRow, session: SessionRow, current: string, next: string, client: Client): Promise<IssuedSession> {
    const { ok } = await verifyPassword(current, user.password_hash, this.settings.scryptLogN);
    if (!ok) {
      this.#fail("wrong_password");
      throw new ApiError(401, "INVALID_CREDENTIALS", "Wrong current password");
    }
    this.checkPassword(next, user.email);
    const hash = await hashPassword(next, this.settings.scryptLogN);
    return this.#db.tx(() => {
      this.#db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", hash, nowIso(), user.id);
      this.revokeAll(user.id, session.id);
      const issued = this.#rotate(session, this.user(user.id)!, client);
      this.#db.run("UPDATE sessions SET step_up_unix = ? WHERE id = ?", this.clock(), issued.session.id);
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "auth.password_changed", { target: user.id });
      this.#mailer.queue(this.#passwordChangedEmail(user.email));
      return { ...issued, session: this.#db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", issued.session.id)! };
    });
  }

  #passwordChangedEmail(to: string) {
    return {
      to,
      kind: "password_changed" as const,
      subject: `Your ${this.platformName()} password was changed`,
      text: `The password of your ${this.platformName()} account was changed and every other session was signed out.\n\nIf this was not you, reset your password now: ${this.link("/forgot")}\n`,
    };
  }

  updateMe(user: UserRow, patch: { name?: string; last_business_id?: string | null }): UserRow {
    if (patch.last_business_id) {
      const visible = user.platform_role ? !!this.merchants?.maybeMerchant(patch.last_business_id) : !!this.membership(user.id, patch.last_business_id);
      if (!visible) throw new ApiError(404, "UNKNOWN_MERCHANT", "business not found");
    }
    this.#db.run(
      "UPDATE users SET name = COALESCE(?, name), last_business_id = CASE WHEN ? THEN ? ELSE last_business_id END, updated_at = ? WHERE id = ?",
      patch.name ?? null,
      patch.last_business_id !== undefined ? 1 : 0,
      patch.last_business_id ?? null,
      nowIso(),
      user.id,
    );
    return this.user(user.id)!;
  }

  // ------------------------------------------------------------------ email verification and reset

  #verifyEmail(user: UserRow, createdBy: string | null) {
    this.#revokeTokens("verify_email", { userId: user.id });
    const { secret } = this.#issueToken("verify_email", { userId: user.id, email: user.email, ttlSec: VERIFY_TTL_SEC, createdBy });
    const link = this.link(`/verify/${secret}`);
    this.#mailer.queue({
      to: user.email,
      kind: "verify_email",
      link,
      subject: `Confirm your email for ${this.platformName()}`,
      text: `Confirm your email address by opening this link (valid 48 hours):\n\n${link}\n\nIf you did not create this account, ignore this email.\n`,
    });
  }

  resendVerification(user: UserRow): void {
    if (user.email_verified_at) return;
    this.#db.tx(() => this.#verifyEmail(user, user.id));
  }

  verify(token: string, client: Client): { email: string; status: UserRow["status"] } {
    return this.#db.tx(() => {
      const row = this.#useToken("verify_email", token);
      const user = this.user(row.user_id!);
      if (!user) throw new ApiError(400, "TOKEN_INVALID", "This link is not valid");
      this.#db.run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?", nowIso(), nowIso(), user.id);
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "auth.email_verified", { target: user.id, meta: { email: user.email } });
      // Sign-up: the request becomes visible for approval, or (open mode) the business is created now.
      const req = this.#db.get<SignupRequestRow>("SELECT * FROM signup_requests WHERE user_id = ? AND status = 'unverified'", user.id);
      if (req) {
        if (this.signupMode() === "open") this.#approve(req, null, client);
        else {
          this.#db.run("UPDATE signup_requests SET status = 'pending' WHERE id = ?", req.id);
          this.#mailer.queue({
            to: user.email,
            kind: "signup_received",
            subject: `${this.platformName()}: your request is waiting for approval`,
            text: `Thanks for verifying your email. The platform owner will review your request for ${req.business_name}; you will get an email when it is decided.\n`,
          });
        }
      }
      return { email: user.email, status: this.user(user.id)!.status };
    });
  }

  /** Always succeeds from the caller's view; sends a link only to an existing, enabled account. */
  forgot(email: string, client: Client): void {
    const user = this.userByEmail(email);
    if (!user || user.status === "disabled") return;
    this.#db.tx(() => {
      this.#revokeTokens("reset_password", { userId: user.id });
      const { secret } = this.#issueToken("reset_password", { userId: user.id, email: user.email, ttlSec: RESET_TTL_SEC });
      const link = this.link(`/reset/${secret}`);
      this.#mailer.queue({
        to: user.email,
        kind: "reset_password",
        link,
        subject: `Reset your ${this.platformName()} password`,
        text: `Open this link to choose a new password (valid 30 minutes):\n\n${link}\n\nIf you did not ask for this, ignore this email; your password stays the same.\n`,
      });
      this.#audit.write({ type: "system", id: null, ip: client.ip }, "auth.reset_requested", { target: user.id, meta: { email: user.email } });
    });
  }

  checkReset(token: string): { email: string } {
    const { row, state } = this.peekToken("reset_password", token);
    if (state === "used" || state === "revoked") throw new ApiError(409, "TOKEN_USED", "This link was already used or replaced");
    if (state === "expired") throw new ApiError(410, "TOKEN_EXPIRED", "This link has expired");
    return { email: row.email ?? "" };
  }

  async reset(token: string, password: string, client: Client): Promise<void> {
    const { row } = this.peekToken("reset_password", token);
    this.checkPassword(password, row.email ?? "");
    const hash = await hashPassword(password, this.settings.scryptLogN);
    this.#db.tx(() => {
      const used = this.#useToken("reset_password", token);
      const user = this.user(used.user_id!);
      if (!user) throw new ApiError(400, "TOKEN_INVALID", "This link is not valid");
      // The link proves the inbox, so the email counts as verified; the lock is cleared with the new password.
      this.#db.run(
        "UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), failed_logins = 0, first_failed_unix = NULL, lock_count = 0, locked_until_unix = NULL, updated_at = ? WHERE id = ?",
        hash,
        nowIso(),
        nowIso(),
        user.id,
      );
      this.revokeAll(user.id);
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "auth.password_reset", { target: user.id, meta: { email: user.email } });
      this.#mailer.queue(this.#passwordChangedEmail(user.email));
    });
  }

  /** The `account reset-owner` CLI: a one-time reset link for the owner, printed on the server itself. */
  ownerResetLink(email: string): string {
    const user = this.userByEmail(email);
    if (!user || user.platform_role !== "owner") throw new Error(`no platform owner with email ${email}`);
    return this.#db.tx(() => {
      this.#revokeTokens("reset_password", { userId: user.id });
      const { secret } = this.#issueToken("reset_password", { userId: user.id, email: user.email, ttlSec: RESET_TTL_SEC, createdBy: "cli" });
      this.#audit.write({ type: "system", id: null }, "auth.reset_requested", { target: user.id, meta: { email: user.email, via: "cli" } });
      return this.link(`/reset/${secret}`);
    });
  }

  // ------------------------------------------------------------------ sign-up

  signupMode(): "off" | "approval" | "open" {
    return this.merchants?.platformRow()?.signup_mode ?? "off";
  }

  async signup(b: { email: string; password: string; name: string; business_name: string }, client: Client): Promise<void> {
    if (this.signupMode() === "off" || !this.merchants) throw new ApiError(403, "SIGNUP_DISABLED", "Sign-up is off on this server; ask the platform owner for an invite");
    this.checkPassword(b.password, b.email);
    const existing = this.userByEmail(b.email);
    if (existing) {
      // Same answer as a new account; the inbox owner learns they already have one.
      this.#db.tx(() =>
        this.#mailer.queue({
          to: existing.email,
          kind: "account_exists",
          subject: `You already have a ${this.platformName()} account`,
          text: `Someone tried to create an account with this email. You already have one: sign in at ${this.link("/login")} or reset your password at ${this.link("/forgot")}.\n`,
        }),
      );
      await hashPassword(b.password, this.settings.scryptLogN);
      return;
    }
    const hash = await hashPassword(b.password, this.settings.scryptLogN);
    this.#db.tx(() => {
      if (this.userByEmail(b.email)) return;
      const user = this.#insertUser({ email: b.email, name: b.name, hash, status: "pending" });
      const id = newAuthId("sur");
      this.#db.run("INSERT INTO signup_requests (id, user_id, business_name, status, created_at) VALUES (?, ?, ?, 'unverified', ?)", id, user.id, b.business_name, nowIso());
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "signup.requested", { target: id, meta: { email: user.email, business_name: b.business_name } });
      this.#verifyEmail(user, null);
    });
  }

  signupRequest(id: string): SignupRequestRow {
    const r = this.#db.get<SignupRequestRow>("SELECT * FROM signup_requests WHERE id = ?", id);
    if (!r) throw new ApiError(404, "NOT_FOUND", "sign-up request not found");
    return r;
  }

  latestSignupRequest(userId: string): SignupRequestRow | undefined {
    return this.#db.get<SignupRequestRow>("SELECT * FROM signup_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", userId);
  }

  signupRequestJson(r: SignupRequestRow) {
    const u = this.user(r.user_id);
    return {
      id: r.id,
      status: r.status,
      business_name: r.business_name,
      user: u ? { id: u.id, email: u.email, name: u.name, email_verified: !!u.email_verified_at } : null,
      merchant_id: r.merchant_id,
      reason: r.reason,
      created_at: r.created_at,
      decided_at: r.decided_at,
      decided_by: r.decided_by,
    };
  }

  signupRequests(status: "pending" | "approved" | "declined" | "all") {
    const rows = this.#db.all<SignupRequestRow>(
      `SELECT * FROM signup_requests ${status === "all" ? "WHERE status != 'unverified'" : "WHERE status = ?"} ORDER BY created_at DESC LIMIT 500`,
      ...(status === "all" ? [] : [status]),
    );
    const pending = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signup_requests WHERE status = 'pending'")!.n;
    return { items: rows.map((r) => this.signupRequestJson(r)), counts: { pending } };
  }

  #approve(req: SignupRequestRow, by: AuditActor | null, client: Client) {
    if (!this.merchants) throw new ApiError(409, "GATEWAY_DISABLED", "businesses need the gateway");
    const user = this.user(req.user_id)!;
    const m = this.merchants.create({ name: req.business_name, payout: zeroAddress, payoutUnset: true, signature: null, signedAt: null, support_email: user.email });
    this.#db.run("INSERT INTO memberships (user_id, merchant_id, role, created_at) VALUES (?, ?, 'admin', ?)", user.id, m.id, nowIso());
    this.#db.run("UPDATE users SET status = 'active', last_business_id = ?, updated_at = ? WHERE id = ?", m.id, nowIso(), user.id);
    this.#db.run("UPDATE signup_requests SET status = 'approved', merchant_id = ?, decided_at = ?, decided_by = ? WHERE id = ?", m.id, nowIso(), by?.id ?? "system", req.id);
    this.rotateSessionsOf(user.id);
    const actor = by ?? { type: "system" as const, id: null, ip: client.ip };
    this.#audit.write(actor, "business.created", { merchantId: m.id, target: m.id, meta: { name: m.name, via: "signup" } });
    this.#audit.write(actor, "signup.approved", { merchantId: m.id, target: req.id, meta: { business_name: req.business_name, email: user.email } });
    this.#mailer.queue({
      to: user.email,
      kind: "signup_approved",
      subject: `${req.business_name} is ready on ${this.platformName()}`,
      text: `Your business ${req.business_name} was approved. Sign in at ${this.link("/login")} and set your payout wallet to start taking payments.\n`,
    });
  }

  approveSignup(id: string, by: AuditActor, client: Client) {
    return this.#db.tx(() => {
      const req = this.signupRequest(id);
      if (req.status !== "pending") throw new ApiError(409, "SIGNUP_NOT_PENDING", `this request is ${req.status}`);
      this.#approve(req, by, client);
      return this.signupRequestJson(this.signupRequest(id));
    });
  }

  declineSignup(id: string, reason: string | null, by: AuditActor) {
    return this.#db.tx(() => {
      const req = this.signupRequest(id);
      if (req.status !== "pending") throw new ApiError(409, "SIGNUP_NOT_PENDING", `this request is ${req.status}`);
      this.#db.run("UPDATE signup_requests SET status = 'declined', reason = ?, decided_at = ?, decided_by = ? WHERE id = ?", reason, nowIso(), by.id ?? by.type, id);
      const user = this.user(req.user_id)!;
      this.#audit.write(by, "signup.declined", { target: id, meta: { business_name: req.business_name, email: user.email, reason } });
      this.#mailer.queue({
        to: user.email,
        kind: "signup_declined",
        subject: `${this.platformName()}: your request was declined`,
        text: `Your request for ${req.business_name} was declined.${reason ? `\n\nReason: ${reason}` : ""}\n`,
      });
      return this.signupRequestJson(this.signupRequest(id));
    });
  }

  // ------------------------------------------------------------------ invites and members

  #inviteJson(r: TokenRow, link?: string) {
    const by = r.created_by ? this.user(r.created_by) : undefined;
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      merchant_id: r.merchant_id,
      status: r.revoked_at ? "revoked" : r.used_at ? "used" : r.expires_unix <= this.clock() ? "expired" : "pending",
      expires_at: new Date(r.expires_unix * 1000).toISOString(),
      created_at: r.created_at,
      invited_by: by ? { id: by.id, email: by.email, name: by.name } : null,
      ...(link ? { link } : {}),
    };
  }

  invites(merchantId: string | null) {
    const rows = this.#db.all<TokenRow>(
      `SELECT * FROM auth_tokens WHERE kind = 'invite' AND used_at IS NULL AND revoked_at IS NULL AND ${merchantId ? "merchant_id = ?" : "merchant_id IS NULL"} ORDER BY created_at DESC`,
      ...(merchantId ? [merchantId] : []),
    );
    return { items: rows.map((r) => this.#inviteJson(r)) };
  }

  invite(merchantId: string | null, emails: string[], role: InviteRole, by: AuditActor & { userId: string | null }) {
    if ((role === "platform_admin") !== (merchantId === null)) throw new ApiError(400, "VALIDATION_ERROR", "platform_admin invites are for the platform; business roles need a business");
    const business = merchantId ? this.merchants?.merchant(merchantId) : null;
    return this.#db.tx(() => {
      const items: Array<Record<string, unknown>> = [];
      for (const raw of [...new Set(emails.map(lowerEmail))]) {
        const existing = this.userByEmail(raw);
        if (existing && (merchantId ? this.membership(existing.id, merchantId) : existing.platform_role)) {
          items.push({ email: raw, error: { code: "ALREADY_MEMBER", message: `${raw} already has access` } });
          continue;
        }
        // Inviting again replaces the earlier pending link.
        this.#revokeTokens("invite", { email: raw, merchantId });
        const { row, secret } = this.#issueToken("invite", { email: raw, merchantId, role, ttlSec: INVITE_TTL_SEC, createdBy: by.userId });
        const link = this.link(`/invite/${secret}`);
        const where = business ? business.name : `the ${this.platformName()} platform team`;
        this.#mailer.queue({
          to: raw,
          kind: "invite",
          link,
          subject: `You are invited to ${where}`,
          text: `You were invited to ${where} on ${this.platformName()} as ${role === "platform_admin" ? "platform admin" : role}.\n\nAccept within 7 days:\n\n${link}\n`,
        });
        this.#audit.write(by, "invite.sent", { merchantId, target: row.id, meta: { email: raw, role } });
        items.push(this.#inviteJson(row, link));
      }
      return { items };
    });
  }

  inviteRow(id: string): TokenRow {
    const r = this.#db.get<TokenRow>("SELECT * FROM auth_tokens WHERE id = ? AND kind = 'invite'", id);
    if (!r) throw new ApiError(404, "NOT_FOUND", "invite not found");
    return r;
  }

  resendInvite(id: string, by: AuditActor & { userId: string | null }) {
    const r = this.inviteRow(id);
    if (r.used_at) throw new ApiError(409, "TOKEN_USED", "this invite was already accepted");
    const out = this.invite(r.merchant_id, [r.email!], r.role as InviteRole, by);
    return out.items[0]!;
  }

  revokeInvite(id: string, by: AuditActor) {
    return this.#db.tx(() => {
      const r = this.inviteRow(id);
      this.#db.run("UPDATE auth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", nowIso(), id);
      this.#audit.write(by, "invite.revoked", { merchantId: r.merchant_id, target: id, meta: { email: r.email } });
      return { id, revoked: true };
    });
  }

  lookupInvite(token: string, signedIn: UserRow | null) {
    const { row, state } = this.peekToken("invite", token);
    const business = row.merchant_id ? this.merchants?.maybeMerchant(row.merchant_id) : null;
    return {
      email: row.email,
      role: row.role,
      business_name: business?.name ?? null,
      platform: row.merchant_id === null,
      status: state === "valid" ? "pending" : state,
      user_exists: !!this.userByEmail(row.email ?? ""),
      signed_in_as: signedIn?.email ?? null,
    };
  }

  async acceptInvite(
    b: { token: string; name?: string; password?: string },
    signedIn: { user: UserRow; session: SessionRow } | null,
    client: Client,
  ): Promise<{ user: UserRow; issued: IssuedSession | null }> {
    const { row, state } = this.peekToken("invite", b.token);
    if (state === "used" || state === "revoked") throw new ApiError(409, "TOKEN_USED", "This invite was already used or revoked");
    if (state === "expired") throw new ApiError(410, "TOKEN_EXPIRED", "This invite has expired; ask for a new one");
    const email = row.email!;
    const existing = this.userByEmail(email);
    let hash: string | null = null;
    if (existing) {
      if (!signedIn) throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in as the invited email to accept");
      if (signedIn.user.id !== existing.id) throw new ApiError(409, "WRONG_ACCOUNT", `This invite is for ${email}; you are signed in as ${signedIn.user.email}`);
    } else {
      if (!b.name || !b.password) throw new ApiError(400, "VALIDATION_ERROR", "name and password are required to create the account", { issues: [{ path: !b.name ? "name" : "password", message: "required" }] });
      this.checkPassword(b.password, email);
      hash = await hashPassword(b.password, this.settings.scryptLogN);
    }
    return this.#db.tx(() => {
      const used = this.#useToken("invite", b.token);
      let user = this.userByEmail(email);
      if (!user) user = this.#insertUser({ email, name: b.name!, hash, verified: true });
      else this.#db.run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?", nowIso(), nowIso(), user.id);
      if (used.merchant_id) {
        if (!this.membership(user.id, used.merchant_id)) {
          this.#db.run("INSERT INTO memberships (user_id, merchant_id, role, created_at) VALUES (?, ?, ?, ?)", user.id, used.merchant_id, used.role, nowIso());
        }
        this.#db.run("UPDATE users SET last_business_id = ? WHERE id = ?", used.merchant_id, user.id);
      } else if (user.platform_role !== "owner") {
        this.#db.run("UPDATE users SET platform_role = 'admin', updated_at = ? WHERE id = ?", nowIso(), user.id);
      }
      user = this.user(user.id)!;
      this.#audit.write({ type: "user", id: user.id, ip: client.ip }, "invite.accepted", { merchantId: used.merchant_id, target: used.id, meta: { email, role: used.role } });
      // A new account is signed in; an existing one gets a fresh token for its new role.
      const issued = signedIn ? this.#rotate(signedIn.session, user, client) : this.#newSession(user, client, null);
      return { user, issued };
    });
  }

  members(merchantId: string) {
    return {
      items: this.#db
        .all<MembershipRow & { email: string; name: string; status: string; email_verified_at: string | null; last_active_at: string | null }>(
          `SELECT m.*, u.email, u.name, u.status, u.email_verified_at, u.last_active_at FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.merchant_id = ? ORDER BY m.created_at, u.email`,
          merchantId,
        )
        .map((r) => ({ user_id: r.user_id, email: r.email, name: r.name, role: r.role, status: r.status, email_verified: !!r.email_verified_at, joined_at: r.created_at, last_active_at: r.last_active_at })),
    };
  }

  #adminCount(merchantId: string): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.merchant_id = ? AND m.role = 'admin' AND u.status != 'disabled'", merchantId)!.n;
  }

  setMemberRole(merchantId: string, userId: string, role: BusinessRole, by: AuditActor) {
    return this.#db.tx(() => {
      const m = this.membership(userId, merchantId);
      if (!m) throw new ApiError(404, "NOT_FOUND", "member not found");
      if (m.role === "admin" && role !== "admin" && this.#adminCount(merchantId) <= 1) throw new ApiError(409, "LAST_ADMIN", "a business needs at least one Admin");
      this.#db.run("UPDATE memberships SET role = ? WHERE user_id = ? AND merchant_id = ?", role, userId, merchantId);
      this.rotateSessionsOf(userId);
      this.#audit.write(by, "member.role_changed", { merchantId, target: userId, meta: { email: this.user(userId)?.email, role, from: m.role } });
      return this.members(merchantId).items.find((x) => x.user_id === userId)!;
    });
  }

  removeMember(merchantId: string, userId: string, by: AuditActor) {
    return this.#db.tx(() => {
      const m = this.membership(userId, merchantId);
      if (!m) throw new ApiError(404, "NOT_FOUND", "member not found");
      if (m.role === "admin" && this.#adminCount(merchantId) <= 1) throw new ApiError(409, "LAST_ADMIN", "a business needs at least one Admin");
      this.#db.run("DELETE FROM memberships WHERE user_id = ? AND merchant_id = ?", userId, merchantId);
      this.#db.run("UPDATE users SET last_business_id = NULL WHERE id = ? AND last_business_id = ?", userId, merchantId);
      this.rotateSessionsOf(userId);
      this.#audit.write(by, "member.removed", { merchantId, target: userId, meta: { email: this.user(userId)?.email } });
      return { user_id: userId, removed: true };
    });
  }

  /** Adds an existing or new user to a business directly (demo seeding and tests); no email. */
  async addMember(merchantId: string, u: { email: string; name: string; password: string }, role: BusinessRole, by: AuditActor): Promise<UserRow> {
    this.checkPassword(u.password, u.email);
    const hash = await hashPassword(u.password, this.settings.scryptLogN);
    return this.#db.tx(() => {
      const user = this.userByEmail(u.email) ?? this.#insertUser({ email: u.email, name: u.name, hash, verified: true });
      if (!this.membership(user.id, merchantId)) this.#db.run("INSERT INTO memberships (user_id, merchant_id, role, created_at) VALUES (?, ?, ?, ?)", user.id, merchantId, role, nowIso());
      this.#audit.write(by, "invite.accepted", { merchantId, target: user.id, meta: { email: user.email, role, direct: true } });
      return user;
    });
  }

  // ------------------------------------------------------------------ platform team and users

  #userJson(u: UserRow) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      platform_role: u.platform_role,
      email_verified: !!u.email_verified_at,
      locked_until: u.locked_until_unix && u.locked_until_unix > this.clock() ? new Date(u.locked_until_unix * 1000).toISOString() : null,
      memberships: this.memberships(u.id).map((m) => ({ merchant_id: m.merchant_id, business_name: m.business_name, role: m.role })),
      created_at: u.created_at,
      last_active_at: u.last_active_at,
    };
  }

  team() {
    return {
      items: this.#db
        .all<UserRow>("SELECT * FROM users WHERE platform_role IS NOT NULL ORDER BY CASE platform_role WHEN 'owner' THEN 0 ELSE 1 END, email")
        .map((u) => ({ user_id: u.id, email: u.email, name: u.name, platform_role: u.platform_role, status: u.status, last_active_at: u.last_active_at })),
    };
  }

  users(q: string | undefined, limit: number, cursor?: number) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q) (where.push("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"), params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`, `%${q.replace(/[\\%_]/g, "\\$&")}%`));
    if (cursor !== undefined) (where.push("rowid < ?"), params.push(cursor));
    const rows = this.#db.all<UserRow & { rid: number }>(`SELECT rowid AS rid, * FROM users ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`, ...params, limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map((u) => this.#userJson(u)), next_cursor: rows.length > limit && page.length ? String(page[page.length - 1]!.rid) : null };
  }

  #target(userId: string): UserRow {
    const u = this.user(userId);
    if (!u) throw new ApiError(404, "NOT_FOUND", "user not found");
    return u;
  }

  setPlatformRole(userId: string, role: "admin" | null, by: AuditActor) {
    return this.#db.tx(() => {
      const u = this.#target(userId);
      if (u.platform_role === "owner") throw new ApiError(409, "OWNER_PROTECTED", "the platform owner's role cannot be changed");
      this.#db.run("UPDATE users SET platform_role = ?, updated_at = ? WHERE id = ?", role, nowIso(), userId);
      this.rotateSessionsOf(userId);
      this.#audit.write(by, "platform_role.changed", { target: userId, meta: { email: u.email, role, from: u.platform_role } });
      return this.#userJson(this.user(userId)!);
    });
  }

  setUserStatus(userId: string, status: "active" | "disabled", by: AuditActor) {
    return this.#db.tx(() => {
      const u = this.#target(userId);
      if (u.platform_role === "owner") throw new ApiError(409, "OWNER_PROTECTED", "the platform owner cannot be disabled");
      this.#db.run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), userId);
      if (status === "disabled") this.revokeAll(userId);
      this.#audit.write(by, status === "disabled" ? "user.disabled" : "user.enabled", { target: userId, meta: { email: u.email } });
      return this.#userJson(this.user(userId)!);
    });
  }

  unlock(userId: string, by: AuditActor) {
    return this.#db.tx(() => {
      const u = this.#target(userId);
      this.#db.run("UPDATE users SET failed_logins = 0, first_failed_unix = NULL, lock_count = 0, locked_until_unix = NULL, updated_at = ? WHERE id = ?", nowIso(), userId);
      this.#audit.write(by, "user.unlocked", { target: userId, meta: { email: u.email } });
      return this.#userJson(this.user(userId)!);
    });
  }

  revokeUserSessions(userId: string, by: AuditActor) {
    return this.#db.tx(() => {
      const u = this.#target(userId);
      const n = this.revokeAll(userId);
      this.#audit.write(by, "session.revoked", { target: userId, meta: { email: u.email, count: n } });
      return { revoked: n };
    });
  }

  // ------------------------------------------------------------------ permissions and the session object

  /** Business permissions of a user on one business (empty when none). */
  businessPermissions(user: UserRow, merchantId: string): readonly string[] {
    if (user.status !== "active") return [];
    if (user.platform_role) return PLATFORM_ROLE_BUSINESS_PERMISSIONS[user.platform_role];
    const m = this.membership(user.id, merchantId);
    return m ? BUSINESS_ROLE_PERMISSIONS[m.role] : [];
  }

  platformPermissions(user: UserRow): readonly string[] {
    if (user.status !== "active" || !user.platform_role) return [];
    return PLATFORM_ROLE_PERMISSIONS[user.platform_role];
  }

  #platformInfo() {
    const p = this.merchants?.platformRow();
    return {
      name: this.platformName(),
      signup_mode: p?.signup_mode ?? "off",
      smtp_configured: this.#mailer.configured,
      recovery_key_enabled: this.settings.breakGlass && this.ownerExists(),
      agent_budgets_for_businesses: p?.agent_budgets_for_businesses === 1,
    };
  }

  sessionJson(user: UserRow, session: SessionRow) {
    const memberships = this.memberships(user.id);
    const businesses: Record<string, readonly string[]> = {};
    if (user.platform_role && user.status === "active") businesses["*"] = PLATFORM_ROLE_BUSINESS_PERMISSIONS[user.platform_role];
    else if (user.status === "active") for (const m of memberships) businesses[m.merchant_id] = BUSINESS_ROLE_PERMISSIONS[m.role];
    const signup = user.status === "pending" ? this.latestSignupRequest(user.id) : undefined;
    return {
      actor_type: "user" as const,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        email_verified: !!user.email_verified_at,
        status: user.status,
        platform_role: user.platform_role,
        last_business_id: user.last_business_id,
        created_at: user.created_at,
      },
      memberships: memberships.map((m) => ({ merchant_id: m.merchant_id, business_name: m.business_name, business_slug: m.business_slug, business_status: m.business_status, role: m.role, created_at: m.created_at })),
      permissions: { platform: this.platformPermissions(user), businesses },
      csrf_token: session.csrf_token,
      session: {
        id: session.id,
        created_at: new Date(session.created_unix * 1000).toISOString(),
        expires_at: new Date(session.expires_unix * 1000).toISOString(),
        idle_expires_at: new Date(session.idle_expires_unix * 1000).toISOString(),
        step_up_until: session.step_up_unix !== null ? new Date((session.step_up_unix + this.settings.stepUpSec) * 1000).toISOString() : null,
      },
      signup_request: signup ? { id: signup.id, status: signup.status, business_name: signup.business_name, reason: signup.reason } : null,
      platform: this.#platformInfo(),
    };
  }

  recoverySessionJson() {
    return {
      actor_type: "recovery_key" as const,
      user: null,
      memberships: [],
      permissions: { platform: PLATFORM_PERMISSIONS, businesses: { "*": BUSINESS_PERMISSIONS } },
      csrf_token: null,
      session: null,
      signup_request: null,
      platform: this.#platformInfo(),
    };
  }
}
