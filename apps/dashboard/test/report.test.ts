import { describe, expect, it } from "vitest";
import { REPORT_CSV_COLUMNS } from "@payminto/protocol";
import { MockGatewayApi } from "@/lib/mock/gateway";
import { reportDatesProblem, reportFilename, reportWindow, thisMonth } from "@/lib/report";

describe("report dates", () => {
  it("defaults to this month so far, local", () => {
    expect(thisMonth(new Date(2026, 9, 17, 15, 30))).toEqual({ from: "2026-10-01", to: "2026-10-17" });
    expect(thisMonth(new Date(2026, 0, 1, 0, 5))).toEqual({ from: "2026-01-01", to: "2026-01-01" });
  });

  it("turns local days into the instants the server reports on, both days included", () => {
    const w = reportWindow({ from: "2026-10-01", to: "2026-10-31" });
    expect(new Date(w.from).getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(new Date(w.to).getTime()).toBe(new Date(2026, 10, 1).getTime());
    expect(reportWindow({ from: "2026-10-05", to: "2026-10-05" }).to).toBe(new Date(2026, 9, 6).toISOString());
  });

  it("says in plain words when a range cannot make a report", () => {
    expect(reportDatesProblem({ from: "2026-10-01", to: "2026-10-31" })).toBeNull();
    expect(reportDatesProblem({ from: "", to: "2026-10-31" })).toBe("Pick a start and an end date.");
    expect(reportDatesProblem({ from: "2026-10-10", to: "2026-10-01" })).toBe("The end date is before the start date.");
    expect(reportDatesProblem({ from: "2025-01-01", to: "2026-06-01" })).toMatch(/^A report covers at most 366 days/);
  });

  it("names the file after the business and the days", () => {
    expect(reportFilename({ from: "2026-10-01", to: "2026-10-31" }, "Northwind Data")).toBe("payminto-report-northwind-data-2026-10-01-to-2026-10-31.csv");
    expect(reportFilename({ from: "2026-10-01", to: "2026-10-31" })).toBe("payminto-report-2026-10-01-to-2026-10-31.csv");
  });
});

describe("mock report", () => {
  it("has the server's columns, one line per payment in the range and a totals line that adds up", async () => {
    const csv = await new MockGatewayApi().reconciliationCsv({ from: new Date(Date.now() - 400 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(REPORT_CSV_COLUMNS.map((c) => `"${c}"`).join(","));
    const total = lines[lines.length - 1]!;
    expect(total.startsWith('"TOTAL"')).toBe(true);
    const cell = (line: string, name: string) => line.split('","')[REPORT_CSV_COLUMNS.indexOf(name as never)]!.replace(/^"|"$/g, "");
    // Rows without embedded commas in quoted text are enough to check the sum.
    const rows = lines.slice(1, -1).filter((l) => l.split('","').length === REPORT_CSV_COLUMNS.length);
    expect(rows.length).toBeGreaterThan(10);
    const gross = Number(cell(total, "amount_paid"));
    const fees = Number(cell(total, "fee_total"));
    const net = Number(cell(total, "net_amount"));
    expect(Math.abs(gross - fees - net)).toBeLessThan(1e-6);
  });
});
