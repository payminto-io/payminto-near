import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  publicActions,
  recoverMessageAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  decodeHeader,
  EIP712_EOA_PROFILE,
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  hspMandateFromWire,
  hspPaymentId,
  hspTypedData,
  receiptLeaf,
  SCHEME,
  voucherTypedData,
  X402_VERSION,
  DENIAL_RULES,
  knownTokenDomain,
  permitTypedData,
  tokenDomainSeparator,
  type ClearingReceipt,
  type PaymentRequirement,
  type VoucherPayment,
} from "@payminto/protocol";
import { z } from "zod";
import {
  clearingReceiptSchema,
  cosignItemSchema,
  errorSchema,
  infoSchema,
  NodeApiError,
  NodeHttp,
  paymentRequirementSchema,
  paymentRequiredSchema,
  paymentResponseSchema,
  positionSchema,
  type CosignItem,
} from "./node-api.ts";
import { computeRequestHash, Emitter, KeyedMutex, revokeMessage, sleep as defaultSleep } from "./util.ts";
import { checkBeforeSigning, checkSplitBeforeSigning, PolicyMismatchError, verifyMandatePolicy, type MandatePolicy, type VerifiedPolicy } from "./policy-guard.ts";
import { MemoryReceiptStore, SqliteReceiptStore, type ReceiptStore } from "./receipt-store.ts";

const policyBundleSchema = z.object({
  mandate: z.object({
    owner: z.string(),
    agent: z.string(),
    token: z.string(),
    totalCap: z.string().regex(/^\d+$/),
    validAfter: z.string().regex(/^\d+$/),
    validUntil: z.string().regex(/^\d+$/),
    payeesRoot: z.string(),
    policyHash: z.string(),
    salt: z.string(),
  }),
  policy: z.object({ perCallCap: z.string().regex(/^\d+$/), dailyCap: z.string().regex(/^\d+$/), maxCallsPerMinute: z.number().int().min(0), purpose: z.string() }),
  payees: z.array(z.string()),
});

/** A split PAYMENT-RESPONSE: one clearing receipt per voucher. */
const splitResponseSchema = z.object({ receipts: z.array(clearingReceiptSchema).min(1) }).loose();

function refusal(code: string, message: string, details: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ x402Version: X402_VERSION, error: { code, message, details } }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

const eip2612Abi = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export type AgentClientOptions = {
  chainId: number;
  hub: Address;
  /** Agent key. Only signTypedData / signMessage are used; it never leaves the process. */
  account: LocalAccount;
  mandateId: Hex;
  /**
   * The clearing node this agent trusts (required). Positions, the policy and the operator address that must sign
   * receipts are read from here only, never from a provider response or the node a 402 requirement advertises.
   */
  nodeUrl: string;
  /** Start the HSP co-sign loop automatically after the first paid call. */
  autoCosign?: boolean;
  cosignIntervalMs?: number;
  /** STALE_CUMULATIVE retries (default 3). */
  maxRetries?: number;
  /** Refuse requirements above this price (atomic units) without signing. */
  maxPrice?: bigint;
  /** Optional pin of the node operator address. Receipts must be signed by the operator nodeUrl reports in any case. */
  trustedNode?: Address;
  /** Extra HSP verifying contracts the agent accepts besides the hub (coordinator deployments). */
  hspVerifyingContracts?: readonly Address[];
  /**
   * Receipts and signed positions. Defaults to a SqliteReceiptStore at `storePath`, else an in-memory store that is
   * lost on restart (after which the agent refuses to extend positions it no longer remembers signing).
   * Processes sharing one agent key must share one store.
   */
  receipts?: ReceiptStore;
  /** File for a durable SqliteReceiptStore (WAL). Ignored when `receipts` is given. */
  storePath?: string;
  /**
   * The mandate, its policy and allowlist. When omitted the client fetches them from the node
   * (GET /v1/mandates/:id/policy). Either way they are verified against mandateId before use.
   */
  policy?: MandatePolicy;
  /** Enforce the mandate policy before signing (default true). Turning it off leaves enforcement to the node and the hub. */
  enforcePolicy?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ReceiptEvent = { receipt: ClearingReceipt; url: string; price: bigint };
export type DeniedEvent = { code: string; message: string; details?: Record<string, unknown>; url: string; payee?: Address; amount?: bigint };
export type CosignedEvent = { hspPaymentId: Hex; batchId: Hex; amount: bigint; recipient: Address };
export type CosignRefusedEvent = { hspPaymentId: Hex; batchId: Hex; reason: string };

type AgentEvents = {
  receipt: ReceiptEvent;
  denied: DeniedEvent;
  cosigned: CosignedEvent;
  cosignRefused: CosignRefusedEvent;
  error: Error;
};

type PreparedRequest = { url: string; method: string; headers: Headers; body: Uint8Array | undefined };

async function prepare(input: string | URL | Request, init?: RequestInit): Promise<PreparedRequest> {
  if (input instanceof Request) {
    const buf = new Uint8Array(await input.arrayBuffer());
    return { url: input.url, method: input.method, headers: new Headers(input.headers), body: buf.length ? buf : undefined };
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const b = init?.body;
  let body: Uint8Array | undefined;
  if (b === undefined || b === null) body = undefined;
  else if (typeof b === "string") body = new TextEncoder().encode(b);
  else if (b instanceof Uint8Array) body = b;
  else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else if (b instanceof URLSearchParams) {
    body = new TextEncoder().encode(b.toString());
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  } else if (b instanceof Blob) body = new Uint8Array(await b.arrayBuffer());
  else throw new TypeError("AgentClient.fetch supports string, bytes, Blob and URLSearchParams bodies (streams cannot be replayed)");
  return { url: String(input), method, headers, body };
}

/**
 * Agent side of Payminto Clearing: pays x402 `payminto-voucher` requirements with signed cumulative vouchers,
 * verifies every receipt, and co-signs HSP mandates only for net debits its own receipts justify.
 */
export class AgentClient extends Emitter<AgentEvents> {
  readonly chainId: number;
  readonly hub: Address;
  readonly account: LocalAccount;
  readonly mandateId: Hex;
  readonly receipts: ReceiptStore;
  readonly #o: AgentClientOptions;
  readonly #fetch: typeof fetch;
  readonly #mutex = new KeyedMutex();
  readonly #positions = new Map<string, bigint>();
  readonly #handledCosigns = new Set<string>();
  readonly #nodeUrl: string;
  readonly #ownsStore: boolean;
  #policy: Promise<VerifiedPolicy> | null = null;
  #operator: Promise<Address> | null = null;
  /** Highest cumulative ever seen per payee (never forgotten), for the total-cap check. */
  readonly #known = new Map<string, bigint>();
  /** Accepted spend of this client, for the rolling 24 h and per-minute checks. */
  #spendLog: Array<{ at: number; amount: bigint }> = [];
  /** Vouchers being signed or in flight, counted against caps so parallel payees cannot jointly overspend. */
  readonly #reserved = new Map<number, { payee: string; amount: bigint; cumulative: bigint }>();
  #reservationSeq = 0;
  #cosignTimer: ReturnType<typeof setInterval> | null = null;
  #cosignBusy: Promise<unknown> | null = null;

  constructor(o: AgentClientOptions) {
    super();
    this.#o = o;
    this.chainId = o.chainId;
    this.hub = getAddress(o.hub);
    this.account = o.account;
    this.mandateId = o.mandateId.toLowerCase() as Hex;
    if (typeof o.nodeUrl !== "string" || !/^https?:\/\/[^/]/i.test(o.nodeUrl)) {
      throw new TypeError("AgentClient requires nodeUrl: the http(s) URL of the clearing node this agent trusts");
    }
    this.#nodeUrl = o.nodeUrl.replace(/\/+$/, "");
    this.#ownsStore = !o.receipts && !!o.storePath;
    this.receipts = o.receipts ?? (o.storePath ? new SqliteReceiptStore(o.storePath) : new MemoryReceiptStore());
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get address(): Address {
    return this.account.address;
  }

  get nodeUrl(): string {
    return this.#nodeUrl;
  }

  #node(): NodeHttp {
    return new NodeHttp(this.#nodeUrl, { fetch: this.#fetch });
  }

  /**
   * The operator address of the configured node (GET nodeUrl/v1/info, cached), checked against this client's chain
   * and hub and against `trustedNode` when set. Every receipt must be signed by it.
   */
  nodeOperator(): Promise<Address> {
    this.#operator ??= (async () => {
      const info = await this.#node().get("/v1/info", infoSchema);
      if (info.network.chainId !== this.chainId) throw new Error(`node at ${this.#nodeUrl} serves chain ${info.network.chainId}, not ${this.chainId}`);
      if (!isAddressEqual(info.hub, this.hub)) throw new Error(`node at ${this.#nodeUrl} clears hub ${info.hub}, not ${this.hub}`);
      if (this.#o.trustedNode && !isAddressEqual(info.operator, this.#o.trustedNode)) {
        throw new Error(`node operator ${info.operator} is not the pinned trustedNode ${this.#o.trustedNode}`);
      }
      return getAddress(info.operator);
    })();
    this.#operator.catch(() => {
      this.#operator = null; // retry on the next call
    });
    return this.#operator;
  }

  /** Current position for a payee from the node (what the next voucher must extend). */
  async position(payee: Address): Promise<{ cumulative: bigint; settled: bigint }> {
    const p = await this.#node().get(`/v1/mandates/${this.mandateId}/position?payee=${getAddress(payee)}`, positionSchema);
    if (p.mandateId !== this.mandateId || !isAddressEqual(p.payee, payee)) throw new Error("node answered with the position of another mandate or payee");
    return { cumulative: BigInt(p.cumulative), settled: BigInt(p.settled) };
  }

  /**
   * The verified policy this client enforces before signing. Fetched once from the node unless given in the options,
   * and rejected (PolicyMismatchError) unless it hashes to the mandate this client holds.
   */
  loadPolicy(): Promise<VerifiedPolicy> {
    this.#policy ??= (async () => {
      const bundle: MandatePolicy =
        this.#o.policy ??
        ((await this.#node().get(`/v1/mandates/${this.mandateId}/policy`, policyBundleSchema)) as unknown as MandatePolicy);
      return verifyMandatePolicy(this.chainId, this.hub, this.mandateId, bundle);
    })();
    this.#policy.catch(() => {
      this.#policy = null; // retry on the next call
    });
    return this.#policy;
  }

  #learn(key: string, cumulative: bigint): void {
    if (cumulative > (this.#known.get(key) ?? 0n)) this.#known.set(key, cumulative);
  }

  /** Synchronous check-and-reserve: nothing can interleave between the policy decision and the reservation. */
  #reserve(policy: VerifiedPolicy, asset: Address, payee: Address, amount: bigint, cumulative: bigint) {
    const now = Math.floor(Date.now() / 1000);
    const key = payee.toLowerCase();
    this.#spendLog = this.#spendLog.filter((e) => e.at > now - 86_400);
    let otherPayeesTotal = 0n;
    for (const [p, c] of this.#known) if (p !== key) otherPayeesTotal += c;
    let reservedAmount = 0n;
    for (const r of this.#reserved.values()) {
      reservedAmount += r.amount;
      if (r.payee !== key) otherPayeesTotal += r.amount;
    }
    const spentLast24h = this.#spendLog.reduce((s, e) => s + e.amount, 0n) + reservedAmount;
    const callsLastMinute = this.#spendLog.filter((e) => e.at > now - 60).length + this.#reserved.size;
    const denial = checkBeforeSigning({ now, policy, asset, payee, amount, cumulative, otherPayeesTotal, spentLast24h, callsLastMinute });
    if (denial) return { denial, id: null };
    const id = ++this.#reservationSeq;
    this.#reserved.set(id, { payee: key, amount, cumulative });
    return { denial: null, id };
  }

  /**
   * fetch() that pays `payminto-voucher` 402 requirements and returns the provider's response. A 402 that lists two
   * voucher requirements for the same resource and different payees (a gateway payment with a fee: merchant net and
   * platform fee, GATEWAY.md section 14.2) is paid with one voucher per payee, both checked together before signing.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = await prepare(input, init);
    const first = await this.#send(req, null);
    if (first.status !== 402) return first;

    const requirements = await this.#pickRequirements(first);
    if (requirements.length === 0) return first;
    const parts = requirements.map((r) => ({ payee: getAddress(r.payTo), amount: BigInt(r.amount) }));
    const amount = parts.reduce((s, p) => s + p.amount, 0n);
    if (this.#o.maxPrice !== undefined && amount > this.#o.maxPrice) {
      this.emit("denied", { code: "CLIENT_MAX_PRICE", message: `price ${amount} exceeds maxPrice ${this.#o.maxPrice}`, url: req.url, payee: parts[0]!.payee, amount });
      return first;
    }
    const requestHash = computeRequestHash(req.method, req.url, req.body);
    const asset = getAddress(requirements[0]!.asset);
    if (parts.length === 1) {
      const { payee } = parts[0]!;
      return this.#mutex.run(`${this.mandateId}:${payee}`, () => this.#pay(req, payee, amount, requestHash, asset));
    }
    // Lock every payee in a fixed order, so two split payments over the same payees cannot deadlock.
    const keys = parts.map((p) => `${this.mandateId}:${p.payee}`).sort();
    const locked = keys.reduceRight<() => Promise<Response>>((inner, key) => () => this.#mutex.run(key, inner), () => this.#paySplit(req, parts, requestHash, asset));
    return locked();
  }

  /**
   * The payminto-voucher requirements this client pays for this chain and hub. Only price, payee and asset are taken
   * from them: `extra.clearingNode` is ignored, the agent talks to its configured node only. Several requirements are
   * alternatives in x402, except a split: two for the same resource and asset with distinct payees, paid together.
   */
  async #pickRequirements(res: Response): Promise<PaymentRequirement[]> {
    let required = decodeHeader<unknown>(res.headers.get(HEADER_REQUIRED));
    if (!required) required = await res.clone().json().catch(() => null);
    const parsed = paymentRequiredSchema.safeParse(required);
    if (!parsed.success) return [];
    const mine: PaymentRequirement[] = [];
    for (const a of parsed.data.accepts) {
      const r = paymentRequirementSchema.safeParse(a);
      if (!r.success) continue;
      if (r.data.scheme !== SCHEME || r.data.network !== `eip155:${this.chainId}`) continue;
      if (!isAddressEqual(r.data.extra.clearingHub, this.hub)) continue;
      mine.push(r.data as PaymentRequirement);
    }
    const [head, second] = mine;
    if (!head) return [];
    const split =
      mine.length === 2 &&
      second!.resource === head.resource &&
      isAddressEqual(second!.asset, head.asset) &&
      !isAddressEqual(second!.payTo, head.payTo);
    return split ? mine : [head];
  }

  #send(req: PreparedRequest, payment: string | null): Promise<Response> {
    const headers = new Headers(req.headers);
    if (payment) headers.set(HEADER_SIGNATURE, payment);
    return this.#fetch(req.url, { method: req.method, headers, body: req.body as BodyInit | undefined });
  }

  async #pay(req: PreparedRequest, payee: Address, amount: bigint, requestHash: Hex, asset: Address): Promise<Response> {
    const key = payee.toLowerCase();
    const maxRetries = this.#o.maxRetries ?? 3;
    const sleep = this.#o.sleep ?? defaultSleep;
    const random = this.#o.random ?? Math.random;
    const enforce = this.#o.enforcePolicy !== false;
    let policy: VerifiedPolicy | null = null;
    if (enforce) {
      try {
        policy = await this.loadPolicy();
      } catch (err) {
        // Fail closed: without a verified policy the agent does not sign.
        const code = err instanceof PolicyMismatchError ? "POLICY_MISMATCH" : "POLICY_UNAVAILABLE";
        const message = err instanceof Error ? err.message : String(err);
        this.emit("denied", { code, message, url: req.url, payee, amount, details: { enforcedBy: "agent" } });
        return refusal(code, message, { enforcedBy: "agent" });
      }
    }
    for (const [p, c] of this.receipts.signedPositions(this.mandateId)) this.#learn(p, c);
    let position: bigint = this.#positions.get(key) ?? (await this.position(payee)).cumulative;

    let reservation: number | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        // Never extend a position this agent did not sign itself: a voucher is bounded by its own high-water mark.
        const signed = this.receipts.signedPosition(this.mandateId, payee);
        if (position > signed) {
          this.#positions.delete(key);
          const details = { reported: position.toString(), signed: signed.toString(), enforcedBy: "agent" };
          this.emit("denied", { code: "POSITION_UNVERIFIED", message: DENIAL_RULES.POSITION_UNVERIFIED, details, url: req.url, payee, amount });
          return refusal("POSITION_UNVERIFIED", DENIAL_RULES.POSITION_UNVERIFIED, details);
        }
        this.#learn(key, position);
        const cumulative = position + amount;
        if (policy) {
          if (reservation !== null) this.#reserved.delete(reservation);
          reservation = null;
          const r = this.#reserve(policy, asset, payee, amount, cumulative);
          if (r.denial) {
            const d = r.denial;
            this.emit("denied", { code: d.code, message: d.message, details: d.details, url: req.url, payee, amount });
            return refusal(d.code, d.message, d.details);
          }
          reservation = r.id;
        }
        const res = await this.#attempt(req, payee, amount, requestHash, cumulative);
        if (res.kind === "paid") {
          this.#spendLog.push({ at: Math.floor(Date.now() / 1000), amount });
          return res.response;
        }
        if (res.kind !== "stale") return res.response;
        if (attempt >= maxRetries) {
          this.#positions.delete(key);
          this.emit("denied", { code: "STALE_CUMULATIVE", message: res.message, details: res.details, url: req.url, payee, amount });
          return res.response;
        }
        // Re-read from the configured node only; a position in the provider's 402 body is never trusted.
        this.#positions.delete(key);
        position = (await this.position(payee)).cumulative;
        this.#positions.set(key, position);
        // Jittered backoff: 25-75 ms, doubling per attempt, so racing processes spread out.
        await sleep(Math.round((25 + random() * 50) * 2 ** attempt));
      }
    } finally {
      if (reservation !== null) this.#reserved.delete(reservation);
    }
  }

  /**
   * Check-and-reserve for a split payment, all or nothing: the combined price against the per-call cap (it is one
   * purchase), then each voucher against every other rule with the earlier ones already reserved, so the two payees
   * cannot jointly pass a total or daily cap that each alone would pass.
   */
  #reserveSplit(policy: VerifiedPolicy, asset: Address, parts: Array<{ payee: Address; amount: bigint; cumulative: bigint }>) {
    const combined = checkSplitBeforeSigning({ policy, amounts: parts.map((p) => p.amount) });
    if (combined) return { denial: combined, ids: [] as number[] };
    const ids: number[] = [];
    for (const p of parts) {
      const r = this.#reserve(policy, asset, p.payee, p.amount, p.cumulative);
      if (r.denial) {
        for (const id of ids) this.#reserved.delete(id);
        return { denial: r.denial, ids: [] as number[] };
      }
      ids.push(r.id!);
    }
    return { denial: null, ids };
  }

  /**
   * Pays a split requirement (merchant net plus platform fee) with one voucher per payee in one PAYMENT-SIGNATURE.
   * Nothing is signed unless every voucher passes the policy guard; the node accepts both or answers 402.
   */
  async #paySplit(req: PreparedRequest, parts: Array<{ payee: Address; amount: bigint }>, requestHash: Hex, asset: Address): Promise<Response> {
    const total = parts.reduce((s, p) => s + p.amount, 0n);
    const maxRetries = this.#o.maxRetries ?? 3;
    const sleep = this.#o.sleep ?? defaultSleep;
    const random = this.#o.random ?? Math.random;
    const deny = (code: string, message: string, details: Record<string, unknown> | undefined, payee: Address) => {
      this.emit("denied", { code, message, details, url: req.url, payee, amount: total });
    };
    let policy: VerifiedPolicy | null = null;
    if (this.#o.enforcePolicy !== false) {
      try {
        policy = await this.loadPolicy();
      } catch (err) {
        const code = err instanceof PolicyMismatchError ? "POLICY_MISMATCH" : "POLICY_UNAVAILABLE";
        const message = err instanceof Error ? err.message : String(err);
        deny(code, message, { enforcedBy: "agent" }, parts[0]!.payee);
        return refusal(code, message, { enforcedBy: "agent" });
      }
    }
    for (const [p, c] of this.receipts.signedPositions(this.mandateId)) this.#learn(p, c);
    const positionOf = async (payee: Address) => this.#positions.get(payee.toLowerCase()) ?? (await this.position(payee)).cumulative;
    const positions = new Map<string, bigint>();
    for (const p of parts) positions.set(p.payee.toLowerCase(), await positionOf(p.payee));

    let reservations: number[] = [];
    const release = () => {
      for (const id of reservations) this.#reserved.delete(id);
      reservations = [];
    };
    try {
      for (let attempt = 0; ; attempt++) {
        const signedParts: Array<{ payee: Address; amount: bigint; cumulative: bigint }> = [];
        for (const p of parts) {
          const key = p.payee.toLowerCase();
          const position = positions.get(key)!;
          // Never extend a position this agent did not sign itself.
          const signed = this.receipts.signedPosition(this.mandateId, p.payee);
          if (position > signed) {
            this.#positions.delete(key);
            const details = { payee: p.payee, reported: position.toString(), signed: signed.toString(), enforcedBy: "agent" };
            deny("POSITION_UNVERIFIED", DENIAL_RULES.POSITION_UNVERIFIED, details, p.payee);
            return refusal("POSITION_UNVERIFIED", DENIAL_RULES.POSITION_UNVERIFIED, details);
          }
          this.#learn(key, position);
          signedParts.push({ ...p, cumulative: position + p.amount });
        }
        if (policy) {
          release();
          const r = this.#reserveSplit(policy, asset, signedParts);
          if (r.denial) {
            const d = r.denial;
            deny(d.code, d.message, d.details, parts[0]!.payee);
            return refusal(d.code, d.message, d.details);
          }
          reservations = r.ids;
        }

        const vouchers: VoucherPayment[] = [];
        for (const p of signedParts) {
          // Write-ahead: every high-water mark is durable before any signature exists.
          this.receipts.recordSigned(this.mandateId, p.payee, p.cumulative);
          this.#learn(p.payee.toLowerCase(), p.cumulative);
        }
        for (const p of signedParts) {
          const signature = await this.account.signTypedData(voucherTypedData(this.chainId, this.hub, { mandateId: this.mandateId, payee: p.payee, cumulative: p.cumulative }));
          vouchers.push({
            x402Version: X402_VERSION,
            scheme: SCHEME,
            network: `eip155:${this.chainId}`,
            payload: { mandateId: this.mandateId, payee: p.payee, amount: p.amount.toString(), cumulative: p.cumulative.toString(), signature, requestHash },
          });
        }
        const res = await this.#send(req, encodeHeader({ vouchers }));
        const paid = decodeHeader<unknown>(res.headers.get(HEADER_RESPONSE));
        if (paid) {
          const at = Math.floor(Date.now() / 1000);
          const listed = splitResponseSchema.safeParse(paid);
          const receipts = listed.success ? (listed.data.receipts as ClearingReceipt[]) : [];
          for (const p of signedParts) {
            this.#positions.set(p.payee.toLowerCase(), p.cumulative);
            this.#spendLog.push({ at, amount: p.amount });
            const r = receipts.find((x) => isAddressEqual(x.payee, p.payee) && BigInt(x.cumulative) === p.cumulative);
            if (!r) {
              this.emit("error", new Error(`provider returned no receipt for the voucher to ${p.payee}`));
              continue;
            }
            await this.#acceptVerified(r, { payee: p.payee, amount: p.amount, cumulative: p.cumulative, requestHash, url: req.url });
          }
          return res;
        }
        if (res.status !== 402) {
          // Unknown outcome: the signed cumulatives count as exposure and positions are re-read next time.
          for (const p of signedParts) this.#positions.delete(p.payee.toLowerCase());
          return res;
        }
        const denial = errorSchema.safeParse(await res.clone().json().catch(() => null));
        const code = denial.success ? denial.data.error.code : "PAYMENT_REQUIRED";
        const details = denial.success ? denial.data.error.details : undefined;
        const message = denial.success ? denial.data.error.message : "payment required";
        if (code !== "STALE_CUMULATIVE") {
          deny(code, message, details, parts[0]!.payee);
          return res;
        }
        // The node books a pair atomically (GATEWAY.md section 15), so a denied pair paid nothing: re-read every
        // position from the configured node and re-sign the whole pair on top of them.
        for (const p of signedParts) {
          this.#positions.delete(p.payee.toLowerCase());
          positions.set(p.payee.toLowerCase(), (await this.position(p.payee)).cumulative);
        }
        if (attempt >= maxRetries) {
          deny("STALE_CUMULATIVE", message, details, parts[0]!.payee);
          return res;
        }
        await sleep(Math.round((25 + random() * 50) * 2 ** attempt));
      }
    } finally {
      release();
    }
  }

  /** Signs one voucher and sends it. "stale" means the node asked for a re-sign at a newer position. */
  async #attempt(
    req: PreparedRequest,
    payee: Address,
    amount: bigint,
    requestHash: Hex,
    cumulative: bigint,
  ): Promise<
    | { kind: "paid" | "done"; response: Response }
    | { kind: "stale"; response: Response; message: string; details?: Record<string, unknown> }
  > {
    const key = payee.toLowerCase();
    {
      // Write-ahead: the high-water mark is durable before the signature exists.
      this.receipts.recordSigned(this.mandateId, payee, cumulative);
      this.#learn(key, cumulative);
      const signature = await this.account.signTypedData(
        voucherTypedData(this.chainId, this.hub, { mandateId: this.mandateId, payee, cumulative }),
      );
      const payment: VoucherPayment = {
        x402Version: X402_VERSION,
        scheme: SCHEME,
        network: `eip155:${this.chainId}`,
        payload: { mandateId: this.mandateId, payee, amount: amount.toString(), cumulative: cumulative.toString(), signature, requestHash },
      };
      const res = await this.#send(req, encodeHeader(payment));
      const paid = decodeHeader<unknown>(res.headers.get(HEADER_RESPONSE));
      if (paid) {
        this.#positions.set(key, cumulative);
        this.#learn(key, cumulative);
        await this.#acceptReceipt(paid, { payee, amount, cumulative, requestHash, url: req.url });
        return { kind: "paid", response: res };
      }
      if (res.status !== 402) {
        // Unknown payment outcome: count the signed cumulative as exposure and resync the position next time.
        this.#learn(key, cumulative);
        this.#positions.delete(key);
        return { kind: "done", response: res };
      }
      const denial = errorSchema.safeParse(await res.clone().json().catch(() => null));
      const code = denial.success ? denial.data.error.code : "PAYMENT_REQUIRED";
      const details = denial.success ? denial.data.error.details : undefined;
      const message = denial.success ? denial.data.error.message : "payment required";
      if (code === "STALE_CUMULATIVE") return { kind: "stale", response: res, message, details };
      this.emit("denied", { code, message, details, url: req.url, payee, amount });
      return { kind: "done", response: res };
    }
  }

  async #acceptReceipt(raw: unknown, expect: { payee: Address; amount: bigint; cumulative: bigint; requestHash: Hex; url: string }): Promise<void> {
    const parsed = paymentResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.emit("error", new Error("provider returned a malformed PAYMENT-RESPONSE"));
      return;
    }
    await this.#acceptVerified(parsed.data.receipt as ClearingReceipt, expect);
  }

  /** Verifies one receipt and stores it; an unverifiable receipt is reported and dropped. */
  async #acceptVerified(r: ClearingReceipt, expect: { payee: Address; amount: bigint; cumulative: bigint; requestHash: Hex; url: string }): Promise<boolean> {
    const problem = await this.#verifyReceipt(r, expect).catch((err: unknown) => String(err));
    if (problem) {
      // Not stored: an unverifiable receipt can never justify an HSP co-signature.
      this.emit("error", new Error(`receipt rejected: ${problem}`));
      return false;
    }
    this.receipts.add(r);
    this.emit("receipt", { receipt: r, url: expect.url, price: expect.amount });
    if (this.#o.autoCosign && !this.#cosignTimer) this.startCosignLoop();
    return true;
  }

  async #verifyReceipt(
    r: ClearingReceipt,
    e: { payee: Address; amount: bigint; cumulative: bigint; requestHash: Hex },
  ): Promise<string | null> {
    if (r.mandateId.toLowerCase() !== this.mandateId) return "mandate mismatch";
    if (!isAddressEqual(r.payee, e.payee)) return "payee mismatch";
    if (BigInt(r.amount) !== e.amount || BigInt(r.cumulative) !== e.cumulative) return "amount mismatch";
    if (r.requestHash.toLowerCase() !== e.requestHash.toLowerCase()) return "request hash mismatch";
    const leaf = receiptLeaf({
      callId: r.callId,
      mandateId: r.mandateId,
      payee: r.payee,
      amount: BigInt(r.amount),
      cumulative: BigInt(r.cumulative),
      requestHash: r.requestHash,
      timestamp: BigInt(r.timestamp),
    });
    if (leaf.toLowerCase() !== r.leaf.toLowerCase()) return "leaf mismatch";
    const operator = await this.nodeOperator().catch(() => null);
    if (!operator) return "cannot read the operator of the configured node";
    const signer = await recoverMessageAddress({ message: { raw: r.leaf }, signature: r.nodeSignature }).catch(() => null);
    if (!signer || !isAddressEqual(signer, operator)) return "not signed by the configured node operator";
    if (!isAddressEqual(r.node, operator)) return "receipt names another node";
    return null;
  }

  /** Approves the hub to pull up to `amount` from the agent wallet (net settlement uses transferFrom). */
  async ensureAllowance(
    walletClient: WalletClient<Transport, Chain | undefined, Account>,
    amount: bigint,
    opts: { token?: Address; publicClient?: PublicClient } = {},
  ): Promise<Hex | null> {
    if (!isAddressEqual(walletClient.account.address, this.address)) throw new Error("walletClient account is not the agent account");
    const token = opts.token ?? (await this.#node().get("/v1/info", infoSchema)).token.address;
    const reader = opts.publicClient ?? walletClient.extend(publicActions);
    const current = await reader.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.address, this.hub] });
    if (current >= amount) return null;
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.hub, amount],
      chain: walletClient.chain ?? null,
      account: walletClient.account,
    });
    const rcpt = await reader.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`approve reverted in ${hash}`);
    return hash;
  }

  /**
   * Gasless onboarding: signs an EIP-2612 permit that lets the hub pull up to `value` from this agent's wallet. The
   * owner hands it to the node with the mandate (OwnerClient.submit({ permit })), the node opens the mandate with
   * openMandateWithPermit and pays the gas, so the agent needs no HSK and sends no transaction. Reads only: the
   * token's permit nonce and DOMAIN_SEPARATOR, which must equal the domain the agent signs under (chains.ts for the
   * network token, so USDC.e signs as "Bridged USDC" version "2"; otherwise the token's ERC-5267 eip712Domain()).
   */
  async signPermit(args: {
    token: Address;
    value: bigint;
    publicClient: PublicClient;
    /** Unix seconds; default one hour from now. */
    deadline?: bigint;
    /** Override the token's EIP-712 name and version. */
    domain?: { name: string; version: string };
  }): Promise<{ value: bigint; deadline: bigint; signature: Hex }> {
    const token = getAddress(args.token);
    const pc = args.publicClient;
    let domain = args.domain ?? knownTokenDomain(this.chainId, token);
    if (!domain) {
      const d = await pc.getEip712Domain({ address: token }).catch(() => null);
      if (!d?.domain.name || !d.domain.version) throw new Error(`token ${token} has no known EIP-712 domain; pass signPermit({ domain })`);
      domain = { name: d.domain.name, version: d.domain.version };
    }
    const onchain = await pc.readContract({ address: token, abi: eip2612Abi, functionName: "DOMAIN_SEPARATOR" });
    if (onchain.toLowerCase() !== tokenDomainSeparator(this.chainId, token, domain).toLowerCase()) {
      throw new Error(`EIP-712 domain ${domain.name} v${domain.version} does not match ${token}.DOMAIN_SEPARATOR(); refusing to sign a permit the token would reject`);
    }
    const nonce = await pc.readContract({ address: token, abi: eip2612Abi, functionName: "nonces", args: [this.address] });
    const deadline = args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const signature = await this.account.signTypedData(
      permitTypedData(
        { name: domain.name, version: domain.version, chainId: this.chainId, verifyingContract: token },
        { owner: this.address, spender: this.hub, value: args.value, nonce, deadline },
      ),
    );
    return { value: args.value, deadline, signature };
  }

  /** Revokes this mandate at the node (agent-signed), stopping new vouchers immediately. */
  async revoke(): Promise<unknown> {
    const signature = await this.account.signMessage({ message: revokeMessage(this.mandateId) });
    return this.#node().post(`/v1/mandates/${this.mandateId}/revoke`, z.unknown(), { signature });
  }

  // ------------------------------------------------------------------ HSP co-sign

  /**
   * Decides whether to co-sign an HSP mandate. Refuses anything not addressed to this agent, not bound to the
   * stated batch, signed under an unexpected domain, or whose amount exceeds what this agent's own verified
   * receipts in that batch add up to (defence against a malicious node).
   */
  checkCosign(item: CosignItem): { ok: true; justified: bigint } | { ok: false; reason: string } {
    const td = item.typedData;
    const body = hspMandateFromWire(td.message);
    if (td.domain.chainId !== this.chainId || body.chainId !== BigInt(this.chainId)) return { ok: false, reason: "wrong chain" };
    const allowedVc = [this.hub, ...(this.#o.hspVerifyingContracts ?? [])];
    if (!allowedVc.some((a) => isAddressEqual(a, td.domain.verifyingContract))) return { ok: false, reason: "unexpected verifying contract" };
    if (body.signer.profileId.toLowerCase() !== EIP712_EOA_PROFILE.toLowerCase()) return { ok: false, reason: "unexpected signer profile" };
    const payer = getAddress(`0x${body.signer.payload.slice(-40)}`);
    if (!isAddressEqual(payer, this.address) || !isAddressEqual(item.payer, this.address)) return { ok: false, reason: "not addressed to this agent" };
    if (body.settlementBinding.toLowerCase() !== item.batchId.toLowerCase()) return { ok: false, reason: "settlementBinding is not the batch id" };
    if (body.amount !== BigInt(item.amount)) return { ok: false, reason: "amount differs from the typed data" };
    if (hspPaymentId(this.chainId, td.domain.verifyingContract, body).toLowerCase() !== item.hspPaymentId.toLowerCase()) {
      return { ok: false, reason: "hspPaymentId does not match the mandate" };
    }
    const batch = item.batchId.toLowerCase();
    let justified = 0n;
    for (const c of item.calls) {
      const mine = this.receipts.get(c.callId);
      if (!mine || mine.mandateId.toLowerCase() !== this.mandateId) continue;
      const usedFor = this.receipts.batchOf(c.callId);
      if (usedFor !== undefined && usedFor !== batch) continue;
      justified += BigInt(mine.amount);
    }
    const already = this.receipts.cosignedInBatch(item.batchId);
    if (already + body.amount > justified) {
      return { ok: false, reason: `co-signing ${body.amount} would exceed this agent's receipts in the batch (${justified}, already co-signed ${already})` };
    }
    return { ok: true, justified };
  }

  /** One co-sign pass: fetches pending HSP mandates for this agent, checks and signs them. */
  async cosignOnce(): Promise<{ signed: Hex[]; refused: Array<{ hspPaymentId: Hex; reason: string }> }> {
    const run = async () => {
      const items = await this.#node().get(`/v1/agents/${this.address}/cosign`, z.array(z.unknown()));
      const signed: Hex[] = [];
      const refused: Array<{ hspPaymentId: Hex; reason: string }> = [];
      for (const raw of items) {
        const parsed = cosignItemSchema.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data;
        // Only the mandate this client holds receipts for: other clients of the same wallet handle theirs.
        if (!item.calls.some((c) => c.mandateId === this.mandateId)) continue;
        if (this.#handledCosigns.has(item.hspPaymentId)) continue;
        const verdict = this.checkCosign(item);
        this.#handledCosigns.add(item.hspPaymentId);
        if (!verdict.ok) {
          refused.push({ hspPaymentId: item.hspPaymentId, reason: verdict.reason });
          this.emit("cosignRefused", { hspPaymentId: item.hspPaymentId, batchId: item.batchId, reason: verdict.reason });
          continue;
        }
        const body = hspMandateFromWire(item.typedData.message);
        const signerProof = await this.account.signTypedData(hspTypedData(this.chainId, item.typedData.domain.verifyingContract, body));
        try {
          await this.#node().post(`/v1/cosign/${item.hspPaymentId}`, z.unknown(), { signerProof });
          const mine = item.calls.filter((c) => this.receipts.get(c.callId)).map((c) => c.callId);
          this.receipts.recordCosign(item.batchId, body.amount, mine);
          signed.push(item.hspPaymentId);
          this.emit("cosigned", { hspPaymentId: item.hspPaymentId, batchId: item.batchId, amount: body.amount, recipient: item.recipient });
        } catch (err) {
          if (!(err instanceof NodeApiError && err.code === "COSIGN_CLOSED")) this.#handledCosigns.delete(item.hspPaymentId);
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
      return { signed, refused };
    };
    // Never run two passes at once.
    const prev = this.#cosignBusy ?? Promise.resolve();
    const next = prev.then(run, run);
    this.#cosignBusy = next.catch(() => undefined);
    return next;
  }

  startCosignLoop(intervalMs = this.#o.cosignIntervalMs ?? 1_000): void {
    if (this.#cosignTimer) return;
    this.#cosignTimer = setInterval(() => {
      this.cosignOnce().catch((err: unknown) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
    }, intervalMs);
    (this.#cosignTimer as { unref?: () => void }).unref?.();
  }

  stopCosignLoop(): void {
    if (this.#cosignTimer) clearInterval(this.#cosignTimer);
    this.#cosignTimer = null;
  }

  /** Stops the co-sign loop and closes the receipt store if this client opened it (`storePath`). */
  close(): void {
    this.stopCosignLoop();
    if (this.#ownsStore) this.receipts.close?.();
  }
}
