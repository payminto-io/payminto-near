/**
 * Deletes a Clearing Node SQLite database (and its WAL/SHM files) so the next start migrates a fresh one.
 * Refuses unless the target is disposable: *.test.db / *.demo.db, inside the OS temp dir,
 * or --i-know-this-is-disposable is passed explicitly (guard in src/db/guard.ts).
 *
 *   node scripts/reset-db.ts <path-to-db> [--i-know-this-is-disposable]
 */
import { existsSync, rmSync } from "node:fs";
import { assertDisposableTarget, DISPOSABLE_FLAG } from "../src/db/guard.ts";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  process.stderr.write(`usage: node scripts/reset-db.ts <db-path> [${DISPOSABLE_FLAG}]\n`);
  process.exit(2);
}
if (target === process.env.DB_PATH && !args.includes(DISPOSABLE_FLAG)) {
  process.stderr.write("Refusing: the target is the DB_PATH the running node uses. Pass an explicit disposable path.\n");
  process.exit(1);
}
try {
  assertDisposableTarget(target, args);
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
let removed = 0;
for (const f of [target, `${target}-wal`, `${target}-shm`]) {
  if (existsSync(f)) {
    rmSync(f);
    removed++;
  }
}
process.stdout.write(`reset ${target} (${removed} file${removed === 1 ? "" : "s"} removed)\n`);
