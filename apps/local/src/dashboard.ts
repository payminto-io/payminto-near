/**
 * The dashboard, as its own process: `next dev` in apps/dashboard, pointed at the local node and the local signer.
 *
 * It runs in its own process group with its output in a log file, so stopping it stops everything it started, and a
 * crash is noticed and reported instead of leaving a dead page behind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DASHBOARD_DIR } from "./config.ts";

export type DashboardOptions = {
  port: number;
  nodeUrl: string;
  signerUrl: string;
  signerToken: string;
  /** The gas relayer, for "Revoke without gas". */
  relayerUrl: string;
  /** The RPC the browser reads proofs from; empty lets the page use the RPC the local node reports. */
  rpcUrl: string;
  /** `--intents live --intents-rpc`: the NEAR mainnet RPC the proof page reads an any-chain delivery from; null for the public one. */
  mainnetRpcUrl?: string | null;
  logPath: string;
  readyTimeoutMs?: number;
};

export class DashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(path: string, bytes = 1_500): string {
  try {
    return readFileSync(path, "utf8").slice(-bytes).trim();
  } catch {
    return "(no log)";
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** The environment of the dev server: the caller's, minus every dashboard setting, plus this run's. */
export function dashboardEnv(o: DashboardOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    // Nothing the person exported for another setup (mock mode, a testnet RPC) may leak into this one.
    if (k.startsWith("NEXT_PUBLIC_") || k === "NODE_INTERNAL_URL" || k === "PORT") continue;
    env[k] = v;
  }
  return {
    ...env,
    NEXT_PUBLIC_NODE_URL: o.nodeUrl,
    // The wallet network. The local signer is selected only for exactly this value.
    NEXT_PUBLIC_NEAR_NETWORK: "sandbox",
    NEXT_PUBLIC_LOCAL_SIGNER_URL: o.signerUrl,
    NEXT_PUBLIC_LOCAL_SIGNER_TOKEN: o.signerToken,
    NEXT_PUBLIC_RELAYER_URL: o.relayerUrl,
    NEXT_PUBLIC_NEAR_RPC_URL: o.rpcUrl,
    NEXT_PUBLIC_NEAR_MAINNET_RPC_URL: o.mainnetRpcUrl ?? "",
    // Set, and empty: a value in apps/dashboard/.env.local cannot turn the mock node back on.
    NEXT_PUBLIC_MOCK: "",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export class DashboardProcess {
  readonly url: string;
  readonly pid: number;
  readonly logPath: string;
  readonly #child: ChildProcess;
  readonly #exited: Promise<string>;
  #stopped = false;

  private constructor(url: string, child: ChildProcess, logPath: string, exited: Promise<string>) {
    this.url = url;
    this.pid = child.pid!;
    this.logPath = logPath;
    this.#child = child;
    this.#exited = exited;
  }

  /** Spawns the dev server. It is not ready yet: call `ready()`. */
  static spawn(o: DashboardOptions): DashboardProcess {
    const next = join(DASHBOARD_DIR, "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(next)) throw new DashboardError(`The dashboard's dependencies are not installed (${next} is missing). Run pnpm install at the repository root.`);
    mkdirSync(dirname(o.logPath), { recursive: true });
    const fd = openSync(o.logPath, "a");
    let child: ChildProcess;
    try {
      // localhost, not 0.0.0.0: the dashboard of a local stack is for this machine only.
      child = spawn(process.execPath, [next, "dev", "-p", String(o.port), "-H", "127.0.0.1"], { cwd: DASHBOARD_DIR, env: dashboardEnv(o), detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    if (!child.pid) throw new DashboardError("The dashboard dev server did not start (no process id).");
    child.unref();
    const exited = new Promise<string>((resolve) => {
      child.once("exit", (code, signal) => resolve(`exit code ${code ?? "none"}, signal ${signal ?? "none"}`));
      child.once("error", (err) => resolve(err.message));
    });
    return new DashboardProcess(`http://localhost:${o.port}`, child, o.logPath, exited);
  }

  /** Resolves once the sign-in page answers 200, which includes its first compile. */
  async ready(timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let exit: string | null = null;
    void this.#exited.then((e) => (exit = e));
    while (Date.now() < deadline) {
      if (exit !== null) throw new DashboardError(`The dashboard dev server stopped while starting (${exit}). Last log lines:\n${tail(this.logPath)}`);
      try {
        const res = await fetch(`${this.url}/login`, { signal: AbortSignal.timeout(30_000) });
        await res.arrayBuffer();
        if (res.ok) return;
      } catch {
        // not listening yet, or still compiling
      }
      await sleep(500);
    }
    throw new DashboardError(`The dashboard did not answer within ${Math.round(timeoutMs / 1000)} s. Last log lines:\n${tail(this.logPath)}`);
  }

  /** Calls back once if the dev server exits on its own. */
  onExit(cb: (how: string) => void): void {
    void this.#exited.then((how) => {
      if (!this.#stopped) cb(how);
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      killGroup(this.pid, "SIGTERM");
      const done = await Promise.race([this.#exited.then(() => true), sleep(4_000).then(() => false)]);
      if (!done) {
        killGroup(this.pid, "SIGKILL");
        await Promise.race([this.#exited, sleep(2_000)]);
      }
    }
  }

  /** For process exit handlers, where nothing asynchronous runs. */
  killSync(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    killGroup(this.pid, "SIGKILL");
  }
}
