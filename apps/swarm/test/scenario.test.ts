import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { helpText, loadSwarmConfig, SwarmConfigError, type RunConfig } from "../src/config.ts";
import { agentsOf, assignStrategies, buildScenario, capacityOf, costOf, DEFAULTS, demandOf, draw, parseStrategyMix, roundIdOf, ScenarioError, sellerPlan } from "../src/scenario.ts";
import { commitmentOf } from "../src/rules.ts";

const dir = mkdtempSync(join(tmpdir(), "payminto-swarm-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (...argv: string[]) => loadSwarmConfig(argv, dir) as RunConfig;
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SwarmConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a SwarmConfigError");
};

describe("the scenario", () => {
  it("defaults to 20 buyers and 5 sellers with one of each seller script", () => {
    const s = buildScenario();
    const { buyers, sellers } = agentsOf(s, "swarm.testnet");
    expect([buyers.length, sellers.length, s.rounds]).toEqual([20, 5, 3]);
    expect(sellers.map((x) => x.strategy)).toEqual(["truthful", "shading", "late", "withhold", "underdeliver"]);
    expect(buyers.filter((b) => b.strategy === "capped").map((b) => b.account)).toEqual(["buyer-19.swarm.testnet"]);
    expect(buyers.filter((b) => b.strategy === "thin").map((b) => b.account)).toEqual(["buyer-20.swarm.testnet"]);
    expect(buyers.filter((b) => b.dataHost).map((b) => b.index)).toEqual([1, 2, 3, 4]);
  });

  it("gives every agent its own key and a direct sub-account of the one parent", () => {
    const { all } = agentsOf(buildScenario(), "swarm.testnet");
    expect(new Set(all.map((a) => a.key.publicKey)).size).toBe(all.length);
    for (const a of all) expect(a.account).toMatch(/^(buyer|seller)-[0-9]+\.swarm\.testnet$/);
  });

  it("is decided by the seed alone", () => {
    const a = buildScenario({}, { seed: 99 });
    const b = buildScenario({}, { seed: 99 });
    const other = buildScenario({}, { seed: 100 });
    const plans = (s: typeof a) => agentsOf(s, "swarm.testnet").sellers.map((x) => sellerPlan(s, x, roundIdOf(s.seed, 1), 1));
    const text = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    expect(text(plans(a))).toBe(text(plans(b)));
    expect(text(plans(a))).not.toBe(text(plans(other)));
    expect(agentsOf(a, "swarm.testnet").all.map((x) => x.key.publicKey)).toEqual(agentsOf(b, "swarm.testnet").all.map((x) => x.key.publicKey));
    expect(draw(99, "x", 1, 6)).toBe(draw(99, "x", 1, 6));
  });

  it("keeps every drawn value inside its range", () => {
    const s = buildScenario();
    const { buyers, sellers } = agentsOf(s, "swarm.testnet");
    for (let n = 1; n <= 12; n++) {
      for (const b of buyers.filter((x) => x.strategy === "steady")) {
        expect(demandOf(s, b, n)).toBeGreaterThanOrEqual(s.demand.min);
        expect(demandOf(s, b, n)).toBeLessThanOrEqual(s.demand.max);
      }
      for (const x of sellers) {
        expect(costOf(s, x, n)).toBeGreaterThanOrEqual(s.cost.min - 40_000n);
        expect(costOf(s, x, n)).toBeLessThanOrEqual(s.cost.max + 40_000n);
        expect(costOf(s, x, n) % 1_000n).toBe(0n);
        expect(capacityOf(s, x, n)).toBeGreaterThanOrEqual(60);
      }
    }
    for (let i = 0; i < 200; i++) {
      const v = draw(1, `r${i}`, -3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it("scripts each seller strategy as documented", () => {
    const s = buildScenario({}, { sellers: 6, sellerMix: [{ strategy: "truthful", weight: 1 }, { strategy: "shading", weight: 1 }, { strategy: "late", weight: 1 }, { strategy: "withhold", weight: 1 }, { strategy: "underdeliver", weight: 1 }, { strategy: "mismatch", weight: 1 }] });
    const sellers = agentsOf(s, "swarm.testnet").sellers;
    const plan = (i: number, n: number) => sellerPlan(s, sellers[i]!, roundIdOf(s.seed, n), n);
    expect(plan(0, 1).bid.unitPrice).toBe(costOf(s, sellers[0]!, 1));
    expect(plan(1, 1).bid.unitPrice).toBeGreaterThan(costOf(s, sellers[1]!, 1));
    expect([plan(2, 1).revealLate, plan(2, 2).revealLate, plan(2, 3).revealLate]).toEqual([true, false, true]);
    expect([plan(3, 1).reveal === null, plan(3, 2).reveal === null]).toEqual([false, true]);
    expect([plan(4, 1).servePercent, plan(0, 1).servePercent]).toEqual([60, 100]);
    const liar = plan(5, 1);
    expect(commitmentOf(roundIdOf(s.seed, 1), sellers[5]!.account, liar.reveal!)).not.toBe(commitmentOf(roundIdOf(s.seed, 1), sellers[5]!.account, liar.bid));
  });

  it("assigns strategies by weight, in the listed order, with the largest remainder rule", () => {
    expect(assignStrategies([{ strategy: "truthful", weight: 2 }, { strategy: "late", weight: 1 }], 3)).toEqual(["truthful", "truthful", "late"]);
    expect(assignStrategies([{ strategy: "truthful", weight: 1 }, { strategy: "late", weight: 1 }], 3)).toEqual(["truthful", "truthful", "late"]);
    expect(assignStrategies([{ strategy: "steady", weight: 18 }, { strategy: "capped", weight: 1 }, { strategy: "thin", weight: 1 }], 10)).toEqual([...Array(9).fill("steady"), "capped"]);
    expect(assignStrategies([{ strategy: "truthful", weight: 0 }, { strategy: "late", weight: 5 }], 2)).toEqual(["late", "late"]);
  });

  it("reads a strategy mix for one or both sides", () => {
    expect(parseStrategyMix("sellers=truthful:2,shading buyers=steady:8,capped:1")).toEqual({
      sellerMix: [{ strategy: "truthful", weight: 2 }, { strategy: "shading", weight: 1 }],
      buyerMix: [{ strategy: "steady", weight: 8 }, { strategy: "capped", weight: 1 }],
    });
    expect(parseStrategyMix("buyers=steady;sellers=late:3")).toEqual({ buyerMix: [{ strategy: "steady", weight: 1 }], sellerMix: [{ strategy: "late", weight: 3 }] });
  });

  it("says what is wrong with a strategy mix and what to write instead", () => {
    const bad = (text: string) => {
      try {
        parseStrategyMix(text);
      } catch (err) {
        expect(err).toBeInstanceOf(ScenarioError);
        return (err as Error).message;
      }
      throw new Error("expected a ScenarioError");
    };
    expect(bad("sellers=honest:2")).toMatch(/"honest" is not a seller strategy; seller strategies are truthful, shading/);
    expect(bad("buyers=steady:x")).toMatch(/weight of steady must be a whole number/);
    expect(bad("sellers=truthful:1,truthful:2")).toMatch(/appears twice/);
    expect(bad("sellers=truthful:0")).toMatch(/at least one strategy with a weight above 0/);
    expect(bad("truthful:2")).toMatch(/write it as "sellers=/);
    expect(bad("")).toMatch(/is empty/);
  });
});

describe("the command line", () => {
  it("runs the default scenario with no arguments", () => {
    const c = run();
    expect(c).toMatchObject({ command: "run", chain: "fake", serve: false, port: 4477, paceMs: 60, timeoutSec: 120 });
    expect(c.scenario).toMatchObject({ seed: DEFAULTS.seed, buyers: 20, sellers: 5, rounds: 3, dataHosts: 4 });
  });

  it("takes every scenario option, as --flag value or --flag=value", () => {
    const c = run("--buyers", "8", "--sellers=3", "--rounds", "2", "--seed=42", "--data-hosts", "1", "--strategy-mix", "sellers=truthful:1,late:1 buyers=steady:3,thin:1", "--serve", "--port", "0", "--pace=5", "--timeout", "30", "--out", "runs/a");
    expect(c.scenario).toMatchObject({ seed: 42, buyers: 8, sellers: 3, rounds: 2, dataHosts: 1 });
    expect(c.scenario.sellerMix).toEqual([{ strategy: "truthful", weight: 1 }, { strategy: "late", weight: 1 }]);
    expect(c).toMatchObject({ serve: true, port: 0, paceMs: 5, timeoutSec: 30, outDir: join(dir, "runs/a") });
  });

  it("scales the data hosts with the buyers unless told otherwise", () => {
    expect(run("--buyers", "4").scenario.dataHosts).toBe(0);
    expect(run("--buyers", "12").scenario.dataHosts).toBe(2);
    expect(run("--buyers", "60").scenario.dataHosts).toBe(4);
  });

  it("reads a scenario file, and lets flags override it", () => {
    const path = join(dir, "scenario.json");
    writeFileSync(path, JSON.stringify({ seed: 3, buyers: 6, sellers: 2, rounds: 1, reserveUnitPrice: "0.90", storage: { every: 3, price: "0.05" }, sellerStrategies: { truthful: 1, underdeliver: 1 }, demand: { min: 1, max: 2 }, sellerCost: { min: "0.50", max: "0.60" } }));
    const c = run("--scenario", "scenario.json", "--seed", "5");
    expect(c.scenario).toMatchObject({ seed: 5, buyers: 6, sellers: 2, rounds: 1, reserveUnitPrice: 900_000n, storage: { every: 3, price: 50_000n }, demand: { min: 1, max: 2 }, cost: { min: 500_000n, max: 600_000n } });
    expect(c.scenario.sellerMix).toEqual([{ strategy: "truthful", weight: 1 }, { strategy: "underdeliver", weight: 1 }]);
  });

  it("explains a bad seed, a bad count and an unknown option, each with what to type", () => {
    expect(message(() => run("--seed", "abc"))).toMatch(/--seed must be a whole number from 0 to 4294967295, not "abc"\. For example: --seed 7/);
    expect(message(() => run("--seed", "-1"))).toMatch(/--seed must be a whole number/);
    expect(message(() => run("--seed", "1.5"))).toMatch(/--seed must be a whole number/);
    expect(message(() => run("--buyers", "0"))).toMatch(/--buyers must be a whole number from 1 to 60/);
    expect(message(() => run("--sellers", "17"))).toMatch(/--sellers must be a whole number from 1 to 16/);
    expect(message(() => run("--rounds"))).toMatch(/--rounds needs a value/);
    expect(message(() => run("--bogus"))).toMatch(/unknown option --bogus\. Run `pnpm swarm --help`/);
    expect(message(() => run("--chain", "mainnet"))).toMatch(/--chain must be fake or sandbox/);
    expect(message(() => run("--buyers", "2", "--data-hosts", "3"))).toMatch(/data hosts are buyers/);
    expect(message(() => run("--strategy-mix", "sellers=honest"))).toMatch(/not a seller strategy/);
  });

  it("explains an unreadable, malformed or invalid scenario file", () => {
    expect(message(() => run("--scenario", "missing.json"))).toMatch(/cannot read the scenario file .*missing\.json: ENOENT\. Check the path/);
    writeFileSync(join(dir, "broken.json"), "{ not json");
    expect(message(() => run("--scenario", "broken.json"))).toMatch(/is not valid JSON/);
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ buyers: 500, sellerStrategies: { honest: 1 }, extra: true }));
    const text = message(() => run("--scenario", "wrong.json"));
    expect(text).toMatch(/has 3 problem\(s\)/);
    expect(text).toMatch(/buyers:/);
    expect(text).toMatch(/scenario\.example\.json/);
  });

  it("takes exactly one file for verify and prove", () => {
    expect(loadSwarmConfig(["verify", "a.json"], dir)).toEqual({ command: "verify", file: join(dir, "a.json") });
    expect(loadSwarmConfig(["prove", "/abs/r.json"], dir)).toEqual({ command: "prove", file: "/abs/r.json" });
    expect(message(() => loadSwarmConfig(["verify"], dir))).toMatch(/takes exactly one argument, a round file\. For example: pnpm swarm verify/);
    expect(message(() => loadSwarmConfig(["prove", "a", "b"], dir))).toMatch(/a receipt proof file/);
  });

  it("lists every option with its default in --help", () => {
    expect(loadSwarmConfig(["--help"])).toEqual({ command: "help" });
    expect(loadSwarmConfig(["--seed", "1", "-h"])).toEqual({ command: "help" });
    const help = helpText();
    for (const flag of ["--buyers <n>", "--sellers <n>", "--rounds <n>", "--seed <n>", "--data-hosts <n>", "--strategy-mix <mix>", "--scenario <file>", "--chain fake|sandbox", "--out <dir>", "--serve", "--port <n>", "--pace <ms>", "--timeout <seconds>", "-h, --help"]) {
      const at = help.indexOf(`  ${flag}`);
      expect(at, flag).toBeGreaterThan(-1);
      // The line after an option states its default.
      expect(help.slice(at).split("\n")[1], flag).toMatch(/default: \S/);
    }
    expect(help).toMatch(/default: 51\b/);
    expect(help).toContain("pnpm swarm verify <round.json>");
    expect(help).toContain("pnpm swarm prove <receipt.json>");
    expect(help).not.toContain(String.fromCharCode(0x2014));
  });
});
