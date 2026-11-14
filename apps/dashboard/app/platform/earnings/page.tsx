"use client";

import Link from "next/link";
import { Download, PiggyBank } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/lib/session";
import { usePlatform, usePlatformFees } from "@/lib/operator-queries";
import { useFeeMonths } from "@/lib/balance-api";
import { useToken } from "@/lib/queries";
import { formatInt, plural } from "@/lib/format";
import { businessesByFees, earningsCsv, earningsCsvFilename, monthLabel, monthsFromDays, monthsFromRows, rowsFromBusinesses, type MonthTotal } from "@/lib/earnings";
import { saveFile } from "@/lib/report";
import { Button } from "@/components/ui/button";
import { Meter, Money, PageHeader, Panel } from "@/components/app/primitives";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RequirePermission, RowsSkeleton } from "@/components/app/states";
import { ListHead } from "@/components/gateway/kit";

const MONTH_COLS = "md:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1.2fr)_8rem]";
const BIZ_COLS = "md:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1.2fr)_8rem]";

function EarningsPagePage() {
  const fees = usePlatformFees();
  const months = useFeeMonths();
  const platform = usePlatform();
  const can = useCan();
  const t = useToken();
  const wallet = platform.data?.fee_recipient ?? null;

  const header = (
    <PageHeader
      title="Earnings"
      description={wallet ? "Platform fees on paid payments, from every business, paid to the fee wallet set in Platform settings." : "Platform fees on paid payments, from every business."}
      actions={
        fees.data && (
          <Button
            variant="outline"
            disabled={months.isPending || fees.data.by_merchant.length === 0}
            onClick={() => {
              const rows = months.data ?? rowsFromBusinesses(fees.data.by_merchant);
              saveFile(earningsCsvFilename(), earningsCsv(rows, t));
              toast.success("Earnings downloaded");
            }}
          >
            <Download aria-hidden /> Download CSV
          </Button>
        )
      }
    />
  );

  if (fees.isPending) {
    return (
      <>
        {header}
        <BlockSkeleton className="h-[5.75rem]" />
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <BlockSkeleton className="h-64" />
          <BlockSkeleton className="h-64" />
        </div>
      </>
    );
  }
  if (fees.isError) {
    return (
      <>
        {header}
        <ErrorState error={fees.error} onRetry={() => void fees.refetch()} />
      </>
    );
  }
  const f = fees.data;
  if (BigInt(f.total) === 0n && f.payments === 0) {
    return (
      <>
        {header}
        <div className="rounded-xl border bg-card">
          <EmptyState icon={<PiggyBank className="size-4" />} title="No fees earned yet" action={can("pricing.read") ? <Button asChild variant="outline"><Link href="/platform/pricing">Open Pricing plans</Link></Button> : undefined}>
            Fees show up here once a business on a priced plan gets paid.
          </EmptyState>
        </div>
      </>
    );
  }

  const monthly: MonthTotal[] | null = months.data ? monthsFromRows(months.data) : months.data === null ? monthsFromDays(f.days) : null;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const current = monthly?.find((m) => m.month === thisMonth)?.fee_total ?? "0";
  const businesses = businessesByFees(f.by_merchant);
  const top = monthly?.reduce((a, m) => (BigInt(m.fee_total) > a ? BigInt(m.fee_total) : a), 0n) ?? 0n;

  return (
    <>
      {header}
      <StatStrip
        stats={[
          { label: "Fees earned", value: <Money atomic={f.total} />, note: "all time" },
          { label: "This month", value: monthly ? <Money atomic={current} /> : "-", note: monthLabel(thisMonth) },
          { label: "Volume", value: <Money atomic={f.volume} />, note: "paid to businesses, before fees" },
          { label: "Paid payments", value: <span className="num">{formatInt(f.payments)}</span>, note: `${formatInt(businesses.length)} ${plural(businesses.length, "business", "businesses")}` },
        ]}
      />
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel
          title="By month"
          description={months.data === null ? "The last 30 days only: this server does not report older months." : "By the month payments were paid in (UTC)."}
          bodyClassName="p-0 sm:p-0"
        >
          {months.isPending ? (
            <RowsSkeleton className="px-5" rows={3} />
          ) : months.isError ? (
            <ErrorState className="m-4" error={months.error} onRetry={() => void months.refetch()} />
          ) : !monthly || monthly.length === 0 ? (
            <EmptyState title="No fees in this period" />
          ) : (
            <>
              <ListHead cols={MONTH_COLS}>
                <span>Month</span>
                <span className="text-right">Payments</span>
                <span aria-hidden />
                <span className="text-right">Fees</span>
              </ListHead>
              <ul className="divide-y">
                {monthly.map((m) => (
                  <li key={m.month} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-5 md:gap-4 ${MONTH_COLS}`}>
                    <span className="font-medium">{monthLabel(m.month)}</span>
                    <span className="num text-right text-muted-foreground max-md:hidden">{m.payments === null ? "-" : formatInt(m.payments)}</span>
                    <span className="max-md:col-span-2 max-md:row-start-2">
                      <Meter value={top > 0n ? Number((BigInt(m.fee_total) * 1000n) / top) / 10 : 0} label={`${monthLabel(m.month)} fees, share of the biggest month`} />
                    </span>
                    <span className="text-right max-md:row-start-1 max-md:col-start-2">
                      <Money atomic={m.fee_total} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
        <Panel title="By business" description="All time, most fees first." bodyClassName="p-0 sm:p-0">
          <ListHead cols={BIZ_COLS}>
            <span>Business</span>
            <span className="text-right">Payments</span>
            <span>Share</span>
            <span className="text-right">Fees</span>
          </ListHead>
          <ul className="divide-y">
            {businesses.map((b) => (
              <li key={b.merchant_id} className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm transition-colors hover:bg-muted/40 sm:px-5 md:gap-4 ${BIZ_COLS}`}>
                <span className="min-w-0">
                  {can("businesses.read") ? (
                    <Link href={`/platform/businesses/${b.merchant_id}`} className="block truncate font-medium after:absolute after:inset-0 hover:underline">
                      {b.name}
                    </Link>
                  ) : (
                    <span className="block truncate font-medium">{b.name}</span>
                  )}
                  <span className="block text-xs text-muted-foreground md:hidden">
                    {formatInt(b.payments)} {plural(b.payments, "payment")}, {b.share}%
                  </span>
                </span>
                <span className="num text-right text-muted-foreground max-md:hidden">{formatInt(b.payments)}</span>
                <span className="flex items-center gap-2 max-md:col-span-2 max-md:row-start-2">
                  <Meter value={b.share} label={`${b.name}, share of all fees`} />
                  <span className="num w-9 shrink-0 text-right text-xs text-muted-foreground max-md:hidden">{b.share}%</span>
                </span>
                <span className="text-right max-md:row-start-1 max-md:col-start-2">
                  <Money atomic={b.fees} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

export default function EarningsPage() {
  return (
    <RequirePermission permission={"earnings.read"}>
      <EarningsPagePage />
    </RequirePermission>
  );
}
