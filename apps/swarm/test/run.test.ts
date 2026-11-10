import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRun, measuredTable } from "../src/checks.ts";
import { readScenarioFile, SWARM_DIR } from "../src/config.ts";
import { verifyRound, type RoundFile } from "../src/rules.ts";
import { runSwarm, type Report, type SwarmEvent } from "../src/run.ts";
import { buildScenario, DEFAULTS, type Scenario } from "../src/scenario.ts";
import { PortInUseError, startPage } from "../src/serve.ts";
import { proveReceiptFile, verifyRoundFile } from "../src/tools.ts";
import { startWorld } from "../src/world.ts";

const root = mkdtempSync(join(tmpdir(), "payminto-swarm-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A small swarm with every scripted strategy that matters: late and under-delivering sellers, two constrained buyers. */
const small = (seed: number): Scenario =>
  buildScenario(
    {},
    {
      seed,
      buyers: 6,
      sellers: 3,
      rounds: 2,
      dataHosts: 1,
      sellerMix: [{ strategy: "truthful", weight: 1 }, { strategy: "late", weight: 1 }, { strategy: "underdeliver", weight: 1 }],
      buyerMix: [{ strategy: "steady", weight: 4 }, { strategy: "capped", weight: 1 }, { strategy: "thin", weight: 1 }],
    },
  );

async function play(name: string, scenario: Scenario): Promise<{ report: Report; events: SwarmEvent[]; lines: string[]; outDir: string }> {
  const outDir = join(root, name);
  const world = await startWorld(scenario, { chain: "fake", outDir });
  try {
    const events: SwarmEvent[] = [];
    const lines: string[] = [];
    const report = await runSwarm(world, { outDir, outDirShown: name, say: (l) => lines.push(l), emit: (e) => events.push(e) });
    return { report, events, lines, outDir };
  } finally {
    await world.stop();
  }
}

let a: Awaited<ReturnType<typeof play>>;
let again: Awaited<ReturnType<typeof play>>;
let other: Awaited<ReturnType<typeof play>>;

beforeAll(async () => {
  a = await play("run-a", small(15));
  again = await play("run-b", small(15));
  other = await play("other", small(16));
});

describe("a small swarm on the simulated hub, end to end", () => {
  it("passes every check", () => {
    expect(checkRun(a.report).filter((c) => !c.ok)).toEqual([]);
    expect(checkRun(other.report).filter((c) => !c.ok)).toEqual([]);
    expect(checkRun(a.report).length).toBeGreaterThanOrEqual(16);
  });

  it("labels the chain as simulated everywhere it shows chain state", () => {
    expect(a.report.simulated).toBe(true);
    expect(a.report.label).toMatch(/^SIMULATED/);
    expect(a.lines.find((l) => l.startsWith("Chain:"))).toMatch(/SIMULATED/);
    expect(a.events[0]).toMatchObject({ type: "run.started", simulated: true });
  });

  it("gives every agent its own sub-account, key and Budget, owned on the hub by that sub-account", () => {
    const { agents, ledger, parent } = a.report;
    expect(agents).toHaveLength(9);
    expect(parent).toBe("swarm.testnet");
    expect(new Set(agents.map((x) => x.budgetId)).size).toBe(9);
    expect(new Set(agents.map((x) => x.publicKey)).size).toBe(9);
    for (const l of ledger) expect(l.ownerOnHub).toBe(l.account);
    // No Budget lets its agent pay just anyone: each lists its real Payees.
    for (const x of agents) expect(x.payees.length).toBeGreaterThan(0);
  });

  it("writes one round file per round that verifyRound and the verify command accept", () => {
    for (const r of a.report.rounds) {
      const onDisk = JSON.parse(readFileSync(r.path, "utf8")) as RoundFile;
      expect(verifyRound(onDisk).problems).toEqual([]);
      expect(onDisk.delivery).toBeTruthy();
      expect(verifyRoundFile(r.path, "x").code).toBe(0);
    }
  });

  it("makes the verify command fail on a tampered round file, and explain an unreadable one", () => {
    const file = JSON.parse(readFileSync(a.report.rounds[0]!.path, "utf8")) as RoundFile;
    file.result.clearingPrice = (BigInt(file.result.clearingPrice!) - 1_000n).toString();
    const tampered = join(root, "tampered.json");
    writeFileSync(tampered, JSON.stringify(file));
    const bad = verifyRoundFile(tampered, "x");
    expect(bad.code).toBe(1);
    expect(bad.lines.join("\n")).toMatch(/NOT VERIFIED/);
    const missing = verifyRoundFile(join(root, "nope.json"), "apps/swarm/data/last-run/round-1.json");
    expect(missing.code).toBe(2);
    expect(missing.lines.join("\n")).toMatch(/there is no such file[\s\S]*What to do: run `pnpm swarm` first/);
    writeFileSync(join(root, "junk.json"), "{ nope");
    expect(verifyRoundFile(join(root, "junk.json"), "x")).toMatchObject({ code: 2 });
    writeFileSync(join(root, "other.json"), JSON.stringify({ hello: 1 }));
    expect(verifyRoundFile(join(root, "other.json"), "x").code).toBe(1);
  });

  it("fails its checks when a payee is held or blocked, since every payee in the swarm is one of its own registered agents", () => {
    // On a local NEAR node, Budgets registered before their sellers had registered with the token were held by the
    // payee check for every round, and the checks still passed: the run quietly paid only half its buyers.
    const held = structuredClone(a.report);
    held.refusals = [...held.refusals, { ...held.refusals[0]!, rule: "PAYEE_NEEDS_APPROVAL", enforcedBy: "node" }];
    const failed = checkRun(held).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("no payee was held or blocked: every payee is one of the swarm's own registered agents");
    expect(checkRun(a.report).find((c) => c.name.startsWith("no payee was held"))?.ok).toBe(true);
  });

  it("exercises the rules: a void bid, an under-delivery and both kinds of refusal", () => {
    const reasons = a.report.rounds.flatMap((r) => r.file.result.bids.map((b) => b.reason)).filter(Boolean);
    expect(reasons).toContain("LATE_REVEAL");
    const rules = a.report.refusals.map((r) => `${r.rule}:${r.enforcedBy}`);
    expect(rules).toContain("TOTAL_CAP:agent");
    expect(rules).toContain("NET_EXPOSURE:node");
    for (const r of a.report.refusals) expect(r.attemptedAmount).toMatch(/^[0-9]+$/);
  });

  it("stops paying a seller that stops delivering", async () => {
    // Only the under-delivering seller bids, so it wins every round and serves 60 percent each time.
    const lone = await play("lone", buildScenario({}, { seed: 4, buyers: 5, sellers: 1, rounds: 1, dataHosts: 0, sellerMix: [{ strategy: "underdeliver", weight: 1 }], buyerMix: [{ strategy: "steady", weight: 1 }] }));
    const d = lone.report.rounds[0]!.file.delivery!;
    const res = lone.report.rounds[0]!.file.result;
    expect(res.clearingPrice).toBe("700000");
    expect(d.deliveredUnits).toBe(Math.max(1, Math.floor((res.awardedUnits * 60) / 100)));
    expect(d.deliveredUnits).toBeLessThan(res.awardedUnits);
    expect(BigInt(d.sellerReceived)).toBe(BigInt(d.deliveredUnits) * 700_000n);
    expect(d.buyers.some((b) => b.stopped?.cause === "seller-unavailable")).toBe(true);
    // One seller and no data host: nobody to buy inputs from, so nothing offsets and one account is paid.
    expect([d.storage.count, d.data.count]).toEqual([0, 0]);
    expect(lone.report.payout.transfers).toHaveLength(1);
    const checks = checkRun(lone.report);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toContain("net moved equals gross cleared, because no account both earned and spent");
    expect(lone.report.settlement.net).toBe(lone.report.settlement.gross);
  });

  it("settles one batch, moves less than it clears, and pays each net creditor once", () => {
    const { settlement, payout, paidCalls } = a.report;
    expect(settlement.batches).toHaveLength(1);
    expect(settlement.net).toBeLessThan(settlement.gross);
    expect(settlement.calls).toBe(paidCalls.total);
    expect(payout.transfers.length).toBeGreaterThan(0);
    expect(payout.transfers.length).toBeLessThan(paidCalls.total);
    expect(payout.transfers.reduce((s, t) => s + t.amount, 0n)).toBe(settlement.net);
    expect(a.report.solvent).toBe(true);
  });

  it("proves one receipt per round, and the prove command rejects the tampered copy", () => {
    for (const r of a.report.rounds) {
      expect(r.proof).toMatchObject({ verified: true, tamperedRejected: true });
      const good = proveReceiptFile(join(a.outDir, r.proof!.file), "x");
      expect(good.code).toBe(0);
      expect(good.lines.join("\n")).toMatch(/VERIFIED against the root recorded in this file/);
      const bad = proveReceiptFile(join(a.outDir, r.proof!.tamperedFile), "x");
      expect(bad.code).toBe(1);
      expect(bad.lines.filter((l) => l.includes("FAIL"))).toHaveLength(2);
    }
    expect(proveReceiptFile(a.report.rounds[0]!.path, "x").code).toBe(2);
    expect(proveReceiptFile(join(root, "nope.json"), "x").code).toBe(2);
  });

  it("is the same run for the same seed: same lines, same round files, same table", () => {
    expect(again.lines.map((l) => l.replaceAll("run-b", "run-a"))).toEqual(a.lines);
    for (const [i, r] of a.report.rounds.entries()) expect(again.report.rounds[i]!.file).toEqual(r.file);
    expect(measuredTable(again.report)).toEqual(measuredTable(a.report));
    expect(checkRun(again.report)).toEqual(checkRun(a.report));
    const shape = (events: SwarmEvent[]) => JSON.stringify(events.filter((e) => e.type !== "run.started" && e.type !== "settled" && e.type !== "proof" && e.type !== "round.delivered"));
    expect(shape(again.events)).toBe(shape(a.events));
  });

  it("is another run for another seed", () => {
    expect(other.report.rounds[0]!.file.messages).not.toEqual(a.report.rounds[0]!.file.messages);
    expect(measuredTable(other.report)).not.toEqual(measuredTable(a.report));
  });

  it("fails its checks when an invariant is broken", () => {
    const names = (r: Report) => checkRun(r).filter((c) => !c.ok).map((c) => c.name);
    const overpaid = structuredClone(a.report);
    overpaid.rounds[0]!.buyerPaid[0]!.amount += BigInt(overpaid.rounds[0]!.file.result.allocations[0]!.share) + 1n;
    expect(names(overpaid)).toEqual(expect.arrayContaining(["no buyer paid more than its share", "every seller was paid exactly for the units it delivered"]));

    const wrongPrice = structuredClone(a.report);
    wrongPrice.rounds[0]!.file.result.clearingPrice = "1";
    expect(names(wrongPrice)).toContain("the winner and the clearing price of every round match verifyRound");

    const unlabeled = structuredClone(a.report);
    unlabeled.label = "NEAR testnet";
    expect(names(unlabeled)).toContain("chain is labeled");

    const insolvent = structuredClone(a.report);
    insolvent.solvent = false;
    expect(names(insolvent)).toContain("the hub is solvent: balance = escrow + credits + in flight");

    const noOffset = structuredClone(a.report);
    noOffset.settlement.net = noOffset.settlement.gross;
    expect(names(noOffset)).toContain("net moved is less than gross cleared");
    expect(checkRun(a.report).map((c) => c.name)).toContain("net moved is less than gross cleared");

    const unproven = structuredClone(a.report);
    unproven.rounds[0]!.proof!.tamperedRejected = false;
    expect(names(unproven)).toContain("one receipt per round is proven against the hub's Merkle root, and a tampered copy is rejected");
  });

  it("emits events a page can rebuild the whole run from", () => {
    const types = a.events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    for (const t of ["round.opened", "round.demand", "round.pooled", "round.committed", "round.revealed", "round.closed", "unit.delivered", "unit.stopped", "input.bought", "round.delivered", "settled", "paid.out", "ledger", "proof"]) expect(types, t).toContain(t);
    // Everything is JSON: no bigint reaches the page.
    expect(() => JSON.stringify(a.events)).not.toThrow();
    const gross = a.events.reduce((s, e) => (e.type === "unit.delivered" || e.type === "input.bought" ? s + BigInt(e.amount) : s), 0n);
    expect(gross).toBe(a.report.settlement.gross);
  });
});

describe("the shipped example scenario", () => {
  it("is valid and equals the defaults", () => {
    const fromFile = buildScenario(readScenarioFile(join(SWARM_DIR, "scenario.example.json")));
    const text = (s: Scenario) => JSON.stringify({ ...s, sellerMix: s.sellerMix.filter((m) => m.weight > 0) }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text(fromFile)).toBe(text(buildScenario()));
    expect(fromFile.seed).toBe(DEFAULTS.seed);
  });
});

describe("the live page server", () => {
  it("serves the page, replays recorded events to a late viewer, and serves only run files", async () => {
    const page = await startPage({ port: 0, outDir: a.outDir, chainLabel: "SIMULATED" });
    try {
      const html = await (await fetch(`${page.url}/`)).text();
      expect(html).toContain("<title>Payminto swarm");
      expect(html).not.toContain(String.fromCharCode(0x2014));
      for (const asset of ["/swarm.css", "/swarm.js"]) expect((await fetch(`${page.url}${asset}`)).status).toBe(200);
      for (const e of a.events.slice(0, 5)) page.push(e);
      const res = await fetch(`${page.url}/events`);
      await page.viewer;
      const reader = res.body!.getReader();
      let text = "";
      while ((text.match(/^data:/gm) ?? []).length < 5) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      expect(text).toContain('"type":"run.started"');
      expect(text).toMatch(/^id: 0$/m);

      expect((await fetch(`${page.url}/files/round-1.json`)).status).toBe(200);
      expect((await fetch(`${page.url}/files/round-1.receipt.json`)).status).toBe(200);
      expect((await fetch(`${page.url}/files/..%2Fsecret.json`)).status).toBe(404);
      expect((await fetch(`${page.url}/files/report.json`)).status).toBe(404);
      expect(await (await fetch(`${page.url}/api/rounds/1/verify`)).json()).toMatchObject({ ok: true });
      expect((await fetch(`${page.url}/api/receipts/99`)).status).toBe(404);
      expect(await (await fetch(`${page.url}/api/receipts/1`)).json()).toMatchObject({ chain: "SIMULATED", live: null });
    } finally {
      await page.close();
    }
  });

  it("says what to do when its port is taken", async () => {
    const first = await startPage({ port: 0, outDir: a.outDir, chainLabel: "SIMULATED" });
    try {
      await expect(startPage({ port: first.port, outDir: a.outDir, chainLabel: "SIMULATED" })).rejects.toThrow(PortInUseError);
      await expect(startPage({ port: first.port, outDir: a.outDir, chainLabel: "SIMULATED" })).rejects.toThrow(/pass --port 0 to let the system choose/);
    } finally {
      await first.close();
    }
  });
});
