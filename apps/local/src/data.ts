/**
 * The local stack's one data directory, and the only code that deletes anything.
 *
 * Chain state does not survive a stop: every start runs a fresh near-sandbox node with a new hub. A database from an
 * earlier run describes Budgets, batches and payments on a chain that no longer exists, so every start begins from a
 * clean directory, and says so. `pnpm local --reset` does the same deletion without starting anything.
 *
 * Data safety: the directory is fixed (apps/local/data, never a path from the environment), a symlink is refused, and
 * every database inside must pass the node's reset guard by name (`*.demo.db`) before anything is removed. One file
 * that does not pass stops the whole deletion.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDisposableTarget } from "@payminto/node";
import { DATA_DIR } from "./config.ts";

export type DataPaths = {
  dir: string;
  /** The clearing node's SQLite file. The name is what makes it disposable. */
  db: string;
  /** Receipt stores of the seeded agents, one per Budget key. */
  receipts: (name: string) => string;
  /** The seller's latest vouchers, for settle_own. */
  vouchers: string;
  /** Generated passwords, mode 0600. */
  logins: string;
  lock: string;
  logs: string;
  nodeLog: string;
  signerLog: string;
  relayerLog: string;
  dashboardLog: string;
  sandboxLog: string;
};

export function dataPaths(dir: string = DATA_DIR): DataPaths {
  const logs = join(dir, "logs");
  return {
    dir,
    db: join(dir, "clearing.demo.db"),
    receipts: (name) => join(dir, `${name}.receipts.demo.db`),
    vouchers: join(dir, "seller.vouchers.json"),
    logins: join(dir, "logins.txt"),
    lock: join(dir, "run.json"),
    logs,
    nodeLog: join(logs, "node.log"),
    signerLog: join(logs, "signer.log"),
    relayerLog: join(logs, "relayer.log"),
    dashboardLog: join(logs, "dashboard.log"),
    // The demo's hub factory writes sandbox.log into the directory it is given.
    sandboxLog: join(logs, "sandbox.log"),
  };
}

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataError";
  }
}

const DB_FILE = /\.db(-wal|-shm|-journal)?$/;

/**
 * Checks a database path before it is opened or deleted: the file name must end in `.demo.db`, and the node's own
 * guard must agree that the target is disposable. Throws otherwise.
 */
export function assertLocalDatabase(path: string): void {
  if (!path.endsWith(".demo.db")) throw new DataError(`Refusing ${path}: the local stack only opens or deletes databases named *.demo.db.`);
  // No argv is passed on purpose: the override flag of the node's reset tool must never apply here.
  const r = isDisposableTarget(path, []);
  if (!r.ok) throw new DataError(`Refusing ${path}: ${r.reason}.`);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/**
 * Deletes the data directory. Refuses a symlink, refuses any directory that is not `dir` exactly as configured, and
 * refuses to delete anything when one database inside does not pass `assertLocalDatabase`. Returns what was removed.
 */
export function wipeData(dir: string = DATA_DIR): { removed: boolean; databases: string[] } {
  const target = resolve(dir);
  if (!existsSync(target)) return { removed: false, databases: [] };
  const st = lstatSync(target);
  if (st.isSymbolicLink()) throw new DataError(`Refusing to delete ${target}: it is a symbolic link, and this tool only deletes its own directory.`);
  if (!st.isDirectory()) throw new DataError(`Refusing to delete ${target}: it is not a directory.`);
  const databases: string[] = [];
  for (const file of filesUnder(target)) {
    if (!DB_FILE.test(file)) continue;
    const db = file.replace(/-(wal|shm|journal)$/, "");
    assertLocalDatabase(db);
    if (!databases.includes(db)) databases.push(db);
  }
  rmSync(target, { recursive: true, force: true });
  return { removed: true, databases };
}

// ---- one stack at a time ----

export type Lock = { pid: number; startedAt: string; mode: string; dashboardPid?: number; dashboardUrl?: string };

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
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return "";
  }
}

export function readLock(paths: DataPaths): Lock | null {
  try {
    return JSON.parse(readFileSync(paths.lock, "utf8")) as Lock;
  } catch {
    return null;
  }
}

/** The stack that owns the data directory right now, or null. A lock whose process is gone does not count. */
export function runningStack(paths: DataPaths): Lock | null {
  const lock = readLock(paths);
  return lock && lock.pid !== process.pid && alive(lock.pid) ? lock : null;
}

/**
 * A run that was killed outright (SIGKILL, a closed terminal) leaves its dashboard dev server behind. The next run
 * stops it here: only when the recorded owner is gone, and only when the process still looks like that dev server.
 * The sandbox node has the same treatment in the demo's own registry.
 */
export function reapStaleDashboard(paths: DataPaths, marker: string): boolean {
  const lock = readLock(paths);
  if (!lock?.dashboardPid || alive(lock.pid) || !alive(lock.dashboardPid)) return false;
  if (!commandOf(lock.dashboardPid).includes(marker)) return false;
  try {
    process.kill(-lock.dashboardPid, "SIGKILL");
  } catch {
    try {
      process.kill(lock.dashboardPid, "SIGKILL");
    } catch {
      return false;
    }
  }
  return true;
}

export function writeLock(paths: DataPaths, lock: Lock): void {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.lock, JSON.stringify(lock, null, 2));
}

export function clearLock(paths: DataPaths): void {
  const lock = readLock(paths);
  if (lock && lock.pid === process.pid) rmSync(paths.lock, { force: true });
}
