import type { Database } from "../db/database.ts";

export type AuditActorType = "user" | "api_key" | "recovery_key" | "system";
export type AuditActor = { type: AuditActorType; id: string | null; ip?: string | null };

export type AuditRow = {
  id: number;
  at: string;
  at_unix: number;
  actor_type: AuditActorType;
  actor_id: string | null;
  merchant_id: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  meta_json: string;
};

export type AuditFilter = {
  merchantIds?: readonly string[] | null;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: number;
};

const short = (a: unknown) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}...${a.slice(-2)}` : String(a ?? ""));

/**
 * The activity log (PRODUCT.md 4.11). `write` joins the caller's transaction, so a change and its record commit
 * together. Rows are append-only (a trigger refuses updates, and deletes of rows younger than a year).
 */
export class AuditLog {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  write(actor: AuditActor, action: string, o: { merchantId?: string | null; target?: string | null; meta?: Record<string, unknown> } = {}): void {
    const now = Date.now();
    this.#db.run(
      "INSERT INTO audit_events (at, at_unix, actor_type, actor_id, merchant_id, action, target, ip, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      new Date(now).toISOString(),
      Math.floor(now / 1000),
      actor.type,
      actor.id,
      o.merchantId ?? null,
      action,
      o.target ?? null,
      actor.ip ?? null,
      JSON.stringify(o.meta ?? {}),
    );
  }

  list(f: AuditFilter) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (f.merchantIds) (where.push(`a.merchant_id IN (${f.merchantIds.map(() => "?").join(", ") || "NULL"})`), params.push(...f.merchantIds));
    if (f.actorId) (where.push("a.actor_id = ?"), params.push(f.actorId));
    if (f.action) {
      if (f.action.endsWith(".")) (where.push("a.action >= ? AND a.action < ?"), params.push(f.action, f.action.slice(0, -1) + "/"));
      else (where.push("a.action = ?"), params.push(f.action));
    }
    if (f.from) (where.push("a.at >= ?"), params.push(new Date(f.from).toISOString()));
    if (f.to) (where.push("a.at <= ?"), params.push(new Date(f.to).toISOString()));
    if (f.cursor !== undefined) (where.push("a.id < ?"), params.push(f.cursor));
    const rows = this.#db.all<AuditRow & { email: string | null; name: string | null }>(
      `SELECT a.*, u.email, u.name FROM audit_events a LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ?`,
      ...params,
      f.limit + 1,
    );
    const page = rows.slice(0, f.limit);
    return {
      items: page.map((r) => {
        const meta = JSON.parse(r.meta_json) as Record<string, unknown>;
        const actor = { type: r.actor_type, id: r.actor_id, email: r.email, name: r.name };
        return { id: r.id, at: r.at, actor, merchant_id: r.merchant_id, action: r.action, target: r.target, summary: summarize(actor, r.action, r.target, meta), ip: r.ip, meta };
      }),
      next_cursor: rows.length > f.limit && page.length ? String(page[page.length - 1]!.id) : null,
    };
  }

  csv(f: Omit<AuditFilter, "limit" | "cursor">): string {
    const { items } = this.list({ ...f, limit: 10_000 });
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
      // Neutralize spreadsheet formulas, then quote.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const lines = [["id", "at", "actor_type", "actor_id", "actor_email", "merchant_id", "action", "target", "summary", "ip", "meta"].join(",")];
    for (const i of items) lines.push([i.id, i.at, i.actor.type, i.actor.id, i.actor.email, i.merchant_id, i.action, i.target, i.summary, i.ip, i.meta].map(esc).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  /** Last write time of an action for a target, for throttled records (recovery key reads). */
  lastAt(action: string, target: string): number | null {
    return this.#db.get<{ t: number }>("SELECT at_unix AS t FROM audit_events WHERE action = ? AND target = ? ORDER BY id DESC LIMIT 1", action, target)?.t ?? null;
  }
}

/** One plain sentence per action for the Activity log page. */
export function summarize(actor: { type: AuditActorType; id: string | null; email: string | null; name: string | null }, action: string, target: string | null, meta: Record<string, unknown>): string {
  const who =
    actor.type === "user" ? actor.name || actor.email || "Someone" : actor.type === "api_key" ? `API key ${actor.id ?? ""}`.trim() : actor.type === "recovery_key" ? "The recovery key" : "Payminto";
  const m = (k: string) => (meta[k] === undefined || meta[k] === null ? "" : String(meta[k]));
  switch (action) {
    case "setup.completed":
      return `${who} set up this server`;
    case "auth.signed_in":
      return `${who} signed in`;
    case "auth.sign_in_failed":
      return `Failed sign-in for ${m("email") || "an account"}`;
    case "auth.locked":
      return `${m("email") || "An account"} was locked after repeated failed sign-ins`;
    case "auth.signed_out":
      return `${who} signed out`;
    case "auth.signed_out_everywhere":
      return `${who} signed out everywhere`;
    case "auth.password_changed":
      return `${who} changed their password`;
    case "auth.reset_requested":
      return `Password reset requested for ${m("email")}`;
    case "auth.password_reset":
      return `${m("email") || who} reset their password`;
    case "auth.email_verified":
      return `${m("email") || who} verified their email`;
    case "session.revoked":
      return `${who} ended ${m("count") || "a"} session(s)`;
    case "invite.sent":
      return `${who} invited ${m("email")} as ${m("role")}`;
    case "invite.accepted":
      return `${m("email") || who} accepted an invite as ${m("role")}`;
    case "invite.revoked":
      return `${who} revoked the invite for ${m("email")}`;
    case "member.role_changed":
      return `${who} changed ${m("email")} to ${m("role")}`;
    case "member.removed":
      return `${who} removed ${m("email")}`;
    case "platform_role.changed":
      return `${who} changed the platform role of ${m("email")} to ${m("role") || "none"}`;
    case "user.disabled":
      return `${who} disabled ${m("email")}`;
    case "user.enabled":
      return `${who} enabled ${m("email")}`;
    case "user.unlocked":
      return `${who} unlocked ${m("email")}`;
    case "signup.requested":
      return `${m("email")} asked to create ${m("business_name")}`;
    case "signup.approved":
      return `${who} approved ${m("business_name")}`;
    case "signup.declined":
      return `${who} declined ${m("business_name")}`;
    case "business.created":
      return `${who} added the business ${m("name")}`;
    case "business.updated":
      return `${who} updated the business ${m("name") || target || ""}`.trim();
    case "business.suspended":
      return `${who} suspended the business ${m("name") || target || ""}`.trim();
    case "payout.changed":
      return `${who} changed the payout account to ${short(meta.to)}`;
    case "pricing.changed":
      return `${who} changed pricing (${m("what") || target || ""})`;
    case "platform.updated":
      return `${who} updated platform settings`;
    case "api_key.created":
      return `${who} created an API key ${m("prefix")}`.trim();
    case "api_key.revoked":
      return `${who} revoked an API key ${target ?? ""}`.trim();
    case "webhook.created":
      return `${who} added a webhook to ${m("url")}`;
    case "webhook.deleted":
      return `${who} deleted a webhook`;
    case "refund.requested":
      return `${who} requested a refund on ${m("payment_id")}`;
    case "refund.approved":
      return `${who} approved a refund on ${m("payment_id")}`;
    case "refund.issued":
      return `${who} issued a refund on ${m("payment_id")}`;
    case "settlement.run":
      return `${who} ran a settlement`;
    case "payout.run":
      return `${who} ran a payout of hub credit`;
    case "recovery_key.used":
      return `The recovery key was used: ${target ?? ""}`.trim();
    case "outbox.viewed":
      return `${who} viewed the email outbox`;
    case "payee.approved":
      return `${who} approved the payee ${m("payee")} for a Budget`;
    case "payee.denied":
      return `${who} denied the payee ${m("payee")} for a Budget`;
    case "payee.approval_withdrawn":
      return `${who} withdrew the decision about the payee ${m("payee")}`;
    case "payee.block_overridden":
      return `${who} approved the payee ${m("payee")} although the payee check blocks it`;
    case "payee.reported":
      return `${who} reported the account ${m("account")}`;
    default:
      return `${who}: ${action}`;
  }
}
