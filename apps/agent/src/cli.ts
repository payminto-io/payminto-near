#!/usr/bin/env node
/**
 * payminto-agent run "<task>"          buyer agent: spends through the wallet MCP server under a per-task ceiling
 * payminto-agent ops "<question>"      ops agent: answers from the merchant MCP server (business API key)
 * payminto-agent serve                 agent service: POST /v1/runs hands the buyer agent a task over HTTP
 * payminto-agent serve-skill market-brief
 *                                      seller agent: the NEAR market brief, sold per call behind the paywall
 * payminto-agent market work           seller agent on the NEAR AI Agent Market: takes jobs, buys its inputs through
 *                                      its Budget under a ceiling per job, and lists their receipts (--dry-run needs
 *                                      no account)
 *
 * Progress goes to stderr; stdout carries the answer and spend report (or JSON with --json).
 */
import { AgentKeyFileError, defaultAgentKeyPath, writeAgentKeyFile } from "@payminto/sdk";
import { runBuyerTask, runOpsTask } from "./agents.ts";
import { AgentConfigError, limitsFromEnv, MissingApiKeyError, modelFromEnv, parseMcpSpec, serviceConfig } from "./config.ts";
import type { McpServerSpec } from "./mcp.ts";
import { marketWork } from "./market.ts";
import { renderRun, type RunEvent, type RunLimits, type RunResult } from "./runtime.ts";
import { serveMarketBrief } from "./serve-skill.ts";
import { createAgentService, listen } from "./service.ts";

const USAGE = `Usage:
  payminto-agent keygen [--out <path>] [--force]
  payminto-agent run "<task>" [--json] [--max-spend <base units>] [--max-turns <n>] [--mcp <url|command>]
  payminto-agent ops "<question>" [--json] [--max-turns <n>]
  payminto-agent serve
  payminto-agent serve-skill market-brief
  payminto-agent market work [--dry-run] [--ceiling <usdc>] [--assignment <file.json>] [--receipts-dir <dir>] [--once] [--json]

Environment: see apps/agent/README.md (PAYMINTO_AGENT_PROVIDER, ANTHROPIC_API_KEY or the provider's key, PAYMINTO_AGENT_MODEL,
PAYMINTO_AGENT_BASE_URL, NODE_URL, AGENT_KEY_FILE, BUDGET_ID, ...).`;

const err = (s: string) => process.stderr.write(`${s}\n`);
const log = (s: string) => err(`[payminto-agent] ${s}`);

type Flags = { json: boolean; maxSpend?: bigint; maxTurns?: number; mcp: McpServerSpec[]; positional: string[] };

function parseFlags(argv: string[]): Flags {
  const f: Flags = { json: false, mcp: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new AgentConfigError([`${a}: needs a value`]);
      return v;
    };
    if (a === "--json") f.json = true;
    else if (a === "--max-spend") {
      const v = value();
      if (!/^\d+$/.test(v)) throw new AgentConfigError(["--max-spend: a whole number of token base units (6 decimals: 100000 is 0.10)"]);
      f.maxSpend = BigInt(v);
    } else if (a === "--max-turns") {
      const v = value();
      if (!/^[1-9]\d*$/.test(v)) throw new AgentConfigError(["--max-turns: a positive integer"]);
      f.maxTurns = Number(v);
    } else if (a === "--mcp") f.mcp.push(parseMcpSpec(`extra-${f.mcp.length + 1}`, value()));
    else if (a.startsWith("--")) throw new AgentConfigError([`unknown option ${a}`]);
    else f.positional.push(a);
  }
  return f;
}

function progress(e: RunEvent) {
  if (e.type === "tool") {
    const args = JSON.stringify(e.input);
    log(`turn ${e.turn}: ${e.name}(${args.length > 120 ? `${args.slice(0, 119)}...` : args}) -> ${e.outcome.isError ? "ERROR " : ""}${e.outcome.text.split("\n", 1)[0]}`);
  } else if (e.type === "stop") log(`stopped: ${e.status}${e.note ? ` (${e.note})` : ""}`);
}

function print(r: RunResult, json: boolean): number {
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${renderRun(r)}\n`);
  if (r.status === "completed") return 0;
  return r.status === "model_error" ? 1 : 3;
}

function limitsOf(f: Flags, base: RunLimits): Partial<RunLimits> {
  return { ...base, ...(f.maxSpend !== undefined ? { maxSpendAtomic: f.maxSpend } : {}), ...(f.maxTurns ? { maxTurns: f.maxTurns } : {}) };
}

/**
 * Writes a new agent key (mode 0600, directory 0700) and prints only its public key on stdout, for the owner to put in
 * a Budget. The secret never reaches stdout, stderr or any environment variable.
 */
function keygen(argv: string[]): number {
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") force = true;
    else if (a === "--out") {
      out = argv[++i];
      if (!out) throw new AgentConfigError(["--out: needs a path"]);
    } else throw new AgentConfigError([`keygen: unknown argument ${a}`]);
  }
  try {
    const k = writeAgentKeyFile(out ?? defaultAgentKeyPath(process.env), { force });
    process.stdout.write(`${k.publicKey}\n`);
    log(`agent key written to ${k.path} (mode 0600). Put the public key above in the agent's Budget; the wallet reads the file through AGENT_KEY_FILE.`);
    return 0;
  } catch (e) {
    if (e instanceof AgentKeyFileError) throw new AgentConfigError([`keygen: ${e.message}`]);
    throw e;
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return cmd ? 0 : 2;
  }
  if (cmd === "keygen") return keygen(rest);
  if (cmd === "market") {
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    process.once("SIGTERM", () => stop.abort());
    // INIT_CWD is where `pnpm agent ...` was typed: receipt files go under it, where the proof command looks for them.
    return marketWork(rest, process.env, { out: (s) => process.stdout.write(`${s}\n`), log, signal: stop.signal, cwd: process.env.INIT_CWD ?? process.cwd() });
  }
  const f = parseFlags(rest);
  const { effort, ...base } = limitsFromEnv(process.env);
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());

  if (cmd === "run" || cmd === "ops") {
    const task = f.positional.join(" ").trim();
    if (!task) throw new AgentConfigError([`${cmd}: give the ${cmd === "run" ? "task" : "question"} in quotes`]);
    const o = { task, effort, limits: limitsOf(f, base), extraServers: f.mcp, signal: abort.signal, onEvent: progress };
    return print(cmd === "run" ? await runBuyerTask(o) : await runOpsTask(o), f.json);
  }

  if (cmd === "serve") {
    const cfg = serviceConfig(process.env);
    // Fail at startup, not on the first request, when the model or the wallet is not configured.
    modelFromEnv(process.env, { effort });
    const svc = createAgentService({
      token: cfg.token,
      maxSpendAtomic: base.maxSpendAtomic,
      maxRuns: cfg.maxRuns,
      runTask: (task, { maxSpendAtomic, signal }) =>
        runBuyerTask({ task, effort, limits: { ...base, maxSpendAtomic }, extraServers: f.mcp, signal, onEvent: progress }),
    });
    const h = await listen(svc.app, cfg.port, cfg.host);
    log(`agent service on ${h.url} (POST /v1/runs, GET /v1/runs/:id; bearer token required)`);
    await new Promise<void>((r) => abort.signal.addEventListener("abort", () => r(), { once: true }));
    await svc.close();
    await h.close();
    return 0;
  }

  if (cmd === "serve-skill") {
    const skill = f.positional[0];
    if (skill !== "market-brief") throw new AgentConfigError([`serve-skill: unknown skill ${skill ?? "(none)"}; the available skill is market-brief`]);
    const s = await serveMarketBrief(process.env, log);
    log(`NEAR market brief on ${s.url} (provider ${s.providerId}, seller ${s.seller}, price ${s.price} base units)`);
    await new Promise<void>((r) => abort.signal.addEventListener("abort", () => r(), { once: true }));
    await s.close();
    return 0;
  }

  throw new AgentConfigError([`unknown command ${cmd}\n\n${USAGE}`]);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof AgentConfigError || e instanceof MissingApiKeyError) {
    err(e.message);
    process.exitCode = 2;
  } else {
    err(`payminto-agent failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  }
}
