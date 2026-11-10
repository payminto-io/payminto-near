import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "text-[0.8125rem] leading-[1.125rem]",
  md: "text-sm leading-5",
  lg: "text-base leading-6",
  display: "text-[2rem] leading-none tracking-[-0.025em]",
} as const;

/**
 * An exact amount with its unit, in tabular mono numerals at weight 500.
 * Every significant decimal of the atomic value shows, never rounded: a clearing product shows exact amounts.
 * Unknown values show `-`.
 */
export function Amount({
  atomic,
  decimals,
  unit,
  signed = false,
  size = "md",
  className,
  unitClassName,
}: {
  atomic: string | bigint | null | undefined;
  decimals: number;
  unit: string;
  signed?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
  unitClassName?: string;
}) {
  if (atomic === null || atomic === undefined || atomic === "") return <span className={cn("font-mono text-subtle", SIZES[size], className)}>-</span>;
  const v = BigInt(atomic);
  const exact = formatMoney(v, decimals);
  const sign = signed && v > 0n ? "+" : "";
  return (
    <span className={cn("num font-mono font-medium whitespace-nowrap", SIZES[size], className)} data-exact={exact}>
      {sign}
      {exact}
      <span className={cn("ml-1 text-[0.82em] font-normal text-muted-foreground", size === "display" && "ml-1.5 text-[0.55em] tracking-normal", unitClassName)}>{unit}</span>
    </span>
  );
}
