/**
 * Hosted checkout state: which panel a payer sees, the words on it, and the countdown.
 * The merchant column never changes between states; only the payment panel does (DESIGN_REFERENCES.md, Gateway 1).
 */
import { formatToken } from "./format";
import { contrastRatio, normalizeBrandColor, readableOn } from "./gateway";
import type { CheckoutHsp, CheckoutView, HspPaymentStatus, PaymentMethod } from "./schemas";

export type CheckoutPhase =
  | "open"
  | "signing"
  | "processing"
  | "partially_paid"
  | "paid"
  | "overpaid"
  | "underpaid"
  | "expired"
  | "canceled";

export const TERMINAL_PHASES: readonly CheckoutPhase[] = ["paid", "overpaid", "underpaid", "expired", "canceled"];

export function isTerminal(phase: CheckoutPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** Phases where the payer can still send money (the pay controls stay on screen). */
export function acceptsPayment(phase: CheckoutPhase): boolean {
  return phase === "open" || phase === "partially_paid";
}

/**
 * The phase for a view. An open payment past its expiry reads as expired straight away, before the node's next update,
 * and a wallet prompt in progress shows the signing panel.
 */
export function phaseOf(view: Pick<CheckoutView, "status" | "expires_at">, opts: { now?: number; signing?: boolean } = {}): CheckoutPhase {
  const now = opts.now ?? Date.now();
  const expired = new Date(view.expires_at).getTime() <= now;
  if (view.status === "open" && expired) return "expired";
  if (view.status === "partially_paid" && expired) return "underpaid";
  if (opts.signing && acceptsPayment(view.status as CheckoutPhase)) return "signing";
  return view.status;
}

export type CopyContext = {
  amount: string;
  paid: string;
  remaining: string;
  excess: string;
  merchant: string;
  /** The payment came from a link that is still active, so a new one can be started. */
  canRestart?: boolean;
  late?: boolean;
};

export type PhaseCopy = {
  headline: string;
  /** What is happening. */
  body: string;
  /** What happens next. */
  next: string;
  tone: "neutral" | "info" | "warning" | "positive" | "negative";
};

/** One headline, one sentence on what is happening and one on what happens next, per phase (build checklist rule 5). */
export function checkoutCopy(phase: CheckoutPhase, c: CopyContext): PhaseCopy {
  switch (phase) {
    case "open":
      return {
        headline: "Waiting for your payment",
        body: `Pay ${c.amount} with your wallet, or send it from any wallet or exchange.`,
        next: "We detect your payment automatically. Keep this page open.",
        tone: "neutral",
      };
    case "signing":
      return {
        headline: "Approve in your wallet",
        body: `Approve paying ${c.amount} in your wallet. Keep this page open.`,
        next: "Nothing moves until you approve. There is no network fee to pay.",
        tone: "info",
      };
    case "processing":
      return {
        headline: "Payment on its way",
        body: "We see your payment. The network is making it final.",
        next: "This usually takes a few seconds. You can keep this page open.",
        tone: "info",
      };
    case "partially_paid":
      return {
        headline: "Partly paid",
        body: `Received ${c.paid} of ${c.amount}. Send the remaining ${c.remaining} to the same address.`,
        next: "The payment completes as soon as the rest arrives, before the timer runs out.",
        tone: "warning",
      };
    case "paid":
      return {
        headline: "Payment complete",
        body: `${c.amount} paid to ${c.merchant}.`,
        next: c.late ? "It arrived after the request expired and was still credited." : "You can close this page. This receipt stays at the same address.",
        tone: "positive",
      };
    case "overpaid":
      return {
        headline: "Payment complete",
        body: `${c.paid} paid to ${c.merchant}.`,
        next: `You sent ${c.excess} more than asked. ${c.merchant} can refund the extra.`,
        tone: "positive",
      };
    case "underpaid":
      return {
        headline: "Payment incomplete",
        body: `This request ended after ${c.paid} of ${c.amount} arrived.`,
        next: `The ${c.paid} already sent is with ${c.merchant}. Contact them to finish or refund it.`,
        tone: "warning",
      };
    case "expired":
      return {
        headline: "This payment request has expired",
        body: "No funds were taken.",
        next: c.canRestart ? "Start a new payment to get a fresh address and timer." : `Do not send money to this address. Ask ${c.merchant} for a new payment link.`,
        tone: "neutral",
      };
    case "canceled":
      return {
        headline: "This payment was canceled",
        body: `${c.merchant} canceled this request. No funds were taken.`,
        next: `Do not send money to this address. Contact ${c.merchant} if this seems wrong.`,
        tone: "neutral",
      };
  }
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

export function secondsLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}

/** "14:52", "1:04:09", or "6d 23h" for links that stay open for days. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The countdown turns amber under five minutes and red under one (PRODUCT.md section 6.3). */
export function countdownTone(seconds: number): "neutral" | "warning" | "danger" {
  if (seconds < 60) return "danger";
  return seconds < 300 ? "warning" : "neutral";
}

/** Share of the payment window still left, 1 when it opened and 0 at expiry, for the shrinking time bar. */
export function countdownFraction(createdAt: string, expiresAt: string, now = Date.now()): number {
  const start = new Date(createdAt).getTime();
  const end = new Date(expiresAt).getTime();
  if (!(end > start)) return 0;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

/** Spoken form for screen readers, announced sparingly: "14 minutes left". */
export function countdownLabel(seconds: number): string {
  if (seconds <= 0) return "Expired";
  if (seconds < 60) return `${seconds} seconds left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} minutes left`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hours left`;
  return `${Math.round(seconds / 86_400)} days left`;
}

// ---------------------------------------------------------------------------
// Confirmations and redirect
// ---------------------------------------------------------------------------

/** Confirmation progress while processing, when the node reports it (clamped, at least one required). */
export function confirmationProgress(view: Pick<CheckoutView, "confirmations">): { current: number; required: number } | null {
  const c = view.confirmations;
  if (!c) return null;
  const required = Math.max(1, c.required);
  return { current: Math.max(0, Math.min(c.current, required)), required };
}

/** Public paths render without the console shell or a session. */
export function isPublicCheckoutPath(pathname: string | null | undefined): boolean {
  return Boolean(pathname && /^\/(l|pay|receipt)\/[^/]+\/?$/.test(pathname));
}

export const REDIRECT_SECONDS = 5;

/** Seconds left before "Return to merchant" happens on its own. */
export function redirectSecondsLeft(startedAt: number, now = Date.now(), total = REDIRECT_SECONDS): number {
  return Math.max(0, total - Math.floor((now - startedAt) / 1000));
}

/**
 * The email a payer already gave on the link page, kept for this tab only, so the checkout does not ask for it again.
 * The public checkout view never carries the email, by design.
 */
const receiptKey = (paymentId: string) => `payminto.receipt-email.${paymentId}`;
export function rememberReceiptEmail(paymentId: string, email: string): void {
  try {
    window.sessionStorage.setItem(receiptKey(paymentId), email);
  } catch {
    // Storage can be unavailable; the checkout then simply offers the optional receipt email again.
  }
}
export function rememberedReceiptEmail(paymentId: string): string | null {
  try {
    return window.sessionStorage.getItem(receiptKey(paymentId));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Methods and the amount due for each
// ---------------------------------------------------------------------------

/** The ways a person pays on the checkout page; agents use the API. */
export type PayMethod = "wallet" | "deposit" | "hsp";

export const METHOD_COPY: Record<PayMethod, { label: string; hint: string }> = {
  wallet: { label: "Pay with wallet", hint: "One click from a browser wallet. No network fee." },
  deposit: { label: "Send to address", hint: "From any wallet or exchange." },
  hsp: { label: "Pay with HSP", hint: "Sign once and HashKey's HSP sends it for you." },
};

/** The fee line is named after the way of paying it is for (GATEWAY.md section 14.3). */
export const METHOD_FEE_LABEL: Record<PaymentMethod, string> = {
  wallet: "Wallet payment fee",
  deposit: "Send to address fee",
  x402: "AI agent fee",
  voucher: "AI agent with budget fee",
  hsp: "HSP payment fee",
};

/** Quotes already seen this visit, so switching back to a method shows its amount without waiting. */
export type QuoteCache = Partial<Record<PayMethod, { surcharge: string; amount_due: string }>>;

export type MethodQuote = {
  surcharge: bigint;
  due: bigint;
  /** Still to send for this method. */
  remaining: bigint;
  /** The numbers are this method's own (from the node now, or from a quote seen earlier). */
  known: boolean;
  /** The node has quoted the payment for this method, so paying with it is safe right now. */
  ready: boolean;
};

type QuoteView = Pick<CheckoutView, "method" | "amount" | "surcharge" | "amount_due" | "amount_paid" | "amount_remaining">;

/**
 * What the payer owes when paying with `method`. Fees depend on the method and the node re-quotes when it changes, so
 * until that answer arrives the amount comes from an earlier quote, or is the business's price marked as not known.
 * Once money has arrived the quote is bound and every method owes the same remainder.
 */
export function quoteFor(view: QuoteView, method: PayMethod, cache: QuoteCache = {}): MethodQuote {
  const bound = BigInt(view.amount_paid) > 0n || view.method === method;
  if (bound) return { surcharge: BigInt(view.surcharge), due: BigInt(view.amount_due), remaining: BigInt(view.amount_remaining), known: true, ready: true };
  const seen = cache[method];
  if (seen) {
    const due = BigInt(seen.amount_due);
    return { surcharge: BigInt(seen.surcharge), due, remaining: due, known: true, ready: false };
  }
  const amount = BigInt(view.amount);
  return { surcharge: 0n, due: amount, remaining: amount, known: false, ready: false };
}

/** Records the view's current quote under its method. */
export function rememberQuote(cache: QuoteCache, view: Pick<CheckoutView, "method" | "surcharge" | "amount_due" | "amount_paid">): QuoteCache {
  if ((view.method !== "wallet" && view.method !== "deposit" && view.method !== "hsp") || BigInt(view.amount_paid) > 0n) return cache;
  const prev = cache[view.method];
  if (prev && prev.surcharge === view.surcharge && prev.amount_due === view.amount_due) return cache;
  return { ...cache, [view.method]: { surcharge: view.surcharge, amount_due: view.amount_due } };
}

/**
 * Methods the payer can pick. The wallet signature only exists while the payment is quoted for `wallet`, so a payment
 * that already took money by another method keeps that method.
 */
export function availableMethods(view: Pick<CheckoutView, "methods" | "authorization" | "status" | "amount_paid">): PayMethod[] {
  const out: PayMethod[] = [];
  if (view.methods.includes("wallet") && (Boolean(view.authorization) || (view.status === "open" && view.amount_paid === "0"))) out.push("wallet");
  if (view.methods.includes("deposit")) out.push("deposit");
  if (view.methods.includes("hsp")) out.push("hsp");
  return out;
}

/** The method a fresh checkout opens on: the one already quoted, unless there is no browser wallet to use it. */
export function initialMethod(view: Parameters<typeof availableMethods>[0] & Pick<CheckoutView, "method">, hasWallet: boolean): PayMethod | null {
  const methods = availableMethods(view);
  if (methods.length === 0) return null;
  if (!hasWallet && methods.includes("deposit")) return "deposit";
  if (view.method === "wallet" || view.method === "deposit" || view.method === "hsp") {
    if (methods.includes(view.method)) return view.method;
  }
  return methods[0]!;
}

// ---------------------------------------------------------------------------
// Browser wallet steps
// ---------------------------------------------------------------------------

export type WalletStep = "idle" | "connecting" | "switching" | "approving" | "submitting";

/** The guided steps shown while paying with a wallet, in order. */
export const WALLET_STEPS: readonly Exclude<WalletStep, "idle" | "submitting">[] = ["connecting", "switching", "approving"];

export function walletStepCopy(step: WalletStep, network: string): { title: string; hint: string; short: string } {
  switch (step) {
    case "idle":
      return { title: "Pay with your wallet", hint: "Sign once. The network fee is covered.", short: "Ready" };
    case "connecting":
      return { title: "Open your wallet", hint: "Choose the account to pay from and connect it.", short: "Connect" };
    case "switching":
      return { title: `Switching to ${network}`, hint: `Approve the switch to ${network} in your wallet.`, short: `Use ${network}` };
    case "approving":
      return { title: "Approve the payment", hint: "Sign once. Nothing moves until you approve.", short: "Approve" };
    case "submitting":
      return { title: "Sending your payment", hint: `Your wallet signed. Sending it on ${network} now.`, short: "Send" };
  }
}

/** Index of a step in WALLET_STEPS; submitting counts as past the last step, idle as before the first. */
export function walletStepIndex(step: WalletStep): number {
  if (step === "idle") return -1;
  if (step === "submitting") return WALLET_STEPS.length;
  return WALLET_STEPS.indexOf(step);
}

// ---------------------------------------------------------------------------
// HSP (GATEWAY.md section 17)
// ---------------------------------------------------------------------------

/** Labels of the HSP progress steps, in order. */
export const HSP_STEPS = ["Submitted", "On chain", "Final"] as const;

/**
 * Where an HSP payment is, in plain words: step 1 submitted (HSP is checking and sending it), 2 on chain (included or
 * safe, not final yet), 3 final. A failed payment says why; a timeout is HSP still trying, so it reads as submitted.
 */
export function hspProgress(status: HspPaymentStatus | null): { step: 0 | 1 | 2 | 3; title: string; hint: string; failed: boolean } {
  switch (status) {
    case null:
    case "order-created":
      return { step: 0, title: "Pay with HSP", hint: "Sign once. HashKey's HSP sends the payment, so you pay no network fee.", failed: false };
    case "payment-submitted":
    case "payment-verified":
    case "payment-processing":
    case "payment-timeout":
      return { step: 1, title: "Submitted to HSP", hint: "HSP is checking your payment and sending it on the network.", failed: false };
    case "payment-included":
    case "payment-safe":
      return { step: 2, title: "On chain", hint: "Your payment is on the network and is becoming final.", failed: false };
    case "payment-finalized":
      return { step: 3, title: "Final", hint: "HSP reports the payment as final.", failed: false };
    case "payment-failed":
      return { step: 0, title: "HSP could not complete the payment", hint: "No money moved. You can try again or pay another way.", failed: true };
  }
}

/** True while an HSP payment was submitted and is not final or failed: the checkout shows its progress. */
export function hspInFlight(hsp: Pick<CheckoutHsp, "status"> | null | undefined): boolean {
  const s = hsp?.status;
  return Boolean(s && s !== "order-created" && s !== "payment-finalized" && s !== "payment-failed");
}

// ---------------------------------------------------------------------------
// View model: one place that turns the node's view into what the panel shows
// ---------------------------------------------------------------------------

export type PanelKind = "pay" | "signing" | "confirming" | "success" | "ended";

export type StatusChip = { label: string; tone: PhaseCopy["tone"] };

const STATUS_CHIP: Record<CheckoutPhase, StatusChip> = {
  open: { label: "Waiting for payment", tone: "neutral" },
  signing: { label: "Waiting for your wallet", tone: "info" },
  processing: { label: "Confirming", tone: "info" },
  partially_paid: { label: "Partly paid", tone: "warning" },
  paid: { label: "Paid", tone: "positive" },
  overpaid: { label: "Paid extra", tone: "positive" },
  underpaid: { label: "Incomplete", tone: "warning" },
  expired: { label: "Expired", tone: "neutral" },
  canceled: { label: "Canceled", tone: "neutral" },
};

export function panelKind(phase: CheckoutPhase): PanelKind {
  if (acceptsPayment(phase)) return "pay";
  if (phase === "signing") return "signing";
  if (phase === "processing") return "confirming";
  if (phase === "paid" || phase === "overpaid") return "success";
  return "ended";
}

/** Labels of the confirmation ring, in order. */
export const CONFIRM_STEPS = ["Seen", "Sent", "Final"] as const;

/**
 * Where the payment is on its way to final: step 0 nothing seen, 1 seen, 2 sent (in a block), 3 final; and the ring's
 * fill from 0 to 1. A sent payment fills by its confirmations and only closes the ring once the node says paid.
 */
export function confirmStage(view: Pick<CheckoutView, "status" | "confirmations">): { step: 0 | 1 | 2 | 3; fraction: number } {
  if (view.status === "paid" || view.status === "overpaid") return { step: 3, fraction: 1 };
  if (view.status !== "processing") return { step: 0, fraction: 0 };
  const c = confirmationProgress(view);
  if (!c || c.current === 0) return { step: 1, fraction: 1 / 3 };
  return { step: 2, fraction: Math.min(0.96, 1 / 3 + (2 / 3) * (c.current / c.required)) };
}

/** Share of the amount due already received, 0 to 1. */
export function paidFraction(view: Pick<CheckoutView, "amount_due" | "amount_paid">): number {
  const due = BigInt(view.amount_due);
  if (due <= 0n) return 0;
  const paid = BigInt(view.amount_paid);
  return Math.min(1, Number((paid * 10_000n) / due) / 10_000);
}

export type CountdownModel = { seconds: number; text: string; label: string; tone: "neutral" | "warning" | "danger"; fraction: number };

export function countdownModel(view: Pick<CheckoutView, "created_at" | "expires_at">, now = Date.now()): CountdownModel {
  const seconds = secondsLeft(view.expires_at, now);
  return { seconds, text: formatCountdown(seconds), label: countdownLabel(seconds), tone: countdownTone(seconds), fraction: countdownFraction(view.created_at, view.expires_at, now) };
}

export type CheckoutModel = {
  phase: CheckoutPhase;
  panel: PanelKind;
  copy: PhaseCopy;
  chip: StatusChip;
  stage: ReturnType<typeof confirmStage>;
  paid: number;
  /** Shown while money can still be sent. */
  countdown: CountdownModel | null;
  /** One sentence for the polite live region, changing only when the state does. */
  announce: string;
};

export function copyContextOf(view: CheckoutView): CopyContext {
  const t = view.token;
  const fmt = (v: bigint) => formatToken(v, t.symbol, t.decimals);
  const due = BigInt(view.amount_due);
  const paid = BigInt(view.amount_paid);
  return {
    amount: fmt(due),
    paid: fmt(paid),
    remaining: fmt(BigInt(view.amount_remaining)),
    excess: fmt(paid > due ? paid - due : 0n),
    merchant: view.merchant.name,
    canRestart: Boolean(view.link?.active),
    late: view.late,
  };
}

export function checkoutModel(view: CheckoutView, opts: { now?: number; signing?: boolean } = {}): CheckoutModel {
  const now = opts.now ?? Date.now();
  const phase = phaseOf(view, { now, signing: opts.signing });
  const copy = checkoutCopy(phase, copyContextOf(view));
  const panel = panelKind(phase);
  return {
    phase,
    panel,
    copy,
    chip: STATUS_CHIP[phase],
    stage: confirmStage(view),
    paid: paidFraction(view),
    countdown: panel === "pay" || panel === "signing" ? countdownModel(view, now) : null,
    announce: `${copy.headline}. ${copy.body}`,
  };
}

/** 0 when the return countdown starts, 1 when it sends the payer back. */
export function redirectFraction(startedAt: number, now = Date.now(), total = REDIRECT_SECONDS): number {
  return Math.min(1, Math.max(0, (now - startedAt) / (total * 1000)));
}

// ---------------------------------------------------------------------------
// Business brand colour, applied only where it stays readable
// ---------------------------------------------------------------------------

/** Card colours of the two themes (globals.css), which the brand colour must stand out from. */
export const CARD_LIGHT = "#ffffff";
export const CARD_DARK = "#121a26";

/**
 * CSS variables for a business colour. `--brand` fills the pay button, with `--brand-fg` as its text. `--brand-ink`
 * and `--brand-ink-dark` draw rings, ticks and accents on the card, and fall back to the app accent in a theme where
 * the colour would have under 3:1 contrast against the card (WCAG non-text contrast).
 */
export function brandVars(color: string | null | undefined): Record<string, string> {
  const brand = normalizeBrandColor(color);
  if (!brand) return {};
  return {
    "--brand": brand,
    "--brand-fg": readableOn(brand),
    "--brand-ink": contrastRatio(brand, CARD_LIGHT) >= 3 ? brand : "var(--primary)",
    "--brand-ink-dark": contrastRatio(brand, CARD_DARK) >= 3 ? brand : "var(--primary)",
  };
}

// ---------------------------------------------------------------------------
// Link page amount chooser
// ---------------------------------------------------------------------------

const PRESET_UNITS = [5n, 10n, 25n, 50n, 100n, 250n, 500n, 1000n];

/**
 * Up to four one-tap amounts for a link where the payer chooses, inside the link's range: round amounts, starting at
 * the minimum when the minimum itself is not round.
 */
export function amountPresets(min: bigint | null | undefined, max: bigint | null | undefined, decimals = 6): bigint[] {
  const unit = 10n ** BigInt(decimals);
  const lo = min ?? 0n;
  const hi = max ?? null;
  const round = PRESET_UNITS.map((u) => u * unit).filter((v) => v >= lo && v > 0n && (hi === null || v <= hi));
  const out = min && min > 0n && !round.includes(min) ? [min, ...round] : round;
  return out.slice(0, 4);
}
