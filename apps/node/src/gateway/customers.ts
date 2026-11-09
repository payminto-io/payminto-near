import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";

type CustomerAgg = {
  merchant_id: string;
  k: string;
  kind: "email" | "wallet";
  email: string | null;
  name: string | null;
  wallets: string | null;
  payments: number;
  paid_payments: number;
  total_paid: string | null;
  total_refunded: string | null;
  first_payment_at: string;
  last_payment_at: string;
};

/** Opaque, stable customer id: the business and the lowercase email or wallet, base64url. */
export function customerId(merchantId: string, key: string): string {
  return `cus_${Buffer.from(`${merchantId}:${key}`, "utf8").toString("base64url")}`;
}

export function parseCustomerId(id: string): { merchantId: string; key: string } | null {
  if (!id.startsWith("cus_")) return null;
  const raw = Buffer.from(id.slice(4), "base64url").toString("utf8");
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const merchantId = raw.slice(0, i);
  const key = raw.slice(i + 1);
  if (!/^mer_[a-z2-7]{24}$/.test(merchantId) || !key) return null;
  return { merchantId, key };
}

const KEY_SQL = "COALESCE(lower(customer_email), lower(payer))";

/**
 * Customers (PRODUCT.md 10.14), derived from payments: one per email, or per payer wallet for payments without an
 * email, within one business. No table of their own, so they can never drift from the payments.
 */
export class CustomerService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  #select(where: string[], params: Array<string | number>, tail: string, tailParams: Array<string | number>): CustomerAgg[] {
    return this.#db.all<CustomerAgg>(
      `SELECT merchant_id, ${KEY_SQL} AS k,
              CASE WHEN MAX(customer_email) IS NOT NULL THEN 'email' ELSE 'wallet' END AS kind,
              MAX(customer_email) AS email, MAX(customer_name) AS name, group_concat(DISTINCT payer) AS wallets,
              COUNT(*) AS payments, SUM(CASE WHEN status IN ('paid', 'overpaid') THEN 1 ELSE 0 END) AS paid_payments,
              bigsum(amount_paid) AS total_paid, bigsum(amount_refunded) AS total_refunded,
              MIN(created_at) AS first_payment_at, MAX(created_at) AS last_payment_at
       FROM payments WHERE draft = 0 AND ${KEY_SQL} IS NOT NULL ${where.length ? `AND ${where.join(" AND ")}` : ""}
       GROUP BY merchant_id, ${KEY_SQL} ${tail}`,
      ...params,
      ...tailParams,
    );
  }

  #json(r: CustomerAgg) {
    return {
      id: customerId(r.merchant_id, r.k),
      merchant_id: r.merchant_id,
      email: r.kind === "email" ? r.email : null,
      name: r.name,
      wallets: r.wallets ? [...new Set(r.wallets.split(","))] : [],
      payments: r.payments,
      paid_payments: r.paid_payments,
      total_paid: r.total_paid ?? "0",
      total_refunded: r.total_refunded ?? "0",
      first_payment_at: r.first_payment_at,
      last_payment_at: r.last_payment_at,
    };
  }

  /** `q` matches the start of the email, the wallet, or the name. Offset cursor (aggregates have no stable rowid). */
  list(merchantIds: readonly string[] | null, f: { q?: string; limit: number; cursor?: number }) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (merchantIds) (where.push(`merchant_id IN (${merchantIds.map(() => "?").join(", ") || "NULL"})`), params.push(...merchantIds));
    if (f.q) {
      const like = `${f.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(lower(customer_email) LIKE ? ESCAPE '\\' OR lower(payer) LIKE ? ESCAPE '\\' OR lower(customer_name) LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    const offset = f.cursor ?? 0;
    const rows = this.#select(where, params, "ORDER BY last_payment_at DESC, k LIMIT ? OFFSET ?", [f.limit + 1, offset]);
    const page = rows.slice(0, f.limit);
    return { items: page.map((r) => this.#json(r)), next_cursor: rows.length > f.limit ? String(offset + f.limit) : null };
  }

  /** One customer, with its last 20 payments (ids and rows; the caller renders payment JSON). */
  get(id: string, visible: (merchantId: string) => boolean) {
    const parsed = parseCustomerId(id);
    if (!parsed || !visible(parsed.merchantId)) throw new ApiError(404, "NOT_FOUND", "customer not found");
    const where = ["merchant_id = ?", `${KEY_SQL} = ?`];
    const rows = this.#select(where, [parsed.merchantId, parsed.key], "", []);
    if (!rows.length) throw new ApiError(404, "NOT_FOUND", "customer not found");
    const recent = this.#db.all<{ id: string }>(
      `SELECT id FROM payments WHERE draft = 0 AND merchant_id = ? AND ${KEY_SQL} = ? ORDER BY rowid DESC LIMIT 20`,
      parsed.merchantId,
      parsed.key,
    );
    return { customer: this.#json(rows[0]!), merchantId: parsed.merchantId, recentPaymentIds: recent.map((r) => r.id) };
  }
}
