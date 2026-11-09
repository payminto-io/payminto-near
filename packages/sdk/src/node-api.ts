import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";

// Schemas for everything the SDK reads from a clearing node or provider: both are trust boundaries.

export const zAddress = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "address")
  .transform((v) => getAddress(v) as Address);
export const zHex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).transform((v) => v as Hex);
export const zBytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);
export const zUint = z.string().regex(/^\d{1,78}$/);

export const positionSchema = z.object({ mandateId: zBytes32, payee: zAddress, cumulative: zUint, settled: zUint });
export type Position = z.infer<typeof positionSchema>;

export const clearingReceiptSchema = z.object({
  callId: zBytes32,
  mandateId: zBytes32,
  payee: zAddress,
  amount: zUint,
  cumulative: zUint,
  requestHash: zBytes32,
  timestamp: z.number().int().nonnegative(),
  leaf: zBytes32,
  nodeSignature: zHex,
  node: zAddress,
});

export const paymentResponseSchema = z.object({ receipt: clearingReceiptSchema, position: positionSchema });

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

export const paymentRequirementSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: zAddress,
  payTo: zAddress,
  amount: zUint,
  resource: z.string(),
  description: z.string(),
  mimeType: z.string().optional(),
  maxTimeoutSeconds: z.number(),
  extra: z.object({
    clearingNode: z.string(),
    clearingHub: zAddress,
    providerId: z.string(),
    tokenSymbol: z.string(),
    tokenDecimals: z.number(),
  }),
});
export const paymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  error: z.unknown().optional(),
  accepts: z.array(z.unknown()),
});

export const cosignItemSchema = z.object({
  hspPaymentId: zBytes32,
  batchId: zBytes32,
  payer: zAddress,
  recipient: zAddress,
  token: zAddress,
  amount: zUint,
  deadline: z.number(),
  calls: z.array(z.object({ callId: zBytes32, mandateId: zBytes32, payee: zAddress, amount: zUint, cumulative: zUint })),
  typedData: z.object({
    domain: z.object({ name: z.literal("HSP"), version: z.literal("1"), chainId: z.number(), verifyingContract: zAddress }),
    primaryType: z.literal("Mandate"),
    types: z.unknown(),
    message: z.object({
      nonce: zBytes32,
      signer: z.object({ profileId: zBytes32, payload: zHex }),
      grantRef: zBytes32,
      requirementRef: zBytes32,
      recipient: z.object({ kind: z.number().int(), payload: zHex }),
      token: zAddress,
      amount: zUint,
      chainId: zUint,
      deadline: zUint,
      settlementBinding: zBytes32,
      requiredCapabilitiesHash: zBytes32,
    }),
  }),
});
export type CosignItem = z.infer<typeof cosignItemSchema>;

export const infoSchema = z
  .object({
    version: z.string(),
    network: z.object({ chainId: z.number(), caip2: z.string() }).loose(),
    hub: zAddress,
    token: z.object({ address: zAddress, symbol: z.string(), decimals: z.number() }),
    operator: zAddress,
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
      payee: zAddress,
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
  /** The node's message without the code prefix. */
  readonly reason: string;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "NodeApiError";
    this.reason = message;
    this.status = status;
    this.code = code;
    this.details = details;
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
      if (e.success) throw new NodeApiError(res.status, e.data.error.code, e.data.error.message, e.data.error.details);
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
