import { newLinkId, newLinkSlug } from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { nowIso } from "../store.ts";
import { linkJson, type LinkRow, type ModelContext } from "./model.ts";

export type CreateLinkInput = {
  title: string;
  description?: string | null;
  amount?: bigint | null;
  min_amount?: bigint | null;
  max_amount?: bigint | null;
  collect_email?: boolean;
  collect_name?: boolean;
  success_url?: string | null;
  max_payments?: number | null;
  listed?: boolean;
  expires_at?: string | null;
  created_by?: string | null;
};

/** A link expiry must be at least this far ahead when it is set. */
export const LINK_EXPIRY_MIN_LEAD_SEC = 60;

function checkExpiry(expiresAt: string | null | undefined): void {
  if (!expiresAt) return;
  if (Date.parse(expiresAt) < Date.now() + LINK_EXPIRY_MIN_LEAD_SEC * 1000) {
    throw new ApiError(400, "VALIDATION_ERROR", `expires_at must be at least ${LINK_EXPIRY_MIN_LEAD_SEC} s in the future`);
  }
}

/** Payment links (GATEWAY.md section 5): a fixed amount, or a payer-chosen amount between min and max. */
export class LinkService {
  readonly #db: Database;
  readonly #ctx: ModelContext;

  constructor(db: Database, ctx: ModelContext) {
    this.#db = db;
    this.#ctx = ctx;
  }

  counters(id: string) {
    const r = this.#db.get<{ n: number; paid: string }>(
      "SELECT COUNT(*) AS n, bigsum(CASE WHEN status IN ('paid', 'overpaid', 'underpaid') THEN amount_paid END) AS paid FROM payments WHERE link_id = ? AND draft = 0",
      id,
    )!;
    return { payments_count: r.n, paid_total: r.paid };
  }

  /**
   * Payments that count against max_payments: those money has reached. Open payments do not, so agent payment attempts
   * (each creates a short-lived draft payment) cannot use up a link.
   */
  usedSlots(id: string): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payments WHERE link_id = ? AND status NOT IN ('open', 'expired', 'canceled')", id)!.n;
  }

  json(r: LinkRow) {
    return linkJson(r, this.#ctx, this.counters(r.id));
  }

  create(merchantId: string, b: CreateLinkInput): LinkRow {
    const fixed = b.amount ?? null;
    const min = b.min_amount ?? null;
    const max = b.max_amount ?? null;
    if (fixed !== null) {
      if (fixed <= 0n) throw new ApiError(400, "VALIDATION_ERROR", "amount must be positive");
      if (min !== null || max !== null) throw new ApiError(400, "VALIDATION_ERROR", "a fixed-amount link takes no min_amount or max_amount");
    } else {
      if (min === null || max === null) throw new ApiError(400, "VALIDATION_ERROR", "an open-amount link needs min_amount and max_amount");
      if (min <= 0n || max < min) throw new ApiError(400, "VALIDATION_ERROR", "need 0 < min_amount <= max_amount");
    }
    checkExpiry(b.expires_at);
    const id = newLinkId();
    const now = nowIso();
    for (let tries = 0; ; tries++) {
      try {
        this.#db.run(
          `INSERT INTO payment_links (id, merchant_id, slug, title, description, amount, min_amount, max_amount, collect_email, collect_name, success_url,
                                      active, listed, max_payments, expires_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          id,
          merchantId,
          newLinkSlug(),
          b.title,
          b.description ?? null,
          fixed?.toString() ?? null,
          min?.toString() ?? null,
          max?.toString() ?? null,
          b.collect_email ? 1 : 0,
          b.collect_name ? 1 : 0,
          b.success_url ?? null,
          b.listed === false ? 0 : 1,
          b.max_payments ?? null,
          b.expires_at ? new Date(b.expires_at).toISOString() : null,
          b.created_by ?? null,
          now,
          now,
        );
        break;
      } catch (err) {
        // A slug collision (40 random bits) is retried with a fresh slug.
        if (tries < 5 && /UNIQUE constraint failed: payment_links.slug/.test(String(err))) continue;
        throw err;
      }
    }
    return this.get(merchantId, id);
  }

  get(merchantId: string, id: string): LinkRow {
    const r = this.#db.get<LinkRow>("SELECT * FROM payment_links WHERE id = ? AND merchant_id = ?", id, merchantId);
    if (!r) throw new ApiError(404, "NOT_FOUND", "payment link not found");
    return r;
  }

  bySlug(slug: string): LinkRow {
    const r = this.#db.get<LinkRow>("SELECT * FROM payment_links WHERE slug = ?", slug);
    if (!r) throw new ApiError(404, "NOT_FOUND", "payment link not found");
    return r;
  }

  list(merchantIds: string | readonly string[] | null, limit: number, cursor?: number) {
    const ids = typeof merchantIds === "string" ? [merchantIds] : merchantIds;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (ids) (where.push(`merchant_id IN (${ids.map(() => "?").join(", ") || "NULL"})`), params.push(...ids));
    if (cursor !== undefined) (where.push("rowid < ?"), params.push(cursor));
    const rows = this.#db.all<LinkRow & { rid: number }>(
      `SELECT rowid AS rid, * FROM payment_links ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ rid: _rid, ...r }) => this.json(r)),
      next_cursor: rows.length > limit && page.length ? String(page[page.length - 1]!.rid) : null,
    };
  }

  /** Active, listed links of active merchants, for the service directory. */
  listed(): LinkRow[] {
    return this.#db.all<LinkRow>(
      `SELECT l.* FROM payment_links l JOIN merchants m ON m.id = l.merchant_id
       WHERE l.active = 1 AND l.listed = 1 AND m.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?) ORDER BY l.created_at DESC LIMIT 500`,
      nowIso(),
    );
  }

  update(
    merchantId: string,
    id: string,
    b: Partial<{ title: string; description: string | null; active: boolean; success_url: string | null; max_payments: number | null; listed: boolean; expires_at: string | null }>,
  ): LinkRow {
    const cur = this.get(merchantId, id);
    if (b.expires_at) checkExpiry(b.expires_at);
    this.#db.run(
      "UPDATE payment_links SET title = ?, description = ?, active = ?, success_url = ?, max_payments = ?, listed = ?, expires_at = ?, updated_at = ? WHERE id = ?",
      b.title ?? cur.title,
      b.description === undefined ? cur.description : b.description,
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      b.success_url === undefined ? cur.success_url : b.success_url,
      b.max_payments === undefined ? cur.max_payments : b.max_payments,
      b.listed === undefined ? cur.listed : b.listed ? 1 : 0,
      b.expires_at === undefined ? cur.expires_at : b.expires_at ? new Date(b.expires_at).toISOString() : null,
      nowIso(),
      id,
    );
    return this.get(merchantId, id);
  }

  /** The amount a payer pays through the link, checked against its fixed amount or range. */
  amountFor(l: LinkRow, requested: bigint | null): bigint {
    if (!l.active) throw new ApiError(410, "LINK_INACTIVE", "this payment link is no longer active");
    if (l.expires_at && Date.parse(l.expires_at) <= Date.now()) throw new ApiError(410, "LINK_EXPIRED", "this payment link has expired");
    if (l.max_payments !== null && this.usedSlots(l.id) >= l.max_payments) throw new ApiError(410, "LINK_EXHAUSTED", "this payment link has reached its maximum number of payments");
    if (l.amount !== null) {
      if (requested !== null && requested !== BigInt(l.amount)) throw new ApiError(400, "AMOUNT_MISMATCH", `this link charges exactly ${l.amount}`);
      return BigInt(l.amount);
    }
    if (requested === null) throw new ApiError(400, "AMOUNT_REQUIRED", `pass amount between ${l.min_amount} and ${l.max_amount} (base units)`);
    if (requested < BigInt(l.min_amount!) || requested > BigInt(l.max_amount!)) {
      throw new ApiError(400, "AMOUNT_OUT_OF_RANGE", `amount must be between ${l.min_amount} and ${l.max_amount}`);
    }
    return requested;
  }
}
