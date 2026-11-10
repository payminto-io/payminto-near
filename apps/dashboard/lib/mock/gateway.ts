/**
 * In-browser gateway node for NEXT_PUBLIC_MOCK (docs/GATEWAY.md sections 4 to 8).
 * One store serves both the merchant pages (MockGatewayApi) and the hosted checkout (MockCheckoutApi), so a payment
 * paid on /pay/{id} shows up as paid in the console in the same tab. The merchant is "Acme Store", every address is
 * derived from a label, and nothing here touches a chain.
 * Fixed demo payments exist in every checkout state; their ids start with "pay_demo" followed by the state.
 */
import { orderFingerprint, type ServedOrder } from "../payment-proof";
import type { ReaderSource } from "../near-reader";
import { mockReader } from "./rpc";
import { canonicalJson, checkoutPayTx, type PayoutProof, computeFees, feeBreakdownToJson, NEAR_TESTNET_USDC, networkFor, sha256Text, type AccountId, type Id32, type WalletTx } from "@payminto/protocol";
import { ApiError } from "../http";
import { getMerchantScope } from "../merchant-scope";
import type { CreateMerchantBody, FeePlanBody, MerchantPatch as OperatorMerchantPatch, OperatorApi, PayoutHistoryEntry } from "../operator-api";
import type { MockTxOutcome } from "./server";
import { plainAmount } from "../gateway";
import { MockIntents } from "./intents";
import { demo } from "./scenario";
import type {
  CreateLinkBody,
  CreateRefundBody,
  CreateWebhookBody,
  CheckoutApi,
  GatewayApi,
  GatewayPage,
  IntentsPayoutBody,
  MerchantPatch,
  PaymentsQuery,
  SubmitRefundBody,
  UpdateLinkBody,
  UpdateWebhookBody,
  WebhookScope,
} from "../gateway-api";
import { REPORT_CSV_COLUMNS, reportCsvCell, type BudgetRefusal, type ReportCsvColumn } from "@payminto/protocol";
import type {
  PlatformFees,
  FeePlan,
  Merchant,
  MerchantMethod,
  Platform,
  DenyListEntry,
  PaymentProof,
  ScreeningDecision,
  LineItem,
  OrderCommitment,
  ApiKey,
  CheckoutView,
  CreatedApiKey,
  Credit,
  GatewayOverview,
  Info,
  IntentsOptions,
  IntentsPayout,
  IntentsQuote,
  MerchantProfile,
  Payment,
  PaymentDetail,
  PaymentLink,
  PaymentMethod,
  PaymentStatus,
  PublicLink,
  Refund,
  TimelineEvent,
  WebhookDelivery,
  WebhookEndpoint,
} from "../schemas";

type Address = AccountId;
const NETWORK = "near:testnet";
const EMPTY = process.env.NEXT_PUBLIC_MOCK === "empty";
const NET = networkFor("near:testnet");
const EXPLORER = NET.explorer;
const TOKEN: AccountId = NEAR_TESTNET_USDC;
/** The hub checkout payments go to, the same account the clearing mock uses. */
const HUB: AccountId = "hub.payminto.testnet";
const USDC = 1_000_000n;
/** NEAR has single-block finality for a transfer: the node waits for one final block, not a confirmation count. */
const CONFIRMATIONS = 1;

// ---------------------------------------------------------------------------
// Deterministic randomness and ids
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261101);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Of(label: string, n = 24): string {
  const hex = sha256Text(label);
  const bytes = Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  let out = "";
  for (let i = 0; out.length < n; i++) out += B32[bytes[i % bytes.length]! % 32];
  return out;
}
/** Ids as GATEWAY.md section 4 shapes them: prefix plus 24 base32 characters. */
const gid = (prefix: string, label: string) => `${prefix}_${base32Of(`${prefix}:${label}`)}`;
/** Readable demo ids, e.g. pay_demopaid... so a reviewer can tell which state a URL opens. */
const demoId = (state: string) => `pay_${`demo${state}${base32Of(`demo:${state}`)}`.slice(0, 24)}`;
const randomId = (prefix: string) => {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(24))) s += B32[b % 32];
  return `${prefix}_${s}`;
};
/** A readable NEAR testnet account for a demo party: "acme-store-payout" becomes "acme-store-payout.testnet". */
const addr = (label: string): Address => `${label}.testnet`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** 32 bytes as base58, the text form of a NEAR transaction hash. */
function base58(hex: string): string {
  let n = BigInt(`0x${hex}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return out;
}
let hashSeq = 0;
const txHash = (label: string): string => base58(sha256Text(`gw-tx:${label}:${hashSeq++}`));
/** The Id32 the hub records a checkout payment under (CheckoutTerms.paymentId). */
const hubPaymentId = (paymentId: string): Id32 => sha256Text(`payminto.checkout:${paymentId}`);

function pick<T>(weights: [T, number][]): T {
  const r = rand();
  let acc = 0;
  for (const [v, w] of weights) {
    acc += w;
    if (r <= acc) return v;
  }
  return weights[weights.length - 1]![0];
}

const delay = (ms = 160 + Math.round(Math.random() * 220)) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const origin = () => (typeof window === "undefined" ? "http://localhost:3000" : window.location.origin);

// ---------------------------------------------------------------------------
// Merchant
// ---------------------------------------------------------------------------

const PAYOUT = addr("acme-store-payout");
const _merchantFields = ["name", "support_email", "brand_color", "logo_url"] as const;
void _merchantFields;
const TOKEN_META = { address: TOKEN, symbol: "USDC", decimals: 6 };

const FEE_RECIPIENT = addr("acme-payments");

// Fee plans, merchants and methods (GATEWAY.md section 14). Only Acme Store has gateway history in the mock.
const plans: FeePlan[] = [
  { id: gid("fp", "standard"), name: "Standard", platform_fee_bps: 50, platform_fee_fixed: "0", min_fee: null, max_fee: null, created_at: iso(Date.now() - 90 * 86_400_000) },
  { id: gid("fp", "volume"), name: "Volume", platform_fee_bps: 25, platform_fee_fixed: "0", min_fee: "50000", max_fee: (5n * 1_000_000n).toString(), created_at: iso(Date.now() - 60 * 86_400_000) },
  { id: gid("fp", "launch"), name: "Launch (no fee)", platform_fee_bps: 0, platform_fee_fixed: "0", min_fee: null, max_fee: null, created_at: iso(Date.now() - 40 * 86_400_000) },
];
const platform: Platform = { name: "Acme Payments (demo)", fee_recipient: FEE_RECIPIENT, default_fee_plan_id: plans[0]!.id, signup_mode: "approval", agent_budgets_for_businesses: false, smtp_configured: false, recovery_key_enabled: false };

const ACME_ID = gid("mer", "acme");
const merchants: Merchant[] = [
  { id: ACME_ID, livemode: false, name: "Acme Store", slug: "acme-store", status: "active", payout: addr("acme-store-payout"), support_email: "support@acme.example", brand_color: "#0f766e", logo_url: null, fee_plan_id: plans[0]!.id, created_at: iso(Date.now() - 80 * 86_400_000) },
  { id: gid("mer", "northwind"), livemode: false, name: "Northwind Coffee", slug: "northwind", status: "active", payout: addr("northwind-payout"), support_email: "hello@northwind.example", brand_color: "#9a3412", logo_url: null, fee_plan_id: plans[1]!.id, created_at: iso(Date.now() - 52 * 86_400_000), volume_30d: (3_412n * 1_000_000n).toString(), payments_30d: 611 },
  { id: gid("mer", "globex"), livemode: false, name: "Globex Data API", slug: "globex", status: "suspended", payout: addr("globex-payout"), support_email: null, brand_color: null, logo_url: null, fee_plan_id: plans[2]!.id, created_at: iso(Date.now() - 30 * 86_400_000), volume_30d: (88n * 1_000_000n).toString(), payments_30d: 41 },
];

/**
 * `?demo=intents-setup` plays a business that has not set up the any-chain checkout yet, so its settings can be walked
 * through; otherwise Acme Store takes payments from other chains (simulated) into its own NEAR account.
 */
const INTENTS_SETUP = demo("intents-setup");

const methodRows: MerchantMethod[] = merchants.flatMap((m) => [
  { merchant_id: m.id, method: "wallet" as const, enabled: true, fee_bps: 0, fee_fixed: "0", bearer: "merchant" as const, min_amount: null, max_amount: null },
  { merchant_id: m.id, method: "oneclick" as const, enabled: m.id === ACME_ID && !INTENTS_SETUP, fee_bps: 0, fee_fixed: "0", bearer: "merchant" as const, min_amount: null, max_amount: null },
  { merchant_id: m.id, method: "voucher" as const, enabled: m.id !== gid("mer", "globex"), fee_bps: 25, fee_fixed: "0", bearer: "merchant" as const, min_amount: null, max_amount: null },
]);

function quote(amount: bigint, method: PaymentMethod | null, merchantId = ACME_ID) {
  const m = merchants.find((x) => x.id === merchantId)!;
  const plan = plans.find((x) => x.id === m.fee_plan_id) ?? plans[0]!;
  const cfg = method ? methodRows.find((r) => r.merchant_id === merchantId && r.method === method) : null;
  return feeBreakdownToJson(computeFees({ amount, plan, method: cfg ? { fee_bps: cfg.fee_bps, fee_fixed: cfg.fee_fixed, bearer: cfg.bearer } : null }));
}

const merchant: MerchantProfile = {
  ...merchants[0]!,
  support_email: "support@acme.example",
  brand_color: "#0f766e",
  logo_url: null,
  livemode: false,
  network: NETWORK,
  payout: PAYOUT,
  token: TOKEN,
  hub: HUB,
  checkout_base_url: "http://localhost:3000",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type MockPayment = PaymentDetail;
/** Confirmations seen so far for each pending credit, by tx hash. */
const depth = new Map<string, number>();

const links: PaymentLink[] = [];
const payments: MockPayment[] = [];
const refunds: Refund[] = [];
/** `scope` keeps a business's endpoints apart from the platform's, as the node does. */
const endpoints: (WebhookEndpoint & { secret: string; scope: WebhookScope })[] = [];
const deliveries: WebhookDelivery[] = [];
const keys: ApiKey[] = [];

const now = Date.now();
const hourAnchor = Math.floor(now / 3_600_000) * 3_600_000;
const DAY = 86_400_000;

function link(id: string, l: Omit<PaymentLink, "id" | "livemode" | "payments_count" | "paid_total" | "url" | "listed"> & { listed?: boolean }): PaymentLink {
  const v: PaymentLink = { id, livemode: false, payments_count: 0, paid_total: "0", url: `${origin()}/l/${l.slug}`, listed: true, ...l };
  links.push(v);
  return v;
}

const PAYERS = ["mira", "jon-park", "ana-silva", "kenji", "lea", "omar", "ivy"].map(addr);

function event(type: string, at: number, data?: Record<string, unknown>): TimelineEvent {
  return { id: gid("evt", `${type}:${at}:${hashSeq++}`), type, created_at: iso(at), data: data ?? null };
}

function makePayment(args: {
  id: string;
  amount: bigint;
  status: PaymentStatus;
  createdMs: number;
  ttlMs?: number;
  link?: PaymentLink;
  description?: string;
  reference?: string | null;
  method?: PaymentMethod;
  paid?: bigint;
  payer?: Address;
  email?: string | null;
  name?: string | null;
  late?: boolean;
  metadata?: Record<string, string> | null;
  lineItems?: LineItem[];
}): MockPayment {
  const ttl = args.ttlMs ?? 30 * 60_000;
  const method = args.method ?? "wallet";
  const payer = args.payer ?? PAYERS[Math.floor(rand() * PAYERS.length)]!;
  const terminalPaid = ["paid", "overpaid", "underpaid"].includes(args.status);
  // Open payments are quoted once the payer picks a method; everything else was quoted for the method it used.
  const fees = quote(args.amount, args.status === "open" ? null : method);
  const due = BigInt(fees.amount_due);
  const paid = args.paid ?? (args.status === "paid" ? due : args.status === "overpaid" ? due + 500_000n : args.status === "underpaid" ? due - due / 5n : 0n);
  // A late credit lands after the request expired (GATEWAY.md section 4) and is still booked.
  const paidAt = args.late ? args.createdMs + ttl + 12 * 60_000 : args.createdMs + Math.round(60_000 + rand() * 6 * 60_000);
  const credits: Credit[] = [];
  const events: TimelineEvent[] = [event("payment.created", args.createdMs, { source: args.link ? "link" : "api" })];
  events.push(event("checkout.opened", args.createdMs + 8_000));
  if (paid > 0n) {
    for (const [i, amt] of [paid].entries()) {
      const hash = txHash(`${args.id}:${i}`);
      const at = paidAt - 20_000;
      credits.push({
        payment_id: args.id,
        method,
        payer,
        amount: amt.toString(),
        tx_hash: method === "voucher" ? null : hash,
        batch_id: method === "voucher" ? sha256Text(`batch:${args.id}`) : null,
        call_id: method === "voucher" ? sha256Text(`call:${args.id}`) : null,
        recorded_at_ms: method === "wallet" ? String(at + 2_000) : null,
        status: "confirmed",
        late: args.late ?? false,
        created_at: iso(at),
        confirmed_at: iso(at + 6_000),
      });
      if (method === "wallet") events.push(event("wallet.connected", at - 30_000, { payer }));
      events.push(event("transaction.broadcast", at, { tx_hash: hash, method }), event("credit.confirmed", at + 6_000, { tx_hash: hash, amount: amt.toString(), confirmations: CONFIRMATIONS }));
    }
  }
  if (terminalPaid) events.push(event(`payment.${args.status}`, paidAt, { amount_paid: paid.toString() }));
  if (args.status === "expired") events.push(event("payment.expired", args.createdMs + ttl));
  if (args.status === "canceled") events.push(event("payment.canceled", args.createdMs + 4 * 60_000));
  if (terminalPaid) events.push(event("webhook.delivered", paidAt + 1_200, { event_type: `payment.${args.status}`, status_code: 200 }));
  const p: MockPayment = {
    id: args.id,
    livemode: false,
    ...fees,
    merchant_id: ACME_ID,
    status: args.status,
    amount_paid: paid.toString(),
    amount_refunded: "0",
    refund_status: "none",
    network: NETWORK,
    token: TOKEN,
    hub: HUB,
    checkout_id: hubPaymentId(args.id),
    payout: PAYOUT,
    description: args.description ?? args.link?.title ?? null,
    reference: args.reference ?? null,
    customer_email: args.email ?? null,
    customer_name: args.name ?? null,
    metadata: args.metadata ?? {},
    line_items: args.lineItems ?? defaultItems(args.amount, args.link, args.description),
    order_hash: ZERO_HASH,
    success_url: args.link?.success_url ?? null,
    checkout_url: `${origin()}/pay/${args.id}`,
    link_id: args.link?.id ?? null,
    method: args.status === "open" ? null : method,
    payer: paid > 0n ? payer : null,
    late: args.late ?? false,
    created_at: iso(args.createdMs),
    updated_at: iso(terminalPaid ? paidAt : args.createdMs),
    expires_at: iso(args.createdMs + ttl),
    paid_at: terminalPaid ? iso(paidAt) : null,
    canceled_at: args.status === "canceled" ? iso(args.createdMs + 4 * 60_000) : null,
    credits,
    refunds: [],
    events,
    // Filled from the any-chain store when the payment is read (MockIntents).
    intents: null,
  };
  p.order_hash = orderFingerprint(canonicalJson(orderOf(p)));
  payments.push(p);
  if (p.link_id) {
    const l = links.find((x) => x.id === p.link_id);
    if (l) {
      l.payments_count += 1;
      if (terminalPaid) l.paid_total = (BigInt(l.paid_total) + paid).toString();
    }
  }
  return p;
}

const ZERO_HASH: Id32 = "0".repeat(64);

/** Line items that sum to the amount: the link title, or a product plus shipping for API orders. */
function defaultItems(amount: bigint, link: PaymentLink | undefined, description: string | undefined): LineItem[] {
  if (link) return [{ name: link.title, quantity: 1, unit_amount: amount.toString() }];
  if (description?.startsWith("Invoice")) {
    const unit = amount / 4n;
    return [
      { name: "Design retainer, October", quantity: 3, unit_amount: unit.toString() },
      { name: "Hosting", quantity: 1, unit_amount: (amount - unit * 3n).toString() },
    ];
  }
  if (amount > 5n * USDC) return [{ name: "Robot arm kit", quantity: 1, unit_amount: (amount - 5n * USDC).toString() }, { name: "Express shipping", quantity: 1, unit_amount: (5n * USDC).toString() }];
  return [{ name: description ?? "Order", quantity: 1, unit_amount: amount.toString() }];
}

/** The order a payment commits to (GATEWAY.md section 13.2). */
function orderOf(p: MockPayment): OrderCommitment {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.metadata ?? {})) metadata[k] = String(v);
  const metadataHash = Object.keys(metadata).length ? sha256Text(canonicalJson(metadata)) : ZERO_HASH;
  return { payment_id: p.id, amount: p.amount_due, token: TOKEN, payout: PAYOUT, reference: p.reference ?? null, description: p.description ?? null, line_items: p.line_items, metadata_hash: metadataHash };
}

/** The bytes a node serves at /order: the canonical JSON that order_hash is the sha256 of. */
function servedOrder(p: MockPayment): ServedOrder {
  const order = orderOf(p);
  return { raw: canonicalJson(order), order };
}

function addRefund(p: MockPayment, amount: bigint, reason: string, status: Refund["status"], atMs: number, failure?: string) {
  const r: Refund = {
    id: gid("re", `${p.id}:${amount}`),
    livemode: false,
    payment_id: p.id,
    amount: amount.toString(),
    to: p.payer ?? PAYERS[0]!,
    reason,
    status,
    method: status === "succeeded" ? "transfer" : null,
    tx_hash: status === "succeeded" ? txHash(`refund:${p.id}`) : null,
    failure_reason: failure ?? null,
    created_at: iso(atMs),
    updated_at: iso(status === "pending" ? atMs : atMs + 40_000),
  };
  refunds.push(r);
  p.refunds.push(r);
  p.events.push(event("refund.created", atMs, { refund_id: r.id, amount: r.amount }));
  if (status === "succeeded") {
    p.events.push(event("refund.succeeded", atMs + 40_000, { refund_id: r.id, amount: r.amount, tx_hash: r.tx_hash }));
    recomputeRefunds(p);
  } else if (status === "failed") p.events.push(event("refund.failed", atMs + 40_000, { refund_id: r.id, reason: failure }));
  return r;
}

function recomputeRefunds(p: MockPayment) {
  const done = p.refunds.filter((r) => r.status === "succeeded").reduce((a, r) => a + BigInt(r.amount), 0n);
  p.amount_refunded = done.toString();
  p.refund_status = done === 0n ? "none" : done >= BigInt(p.amount_paid) ? "full" : "partial";
}

function seed() {
  const pro = link(gid("plink", "pro"), {
    slug: "pro-plan",
    title: "Pro plan, monthly",
    description: "Unlimited projects and priority support for one month.",
    amount: (25n * USDC).toString(),
    min_amount: null,
    max_amount: null,
    collect_email: true,
    collect_name: false,
    success_url: "https://acme.example/thanks",
    active: true,
    max_payments: null,
    created_at: iso(hourAnchor - 34 * DAY),
  });
  const tip = link(gid("plink", "tip"), {
    slug: "tip-jar1",
    title: "Support the newsletter",
    description: "Pay what you like. Every contribution keeps the weekly issue free.",
    amount: null,
    min_amount: (1n * USDC).toString(),
    max_amount: (500n * USDC).toString(),
    collect_email: false,
    collect_name: true,
    success_url: null,
    active: true,
    max_payments: null,
    created_at: iso(hourAnchor - 21 * DAY),
  });
  const credits = link(gid("plink", "credits"), {
    slug: "api-cred",
    title: "API credits, 10k requests",
    description: "Prepaid credits for the Acme inference API.",
    amount: (10n * USDC).toString(),
    min_amount: null,
    max_amount: null,
    collect_email: true,
    collect_name: false,
    success_url: null,
    active: true,
    max_payments: 500,
    created_at: iso(hourAnchor - 12 * DAY),
  });
  const beta = link(gid("plink", "beta"), {
    slug: "beta-old",
    title: "Beta access, early bird",
    description: "Lifetime beta access at the launch price.",
    amount: (49n * USDC).toString(),
    min_amount: null,
    max_amount: null,
    collect_email: true,
    collect_name: true,
    success_url: null,
    active: false,
    max_payments: 100,
    created_at: iso(hourAnchor - 60 * DAY),
  });

  // History: about 46 payments over 30 days, mostly paid, from links and the API.
  for (let i = 0; i < 46; i++) {
    const createdMs = hourAnchor - Math.round((1 + rand() * 29.5) * DAY);
    const source = pick<PaymentLink | null>([[pro, 0.34], [tip, 0.18], [credits, 0.26], [beta, 0.04], [null, 0.18]]);
    const status = pick<PaymentStatus>([["paid", 0.7], ["expired", 0.13], ["overpaid", 0.04], ["underpaid", 0.05], ["canceled", 0.08]]);
    const amount = source?.amount ? BigInt(source.amount) : source ? BigInt(Math.round(2 + rand() * 60)) * USDC : BigInt(Math.round(5 + rand() * 180)) * USDC + BigInt(Math.round(rand() * 99)) * 10_000n;
    const method = pick<PaymentMethod>([["wallet", 0.8], ["voucher", 0.2]]);
    makePayment({
      id: gid("pay", `hist:${i}`),
      amount,
      status: source === null && status === "canceled" ? "expired" : status,
      createdMs,
      link: source ?? undefined,
      description: source ? undefined : `Order #${1040 + i}`,
      reference: source ? null : `ord_${1040 + i}`,
      method,
      email: source?.collect_email ? `buyer${i}@mail.example` : null,
      name: source?.collect_name ? ["Mira Chen", "Jon Park", "Ana Silva", "Kenji Ito"][i % 4] : null,
      metadata: source ? null : { cart_id: `cart_${7000 + i}`, channel: "web" },
    });
  }

  // One fixed payment per checkout state, created moments ago, so every panel can be opened directly.
  const fresh = now - 90_000;
  makePayment({ id: demoId("open"), amount: 25n * USDC, status: "open", createdMs: fresh, link: pro, email: "mira@mail.example" });
  makePayment({ id: demoId("soon"), amount: 10n * USDC, status: "open", createdMs: now - 28 * 60_000, link: credits });
  makePayment({ id: demoId("partial"), amount: 25n * USDC, status: "partially_paid", createdMs: fresh, link: pro, paid: 20n * USDC, method: "wallet" });
  const processing = makePayment({ id: demoId("processing"), amount: 25n * USDC, status: "processing", createdMs: fresh, link: pro, method: "wallet" });
  processing.credits.push({ payment_id: processing.id, method: "wallet", payer: PAYERS[1]!, amount: (25n * USDC).toString(), tx_hash: txHash("processing"), batch_id: null, call_id: null, recorded_at_ms: null, status: "pending", late: false, created_at: iso(now - 15_000), confirmed_at: null });
  depth.set(processing.credits[0]!.tx_hash!, 1);
  makePayment({ id: demoId("paid"), amount: 25n * USDC, status: "paid", createdMs: now - 6 * 60_000, link: pro, method: "wallet", email: "jon@mail.example" });
  makePayment({ id: demoId("overpaid"), amount: 25n * USDC, status: "overpaid", createdMs: now - 9 * 60_000, link: pro, paid: 25_500_000n, method: "wallet" });
  makePayment({ id: demoId("underpaid"), amount: 25n * USDC, status: "underpaid", createdMs: now - 50 * 60_000, link: pro, paid: 20n * USDC, method: "wallet" });
  makePayment({ id: demoId("expired"), amount: 10n * USDC, status: "expired", createdMs: now - 45 * 60_000, link: credits });
  makePayment({ id: demoId("canceled"), amount: 120n * USDC, status: "canceled", createdMs: now - 20 * 60_000, description: "Invoice INV-2026-0117", reference: "INV-2026-0117" });
  makePayment({ id: demoId("late"), amount: 10n * USDC, status: "paid", createdMs: now - 3 * 3_600_000, link: credits, method: "wallet", late: true });

  // Refunds: one full, one partial, one waiting on the payout account, one failed.
  const paidHist = payments.filter((p) => p.status === "paid" && p.id.startsWith("pay_") && !p.id.startsWith("pay_demo"));
  if (paidHist[0]) addRefund(paidHist[0], BigInt(paidHist[0].amount_paid), "Requested by customer", "succeeded", new Date(paidHist[0].paid_at!).getTime() + DAY);
  if (paidHist[3]) addRefund(paidHist[3], BigInt(paidHist[3].amount_paid) / 2n, "Duplicate", "succeeded", new Date(paidHist[3].paid_at!).getTime() + 2 * DAY);
  const over = payments.find((p) => p.status === "overpaid" && !p.id.startsWith("pay_demo"));
  if (over) addRefund(over, BigInt(over.amount_paid) - BigInt(over.amount_due), "Overpayment", "pending", now - 2 * 3_600_000);
  if (paidHist[6]) addRefund(paidHist[6], BigInt(paidHist[6].amount_paid), "Requested by customer", "failed", now - 26 * 3_600_000, "The payout account did not have enough USDC when the transfer was simulated.");

  // Webhooks: a healthy production receiver and one the worker disabled after repeated failures.
  const prod: WebhookEndpoint & { secret: string; scope: WebhookScope } = {
    scope: "business",
    id: gid("we", "prod"),
    livemode: false,
    url: "https://acme.example/api/payminto/webhooks",
    description: "Order fulfilment",
    events: ["payment.paid", "payment.overpaid", "payment.underpaid", "refund.succeeded", "refund.failed"],
    active: true,
    secret: `whsec_${base32Of("whsec:prod", 43)}`,
    created_at: iso(hourAnchor - 33 * DAY),
    success_rate_7d: 0.984,
    last_delivery_at: null,
    disabled_reason: null,
  };
  const crm: WebhookEndpoint & { secret: string; scope: WebhookScope } = {
    scope: "business",
    id: gid("we", "crm"),
    livemode: false,
    url: "https://hooks.crm.example/acme/payments",
    description: "CRM sync",
    events: ["*"],
    active: false,
    secret: `whsec_${base32Of("whsec:crm", 43)}`,
    created_at: iso(hourAnchor - 15 * DAY),
    success_rate_7d: 0,
    last_delivery_at: null,
    disabled_reason: "Disabled after 7 failed deliveries in a row.",
  };
  endpoints.push(prod, crm);
  const recent = [...payments].filter((p) => p.paid_at).sort((a, b) => b.paid_at!.localeCompare(a.paid_at!)).slice(0, 14);
  for (const [i, p] of recent.entries()) {
    const at = new Date(p.paid_at!).getTime() + 1_200;
    const evtId = gid("evt", `wh:${p.id}`);
    const body = webhookBody(evtId, `payment.${p.status}`, at, p);
    // A 503 on one delivery, then a successful retry a minute later.
    if (i === 2) deliveries.push(delivery(prod.id, evtId, `payment.${p.status}`, at, 1, "failed", 503, 10_000, body, "upstream unavailable"));
    deliveries.push(delivery(prod.id, evtId, `payment.${p.status}`, i === 2 ? at + 60_000 : at, i === 2 ? 2 : 1, "succeeded", 200, 80 + Math.round(rand() * 240), body, '{"received":true}'));
    if (i < 7) deliveries.push(delivery(crm.id, evtId, `payment.${p.status}`, at, 7 - i, "failed", i % 3 === 0 ? null : 500, i % 3 === 0 ? 10_000 : 340, body, i % 3 === 0 ? null : "Internal Server Error", i % 3 === 0 ? "Timed out after 10 s" : null));
  }
  prod.last_delivery_at = deliveries.filter((d) => d.endpoint_id === prod.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;
  crm.last_delivery_at = deliveries.filter((d) => d.endpoint_id === crm.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;

  keys.push(
    { id: gid("key", "server"), name: "Production server", prefix: "sk_test_4f2a", livemode: false, created_at: iso(hourAnchor - 33 * DAY), last_used_at: iso(now - 4 * 60_000), revoked_at: null },
    { id: gid("key", "zapier"), name: "Zapier", prefix: "sk_test_9c1e", livemode: false, created_at: iso(hourAnchor - 40 * DAY), last_used_at: iso(hourAnchor - 20 * DAY), revoked_at: iso(hourAnchor - 19 * DAY) },
  );
}

/**
 * The platform's refusal alert endpoint (`/v1/platform/webhooks`), with one `budget.refused` delivery per refusal the
 * demo node recorded. Called by the clearing mock once its refusals exist.
 */
export function seedPlatformRefusals(refusals: BudgetRefusal[]): void {
  if (endpoints.some((e) => e.scope === "platform")) return;
  const ops: WebhookEndpoint & { secret: string; scope: WebhookScope } = {
    scope: "platform",
    id: gid("we", "ops"),
    livemode: false,
    url: "https://ops.acme.example/payminto/refusals",
    description: "On-call alerts for refused agent payments",
    events: ["budget.refused"],
    active: true,
    secret: `whsec_${base32Of("whsec:ops", 43)}`,
    created_at: iso(Date.now() - 9 * DAY),
    success_rate_7d: 1,
    last_delivery_at: null,
    disabled_reason: null,
  };
  endpoints.push(ops);
  for (const [i, r] of refusals.entries()) {
    const at = new Date(r.created_at).getTime() + 400;
    const evtId = gid("evt", `refused:${r.id}`);
    deliveries.push(delivery(ops.id, evtId, "budget.refused", at, 1, "succeeded", 200, 64 + ((i * 53) % 170), webhookBody(evtId, "budget.refused", at, r), '{"ok":true}'));
  }
  ops.last_delivery_at = deliveries.filter((d) => d.endpoint_id === ops.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;
}

/** Refusals recorded after the first seeding, each with its own delivery to the platform's alert endpoint. */
export function addPlatformRefusals(refusals: BudgetRefusal[]): void {
  const ops = endpoints.find((e) => e.scope === "platform");
  if (!ops) return;
  for (const r of refusals) {
    const at = new Date(r.created_at).getTime() + 400;
    const evtId = gid("evt", `refused:${r.id}`);
    deliveries.push(delivery(ops.id, evtId, "budget.refused", at, 1, "succeeded", 200, 96, webhookBody(evtId, "budget.refused", at, r), '{"ok":true}'));
  }
  ops.last_delivery_at = deliveries.filter((d) => d.endpoint_id === ops.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;
}

function publicEndpoint(e: WebhookEndpoint & { secret: string; scope: WebhookScope }): WebhookEndpoint {
  const { secret: _s, scope: _scope, ...rest } = e;
  void _s;
  void _scope;
  return { ...rest };
}

function webhookBody(id: string, type: string, at: number, object: unknown): string {
  return JSON.stringify({ id, type, created: Math.floor(at / 1000), livemode: false, data: { object: publicObject(object) } }, null, 2);
}

/** The public payment object a webhook carries: no credits, refunds or timeline. */
function publicObject(o: unknown) {
  if (!o || typeof o !== "object" || !("credits" in o)) return o;
  const { credits: _c, refunds: _r, events: _e, ...rest } = o as MockPayment;
  void _c;
  void _r;
  void _e;
  return rest;
}

function delivery(
  endpointId: string,
  eventId: string,
  type: string,
  at: number,
  attempt: number,
  status: WebhookDelivery["status"],
  code: number | null,
  ms: number,
  body: string,
  response: string | null,
  error: string | null = null,
): WebhookDelivery {
  const schedule = [0, 60, 300, 1800, 7200, 21600, 86400];
  const next = status === "failed" && attempt < 7 ? iso(at + schedule[attempt]! * 1000) : null;
  return {
    id: gid("whd", `${endpointId}:${eventId}:${attempt}`),
    endpoint_id: endpointId,
    url: endpoints.find((e) => e.id === endpointId)?.url ?? "",
    event_id: eventId,
    event_type: type,
    status,
    response_status: code,
    duration_ms: ms,
    attempt,
    next_attempt_at: next,
    request_body: body,
    response_body: response,
    error,
    created_at: iso(at),
  };
}

// Screening (GATEWAY.md section 13.1): two merchant deny-list entries and recent refusals with source `gateway`.
const denyList: DenyListEntry[] = [];
const decisions: ScreeningDecision[] = [];
function seedScreening() {
  const scammer = addr("chargeback-farm");
  const mixer = addr("sanctioned-mixer");
  denyList.push(
    { address: scammer, note: "Repeated chargeback claims on the Pro plan", created_at: iso(hourAnchor - 9 * DAY) },
    { address: addr("bot-signups"), note: "Automated signups from one wallet", created_at: iso(hourAnchor - 4 * DAY) },
  );
  const at = (h: number) => iso(now - h * 3_600_000);
  decisions.push(
    { id: "scr_6", source: "gateway", rule: "PAYER_DENIED", message: "The payer is on this merchant's deny list.", address: scammer, payment_id: null, link_id: links[0]?.id ?? null, method: "wallet", amount: (25n * USDC).toString(), created_at: at(0.6) },
    { id: "scr_5", source: "gateway", rule: "PAYER_BLACKLISTED", message: "The token contract reports the payer as blocked.", address: mixer, payment_id: null, link_id: links[2]?.id ?? null, method: "voucher", amount: (10n * USDC).toString(), created_at: at(3.2) },
    { id: "scr_4", source: "gateway", rule: "PAYER_TOO_NEW", message: "The payer account has 0 transactions; this node requires at least 3.", address: addr("fresh-wallet"), payment_id: null, link_id: links[1]?.id ?? null, method: "voucher", amount: (4n * USDC).toString(), created_at: at(7.5) },
    { id: "scr_3", source: "gateway", rule: "PAYER_DENIED", message: "The payer is on this merchant's deny list.", address: scammer, payment_id: null, link_id: links[0]?.id ?? null, method: "wallet", amount: (25n * USDC).toString(), created_at: at(26) },
  );
}

/** The any-chain checkout of this demo node, simulated: Acme Store's NEAR account and every deposit address. */
const intents = new MockIntents(
  {
    find,
    enabled: (merchantId) => methodRows.some((r) => r.merchant_id === merchantId && r.method === "oneclick" && r.enabled),
    changed(p, opts) {
      if (opts?.reopen && p.credits.length === 0 && p.status === "processing") p.status = new Date(p.expires_at).getTime() > Date.now() ? "open" : "expired";
      settleState(p);
      notify(p);
    },
    event(p, type, data) {
      p.events.push(event(type, Date.now(), data));
    },
    merchant: { id: ACME_ID, hub: HUB },
  },
  { account: INTENTS_SETUP ? null : "acme-store.near" },
);

/** One payment paid from USDC on Base an hour ago, so the console shows an any-chain payment and its NEAR Intents card. */
function seedAnyChain() {
  const pro = links.find((l) => l.slug === "pro-plan");
  const at = now - 62 * 60_000;
  const p = makePayment({ id: demoId("anychain"), amount: 25n * USDC, status: "open", createdMs: at - 6 * 60_000, ttlMs: 60 * 60_000, link: pro, email: "ines@mail.example" });
  intents.seedPaid(p, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", at);
  Object.assign(p, { status: "paid", amount_paid: p.amount_due, method: "oneclick", payer: p.credits[0]!.payer, paid_at: iso(at), updated_at: iso(at) });
  p.events.push(event("intents.quote_created", at - 4 * 60_000, { origin: "USDC on Base" }), event("payment.processing", at - 90_000), event("payment.paid", at, { amount_paid: p.amount_due }));
  if (pro) pro.paid_total = (BigInt(pro.paid_total) + BigInt(p.amount_due)).toString();
}

if (!EMPTY) {
  seed();
  seedScreening();
  seedAnyChain();
}

// Payment links created in this browser survive a reload and open in a new tab.
const LINKS_KEY = "payminto.mock.gateway.links";
const createdHere = new Set<string>();
function loadSavedLinks() {
  try {
    const raw = window.localStorage.getItem(LINKS_KEY);
    if (!raw) return;
    for (const l of JSON.parse(raw) as PaymentLink[]) {
      createdHere.add(l.id);
      if (!links.some((x) => x.id === l.id)) links.unshift({ ...l, url: `${origin()}/l/${l.slug}` });
    }
  } catch {
    // Storage can be unavailable; created links then last for this tab only.
  }
}
function saveLinks() {
  try {
    window.localStorage.setItem(LINKS_KEY, JSON.stringify(links.filter((l) => createdHere.has(l.id))));
  } catch {
    // See loadSavedLinks.
  }
}
if (typeof window !== "undefined") {
  merchant.checkout_base_url = origin();
  if (!EMPTY) loadSavedLinks();
}

// ---------------------------------------------------------------------------
// Payment state machine (mock of GATEWAY.md section 4)
// ---------------------------------------------------------------------------

type ViewListener = (v: CheckoutView) => void;
const viewListeners = new Map<string, Set<ViewListener>>();

function notify(p: MockPayment) {
  const v = viewOf(p);
  for (const l of viewListeners.get(p.id) ?? []) l(v);
}

function find(id: string): MockPayment {
  const p = payments.find((x) => x.id === id);
  if (!p) throw new ApiError(404, "PAYMENT_NOT_FOUND", `No payment ${id} on this node.`);
  return p;
}

/** Sums confirmed credits and picks the state, the same step the node runs in one transaction. */
function settleState(p: MockPayment) {
  const confirmed = p.credits.filter((c) => c.status === "confirmed").reduce((a, c) => a + BigInt(c.amount), 0n);
  const amount = BigInt(p.amount_due);
  const expired = new Date(p.expires_at).getTime() <= Date.now();
  const before = p.status;
  p.amount_paid = confirmed.toString();
  if (confirmed === 0n) p.status = p.credits.length ? "processing" : expired ? "expired" : p.status;
  else if (confirmed === amount) p.status = "paid";
  else if (confirmed > amount) p.status = "overpaid";
  else if (p.credits.some((c) => c.status === "pending")) p.status = "processing";
  else p.status = expired ? "underpaid" : "partially_paid";
  if (p.status !== before) {
    if (["paid", "overpaid", "underpaid"].includes(p.status)) p.paid_at = iso(Date.now());
    p.events.push(event(`payment.${p.status}`, Date.now(), { amount_paid: p.amount_paid }));
  }
}

function credit(p: MockPayment, amount: bigint, method: PaymentMethod, from: Address) {
  const hash = txHash(`${p.id}:live`);
  const c: Credit = { payment_id: p.id, method, payer: from, amount: amount.toString(), tx_hash: hash, batch_id: null, call_id: null, recorded_at_ms: null, status: "pending", late: false, created_at: iso(Date.now()), confirmed_at: null };
  p.credits.push(c);
  p.method ??= method;
  p.payer ??= from;
  depth.set(hash, 0);
  p.events.push(event("transaction.broadcast", Date.now(), { tx_hash: hash, method }));
  settleState(p);
  notify(p);
  // One confirmation every 1.4 s until the finality depth, then the credit counts.
  const step = () => {
    const d = (depth.get(hash) ?? 0) + 1;
    depth.set(hash, d);
    if (d >= CONFIRMATIONS) {
      c.status = "confirmed";
      c.confirmed_at = iso(Date.now());
      c.recorded_at_ms = String(Date.now());
      p.events.push(event("credit.confirmed", Date.now(), { tx_hash: hash, amount: c.amount, confirmations: CONFIRMATIONS }));
      settleState(p);
      notify(p);
      return;
    }
    notify(p);
    setTimeout(step, 1400);
  };
  setTimeout(step, 1400);
  return hash;
}

/** A stand-in for the node's ed25519 signature over the checkout terms; the demo hub accepts it, a real one would not. */
const demoSignature = (paymentId: Id32, amount: bigint): string => sha256Text(`sig:${paymentId}:${amount}`) + sha256Text(`sig2:${paymentId}:${amount}`);

/** What the node hands the payer's wallet: signed terms and the prebuilt transfer, built with the chain package. */
function walletOf(p: MockPayment, rest: bigint): NonNullable<CheckoutView["wallet"]> {
  const terms = { payment_id: hubPaymentId(p.id), merchant: PAYOUT, amount: rest.toString(), expiry_ms: String(new Date(p.expires_at).getTime()) };
  const signature = demoSignature(terms.payment_id, rest);
  const transaction = checkoutPayTx(TOKEN, HUB, { paymentId: terms.payment_id, merchant: terms.merchant, amount: rest, expiryMs: BigInt(terms.expiry_ms) }, signature);
  return { terms, signature, checkout_key: "ed25519:DemoCheckoutKeyNotReal111111111111111111111111", transaction };
}

function viewOf(p: MockPayment): CheckoutView {
  const remaining = BigInt(p.amount_due) - BigInt(p.amount_paid);
  const rest = remaining > 0n ? remaining : 0n;
  const l = p.link_id ? links.find((x) => x.id === p.link_id) : null;
  const pending = p.credits.filter((c) => c.status === "pending").at(-1);
  const lastConfirmed = p.credits.filter((c) => c.status === "confirmed" && c.tx_hash).at(-1);
  const payable = (p.status === "open" || p.status === "partially_paid") && new Date(p.expires_at).getTime() > Date.now();
  return {
    id: p.id,
    livemode: false,
    status: p.status,
    late: p.late,
    merchant: { id: merchant.id, name: merchant.name, support_email: merchant.support_email, brand_color: merchant.brand_color, logo_url: merchant.logo_url },
    description: p.description,
    reference: p.reference,
    amount: p.amount,
    surcharge: p.surcharge,
    amount_due: p.amount_due,
    amount_paid: p.amount_paid,
    amount_remaining: rest.toString(),
    network: NETWORK,
    token: TOKEN_META,
    hub: HUB,
    method: p.method,
    methods: payable ? ["wallet", ...(intents.offered(p) ? (["oneclick"] as const) : [])] : [],
    wallet: payable && p.method === "wallet" && rest > 0n ? walletOf(p, rest) : null,
    success_url: p.success_url,
    tx_hash: (pending ?? lastConfirmed)?.tx_hash ?? null,
    order_hash: p.order_hash,
    expires_at: p.expires_at,
    created_at: p.created_at,
    confirmations: pending?.tx_hash ? { current: depth.get(pending.tx_hash) ?? 0, required: CONFIRMATIONS } : null,
    link: l ? { slug: l.slug, active: l.active } : null,
    paid_at: p.paid_at,
    payer: lastConfirmed?.payer ?? pending?.payer ?? null,
    payout: PAYOUT,
    intents: intents.checkout(p),
  };
}

function publicLinkOf(l: PaymentLink): PublicLink {
  return {
    slug: l.slug,
    livemode: false,
    title: l.title,
    description: l.description,
    amount: l.amount,
    min_amount: l.min_amount,
    max_amount: l.max_amount,
    collect_email: l.collect_email,
    collect_name: l.collect_name,
    active: l.active && (l.max_payments == null || l.payments_count < l.max_payments),
    merchant: { name: merchant.name, support_email: merchant.support_email, brand_color: merchant.brand_color, logo_url: merchant.logo_url },
    network: NETWORK,
    token: TOKEN_META,
  };
}

function stripPayment(p: MockPayment): Payment {
  const { credits: _c, refunds: _r, events: _e, intents: _i, ...rest } = p;
  void _c;
  void _r;
  void _e;
  void _i;
  return rest;
}

function page<T>(items: T[], limit = 50, cursor?: string, counts: Record<string, number> | null = null): GatewayPage<T> {
  const start = cursor ? Number(cursor) : 0;
  const slice = items.slice(start, start + limit);
  return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null, counts };
}

// ---------------------------------------------------------------------------
// Merchant API
// ---------------------------------------------------------------------------

export class MockGatewayApi implements GatewayApi {
  /** Which endpoints this instance manages: a business's, or the platform's own (`/v1/platform/webhooks`). */
  constructor(private readonly hookScope: WebhookScope = "business") {}

  private endpoint(id: string) {
    const e = endpoints.find((x) => x.id === id && x.scope === this.hookScope);
    if (!e) throw new ApiError(404, "WEBHOOK_NOT_FOUND", `No webhook endpoint ${id}.`);
    return e;
  }

  async overview(): Promise<GatewayOverview> {
    await delay();
    if (foreign()) return { volume: "0", payments: 0, counts: {}, conversion: 0, days: [] };
    const since = Date.now() - 30 * DAY;
    const recent = payments.filter((p) => new Date(p.created_at).getTime() >= since);
    const counts: Record<string, number> = {};
    for (const p of recent) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const paid = recent.filter((p) => p.status === "paid" || p.status === "overpaid");
    const terminal = recent.filter((p) => ["paid", "overpaid", "underpaid", "expired", "canceled"].includes(p.status));
    const days: GatewayOverview["days"] = [];
    for (let d = 29; d >= 0; d--) {
      const start = new Date(Date.now() - d * DAY);
      start.setHours(0, 0, 0, 0);
      const end = start.getTime() + DAY;
      const inDay = paid.filter((p) => {
        const t = new Date(p.paid_at ?? p.created_at).getTime();
        return t >= start.getTime() && t < end;
      });
      days.push({ day: start.toISOString().slice(0, 10), volume: inDay.reduce((a, p) => a + BigInt(p.amount_paid), 0n).toString(), count: inDay.length });
    }
    return {
      volume: paid.reduce((a, p) => a + BigInt(p.amount_paid), 0n).toString(),
      payments: recent.length,
      counts,
      conversion: terminal.length ? paid.length / terminal.length : 0,
      days,
    };
  }

  async payments(q: PaymentsQuery = {}): Promise<GatewayPage<Payment>> {
    await delay();
    if (foreign()) return page([], 50, undefined, {});
    const text = q.q?.trim().toLowerCase();
    const base = payments.filter(
      (p) =>
        (!q.link_id || p.link_id === q.link_id) &&
        (!q.method?.length || (p.method !== null && q.method.includes(p.method))) &&
        (!q.merchant_id || (p.merchant_id ?? ACME_ID) === q.merchant_id) &&
        (!q.email || (p.customer_email ?? "").toLowerCase().includes(q.email.toLowerCase())) &&
        (!text ||
          p.id.includes(text) ||
          (p.reference ?? "").toLowerCase().includes(text) ||
          (p.payer ?? "").toLowerCase().includes(text) ||
          p.credits.some((c) => (c.tx_hash ?? "").toLowerCase().includes(text)) ||
          (p.description ?? "").toLowerCase().includes(text)),
    );
    const counts: Record<string, number> = { refunded: base.filter((p) => p.refund_status !== "none").length };
    for (const p of base) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const items = base
      .filter((p) => (!q.status?.length || q.status.includes(p.status)) && (!q.refunded || p.refund_status !== "none"))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(stripPayment);
    return page(items, q.limit ?? 50, q.cursor, counts);
  }

  async payment(id: string): Promise<PaymentDetail> {
    await delay();
    const p = find(id);
    return { ...p, credits: [...p.credits], refunds: [...p.refunds], events: [...p.events].sort((a, b) => a.created_at.localeCompare(b.created_at)), intents: intents.paymentIntents(p.id) };
  }

  async cancelPayment(id: string): Promise<Payment> {
    await delay(500);
    const p = find(id);
    if (p.status !== "open") throw new ApiError(409, "PAYMENT_NOT_OPEN", "Only an open payment can be canceled.");
    p.status = "canceled";
    p.canceled_at = iso(Date.now());
    p.events.push(event("payment.canceled", Date.now()));
    notify(p);
    return stripPayment(p);
  }

  async links(): Promise<PaymentLink[]> {
    await delay();
    if (foreign()) return [];
    return [...links].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(withExpiry);
  }

  async link(id: string): Promise<PaymentLink> {
    await delay();
    const l = links.find((x) => x.id === id);
    if (!l) throw new ApiError(404, "LINK_NOT_FOUND", `No payment link ${id} on this node.`);
    return withExpiry(l);
  }

  async createLink(body: CreateLinkBody): Promise<PaymentLink> {
    await delay(500);
    let slug = "";
    for (const b of crypto.getRandomValues(new Uint8Array(8))) slug += "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 56];
    const l: PaymentLink = {
      id: randomId("plink"),
      livemode: false,
      slug,
      url: `${origin()}/l/${slug}`,
      title: body.title,
      description: body.description || null,
      amount: body.amount ?? null,
      min_amount: body.min_amount ?? null,
      max_amount: body.max_amount ?? null,
      collect_email: body.collect_email ?? false,
      collect_name: body.collect_name ?? false,
      success_url: body.success_url || null,
      active: true,
      listed: body.listed ?? true,
      max_payments: body.max_payments ?? null,
      expires_at: body.expires_at ?? null,
      created_at: iso(Date.now()),
      payments_count: 0,
      paid_total: "0",
    };
    links.unshift(l);
    createdHere.add(l.id);
    saveLinks();
    return { ...l };
  }

  async updateLink(id: string, patch: UpdateLinkBody): Promise<PaymentLink> {
    await delay(400);
    const l = links.find((x) => x.id === id);
    if (!l) throw new ApiError(404, "LINK_NOT_FOUND", `No payment link ${id} on this node.`);
    Object.assign(l, patch);
    saveLinks();
    return { ...l };
  }

  async refunds(q: { payment_id?: string; limit?: number; cursor?: string } = {}): Promise<GatewayPage<Refund>> {
    await delay();
    if (foreign()) return page([], 50);
    const items = refunds.filter((r) => !q.payment_id || r.payment_id === q.payment_id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const counts: Record<string, number> = {};
    for (const r of items) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return page(items.map((r) => ({ ...r, merchant_id: r.merchant_id ?? ACME_ID })), q.limit ?? 50, q.cursor, counts);
  }

  async createRefund(body: CreateRefundBody): Promise<Refund> {
    await delay(400);
    const p = find(body.paymentId);
    const pending = p.refunds.filter((r) => r.status === "pending" || r.status === "succeeded").reduce((a, r) => a + BigInt(r.amount), 0n);
    const available = BigInt(p.amount_paid) - pending;
    if (BigInt(body.amount) > available) throw new ApiError(422, "REFUND_TOO_LARGE", `At most ${plainAmount(available)} USDC can be refunded.`);
    const r: Refund = {
      id: randomId("re"),
      livemode: false,
      payment_id: p.id,
      amount: body.amount,
      to: body.to ?? p.payer ?? PAYERS[0]!,
      reason: body.reason ?? null,
      note: body.note ?? null,
      approval: mockActorIsStaff() ? "requested" : "not_required",
      requested_by: readMockUser(),
      approved_by: null,
      status: "pending",
      tx_hash: null,
      failure_reason: null,
      method: null,
      created_at: iso(Date.now()),
      updated_at: iso(Date.now()),
    };
    refunds.unshift(r);
    p.refunds.push(r);
    p.events.push(event("refund.created", Date.now(), { refund_id: r.id, amount: r.amount }));
    return { ...r };
  }

  async submitRefund(id: string, body: SubmitRefundBody): Promise<Refund> {
    await delay(900);
    const r = refunds.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "REFUND_NOT_FOUND", `No refund ${id}.`);
    r.status = "succeeded";
    r.tx_hash = body.txHash;
    r.updated_at = iso(Date.now());
    r.method = "transfer";
    r.verification = "transfer_checked";
    const p = find(r.payment_id);
    p.events.push(event("refund.succeeded", Date.now(), { refund_id: r.id, amount: r.amount, tx_hash: r.tx_hash }));
    recomputeRefunds(p);
    return { ...r };
  }

  async approveRefund(id: string): Promise<Refund> {
    await delay(400);
    const r = refunds.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "REFUND_NOT_FOUND", `No refund ${id}.`);
    r.approval = "approved";
    r.approved_by = readMockUser();
    return { ...r };
  }

  async updateRefundNote(id: string, note: string): Promise<Refund> {
    await delay(300);
    const r = refunds.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "REFUND_NOT_FOUND", `No refund ${id}.`);
    r.note = note || null;
    return { ...r };
  }

  async cancelRefund(id: string): Promise<Refund> {
    await delay(400);
    const r = refunds.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "REFUND_NOT_FOUND", `No refund ${id}.`);
    r.status = "canceled";
    return { ...r };
  }

  async webhooks(): Promise<WebhookEndpoint[]> {
    await delay();
    if (this.hookScope === "business" && foreign()) return [];
    return endpoints.filter((e) => e.scope === this.hookScope).map(publicEndpoint);
  }

  async webhook(id: string): Promise<WebhookEndpoint> {
    await delay();
    return publicEndpoint(this.endpoint(id));
  }

  async revealWebhookSecret(id: string): Promise<string> {
    await delay(300);
    return this.endpoint(id).secret;
  }

  async createWebhook(body: CreateWebhookBody): Promise<WebhookEndpoint> {
    await delay(500);
    const e = {
      id: randomId("we"),
      scope: this.hookScope,
      livemode: false,
      url: body.url,
      description: body.description || null,
      events: body.events,
      active: true,
      secret: `whsec_${base32Of(`whsec:${Math.random()}`, 43)}`,
      created_at: iso(Date.now()),
      success_rate_7d: null,
      last_delivery_at: null,
      disabled_reason: null,
    };
    endpoints.unshift(e);
    const { scope: _scope, ...out } = e;
    void _scope;
    return out;
  }

  async updateWebhook(id: string, patch: UpdateWebhookBody): Promise<WebhookEndpoint> {
    await delay(400);
    const e = this.endpoint(id);
    Object.assign(e, patch);
    if (patch.active) e.disabled_reason = null;
    return publicEndpoint(e);
  }

  async deleteWebhook(id: string): Promise<void> {
    await delay(400);
    const i = endpoints.findIndex((x) => x.id === id && x.scope === this.hookScope);
    if (i >= 0) endpoints.splice(i, 1);
  }

  async rotateWebhookSecret(id: string): Promise<WebhookEndpoint> {
    await delay(500);
    const e = this.endpoint(id);
    e.secret = `whsec_${base32Of(`whsec:${Math.random()}`, 43)}`;
    return { ...publicEndpoint(e), secret: e.secret };
  }

  async testWebhook(id: string): Promise<void> {
    await delay(700);
    const e = this.endpoint(id);
    const evtId = randomId("evt");
    const body = JSON.stringify({ id: evtId, type: "ping", created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { message: "Test event from the Payminto dashboard" } } }, null, 2);
    const ok = e.active;
    deliveries.unshift(delivery(e.id, evtId, "ping", Date.now(), 1, ok ? "succeeded" : "failed", ok ? 200 : 500, ok ? 112 : 290, body, ok ? '{"received":true}' : "Internal Server Error"));
    e.last_delivery_at = iso(Date.now());
  }

  async deliveries(endpointId: string, q: { limit?: number; cursor?: string } = {}): Promise<GatewayPage<WebhookDelivery>> {
    await delay();
    this.endpoint(endpointId);
    const items = deliveries.filter((d) => d.endpoint_id === endpointId).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return page(items, q.limit ?? 50, q.cursor);
  }

  async retryDelivery(id: string): Promise<WebhookDelivery> {
    await delay(800);
    const d = deliveries.find((x) => x.id === id);
    if (!d) throw new ApiError(404, "DELIVERY_NOT_FOUND", `No delivery ${id}.`);
    const e = endpoints.find((x) => x.id === d.endpoint_id);
    const ok = Boolean(e?.active);
    const next = delivery(d.endpoint_id, d.event_id, d.event_type, Date.now(), d.attempt + 1, ok ? "succeeded" : "failed", ok ? 200 : 500, ok ? 96 : 310, d.request_body ?? "", ok ? '{"received":true}' : "Internal Server Error");
    next.id = randomId("whd");
    deliveries.unshift(next);
    return next;
  }

  async apiKeys(): Promise<ApiKey[]> {
    await delay();
    if (foreign()) return [];
    return [...keys];
  }

  async createApiKey(body: { name: string }): Promise<CreatedApiKey> {
    await delay(500);
    let tail = "";
    for (const b of crypto.getRandomValues(new Uint8Array(32))) tail += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62];
    const secret = `sk_test_${tail}`;
    const k: ApiKey = { id: randomId("key"), name: body.name, prefix: secret.slice(0, 12), livemode: false, created_at: iso(Date.now()), last_used_at: null, revoked_at: null };
    keys.unshift(k);
    return { ...k, secret };
  }

  async revokeApiKey(id: string): Promise<void> {
    await delay(400);
    const k = keys.find((x) => x.id === id);
    if (k) k.revoked_at = iso(Date.now());
  }

  async merchant(): Promise<MerchantProfile> {
    await delay();
    const scoped = getMerchantScope();
    const m = scoped ? merchants.find((x) => x.id === scoped) : null;
    if (m && m.id !== ACME_ID) return { ...merchant, ...m };
    return { ...merchant, ...merchants[0]! };
  }

  async updateMerchant(patch: MerchantPatch): Promise<MerchantProfile> {
    await delay(500);
    const m = merchants.find((x) => x.id === (getMerchantScope() ?? ACME_ID)) ?? merchants[0]!;
    Object.assign(m, patch);
    if (m.id === ACME_ID) Object.assign(merchant, patch);
    return { ...merchant, ...m };
  }

  async denyList(): Promise<DenyListEntry[]> {
    await delay();
    if (foreign()) return [];
    return [...denyList].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async addDeny(body: { address: Address; note?: string }): Promise<DenyListEntry> {
    await delay(400);
    if (denyList.some((d) => d.address.toLowerCase() === body.address.toLowerCase())) throw new ApiError(409, "ALREADY_DENIED", "This address is already on the deny list.");
    const e: DenyListEntry = { address: body.address, note: body.note || null, created_at: iso(Date.now()) };
    denyList.unshift(e);
    return e;
  }

  async removeDeny(address: Address): Promise<void> {
    await delay(400);
    const i = denyList.findIndex((d) => d.address.toLowerCase() === address.toLowerCase());
    if (i >= 0) denyList.splice(i, 1);
  }

  async screeningDecisions(): Promise<ScreeningDecision[]> {
    await delay();
    if (foreign()) return [];
    return [...decisions];
  }

  /** The same columns and quoting as the server's report, from the demo store (fees charged pro rata, like the node). */
  async reconciliationCsv(range: { from: string; to: string }): Promise<string> {
    await delay(300);
    const rows = foreign() ? [] : payments.filter((p) => p.created_at >= range.from && p.created_at < range.to).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const fixed = (v: bigint) => {
      const s = (v < 0n ? -v : v).toString().padStart(7, "0");
      return `${v < 0n ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
    };
    const t = { gross: 0n, platform: 0n, method: 0n, fees: 0n, net: 0n, refunded: 0n, pending: 0n };
    const line = (cells: Partial<Record<ReportCsvColumn, string | null>>) => REPORT_CSV_COLUMNS.map((k) => reportCsvCell(cells[k] ?? null)).join(",");
    const out = [REPORT_CSV_COLUMNS.map((k) => reportCsvCell(k)).join(",")];
    for (const p of rows) {
      const due = BigInt(p.amount_due);
      const paid = BigInt(p.amount_paid);
      const total = BigInt(p.fee_total);
      const fee = due === 0n ? 0n : (paid * total) / due > total ? total : (paid * total) / due;
      const platform = total === 0n ? 0n : (fee * BigInt(p.platform_fee)) / total;
      const refunded = p.refunds.filter((r) => r.status === "succeeded").reduce((a, r) => a + BigInt(r.amount), 0n);
      const pending = p.refunds.filter((r) => r.status === "pending").reduce((a, r) => a + BigInt(r.amount), 0n);
      t.gross += paid;
      t.platform += platform;
      t.method += fee - platform;
      t.fees += fee;
      t.net += paid - fee;
      t.refunded += refunded;
      t.pending += pending;
      out.push(
        line({
          payment_id: p.id,
          reference: p.reference,
          link_id: p.link_id,
          description: p.description,
          created_at: p.created_at,
          paid_at: p.paid_at,
          status: p.status,
          method: p.method,
          payer: p.payer,
          currency: "USDC",
          amount: fixed(BigInt(p.amount)),
          surcharge: fixed(BigInt(p.surcharge)),
          amount_due: fixed(due),
          amount_paid: fixed(paid),
          platform_fee: fixed(platform),
          method_fee: fixed(fee - platform),
          fee_total: fixed(fee),
          net_amount: fixed(paid - fee),
          refunded: fixed(refunded),
          refunds_pending: fixed(pending),
          net_after_refunds: fixed(paid - fee - refunded),
          refund_ids: p.refunds.filter((r) => r.status === "succeeded" || r.status === "pending").map((r) => r.id).join(" "),
          tx_hashes: [...new Set(p.credits.map((c) => c.tx_hash).filter(Boolean))].join(" "),
          batch_ids: [...new Set(p.credits.map((c) => c.batch_id).filter(Boolean))].join(" "),
          proof_url: p.status === "paid" || p.status === "overpaid" ? `${origin()}/receipt/${p.id}` : null,
          screening_rules: [...new Set(decisions.filter((d) => d.payment_id === p.id).map((d) => d.rule))].join(" "),
        }),
      );
    }
    out.push(
      line({
        payment_id: "TOTAL",
        description: `${rows.length} payments from ${range.from} to ${range.to}`,
        currency: "USDC",
        amount_paid: fixed(t.gross),
        platform_fee: fixed(t.platform),
        method_fee: fixed(t.method),
        fee_total: fixed(t.fees),
        net_amount: fixed(t.net),
        refunded: fixed(t.refunded),
        refunds_pending: fixed(t.pending),
        net_after_refunds: fixed(t.net - t.refunded),
      }),
    );
    return out.join("\r\n") + "\r\n";
  }

  async intentsPayout(): Promise<IntentsPayout> {
    await delay();
    return intents.payout();
  }

  async setIntentsPayout(body: IntentsPayoutBody): Promise<IntentsPayout> {
    await delay(500);
    return intents.setPayout(body);
  }
}

/** True when the operator switched to a merchant other than Acme Store, which has no gateway history in the mock. */
function foreign(): boolean {
  const scoped = getMerchantScope();
  return Boolean(scoped && scoped !== ACME_ID);
}

// ---------------------------------------------------------------------------
// Operator API (GATEWAY.md section 14.3)
// ---------------------------------------------------------------------------

const payoutHistory = new Map<string, PayoutHistoryEntry[]>([
  [
    ACME_ID,
    [
      { old_payout: addr("acme-old-payout"), new_payout: addr("acme-store-payout"), proven: true, changed_at: iso(Date.now() - 70 * DAY) },
      { old_payout: null, new_payout: addr("acme-old-payout"), proven: false, changed_at: iso(Date.now() - 80 * DAY) },
    ],
  ],
]);

export class MockOperatorApi implements OperatorApi {
  async platform(): Promise<Platform> {
    await delay();
    return { ...platform };
  }
  async updatePlatform(patch: Partial<Pick<Platform, "name" | "default_fee_plan_id" | "signup_mode" | "agent_budgets_for_businesses">>): Promise<Platform> {
    await delay(400);
    Object.assign(platform, patch);
    return { ...platform };
  }
  async platformFees(): Promise<PlatformFees> {
    await delay();
    const since = Date.now() - 30 * DAY;
    const paid = payments.filter((p) => (p.status === "paid" || p.status === "overpaid") && new Date(p.paid_at ?? p.created_at).getTime() >= since);
    const sum = (xs: MockPayment[], f: (p: MockPayment) => string) => xs.reduce((a, p) => a + BigInt(f(p)), 0n);
    const acme = { merchant_id: ACME_ID, name: "Acme Store", volume: sum(paid, (p) => p.amount_paid).toString(), fees: sum(paid, (p) => p.fee_total).toString(), payments: paid.length };
    const others = merchants.slice(1).map((m) => {
      const plan = plans.find((x) => x.id === m.fee_plan_id)!;
      const volume = BigInt(m.volume_30d ?? "0");
      const n = m.payments_30d ?? 0;
      const avg = n ? volume / BigInt(n) : 0n;
      const fee = n ? BigInt(n) * computeFees({ amount: avg || 1n, plan, method: null }).platform_fee : 0n;
      return { merchant_id: m.id, name: m.name, volume: volume.toString(), fees: fee.toString(), payments: n };
    });
    const byMerchant = [acme, ...others];
    const byMethod = (["wallet", "voucher"] as const).map((method) => {
      const xs = paid.filter((p) => p.method === method);
      return { method, volume: sum(xs, (p) => p.amount_paid).toString(), fees: sum(xs, (p) => p.fee_total).toString(), payments: xs.length };
    });
    const days: PlatformFees["days"] = [];
    for (let d = 29; d >= 0; d--) {
      const start = new Date(Date.now() - d * DAY);
      start.setHours(0, 0, 0, 0);
      const inDay = paid.filter((p) => {
        const t = new Date(p.paid_at ?? p.created_at).getTime();
        return t >= start.getTime() && t < start.getTime() + DAY;
      });
      const otherDaily = others.reduce((a, o) => a + BigInt(o.fees) / 30n, 0n);
      days.push({ day: start.toISOString().slice(0, 10), fees: (sum(inDay, (p) => p.fee_total) + otherDaily).toString() });
    }
    return {
      total: byMerchant.reduce((a, m) => a + BigInt(m.fees), 0n).toString(),
      volume: byMerchant.reduce((a, m) => a + BigInt(m.volume), 0n).toString(),
      payments: byMerchant.reduce((a, m) => a + m.payments, 0),
      by_merchant: byMerchant,
      by_method: byMethod,
      days,
    };
  }
  async merchants(): Promise<Merchant[]> {
    await delay();
    const acmeVolume = payments.filter((p) => p.status === "paid" || p.status === "overpaid").reduce((a, p) => a + BigInt(p.amount_paid), 0n);
    return merchants.map((m) => (m.id === ACME_ID ? { ...m, volume_30d: acmeVolume.toString(), payments_30d: payments.length } : { ...m }));
  }
  async merchant(id: string) {
    await delay();
    const m = merchants.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "MERCHANT_NOT_FOUND", `No merchant ${id}.`);
    return { ...m, payout_history: payoutHistory.get(id) ?? [] };
  }
  async createMerchant(body: CreateMerchantBody): Promise<Merchant> {
    await delay(700);
    if (merchants.some((m) => m.slug === body.slug)) throw new ApiError(409, "SLUG_TAKEN", "Another merchant already uses this slug.");
    const m: Merchant = {
      id: randomId("mer"),
      livemode: false,
      name: body.name,
      slug: body.slug,
      status: "active",
      payout: body.payout,
      support_email: body.support_email ?? null,
      brand_color: body.brand_color ?? null,
      logo_url: body.logo_url ?? null,
      fee_plan_id: body.fee_plan_id,
      created_at: iso(Date.now()),
      volume_30d: "0",
      payments_30d: 0,
    };
    merchants.push(m);
    for (const r of body.methods ?? []) methodRows.push({ ...r, merchant_id: m.id });
    return m;
  }
  async updateMerchant(id: string, patch: OperatorMerchantPatch): Promise<Merchant> {
    await delay(400);
    const m = merchants.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "MERCHANT_NOT_FOUND", `No merchant ${id}.`);
    Object.assign(m, patch);
    if (id === ACME_ID) Object.assign(merchant, patch);
    return { ...m };
  }
  async changePayout(id: string, body: PayoutProof): Promise<Merchant> {
    await delay(600);
    const m = merchants.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "MERCHANT_NOT_FOUND", `No merchant ${id}.`);
    payoutHistory.set(id, [{ old_payout: m.payout as Address, new_payout: body.payout, proven: true, changed_at: iso(Date.now()) }, ...(payoutHistory.get(id) ?? [])]);
    m.payout = body.payout;
    return { ...m };
  }
  async methods(merchantId: string): Promise<MerchantMethod[]> {
    await delay();
    return methodRows.filter((r) => r.merchant_id === merchantId).map((r) => ({ ...r }));
  }
  async setMethods(merchantId: string, rows: Omit<MerchantMethod, "merchant_id">[]): Promise<MerchantMethod[]> {
    await delay(400);
    for (const r of rows) {
      const i = methodRows.findIndex((x) => x.merchant_id === merchantId && x.method === r.method);
      if (i >= 0) methodRows[i] = { ...r, merchant_id: merchantId };
      else methodRows.push({ ...r, merchant_id: merchantId });
    }
    return this.methods(merchantId);
  }
  async setMethodsEnabled(merchantId: string, items: Pick<MerchantMethod, "method" | "enabled">[]): Promise<MerchantMethod[]> {
    await delay(400);
    if (merchantId === ACME_ID && items.some((r) => r.method === "oneclick" && r.enabled)) intents.assertCanEnable();
    for (const r of items) {
      const row = methodRows.find((x) => x.merchant_id === merchantId && x.method === r.method);
      if (row) row.enabled = r.enabled;
    }
    return this.methods(merchantId);
  }
  async feePlans(): Promise<FeePlan[]> {
    await delay();
    return plans.map((p) => ({ ...p, merchants: merchants.filter((m) => m.fee_plan_id === p.id).length }));
  }
  async createFeePlan(body: FeePlanBody): Promise<FeePlan> {
    await delay(400);
    const p: FeePlan = { id: randomId("fp"), ...body, created_at: iso(Date.now()) };
    plans.push(p);
    return p;
  }
  async updateFeePlan(id: string, patch: Partial<FeePlanBody>): Promise<FeePlan> {
    await delay(400);
    const p = plans.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "FEE_PLAN_NOT_FOUND", `No fee plan ${id}.`);
    Object.assign(p, patch);
    return { ...p };
  }
}

// ---------------------------------------------------------------------------
// Public checkout API
// ---------------------------------------------------------------------------

export class MockCheckoutApi implements CheckoutApi {
  readonly mock = true;

  async info(): Promise<Info> {
    await delay(80);
    return {
      network: { id: NET.network, name: NET.name, explorer: NET.explorer, testnet: NET.testnet, rpc_url: NET.rpcUrl },
      hub: HUB,
      token: { address: TOKEN, symbol: "USDC", decimals: 6 },
      explorer: EXPLORER,
      operator: "node.payminto.testnet",
      version: "0.1.0-mock",
    };
  }

  async checkout(id: string): Promise<CheckoutView> {
    await delay();
    return viewOf(find(id));
  }

  async chooseMethod(id: string, method: "wallet"): Promise<CheckoutView> {
    await delay(200);
    const p = find(id);
    if (p.status === "open" && p.amount_paid === "0" && p.method !== method) {
      Object.assign(p, quote(BigInt(p.amount), method));
      p.method = method;
      p.order_hash = orderFingerprint(canonicalJson(orderOf(p)));
      notify(p);
    }
    return viewOf(p);
  }

  async order(id: string): Promise<ServedOrder> {
    await delay();
    return servedOrder(find(id));
  }

  async proof(id: string): Promise<PaymentProof> {
    await delay();
    const p = find(id);
    if (p.status !== "paid" && p.status !== "overpaid") throw new ApiError(409, "PAYMENT_NOT_PAID", "A proof exists only for a paid payment.");
    const c = p.credits.filter((x) => x.status === "confirmed").at(-1);
    return {
      payment_id: p.id,
      status: p.status,
      network: NETWORK,
      hub: HUB,
      token: TOKEN,
      payout: PAYOUT,
      amount_due: p.amount_due,
      amount_paid: p.amount_paid,
      credit_amount: c?.amount ?? null,
      method: p.method,
      payer: p.payer,
      tx_hash: c?.tx_hash ?? null,
      hub_payment_id: hubPaymentId(p.id),
      order_hash: p.order_hash,
      paid_at: p.paid_at,
    };
  }

  async link(slug: string): Promise<PublicLink> {
    await delay();
    const l = links.find((x) => x.slug === slug);
    if (!l) throw new ApiError(404, "LINK_NOT_FOUND", "No payment link with this address.");
    return publicLinkOf(l);
  }

  async payFromLink(slug: string, body: { amount?: string; email?: string; name?: string }): Promise<{ id: string }> {
    await delay(500);
    const l = links.find((x) => x.slug === slug);
    if (!l) throw new ApiError(404, "LINK_NOT_FOUND", "No payment link with this address.");
    if (!publicLinkOf(l).active) throw new ApiError(410, "LINK_INACTIVE", "This payment link is no longer active.");
    const amount = l.amount ?? body.amount;
    if (!amount) throw new ApiError(422, "AMOUNT_REQUIRED", "Enter an amount.");
    const p = makePayment({ id: randomId("pay"), amount: BigInt(amount), status: "open", createdMs: Date.now(), link: l, email: body.email ?? null, name: body.name ?? null });
    p.events = p.events.slice(0, 1);
    return { id: p.id };
  }

  async addEmail(id: string, email: string): Promise<void> {
    await delay(400);
    const p = find(id);
    if (p.customer_email) throw new ApiError(409, "EMAIL_ALREADY_SET", "This payment already has a receipt email.");
    p.customer_email = email;
  }

  eventsUrl() {
    return null;
  }

  subscribe(id: string, listener: ViewListener): () => void {
    const set = viewListeners.get(id) ?? new Set();
    set.add(listener);
    viewListeners.set(id, set);
    return () => set.delete(listener);
  }

  /** The demo wallet already applied the payment to the demo hub; the report is display only, as on a node. */
  async walletSent(id: string, txHash: string): Promise<void> {
    void id;
    void txHash;
  }

  async intentsOptions(id: string): Promise<IntentsOptions> {
    await delay(700);
    return intents.options(id);
  }

  /** Retries with the same key get the same quote, as the node's idempotency keys do. */
  readonly #byKey = new Map<string, IntentsQuote>();
  async createIntentsQuote(id: string, body: { origin_asset: string; refund_to: string }, idempotencyKey: string): Promise<IntentsQuote> {
    await delay(900);
    const seen = this.#byKey.get(`${id} ${idempotencyKey}`);
    if (seen) return intents.quote(id, seen.id);
    const { quote: q } = intents.createQuote(id, body);
    this.#byKey.set(`${id} ${idempotencyKey}`, q);
    return q;
  }

  async intentsQuote(id: string, quoteId: string): Promise<IntentsQuote> {
    await delay();
    return intents.quote(id, quoteId);
  }

  async submitIntentsDeposit(id: string, quoteId: string, txHash: string): Promise<IntentsQuote> {
    await delay(500);
    return intents.submitDeposit(id, quoteId, txHash);
  }

  async simulateIntentsDeposit(id: string, quoteId: string, amount?: string): Promise<IntentsQuote> {
    await delay(500);
    return intents.simulate(id, quoteId, amount);
  }

  /** The demo hub, read through the same NearReader and JSON-RPC the receipt page uses against NEAR. */
  reader(): ReaderSource {
    demoReader ??= mockReader({ hub: HUB, view: hubView, txFinal: (hash) => payments.some((p) => p.credits.some((c) => c.tx_hash === hash && c.status === "confirmed")) });
    return demoReader;
  }
}

let demoReader: ReaderSource | null = null;

/** The demo hub's `payments` view: what the hub would answer for each checkout payment, in its JSON shape. */
function hubView(method: string, args: Record<string, unknown>): unknown {
  if (method !== "payments") throw new Error(`MethodResolveError(MethodNotFound) ${method}`);
  return (args.ids as Id32[]).map((id) => {
    const p = payments.find((x) => hubPaymentId(x.id) === id);
    const last = p?.credits.filter((c) => c.status === "confirmed").at(-1);
    if (!p || !last) return null;
    return { id, merchant: PAYOUT, amount: last.amount, payer: last.payer ?? PAYERS[0]!, at: String(new Date(last.confirmed_at ?? last.created_at).getTime()) };
  });
}

/**
 * Applies a checkout `ft_transfer_call` from the demo wallet as the hub would: it checks the terms against the payment,
 * returns the tokens for anything that does not match, and otherwise records the payment and credits the merchant.
 * Returns null for any transaction that is not a checkout payment, so the clearing mock can take it.
 */
export function applyMockCheckoutTx(tx: WalletTx, signer: AccountId): MockTxOutcome | null {
  const call = tx.actions[0];
  // The one human step of the any-chain setup: the business's NEAR account registers with USDC.
  if (call?.params.methodName === "storage_deposit" && tx.receiverId === intents.payout().usdc.contract) {
    intents.markRegistered();
    return { ok: true };
  }
  if (!call || call.params.methodName !== "ft_transfer_call") return null;
  let msg: { payment?: { payment_id: string; merchant: string; amount: string; expiry_ms: string; signature: string } };
  try {
    msg = JSON.parse(String(call.params.args.msg)) as typeof msg;
  } catch {
    return null;
  }
  const t = msg.payment;
  if (!t) return null;
  const refused = (error: string): MockTxOutcome => ({ ok: false, error: `Smart contract panicked: ${error}`, refunded: true });
  if (tx.receiverId !== TOKEN || call.params.args.receiver_id !== HUB) return refused("unknown token or receiver");
  const p = payments.find((x) => hubPaymentId(x.id) === t.payment_id);
  if (!p) return refused("unknown payment");
  const amount = BigInt(String(call.params.args.amount));
  if (amount !== BigInt(t.amount)) return refused("wrong amount");
  if (BigInt(t.expiry_ms) <= BigInt(Date.now())) return refused("expired terms");
  if (t.signature !== demoSignature(t.payment_id, amount)) return refused("bad checkout signature");
  if (p.credits.some((c) => c.status === "confirmed" && BigInt(p.amount_paid) >= BigInt(p.amount_due))) return refused("payment already recorded");
  p.events.push(event("wallet.connected", Date.now() - 4_000, { payer: signer }));
  credit(p, amount, "wallet", signer);
  return { ok: true, used: amount };
}

/** Mock-only: the fixed payment for each checkout state, for links in the docs and screenshots. */
export const DEMO_PAYMENTS = {
  open: demoId("open"),
  soon: demoId("soon"),
  partial: demoId("partial"),
  processing: demoId("processing"),
  paid: demoId("paid"),
  overpaid: demoId("overpaid"),
  underpaid: demoId("underpaid"),
  expired: demoId("expired"),
  canceled: demoId("canceled"),
  late: demoId("late"),
};

/** The mock businesses, for the mock account server (lib/mock/accounts.ts): ids and names only. */
export function mockBusinesses(): { id: string; name: string; slug: string; status: string }[] {
  return merchants.map((m) => ({ id: m.id, name: m.name, slug: m.slug, status: m.status }));
}

/** Expired links read as `expired: true` (PRODUCT.md section 10.12). */
function withExpiry(l: PaymentLink): PaymentLink {
  const at = l.expires_at ? new Date(l.expires_at).getTime() : null;
  return { ...l, merchant_id: l.merchant_id ?? ACME_ID, expired: at !== null && at <= Date.now() };
}

/** The mock account server's signed-in user (lib/mock/accounts.ts), so a Staff refund is created as a request. */
function readMockUser(): string | null {
  try {
    return window.localStorage.getItem("payminto.mock.user");
  } catch {
    return null;
  }
}
function mockActorIsStaff(): boolean {
  return readMockUser() === "usr_sam";
}
