import { isAccountId, isPublicKey } from "@payminto/protocol";
import { formatAmount } from "@payminto/protocol";
import type { Database } from "./db/database.ts";
import { customerId, parseCustomerId, type CustomerService } from "./gateway/customers.ts";

export const SEARCH_TYPES = ["payment", "link", "customer", "refund", "business", "budget", "paid_service", "settlement"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export type SearchScope = {
  /** Businesses the actor sees, or null for every business. */
  merchantIds: readonly string[] | null;
  /** Platform groups (businesses, budgets, paid services, settlements) the actor may search. */
  platform: boolean;
};

export type SearchItem = {
  id: string;
  type: SearchType;
  title: string;
  subtitle: string;
  href: string;
  status: string | null;
  matched: { field: string; snippet: string };
  merchant_id: string | null;
};

export type Detected = "id" | "tx_hash" | "address" | "email" | "amount" | "text";

const MAX_TOTAL = 100;
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s);

/** Text to an FTS5 prefix query: each word quoted (no operators get through) and prefixed. */
export function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

/**
 * What a query looks like. `tx_hash`: a NEAR transaction hash (base58) or a 32-byte id (Budget, checkout, batch).
 * `address`: a named NEAR account (`alice.testnet`) or an ed25519 public key (an agent). Amounts are tested before
 * accounts, because a bare number is also a valid NEAR account id.
 */
export function detect(q: string): Detected {
  if (/^(pay|plink|re|mer)_[a-z2-7]{24}$/.test(q) || /^cus_[A-Za-z0-9_-]+$/.test(q)) return "id";
  if (/^[0-9a-fA-F]{64}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(q)) return "tx_hash";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return "email";
  if (/^\d{1,12}(\.\d{1,6})?$/.test(q)) return "amount";
  if (isPublicKey(q) || (q.includes(".") && isAccountId(q.toLowerCase()))) return "address";
  return "text";
}

/**
 * Global search (PRODUCT.md 5.4 and 10.13). Pattern queries use exact-match indexes; text uses the FTS5 tables.
 * Scope is applied in SQL from the actor's businesses, never from client parameters alone.
 */
export class SearchService {
  readonly #db: Database;
  readonly #customers: CustomerService | null;
  readonly #decimals: number;
  readonly #symbol: string;

  constructor(o: { db: Database; customers: CustomerService | null; token: { decimals: number; symbol: string } }) {
    this.#db = o.db;
    this.#customers = o.customers;
    this.#decimals = o.token.decimals;
    this.#symbol = o.token.symbol;
  }

  #money(v: string) {
    return `${formatAmount(BigInt(v), this.#decimals)} ${this.#symbol}`;
  }

  #in(col: string, ids: readonly string[] | null): { sql: string; params: string[] } {
    if (!ids) return { sql: "1 = 1", params: [] };
    return { sql: `${col} IN (${ids.map(() => "?").join(", ") || "NULL"})`, params: [...ids] };
  }

  #names(ids: string[]): Map<string, string> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    return new Map(this.#db.all<{ id: string; name: string }>(`SELECT id, name FROM merchants WHERE id IN (${uniq.map(() => "?").join(", ")})`, ...uniq).map((r) => [r.id, r.name]));
  }

  search(q: string, types: readonly SearchType[], limit: number, scope: SearchScope) {
    const started = performance.now();
    const query = q.trim();
    const detected = detect(query);
    if (query.length < 2) return { query, detected, groups: [], took_ms: 0 };
    const allowed = types.filter((t) => scope.platform || !["business", "budget", "paid_service", "settlement"].includes(t));
    const groups: Array<{ type: SearchType; total: number; items: SearchItem[] }> = [];
    for (const type of allowed) {
      const found = this.#group(type, query, detected, limit, scope);
      if (found.items.length) groups.push({ type, ...found });
    }
    // Business names on payment-like rows ("Paid - 20.00 USDC - Northwind Data").
    const names = this.#names(groups.flatMap((g) => g.items.map((i) => i.merchant_id).filter((x): x is string => !!x)));
    for (const g of groups) {
      if (g.type === "business") continue;
      for (const i of g.items) if (i.merchant_id && names.has(i.merchant_id) && (!scope.merchantIds || scope.merchantIds.length > 1)) i.subtitle += ` - ${names.get(i.merchant_id)}`;
    }
    return { query, detected, groups, took_ms: Math.round(performance.now() - started) };
  }

  #group(type: SearchType, q: string, d: Detected, limit: number, scope: SearchScope): { total: number; items: SearchItem[] } {
    switch (type) {
      case "payment":
        return this.#payments(q, d, limit, scope.merchantIds);
      case "link":
        return this.#links(q, d, limit, scope.merchantIds);
      case "customer":
        return this.#customersFor(q, d, limit, scope.merchantIds);
      case "refund":
        return this.#refunds(q, d, limit, scope.merchantIds);
      case "business":
        return this.#businesses(q, d, limit);
      case "budget":
        return this.#budgets(q, d, limit);
      case "paid_service":
        return this.#services(q, d, limit);
      case "settlement":
        return this.#settlements(q, d, limit);
    }
  }

  #page<T>(rows: T[], limit: number, map: (r: T) => SearchItem) {
    return { total: Math.min(rows.length, MAX_TOTAL), items: rows.slice(0, limit).map(map) };
  }

  // ------------------------------------------------------------------ payments

  #payments(q: string, d: Detected, limit: number, ids: readonly string[] | null) {
    type Row = { id: string; merchant_id: string; status: string; amount: string; description: string | null; reference: string | null; customer_email: string | null; created_at: string; field: string; snippet: string };
    const scope = this.#in("p.merchant_id", ids);
    const cols = "p.id, p.merchant_id, p.status, p.amount, p.description, p.reference, p.customer_email, p.created_at";
    let rows: Row[] = [];
    const cap = MAX_TOTAL + 1;
    if (d === "id") {
      if (q.startsWith("pay_")) rows = this.#db.all<Row>(`SELECT ${cols}, 'id' AS field, p.id AS snippet FROM payments p WHERE p.id = ? AND p.draft = 0 AND ${scope.sql}`, q, ...scope.params);
    } else if (d === "tx_hash") {
      // A NEAR transaction hash (reported by a wallet, or a batch's), or a 32-byte id: the payment's checkout id.
      rows = this.#db.all<Row>(
        `SELECT DISTINCT ${cols}, 'tx_hash' AS field, c.tx_hash AS snippet FROM payment_credits c JOIN payments p ON p.id = c.payment_id
         WHERE c.tx_hash = ? AND p.draft = 0 AND ${scope.sql}
         UNION SELECT ${cols}, 'tx_hash' AS field, p.wallet_tx_hash AS snippet FROM payments p WHERE p.wallet_tx_hash = ? AND p.draft = 0 AND ${scope.sql}
         UNION SELECT ${cols}, 'checkout_id' AS field, p.checkout_id AS snippet FROM payments p WHERE p.checkout_id = ? AND p.draft = 0 AND ${scope.sql}
         LIMIT ?`,
        q,
        ...scope.params,
        q,
        ...scope.params,
        q.toLowerCase(),
        ...scope.params,
        cap,
      );
    } else if (d === "address") {
      const a = q.toLowerCase();
      rows = this.#db.all<Row>(
        `SELECT ${cols}, 'payer' AS field, p.payer AS snippet FROM payments p WHERE lower(p.payer) = ? AND p.draft = 0 AND ${scope.sql}
         UNION SELECT ${cols}, 'payer' AS field, c.payer AS snippet FROM payment_credits c JOIN payments p ON p.id = c.payment_id WHERE lower(c.payer) = ? AND p.draft = 0 AND ${scope.sql}
         ORDER BY created_at DESC LIMIT ?`,
        a,
        ...scope.params,
        a,
        ...scope.params,
        cap,
      );
    } else if (d === "email") {
      rows = this.#db.all<Row>(
        `SELECT ${cols}, 'customer_email' AS field, p.customer_email AS snippet FROM payments p WHERE lower(p.customer_email) = ? AND p.draft = 0 AND ${scope.sql} ORDER BY p.rowid DESC LIMIT ?`,
        q.toLowerCase(),
        ...scope.params,
        cap,
      );
    } else if (d === "amount") {
      const base = toBase(q, this.#decimals);
      if (base !== null) {
        rows = this.#db.all<Row>(
          `SELECT ${cols}, 'amount' AS field, p.amount AS snippet FROM payments p WHERE p.amount = ? AND p.draft = 0 AND ${scope.sql} ORDER BY p.rowid DESC LIMIT 5`,
          base,
          ...scope.params,
        );
        rows = rows.map((r) => ({ ...r, snippet: this.#money(r.amount) }));
      }
    }
    if (d === "text" || (d === "amount" && rows.length === 0) || (d === "email" && rows.length === 0)) {
      const fts = ftsQuery(q);
      if (fts) {
        rows = this.#db.all<Row>(
          `SELECT ${cols}, 'text' AS field, COALESCE(p.reference, p.description, p.customer_email, '') AS snippet
           FROM payments_fts JOIN payments p ON p.rowid = payments_fts.rowid
           WHERE payments_fts MATCH ? AND p.draft = 0 AND ${scope.sql} ORDER BY p.rowid DESC LIMIT ?`,
          fts,
          ...scope.params,
          cap,
        );
        const lower = q.toLowerCase();
        rows = rows.map((r) => ({
          ...r,
          field: r.reference?.toLowerCase().includes(lower) ? "reference" : r.customer_email?.toLowerCase().includes(lower) ? "customer_email" : "description",
        }));
      }
    }
    return this.#page(rows, limit, (r) => ({
      id: r.id,
      type: "payment",
      title: r.description || r.reference || r.id,
      subtitle: `${statusWord(r.status)} - ${this.#money(r.amount)} - ${ago(r.created_at)}`,
      href: `/payments/${r.id}`,
      status: r.status,
      matched: { field: r.field, snippet: short(r.snippet ?? "") },
      merchant_id: r.merchant_id,
    }));
  }

  // ------------------------------------------------------------------ links

  #links(q: string, d: Detected, limit: number, ids: readonly string[] | null) {
    type Row = { id: string; merchant_id: string; title: string; slug: string; amount: string | null; active: number; field: string };
    const scope = this.#in("l.merchant_id", ids);
    let rows: Row[] = [];
    if (d === "id" && q.startsWith("plink_")) rows = this.#db.all<Row>(`SELECT l.id, l.merchant_id, l.title, l.slug, l.amount, l.active, 'id' AS field FROM payment_links l WHERE l.id = ? AND ${scope.sql}`, q, ...scope.params);
    else if (d === "text" || d === "amount") {
      const fts = ftsQuery(q);
      if (fts) {
        rows = this.#db.all<Row>(
          `SELECT l.id, l.merchant_id, l.title, l.slug, l.amount, l.active, 'title' AS field FROM payment_links_fts JOIN payment_links l ON l.rowid = payment_links_fts.rowid
           WHERE payment_links_fts MATCH ? AND ${scope.sql} ORDER BY l.rowid DESC LIMIT ?`,
          fts,
          ...scope.params,
          MAX_TOTAL + 1,
        );
        // A slug is one word to the tokenizer only in part; an exact slug always wins.
        const exact = this.#db.all<Row>(`SELECT l.id, l.merchant_id, l.title, l.slug, l.amount, l.active, 'slug' AS field FROM payment_links l WHERE l.slug = ? AND ${scope.sql}`, q, ...scope.params);
        rows = [...exact, ...rows.filter((r) => !exact.some((e) => e.id === r.id))];
      }
    }
    return this.#page(rows, limit, (r) => ({
      id: r.id,
      type: "link",
      title: r.title,
      subtitle: `${r.active ? "Active" : "Inactive"} - ${r.amount ? this.#money(r.amount) : "Customer chooses amount"} - /l/${r.slug}`,
      href: `/links/${r.id}`,
      status: r.active ? "active" : "inactive",
      matched: { field: r.field, snippet: r.field === "slug" ? r.slug : r.field === "id" ? r.id : r.title },
      merchant_id: r.merchant_id,
    }));
  }

  // ------------------------------------------------------------------ customers

  #customersFor(q: string, d: Detected, limit: number, ids: readonly string[] | null) {
    if (!this.#customers) return { total: 0, items: [] };
    if (d === "id" && q.startsWith("cus_")) {
      const p = parseCustomerId(q);
      if (!p || (ids && !ids.includes(p.merchantId))) return { total: 0, items: [] };
      try {
        const { customer } = this.#customers.get(q, () => true);
        return { total: 1, items: [this.#customerItem(customer, "id", q)] };
      } catch {
        return { total: 0, items: [] };
      }
    }
    if (d === "tx_hash" || d === "amount" || d === "id") return { total: 0, items: [] };
    const list = this.#customers.list(ids, { q, limit: Math.min(MAX_TOTAL, limit) });
    const field = d === "address" ? "wallet" : d === "email" ? "email" : "name";
    return { total: list.items.length, items: list.items.map((cu) => this.#customerItem(cu, field, field === "wallet" ? q : (cu.email ?? cu.name ?? ""))) };
  }

  #customerItem(cu: ReturnType<CustomerService["list"]>["items"][number], field: string, snippet: string): SearchItem {
    return {
      id: cu.id,
      type: "customer",
      title: cu.name || cu.email || short(cu.wallets[0] ?? cu.id),
      subtitle: `${cu.payments} payment${cu.payments === 1 ? "" : "s"} - ${this.#money(cu.total_paid)} paid`,
      href: `/customers/${cu.id}`,
      status: null,
      matched: { field, snippet: short(snippet) },
      merchant_id: cu.merchant_id,
    };
  }

  // ------------------------------------------------------------------ refunds

  #refunds(q: string, d: Detected, limit: number, ids: readonly string[] | null) {
    type Row = { id: string; merchant_id: string; payment_id: string; amount: string; status: string; to_addr: string; tx_hash: string | null; created_at: string; field: string; snippet: string };
    const scope = this.#in("r.merchant_id", ids);
    const cols = "r.id, r.merchant_id, r.payment_id, r.amount, r.status, r.to_addr, r.tx_hash, r.created_at";
    let rows: Row[] = [];
    if (d === "id" && q.startsWith("re_")) rows = this.#db.all<Row>(`SELECT ${cols}, 'id' AS field, r.id AS snippet FROM refunds r WHERE r.id = ? AND ${scope.sql}`, q, ...scope.params);
    else if (d === "id" && q.startsWith("pay_")) rows = this.#db.all<Row>(`SELECT ${cols}, 'payment_id' AS field, r.payment_id AS snippet FROM refunds r WHERE r.payment_id = ? AND ${scope.sql} ORDER BY r.rowid DESC LIMIT ?`, q, ...scope.params, MAX_TOTAL + 1);
    else if (d === "tx_hash") rows = this.#db.all<Row>(`SELECT ${cols}, 'tx_hash' AS field, r.tx_hash AS snippet FROM refunds r WHERE lower(r.tx_hash) = ? AND ${scope.sql}`, q.toLowerCase(), ...scope.params);
    else if (d === "address") rows = this.#db.all<Row>(`SELECT ${cols}, 'recipient' AS field, r.to_addr AS snippet FROM refunds r WHERE lower(r.to_addr) = ? AND ${scope.sql} ORDER BY r.rowid DESC LIMIT ?`, q.toLowerCase(), ...scope.params, MAX_TOTAL + 1);
    return this.#page(rows, limit, (r) => ({
      id: r.id,
      type: "refund",
      title: `Refund of ${this.#money(r.amount)}`,
      subtitle: `${r.status[0]!.toUpperCase()}${r.status.slice(1)} - ${r.payment_id} - ${ago(r.created_at)}`,
      href: `/payments/${r.payment_id}`,
      status: r.status,
      matched: { field: r.field, snippet: short(r.snippet ?? "") },
      merchant_id: r.merchant_id,
    }));
  }

  // ------------------------------------------------------------------ platform groups

  #businesses(q: string, d: Detected, limit: number) {
    type Row = { id: string; name: string; slug: string; status: string; payout: string; field: string; snippet: string };
    let rows: Row[] = [];
    if (d === "id" && q.startsWith("mer_")) rows = this.#db.all<Row>("SELECT id, name, slug, status, payout, 'id' AS field, id AS snippet FROM merchants WHERE id = ?", q);
    else if (d === "address") rows = this.#db.all<Row>("SELECT id, name, slug, status, payout, 'payout' AS field, payout AS snippet FROM merchants WHERE lower(payout) = ?", q.toLowerCase());
    else if (d === "text" || d === "email") {
      const fts = ftsQuery(q);
      if (fts) {
        rows = this.#db.all<Row>(
          `SELECT m.id, m.name, m.slug, m.status, m.payout, 'name' AS field, m.name AS snippet FROM merchants_fts JOIN merchants m ON m.rowid = merchants_fts.rowid
           WHERE merchants_fts MATCH ? ORDER BY m.name LIMIT ?`,
          fts,
          MAX_TOTAL + 1,
        );
      }
    }
    return this.#page(rows, limit, (r) => ({
      id: r.id,
      type: "business",
      title: r.name,
      subtitle: `${r.status === "active" ? "Active" : "Suspended"} - ${r.slug}`,
      href: `/platform/merchants/${r.id}`,
      status: r.status,
      matched: { field: r.field, snippet: short(r.snippet) },
      merchant_id: r.id,
    }));
  }

  #budgets(q: string, d: Detected, limit: number) {
    type Row = { id: string; label: string; status: string; cap: string; agent: string; owner: string; field: string; snippet: string };
    let rows: Row[] = [];
    const cols = "id, label, status, cap, agent, owner";
    if (d === "tx_hash") rows = this.#db.all<Row>(`SELECT ${cols}, 'id' AS field, id AS snippet FROM budgets WHERE id = ?`, q.toLowerCase());
    else if (d === "address") {
      // Agents are public keys (case-sensitive base58); owners are account ids (lowercase).
      rows = this.#db.all<Row>(
        `SELECT ${cols}, 'agent' AS field, agent AS snippet FROM budgets WHERE agent = ? UNION SELECT ${cols}, 'owner' AS field, owner AS snippet FROM budgets WHERE owner = ? LIMIT ?`,
        q,
        q.toLowerCase(),
        MAX_TOTAL + 1,
      );
    } else if (d === "text") {
      rows = this.#db.all<Row>(`SELECT ${cols}, 'label' AS field, label AS snippet FROM budgets WHERE label LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`, `%${likeEscape(q)}%`, MAX_TOTAL + 1);
    }
    return this.#page(rows, limit, (r) => ({
      id: r.id,
      type: "budget",
      title: r.label,
      subtitle: `${r.status === "open" ? "Active" : r.status === "revoked" ? "Stopped" : "Pending"} - limit ${this.#money(r.cap)} - agent ${short(r.agent)}`,
      href: `/budgets/${r.id}`,
      status: r.status,
      matched: { field: r.field, snippet: short(r.snippet) },
      merchant_id: null,
    }));
  }

  #services(q: string, d: Detected, limit: number) {
    type Row = { id: string; name: string; payee: string; price_atomic: string; resource: string; field: string; snippet: string };
    let rows: Row[] = [];
    const cols = "id, name, payee, price_atomic, resource";
    if (d === "address") rows = this.#db.all<Row>(`SELECT ${cols}, 'payee' AS field, payee AS snippet FROM providers WHERE payee = ? AND category != 'gateway'`, q.toLowerCase());
    else if (d === "text") {
      const like = `%${likeEscape(q)}%`;
      rows = this.#db.all<Row>(
        `SELECT ${cols}, CASE WHEN name LIKE ? ESCAPE '\\' THEN 'name' ELSE 'endpoint' END AS field, CASE WHEN name LIKE ? ESCAPE '\\' THEN name ELSE resource END AS snippet
         FROM providers WHERE category != 'gateway' AND (name LIKE ? ESCAPE '\\' OR resource LIKE ? ESCAPE '\\' OR id = ?) ORDER BY name LIMIT ?`,
        like,
        like,
        like,
        like,
        q,
        MAX_TOTAL + 1,
      );
    }
    return this.#page(rows, limit, (r) => ({
      id: r.id,
      type: "paid_service",
      title: r.name,
      subtitle: `${this.#money(r.price_atomic)} per call - payee ${short(r.payee)}`,
      href: `/providers?id=${r.id}`,
      status: null,
      matched: { field: r.field, snippet: short(r.snippet) },
      merchant_id: null,
    }));
  }

  #settlements(q: string, d: Detected, limit: number) {
    type Row = { seq: number; batch_id: string | null; status: string; calls: number; net: string; tx_hash: string | null; field: string; snippet: string };
    let rows: Row[] = [];
    if (d === "tx_hash") {
      const h = q.toLowerCase();
      rows = this.#db.all<Row>(
        "SELECT seq, batch_id, status, calls, net, tx_hash, CASE WHEN lower(tx_hash) = ? THEN 'tx_hash' ELSE 'id' END AS field, CASE WHEN lower(tx_hash) = ? THEN tx_hash ELSE batch_id END AS snippet FROM batches WHERE lower(tx_hash) = ? OR lower(batch_id) = ?",
        h,
        h,
        h,
        h,
      );
    } else if (d === "amount" && /^\d+$/.test(q)) {
      rows = this.#db.all<Row>("SELECT seq, batch_id, status, calls, net, tx_hash, 'id' AS field, CAST(seq AS TEXT) AS snippet FROM batches WHERE seq = ?", Number(q));
    }
    return this.#page(rows, limit, (r) => ({
      id: r.batch_id ?? String(r.seq),
      type: "settlement",
      title: `Settlement #${r.seq}`,
      subtitle: `${r.status === "confirmed" ? "Final" : r.status === "submitted" ? "Sent" : r.status} - ${r.calls} charges - ${this.#money(r.net)} moved`,
      href: `/batches/${r.batch_id ?? r.seq}`,
      status: r.status,
      matched: { field: r.field, snippet: short(r.snippet ?? "") },
      merchant_id: null,
    }));
  }

  // ------------------------------------------------------------------ recent items

  recent(userId: string) {
    return {
      items: this.#db.all<{ type: string; id: string; title: string; href: string; at: string }>("SELECT type, id, title, href, at FROM search_recent WHERE user_id = ? ORDER BY at DESC LIMIT 20", userId),
    };
  }

  addRecent(userId: string, r: { type: string; id: string; title: string; href: string }) {
    this.#db.tx(() => {
      this.#db.run(
        "INSERT INTO search_recent (user_id, type, id, title, href, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, type, id) DO UPDATE SET title = excluded.title, href = excluded.href, at = excluded.at",
        userId,
        r.type,
        r.id,
        r.title,
        r.href,
        new Date().toISOString(),
      );
      this.#db.run(
        "DELETE FROM search_recent WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM search_recent WHERE user_id = ? ORDER BY at DESC LIMIT 20)",
        userId,
        userId,
      );
    });
    return this.recent(userId);
  }
}

function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** "12.5" to base units, or null when it has more decimals than the token. */
export function toBase(q: string, decimals: number): string | null {
  const [whole, frac = ""] = q.split(".");
  if (frac.length > decimals) return null;
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

function statusWord(s: string): string {
  return (
    { open: "Waiting for payment", processing: "Processing", partially_paid: "Partly paid", paid: "Paid", overpaid: "Paid extra", underpaid: "Underpaid", expired: "Expired", canceled: "Canceled" } as Record<string, string>
  )[s] ?? s;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export { customerId };
