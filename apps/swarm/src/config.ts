/** Command-line options of `pnpm swarm`. Every mistake is a SwarmConfigError that says what to type instead. */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenario, BUYER_STRATEGIES, DEFAULT_BUYER_MIX, DEFAULT_SELLER_MIX, DEFAULTS, defaultDataHosts, LIMITS, parseStrategyMix, ScenarioError, scenarioFileSchema, SELLER_STRATEGIES, STRATEGY_TEXT, type Mix, type Scenario, type ScenarioFile, type ScenarioOverrides } from "./scenario.ts";

export const SWARM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT_DIR = resolve(SWARM_DIR, "data", "last-run");
export const DEFAULT_PORT = 4477;
export const DEFAULT_PACE_MS = 60;
export const DEFAULT_TIMEOUT_SEC = { fake: 120, sandbox: 900 } as const;
export const CHAINS = ["fake", "sandbox"] as const;
export type Chain = (typeof CHAINS)[number];

export class SwarmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmConfigError";
  }
}

export type RunConfig = {
  command: "run";
  scenario: Scenario;
  chain: Chain;
  outDir: string;
  serve: boolean;
  port: number;
  paceMs: number;
  timeoutSec: number;
};
export type FileConfig = { command: "verify" | "prove"; file: string };
export type SwarmConfig = RunConfig | FileConfig | { command: "help" };

const mixText = <S extends string>(m: Mix<S>) => m.map((x) => `${x.strategy}:${x.weight}`).join(",");
/** A path as the user would type it from where they ran the command. */
export const shown = (path: string, cwd = process.cwd()): string => {
  const rel = relative(cwd, path);
  return rel === "" ? "." : rel.startsWith("..") ? path : rel;
};

export function helpText(cwd = process.cwd()): string {
  const d = DEFAULTS;
  const opt = (flag: string, def: string, what: string) => `  ${flag.padEnd(24)} ${what}\n  ${"".padEnd(24)} default: ${def}`;
  return [
    "Payminto swarm: buyer agents pool demand for GPU hours, sellers bid sealed, the clearing node nets and settles.",
    "",
    "Usage",
    "  pnpm swarm [options]                 run the simulation and print the rounds, the measured table and the checks",
    "  pnpm swarm --serve [options]         the same run on a live page; the run starts when the page opens",
    "  pnpm swarm verify <round.json>       re-check a published round file against RULES.md",
    "  pnpm swarm prove <receipt.json>      re-check a receipt proof file written by a run",
    "  pnpm swarm --help                    this text",
    "",
    "Scenario options",
    opt("--buyers <n>", String(d.buyers), `buyer agents, ${LIMITS.buyers.min} to ${LIMITS.buyers.max}`),
    opt("--sellers <n>", String(d.sellers), `seller agents, ${LIMITS.sellers.min} to ${LIMITS.sellers.max}`),
    opt("--rounds <n>", String(d.rounds), `sealed-bid rounds, ${LIMITS.rounds.min} to ${LIMITS.rounds.max}`),
    opt("--seed <n>", String(d.seed), `whole number from ${LIMITS.seed.min} to ${LIMITS.seed.max}; one seed always gives the same run`),
    opt("--data-hosts <n>", `${defaultDataHosts(d.buyers)} (one per five buyers, at most 4)`, `how many of the first buyers also sell dataset shards, ${LIMITS.dataHosts.min} to ${LIMITS.dataHosts.max}`),
    opt("--strategy-mix <mix>", `"sellers=${mixText(DEFAULT_SELLER_MIX)} buyers=${mixText(DEFAULT_BUYER_MIX)}"`, "weights of the scripted strategies; either side may be left out"),
    opt("--scenario <file>", "none", "a JSON scenario file (see apps/swarm/scenario.example.json); flags override it"),
    "",
    "Run options",
    opt("--chain fake|sandbox", "fake", "fake: the simulated hub, in memory. sandbox: a fresh local near-sandbox node, real transactions, a few minutes"),
    opt("--out <dir>", shown(DEFAULT_OUT_DIR, cwd), "where round files and receipt proofs are written"),
    opt("--serve", "off", "serve the live page and keep it up until Ctrl-C"),
    opt("--port <n>", String(DEFAULT_PORT), "port of the live page on 127.0.0.1, 0 lets the system choose (with --serve)"),
    opt("--pace <ms>", String(DEFAULT_PACE_MS), "pause after each event so a person can follow, 0 to 2000 (with --serve)"),
    opt("--timeout <seconds>", `${DEFAULT_TIMEOUT_SEC.fake} (fake), ${DEFAULT_TIMEOUT_SEC.sandbox} (sandbox)`, "stop the run if it takes longer, 10 to 3600; with --serve it covers the run, not the page"),
    opt("-h, --help", "off", "print this text"),
    "",
    "Strategies",
    ...SELLER_STRATEGIES.map((x) => `  ${x.padEnd(13)} ${STRATEGY_TEXT[x]}`),
    ...BUYER_STRATEGIES.map((x) => `  ${x.padEnd(13)} ${STRATEGY_TEXT[x]}`),
    "",
    "Exit codes: 0 every check passed, 1 a check failed or the run broke, 2 a mistake in the options, 3 the timeout passed, 130 interrupted.",
    "The rules are in apps/swarm/RULES.md.",
  ].join("\n");
}

const HELP_HINT = "Run `pnpm swarm --help` for every option and its default.";

function wholeNumber(flag: string, raw: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new SwarmConfigError(`${flag} must be a whole number from ${min} to ${max}, not "${raw}". For example: ${flag} ${Math.min(max, Math.max(min, 7))}`);
  }
  return Number(raw);
}

export function readScenarioFile(path: string): ScenarioFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new SwarmConfigError(`cannot read the scenario file ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}. Check the path; apps/swarm/scenario.example.json is a working example.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SwarmConfigError(`the scenario file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Compare it with apps/swarm/scenario.example.json.`);
  }
  const parsed = scenarioFileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(top level)"}: ${i.message}`).join("\n");
    throw new SwarmConfigError(`the scenario file ${path} has ${parsed.error.issues.length} problem(s):\n${problems}\nEvery field is optional; apps/swarm/scenario.example.json shows all of them.`);
  }
  return parsed.data;
}

export function loadSwarmConfig(argv: readonly string[], cwd = process.cwd()): SwarmConfig {
  const args = argv.filter((a) => a !== "--");
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") return { command: "help" };
  if (args[0] === "verify" || args[0] === "prove") {
    const what = args[0] === "verify" ? "a round file" : "a receipt proof file";
    const rest = args.slice(1);
    if (rest.length !== 1 || rest[0]!.startsWith("-")) {
      throw new SwarmConfigError(`pnpm swarm ${args[0]} takes exactly one argument, ${what}. For example: pnpm swarm ${args[0]} ${shown(DEFAULT_OUT_DIR, cwd)}/round-1${args[0] === "verify" ? "" : ".receipt"}.json`);
    }
    return { command: args[0], file: resolve(cwd, rest[0]!) };
  }

  const flags: ScenarioOverrides = {};
  let scenarioPath: string | undefined;
  let chain = "fake";
  let outDir = DEFAULT_OUT_DIR;
  let serve = false;
  let port = DEFAULT_PORT;
  let paceMs = DEFAULT_PACE_MS;
  let timeout: number | undefined;
  for (let i = 0; i < args.length; i++) {
    let a = args[i]!;
    let inline: string | undefined;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const value = (): string => {
      const v = inline ?? args[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new SwarmConfigError(`${a} needs a value. ${HELP_HINT}`);
      return v;
    };
    if (a === "run") continue;
    else if (a === "--buyers") flags.buyers = wholeNumber(a, value(), LIMITS.buyers.min, LIMITS.buyers.max);
    else if (a === "--sellers") flags.sellers = wholeNumber(a, value(), LIMITS.sellers.min, LIMITS.sellers.max);
    else if (a === "--rounds") flags.rounds = wholeNumber(a, value(), LIMITS.rounds.min, LIMITS.rounds.max);
    else if (a === "--seed") flags.seed = wholeNumber(a, value(), LIMITS.seed.min, LIMITS.seed.max);
    else if (a === "--data-hosts") flags.dataHosts = wholeNumber(a, value(), LIMITS.dataHosts.min, LIMITS.dataHosts.max);
    else if (a === "--strategy-mix") {
      try {
        Object.assign(flags, parseStrategyMix(value()));
      } catch (err) {
        if (err instanceof ScenarioError) throw new SwarmConfigError(err.message);
        throw err;
      }
    } else if (a === "--scenario") scenarioPath = resolve(cwd, value());
    else if (a === "--chain") chain = value();
    else if (a === "--out") outDir = resolve(cwd, value());
    else if (a === "--serve") serve = true;
    else if (a === "--port") port = wholeNumber(a, value(), 0, 65_535);
    else if (a === "--pace") paceMs = wholeNumber(a, value(), 0, 2_000);
    else if (a === "--timeout") timeout = wholeNumber(a, value(), 10, 3_600);
    else throw new SwarmConfigError(`unknown option ${args[i]}. ${HELP_HINT}`);
  }
  if (!(CHAINS as readonly string[]).includes(chain)) throw new SwarmConfigError(`--chain must be fake or sandbox, not "${chain}". Leave it out to run on the simulated hub.`);
  let scenario: Scenario;
  try {
    scenario = buildScenario(scenarioPath ? readScenarioFile(scenarioPath) : {}, flags);
  } catch (err) {
    if (err instanceof ScenarioError) throw new SwarmConfigError(`${err.message}. ${HELP_HINT}`);
    throw err;
  }
  const kind = chain as Chain;
  return { command: "run", scenario, chain: kind, outDir, serve, port, paceMs, timeoutSec: timeout ?? DEFAULT_TIMEOUT_SEC[kind] };
}
