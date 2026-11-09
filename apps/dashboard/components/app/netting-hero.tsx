"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { formatInt, formatRatio } from "@/lib/format";
import type { BeforeAfter } from "@/lib/netting";
import { cn } from "@/lib/utils";
import { Money } from "./primitives";

const MAX_TICKS = 240;

/** One mark per on-chain transfer, so the difference is visible before it is read. */
function Ticks({ count, tone }: { count: number; tone: "before" | "after" }) {
  const shown = Math.min(count, MAX_TICKS);
  return (
    <div aria-hidden className="mt-4 flex min-h-7 flex-wrap content-start items-center gap-[3px]">
      {Array.from({ length: shown }, (_, i) =>
        tone === "before" ? (
          <span key={i} className="h-3 w-[3px] rounded-[1px] bg-subtle/55" />
        ) : (
          <span key={i} className="h-3 w-9 rounded-[3px] bg-primary" />
        ),
      )}
      {count > shown && <span className="num ml-1 text-xs text-subtle">+{formatInt(count - shown)}</span>}
    </div>
  );
}

/**
 * The Netting hero: transfers and value without netting next to the same figures with it,
 * plus the action that turns one into the other.
 */
export function NettingHero({ figures, settled, action }: { figures: BeforeAfter; settled: boolean; action: ReactNode }) {
  const { before, after, fewer, valueSavedPct } = figures;
  return (
    <section aria-label="Before and after bundling" className="overflow-hidden rounded-xl border bg-card">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,19rem)]">
        <div className="min-w-0 px-5 pt-5 pb-4 sm:px-6 lg:pb-5">
          <p className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Without bundling</p>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="num text-[2.5rem] leading-none font-semibold tracking-[-0.03em] text-muted-foreground">{formatInt(before.transfers)}</span>
            <span className="text-sm text-muted-foreground">on-chain transfers</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            One per charge, moving <Money atomic={before.amount} maxFraction={4} className="text-foreground" />
          </p>
          <Ticks count={before.transfers} tone="before" />
        </div>

        <div className="flex items-center justify-center gap-3 px-5 py-1 lg:flex-col lg:px-2 lg:py-5">
          <span className="flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground">
            <ArrowDown className="size-4 lg:hidden" aria-hidden />
            <ArrowRight className="size-4 max-lg:hidden" aria-hidden />
          </span>
          {fewer > 0 && (
            <span className="num rounded-full bg-accent px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-accent-foreground">
              {formatRatio(fewer)}x fewer
            </span>
          )}
        </div>

        <div className="min-w-0 px-5 pt-4 pb-5 sm:px-6 lg:pt-5">
          <p className="text-xs font-medium tracking-[0.06em] text-primary uppercase">{settled ? "Sent with bundling" : "With bundling"}</p>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="num text-[2.5rem] leading-none font-semibold tracking-[-0.03em] text-foreground">{formatInt(after.transfers)}</span>
            <span className="text-sm text-muted-foreground">on-chain {after.transfers === 1 ? "transfer" : "transfers"}</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Moving <Money atomic={after.amount} maxFraction={4} className="text-foreground" />
            {valueSavedPct > 0 && <span className="text-positive">, {valueSavedPct.toFixed(1)}% less</span>}
          </p>
          <Ticks count={after.transfers} tone="after" />
        </div>

        <div className={cn("flex min-w-0 flex-col justify-center gap-3 border-t bg-rail px-5 py-5 sm:px-6 lg:col-span-3 xl:col-span-1 xl:border-t-0 xl:border-l")}>
          {action}
        </div>
      </div>
      <p className="sr-only">
        Without bundling, {before.transfers} transfers. With bundling, {after.transfers} transfers.
      </p>
    </section>
  );
}
