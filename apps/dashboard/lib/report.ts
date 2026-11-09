/**
 * The reconciliation report download (docs/GATEWAY.md section 16): date ranges as the person picks them, in their own
 * time zone, turned into the exact instants the server reports on.
 */

/** Calendar dates as `<input type="date">` gives them (YYYY-MM-DD, local). `to` is inclusive. */
export type ReportDates = { from: string; to: string };

/** The longest range the server reports on in one go. */
export const REPORT_MAX_DAYS = 366;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** From the 1st of this month to today, local. */
export function thisMonth(now = new Date()): ReportDates {
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
}

function localMidnight(date: string, plusDays = 0): Date | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A plain sentence when the dates cannot make a report, else null. */
export function reportDatesProblem(r: ReportDates): string | null {
  const from = localMidnight(r.from);
  const to = localMidnight(r.to, 1);
  if (!from || !to) return "Pick a start and an end date.";
  if (to <= from) return "The end date is before the start date.";
  if (to.getTime() - from.getTime() > (REPORT_MAX_DAYS + 1) * 86_400_000) return `A report covers at most ${REPORT_MAX_DAYS} days. Pick a shorter range.`;
  return null;
}

/** The instants the server reports on: local midnight of `from` up to local midnight after `to`. */
export function reportWindow(r: ReportDates): { from: string; to: string } {
  const from = localMidnight(r.from);
  const to = localMidnight(r.to, 1);
  if (!from || !to) throw new Error("invalid report dates");
  return { from: from.toISOString(), to: to.toISOString() };
}

export function reportFilename(r: ReportDates, business?: string | null): string {
  const slug = (business ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `payminto-report-${slug ? `${slug}-` : ""}${r.from}-to-${r.to}.csv`;
}

/** Hands the browser a file to save. */
export function saveFile(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers read the blob after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
