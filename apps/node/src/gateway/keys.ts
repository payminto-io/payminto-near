import { createHash } from "node:crypto";
import { hashApiKeySecret, newApiKeyId, newApiKeySecret, type ApiKeyWithSecret } from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { nowIso } from "../store.ts";
import { apiKeyJson, type ApiKeyRow } from "./model.ts";

/** last_used_at is written at most this often per key, so authenticated traffic does not write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** Merchant API keys (GATEWAY.md section 8): sk_test_/sk_live_, stored as SHA-256 only, shown once, revocable. */
export class ApiKeyService {
  readonly #db: Database;
  readonly #livemode: boolean;

  constructor(db: Database, livemode: boolean) {
    this.#db = db;
    this.#livemode = livemode;
  }

  create(merchantId: string, name: string | null): ApiKeyWithSecret & { merchant_id: string } {
    const secret = newApiKeySecret(this.#livemode);
    const id = newApiKeyId();
    this.#db.run(
      "INSERT INTO api_keys (id, merchant_id, name, livemode, prefix, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      merchantId,
      name,
      this.#livemode ? 1 : 0,
      secret.slice(0, 12),
      hashApiKeySecret(secret),
      nowIso(),
    );
    return { ...apiKeyJson(this.#row(id)!), secret, merchant_id: merchantId };
  }

  /**
   * A key for one agent run (docs/AGENTS.md section 4): narrowed to `permissions`, expiring at `expiresAt` even if
   * nobody revokes it, and hidden from the key list. The caller revokes it when the attempt ends.
   */
  createRunScoped(merchantId: string, runId: string, permissions: readonly string[], expiresAt: Date): { id: string; secret: string } {
    const secret = newApiKeySecret(this.#livemode);
    const id = newApiKeyId();
    this.#db.run(
      "INSERT INTO api_keys (id, merchant_id, name, livemode, prefix, secret_hash, created_at, permissions, agent_run_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      merchantId,
      `agent run ${runId}`,
      this.#livemode ? 1 : 0,
      secret.slice(0, 12),
      hashApiKeySecret(secret),
      nowIso(),
      JSON.stringify(permissions),
      runId,
      expiresAt.toISOString(),
    );
    return { id, secret };
  }

  /** Revokes a run-scoped key (idempotent). */
  revokeRunScoped(id: string): void {
    this.#db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND agent_run_id IS NOT NULL AND revoked_at IS NULL", nowIso(), id);
  }

  #row(id: string): ApiKeyRow | undefined {
    return this.#db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ?", id);
  }

  list(merchantId: string) {
    return this.#db
      .all<ApiKeyRow>("SELECT * FROM api_keys WHERE merchant_id = ? AND agent_run_id IS NULL ORDER BY created_at DESC", merchantId)
      .map((r) => ({ ...apiKeyJson(r), merchant_id: r.merchant_id }));
  }

  revoke(merchantId: string, id: string) {
    const r = this.#row(id);
    if (!r || r.merchant_id !== merchantId || r.agent_run_id) throw new ApiError(404, "NOT_FOUND", "API key not found");
    if (!r.revoked_at) this.#db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", nowIso(), id);
    return { ...apiKeyJson(this.#row(id)!), merchant_id: r.merchant_id };
  }

  /** The active key for a presented secret, or null. Keys of the other mode (test on 177, live elsewhere) never match. */
  authenticate(secret: string): ApiKeyRow | null {
    const prefix = this.#livemode ? "sk_live_" : "sk_test_";
    if (!secret.startsWith(prefix)) return null;
    const r = this.#db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE secret_hash = ? AND revoked_at IS NULL", hashApiKeySecret(secret));
    if (!r) return null;
    if (r.expires_at && Date.parse(r.expires_at) <= Date.now()) return null;
    const last = r.last_used_at ? Date.parse(r.last_used_at) : 0;
    if (Date.now() - last > LAST_USED_RESOLUTION_MS) this.#db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", nowIso(), r.id);
    return r;
  }
}

export const IDEMPOTENCY_TTL_SEC = 86_400;

type IdemRow = { scope: string; key: string; request_hash: string; status_code: number | null; response: string | null; created_unix: number };

/**
 * Idempotency-Key (GATEWAY.md section 8): the same key and body within 24 h returns the stored response; the same key
 * with a different body is 409 IDEMPOTENCY_MISMATCH; a key whose first request is still running is 409
 * IDEMPOTENCY_IN_PROGRESS. Server errors are not stored, so they can be retried with the same key.
 */
export class Idempotency {
  readonly #db: Database;
  readonly #clock: () => number;

  constructor(db: Database, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.#db = db;
    this.#clock = clock;
  }

  async run(scope: string, key: string, rawBody: string, fn: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown; replayed: boolean }> {
    if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw new ApiError(400, "VALIDATION_ERROR", "Idempotency-Key must be 1-255 visible ASCII characters");
    const hash = createHash("sha256").update(rawBody).digest("hex");
    const now = this.#clock();
    const claimed = this.#db.tx(() => {
      this.#db.run("DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND created_unix <= ?", scope, key, now - IDEMPOTENCY_TTL_SEC);
      const r = this.#db.get<IdemRow>("SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?", scope, key);
      if (r) return r;
      this.#db.run("INSERT INTO idempotency_keys (scope, key, request_hash, created_unix) VALUES (?, ?, ?, ?)", scope, key, hash, now);
      return null;
    });
    if (claimed) {
      if (claimed.request_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_MISMATCH", "this Idempotency-Key was used with a different request body");
      if (claimed.status_code === null) throw new ApiError(409, "IDEMPOTENCY_IN_PROGRESS", "a request with this Idempotency-Key is still being processed");
      return { status: claimed.status_code, body: JSON.parse(claimed.response!), replayed: true };
    }
    try {
      const out = await fn();
      this.#db.run("UPDATE idempotency_keys SET status_code = ?, response = ? WHERE scope = ? AND key = ?", out.status, JSON.stringify(out.body), scope, key);
      return { ...out, replayed: false };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        this.#db.run("UPDATE idempotency_keys SET status_code = ?, response = ? WHERE scope = ? AND key = ?", err.status, JSON.stringify(err.toJSON()), scope, key);
      } else {
        this.#db.run("DELETE FROM idempotency_keys WHERE scope = ? AND key = ?", scope, key);
      }
      throw err;
    }
  }

  prune(): number {
    return this.#db.run("DELETE FROM idempotency_keys WHERE created_unix <= ?", this.#clock() - IDEMPOTENCY_TTL_SEC).changes;
  }
}
