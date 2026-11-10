#!/usr/bin/env node
/**
 * `pnpm swarm`: the group-buying swarm on Payminto.
 *
 * Exit codes: 0 every check passed, 1 a check failed or the run broke, 2 a mistake in the options or an unreadable
 * file, 3 the timeout passed, 130 interrupted. On every one of them the page, the agents' servers, the clearing node
 * and the chain are stopped first.
 */
import { DEFAULT_OUT_DIR, helpText, loadSwarmConfig, shown, SwarmConfigError, type RunConfig, type SwarmConfig } from "./config.ts";

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);

let cfg: SwarmConfig;
try {
  cfg = loadSwarmConfig(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof SwarmConfigError)) throw e;
  err(e.message);
  process.exit(2);
}

if (cfg.command === "help") {
  out(helpText());
  process.exit(0);
}

if (cfg.command === "verify" || cfg.command === "prove") {
  // The file tools load nothing but the rules, so they start at once and need no node.
  const { verifyRoundFile, proveReceiptFile } = await import("./tools.ts");
  const example = `${shown(DEFAULT_OUT_DIR)}/round-1${cfg.command === "verify" ? "" : ".receipt"}.json`;
  const result = cfg.command === "verify" ? verifyRoundFile(cfg.file, example) : proveReceiptFile(cfg.file, example);
  for (const line of result.lines) (result.code === 2 ? err : out)(line);
  process.exit(result.code);
}

await run(cfg as RunConfig);

async function run(c: RunConfig): Promise<never> {
  const { startWorld, SwarmStartError } = await import("./world.ts");
  const { runSwarm } = await import("./run.ts");
  const { checkRun, measuredTable } = await import("./checks.ts");
  const { startPage, PortInUseError } = await import("./serve.ts");
  const { verifyReceipt, receiptFileSchema } = await import("@payminto/demo");
  const { readFileSync, mkdirSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  const started = Date.now();
  let lastLine = "";
  const say = (line: string) => {
    if (line.trim()) lastLine = line.trim();
    out(line);
  };

  let page: Awaited<ReturnType<typeof startPage>> | undefined;
  let world: Awaited<ReturnType<typeof startWorld>> | undefined;
  let stopping: Promise<void> | null = null;
  /** Stops the page, the agents' servers, the node and the chain, at most once, and gives up after 20 seconds. */
  const shutdown = (): Promise<void> => {
    stopping ??= Promise.race([
      (async () => {
        await page?.close().catch(() => {});
        await world?.stop().catch(() => {});
      })(),
      new Promise<void>((r) => setTimeout(r, 20_000).unref()),
    ]);
    return stopping;
  };
  const leave = async (code: number): Promise<never> => {
    await shutdown();
    process.exit(code);
  };

  let interrupted = false;
  let wakeInterrupt: () => void = () => {};
  const interruption = new Promise<void>((r) => (wakeInterrupt = r));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (interrupted) {
        err("Second interrupt: leaving now.");
        process.exit(130);
      }
      interrupted = true;
      err("");
      err(`Interrupted (${signal}). Stopping the ${c.serve ? "page, the " : ""}agents, the clearing node${c.chain === "sandbox" ? " and the sandbox" : ""}.`);
      wakeInterrupt();
      void leave(130);
    });
  }

  say("Payminto swarm: buyer agents pool demand for GPU hours, sellers bid sealed, the clearing node nets and settles.");

  // The output directory holds only what a run writes; files of an earlier run are replaced.
  try {
    mkdirSync(c.outDir, { recursive: true });
    for (const name of readdirSync(c.outDir)) if (/^round-[0-9]+(\.receipt(\.tampered)?)?\.json$/.test(name)) rmSync(join(c.outDir, name), { force: true });
  } catch (e) {
    err(`Cannot write to the output directory ${c.outDir}: ${(e as NodeJS.ErrnoException).code ?? String(e)}.`);
    err("What to do: pass --out <dir> with a directory this user can write to, or leave --out out to use apps/swarm/data/last-run.");
    process.exit(2);
  }

  let timer: NodeJS.Timeout | undefined;
  const armTimeout = () => {
    timer = setTimeout(() => {
      err("");
      err(`TIMEOUT: the run did not finish within ${c.timeoutSec} s. Last step: ${lastLine}`);
      err("What to do: run it again; if it is a large scenario, pass a longer --timeout <seconds> or fewer --buyers and --rounds.");
      void leave(3);
    }, c.timeoutSec * 1000);
  };

  let code = 1;
  try {
    if (c.serve) {
      page = await startPage({ port: c.port, outDir: c.outDir, chainLabel: c.chain === "fake" ? "SIMULATED" : "SANDBOX" });
    }
    armTimeout();
    world = await startWorld(c.scenario, { chain: c.chain, outDir: c.outDir, say });
    const w = world;
    if (page) {
      clearTimeout(timer);
      page.setLiveReceiptCheck(async (n) => {
        const file = receiptFileSchema.parse(JSON.parse(readFileSync(join(c.outDir, `round-${n}.receipt.json`), "utf8")));
        return verifyReceipt(w.chain, file);
      });
      say("");
      say(`Live page: ${page.url}`);
      say("Open it in a browser. The run starts when the page opens, and the page stays up until you press Ctrl-C.");
      await Promise.race([page.viewer, interruption]);
      if (interrupted) await leave(130);
      say("A page is connected: starting the run.");
      say("");
      armTimeout();
    }
    const pace = page && c.paceMs > 0 ? () => new Promise<void>((r) => setTimeout(r, c.paceMs)) : undefined;
    const report = await runSwarm(w, { outDir: c.outDir, outDirShown: shown(c.outDir), say, emit: (e) => page?.push(e), pace });
    clearTimeout(timer);

    const table = measuredTable(report);
    const checks = checkRun(report);
    const failed = checks.filter((x) => !x.ok).length;
    say("");
    say(`Measured in this run (chain state: ${report.label}):`);
    for (const row of table) say(`  ${row.measure.padEnd(30)} ${row.value}`);
    say("");
    say(`Checks (${report.label}):`);
    for (const x of checks) say(`  ${x.ok ? "PASS" : "FAIL"}  ${x.name}: ${x.detail}`);
    say(`${checks.length - failed} of ${checks.length} checks passed.`);
    page?.push({ type: "run.finished", table, checks, ok: failed === 0 });
    code = failed > 0 ? 1 : 0;
    // The elapsed time goes to stderr, so the same seed prints the same stdout every time.
    err(`Finished in ${((Date.now() - started) / 1000).toFixed(1)} s. Round files and receipt proofs are in ${shown(c.outDir)}.`);
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof SwarmConfigError || e instanceof PortInUseError) {
      err(e.message);
      await leave(2);
    }
    if (e instanceof SwarmStartError) {
      err(e.message);
      await leave(1);
    }
    err(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    err(`Last step: ${lastLine}`);
    err("What to do: run the command again. If it fails the same way, run `pnpm --filter @payminto/swarm test` and report the first failing test with the lines above.");
    await leave(1);
  }

  if (page && !interrupted) {
    say("");
    say(`The run is over and the page is still up at ${page.url}: use its replay control, open a round file or a receipt proof.`);
    say("Press Ctrl-C to stop.");
    await interruption;
    // The signal handler stops everything and exits.
    await new Promise<never>(() => {});
  }
  return leave(code);
}
