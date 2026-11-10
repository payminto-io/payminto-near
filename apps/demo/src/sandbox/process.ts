/**
 * One near-sandbox node for one demo run: find the binary, start it detached with its output in a log file, wait until
 * it produces blocks, watch it while the story runs, and stop it on every exit path.
 *
 * Why it is spawned here and not through near-kit's `Sandbox.start`:
 * - The node's stdout and stderr go to a regular file. A pipe that nobody reads fills up and the node then blocks on a
 *   log write; a file never does, and it is there to read when something goes wrong.
 * - RPC and network ports bind to 127.0.0.1 only, so nothing on the LAN can reach the node and macOS does not ask
 *   whether the binary may accept incoming connections.
 * - The process id and home directory are recorded, so a run that was killed outright (SIGKILL, a closed terminal)
 *   has its node reaped by the next run instead of leaving it running.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { freePort } from "../ports.ts";

export const SANDBOX_VERSION = "2.14.0";

export type RootAccount = { id: string; secretKey: string };

export type SandboxStats = { blocks: number; longestGapMs: number; stalls: number };

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- binary ----

/** The main checkout of a git worktree (`.git` is then a file pointing into the main repository's `.git`). */
function mainCheckoutOf(repoRoot: string): string | null {
  try {
    const dotGit = join(repoRoot, ".git");
    if (!statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    // <main>/.git/worktrees/<name>
    return resolve(m[1]!.trim(), "..", "..", "..");
  } catch {
    return null;
  }
}

/** Every place a near-sandbox binary of the pinned version may already be, in order of preference. */
export function sandboxBinaryCandidates(repoRoot: string, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const root of [repoRoot, mainCheckoutOf(repoRoot)]) {
    if (!root) continue;
    for (const profile of ["debug", "release"]) {
      const build = join(root, "contracts-near", "target", profile, "build");
      if (!existsSync(build)) continue;
      for (const dir of readdirSync(build).filter((d) => d.startsWith("near-sandbox-"))) {
        out.push(join(build, dir, "out", ".near", `near-sandbox-${SANDBOX_VERSION}`, "near-sandbox"));
      }
    }
  }
  out.push(join(env.HOME ?? homedir(), ".near-kit", "sandbox", "bin", `near-sandbox-${SANDBOX_VERSION}`));
  return out;
}

/**
 * NEAR_SANDBOX_BIN_PATH, else the copy the contract's cargo tests downloaded, else near-kit's cache. When none exists,
 * near-kit downloads near-sandbox from NEAR's release bucket once (about 30 MB) into ~/.near-kit/sandbox/bin.
 */
export async function resolveSandboxBinary(repoRoot: string, say: (line: string) => void): Promise<string> {
  const fromEnv = process.env.NEAR_SANDBOX_BIN_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new SandboxError(`NEAR_SANDBOX_BIN_PATH is ${fromEnv}, which does not exist`);
    return fromEnv;
  }
  const found = sandboxBinaryCandidates(repoRoot).find((p) => existsSync(p));
  if (found) return found;
  say(`   near-sandbox ${SANDBOX_VERSION} is not on this machine yet; near-kit downloads it once from NEAR's release bucket (about 30 MB).`);
  const { Sandbox } = await import("near-kit/sandbox");
  const s = await Sandbox.start({ version: SANDBOX_VERSION, detached: true });
  await s.stop();
  const cached = sandboxBinaryCandidates(repoRoot).find((p) => existsSync(p));
  if (!cached) throw new SandboxError("near-kit finished its download but the near-sandbox binary is not in ~/.near-kit/sandbox/bin");
  return cached;
}

// ---- orphan registry ----

const REGISTRY = join(tmpdir(), "payminto-demo-sandboxes");

type Entry = { pid: number; ownerPid: number; home: string; startedAt: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function commandOf(pid: number): string {
  try {
    if (existsSync(`/proc/${pid}/cmdline`)) return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return "";
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

/**
 * Stops sandbox nodes left behind by demo runs that died without cleaning up: the run's process is gone, and the node
 * still runs with that run's home directory on its command line (so a reused process id is never touched).
 * Returns how many nodes were stopped.
 */
export function reapOrphans(registry = REGISTRY): number {
  if (!existsSync(registry)) return 0;
  let reaped = 0;
  for (const file of readdirSync(registry).filter((f) => f.endsWith(".json"))) {
    const path = join(registry, file);
    let e: Entry;
    try {
      e = JSON.parse(readFileSync(path, "utf8")) as Entry;
    } catch {
      rmSync(path, { force: true });
      continue;
    }
    if (alive(e.ownerPid)) continue; // another run is using it
    if (alive(e.pid) && commandOf(e.pid).includes(e.home)) {
      killGroup(e.pid, "SIGKILL");
      reaped++;
    }
    rmSync(e.home, { recursive: true, force: true });
    rmSync(path, { force: true });
  }
  return reaped;
}

export function registerProcess(entry: Entry, registry = REGISTRY): string {
  mkdirSync(registry, { recursive: true });
  const path = join(registry, `${entry.pid}.json`);
  writeFileSync(path, JSON.stringify(entry));
  return path;
}

// Every node this process started, so an abrupt exit still kills them.
const live = new Set<SandboxProcess>();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const s of live) s.killSync();
  });
}

// ---- the node ----

async function status(rpcUrl: string, timeoutMs = 2_000): Promise<number | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "status", method: "status", params: [] }), signal: ac.signal });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: { sync_info?: { latest_block_height?: number } } };
    return j.result?.sync_info?.latest_block_height ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function tail(path: string, bytes = 2_000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(-bytes);
  } catch {
    return "(no log)";
  }
}

export class SandboxProcess {
  readonly rpcUrl: string;
  readonly root: RootAccount;
  readonly home: string;
  readonly logPath: string;
  readonly pid: number;
  readonly #child: ChildProcess;
  readonly #registryPath: string;
  #exited: Promise<void>;
  #stopped = false;
  #watch: { timer: NodeJS.Timeout; height: number; changedAt: number; stats: SandboxStats; first: number } | null = null;

  private constructor(o: { rpcUrl: string; root: RootAccount; home: string; logPath: string; child: ChildProcess; registryPath: string; exited: Promise<void> }) {
    this.rpcUrl = o.rpcUrl;
    this.root = o.root;
    this.home = o.home;
    this.logPath = o.logPath;
    this.#child = o.child;
    this.pid = o.child.pid!;
    this.#registryPath = o.registryPath;
    this.#exited = o.exited;
  }

  /**
   * Initializes a fresh home in the OS temp directory, starts the node, and resolves once it has produced two blocks.
   * A port taken between choosing it and binding it makes the node exit at once; that is retried with new ports.
   */
  static async start(o: { binary: string; logPath: string; readyTimeoutMs?: number }): Promise<SandboxProcess> {
    installExitHook();
    reapOrphans();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await SandboxProcess.#startOnce(o);
      } catch (err) {
        lastError = err;
        if (!(err instanceof SandboxError && /address already in use|AddrInUse|os error 48|os error 98/i.test(err.message))) throw err;
      }
    }
    throw lastError;
  }

  static async #startOnce(o: { binary: string; logPath: string; readyTimeoutMs?: number }): Promise<SandboxProcess> {
    const home = mkdtempSync(join(tmpdir(), "payminto-sandbox-"));
    mkdirSync(dirname(o.logPath), { recursive: true });
    try {
      execFileSync(o.binary, ["--home", home, "init", "--chain-id", "localnet"], { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
    } catch (err) {
      rmSync(home, { recursive: true, force: true });
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
      const hint = /file descriptor/i.test(stderr) ? " Raise the open file limit (ulimit -n 65535) and try again." : "";
      throw new SandboxError(`near-sandbox init failed: ${stderr.slice(-1_000)}${hint}`);
    }
    const key = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key?: string; private_key?: string };
    const root = { id: key.account_id, secretKey: key.secret_key ?? key.private_key ?? "" };

    const [rpcPort, netPort] = [await freePort(), await freePort()];
    const fd = openSync(o.logPath, "a");
    let child: ChildProcess;
    try {
      // detached: its own process group, so a group kill reaches anything it forks, and the terminal's Ctrl-C reaches
      // this process first, which then stops the node in order.
      child = spawn(o.binary, ["--home", home, "run", "--rpc-addr", `127.0.0.1:${rpcPort}`, "--network-addr", `127.0.0.1:${netPort}`], { detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    if (!child.pid) {
      rmSync(home, { recursive: true, force: true });
      throw new SandboxError("near-sandbox did not start (no process id)");
    }
    child.unref();
    let exitInfo: string | null = null;
    const exited = new Promise<void>((r) => {
      child.once("exit", (code, signal) => {
        exitInfo = `exit code ${code ?? "none"}, signal ${signal ?? "none"}`;
        r();
      });
      child.once("error", (err) => {
        exitInfo = err.message;
        r();
      });
    });
    const registryPath = registerProcess({ pid: child.pid, ownerPid: process.pid, home, startedAt: new Date().toISOString() });
    const s = new SandboxProcess({ rpcUrl: `http://127.0.0.1:${rpcPort}`, root, home, logPath: o.logPath, child, registryPath, exited });
    live.add(s);

    const deadline = Date.now() + (o.readyTimeoutMs ?? 60_000);
    let first: number | null = null;
    while (Date.now() < deadline) {
      if (exitInfo !== null) {
        await s.stop();
        throw new SandboxError(`near-sandbox exited while starting (${exitInfo}). Last log lines:\n${tail(o.logPath)}`);
      }
      const h = await status(s.rpcUrl);
      if (h !== null) {
        first ??= h;
        if (h >= first + 2) return s;
      }
      await sleep(250);
    }
    await s.stop();
    throw new SandboxError(`near-sandbox did not produce blocks within ${Math.round((o.readyTimeoutMs ?? 60_000) / 1000)} s. Last log lines:\n${tail(o.logPath)}`);
  }

  /** The latest block height, or null when the RPC does not answer within two seconds. */
  height(): Promise<number | null> {
    return status(this.rpcUrl);
  }

  /**
   * Polls the block height every second while the story runs. When no block arrives for `stallMs`, `onStall` gets one
   * line naming the gap, the process state and the log size, so a stall is visible instead of looking like a hang.
   */
  watch(onStall: (line: string) => void, stallMs = 15_000): void {
    if (this.#watch) return;
    const w = { timer: undefined as unknown as NodeJS.Timeout, height: -1, changedAt: Date.now(), stats: { blocks: 0, longestGapMs: 0, stalls: 0 }, first: -1 };
    let reported = false;
    let busy = false;
    w.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const h = await status(this.rpcUrl);
        const now = Date.now();
        if (h !== null && h !== w.height) {
          if (w.first < 0) w.first = h;
          w.stats.longestGapMs = Math.max(w.stats.longestGapMs, now - w.changedAt);
          if (reported) onStall(`   near-sandbox is producing blocks again at #${h}, after ${((now - w.changedAt) / 1000).toFixed(0)} s.`);
          reported = false;
          w.height = h;
          w.changedAt = now;
          w.stats.blocks = h - w.first;
        } else if (!reported && now - w.changedAt > stallMs) {
          reported = true;
          w.stats.stalls++;
          let state = "";
          try {
            state = execFileSync("ps", ["-o", "stat=,pcpu=", "-p", String(this.pid)], { encoding: "utf8" }).trim();
          } catch {
            state = "not running";
          }
          let size = 0;
          try {
            size = statSync(this.logPath).size;
          } catch {
            // no log
          }
          onStall(`   WARNING near-sandbox produced no block for ${((now - w.changedAt) / 1000).toFixed(0)} s (last #${w.height}, RPC ${h === null ? "not answering" : "answering"}, process ${state || "unknown"}, log ${size} bytes at ${this.logPath}).`);
        }
      } finally {
        busy = false;
      }
    }, 1_000);
    w.timer.unref();
    this.#watch = w;
  }

  stats(): SandboxStats | null {
    if (!this.#watch) return null;
    return { ...this.#watch.stats, longestGapMs: Math.max(this.#watch.stats.longestGapMs, Date.now() - this.#watch.changedAt) };
  }

  /** SIGTERM to the node's process group, SIGKILL after three seconds, then removes its home. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#watch) clearInterval(this.#watch.timer);
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      killGroup(this.pid, "SIGTERM");
      const done = await Promise.race([this.#exited.then(() => true), sleep(3_000).then(() => false)]);
      if (!done) {
        killGroup(this.pid, "SIGKILL");
        await Promise.race([this.#exited, sleep(2_000)]);
      }
    }
    this.#cleanupFiles();
  }

  /** For process exit handlers, where nothing asynchronous runs: SIGKILL and remove the home. */
  killSync(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    killGroup(this.pid, "SIGKILL");
    this.#cleanupFiles();
  }

  #cleanupFiles(): void {
    live.delete(this);
    rmSync(this.home, { recursive: true, force: true });
    try {
      unlinkSync(this.#registryPath);
    } catch {
      // already gone
    }
  }
}
