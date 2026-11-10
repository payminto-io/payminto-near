/**
 * Pure gateway helpers shared by the hosted checkout and the merchant pages (docs/GATEWAY.md).
 * Amounts stay in token base units as bigint; nothing here goes through floats.
 */
import { formatAmount, isAccountId, networks, toAtomic, type AccountId, type Network } from "@payminto/protocol";
import { formatMoney, formatToken } from "./format";
import { proofRpcUrl } from "./near-reader";
import type { Payment, PaymentStatus, PaymentTab } from "./schemas";

// ---------------------------------------------------------------------------
// Amount input
// ---------------------------------------------------------------------------

export type AmountParse = { ok: true; atomic: bigint } | { ok: false; error: string };

/**
 * Parses what a person types ("25", "25.5", "1,250.00") into base units, refusing anything a token cannot represent.
 * Bounds are inclusive and in base units.
 */
export function parseAmountInput(text: string, decimals = 6, bounds: { min?: bigint | null; max?: bigint | null } = {}): AmountParse {
  const raw = text.trim().replace(/,/g, "");
  if (!raw) return { ok: false, error: "Enter an amount." };
  if (!/^\d*\.?\d*$/.test(raw) || raw === ".") return { ok: false, error: "Use digits and one decimal point." };
  const frac = raw.split(".")[1] ?? "";
  if (frac.length > decimals) return { ok: false, error: `At most ${decimals} decimal places.` };
  const atomic = toAtomic(`${raw.startsWith(".") ? "0" : ""}${raw.endsWith(".") ? raw.slice(0, -1) : raw}`, decimals);
  if (atomic <= 0n) return { ok: false, error: "The amount must be more than zero." };
  if (bounds.min != null && atomic < bounds.min) return { ok: false, error: `The minimum is ${plainAmount(bounds.min, decimals)}.` };
  if (bounds.max != null && atomic > bounds.max) return { ok: false, error: `The maximum is ${plainAmount(bounds.max, decimals)}.` };
  return { ok: true, atomic };
}

/** The exact amount as a payer types or pastes it: no grouping, no trailing zeros beyond two places ("25.00", "0.125"). */
export function plainAmount(atomic: bigint | string, decimals = 6): string {
  return formatAmount(BigInt(atomic), decimals);
}

// ---------------------------------------------------------------------------
// Merchant brand colour
// ---------------------------------------------------------------------------

/** A merchant colour as #rrggbb, or null when it is missing or not a hex colour. */
export function normalizeBrandColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(v);
  return long ? `#${long[1]}` : null;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour for a button filled with the merchant colour: whichever of white or ink reads better. */
export function readableOn(brand: string): "#ffffff" | "#0e1726" {
  return contrastRatio(brand, "#ffffff") >= contrastRatio(brand, "#0e1726") ? "#ffffff" : "#0e1726";
}

// ---------------------------------------------------------------------------
// Statuses, tabs and redirects
// ---------------------------------------------------------------------------

export type Tone = "positive" | "warning" | "negative" | "info" | "neutral";

export const PAYMENT_STATUS_META: Record<PaymentStatus, { tone: Tone; label: string }> = {
  open: { tone: "neutral", label: "Waiting for payment" },
  processing: { tone: "info", label: "Confirming" },
  partially_paid: { tone: "warning", label: "Partly paid" },
  paid: { tone: "positive", label: "Paid" },
  overpaid: { tone: "positive", label: "Paid extra" },
  underpaid: { tone: "warning", label: "Partly paid, ended" },
  expired: { tone: "neutral", label: "Expired" },
  canceled: { tone: "neutral", label: "Canceled" },
};

/** Which statuses each payments tab lists. "refunded" is a refund state, not a payment status. */
export const TAB_STATUSES: Record<Exclude<PaymentTab, "all" | "refunded">, PaymentStatus[]> = {
  paid: ["paid", "overpaid"],
  pending: ["open", "processing", "partially_paid"],
  underpaid: ["underpaid"],
  expired: ["expired", "canceled"],
};

export const TAB_LABELS: Record<PaymentTab, string> = {
  all: "All",
  paid: "Paid",
  pending: "Waiting",
  underpaid: "Partly paid",
  expired: "Expired",
  refunded: "Refunded",
};

export function paymentInTab(p: Pick<Payment, "status" | "refund_status">, tab: PaymentTab): boolean {
  if (tab === "all") return true;
  if (tab === "refunded") return p.refund_status !== "none";
  return TAB_STATUSES[tab].includes(p.status);
}

/** Tab counts from per-status counts (and a refunded count, when the node sends one). */
export function tabCounts(counts: Record<string, number>): Record<PaymentTab, number> {
  const sum = (ss: PaymentStatus[]) => ss.reduce((a, s) => a + (counts[s] ?? 0), 0);
  return {
    all: counts.all ?? Object.entries(counts).reduce((a, [k, v]) => (k === "refunded" ? a : a + v), 0),
    paid: sum(TAB_STATUSES.paid),
    pending: sum(TAB_STATUSES.pending),
    underpaid: sum(TAB_STATUSES.underpaid),
    expired: sum(TAB_STATUSES.expired),
    refunded: counts.refunded ?? 0,
  };
}

/** Only http(s) URLs are followed after payment, so a merchant field can never run script in the payer's tab. */
export function safeRedirectUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The trimmed NEAR account id, or null when it is not one. */
export function parseAccount(account: string): AccountId | null {
  const v = account.trim();
  return isAccountId(v) ? v : null;
}

export type GatewayNetwork = { id: Network; name: string; explorer: string | null; rpcUrl: string | null };

/** The network a checkout runs on, from the node's /v1/info when it has answered and the protocol package until then. */
export function gatewayNetwork(info?: { network: { id: string; name: string; explorer?: string | null; rpc_url?: string | null } } | null): GatewayNetwork {
  const id = (info?.network.id ?? "near:testnet") as Network;
  const known = networks[id];
  return {
    id,
    name: info?.network.name || known?.name || id,
    explorer: (info?.network.explorer ?? known?.explorer ?? "").replace(/\/+$/, "") || null,
    rpcUrl: proofRpcUrl(id, info?.network.rpc_url),
  };
}

/** "25.00 USDC", or the payer's range for a link where the customer chooses. */
export function linkPrice(l: { amount: string | null; min_amount?: string | null; max_amount?: string | null }, t: { symbol: string; decimals: number }): string {
  const f = (v: string) => formatToken(v, t.symbol, t.decimals);
  if (l.amount) return f(l.amount);
  if (l.min_amount && l.max_amount) return `Customer chooses, ${formatMoney(l.min_amount, t.decimals)} to ${f(l.max_amount)}`;
  return "Customer chooses";
}

/** A fee plan as one sentence: "0.50% + 0.10 USDC, at least 0.05 USDC, at most 5.00 USDC". */
export function describeFeePlan(p: { platform_fee_bps: number; platform_fee_fixed: string; min_fee?: string | null; max_fee?: string | null }, t: { symbol: string; decimals: number }): string {
  const parts: string[] = [];
  if (p.platform_fee_bps > 0 || BigInt(p.platform_fee_fixed) === 0n) parts.push(`${formatBps(p.platform_fee_bps)}`);
  if (BigInt(p.platform_fee_fixed) > 0n) parts.push(formatToken(p.platform_fee_fixed, t.symbol, t.decimals));
  let s = parts.join(" + ");
  if (p.min_fee && BigInt(p.min_fee) > 0n) s += `, at least ${formatToken(p.min_fee, t.symbol, t.decimals)}`;
  if (p.max_fee) s += `, at most ${formatToken(p.max_fee, t.symbol, t.decimals)}`;
  return s;
}

/** Basis points as a percentage: 50 is "0.5%", 0 is "0%", 125 is "1.25%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** Percent text ("0.5") to basis points, or null when it is not a valid 0 to max percent with at most 2 decimals. */
export function parsePercentToBps(text: string, maxBps = 1000): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= 0 && bps <= maxBps ? bps : null;
}

// ---------------------------------------------------------------------------
// Link expiry (PRODUCT.md section 10.12): never, 24 hours, 7 days or a custom time at least 60 s ahead.
// ---------------------------------------------------------------------------

export type ExpiryChoice = "never" | "24h" | "7d" | "custom";

export function linkExpiry(choice: ExpiryChoice, custom: string, now = Date.now()): { ok: true; iso: string | null } | { ok: false; error: string } {
  if (choice === "never") return { ok: true, iso: null };
  if (choice === "24h") return { ok: true, iso: new Date(now + 86_400_000).toISOString() };
  if (choice === "7d") return { ok: true, iso: new Date(now + 7 * 86_400_000).toISOString() };
  const at = custom ? new Date(custom).getTime() : NaN;
  if (!Number.isFinite(at)) return { ok: false, error: "Pick a date and time." };
  if (at < now + 60_000) return { ok: false, error: "Pick a time at least a minute from now." };
  return { ok: true, iso: new Date(at).toISOString() };
}

/** A `datetime-local` value for an ISO time, in the browser's time zone. */
export function toLocalInput(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The embeddable pay button, in the business's brand colour with a readable text colour (carry-over item 10). */
export function embedButtonHtml(url: string, brandColor: string | null | undefined, label = "Pay with crypto"): { html: string; background: string; color: string } {
  const background = normalizeBrandColor(brandColor) ?? "#0e1726";
  const color = readableOn(background);
  const safeUrl = url.replace(/"/g, "&quot;");
  const safeLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return {
    background,
    color,
    html: `<a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:${background};color:${color};font:600 15px system-ui;text-decoration:none">${safeLabel}</a>`,
  };
}
