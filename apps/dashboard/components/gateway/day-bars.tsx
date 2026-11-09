"use client";

import { formatToken } from "@/lib/format";
import { useToken } from "@/lib/queries";
import { cn } from "@/lib/utils";

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLabel = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));

/** A compact 30-day bar strip with an accessible summary and its first and last day under it; each bar has its value in a tooltip title. */
export function DayBars({ days, label, className }: { days: { day: string; value: string }[]; label: string; className?: string }) {
  const t = useToken();
  const max = days.reduce((a, d) => (BigInt(d.value) > a ? BigInt(d.value) : a), 0n);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <div>
      <div role="img" aria-label={label} className={cn("flex h-16 items-end gap-[3px]", className)}>
        {days.map((d) => {
          const v = BigInt(d.value);
          const pct = max > 0n ? Number((v * 1000n) / max) / 10 : 0;
          return (
            <span
              key={d.day}
              title={`${dayLabel(d.day)}: ${formatToken(v, t.symbol, t.decimals)}`}
              className={cn("min-w-0 flex-1 rounded-sm", v > 0n ? "bg-[var(--chart-bar)]" : "bg-muted")}
              style={{ height: `${Math.max(v > 0n ? 6 : 3, pct)}%` }}
            />
          );
        })}
      </div>
      {first && last && (
        <p aria-hidden className="num mt-1.5 flex justify-between text-[0.6875rem] text-subtle">
          <span>{dayLabel(first.day)}</span>
          <span>{dayLabel(last.day)}</span>
        </p>
      )}
    </div>
  );
}
