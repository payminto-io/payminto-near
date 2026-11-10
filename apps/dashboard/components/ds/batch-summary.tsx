import type { ReactNode } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { formatInt, formatRatio, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

const TICK_CAP = 120;

/**
 * How N Calls settled as M token transfers: gross cleared on the left, tokens moved on the right. Ticks are one per Call
 * (capped at 120 with "+N") and bars one per transfer; both are decorative, so the counts and amounts are stated in
 * text. Below 620px of its own width the two sides stack with a downward arrow.
 */
export function BatchSummary({
  calls,
  transfers,
  gross,
  moved,
  label,
  children,
  footer,
}: {
  calls: number;
  transfers: number;
  /** Gross cleared: every Call's amount, before offsetting. */
  gross: ReactNode;
  /** Tokens moved: the sum of the net transfers. */
  moved: ReactNode;
  /** "Settlement batch #41". */
  label: string;
  /** The transfers, as TransferRow items. */
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const ratio = transfers > 0 ? calls / transfers : 0;
  const shown = Math.min(calls, TICK_CAP);
  return (
    <section aria-label={label} className="@container min-w-0 rounded-xl border bg-card">
      <div className="grid grid-cols-1 @[620px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Side
          overline="Gross cleared"
          count={calls}
          unit={plural(calls, "Call")}
          amountLabel="Cleared"
          amount={gross}
          marks={
            <>
              {Array.from({ length: shown }, (_, i) => (
                <span key={i} className="h-3 w-[3px] rounded-[1px] bg-subtle/55" />
              ))}
              {calls > TICK_CAP && <span className="ml-1 text-xs text-muted-foreground">+{formatInt(calls - TICK_CAP)}</span>}
            </>
          }
        />
        <div className="flex items-center justify-center gap-3 px-4 py-1 @[620px]:flex-col @[620px]:px-2 @[620px]:py-5">
          <span className="flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground" aria-hidden>
            <ArrowRight className="hidden size-4 @[620px]:block" />
            <ArrowDown className="size-4 @[620px]:hidden" />
          </span>
          {ratio > 1 && <span className="num rounded-full bg-accent px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-accent-foreground">{formatRatio(ratio)}x fewer</span>}
        </div>
        <Side
          overline="Tokens moved"
          primary
          count={transfers}
          unit={plural(transfers, "transfer")}
          amountLabel="Moved"
          amount={moved}
          marks={Array.from({ length: Math.min(transfers, 24) }, (_, i) => (
            <span key={i} className="h-3 w-9 rounded-[3px] bg-primary" />
          ))}
        />
      </div>
      <p className="sr-only">
        {formatInt(calls)} {plural(calls, "Call")} settled as {formatInt(transfers)} {plural(transfers, "transfer")}.
      </p>
      {children && <ul className="divide-y border-t">{children}</ul>}
      {footer && <div className="flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t bg-rail px-4 py-3 text-sm sm:px-5">{footer}</div>}
    </section>
  );
}

function Side({ overline, count, unit, amountLabel, amount, marks, primary = false }: { overline: string; count: number; unit: string; amountLabel: string; amount: ReactNode; marks: ReactNode; primary?: boolean }) {
  return (
    <div className="min-w-0 p-4 @[620px]:p-5">
      <p className={cn("text-xs font-medium tracking-[0.06em] uppercase", primary ? "text-primary" : "text-muted-foreground")}>{overline}</p>
      <p className="mt-2 flex items-baseline gap-2">
        <b className="num text-[2.5rem] leading-none font-semibold tracking-[-0.03em]">{formatInt(count)}</b>
        <span className="text-muted-foreground">{unit}</span>
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {amountLabel} {amount}
      </p>
      <div className="mt-4 flex min-h-7 flex-wrap items-center gap-[3px]" aria-hidden>
        {marks}
      </div>
    </div>
  );
}
