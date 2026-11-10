import { execFile } from "node:child_process";
import { join } from "node:path";
import { DEMO_DIR } from "./config.ts";

export const VERIFY_CLI = join(DEMO_DIR, "src", "verify-cli.ts");

/**
 * Runs `verify-cli.ts` as its own process, the way a judge runs `pnpm verify:near`: an environment with no keys and no
 * node URL, only the arguments. Resolves with the exit code, the last summary line and the full output.
 */
export function runVerifierCli(args: readonly string[], timeoutMs = 60_000): Promise<{ code: number; summary: string; output: string }> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    execFile(process.execPath, [VERIFY_CLI, ...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 2) : 0;
      const output = `${stdout}${stderr}`;
      const summary = output.trim().split("\n").filter((l) => /^(NOT VERIFIED|VERIFIED|verify:near:)/.test(l)).pop() ?? output.trim().split("\n").pop() ?? "";
      resolve({ code, summary, output });
    });
  });
}
