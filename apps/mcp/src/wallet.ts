import { createPublicClient, getAddress, http, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  clearingHubAbi,
  decodeHeader,
  DENIAL_RULES,
  formatAmount,
  HEADER_RESPONSE,
  networkFor,
  verifyReceiptProof,
  type ClearingReceipt,
  type DenialRule,
} from "@payminto/protocol";
import { AgentClient, NodeApiError, NodeHttp, verifyReceiptOnchain, type DeniedEvent, type ReceiptStore, type VerifiedPolicy } from "@payminto/sdk";

// Everything read from the clearing node or a provider is untrusted input: parse it.
const zAddr = z.string().transform((v, ctx) => {
  try {
    return getAddress(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "address" });
    return z.NEVER;
  }
});
const zUint = z.string().regex(/^\d{1,78}$/);
const zB32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);

const infoSchema = z
  .object({
    hub: zAddr,
    token: z.object({ address: zAddr, symbol: z.string(), decimals: z.number().int() }),
    operator: zAddr,
  })
  .loose();
const catalogSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      payee: zAddr,
      priceAtomic: zUint,
      resource: z.string(),
      category: z.string(),
      calls24h: z.number().optional(),
    })
    .loose(),
);
const tokenSchema = z.object({ address: zAddr, symbol: z.string(), decimals: z.number().int() }).loose();
// The service directory (GATEWAY.md section 13.4): payment links and registered paid endpoints.
const directorySchema = z
  .object({
    services: z.array(
      z.union([
        z
          .object({
            type: z.literal("link"),
            id: z.string(),
            merchant: z.object({ id: z.string(), name: z.string() }).loose(),
            title: z.string(),
            description: z.string().nullable(),
            // A fixed `amount`, or the open range the payer picks from.
            price: z.object({ amount: zUint.optional(), min_amount: zUint.nullable().optional(), max_amount: zUint.nullable().optional() }).loose(),
            token: tokenSchema,
            schemes: z.array(z.string()),
            pay_url: z.string(),
          })
          .loose(),
        z
          .object({
            type: z.literal("endpoint"),
            id: z.string(),
            title: z.string(),
            description: z.string(),
            category: z.string(),
            price: z.object({ amount: zUint }).loose(),
            payee: zAddr,
            token: tokenSchema,
            schemes: z.array(z.string()),
            pay_url: z.string(),
          })
          .loose(),
      ]),
    ),
  })
  .loose();
const positionSchema = z.object({ cumulative: zUint, settled: zUint }).loose();
const proofSchema = z
  .object({
    receipt: z
      .object({
        callId: zB32,
        mandateId: zB32,
        payee: zAddr,
        amount: zUint,
        cumulative: zUint,
        requestHash: zB32,
        timestamp: z.number(),
        leaf: zB32,
        nodeSignature: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((v) => v as Hex),
      })
      .loose(),
    status: z.string(),
    batchId: zB32.nullable(),
    batchStatus: z.string().nullable().optional(),
    receiptsRoot: zB32.nullable(),
    proof: z.array(zB32),
    leaf: zB32,
    txHash: z.string().nullable(),
    explorerUrl: z.string().nullable(),
    onchainVerified: z.boolean().nullable(),
  })
  .loose();

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) });
const receiptRefSchema = z.object({ callId: zB32, payee: zAddr, amount: zUint, cumulative: zUint }).loose();
const paymentResponseSchema = z.object({ receipt: receiptRefSchema }).loose();
const linkResponseSchema = z
  .object({ paymentId: z.string().regex(/^pay_[a-z2-7]{24}$/), status: z.string(), receipt: receiptRefSchema, receipts: z.array(receiptRefSchema).optional() })
  .loose();
const linkBodySchema = z.object({ payment_id: z.string(), status: z.string(), amount_due: zUint, order_hash: z.string().optional(), proof_url: z.string().optional() }).loose();
const checkoutViewSchema = z.object({ id: z.string(), status: z.string(), amount: zUint, surcharge: zUint, amount_due: zUint, merchant: z.object({ name: z.string() }).loose() }).loose();

export type Service = {
  /** "endpoint": a paid API (call_paid_service). "link": a merchant payment link (pay_link). */
  type: "endpoint" | "link";
  id: string;
  name: string;
  description: string;
  category: string;
  url: string;
  /** Null for links: a link pays the merchant and, with a fee, the platform (both must be on the allowlist). */
  payee: Address | null;
  /** Null for an open-amount link (the payer picks within minAtomic and maxAtomic, passed as ?amount=). */
  priceAtomic: string | null;
  price: string;
  minAtomic?: string | null;
  maxAtomic?: string | null;
  /** The merchant selling a link. */
  merchant?: string;
  /** x402 schemes the service accepts; this wallet pays only payminto-voucher. */
  schemes: string[];
  calls24h: number | null;
  /** null when the wallet cannot see the mandate allowlist, or for links (their payees show in the 402). */
  allowedByMandate: boolean | null;
};

export type LinkPayment = {
  paymentId: string;
  status: string;
  merchant: string | null;
  url: string;
  /** Fee breakdown in atomic units: what was paid, the merchant's net and the platform fee. */
  amountAtomic: string;
  amount: string;
  breakdown: {
    price: string | null;
    surcharge: string | null;
    amountDue: string;
    merchantNet: string;
    platformFee: string;
    vouchers: Array<{ callId: Hex; payee: Address; amount: string; role: "merchant" | "platform fee" }>;
  };
  orderHash: string | null;
  /** Public proof page (needs the clearing batch to settle) and the node's proof API. */
  proofUrl: string | null;
  proofApi: string;
};

export type LinkOutcome = { ok: true; payment: LinkPayment } | Exclude<CallOutcome, { ok: true }>;

export type CallArgs = {
  serviceId?: string;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean>;
  body?: unknown;
};

export type Paid = { callId: Hex; payee: Address; amountAtomic: string; amount: string; cumulativeAtomic: string };

export type CallOutcome =
  | { ok: true; status: number; url: string; service: string | null; paid: Paid | null; body: unknown; truncated: boolean }
  | {
      ok: false;
      kind: "denied";
      rule: string;
      ruleText: string;
      message: string;
      /** "agent": refused by this wallet before signing; "node": refused by the clearing node and recorded there. */
      enforcedBy: "agent" | "node";
      status: number;
      url: string;
      service: string | null;
      details?: Record<string, unknown>;
    }
  | { ok: false; kind: "error"; message: string; status: number | null; url: string | null; service: string | null; body?: unknown };

export type HistoryEntry = { at: string; service: string | null; url: string; receipt: ClearingReceipt; price: string };

export type WalletOptions = {
  nodeUrl: string;
  chainId: number;
  hub?: Address;
  agentKey: Hex;
  mandateId: Hex;
  rpcUrl?: string;
  maxPrice?: bigint;
  trustedNode?: Address;
  /** Check the mandate policy before signing (default true, the SDK default). */
  enforcePolicy?: boolean;
  /** Durable receipt store file (SQLite). Without it (and without `receipts`), receipts and signed positions are lost on restart. */
  receiptStorePath?: string;
  /** A store shared with another client of the same agent key (takes precedence over receiptStorePath). */
  receipts?: ReceiptStore;
  fetch?: typeof fetch;
  /** Largest response body (characters) returned to the model. */
  maxBodyChars?: number;
};

const MAX_HISTORY = 1_000;

/**
 * A budgeted wallet for an LLM agent: every paid call goes through AgentClient, so it is bound to one mandate
 * and the clearing node enforces every cap atomically. Keeps the receipts it was given for proof requests.
 */
export class AgentWallet {
  readonly agent: AgentClient;
  readonly node: NodeHttp;
  readonly chainId: number;
  readonly hub: Address;
  readonly mandateId: Hex;
  readonly history: HistoryEntry[] = [];
  readonly #o: WalletOptions;
  readonly #public: PublicClient | null;
  #info: z.infer<typeof infoSchema> | null = null;

  private constructor(o: WalletOptions, hub: Address, info: z.infer<typeof infoSchema>) {
    this.#o = o;
    this.chainId = o.chainId;
    this.hub = hub;
    this.mandateId = o.mandateId.toLowerCase() as Hex;
    this.#info = info;
    this.node = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
    this.agent = new AgentClient({
      nodeUrl: o.nodeUrl,
      chainId: o.chainId,
      hub,
      account: privateKeyToAccount(o.agentKey),
      mandateId: this.mandateId,
      autoCosign: true,
      maxPrice: o.maxPrice,
      trustedNode: o.trustedNode ?? info.operator,
      enforcePolicy: o.enforcePolicy,
      receipts: o.receipts,
      storePath: o.receiptStorePath,
      fetch: o.fetch,
    });
    // Receipts paid before a restart stay listable and provable.
    for (const r of this.agent.receipts.all()) {
      if (r.mandateId.toLowerCase() !== this.mandateId) continue;
      this.history.push({ at: new Date(r.timestamp * 1000).toISOString(), service: null, url: "", receipt: r, price: r.amount });
    }
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.#public = o.rpcUrl ? (createPublicClient({ transport: http(o.rpcUrl) }) as PublicClient) : null;
  }

  /** Connects to the node, checks it clears the configured hub, and builds the wallet. */
  static async connect(o: WalletOptions): Promise<AgentWallet> {
    const node = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
    const info = await node.get("/v1/info", infoSchema);
    if (o.hub && !isAddressEqual(o.hub, info.hub)) {
      throw new Error(`clearing node at ${o.nodeUrl} clears hub ${info.hub}, but HUB_ADDRESS is ${o.hub}`);
    }
    return new AgentWallet(o, o.hub ?? info.hub, info);
  }

  get address(): Address {
    return this.agent.address;
  }

  get token() {
    return this.#info!.token;
  }

  fmt(atomic: bigint | string): string {
    return `${formatAmount(atomic, this.token.decimals)} ${this.token.symbol}`;
  }

  /** Stops the HSP co-sign loop and closes the receipt store (call on shutdown). */
  close(): void {
    this.agent.close();
  }

  /** The mandate, policy and allowlist, verified by the SDK against the mandate id (a node cannot loosen them). */
  async #policy(): Promise<VerifiedPolicy | null> {
    return this.agent.loadPolicy().catch(() => null);
  }

  /**
   * What the node sells: its service directory (GATEWAY.md section 13.4), with links and paid endpoints. A node without
   * the gateway has no directory, so the provider catalog is the fallback; it also supplies endpoint call counts.
   */
  async services(): Promise<Service[]> {
    const [catalog, directory, pol] = await Promise.all([
      this.node.get("/v1/providers", catalogSchema),
      this.node.get("/v1/directory", directorySchema).catch((err: unknown) => {
        if (err instanceof NodeApiError && err.status === 404) return null;
        throw err;
      }),
      this.#policy(),
    ]);
    const allow = pol?.payees;
    const allowed = (payee: Address) => (allow ? allow.some((a) => isAddressEqual(a, payee)) : null);
    const calls = new Map(catalog.map((p) => [p.id, p.calls24h ?? null]));
    if (!directory) {
      return catalog.map((p) => ({
        type: "endpoint" as const,
        id: p.id,
        name: p.name,
        description: p.description,
        category: p.category,
        url: p.resource,
        payee: p.payee,
        priceAtomic: p.priceAtomic,
        price: this.fmt(p.priceAtomic),
        schemes: ["payminto-voucher"],
        calls24h: p.calls24h ?? null,
        allowedByMandate: allowed(p.payee),
      }));
    }
    return directory.services.map((s): Service => {
      if (s.type === "endpoint") {
        return {
          type: "endpoint",
          id: s.id,
          name: s.title,
          description: s.description,
          category: s.category,
          url: s.pay_url,
          payee: s.payee,
          priceAtomic: s.price.amount,
          price: this.fmt(s.price.amount),
          schemes: s.schemes,
          calls24h: calls.get(s.id) ?? null,
          allowedByMandate: allowed(s.payee),
        };
      }
      const fixed = s.price.amount ?? null;
      const range = fixed ? null : { min_amount: s.price.min_amount ?? null, max_amount: s.price.max_amount ?? null };
      return {
        type: "link",
        id: s.id,
        name: s.title,
        description: s.description ?? "",
        category: "payment-link",
        url: s.pay_url,
        payee: null,
        priceAtomic: fixed,
        price: fixed ? this.fmt(fixed) : `${this.fmt(range?.min_amount ?? "0")} to ${range?.max_amount ? this.fmt(range.max_amount) : "any amount"} (pass amountAtomic)`,
        ...(range ? { minAtomic: range.min_amount, maxAtomic: range.max_amount } : {}),
        merchant: s.merchant.name,
        schemes: s.schemes,
        calls24h: null,
        allowedByMandate: null,
      };
    });
  }

  async #resolve(a: CallArgs): Promise<{ url: string; service: string | null }> {
    let base: string;
    let service: string | null = null;
    if (a.serviceId) {
      const s = (await this.services()).find((x) => x.id === a.serviceId || x.name.toLowerCase() === a.serviceId!.toLowerCase());
      if (!s) throw new Error(`unknown serviceId "${a.serviceId}"; call list_paid_services for valid ids`);
      service = s.name;
      base = a.url ?? s.url;
    } else if (a.url) {
      base = a.url;
    } else {
      throw new Error("pass either serviceId or url");
    }
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      throw new Error(`"${base}" is not an absolute URL; pass url explicitly`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https URLs can be called");
    for (const [k, v] of Object.entries(a.query ?? {})) u.searchParams.set(k, String(v));
    return { url: u.toString(), service };
  }

  /** Calls a service, paying its x402 payminto-voucher requirement from the mandate if it asks for one. */
  async call(a: CallArgs): Promise<CallOutcome> {
    let target: { url: string; service: string | null };
    try {
      target = await this.#resolve(a);
    } catch (err) {
      return { ok: false, kind: "error", message: (err as Error).message, status: null, url: a.url ?? null, service: a.serviceId ?? null };
    }
    const method = a.method ?? (a.body === undefined ? "GET" : "POST");
    const init: RequestInit = { method, headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" } };
    if (a.body !== undefined && method !== "GET") {
      init.body = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
      init.headers = { ...init.headers, "content-type": typeof a.body === "string" ? "text/plain" : "application/json" };
    }
    let clientDenial: DeniedEvent | null = null;
    const off = this.agent.on("denied", (d) => {
      if (d.url === target.url && d.code.startsWith("CLIENT_")) clientDenial = d;
    });
    let res: Response;
    try {
      res = await this.agent.fetch(target.url, init);
    } catch (err) {
      return { ok: false, kind: "error", message: `request failed: ${(err as Error).message}`, status: null, ...target };
    } finally {
      off();
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: keep text
    }

    if (res.status === 402) {
      return this.#refused(402, body, clientDenial as DeniedEvent | null, target, "the service requires a payment this wallet cannot make: no payminto-voucher offer for this network and clearing hub");
    }

    let paid: Paid | null = null;
    const pr = paymentResponseSchema.safeParse(decodeHeader<unknown>(res.headers.get(HEADER_RESPONSE)));
    if (pr.success) {
      const r = pr.data.receipt;
      const stored = this.agent.receipts.get(r.callId);
      // Only receipts the AgentClient verified (node signature, leaf, amounts) count as paid.
      if (stored) {
        paid = { callId: r.callId, payee: r.payee, amountAtomic: r.amount, amount: this.fmt(r.amount), cumulativeAtomic: r.cumulative };
        this.history.push({ at: new Date().toISOString(), service: target.service, url: target.url, receipt: stored, price: r.amount });
        if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      }
    }
    const max = this.#o.maxBodyChars ?? 16_000;
    let truncated = false;
    if (typeof body === "string" && body.length > max) {
      body = body.slice(0, max);
      truncated = true;
    } else if (body !== null && typeof body === "object" && JSON.stringify(body).length > max) {
      body = JSON.stringify(body).slice(0, max);
      truncated = true;
    }
    if (!res.ok) return { ok: false, kind: "error", message: `service answered HTTP ${res.status}`, status: res.status, body, ...target };
    return { ok: true, status: res.status, paid, body, truncated, ...target };
  }

  /**
   * Pays a payment link (or a single payment's pay URL) from the mandate, with the payminto-voucher path only: a fee-
   * carrying link takes two vouchers (merchant net and platform fee), both checked against the mandate before signing.
   * Never pays x402 `exact`, which no mandate policy covers. Money moves at the next clearing batch; until then the
   * payment is `processing`.
   */
  async payLink(a: { url: string; amountAtomic?: string }): Promise<LinkOutcome> {
    let target: string;
    try {
      const u = new URL(a.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https links can be paid");
      if (a.amountAtomic !== undefined) {
        if (!/^[1-9]\d{0,77}$/.test(a.amountAtomic)) throw new Error("amountAtomic must be a positive integer of base units");
        u.searchParams.set("amount", a.amountAtomic);
      }
      target = u.toString();
    } catch (err) {
      return { ok: false, kind: "error", message: (err as Error).message, status: null, url: a.url, service: null };
    }
    let clientDenial: DeniedEvent | null = null;
    const off = this.agent.on("denied", (d) => {
      if (d.url === target && d.code.startsWith("CLIENT_")) clientDenial = d;
    });
    let res: Response;
    try {
      // Non-HTML Accept: a dashboard /l/ link proxies agents to the node's x402 route instead of the checkout page.
      res = await this.agent.fetch(target, { headers: { accept: "application/json" } });
    } catch (err) {
      return { ok: false, kind: "error", message: `request failed: ${(err as Error).message}`, status: null, url: target, service: null };
    } finally {
      off();
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (res.status === 402) return this.#refused(res.status, body, clientDenial, { url: target, service: null }, "the link offers no payminto-voucher payment for this network and clearing hub (this wallet never pays x402 exact)");
    if (!res.ok) return { ok: false, kind: "error", message: `link answered HTTP ${res.status}`, status: res.status, url: target, service: null, body };
    const pr = linkResponseSchema.safeParse(decodeHeader<unknown>(res.headers.get(HEADER_RESPONSE)));
    if (!pr.success) return { ok: false, kind: "error", message: "the link answered without a voucher PAYMENT-RESPONSE", status: res.status, url: target, service: null, body };
    // Only receipts the AgentClient verified count; the node lists the merchant voucher first, then the platform fee.
    const refs = pr.data.receipts ?? [pr.data.receipt];
    const vouchers: LinkPayment["breakdown"]["vouchers"] = [];
    for (const [i, r] of refs.entries()) {
      const stored = this.agent.receipts.get(r.callId);
      if (!stored) return { ok: false, kind: "error", message: `the receipt for ${r.payee} did not verify; treat the payment as unconfirmed`, status: res.status, url: target, service: null, body };
      vouchers.push({ callId: r.callId, payee: r.payee, amount: r.amount, role: i === 0 ? "merchant" : "platform fee" });
      this.history.push({ at: new Date().toISOString(), service: `link ${pr.data.paymentId}`, url: target, receipt: stored, price: r.amount });
    }
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    const total = vouchers.reduce((s, v) => s + BigInt(v.amount), 0n);
    const fee = vouchers.slice(1).reduce((s, v) => s + BigInt(v.amount), 0n);
    const paidBody = linkBodySchema.safeParse(body);
    const view = await this.node.get(`/v1/checkout/${pr.data.paymentId}`, checkoutViewSchema).catch(() => null);
    return {
      ok: true,
      payment: {
        paymentId: pr.data.paymentId,
        status: pr.data.status,
        merchant: view?.merchant.name ?? null,
        url: target,
        amountAtomic: total.toString(),
        amount: this.fmt(total),
        breakdown: {
          price: view?.amount ?? null,
          surcharge: view?.surcharge ?? null,
          amountDue: paidBody.success ? paidBody.data.amount_due : total.toString(),
          merchantNet: vouchers[0]!.amount,
          platformFee: fee.toString(),
          vouchers,
        },
        orderHash: paidBody.success ? (paidBody.data.order_hash ?? null) : null,
        proofUrl: paidBody.success ? (paidBody.data.proof_url ?? null) : null,
        proofApi: `${this.node.baseUrl}/v1/checkout/${pr.data.paymentId}/proof`,
      },
    };
  }

  /** A 402 after AgentClient.fetch: a policy denial (agent or node), or no payable offer. */
  #refused(status: number, body: unknown, clientDenial: DeniedEvent | null, target: { url: string; service: string | null }, noOffer: string): Exclude<CallOutcome, { ok: true }> {
    if (clientDenial) {
      return { ok: false, kind: "denied", rule: clientDenial.code, ruleText: "Price above this wallet's MAX_PRICE_ATOMIC", message: clientDenial.message, enforcedBy: "agent", status, ...target };
    }
    const e = errorBodySchema.safeParse(body);
    if (e.success && e.data.error.code !== "PAYMENT_REQUIRED") {
      const rule = e.data.error.code;
      const ruleText = rule in DENIAL_RULES ? DENIAL_RULES[rule as DenialRule] : "Payment refused";
      const enforcedBy = e.data.error.details?.enforcedBy === "agent" ? "agent" : "node";
      return { ok: false, kind: "denied", rule, ruleText, message: e.data.error.message, enforcedBy, status, details: e.data.error.details, ...target };
    }
    return { ok: false, kind: "error", message: noOffer, status, ...target };
  }

  /** Budget: verified mandate and policy, node positions per allowed payee, and on-chain state when RPC_URL is set. */
  async budget() {
    const pol = await this.#policy();
    const payees = pol?.payees ?? [...new Map((await this.services()).flatMap((s) => (s.payee ? [[s.payee.toLowerCase(), s.payee] as const] : []))).values()];
    let cumulative = 0n;
    let settled = 0n;
    for (const payee of payees) {
      const p = await this.node.get(`/v1/mandates/${this.mandateId}/position?payee=${payee}`, positionSchema).catch(() => null);
      if (!p) continue;
      cumulative += BigInt(p.cumulative);
      settled += BigInt(p.settled);
    }
    let onchain: { spent: bigint; revokedAt: number } | null = null;
    if (this.#public) {
      const m = await this.#public
        .readContract({ address: this.hub, abi: clearingHubAbi, functionName: "mandates", args: [this.mandateId] })
        .catch(() => null);
      if (m) {
        const t = m as readonly [Address, Address, Address, bigint, bigint, bigint, bigint, bigint, Hex];
        onchain = { spent: t[7], revokedAt: Number(t[5]) };
      }
    }
    const now = Date.now();
    const sessionToday = this.history.filter((h) => now - Date.parse(h.at) < 86_400_000).reduce((s, h) => s + BigInt(h.price), 0n);
    const pending = cumulative - settled;
    const settledTotal = onchain && onchain.spent > settled ? onchain.spent : settled;
    const total = settledTotal + pending;
    const out: Record<string, unknown> = {
      mandateId: this.mandateId,
      agent: this.address,
      token: this.token,
      spent: { total: this.fmt(total), settled: this.fmt(settledTotal), pending: this.fmt(pending), totalAtomic: total.toString() },
      sessionCalls: this.history.length,
      spentThisSession24h: this.fmt(sessionToday),
    };
    if (pol) {
      const cap = pol.mandate.totalCap;
      const remaining = cap > total ? cap - total : 0n;
      out.totalCap = this.fmt(cap);
      out.remaining = this.fmt(remaining);
      out.remainingAtomic = remaining.toString();
      out.perCallCap = this.fmt(pol.policy.perCallCap);
      out.dailyCap = this.fmt(pol.policy.dailyCap);
      out.maxCallsPerMinute = pol.policy.maxCallsPerMinute === 0 ? "unlimited" : pol.policy.maxCallsPerMinute;
      out.purpose = pol.policy.purpose;
      out.validFrom = new Date(Number(pol.mandate.validAfter) * 1000).toISOString();
      out.expiresAt = new Date(Number(pol.mandate.validUntil) * 1000).toISOString();
      out.allowedPayees = pol.payees;
      out.policyVerified = "mandate, policy and allowlist hash to this mandate id";
    } else out.note = "the node did not serve a verifiable policy for this mandate; caps unknown, payments will be refused by this wallet";
    if (onchain) out.revoked = onchain.revokedAt > 0;
    return out;
  }

  receipts(limit = 10) {
    return this.history
      .slice(-Math.max(1, Math.min(limit, 100)))
      .reverse()
      .map((h) => ({
        callId: h.receipt.callId,
        at: h.at,
        service: h.service,
        url: h.url,
        payee: h.receipt.payee,
        amount: this.fmt(h.receipt.amount),
        cumulative: this.fmt(h.receipt.cumulative),
        leaf: h.receipt.leaf,
        node: h.receipt.node,
      }));
  }

  /** Proves one call against the batch receipts root stored on chain, checking the node's answer independently. */
  async prove(callId: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) throw new Error("callId must be a 0x-prefixed 32-byte id from get_receipts");
    const id = callId.toLowerCase() as Hex;
    const p = await this.node.get(`/v1/receipts/${id}/proof`, proofSchema);
    const mine = this.agent.receipts.get(id) ?? null;
    if (!p.batchId || !p.receiptsRoot) {
      return { callId: id, status: p.status, settled: false, message: "This call is cleared but not settled yet; it lands in the next batch. Ask again after settlement." };
    }
    const r = p.receipt;
    const localProofValid = verifyReceiptProof(
      p.receiptsRoot,
      { callId: r.callId, mandateId: r.mandateId, payee: r.payee, amount: BigInt(r.amount), cumulative: BigInt(r.cumulative), requestHash: r.requestHash, timestamp: BigInt(r.timestamp) },
      p.proof,
    );
    const matchesMyReceipt = mine ? mine.leaf.toLowerCase() === p.leaf.toLowerCase() : null;
    // A root on chain proves nothing by itself (settleBatch is permissionless): the batch must have been settled by
    // this wallet's node operator, and the leaf must carry that operator's signature.
    let independentlyVerifiedOnchain: boolean | null = null;
    let check: Awaited<ReturnType<typeof verifyReceiptOnchain>> | null = null;
    if (this.#public) {
      const operator = await this.agent.nodeOperator();
      check = await verifyReceiptOnchain({ publicClient: this.#public, hub: this.hub, operator, receipt: r, batchId: p.batchId, proof: p.proof }).catch(() => null);
      independentlyVerifiedOnchain = check ? check.verified : null;
    }
    return {
      callId: id,
      status: p.status,
      settled: true,
      batchId: p.batchId,
      batchStatus: p.batchStatus ?? null,
      receiptsRoot: p.receiptsRoot,
      leaf: p.leaf,
      proofLength: p.proof.length,
      proof: p.proof,
      txHash: p.txHash,
      explorerUrl: p.explorerUrl ?? (p.txHash ? explorerOrNull(this.chainId, p.txHash) : null),
      amount: this.fmt(r.amount),
      payee: r.payee,
      nodeSaysVerifiedOnchain: p.onchainVerified,
      independentlyVerifiedOnchain,
      settler: check?.settler ?? null,
      settledByNode: check?.settlerIsNode ?? null,
      nodeSigned: check?.nodeSigned ?? null,
      notVerifiedBecause: check?.reason ?? null,
      localProofValid,
      matchesMyReceipt,
    };
  }
}

function explorerOrNull(chainId: number, hash: string): string | null {
  const base = networkFor(chainId).explorer;
  return base ? `${base}/tx/${hash}` : null;
}
