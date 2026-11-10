import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.ts";
import { reapOrphans, registerProcess, sandboxBinaryCandidates, SANDBOX_VERSION } from "../src/sandbox/process.ts";
import { runVerifierCli } from "../src/verify-cli-runner.ts";

const dir = mkdtempSync(join(tmpdir(), "payminto-demo-process-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (pid: number) => new Promise<void>((r) => {
  const t = setInterval(() => {
    if (!alive(pid)) {
      clearInterval(t);
      r();
    }
  }, 50);
});

describe("finding near-sandbox", () => {
  it("looks in this checkout, a worktree's main checkout, then near-kit's cache", () => {
    const home = join(dir, "home");
    const c = sandboxBinaryCandidates(REPO_ROOT, { HOME: home });
    expect(c.at(-1)).toBe(join(home, ".near-kit", "sandbox", "bin", `near-sandbox-${SANDBOX_VERSION}`));
    expect(c.every((p) => p.includes(SANDBOX_VERSION))).toBe(true);
  });
});

describe("reaping sandboxes left by a run that was killed", () => {
  it("stops a node whose run is gone, and leaves one whose run is alive", async () => {
    const registry = join(dir, "registry");
    mkdirSync(registry, { recursive: true });
    const home = join(dir, "sandbox-home");
    mkdirSync(home);
    // A stand-in for near-sandbox: a long-lived process with the run's home directory on its command line.
    const node = (h: string) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--home", h, "run"], { detached: true, stdio: "ignore" });
    const orphan = node(home);
    const kept = node(join(dir, "other-home"));
    // A run that already exited: its pid is free.
    const gone = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => gone.once("exit", r));
    registerProcess({ pid: orphan.pid!, ownerPid: gone.pid!, home, startedAt: new Date().toISOString() }, registry);
    registerProcess({ pid: kept.pid!, ownerPid: process.pid, home: join(dir, "other-home"), startedAt: new Date().toISOString() }, registry);
    // A recycled pid whose command line does not name the home is never killed.
    const stranger = node(join(dir, "unrelated"));
    writeFileSync(join(registry, "stale.json"), JSON.stringify({ pid: stranger.pid, ownerPid: gone.pid, home: join(dir, "not-this-one"), startedAt: "" }));
    try {
      expect(reapOrphans(registry)).toBe(1);
      await exited(orphan.pid!);
      expect(alive(kept.pid!)).toBe(true);
      expect(alive(stranger.pid!)).toBe(true);
      expect(readdirSync(registry)).toEqual([`${kept.pid}.json`]);
    } finally {
      for (const p of [orphan, kept, stranger]) p.kill("SIGKILL");
    }
  });
});

describe("verify:near arguments", () => {
  it("exits 2 with the usage when it cannot run", async () => {
    expect(await runVerifierCli([])).toMatchObject({ code: 2, summary: expect.stringMatching(/--rpc-url/) });
    expect((await runVerifierCli(["--rpc-url", "http://127.0.0.1:9", "--hub", "hub.test.near", "--batch", "nothex"])).code).toBe(2);
    expect((await runVerifierCli(["--rpc-url", "http://127.0.0.1:9", "--hub", "hub.test.near", "--receipt", join(dir, "missing.json")])).code).toBe(2);
  });

  it("exits 2 when the hub cannot be read", async () => {
    const r = await runVerifierCli(["--rpc-url", "http://127.0.0.1:9", "--hub", "hub.test.near", "--batch", "ab".repeat(32), "--settler", "node.test.near"]);
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/cannot read the hub/);
  });

  it("exits 2 for a batch with no settler: batch ids belong to their settler", async () => {
    const r = await runVerifierCli(["--rpc-url", "http://127.0.0.1:9", "--hub", "hub.test.near", "--batch", "ab".repeat(32)]);
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/a batch alone needs --settler/);
  });
});
