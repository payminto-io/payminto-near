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

export type Gauge = { name: string; help: string; samples: Array<{ labels?: Labels; value: number | bigint }> };

export function renderGauges(gauges: Gauge[]): string[] {
  const out: string[] = [];
  for (const g of gauges) {
    if (g.samples.length === 0) continue;
    out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
    for (const s of g.samples) out.push(`${g.name}${labelText(s.labels ?? {})} ${s.value.toString()}`);
  }
  return out;
}

/** Ledger-level gauges straight from SQLite; cheap aggregate queries over indexed columns. */
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
  ];
}
