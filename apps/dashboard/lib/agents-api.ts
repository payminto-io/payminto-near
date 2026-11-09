/**
 * Typed client for the merchant AI agent routes in docs/AGENTS.md section 6: AI connections (the business's own model
 * keys), agents, runs and run steps. Every response is parsed with the zod schemas in lib/schemas.ts. In mock mode the
 * same interface is served by lib/mock/agents.ts.
 */
import { z } from "zod";
import {
  agentOneSchema,
  agentRunEventsSchema,
  agentRunOneSchema,
  agentRunSchema,
  agentsSchema,
  aiConnectionOneSchema,
  aiConnectionsSchema,
  aiModelsSchema,
  aiProvidersSchema,
  aiUsageSchema,
  gatewayPageSchema,
  type Agent,
  type AgentKind,
  type AgentLimits,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunStatus,
  type AiConnection,
  type AiProvider,
  type AiUsage,
} from "./schemas";
import { requestJson, type RequestOptions } from "./http";
import { getMerchantScope, roleOf } from "./merchant-scope";
import type { GatewayPage } from "./gateway-api";

export type CreateConnectionBody = {
  provider: string;
  label: string;
  api_key: string;
  base_url?: string;
  default_model: string;
  monthly_token_limit?: number | null;
};

/** Label, base URL, model, limit, on or off, or `api_key` to rotate (the server verifies the new key). */
export type UpdateConnectionBody = Partial<{
  label: string;
  base_url: string | null;
  default_model: string;
  monthly_token_limit: number | null;
  status: "active" | "disabled";
  api_key: string;
}>;

export type CreateAgentBody = {
  kind: AgentKind;
  name: string;
  description?: string | null;
  connection_id: string;
  model: string;
  instructions?: string | null;
  tools?: string[];
  limits?: Partial<AgentLimits>;
  /** Skill only; `price` in token base units. */
  slug?: string;
  price?: string;
  input_hint?: string | null;
};

export type UpdateAgentBody = Partial<Omit<CreateAgentBody, "kind">> & { status?: "active" | "paused" };

export type RunsQuery = { agent_id?: string; status?: AgentRunStatus; limit?: number; cursor?: string };

/** Abort a long poll when the screen goes away. */
export type CallOptions = { signal?: AbortSignal };

export interface AgentsApi {
  providers(): Promise<AiProvider[]>;
  connections(): Promise<AiConnection[]>;
  createConnection(body: CreateConnectionBody): Promise<AiConnection>;
  updateConnection(id: string, patch: UpdateConnectionBody): Promise<AiConnection>;
  /** Refused with 409 while an active agent uses the connection. */
  deleteConnection(id: string): Promise<void>;
  verifyConnection(id: string): Promise<AiConnection>;
  /** The provider's model list, or null when it has none. */
  models(connectionId: string): Promise<string[] | null>;
  /** `month` is YYYY-MM; the server's current month when left out. */
  usage(month?: string): Promise<AiUsage>;
  agents(): Promise<Agent[]>;
  agent(id: string): Promise<Agent>;
  createAgent(body: CreateAgentBody): Promise<Agent>;
  updateAgent(id: string, patch: UpdateAgentBody): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;
  startRun(agentId: string, input: string, idempotencyKey?: string): Promise<AgentRun>;
  runs(q?: RunsQuery): Promise<GatewayPage<AgentRun>>;
  /** `wait` (0 to 30 seconds) long-polls until the status changes or the time passes. */
  run(id: string, wait?: number, o?: CallOptions): Promise<AgentRun>;
  /** Steps after a sequence number, oldest first; every step when `after` is left out. */
  runEvents(id: string, after?: number, o?: CallOptions): Promise<AgentRunEvent[]>;
  cancelRun(id: string): Promise<AgentRun>;
}

const anyBody = z.unknown();

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class HttpAgentsApi implements AgentsApi {
  /** Like the gateway client: a console credential names the open business with Merchant-Id. */
  private readonly scoped: boolean;
  constructor(
    private readonly nodeUrl: string,
    private readonly token: string,
  ) {
    this.scoped = roleOf(token) === "operator";
  }

  private req<T>(path: string, schema: z.ZodType<T>, init: RequestOptions = {}): Promise<T> {
    const scope = this.scoped ? getMerchantScope() : null;
    return requestJson(this.nodeUrl, path, schema, { ...init, token: this.token, headers: { ...(scope ? { "Merchant-Id": scope } : {}), ...init.headers } });
  }
  private send<T>(method: "POST" | "PATCH", path: string, schema: z.ZodType<T>, body: unknown = {}, idempotencyKey?: string): Promise<T> {
    return this.req(path, schema, { method, body: JSON.stringify(body), idempotencyKey });
  }

  providers() {
    return this.req("/v1/ai/providers", aiProvidersSchema);
  }
  connections() {
    return this.req("/v1/ai/connections", aiConnectionsSchema);
  }
  createConnection(body: CreateConnectionBody) {
    return this.send("POST", "/v1/ai/connections", aiConnectionOneSchema, body);
  }
  updateConnection(id: string, patch: UpdateConnectionBody) {
    return this.send("PATCH", `/v1/ai/connections/${encodeURIComponent(id)}`, aiConnectionOneSchema, patch);
  }
  async deleteConnection(id: string) {
    await this.req(`/v1/ai/connections/${encodeURIComponent(id)}`, anyBody, { method: "DELETE" });
  }
  verifyConnection(id: string) {
    return this.send("POST", `/v1/ai/connections/${encodeURIComponent(id)}/verify`, aiConnectionOneSchema);
  }
  models(connectionId: string) {
    return this.req(`/v1/ai/connections/${encodeURIComponent(connectionId)}/models`, aiModelsSchema);
  }
  usage(month?: string) {
    return this.req(`/v1/ai/usage${qs({ month })}`, aiUsageSchema);
  }
  agents() {
    return this.req("/v1/agents", agentsSchema);
  }
  agent(id: string) {
    return this.req(`/v1/agents/${encodeURIComponent(id)}`, agentOneSchema);
  }
  createAgent(body: CreateAgentBody) {
    return this.send("POST", "/v1/agents", agentOneSchema, body);
  }
  updateAgent(id: string, patch: UpdateAgentBody) {
    return this.send("PATCH", `/v1/agents/${encodeURIComponent(id)}`, agentOneSchema, patch);
  }
  async deleteAgent(id: string) {
    await this.req(`/v1/agents/${encodeURIComponent(id)}`, anyBody, { method: "DELETE" });
  }
  startRun(agentId: string, input: string, idempotencyKey?: string) {
    return this.send("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, agentRunOneSchema, { input }, idempotencyKey);
  }
  runs(q: RunsQuery = {}) {
    return this.req(`/v1/agent-runs${qs(q)}`, gatewayPageSchema(agentRunSchema));
  }
  run(id: string, wait = 0, o: CallOptions = {}) {
    return this.req(`/v1/agent-runs/${encodeURIComponent(id)}${qs({ wait: wait > 0 ? Math.min(30, Math.round(wait)) : undefined })}`, agentRunOneSchema, { signal: o.signal });
  }
  runEvents(id: string, after?: number, o: CallOptions = {}) {
    return this.req(`/v1/agent-runs/${encodeURIComponent(id)}/events${qs({ after })}`, agentRunEventsSchema, { signal: o.signal });
  }
  cancelRun(id: string) {
    return this.send("POST", `/v1/agent-runs/${encodeURIComponent(id)}/cancel`, agentRunOneSchema);
  }
}
