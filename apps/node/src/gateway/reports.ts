import type { Hono } from "hono";

import {
  explorerTx,
  REPORT_AMOUNT_FIELDS,
  REPORT_CSV_COLUMNS,
  REPORT_TOTAL_FIELDS,
  reportCsvCell,
  type PaymentStatus,
  type ReportCsvColumn,
  type ReconciliationReport,
  type ReconciliationRow,
  type ReportAmountField,
  type ReportAmounts,
  type ReportTotalField,
} from "@payminto/protocol";
import type { Access } from "../auth/actor.ts";
import { ApiError } from "../errors.ts";
import { nowIso } from "../store.ts";
import type { Gateway } from "./index.ts";
import type { MerchantRow } from "./merchants.ts";
import type { CreditRow, PaymentRow, RefundRow } from "./model.ts";

/** The longest range one report covers. */
export const REPORT_MAX_DAYS = 366;
/** More payments than this in one range is refused: narrow the range instead. */
export const REPORT_MAX_ROWS = 100_000;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A time must name its zone (Z or an offset): a bare local time would mean a different instant on every machine.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export type ReportRange = { from: string; to: string };

/**
 * Parses `from` and `to`: ISO 8601 times, or plain dates (UTC). A plain `to` date covers that whole day, so
 * `from=2026-10-01&to=2026-10-31` is October. The range is [from, to): from inclusive, to exclusive.
 */
export function parseReportRange(from: string | undefined, to: string | undefined): ReportRange {
  if (!from || !to) throw new ApiError(400, "VALIDATION_ERROR", "from and to are required (ISO 8601 times or YYYY-MM-DD dates)");
  const at = (v: string, name: string, endOfDay: boolean) => {
    const ms = DATE_ONLY.test(v) ? Date.parse(`${v}T00:00:00.000Z`) + (endOfDay ? DAY_MS : 0) : DATE_TIME.test(v) ? Date.parse(v) : NaN;
    if (Number.isNaN(ms)) throw new ApiError(400, "VALIDATION_ERROR", `${name} must be an ISO 8601 time or a YYYY-MM-DD date`, { issues: [{ path: name, message: "invalid date" }] });
    return ms;
  };
  const f = at(from, "from", false);
  const t = at(to, "to", true);
  if (t <= f) throw new ApiError(400, "VALIDATION_ERROR", "to must be after from", { issues: [{ path: "to", message: "must be after from" }] });
  if (t - f > (REPORT_MAX_DAYS + 1) * DAY_MS) throw new ApiError(400, "VALIDATION_ERROR", `a report covers at most ${REPORT_MAX_DAYS} days`, { issues: [{ path: "to", message: "range too long" }] });
  return { from: new Date(f).toISOString(), to: new Date(t).toISOString() };
}

/** Base units as a decimal string with exactly `decimals` places ("12500000" -> "12.500000"). */
export function decimalOf(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString();
  if (decimals === 0) return `${neg ? "-" : ""}${s}`;
  const padded = s.padStart(decimals + 1, "0");
  return `${neg ? "-" : ""}${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

/**
 * The fee actually charged on what was received: pro rata on a partial payment, capped at `fee_total` on an
 * overpayment. Equal to the quote when paid exactly.
 */
export function chargedFees(p: Pick<PaymentRow, "amount_due" | "amount_paid" | "fee_total" | "platform_fee">): { fee: bigint; platform: bigint; method: bigint; net: bigint } {
  const due = BigInt(p.amount_due);
  const paid = BigInt(p.amount_paid);
  const total = BigInt(p.fee_total);
  let fee = due === 0n || paid === 0n ? 0n : (paid * total) / due;
  if (fee > total) fee = total;
  const platform = total === 0n ? 0n : (fee * BigInt(p.platform_fee)) / total;
  return { fee, platform, method: fee - platform, net: paid - fee };
}

/** One RFC 4180 cell with formulas neutralized (shared with the dashboard's demo data). */
export const csvCell = reportCsvCell;

type Range = { merchantId: string; from: string; to: string };
const IN_RANGE = "p.merchant_id = ? AND p.draft = 0 AND p.created_at >= ? AND p.created_at < ?";

/**
 * The reconciliation report (docs/GATEWAY.md section 16): one row per payment created in the range, with its fee
 * lines, net, refunds, on-chain transactions, clearing batch and receipt proofs, and screening refusals, and
 * totals. Read only; every figure comes from the same rows the payment API serves.
 */
export class ReconciliationReports {
  readonly #g: Gateway;
  readonly #publicUrl: string;

  constructor(g: Gateway, publicUrl: string) {
    this.#g = g;
    this.#publicUrl = publicUrl.replace(/\/+$/, "");
  }

  build(m: MerchantRow, range: ReportRange): ReconciliationReport {
    const g = this.#g;
    const db = g.db;
    const r: Range = { merchantId: m.id, from: range.from, to: range.to };
    const args = [r.merchantId, r.from, r.to] as const;
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payments p WHERE ${IN_RANGE}`, ...args)!.n;
    if (n > REPORT_MAX_ROWS) throw new ApiError(400, "REPORT_TOO_LARGE", `more than ${REPORT_MAX_ROWS} payments in this range; ask for a shorter one`, { payments: n });
    // Synchronous reads with no await in between, so rows, refunds and the ledger check describe the same moment.
    const payments = db.all<PaymentRow & Record<string, unknown>>(`SELECT p.* FROM payments p WHERE ${IN_RANGE} ORDER BY p.created_at, p.rowid`, ...args);
    const credits = group(
      db.all<CreditRow & { batch_tx: string | null }>(
        `SELECT c.*, b.tx_hash AS batch_tx FROM payment_credits c JOIN payments p ON p.id = c.payment_id LEFT JOIN batches b ON b.batch_id = c.batch_id
         WHERE ${IN_RANGE} ORDER BY c.id`,
        ...args,
      ),
    );
    const refunds = group(db.all<RefundRow>(`SELECT f.* FROM refunds f JOIN payments p ON p.id = f.payment_id WHERE ${IN_RANGE} ORDER BY f.created_at, f.rowid`, ...args));
    const screened = group(
      db.all<{ payment_id: string; rule: string }>(
        `SELECT d.payment_id, d.rule FROM screening_decisions d JOIN payments p ON p.id = d.payment_id WHERE ${IN_RANGE} ORDER BY d.seq`,
        ...args,
      ),
    );
    const rows = payments.map((p) => this.#row(p, credits.get(p.id) ?? [], refunds.get(p.id) ?? [], screened.get(p.id) ?? []));
    return {
      object: "reconciliation_report",
      merchant_id: m.id,
      business_name: m.name,
      from: r.from,
      to: r.to,
      generated_at: nowIso(),
      network: g.network,
      livemode: g.ctx.livemode,
      token: { address: g.token.address, symbol: g.token.symbol, decimals: g.token.decimals },
      ...this.#totals(rows),
      ledger: this.#ledger(r),
      rows,
    };
  }

  #amounts<K extends string>(v: Record<K, bigint>): ReportAmounts<K> {
    const d = this.#g.token.decimals;
    const out = { base_units: {} } as ReportAmounts<K>;
    for (const [k, x] of Object.entries(v) as Array<[K, bigint]>) {
      (out as Record<K, string>)[k] = decimalOf(x, d);
      out.base_units[k] = x.toString();
    }
    return out;
  }

  #row(p: PaymentRow & Record<string, unknown>, credits: Array<CreditRow & { batch_tx: string | null }>, refunds: RefundRow[], rules: Array<{ rule: string }>): ReconciliationRow {
    const g = this.#g;
    const d = g.token.decimals;
    const fees = chargedFees(p);
    const refunded = sum(refunds.filter((f) => f.status === "succeeded"));
    const pending = sum(refunds.filter((f) => f.status === "pending"));
    const amounts: Record<ReportAmountField, bigint> = {
      amount: BigInt(p.amount),
      surcharge: BigInt(p.surcharge),
      amount_due: BigInt(p.amount_due),
      amount_paid: BigInt(p.amount_paid),
      platform_fee: fees.platform,
      method_fee: fees.method,
      fee_total: fees.fee,
      net_amount: fees.net,
      refunded,
      refunds_pending: pending,
      // Fees are not returned on refunds, so a full refund leaves this at minus the fee.
      net_after_refunds: fees.net - refunded,
    };
    const batchIds = [...new Set(credits.map((c) => c.batch_id).filter((b): b is string => !!b))];
    return {
      payment_id: p.id,
      reference: p.reference,
      link_id: p.link_id,
      description: p.description,
      created_at: p.created_at,
      paid_at: p.paid_at,
      status: p.status as PaymentStatus,
      method: (p.quote_method ?? p.method ?? null) as string | null,
      payer: p.payer as string | null,
      currency: g.token.symbol,
      ...this.#amounts(amounts),
      refunds: refunds.map((f) => ({
        id: f.id,
        amount: decimalOf(BigInt(f.amount), d),
        amount_base_units: f.amount,
        status: f.status,
        approval: f.approval ?? "not_required",
        tx_hash: f.tx_hash,
        explorer_url: f.tx_hash ? explorerTx(g.network, f.tx_hash) : null,
        created_at: f.created_at,
      })),
      transactions: credits.map((c) => {
        const tx = c.tx_hash ?? c.batch_tx ?? null;
        return {
          method: c.method as string,
          amount: decimalOf(BigInt(c.amount), d),
          amount_base_units: c.amount,
          status: c.status,
          tx_hash: tx,
          explorer_url: tx ? explorerTx(g.network, tx) : null,
          batch_id: c.batch_id,
          call_id: c.call_id,
          receipt_proof_url: c.call_id && this.#publicUrl ? `${this.#publicUrl}/v1/receipts/${c.call_id}/proof` : null,
        };
      }),
      batch_ids: batchIds,
      proof_url: p.status === "paid" || p.status === "overpaid" ? `${g.ctx.checkoutBaseUrl}/receipt/${p.id}` : null,
      screening_rules: [...new Set(rules.map((x) => x.rule))],
    };
  }

  #totals(rows: ReconciliationRow[]): Pick<ReconciliationReport, "totals" | "counts" | "by_method"> {
    const zero = (): Record<ReportTotalField, bigint> => Object.fromEntries(REPORT_TOTAL_FIELDS.map((k) => [k, 0n])) as Record<ReportTotalField, bigint>;
    const t = zero();
    const counts: Record<string, number> = {};
    const methods = new Map<string, { payments: number; gross: bigint; fees: bigint; net: bigint; refunds: bigint }>();
    for (const row of rows) {
      const b = (k: ReportAmountField) => BigInt(row.base_units[k]);
      t.gross += b("amount_paid");
      t.platform_fee += b("platform_fee");
      t.method_fee += b("method_fee");
      t.fees += b("fee_total");
      t.net += b("net_amount");
      t.refunds += b("refunded");
      t.refunds_pending += b("refunds_pending");
      t.net_after_refunds += b("net_after_refunds");
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      // A payment with no method yet has received nothing, so it adds nothing to any method.
      if (!row.method) continue;
      const key = row.method;
      const m = methods.get(key) ?? { payments: 0, gross: 0n, fees: 0n, net: 0n, refunds: 0n };
      m.payments += 1;
      m.gross += b("amount_paid");
      m.fees += b("fee_total");
      m.net += b("net_amount");
      m.refunds += b("refunded");
      methods.set(key, m);
    }
    return {
      totals: { payments: rows.length, ...this.#amounts(t) },
      counts,
      by_method: Object.fromEntries([...methods].map(([k, { payments, ...v }]) => [k, { payments, ...this.#amounts(v) }])),
    };
  }

  /** Agent charges of the range (voucher credits) against the call.accepted journals the clearing ledger booked for them. */
  #ledger(r: Range): ReconciliationReport["ledger"] {
    const db = this.#g.db;
    const args = [r.merchantId, r.from, r.to] as const;
    const charges = db.get<{ n: number; s: string }>(
      `SELECT COUNT(*) AS n, bigsum(c.amount) AS s FROM payment_credits c JOIN payments p ON p.id = c.payment_id WHERE c.call_id IS NOT NULL AND ${IN_RANGE}`,
      ...args,
    )!;
    const accepted = db.get<{ s: string }>(
      `SELECT bigsum(e.debit) AS s FROM ledger_entries e JOIN journals j ON j.id = e.journal_id
       WHERE j.kind = 'call.accepted' AND j.ref IN (SELECT c.call_id FROM payment_credits c JOIN payments p ON p.id = c.payment_id WHERE c.call_id IS NOT NULL AND ${IN_RANGE})`,
      ...args,
    )!.s;
    const d = this.#g.token.decimals;
    return {
      calls: charges.n,
      charges: decimalOf(BigInt(charges.s), d),
      ledger_accepted: decimalOf(BigInt(accepted), d),
      base_units: { charges: charges.s, ledger_accepted: accepted },
      matches: charges.s === accepted,
    };
  }

  csv(report: ReconciliationReport): string {
    const lines = [REPORT_CSV_COLUMNS.map(csvCell).join(",")];
    const join = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).join(" ");
    for (const row of report.rows) {
      const live = row.refunds.filter((f) => f.status === "succeeded" || f.status === "pending");
      const cells: Record<ReportCsvColumn, string | null> = {
        payment_id: row.payment_id,
        reference: row.reference,
        link_id: row.link_id,
        description: row.description,
        created_at: row.created_at,
        paid_at: row.paid_at,
        status: row.status,
        method: row.method,
        payer: row.payer,
        currency: row.currency,
        ...(Object.fromEntries(REPORT_AMOUNT_FIELDS.map((k) => [k, row[k]])) as Record<ReportAmountField, string>),
        refund_ids: join(live.map((f) => f.id)),
        tx_hashes: join([...new Set(row.transactions.map((x) => x.tx_hash))]),
        explorer_urls: join([...new Set(row.transactions.map((x) => x.explorer_url))]),
        batch_ids: join(row.batch_ids),
        receipt_proof_urls: join(row.transactions.map((x) => x.receipt_proof_url)),
        proof_url: row.proof_url,
        screening_rules: join(row.screening_rules),
      };
      lines.push(REPORT_CSV_COLUMNS.map((k) => csvCell(cells[k])).join(","));
    }
    // The totals row: money columns only (prices of unpaid payments are not money received).
    const t = report.totals;
    const total: Partial<Record<ReportCsvColumn, string>> = {
      payment_id: "TOTAL",
      description: `${t.payments} payments from ${report.from} to ${report.to}`,
      currency: report.token.symbol,
      amount_paid: t.gross,
      platform_fee: t.platform_fee,
      method_fee: t.method_fee,
      fee_total: t.fees,
      net_amount: t.net,
      refunded: t.refunds,
      refunds_pending: t.refunds_pending,
      net_after_refunds: t.net_after_refunds,
    };
    lines.push(REPORT_CSV_COLUMNS.map((k) => csvCell(total[k] ?? null)).join(","));
    return lines.join("\r\n") + "\r\n";
  }
}

function group<T extends { payment_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.payment_id);
    if (list) list.push(r);
    else out.set(r.payment_id, [r]);
  }
  return out;
}

function sum(rows: Array<{ amount: string }>): bigint {
  return rows.reduce((a, r) => a + BigInt(r.amount), 0n);
}

/**
 * `GET /v1/reports/reconciliation?from=&to=&format=json|csv` for the business the request acts on (API key, or a
 * session with the business selected by `Merchant-Id` or `merchant_id`), with `payments.read`: Viewers may read it.
 */
export function mountReports(app: Hono<any>, g: Gateway, d: { access: Access; publicUrl: string }): void {
  const reports = new ReconciliationReports(g, d.publicUrl);
  app.get("/v1/reports/reconciliation", (c) => {
    const { merchant } = d.access.business(c, "payments.read", c.req.query("merchant_id") || undefined);
    const format = c.req.query("format") || "json";
    if (format !== "json" && format !== "csv") throw new ApiError(400, "VALIDATION_ERROR", "format must be json or csv", { issues: [{ path: "format", message: "json or csv" }] });
    const report = reports.build(merchant, parseReportRange(c.req.query("from"), c.req.query("to")));
    if (format === "json") return c.json(report);
    const day = (iso: string) => iso.slice(0, 10);
    const lastDay = day(new Date(Date.parse(report.to) - 1).toISOString());
    const name = `payminto-reconciliation-${merchant.slug}-${day(report.from)}-to-${lastDay}.csv`.replace(/[^A-Za-z0-9._-]/g, "-");
    return c.body(reports.csv(report), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` });
  });
}
