/**
 * Typed client for the Clearing Node API (docs/SPEC.md 5.6).
 * One instance per signed-in session. In mock mode (NEXT_PUBLIC_MOCK=1) the same interface is served by
 * an in-memory node so every screen can be built and demoed without a backend.
 */
import { z } from "zod";
import type { AccountId, BudgetTermsJson, Network, Policy } from "@payminto/protocol";
import type { Verdict } from "@payminto/payee-check";
import { liveReader, type ReaderSource } from "./near-reader";
import {
  batchDetailSchema,
  batchSchema,
  callSchema,
  denialSchema,
  healthSchema,
  infoSchema,
  ledgerEntrySchema,
  budgetDetailSchema,
  budgetSchema,
  nettingPreviewSchema,
  overviewSchema,
  pageSchema,
  payeeApprovalSchema,
  payeeApprovalsSchema,
  payeeReportFiledSchema,
  payeeReportsSchema,
  payeeVerdictSchema,
  proofSchema,
  payoutsSchema,
  payoutRunSchema,
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
  type BudgetDetail,
  type BudgetRecord,
  type NettingPreview,
  type Overview,
  type PayeeApproval,
  type PayeeApprovals,
  type PayeeReportFiled,
  type PayeeReports,
  type Provider,
  type ReceiptProof,
  type Payouts,
  type PayoutRun,
  type RevokeResult,
  type SettlementResult,
  type TrialBalance,
  type NodeEvent,
} from "./schemas";
import { MOCK_MODE, NODE_URL } from "./config";
import { ApiError, isSameOrigin, requestJson } from "./http";
import { HttpGatewayApi, type GatewayApi, type WebhookApi } from "./gateway-api";
import { HttpOperatorApi, type OperatorApi } from "./operator-api";
import { HttpAgentsApi, type AgentsApi } from "./agents-api";
import { roleOf, type Role } from "./merchant-scope";

export { ApiError };

export type CreateBudgetBody = {
  budget: BudgetTermsJson;
  policy: Policy;
  label: string;
};

export type CreateProviderBody = {
  name: string;
  description: string;
  payee: AccountId;
  priceAtomic: string;
  resource: string;
  category: string;
};

/** An owner's decision about a Payee. `overrideBlock` is sent only after the node answered 409 PAYEE_BLOCKED. */
export type PayeeDecisionBody = { payee: AccountId; decision: "approve" | "deny"; note?: string | null; overrideBlock?: boolean };
/** A report. It never names a reporter: the node files it in the name of its own operator account. */
export type PayeeReportBody = { account: AccountId; reason: string; evidence: string };

export type CallsQuery = { budgetId?: string; payee?: string; status?: string; limit?: number; cursor?: string };
export type Page<T> = { items: T[]; nextCursor?: string | null };

export interface ClearingApi {
  readonly nodeUrl: string;
  readonly mock: boolean;
  /** Merchant gateway routes (docs/GATEWAY.md section 8) on the same node and token. */
  readonly gateway: GatewayApi;
  /** The platform's own webhook endpoints, which receive `budget.refused` for every refusal on this server. */
  readonly platformWebhooks: WebhookApi;
  /** Operator routes (admin token): merchants, fee plans, platform. */
  readonly operator: OperatorApi;
  /** Merchant AI agents (docs/AGENTS.md section 6): AI connections, agents and runs of the open business. */
  readonly agents: AgentsApi;
  /** "merchant" when signed in with a merchant secret key, which sees only its own gateway data. */
  readonly role: Role;
  health(): Promise<Health>;
  info(): Promise<Info>;
  overview(): Promise<Overview>;
  budgets(): Promise<BudgetRecord[]>;
  budget(id: string): Promise<BudgetDetail>;
  createBudget(body: CreateBudgetBody): Promise<BudgetRecord>;
  revokeBudget(id: string): Promise<RevokeResult>;
  /**
   * The node's payee check of one account (`GET /v1/payees/check`), judged for a Budget when one is given. Rejects with
   * 409 PAYEE_CHECK_OFF when the node has the check off, and with 404 on a node that predates it.
   */
  checkPayee(account: string, budgetId?: string): Promise<Verdict>;
  /** The owner's decisions for a Budget and the Calls that wait for one (`GET /v1/budgets/:id/payee-approvals`). */
  payeeApprovals(budgetId: string): Promise<PayeeApprovals>;
  /** Approves or denies a Payee for a Budget. 409 PAYEE_BLOCKED: the check blocks it and `overrideBlock` was not sent. */
  decidePayee(budgetId: string, body: PayeeDecisionBody): Promise<PayeeApproval>;
  /** Withdraws a decision, so the Payee is judged by the check alone again. Resolves with the decision it removed. */
  withdrawPayeeDecision(budgetId: string, payee: AccountId): Promise<PayeeApproval>;
  /** Reports against one account (`GET /v1/payees/reports?account=`). */
  payeeReports(account: AccountId): Promise<PayeeReports>;
  /** Files a report in the name of the node's operator account (`POST /v1/payees/reports`). */
  reportPayee(body: PayeeReportBody): Promise<PayeeReportFiled>;
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
  /** The NEAR reader proofs are checked with in this browser: the configured RPC, or the demo hub in mock mode. */
  nearReader(info: Info): ReaderSource | null;
  /** Hub credit per creditor and recent payouts. */
  payouts(): Promise<Payouts>;
  /** Pays out every due creditor now (`POST /v1/payouts`); anyone may call `payout` on the hub, this asks the node to. */
  runPayouts(): Promise<PayoutRun>;
  /** Decision 9: gross per counterparty next to net, for books, as CSV (`GET /v1/settlements/export`). */
  settlementExportCsv(range: { from?: string; to?: string; account?: string }): Promise<string>;
  eventsUrl(): string | null;
  /** In-process event source (mock mode). Live nodes use `eventsUrl` with EventSource instead. */
  subscribe?(listener: (e: NodeEvent) => void): () => void;
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
  readonly platformWebhooks: WebhookApi;
  readonly operator: OperatorApi;
  readonly agents: AgentsApi;
  readonly role: Role;
  private readonly token: string;
  private readonly events: boolean;
  private readonly readers: Map<string, ReaderSource | null>;

  nearReader(info: Info): ReaderSource | null {
    const key = `${info.network.id} ${info.hub} ${info.network.rpc_url ?? ""}`;
    if (!this.readers.has(key)) this.readers.set(key, liveReader(info.network.id as Network, info.hub, info.network.rpc_url));
    return this.readers.get(key) ?? null;
  }

  /**
   * `nodeUrl` is the dashboard's own `/api` path for a cookie session (token empty), or the same path with the
   * recovery key as the token. `events` is false when the actor cannot read the agent event stream.
   */
  constructor(nodeUrl: string, token: string, opts: { events?: boolean } = {}) {
    this.nodeUrl = nodeUrl;
    this.readers = new Map();
    this.token = token;
    this.events = opts.events ?? true;
    this.role = roleOf(token);
    this.gateway = new HttpGatewayApi(nodeUrl, token);
    this.platformWebhooks = new HttpGatewayApi(nodeUrl, token, "platform");
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
  budgets() {
    return this.request("/v1/budgets", listOf(budgetSchema, "budgets"));
  }
  budget(id: string) {
    return this.request(`/v1/budgets/${id}`, oneOf(budgetDetailSchema, "budget"));
  }
  createBudget(body: CreateBudgetBody) {
    return this.request("/v1/budgets", oneOf(budgetSchema, "budget"), { method: "POST", body: JSON.stringify(body) });
  }
  revokeBudget(id: string) {
    return this.request(`/v1/budgets/${id}/revoke`, revokeResultSchema, { method: "POST", body: "{}" });
  }
  checkPayee(account: string, budgetId?: string) {
    return this.request(`/v1/payees/check${qs({ account, budget: budgetId })}`, payeeVerdictSchema);
  }
  payeeApprovals(budgetId: string) {
    return this.request(`/v1/budgets/${budgetId}/payee-approvals`, payeeApprovalsSchema);
  }
  decidePayee(budgetId: string, body: PayeeDecisionBody) {
    // The flag and the note are left out unless set: the node refuses unknown values, and an older one unknown fields.
    const sent = { payee: body.payee, decision: body.decision, ...(body.note ? { note: body.note } : {}), ...(body.overrideBlock ? { overrideBlock: true } : {}) };
    return this.request(`/v1/budgets/${budgetId}/payee-approvals`, z.object({ approval: payeeApprovalSchema }).transform((r) => r.approval), { method: "POST", body: JSON.stringify(sent) });
  }
  withdrawPayeeDecision(budgetId: string, payee: AccountId) {
    return this.request(`/v1/budgets/${budgetId}/payee-approvals/${encodeURIComponent(payee)}`, z.object({ approval: payeeApprovalSchema }).transform((r) => r.approval), { method: "DELETE" });
  }
  payeeReports(account: AccountId) {
    return this.request(`/v1/payees/reports${qs({ account })}`, payeeReportsSchema);
  }
  reportPayee(body: PayeeReportBody) {
    return this.request("/v1/payees/reports", payeeReportFiledSchema, { method: "POST", body: JSON.stringify({ account: body.account, reason: body.reason, evidence: body.evidence }) });
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
  payouts() {
    return this.request("/v1/payouts", payoutsSchema);
  }
  runPayouts() {
    return this.request("/v1/payouts", payoutRunSchema, { method: "POST", body: "{}" });
  }
  async settlementExportCsv(range: { from?: string; to?: string; account?: string }) {
    let res: Response;
    try {
      res = await fetch(`${this.nodeUrl}/v1/settlements/export${qs({ ...range, format: "csv" })}`, {
        headers: { Accept: "text/csv", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        ...(isSameOrigin(this.nodeUrl) ? { credentials: "same-origin" as const } : {}),
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "NODE_UNREACHABLE", "Cannot reach the Payminto server. Check that it is running.");
    }
    const text = await res.text();
    if (res.ok) return text;
    let error: { code?: string; message?: string } | undefined;
    try {
      error = (JSON.parse(text) as { error?: typeof error }).error;
    } catch {
      // Not the node's JSON error.
    }
    throw new ApiError(res.status, error?.code ?? "HTTP_ERROR", error?.message ?? `The export could not be made (status ${res.status}).`);
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
    const [{ MockClearingApi }, { installMockWallet }] = await Promise.all([import("./mock/server"), import("./mock/install-wallet")]);
    installMockWallet();
    return new MockClearingApi();
  }
  return new HttpClearingApi(API_BASE, cred.recoveryKey ?? "", { events: cred.events });
}

/** The dashboard reaches the server through its own origin (PRODUCT.md section 10.1). */
export const API_BASE = "/api";
/** Shown on Settings: where the dashboard forwards `/api` to. */
export const SERVER_URL = NODE_URL;
