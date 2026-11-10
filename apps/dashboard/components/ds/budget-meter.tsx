import type { ReactNode } from "react";
import { budgetSplit } from "@/lib/spend";
import { cn } from "@/lib/utils";

const SOLID = { primary: "bg-primary", warning: "bg-warning", negative: "bg-negative" } as const;
/**
 * The waiting segment is hatched in the tone colour rather than tinted: each stripe holds 5.3:1 or more against the
 * track in both themes, where a 35 percent tint was about 1.8:1. A 2px track gap separates it from the settled segment.
 */
const HATCH = {
  primary: "bg-[repeating-linear-gradient(135deg,var(--primary)_0_2px,transparent_2px_5px)]",
  warning: "bg-[repeating-linear-gradient(135deg,var(--warning)_0_2px,transparent_2px_5px)]",
  negative: "bg-[repeating-linear-gradient(135deg,var(--negative)_0_2px,transparent_2px_5px)]",
} as const;

/** The bar alone, for lists; pair it with the amounts in words. */
export function MeterBar({ settled, waiting, limit, label, size = "md", className }: { settled: bigint | string; waiting: bigint | string; limit: bigint | string; label: string; size?: "sm" | "md"; className?: string }) {
  const split = budgetSplit(settled, waiting, limit);
  const hasWaiting = BigInt(waiting) > 0n;
  return (
    <div
      className={cn("flex w-full gap-0.5 overflow-hidden rounded-full bg-muted", size === "sm" ? "h-1.5" : "h-2.5", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split.usedPct)}
      aria-valuetext={`${split.usedPct.toFixed(1)} percent used`}
    >
      {split.settledPct > 0 && <div className={cn("h-full shrink-0 rounded-l-full transition-[width] duration-500", SOLID[split.tone])} style={{ width: `${Math.max(split.settledPct, 1)}%` }} />}
      {hasWaiting && <div className={cn("h-full shrink-0 transition-[width] duration-500", HATCH[split.tone])} style={{ width: `${Math.max(split.pendingPct, 1)}%` }} />}
    </div>
  );
}

/**
 * What is settled, waiting and remaining in a Budget, led by the remaining amount. The bar is primary up to 75 percent
 * used, warning above and negative above 90. The legend always states each amount, so the bar is never the only signal.
 */
export function BudgetMeter({
  settled,
  waiting,
  limit,
  remaining,
  money,
  aside,
  spendableNow,
}: {
  settled: string;
  waiting: string;
  limit: string;
  remaining: string;
  /** Renders an amount in the Budget's token. */
  money: (atomic: string, opts?: { size?: "display" }) => ReactNode;
  /** Right-hand line, for example the used percent and time left. */
  aside?: ReactNode;
  /**
   * What the agent can spend right now when that is less than the remaining cap: the server refuses a Call once the
   * Budget's unsettled spending would pass its escrow, so escrow, not the cap, is then the real limit.
   */
  spendableNow?: { atomic: string; why: ReactNode } | null;
}) {
  const split = budgetSplit(settled, waiting, limit);
  return (
    <section aria-label="Budget" className="rounded-xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Remaining in this Budget</p>
          <p className="mt-1.5">{money(remaining, { size: "display" })}</p>
          {spendableNow && (
            <p className="mt-1 text-sm text-muted-foreground">
              Spendable now <span className="font-medium text-foreground">{money(spendableNow.atomic)}</span>, {spendableNow.why}
            </p>
          )}
        </div>
        {aside && <div className="text-sm text-muted-foreground">{aside}</div>}
      </div>
      <MeterBar settled={settled} waiting={waiting} limit={limit} label="Budget used" className="mt-4" />
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn("size-2.5 rounded-full", SOLID[split.tone])} />
          <dt className="text-muted-foreground">Settled</dt>
          <dd>{money(settled)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn("size-2.5 rounded-full ring-1 ring-inset", HATCH[split.tone], split.tone === "primary" ? "ring-primary" : split.tone === "warning" ? "ring-warning" : "ring-negative")} />
          <dt className="text-muted-foreground">Waiting to settle</dt>
          <dd>{money(waiting)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-full bg-muted ring-1 ring-input ring-inset" />
          <dt className="text-muted-foreground">Remaining</dt>
          <dd>{money(remaining)}</dd>
        </div>
      </dl>
    </section>
  );
}
