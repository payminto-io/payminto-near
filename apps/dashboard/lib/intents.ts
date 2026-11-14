/**
 * The any-chain checkout through NEAR Intents (docs/DEVELOPERS.md, "Any-chain checkout"), as the buyer and the business
 * see it: which tab and screen to show, the words on each screen, and the checks before "Show payment address" enables.
 * Pure, for tests. Every amount and fee comes from the node's signed quote; nothing here prices anything.
 */
import { isOriginAddress, originOf, type AddressFormat } from "@payminto/near-addons/intents";
import { countdownTone, formatCountdown, secondsLeft } from "./checkout";
import { ApiError } from "./http";
import { manualRefundDetailsSchema } from "./schemas";
import type {
  CheckoutView,
  IntentsAmount,
  IntentsDestinationOption,
  IntentsFeeLines,
  IntentsOption,
  IntentsOrigin,
  IntentsPayout,
  IntentsQuote,
  IntentsQuoteDestination,
  IntentsQuoteStatus,
  IntentsSummary,
  ManualRefundDetails,
  Payment,
  PaymentIntents,
  PublicLinkIntents,
} from "./schemas";

/** The two ways a person pays on the hosted checkout, in order: the NEAR wallet always first. */
export type PayTab = "wallet" | "oneclick";

export const TAB_LABEL: Record<PayTab, string> = { wallet: "NEAR wallet", oneclick: "Any chain" };

/** The 1Click chain codes of the offered origins, for people. */
export const CHAIN_NAMES: Record<string, string> = { base: "Base", eth: "Ethereum", arb: "Arbitrum", sol: "Solana", pol: "Polygon" };

export const chainName = (code: string): string => CHAIN_NAMES[code] ?? code;

/** True when the business takes payments from other chains for this payment right now. */
export function anyChainOffered(view: Pick<CheckoutView, "methods" | "intents">): boolean {
  return view.methods.includes("oneclick") && view.intents?.available === true;
}

/** A quote that still has something to show: anything but an address that expired unused. */
export function activeQuote(view: Pick<CheckoutView, "intents">): IntentsQuote | null {
  const q = view.intents?.active_quote ?? null;
  return q && q.status !== "expired" ? q : null;
}

/**
 * Money from another chain is on its way to this payment: the deposit was seen, is converting or was delivered, or a
 * short deposit waits for the rest. A second payment with the NEAR wallet then would pay twice, so the wallet waits.
 */
export function depositOnItsWay(view: Pick<CheckoutView, "intents">): boolean {
  const q = view.intents?.active_quote ?? null;
  if (!q) return false;
  if (q.status === "incomplete_deposit") return q.deposited !== null && BigInt(q.deposited.amount) > 0n;
  return q.status === "deposit_detected" || q.status === "processing" || q.status === "delivered";
}

/** The NEAR wallet tab while a deposit from another chain is on its way. */
export const WALLET_HELD = "A payment from another chain is on its way. Wait for it to finish.";

/** The node's 409 for choosing or paying with the NEAR wallet while a deposit from another chain is on its way. */
export function isInFlightError(e: unknown): boolean {
  return e instanceof ApiError && e.code === "INTENTS_IN_FLIGHT";
}

/**
 * The tabs of the pay panel. "Any chain" shows when the node offers it now, and also while a deposit made earlier is
 * still on its way, so the buyer can follow it even after the payment stopped taking new addresses. The NEAR wallet
 * tab stays while that deposit is on its way, to say why it does not pay now.
 */
export function payTabs(view: Pick<CheckoutView, "methods" | "intents">, walletOffered: boolean): PayTab[] {
  const tabs: PayTab[] = [];
  if (walletOffered || (view.methods.includes("wallet") && depositOnItsWay(view))) tabs.push("wallet");
  if (anyChainOffered(view) || activeQuote(view)) tabs.push("oneclick");
  return tabs;
}

/**
 * Whether the pay panel shows its tab bar: only when the business offers the NEAR wallet beside Any chain. In live
 * mode the checkout offers Any chain alone, and then the panel is just the any-chain flow.
 */
export function showsTabBar(view: Pick<CheckoutView, "methods">, tabs: readonly PayTab[]): boolean {
  return view.methods.includes("wallet") && tabs.includes("oneclick");
}

/** The tab a fresh page opens on: the any-chain tab when a deposit address of this payment is in use, else the first. */
export function initialTab(view: Pick<CheckoutView, "methods" | "intents">, walletOffered: boolean): PayTab | null {
  const tabs = payTabs(view, walletOffered);
  if (tabs.includes("oneclick") && activeQuote(view)) return "oneclick";
  return tabs[0] ?? null;
}

// ---------------------------------------------------------------------------
// Screens of one deposit address
// ---------------------------------------------------------------------------

/**
 * Which any-chain screen a quote shows: the deposit screen (C) while it waits or runs, then done (D), or one of the
 * ended screens (E): incomplete, returned, failed, or an address that expired before anything arrived.
 */
export type IntentsStage = "deposit" | "incomplete" | "done" | "returned" | "failed" | "expired";

export function intentsStage(q: Pick<IntentsQuote, "status" | "deadline_passed">): IntentsStage {
  switch (q.status) {
    case "confirmed":
      return "done";
    case "refunded":
      return "returned";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "incomplete_deposit":
      return "incomplete";
    case "awaiting_deposit":
      return q.deadline_passed ? "expired" : "deposit";
    default:
      return "deposit";
  }
}

/** Money is on its way for this quote: the page keeps the deposit screen up even while the payment shows processing. */
export function inFlight(q: Pick<IntentsQuote, "status" | "deadline_passed"> | null): boolean {
  return q !== null && ["deposit", "incomplete"].includes(intentsStage(q)) && q.status !== "awaiting_deposit";
}

/** The deposit screen stays on the panel: a quote that waits for a deposit or carries one. */
export function showsDeposit(q: Pick<IntentsQuote, "status" | "deadline_passed"> | null): boolean {
  return q !== null && ["deposit", "incomplete"].includes(intentsStage(q));
}

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

/**
 * A decimal amount without the trailing zeros of its token's precision: "4.500000" is "4.50", "0.002441510000000000" is
 * "0.00244151". It only drops zeros, so the value is exactly the quote's; a whole amount keeps two places.
 */
export function exactUnits(formatted: string): string {
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(formatted.trim());
  if (!m) return formatted;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return `${m[1]}.${frac.padEnd(2, "0")}`;
}

/**
 * An indicative amount rounded half up to what a person reads, for estimates only (the deposit screen stays exact):
 * 6 places from 1 up, 4 significant digits below 1. "0.000977882374124212" is "0.0009779", "2.0068345" is "2.006835".
 */
export function approxUnits(formatted: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(formatted.trim());
  if (!m) return formatted;
  const int = m[1]!;
  const frac = m[2] ?? "";
  const whole = BigInt(int) > 0n;
  const leadingZeros = /^0*/.exec(frac)![0].length;
  if (!whole && leadingZeros === frac.length) return "0.00";
  const places = whole ? 6 : leadingZeros + 4;
  let scaled = BigInt(int + frac.padEnd(places, "0").slice(0, places));
  if ((frac[places] ?? "0") >= "5") scaled += 1n;
  return exactUnits(unitsOf(scaled, places));
}

/** "4.509585 USDC". */
export const amountText = (a: Pick<IntentsAmount, "formatted" | "symbol">): string => `${exactUnits(a.formatted)} ${a.symbol}`;

/** Base units as a decimal string with every place of the token ("2010154", 6: "2.010154"). */
export function unitsOf(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n;
  const s = (neg ? -atomic : atomic).toString().padStart(decimals + 1, "0");
  const out = decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return `${neg ? "-" : ""}${out}`;
}

/** "under a minute", "about 2 minutes", "about 14 minutes", "about 2 hours": 1Click's own estimate, said as one. */
export function timeEstimateText(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/** "22:38 UTC", the clock the node's warning uses too, so the page never shows two times for one deadline. */
export function clockUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(11, 16)} UTC`;
}

export type DeadlineModel = { seconds: number; text: string; tone: "neutral" | "warning" | "danger"; fraction: number; clock: string };

/** The countdown to the address going inactive (`deadline`), never the payment's expiry. */
export function deadlineModel(q: Pick<IntentsQuote, "deadline" | "created_at"> & { send_by?: string | null }, now = Date.now()): DeadlineModel {
  // The time the buyer must send by (the node's own deadline), never 1Click's later one, when refunds begin.
  const by = sendByOf(q);
  const seconds = secondsLeft(by, now);
  const start = new Date(q.created_at).getTime();
  const end = new Date(by).getTime();
  const fraction = end > start ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0;
  return { seconds, text: formatCountdown(seconds), tone: countdownTone(seconds), fraction, clock: clockUtc(by) };
}

/** When the buyer must send by: `send_by`, or `deadline` from an older server; the earlier of the two. */
export function sendByOf(q: Pick<IntentsQuote, "deadline"> & { send_by?: string | null }): string {
  if (!q.send_by) return q.deadline;
  return new Date(q.send_by).getTime() <= new Date(q.deadline).getTime() ? q.send_by : q.deadline;
}

/** Where a deposit that cannot complete goes: the buyer's own address, or the business's NEAR Intents balance. */
export function refundWhere(q: Pick<IntentsQuote, "refund_to" | "origin"> & { refund_type?: "ORIGIN_CHAIN" | "INTENTS" }, merchant: string): string {
  if (q.refund_type === "INTENTS") return `If a payment cannot complete (too little, or too late), NEAR Intents returns it to ${merchant}'s account ${q.refund_to}, and ${merchant} sends it back to you.`;
  return `If a payment cannot complete, it goes back to ${q.refund_to} on ${q.origin.chain_name}.`;
}

const PLAIN_REASON: Record<string, string> = {
  PARTIAL_DEPOSIT: "the deposit was below the required amount",
  INCOMPLETE_DEPOSIT: "the deposit was below the required amount",
  DEADLINE_EXCEEDED: "the deposit arrived after the address expired",
  EXPIRED: "the deposit arrived after the address expired",
  SLIPPAGE: "the price moved more than the quote allowed",
  NO_LIQUIDITY: "no one could fill the swap at the quoted price",
};

/** 1Click's refund reason in plain words; an unknown code is said as a code, never hidden. */
export function refundReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return PLAIN_REASON[reason.toUpperCase()] ?? `1Click reported ${reason}`;
}

/** Screen E, incomplete: what arrived, what is missing, by when, and where it goes back otherwise. */
export function incompleteCopy(q: Pick<IntentsQuote, "deposited" | "send_exactly" | "refund_to" | "deadline" | "origin">): string {
  const sym = q.send_exactly.symbol;
  const sent = q.deposited ? BigInt(q.deposited.amount) : 0n;
  const rest = BigInt(q.send_exactly.amount) - sent;
  const got = q.deposited ? exactUnits(q.deposited.formatted) : "0.00";
  const missing = exactUnits(unitsOf(rest > 0n ? rest : 0n, q.origin.decimals));
  const back = (q as { refund_type?: string }).refund_type === "INTENTS" ? `the business, which sends it back to you` : q.refund_to;
  return `We received ${got} of ${exactUnits(q.send_exactly.formatted)} ${sym}. Send the remaining ${missing} ${sym} to the same address before ${clockUtc(sendByOf(q))}, or it will be returned to ${back}.`;
}

/**
 * What the buyer has to send now: the whole amount, or after a short deposit only what is still missing, so the heading
 * and "Copy amount" never ask for the full amount a second time.
 */
export function sendNow(q: Pick<IntentsQuote, "status" | "deposited" | "send_exactly" | "origin">): { amount: string; symbol: string; remaining: boolean } {
  const symbol = q.send_exactly.symbol;
  const sent = q.deposited ? BigInt(q.deposited.amount) : 0n;
  const rest = BigInt(q.send_exactly.amount) - sent;
  if (q.status === "incomplete_deposit" && sent > 0n && rest > 0n) return { amount: exactUnits(unitsOf(rest, q.origin.decimals)), symbol, remaining: true };
  return { amount: exactUnits(q.send_exactly.formatted), symbol, remaining: false };
}

/** `sendNow` in base units: the whole amount, or after a short deposit what is still missing. */
export function sendNowAtomic(q: Pick<IntentsQuote, "status" | "deposited" | "send_exactly">): string {
  const sent = q.deposited ? BigInt(q.deposited.amount) : 0n;
  const rest = BigInt(q.send_exactly.amount) - sent;
  return q.status === "incomplete_deposit" && sent > 0n && rest > 0n ? rest.toString() : q.send_exactly.amount;
}

/** What the deposit QR holds for a wallet: `depositPaymentUri` of `@payminto/protocol` (EIP-681, Solana Pay). */
export type DepositUriMaker = (o: { chain: string; chainId: number | null; contractAddress: string | null; decimals: number; symbol: string }, depositAddress: string, amountAtomic: string) => string | null;

export const DEPOSIT_QR_CAPTION = "Scan with your wallet: it fills in the address, network and amount";

/** Native coins a contract-less EVM row stands for (as in `depositPaymentUri`). */
const EVM_NATIVE = new Set(["ETH", "POL", "BNB", "AVAX"]);

/**
 * Whether this origin's payment request starts with the deposit address itself: a native coin (EIP-681
 * `ethereum:<deposit>@<chain>?value=`) or Solana Pay (`solana:<deposit>?...`). An ERC-20 request starts with the token
 * contract (`ethereum:<token>@<chain>/transfer?address=<deposit>`), and a wallet that reads only that first address sends
 * the money to the token contract, where it is lost; gateways have seen exactly this. So an ERC-20 QR holds the bare
 * deposit address, and the buyer copies the amount (or pays from a connected wallet, which builds the exact transfer).
 */
export function requestNamesDeposit(o: Pick<IntentsOrigin, "chain" | "symbol" | "contract_address">): boolean {
  if (o.chain === "sol") return true;
  return o.contract_address == null && EVM_NATIVE.has(o.symbol.toUpperCase());
}

/**
 * The deposit screen's QR: a payment request a wallet reads (the token, the network and the amount to send now), or
 * the bare address when no request can be made for this origin or the buyer asked for the address only.
 */
export function depositQr(q: Pick<IntentsQuote, "origin" | "deposit_address" | "status" | "deposited" | "send_exactly">, addressOnly: boolean, makeUri: DepositUriMaker): { value: string; wallet: boolean } {
  if (addressOnly || !requestNamesDeposit(q.origin)) return { value: q.deposit_address, wallet: false };
  const o = q.origin;
  const uri = makeUri({ chain: o.chain, chainId: o.chain_id ?? null, contractAddress: o.contract_address ?? null, decimals: o.decimals, symbol: o.symbol }, q.deposit_address, sendNowAtomic(q));
  return uri ? { value: uri, wallet: true } : { value: q.deposit_address, wallet: false };
}

/** Screen E, returned, under the heading "Your deposit was returned": how much went back, where, on which chain, and why. */
export function returnedCopy(q: Pick<IntentsQuote, "refunded" | "refund_to" | "origin" | "refund_reason"> & { refund_type?: "ORIGIN_CHAIN" | "INTENTS" }): string {
  const where = q.refund_type === "INTENTS" ? `the business's NEAR account ${q.refund_to}, which sends it back to you` : `${q.refund_to} on ${q.origin.chain_name}`;
  const head = q.refunded ? `${amountText(q.refunded)} went back to ${where}` : `It went back to ${where}`;
  const why = refundReasonText(q.refund_reason);
  return why ? `${head}, because ${why}.` : `${head}.`;
}

/** What NEAR Intents kept of a returned deposit (its refund fee), so "You sent" and "Returned" add up; null when nothing was kept. */
export function refundKept(q: Pick<IntentsQuote, "deposited" | "refunded" | "origin">): string | null {
  if (!q.deposited || !q.refunded) return null;
  const kept = BigInt(q.deposited.amount) - BigInt(q.refunded.amount);
  return kept > 0n ? `${exactUnits(unitsOf(kept, q.origin.decimals))} ${q.refunded.symbol}` : null;
}

/** Screen E, failed: who to contact and with what reference. */
export function failedCopy(view: Pick<CheckoutView, "id" | "merchant">): string {
  const who = view.merchant.support_email ?? view.merchant.name;
  return `This payment could not be completed. Contact ${who} with reference ${view.id}.`;
}

/**
 * Who to write to after a deposit that cannot count (the wrong token, the wrong network, or after the address
 * expired), and what to quote, in one sentence.
 */
export function wrongDepositCopy(view: Pick<CheckoutView, "merchant">, q: Pick<IntentsQuote, "deposit_address">): string {
  const who = view.merchant.support_email ?? view.merchant.name;
  return `Sent the wrong token, on the wrong network or too late? Contact ${who} and quote the deposit address ${q.deposit_address}.`;
}

export type FeeLine = { label: string; value: string; hint: string | null };

/** The deposit screen's fee lines, every number from the signed quote; `destination` names where the business receives. */
export function depositFeeLines(f: IntentsFeeLines, merchant: string, destination?: IntentsQuoteDestination | null): FeeLine[] {
  const swap = f.swap_cost.unit === "USD" ? `$${exactUnits(f.swap_cost.formatted)}` : `${exactUnits(f.swap_cost.formatted)} ${f.swap_cost.unit}`;
  const eta = timeEstimateText(f.time_estimate_sec);
  const rows: FeeLine[] = [
    { label: `${merchant} receives`, value: destinationText(f.merchant_receives, destination), hint: null },
    { label: "Swap and delivery cost", value: swap, hint: "Paid by you, from the quote NEAR Intents signed." },
    { label: "Price buffer", value: amountText(f.price_buffer), hint: "Returned to your refund address if unused." },
  ];
  if (f.refund_fee) rows.push({ label: "Refund fee if your deposit is returned", value: amountText(f.refund_fee), hint: "Kept by NEAR Intents only if your deposit comes back." });
  if (eta) rows.push({ label: "Arrives in", value: eta, hint: "After your deposit is confirmed on its chain." });
  return rows;
}

/**
 * On a paid payment, what 1Click sent back to the buyer: the part of the deposit above the price, or the unused price
 * buffer. The payment is paid; this is not a returned deposit. Null when nothing came back.
 */
export function excessReturned(q: Pick<IntentsQuote, "status" | "refunded" | "refund_to" | "origin"> & { refund_type?: "ORIGIN_CHAIN" | "INTENTS" }): { amount: string; to: string; chain: string } | null {
  // Without a buyer address the unused buffer went to the business's NEAR Intents balance, not back to the buyer.
  if (q.refund_type === "INTENTS") return null;
  if (q.status === "refunded" || !q.refunded || BigInt(q.refunded.amount) <= 0n) return null;
  return { amount: amountText(q.refunded), to: q.refund_to, chain: q.origin.chain_name };
}

/** The business's word for money 1Click sent back: a returned deposit, or the excess of a paid one (never "refunded"). */
export function returnedLabel(q: Pick<IntentsQuote, "status"> & { refund_type?: "ORIGIN_CHAIN" | "INTENTS" }): string {
  if (q.refund_type === "INTENTS") return q.status === "refunded" ? "Returned to your NEAR Intents balance, for the buyer" : "Unused price buffer, in your NEAR Intents balance";
  return q.status === "refunded" ? "Returned to buyer" : "Excess returned to the buyer";
}

/** Screen E, an address that went inactive before anything arrived. */
export function expiredCopy(q: Pick<IntentsQuote, "deadline">): string {
  return `This deposit address stopped taking payments at ${clockUtc(q.deadline)}. Do not send to it. Get a new address to pay.`;
}

/** One sentence for the page's polite live region, changing only when the quote's state does. */
export function intentsAnnouncement(q: IntentsQuote): string {
  switch (intentsStage(q)) {
    case "deposit": {
      const step = q.steps.find((s) => s.state === "current");
      return step ? `${step.label}.` : "Waiting for deposit.";
    }
    case "incomplete":
      return incompleteCopy(q);
    case "returned":
      return `Your deposit was returned. ${returnedCopy(q)}`;
    case "failed":
      return "This payment could not be completed.";
    case "expired":
      return "This deposit address expired.";
    case "done":
      return "Delivered to merchant.";
  }
}

/** Screen D's line under the headline. */
export const paidFromText = (q: Pick<IntentsQuote, "origin">): string => `Paid from ${q.origin.chain_name} through NEAR Intents`;

/** The short form of the intents label: the chip on the buyer's screens says only "Simulated" or "Live - NEAR mainnet". */
export function modeChip(mode: "simulated" | "live"): string {
  return mode === "live" ? "Live - NEAR mainnet" : "Simulated";
}

// ---------------------------------------------------------------------------
// The refund address
// ---------------------------------------------------------------------------

function addressFormatOf(origin: Pick<IntentsOrigin, "asset" | "chain">): AddressFormat {
  return originOf(origin.asset)?.addressFormat ?? (origin.chain === "sol" ? "solana" : "evm");
}

/**
 * Why the refund address cannot be used on this origin's chain, or null when it can. Format only, checked the way the
 * node checks it; it says nothing about who owns the address, which is why the hint asks for the address paid from.
 */
export function refundAddressProblem(origin: Pick<IntentsOrigin, "asset" | "chain" | "chain_name">, value: string): string | null {
  const v = value.trim();
  const format = addressFormatOf(origin);
  if (!v) return `Enter your ${origin.chain_name} address.`;
  if (isOriginAddress({ addressFormat: format }, v)) return null;
  return format === "solana"
    ? "That is not a Solana address. It is 32 to 44 letters and digits, like the one your wallet shows."
    : `That is not a ${origin.chain_name} address. It is 0x followed by 40 characters, 0 to 9 and a to f.`;
}

export const refundPlaceholder = (origin: Pick<IntentsOrigin, "asset" | "chain">): string => (addressFormatOf(origin) === "solana" ? "Your Solana address" : "0x...");

// ---------------------------------------------------------------------------
// Simulated mode
// ---------------------------------------------------------------------------

/** "Send too little" in simulated mode: 60% of the amount, well under the quote's minimum, so the deposit comes back. */
export function shortAmount(q: Pick<IntentsQuote, "send_exactly" | "min_amount_in">): string {
  const v = (BigInt(q.send_exactly.amount) * 6n) / 10n;
  const min = BigInt(q.min_amount_in.amount);
  return (v < min ? v : min - 1n).toString();
}

// ---------------------------------------------------------------------------
// Merchant side
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "warning" | "positive" | "negative";

export const QUOTE_STATUS: Record<IntentsQuoteStatus, { label: string; tone: Tone }> = {
  awaiting_deposit: { label: "Waiting for deposit", tone: "neutral" },
  deposit_detected: { label: "Deposit received", tone: "info" },
  incomplete_deposit: { label: "Deposit too small", tone: "warning" },
  processing: { label: "Converting", tone: "info" },
  delivered: { label: "Delivered, checking on NEAR", tone: "info" },
  confirmed: { label: "Delivered", tone: "positive" },
  refunded: { label: "Deposit returned", tone: "warning" },
  failed: { label: "Failed", tone: "negative" },
  expired: { label: "Expired unused", tone: "neutral" },
};

/** How the node knows the USDC arrived. */
export function verificationText(v: IntentsQuote["verification"]): string {
  if (v === "rpc_checked") return "Delivery checked on NEAR";
  if (v === "provider_only") return "Reported by 1Click only";
  return "Not delivered yet";
}

/**
 * "Any chain - USDC on Base" when the paying quote is known (a list item's `intents` summary, or the detail's quotes),
 * "Any chain - from Base" from the payer alone.
 */
export function anyChainMethodLabel(p: Pick<Payment, "method" | "payer"> & { intents?: Pick<IntentsSummary, "origin"> | null }, quotes: readonly Pick<IntentsQuote, "status" | "origin">[] = []): string {
  const paid = quotes.find((q) => q.status === "confirmed") ?? quotes.find((q) => q.status === "delivered") ?? null;
  if (paid) return `Any chain - ${paid.origin.symbol} on ${paid.origin.chain_name}`;
  if (p.intents) return `Any chain - ${p.intents.origin.symbol} on ${p.intents.origin.chain_name}`;
  const code = p.payer && p.method === "oneclick" ? /^([a-z]+):/.exec(p.payer)?.[1] : undefined;
  return code ? `Any chain - from ${chainName(code)}` : "Any chain (NEAR Intents)";
}

/** Whether a list row names the any-chain origin: paid that way, or a buyer asked for a deposit address. */
export function showsAnyChain(p: Pick<Payment, "method"> & { intents?: unknown }): boolean {
  return p.method === "oneclick" || Boolean(p.intents);
}

/** A NEAR mainnet transaction on NearBlocks. */
export const mainnetTxUrl = (hash: string): string => `https://nearblocks.io/txns/${hash}`;

/**
 * The link page's words on how the buyer pays next, from the link's `intents`. In live mode the checkout offers Any
 * chain alone (the NEAR wallet pays test money there), so the page never mentions the wallet.
 */
export function linkPayCopy(intents: PublicLinkIntents | null | undefined): { lead: string; chip: string; icon: "wallet" | "globe" } {
  if (intents?.mode === "live") {
    if (intents.offered) return { lead: "Pay with USDC, USDT or ETH on Base, Ethereum, Arbitrum, Solana or Polygon.", chip: "Pay from any chain", icon: "globe" };
    return { lead: intents.reason ?? "Paying from another chain is not available for this link right now.", chip: "Pay from any chain", icon: "globe" };
  }
  if (intents?.offered) return { lead: "Next you pay from your NEAR wallet, or from another chain with USDC, USDT or ETH through NEAR Intents.", chip: "Pay from NEAR or any chain", icon: "globe" };
  return { lead: "Next you pay from your NEAR wallet. A plain transfer from an exchange cannot carry this order, so it would not count as this payment.", chip: "Pay from your NEAR wallet", icon: "wallet" };
}

/** A link that opens its checkout at once: active, a fixed amount, and nothing to ask the payer. */
export function linkOpensCheckout(link: { active: boolean; amount: string | null; collect_email: boolean; collect_name: boolean }): boolean {
  return link.active && link.amount !== null && !link.collect_email && !link.collect_name;
}

/** A page address a phone cannot open: this computer's own. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return true;
  }
}

/** The other chain's address in a `base:0x...` payer, for display. */
export function originPayer(payer: string | null | undefined): { chain: string; address: string } | null {
  const m = payer ? /^([a-z]+):(.+)$/.exec(payer) : null;
  return m ? { chain: chainName(m[1]!), address: m[2]! } : null;
}

export type CheckState = "done" | "todo" | "failed" | "unknown";
export type PayoutCheck = { key: "exists" | "usdc" | "proven"; label: string; state: CheckState; hint: string };

/** The three checks a business's NEAR account passes before "Accept any chain" can be turned on, as a checklist. */
export function payoutChecklist(p: Pick<IntentsPayout, "account" | "checks" | "settlement_network">): PayoutCheck[] {
  const network = p.settlement_network.startsWith("near:mainnet") ? "NEAR mainnet" : p.settlement_network;
  const none = p.account === null;
  const tri = (v: boolean | null): CheckState => (none ? "todo" : v === true ? "done" : v === false ? "failed" : "unknown");
  return [
    {
      key: "exists",
      label: `The account exists on ${network}`,
      state: tri(p.checks.exists),
      hint: p.checks.exists === false ? `No account with this name on ${network}. Check the spelling.` : p.checks.exists === null && !none ? `${network} could not be read just now. Check again in a moment.` : "Read from the chain when you save.",
    },
    {
      key: "usdc",
      label: "Registered with USDC",
      state: tri(p.checks.usdc_registered),
      hint: p.checks.usdc_registered === false ? "One storage deposit from the account, once. See the step below." : "So a USDC delivery to it cannot fail.",
    },
    {
      key: "proven",
      label: "Proven yours with a signed message",
      state: none ? "todo" : p.checks.proven ? "done" : "todo",
      hint: "Signed by the account itself, so nobody else can redirect your money.",
    },
  ];
}

/** The 409s of turning the method on, in plain words with what to do next. */
export function enableErrorText(code: string, fallback: string): string {
  if (code === "INTENTS_PAYOUT_REQUIRED") return "Set your NEAR account for any-chain payments and sign the message first.";
  if (code === "INTENTS_PAYOUT_NOT_REGISTERED") return "Your NEAR account is not registered with USDC yet. Send the storage deposit shown above, then check again.";
  if (code === "INTENTS_CHECKOUT_OFF") return "This Payminto server does not run the any-chain checkout. The operator turns it on with INTENTS_CHECKOUT.";
  return fallback;
}

// ---------------------------------------------------------------------------
// Refunds of an any-chain payment: sent by the business from its own wallet, then recorded by hand
// ---------------------------------------------------------------------------

/**
 * What the business needs to refund a payment that came from another chain, read from the quote that paid (or the
 * payer, `base:0x...`, when the quotes are not there): the buyer's refund address, the chain and token, the original
 * deposit, and how much is left to refund. Null for a payment made on NEAR.
 */
export function manualRefundOf(p: Pick<Payment, "method" | "payer"> & { intents?: Pick<PaymentIntents, "quotes"> | null }, refundable: bigint): ManualRefundDetails | null {
  if (p.method !== "oneclick") return null;
  const quotes = p.intents?.quotes ?? [];
  const q = quotes.find((x) => x.status === "confirmed") ?? quotes.find((x) => x.status === "delivered") ?? null;
  if (q) return { chain: q.origin.chain, chain_name: q.origin.chain_name, symbol: q.origin.symbol, refund_to: q.refund_to, deposit_tx: q.origin_txs[0] ?? null, refundable: refundable.toString() };
  const m = p.payer ? /^([a-z]+):(.+)$/.exec(p.payer) : null;
  if (!m) return null;
  return { chain: m[1]!, chain_name: chainName(m[1]!), symbol: null, refund_to: m[2]!, deposit_tx: null, refundable: refundable.toString() };
}

/** The details of 409 REFUND_MANUAL_REQUIRED, for a refund dialog opened the NEAR way; null for anything else. */
export function manualRefundFromError(e: unknown): ManualRefundDetails | null {
  if (!(e instanceof ApiError) || e.code !== "REFUND_MANUAL_REQUIRED") return null;
  const parsed = manualRefundDetailsSchema.safeParse(e.details);
  return parsed.success ? parsed.data : null;
}

const EVM_CHAINS = new Set(["base", "eth", "arb", "pol", "op", "bsc", "avax", "gnosis", "bera"]);
const an = (word: string) => (/^[AEIOU]/i.test(word) ? `an ${word}` : `a ${word}`);

/** Why a transaction hash cannot be from this chain, or null when its format fits. Format only, checked by the node too. */
export function originTxProblem(chain: string, chainNameText: string, value: string): string | null {
  const v = value.trim();
  if (!v) return `Enter the transaction hash on ${chainNameText}.`;
  if (EVM_CHAINS.has(chain)) return /^0x[0-9a-fA-F]{64}$/.test(v) ? null : `That is not ${an(chainNameText)} transaction hash. It is 0x followed by 64 characters, 0 to 9 and a to f.`;
  if (chain === "sol") return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v) ? null : "That is not a Solana transaction signature. It is 64 to 90 letters and digits, like the one your wallet shows.";
  return /^(0x)?[0-9A-Za-z]{32,128}$/.test(v) ? null : `That does not look like a transaction hash on ${chainNameText}.`;
}

// ---------------------------------------------------------------------------
// The token customers see first, and where the business receives
// ---------------------------------------------------------------------------

/** The origin the checkout opens with: the business's default when this payment offers it and it can be used now. */
export function preselectOrigin(rows: readonly Pick<IntentsOption, "origin" | "available">[], defaultOrigin: string | null | undefined): string | null {
  if (!defaultOrigin) return null;
  return rows.some((o) => o.origin.asset === defaultOrigin && o.available) ? defaultOrigin : null;
}

/** "0xab12...abcd" for a long address; a short one (a NEAR account) as it is. */
export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);

/** USDC on NEAR, the default destination: no destination at all (an older server) or one on NEAR. */
export const isNearDestination = (d: Pick<IntentsQuoteDestination, "chain"> | null | undefined): boolean => !d || d.chain === "near";

/** "1.50 USDC on Base to 0xab12...abcd"; "1.50 USDC on NEAR" for the default. */
export function destinationText(amount: Pick<IntentsAmount, "formatted" | "symbol">, d: IntentsQuoteDestination | null | undefined): string {
  if (!d || isNearDestination(d)) return `${amountText(amount)} on NEAR`;
  return `${exactUnits(amount.formatted)} ${d.symbol} on ${d.chain_name} to ${shortAddress(d.address)}`;
}

/** USDC on NEAR, for a server that does not list destinations yet. */
export const NEAR_USDC_DESTINATION: IntentsDestinationOption = { chain: "near", chain_name: "NEAR", symbol: "USDC", asset: "near:usdc", decimals: 6, verify: "rpc" };

/** The "Receive as" choices, USDC on NEAR first; NEAR alone when the server does not list any. */
export function receiveOptions(list: readonly IntentsDestinationOption[] | null | undefined): IntentsDestinationOption[] {
  if (!list || list.length === 0) return [NEAR_USDC_DESTINATION];
  const near = list.filter((d) => d.chain === "near");
  return [...(near.length ? near : [NEAR_USDC_DESTINATION]), ...list.filter((d) => d.chain !== "near")];
}

/** Said plainly where the server cannot read the destination chain itself; null where it can. */
export function destinationVerifyNote(d: Pick<IntentsDestinationOption, "chain_name" | "verify">): string | null {
  return d.verify === "provider_only" ? `Deliveries to ${d.chain_name} are confirmed by NEAR Intents' report. This server cannot read ${d.chain_name} itself.` : null;
}

/** EIP-155 chain ids of the EVM destinations. */
export const EVM_CHAIN_IDS: Record<string, number> = { base: 8453, eth: 1, arb: 42161, pol: 137, op: 10 };

export const isEvmAddress = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

/**
 * The EIP-191 message an EVM payout address signs (`personal_sign`), exactly as the server rebuilds it; null for a
 * chain that is not EVM.
 */
export function evmPayoutMessage(merchantId: string, address: string, timestamp: number, chain: string, hub: string): string | null {
  const id = EVM_CHAIN_IDS[chain];
  if (id === undefined) return null;
  return `Payminto intents payout ${merchantId} ${address.trim().toLowerCase()} ${timestamp} network eip155:${id} hub ${hub}`;
}
