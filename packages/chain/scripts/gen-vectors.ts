/**
 * Writes the frozen cross-language test vectors to packages/chain/vectors/*.json.
 * The Rust contract consumes these files; test/vectors.test.ts fails if a change would alter them.
 *
 *   node scripts/gen-vectors.ts          write the files
 *   node scripts/gen-vectors.ts --check  exit 1 if the committed files differ
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVectors } from "./vectors.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const check = process.argv.includes("--check");
let stale = 0;
mkdirSync(dir, { recursive: true });
for (const [name, value] of Object.entries(buildVectors())) {
  const path = join(dir, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if (readFileSync(path, "utf8") !== text) {
      process.stderr.write(`stale vector file: ${path}\n`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    process.stdout.write(`wrote ${path}\n`);
  }
}
process.exit(stale ? 1 : 0);
