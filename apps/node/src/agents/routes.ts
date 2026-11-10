/**
 * The agents API (docs/AGENTS.md section 6). Reads need payments.read (Viewers and up), starting and cancelling runs
 * payments.write (Staff and up), and connection and agent changes business.update (business Admins; a business API
 * key holds it too). Paid skills are public behind the paywall.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { PROVIDER_IDS, PROVIDERS } from "@payminto/models";
import { HEADER_RESPONSE } from "@payminto/protocol";
import { ApiError } from "../errors.ts";
import { auditActor, type Access, type Actor } from "../auth/actor.ts";
import type { BusinessPermission } from "../auth/permissions.ts";
import type { AuthService } from "../auth/service.ts";
import { body, limitOf, parse, zUint } from "../gateway/http.ts";
import type { MerchantRow } from "../gateway/merchants.ts";
import { OPS_TOOLS } from "./agents.ts";
import { monthBounds, verificationJson } from "./connections.ts";
import type { AgentsModule } from "./index.ts";
import { AGENT_KINDS, isAgentId, RUN_STATUSES, runJson, TERMINAL, type AgentRow, type RunRow, type RunStatus } from "./rows.ts";
import { MAX_RUN_INPUT } from "./runs.ts";

type AuthedActor = Exclude<Actor, { type: "anonymous" }>;

const READ: BusinessPermission = "payments.read";
const RUN: BusinessPermission = "payments.write";
const MANAGE: BusinessPermission = "business.update";

const zText = (max: number) => z.string().trim().min(1).max(max);
const zModel = z.string().trim().min(1).max(200);
const zLimit = z.number().int().positive().max(1_000_000_000_000);

const createConnectionSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  label: zText(120),
  api_key: z.string().max(2_000).nullish(),
  base_url: z.url().max(2_000).nullish(),
  default_model: zModel,
  monthly_token_limit: zLimit.nullish(),
});

const updateConnectionSchema = z.object({
  label: zText(120).optional(),
  base_url: z.url().max(2_000).nullable().optional(),
  default_model: zModel.optional(),
  monthly_token_limit: zLimit.nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  api_key: z.string().max(2_000).optional(),
});

const zLimits = z
  .object({
    max_turns: z.number().int().min(1).max(50),
    max_output_tokens: z.number().int().min(256).max(200_000),
    timeout_seconds: z.number().int().min(10).max(900),
  })
  .partial();

const zSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "2 to 63 lowercase letters, digits and dashes");
const zPrice = zUint.refine((v) => BigInt(v) > 0n, "must be more than zero");

const createAgentSchema = z.object({
  kind: z.enum(AGENT_KINDS),
  name: zText(120),
  description: z.string().trim().max(1_000).optional(),
  connection_id: z.string().min(1).max(64),
  model: zModel.nullish(),
  instructions: z.string().max(8_000).optional(),
  tools: z.array(z.enum(OPS_TOOLS)).max(OPS_TOOLS.length).nullish(),
  limits: zLimits.optional(),
  slug: zSlug.optional(),
  price: zPrice.optional(),
  input_hint: z.string().trim().max(500).nullish(),
});

const updateAgentSchema = z.object({
  name: zText(120).optional(),
  description: z.string().trim().max(1_000).optional(),
  connection_id: z.string().min(1).max(64).optional(),
  model: zModel.nullable().optional(),
  instructions: z.string().max(8_000).optional(),
  tools: z.array(z.enum(OPS_TOOLS)).max(OPS_TOOLS.length).nullable().optional(),
  limits: zLimits.optional(),
  status: z.enum(["active", "paused"]).optional(),
  price: zPrice.optional(),
  input_hint: z.string().trim().max(500).nullable().optional(),
});

const runSchema = z.object({ input: z.string().trim().min(1).max(MAX_RUN_INPUT) });

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

function waitOf(c: Context, max = 30): number {
  const raw = c.req.query("wait");
  if (raw === undefined || raw === "") return 0;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, "VALIDATION_ERROR", `wait must be 0 to ${max} seconds`);
  return Math.min(Number(raw), max);
}

export type AgentRouteDeps = { access: Access; auth: AuthService };

export function mountAgents(app: Hono<any>, m: AgentsModule, d: AgentRouteDeps): void {
  const a = d.access;
  const actorId = (x: AuthedActor) => (x.type === "user" ? x.user.id : x.type === "api_key" ? x.key.id : null);
  const audit = (x: AuthedActor, merchantId: string, action: string, target: string, meta: Record<string, unknown> = {}) =>
    d.auth.audit.write(auditActor(x), action, { merchantId, target, meta });
  const who = (c: Context, perm: BusinessPermission) => a.business(c, perm);

  /** Why a run of this agent cannot start now, or null. */
  const unavailable = (agent: AgentRow): string | null => {
    if (agent.status !== "active") return "agent_paused";
    const conn = m.connections.row(agent.connection_id);
    if (!conn || conn.deleted_at) return "connection_deleted";
    if (conn.status !== "active") return `connection_${conn.status}`;
    if (m.connections.overLimit(conn)) return "token_limit_reached";
    return null;
  };
  const refuseUnavailable = (agent: AgentRow) => {
    const reason = unavailable(agent);
    if (reason) throw new ApiError(503, "MODEL_UNAVAILABLE", "this agent cannot run now", { reason });
  };

  // ================================================================ providers and connections

  app.get("/v1/ai/providers", (c) => {
    who(c, READ);
    return c.json({ items: PROVIDERS });
  });

  app.get("/v1/ai/connections", (c) => {
    const { merchant } = who(c, READ);
    return c.json({ items: m.connections.list(merchant.id).map((r) => m.connections.json(r)) });
  });

  app.post("/v1/ai/connections", async (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const b = await body(c, createConnectionSchema);
    const out = await m.connections.create(merchant.id, b, actorId(actor));
    audit(actor, merchant.id, "ai_connection.created", out.row.id, { provider: out.row.provider, label: out.row.label, model: out.row.default_model, status: out.row.status });
    return c.json({ ...m.connections.json(out.row), verification: verificationJson(out.verification, out.key) }, 201);
  });

  const connectionId = (c: Context) => {
    const id = c.req.param("id");
    if (!isAgentId(id, "aic")) throw new ApiError(404, "NOT_FOUND", "AI connection not found");
    return id;
  };

  app.get("/v1/ai/connections/:id", (c) => {
    const { merchant } = who(c, READ);
    return c.json(m.connections.json(m.connections.get(merchant.id, connectionId(c))));
  });

  app.patch("/v1/ai/connections/:id", async (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const id = connectionId(c);
    const b = await body(c, updateConnectionSchema);
    const before = m.connections.get(merchant.id, id);
    const out = await m.connections.update(merchant.id, id, b);
    const action = out.rotated
      ? "ai_connection.rotated"
      : b.status === "disabled" && before.status !== "disabled"
        ? "ai_connection.disabled"
        : b.status === "active" && before.status !== "active"
          ? "ai_connection.enabled"
          : "ai_connection.updated";
    const { api_key: _key, ...changed } = b;
    audit(actor, merchant.id, action, id, { ...changed, status: out.row.status });
    return c.json({ ...m.connections.json(out.row), verification: out.verification ? verificationJson(out.verification, out.key ?? undefined) : null });
  });

  app.delete("/v1/ai/connections/:id", (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const id = connectionId(c);
    const r = m.connections.remove(merchant.id, id);
    audit(actor, merchant.id, "ai_connection.deleted", id, { provider: r.provider, label: r.label });
    return c.json({ id, deleted: true });
  });

  app.post("/v1/ai/connections/:id/verify", async (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const id = connectionId(c);
    const out = await m.connections.verify(merchant.id, id);
    audit(actor, merchant.id, "ai_connection.verified", id, { ok: out.verification.ok, status: out.row.status });
    return c.json({ ...m.connections.json(out.row), verification: verificationJson(out.verification, out.key) });
  });

  app.get("/v1/ai/connections/:id/models", async (c) => {
    const { merchant } = who(c, READ);
    return c.json({ items: await m.connections.listProviderModels(merchant.id, connectionId(c)) });
  });

  app.get("/v1/ai/usage", (c) => {
    const { merchant } = who(c, READ);
    const month = c.req.query("month") || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, "VALIDATION_ERROR", "month must be YYYY-MM");
    const { start, end } = monthBounds(Date.parse(`${month}-01T00:00:00.000Z`));
    const sum = (where: string, ...p: Array<string | number>) =>
      m.gateway.db.all<{ k: string; i: number; o: number; n: number }>(
        `SELECT ${where} AS k, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COUNT(*) AS n
         FROM agent_runs WHERE merchant_id = ? AND created_ms >= ? AND created_ms < ? GROUP BY ${where} ORDER BY ${where}`,
        merchant.id,
        start,
        end,
        ...p,
      );
    const shape = (r: { i: number; o: number; n: number }) => ({ input_tokens: r.i, output_tokens: r.o, total_tokens: r.i + r.o, runs: r.n });
    const connections = sum("connection_id").map((r) => {
      const conn = m.connections.row(r.k);
      return { connection_id: r.k, label: conn?.label ?? null, provider: conn?.provider ?? null, monthly_token_limit: conn?.monthly_token_limit ?? null, ...shape(r) };
    });
    const agents = sum("agent_id").map((r) => ({ agent_id: r.k, name: m.agents.row(r.k)?.name ?? null, ...shape(r) }));
    const totals = connections.reduce((t, x) => ({ input_tokens: t.input_tokens + x.input_tokens, output_tokens: t.output_tokens + x.output_tokens, total_tokens: t.total_tokens + x.total_tokens, runs: t.runs + x.runs }), {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      runs: 0,
    });
    return c.json({ month, from: new Date(start).toISOString(), to: new Date(end).toISOString(), totals, connections, agents });
  });

  // ================================================================ agents

  const agentId = (c: Context) => {
    const id = c.req.param("id");
    if (!isAgentId(id, "agt")) throw new ApiError(404, "NOT_FOUND", "agent not found");
    return id;
  };

  app.get("/v1/agents", (c) => {
    const { merchant } = who(c, READ);
    const kind = c.req.query("kind");
    if (kind && !(AGENT_KINDS as readonly string[]).includes(kind)) throw new ApiError(400, "VALIDATION_ERROR", `kind must be one of ${AGENT_KINDS.join(", ")}`);
    return c.json({ items: m.agents.list(merchant.id, { kind: kind as AgentRow["kind"] | undefined }).map((r) => m.agents.json(r)) });
  });

  app.post("/v1/agents", async (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const b = await body(c, createAgentSchema);
    const r = m.gateway.db.tx(() => {
      const r = m.agents.create(merchant, b, actorId(actor));
      audit(actor, merchant.id, "agent.created", r.id, { kind: r.kind, name: r.name, connection_id: r.connection_id, model: r.model, slug: r.slug, price: r.price });
      return r;
    });
    return c.json(m.agents.json(r), 201);
  });

  app.get("/v1/agents/:id", (c) => {
    const { merchant } = who(c, READ);
    return c.json(m.agents.json(m.agents.get(merchant.id, agentId(c))));
  });

  app.patch("/v1/agents/:id", async (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const id = agentId(c);
    const b = await body(c, updateAgentSchema);
    const r = m.gateway.db.tx(() => {
      const before = m.agents.get(merchant.id, id);
      const r = m.agents.update(merchant, id, b);
      const action = b.status === "paused" && before.status !== "paused" ? "agent.paused" : b.status === "active" && before.status !== "active" ? "agent.resumed" : "agent.updated";
      audit(actor, merchant.id, action, id, { ...b, instructions: b.instructions === undefined ? undefined : "changed" });
      return r;
    });
    return c.json(m.agents.json(r));
  });

  app.delete("/v1/agents/:id", (c) => {
    const { merchant, actor } = who(c, MANAGE);
    const id = agentId(c);
    const r = m.gateway.db.tx(() => {
      const r = m.agents.remove(merchant.id, id);
      audit(actor, merchant.id, "agent.deleted", id, { kind: r.kind, name: r.name });
      return r;
    });
    const cancelled = m.runs.cancelQueuedOf(r.id);
    return c.json({ id, deleted: true, runs_cancelled: cancelled });
  });

  // ================================================================ runs

  app.post("/v1/agents/:id/runs", async (c) => {
    const { merchant, actor } = who(c, RUN);
    const agent = m.agents.get(merchant.id, agentId(c));
    const b = await body(c, runSchema);
    const idem = c.req.header("idempotency-key") ?? null;
    // A replay returns the first run even if the agent cannot run now; a new run of such an agent is refused.
    if (!(idem && m.runs.byIdempotencyKey(merchant.id, idem))) refuseUnavailable(agent);
    const out = m.runs.create({ agent, trigger: actor.type === "user" ? "dashboard" : "api", input: b.input, idempotencyKey: idem, createdBy: actorId(actor) });
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(runJson(m.runs.row(out.row.id)!), out.replayed ? 200 : 202);
  });

  const runOf = (c: Context, merchant: MerchantRow): RunRow => {
    const id = c.req.param("id");
    if (!isAgentId(id, "run")) throw new ApiError(404, "NOT_FOUND", "agent run not found");
    return m.runs.get(merchant.id, id);
  };

  app.get("/v1/agent-runs", (c) => {
    const { merchant } = who(c, READ);
    const status = c.req.query("status");
    if (status && !(RUN_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "VALIDATION_ERROR", `status must be one of ${RUN_STATUSES.join(", ")}`);
    const cursor = c.req.query("cursor");
    if (cursor && !/^\d+$/.test(cursor)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    return c.json(
      m.runs.list(merchant.id, {
        agentId: c.req.query("agent_id") || undefined,
        status: (status || undefined) as RunStatus | undefined,
        limit: limitOf(c, 50, 200),
        cursor: cursor ? Number(cursor) : undefined,
      }),
    );
  });

  app.get("/v1/agent-runs/:id", async (c) => {
    const { merchant } = who(c, READ);
    let run = runOf(c, merchant);
    const wait = waitOf(c);
    if (wait > 0 && !TERMINAL.has(run.status)) run = await m.runs.waitForChange(run.id, run.status, wait * 1000);
    return c.json(runJson(run));
  });

  app.get("/v1/agent-runs/:id/events", (c) => {
    const { merchant } = who(c, READ);
    const run = runOf(c, merchant);
    const after = c.req.query("after");
    if (after !== undefined && after !== "" && !/^\d+$/.test(after)) throw new ApiError(400, "VALIDATION_ERROR", "after must be a step sequence number");
    const items = m.runs.events(run.id, after ? Number(after) : 0, limitOf(c, 500, 500));
    return c.json({ run_id: run.id, status: run.status, items, last_seq: items.at(-1)?.seq ?? (after ? Number(after) : 0) });
  });

  app.post("/v1/agent-runs/:id/cancel", (c) => {
    const { merchant } = who(c, RUN);
    const run = runOf(c, merchant);
    return c.json(runJson(m.runs.requestCancel(merchant.id, run.id)));
  });

  // ================================================================ paid skills (public)

  const skillOf = (c: Context): AgentRow => {
    const slug = c.req.param("slug") ?? "";
    const agent = /^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) ? m.agents.bySlug(slug) : undefined;
    if (!agent) throw new ApiError(404, "NOT_FOUND", "no skill with this name on this server");
    return agent;
  };

  const skillView = (agent: AgentRow, r: RunRow, token?: string) => {
    const pollUrl = `${m.agents.skillUrl(agent.slug!)}/runs/${r.id}`;
    return {
      run_id: r.id,
      skill: agent.slug,
      status: r.status,
      result: r.result ? (JSON.parse(r.result) as { answer: string }) : null,
      error_code: r.error_code,
      error_message: r.error_message,
      created_at: r.created_at,
      finished_at: r.finished_at,
      poll_url: token ? `${pollUrl}?token=${token}` : pollUrl,
      ...(token ? { result_token: token } : {}),
    };
  };

  app.post("/v1/skills/:slug", async (c) => {
    const agent = skillOf(c);
    const merchant = m.gateway.merchants.merchant(agent.merchant_id);
    // Everything that can be refused is refused before the paywall, so nobody pays for work that cannot run.
    const text = await c.req.text();
    let raw: unknown;
    const type = c.req.header("content-type") ?? "";
    if (type.includes("application/json")) {
      try {
        raw = text ? JSON.parse(text) : {};
      } catch {
        throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
      }
    } else raw = { input: text };
    const { input } = parse(raw, runSchema, "send {\"input\": \"...\"} as JSON, or the input as plain text");
    if (merchant.status !== "active") throw new ApiError(503, "MODEL_UNAVAILABLE", "this skill cannot run now", { reason: "business_suspended" });
    const reason = unavailable(agent);
    if (reason) throw new ApiError(503, "MODEL_UNAVAILABLE", "this skill cannot run now", { reason });
    if (merchant.payout === null) throw new ApiError(503, "MODEL_UNAVAILABLE", "this skill cannot run now", { reason: "payout_not_set" });
    m.agents.syncProvider(agent, merchant);
    // A fresh Request with the bytes already read: the paywall hashes method, URL and body.
    const req = new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: text });
    const check = await m.paywallFor(agent, merchant.payout).check(req);
    if (!check.ok) return check.response;
    const token = `rtk_${randomBytes(24).toString("base64url")}`;
    const out = m.runs.create({
      agent,
      trigger: "skill_call",
      input,
      resultTokenHash: sha256hex(token),
      skillCallId: check.paid.receipt.callId,
      payer: m.gateway.db.get<{ agent: string }>("SELECT agent FROM budgets WHERE id = ?", check.paid.receipt.budgetId)?.agent ?? null,
    });
    // Wait for the result up to skillWaitMs (25 s), then hand back a poll URL that needs the result token.
    const deadline = Date.now() + m.skillWaitMs;
    let run = out.row;
    while (!TERMINAL.has(run.status) && Date.now() < deadline) run = await m.runs.waitForChange(run.id, run.status, deadline - Date.now());
    c.header(HEADER_RESPONSE, check.responseHeader);
    c.header("access-control-expose-headers", HEADER_RESPONSE);
    return c.json(skillView(agent, run, token), TERMINAL.has(run.status) ? 200 : 202);
  });

  app.get("/v1/skills/:slug/runs/:id", async (c) => {
    const agent = skillOf(c);
    const id = c.req.param("id");
    const token = c.req.query("token") ?? "";
    const r = isAgentId(id, "run") ? m.runs.row(id) : undefined;
    const ok =
      !!r &&
      r.agent_id === agent.id &&
      !!r.result_token_hash &&
      /^rtk_[A-Za-z0-9_-]{32}$/.test(token) &&
      timingSafeEqual(Buffer.from(sha256hex(token), "hex"), Buffer.from(r.result_token_hash, "hex"));
    // One answer for a wrong id and a wrong token: nobody learns which runs exist.
    if (!ok) throw new ApiError(404, "NOT_FOUND", "no run of this skill matches this id and token");
    let run = r!;
    const wait = waitOf(c);
    if (wait > 0 && !TERMINAL.has(run.status)) run = await m.runs.waitForChange(run.id, run.status, wait * 1000);
    return c.json(skillView(agent, run));
  });
}
