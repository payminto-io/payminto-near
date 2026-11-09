"use client";

import { RequirePermission } from "@/components/app/states";
import { useCan } from "@/lib/session";
import Link from "next/link";
import { Plus, Store } from "lucide-react";
import { useFeePlans, useMerchants } from "@/lib/operator-queries";
import { formatInt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Address, Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { ListHead } from "@/components/gateway/kit";
import { MerchantMark } from "@/components/checkout/parts";

const COLS = "md:grid-cols-[minmax(0,1.6fr)_6.5rem_minmax(0,1fr)_minmax(0,1fr)_8rem_5.5rem]";

function MerchantsPagePage() {
  const merchants = useMerchants();
  const plans = useFeePlans();
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Businesses"
        description="Every business this server takes payments for. Each has its own payout wallet, pricing plan, methods, links and keys."
        actions={
          can("businesses.manage") && (
            <Button asChild>
              <Link href="/platform/businesses/new">
                <Plus /> Add business
              </Link>
            </Button>
          )
        }
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {merchants.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : merchants.isError ? (
          <ErrorState className="m-4" error={merchants.error} onRetry={() => void merchants.refetch()} />
        ) : merchants.data.length === 0 ? (
          <EmptyState icon={<Store className="size-4" />} title="No businesses yet" action={can("businesses.manage") ? <Button asChild><Link href="/platform/businesses/new">Add the first business</Link></Button> : undefined} />
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Business</span>
              <span>Status</span>
              <span>Payout</span>
              <span>Pricing plan</span>
              <span className="text-right">Volume, 30d</span>
              <span className="text-right">Payments</span>
            </ListHead>
            <ul className="divide-y">
              {merchants.data.map((m) => (
                <li key={m.id} className={`relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/40 sm:px-5 md:gap-4 ${COLS}`}>
                  <span className="flex min-w-0 items-center gap-3" style={m.brand_color ? ({ "--brand": m.brand_color } as React.CSSProperties) : undefined}>
                    <MerchantMark merchant={m} className="size-8 text-sm" />
                    <span className="min-w-0">
                      <Link href={`/platform/businesses/${m.id}`} className="block truncate font-medium after:absolute after:inset-0 hover:underline">
                        {m.name}
                      </Link>
                      <span className="hash block truncate text-xs text-muted-foreground">{m.slug}</span>
                    </span>
                  </span>
                  <span>
                    <Chip tone={m.status === "active" ? "positive" : "warning"}>{m.status === "active" ? "Active" : "Suspended"}</Chip>
                  </span>
                  <span className="relative z-10 min-w-0 max-md:hidden">
                    <Address address={m.payout} showName={false} explorer={false} />
                  </span>
                  <span className="truncate text-muted-foreground max-md:hidden">{plans.data?.find((p) => p.id === m.fee_plan_id)?.name ?? "-"}</span>
                  <span className="text-right max-md:col-start-1 max-md:text-left max-md:text-muted-foreground">{m.volume_30d ? <Money atomic={m.volume_30d} maxFraction={2} /> : "-"}</span>
                  <span className="num text-right text-muted-foreground max-md:hidden">{m.payments_30d != null ? formatInt(m.payments_30d) : "-"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

export default function MerchantsPage() {
  return (
    <RequirePermission permission={"businesses.read"}>
      <MerchantsPagePage />
    </RequirePermission>
  );
}
