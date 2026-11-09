"use client";

import { useState } from "react";
import Link from "next/link";
import { Undo2 } from "lucide-react";
import { useRefunds } from "@/lib/gateway-queries";
import type { RefundStatus } from "@/lib/schemas";
import { withBusiness } from "@/lib/merchant-scope";
import { Chip } from "@/components/app/status";
import { BusinessFilter, useBusinessNames } from "@/components/gateway/business-filter";
import { Address, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { RefundStatusChip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { CountTabs, ListHead } from "@/components/gateway/kit";

const COLS = "md:grid-cols-[8rem_6.5rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem]";
const COLS_BUSINESS = "md:grid-cols-[8rem_6.5rem_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem]";

export default function RefundsPage() {
  const refunds = useRefunds();
  const [filter, setFilter] = useState<"all" | RefundStatus | "requested">("all");
  const [business, setBusiness] = useState<string | null>(null);
  const { platformView, nameOf } = useBusinessNames();
  const cols = platformView ? COLS_BUSINESS : COLS;
  const all = (refunds.data?.items ?? []).filter((r) => !business || r.merchant_id === business);
  const requested = all.filter((r) => r.approval === "requested" && r.status === "pending");
  const shown = filter === "requested" ? requested : all.filter((r) => filter === "all" || r.status === filter);
  const count = (s: RefundStatus) => (refunds.data ? all.filter((r) => r.status === s).length : null);

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Money sent back to customers from the payout wallet. Payminto checks each transfer on chain before it counts."
        actions={<BusinessFilter value={business} onChange={setBusiness} />}
      />
      <CountTabs
        label="Filter refunds"
        value={filter}
        onChange={setFilter}
        tabs={[
          { key: "all", label: "All", count: refunds.data ? all.length : null },
          { key: "requested", label: "Waiting for approval", count: refunds.data ? requested.length : null },
          { key: "pending", label: "Not sent yet", count: count("pending") },
          { key: "succeeded", label: "Sent", count: count("succeeded") },
          { key: "failed", label: "Failed", count: count("failed") },
        ]}
      />
      <Panel className="mt-4" bodyClassName="p-0 sm:p-0">
        {refunds.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : refunds.isError ? (
          <ErrorState className="m-4" error={refunds.error} onRetry={() => void refunds.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState icon={<Undo2 className="size-4" />} title={all.length ? "No refunds in this view" : "No refunds yet"}>
            Open a paid payment and choose Refund. The money is sent from your payout wallet.
          </EmptyState>
        ) : (
          <>
            <ListHead cols={cols}>
              <span className="text-right">Amount</span>
              <span>Status</span>
              <span>Original payment</span>
              {platformView && <span>Business</span>}
              <span>Recipient</span>
              <span>Reason</span>
              <span className="text-right">Date</span>
            </ListHead>
            <ul className="stagger divide-y">
              {shown.map((r) => {
                const mid = r.merchant_id;
                return (
                <li key={r.id} className={`relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 md:gap-4 ${cols}`}>
                  <Link href={withBusiness(`/payments/${r.payment_id}`, mid)} className="font-semibold after:absolute after:inset-0 md:text-right">
                    <Money atomic={r.amount} />
                  </Link>
                  <span className="justify-self-end md:justify-self-start">
                    {r.approval === "requested" && r.status === "pending" ? <Chip tone="warning">Waiting for approval</Chip> : <RefundStatusChip status={r.status} />}
                  </span>
                  <span className="relative z-10 min-w-0 text-sm">
                    <Hash value={r.payment_id} href={withBusiness(`/payments/${r.payment_id}`, mid)} />
                  </span>
                  {platformView && <span className="min-w-0 truncate text-sm text-muted-foreground max-md:hidden">{nameOf(mid) ?? "-"}</span>}
                  <span className="relative z-10 min-w-0 text-sm max-md:justify-self-end">
                    <Address address={r.to} showName={false} explorer={false} />
                  </span>
                  <span className="min-w-0 text-sm text-muted-foreground max-md:col-span-2">
                    <span className="block truncate">{r.reason ?? "-"}</span>
                    {r.failure_reason && <span className="block text-xs text-negative">{r.failure_reason}</span>}
                  </span>
                  <span className="text-sm text-muted-foreground max-md:hidden md:text-right">
                    <TimeAgo iso={r.created_at} />
                  </span>
                </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}
