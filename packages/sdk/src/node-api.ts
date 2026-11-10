import { z } from "zod";
import {
  clearingReceiptSchema,
  positionSchema,
  refusalSchema,
  zAccountId,
  zAtomic,
  zId32 as zId32Protocol,
  zNetwork as zNetworkProtocol,
  zPublicKey as zPublicKeyProtocol,
  zSig64,
  type Refusal,
} from "@payminto/protocol";

// Schemas for everything the SDK reads from a clearing node or provider: both are trust boundaries. The x402 and
// receipt schemas live in @payminto/protocol (x402.ts); these names stay for the SDK's own modules.

export const zAccount = zAccountId;
export const zId32 = zId32Protocol;
export const zSig = zSig64;
export const zPublicKey = zPublicKeyProtocol;
export const zNetwork = zNetworkProtocol;
export const zUint = zAtomic;

export { clearingReceiptSchema, positionSchema, refusalSchema };
export type Position = z.infer<typeof positionSchema>;

/** What the node answers to `POST /v1/vouchers`. */
export const paymentResponseSchema = z.object({ receipt: clearingReceiptSchema, position: positionSchema });

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
  // A malformed refusal must not hide the error code next to it.
  refusal: refusalSchema.optional().catch(undefined),
});

export const infoSchema = z
  .object({
    version: z.string(),
    network: z.object({ id: zNetwork, name: z.string() }).loose(),
    hub: zAccount,
    token: z.object({ address: zAccount, symbol: z.string(), decimals: z.number() }),
    operator: zAccount,
    nodeKey: zPublicKey,
    publicUrl: z.string(),
  })
  .loose();
export type NodeInfo = z.infer<typeof infoSchema>;

export const providerCatalogSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      payee: zAccount,
      priceAtomic: zUint,
      resource: z.string(),
      category: z.string(),
    })
    .loose(),
);

/** Error returned by a clearing node, with its HTTP status and machine-readable code. */
export class NodeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  /** The machine-readable refusal, when the node refused a voucher. */
  readonly refusal: Refusal | undefined;
  /** The node's message without the code prefix. */
  readonly reason: string;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>, refusal?: Refusal) {
    super(`${code}: ${message}`);
    this.name = "NodeApiError";
    this.reason = message;
    this.status = status;
    this.code = code;
    this.details = details;
    this.refusal = refusal;
  }
}

/** Small JSON client for a clearing node. */
export class NodeHttp {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;

  constructor(baseUrl: string, opts: { fetch?: typeof fetch; bearer?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#token = opts.bearer;
  }

  async request<T extends z.ZodType>(method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    const res = await this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new NodeApiError(res.status, "BAD_RESPONSE", `node returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const e = errorSchema.safeParse(json);
      if (e.success) throw new NodeApiError(res.status, e.data.error.code, e.data.error.message, e.data.error.details, e.data.refusal as Refusal | undefined);
      throw new NodeApiError(res.status, "HTTP_ERROR", `HTTP ${res.status}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new NodeApiError(res.status, "BAD_RESPONSE", `unexpected response shape for ${method} ${path}`);
    return parsed.data;
  }

  get<T extends z.ZodType>(path: string, schema: T) {
    return this.request("GET", path, schema);
  }
  post<T extends z.ZodType>(path: string, schema: T, body: unknown) {
    return this.request("POST", path, schema, body);
  }
}
