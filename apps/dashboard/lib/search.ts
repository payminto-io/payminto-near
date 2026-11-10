/**
 * Global search (docs/PRODUCT.md sections 5 and 10.13): query parsing, pattern detection, static pages and actions,
 * and grouping for the command palette. Pure, so grouping and the keyboard model are unit tested.
 */
import { z } from "zod";

export type RecordType = "payment" | "link" | "customer" | "refund" | "business" | "budget" | "paid_service" | "settlement";
export type GroupType = "recent" | "action" | "page" | RecordType | "setting" | "shortcut";

export const GROUP_LABEL: Record<GroupType, string> = {
  recent: "Recent",
  action: "Actions",
  page: "Pages",
  payment: "Payments",
  link: "Payment links",
  customer: "Customers",
  refund: "Refunds",
  business: "Businesses",
  budget: "Budgets",
  paid_service: "Paid services",
  settlement: "Settlements",
  setting: "Settings",
  shortcut: "Keyboard shortcuts",
};

/** Section 5.2 order. */
export const GROUP_ORDER: GroupType[] = ["recent", "action", "page", "payment", "link", "customer", "refund", "business", "budget", "paid_service", "settlement", "setting", "shortcut"];

export const RECORD_TYPES: RecordType[] = ["payment", "link", "customer", "refund", "business", "budget", "paid_service", "settlement"];

/** A filter chip: one group only. */
export type Filter = "payment" | "link" | "customer" | "business" | "budget" | "action";

export const FILTER_LABEL: Record<Filter, string> = { payment: "Payments", link: "Payment links", customer: "Customers", business: "Businesses", budget: "Agents and budgets", action: "Actions" };

const PREFIXES: [string, Filter][] = [
  ["p:", "payment"],
  ["l:", "link"],
  ["c:", "customer"],
  ["b:", "business"],
  ["a:", "budget"],
  [">", "action"],
];

/** `p: 1001` filters to payments; `>` lists actions only. */
export function parseQuery(raw: string): { filter: Filter | null; text: string } {
  const t = raw.replace(/^\s+/, "");
  for (const [prefix, filter] of PREFIXES) {
    if (t.toLowerCase().startsWith(prefix)) return { filter, text: t.slice(prefix.length).trim() };
  }
  return { filter: null, text: raw.trim() };
}

export type Detected = { kind: "id"; type: RecordType | null } | { kind: "tx_hash" } | { kind: "address" } | { kind: "email" } | { kind: "amount" } | { kind: "text" } | { kind: "short" };

const ID_PREFIX: [RegExp, RecordType][] = [
  [/^pay_/i, "payment"],
  [/^(plink|lnk)_/i, "link"],
  [/^(re|ref)_/i, "refund"],
  [/^mer_/i, "business"],
  [/^cus_/i, "customer"],
  [/^mnd_/i, "budget"],
  [/^bat_/i, "settlement"],
];

/** Pattern detection runs before full-text search (section 5.2). */
export function detect(text: string): Detected {
  const t = text.trim();
  if (t.length < 2) return { kind: "short" };
  for (const [re, type] of ID_PREFIX) if (re.test(t)) return { kind: "id", type };
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return { kind: "tx_hash" };
  if (/^0x[0-9a-fA-F]{40}$/.test(t) || /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(testnet|near)$/.test(t)) return { kind: "address" };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: "email" };
  if (/^\d+(\.\d+)?$/.test(t)) return { kind: "amount" };
  return { kind: "text" };
}

/** A plain hint under the input while a pattern is recognised. */
export function detectedHint(d: Detected): string | null {
  switch (d.kind) {
    case "id":
      return d.type ? `Looking up this ${GROUP_LABEL[d.type].replace(/s$/, "").toLowerCase()} id` : "Looking up this id";
    case "tx_hash":
      return "Transaction hash: matching payments, refunds and settlements";
    case "address":
      return "Wallet address: matching payers, payout wallets, agents and paid services";
    case "email":
      return "Email: matching customers and payments";
    case "amount":
      return "Amount: payments of this amount";
    default:
      return null;
  }
}

export type SearchItem = {
  /** Unique within the palette. */
  key: string;
  type: GroupType;
  id: string;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  status?: string | null;
  matched?: { field: string; snippet: string } | null;
  merchantId?: string | null;
  /** For actions: what to run instead of navigating. */
  action?: string;
  shortcut?: string;
  external?: boolean;
  keywords?: string[];
};

export type SearchGroup = { type: GroupType; total: number; items: SearchItem[] };

// ---------------------------------------------------------------------------
// Server response (section 5.4)
// ---------------------------------------------------------------------------

const groupTypeSchema = z.string();

export const searchResponseSchema = z
  .object({
    query: z.string().optional(),
    detected: z.string().nullable().optional(),
    groups: z
      .array(
        z
          .object({
            type: groupTypeSchema,
            total: z.number().optional(),
            items: z.array(
              z
                .object({
                  id: z.string(),
                  type: z.string().optional(),
                  title: z.string(),
                  subtitle: z.string().nullable().optional(),
                  href: z.string().nullable().optional(),
                  status: z.string().nullable().optional(),
                  matched: z.object({ field: z.string(), snippet: z.string() }).nullable().optional(),
                  merchant_id: z.string().nullable().optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      )
      .default([]),
    took_ms: z.number().optional(),
  })
  .passthrough()
  .transform((r) => ({
    detected: r.detected ?? null,
    tookMs: r.took_ms ?? null,
    groups: r.groups
      .filter((g): g is typeof g & { type: RecordType } => (RECORD_TYPES as string[]).includes(g.type))
      .map(
        (g): SearchGroup => ({
          type: g.type,
          total: g.total ?? g.items.length,
          items: g.items.map((i) => ({
            key: `${g.type}:${i.id}`,
            type: g.type,
            id: i.id,
            title: i.title,
            subtitle: i.subtitle ?? null,
            href: i.href ?? null,
            status: i.status ?? null,
            matched: i.matched ?? null,
            merchantId: i.merchant_id ?? null,
          })),
        }),
      ),
  }));
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const recentSchema = z
  .object({ items: z.array(z.object({ type: z.string(), id: z.string(), title: z.string(), href: z.string(), at: z.union([z.string(), z.number()]).optional() }).passthrough()).default([]) })
  .passthrough()
  .transform((r) => r.items.map((i): SearchItem => ({ key: `recent:${i.type}:${i.id}`, type: "recent", id: i.id, title: i.title, href: i.href, subtitle: GROUP_LABEL[i.type as GroupType] ?? (i.type === "page" ? "Page" : null) })));

// ---------------------------------------------------------------------------
// Static matching (pages, actions, settings)
// ---------------------------------------------------------------------------

/** 0 when nothing matches; higher is better: title prefix, word start, then substring, then keywords. */
export function score(item: Pick<SearchItem, "title" | "keywords">, text: string): number {
  const q = text.trim().toLowerCase();
  if (!q) return 1;
  const title = item.title.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.split(/[\s-]+/).some((w) => w.startsWith(q))) return 60;
  if (title.includes(q)) return 40;
  if (item.keywords?.some((k) => k.toLowerCase().startsWith(q))) return 30;
  if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return 20;
  return 0;
}

export function matchStatic(items: SearchItem[], text: string, limit = 8): SearchItem[] {
  return items
    .map((item, i) => ({ item, s: score(item, text), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

/** The groups a filter allows; `budget` also covers paid services and settlements ("agents and budgets"). */
export function allowedByFilter(type: GroupType, filter: Filter | null): boolean {
  if (!filter) return true;
  if (filter === "budget") return type === "budget" || type === "paid_service" || type === "settlement";
  return type === filter;
}

/**
 * The palette's groups, in section 5.2 order.
 * Empty query: Recent, Actions and Pages. Typing: static matches plus the server's record groups.
 */
export function buildGroups(input: {
  query: string;
  recent: SearchItem[];
  actions: SearchItem[];
  pages: SearchItem[];
  settings?: SearchItem[];
  remote: SearchGroup[];
}): SearchGroup[] {
  const { filter, text } = parseQuery(input.query);
  const groups: SearchGroup[] = [];
  if (!text) {
    if (!filter) {
      if (input.recent.length) groups.push({ type: "recent", total: input.recent.length, items: input.recent.slice(0, 8) });
      groups.push({ type: "action", total: input.actions.length, items: input.actions });
      groups.push({ type: "page", total: input.pages.length, items: input.pages });
    } else if (filter === "action") {
      groups.push({ type: "action", total: input.actions.length, items: input.actions });
    }
    return groups.filter((g) => g.items.length > 0);
  }
  const statics: [GroupType, SearchItem[]][] = [
    ["action", input.actions],
    ["page", input.pages],
    ["setting", input.settings ?? []],
  ];
  for (const [type, list] of statics) {
    if (!allowedByFilter(type, filter)) continue;
    const items = matchStatic(list, text, type === "page" ? 6 : 5);
    if (items.length) groups.push({ type, total: items.length, items });
  }
  for (const g of input.remote) {
    if (!allowedByFilter(g.type, filter) || g.items.length === 0) continue;
    groups.push(g);
  }
  return groups.sort((a, b) => GROUP_ORDER.indexOf(a.type) - GROUP_ORDER.indexOf(b.type));
}

/** The flat keyboard order of the rows in a set of groups. */
export function flatten(groups: SearchGroup[]): SearchItem[] {
  return groups.flatMap((g) => g.items);
}

/** Arrow keys wrap around the list. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
}

/** `Tab` cycles the filter chip through the record groups present, then back to none. */
export function cycleFilter(current: Filter | null, available: Filter[], backwards = false): Filter | null {
  const order: (Filter | null)[] = [null, ...available];
  const i = Math.max(0, order.indexOf(current));
  const next = order[(i + (backwards ? -1 : 1) + order.length) % order.length]!;
  return next;
}

export function filterPrefix(filter: Filter): string {
  return PREFIXES.find(([, f]) => f === filter)![0];
}

/** Splits text into segments so the matched part can be highlighted. */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, i), match: false },
    { text: text.slice(i, i + q.length), match: true },
    { text: text.slice(i + q.length), match: false },
  ].filter((s) => s.text.length > 0);
}

/** Search only with 2 or more characters (section 10.13), and never for the action-only filter. */
export function shouldSearchServer(query: string): boolean {
  const { filter, text } = parseQuery(query);
  return filter !== "action" && text.length >= 2;
}

/** The server `types` parameter for a filter. */
export function typesFor(filter: Filter | null): RecordType[] | null {
  if (!filter || filter === "action") return null;
  if (filter === "budget") return ["budget", "paid_service", "settlement"];
  return [filter];
}

/** Recent items kept in this browser too, so the palette has them before the server answers. */
export function pushRecent(list: SearchItem[], item: SearchItem, max = 20): SearchItem[] {
  const key = item.href ?? item.key;
  const rest = list.filter((x) => (x.href ?? x.key) !== key);
  return [{ ...item, key: `recent:${key}`, type: "recent" as const }, ...rest].slice(0, max);
}
