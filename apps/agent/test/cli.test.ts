import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentKeyFile } from "@payminto/sdk";
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
    const data = mkdtempSync(join(tmpdir(), "payminto-cli-"));
    const r = cli(["run", "x"], { ANTHROPIC_API_KEY: "sk-ant-not-used", PAYMINTO_DATA_DIR: data });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/NODE_URL: required for the buyer agent's wallet/);
    expect(r.stderr).toMatch(/AGENT_KEY_FILE: no agent key at .*agent-key\.json; run `payminto-agent keygen`/);
  });

  it("keygen writes a mode 0600 key and prints only the public key", () => {
    const data = mkdtempSync(join(tmpdir(), "payminto-keygen-"));
    const r = cli(["keygen"], { PAYMINTO_DATA_DIR: data });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}\n$/);
    const path = join(data, "agent", "agent-key.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, "agent")).mode & 0o777).toBe(0o700);
    const file = JSON.parse(readFileSync(path, "utf8")) as { publicKey: string; secretKey: string };
    expect(file.publicKey).toBe(r.stdout.trim());
    expect(r.stdout + r.stderr).not.toContain(file.secretKey);
    expect(readAgentKeyFile(path).publicKey).toBe(file.publicKey);
    // Never replaces a key by accident.
    const again = cli(["keygen"], { PAYMINTO_DATA_DIR: data });
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists; pass --force/);
    const out = join(data, "other.json");
    const forced = cli(["keygen", "--out", out, "--force"]);
    expect(forced.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("validates the service token and options", () => {
    expect(cli(["serve"], { AGENT_SERVICE_TOKEN: "short" }).stderr).toMatch(/AGENT_SERVICE_TOKEN: must be at least 24 characters/);
    expect(cli(["run", "x", "--max-spend", "1.5"]).stderr).toMatch(/--max-spend: a whole number/);
    expect(cli(["serve-skill", "poetry"]).stderr).toMatch(/unknown skill poetry/);
  });
});
