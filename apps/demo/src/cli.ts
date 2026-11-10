#!/usr/bin/env node
/**
 * `pnpm demo [--chain fake|sandbox] [--scale <n>] [--timeout <seconds>] [--keep]`: the whole Payminto story in one
 * process, then a checks block.
 *
 * Exit codes: 0 every check passed, 1 a check failed or the run broke, 2 a configuration error, 3 the overall timeout
 * passed, 130 interrupted. On every one of them the node and the sandbox are stopped; a second Ctrl-C kills the
 * sandbox at once.
 */
import { checkReport } from "./checks.ts";
import { DemoConfigError, loadDemoConfig, type DemoConfig } from "./config.ts";
import { runStory, type Report } from "./scenario.ts";
import { startStack, type Stack } from "./stack.ts";

const started = Date.now();
let lastLine = "";
const say = (line: string) => {
  if (line.trim()) lastLine = line.trim();
  process.stdout.write(`${line}\n`);
};
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);

let cfg: DemoConfig;
try {
  cfg = loadDemoConfig(process.env, process.argv.slice(2));
} catch (err) {
  if (!(err instanceof DemoConfigError)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

let stack: Stack | undefined;
let stopping: Promise<void> | null = null;
/** Stops the agents, the node and the chain, at most once, and gives up after 20 s (the exit hook then kills the sandbox). */
const shutdown = (): Promise<void> => {
  stopping ??= Promise.race([(stack?.stop() ?? Promise.resolve()).catch(() => {}), new Promise<void>((r) => setTimeout(r, 20_000).unref())]);
  return stopping;
};
const leave = async (code: number): Promise<never> => {
  await shutdown();
  process.exit(code);
};

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (interrupted) {
      say("Second interrupt: stopping the sandbox now.");
      process.exit(130);
    }
    interrupted = true;
    say("");
    say(`Interrupted (${signal}) after ${seconds()} s. Stopping the node${cfg.chain === "sandbox" ? " and the sandbox" : ""}.`);
    void leave(130);
  });
}

const timer = setTimeout(() => {
  say("");
  say(`TIMEOUT: the demo did not finish within ${cfg.timeoutSec} s (raise it with --timeout <seconds>). Last step: ${lastLine}`);
  if (stack?.hub.kind === "sandbox") say(`The sandbox node's own log is in ${stack.runDir}/sandbox.log.`);
  void leave(3);
}, cfg.timeoutSec * 1000);

say("Payminto: a clearing layer for agent payments on NEAR.");
let failed = 0;
let report: Report | undefined;
try {
  stack = await startStack(cfg, { say });
  report = await runStory(stack, say);
  const checks = checkReport(report);
  failed = checks.filter((c) => !c.ok).length;
  say("");
  say(`Checks (${stack.hub.label}):`);
  for (const c of checks) say(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  const stats = stack.hub.stats();
  if (stats) say(`near-sandbox produced ${stats.blocks} blocks during the run; the longest wait for a block was ${(stats.longestGapMs / 1000).toFixed(1)} s, with ${stats.stalls} stall warning(s).`);
  say(`${checks.length - failed} of ${checks.length} checks passed in ${seconds()} s.`);
} catch (err) {
  if (err instanceof DemoConfigError) {
    process.stderr.write(`${err.message}\n`);
    clearTimeout(timer);
    await leave(2);
  }
  failed = 1;
  say(`FAILED after ${seconds()} s: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (stack?.hub.kind === "sandbox" || cfg.chain === "sandbox") say("The sandbox node's own log is sandbox.log in the run directory above.");
}
clearTimeout(timer);

if (cfg.keep && stack?.hub.rpcUrl && report?.verifier.receiptPath && !interrupted) {
  say("");
  say("The sandbox stays up so you can check the receipt yourself. The clearing node is already stopped. In another terminal:");
  say(`  pnpm verify:near --rpc-url ${stack.hub.rpcUrl} --hub ${stack.hub.chain.hub} --receipt ${report.verifier.receiptPath}`);
  say("Press Ctrl-C to stop the sandbox.");
  await new Promise<never>(() => {
    // Resolved only by the signal handlers above, which stop everything and exit.
    setInterval(() => {}, 1 << 30);
  });
}
await leave(failed > 0 ? 1 : 0);
