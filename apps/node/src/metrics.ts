import type { Database } from "./db/database.ts";

type Labels = Record<string, string>;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelText = (l: Labels) => {
  const keys = Object.keys(l);
  return keys.length ? `{${keys.map((k) => `${k}="${esc(l[k]!)}"`).join(",")}}` : "";
};

/** Process-local counters, rendered in the Prometheus text exposition format together with gauges read on scrape. */
export class Metrics {
  readonly #counters = new Map<string, { help: string; values: Map<string, { labels: Labels; value: number }> }>();
  readonly startedAt = Date.now();

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    let c = this.#counters.get(name);
    if (!c) {
      c = { help, values: new Map() };
      this.#counters.set(name, c);
    }
    const key = labelText(labels);
    const v = c.values.get(key);
    if (v) v.value += by;
    else c.values.set(key, { labels, value: by });
  }

  counter(name: string, labels: Labels = {}): number {
    return this.#counters.get(name)?.values.get(labelText(labels))?.value ?? 0;
  }

  renderCounters(): string[] {
    const out: string[] = [];
    for (const [name, c] of this.#counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const v of c.values.values()) out.push(`${name}${labelText(v.labels)} ${v.value}`);
    }
    return out;
  }
}

/** A metric read on scrape. `type` is gauge unless a service keeps a counter itself (see `addCollector`). */
export type Gauge = { name: string; help: string; type?: "gauge" | "counter"; samples: Array<{ labels?: Labels; value: number | bigint }> };

export function renderGauges(gauges: Gauge[]): string[] {
  const out: string[] = [];
  for (const g of gauges) {
    if (g.samples.length === 0) continue;
    out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} ${g.type ?? "gauge"}`);
    for (const s of g.samples) out.push(`${g.name}${labelText(s.labels ?? {})} ${s.value.toString()}`);
  }
  return out;
}

/**
 * Metrics a service of one node renders on scrape, keyed by that node's database, so a service can publish its own
 * metrics without the API layer knowing about it. `databaseGauges` renders them.
 */
const collectors = new WeakMap<Database, Array<() => Gauge[]>>();

export function addCollector(db: Database, collect: () => Gauge[]): void {
  const list = collectors.get(db) ?? [];
  list.push(collect);
  collectors.set(db, list);
}

/** What the any-chain checkout raises an operator alert for. */
export const INTENTS_ALERT_KINDS = ["provider_only", "stuck", "contradicted", "auth"] as const;
export type IntentsAlertKind = (typeof INTENTS_ALERT_KINDS)[number];

/** `payminto_intents_alerts_total{kind}`: one per quote and kind, each also a platform `intents.alert` event. Alert on any increase. */
export function intentsAlertsMetric(counts: Readonly<Record<IntentsAlertKind, number>>): Gauge {
  return {
    name: "payminto_intents_alerts_total",
    help: "Any-chain checkout conditions only the operator can resolve, by kind (provider_only, stuck, contradicted, auth). Alert on any increase.",
    type: "counter",
    samples: INTENTS_ALERT_KINDS.map((kind) => ({ labels: { kind }, value: counts[kind] })),
  };
}

/** Ledger-level gauges straight from SQLite; cheap aggregate queries over indexed columns, plus the collectors of this database. */
export function databaseGauges(db: Database): Gauge[] {
  const byStatus = (table: "calls" | "batches") =>
    db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).map((r) => ({ labels: { status: r.status }, value: r.n }));
  const denials = db.get<{ rows: number; total: number }>("SELECT COUNT(*) AS rows, COALESCE(SUM(repeats), 0) AS total FROM denials")!;
  const events = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!;
  const pages = db.get<{ page_count: number }>("PRAGMA page_count")!;
  const pageSize = db.get<{ page_size: number }>("PRAGMA page_size")!;
  return [
    { name: "payminto_calls", help: "Accepted calls by status.", samples: byStatus("calls") },
    { name: "payminto_batches", help: "Settlement batches by status.", samples: byStatus("batches") },
    { name: "payminto_denials", help: "Denied vouchers, counting folded repeats.", samples: [{ value: denials.total }] },
    { name: "payminto_denial_rows", help: "Rows in the denials table (bounded by DENIALS_MAX_ROWS).", samples: [{ value: denials.rows }] },
    { name: "payminto_event_rows", help: "Rows in the durable event log (bounded by EVENTS_MAX_ROWS).", samples: [{ value: events.n }] },
    { name: "payminto_db_size_bytes", help: "SQLite main database file size.", samples: [{ value: pages.page_count * pageSize.page_size }] },
    ...(collectors.get(db) ?? []).flatMap((collect) => collect()),
  ];
}
