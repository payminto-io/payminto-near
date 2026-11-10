#!/usr/bin/env node
/**
 * `pnpm local`: the whole Payminto product on this machine, on a real local NEAR node, for a person to use in a
 * browser. `pnpm local --check` runs the same stack and a scripted pass, and exits non-zero on any failure.
 *
 * Exit codes: 0 stopped cleanly (or every check passed), 1 a check failed or a part of the stack broke, 2 a usage or
 * start error, 130 interrupted. On every one of them the dashboard, the node, the signer and the sandbox are stopped.
 */
import { parseArgs, USAGE, UsageError, DATA_DIR, type LocalOptions } from "./config.ts";
import { runChecks } from "./check.ts";
import { DataError, dataPaths, runningStack, wipeData } from "./data.ts";
import { guide } from "./guide.ts";
import { liveBanner } from "./intents-live.ts";
import { PortBusyError } from "./ports.ts";
import { StartError, startStack, type Stack } from "./stack.ts";

const started = Date.now();
const say = (line: string) => process.stdout.write(`${line}\n`);
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);

let opts: LocalOptions;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

if (opts.mode === "help") {
  say(USAGE);
  process.exit(0);
}

if (opts.mode === "reset") {
  try {
    const paths = dataPaths();
    const other = runningStack(paths);
    if (other) {
      process.stderr.write(`pnpm local is running (process ${other.pid}). Stop it with Ctrl-C in its terminal, then reset.\n`);
      process.exit(2);
    }
    const out = wipeData(DATA_DIR);
    say(out.removed ? `Deleted ${DATA_DIR} (${out.databases.length} database(s), each named *.demo.db and accepted by the node's reset guard).` : `Nothing to delete: ${DATA_DIR} does not exist.`);
    process.exit(0);
  } catch (err) {
    if (!(err instanceof DataError)) throw err;
    process.stderr.write(`${err.message}\nNothing was deleted.\n`);
    process.exit(2);
  }
}

let stack: Stack | undefined;
let stopping: Promise<void> | null = null;
/** Stops everything at most once, and gives up after 30 s (the exit hooks then kill the sandbox and the dashboard). */
const shutdown = (): Promise<void> => {
  stopping ??= Promise.race([(stack?.stop() ?? Promise.resolve()).catch(() => {}), new Promise<void>((r) => setTimeout(r, 30_000).unref())]);
  return stopping;
};
const leave = async (code: number): Promise<never> => {
  await shutdown();
  process.exit(code);
};

let interrupted = false;
let starting = true;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (interrupted) {
      say("Second interrupt: stopping everything now.");
      process.exit(130);
    }
    interrupted = true;
    say("");
    say(`Stopping (${signal}): the dashboard, the clearing node, the signer and the local NEAR node.`);
    if (starting) {
      // Nothing is worth finishing half way through a start. The exit hooks stop the sandbox node and the dashboard
      // dev server synchronously, and the node and the signer live in this process.
      process.exit(130);
    }
    void leave(130).catch(() => process.exit(130));
  });
}
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    say("");
    say(`A part of the local stack failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    say("Stopping everything.");
    void leave(1);
  });
}

say("Payminto local: the real contracts, the real clearing node and the dashboard, on a NEAR node on this machine.");
if (opts.intents.mode === "live") {
  // Said before anything starts, so a person who did not mean it can press Ctrl-C now.
  say("");
  for (const line of liveBanner(opts.intents.payout)) say(line);
} else {
  say("Nothing here reaches testnet or mainnet, and nothing needs an account, a wallet extension or a secret.");
}
say("");
try {
  stack = await startStack(opts, say);
} catch (err) {
  if (interrupted) process.exit(130);
  say("");
  if (err instanceof StartError || err instanceof PortBusyError || err instanceof DataError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`pnpm local could not start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}
starting = false;
if (interrupted) await leave(130);

stack.onCrash((what, detail) => {
  say("");
  say(`${what} stopped: ${detail}`);
  say("The local stack cannot go on without it. Stopping everything; run pnpm local again for a fresh one.");
  void leave(1);
});

if (opts.mode === "check") {
  let failed = 1;
  try {
    const checks = await runChecks(stack, say);
    failed = checks.filter((c) => !c.ok).length;
    say("");
    say(`Checks (a local NEAR node: near-sandbox on 127.0.0.1; chain facts read through a client that holds no key):`);
    for (const c of checks) say(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    say(`${checks.length - failed} of ${checks.length} checks passed in ${seconds()} s.`);
  } catch (err) {
    say("");
    say(`FAILED after ${seconds()} s: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    say(`Logs: ${stack.paths.logs}`);
  }
  await leave(failed > 0 ? 1 : 0);
}

say("");
for (const line of guide(stack)) say(line);
say("");
say(`Ready in ${seconds()} s. Press Ctrl-C to stop everything.`);
await new Promise<never>(() => {
  // Resolved only by the signal and crash handlers above, which stop everything and exit.
  setInterval(() => {}, 1 << 30);
});
