import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function cli(args: string[], env: Record<string, string> = {}) {
  // A clean environment: no ANTHROPIC_API_KEY or wallet variables leak in from the developer's shell.
  return spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, encoding: "utf8", timeout: 30_000 });
}

describe("payminto-agent CLI", () => {
  it("prints usage", () => {
    const r = cli(["help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/payminto-agent run "<task>"/);
  });

  it("refuses to run without ANTHROPIC_API_KEY and says what to set", () => {
    for (const cmd of [["run", "compare HSK and ETH"], ["ops", "what did we earn today"]]) {
      const r = cli(cmd);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/ANTHROPIC_API_KEY is not set/);
    }
    const serve = cli(["serve"], { AGENT_SERVICE_TOKEN: "a-long-enough-service-token-123" });
    expect(serve.status).toBe(2);
    expect(serve.stderr).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it("names the missing wallet variables when the key is present", () => {
    const r = cli(["run", "x"], { ANTHROPIC_API_KEY: "sk-ant-not-used" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/NODE_URL: required for the buyer agent's wallet/);
    expect(r.stderr).toMatch(/AGENT_KEY: required/);
  });

  it("validates the service token and options", () => {
    expect(cli(["serve"], { AGENT_SERVICE_TOKEN: "short" }).stderr).toMatch(/AGENT_SERVICE_TOKEN: must be at least 24 characters/);
    expect(cli(["run", "x", "--max-spend", "1.5"]).stderr).toMatch(/--max-spend: a whole number/);
    expect(cli(["serve-skill", "poetry"]).stderr).toMatch(/unknown skill poetry/);
  });
});
