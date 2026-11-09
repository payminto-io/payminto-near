import { formatAmount } from "@payminto/protocol";

/** Groups the whole part of a plain decimal string with thousands separators. */
function group(whole: string): string {
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${out}` : out;
}

/**
 * Money for display: exact, never through floats.
 * `formatMoney("1234567", 6)` is "1.234567" and `formatMoney("1234560000", 6)` is "1,234.56".
 */
export function formatMoney(atomic: bigint | string, decimals = 6, opts: { maxFraction?: number } = {}): string {
  const raw = formatAmount(BigInt(atomic), decimals);
  const [whole = "0", frac = ""] = raw.split(".");
  let f = frac;
  if (opts.maxFraction !== undefined && f.length > opts.maxFraction) {
    // Round half up on the decimal string so the display never invents precision.
    const scaled = BigInt(atomic) < 0n ? -BigInt(atomic) : BigInt(atomic);
    const unit = 10n ** BigInt(decimals - opts.maxFraction);
    const rounded = (scaled + unit / 2n) / unit;
    const s = rounded.toString().padStart(opts.maxFraction + 1, "0");
    const w = s.slice(0, s.length - opts.maxFraction);
    f = s.slice(s.length - opts.maxFraction).replace(/0+$/, "").padEnd(2, "0");
    return `${BigInt(atomic) < 0n ? "-" : ""}${group(w)}.${f}`;
  }
  return `${group(whole)}.${f}`;
}

/** Money with its unit, the only way amounts reach the screen: "12.50 USDC". */
export function formatToken(atomic: bigint | string, symbol = "USDC", decimals = 6, opts?: { maxFraction?: number }): string {
  return `${formatMoney(atomic, decimals, opts)} ${symbol}`;
}

/** 0x12ab...9f3c style truncation that keeps the checksum casing. */
export function shortAddress(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortHash(value: string): string {
  return shortAddress(value, 10, 6);
}

const intFmt = new Intl.NumberFormat("en-US");
export function formatInt(n: number | bigint): string {
  return intFmt.format(n);
}

/** "1 call", "2 calls": the word after a count, singular only for exactly one. */
export function plural(n: number | bigint, one: string, many = `${one}s`): string {
  return Number(n) === 1 ? one : many;
}

export function formatRatio(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n >= 100 ? intFmt.format(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
}

/** Gas units in thousands or millions, e.g. "11.2M gas". */
export function formatGas(units: bigint | string): string {
  const n = Number(BigInt(units));
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M gas`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k gas`;
  return `${n} gas`;
}

/** Native-token wei as a short decimal, e.g. "0.00118 HSK" (L1 data fees appear only on HashKey Chain). */
export function formatNative(wei: bigint | string, symbol = "HSK"): string {
  const n = Number(BigInt(wei)) / 1e18;
  return `${n === 0 ? "0" : n.toPrecision(3).replace(/\.?0+(e|$)/, "$1")} ${symbol}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 5) return "just now";
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

const dtFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export function formatDateTime(iso: string): string {
  return dtFmt.format(new Date(iso));
}

const dFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });
export function formatDate(iso: string | number): string {
  return dFmt.format(typeof iso === "number" ? new Date(iso * 1000) : new Date(iso));
}

/** Integer percentage of used/total, clamped to 0..100, computed in bigint. */
export function percentOf(used: bigint | string, total: bigint | string): number {
  const t = BigInt(total);
  if (t <= 0n) return 0;
  const p = Number((BigInt(used) * 10000n) / t) / 100;
  return Math.max(0, Math.min(100, p));
}
