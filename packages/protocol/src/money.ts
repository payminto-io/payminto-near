function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(-decimals) : "";
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Formats atomic units for display, trimming trailing zeros but keeping at least two decimals. */
export function formatAmount(atomic: bigint | string, decimals = 6): string {
  const [whole, frac = ""] = formatUnits(BigInt(atomic), decimals).split(".");
  return `${whole}.${frac.replace(/0+$/, "").padEnd(2, "0")}`;
}

export function toAtomic(display: string, decimals = 6): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(display)) throw new Error(`not a decimal amount: ${display}`);
  const negative = display.startsWith("-");
  const [whole, frac = ""] = display.replace("-", "").split(".");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`${display} has more than ${decimals} decimals`);
  const atomic = BigInt(`${whole}${frac.slice(0, decimals).padEnd(decimals, "0")}`);
  return negative ? -atomic : atomic;
}
