import { formatUnits, parseUnits } from "viem";

/** Formats atomic units for display, trimming trailing zeros but keeping at least two decimals. */
export function formatAmount(atomic: bigint | string, decimals = 6): string {
  const s = formatUnits(BigInt(atomic), decimals);
  const [whole, frac = ""] = s.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

export function toAtomic(display: string, decimals = 6): bigint {
  return parseUnits(display, decimals);
}
