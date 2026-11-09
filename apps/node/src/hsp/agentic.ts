import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { HSP_PAYMENT_STATUSES, type HspPaymentStatus } from "@payminto/protocol";
import { errMessage } from "./port.ts";

/**
 * Client for HashKey's HSP Agentic Payment MCP server (docs/GATEWAY.md section 17): Streamable HTTP, exactly eight
 * tools. Every tool result is validated with zod before the node acts on it, and every failure is an HspError whose
 * `kind` says what the caller should do (wait for the allowlist, prepare a new quote, retry later).
 * This is separate from the HSP port in port.ts, which attests netted clearing batches.
 */

export const HSP_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;
export type HspTool = (typeof HSP_TOOLS)[number];

/** HSP gateway error: the quote behind the signature expired; prepare again and sign the new data. */
export const HSP_ERROR_QUOTE_EXPIRED = 30043;

export type HspErrorKind =
  /** HTTP 401 or 403: our egress IP is not on HashKey's allowlist. */
  | "not_allowlisted"
  /** No answer (DNS, connection, timeout, 5xx). The outcome of a write is unknown: query before retrying. */
  | "unreachable"
  /** The quote expired (error 30043 or quote_expires_at passed): prepare again and get a new signature. */
  | "requote"
  /** The server lacks one of the eight tools. */
  | "tools_missing"
  /** A tool answered with an error. */
  | "tool_error"
  /** A tool answered with something that does not match the documented shape. */
  | "invalid_response";

export class HspError extends Error {
  readonly kind: HspErrorKind;
  /** HSP's numeric error code, when the tool reported one. */
  readonly code: number | null;
  readonly tool: HspTool | null;
  constructor(kind: HspErrorKind, message: string, o: { code?: number | null; tool?: HspTool | null } = {}) {
    super(message);
    this.name = "HspError";
    this.kind = kind;
    this.code = o.code ?? null;
    this.tool = o.tool ?? null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Result shapes. Loose: HSP may add fields; only what the node relies on is required.

const zAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a));
const zRaw = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => String(v));
const zChainId = z.union([z.number().int().positive(), z.string().regex(/^(eip155:)?\d+$/)]).transform((v) => Number(String(v).replace(/^eip155:/, "")));

const zToken = z
  .object({
    address: zAddr,
    decimals: z.number().int().min(0).max(36),
    payment_protocol: z.enum(["eip3009", "permit2"]),
    symbol: z.string().optional(),
  })
  .loose();

const zNetwork = z
  .object({
    network: z.string().min(1),
    chain_id: zChainId,
    tokens: z.array(zToken),
  })
  .loose();

/** get_chain_config: a list of networks, as a bare array or under `networks`/`chains`. */
const zChainConfig = z.union([
  z.array(zNetwork),
  z.object({ networks: z.array(zNetwork) }).loose().transform((o) => o.networks),
  z.object({ chains: z.array(zNetwork) }).loose().transform((o) => o.chains),
]);
export type HspNetwork = z.output<typeof zNetwork>;
export type HspToken = z.output<typeof zToken>;

const zOrder = z
  .object({
    flow_id: z.string().min(1),
    payment_request_id: z.string().min(1).nullish(),
    payment_url: z.string().nullish(),
  })
  .loose();
export type HspOrder = z.output<typeof zOrder>;

const zOrderInfo = z.object({ flow_id: z.string().min(1).optional(), gas_fee_advanced: z.boolean().optional() }).loose();
export type HspOrderInfo = z.output<typeof zOrderInfo>;

const zTime = z.union([z.string().min(1), z.number()]).transform((v, ctx) => {
  const ms = typeof v === "number" ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: "custom", message: "not a time" });
    return z.NEVER;
  }
  return Math.floor(ms / 1000);
});

const zEip712 = z
  .object({
    domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    primaryType: z.string().min(1),
    message: z.record(z.string(), z.unknown()),
  })
  .loose();
export type HspEip712 = z.output<typeof zEip712>;

const zPrepared = z
  .object({
    eip712: zEip712,
    cart_hash: z.string().min(1),
    token_total_raw: zRaw,
    pay_to: zAddr,
    payer: zAddr,
    payment_request_id: z.string().nullish(),
    payment_payload: z.unknown(),
    payment_mandate_contents: z.unknown(),
    quote_expires_at: zTime,
  })
  .loose();
/** prepare_payment, with quote_expires_at as unix seconds. */
export type HspPrepared = z.output<typeof zPrepared>;

const zFinalized = z.object({ payment_mandate_json: z.unknown().refine((v) => v !== undefined && v !== null, "missing") }).loose();

const zSubmitted = z.object({ status: z.string().min(1) }).loose();

const zStatus = z.enum(HSP_PAYMENT_STATUSES);
const zQuery = z
  .object({
    status: z.string().optional(),
    payment: z
      .object({
        status: z.string().optional(),
        status_reason: z.string().nullish(),
        tx_signature: z.string().nullish(),
      })
      .loose()
      .nullish(),
    attribution_verified: z.boolean().optional(),
    gas_fee_advanced: z.boolean().optional(),
  })
  .loose();

export type HspPaymentQuery = {
  status: HspPaymentStatus;
  statusReason: string | null;
  txHash: Hex | null;
  attributionVerified: boolean;
  gasFeeAdvanced: boolean | null;
};

/** The eight tools, behind one seam: the MCP client in production, a stand-in in tests. */
export interface HspAgenticClient {
  /** GET /health; throws HspError (not_allowlisted on 401/403, unreachable otherwise). */
  health(): Promise<void>;
  /** Connects and checks the server offers all eight tools (HspError tools_missing otherwise). */
  tools(): Promise<Array<{ name: string; inputSchema: unknown }>>;
  getChainConfig(): Promise<HspNetwork[]>;
  createOrder(a: { merchantName: string; payTo: Address; cartMandate: Record<string, unknown> }): Promise<HspOrder>;
  getOrder(a: { flowId: string }): Promise<HspOrderInfo>;
  preparePayment(a: { flowId: string; payer: Address; protocol: string }): Promise<HspPrepared>;
  finalizePayment(a: { signature: Hex; paymentPayload: unknown; paymentMandateContents: unknown; cartHash: string }): Promise<{ paymentMandateJson: unknown }>;
  estimateFee(a: Record<string, unknown>): Promise<unknown>;
  submitPayment(a: { paymentMandateJson: unknown }): Promise<{ status: string }>;
  queryPayment(a: { flowId: string; expectedMerchantName: string }): Promise<HspPaymentQuery>;
  close(): Promise<void>;
}

type ToolResult = { content?: unknown; structuredContent?: unknown; isError?: boolean };

/** What a tool returned: structuredContent, else the JSON (or plain text) of its first text block. */
export function toolPayload(r: ToolResult): unknown {
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
  const text = Array.isArray(r.content) ? r.content.find((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && c.type === "text") : undefined;
  if (!text) return null;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

/** HSP's numeric error code in a tool error: `code`, `error.code`, `error_code`, or a five-digit number in the text. */
export function hspErrorCode(payload: unknown): number | null {
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    const err = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : null;
    for (const v of [o.code, o.error_code, err?.code]) {
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
      if (Number.isInteger(n)) return n;
    }
  }
  const m = /\b(\d{5})\b/.exec(typeof payload === "string" ? payload : JSON.stringify(payload ?? ""));
  return m ? Number(m[1]) : null;
}

function errorText(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 300);
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    const err = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : null;
    const msg = o.message ?? err?.message ?? o.error;
    if (typeof msg === "string") return msg.slice(0, 300);
  }
  return JSON.stringify(payload ?? null).slice(0, 300);
}

/** Maps a transport failure: 401/403 is the allowlist, everything else is "no answer". */
export function transportError(err: unknown, tool: HspTool | null = null): HspError {
  if (err instanceof HspError) return err;
  const status = err instanceof StreamableHTTPError ? err.code : null;
  if (status === 401 || status === 403 || (err instanceof Error && err.name === "UnauthorizedError")) {
    return new HspError("not_allowlisted", `HSP refused this server (HTTP ${status ?? 401}): its public IP is not on HashKey's allowlist`, { tool });
  }
  return new HspError("unreachable", `HSP did not answer${tool ? ` ${tool}` : ""}: ${errMessage(err)}`, { tool });
}

/**
 * The HSP Agentic Payment MCP client. Connects lazily, reconnects after a transport failure, and reads the live tool
 * list (and input schemas) on connect. It sends only the arguments HashKey's guide names; when a live input schema
 * requires an argument this client does not send, the call fails with a clear message instead of guessing.
 */
export class McpHspAgenticClient implements HspAgenticClient {
  readonly url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #client: Promise<{ client: Client; schemas: Map<string, unknown> }> | null = null;

  constructor(o: { url: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.url = o.url;
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = o.timeoutMs ?? 30_000;
  }

  async health(): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(new URL("health", this.url.endsWith("/") ? this.url : `${this.url}/`), { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (err) {
      throw transportError(err);
    }
    if (res.status === 401 || res.status === 403) throw new HspError("not_allowlisted", `HSP health answered HTTP ${res.status}: this server's public IP is not on HashKey's allowlist`);
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    if (!res.ok || body?.status !== "ok") throw new HspError("unreachable", `HSP health answered HTTP ${res.status}`);
  }

  #connect() {
    this.#client ??= (async () => {
      const client = new Client({ name: "payminto-node", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), { fetch: this.#fetch });
      try {
        await client.connect(transport, { timeout: this.#timeoutMs });
        const { tools } = await client.listTools(undefined, { timeout: this.#timeoutMs });
        const missing = HSP_TOOLS.filter((t) => !tools.some((x) => x.name === t));
        if (missing.length) throw new HspError("tools_missing", `HSP server lacks ${missing.join(", ")}`);
        return { client, schemas: new Map(tools.map((t) => [t.name, t.inputSchema])) };
      } catch (err) {
        await client.close().catch(() => {});
        throw transportError(err);
      }
    })().catch((err) => {
      this.#client = null;
      throw err;
    });
    return this.#client;
  }

  async tools() {
    const { schemas } = await this.#connect();
    return [...schemas].map(([name, inputSchema]) => ({ name, inputSchema }));
  }

  async #call(tool: HspTool, args: Record<string, unknown>): Promise<unknown> {
    const { client, schemas } = await this.#connect();
    const required = ((schemas.get(tool) as { required?: unknown } | undefined)?.required ?? []) as unknown[];
    const missing = required.filter((k): k is string => typeof k === "string" && !(k in args));
    if (missing.length) throw new HspError("invalid_response", `HSP ${tool} now requires ${missing.join(", ")}, which this node does not send; update the HSP client`, { tool });
    let r: ToolResult;
    try {
      r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.#timeoutMs })) as ToolResult;
    } catch (err) {
      // The session may be gone; the next call reconnects.
      const c = this.#client;
      this.#client = null;
      void c?.then((x) => x.client.close()).catch(() => {});
      throw transportError(err, tool);
    }
    const payload = toolPayload(r);
    if (r.isError) {
      const code = hspErrorCode(payload);
      if (code === HSP_ERROR_QUOTE_EXPIRED) throw new HspError("requote", `HSP ${tool}: the quote expired (${code}); prepare the payment again`, { code, tool });
      throw new HspError("tool_error", `HSP ${tool} failed${code !== null ? ` (${code})` : ""}: ${errorText(payload)}`, { code, tool });
    }
    return payload;
  }

  async #parsed<S extends z.ZodType>(tool: HspTool, args: Record<string, unknown>, schema: S): Promise<z.output<S>> {
    const payload = await this.#call(tool, args);
    const out = schema.safeParse(payload);
    if (!out.success) throw new HspError("invalid_response", `HSP ${tool} returned an unexpected shape: ${z.prettifyError(out.error).slice(0, 300)}`, { tool });
    return out.data;
  }

  getChainConfig() {
    return this.#parsed("get_chain_config", {}, zChainConfig);
  }

  createOrder(a: { merchantName: string; payTo: Address; cartMandate: Record<string, unknown> }) {
    return this.#parsed("create_order", { merchant_name: a.merchantName, pay_to: a.payTo, cart_mandate: a.cartMandate }, zOrder);
  }

  getOrder(a: { flowId: string }) {
    return this.#parsed("get_order", { flow_id: a.flowId }, zOrderInfo);
  }

  preparePayment(a: { flowId: string; payer: Address; protocol: string }) {
    return this.#parsed("prepare_payment", { flow_id: a.flowId, payer: a.payer, protocol: a.protocol }, zPrepared);
  }

  async finalizePayment(a: { signature: Hex; paymentPayload: unknown; paymentMandateContents: unknown; cartHash: string }) {
    const out = await this.#parsed(
      "finalize_payment",
      { signature: a.signature, payment_payload: a.paymentPayload, payment_mandate_contents: a.paymentMandateContents, cart_hash: a.cartHash },
      zFinalized,
    );
    return { paymentMandateJson: out.payment_mandate_json };
  }

  estimateFee(a: Record<string, unknown>) {
    return this.#call("estimate_fee", a);
  }

  submitPayment(a: { paymentMandateJson: unknown }) {
    return this.#parsed("submit_payment", { payment_mandate_json: a.paymentMandateJson }, zSubmitted);
  }

  async queryPayment(a: { flowId: string; expectedMerchantName: string }): Promise<HspPaymentQuery> {
    const q = await this.#parsed("query_payment", { flow_id: a.flowId, expected_merchant_name: a.expectedMerchantName }, zQuery);
    const status = zStatus.safeParse(q.payment?.status ?? q.status);
    if (!status.success) throw new HspError("invalid_response", `HSP query_payment returned an unknown status ${JSON.stringify(q.payment?.status ?? q.status)}`, { tool: "query_payment" });
    const tx = q.payment?.tx_signature ?? null;
    return {
      status: status.data,
      statusReason: q.payment?.status_reason ?? null,
      txHash: tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as Hex) : null,
      attributionVerified: q.attribution_verified === true,
      gasFeeAdvanced: q.gas_fee_advanced ?? null,
    };
  }

  async close(): Promise<void> {
    const c = this.#client;
    this.#client = null;
    await c?.then((x) => x.client.close()).catch(() => {});
  }
}
