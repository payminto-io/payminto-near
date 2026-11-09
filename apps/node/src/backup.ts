import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type BackupResult = { file: string; bytes: number; migrations: number; calls: number; journals: number };

/** UTC timestamp safe for file names: 20261029T101530Z. */
export function backupStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Online, consistent backup of a Clearing Node database with SQLite `VACUUM INTO`.
 * Safe while the node runs (WAL readers do not block the writer), never writes to the source, refuses to overwrite,
 * and verifies the copy right away: non-empty, integrity_check ok, and no fewer migrations, calls or journals than the source.
 */
export function backupDatabase(source: string, outDir: string, now = new Date()): BackupResult {
  const src = resolve(source);
  if (!existsSync(src)) throw new Error(`no database at ${src}`);
  mkdirSync(outDir, { recursive: true });
  const file = resolve(join(outDir, `clearing-${backupStamp(now)}.db`));
  if (existsSync(file)) throw new Error(`refusing to overwrite existing backup ${file}`);

  const counts = (db: DatabaseSync) => {
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number | bigint }).n);
    return {
      migrations: n("SELECT COUNT(*) AS n FROM schema_migrations"),
      calls: n("SELECT COUNT(*) AS n FROM calls"),
      journals: n("SELECT COUNT(*) AS n FROM journals"),
    };
  };

  const db = new DatabaseSync(src, { readOnly: true });
  let before: ReturnType<typeof counts>;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // VACUUM INTO cannot run inside a transaction, so the counts are taken just before the copy. These tables are
    // append-only, so the copy (a consistent snapshot of its own) must hold at least as many rows.
    before = counts(db);
    db.prepare("VACUUM INTO ?").run(file);
  } finally {
    db.close();
  }

  const bytes = statSync(file).size;
  if (bytes === 0) throw new Error(`backup ${file} is empty`);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") throw new Error(`backup ${file} failed integrity_check: ${integrity}`);
    const after = counts(copy);
    for (const k of Object.keys(before) as Array<keyof typeof before>) {
      if (after[k] < before[k]) throw new Error(`backup ${file} has ${after[k]} ${k}, source had ${before[k]}`);
    }
    return { file, bytes, ...after };
  } finally {
    copy.close();
  }
}
