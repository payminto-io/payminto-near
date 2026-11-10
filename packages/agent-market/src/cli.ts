#!/usr/bin/env node
/**
 * `market`: Payminto's command line for the NEAR AI Agent Market.
 *
 *   market search <query>     find live agents (public, read-only)
 *   market quote <handle>     ask what one call costs and check it against a policy (free, nothing is signed)
 *   market work --dry-run     run the seller flow on a recorded assignment, with no account and no network
 *   market work               work the live market; needs AGENT_MARKET_TOKEN and a fulfil module
 *
 * It holds no key and cannot pay. Expected failures print one line saying what happened and one saying what to do.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toAtomic } from "@payminto/protocol";
import { MarketClient } from "./client.ts";
import { CATEGORIES, USDC_DECIMALS, type Category } from "./constants.ts";
import { MarketError, printable } from "./errors.ts";
import type { Clock, FetchLike } from "./http.ts";
import { quoteAndCheck, type QuoteToolResult } from "./mcp.ts";
import { money, usdc, usdcPolicy } from "./quote.ts";
import { retryText } from "./refusal.ts";
import { HUMAN_SETUP_STEPS, createMarketWorker, sampleFulfil } from "./seller.ts";
import type { Fulfil, WorkerEvent } from "./worker.ts";

export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, needsPerson: 4 } as const;

export const USAGE = `market - Payminto's client for the NEAR AI Agent Market. It holds no key and cannot pay.

  market search <query> [--category <slug>] [--limit <n>] [--json]
      Find live agents in the public catalog.

  market quote <handle> [--message <text>] [--max <usdc>] [--daily <usdc>] [--json]
      Ask the agent what one call costs (free, no account) and check the price against a policy.
      --max is the most one hire may cost (default 1.00), --daily the most per 24 hours (default 5.00, or --max if larger).
      Prints ALLOW or REFUSE with the rule. Nothing is signed either way.

  market work --dry-run [--assignment <file.json>] [--fulfil <module>] [--ceiling <usdc>]
      Run the seller flow on a recorded assignment and print the deliverable. No account, no network.

  market work --fulfil <module> --ceiling <usdc> [--once] [--concurrency <n>]
      Work the live market as your agent. Needs AGENT_MARKET_TOKEN.
      <module> exports fulfil(job, ctx); --ceiling is the most one job may spend on inputs.

Exit codes: 0 done or ALLOW, 1 the market could not be used, 2 bad arguments, 3 REFUSE, 4 a person must set something up first.`;

export type CliDeps = {
  fetch?: FetchLike;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** Where relative paths are resolved from. */
  cwd?: string;
  signal?: AbortSignal;
  /** Loads a fulfil module. Tests replace it. */
  load?: (path: string) => Promise<unknown>;
};

class UsageError extends Error {}

type Flags = { positional: string[]; values: Map<string, string>; switches: Set<string> };

function parseFlags(argv: readonly string[], spec: { values: readonly string[]; switches: readonly string[] }): Flags {
  const flags: Flags = { positional: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (!a.startsWith("--")) {
      flags.positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (spec.switches.includes(name) && eq < 0) {
      flags.switches.add(name);
      continue;
    }
    if (!spec.values.includes(name)) throw new UsageError(`unknown option --${name}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    flags.values.set(name, value);
  }
  return flags;
}

function usdcFlag(value: string | undefined, fallback: string, name: string): string {
  const text = value ?? fallback;
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(text)) throw new UsageError(`${name} must be an amount in USDC with at most six decimals, for example 0.25`);
  return toAtomic(text, USDC_DECIMALS).toString();
}

function intFlag(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

async function search(argv: string[], d: Required<Pick<CliDeps, "out" | "env">> & CliDeps): Promise<number> {
  const f = parseFlags(argv, { values: ["category", "limit"], switches: ["json"] });
  const q = f.positional.join(" ").trim();
  if (!q) throw new UsageError("search needs a query, for example: market search research");
  const category = f.values.get("category");
  if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) throw new UsageError(`--category must be one of: ${CATEGORIES.join(", ")}`);
  const client = new MarketClient({ ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.clock ? { clock: d.clock } : {}) });
  const agents = await client.searchAgents({ q, limit: intFlag(f.values.get("limit"), 10, "--limit", 1, 50), ...(category ? { category: category as Category } : {}) }, d.signal);
  if (f.switches.has("json")) {
    d.out(JSON.stringify({ query: q, agents }, null, 2));
    return EXIT.ok;
  }
  if (agents.length === 0) {
    d.out(`No live agent matches "${printable(q, 80)}".`);
    d.out("Next: try a broader word, or a category with --category research.");
    return EXIT.ok;
  }
  d.out(`${agents.length} agent${agents.length === 1 ? "" : "s"} for "${printable(q, 80)}" on ${client.origin} (names and descriptions are the builders' own text):`);
  d.out("");
  d.out(`${pad("HANDLE", 30)}  ${pad("CATEGORY", 16)}  ${pad("TAKING CALLS", 12)}  ${pad("DELIVERED", 9)}  NAME`);
  for (const a of agents) {
    const taking = a.available_now === true ? "yes" : a.available_now === false ? "no" : "unknown";
    d.out(`${pad(a.handle, 30)}  ${pad(a.category, 16)}  ${pad(taking, 12)}  ${pad(String(a.delivered_jobs), 9)}  ${printable(a.name, 60)}`);
    if (a.description) d.out(`${" ".repeat(32)}${printable(a.description, 110)}`);
  }
  d.out("");
  d.out(`Next: market quote ${agents.find((a) => a.available_now)?.handle ?? agents[0]!.handle}`);
  return EXIT.ok;
}

function printQuote(r: QuoteToolResult, name: string, dailyMax: string, payeeListed: boolean | null, out: (line: string) => void): void {
  out(`Agent      ${printable(name, 80)} (${r.handle})`);
  out(`Quote      ${r.price.display} per call, on ${r.price.network}`);
  out(`           asset ${r.price.asset}`);
  out(`           paid to ${r.price.payTo}`);
  out(
    payeeListed === true
      ? "           that is the market's own treasury account, as its /.well-known/x402 lists it, not the agent"
      : payeeListed === false
        ? "           WARNING: that is not a treasury account the market lists at /.well-known/x402"
        : "           the market's list of treasury accounts could not be read, so this account was not compared with it",
  );
  out(`           a payment would stay valid for ${r.price.validForSeconds} s and be charged only on delivery`);
  out(`Policy     at most ${r.maxPerHire.display} per hire and ${usdc(dailyMax)} per 24 hours`);
  if (r.decision === "allow") {
    out("Decision   ALLOW");
    for (const w of r.warnings) out(`           warning: ${printable(w, 200)}`);
    out("           The price is within the policy, so an agent holding this policy may go on to pay through the market.");
  } else {
    const f = r.refusal!;
    out(`Decision   REFUSE by rule ${f.rule}`);
    out(`           ${f.ruleText}.`);
    out(`           ${printable(f.message, 300)}.`);
    const show = (atomic: string) => money(atomic, r.price.asset);
    out(`           attempted ${show(f.attemptedAmount)}${f.limit === null ? "" : `, limit ${show(f.limit)}`}${f.remainingBudget === null ? "" : `, left for today ${show(f.remainingBudget)}`}`);
    out(`           retry: ${retryText(f.retry)}`);
    out("           Refused before signing, so this cost nothing.");
  }
  out("");
  out("Nothing was signed or paid. A hire on the Agent Market is paid through the market itself.");
}

async function quote(argv: string[], d: Required<Pick<CliDeps, "out" | "env">> & CliDeps): Promise<number> {
  const f = parseFlags(argv, { values: ["message", "max", "daily"], switches: ["json"] });
  const handle = f.positional[0];
  if (!handle || f.positional.length > 1) throw new UsageError("quote needs one handle: market quote <handle>. Pick a handle from market search <query>.");
  const maxPerHire = usdcFlag(f.values.get("max"), d.env.PAYMINTO_MARKET_MAX_PER_HIRE_USDC ?? "1.00", "--max");
  const dailyGiven = f.values.get("daily") ?? d.env.PAYMINTO_MARKET_MAX_PER_DAY_USDC;
  // With no daily maximum given, the default is 5.00, or the per-hire maximum when that is larger.
  const maxPerDay = dailyGiven === undefined && BigInt(maxPerHire) > 5_000_000n ? maxPerHire : usdcFlag(dailyGiven, "5.00", "--daily");
  const client = new MarketClient({ ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.clock ? { clock: d.clock } : {}) });
  // The card comes first: it proves the handle is a published agent whose endpoint is on its own market host.
  const card = await client.getAgentCard(handle, d.signal);
  const message = f.values.get("message");
  const result = await quoteAndCheck({ client, policy: usdcPolicy({ maxPerHire, maxPerDay }) }, { handle, ...(message ? { task: message } : {}) }, d.signal);
  // The quote says who is paid. The market publishes its treasury accounts separately; compare the two.
  const payeeListedByMarket = await client
    .x402Recipients(d.signal)
    .then((x) => x.recipients.some((p) => p.network === result.price.network && p.asset === result.price.asset && p.payTo === result.price.payTo))
    .catch(() => null);
  if (f.switches.has("json")) d.out(JSON.stringify({ agent: { handle, name: card.name }, ...result, payeeListedByMarket, maxPerDay: { atomic: maxPerDay, display: usdc(maxPerDay) } }, null, 2));
  else printQuote(result, card.name, maxPerDay, payeeListedByMarket, d.out);
  return result.decision === "allow" ? EXIT.ok : EXIT.refused;
}

async function loadFulfil(path: string, d: CliDeps): Promise<Fulfil> {
  const base = d.cwd ?? d.env?.INIT_CWD ?? process.cwd();
  const file = isAbsolute(path) ? path : resolve(base, path);
  let mod: unknown;
  try {
    mod = await (d.load ? d.load(file) : import(pathToFileURL(file).href));
  } catch (err) {
    throw new UsageError(`cannot load the fulfil module ${file}: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  const m = mod as { fulfil?: unknown; default?: unknown } | null;
  const fn = typeof m?.fulfil === "function" ? m.fulfil : typeof m?.default === "function" ? m.default : null;
  if (!fn) throw new UsageError(`${file} must export a function named fulfil (or a default function) taking (job, ctx) and returning { deliverableMarkdown, receipts }`);
  return fn as Fulfil;
}

function eventLine(e: WorkerEvent): string | null {
  switch (e.type) {
    case "poll":
      return e.assignments || e.skippedRows ? `poll: ${e.assignments} assignment(s) in progress${e.skippedRows ? `, ${e.skippedRows} row(s) skipped as malformed` : ""}` : null;
    case "taken":
      return `taken: ${e.assignmentId} (${e.round}, attempt ${e.attempt})`;
    case "submitted":
      return `submitted: ${e.assignmentId}, ${e.bytes} bytes, ${e.receipts} receipt(s), spent ${e.spentAtomic} atomic units on inputs`;
    case "submit_deferred":
      return `submit deferred: ${e.assignmentId} (${e.code}); the finished deliverable is kept and sent again`;
    case "fulfil_failed":
      return `fulfil failed: ${e.assignmentId} (attempt ${e.attempt}): ${e.reason}`;
    case "ceiling_breach":
      return `ceiling breach: ${e.assignmentId} reported ${e.spentAtomic} atomic units against a ceiling of ${e.ceilingAtomic}; not submitted`;
    case "declined":
      return `declined: ${e.assignmentId}; the buyer is refunded`;
    case "skipped":
      return `skipped: ${e.assignmentId} (${e.code})`;
    case "error":
      return `error${e.assignmentId ? ` on ${e.assignmentId}` : ""} (${e.code}): ${e.message}\n  Next: ${e.nextStep}`;
    case "stopped":
      return `stopped: ${e.reason}`;
  }
}

async function work(argv: string[], d: Required<Pick<CliDeps, "out" | "err" | "env">> & CliDeps): Promise<number> {
  const f = parseFlags(argv, { values: ["fulfil", "ceiling", "assignment", "concurrency"], switches: ["dry-run", "once", "real-receipts"] });
  if (f.positional.length) throw new UsageError(`work takes no positional argument (got ${printable(f.positional[0]!, 40)})`);
  const fulfilPath = f.values.get("fulfil");
  const maxConcurrent = intFlag(f.values.get("concurrency"), 1, "--concurrency", 1, 16);

  if (f.switches.has("dry-run")) {
    const spendCeilingAtomic = usdcFlag(f.values.get("ceiling"), d.env.AGENT_MARKET_SPEND_CEILING_USDC ?? "0.50", "--ceiling");
    let rows: unknown[] | undefined;
    const file = f.values.get("assignment");
    if (file) {
      const path = isAbsolute(file) ? file : resolve(d.cwd ?? d.env.INIT_CWD ?? process.cwd(), file);
      try {
        const json = JSON.parse(readFileSync(path, "utf8")) as unknown;
        rows = Array.isArray(json) ? json : json !== null && typeof json === "object" && Array.isArray((json as { assignments?: unknown }).assignments) ? (json as { assignments: unknown[] }).assignments : [json];
      } catch (err) {
        throw new UsageError(`cannot read ${path} as JSON: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
    const fulfil = fulfilPath ? await loadFulfil(fulfilPath, d) : sampleFulfil;
    const worker = createMarketWorker({ fulfil, spendCeilingAtomic, maxConcurrent });
    const run = await worker.dryRun({ ...(rows ? { rows } : {}), realReceipts: f.switches.has("real-receipts") });
    d.out("DRY RUN: nothing is sent to the market, and no account or token is used.");
    d.out(`Assignment: ${file ? `recorded rows from ${file}` : "the built-in sample row (synthetic, in the shape of the market's assignment list)"}.`);
    d.out(`Fulfil: ${fulfilPath ? fulfilPath : "the built-in sample (placeholder text and sample receipts)"}.`);
    d.out(`Spend ceiling per job, set by you: ${usdc(spendCeilingAtomic)}. Job text cannot change it.`);
    if (!file) d.out("The sample brief contains a line telling the agent to raise its limit and pay a stranger. It reaches fulfil as data and changes nothing.");
    d.out("");
    d.out("What the worker would have sent to the market:");
    for (const c of run.calls) d.out(`  ${c.call} ${c.assignmentId}${c.bytes !== undefined ? ` (${c.bytes} bytes of Markdown)` : ""}${c.reason ? ` (${c.reason})` : ""}`);
    for (const e of run.events) if (e.type === "fulfil_failed" || e.type === "ceiling_breach" || e.type === "error" || e.type === "skipped") d.out(`  ${eventLine(e)}`);
    if (run.deliverables.length === 0) {
      d.out("");
      d.out("No deliverable was produced.");
      d.out("Next: check that the recorded rows have the shape of GET /v1/agents/me/assignments and status in_progress, and that fulfil returns { deliverableMarkdown }.");
      return EXIT.error;
    }
    for (const x of run.deliverables) {
      d.out("");
      d.out(`----- deliverable for assignment ${x.assignmentId} -----`);
      d.out(x.markdown.trimEnd());
      d.out("----- end of deliverable -----");
    }
    d.out("");
    d.out("Next: to work the live market, a person lists the agent and creates its token; run `market work` without --dry-run to see the steps.");
    return EXIT.ok;
  }

  const token = d.env.AGENT_MARKET_TOKEN;
  if (!token) {
    d.err("market work needs AGENT_MARKET_TOKEN, the aat_ token of an agent listed on the NEAR AI Agent Market.");
    d.err("This command cannot create one: listing an agent and minting its token is done by a person, once.");
    d.err("");
    for (const step of HUMAN_SETUP_STEPS) d.err(step);
    d.err("");
    d.err("To see the whole seller flow now, with no account: market work --dry-run");
    return EXIT.needsPerson;
  }
  if (!fulfilPath) throw new UsageError("work needs --fulfil <module>: the module that writes the deliverable. Try the flow first with: market work --dry-run");
  const ceiling = f.values.get("ceiling") ?? d.env.AGENT_MARKET_SPEND_CEILING_USDC;
  if (ceiling === undefined) throw new UsageError("work needs --ceiling <usdc>: the most one job may spend on inputs (0 lets the agent buy nothing)");
  const worker = createMarketWorker({
    fulfil: await loadFulfil(fulfilPath, d),
    spendCeilingAtomic: usdcFlag(ceiling, ceiling, "--ceiling"),
    token,
    maxConcurrent,
    market: { ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.clock ? { clock: d.clock } : {}) },
    ...(d.clock ? { clock: d.clock } : {}),
    onEvent: (e) => {
      const line = eventLine(e);
      if (line) (e.type === "error" ? d.err : d.out)(line);
    },
  });
  d.out(`Working the market as your agent. Spend ceiling per job: ${usdc(usdcFlag(ceiling, ceiling, "--ceiling"))}. Stop with Ctrl-C.`);
  const summary = await worker.start(d.signal, { once: f.switches.has("once") }).done;
  d.out(`Done: ${summary.submitted} submitted, ${summary.declined} declined, ${summary.failed} failed, ${summary.polls} poll(s).`);
  if (summary.stopped === "unauthorized") {
    d.err("The market no longer accepts this token.");
    d.err("Next: ask the agent's owner to create a new token on the agent's Edit page and set AGENT_MARKET_TOKEN again.");
    return EXIT.needsPerson;
  }
  return EXIT.ok;
}

/** Runs one command and returns its exit code. It never throws for an expected failure. */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const d = { ...deps, out: deps.out ?? ((l: string) => process.stdout.write(`${l}\n`)), err: deps.err ?? ((l: string) => process.stderr.write(`${l}\n`)), env: deps.env ?? process.env };
  const [command, ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      d.out(USAGE);
      return command === undefined ? EXIT.usage : EXIT.ok;
    }
    if (rest.includes("--help") || rest.includes("-h")) {
      d.out(USAGE);
      return EXIT.ok;
    }
    if (command === "search") return await search(rest, d);
    if (command === "quote") return await quote(rest, d);
    if (command === "work") return await work(rest, d);
    throw new UsageError(`unknown command ${printable(command, 40)}`);
  } catch (err) {
    if (err instanceof UsageError) {
      d.err(`market: ${err.message}`);
      d.err("Next: run `market help` to see the commands and their options.");
      return EXIT.usage;
    }
    if (err instanceof MarketError) {
      d.err(`market: ${err.message} (${err.code})`);
      d.err(`Next: ${err.nextStep}`);
      return err.code === "INVALID_ARGUMENT" ? EXIT.usage : err.code === "TOKEN_REQUIRED" || err.code === "UNAUTHORIZED" ? EXIT.needsPerson : EXIT.error;
    }
    d.err(`market: unexpected failure: ${err instanceof Error ? err.message : "unknown error"}`);
    d.err("Next: this is a bug in the command, not in your input. Run it again, and report the line above if it repeats.");
    return EXIT.error;
  }
}

function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  process.exitCode = await runCli(process.argv.slice(2), { signal: stop.signal });
}
