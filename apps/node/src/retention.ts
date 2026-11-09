import type { Database } from "./db/database.ts";

/**
 * Keeps the newest `maxRows` rows of an append-only table and deletes the rest.
 * Only the denials and events logs are pruned; calls, batches and the ledger are never touched.
 */
export function pruneTable(db: Database, table: "denials" | "events", maxRows: number): number {
  const key = table === "denials" ? "seq" : "id";
  const cutoff = db.get<{ k: number }>(`SELECT ${key} AS k FROM ${table} ORDER BY ${key} DESC LIMIT 1 OFFSET ?`, maxRows);
  if (!cutoff) return 0;
  return db.run(`DELETE FROM ${table} WHERE ${key} <= ?`, cutoff.k).changes;
}
