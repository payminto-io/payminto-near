import type { MiddlewareHandler } from "hono";
import {
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  nodeVoucherBody,
  parsePaymentSignature,
  sameRequirement,
  SCHEME,
  voucherSignedBy,
  vouchersOf,
  X402_VERSION,
  type AccountId,
  type ClearingReceipt,
  type Network,
  type PaymentRequired,
  type Refusal,
  type ResourceInfo,
  type SettlementFailure,
  type SettlementSuccess,
  type VoucherRequirement,
} from "@payminto/protocol";
import { errorSchema, infoSchema, NodeApiError, NodeHttp, paymentResponseSchema, providerCatalogSchema, type Position } from "./node-api.ts";
import { computeRequestHash } from "./util.ts";
import { acceptanceCovers, exportVouchers, MemoryVoucherStore, type StoredVoucher, type VoucherExport, type VoucherStore } from "./voucher-store.ts";

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
  /**
   * Where the latest accepted voucher per Budget is kept for `settle_own` (spec decision 4), with the node's acceptance
   * of it, which `settle_own` requires. Defaults to memory; pass a FileVoucherStore so the vouchers survive a restart.
   */
  vouchers?: VoucherStore;
  /**
   * Called when a voucher the node accepted could not be stored, or came with an acceptance that does not verify and
   * so could not be settled with `settle_own`. The call is still served: the node accepted it.
   */
  onError?: (err: Error) => void;
  fetch?: typeof fetch;
};

export type PaidContext = { receipt: ClearingReceipt; position: Position; voucher: StoredVoucher };

export type PaywallCheck = { ok: true; paid: PaidContext; responseHeader: string } | { ok: false; response: Response };

type Setup = { requirement: VoucherRequirement; network: Network; hub: AccountId; nodeKey: string; provider: { id: string; priceAtomic: string }; description: string };

type ErrorBody = { code: string; message: string; details?: Record<string, unknown> };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Seller side: answers unpaid requests with an x402 v2 402, checks the voucher an agent sends (version, requirement,
 * request hash and signature), forwards it to the clearing node, keeps the latest accepted voucher per Budget for
 * `settle_own` together with the node's acceptance, and serves only after the node accepted the call.
 * Framework-agnostic `wrap()` plus a Hono middleware.
 *
 * A header that cannot be read, or that is not x402 version 2, is a 400, as at the node's own gateway. A readable
 * payment that fails the schema or a check is a failed payment: 402 with `PAYMENT-RESPONSE`, so the agent learns why.
 */
export function paywall(o: PaywallOptions) {
  const node = new NodeHttp(o.nodeUrl, { fetch: o.fetch, bearer: o.apiKey });
  const publicNode = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
  const store: VoucherStore = o.vouchers ?? new MemoryVoucherStore();
  const report = o.onError ?? ((err: Error) => console.error(`[payminto paywall] ${err.message}`));
  let setup: Promise<Setup> | null = null;

  const load = (): Promise<Setup> => {
    setup ??= (async () => {
      const [info, catalog] = await Promise.all([publicNode.get("/v1/info", infoSchema), publicNode.get("/v1/providers", providerCatalogSchema)]);
      const p = catalog.find((x) => x.id === o.providerId);
      if (!p) throw new Error(`provider ${o.providerId} is not registered at ${o.nodeUrl}`);
      if (o.price !== undefined && BigInt(o.price) !== BigInt(p.priceAtomic)) {
        throw new Error(`paywall price ${o.price} differs from the registered price ${p.priceAtomic} of ${o.providerId}`);
      }
      const requirement: VoucherRequirement = {
        scheme: SCHEME,
        network: info.network.id,
        amount: p.priceAtomic,
        asset: info.token.address,
        payTo: p.payee,
        maxTimeoutSeconds: o.maxTimeoutSeconds ?? 60,
        extra: {
          clearingHub: info.hub,
          clearingNode: (o.publicNodeUrl ?? info.publicUrl).replace(/\/+$/, ""),
          providerId: p.id,
          tokenSymbol: info.token.symbol,
          tokenDecimals: info.token.decimals,
        },
      };
      return { requirement, network: info.network.id, hub: info.hub, nodeKey: info.nodeKey, provider: { id: p.id, priceAtomic: p.priceAtomic }, description: o.description ?? p.description };
    })();
    setup.catch(() => {
      setup = null; // retry on the next request
    });
    return setup;
  };

  const resourceOf = (s: Setup, url: string): ResourceInfo => ({ url, description: s.description, ...(o.mimeType ? { mimeType: o.mimeType } : {}) });

  /**
   * A 402. `PAYMENT-REQUIRED` always carries the offer (with the error code once a payment was tried). A refused payment
   * also carries a `PAYMENT-RESPONSE` with `success: false`, the rule in `errorReason` and the machine-readable refusal.
   */
  const required = (s: Setup, url: string, error: ErrorBody, refusal?: Refusal, payer?: string) => {
    const pr: PaymentRequired = { x402Version: X402_VERSION, ...(error.code === "PAYMENT_REQUIRED" ? {} : { error: error.code }), resource: resourceOf(s, url), accepts: [s.requirement] };
    const headers: Record<string, string> = { [HEADER_REQUIRED]: encodeHeader(pr) };
    if (error.code === "PAYMENT_REQUIRED") return json(402, { ...pr, error }, headers);
    const failure: SettlementFailure = {
      success: false,
      errorReason: error.code,
      transaction: "",
      network: s.network,
      ...(payer ? { payer: payer as SettlementFailure["payer"] } : {}),
      ...(refusal ? { refusal } : {}),
    };
    headers[HEADER_RESPONSE] = encodeHeader(failure);
    return json(402, { ...pr, success: false, errorReason: error.code, error, ...(refusal ? { refusal } : {}) }, headers);
  };

  async function check(request: Request): Promise<PaywallCheck> {
    let s: Setup;
    try {
      s = await load();
    } catch (err) {
      return { ok: false, response: json(503, { error: { code: "CLEARING_UNAVAILABLE", message: err instanceof Error ? err.message : "clearing node unavailable" } }) };
    }
    const url = request.url;
    const header = request.headers.get(HEADER_SIGNATURE);
    if (!header) return { ok: false, response: required(s, url, { code: "PAYMENT_REQUIRED", message: `pay with ${SCHEME}` }) };

    const parsed = parsePaymentSignature(header);
    if (!parsed.ok) {
      // The same answers as the node gateway (apps/node/src/gateway/x402-wire.ts). A wrong version or an unreadable
      // header is a bad request, not a payment: 400 with no payment headers. A readable payment that fails the schema
      // is a failed payment: 402.
      if (parsed.code === "UNSUPPORTED_VERSION") return { ok: false, response: json(400, { error: { code: "UNSUPPORTED_X402_VERSION", message: parsed.message } }) };
      if (parsed.code === "INVALID") return { ok: false, response: required(s, url, { code: "INVALID_PAYMENT", message: parsed.message }) };
      return { ok: false, response: json(400, { error: { code: "INVALID_PAYMENT", message: parsed.message } }) };
    }
    const payment = parsed.value;
    if (!sameRequirement(payment.accepted, s.requirement)) {
      return { ok: false, response: required(s, url, { code: "REQUIREMENT_MISMATCH", message: "the accepted requirement is not the one this seller offers" }) };
    }
    const [v] = vouchersOf(payment);
    const voucher = v!;
    const body = request.body ? new Uint8Array(await request.clone().arrayBuffer()) : undefined;
    const requestHash = computeRequestHash(request.method, url, body);
    if (voucher.requestHash !== requestHash) {
      return { ok: false, response: required(s, url, { code: "REQUEST_HASH_MISMATCH", message: "voucher requestHash does not match this request" }, undefined, voucher.publicKey) };
    }
    if (!voucherSignedBy(s.hub, s.network, voucher)) {
      return { ok: false, response: required(s, url, { code: "BAD_SIGNATURE", message: "the voucher signature does not verify against payload.publicKey" }, undefined, voucher.publicKey) };
    }

    let paid: { receipt: ClearingReceipt; position: Position };
    try {
      paid = await node.post("/v1/vouchers", paymentResponseSchema, { ...nodeVoucherBody(s.network, voucher), providerId: s.provider.id, requestHash });
    } catch (err) {
      if (err instanceof NodeApiError && err.status === 402) {
        const error = { code: err.code, message: err.reason, ...(err.details ? { details: err.details } : {}) };
        return { ok: false, response: required(s, url, error, err.refusal, voucher.publicKey) };
      }
      const status = err instanceof NodeApiError && err.status < 500 ? 400 : 502;
      const code = err instanceof NodeApiError ? err.code : "CLEARING_UNAVAILABLE";
      return { ok: false, response: json(status, { error: { code, message: err instanceof Error ? err.message : "clearing failed" } }) };
    }
    const r = paid.receipt;
    if (r.budgetId !== voucher.budgetId || r.payee !== voucher.payee || r.cumulative !== voucher.cumulative || r.voucherSig !== voucher.signature) {
      return { ok: false, response: json(502, { error: { code: "CLEARING_MISMATCH", message: "the clearing node answered with a receipt for another voucher" } }) };
    }

    // The receipt carries the node's acceptance of this call: the hub's settle_own takes the voucher only with it.
    const stored: StoredVoucher = {
      ...voucher,
      hub: s.hub,
      network: s.network,
      callId: r.callId,
      acceptedAt: new Date(r.timestamp * 1000).toISOString(),
      acceptance: { nodeKey: r.node, timestampS: String(r.timestamp), signature: r.nodeSignature },
    };
    if (!acceptanceCovers(stored)) {
      // Kept out of the store, so the latest voucher that can be settled is never replaced by one that cannot.
      report(new Error(`voucher ${r.callId} was accepted, but the node's acceptance does not verify for it, so it could not be settled with settle_own and was not stored`));
    } else {
      if (r.node !== s.nodeKey) report(new Error(`voucher ${r.callId} was accepted with key ${r.node}, not the node's published key ${s.nodeKey}; settle_own works only if the node registered that key on the hub`));
      try {
        store.put(stored);
      } catch (err) {
        report(new Error(`voucher ${r.callId} was accepted but not stored for settle_own: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    // An empty transaction means settlement is deferred to a later netted batch.
    const success: SettlementSuccess = { success: true, transaction: "", network: s.network, payer: voucher.publicKey, receipts: [r], positions: [paid.position] };
    return { ok: true, paid: { receipt: r, position: paid.position, voucher: stored }, responseHeader: encodeHeader(success) };
  }

  function withPaymentHeader(res: Response, header: string): Response {
    const headers = new Headers(res.headers);
    headers.set(HEADER_RESPONSE, header);
    headers.append("access-control-expose-headers", HEADER_RESPONSE);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  return {
    check,
    /** The latest accepted voucher per Budget with the node's acceptance, for `settle_own`. */
    vouchers: store,
    /** Exports the latest vouchers and their acceptances for this seller's hub, for its own wallet to call `settle_own` with. */
    async exportVouchers(payee?: AccountId): Promise<VoucherExport> {
      const s = await load();
      return exportVouchers(store, { hub: s.hub, network: s.network, ...(payee ? { payee } : {}) });
    },
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

/** Parses a seller's 402 denial body, if it is one. */
export function parseDenial(body: unknown): ErrorBody | null {
  const r = errorSchema.safeParse(body);
  return r.success ? r.data.error : null;
}
