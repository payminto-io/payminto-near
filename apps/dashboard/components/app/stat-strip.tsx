import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CountUp } from "./count-up";

export type Stat = { label: string; value: ReactNode; note?: ReactNode; tone?: "positive" | "negative" | "neutral" };

/** One bordered strip of figures with hairline dividers; reads as a single statement, not a card grid. */
export function StatStrip({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border",
        stats.length >= 6 ? "sm:grid-cols-3 xl:grid-cols-6" : stats.length === 4 ? "lg:grid-cols-4" : stats.length === 3 ? "sm:grid-cols-3" : "",
        className,
      )}
    >
      {stats.map((s) => (
        <div key={s.label} className="min-w-0 bg-card px-4 py-4 transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5">
          <dt className="truncate text-xs text-muted-foreground">{s.label}</dt>
          <dd className="num mt-1.5 truncate text-[1.3125rem] leading-tight font-semibold tracking-[-0.015em]">
            <CountUp>{s.value}</CountUp>
          </dd>
          {s.note && (
            <dd
              className={cn(
                "mt-1 line-clamp-2 text-xs sm:line-clamp-1",
                s.tone === "positive" ? "text-positive" : s.tone === "negative" ? "text-negative" : "text-muted-foreground",
              )}
            >
              {s.note}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}
