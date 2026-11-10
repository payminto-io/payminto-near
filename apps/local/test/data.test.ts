import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR, DEFAULT_PORTS, parseArgs, UsageError } from "../src/config.ts";
import { dashboardEnv } from "../src/dashboard.ts";
import { assertLocalDatabase, clearLock, DataError, dataPaths, readLock, runningStack, wipeData, writeLock } from "../src/data.ts";
import { choosePorts, isFree, PortBusyError } from "../src/ports.ts";
import { newPassword, writeLogins } from "../src/setup.ts";

const made: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "payminto-local-test-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the data directory", () => {
  it("is apps/local/data, with a database named *.demo.db", () => {
    const p = dataPaths();
    expect(p.dir).toBe(DATA_DIR);
    expect(DATA_DIR.endsWith(join("apps", "local", "data"))).toBe(true);
    expect(p.db.endsWith("clearing.demo.db")).toBe(true);
    expect(p.receipts("agent-abc").endsWith("agent-abc.receipts.demo.db")).toBe(true);
    expect(() => assertLocalDatabase(p.db)).not.toThrow();
  });

  it("refuses to open or delete a database that is not named *.demo.db, even in the temp directory", () => {
    expect(() => assertLocalDatabase(join(scratch(), "clearing.db"))).toThrow(DataError);
    expect(() => assertLocalDatabase(join(scratch(), "prod.test.db"))).toThrow(/\*\.demo\.db/);
    expect(() => assertLocalDatabase("/var/lib/payminto/clearing.db")).toThrow(DataError);
  });

  it("deletes the directory when every database in it is disposable", () => {
    const dir = join(scratch(), "data");
    mkdirSync(join(dir, "logs"), { recursive: true });
    for (const f of ["clearing.demo.db", "clearing.demo.db-wal", "clearing.demo.db-shm", "agent-1.receipts.demo.db", "logins.txt", "logs/node.log"]) writeFileSync(join(dir, f), "x");
    const out = wipeData(dir);
    expect(out.removed).toBe(true);
    expect(out.databases.map((d) => d.split("/").pop()).sort()).toEqual(["agent-1.receipts.demo.db", "clearing.demo.db"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("deletes nothing at all when one database in it is not disposable", () => {
    const dir = join(scratch(), "data");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "clearing.demo.db"), "disposable");
    writeFileSync(join(dir, "nested", "clearing.db"), "someone's real database");
    expect(() => wipeData(dir)).toThrow(DataError);
    expect(readFileSync(join(dir, "clearing.demo.db"), "utf8")).toBe("disposable");
    expect(readFileSync(join(dir, "nested", "clearing.db"), "utf8")).toBe("someone's real database");
  });

  it("refuses a symbolic link, so it can never delete through one", () => {
    const base = scratch();
    const real = join(base, "elsewhere");
    mkdirSync(real);
    writeFileSync(join(real, "keep.demo.db"), "keep");
    const link = join(base, "data");
    symlinkSync(real, link);
    expect(() => wipeData(link)).toThrow(/symbolic link/);
    expect(existsSync(join(real, "keep.demo.db"))).toBe(true);
  });

  it("has nothing to do when the directory does not exist", () => {
    expect(wipeData(join(scratch(), "missing"))).toEqual({ removed: false, databases: [] });
  });
});

describe("one stack at a time", () => {
  it("sees a lock held by a live process, and ignores its own and a dead one", () => {
    const paths = dataPaths(join(scratch(), "data"));
    expect(runningStack(paths)).toBeNull();
    writeLock(paths, { pid: process.pid, startedAt: "now", mode: "run" });
    expect(runningStack(paths)).toBeNull();
    writeLock(paths, { pid: process.ppid, startedAt: "now", mode: "run", dashboardUrl: "http://localhost:3210" });
    expect(runningStack(paths)).toMatchObject({ pid: process.ppid });
    // Only the owner clears its lock.
    clearLock(paths);
    expect(readLock(paths)).not.toBeNull();
    writeLock(paths, { pid: 2 ** 22 + 12345, startedAt: "long ago", mode: "run" });
    expect(runningStack(paths)).toBeNull();
    writeLock(paths, { pid: process.pid, startedAt: "now", mode: "check" });
    clearLock(paths);
    expect(readLock(paths)).toBeNull();
  });
});

describe("logins", () => {
  it("are written with mode 0600, and stay 0600 when rewritten", () => {
    const path = join(scratch(), "logins.txt");
    writeFileSync(path, "old", { mode: 0o644 });
    const logins = [{ who: "Platform owner", email: "owner@payminto.local", password: newPassword() }];
    writeLogins(path, "http://localhost:3210", logins, ["API key", "  sk_test_x"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(logins[0]!.password);
    expect(text).toContain("http://localhost:3210/login");
    expect(text).toContain("sk_test_x");
  });

  it("makes a different password every time, long enough for the node's rules", () => {
    const a = newPassword();
    const b = newPassword();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
  });
});

describe("arguments", () => {
  it("defaults to a run, and reads the modes and ports", () => {
    expect(parseArgs([])).toEqual({ mode: "run", empty: false, ports: {}, noDashboard: false });
    expect(parseArgs(["--check"]).mode).toBe("check");
    expect(parseArgs(["--reset"]).mode).toBe("reset");
    expect(parseArgs(["--empty", "--dashboard-port", "3300", "--node-port=4300"])).toMatchObject({ empty: true, ports: { dashboard: 3300, node: 4300 } });
    expect(parseArgs(["--check", "--no-dashboard"]).noDashboard).toBe(true);
  });

  it("explains a wrong argument instead of guessing", () => {
    expect(() => parseArgs(["--chek"])).toThrow(UsageError);
    expect(() => parseArgs(["--dashboard-port", "80"])).toThrow(/1024 to 65535/);
    expect(() => parseArgs(["--dashboard-port"])).toThrow(/needs a port/);
    expect(() => parseArgs(["--reset", "--empty"])).toThrow(/no other flag/);
    expect(() => parseArgs(["--no-dashboard"])).toThrow(/only applies to --check/);
    expect(() => parseArgs(["--node-port", "4300", "--signer-port", "4300"])).toThrow(/different port/);
  });
});

describe("ports", () => {
  it("names the busy port, what needs it and the flag that changes it", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port)));
    try {
      expect(await isFree(port)).toBe(false);
      const err = await choosePorts({ dashboard: port }, true).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PortBusyError);
      expect((err as Error).message).toContain(`Port ${port} is already in use`);
      expect((err as Error).message).toContain("--dashboard-port");
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await isFree(port)).toBe(true);
  });

  it("picks distinct free ports for the scripted check and keeps explicit ones", async () => {
    const free = await choosePorts({}, false);
    expect(new Set(Object.values(free)).size).toBe(Object.keys(DEFAULT_PORTS).length);
    for (const p of Object.values(free)) expect(p).toBeGreaterThan(1023);
  });
});

describe("the dashboard's environment", () => {
  it("drops every dashboard setting the caller exported and sets this run's, on the sandbox only", () => {
    const env = dashboardEnv(
      { port: 3210, nodeUrl: "http://127.0.0.1:4210", signerUrl: "http://127.0.0.1:4211", signerToken: "tok", relayerUrl: "http://127.0.0.1:4213", rpcUrl: "", logPath: "/tmp/x.log" },
      { PATH: "/usr/bin", NEXT_PUBLIC_MOCK: "1", NEXT_PUBLIC_NEAR_NETWORK: "mainnet", NEXT_PUBLIC_NEAR_RPC_URL: "https://rpc.mainnet.near.org", NEXT_PUBLIC_DOCS_URL: "https://docs.example", NODE_INTERNAL_URL: "http://10.0.0.5:8787", DB_PATH: "/var/lib/payminto/clearing.db" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NEXT_PUBLIC_MOCK).toBe("");
    expect(env.NEXT_PUBLIC_NEAR_NETWORK).toBe("sandbox");
    expect(env.NEXT_PUBLIC_NEAR_RPC_URL).toBe("");
    expect(env.NEXT_PUBLIC_NODE_URL).toBe("http://127.0.0.1:4210");
    expect(env.NEXT_PUBLIC_LOCAL_SIGNER_URL).toBe("http://127.0.0.1:4211");
    expect(env.NEXT_PUBLIC_RELAYER_URL).toBe("http://127.0.0.1:4213");
    expect(env.NEXT_PUBLIC_DOCS_URL).toBeUndefined();
    expect(env.NODE_INTERNAL_URL).toBeUndefined();
  });
});
