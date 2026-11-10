import {
  AGENT_ONLY_RULES,
  clearingReceiptSchema,
  DENIAL_RULES,
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  nodeDigest,
  paymentRequiredSchema,
  parsePaymentRequired,
  parsePaymentResponse,
  parseValue,
  refusalSchema,
  signDigest,
  verifyDigest,
  voucherDigest,
  voucherRequirements,
  X402_VERSION,
  type AccountId,
  type ClearingReceipt,
  type DenialRule,
  type Id32,
  type Keypair,
  type Network,
  type PaymentPayload,
  type PublicKey,
  type RefusalWire as Refusal,
  type ResourceInfo,
  type RetryHint,
  type SettlementSuccess,
  type VoucherFields,
  type VoucherRequirement,
} from "@payminto/protocol";
import { z } from "zod";
import { infoSchema, NodeApiError, NodeHttp, positionSchema, zAccount, zId32, zPublicKey, zUint, type NodeInfo } from "./node-api.ts";
import { checkBeforeSigning, checkSplitBeforeSigning, PolicyMismatchError, verifyBudgetPolicy, type BudgetPolicy, type VerifiedPolicy } from "./policy-guard.ts";
import { MemoryReceiptStore, SqliteReceiptStore, type ReceiptStore } from "./receipt-store.ts";
import { SpendLog, type SignedVoucher } from "./spend-log.ts";
import { callIdOf, cleanText, computeRequestHash, Emitter, KeyedMutex, revokeDigest, sleep as defaultSleep } from "./util.ts";

const policyBundleSchema = z.object({
  budget: z.object({
    owner: zAccount,
    agentPk: zPublicKey,
    settler: zAccount,
    cap: zUint,
    validUntil: zUint,
    payees: z.array(zAccount),
    policyHash: zId32,
    salt: zId32,
  }),
  policy: z.object({
    perCallCap: zUint,
    dailyCap: zUint,
    hourlyCap: zUint.optional(),
    maxCallsPerMinute: z.number().int().min(0),
    maxRepeatsPerRequest: z.number().int().min(0).optional(),
    purpose: z.string(),
  }),
});

/** A 402 this client answers itself: nothing was signed or nothing was paid. Carries the machine-readable refusal. */
function refusal(r: Refusal, details: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ x402Version: X402_VERSION, success: false, errorReason: r.rule, error: { code: r.rule, message: r.message, details }, refusal: r }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/** The parsed success PAYMENT-RESPONSE; "absent" without one; "malformed" for one that claims payment but does not parse. A 402 is never a payment. */
function paidHeader(res: Response): SettlementSuccess | "absent" | "malformed" {
  if (res.status === 402) return "absent";
  const raw = res.headers.get(HEADER_RESPONSE);
  if (!raw) return "absent";
  const parsed = parsePaymentResponse(raw);
  if (!parsed.ok) return "malformed";
  return parsed.value.success ? parsed.value : "absent";
}

/** The offer this client pays: one voucher requirement and the resource it is for. */
type Offer = { requirement: VoucherRequirement; resource: ResourceInfo };

/** What `beforeSign` is asked, once per payee of an offer, before any voucher of that offer is signed. */
export type BeforeSignRequest = {
  /** Who pays: the Budget's owner, from the terms this client verified against the Budget id. */
  payer: AccountId;
  payee: AccountId;
  /** This payee's part of the offer, atomic units. */
  amount: bigint;
  /** The whole offer, every payee together, atomic units. A refusal reports this as the attempted amount. */
  total: bigint;
  /** The Budget's allowed payees, from the verified terms. Empty means any payee. */
  budgetPayees: readonly AccountId[];
  /** The requirement this client accepted from the seller's 402: what it would sign for. */
  requirement: VoucherRequirement;
  url: string;
  budgetId: Id32;
};

/** A refusal from `beforeSign`. It becomes the client's own structured refusal, with this rule, message and retry hint. */
export type BeforeSignRefusal = { rule: string; message: string; retry: RetryHint; details?: Record<string, unknown> };

/**
 * Asked before any voucher of an offer is signed. Null (or nothing) lets the client go on to its own checks and sign;
 * a refusal stops the call, and nothing is signed. A hook that throws refuses the call as well: it fails closed.
 */
export type BeforeSign = (request: BeforeSignRequest) => BeforeSignRefusal | null | undefined | Promise<BeforeSignRefusal | null | undefined>;

/** Seconds a caller is told to wait when the `beforeSign` hook itself failed. */
const BEFORE_SIGN_RETRY_SEC = 30;

export type AgentClientOptions = {
  network: Network;
  hub: AccountId;
  /** The bare ed25519 agent key. It has no NEAR account and no gas; it never leaves the process. */
  keypair: Keypair;
  budgetId: Id32;
  /**
   * The clearing node this agent trusts (required). Positions, the policy and the key that must sign receipts are read
   * from here only, never from a provider response or the node a 402 requirement advertises.
   */
  nodeUrl: string;
  /** STALE_CUMULATIVE retries (default 3). */
  maxRetries?: number;
  /** Refuse requirements above this price (atomic units) without signing. `pay()` can lower it for one call. */
  maxPrice?: bigint;
  /**
   * Pay under a Budget whose payee list is empty, which on chain means any payee (default false: such a Budget pays
   * nobody). Set it only when the owner really meant "any payee".
   */
  allowAnyPayee?: boolean;
  /** Optional pin of the node's receipt key. Receipts must be signed by the key nodeUrl reports in any case. */
  trustedNodeKey?: PublicKey;
  /**
   * Receipts and signed positions. Defaults to a SqliteReceiptStore at `storePath`, else an in-memory store that is
   * lost on restart (after which the agent refuses to extend positions it no longer remembers signing).
   * Processes sharing one agent key must share one store.
   */
  receipts?: ReceiptStore;
  /** File for a durable SqliteReceiptStore (WAL). Ignored when `receipts` is given. */
  storePath?: string;
  /**
   * The Budget terms and policy. When omitted the client fetches them from the node (GET /v1/budgets/:id/policy).
   * Either way they are verified against budgetId before use.
   */
  policy?: BudgetPolicy;
  /** Enforce the Budget policy before signing (default true). Turning it off leaves enforcement to the node and the hub. */
  enforcePolicy?: boolean;
  /**
   * Asked about every payee of an offer before any voucher is signed, after the client's maximum price and before its
   * Budget rules. A refusal becomes the client's structured refusal and nothing is signed. The Budget's terms are
   * verified first, whatever `enforcePolicy` says, because the hook is told who pays and which payees are allowed.
   */
  beforeSign?: BeforeSign;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ReceiptEvent = { receipt: ClearingReceipt; url: string; price: bigint };

/**
 * Who says a payment was refused.
 * "agent": this client refused before signing, from the Budget policy it verified itself. Nothing was signed.
 * "seller": a seller's 402 said so after a voucher was sent. The seller may be relaying its clearing node faithfully,
 * but nothing in the answer is signed, so it is not proof of the owner's policy and not proof that nothing was paid.
 */
export type RefusalSource = "agent" | "seller";

export type DeniedEvent = {
  /** A rule in DENIAL_RULES or an agent-side rule. A seller's code outside DENIAL_RULES is reported as SELLER_REFUSED. */
  code: string;
  /** This client's own text for the code, never the seller's. */
  message: string;
  source: RefusalSource;
  /** Present only for refusals this client decided itself. */
  details?: Record<string, unknown>;
  refusal?: Refusal;
  /** What the seller wrote, cleaned and capped: untrusted data. */
  sellerCode?: string;
  sellerText?: string;
  url: string;
  payee?: AccountId;
  amount?: bigint;
};

/**
 * What became of one voucher a call signed.
 * "paid": this agent's node booked it and its signed receipt verified.
 * "void": this agent's node moved to or past its cumulative without booking it, so it can collect nothing more.
 * "unverified": signed and sent, and not confirmed either way. The seller holds a voucher it can still collect,
 * through the node while the position matches or on the hub with `settle_own`. Treat the amount as possibly spent.
 */
export type VoucherState = "paid" | "void" | "unverified";

export type VoucherOutcome = {
  payee: AccountId;
  amount: bigint;
  cumulative: bigint;
  callId: Id32;
  state: VoucherState;
  /** The node's receipt, for a paid voucher. */
  receipt: ClearingReceipt | null;
  /** Why an unverified voucher is unverified. */
  note: string | null;
};

export type PaymentRefusal = {
  source: RefusalSource;
  code: string;
  message: string;
  refusal: Refusal | null;
  /** Present only for refusals this client decided itself. */
  details?: Record<string, unknown>;
  sellerCode: string | null;
  sellerText: string | null;
};

/** What one call paid, known from this client and its own node only, never from the seller's word. */
export type PaymentOutcome = {
  /**
   * "none": nothing was signed, or every voucher signed is void. Nothing was paid.
   * "paid": at least one voucher is booked on this agent's node and none is unverified.
   * "unverified": at least one voucher was signed and sent with its outcome unknown. Never report it as unpaid.
   */
  status: "none" | "paid" | "unverified";
  /** Sum of the paid vouchers, atomic units. */
  paid: bigint;
  /** Sum of the unverified vouchers, atomic units. */
  unverified: bigint;
  vouchers: VoucherOutcome[];
  /** Set when the call was refused. A seller's refusal can stand next to a paid voucher: the seller's word is not the node's. */
  refusal: PaymentRefusal | null;
};

export type PaidResponse = { response: Response; payment: PaymentOutcome };

/**
 * `pay()` could not finish (the seller or the node was unreachable, or the request could not be built). It still says
 * what the call paid: a request that dies after a voucher left the process is unverified, not unpaid.
 */
export class PayFailed extends Error {
  readonly payment: PaymentOutcome;
  constructor(cause: unknown, payment: PaymentOutcome) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PayFailed";
    this.payment = payment;
  }
}

type AgentEvents = {
  receipt: ReceiptEvent;
  denied: DeniedEvent;
  error: Error;
};

/** The vouchers and the refusal of one call, gathered while it runs. */
class Trace {
  readonly #vouchers = new Map<Id32, VoucherOutcome>();
  refusal: PaymentRefusal | null = null;

  set(v: SignedVoucher, r: Pick<Resolved, "state" | "receipt" | "note">): void {
    this.#vouchers.set(v.callId, { payee: v.payee, amount: v.amount, cumulative: v.cumulative, callId: v.callId, state: r.state, receipt: r.receipt, note: r.note });
  }

  outcome(): PaymentOutcome {
    const vouchers = [...this.#vouchers.values()];
    const sum = (state: VoucherState) => vouchers.reduce((s, v) => (v.state === state ? s + v.amount : s), 0n);
    const paid = sum("paid");
    const unverified = sum("unverified");
    return { status: unverified > 0n ? "unverified" : paid > 0n ? "paid" : "none", paid, unverified, vouchers, refusal: this.refusal };
  }
}

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

/** Rules a clearing node can give. A seller can only relay these; anything else is its own word. */
const NODE_RULES: ReadonlySet<string> = new Set(Object.keys(DENIAL_RULES).filter((r) => !(AGENT_ONLY_RULES as readonly string[]).includes(r)));

const sellerErrorSchema = z.object({ error: z.object({ code: z.unknown(), message: z.unknown() }).loose(), refusal: refusalSchema.optional().catch(undefined) }).loose();

type SellerDenial = { code: string; message: string; refusal: Refusal | null; sellerCode: string | null; sellerText: string | null };

/**
 * What a seller's 402 says about a payment it was sent, reduced to what is safe to repeat. Nothing in the answer is
 * signed, so only a rule code from DENIAL_RULES is kept as a code, with this client's own text for it; any other code
 * becomes SELLER_REFUSED. The seller's own words survive only as `sellerCode` and `sellerText`, cleaned and capped,
 * for a caller to show as unauthenticated seller text. Free-form `details` are dropped.
 */
async function sellerDenial(res: Response): Promise<SellerDenial> {
  let code: unknown;
  let text: unknown;
  let relayed: Refusal | undefined;
  const body = sellerErrorSchema.safeParse(await res.clone().json().catch(() => null));
  if (body.success) {
    code = body.data.error.code;
    text = body.data.error.message;
    relayed = body.data.refusal;
  } else {
    const header = parsePaymentResponse(res.headers.get(HEADER_RESPONSE));
    if (header.ok && !header.value.success) {
      code = header.value.errorReason;
      text = header.value.refusal?.message;
      relayed = header.value.refusal;
    }
  }
  const sellerCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
  const sellerText = cleanText(text, 200) || null;
  if (sellerCode !== null && NODE_RULES.has(sellerCode)) {
    const rule = sellerCode as DenialRule;
    const kept: Refusal | null = relayed && relayed.rule === rule ? { ...relayed, message: DENIAL_RULES[rule] } : null;
    return { code: rule, message: DENIAL_RULES[rule], refusal: kept, sellerCode, sellerText };
  }
  // No code at all, or the plain "pay first" code: the seller is asking for a payment, not relaying a refusal.
  if (code === undefined || sellerCode === "PAYMENT_REQUIRED") return { code: "PAYMENT_REQUIRED", message: "payment required", refusal: null, sellerCode, sellerText };
  return { code: "SELLER_REFUSED", message: "The seller refused the payment with a code that is not a clearing rule", refusal: null, sellerCode, sellerText };
}

type Guard = { policy: VerifiedPolicy; token: AccountId };
type Reservation = { payee: string; amount: bigint; cumulative: bigint; requestHash: Id32 };
type Part = { payee: AccountId; amount: bigint };
type Resolved = { state: VoucherState; position: bigint | null; receipt: ClearingReceipt | null; note: string | null };
type Denial = { code: string; message: string; details: Record<string, unknown>; retry: RetryHint };

const lookupSchema = z.object({ receipt: clearingReceiptSchema }).loose();

const NOT_BOOKED = "this agent's node has not booked the voucher; the seller holds it and can still collect it";
const NODE_SILENT = "this agent's node is at or past this cumulative but did not say whether it booked this voucher";
const NODE_UNREACHABLE = "this agent's node could not be reached to check the voucher";

/**
 * Agent side of Payminto Clearing: pays x402 `payminto-voucher` requirements with signed cumulative vouchers,
 * and verifies every receipt before keeping it.
 *
 * What a call paid is decided from this client and its own node only. A seller's receipt counts when the node's
 * signature on it verifies; a seller's refusal, error or silence after a voucher was sent decides nothing, and the
 * agent asks its node what happened to the voucher instead (`pay()` reports the answer).
 */
export class AgentClient extends Emitter<AgentEvents> {
  readonly network: Network;
  readonly hub: AccountId;
  readonly keypair: Keypair;
  readonly budgetId: Id32;
  readonly receipts: ReceiptStore;
  readonly #o: AgentClientOptions;
  readonly #fetch: typeof fetch;
  readonly #mutex = new KeyedMutex();
  /** The position this agent's node confirmed per payee: set only from a receipt that verified. */
  readonly #positions = new Map<string, bigint>();
  readonly #nodeUrl: string;
  readonly #ownsStore: boolean;
  #policy: Promise<VerifiedPolicy> | null = null;
  #info: Promise<NodeInfo> | null = null;
  /** Highest cumulative ever seen per payee (never forgotten), for the total-cap check. */
  readonly #known = new Map<string, bigint>();
  /** Accepted spend of this client and every signed voucher whose outcome is open, for the rolling windows and the repeat limit. */
  readonly #spendLog = new SpendLog();
  /** Vouchers being signed or in flight, counted against caps so parallel payees cannot jointly overspend. */
  readonly #reserved = new Map<number, Reservation>();
  #reservationSeq = 0;

  constructor(o: AgentClientOptions) {
    super();
    this.#o = o;
    this.network = o.network;
    this.hub = o.hub;
    this.keypair = o.keypair;
    this.budgetId = o.budgetId;
    if (typeof o.nodeUrl !== "string" || !/^https?:\/\/[^/]/i.test(o.nodeUrl)) {
      throw new TypeError("AgentClient requires nodeUrl: the http(s) URL of the clearing node this agent trusts");
    }
    this.#nodeUrl = o.nodeUrl.replace(/\/+$/, "");
    this.#ownsStore = !o.receipts && !!o.storePath;
    this.receipts = o.receipts ?? (o.storePath ? new SqliteReceiptStore(o.storePath) : new MemoryReceiptStore());
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  get nodeUrl(): string {
    return this.#nodeUrl;
  }

  #node(): NodeHttp {
    return new NodeHttp(this.#nodeUrl, { fetch: this.#fetch });
  }

  /** GET nodeUrl/v1/info, cached, checked against this client's network and hub and against `trustedNodeKey` when set. */
  nodeInfo(): Promise<NodeInfo> {
    this.#info ??= (async () => {
      const info = await this.#node().get("/v1/info", infoSchema);
      if (info.network.id !== this.network) throw new Error(`node at ${this.#nodeUrl} serves ${info.network.id}, not ${this.network}`);
      if (info.hub !== this.hub) throw new Error(`node at ${this.#nodeUrl} clears hub ${info.hub}, not ${this.hub}`);
      if (this.#o.trustedNodeKey && info.nodeKey !== this.#o.trustedNodeKey) {
        throw new Error(`node key ${info.nodeKey} is not the pinned trustedNodeKey ${this.#o.trustedNodeKey}`);
      }
      return info;
    })();
    this.#info.catch(() => {
      this.#info = null; // retry on the next call
    });
    return this.#info;
  }

  /** The key every receipt must be signed by. */
  async nodeKey(): Promise<PublicKey> {
    return (await this.nodeInfo()).nodeKey;
  }

  /** Current position for a payee from the node (what the next voucher must extend). */
  async position(payee: AccountId): Promise<{ cumulative: bigint; settled: bigint }> {
    const p = await this.#node().get(`/v1/budgets/${this.budgetId}/position?payee=${encodeURIComponent(payee)}`, positionSchema);
    if (p.budgetId !== this.budgetId || p.payee !== payee) throw new Error("node answered with the position of another budget or payee");
    return { cumulative: BigInt(p.cumulative), settled: BigInt(p.settled) };
  }

  /**
   * The verified policy this client enforces before signing. Fetched once from the node unless given in the options,
   * and rejected (PolicyMismatchError) unless it hashes to the Budget this client holds and names this agent's key.
   */
  loadPolicy(): Promise<VerifiedPolicy> {
    this.#policy ??= (async () => {
      const bundle: BudgetPolicy = this.#o.policy ?? (await this.#node().get(`/v1/budgets/${this.budgetId}/policy`, policyBundleSchema));
      const verified = verifyBudgetPolicy(this.hub, this.network, this.budgetId, bundle);
      if (verified.budget.agentPk !== this.publicKey) throw new PolicyMismatchError("the Budget names another agent key");
      return verified;
    })();
    this.#policy.catch(() => {
      this.#policy = null; // retry on the next call
    });
    return this.#policy;
  }

  async #guard(): Promise<Guard> {
    const [policy, info] = await Promise.all([this.loadPolicy(), this.nodeInfo()]);
    return { policy, token: info.token.address };
  }

  #learn(payee: string, cumulative: bigint): void {
    if (cumulative > (this.#known.get(payee) ?? 0n)) this.#known.set(payee, cumulative);
  }

  #now(): number {
    return Math.floor(Date.now() / 1000);
  }

  #signedVoucher(req: PreparedRequest, payee: AccountId, amount: bigint, cumulative: bigint, requestHash: Id32, v: VoucherFields): SignedVoucher {
    return { payee, amount, cumulative, requestHash, voucherSig: v.signature, callId: callIdOf({ budgetId: this.budgetId, payee, cumulative, requestHash }), url: req.url };
  }

  /** Synchronous check-and-reserve: nothing can interleave between the policy decision and the reservation. */
  #reserve(guard: Guard, asset: AccountId, payee: AccountId, amount: bigint, cumulative: bigint, requestHash: Id32) {
    const now = this.#now();
    let otherPayeesTotal = 0n;
    for (const [p, c] of this.#known) if (p !== payee) otherPayeesTotal += c;
    let reservedAmount = 0n;
    let reservedSameRequest = 0;
    for (const r of this.#reserved.values()) {
      reservedAmount += r.amount;
      if (r.payee !== payee) otherPayeesTotal += r.amount;
      if (r.requestHash === requestHash) reservedSameRequest++;
    }
    const spent = this.#spendLog.totals(now, { payee, cumulative, requestHash, callId: callIdOf({ budgetId: this.budgetId, payee, cumulative, requestHash }) });
    const committed = otherPayeesTotal + cumulative - amount;
    const remaining = guard.policy.budget.cap > committed ? guard.policy.budget.cap - committed : 0n;
    const denial = checkBeforeSigning({
      now,
      policy: guard.policy,
      asset,
      token: guard.token,
      payee,
      amount,
      cumulative,
      otherPayeesTotal,
      spentLastHour: spent.spentLastHour + reservedAmount,
      spentLast24h: spent.spentLast24h + reservedAmount,
      callsLastMinute: spent.callsLastMinute + this.#reserved.size,
      sameRequestCalls: spent.sameRequestCalls + reservedSameRequest,
      sameRequestTimes: spent.sameRequestTimes,
      allowAnyPayee: this.#o.allowAnyPayee === true,
    });
    if (denial) return { denial, id: null, remaining };
    const id = ++this.#reservationSeq;
    this.#reserved.set(id, { payee, amount, cumulative, requestHash });
    return { denial: null, id, remaining };
  }

  /** A refusal this client decides itself, signing nothing: emitted as `denied` and returned as a 402. */
  #refuse(trace: Trace, req: PreparedRequest, payee: AccountId, amount: bigint, d: Denial, remaining: bigint | null): Response {
    const r: Refusal = { rule: d.code, message: d.message, attemptedAmount: amount.toString(), remainingBudget: remaining === null ? null : remaining.toString(), retry: d.retry };
    trace.refusal = { source: "agent", code: d.code, message: d.message, refusal: r, details: d.details, sellerCode: null, sellerText: null };
    this.emit("denied", { code: d.code, message: d.message, source: "agent", details: d.details, refusal: r, url: req.url, payee, amount });
    return refusal(r, d.details);
  }

  /**
   * fetch() that pays `payminto-voucher` 402 requirements and returns the seller's response. Several `accepts` entries
   * are alternatives: the first one for this client's network and hub is paid. An entry with `extra.splits` is one
   * purchase paid with one voucher per split, all checked together before anything is signed.
   *
   * The response is the seller's, whatever it says. Use `pay()` to learn what was paid: a seller can answer an error or
   * a refusal after it was paid, and a success without being paid.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    try {
      return (await this.pay(input, init)).response;
    } catch (err) {
      throw err instanceof PayFailed && err.cause !== undefined ? err.cause : err;
    }
  }

  /**
   * `fetch()` plus what the call paid, on every outcome. `maxPrice` is a hard maximum for this one call, applied with
   * the client's own `maxPrice` (the lower one wins); a price above it is refused before anything is signed.
   * Throws PayFailed, which carries the same report, when the call could not finish.
   */
  async pay(input: string | URL | Request, init?: RequestInit, o: { maxPrice?: bigint } = {}): Promise<PaidResponse> {
    const trace = new Trace();
    try {
      const response = await this.#run(await prepare(input, init), o, trace);
      return { response, payment: trace.outcome() };
    } catch (err) {
      throw new PayFailed(err, trace.outcome());
    }
  }

  async #run(req: PreparedRequest, o: { maxPrice?: bigint }, trace: Trace): Promise<Response> {
    const first = await this.#send(req, null);
    if (first.status !== 402) return first;

    const offer = await this.#pickOffer(first);
    if (!offer) return first;
    const { requirement } = offer;
    const parts: Part[] = (requirement.extra.splits ?? [{ payTo: requirement.payTo, amount: requirement.amount }]).map((x) => ({ payee: x.payTo, amount: BigInt(x.amount) }));
    const amount = BigInt(requirement.amount);
    const limits = [this.#o.maxPrice, o.maxPrice].filter((x): x is bigint => x !== undefined);
    const maxPrice = limits.length ? limits.reduce((a, b) => (a < b ? a : b)) : undefined;
    if (maxPrice !== undefined && amount > maxPrice) {
      const details = { amount: amount.toString(), maxPrice: maxPrice.toString(), enforcedBy: "agent" };
      return this.#refuse(trace, req, parts[0]!.payee, amount, { code: "CLIENT_MAX_PRICE", message: `price ${amount} exceeds maxPrice ${maxPrice}`, details, retry: { kind: "never" } }, null);
    }
    if (this.#o.beforeSign) {
      const stopped = await this.#beforeSign(trace, req, offer, parts, amount);
      if (stopped) return stopped;
    }
    const requestHash = computeRequestHash(req.method, req.url, req.body);
    // Lock every payee in a fixed order, so two split payments over the same payees cannot deadlock.
    const keys = parts.map((p) => `${this.budgetId}:${p.payee}`).sort();
    const locked = keys.reduceRight<() => Promise<Response>>((inner, key) => () => this.#mutex.run(key, inner), () => this.#pay(req, offer, parts, requestHash, trace));
    return locked();
  }

  /**
   * The offer this client pays, from PAYMENT-REQUIRED (or the JSON body that repeats it). Only price, payees and asset
   * are taken from it: `extra.clearingNode` is ignored, the agent talks to its configured node only. Another
   * `x402Version`, scheme, network or hub is not payable here, and the 402 is returned as it came.
   */
  async #pickOffer(res: Response): Promise<Offer | null> {
    let pr = parsePaymentRequired(res.headers.get(HEADER_REQUIRED));
    if (!pr.ok && pr.code === "MISSING") {
      const body = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
      // A body may repeat the offer next to a structured error object; the header form carries the code as a string.
      if (body && typeof body === "object" && typeof body.error !== "string") delete body.error;
      pr = parseValue(paymentRequiredSchema, body, { versioned: true, what: "402 body" });
    }
    if (!pr.ok) return null;
    const [requirement] = voucherRequirements(pr.value, this.network, this.hub);
    return requirement ? { requirement, resource: pr.value.resource } : null;
  }

  #send(req: PreparedRequest, payment: string | null): Promise<Response> {
    const headers = new Headers(req.headers);
    if (payment) headers.set(HEADER_SIGNATURE, payment);
    return this.#fetch(req.url, { method: req.method, headers, body: req.body as BodyInit | undefined });
  }

  /** Signs one voucher. The amount and request hash bind the signature to this specific call. */
  #voucher(payee: AccountId, amount: bigint, cumulative: bigint, requestHash: Id32): VoucherFields {
    const v = { budgetId: this.budgetId, payee, amount, cumulative, requestHash };
    const signature = signDigest(this.keypair.secretKey, voucherDigest(this.hub, this.network, v));
    return { budgetId: this.budgetId, payee, amount: amount.toString(), cumulative: cumulative.toString(), requestHash, publicKey: this.publicKey, signature };
  }

  /** The PAYMENT-SIGNATURE for an offer: the accepted requirement and one voucher, or one per split. */
  #payment(offer: Offer, vouchers: VoucherFields[]): string {
    const p: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: offer.resource,
      accepted: offer.requirement,
      payload: vouchers.length === 1 ? vouchers[0]! : { vouchers },
    };
    return encodeHeader(p);
  }

  /**
   * The `beforeSign` hook, once per payee, before anything of the offer is signed. Null when every payee may be paid;
   * otherwise the refusal this client answers with. It runs before the payees are locked, so a hook that waits (for a
   * person, for an owner's approval) holds up no other call.
   */
  async #beforeSign(trace: Trace, req: PreparedRequest, offer: Offer, parts: Part[], total: bigint): Promise<Response | null> {
    let policy: VerifiedPolicy;
    try {
      policy = await this.loadPolicy();
    } catch (err) {
      return this.#policyUnavailable(trace, err, req, parts[0]!.payee, total);
    }
    for (const p of parts) {
      let r: BeforeSignRefusal | null | undefined;
      try {
        r = await this.#o.beforeSign!({ payer: policy.budget.owner, payee: p.payee, amount: p.amount, total, budgetPayees: [...policy.payees], requirement: offer.requirement, url: req.url, budgetId: this.budgetId });
      } catch (err) {
        r = { rule: "CLIENT_CHECK_FAILED", message: `The check before signing failed, so nothing was signed: ${cleanText(err instanceof Error ? err.message : String(err), 200)}`, retry: { kind: "after", seconds: BEFORE_SIGN_RETRY_SEC } };
      }
      if (!r) continue;
      const details = { ...(r.details ?? {}), enforcedBy: "agent", payee: p.payee };
      return this.#refuse(trace, req, p.payee, total, { code: r.rule, message: r.message, details, retry: r.retry }, null);
    }
    return null;
  }

  /** Fail closed: without a verified policy the agent does not sign. */
  #policyUnavailable(trace: Trace, err: unknown, req: PreparedRequest, payee: AccountId, amount: bigint): Response {
    const code = err instanceof PolicyMismatchError ? "POLICY_MISMATCH" : "POLICY_UNAVAILABLE";
    const message = err instanceof Error ? err.message : String(err);
    return this.#refuse(trace, req, payee, amount, { code, message, details: { enforcedBy: "agent" }, retry: code === "POLICY_MISMATCH" ? { kind: "never" } : { kind: "after", seconds: 30 } }, null);
  }

  /**
   * Check-and-reserve, all or nothing. A split is one purchase, so its combined price is held against the per-call cap
   * first; then each voucher is held against every other rule with the earlier ones already reserved, so the payees
   * cannot jointly pass a total or daily cap that each alone would pass.
   */
  #reserveAll(guard: Guard, asset: AccountId, parts: Array<Part & { cumulative: bigint }>, requestHash: Id32) {
    let remaining: bigint | null = null;
    if (parts.length > 1) {
      const combined = checkSplitBeforeSigning({ policy: guard.policy, amounts: parts.map((p) => p.amount) });
      if (combined) return { denial: combined, ids: [] as number[], remaining };
    }
    const ids: number[] = [];
    for (const p of parts) {
      const r = this.#reserve(guard, asset, p.payee, p.amount, p.cumulative, requestHash);
      remaining = r.remaining;
      if (r.denial) {
        for (const id of ids) this.#reserved.delete(id);
        return { denial: r.denial, ids: [] as number[], remaining };
      }
      ids.push(r.id!);
    }
    return { denial: null, ids, remaining };
  }

  /**
   * Pays one offer: one voucher, or one per split in a single PAYMENT-SIGNATURE. Nothing is signed unless every voucher
   * passes the policy guard. A position advances only on a receipt that verified; after anything else the agent asks
   * its own node what happened to each voucher before it decides to stop or to sign again.
   */
  async #pay(req: PreparedRequest, offer: Offer, parts: Part[], requestHash: Id32, trace: Trace): Promise<Response> {
    const total = parts.reduce((s, p) => s + p.amount, 0n);
    const first = parts[0]!.payee;
    const maxRetries = this.#o.maxRetries ?? 3;
    const sleep = this.#o.sleep ?? defaultSleep;
    const random = this.#o.random ?? Math.random;
    const asset = offer.requirement.asset;
    let guard: Guard | null = null;
    if (this.#o.enforcePolicy !== false) {
      try {
        guard = await this.#guard();
      } catch (err) {
        return this.#policyUnavailable(trace, err, req, first, total);
      }
    }
    for (const [p, c] of this.receipts.signedPositions(this.budgetId)) this.#learn(p, c);
    const positions = new Map<string, bigint>();
    for (const p of parts) positions.set(p.payee, this.#positions.get(p.payee) ?? (await this.#readPosition(p.payee)));

    let reservations: number[] = [];
    const release = () => {
      for (const id of reservations) this.#reserved.delete(id);
      reservations = [];
    };
    try {
      for (let attempt = 0; ; attempt++) {
        const next: Array<Part & { cumulative: bigint }> = [];
        for (const p of parts) {
          const position = positions.get(p.payee)!;
          // Never extend a position this agent did not sign itself: a voucher is bounded by its own high-water mark.
          const signed = this.receipts.signedPosition(this.budgetId, p.payee);
          if (position > signed) {
            this.#positions.delete(p.payee);
            const details = { payee: p.payee, reported: position.toString(), signed: signed.toString(), enforcedBy: "agent" };
            return this.#refuse(trace, req, p.payee, total, { code: "POSITION_UNVERIFIED", message: DENIAL_RULES.POSITION_UNVERIFIED, details, retry: { kind: "never" } }, null);
          }
          this.#learn(p.payee, position);
          next.push({ ...p, cumulative: position + p.amount });
        }
        if (guard) {
          release();
          const r = this.#reserveAll(guard, asset, next, requestHash);
          if (r.denial) return this.#refuse(trace, req, first, total, r.denial, r.remaining);
          reservations = r.ids;
        }

        for (const p of next) {
          // Write-ahead: every high-water mark is durable before any signature exists.
          this.receipts.recordSigned(this.budgetId, p.payee, p.cumulative);
          this.#learn(p.payee, p.cumulative);
        }
        const vouchers = next.map((p) => this.#voucher(p.payee, p.amount, p.cumulative, requestHash));
        const sent = next.map((p, i) => this.#signedVoucher(req, p.payee, p.amount, p.cumulative, requestHash, vouchers[i]!));
        let res: Response;
        try {
          res = await this.#send(req, this.#payment(offer, vouchers));
        } catch (err) {
          // The request died with the vouchers already signed, and the seller may hold them: they count as spend, and
          // the agent asks its node before it reports the failure.
          const at = this.#now();
          for (const v of sent) this.#spendLog.outstanding(v, at);
          release();
          for (const v of sent) trace.set(v, await this.#resolve(v));
          throw err;
        }

        // A voucher is paid when the receipt for it carries the signature of this agent's node. Nothing else counts.
        const paid = paidHeader(res);
        const open: SignedVoucher[] = [];
        for (const [i, v] of sent.entries()) {
          const r = typeof paid === "object" ? paid.receipts.find((x) => x.payee === v.payee && BigInt(x.cumulative) === v.cumulative) : undefined;
          if (r && (await this.#verifies(r, v))) {
            // In one step the voucher stops being in flight and becomes accepted spend, so no check counts it twice.
            if (reservations[i] !== undefined) this.#reserved.delete(reservations[i]!);
            this.#book(r, v);
            // The position advances here and nowhere else: on a receipt this agent's node signed.
            this.#positions.set(v.payee, v.cumulative);
            trace.set(v, { state: "paid", receipt: r, note: null });
            continue;
          }
          if (typeof paid === "object" && !r) this.emit("error", new Error(`seller returned no receipt for the voucher to ${v.payee}`));
          open.push(v);
        }
        if (paid === "malformed") this.emit("error", new Error("provider returned a malformed PAYMENT-RESPONSE"));
        if (open.length === 0) return res;

        // The outcome of the rest is unknown. They count as spend from here on, and the agent asks its own node.
        const now = this.#now();
        for (const v of open) this.#spendLog.outstanding(v, now);
        release();
        const resolved: Resolved[] = [];
        for (const v of open) {
          const r = await this.#resolve(v);
          trace.set(v, r);
          if (r.position !== null) positions.set(v.payee, r.position);
          resolved.push(r);
        }
        if (res.status !== 402) return res;

        const denial = await sellerDenial(res);
        trace.refusal = { source: "seller", ...denial };
        // The node booked this call, whatever the seller says: it is paid, and signing again would pay twice.
        if (resolved.every((r) => r.state === "paid")) return res;
        const deny = () => {
          const { refusal: relayed, sellerCode, sellerText, ...rest } = denial;
          this.emit("denied", { ...rest, source: "seller", ...(relayed ? { refusal: relayed } : {}), ...(sellerCode ? { sellerCode } : {}), ...(sellerText ? { sellerText } : {}), url: req.url, payee: first, amount: total });
          return res;
        };
        // Signing again is safe only when the node says none of these vouchers was booked or still can be booked on
        // top of what it holds: each is void, or the node's position is below it (a re-sign then replaces it).
        const resign =
          denial.code === "STALE_CUMULATIVE" &&
          open.length === sent.length &&
          resolved.every((r, i) => r.state === "void" || (r.state === "unverified" && r.position !== null && r.position < open[i]!.cumulative));
        if (!resign || attempt >= maxRetries) return deny();
        // Jittered backoff: 25-75 ms, doubling per attempt, so racing processes spread out.
        await sleep(Math.round((25 + random() * 50) * 2 ** attempt));
      }
    } finally {
      release();
    }
  }

  /** The node's position for a payee, after settling every open voucher for that payee the position has reached. */
  async #readPosition(payee: AccountId): Promise<bigint> {
    const position = (await this.position(payee)).cumulative;
    for (const v of this.#spendLog.outstandingFor(payee)) {
      if (v.cumulative > position) continue;
      const found = await this.#lookup(v);
      // Booked: it is accepted spend. Passed over: the node holds other vouchers up to here, so it is worth nothing more.
      if (found === "absent") this.#spendLog.drop(v.callId);
    }
    return position;
  }

  /**
   * Asks this agent's own node whether it booked a voucher, by the call id the node derives from the voucher's fields.
   * "booked" only when the node's receipt for it verifies; "absent" only when the node says it has no such call.
   */
  async #lookup(v: SignedVoucher): Promise<"booked" | "absent" | "unknown"> {
    let receipt: ClearingReceipt;
    try {
      receipt = (await this.#node().get(`/v1/receipts/${v.callId}/proof`, lookupSchema)).receipt;
    } catch (err) {
      return err instanceof NodeApiError && err.status === 404 && err.code === "NOT_FOUND" ? "absent" : "unknown";
    }
    if (receipt.callId !== v.callId || !(await this.#verifies(receipt, v))) return "unknown";
    this.#book(receipt, v);
    return "booked";
  }

  /** What this agent's own node says about a voucher whose outcome the seller left open. */
  async #resolve(v: SignedVoucher): Promise<Resolved> {
    this.#positions.delete(v.payee);
    let position: bigint;
    try {
      position = await this.#readPosition(v.payee);
    } catch {
      return { state: "unverified", position: null, receipt: null, note: NODE_UNREACHABLE };
    }
    const entry = this.#spendLog.get(v.callId);
    if (!entry) return { state: "void", position, receipt: null, note: null };
    if (entry.state === "accepted") return { state: "paid", position, receipt: this.receipts.get(v.callId) ?? null, note: null };
    return { state: "unverified", position, receipt: null, note: position < v.cumulative ? NOT_BOOKED : NODE_SILENT };
  }

  /** True when the receipt is this agent's node's signed word for exactly this voucher. Otherwise reported, and nothing changes. */
  async #verifies(r: ClearingReceipt, v: SignedVoucher): Promise<boolean> {
    const problem = await this.#verifyReceipt(r, v).catch((err: unknown) => String(err));
    if (problem) this.emit("error", new Error(`receipt rejected: ${problem}`));
    return !problem;
  }

  /** Keeps a verified receipt and books its voucher as accepted spend. */
  #book(r: ClearingReceipt, v: SignedVoucher): void {
    this.receipts.add(r);
    this.#spendLog.accepted(v, this.#now());
    this.emit("receipt", { receipt: r, url: v.url, price: v.amount });
  }

  async #verifyReceipt(r: ClearingReceipt, e: SignedVoucher): Promise<string | null> {
    if (r.budgetId !== this.budgetId) return "budget mismatch";
    if (r.payee !== e.payee) return "payee mismatch";
    if (BigInt(r.amount) !== e.amount || BigInt(r.cumulative) !== e.cumulative) return "amount mismatch";
    if (r.requestHash !== e.requestHash) return "request hash mismatch";
    if (r.voucherSig !== e.voucherSig) return "voucher signature mismatch";
    const digest = nodeDigest({
      callId: r.callId,
      budgetId: r.budgetId,
      payee: r.payee,
      amount: BigInt(r.amount),
      cumulative: BigInt(r.cumulative),
      requestHash: r.requestHash,
      timestamp: BigInt(r.timestamp),
      voucherSig: r.voucherSig,
    });
    if (digest !== r.digest) return "digest mismatch";
    const nodeKey = await this.nodeKey().catch(() => null);
    if (!nodeKey) return "cannot read the key of the configured node";
    if (!verifyDigest(nodeKey, digest, r.nodeSignature)) return "not signed by the configured node key";
    if (r.node !== nodeKey) return "receipt names another node";
    return null;
  }

  /** Asks the node to stop accepting this agent's vouchers. Agents cannot revoke on chain; only the owner can. */
  revoke(): Promise<unknown> {
    const signature = signDigest(this.keypair.secretKey, revokeDigest(this.budgetId));
    return this.#node().post(`/v1/budgets/${this.budgetId}/revoke`, z.unknown(), { signature });
  }

  /** Closes the receipt store if this client opened it (`storePath`). */
  close(): void {
    if (this.#ownsStore) this.receipts.close?.();
  }
}
