#!/usr/bin/env node
/**
 * payminto-payee-check: judge a NEAR account before paying it.
 * Read-only. It holds no key, signs nothing and sends no transaction. `report` writes to a local file only.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAccountId, printable, type AccountId } from "./account.ts";
import { nearBlocksAgeSource } from "./age.ts";
import { StoreError, type ReportInput } from "./blocklist.ts";
import { createPayeeCheck } from "./check.ts";
import type { FetchLike } from "./http.ts";
import { FileBlocklist, FileCodeStore } from "./node.ts";
import { NEAR_RPC_URLS, RpcNearReader, SETTLEMENT_TOKENS, firstAnswering, rpcEndpoints, type NearNetwork } from "./rpc.ts";
import type { Verdict } from "./verdict.ts";
import { toView } from "./view.ts";

export type CliDeps = {
  fetch?: FetchLike;
  out?: (line: string) => void;
  err?: (line: string) => void;
  clock?: () => number;
  /** Per-request time limit. Default 8000. */
  timeoutMs?: number;
};

export const USAGE = `payminto-payee-check - judge a NEAR account before paying it. Read-only: no keys, no transactions.

  check <account> [options]     Print allow, warn or block for the account, with the reasons.
  report <account> [options]    Add a report to a local blocklist file. Nothing is sent anywhere.

Options for check
  --network testnet|mainnet     Default: mainnet for names ending in .near or .tg, otherwise testnet.
  --rpc-url <url>               A NEAR JSON-RPC endpoint. Default: a public endpoint, with a second one as backup.
  --token <account>|none        The settlement token to check registration with. Default: USDC on the network.
  --allowed <a,b,...>           Payees the Budget already allows, to catch lookalike names.
  --store <dir>                 A directory holding blocklist.json and code-seen.json, to use reports and spot code changes.
  --no-indexer                  Skip the account age lookup at NearBlocks.
  --json                        Print the verdict as JSON.
  --exit-code                   Exit 0 on allow, 10 on warn, 20 on block. Without it a verdict always exits 0.

Options for report
  --store <dir>                 Required. Where blocklist.json lives.
  --reporter <account>          Required. Who reports.
  --reason <text>               Required. One line, at most 280 characters.
  --evidence <url or tx hash>   Required. An https URL or a NEAR transaction hash.

Examples
  pnpm --filter @payminto/payee-check check near-examples.testnet
  pnpm --filter @payminto/payee-check check acrne.testnet --allowed acme.testnet
  pnpm --filter @payminto/payee-check check near --network mainnet --json`;

const VALUE_FLAGS = new Set(["network", "rpc-url", "token", "allowed", "store", "reporter", "reason", "evidence"]);
const BOOLEAN_FLAGS = new Set(["json", "no-indexer", "exit-code", "help"]);

const REPORT_EXAMPLE = 'pnpm --filter @payminto/payee-check report scam.testnet --store ./payee-store --reporter you.testnet --reason "took payment, sent nothing" --evidence https://example.com/proof';

/** A mistake in how the command was called. The message says what to do instead. */
class UsageError extends Error {}

function parseArgs(argv: string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h") {
      flags.set("help", "true");
    } else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, "true");
      } else if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value. Run with --help to see an example.`);
        flags.set(name, value);
      } else {
        throw new UsageError(`Unknown option --${printable(name, 30)}. Run with --help to see the options.`);
      }
    } else {
      words.push(arg);
    }
  }
  return { words, flags };
}

const inferNetwork = (account: string): NearNetwork => (/\.(near|tg)$/.test(account) ? "mainnet" : "testnet");

/** Spelling help for text that is not an account id, or for a name that does not exist. */
function suggestionFor(payee: string, network: NearNetwork, verdict: Verdict): string | null {
  const ids = new Set(verdict.signals.map((s) => s.id));
  const suffix = network === "mainnet" ? ".near" : ".testnet";
  if (ids.has("invalid_account_id")) {
    const tidy = payee.trim().toLowerCase().replace(/^@/, "");
    if (tidy !== payee && isAccountId(tidy)) return `Did you mean ${tidy}? Account ids are lowercase.`;
    return "An account id looks like acme.testnet or acme.near: 2 to 64 characters of a-z, 0-9, hyphen, underscore and dot.";
  }
  if (ids.has("account_missing")) {
    if (network === "testnet" && /\.(near|tg)$/.test(payee)) return `This looks like a mainnet name. Try again with --network mainnet.`;
    if (network === "mainnet" && payee.endsWith(".testnet")) return `This looks like a testnet name. Try again with --network testnet.`;
    if (!payee.includes(".") && payee.length < 64) return `Named accounts on ${network} usually end in ${suffix}. Did you mean ${payee}${suffix}?`;
    return `Check the spelling, or try the other network with --network ${network === "testnet" ? "mainnet" : "testnet"}.`;
  }
  return null;
}

type Run = { network: NearNetwork; rpcUrls: string[]; token: AccountId | null; ageSource: string | null; store: string | null };

/** What the person can do about each thing that went wrong or was left out. */
function adviceFor(verdict: Verdict, run: Run, customRpc: boolean): string[] {
  const advice: string[] = [];
  for (const s of verdict.signals) {
    if (s.id === "check_failed") {
      advice.push(
        customRpc
          ? `The RPC endpoint ${run.rpcUrls[0]} did not answer (${String(s.facts.cause)}). Check the URL, or leave --rpc-url out to use the public endpoints.`
          : `No public RPC endpoint answered (${String(s.facts.cause)}). Check your connection and try again, or pass your own endpoint with --rpc-url <url>.`,
      );
    }
    if (s.id === "check_incomplete") {
      for (const m of s.facts.missing as Array<{ fact: string; cause: string }>) {
        if (m.fact === "age") advice.push(`The account age could not be read from NearBlocks (${m.cause}). Try again in a minute, or pass --no-indexer to skip the age lookup.`);
        else if (m.fact === "token") advice.push(`Token registration could not be read (${m.cause}). Check that --token names a token contract on ${run.network}, or pass --token none.`);
        else if (m.fact === "reports" || m.fact === "code") advice.push(`The store in ${run.store} could not be read (${m.cause}). Fix or remove the file, or pass another --store.`);
        else advice.push(`${m.fact} could not be read (${m.cause}). Try again in a moment.`);
      }
    }
  }
  return advice;
}

const NOT_CHECKED_HELP: Record<string, string> = {
  age: "account age: remove --no-indexer to look it up",
  token: "token registration: pass --token <account>",
  history: "prior payments: the node supplies these, not the command line",
  reports: "shared blocklist: pass --store <dir>",
  code: "code changes since the last check: pass --store <dir>",
  lookalike: "lookalike names: pass --allowed <a,b,...> with the Budget's payees",
};

const CHECKED_NAMES: Record<string, string> = {
  account: "account state",
  keys: "access keys",
  age: "account age",
  code: "code changes",
  token: "token registration",
  history: "prior payments",
  reports: "shared blocklist",
  lookalike: "lookalike names",
};

function printVerdict(out: (line: string) => void, verdict: Verdict, run: Run, extra: string[]): void {
  const view = toView(verdict);
  out(`Payee     ${view.payee}`);
  out(`Kind      ${view.accountKind}`);
  out(`Network   NEAR ${run.network}`);
  out(`Verdict   ${verdict.verdict.toUpperCase()} - ${view.headline}`);
  out("");
  out(view.summary);
  if (view.signals.length > 0) {
    out("");
    out("Signals");
    for (const s of view.signals) {
      out(`  ${s.severity.padEnd(5)} ${s.id}`);
      out(`        ${s.reason}`);
    }
  }
  if (view.reports.length > 0) {
    out("");
    out("Reports (claims by third parties, quoted as written)");
    for (const r of view.reports) out(`  ${r.at.slice(0, 10)}  ${r.reporter}: "${r.quote}"  [${r.evidence.label.toLowerCase()}: ${r.evidence.text}]`);
  }
  if (verdict.checked.length > 0) {
    out("");
    out(`Checked   ${verdict.checked.map((id) => CHECKED_NAMES[id] ?? id).join(", ")}`);
  }
  if (verdict.notChecked.length > 0) {
    out("");
    out("Not checked");
    for (const id of verdict.notChecked) out(`  ${NOT_CHECKED_HELP[id] ?? id}`);
  }
  // For these three the command line has more exact advice than the general next step, so it replaces it.
  const top = verdict.signals[0]?.id;
  const replaced = extra.length > 0 && (top === "invalid_account_id" || top === "account_missing" || top === "check_failed");
  out("");
  out("Next");
  for (const line of replaced ? extra : [view.nextStep, ...extra]) out(`  ${line}`);
  out("");
  if (verdict.kind === null) {
    out("Sources   none: nothing was read, because the text is not an account id");
  } else {
    const used = [`RPC ${run.rpcUrls.join(", then ")}`];
    if (run.ageSource && verdict.checked.includes("age")) used.push(`age from ${run.ageSource}`);
    if (run.token && verdict.checked.includes("token")) used.push(`token ${run.token}`);
    out(`Sources   ${used.join("; ")}`);
  }
  out("These are heuristics, not a guarantee. Read-only: nothing was signed or sent.");
}

async function check(words: string[], flags: Map<string, string>, deps: Required<Pick<CliDeps, "out" | "clock">> & CliDeps): Promise<number> {
  const payee = words[0];
  if (payee === undefined) throw new UsageError("Name the account to check, for example: pnpm --filter @payminto/payee-check check near-examples.testnet");
  if (words.length > 1) throw new UsageError(`Check one account at a time. Got ${words.length}: put options after the account and quote values that contain spaces.`);
  const misplaced = ["reporter", "reason", "evidence"].find((name) => flags.has(name));
  if (misplaced) throw new UsageError(`--${misplaced} belongs to report, not check. To file a report: ${REPORT_EXAMPLE}`);

  const networkFlag = flags.get("network");
  if (networkFlag !== undefined && networkFlag !== "testnet" && networkFlag !== "mainnet") throw new UsageError("--network must be testnet or mainnet.");
  const network: NearNetwork = networkFlag ?? inferNetwork(payee);

  const rpcFlag = flags.get("rpc-url");
  if (rpcFlag !== undefined && !/^https?:\/\/\S+$/.test(rpcFlag)) throw new UsageError("--rpc-url must be an http(s) URL, for example https://rpc.testnet.near.org");
  // An endpoint named with --rpc-url is read alone, whatever it is; without the flag the public pair is read.
  const rpcUrls = rpcFlag ? [rpcFlag] : rpcEndpoints(NEAR_RPC_URLS[network]);

  const tokenFlag = flags.get("token");
  if (tokenFlag !== undefined && tokenFlag !== "none" && !isAccountId(tokenFlag)) throw new UsageError("--token must be a NEAR account id, or none to skip the registration check.");
  const token = tokenFlag === "none" ? null : (tokenFlag ?? SETTLEMENT_TOKENS[network]);

  const allowed = flags.get("allowed")?.split(",").map((a) => a.trim()).filter((a) => a !== "");
  const bad = allowed?.find((a) => !isAccountId(a));
  if (bad !== undefined) throw new UsageError(`--allowed takes account ids separated by commas. "${printable(bad, 40)}" is not an account id.`);

  const store = flags.has("store") ? resolve(flags.get("store")!) : null;
  const ageSource = flags.has("no-indexer") ? null : nearBlocksAgeSource({ network, fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  const run: Run = { network, rpcUrls, token, ageSource: ageSource?.name ?? null, store };

  const judge = createPayeeCheck({
    reader: firstAnswering(rpcUrls.map((url) => new RpcNearReader({ url, fetch: deps.fetch, timeoutMs: deps.timeoutMs }))),
    clock: deps.clock,
    ...(token ? { token } : {}),
    ...(ageSource ? { ageSource } : {}),
    ...(store ? { blocklist: new FileBlocklist({ path: join(store, "blocklist.json"), clock: deps.clock }), codeStore: new FileCodeStore({ path: join(store, "code-seen.json") }) } : {}),
  });
  if (store) mkdirSync(store, { recursive: true });
  const verdict = await judge({ payee, budgetPayees: allowed ?? null });

  if (flags.has("json")) {
    deps.out(JSON.stringify({ ...verdict, network, rpcUrls, token, ageSource: run.ageSource }, null, 2));
  } else {
    const hint = suggestionFor(payee, network, verdict);
    printVerdict(deps.out, verdict, run, [...(hint ? [hint] : []), ...adviceFor(verdict, run, rpcFlag !== undefined)]);
  }
  if (!flags.has("exit-code")) return 0;
  return verdict.verdict === "allow" ? 0 : verdict.verdict === "warn" ? 10 : 20;
}

async function report(words: string[], flags: Map<string, string>, deps: Required<Pick<CliDeps, "out" | "clock">>): Promise<number> {
  const account = words[0];
  if (account === undefined) throw new UsageError(`Name the account to report. Example: ${REPORT_EXAMPLE}`);
  const need = (name: string): string => {
    const v = flags.get(name);
    if (v === undefined) throw new UsageError(`report needs --${name}. Example: ${REPORT_EXAMPLE}`);
    return v;
  };
  const store = resolve(need("store"));
  const evidence = need("evidence");
  const input: ReportInput = {
    account,
    reporter: need("reporter"),
    reason: need("reason"),
    evidence: /^https?:\/\//i.test(evidence) ? { type: "url", url: evidence } : { type: "tx", hash: evidence },
  };
  mkdirSync(store, { recursive: true });
  const path = join(store, "blocklist.json");
  const saved = await new FileBlocklist({ path, clock: deps.clock }).report(input);
  deps.out(`Recorded the report by ${saved.reporter} against ${saved.account} in ${path}.`);
  deps.out(`Nothing was sent anywhere. See its effect with: pnpm --filter @payminto/payee-check check ${saved.account} --store ${flags.get("store")}`);
  return 0;
}

/** Runs the command line and returns the exit code. Expected failures print one helpful line and never a stack trace. */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const clock = deps.clock ?? Date.now;
  try {
    const { words, flags } = parseArgs(argv);
    if (flags.has("help") || words[0] === "help") {
      out(USAGE);
      return 0;
    }
    if (words[0] === "report") return await report(words.slice(1), flags, { out, clock });
    return await check(words[0] === "check" ? words.slice(1) : words, flags, { ...deps, out, clock });
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err("Run with --help for all options.");
      return 2;
    }
    if (e instanceof StoreError) {
      err(
        e.code === "invalid_report"
          ? `The report was not saved: ${e.message}. The account and reporter must be account ids, the reason one line of at most 280 characters, and the evidence an https URL or a transaction hash.`
          : `The store could not be used: ${e.message}. Check that the directory is writable and the file is intact, or pass another --store.`,
      );
      return 1;
    }
    err(`Unexpected error: ${printable(e instanceof Error ? e.message : e, 200)}. Nothing was signed or sent. Please report this with the command you ran.`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
