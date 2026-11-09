/**
 * Number count-ups for stats: the numbers in a piece of text animate from the previous value (0 on first paint) to the
 * new one, keeping the text's own formatting (thousands separators, decimals, suffixes). Pure parts are unit tested.
 */

const NUM = /\d[\d,]*(?:\.\d+)?/g;

export type NumberToken = { start: number; end: number; value: number; decimals: number; grouped: boolean };

export function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUM)) {
    const raw = m[0];
    const dot = raw.indexOf(".");
    out.push({ start: m.index!, end: m.index! + raw.length, value: Number(raw.replace(/,/g, "")), decimals: dot < 0 ? 0 : raw.length - dot - 1, grouped: raw.includes(",") || Number(raw.replace(/,/g, "")) >= 1000 });
  }
  return out;
}

export function formatToken(value: number, t: Pick<NumberToken, "decimals" | "grouped">): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: t.decimals, maximumFractionDigits: t.decimals, useGrouping: t.grouped });
}

/** The text at progress `p` (0 to 1) between `from` (a number per token, or 0) and the target text. */
export function interpolate(target: string, from: number[], p: number): string {
  const tokens = numberTokens(target);
  if (tokens.length === 0) return target;
  let out = "";
  let at = 0;
  tokens.forEach((t, i) => {
    const start = from[i] ?? 0;
    const v = start + (t.value - start) * p;
    out += target.slice(at, t.start) + formatToken(p >= 1 ? t.value : v, t);
    at = t.end;
  });
  return out + target.slice(at);
}

/** Ease-out cubic. */
export function easeOut(p: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);
}
