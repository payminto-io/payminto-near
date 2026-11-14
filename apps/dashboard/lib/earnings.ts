/**
 * The platform owner's Earnings: fees by month and by business, and the CSV export in the reconciliation report's
 * style (quoted cells, decimal amounts next to base units, a TOTAL line, CRLF). Pure, so the grouping is unit tested.
 */
import { reportCsvCell } from "@payminto/protocol";
import type { FeeMonth } from "./platform-schemas";
import type { PlatformFees } from "./schemas";

/** One month of fees. Figures other than `fee_total` are null when only the 30-day daily series was available. */
export type MonthTotal = { month: string; payments: number | null; volume: string | null; platform_fee: string | null; method_fee: string | null; fee_total: string };

const add = (a: string, b: string) => (BigInt(a) + BigInt(b)).toString();

export function monthsFromRows(rows: readonly FeeMonth[]): MonthTotal[] {
  const by = new Map<string, { month: string; payments: number; volume: string; platform_fee: string; method_fee: string; fee_total: string }>();
  for (const r of rows) {
    const m = by.get(r.month) ?? { month: r.month, payments: 0, volume: "0", platform_fee: "0", method_fee: "0", fee_total: "0" };
    by.set(r.month, {
      month: r.month,
      payments: m.payments + r.payments,
      volume: add(m.volume, r.volume),
      platform_fee: add(m.platform_fee, r.platform_fee),
      method_fee: add(m.method_fee, r.method_fee),
      fee_total: add(m.fee_total, r.fee_total),
    });
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** From the last 30 days of `GET /v1/platform/fees`, for a server without the monthly route. */
export function monthsFromDays(days: readonly { day: string; fees: string }[]): MonthTotal[] {
  const by = new Map<string, bigint>();
  for (const d of days) by.set(d.day.slice(0, 7), (by.get(d.day.slice(0, 7)) ?? 0n) + BigInt(d.fees));
  return [...by.entries()]
    .filter(([, v]) => v > 0n)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([month, v]) => ({ month, payments: null, volume: null, platform_fee: null, method_fee: null, fee_total: v.toString() }));
}

export type BusinessFees = PlatformFees["by_merchant"][number] & { share: number };

/** Businesses by fees earned, most first, each with its whole-percent share of all fees. */
export function businessesByFees(rows: PlatformFees["by_merchant"]): BusinessFees[] {
  const total = rows.reduce((a, r) => a + BigInt(r.fees), 0n);
  return [...rows]
    .sort((a, b) => (BigInt(b.fees) > BigInt(a.fees) ? 1 : BigInt(b.fees) < BigInt(a.fees) ? -1 : a.name.localeCompare(b.name)))
    .map((r) => ({ ...r, share: total > 0n ? Number((BigInt(r.fees) * 100n) / total) : 0 }));
}

/** Base units as a decimal with exactly `decimals` places, as the reconciliation report writes them. */
function decimalOf(v: string, decimals: number): string {
  const n = BigInt(v);
  const neg = n < 0n;
  const s = (neg ? -n : n).toString();
  if (decimals === 0) return `${neg ? "-" : ""}${s}`;
  const padded = s.padStart(decimals + 1, "0");
  return `${neg ? "-" : ""}${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

const MONEY = ["volume", "platform_fee", "method_fee", "fee_total"] as const;
type MoneyKey = (typeof MONEY)[number];
export const EARNINGS_CSV_COLUMNS = ["month", "business_id", "business", "payments", "currency", ...MONEY, ...MONEY.map((k) => `${k}_base_units` as const)] as const;

/** A line of the export. The platform and method split is null when the server did not report it. */
export type EarningsRow = Omit<FeeMonth, "platform_fee" | "method_fee"> & { platform_fee: string | null; method_fee: string | null };

/** One line per business and month, then a TOTAL line. */
export function earningsCsv(rows: readonly EarningsRow[], token: { symbol: string; decimals: number }): string {
  const line = (cells: (string | number | null)[]) => cells.map((c) => reportCsvCell(c)).join(",");
  const money = (r: Record<MoneyKey, string | null>) => [...MONEY.map((k) => (r[k] === null ? null : decimalOf(r[k], token.decimals))), ...MONEY.map((k) => r[k])];
  const lines = [line([...EARNINGS_CSV_COLUMNS])];
  const total: Record<MoneyKey, string | null> = { volume: "0", platform_fee: "0", method_fee: "0", fee_total: "0" };
  let payments = 0;
  for (const r of rows) {
    lines.push(line([r.month, r.merchant_id, r.merchant_name, r.payments, token.symbol, ...money(r)]));
    for (const k of MONEY) {
      const v = r[k];
      total[k] = total[k] === null || v === null ? null : add(total[k], v);
    }
    payments += r.payments;
  }
  lines.push(line(["TOTAL", "", `${rows.length} ${rows.length === 1 ? "line" : "lines"}`, payments, token.symbol, ...money(total)]));
  return lines.join("\r\n") + "\r\n";
}

/** Lines from all-time totals per business, for a server without the monthly route: no month, no fee split. */
export function rowsFromBusinesses(rows: PlatformFees["by_merchant"]): EarningsRow[] {
  return rows.map((r) => ({ month: "", merchant_id: r.merchant_id, merchant_name: r.name, payments: r.payments, volume: r.volume, platform_fee: null, method_fee: null, fee_total: r.fees }));
}

const pad = (n: number) => String(n).padStart(2, "0");
export function earningsCsvFilename(now = new Date()): string {
  return `payminto-earnings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}

/** "2026-11" as "November 2026"; the month is a UTC month, so it is read in UTC. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
