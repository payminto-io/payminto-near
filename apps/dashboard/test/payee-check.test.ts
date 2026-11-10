import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pc from "@payminto/payee-check";
import { NEAR_TESTNET_USDC } from "@payminto/protocol";
import { PayeeCheckUnavailable, PayeeGate, confirmationFor, covers, readPayeeWith, typedIdMatches, type PayeeCheckSetup, type PayeeReader, type PayeeRow } from "@/lib/payee-check";
import { DEMO_MISSING_EXAMPLE, DEMO_PAYEES, demoPayeeSources } from "@/lib/mock/payee-check";

const TOKEN = NEAR_TESTNET_USDC;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const P = DEMO_PAYEES;

/** The demo sources with no latency: the package's fakes, so nothing here can reach a network. */
async function demoSetup(): Promise<PayeeCheckSetup> {
  return { pc, sources: await demoPayeeSources(TOKEN, { latencyMs: 0, nowMs: NOW }), from: "test data", demo: true, missing: null };
}

async function judge(payee: string, budgetPayees: string[] = [], setup?: PayeeCheckSetup) {
  return (await readPayeeWith(setup ?? (await demoSetup()), { payee, payer: "treasury.testnet" })).judge(budgetPayees);
}

const ids = (r: { verdict: pc.Verdict }, severity: pc.Severity) => r.verdict.signals.filter((s) => s.severity === severity).map((s) => s.id);

let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("tests never touch the network")));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  globalThis.fetch = realFetch;
});

describe("demo payees (mock mode seeding)", () => {
  it("clears the two long-standing demo Payees", async () => {
    for (const payee of [P.marketData, P.riskScan]) {
      const r = await judge(payee, [P.researchWriter]);
      expect(r.verdict.verdict, payee).toBe("allow");
      expect(r.view.headline).toBe("No concerns found");
      expect(r.failed).toBe(false);
      expect(r.demo).toBe(true);
    }
    expect((await judge(P.riskScan)).verdict.signals.map((s) => s.id)).toContain("has_contract");
  });

  it("asks a person about a new account, an unregistered one and one report", async () => {
    const fresh = await judge(P.researchWriter, [P.marketData]);
    expect(fresh.verdict.verdict).toBe("warn");
    expect(ids(fresh, "warn")).toEqual(["new_account"]);
    expect(fresh.view.headline).toBe("Ask a person first");

    const unregistered = await judge(P.unregistered);
    expect(unregistered.verdict.verdict).toBe("warn");
    expect(ids(unregistered, "warn")).toEqual(["token_unregistered"]);

    const reportedOnce = await judge(P.reportedOnce);
    expect(reportedOnce.verdict.verdict).toBe("warn");
    expect(ids(reportedOnce, "warn")).toEqual(["reported"]);
    expect(reportedOnce.view.reports).toHaveLength(1);
  });

  it("blocks a lookalike of a Payee in the Budget, and only then", async () => {
    const alone = await judge(P.lookalike);
    expect(alone.verdict.verdict).toBe("warn");
    const beside = await judge(P.lookalike, [P.marketData, P.riskScan]);
    expect(beside.verdict.verdict).toBe("block");
    expect(ids(beside, "block")).toEqual(["lookalike_payee"]);
    expect(beside.view.headline).toBe("Do not pay");
    expect(beside.view.signals[0]?.reason).toContain(P.marketData);
    expect(beside.against).toEqual([P.marketData, P.riskScan]);
  });

  it("blocks an account that does not exist and one reported by three parties", async () => {
    const missing = await judge(DEMO_MISSING_EXAMPLE);
    expect(missing.verdict.verdict).toBe("block");
    expect(ids(missing, "block")).toEqual(["account_missing"]);
    expect(missing.failed).toBe(false);

    const reported = await judge(P.reported);
    expect(reported.verdict.verdict).toBe("block");
    expect(ids(reported, "block")).toEqual(["reported_by_several"]);
    expect(reported.view.reports.map((r) => r.reporter).sort()).toEqual(["northwind-ops.testnet", "ops-lead.testnet", "trading-desk.testnet"]);
    // Report text never reaches a signal reason: it stays apart, as a quote.
    for (const s of reported.verdict.signals) for (const r of reported.view.reports) expect(s.reason).not.toContain(r.quote);
  });

  it("turns a read that fails into the package's own block, and succeeds on the next try", async () => {
    const setup = await demoSetup();
    const first = await judge(P.failsOnce, [], setup);
    expect(first.verdict.verdict).toBe("block");
    expect(ids(first, "block")).toEqual(["check_failed"]);
    expect(first.failed).toBe(true);
    const second = await judge(P.failsOnce, [], setup);
    expect(second.verdict.verdict).toBe("allow");
  });

  it("never compares a Payee with itself", async () => {
    const r = await judge(P.marketData, [P.marketData]);
    expect(r.against).toEqual([]);
    expect(r.verdict.verdict).toBe("allow");
  });

  it("blocks when no check can run at all", async () => {
    const r = await judge(P.marketData, [], { pc, sources: null, from: "no NEAR RPC", demo: false, missing: "no NEAR RPC is configured for this network" });
    expect(r.verdict.verdict).toBe("block");
    expect(r.failed).toBe(true);
    expect(r.verdict.signals[0]?.facts.cause).toBe("no NEAR RPC is configured for this network");
  });
});

describe("confirmation rules", () => {
  it("needs nothing on allow, a confirmation on warn and the typed id on block", () => {
    expect(confirmationFor("allow")).toBe("none");
    expect(confirmationFor("warn")).toBe("confirm");
    expect(confirmationFor("block")).toBe("type_id");
  });

  it("accepts only the exact account id", () => {
    expect(typedIdMatches("rnarket-data.testnet", "rnarket-data.testnet")).toBe(true);
    expect(typedIdMatches("rnarket-data.testnet", "  rnarket-data.testnet ")).toBe(true);
    expect(typedIdMatches("rnarket-data.testnet", "market-data.testnet")).toBe(false);
    expect(typedIdMatches("rnarket-data.testnet", "Rnarket-data.testnet")).toBe(false);
    expect(typedIdMatches("rnarket-data.testnet", "rnarket-data.testne")).toBe(false);
    expect(typedIdMatches("rnarket-data.testnet", "")).toBe(false);
  });

  it("never lets a lighter confirmation cover a heavier verdict", () => {
    expect(covers(null, "allow")).toBe(true);
    expect(covers(null, "warn")).toBe(false);
    expect(covers("warn", "warn")).toBe(true);
    expect(covers("warn", "block")).toBe(false);
    expect(covers("block", "warn")).toBe(true);
    expect(covers("block", "block")).toBe(true);
  });
});

describe("PayeeGate", () => {
  async function gateWith(setup?: PayeeCheckSetup) {
    const s = setup ?? (await demoSetup());
    const reads: string[] = [];
    const reader: PayeeReader = (payee) => {
      reads.push(payee);
      return readPayeeWith(s, { payee });
    };
    const gate = new PayeeGate();
    gate.configure(reader);
    return { gate, reads };
  }
  const row = (gate: PayeeGate, payee: string): PayeeRow => gate.rows().find((r) => r.payee === payee)!;
  const added = (gate: PayeeGate) => gate.rows().filter((r) => r.state === "added").map((r) => r.payee);
  const settled = (gate: PayeeGate) => vi.waitFor(() => expect(gate.rows().some((r) => r.state === "checking")).toBe(false));

  it("adds a cleared Payee quietly, and not before its check finishes", async () => {
    const { gate } = await gateWith();
    gate.sync([P.marketData]);
    expect(row(gate, P.marketData).state).toBe("checking");
    expect(added(gate)).toEqual([]);
    await settled(gate);
    expect(row(gate, P.marketData).state).toBe("added");
    expect(added(gate)).toEqual([P.marketData]);
  });

  it("keeps a warned Payee out until the owner confirms", async () => {
    const { gate } = await gateWith();
    gate.sync([P.researchWriter]);
    await settled(gate);
    expect(row(gate, P.researchWriter).state).toBe("needs_confirm");
    expect(added(gate)).toEqual([]);
    expect(gate.confirm(P.researchWriter)).toBe(true);
    expect(row(gate, P.researchWriter).state).toBe("added");
    expect(row(gate, P.researchWriter).acknowledged).toBe("warn");
  });

  it("keeps a blocked Payee out until the owner types its account id exactly", async () => {
    const { gate } = await gateWith();
    gate.sync([P.marketData, P.lookalike]);
    await settled(gate);
    expect(row(gate, P.lookalike).state).toBe("needs_typed_id");
    expect(gate.confirm(P.lookalike)).toBe(false);
    expect(gate.confirm(P.lookalike, P.marketData)).toBe(false);
    expect(gate.confirm(P.lookalike, "rnarket-data.testnet.")).toBe(false);
    expect(added(gate)).toEqual([P.marketData]);
    expect(gate.confirm(P.lookalike, P.lookalike)).toBe(true);
    expect(added(gate)).toEqual([P.marketData, P.lookalike]);
    expect(row(gate, P.lookalike).acknowledged).toBe("block");
  });

  it("judges a waiting Payee again, with no new read, when a Payee it resembles is added", async () => {
    const { gate, reads } = await gateWith();
    gate.sync([P.lookalike]);
    await settled(gate);
    expect(row(gate, P.lookalike).state).toBe("needs_confirm");
    gate.sync([P.lookalike, P.marketData]);
    await settled(gate);
    expect(row(gate, P.marketData).state).toBe("added");
    expect(row(gate, P.lookalike).state).toBe("needs_typed_id");
    expect(row(gate, P.lookalike).result?.against).toEqual([P.marketData]);
    expect(reads.filter((p) => p === P.lookalike)).toHaveLength(1);
  });

  it("flags the later of two lookalikes even when the first was confirmed", async () => {
    const { gate } = await gateWith();
    gate.sync([P.lookalike]);
    await settled(gate);
    expect(gate.confirm(P.lookalike)).toBe(true);
    gate.sync([P.lookalike, P.marketData]);
    await settled(gate);
    // The confirmed Payee keeps the verdict it was added under; the new one is held back.
    expect(row(gate, P.lookalike).state).toBe("added");
    expect(row(gate, P.marketData).state).toBe("needs_typed_id");
    expect(row(gate, P.marketData).result?.view.signals[0]?.id).toBe("lookalike_payee");
  });

  it("shows a failed check as a block and reads again on request", async () => {
    const { gate, reads } = await gateWith();
    gate.sync([P.failsOnce]);
    await settled(gate);
    expect(row(gate, P.failsOnce).state).toBe("needs_typed_id");
    expect(row(gate, P.failsOnce).result?.failed).toBe(true);
    gate.recheck(P.failsOnce);
    expect(row(gate, P.failsOnce).state).toBe("checking");
    await settled(gate);
    expect(row(gate, P.failsOnce).state).toBe("added");
    expect(reads).toEqual([P.failsOnce, P.failsOnce]);
  });

  it("takes an added Payee out of the Budget while it is checked again", async () => {
    const { gate } = await gateWith();
    gate.sync([P.researchWriter]);
    await settled(gate);
    gate.confirm(P.researchWriter);
    gate.recheck(P.researchWriter);
    expect(added(gate)).toEqual([]);
    await settled(gate);
    // The same verdict as the one the owner confirmed: no second confirmation.
    expect(added(gate)).toEqual([P.researchWriter]);
  });

  it("says so when the check could not load, and adds nothing", async () => {
    const gate = new PayeeGate();
    let fail = true;
    const setup = await demoSetup();
    gate.configure((payee) => (fail ? Promise.reject(new PayeeCheckUnavailable()) : readPayeeWith(setup, { payee })));
    gate.sync([P.marketData]);
    await settled(gate);
    expect(row(gate, P.marketData).state).toBe("unavailable");
    expect(row(gate, P.marketData).problem).toMatch(/could not load/);
    expect(gate.confirm(P.marketData, P.marketData)).toBe(false);
    expect(added(gate)).toEqual([]);
    fail = false;
    gate.recheck(P.marketData);
    await settled(gate);
    expect(added(gate)).toEqual([P.marketData]);
  });

  it("forgets a Payee that is no longer picked, along with its confirmation", async () => {
    const { gate } = await gateWith();
    gate.sync([P.researchWriter]);
    await settled(gate);
    gate.confirm(P.researchWriter);
    gate.sync([]);
    expect(gate.rows()).toEqual([]);
    gate.sync([P.researchWriter]);
    await settled(gate);
    expect(row(gate, P.researchWriter).state).toBe("needs_confirm");
  });

  it("waits for a reader, then checks what was picked", async () => {
    const gate = new PayeeGate();
    gate.sync([P.marketData]);
    expect(row(gate, P.marketData).state).toBe("checking");
    const setup = await demoSetup();
    gate.configure((payee) => readPayeeWith(setup, { payee }));
    await settled(gate);
    expect(added(gate)).toEqual([P.marketData]);
  });

  it("tells its listeners and keeps the same rows until something changes", async () => {
    const { gate } = await gateWith();
    const seen = vi.fn();
    gate.subscribe(seen);
    gate.sync([P.marketData]);
    await settled(gate);
    expect(seen).toHaveBeenCalled();
    const rows = gate.rows();
    gate.sync([P.marketData]);
    expect(gate.rows()).toBe(rows);
  });
});
