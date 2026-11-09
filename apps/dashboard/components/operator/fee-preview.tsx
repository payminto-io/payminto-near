"use client";

import { computeFees, type FeeBearer } from "@payminto/protocol";
import { useToken } from "@/lib/queries";
import { formatToken } from "@/lib/format";
import { cn } from "@/lib/utils";

type Plan = { platform_fee_bps: number; platform_fee_fixed: string; min_fee?: string | null; max_fee?: string | null };
type Method = { fee_bps: number; fee_fixed: string; bearer: FeeBearer } | null;

/** The live breakdown of one sample payment, computed with the protocol's computeFees (the node's own math). */
export function FeePreview({ amount, plan, method, className }: { amount: bigint; plan: Plan | null; method?: Method; className?: string }) {
  const t = useToken();
  let rows: [string, bigint, boolean?][] | null = null;
  let error: string | null = null;
  if (plan) {
    try {
      const f = computeFees({ amount, plan, method: method ?? null });
      rows = [
        ["Price", f.amount],
        ...(f.surcharge > 0n ? ([["Fee paid by customer", f.surcharge]] as [string, bigint][]) : []),
        ["Total to pay", f.amount_due],
        ["Platform fee", -f.platform_fee],
        ["Payment method fee", -f.method_fee],
        ["Business receives", f.net_amount, true],
      ];
    } catch (e) {
      error = e instanceof Error ? e.message : "Invalid plan";
    }
  }
  return (
    <div className={cn("rounded-lg border bg-muted/30 p-3", className)} aria-live="polite">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Example: a {formatToken(amount, t.symbol, t.decimals)} payment</p>
      {error ? (
        <p className="text-sm text-negative">{error}</p>
      ) : rows ? (
        <dl className="space-y-1 text-sm">
          {rows.map(([k, v, strong]) => (
            <div key={k} className={cn("flex justify-between gap-4", strong && "border-t pt-1.5 font-semibold")}>
              <dt className={strong ? undefined : "text-muted-foreground"}>{k}</dt>
              <dd className="num whitespace-nowrap">
                {v < 0n ? "-" : ""}
                {formatToken(v < 0n ? -v : v, t.symbol, t.decimals)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Fix the fee fields to see the breakdown.</p>
      )}
    </div>
  );
}
