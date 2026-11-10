#!/usr/bin/env node
/**
 * payminto-revoke: revoke a Budget through a Payminto relayer, for an owner who has no NEAR for gas and no dashboard.
 * Run it with `pnpm --filter @payminto/relayer revoke --help`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { runRevoke, type CliFetch } from "./revoke.ts";

const code = await runRevoke(process.argv.slice(2), {
  fetch: globalThis.fetch as unknown as CliFetch,
  files: { readFile: (path) => readFileSync(path, "utf8"), listDir: (path) => readdirSync(path) },
  homedir,
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});
process.exit(code);
