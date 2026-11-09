"use client";

import { RequirePermission } from "@/components/app/states";
import { usePlatformFees } from "@/lib/operator-queries";
import { formatInt } from "@/lib/format";
import { METHOD_INFO } from "@/components/operator/methods-editor";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { DayBars } from "@/components/gateway/day-bars";

function EarningsPagePage() {
  const q = usePlatformFees();
  return (
    <>
      <PageHeader title="Platform earnings" description="Fees the platform took in the last 30 days, split on chain in the same transaction as each payment." />
      {q.isPending ? (
        <BlockSkeleton className="h-[5.75rem]" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <StatStrip
            stats={[
              { label: "Fees earned", value: <Money atomic={q.data.total} />, note: "last 30 days" },
              { label: "Payment volume", value: <Money atomic={q.data.volume} maxFraction={2} />, note: "paid to businesses and platform" },
              { label: "Payments", value: <span className="num">{formatInt(q.data.payments)}</span>, note: "paid or overpaid" },
            ]}
          />
          <Panel className="mt-5" title="Fees by day">
            <DayBars days={q.data.days.map((d) => ({ day: d.day, value: d.fees }))} label="Platform fees per day for the last 30 days" />
          </Panel>
          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <Panel title="By business" bodyClassName="p-0 sm:p-0">
              <Table
                head={["Business", "Payments", "Volume", "Fees"]}
                rows={q.data.by_merchant.map((m) => [m.name, formatInt(m.payments), <Money key="v" atomic={m.volume} maxFraction={2} />, <Money key="f" atomic={m.fees} />])}
                total={["Total", formatInt(q.data.payments), <Money key="v" atomic={q.data.volume} maxFraction={2} />, <Money key="f" atomic={q.data.total} />]}
              />
            </Panel>
            <Panel title="By method" bodyClassName="p-0 sm:p-0">
              <Table
                head={["Method", "Payments", "Volume", "Fees"]}
                rows={q.data.by_method.map((m) => [METHOD_INFO[m.method].label, formatInt(m.payments), <Money key="v" atomic={m.volume} maxFraction={2} />, <Money key="f" atomic={m.fees} />])}
                total={["Total", formatInt(q.data.payments), <Money key="v" atomic={q.data.volume} maxFraction={2} />, <Money key="f" atomic={q.data.total} />]}
              />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function Table({ head, rows, total }: { head: string[]; rows: React.ReactNode[][]; total?: React.ReactNode[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={i === 0 ? "py-2.5 pr-3 pl-4 font-normal sm:pl-5" : "px-3 py-2.5 text-right font-normal last:pr-4 sm:last:pr-5"}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j === 0 ? "py-2.5 pr-3 pl-4 font-medium sm:pl-5" : "num px-3 py-2.5 text-right last:pr-4 sm:last:pr-5"}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t font-semibold">
              {total.map((c, j) => (
                <td key={j} className={j === 0 ? "py-2.5 pr-3 pl-4 sm:pl-5" : "num px-3 py-2.5 text-right last:pr-4 sm:last:pr-5"}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default function EarningsPage() {
  return (
    <RequirePermission permission={"earnings.read"}>
      <EarningsPagePage />
    </RequirePermission>
  );
}
