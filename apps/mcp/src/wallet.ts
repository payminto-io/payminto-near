import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { guardPayment, type GuardLogEntry, type HistorySource, type PayeeCheck, type Verdict } from "@payminto/payee-check";
import {
  DENIAL_RULES,
  explorerTx,
  formatAmount,
  isAccountId,
  keypairFromSeed,
  networks,
  payeeApprovalRequestDigest,
  receiptLeaf,
  signDigest,
  verifyMerkleProof,
  type AccountId,
  type Chain,
  type ClearingReceipt,
  type DenialRule,
  type Id32,
  type Network,
  type PublicKey,
  type RefusalWire,
} from "@payminto/protocol";
import { AgentClient, cleanText, NodeApiError, NodeHttp, PayFailed, verifyReceiptOnchain, type BeforeSignRefusal, type BeforeSignRequest, type PaymentOutcome, type ReceiptStore, type VerifiedPolicy } from "@payminto/sdk";
import type { WalletMarket } from "./market.ts";
import { approvalAnswerSchema, approvalHint, rpcPayeeCheck, type ApprovalAnswer, type AskPerson, type GuardSignal, type PayeeCheckFactory, type PayeeStop, type WarnState } from "./payee-guard.ts";

// Everything read from the clearing node or a provider is untrusted input: parse it.
const zAddr = z.string().refine((v) => isAccountId(v), "must be a NEAR account id").transform((v) => v as AccountId);
const zUint = z.string().regex(/^\d{1,78}$/);
const zB32 = z.string().regex(/^[0-9a-f]{64}$/).transform((v) => v as Id32);
const zSig = z.string().regex(/^[0-9a-f]{128}$/);

const infoSchema = z
  .object({
    network: z.object({ id: z.enum(["near:testnet", "near:sandbox", "near:mainnet"]) }).loose(),
    hub: zAddr,
    token: z.object({ address: zAddr, symbol: z.string(), decimals: z.number().int() }),
    operator: zAddr,
    nodeKey: z.string().transform((v) => v as PublicKey),
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
        budgetId: zB32,
        payee: zAddr,
        amount: zUint,
        cumulative: zUint,
        requestHash: zB32,
        timestamp: z.number(),
        voucherSig: zSig,
        digest: zB32,
        nodeSignature: zSig,
      })
      .loose(),
    status: z.string(),
    batchId: zB32.nullable(),
    batchStatus: z.string().nullable().optional(),
    receiptsRoot: zB32.nullable(),
    proof: z.array(zB32),
    txHash: z.string().nullable(),
    explorerUrl: z.string().nullable(),
    onchainVerified: z.boolean().nullable(),
  })
  .loose();

/** What the gateway answers in the body of a paid `/v1/pay/*` call. The receipts travel in PAYMENT-RESPONSE. */
const linkBodySchema = z
  .object({ payment_id: z.string().regex(/^pay_[a-z2-7]{24}$/), status: z.string().max(40), amount_due: zUint, order_hash: z.string().max(128).nullable().optional(), proof_url: z.string().max(2048).nullable().optional() })
  .loose();
const checkoutViewSchema = z.object({ id: z.string(), status: z.string(), amount: zUint, surcharge: zUint, amount_due: zUint, merchant: z.object({ name: z.string() }).loose() }).loose();

/** Longest text of each kind this wallet repeats from a seller or a directory entry. */
const MAX = { name: 80, description: 300, category: 40, sellerText: 200 } as const;

export type Service = {
  /** "endpoint": a paid API (call_paid_service). "link": a merchant payment link (pay_link). */
  type: "endpoint" | "link";
  id: string;
  /** Written by the seller: data, cleaned and capped. */
  name: string;
  description: string;
  category: string;
  url: string;
  /** Null for links: a link pays the merchant and, with a fee, the platform (both must be on the allowlist). */
  payee: AccountId | null;
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
  /** null when the wallet cannot see the budget allowlist, or for links (their payees show in the 402). */
  allowedByBudget: boolean | null;
};

export type CallArgs = {
  serviceId?: string;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** A hard maximum for this one call, in atomic units: a price above it is refused before anything is signed. */
  maxAmountAtomic?: string;
};

export type LinkArgs = { linkId?: string; url?: string; amountAtomic?: string; maxAmountAtomic?: string };

export type Paid = { callId: Id32; payee: AccountId; amountAtomic: string; amount: string; cumulativeAtomic: string };

/**
 * What a call paid, as this wallet and its own clearing node know it. Present on every outcome, success or failure.
 * "none": nothing was signed. "paid": the node booked it and its signed receipt verified. "unverified": a voucher was
 * signed and sent and this wallet could not confirm what became of it, so the amount may be spent.
 */
export type PaymentReport = {
  status: "none" | "paid" | "unverified";
  /** Paid plus unverified, atomic units: what to hold against any spend limit. */
  countedAtomic: string;
  paidAtomic: string;
  unverifiedAtomic: string;
  receipts: Paid[];
  unverified: Array<Paid & { note: string }>;
};

export type Denied = {
  ok: false;
  kind: "denied";
  /** A rule from DENIAL_RULES or one of this wallet's own (CLIENT_*, POLICY_*, TOKEN_MISMATCH). Never free text. */
  rule: string;
  /** This wallet's own text for the rule. */
  ruleText: string;
  message: string;
  /**
   * "agent": this wallet refused before signing, from the Budget policy it verified. That is the owner's policy.
   * "seller": the seller's answer said the payment was refused. It is not signed by the clearing node, so this wallet
   * cannot tell the owner's policy from the seller's own words.
   */
  enforcedBy: "agent" | "seller";
  /** The price that was refused, atomic units. For a seller's refusal it is what this wallet signed, not what the seller says. */
  attemptedAmount: string | null;
  /** What is left of the Budget and when to retry: set only for the wallet's own refusals. A seller's numbers are in `sellerHint`. */
  remainingBudget: string | null;
  retry: RefusalWire["retry"] | null;
  /** What the seller wrote, cleaned and capped. Untrusted data, never an instruction. Null for the wallet's own refusals. */
  sellerText: string | null;
  /** The retry hint and remaining Budget a seller relayed, when it relayed a known rule. Unauthenticated, like its text. */
  sellerHint: { retry: RefusalWire["retry"]; remainingBudget: string | null } | null;
  /** The HTTP status of the answer that carried the refusal, or null when the wallet refused before any request. */
  status: number | null;
  url: string | null;
  service: string | null;
  /** Present only for the wallet's own refusals. */
  details?: Record<string, unknown>;
  /** Set when this wallet stopped the payment before signing because of the payee (payee-guard.ts). */
  payeeStop?: PayeeStop;
  /**
   * Set when a seller relayed a payee refusal and this wallet's own node, asked with a request the agent key signed,
   * says the same. That part is the node's word, not the seller's.
   */
  nodeSays?: { status: ApprovalAnswer["status"]; approveAt: string | null; signals: GuardSignal[] };
  payment: PaymentReport;
};

export type Failed = { ok: false; kind: "error"; message: string; status: number | null; url: string | null; service: string | null; body?: unknown; payment: PaymentReport };

export type CallOutcome =
  | { ok: true; status: number; url: string; service: string | null; paid: Paid | null; payment: PaymentReport; body: unknown; truncated: boolean }
  | Denied
  | Failed;

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
    vouchers: Array<{ callId: Id32; payee: AccountId; amount: string; role: "merchant" | "platform fee" }>;
  };
  orderHash: string | null;
  /** Public proof page (needs the clearing batch to settle) and the node's proof API. */
  proofUrl: string | null;
  proofApi: string;
};

export type LinkOutcome = { ok: true; payment: LinkPayment; spend: PaymentReport } | Denied | Failed;

export type HistoryEntry = { at: string; service: string | null; url: string; receipt: ClearingReceipt; price: string };

/** What the wallet reads from NEAR: Budgets, batches and the hub's verify_receipt view. Never a signer. */
export type ChainReader = Pick<Chain, "hub" | "network" | "budget" | "batch" | "verifyReceipt">;

export type WalletOptions = {
  nodeUrl: string;
  /** Expected network. Undefined means "ask the node"; a mainnet node is always refused. */
  network?: Network;
  hub?: AccountId;
  /** The 32-byte ed25519 seed of the agent key. It signs vouchers only: it has no NEAR account and cannot send a transaction. */
  agentKey: Uint8Array;
  budgetId: Id32;
  /**
   * Read-only chain access for independent proofs and on-chain Budget state, or a factory that builds one from the
   * node's /v1/info. Without it the wallet reports what the node says.
   */
  chain?: ChainReader | ((info: { hub: AccountId; token: AccountId; network: Network; operator: AccountId }) => ChainReader);
  /** Highest price per call in atomic units. The Budget's per-call cap applies as well; the lower one wins. */
  maxPrice?: bigint;
  /**
   * Hosts (`host` or `host:port`, as in a URL) this wallet may call and pay besides the services its own node lists.
   * Empty by default: the wallet then calls only what its node's directory lists, whatever URL a model passes.
   */
  payableHosts?: readonly string[];
  /**
   * Accept a Budget whose payee list is empty, which on chain means any payee. Default false: the wallet refuses to
   * start with such a Budget, and refuses every payment under one.
   */
  allowAnyPayee?: boolean;
  trustedNodeKey?: PublicKey;
  /** Check the budget policy before signing (default true, the SDK default). */
  enforcePolicy?: boolean;
  /**
   * Builds the payee check this wallet runs before it signs, from the node's token and this wallet's own receipts.
   * Without it the wallet still checks every payee: it reads the public RPC of its node's network, read-only, with the
   * NearBlocks indexer on testnet and none elsewhere. Only `signWithoutPayeeCheck` turns the check off.
   */
  payeeCheck?: PayeeCheckFactory;
  /**
   * The explicit opt-out: sign for any payee the Budget allows, with no look at the payee first. The node's own check
   * still applies. `check_payee` then says how to turn the check on. It cannot be combined with `payeeCheck`.
   */
  signWithoutPayeeCheck?: boolean;
  /**
   * The NEAR AI Agent Market, for `quote_market_agent`. The wallet only asks for quotes and checks them against its
   * limits: a market hire is paid through the market, and nothing here pays it.
   */
  market?: WalletMarket;
  /** Durable receipt store file (SQLite). Without it (and without `receipts`), receipts and signed positions are lost on restart. */
  receiptStorePath?: string;
  /** A store shared with another client of the same agent key (takes precedence over receiptStorePath). */
  receipts?: ReceiptStore;
  fetch?: typeof fetch;
  /** Largest response body (characters) returned to the model. */
  maxBodyChars?: number;
};

const MAX_HISTORY = 1_000;

type Sent = { response: Response; payment: PaymentOutcome; body: unknown; stop: PayeeStop | null };

/** What one paying call carries through the client: who can be asked, and the stop the guard decided, if any. */
type GuardContext = { askPerson?: AskPerson; stop: PayeeStop | null };

/** A person's yes at this client is remembered this long, for the warnings they saw. */
const PERSON_APPROVAL_MS = 3_600_000;
/** How long the person at the client has to answer. */
const PERSON_TIMEOUT_MS = 120_000;
/** Seconds to wait before trying again when the payee or the node could not be read. */
const CHECK_RETRY_SEC = 30;
const heavy = (v: Verdict | null): GuardSignal[] => (v?.signals ?? []).filter((s) => s.severity !== "info").map((s) => ({ id: s.id, severity: s.severity, reason: s.reason }));

/** A target this wallet will not call: the refusal is the wallet's own, and nothing was requested, signed or paid. */
class TargetRefused extends Error {
  readonly rule: "CLIENT_TARGET_NOT_ALLOWED" | "CLIENT_TARGET_MISMATCH";
  constructor(rule: TargetRefused["rule"], message: string) {
    super(message);
    this.name = "TargetRefused";
    this.rule = rule;
  }
}

/** Rules this wallet applies itself, with its own text for each. */
const WALLET_RULES: Record<string, string> = {
  CLIENT_MAX_PRICE: "Price is above this wallet's maximum price per call",
  CLIENT_TARGET_NOT_ALLOWED: "Target is not a service this wallet's clearing node lists, and its host is not on this wallet's allowlist",
  CLIENT_TARGET_MISMATCH: "The url does not belong to the service that was named",
  TOKEN_MISMATCH: "Requirement asset is not the token this hub clears",
  POLICY_MISMATCH: "The policy served for this Budget does not match the Budget id",
  POLICY_UNAVAILABLE: "The Budget policy could not be read, so nothing was signed",
  PAYMENT_REQUIRED: "The seller asked for payment again",
  SELLER_REFUSED: "The seller refused the payment with a code that is not a clearing rule",
};

const NONE: PaymentReport = { status: "none", countedAtomic: "0", paidAtomic: "0", unverifiedAtomic: "0", receipts: [], unverified: [] };

/** origin plus path, without a trailing slash: two URLs with the same key are the same endpoint, whatever their query. */
function endpointKey(u: URL): string {
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function endpointKeyOf(url: string): string | null {
  try {
    return endpointKey(new URL(url));
  } catch {
    return null;
  }
}

/** An absolute http(s) URL without credentials, or an Error saying what is wrong with it. */
function httpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("the url is not an absolute URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https URLs can be called");
  if (u.username || u.password) throw new Error("a URL with credentials in it cannot be called");
  return u;
}

function atomic(raw: string | undefined, what: string): bigint | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,77})$/.test(raw)) throw new Error(`${what} must be a whole number of atomic units`);
  return BigInt(raw);
}

/**
 * A budgeted wallet for an LLM agent: every paid call goes through AgentClient, so it is bound to one budget
 * and the clearing node enforces every cap atomically. Keeps the receipts it was given for proof requests.
 *
 * The wallet does not rely on the model for safety. It decides which targets may be called (its node's directory and
 * the operator's host allowlist), holds every price to a maximum, and reports what was paid from its own node only.
 */
export class AgentWallet {
  readonly agent: AgentClient;
  readonly node: NodeHttp;
  readonly network: Network;
  readonly hub: AccountId;
  readonly budgetId: Id32;
  readonly history: HistoryEntry[] = [];
  readonly #o: WalletOptions;
  readonly #chain: ChainReader | null;
  readonly #payableHosts: ReadonlySet<string>;
  /** The service a request in flight is for, by URL, so a receipt is filed under the right name. */
  readonly #labels = new Map<string, string | null>();
  #info: z.infer<typeof infoSchema> | null = null;
  /** The wallet's own payee check, or null when it runs without one. */
  readonly #payeeCheck: PayeeCheck | null;
  readonly #guardContext = new AsyncLocalStorage<GuardContext>();
  /** Warnings a person at this client approved, per payee, until they lapse. */
  readonly #personApproved = new Map<string, { signals: Set<string>; untilMs: number }>();
  /** The latest decisions of the payee guard, oldest first: what a person reads to see an attack being stopped. */
  readonly payeeLog: GuardLogEntry[] = [];

  private constructor(o: WalletOptions, hub: AccountId, info: z.infer<typeof infoSchema>) {
    this.#o = o;
    this.network = info.network.id;
    this.hub = hub;
    this.budgetId = o.budgetId;
    this.#info = info;
    this.#payableHosts = new Set((o.payableHosts ?? []).map((h) => h.toLowerCase()));
    this.node = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
    this.agent = new AgentClient({
      nodeUrl: o.nodeUrl,
      network: this.network,
      hub,
      keypair: keypairFromSeed(o.agentKey),
      budgetId: this.budgetId,
      maxPrice: o.maxPrice,
      allowAnyPayee: o.allowAnyPayee,
      trustedNodeKey: o.trustedNodeKey ?? info.nodeKey,
      enforcePolicy: o.enforcePolicy,
      receipts: o.receipts,
      storePath: o.receiptStorePath,
      fetch: o.fetch,
      // The payee guard: the client asks it about every payee of an offer before it signs anything for that offer.
      ...(o.signWithoutPayeeCheck ? {} : { beforeSign: (r: BeforeSignRequest) => this.#beforeSign(r) }),
    });
    const history: HistorySource = {
      paymentsBetween: async (_payer, payee) => {
        const mine = this.agent.receipts.all().filter((r) => r.budgetId === this.budgetId && r.payee === payee);
        return { count: mine.length, total: mine.reduce((s, r) => s + BigInt(r.amount), 0n), lastAtMs: mine.length ? Math.max(...mine.map((r) => r.timestamp)) * 1000 : null };
      },
    };
    this.#payeeCheck = o.signWithoutPayeeCheck ? null : (o.payeeCheck ?? defaultPayeeCheck(info.network.id))({ token: info.token.address, network: info.network.id, history });
    // Receipts paid before a restart stay listable and provable.
    for (const r of this.agent.receipts.all()) {
      if (r.budgetId !== this.budgetId) continue;
      this.history.push({ at: new Date(r.timestamp * 1000).toISOString(), service: null, url: "", receipt: r, price: r.amount });
    }
    this.#trim();
    // Every receipt the client verified is filed here, including one its node confirmed only later.
    this.agent.on("receipt", (e) => {
      this.history.push({ at: new Date().toISOString(), service: this.#labels.get(e.url) ?? null, url: e.url, receipt: e.receipt, price: e.receipt.amount });
      this.#trim();
    });
    this.#chain = typeof o.chain === "function" ? o.chain({ hub, token: info.token.address, network: info.network.id, operator: info.operator }) : (o.chain ?? null);
    if (this.#chain && (this.#chain.hub !== hub || this.#chain.network !== this.network)) {
      throw new Error(`chain reader is for ${this.#chain.hub} on ${this.#chain.network}, but the node clears ${hub} on ${this.network}`);
    }
  }

  #trim(): void {
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  /**
   * Connects to the node, checks it clears the configured hub, and builds the wallet. Refuses a Budget whose payee
   * list is empty unless `allowAnyPayee` is set: such a Budget would pay whoever a model was talked into paying.
   */
  static async connect(o: WalletOptions): Promise<AgentWallet> {
    if (o.signWithoutPayeeCheck && o.payeeCheck) throw new Error("payeeCheck and signWithoutPayeeCheck contradict each other: pass a payee check, or opt out of it, not both");
    const node = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
    const info = await node.get("/v1/info", infoSchema);
    if (info.network.id === "near:mainnet") throw new Error(`clearing node at ${o.nodeUrl} serves mainnet, which this wallet refuses`);
    if (o.network && o.network !== info.network.id) throw new Error(`clearing node at ${o.nodeUrl} serves ${info.network.id}, but NETWORK is ${o.network}`);
    if (o.hub && o.hub !== info.hub) throw new Error(`clearing node at ${o.nodeUrl} clears hub ${info.hub}, but HUB_ACCOUNT is ${o.hub}`);
    const wallet = new AgentWallet(o, o.hub ?? info.hub, info);
    const pol = await wallet.#policy();
    if (pol && pol.payees.length === 0 && !o.allowAnyPayee) {
      wallet.close();
      throw new Error(`Budget ${o.budgetId} has an empty payee list, which allows any payee. This wallet refuses it; set ALLOW_ANY_PAYEE=1 (allowAnyPayee) only if the owner meant any payee`);
    }
    return wallet;
  }

  get publicKey(): PublicKey {
    return this.agent.publicKey;
  }

  get token() {
    return this.#info!.token;
  }

  fmt(atomic: bigint | string): string {
    return `${formatAmount(atomic, this.token.decimals)} ${this.token.symbol}`;
  }

  /** Closes the receipt store (call on shutdown). */
  close(): void {
    this.agent.close();
  }

  /** The budget, policy and allowlist, verified by the SDK against the budget id (a node cannot loosen them). */
  async #policy(): Promise<VerifiedPolicy | null> {
    return this.agent.loadPolicy().catch(() => null);
  }

  /**
   * What the node sells: its service directory (GATEWAY.md section 13.4), with links and paid endpoints. A node without
   * the gateway has no directory, so the provider catalog is the fallback; it also supplies endpoint call counts.
   * Names, descriptions and categories are written by sellers: they are cleaned and capped, and they stay data.
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
    const allowed = (payee: AccountId) => (allow ? (allow.length === 0 ? this.#o.allowAnyPayee === true : allow.includes(payee)) : null);
    const calls = new Map(catalog.map((p) => [p.id, p.calls24h ?? null]));
    if (!directory) {
      return catalog.map((p) => ({
        type: "endpoint" as const,
        id: p.id,
        name: cleanText(p.name, MAX.name),
        description: cleanText(p.description, MAX.description),
        category: cleanText(p.category, MAX.category),
        url: p.resource,
        payee: p.payee,
        priceAtomic: p.priceAtomic,
        price: this.fmt(p.priceAtomic),
        schemes: ["payminto-voucher"],
        calls24h: p.calls24h ?? null,
        allowedByBudget: allowed(p.payee),
      }));
    }
    return directory.services.map((s): Service => {
      if (s.type === "endpoint") {
        return {
          type: "endpoint",
          id: s.id,
          name: cleanText(s.title, MAX.name),
          description: cleanText(s.description, MAX.description),
          category: cleanText(s.category, MAX.category),
          url: s.pay_url,
          payee: s.payee,
          priceAtomic: s.price.amount,
          price: this.fmt(s.price.amount),
          schemes: s.schemes,
          calls24h: calls.get(s.id) ?? null,
          allowedByBudget: allowed(s.payee),
        };
      }
      const fixed = s.price.amount ?? null;
      const range = fixed ? null : { min_amount: s.price.min_amount ?? null, max_amount: s.price.max_amount ?? null };
      return {
        type: "link",
        id: s.id,
        name: cleanText(s.title, MAX.name),
        description: cleanText(s.description ?? "", MAX.description),
        category: "payment-link",
        url: s.pay_url,
        payee: null,
        priceAtomic: fixed,
        price: fixed ? this.fmt(fixed) : `${this.fmt(range?.min_amount ?? "0")} to ${range?.max_amount ? this.fmt(range.max_amount) : "any amount"} (pass amountAtomic)`,
        ...(range ? { minAtomic: range.min_amount, maxAtomic: range.max_amount } : {}),
        merchant: cleanText(s.merchant.name, MAX.name),
        schemes: s.schemes,
        calls24h: null,
        allowedByBudget: null,
      };
    });
  }

  #hostAllowed(u: URL): boolean {
    return this.#payableHosts.has(u.host.toLowerCase());
  }

  #notAllowed(u: URL): TargetRefused {
    return new TargetRefused("CLIENT_TARGET_NOT_ALLOWED", `${u.origin}${u.pathname} is not listed by this wallet's clearing node, and ${u.host} is not on this wallet's host allowlist`);
  }

  /**
   * The one URL a call may go to. A service id always means the URL its directory entry has: a `url` passed with it
   * must be that same endpoint and can only add a query string. A bare `url` must be an endpoint the node lists, or
   * sit on a host the operator allowed. Anything else is refused before any request leaves this process.
   */
  async #resolve(a: CallArgs): Promise<{ url: string; service: string | null }> {
    const given = a.url === undefined ? null : httpUrl(a.url);
    const dir = await this.services();
    let target: URL;
    let service: string | null = null;
    if (a.serviceId !== undefined) {
      const byId = dir.filter((x) => x.id === a.serviceId);
      const matches = byId.length ? byId : dir.filter((x) => x.name.toLowerCase() === a.serviceId!.toLowerCase());
      if (matches.length === 0) throw new Error("unknown serviceId; call list_paid_services for valid ids");
      if (matches.length > 1) throw new Error(`${matches.length} services share that name; pass the id from list_paid_services`);
      const s = matches[0]!;
      const listed = endpointKeyOf(s.url);
      if (listed === null) throw new Error("the directory has no absolute URL for this service, so it cannot be called by id");
      if (given && endpointKey(given) !== listed) {
        throw new TargetRefused("CLIENT_TARGET_MISMATCH", `the url is not the endpoint of service ${s.id}; pass the serviceId alone, or the url alone`);
      }
      target = given ?? httpUrl(s.url);
      service = s.name;
    } else if (given) {
      const s = dir.find((x) => endpointKeyOf(x.url) === endpointKey(given));
      if (!s && !this.#hostAllowed(given)) throw this.#notAllowed(given);
      target = given;
      service = s?.name ?? null;
    } else {
      throw new Error("pass either serviceId or url");
    }
    for (const [k, v] of Object.entries(a.query ?? {})) target.searchParams.set(k, String(v));
    return { url: target.toString(), service };
  }

  /** The node's own x402 route for a link the directory lists (the directory's URL is the checkout page for people). */
  #linkRoute(s: Service): string | null {
    const slug = /\/l\/([^/]+)\/?$/.exec(new URL(s.url).pathname)?.[1];
    return slug ? `${this.node.baseUrl}/v1/pay/l/${slug}` : null;
  }

  /** The one URL a link payment may go to: a link the node's directory lists, or a host the operator allowed. */
  async #resolveLink(a: LinkArgs): Promise<{ url: string; service: string | null }> {
    const given = a.url === undefined ? null : httpUrl(a.url);
    const links = (await this.services()).filter((s) => s.type === "link" && endpointKeyOf(s.url) !== null);
    const routes = new Map(links.map((s) => [s.id, this.#linkRoute(s)]));
    const sameLink = (s: Service, u: URL) => endpointKeyOf(s.url) === endpointKey(u) || (routes.get(s.id) ? endpointKeyOf(routes.get(s.id)!) === endpointKey(u) : false);
    let target: URL;
    let service: string | null = null;
    if (a.linkId !== undefined) {
      const s = links.find((x) => x.id === a.linkId);
      if (!s) throw new Error("unknown linkId; call list_paid_services for the payment links this wallet can pay");
      if (given && !sameLink(s, given)) throw new TargetRefused("CLIENT_TARGET_MISMATCH", `the url is not link ${s.id}; pass the linkId alone, or the url alone`);
      target = given ?? httpUrl(routes.get(s.id) ?? s.url);
      service = s.name;
    } else if (given) {
      const s = links.find((x) => sameLink(x, given));
      if (!s && !this.#hostAllowed(given)) throw this.#notAllowed(given);
      target = given;
      service = s?.name ?? null;
    } else {
      throw new Error("pass either linkId or url");
    }
    if (a.amountAtomic !== undefined) {
      if (!/^[1-9]\d{0,77}$/.test(a.amountAtomic)) throw new Error("amountAtomic must be a positive integer of base units");
      target.searchParams.set("amount", a.amountAtomic);
    }
    return { url: target.toString(), service };
  }

  /**
   * The highest price this call may be signed for: the operator's maximum and the caller's, whichever is lower. The
   * Budget's per-call cap always applies too. It is checked by the policy guard, and by this wallet itself when that
   * guard is off, so no configuration leaves a price unbounded.
   */
  async #maxPrice(perCall: bigint | undefined): Promise<bigint | undefined> {
    const limits: bigint[] = [];
    if (this.#o.maxPrice !== undefined) limits.push(this.#o.maxPrice);
    if (perCall !== undefined) limits.push(perCall);
    if (this.#o.enforcePolicy === false) {
      const pol = await this.#policy();
      if (pol) limits.push(BigInt(pol.policy.perCallCap));
      else if (limits.length === 0) throw new Error("the Budget policy could not be read and no maximum price is set, so this wallet will not sign");
    }
    return limits.length ? limits.reduce((a, b) => (a < b ? a : b)) : undefined;
  }

  #report(p: PaymentOutcome): PaymentReport {
    const row = (v: PaymentOutcome["vouchers"][number]): Paid => ({ callId: v.callId, payee: v.payee, amountAtomic: v.amount.toString(), amount: this.fmt(v.amount), cumulativeAtomic: v.cumulative.toString() });
    return {
      status: p.status,
      countedAtomic: (p.paid + p.unverified).toString(),
      paidAtomic: p.paid.toString(),
      unverifiedAtomic: p.unverified.toString(),
      receipts: p.vouchers.filter((v) => v.state === "paid").map(row),
      unverified: p.vouchers.filter((v) => v.state === "unverified").map((v) => ({ ...row(v), note: v.note ?? "" })),
    };
  }

  /** Sends one request through the paying client, with the service name on hand for the receipts it produces. */
  async #pay(target: { url: string; service: string | null }, init: RequestInit, maxPrice: bigint | undefined, askPerson?: AskPerson): Promise<Sent> {
    this.#labels.set(target.url, target.service);
    const ctx: GuardContext = { ...(askPerson ? { askPerson } : {}), stop: null };
    try {
      const { response, payment } = await this.#guardContext.run(ctx, () => this.agent.pay(target.url, init, { maxPrice }));
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // not JSON: keep text
      }
      return { response, payment, body, stop: ctx.stop };
    } finally {
      this.#labels.delete(target.url);
    }
  }

  // ------------------------------------------------------------------ the Agent Market

  /** The market wiring, or null when this wallet quotes nothing there. */
  get market(): WalletMarket | null {
    return this.#o.market ?? null;
  }

  /**
   * The owner's limits as they apply to a market hire, in atomic units: the most one call may cost (the Budget's
   * per-call cap, or the operator's lower maximum), and what is left of the Budget's rolling 24 hours after what this
   * wallet has paid. Read from the verified Budget on every quote, so a changed limit applies at once.
   */
  async hireLimits(): Promise<{ maxPerHire: bigint; maxPerDay: bigint }> {
    const pol = await this.#policy();
    if (!pol) throw new Error("the Budget's terms could not be read and verified, so this wallet has no limits to check a quote against");
    const perCall = BigInt(pol.policy.perCallCap);
    const maxPerHire = this.#o.maxPrice !== undefined && this.#o.maxPrice < perCall ? this.#o.maxPrice : perCall;
    const now = Date.now();
    const spentToday = this.history.filter((h) => now - Date.parse(h.at) < 86_400_000).reduce((s, h) => s + BigInt(h.price), 0n);
    const daily = BigInt(pol.policy.dailyCap);
    return { maxPerHire, maxPerDay: daily > spentToday ? daily - spentToday : 0n };
  }

  // ------------------------------------------------------------------ the payee guard

  /** True when this wallet checks every payee before it signs. */
  get checksPayees(): boolean {
    return this.#payeeCheck !== null;
  }

  /**
   * The wallet's own verdict about an account, for `check_payee`: judged for this Budget's owner and against its
   * allowed payees, so a lookalike of one of them is caught. Read-only; it spends and signs nothing.
   */
  async checkPayee(payee: string): Promise<Verdict> {
    if (!this.#payeeCheck) {
      throw new Error("this wallet runs without a payee check. Start it with a chain reader (CHAIN_READER=rpc, NEAR_RPC_URL) and PAYEE_CHECK=on, then ask again");
    }
    const pol = await this.#policy();
    return this.#payeeCheck({ payee, payer: pol?.budget.owner ?? null, budgetPayees: pol && pol.payees.length > 0 ? pol.payees : null });
  }

  /**
   * The client's `beforeSign` hook: every payee of an offer goes through the payee check before the client signs
   * anything for that offer. A stop is kept for the call in flight, so its refusal says why, and the client answers
   * with its own structured refusal and signs nothing.
   */
  async #beforeSign(r: BeforeSignRequest): Promise<BeforeSignRefusal | null> {
    if (!this.#payeeCheck) return null;
    const ctx = this.#guardContext.getStore();
    const stop = await this.#guardPayee(r.payee, r.amount, r.total, ctx);
    if (!stop) return null;
    if (ctx) ctx.stop = stop;
    return {
      rule: stop.rule,
      message: cleanText(stop.message, 480),
      retry: stop.retry,
      details: { payeeCheck: { status: stop.status, signals: stop.signals, notChecked: stop.notChecked }, ...(stop.approveAt ? { approval: { status: stop.status, approveAt: stop.approveAt, requestId: stop.requestId } } : {}) },
    };
  }

  #remember(entry: GuardLogEntry): void {
    this.payeeLog.push(entry);
    if (this.payeeLog.length > 200) this.payeeLog.splice(0, this.payeeLog.length - 200);
  }

  /**
   * Runs the payee check for one payee of an offer. Null means the wallet may sign for it. On block it stops. On warn
   * it asks its own node whether the owner approved, and stops unless the answer is yes (or a person at the client
   * said yes where the node has nothing against the payee). If the check cannot run, it stops: fail closed.
   */
  async #guardPayee(payee: AccountId, amount: bigint, total: bigint, ctx: GuardContext | undefined): Promise<PayeeStop | null> {
    const check = this.#payeeCheck!;
    const base = { payee, attemptedAmount: total.toString(), notChecked: [] as string[], approveAt: null, requestId: null };
    const pol = await this.#policy();
    if (!pol) {
      // The client refuses to sign without a verified policy, and says so better than this guard could. Only a wallet
      // told not to enforce the policy gets here with nothing to judge the payee against.
      if (this.#o.enforcePolicy !== false) return null;
      return { ...base, rule: "PAYEE_BLOCKED", status: "check_unavailable", signals: [], retry: { kind: "after", seconds: CHECK_RETRY_SEC }, message: "The Budget's terms could not be read, so the payee could not be checked and nothing was signed; retry shortly" };
    }
    let settled: WarnState | null = null;
    const decision = await guardPayment({
      payer: pol.budget.owner,
      payee,
      amount,
      budgetPayees: pol.payees.length > 0 ? pol.payees : null,
      check,
      onWarn: async ({ verdict }) => {
        settled = await this.#settleWarn(payee, total, verdict, ctx);
        return settled.state === "owner_approved" || settled.state === "person_approved" ? "approve" : "deny";
      },
      checkTimeoutMs: 15_000,
      approvalTimeoutMs: PERSON_TIMEOUT_MS + 30_000,
      log: (entry) => this.#remember(entry),
    });
    if (decision.proceed) return null;
    const signals = heavy(decision.verdict);
    const seen = { ...base, signals, notChecked: decision.verdict?.notChecked ?? [] };
    const blocks = signals.filter((x) => x.severity === "block");
    // A verdict that blocks only because the chain could not be read is the check failing, not a finding about the payee.
    const unreadable = decision.outcome === "blocked" && blocks.length > 0 && blocks.every((x) => x.id === "check_failed");
    if (decision.outcome === "blocked" && !unreadable) {
      const top = blocks[0];
      return { ...seen, rule: "PAYEE_BLOCKED", status: "blocked", retry: { kind: "never" }, message: `${DENIAL_RULES.PAYEE_BLOCKED}${top ? `: ${top.id} (${top.reason})` : ""}` };
    }
    if (decision.outcome === "check_failed" || unreadable) {
      return { ...seen, rule: "PAYEE_BLOCKED", status: "check_unavailable", retry: { kind: "after", seconds: CHECK_RETRY_SEC }, message: "The payee could not be checked, so nothing was signed; retry shortly" };
    }
    const s = settled as WarnState | null;
    const warned = signals.map((x) => x.id).join(", ");
    if (s?.state === "owner_denied") return { ...seen, rule: "PAYEE_BLOCKED", status: "owner_denied", approveAt: s.approveAt, retry: { kind: "never" }, message: "The Budget's owner denied this payee, so nothing is paid to it" };
    if (s?.state === "node_blocked") {
      const top = s.signals.find((x) => x.severity === "block");
      return { ...seen, signals: s.signals, rule: "PAYEE_BLOCKED", status: "blocked", retry: { kind: "never" }, message: `${DENIAL_RULES.PAYEE_BLOCKED}${top ? `: ${top.id} (${top.reason})` : ""}` };
    }
    if (s?.state === "waiting") {
      return { ...seen, rule: "PAYEE_NEEDS_APPROVAL", status: "waiting", approveAt: s.approveAt, requestId: s.requestId, retry: approvalHint(payee, s.approveAt), message: `${DENIAL_RULES.PAYEE_NEEDS_APPROVAL}: ${warned}` };
    }
    if (s?.state === "person_declined") {
      return { ...seen, rule: "PAYEE_NEEDS_APPROVAL", status: "person_declined", retry: { kind: "never" }, message: `The person asked at this client declined to pay this payee (${warned})` };
    }
    const why = s?.state === "unknown" ? s.why : "nobody answered in time";
    return { ...seen, rule: "PAYEE_NEEDS_APPROVAL", status: "unknown", retry: { kind: "after", seconds: CHECK_RETRY_SEC }, message: `${DENIAL_RULES.PAYEE_NEEDS_APPROVAL} (${warned}), and this wallet could not ask its clearing node whether the owner has: ${why}` };
  }

  /** Asks this wallet's own node about a payee, with a request the agent key signed. The node records that a call waits. */
  async #askNode(payee: AccountId, amount: bigint): Promise<ApprovalAnswer> {
    const request = { budgetId: this.budgetId, payee, amount: amount.toString() };
    const signature = signDigest(this.agent.keypair.secretKey, payeeApprovalRequestDigest(this.hub, this.network, request));
    return this.node.request("POST", `/v1/budgets/${this.budgetId}/payee-approvals/requests`, approvalAnswerSchema, { payee, amount: request.amount, signature });
  }

  /**
   * Settles a warn. The node is asked first, always: an owner's yes or no there decides. A person at the client is
   * asked only when the node itself has nothing against the payee, because a voucher the node would refuse is not
   * worth signing whatever anyone at the client says.
   */
  async #settleWarn(payee: AccountId, amount: bigint, verdict: Verdict, ctx: GuardContext | undefined): Promise<WarnState> {
    const warned = heavy(verdict);
    let node: ApprovalAnswer | null = null;
    let nodeError = "";
    try {
      node = await this.#askNode(payee, amount);
    } catch (err) {
      nodeError = cleanText(err instanceof Error ? err.message : String(err), 160);
    }
    if (node?.status === "approved") return { state: "owner_approved" };
    if (node?.status === "denied") return { state: "owner_denied", approveAt: node.approveAt };
    if (node?.status === "blocked") return { state: "node_blocked", signals: node.payeeCheck.signals.map((s) => ({ id: cleanText(s.id, 64), severity: s.severity, reason: cleanText(s.reason, 400) })) };
    const nodeWouldRefuse = node !== null && node.payeeCheck.enabled && node.payeeCheck.verdict !== "allow";
    if (!nodeWouldRefuse) {
      const now = Date.now();
      const said = this.#personApproved.get(payee);
      if (said && said.untilMs > now && warned.every((s) => said.signals.has(s.id))) return { state: "person_approved" };
      if (ctx?.askPerson) {
        const answer = await ctx.askPerson({ payee, amountAtomic: amount.toString(), amount: this.fmt(amount), reasons: warned.map((s) => `${s.id}: ${s.reason}`) }).catch((): "unavailable" => "unavailable");
        if (answer === "approve") {
          this.#personApproved.set(payee, { signals: new Set(warned.map((s) => s.id)), untilMs: now + PERSON_APPROVAL_MS });
          return { state: "person_approved" };
        }
        if (answer === "deny") return { state: "person_declined" };
      }
    }
    if (node) return { state: "waiting", approveAt: node.approveAt, requestId: node.request?.id ?? null };
    return { state: "unknown", why: nodeError || "the node did not answer" };
  }

  /** A payment the guard stopped: nothing was signed, so nothing was paid. */
  #payeeStopped(stop: PayeeStop, target: { url: string; service: string | null }, payment: PaymentReport): Denied {
    return {
      ok: false,
      kind: "denied",
      rule: stop.rule,
      ruleText: DENIAL_RULES[stop.rule],
      message: cleanText(stop.message, 480),
      enforcedBy: "agent",
      attemptedAmount: stop.attemptedAmount,
      remainingBudget: null,
      retry: stop.retry,
      sellerText: null,
      sellerHint: null,
      status: null,
      ...target,
      details: { enforcedBy: "agent", payee: stop.payee, payeeCheck: { status: stop.status, signals: stop.signals, notChecked: stop.notChecked }, ...(stop.approveAt ? { approval: { status: stop.status, approveAt: stop.approveAt, requestId: stop.requestId } } : {}) },
      payeeStop: stop,
      payment,
    };
  }

  /**
   * A seller relayed PAYEE_BLOCKED or PAYEE_NEEDS_APPROVAL. Its word is unauthenticated, so the wallet asks its own
   * node the same question, signed with the agent key, and reports the node's answer next to the seller's.
   */
  async #nodeSays(rule: string, outcome: PaymentOutcome): Promise<Denied["nodeSays"]> {
    const v = outcome.vouchers[0];
    if ((rule !== "PAYEE_NEEDS_APPROVAL" && rule !== "PAYEE_BLOCKED") || !v) return undefined;
    try {
      const a = await this.#askNode(v.payee, outcome.vouchers.reduce((s, x) => s + x.amount, 0n));
      if (a.status === "approved") return undefined;
      const hint = approvalHint(v.payee, a.approveAt);
      return { status: a.status, approveAt: hint.kind === "approval" ? hint.approveAt : null, signals: a.payeeCheck.signals.filter((s) => s.severity !== "info").map((s) => ({ id: cleanText(s.id, 64), severity: s.severity, reason: cleanText(s.reason, 400) })) };
    } catch {
      return undefined;
    }
  }

  /** A refusal decided here, before any request: nothing was signed, so nothing was paid. */
  #targetRefused(err: TargetRefused, url: string | null, service: string | null): Denied {
    return {
      ok: false,
      kind: "denied",
      rule: err.rule,
      ruleText: WALLET_RULES[err.rule]!,
      message: err.message,
      enforcedBy: "agent",
      attemptedAmount: null,
      remainingBudget: null,
      retry: { kind: "never" },
      sellerText: null,
      sellerHint: null,
      status: null,
      url,
      service,
      payment: NONE,
    };
  }

  /**
   * Calls a service, paying its x402 payminto-voucher requirement from the budget if it asks for one. `askPerson` is
   * how a person at the client can be asked about a payee with warnings; without it only the node's approval counts.
   */
  async call(a: CallArgs, o: { askPerson?: AskPerson } = {}): Promise<CallOutcome> {
    let target: { url: string; service: string | null };
    let maxPrice: bigint | undefined;
    try {
      target = await this.#resolve(a);
      maxPrice = await this.#maxPrice(atomic(a.maxAmountAtomic, "maxAmountAtomic"));
    } catch (err) {
      if (err instanceof TargetRefused) return this.#targetRefused(err, a.url ?? null, a.serviceId ?? null);
      return { ok: false, kind: "error", message: (err as Error).message, status: null, url: a.url ?? null, service: a.serviceId ?? null, payment: NONE };
    }
    const method = a.method ?? (a.body === undefined ? "GET" : "POST");
    const init: RequestInit = { method, headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" } };
    if (a.body !== undefined && method !== "GET") {
      init.body = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
      init.headers = { ...init.headers, "content-type": typeof a.body === "string" ? "text/plain" : "application/json" };
    }
    let sent: Sent;
    try {
      sent = await this.#pay(target, init, maxPrice, o.askPerson);
    } catch (err) {
      return this.#failed(err, target);
    }
    const { response: res, payment: outcome } = sent;
    const payment = this.#report(outcome);
    if (sent.stop) return this.#payeeStopped(sent.stop, target, payment);
    if (res.status === 402) {
      return this.#refused(outcome, payment, target, "the service requires a payment this wallet cannot make: no payminto-voucher offer for this network and clearing hub");
    }
    const max = this.#o.maxBodyChars ?? 16_000;
    let body = sent.body;
    let truncated = false;
    if (typeof body === "string" && body.length > max) {
      body = body.slice(0, max);
      truncated = true;
    } else if (body !== null && typeof body === "object" && JSON.stringify(body).length > max) {
      body = JSON.stringify(body).slice(0, max);
      truncated = true;
    }
    // What was paid is reported on every outcome: a seller can take the voucher and still answer an error.
    if (!res.ok) return { ok: false, kind: "error", message: `service answered HTTP ${res.status}`, status: res.status, body, ...target, payment };
    return { ok: true, status: res.status, paid: payment.receipts[0] ?? null, payment, body, truncated, ...target };
  }

  /** A request that could not finish. The client still says what it paid: a voucher may have left before it died. */
  #failed(err: unknown, target: { url: string; service: string | null }): Failed {
    const payment = err instanceof PayFailed ? this.#report(err.payment) : NONE;
    return { ok: false, kind: "error", message: `request failed: ${cleanText(err instanceof Error ? err.message : String(err), 300)}`, status: null, ...target, payment };
  }

  /**
   * Pays a payment link (or a single payment's pay URL) from the budget, with the payminto-voucher path only: a fee-
   * carrying link takes two vouchers (merchant net and platform fee), both checked against the budget before signing.
   * Never pays x402 `exact`, which no budget policy covers. Money moves at the next clearing batch; until then the
   * payment is `processing`.
   */
  async payLink(a: LinkArgs, o: { askPerson?: AskPerson } = {}): Promise<LinkOutcome> {
    let target: { url: string; service: string | null };
    let maxPrice: bigint | undefined;
    try {
      target = await this.#resolveLink(a);
      maxPrice = await this.#maxPrice(atomic(a.maxAmountAtomic, "maxAmountAtomic"));
    } catch (err) {
      if (err instanceof TargetRefused) return this.#targetRefused(err, a.url ?? null, a.linkId ?? null);
      return { ok: false, kind: "error", message: (err as Error).message, status: null, url: a.url ?? null, service: a.linkId ?? null, payment: NONE };
    }
    let sent: Sent;
    try {
      // Non-HTML Accept: a dashboard /l/ link proxies agents to the node's x402 route instead of the checkout page.
      sent = await this.#pay(target, { headers: { accept: "application/json" } }, maxPrice, o.askPerson);
    } catch (err) {
      return this.#failed(err, target);
    }
    const { response: res, payment: outcome, body } = sent;
    const spend = this.#report(outcome);
    if (sent.stop) return this.#payeeStopped(sent.stop, target, spend);
    if (res.status === 402) return this.#refused(outcome, spend, target, "the link offers no payminto-voucher payment for this network and clearing hub (this wallet never pays x402 exact)");
    if (!res.ok) return { ok: false, kind: "error", message: `link answered HTTP ${res.status}`, status: res.status, ...target, body, payment: spend };
    // Only receipts the AgentClient verified against this wallet's own node count as a payment.
    const paidBody = linkBodySchema.safeParse(body);
    const paid = outcome.vouchers.filter((v) => v.state === "paid");
    if (outcome.status !== "paid") {
      return { ok: false, kind: "error", message: "the link answered success, but this wallet could not verify a receipt for every voucher it sent; treat the payment as unconfirmed", status: res.status, ...target, payment: spend };
    }
    if (!paidBody.success) return { ok: false, kind: "error", message: "the link was paid, but its answer names no payment", status: res.status, ...target, payment: spend };
    const paymentId = paidBody.data.payment_id;
    // A split pays the merchant first, then the platform fee, in the order the requirement lists them.
    const vouchers: LinkPayment["breakdown"]["vouchers"] = paid.map((v, i) => ({ callId: v.callId, payee: v.payee, amount: v.amount.toString(), role: i === 0 ? "merchant" : "platform fee" }));
    for (const h of this.history) if (vouchers.some((v) => v.callId === h.receipt.callId)) h.service = `link ${paymentId}`;
    const total = outcome.paid;
    const fee = paid.slice(1).reduce((s, v) => s + v.amount, 0n);
    const view = await this.node.get(`/v1/checkout/${paymentId}`, checkoutViewSchema).catch(() => null);
    return {
      ok: true,
      spend,
      payment: {
        paymentId,
        status: cleanText(paidBody.data.status, 40),
        merchant: view ? cleanText(view.merchant.name, MAX.name) : null,
        url: target.url,
        amountAtomic: total.toString(),
        amount: this.fmt(total),
        breakdown: {
          price: view?.amount ?? null,
          surcharge: view?.surcharge ?? null,
          amountDue: paidBody.data.amount_due,
          merchantNet: vouchers[0]!.amount,
          platformFee: fee.toString(),
          vouchers,
        },
        orderHash: paidBody.data.order_hash ?? null,
        proofUrl: paidBody.data.proof_url ?? null,
        proofApi: `${this.node.baseUrl}/v1/checkout/${paymentId}/proof`,
      },
    };
  }

  /**
   * A 402 after AgentClient.pay. The client says who refused: this wallet before signing (the owner's policy, verified
   * against the Budget id), or the seller after a voucher was sent (its unsigned word). Nothing a seller wrote is used
   * as a rule, a rule text or an instruction here; its text travels in `sellerText` only.
   */
  async #refused(outcome: PaymentOutcome, payment: PaymentReport, target: { url: string; service: string | null }, noOffer: string): Promise<Denied | Failed> {
    const r = outcome.refusal;
    if (!r) return { ok: false, kind: "error", message: noOffer, status: 402, ...target, payment };
    const ruleText = r.code in DENIAL_RULES ? DENIAL_RULES[r.code as DenialRule] : (WALLET_RULES[r.code] ?? "Payment refused");
    const base = { ok: false as const, kind: "denied" as const, rule: r.code, ruleText, status: 402, ...target, payment };
    if (r.source === "agent") {
      const hint = { attemptedAmount: r.refusal?.attemptedAmount ?? null, remainingBudget: r.refusal?.remainingBudget ?? null, retry: r.refusal?.retry ?? null };
      // The message of a wallet-side refusal can quote the node (a policy that could not be read): cleaned like any other.
      return { ...base, ...hint, message: cleanText(r.message, 300), enforcedBy: "agent", sellerText: null, sellerHint: null, ...(r.details ? { details: r.details } : {}) };
    }
    // The amount is what this wallet signed. What the seller says about the Budget and about retrying is its own word.
    const signed = outcome.paid + outcome.unverified;
    const nodeSays = await this.#nodeSays(r.code, outcome);
    return {
      ...base,
      ...(nodeSays ? { nodeSays } : {}),
      attemptedAmount: signed > 0n ? signed.toString() : null,
      remainingBudget: null,
      retry: null,
      message: ruleText,
      enforcedBy: "seller",
      sellerText: r.sellerText ? cleanText(r.sellerText, MAX.sellerText) : null,
      sellerHint: r.refusal ? { retry: r.refusal.retry, remainingBudget: r.refusal.remainingBudget } : null,
    };
  }

  /** Budget: verified budget and policy, node positions per allowed payee, and on-chain state when RPC_URL is set. */
  async budgetStatus() {
    const pol = await this.#policy();
    // An empty allowlist means any payee, so the positions to add up come from the node's catalog.
    const payees = pol && pol.payees.length > 0 ? pol.payees : [...new Set((await this.services()).flatMap((s) => (s.payee ? [s.payee] : [])))];
    let cumulative = 0n;
    let settled = 0n;
    for (const payee of payees) {
      const p = await this.node.get(`/v1/budgets/${this.budgetId}/position?payee=${payee}`, positionSchema).catch(() => null);
      if (!p) continue;
      cumulative += BigInt(p.cumulative);
      settled += BigInt(p.settled);
    }
    const b = this.#chain ? await this.#chain.budget(this.budgetId).catch(() => null) : null;
    const onchain = b ? { spent: b.spent, escrow: b.escrow, revoked: b.revokedAt !== null } : null;
    const now = Date.now();
    const sessionToday = this.history.filter((h) => now - Date.parse(h.at) < 86_400_000).reduce((s, h) => s + BigInt(h.price), 0n);
    const pending = cumulative - settled;
    const settledTotal = onchain && onchain.spent > settled ? onchain.spent : settled;
    const total = settledTotal + pending;
    const out: Record<string, unknown> = {
      budgetId: this.budgetId,
      agent: this.publicKey,
      token: this.token,
      spent: { total: this.fmt(total), settled: this.fmt(settledTotal), pending: this.fmt(pending), totalAtomic: total.toString() },
      sessionCalls: this.history.length,
      spentThisSession24h: this.fmt(sessionToday),
      payableHosts: [...this.#payableHosts],
    };
    if (pol) {
      const cap = pol.budget.cap;
      const remaining = cap > total ? cap - total : 0n;
      const perCall = BigInt(pol.policy.perCallCap);
      const maxPrice = this.#o.maxPrice !== undefined && this.#o.maxPrice < perCall ? this.#o.maxPrice : perCall;
      out.cap = this.fmt(cap);
      out.remaining = this.fmt(remaining);
      out.remainingAtomic = remaining.toString();
      out.perCallCap = this.fmt(pol.policy.perCallCap);
      out.maxPricePerCall = this.fmt(maxPrice);
      out.maxPricePerCallAtomic = maxPrice.toString();
      out.dailyCap = this.fmt(pol.policy.dailyCap);
      out.hourlyCap = BigInt(pol.policy.hourlyCap ?? "0") > 0n ? this.fmt(pol.policy.hourlyCap!) : "none";
      out.maxRepeatsPerRequest = (pol.policy.maxRepeatsPerRequest ?? 0) === 0 ? "unlimited" : pol.policy.maxRepeatsPerRequest;
      out.maxCallsPerMinute = pol.policy.maxCallsPerMinute === 0 ? "unlimited" : pol.policy.maxCallsPerMinute;
      out.purpose = cleanText(pol.policy.purpose, 300);
      out.expiresAt = new Date(Number(pol.budget.validUntil)).toISOString();
      out.allowedPayees = pol.payees;
      if (pol.payees.length === 0) out.anyPayee = this.#o.allowAnyPayee === true ? "allowed by this wallet's operator (ALLOW_ANY_PAYEE)" : "refused: the payee list is empty and the operator did not opt in";
      out.policyVerified = "terms, policy and allowlist hash to this Budget id";
    } else out.note = "the node did not serve a verifiable policy for this budget; caps unknown, payments will be refused by this wallet";
    if (onchain) {
      out.revoked = onchain.revoked;
      out.escrow = this.fmt(onchain.escrow);
    }
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
        digest: h.receipt.digest,
        node: h.receipt.node,
      }));
  }

  /**
   * Proves one call this wallet paid against the batch receipts root stored on chain, checking the node's answer
   * independently. The proof must be for the call that was asked for and for the receipt this wallet holds, and the
   * batch must have been settled by the settler the Budget names on chain. What the node says about itself in
   * /v1/info is not used for that.
   */
  async prove(callId: string) {
    if (!/^[0-9a-f]{64}$/.test(callId)) throw new Error("callId must be a 32-byte lowercase hex id from get_receipts");
    const id: Id32 = callId;
    const mine = this.agent.receipts.get(id) ?? null;
    if (!mine) {
      return { callId: id, status: "unknown", settled: false, proven: false, message: "This wallet holds no receipt for this call, so it cannot prove it. Use a callId from get_receipts." };
    }
    const p = await this.node.get(`/v1/receipts/${id}/proof`, proofSchema);
    if (!p.batchId || !p.receiptsRoot) {
      return { callId: id, status: cleanText(p.status, 40), settled: false, proven: false, message: "This call is cleared but not settled yet; it lands in the next batch. Ask again after settlement." };
    }
    const r = p.receipt;
    // The node must answer about this call, with the receipt this wallet was given for it. The checks below then run on
    // the wallet's own copy, so a proof of some other call can never be reported as a proof of this one.
    const sameCall = r.callId === id;
    const matchesMyReceipt = sameCall && r.digest === mine.digest && r.nodeSignature === mine.nodeSignature;
    const fields = { callId: mine.callId, budgetId: mine.budgetId, payee: mine.payee, amount: BigInt(mine.amount), cumulative: BigInt(mine.cumulative), requestHash: mine.requestHash, timestampMs: BigInt(mine.timestamp) * 1000n, voucherSig: mine.voucherSig };
    const localProofValid = verifyMerkleProof(p.receiptsRoot, receiptLeaf(this.hub, this.network, p.batchId, fields), p.proof);
    // A root on chain proves only that a settler committed to it: the batch must have been settled by the settler this
    // Budget names on chain, and the receipt must carry the node's signature and this agent's voucher signature.
    let independentlyVerifiedOnchain: boolean | null = null;
    let check: Awaited<ReturnType<typeof verifyReceiptOnchain>> | null = null;
    let chainError: string | null = null;
    let onchainRoot: Id32 | null = null;
    let budgetSettler: AccountId | null = null;
    let mismatch: string | null = !sameCall ? "the node answered with the receipt of another call" : !matchesMyReceipt ? "the node's receipt for this call differs from the one this wallet holds" : null;
    if (this.#chain) {
      try {
        const [budget, pol, nodeKey] = await Promise.all([this.#chain.budget(this.budgetId), this.#policy(), this.agent.nodeKey()]);
        if (!budget) throw new Error("the hub has no such Budget");
        budgetSettler = budget.settler;
        // The verified terms hash to the Budget id, and the id is what the vouchers were signed for: the two must agree.
        if (pol && pol.budget.settler !== budget.settler) mismatch ??= `the hub names settler ${budget.settler} for this Budget, but its verified terms name ${pol.budget.settler}`;
        check = await verifyReceiptOnchain({ chain: this.#chain, operator: budget.settler, nodeKey, agentPk: this.publicKey, receipt: mine, batchId: p.batchId, proof: p.proof });
        independentlyVerifiedOnchain = check.verified && mismatch === null;
        onchainRoot = (await this.#chain.batch(p.batchId))?.root ?? null;
      } catch (err) {
        chainError = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      callId: id,
      status: cleanText(p.status, 40),
      settled: true,
      proven: independentlyVerifiedOnchain === true,
      batchId: p.batchId,
      batchStatus: p.batchStatus ? cleanText(p.batchStatus, 40) : null,
      receiptsRoot: p.receiptsRoot,
      proofLength: p.proof.length,
      proof: p.proof,
      txHash: p.txHash ? cleanText(p.txHash, 128) : null,
      explorerUrl: p.txHash ? explorerTx(this.network, cleanText(p.txHash, 128)) : null,
      amount: this.fmt(mine.amount),
      payee: mine.payee,
      nodeSaysVerifiedOnchain: p.onchainVerified,
      independentlyVerifiedOnchain,
      /** Who settled the batch, and the settler the Budget names on chain: they must be the same account. */
      settler: check?.settler ?? null,
      budgetSettler,
      settledByBudgetSettler: check?.settlerIsNode ?? null,
      settledByNode: check?.settlerIsNode ?? null,
      nodeSigned: check?.nodeSigned ?? null,
      agentSigned: check?.agentSigned ?? null,
      notVerifiedBecause: mismatch ?? check?.reason ?? (chainError ? `the chain could not be read: ${cleanText(chainError, 200)}` : null),
      /** The root the hub stores for this batch, and whether the node served the same one. */
      onchainRoot,
      nodeRootMatchesChain: onchainRoot === null ? null : onchainRoot === p.receiptsRoot,
      localProofValid,
      matchesMyReceipt,
    };
  }
}

/**
 * The check a wallet runs when it is given none: read-only RPC on the public endpoint of its node's network, the
 * NearBlocks indexer on testnet only, and the code each payee ran remembered for this process.
 */
function defaultPayeeCheck(network: Network): PayeeCheckFactory {
  const rpcUrl = networks[network]?.rpcUrl;
  if (!rpcUrl) throw new Error(`this wallet has no RPC endpoint to check payees on ${network}: pass payeeCheck (see rpcPayeeCheck), or signWithoutPayeeCheck to sign without one`);
  return rpcPayeeCheck({ rpcUrl, indexer: network === "near:testnet" ? "nearblocks" : "off" });
}
