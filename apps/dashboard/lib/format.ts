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
export function formatMoney(atomic: bigint | string, decimals = 6): string {
  const raw = formatAmount(BigInt(atomic), decimals);
  const [whole = "0", frac = ""] = raw.split(".");
  return `${group(whole)}.${frac}`;
}

/** Money with its unit, the only way amounts reach the screen: "12.50 USDC". */
export function formatToken(atomic: bigint | string, symbol = "USDC", decimals = 6): string {
  return `${formatMoney(atomic, decimals)} ${symbol}`;
}

/**
 * A NEAR account for tight text: named accounts up to 24 characters stay whole, longer ones (implicit accounts, keys)
 * keep the head and the last 8 characters, as AccountId does.
 */
export function shortAddress(value: string, head = 10, tail = 8): string {
  if (!value) return "";
  if (value.length <= Math.max(24, head + tail + 1)) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortHash(value: string): string {
  return value.length <= 17 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
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

const tFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** "14:01:57": exact time of day for rows; the date lives in the title or the row group. */
export function formatTime(iso: string): string {
  return tFmt.format(new Date(iso));
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

/**
 * `role:account:kind`, where the account itself may contain ":" (an `ed25519:` key), so only the first and last
 * segments are structure.
 */
export function splitLedgerAccount(account: string): { role: string; addr: string; kind: string } {
  const parts = account.split(":");
  if (parts.length < 3) return { role: parts[0] ?? "", addr: parts.slice(1).join(":"), kind: "" };
  return { role: parts[0]!, addr: parts.slice(1, -1).join(":"), kind: parts.at(-1)! };
}
