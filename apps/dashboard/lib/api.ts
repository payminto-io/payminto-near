/**
 * Typed client for the Clearing Node API (docs/SPEC.md 5.6).
 * One instance per signed-in session. In mock mode (NEXT_PUBLIC_MOCK=1) the same interface is served by
 * an in-memory node so every screen can be built and demoed without a backend.
 */
import { z } from "zod";
import type { Address, Hex } from "viem";
import type { MandateJson, Policy } from "@payminto/protocol";
import {
  batchDetailSchema,
  batchSchema,
  callSchema,
  denialSchema,
  healthSchema,
  infoSchema,
  ledgerEntrySchema,
  mandateDetailSchema,
  mandateSchema,
  nettingPreviewSchema,
  overviewSchema,
  pageSchema,
  proofSchema,
  providerCreatedSchema,
  providerSchema,
  revokeResultSchema,
  settlementResultSchema,
  trialBalanceSchema,
  type Batch,
  type BatchDetail,
  type Call,
  type Denial,
  type Health,
  type Info,
  type LedgerEntry,
  type MandateDetail,
  type MandateRecord,
  type NettingPreview,
  type Overview,
  type Provider,
  type ReceiptProof,
  type RevokeResult,
  type SettlementResult,
  type TrialBalance,
  type NodeEvent,
} from "./schemas";
import { MOCK_MODE, NODE_URL } from "./config";
import { ApiError, requestJson } from "./http";
import { HttpGatewayApi, type GatewayApi } from "./gateway-api";
import { HttpOperatorApi, type OperatorApi } from "./operator-api";
import { HttpAgentsApi, type AgentsApi } from "./agents-api";
import { roleOf, type Role } from "./merchant-scope";

export { ApiError };

export type CreateMandateBody = {
  mandate: MandateJson;
  ownerSignature: Hex;
  policy: Policy;
  payees: Address[];
  label: string;
};

export type CreateProviderBody = {
  name: string;
  description: string;
  payee: Address;
  priceAtomic: string;
  resource: string;
  category: string;
};

export type CallsQuery = { mandateId?: string; payee?: string; status?: string; limit?: number; cursor?: string };
export type Page<T> = { items: T[]; nextCursor?: string | null };

export interface ClearingApi {
  readonly nodeUrl: string;
  readonly mock: boolean;
  /** Merchant gateway routes (docs/GATEWAY.md section 8) on the same node and token. */
  readonly gateway: GatewayApi;
  /** Operator routes (admin token): merchants, fee plans, platform. */
  readonly operator: OperatorApi;
  /** Merchant AI agents (docs/AGENTS.md section 6): AI connections, agents and runs of the open business. */
  readonly agents: AgentsApi;
  /** "merchant" when signed in with a merchant secret key, which sees only its own gateway data. */
  readonly role: Role;
  health(): Promise<Health>;
  info(): Promise<Info>;
  overview(): Promise<Overview>;
  mandates(): Promise<MandateRecord[]>;
  mandate(id: string): Promise<MandateDetail>;
  createMandate(body: CreateMandateBody): Promise<MandateRecord>;
  revokeMandate(id: string): Promise<RevokeResult>;
  providers(): Promise<Provider[]>;
  /** The catalog alone (no per-provider revenue): one request, used to name wallets. */
  providerCatalog(): Promise<Provider[]>;
  provider(id: string): Promise<Provider>;
  createProvider(body: CreateProviderBody): Promise<{ id: string; apiKey: string }>;
  calls(q?: CallsQuery): Promise<Page<Call>>;
  denials(limit?: number): Promise<Denial[]>;
  batches(): Promise<Batch[]>;
  batch(id: string): Promise<BatchDetail>;
  settle(): Promise<SettlementResult>;
  nettingPreview(): Promise<NettingPreview>;
  ledger(q?: { account?: string; limit?: number }): Promise<LedgerEntry[]>;
  trialBalance(): Promise<TrialBalance>;
  receiptProof(callId: string): Promise<ReceiptProof>;
  eventsUrl(): string | null;
  /** In-process event source (mock mode). Live nodes use `eventsUrl` with EventSource instead. */
  subscribe?(listener: (e: NodeEvent) => void): () => void;
  /** Mock mode only: stands in for an on-chain approve so the wallet panel can be demoed. */
  mockApprove?(mandateId: string, amount: string): Promise<void>;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Accepts either a bare array or an `{ items }` / `{ <key>: [] }` envelope, since list envelopes are not pinned in the SPEC. */
function listOf<T extends z.ZodType>(item: T, key: string) {
  return z.union([
    z.array(item),
    z.object({ items: z.array(item) }).transform((o) => o.items),
    z.object({ [key]: z.array(item) }).transform((o) => (o as Record<string, z.infer<T>[]>)[key]!),
  ]) as unknown as z.ZodType<z.infer<T>[]>;
}

/** Single-entity responses may be bare or wrapped as `{ <key>: entity }`. */
function oneOf<T extends z.ZodType>(item: T, key: string) {
  return z.union([item, z.object({ [key]: item }).transform((o) => (o as Record<string, z.infer<T>>)[key]!)]) as unknown as z.ZodType<
    z.infer<T>
  >;
}

export class HttpClearingApi implements ClearingApi {
  readonly mock = false;
  readonly nodeUrl: string;
  readonly gateway: GatewayApi;
  readonly operator: OperatorApi;
  readonly agents: AgentsApi;
  readonly role: Role;
  private readonly token: string;
  private readonly events: boolean;

  /**
   * `nodeUrl` is the dashboard's own `/api` path for a cookie session (token empty), or the same path with the
   * recovery key as the token. `events` is false when the actor cannot read the agent event stream.
   */
  constructor(nodeUrl: string, token: string, opts: { events?: boolean } = {}) {
    this.nodeUrl = nodeUrl;
    this.token = token;
    this.events = opts.events ?? true;
    this.role = roleOf(token);
    this.gateway = new HttpGatewayApi(nodeUrl, token);
    this.operator = new HttpOperatorApi(nodeUrl, token);
    this.agents = new HttpAgentsApi(nodeUrl, token);
  }

  private request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, okStatuses: number[] = []): Promise<T> {
    return requestJson(this.nodeUrl, path, schema, { ...init, token: this.token }, okStatuses);
  }

  health() {
    // 503 still carries the health body (ok: false), which is exactly what the console wants to show.
    return this.request("/healthz", healthSchema, {}, [503]);
  }
  info() {
    return this.request("/v1/info", infoSchema);
  }
  overview() {
    return this.request("/v1/overview", overviewSchema);
  }
  mandates() {
    return this.request("/v1/mandates", listOf(mandateSchema, "mandates"));
  }
  mandate(id: string) {
    return this.request(`/v1/mandates/${id}`, oneOf(mandateDetailSchema, "mandate"));
  }
  createMandate(body: CreateMandateBody) {
    return this.request("/v1/mandates", oneOf(mandateSchema, "mandate"), { method: "POST", body: JSON.stringify(body) });
  }
  revokeMandate(id: string) {
    return this.request(`/v1/mandates/${id}/revoke`, revokeResultSchema, { method: "POST", body: "{}" });
  }
  providerCatalog() {
    return this.request("/v1/providers", listOf(providerSchema, "providers"));
  }

  async providers() {
    const list = await this.request("/v1/providers", listOf(providerSchema, "providers"));
    // The public catalog has no revenue; the admin detail route does. A node clears a handful of providers, so fan out.
    const details = await Promise.all(list.map((p) => this.provider(p.id).catch(() => null)));
    return list.map((p, i) => ({ ...p, revenue: details[i]?.revenue ?? p.revenue, callsTotal: details[i]?.callsTotal ?? p.callsTotal }));
  }
  provider(id: string) {
    return this.request(`/v1/providers/${id}`, oneOf(providerSchema, "provider"));
  }
  createProvider(body: CreateProviderBody) {
    return this.request("/v1/providers", providerCreatedSchema, { method: "POST", body: JSON.stringify(body) });
  }
  calls(q: CallsQuery = {}) {
    return this.request(`/v1/calls${qs(q)}`, pageSchema(callSchema));
  }
  denials(limit = 100) {
    return this.request(`/v1/denials${qs({ limit })}`, listOf(denialSchema, "denials"));
  }
  batches() {
    return this.request("/v1/batches", listOf(batchSchema, "batches"));
  }
  batch(id: string) {
    return this.request(`/v1/batches/${id}`, oneOf(batchDetailSchema, "batch"));
  }
  settle() {
    return this.request("/v1/settlements", settlementResultSchema, { method: "POST", body: "{}" });
  }
  nettingPreview() {
    return this.request("/v1/netting/preview", nettingPreviewSchema);
  }
  ledger(q: { account?: string; limit?: number } = {}) {
    return this.request(`/v1/ledger${qs(q)}`, listOf(ledgerEntrySchema, "entries"));
  }
  trialBalance() {
    return this.request("/v1/ledger/trial-balance", trialBalanceSchema);
  }
  receiptProof(callId: string) {
    return this.request(`/v1/receipts/${callId}/proof`, proofSchema);
  }
  eventsUrl() {
    if (!this.events) return null;
    return `${this.nodeUrl}/v1/events${qs({ token: this.token || undefined })}`;
  }
}

export type Credential = { recoveryKey?: string | null; events?: boolean };

/**
 * The console client. Every call goes through the dashboard's own `/api` path (proxy.ts) with the session cookie, or
 * with the recovery key as a bearer token on that same path.
 */
export async function createApi(cred: Credential = {}): Promise<ClearingApi> {
  if (MOCK_MODE) {
    const { MockClearingApi } = await import("./mock/server");
    return new MockClearingApi();
  }
  return new HttpClearingApi(API_BASE, cred.recoveryKey ?? "", { events: cred.events });
}

/** The dashboard reaches the server through its own origin (PRODUCT.md section 10.1). */
export const API_BASE = "/api";
/** Shown on Settings: where the dashboard forwards `/api` to. */
export const SERVER_URL = NODE_URL;
