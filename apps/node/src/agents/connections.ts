import { providerInfo, type ConnectionSpec, type ModelError, type Provider, type VerifyResult } from "@payminto/models";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import { checkWebhookUrl } from "../gateway/ssrf.ts";
import { nowIso } from "../store.ts";
import { asModelError, type ModelLayer } from "./models.ts";
import { connectionJson, newId, scrubSecrets, type ConnectionRow, type TokenUsage } from "./rows.ts";
import { keyHint, type SecretBox } from "./secrets.ts";

export type CreateConnectionInput = {
  provider: Provider;
  label: string;
  api_key?: string | null;
  base_url?: string | null;
  default_model: string;
  monthly_token_limit?: number | null;
};

export type UpdateConnectionInput = {
  label?: string;
  base_url?: string | null;
  default_model?: string;
  monthly_token_limit?: number | null;
  status?: "active" | "disabled";
  api_key?: string | null;
};

/** The verification result as the API shows it: never the key, provider text scrubbed of anything key-shaped. */
export function verificationJson(v: VerifyResult, key?: string) {
  if (v.ok) return { ok: true as const, models: v.models };
  return { ok: false as const, error: { kind: v.error.kind, message: scrubSecrets(v.error.message, key), status: v.error.status, retryable: v.error.retryable } };
}

/** First day of the UTC month containing `ms`, and of the next month. */
export function monthBounds(ms: number): { start: number; end: number } {
  const d = new Date(ms);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

/**
 * A business's AI connections (docs/AGENTS.md section 2): provider accounts whose keys are sealed with the server key,
 * verified on save and on demand, marked invalid when the provider rejects the key.
 */
export class ConnectionService {
  readonly #db: Database;
  readonly #box: SecretBox;
  readonly #models: ModelLayer;
  readonly #allowPrivate: boolean;
  readonly #clock: () => number;

  constructor(o: { db: Database; box: SecretBox; models: ModelLayer; allowPrivateModelUrls: boolean; clock?: () => number }) {
    this.#db = o.db;
    this.#box = o.box;
    this.#models = o.models;
    this.#allowPrivate = o.allowPrivateModelUrls;
    this.#clock = o.clock ?? (() => Date.now());
  }

  get models(): ModelLayer {
    return this.#models;
  }

  // ------------------------------------------------------------------ reads

  row(id: string): ConnectionRow | undefined {
    return this.#db.get<ConnectionRow>("SELECT * FROM ai_connections WHERE id = ?", id);
  }

  get(merchantId: string, id: string): ConnectionRow {
    const r = this.row(id);
    if (!r || r.merchant_id !== merchantId || r.deleted_at) throw new ApiError(404, "NOT_FOUND", "AI connection not found");
    return r;
  }

  list(merchantId: string): ConnectionRow[] {
    return this.#db.all<ConnectionRow>("SELECT * FROM ai_connections WHERE merchant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id", merchantId);
  }

  /** Input plus output tokens of every run on the connection created in [startMs, endMs). */
  usage(connectionId: string, startMs: number, endMs: number): TokenUsage {
    const u = this.#db.get<{ i: number; o: number; n: number }>(
      "SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COUNT(*) AS n FROM agent_runs WHERE connection_id = ? AND created_ms >= ? AND created_ms < ?",
      connectionId,
      startMs,
      endMs,
    )!;
    return { input_tokens: u.i, output_tokens: u.o, total_tokens: u.i + u.o, runs: u.n };
  }

  monthUsage(connectionId: string): TokenUsage {
    const m = monthBounds(this.#clock());
    return this.usage(connectionId, m.start, m.end);
  }

  /** True when the connection has a monthly limit and this month's tokens reached it. */
  overLimit(r: ConnectionRow): boolean {
    return r.monthly_token_limit !== null && this.monthUsage(r.id).total_tokens >= r.monthly_token_limit;
  }

  json(r: ConnectionRow) {
    return connectionJson(r, this.monthUsage(r.id));
  }

  /** The decrypted spec for a model call. Throws SecretError when the server key cannot open it. */
  spec(r: ConnectionRow, model?: string): ConnectionSpec {
    const apiKey = this.#box.open({ ciphertext: r.key_ciphertext, iv: r.key_iv, tag: r.key_tag, version: r.key_version }, { merchantId: r.merchant_id, rowId: r.id });
    return { provider: r.provider, apiKey, ...(r.base_url ? { baseUrl: r.base_url } : {}), model: model ?? r.default_model };
  }

  /**
   * The SSRF guard of webhooks (gateway/ssrf.ts) for a base URL: https and public addresses only, unless the operator
   * allows private model URLs (Ollama or vLLM on the same box).
   */
  async checkBaseUrl(url: string): Promise<void> {
    try {
      await checkWebhookUrl(url, { allowPrivate: this.#allowPrivate });
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError(400, "BASE_URL_REJECTED", err.message.replace(/^url/, "base_url"), this.#allowPrivate ? undefined : { hint: "private and loopback model URLs need AGENT_ALLOW_PRIVATE_MODEL_URLS=true" });
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ writes

  async create(merchantId: string, b: CreateConnectionInput, createdBy: string | null): Promise<{ row: ConnectionRow; verification: VerifyResult; key: string }> {
    const key = (b.api_key ?? "").trim();
    const info = providerInfo(b.provider);
    if (!key && !info.keyOptional) throw new ApiError(400, "VALIDATION_ERROR", `${info.name} needs an API key`, { issues: [{ path: "api_key", message: "required" }] });
    const baseUrl = b.base_url?.trim() || null;
    if (info.needsBaseUrl && !baseUrl) throw new ApiError(400, "VALIDATION_ERROR", "base_url is required for an OpenAI-compatible connection", { issues: [{ path: "base_url", message: "required" }] });
    if (baseUrl) await this.checkBaseUrl(baseUrl);
    const id = newId("aic");
    const sealed = this.#box.seal(key, { merchantId, rowId: id });
    const now = nowIso();
    const verification = await this.#models.verifyConnection({ provider: b.provider, apiKey: key, ...(baseUrl ? { baseUrl } : {}), model: b.default_model });
    const v = this.#verifyColumns(verification, key, "active");
    this.#db.run(
      `INSERT INTO ai_connections (id, merchant_id, provider, label, base_url, default_model, key_hint, key_ciphertext, key_iv, key_tag, key_version,
         status, verified_at, last_error, monthly_token_limit, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      merchantId,
      b.provider,
      b.label,
      baseUrl,
      b.default_model,
      key ? keyHint(key) : "",
      sealed.ciphertext,
      sealed.iv,
      sealed.tag,
      sealed.version,
      v.status,
      v.verifiedAt,
      v.lastError,
      b.monthly_token_limit ?? null,
      now,
      createdBy,
      now,
    );
    return { row: this.row(id)!, verification, key };
  }

  /** Applies a patch; a new key or base URL re-verifies, and so does re-activating an invalid connection. */
  async update(merchantId: string, id: string, b: UpdateConnectionInput): Promise<{ row: ConnectionRow; verification: VerifyResult | null; rotated: boolean; key: string | null }> {
    const cur = this.get(merchantId, id);
    const info = providerInfo(cur.provider);
    const rotated = b.api_key !== undefined && b.api_key !== null;
    const newKey = rotated ? b.api_key!.trim() : null;
    if (rotated && !newKey && !info.keyOptional) throw new ApiError(400, "VALIDATION_ERROR", `${info.name} needs an API key`, { issues: [{ path: "api_key", message: "required" }] });
    const baseUrl = b.base_url === undefined ? cur.base_url : b.base_url?.trim() || null;
    if (info.needsBaseUrl && !baseUrl) throw new ApiError(400, "VALIDATION_ERROR", "base_url is required for an OpenAI-compatible connection", { issues: [{ path: "base_url", message: "required" }] });
    if (baseUrl && baseUrl !== cur.base_url) await this.checkBaseUrl(baseUrl);
    const model = b.default_model ?? cur.default_model;
    const reverify = rotated || baseUrl !== cur.base_url || (b.status === "active" && cur.status === "invalid");
    const key = newKey ?? (reverify ? this.spec(cur).apiKey : null);
    let verification: VerifyResult | null = null;
    let status = b.status ?? cur.status;
    let verifiedAt = cur.verified_at;
    let lastError = cur.last_error;
    if (reverify) {
      verification = await this.#models.verifyConnection({ provider: cur.provider, apiKey: key!, ...(baseUrl ? { baseUrl } : {}), model });
      // A disabled connection stays disabled whatever the check says.
      const v = this.#verifyColumns(verification, key!, status === "disabled" ? "disabled" : "active");
      status = status === "disabled" ? "disabled" : v.status;
      verifiedAt = v.verifiedAt ?? verifiedAt;
      lastError = v.lastError;
    }
    const sealed = newKey !== null ? this.#box.seal(newKey, { merchantId, rowId: id }) : null;
    const now = nowIso();
    this.#db.run(
      `UPDATE ai_connections SET label = ?, base_url = ?, default_model = ?, monthly_token_limit = ?, status = ?, verified_at = ?, last_error = ?,
         key_hint = ?, key_ciphertext = ?, key_iv = ?, key_tag = ?, key_version = ?, rotated_at = ?, updated_at = ? WHERE id = ?`,
      b.label ?? cur.label,
      baseUrl,
      model,
      b.monthly_token_limit === undefined ? cur.monthly_token_limit : b.monthly_token_limit,
      status,
      verifiedAt,
      lastError,
      newKey !== null ? (newKey ? keyHint(newKey) : "") : cur.key_hint,
      sealed?.ciphertext ?? cur.key_ciphertext,
      sealed?.iv ?? cur.key_iv,
      sealed?.tag ?? cur.key_tag,
      sealed?.version ?? cur.key_version,
      sealed ? now : cur.rotated_at,
      now,
      id,
    );
    return { row: this.row(id)!, verification, rotated, key };
  }

  async verify(merchantId: string, id: string): Promise<{ row: ConnectionRow; verification: VerifyResult; key: string }> {
    const cur = this.get(merchantId, id);
    const spec = this.spec(cur);
    if (cur.base_url) await this.checkBaseUrl(cur.base_url);
    const verification = await this.#models.verifyConnection(spec);
    const v = this.#verifyColumns(verification, spec.apiKey, cur.status === "disabled" ? "disabled" : "active");
    this.#db.run(
      "UPDATE ai_connections SET status = ?, verified_at = COALESCE(?, verified_at), last_error = ?, updated_at = ? WHERE id = ?",
      cur.status === "disabled" ? "disabled" : v.status,
      v.verifiedAt,
      v.lastError,
      nowIso(),
      id,
    );
    return { row: this.row(id)!, verification, key: spec.apiKey };
  }

  async listProviderModels(merchantId: string, id: string): Promise<string[] | null> {
    const cur = this.get(merchantId, id);
    const spec = this.spec(cur);
    if (cur.base_url) await this.checkBaseUrl(cur.base_url);
    try {
      return await this.#models.listModels({ provider: spec.provider, apiKey: spec.apiKey, ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}) });
    } catch (err) {
      const e = asModelError(err);
      throw new ApiError(502, "MODEL_PROVIDER_ERROR", scrubSecrets(e.message, spec.apiKey), { kind: e.kind, status: e.status });
    }
  }

  /** Soft delete with the ciphertext wiped; refused while an active agent uses the connection. */
  remove(merchantId: string, id: string): ConnectionRow {
    const cur = this.get(merchantId, id);
    const users = this.#db.all<{ id: string; name: string }>("SELECT id, name FROM agents WHERE connection_id = ? AND status = 'active' AND deleted_at IS NULL", id);
    if (users.length) throw new ApiError(409, "CONNECTION_IN_USE", "active agents use this connection; pause them or move them to another connection first", { agents: users });
    const now = nowIso();
    this.#db.run("UPDATE ai_connections SET deleted_at = ?, status = 'disabled', key_ciphertext = '', key_iv = '', key_tag = '', updated_at = ? WHERE id = ?", now, now, cur.id);
    return this.row(id)!;
  }

  /** The provider rejected the key during a run (401 or 403): nothing uses the connection until it is fixed. */
  markInvalid(id: string, error: ModelError, key?: string): void {
    this.#db.run("UPDATE ai_connections SET status = 'invalid', last_error = ?, updated_at = ? WHERE id = ? AND status = 'active'", scrubSecrets(error.message, key), nowIso(), id);
  }

  #verifyColumns(v: VerifyResult, key: string, okStatus: "active" | "disabled"): { status: ConnectionRow["status"]; verifiedAt: string | null; lastError: string | null } {
    if (v.ok) return { status: okStatus, verifiedAt: nowIso(), lastError: null };
    // Only a rejected key makes a connection invalid; a busy or unreachable provider is recorded and left active.
    return { status: v.error.kind === "auth" ? "invalid" : okStatus, verifiedAt: null, lastError: scrubSecrets(v.error.message, key) };
  }
}
