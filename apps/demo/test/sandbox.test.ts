/**
 * The whole story on a fresh near-sandbox, at a quarter of the calls. About 70 seconds, so it is skipped unless
 * PAYMINTO_SANDBOX=1. Run it with:
 *   pnpm --filter @payminto/demo test:sandbox
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReport } from "../src/checks.ts";
import { loadDemoConfig } from "../src/config.ts";
import { runStory, type Report } from "../src/scenario.ts";
import { startStack, type Stack } from "../src/stack.ts";

const RUN = process.env.PAYMINTO_SANDBOX === "1";
const dir = mkdtempSync(join(tmpdir(), "payminto-demo-sandbox-"));
let stack: Stack;
let report: Report;

const sandboxPids = () => {
  try {
    // Every node this demo starts runs with --home <tmp>/payminto-sandbox-XXXXXX and is a child of this test process.
    // Only those count: another run on the same machine starts its own nodes with the same kind of home.
    return execFileSync("pgrep", ["-P", String(process.pid), "-f", "near-sandbox --home .*payminto-sandbox-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

describe.skipIf(!RUN)("the demo story on near-sandbox", () => {
  beforeAll(async () => {
    stack = await startStack(loadDemoConfig({ DEMO_DATA_DIR: dir }, ["--chain", "sandbox", "--scale", "0.25"]));
    report = await runStory(stack);
  }, 300_000);

  afterAll(async () => {
    await stack?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes every check, reading chain facts from a keyless client", () => {
    expect(checkReport(report).filter((c) => !c.ok)).toEqual([]);
    expect(report.simulated).toBe(false);
    expect(report.label).toMatch(/^SANDBOX/);
    expect(report.hub).toMatchObject({ accessKeys: 0 });
    expect(stack.hub.nodeChain).toBeUndefined();
  });

  it("returns the sandbox root account, the parent of every account it created, for a caller that creates more", () => {
    const root = stack.hub.sandbox!.root;
    expect(stack.hub.sandbox!.signers.get(root).secretKey).toMatch(/^ed25519:/);
    expect(stack.hub.names.hub).toBe(`hub.${root}`);
  });

  it("produced blocks the whole time", () => {
    expect(stack.hub.stats()).toMatchObject({ stalls: 0 });
    expect(stack.hub.stats()!.longestGapMs).toBeLessThan(10_000);
  });

  it("leaves no sandbox process once stopped", async () => {
    // The node is this process's child while the stack runs, so the check below can see it.
    expect(sandboxPids()).toHaveLength(1);
    await stack.stop();
    expect(sandboxPids()).toEqual([]);
  });
});
