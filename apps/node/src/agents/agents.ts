import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { MerchantRow } from "../gateway/merchants.ts";
import { nowIso } from "../store.ts";
import type { ConnectionService } from "./connections.ts";
import { agentTools, DEFAULT_AGENT_LIMITS, newId, type AgentKind, type AgentRow, type AgentStatus } from "./rows.ts";
import type { SecretBox } from "./secrets.ts";

/** The ops agent's tools: the seven merchant tools (apps/mcp merchant server, packages/sdk merchant-tools.ts). */
export const OPS_TOOLS = ["get_overview", "list_payments", "get_payment", "create_link", "request_refund", "get_reconciliation", "list_blocked"] as const;

export type AgentLimits = { max_turns: number; max_output_tokens: number; timeout_seconds: number };

export type CreateAgentInput = {
  kind: AgentKind;
  name: string;
  description?: string;
  connection_id: string;
  model?: string | null;
  instructions?: string;
  tools?: string[] | null;
  limits?: Partial<AgentLimits>;
  slug?: string;
  price?: string;
  input_hint?: string | null;
};

export type UpdateAgentInput = {
  name?: string;
  description?: string;
  connection_id?: string;
  model?: string | null;
  instructions?: string;
  tools?: string[] | null;
  limits?: Partial<AgentLimits>;
  status?: AgentStatus;
  price?: string;
  input_hint?: string | null;
};

/** Category of the provider rows that back skills (listed in the directory, unlike the gateway's own rows). */
export const SKILL_CATEGORY = "skill";

/**
 * A business's agents (docs/AGENTS.md section 4). A skill also registers a provider (what `paywall()` and the
 * directory read): payee the business's payout wallet, price the skill's price, resource its public URL. Its provider
 * key is sealed like a model key.
 */
export class AgentService {
  readonly #db: Database;
  readonly #box: SecretBox;
  readonly #connections: ConnectionService;
  readonly #publicUrl: string;

  constructor(o: { db: Database; box: SecretBox; connections: ConnectionService; publicUrl: string }) {
    this.#db = o.db;
    this.#box = o.box;
    this.#connections = o.connections;
    this.#publicUrl = o.publicUrl.replace(/\/+$/, "");
  }

  row(id: string): AgentRow | undefined {
    return this.#db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  }

  get(merchantId: string, id: string): AgentRow {
    const r = this.row(id);
    if (!r || r.merchant_id !== merchantId || r.deleted_at) throw new ApiError(404, "NOT_FOUND", "agent not found");
    return r;
  }

  list(merchantId: string, o: { kind?: AgentKind } = {}): AgentRow[] {
    return this.#db.all<AgentRow>(
      `SELECT * FROM agents WHERE merchant_id = ? AND deleted_at IS NULL ${o.kind ? "AND kind = ?" : ""} ORDER BY created_at DESC, id`,
      merchantId,
      ...(o.kind ? [o.kind] : []),
    );
  }

  bySlug(slug: string): AgentRow | undefined {
    return this.#db.get<AgentRow>("SELECT * FROM agents WHERE slug = ? AND deleted_at IS NULL AND kind = 'skill'", slug);
  }

  skillUrl(slug: string): string {
    return `${this.#publicUrl}/v1/skills/${slug}`;
  }

  json(r: AgentRow) {
    const conn = this.#connections.row(r.connection_id);
    const last = this.#db.get<{ id: string; status: string; created_at: string; finished_at: string | null }>(
      "SELECT id, status, created_at, finished_at FROM agent_runs WHERE agent_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1",
      r.id,
    );
    return {
      id: r.id,
      object: "agent" as const,
      merchant_id: r.merchant_id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      connection_id: r.connection_id,
      connection: conn ? { label: conn.label, provider: conn.provider, status: conn.deleted_at ? ("deleted" as const) : conn.status } : null,
      model: r.model,
      instructions: r.instructions,
      tools: r.kind === "ops" ? (agentTools(r) ?? [...OPS_TOOLS]) : [],
      limits: { max_turns: r.max_turns, max_output_tokens: r.max_output_tokens, timeout_seconds: r.timeout_seconds },
      status: r.status,
      skill_url: r.kind === "skill" ? this.skillUrl(r.slug!) : null,
      skill: r.kind === "skill" ? { slug: r.slug!, price: r.price!, input_hint: r.input_hint, url: this.skillUrl(r.slug!), provider_id: r.provider_id } : null,
      last_run: last ?? null,
      created_at: r.created_at,
      created_by: r.created_by,
      updated_at: r.updated_at,
    };
  }

  #connection(merchantId: string, id: string) {
    const c = this.#connections.row(id);
    if (!c || c.merchant_id !== merchantId || c.deleted_at) throw new ApiError(400, "UNKNOWN_CONNECTION", "connection_id names no AI connection of this business");
    return c;
  }

  #tools(kind: AgentKind, tools: string[] | null | undefined): string | null {
    if (tools === undefined || tools === null) return null;
    if (kind !== "ops") throw new ApiError(400, "VALIDATION_ERROR", "only ops agents have tools", { issues: [{ path: "tools", message: "not allowed for skills" }] });
    const bad = tools.filter((t) => !(OPS_TOOLS as readonly string[]).includes(t));
    if (bad.length) throw new ApiError(400, "VALIDATION_ERROR", `unknown tools: ${bad.join(", ")}`, { issues: [{ path: "tools", message: `must be among ${OPS_TOOLS.join(", ")}` }] });
    return JSON.stringify([...new Set(tools)]);
  }

  create(merchant: MerchantRow, b: CreateAgentInput, createdBy: string | null): AgentRow {
    const conn = this.#connection(merchant.id, b.connection_id);
    const limits = { ...DEFAULT_AGENT_LIMITS, ...b.limits };
    const tools = this.#tools(b.kind, b.tools);
    const id = newId("agt");
    const now = nowIso();
    let skill: { slug: string; price: string; providerId: string; keyHash: string; sealed: ReturnType<SecretBox["seal"]> } | null = null;
    if (b.kind === "skill") {
      if (!b.slug || !b.price) throw new ApiError(400, "VALIDATION_ERROR", "a skill needs slug and price", { issues: [{ path: b.slug ? "price" : "slug", message: "required" }] });
      if (this.bySlug(b.slug)) throw new ApiError(409, "SLUG_TAKEN", `the skill slug ${b.slug} is taken on this server`);
      if (merchant.payout_set === 0) throw new ApiError(409, "PAYOUT_NOT_SET", "set the business's payout wallet before selling a skill");
      const providerKey = `pmk_${randomBytes(24).toString("base64url")}`;
      skill = { slug: b.slug, price: b.price, providerId: `prv_${randomBytes(6).toString("hex")}`, keyHash: createHash("sha256").update(providerKey).digest("hex"), sealed: this.#box.seal(providerKey, { merchantId: merchant.id, rowId: id }) };
    } else if (b.slug || b.price || b.input_hint) {
      throw new ApiError(400, "VALIDATION_ERROR", "slug, price and input_hint are for skills only", { issues: [{ path: b.slug ? "slug" : b.price ? "price" : "input_hint", message: "not allowed for ops agents" }] });
    }
    this.#db.tx(() => {
      if (skill) {
        // The same hashing as POST /v1/providers (api.ts hashApiKey), so the provider middleware finds the key.
        this.#db.run(
          `INSERT INTO providers (id, name, description, payee, price_atomic, resource, category, api_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          skill!.providerId,
          b.name,
          b.description ?? "",
          merchant.payout,
          b.price!,
          this.skillUrl(b.slug!),
          SKILL_CATEGORY,
          skill.keyHash,
          now,
        );
      }
      this.#db.run(
        `INSERT INTO agents (id, merchant_id, kind, name, description, connection_id, model, instructions, tools, max_turns, max_output_tokens, timeout_seconds,
           status, slug, price, input_hint, provider_id, provider_key_ciphertext, provider_key_iv, provider_key_tag, provider_key_version, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        merchant.id,
        b.kind,
        b.name,
        b.description ?? "",
        conn.id,
        b.model?.trim() || conn.default_model,
        b.instructions ?? "",
        tools,
        limits.max_turns,
        limits.max_output_tokens,
        limits.timeout_seconds,
        skill?.slug ?? null,
        skill?.price ?? null,
        b.kind === "skill" ? (b.input_hint ?? null) : null,
        skill?.providerId ?? null,
        skill?.sealed.ciphertext ?? null,
        skill?.sealed.iv ?? null,
        skill?.sealed.tag ?? null,
        skill?.sealed.version ?? null,
        now,
        createdBy,
        now,
      );
    });
    return this.row(id)!;
  }

  update(merchant: MerchantRow, id: string, b: UpdateAgentInput): AgentRow {
    const cur = this.get(merchant.id, id);
    const conn = b.connection_id ? this.#connection(merchant.id, b.connection_id) : null;
    if (cur.kind !== "skill" && (b.price !== undefined || b.input_hint !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "price and input_hint are for skills only", { issues: [{ path: b.price !== undefined ? "price" : "input_hint", message: "not allowed for ops agents" }] });
    }
    const tools = b.tools === undefined ? cur.tools : this.#tools(cur.kind, b.tools);
    const limits = { max_turns: cur.max_turns, max_output_tokens: cur.max_output_tokens, timeout_seconds: cur.timeout_seconds, ...b.limits };
    const now = nowIso();
    this.#db.tx(() => {
      this.#db.run(
        `UPDATE agents SET name = ?, description = ?, connection_id = ?, model = ?, instructions = ?, tools = ?, max_turns = ?, max_output_tokens = ?,
           timeout_seconds = ?, status = ?, price = ?, input_hint = ?, updated_at = ? WHERE id = ?`,
        b.name ?? cur.name,
        b.description ?? cur.description,
        conn?.id ?? cur.connection_id,
        b.model === undefined ? (conn ? conn.default_model : cur.model) : b.model?.trim() || (conn ?? this.#connections.row(cur.connection_id)!).default_model,
        b.instructions ?? cur.instructions,
        tools,
        limits.max_turns,
        limits.max_output_tokens,
        limits.timeout_seconds,
        b.status ?? cur.status,
        b.price ?? cur.price,
        b.input_hint === undefined ? cur.input_hint : b.input_hint,
        now,
        id,
      );
      if (cur.provider_id) this.syncProvider(this.row(id)!, merchant);
    });
    return this.row(id)!;
  }

  /** Keeps the skill's provider row in step with the agent and the business's current payout wallet. */
  syncProvider(r: AgentRow, merchant: MerchantRow): void {
    if (!r.provider_id) return;
    this.#db.run(
      "UPDATE providers SET name = ?, description = ?, payee = ?, price_atomic = ? WHERE id = ? AND (name != ? OR description != ? OR payee != ? OR price_atomic != ?)",
      r.name,
      r.description,
      merchant.payout,
      r.price!,
      r.provider_id,
      r.name,
      r.description,
      merchant.payout,
      r.price!,
    );
  }

  /** Soft delete; runs are kept, queued runs are cancelled by the caller. A skill's slug becomes free again. */
  remove(merchantId: string, id: string): AgentRow {
    const cur = this.get(merchantId, id);
    const now = nowIso();
    this.#db.run("UPDATE agents SET deleted_at = ?, status = 'paused', updated_at = ? WHERE id = ?", now, now, cur.id);
    return this.row(id)!;
  }

  /** The skill's provider API key, for its paywall. */
  providerKey(r: AgentRow): string {
    if (!r.provider_key_ciphertext) throw new Error(`agent ${r.id} has no provider key`);
    return this.#box.open(
      { ciphertext: r.provider_key_ciphertext, iv: r.provider_key_iv!, tag: r.provider_key_tag!, version: r.provider_key_version! },
      { merchantId: r.merchant_id, rowId: r.id },
    );
  }

}
