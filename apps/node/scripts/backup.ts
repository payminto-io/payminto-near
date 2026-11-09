/**
 * Online backup of the Clearing Node database (SQLite VACUUM INTO), safe while the node runs.
 *
 *   pnpm --filter @payminto/node backup [--db <path>] [--out <dir>]
 *
 * Defaults: --db is DB_PATH (from the environment or apps/node/.env, else ./data/clearing.db),
 * --out is BACKUP_DIR or ./backups. Writes clearing-<UTC timestamp>.db and verifies it; never overwrites.
 * Restore: stop the node, move the old DB_PATH (and its -wal/-shm files) aside, copy the backup to DB_PATH, start.
 * See docs/OPERATIONS.md.
 */
import { backupDatabase } from "../src/backup.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = flag("--db") ?? process.env.DB_PATH ?? "./data/clearing.db";
const out = flag("--out") ?? process.env.BACKUP_DIR ?? "./backups";

try {
  const r = backupDatabase(db, out);
  process.stdout.write(
    `backup ok: ${r.file}\n  ${r.bytes} bytes, integrity_check ok, ${r.migrations} migrations, ${r.calls} calls, ${r.journals} journals\n`,
  );
} catch (err) {
  process.stderr.write(`backup failed: ${(err as Error).message}\n`);
  process.exit(1);
}
