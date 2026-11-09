import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, resolve, sep, basename } from "node:path";

export const DISPOSABLE_FLAG = "--i-know-this-is-disposable";

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // The file may not exist yet; resolve its directory instead.
    try {
      return resolve(realpathSync(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

/**
 * Data-safety guard for every reset or seed tool (SPEC 5.2).
 * A target is disposable only if its file name ends in .test.db or .demo.db, or it lives in the OS temp dir,
 * or the caller passed --i-know-this-is-disposable explicitly for this run.
 */
export function isDisposableTarget(path: string, argv: readonly string[] = []): { ok: boolean; reason: string } {
  if (argv.includes(DISPOSABLE_FLAG)) return { ok: true, reason: `explicit ${DISPOSABLE_FLAG}` };
  if (path === ":memory:") return { ok: true, reason: "in-memory database" };
  const abs = real(path);
  if (/\.(test|demo)\.db$/.test(abs)) return { ok: true, reason: "file name marks it disposable" };
  const tmpRoots = [real(tmpdir()), "/tmp", "/private/tmp"].map((t) => (t.endsWith(sep) ? t : t + sep));
  if (tmpRoots.some((t) => abs.startsWith(t))) return { ok: true, reason: "inside the OS temp dir" };
  return { ok: false, reason: `${abs} is not marked disposable (.test.db / .demo.db / temp dir)` };
}

export function assertDisposableTarget(path: string, argv: readonly string[] = []): void {
  const r = isDisposableTarget(path, argv);
  if (!r.ok) {
    throw new Error(`Refusing to reset or seed: ${r.reason}. Pass ${DISPOSABLE_FLAG} only if this database is truly disposable.`);
  }
}
