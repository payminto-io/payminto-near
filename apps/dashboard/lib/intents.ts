/**
 * The any-chain checkout through NEAR Intents (docs/DEVELOPERS.md, "Any-chain checkout"), as the buyer and the business
 * see it: which tab and screen to show, the words on each screen, and the checks before "Get deposit address" enables.
 * Pure, for tests. Every amount and fee comes from the node's signed quote; nothing here prices anything.
 */
import { isOriginAddress, originOf, type AddressFormat } from "@payminto/near-addons/intents";
import { countdownTone, formatCountdown, secondsLeft } from "./checkout";
import type { CheckoutView, IntentsAmount, IntentsOrigin, IntentsPayout, IntentsQuote, IntentsQuoteStatus, IntentsSummary, Payment, PublicLinkIntents } from "./schemas";

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
 * The tabs of the pay panel. "Any chain" shows when the node offers it now, and also while a deposit made earlier is
 * still on its way, so the buyer can follow it even after the payment stopped taking new addresses.
 */
export function payTabs(view: Pick<CheckoutView, "methods" | "intents">, walletOffered: boolean): PayTab[] {
  const tabs: PayTab[] = [];
  if (walletOffered) tabs.push("wallet");
  if (anyChainOffered(view) || activeQuote(view)) tabs.push("oneclick");
  return tabs;
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
export function deadlineModel(q: Pick<IntentsQuote, "deadline" | "created_at">, now = Date.now()): DeadlineModel {
  const seconds = secondsLeft(q.deadline, now);
  const start = new Date(q.created_at).getTime();
  const end = new Date(q.deadline).getTime();
  const fraction = end > start ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0;
  return { seconds, text: formatCountdown(seconds), tone: countdownTone(seconds), fraction, clock: clockUtc(q.deadline) };
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
  return `We received ${got} of ${exactUnits(q.send_exactly.formatted)} ${sym}. Send the remaining ${missing} ${sym} to the same address before ${clockUtc(q.deadline)}, or it will be returned to ${q.refund_to}.`;
}

/** Screen E, returned: how much went back, where, on which chain, and why. */
export function returnedCopy(q: Pick<IntentsQuote, "refunded" | "refund_to" | "origin" | "refund_reason">): string {
  const where = `${q.refund_to} on ${q.origin.chain_name}`;
  const head = q.refunded ? `Your deposit was returned: ${amountText(q.refunded)} sent back to ${where}.` : `Your deposit was returned to ${where}.`;
  const why = refundReasonText(q.refund_reason);
  return why ? `${head} Reason: ${why}.` : head;
}

/** Screen E, failed: who to contact and with what reference. */
export function failedCopy(view: Pick<CheckoutView, "id" | "merchant">): string {
  const who = view.merchant.support_email ?? view.merchant.name;
  return `This payment could not be completed. Contact ${who} with reference ${view.id}.`;
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
      return returnedCopy(q);
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

/** The link page's words on how the buyer pays next, from the link's `intents`. */
export function linkPayCopy(intents: PublicLinkIntents | null | undefined): { lead: string; chip: string } {
  if (intents?.offered) return { lead: "Next you pay from your NEAR wallet, or from another chain with USDC, USDT or ETH through NEAR Intents.", chip: "Pay from NEAR or any chain" };
  return { lead: "Next you pay from your NEAR wallet. A plain transfer from an exchange cannot carry this order, so it would not count as this payment.", chip: "Pay from your NEAR wallet" };
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
