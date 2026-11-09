import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  explorerAddress,
  explorerTx,
  networkFor,
  SCHEME,
  X402_VERSION,
  type ClearingReceipt,
  type DenialRule,
} from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db/database.ts";
import { ApiError } from "./errors.ts";
import type { EventBus, NodeEvent } from "./events.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import type { MandateService } from "./mandates.ts";
import { databaseGauges, renderGauges, type Metrics } from "./metrics.ts";
import { clientIp, TokenBuckets, type TakeResult } from "./ratelimit.ts";
import { overview } from "./overview.ts";
import { receiptVerifiedOnchain } from "./proofs.ts";
import type { SettlementService } from "./settlement.ts";
import { batchSummaryJson, providerPublicJson, nowIso, type ProviderRow, type Store } from "./store.ts";
import type { VoucherService } from "./vouchers.ts";
import type { Gateway } from "./gateway/index.ts";
import { mountGateway } from "./gateway/routes.ts";
import { Access, auditActor, resolveActor, type AuthVars } from "./auth/actor.ts";
import { DEFAULT_AUTH_LIMITS, mountAuth } from "./auth/routes.ts";
import type { AuthService } from "./auth/service.ts";
import type { CustomerService } from "./gateway/customers.ts";
import { SEARCH_TYPES, type SearchService, type SearchType } from "./search.ts";
import { hashkeyLinks } from "@payminto/protocol";
import type { AgentsModule } from "./agents/index.ts";
import { mountAgents } from "./agents/routes.ts";

export const NODE_VERSION = "0.1.0";

export type NodeServices = {
  config: Config;
  db: Database;
  store: Store;
  chain: ChainClient;
  ledger: Ledger;
  events: EventBus;
  vouchers: VoucherService;
  mandates: MandateService;
  settlement: SettlementService;
  log: Logger;
  token: { address: Address; symbol: string; decimals: number };
  /** Called on shutdown to end open SSE streams. */
  sseClosers: Set<() => void>;
  metrics: Metrics;
  limiters: { provider: TokenBuckets; ip: TokenBuckets };
  /** Payminto Gateway, when enabled (GATEWAY_PAYOUT_ADDRESS or GATEWAY_ENABLED). */
  gateway?: Gateway | null;
  /** Accounts, sessions and permissions (docs/PRODUCT.md sections 4 and 10). */
  auth: AuthService;
  search: SearchService;
  customers: CustomerService | null;
  /** Merchant AI agents (docs/AGENTS.md), when the gateway is on and agents are enabled. */
  agents?: AgentsModule | null;
};

// ---------------------------------------------------------------------------
// Validation (zod at the trust boundary)
// ---------------------------------------------------------------------------

const zAddress = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
const zBytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex")
  .transform((v) => v.toLowerCase() as Hex);
const zHex = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex")
  .transform((v) => v as Hex);
// abort: refinements that call BigInt must not run on a string that failed the pattern (see gateway/http.ts).
const zUint = z.string().regex(/^(0|[1-9]\d{0,77})$/, { message: "must be a decimal string of atomic units", abort: true });
const zUintBig = zUint.transform((v) => BigInt(v));

const policySchema = z.object({
  perCallCap: zUint,
  dailyCap: zUint,
  maxCallsPerMinute: z.number().int().min(0).max(1_000_000),
  purpose: z.string().max(500),
});

const mandateJsonSchema = z.object({
  owner: zAddress,
  agent: zAddress,
  token: zAddress,
  totalCap: zUintBig,
  validAfter: zUintBig,
  validUntil: zUintBig,
  payeesRoot: zBytes32,
  policyHash: zBytes32,
  salt: zBytes32,
});

const createMandateSchema = z.object({
  mandate: mandateJsonSchema,
  ownerSignature: zHex,
  policy: policySchema,
  payees: z.array(zAddress).max(1024),
  label: z.string().trim().min(1).max(120),
  /** Optional EIP-2612 permit by the agent for the hub: opened with openMandateWithPermit, so the agent sends nothing. */
  permit: z
    .object({
      value: zUintBig,
      deadline: zUintBig,
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte signature").transform((v) => v as Hex),
    })
    .optional(),
});

const createProviderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  payee: zAddress,
  priceAtomic: zUint.refine((v) => BigInt(v) > 0n, "must be positive"),
  resource: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(60).default("api"),
});

const voucherSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal(SCHEME),
  network: z.string(),
  payload: z.object({
    mandateId: zBytes32,
    payee: zAddress,
    amount: zUintBig,
    cumulative: zUintBig,
    signature: zHex,
    requestHash: zBytes32,
  }),
  providerId: z.string().min(1).max(64),
  requestHash: zBytes32,
});

const cosignSchema = z.object({ signerProof: zHex });
const revokeSchema = z.object({ signature: zHex.optional() }).default({});

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "request body failed validation", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

function param<T extends z.ZodType>(value: string | undefined, schema: T, name: string): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", `invalid ${name}`, { [name]: r.error.issues[0]?.message ?? "invalid" });
  return r.data;
}

function limitOf(c: Context, def = 50, max = 500): number {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new ApiError(400, "VALIDATION_ERROR", "limit must be a positive integer");
  return Math.min(Number(raw), max);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function hashApiKey(key: string): string {
  return sha256(key).toString("hex");
}

/** True when a URL likely carries credentials or an API key (basic auth, query, or a long token in the path). */
function hasSecret(u: string): boolean {
  try {
    const url = new URL(u);
    return !!(url.username || url.password || url.search || /[0-9a-f]{16,}|[A-Za-z0-9_-]{24,}/.test(url.pathname));
  } catch {
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1]!.trim() : null;
}

type Vars = { Variables: { provider: ProviderRow } & AuthVars["Variables"] };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApi(s: NodeServices): Hono<Vars> {
  const { config, store, chain, events, log } = s;
  const app = new Hono<Vars>();
  const nowSec = () => Math.floor(Date.now() / 1000);
  const net = networkFor(config.chainId);

  app.use(
    "*",
    cors({
      origin: (origin) => (config.corsOrigins.includes("*") ? origin || "*" : config.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Last-Event-ID", "Idempotency-Key", "Merchant-Id", "PAYMENT-SIGNATURE", "X-Payminto-CSRF"],
      // x402 clients in a browser must be able to read the payment headers.
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "Retry-After", "Idempotent-Replayed"],
      maxAge: 600,
    }),
  );

  app.use(
    "*",
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (c) => c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds 512 KiB" } }, 413),
    }),
  );

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    s.metrics.inc("payminto_http_requests_total", "HTTP requests by method and status class.", {
      method: c.req.method,
      status: `${Math.floor(c.res.status / 100)}xx`,
    });
    // Path only: the query string may carry the SSE admin token.
    log.debug("http", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) });
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
    log.error("unhandled error", { method: c.req.method, path: c.req.path, err });
    return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  const ipOf = (c: Context) => clientIp(c, config.trustProxyHops);
  const tooMany = (c: Context, scope: string, r: Extract<TakeResult, { ok: false }> | number) => {
    const retryAfterSec = typeof r === "number" ? r : r.retryAfterSec;
    s.metrics.inc("payminto_rate_limited_total", "Requests refused with 429, by limiter.", { scope });
    c.header("Retry-After", String(retryAfterSec));
    return c.json({ error: { code: "RATE_LIMITED", message: `too many requests, retry in ${retryAfterSec}s`, details: { scope } } }, 429);
  };

  // One actor per request: API key, recovery key (ADMIN_TOKEN) or session cookie (docs/PRODUCT.md 10.1).
  const authDeps = { auth: s.auth, keys: () => s.gateway?.keys ?? null, merchants: () => s.gateway?.merchants ?? null, clientIp: ipOf, bearer };
  const access = new Access(authDeps);
  const resolve = resolveActor(authDeps);
  app.use("*", async (c, next) => (c.req.method === "OPTIONS" ? next() : resolve(c, next)));

  // Per-IP token bucket for every request without a valid credential: public reads, cosign, signed revokes and
  // failed auth attempts. Provider voucher traffic is limited per provider key below instead. /healthz stays open
  // for container and load-balancer probes. API keys, the recovery key and signed-in users are not limited per IP.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/healthz" || (c.req.method === "POST" && c.req.path === "/v1/vouchers")) return next();
    if (access.actor(c).type !== "anonymous") return next();
    const r = s.limiters.ip.take(ipOf(c));
    if (!r.ok) return tooMany(c, "ip", r);
    return next();
  });

  /** Budgets, paid services, settlements and the books: platform roles (PRODUCT.md 10.12). */
  const admin: MiddlewareHandler<Vars> = async (c, next) => {
    access.platform(c, c.req.method === "GET" ? "agents.read" : "agents.manage");
    await next();
  };
  const provider: MiddlewareHandler<Vars> = async (c, next) => {
    const t = bearer(c);
    const p = t ? store.providerByKeyHash(hashApiKey(t)) : undefined;
    if (!p) {
      // Unknown keys share the caller's IP bucket, so guessing keys cannot bypass the per-key limit.
      const r = s.limiters.ip.take(clientIp(c, config.trustProxyHops));
      if (!r.ok) return tooMany(c, "ip", r);
      throw new ApiError(401, "UNAUTHORIZED", "provider API key required");
    }
    const r = s.limiters.provider.take(p.id);
    if (!r.ok) return tooMany(c, "provider", r);
    c.set("provider", p);
    await next();
  };

  // ------------------------------------------------------------------ public

  app.get("/healthz", async (c) => {
    let blockNumber: number | null = null;
    try {
      blockNumber = Number(await chain.public.getBlockNumber());
    } catch {
      blockNumber = null;
    }
    const ok = blockNumber !== null;
    return c.json(
      { ok, chainId: config.chainId, hub: chain.hub, token: chain.token, operator: chain.operator.address, blockNumber, hspMode: config.hsp.mode },
      ok ? 200 : 503,
    );
  });

  // Prometheus scrape target. Admin-authenticated: configure `authorization: { credentials: <ADMIN_TOKEN> }` in the
  // scrape job, or scrape through a proxy that adds the header (docs/OPERATIONS.md).
  app.get("/metrics", async (c) => {
    const t = bearer(c);
    const metricsToken = config.auth?.metricsToken ?? null;
    if (!t || !(safeEqual(t, config.adminToken) || (metricsToken !== null && safeEqual(t, metricsToken)))) {
      throw new ApiError(401, "UNAUTHORIZED", "ADMIN_TOKEN or METRICS_TOKEN bearer required");
    }
    const [head, gas] = await Promise.all([
      chain.public.getBlockNumber().catch(() => null),
      chain.public.getBalance({ address: chain.operator.address }).catch(() => null),
    ]);
    const scanned = store.getMeta("revocations_scanned_block");
    const mem = process.memoryUsage();
    const lines = [
      ...renderGauges([
        {
          name: "payminto_node_info",
          help: "Static node information.",
          samples: [{ labels: { version: NODE_VERSION, chain_id: String(config.chainId), hsp_mode: config.hsp.mode }, value: 1 }],
        },
        { name: "payminto_chain_head_block", help: "Latest block seen from RPC_URL.", samples: head === null ? [] : [{ value: head }] },
        { name: "payminto_rpc_up", help: "1 when the RPC answered this scrape.", samples: [{ value: head === null ? 0 : 1 }] },
        {
          name: "payminto_revocations_scanned_block",
          help: "Last block scanned for on-chain MandateRevoked events.",
          samples: scanned === undefined ? [] : [{ value: BigInt(scanned) }],
        },
        { name: "payminto_operator_gas_balance_wei", help: "Native balance of the operator, which pays settlement gas.", samples: gas === null ? [] : [{ value: gas }] },
        { name: "payminto_unsettled_calls", help: "Accepted calls not yet in a batch.", samples: [{ value: store.unsettledCallCount() }] },
        { name: "payminto_sse_clients", help: "Open /v1/events streams.", samples: [{ value: s.sseClosers.size }] },
        { name: "payminto_ratelimit_keys", help: "Tracked rate-limit buckets.", samples: [
          { labels: { scope: "provider" }, value: s.limiters.provider.size },
          { labels: { scope: "ip" }, value: s.limiters.ip.size },
        ] },
        ...databaseGauges(s.db),
        { name: "process_resident_memory_bytes", help: "Resident set size.", samples: [{ value: mem.rss }] },
        { name: "process_uptime_seconds", help: "Seconds since the node started.", samples: [{ value: Math.round((Date.now() - s.metrics.startedAt) / 1000) }] },
      ]),
      ...s.metrics.renderCounters(),
    ];
    return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  // The RPC a browser wallet should use: PUBLIC_RPC_URL, else the chain's public RPC, else RPC_URL when it carries no key.
  const publicRpcUrl = config.auth?.publicRpcUrl ?? (net.chain.id === 31337 || !net.chain.rpcUrls.default.http[0] ? (hasSecret(config.rpcUrl) ? null : config.rpcUrl) : net.chain.rpcUrls.default.http[0]);
  app.get("/v1/info", async (c) => {
    const gas = await chain.public.getBalance({ address: chain.operator.address }).catch(() => null);
    return c.json({
      version: NODE_VERSION,
      chainId: config.chainId,
      network: {
        chainId: config.chainId,
        name: net.chain.name,
        caip2: net.caip2,
        explorer: net.explorer || null,
        testnet: !!net.chain.testnet,
        rpc_url: publicRpcUrl,
        fallback_rpc_urls: config.rpcFallbackUrls.filter((u) => !hasSecret(u)),
        ...(hashkeyLinks[config.chainId] ?? { faucet: null, bridge: null, docs: null }),
      },
      hub: chain.hub,
      hubExplorerUrl: explorerAddress(config.chainId, chain.hub),
      token: s.token,
      explorer: net.explorer || null,
      operator: chain.operator.address,
      /** Native gas balance of the operator (wei), which pays openMandate and settleBatch gas. */
      ...(gas !== null ? { operatorGasBalance: gas.toString() } : {}),
      publicUrl: config.publicUrl,
      hspMode: config.hsp.mode,
      hsp: {
        mode: config.hsp.mode,
        verifyingContract: s.settlement.hsp.verifyingContract,
        requiredCapabilities: s.settlement.hsp.requiredCapabilities,
        cosignTimeoutSec: config.hsp.cosignTimeoutSec,
      },
      settleIntervalSec: config.settleIntervalSec,
      gateway: s.gateway
        ? {
            enabled: true,
            checkoutBaseUrl: s.gateway.ctx.checkoutBaseUrl,
            depositFactory: s.gateway.config.depositFactory,
            paymentRouter: s.gateway.config.paymentRouter,
            tokenDomain: s.gateway.domain,
            confirmTag: chain.confirmTag,
            // The HSP payment method (GATEWAY.md section 17): off, or whether HashKey's HSP can take payments now.
            hspPayments: s.gateway.hsp?.availability() ?? { state: "off" },
          }
        : { enabled: false },
      settlement: {
        intervalSec: config.settleIntervalSec,
        minCalls: config.settleMinCalls,
        maxClaimsPerBatch: 64,
        /** Head a batch must reach before it is confirmed and booked (latest, safe or finalized). */
        confirmTag: chain.confirmTag,
        easAttest: config.easAttest ?? false,
      },
    });
  });

  app.get("/v1/providers", (c) => {
    const now = nowSec();
    return c.json(store.providers().map((p) => providerPublicJson(p, store.providerCalls24h(p.id, now))));
  });

  app.get("/v1/mandates/:id/position", (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const payee = param(c.req.query("payee"), zAddress, "payee");
    if (!store.mandate(id)) throw new ApiError(404, "UNKNOWN_MANDATE", "No open mandate with this id on this node");
    return c.json(s.vouchers.positionJson(id, payee));
  });

  // Public: the signed mandate, its policy and allowlist. Safe to expose (the mandate is public on chain and commits
  // to both via policyHash and payeesRoot); agents verify those hashes and enforce the policy before signing.
  app.get("/v1/mandates/:id/policy", (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const m = store.mandate(id);
    if (!m) throw new ApiError(404, "UNKNOWN_MANDATE", "No open mandate with this id on this node");
    const summary = store.mandateSummary(m, nowSec());
    return c.json({ id: m.id, status: summary.status, mandate: summary.mandate, policy: summary.policy, payees: summary.payees });
  });

  app.get("/v1/receipts/:callId/proof", async (c) => {
    const callId = param(c.req.param("callId"), zBytes32, "callId");
    const call = store.call(callId);
    if (!call) throw new ApiError(404, "NOT_FOUND", "call not found");
    const batch = call.batch_seq !== null ? store.batch(String(call.batch_seq)) : undefined;
    const proof = call.proof ? (JSON.parse(call.proof) as Hex[]) : [];
    // True only if this node's operator settled the batch, signed the leaf, and the Merkle proof verifies on chain.
    const onchainVerified =
      batch && batch.status === "confirmed" ? await receiptVerifiedOnchain(chain, batch.batch_id, call.leaf, call.node_signature, proof) : null;
    const receipt: ClearingReceipt = {
      callId: call.call_id,
      mandateId: call.mandate_id,
      payee: call.payee,
      amount: call.amount,
      cumulative: call.cumulative,
      requestHash: call.request_hash,
      timestamp: call.timestamp,
      leaf: call.leaf,
      nodeSignature: call.node_signature,
      node: chain.operator.address,
    };
    return c.json({
      receipt,
      status: call.status,
      batchId: batch?.batch_id ?? null,
      batchStatus: batch?.status ?? null,
      receiptsRoot: batch?.receipts_root ?? null,
      proof,
      leaf: call.leaf,
      txHash: batch?.tx_hash ?? null,
      explorerUrl: batch?.tx_hash ? explorerTx(config.chainId, batch.tx_hash) : null,
      onchainVerified,
    });
  });

  app.get("/v1/agents/:address/cosign", (c) => {
    const address = param(c.req.param("address"), zAddress, "address");
    return c.json(s.settlement.pendingCosigns(address));
  });

  app.post("/v1/cosign/:hspPaymentId", async (c) => {
    const id = param(c.req.param("hspPaymentId"), zBytes32, "hspPaymentId");
    const { signerProof } = await body(c, cosignSchema);
    return c.json(await s.settlement.cosign(id, signerProof));
  });

  app.get("/v1/events", (c) => {
    // EventSource cannot send headers: the recovery key may come as ?token= (while it is active); sessions use the cookie.
    const qt = c.req.query("token");
    // Business members and API keys (no platform role) see only their business's agent run events (docs/AGENTS.md section 6).
    let only: ((e: NodeEvent) => boolean) | null = null;
    if (!(qt && s.auth.recoveryKeyActive() && safeEqual(qt, config.adminToken))) {
      const actor = access.actor(c);
      if (s.agents && actor.type !== "anonymous" && !access.hasPlatform(actor, "agents.read")) {
        const { merchant } = access.business(c, "payments.read", c.req.query("merchant_id") || undefined);
        only = (e) => e.type.startsWith("agent_run.") && e.merchant_id === merchant.id;
      } else access.platform(c, "agents.read");
    }
    const visible = (e: NodeEvent) => !only || only(e);
    const lastRaw = c.req.header("last-event-id") ?? c.req.query("since");
    const lastId = lastRaw && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
    return streamSSE(c, async (stream) => {
      const queue: NodeEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const close = () => {
        closed = true;
        wake?.();
      };
      const unsubscribe = events.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      s.sseClosers.add(close);
      stream.onAbort(close);
      try {
        let sent = 0;
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: nowIso(), node: chain.operator.address }), retry: 3000 });
        if (lastId !== null) {
          for (const e of events.since(lastId)) {
            if (!visible(e)) continue;
            await stream.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
            sent = Number(e.id);
          }
        }
        while (!closed && !stream.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 15_000);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = null;
            if (queue.length === 0 && !closed) await stream.write(": ping\n\n");
          }
          while (queue.length && !closed) {
            const e = queue.shift()!;
            if (Number(e.id) <= sent || !visible(e)) continue;
            await stream.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
          }
        }
      } finally {
        unsubscribe();
        s.sseClosers.delete(close);
      }
    });
  });

  // ---------------------------------------------------------------- provider

  app.post("/v1/vouchers", provider, async (c) => {
    const p = c.get("provider");
    const b = await body(c, voucherSchema);
    if (b.providerId !== p.id) throw new ApiError(403, "PROVIDER_MISMATCH", "providerId does not match the API key");
    if (b.network !== net.caip2) throw new ApiError(400, "NETWORK_MISMATCH", `network must be ${net.caip2}`);
    if (b.payload.payee !== p.payee) throw new ApiError(400, "PAYEE_MISMATCH", "voucher payee is not this provider's payee");
    if (b.payload.requestHash !== b.requestHash) {
      throw new ApiError(400, "REQUEST_HASH_MISMATCH", "payload.requestHash differs from the provider's requestHash");
    }
    const r = await s.vouchers.accept(p, b.payload);
    if (r.ok) return c.json({ receipt: r.receipt, position: r.position });
    return c.json({ error: { code: r.rule as DenialRule, message: r.message, details: r.details } }, 402);
  });

  // ------------------------------------------------------------------- admin

  app.get("/v1/overview", admin, (c) => c.json({ ...overview(s.db, store, config.chainId, nowSec()), token: s.token }));

  app.get("/v1/mandates", admin, (c) => {
    const now = nowSec();
    return c.json(store.mandates().map((m) => store.mandateSummary(m, now)));
  });

  app.get("/v1/mandates/:id", admin, async (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const m = store.mandate(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "mandate not found");
    const [onchain, onboarding] = await Promise.all([
      chain.mandate(m.id).catch(() => undefined),
      m.open_tx_hash ? chain.onboarding(m.open_tx_hash as Hex, m.agent as Address).catch(() => null) : Promise.resolve(null),
    ]);
    const positions = s.db
      .all<{ payee: Address; cumulative: string; settled: string }>(
        "SELECT payee, cumulative, settled FROM positions WHERE mandate_id = ? ORDER BY payee",
        m.id,
      )
      .map((p) => ({ ...p, pending: (BigInt(p.cumulative) - BigInt(p.settled)).toString() }));
    return c.json({
      ...store.mandateSummary(m, nowSec()),
      ownerSignature: m.owner_signature,
      revokedBy: m.revoked_by,
      revokeTxHash: m.revoke_tx_hash,
      openTxExplorerUrl: m.open_tx_hash ? explorerTx(config.chainId, m.open_tx_hash) : null,
      onchain:
        onchain === undefined
          ? null
          : onchain === null
            ? { open: false }
            : {
                open: true,
                spent: onchain.spent.toString(),
                totalCap: onchain.totalCap.toString(),
                revokedAt: onchain.revokedAt === 0n ? null : Number(onchain.revokedAt),
                validUntil: Number(onchain.validUntil),
              },
      positions,
      recentCalls: store.listCalls({ mandateId: m.id, limit: 50 }).items,
      denials: store.listDenials({ mandateId: m.id, limit: 50 }),
      spendSeries: store.spendSeries(m.id, nowSec()),
      spendRecent: store.spendRecent(m.id, nowSec()),
      onboarding,
    });
  });

  app.post("/v1/mandates", admin, async (c) => {
    const b = await body(c, createMandateSchema);
    const row = await s.mandates.create(b);
    return c.json(store.mandateSummary(row, nowSec()), 201);
  });

  app.post("/v1/mandates/:id/revoke", async (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const m = store.mandate(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "mandate not found");
    const actor = access.actor(c);
    let by: string;
    if (actor.type !== "anonymous" && access.hasPlatform(actor, "agents.manage")) {
      access.authed(c);
      by = "admin";
    } else {
      const { signature } = await body(c, revokeSchema);
      if (!signature) throw new ApiError(401, "UNAUTHORIZED", "admin bearer token or an agent/owner revoke signature required");
      by = await s.mandates.authorizeSignedRevoke(m, signature);
    }
    return c.json(await s.mandates.revoke(m.id, by));
  });

  app.get("/v1/providers/:id", admin, (c) => {
    const p = store.provider(c.req.param("id"));
    if (!p) throw new ApiError(404, "NOT_FOUND", "provider not found");
    const revenue = s.db.get<{ settled: string; pending: string; calls: number }>(
      `SELECT bigsum(CASE WHEN status = 'settled' THEN amount END) AS settled,
              bigsum(CASE WHEN status != 'settled' THEN amount END) AS pending, COUNT(*) AS calls
       FROM calls WHERE provider_id = ?`,
      p.id,
    )!;
    const denials = s.db.get<{ n: number }>("SELECT COALESCE(SUM(repeats), 0) AS n FROM denials WHERE provider_id = ?", p.id)!.n;
    return c.json({
      ...providerPublicJson(p, store.providerCalls24h(p.id, nowSec())),
      createdAt: p.created_at,
      callsTotal: revenue.calls,
      denials,
      revenue: { settled: revenue.settled, pending: revenue.pending },
      recentCalls: store.listCalls({ providerId: p.id, limit: 50 }).items,
    });
  });

  app.post("/v1/providers", admin, async (c) => {
    const b = await body(c, createProviderSchema);
    const id = `prv_${randomBytes(6).toString("hex")}`;
    const apiKey = `pmk_${randomBytes(24).toString("base64url")}`;
    const createdAt = nowIso();
    s.db.run(
      `INSERT INTO providers (id, name, description, payee, price_atomic, resource, category, api_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      b.name,
      b.description,
      b.payee,
      b.priceAtomic,
      b.resource,
      b.category,
      hashApiKey(apiKey),
      createdAt,
    );
    log.info("provider registered", { providerId: id, payee: b.payee });
    const p = store.provider(id)!;
    return c.json({ ...providerPublicJson(p, 0), createdAt, apiKey }, 201);
  });

  app.get("/v1/calls", admin, (c) => {
    const status = c.req.query("status");
    if (status && !["accepted", "settling", "settled"].includes(status)) {
      throw new ApiError(400, "VALIDATION_ERROR", "status must be accepted, settling or settled");
    }
    const cursor = c.req.query("cursor");
    if (cursor && !/^\d+$/.test(cursor)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    const mandateId = c.req.query("mandateId");
    const payee = c.req.query("payee");
    return c.json(
      store.listCalls({
        mandateId: mandateId ? param(mandateId, zBytes32, "mandateId") : undefined,
        payee: payee ? param(payee, zAddress, "payee") : undefined,
        status: status || undefined,
        providerId: c.req.query("providerId") || undefined,
        limit: limitOf(c),
        cursor: cursor ? Number(cursor) : undefined,
      }),
    );
  });

  app.get("/v1/denials", admin, (c) => c.json(store.listDenials({ limit: limitOf(c) })));

  app.get("/v1/batches", admin, (c) => {
    return c.json(store.batches(limitOf(c)).map((b) => batchSummaryJson(b, config.chainId)));
  });

  app.get("/v1/batches/:id", admin, (c) => {
    const b = store.batch(c.req.param("id"));
    if (!b) throw new ApiError(404, "NOT_FOUND", "batch not found");
    return c.json(store.batchDetailJson(b, config.chainId));
  });

  app.post("/v1/settlements", async (c) => {
    const actor = access.platform(c, "settlements.run");
    const out = await s.settlement.settle("manual");
    s.auth.audit.write(auditActor(actor), "settlement.run", { meta: { trigger: "manual" } });
    return c.json(out);
  });

  app.get("/v1/ledger", admin, (c) => {
    const cursor = c.req.query("cursor");
    if (cursor && !/^\d+$/.test(cursor)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    return c.json(s.ledger.entries({ account: c.req.query("account") || undefined, limit: limitOf(c, 100, 1000), cursor: cursor ? Number(cursor) : undefined }));
  });

  app.get("/v1/ledger/trial-balance", admin, (c) => c.json(s.ledger.trialBalance()));

  app.get("/v1/netting/preview", admin, (c) => c.json(s.settlement.preview()));

  mountAuth(app, access, { metrics: s.metrics, chainId: config.chainId, tooMany, limits: { ...DEFAULT_AUTH_LIMITS, ...(config.auth?.rateLimitPerMin ? { authPerMin: config.auth.rateLimitPerMin } : {}), ...(config.auth?.setupPerMin ? { setupPerMin: config.auth.setupPerMin } : {}), ...(config.auth?.emailPerHour ? { emailPerHour: config.auth.emailPerHour } : {}) } });

  // ------------------------------------------------------------------ global search (PRODUCT.md 5.4 and 10.13)

  const searchRps = config.auth?.searchRps ?? 10;
  const searchBuckets = new TokenBuckets({ rps: searchRps, burst: searchRps * 2 });
  app.get("/v1/search", (c) => {
    const actor = access.authed(c);
    const key = actor.type === "user" ? actor.session.id : actor.type === "api_key" ? actor.key.id : "recovery";
    const r = searchBuckets.take(key);
    if (!r.ok) return tooMany(c, "search", r);
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const typesRaw = c.req.query("types");
    const types = (typesRaw ? typesRaw.split(",").map((t) => t.trim()) : [...SEARCH_TYPES]).filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t));
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8) || 8, 1), 20);
    const platform = access.hasPlatform(actor, "agents.read") && access.hasPlatform(actor, "businesses.read");
    let merchantIds: string[] | null = [];
    if (s.gateway) {
      const mid = c.req.query("merchant_id");
      if (mid) merchantIds = [access.business(c, "payments.read", mid).merchant.id];
      else if (access.isPlatformActor(actor)) merchantIds = null;
      else if (actor.type === "api_key") merchantIds = [actor.key.merchant_id];
      else if (actor.type === "user") merchantIds = s.auth.memberships(actor.user.id).filter((m) => access.canBusiness(actor, "payments.read", m.merchant_id)).map((m) => m.merchant_id);
    }
    return c.json(s.search.search(q, types, limit, { merchantIds, platform }));
  });
  app.get("/v1/search/recent", (c) => c.json(s.search.recent(access.user(c).user.id)));
  app.post("/v1/search/recent", async (c) => {
    const x = access.user(c);
    const b = await body(c, z.object({ type: z.string().min(1).max(40), id: z.string().min(1).max(200), title: z.string().max(200), href: z.string().regex(/^\/[^/]/, "must be a dashboard path").max(500) }));
    return c.json(s.search.addRecent(x.user.id, b));
  });

  if (s.gateway) mountGateway(app, s.gateway, { access, auth: s.auth, customers: s.customers, clientIp: ipOf, sseClosers: s.sseClosers, publicUrl: config.publicUrl });
  if (s.agents) {
    mountAgents(app, s.agents, { access, auth: s.auth });
    // Ops tools and skill paywalls call this API in-process; nothing leaves the node.
    s.agents.bindFetch(((input: RequestInfo | URL, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch);
  }

  return app;
}
