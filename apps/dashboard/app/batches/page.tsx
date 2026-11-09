"use client";

import { RequirePermission } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import Link from "next/link";
import { Layers } from "lucide-react";
import { useBatches } from "@/lib/queries";
import { formatDateTime, formatInt, formatRatio, plural } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

function BatchesPagePage() {
  const batches = useBatches();
  return (
    <>
      <PageHeader
        title="Settlements"
        description="Each settlement is one on-chain transaction that pays many charges at once. It moves only the differences, and every single charge in it can still be verified later."
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {batches.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : batches.isError ? (
          <ErrorState className="m-4" error={batches.error} onRetry={() => void batches.refetch()} />
        ) : batches.data.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-4" />}
            title="No settlements yet"
            action={
              <Button asChild>
                <Link href="/netting">Open next settlement</Link>
              </Button>
            }
          >
            Settle accepted charges from Next settlement, or let the server settle on its interval.
          </EmptyState>
        ) : (
          <>
          <ul className="divide-y md:hidden">
            {batches.data.map((b) => (
              <li key={b.id}>
                <Link href={`/batches/${b.id}`} className="block px-4 py-3.5 hover:bg-muted/40">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">Settlement #{b.seq}</span>
                    <BatchStatusChip status={b.status} />
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    <span className="num">{formatInt(b.calls)}</span> {plural(b.calls, "charge")}, <Money atomic={b.gross} maxFraction={4} /> owed, <Money atomic={b.net} maxFraction={4} /> moved
                  </p>
                  <p className="mt-0.5 text-xs text-subtle">
                    <span className="num">{formatRatio(b.transfers ? b.calls / b.transfers : 0)}</span> {plural(b.transfers ? b.calls / b.transfers : 0, "call")} per transfer, <TimeAgo iso={b.confirmedAt ?? b.createdAt} />
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <div className="overflow-x-auto max-md:hidden">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-normal">Settlement</th>
                  <th className="px-3 py-2.5 font-normal">Status</th>
                  <th className="px-3 py-2.5 text-right font-normal">Charges</th>
                  <th className="px-3 py-2.5 text-right font-normal">Owed</th>
                  <th className="px-3 py-2.5 text-right font-normal">Moved on chain</th>
                  <th className="px-3 py-2.5 text-right font-normal">Transfers</th>
                  <th className="px-3 py-2.5 text-right font-normal">Charges per transfer</th>
                  <th className="px-3 py-2.5 font-normal">Transaction</th>
                  <th className="px-5 py-2.5 text-right font-normal">Settled</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {batches.data.map((b) => (
                  <tr key={b.id} className="hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <Link href={`/batches/${b.id}`} className="font-medium hover:underline">
                        Settlement #{b.seq}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <BatchStatusChip status={b.status} />
                    </td>
                    <td className="num px-3 py-3 text-right">{formatInt(b.calls)}</td>
                    <td className="px-3 py-3 text-right"><Money atomic={b.gross} maxFraction={4} /></td>
                    <td className="px-3 py-3 text-right"><Money atomic={b.net} maxFraction={4} /></td>
                    <td className="num px-3 py-3 text-right">{b.transfers}</td>
                    <td className="num px-3 py-3 text-right font-medium">{formatRatio(b.transfers ? b.calls / b.transfers : 0)}</td>
                    <td className="px-3 py-3"><Hash value={b.txHash} kind="tx" /></td>
                    <td className="num px-5 py-3 text-right text-xs whitespace-nowrap text-muted-foreground" title={formatDateTime(b.confirmedAt ?? b.createdAt)}>
                      <TimeAgo iso={b.confirmedAt ?? b.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>
    </>
  );
}

export default function BatchesPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <BatchesPagePage />
    </RequirePermission>
  );
}
