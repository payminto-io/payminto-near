import { describe, expect, it } from "vitest";
import { businessesByFees, earningsCsv, earningsCsvFilename, monthLabel, monthsFromDays, monthsFromRows, rowsFromBusinesses } from "@/lib/earnings";
import type { FeeMonth } from "@/lib/platform-schemas";

const row = (month: string, merchant_id: string, fee_total: string, o: Partial<FeeMonth> = {}): FeeMonth => ({
  month,
  merchant_id,
  merchant_name: merchant_id === "mer_a" ? "Acme" : "Beta, Inc.",
  payments: 1,
  volume: "10000000",
  platform_fee: fee_total,
  method_fee: "0",
  fee_total,
  ...o,
});

describe("monthsFromRows", () => {
  it("adds every business into its month, newest month first", () => {
    const out = monthsFromRows([row("2026-10", "mer_a", "100000"), row("2026-11", "mer_a", "250000", { payments: 3 }), row("2026-11", "mer_b", "50000", { method_fee: "10000", platform_fee: "40000" })]);
    expect(out).toEqual([
      { month: "2026-11", payments: 4, volume: "20000000", platform_fee: "290000", method_fee: "10000", fee_total: "300000" },
      { month: "2026-10", payments: 1, volume: "10000000", platform_fee: "100000", method_fee: "0", fee_total: "100000" },
    ]);
  });
  it("is empty with no rows", () => {
    expect(monthsFromRows([])).toEqual([]);
  });
});

describe("monthsFromDays (an older server: the last 30 days only)", () => {
  it("groups the days by month and drops empty months", () => {
    expect(
      monthsFromDays([
        { day: "2026-10-30", fees: "1000" },
        { day: "2026-10-31", fees: "0" },
        { day: "2026-11-01", fees: "2500" },
        { day: "2026-11-02", fees: "500" },
      ]),
    ).toEqual([
      { month: "2026-11", payments: null, volume: null, platform_fee: null, method_fee: null, fee_total: "3000" },
      { month: "2026-10", payments: null, volume: null, platform_fee: null, method_fee: null, fee_total: "1000" },
    ]);
    expect(monthsFromDays([{ day: "2026-11-01", fees: "0" }])).toEqual([]);
  });
});

describe("businessesByFees", () => {
  it("ranks businesses by fees with each one's share of the total", () => {
    const out = businessesByFees([
      { merchant_id: "mer_a", name: "Acme", volume: "1", fees: "250", payments: 1 },
      { merchant_id: "mer_b", name: "Beta", volume: "1", fees: "750", payments: 2 },
      { merchant_id: "mer_c", name: "Zero", volume: "0", fees: "0", payments: 0 },
    ]);
    expect(out.map((b) => [b.merchant_id, b.share])).toEqual([
      ["mer_b", 75],
      ["mer_a", 25],
      ["mer_c", 0],
    ]);
  });
});

describe("earningsCsv", () => {
  it("writes one quoted line per business and month, in decimal and base units, with a TOTAL line", () => {
    const csv = earningsCsv([row("2026-11", "mer_b", "50000"), row("2026-11", "mer_a", "250000")], { symbol: "USDC", decimals: 6 });
    expect(csv.split("\r\n")).toEqual([
      '"month","business_id","business","payments","currency","volume","platform_fee","method_fee","fee_total","volume_base_units","platform_fee_base_units","method_fee_base_units","fee_total_base_units"',
      '"2026-11","mer_b","Beta, Inc.","1","USDC","10.000000","0.050000","0.000000","0.050000","10000000","50000","0","50000"',
      '"2026-11","mer_a","Acme","1","USDC","10.000000","0.250000","0.000000","0.250000","10000000","250000","0","250000"',
      '"TOTAL","","2 lines","2","USDC","20.000000","0.300000","0.000000","0.300000","20000000","300000","0","300000"',
      "",
    ]);
  });
  it("defuses a business name that a spreadsheet would run as a formula", () => {
    expect(earningsCsv([row("2026-11", "mer_x", "1", { merchant_name: "=HYPERLINK(1)" })], { symbol: "USDC", decimals: 6 })).toContain(`"'=HYPERLINK(1)"`);
  });
  it("names the file by the day it was made", () => {
    expect(earningsCsvFilename(new Date(2026, 10, 13))).toBe("payminto-earnings-2026-11-13.csv");
  });
});

describe("monthLabel", () => {
  it("reads a month in words", () => {
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
  });
});

describe("earningsCsv without the monthly route", () => {
  it("leaves the month and the fee split blank rather than guessing", () => {
    const csv = earningsCsv(rowsFromBusinesses([{ merchant_id: "mer_a", name: "Acme", volume: "5000000", fees: "50000", payments: 2 }]), { symbol: "USDC", decimals: 6 });
    expect(csv.split("\r\n")[1]).toBe('"","mer_a","Acme","2","USDC","5.000000","","","0.050000","5000000","","","50000"');
    expect(csv.split("\r\n")[2]).toBe('"TOTAL","","1 line","2","USDC","5.000000","","","0.050000","5000000","","","50000"');
  });
});
