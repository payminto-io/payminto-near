/**
 * Account recovery on the server itself (docs/PRODUCT.md 4.2).
 *
 *   pnpm --filter @payminto/node account reset-owner --email <email> [--db <path>]
 *
 * Prints a one-time password reset link (30 minutes) for the platform owner. It only adds a token row and an
 * activity-log entry; it never creates, migrates or resets a database. The link points at PUBLIC_DASHBOARD_URL
 * (else PUBLIC_CHECKOUT_URL, else http://localhost:3000). Needs read access to DB_PATH, which is server access.
 */
import { existsSync } from "node:fs";
import { AuditLog } from "../src/auth/audit.ts";
import { Mailer } from "../src/auth/mailer.ts";
import { DEFAULT_SCRYPT_LOG_N } from "../src/auth/passwords.ts";
import { AuthService, DEFAULT_SESSION } from "../src/auth/service.ts";
import { Database } from "../src/db/database.ts";
import { silentLogger } from "../src/logger.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "usage: pnpm --filter @payminto/node account reset-owner --email <email> [--db <path>]\n";

if (args[0] !== "reset-owner" || !flag("--email")) {
  process.stderr.write(usage);
  process.exit(2);
}
const dbPath = flag("--db") ?? process.env.DB_PATH ?? "./data/clearing.db";
if (!existsSync(dbPath)) {
  process.stderr.write(`no database at ${dbPath}; pass --db or set DB_PATH\n`);
  process.exit(1);
}
const db = new Database(dbPath);
try {
  const applied = new Set(db.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name));
  if (!applied.has("001_near.sql")) throw new Error("this database has no accounts yet (start the node once to create the schema)");
  const dashboardUrl = (process.env.PUBLIC_DASHBOARD_URL ?? process.env.PUBLIC_CHECKOUT_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const auth = new AuthService({
    db,
    log: silentLogger,
    mailer: new Mailer({ db, log: silentLogger, smtp: null }),
    audit: new AuditLog(db),
    merchants: null,
    settings: {
      dashboardUrl,
      allowedOrigins: [],
      adminToken: "",
      breakGlass: false,
      scryptLogN: DEFAULT_SCRYPT_LOG_N,
      idlePlatformSec: DEFAULT_SESSION.idlePlatformSec,
      idleBusinessSec: DEFAULT_SESSION.idleBusinessSec,
      absoluteSec: DEFAULT_SESSION.absoluteSec,
      rotateSec: DEFAULT_SESSION.rotateSec,
      rotateGraceSec: DEFAULT_SESSION.rotateGraceSec,
      stepUpSec: DEFAULT_SESSION.stepUpSec,
      platformName: process.env.PLATFORM_NAME ?? "Payminto",
    },
  });
  const link = auth.ownerResetLink(flag("--email")!);
  process.stdout.write(`One-time reset link for the platform owner (valid 30 minutes):\n  ${link}\n`);
} catch (err) {
  process.stderr.write(`account reset-owner failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
