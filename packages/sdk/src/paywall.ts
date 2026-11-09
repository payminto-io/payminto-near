import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  decodeHeader,
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  SCHEME,
  X402_VERSION,
  type ClearingReceipt,
  type PaymentRequired,
  type PaymentRequirement,
} from "@payminto/protocol";
import { errorSchema, infoSchema, NodeApiError, NodeHttp, paymentResponseSchema, providerCatalogSchema, zAddress, zBytes32, zHex, zUint } from "./node-api.ts";
import { computeRequestHash } from "./util.ts";

export type PaywallOptions = {
  nodeUrl: string;
  providerId: string;
  apiKey: string;
  /** Expected price in atomic units; must equal the price registered at the node (that is what the node enforces). */
  price?: bigint | string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /** Clearing node URL advertised to agents; defaults to the node's PUBLIC_URL. */
  publicNodeUrl?: string;
  fetch?: typeof fetch;
};

export type PaidContext = { receipt: ClearingReceipt; position: { cumulative: string; settled: string } };

export type PaywallCheck = { ok: true; paid: PaidContext; responseHeader: string } | { ok: false; response: Response };

const voucherPaymentSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal(SCHEME),
  network: z.string(),
  payload: z.object({
    mandateId: zBytes32,
    payee: zAddress,
    amount: zUint,
    cumulative: zUint,
    signature: zHex,
    requestHash: zBytes32,
  }),
});

type Setup = { base: Omit<PaymentRequirement, "resource">; provider: { id: string; priceAtomic: string } };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Provider side: answers unpaid requests with an x402 402, forwards vouchers to the clearing node, and serves
 * only after the node accepted the call. Framework-agnostic `wrap()` plus a Hono middleware.
 */
export function paywall(o: PaywallOptions) {
  const node = new NodeHttp(o.nodeUrl, { fetch: o.fetch, bearer: o.apiKey });
  const publicNode = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
  let setup: Promise<Setup> | null = null;

  const load = (): Promise<Setup> => {
    setup ??= (async () => {
      const [info, catalog] = await Promise.all([publicNode.get("/v1/info", infoSchema), publicNode.get("/v1/providers", providerCatalogSchema)]);
      const p = catalog.find((x) => x.id === o.providerId);
      if (!p) throw new Error(`provider ${o.providerId} is not registered at ${o.nodeUrl}`);
      if (o.price !== undefined && BigInt(o.price) !== BigInt(p.priceAtomic)) {
        throw new Error(`paywall price ${o.price} differs from the registered price ${p.priceAtomic} of ${o.providerId}`);
      }
      const base: Omit<PaymentRequirement, "resource"> = {
        scheme: SCHEME,
        network: info.network.caip2 as `eip155:${number}`,
        asset: info.token.address,
        payTo: p.payee,
        amount: p.priceAtomic,
        description: o.description ?? p.description,
        ...(o.mimeType ? { mimeType: o.mimeType } : {}),
        maxTimeoutSeconds: o.maxTimeoutSeconds ?? 60,
        extra: {
          clearingNode: (o.publicNodeUrl ?? info.publicUrl).replace(/\/+$/, ""),
          clearingHub: info.hub,
          providerId: p.id,
          tokenSymbol: info.token.symbol,
          tokenDecimals: info.token.decimals,
        },
      };
      return { base, provider: { id: p.id, priceAtomic: p.priceAtomic } };
    })();
    setup.catch(() => {
      setup = null; // retry on the next request
    });
    return setup;
  };

  /** x402 PaymentRequired: the header carries the error code, the JSON body the full error object. */
  const required = (s: Setup, resource: string, error: { code: string; message: string; details?: Record<string, unknown> }) => {
    const pr: PaymentRequired = { x402Version: X402_VERSION, error: error.code, accepts: [{ ...s.base, resource }] };
    return json(402, { x402Version: X402_VERSION, error, accepts: pr.accepts }, { [HEADER_REQUIRED]: encodeHeader(pr) });
  };

  async function check(request: Request): Promise<PaywallCheck> {
    let s: Setup;
    try {
      s = await load();
    } catch (err) {
      return { ok: false, response: json(503, { error: { code: "CLEARING_UNAVAILABLE", message: err instanceof Error ? err.message : "clearing node unavailable" } }) };
    }
    const resource = request.url;
    const header = request.headers.get(HEADER_SIGNATURE);
    if (!header) {
      return { ok: false, response: required(s, resource, { code: "PAYMENT_REQUIRED", message: "pay with a payminto-voucher" }) };
    }
    const parsed = voucherPaymentSchema.safeParse(decodeHeader<unknown>(header));
    if (!parsed.success) {
      return { ok: false, response: required(s, resource, { code: "INVALID_PAYMENT", message: "PAYMENT-SIGNATURE is not a valid payminto-voucher payment" }) };
    }
    const payment = parsed.data;
    const bodyBytes = request.body ? new Uint8Array(await request.clone().arrayBuffer()) : undefined;
    const requestHash = computeRequestHash(request.method, request.url, bodyBytes);
    if (payment.payload.requestHash !== requestHash) {
      return { ok: false, response: required(s, resource, { code: "REQUEST_HASH_MISMATCH", message: "voucher requestHash does not match this request" }) };
    }
    try {
      const paid = await node.post("/v1/vouchers", paymentResponseSchema, { ...payment, providerId: s.provider.id, requestHash });
      return { ok: true, paid: paid as PaidContext, responseHeader: encodeHeader(paid) };
    } catch (err) {
      if (err instanceof NodeApiError && err.status === 402) {
        const error = { code: err.code, message: err.reason, ...(err.details ? { details: err.details } : {}) };
        return { ok: false, response: required(s, resource, error) };
      }
      const status = err instanceof NodeApiError && err.status < 500 ? 400 : 502;
      const code = err instanceof NodeApiError ? err.code : "CLEARING_UNAVAILABLE";
      return { ok: false, response: json(status, { error: { code, message: err instanceof Error ? err.message : "clearing failed" } }) };
    }
  }

  function withPaymentHeader(res: Response, header: string): Response {
    const headers = new Headers(res.headers);
    headers.set(HEADER_RESPONSE, header);
    headers.append("access-control-expose-headers", HEADER_RESPONSE);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  return {
    check,
    /** Wraps any fetch-style handler: `export default { fetch: pay.wrap(handler) }`. */
    wrap<A extends unknown[]>(handler: (req: Request, ...rest: A) => Response | Promise<Response>) {
      return async (req: Request, ...rest: A): Promise<Response> => {
        const r = await check(req);
        if (!r.ok) return r.response;
        return withPaymentHeader(await handler(req, ...rest), r.responseHeader);
      };
    },
    /** Hono middleware: `app.get("/quote", pay.hono(), handler)`. The receipt is available as c.get("payminto"). */
    hono(): MiddlewareHandler<{ Variables: { payminto: PaidContext } }> {
      return async (c, next) => {
        const r = await check(c.req.raw);
        if (!r.ok) return r.response;
        c.set("payminto", r.paid);
        await next();
        c.res = withPaymentHeader(c.res, r.responseHeader);
      };
    },
  };
}

export type Paywall = ReturnType<typeof paywall>;

/** Parses a provider 402 denial body, if it is one. */
export function parseDenial(body: unknown): { code: string; message: string; details?: Record<string, unknown> } | null {
  const r = errorSchema.safeParse(body);
  return r.success ? r.data.error : null;
}
