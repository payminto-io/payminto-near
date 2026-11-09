import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { aggregateObligations, beforeAfter, layoutFlow, netPositions, netTransfers, sumAmounts } from "@/lib/netting";

const A = getAddress("0x00000000000000000000000000000000000000a1"); // Treasury Agent
const B = getAddress("0x00000000000000000000000000000000000000b2"); // Trading Agent
const MD = getAddress("0x00000000000000000000000000000000000000d1"); // Market Data
const RS = getAddress("0x00000000000000000000000000000000000000d2"); // Risk Scan
const RW = getAddress("0x00000000000000000000000000000000000000d3"); // Research Writer, buys and sells

const gross = [
  { from: A, to: RW, amount: "500000", calls: 10 },
  { from: A, to: MD, amount: "40000", calls: 20 },
  { from: RW, to: MD, amount: "300000", calls: 150 },
  { from: RW, to: RS, amount: "200000", calls: 20 },
  { from: B, to: MD, amount: "60000", calls: 30 },
];

describe("netting projection", () => {
  it("conserves value: every net position sums to zero", () => {
    const pos = netPositions(gross);
    expect(pos.reduce((s, p) => s + p.balance, 0n)).toBe(0n);
  });

  it("cancels a party that is owed exactly what it owes", () => {
    const pos = new Map(netPositions(gross).map((p) => [p.party, p.balance]));
    expect(pos.get(RW)).toBe(0n);
    expect(netTransfers(gross).some((t) => t.from === RW || t.to === RW)).toBe(false);
  });

  it("matches the hub's greedy two-pointer result", () => {
    // Parties in first-seen order: A(-540000) RW(0) MD(+400000) RS(+200000) B(-60000)
    expect(netTransfers(gross)).toEqual([
      { from: A, to: MD, amount: "400000" },
      { from: A, to: RS, amount: "140000" },
      { from: B, to: RS, amount: "60000" },
    ]);
  });

  it("moves less than gross and never more transfers than parties minus one", () => {
    const net = netTransfers(gross);
    expect(sumAmounts(net)).toBe(600000n);
    expect(sumAmounts(gross)).toBe(1100000n);
    expect(net.length).toBeLessThanOrEqual(netPositions(gross).length - 1);
  });

  it("aggregates per-call obligations into one edge per pair", () => {
    const calls = [
      { from: A, to: MD, amount: "2000" },
      { from: A.toLowerCase(), to: MD, amount: "2000" },
      { from: A, to: RS, amount: "10000" },
    ];
    const agg = aggregateObligations(calls);
    expect(agg).toHaveLength(2);
    expect(agg[0]).toEqual({ from: A, to: MD, amount: "4000", calls: 2 });
  });
});

describe("flow graph layout", () => {
  const layout = layoutFlow(gross, { width: 400, nodeWidth: 8 });

  it("puts payers left and payees right, with the dual party on both sides", () => {
    const payers = layout.nodes.filter((n) => n.side === "payer").map((n) => n.address);
    const payees = layout.nodes.filter((n) => n.side === "payee").map((n) => n.address);
    expect(new Set(payers)).toEqual(new Set([A, B, RW]));
    expect(new Set(payees)).toEqual(new Set([MD, RS, RW]));
    expect(layout.nodes.filter((n) => n.dual).map((n) => n.address)).toEqual([RW, RW]);
    for (const n of layout.nodes) expect(n.x).toBe(n.side === "payer" ? 0 : 392);
  });

  it("orders nodes by total flow, largest first", () => {
    const payers = layout.nodes.filter((n) => n.side === "payer");
    for (let i = 1; i < payers.length; i++) expect(payers[i - 1]!.total >= payers[i]!.total).toBe(true);
  });

  it("keeps every node and ribbon inside the drawing", () => {
    for (const n of layout.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height + 0.001);
    }
    for (const l of layout.links) {
      expect(l.path.startsWith("M8,")).toBe(true);
      expect(l.path.endsWith("Z")).toBe(true);
    }
  });

  it("gives each obligation one ribbon whose thickness follows its amount", () => {
    expect(layout.links).toHaveLength(gross.length);
    const big = layout.links.find((l) => l.from === A && l.to === RW)!;
    const small = layout.links.find((l) => l.from === A && l.to === MD)!;
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.calls).toBe(10);
  });

  it("handles no obligations", () => {
    const empty = layoutFlow([], { width: 300 });
    expect(empty.nodes).toEqual([]);
    expect(empty.links).toEqual([]);
  });
});

describe("beforeAfter", () => {
  it("compares one transfer per call with the net transfers", () => {
    const net = netTransfers(gross);
    const r = beforeAfter({ gross, net });
    expect(r.before.transfers).toBe(230);
    expect(r.before.amount).toBe(1_100_000n);
    expect(r.after.transfers).toBe(net.length);
    expect(r.after.amount).toBe(sumAmounts(net));
    expect(r.fewer).toBeCloseTo(230 / net.length);
    expect(r.valueSavedPct).toBeGreaterThan(0);
    expect(r.valueSavedPct).toBeLessThan(100);
  });

  it("prefers the node's totals and handles an empty preview", () => {
    expect(beforeAfter({ gross: [], net: [], calls: 0 })).toEqual({
      before: { transfers: 0, amount: 0n },
      after: { transfers: 0, amount: 0n },
      fewer: 0,
      valueSavedPct: 0,
    });
    const r = beforeAfter({ gross: [{ amount: "1", calls: 1 }], net: [{ amount: "1" }], grossTotal: "1000", netTotal: "250", calls: 143 });
    expect(r.before).toEqual({ transfers: 143, amount: 1000n });
    expect(r.after.amount).toBe(250n);
    expect(r.valueSavedPct).toBe(75);
  });
});
