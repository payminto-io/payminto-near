"use client";

import { useState } from "react";
import Link from "next/link";
import { Link2, Plus } from "lucide-react";
import { useLinks } from "@/lib/gateway-queries";
import { useToken } from "@/lib/queries";
import { formatInt } from "@/lib/format";
import { linkPrice } from "@/lib/gateway";
import { useCan } from "@/lib/session";
import { withBusiness } from "@/lib/merchant-scope";
import { BusinessFilter, useBusinessNames } from "@/components/gateway/business-filter";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { CopyAction } from "@/components/checkout/parts";
import { CountTabs, ListHead } from "@/components/gateway/kit";

const COLS = "md:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_5.5rem_8.5rem_6.5rem_7rem]";
type Filter = "all" | "active" | "expired" | "inactive";
const COLS_BUSINESS = "md:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem_8.5rem_6.5rem_7rem]";

/** Active, expired (a past expiry) or turned off. */
function linkState(l: { active: boolean; expired?: boolean }): "active" | "expired" | "inactive" {
  if (!l.active) return "inactive";
  return l.expired ? "expired" : "active";
}

export default function LinksPage() {
  const links = useLinks();
  const t = useToken();
  const can = useCan();
  const [filter, setFilter] = useState<Filter>("all");
  const [business, setBusiness] = useState<string | null>(null);
  const { platformView, nameOf } = useBusinessNames();
  const cols = platformView ? COLS_BUSINESS : COLS;
  const all = (links.data ?? []).filter((l) => !business || l.merchant_id === business);
  const shown = all.filter((l) => filter === "all" || linkState(l) === filter);
  const count = (f: Exclude<Filter, "all">) => (links.data ? all.filter((l) => linkState(l) === f).length : null);

  return (
    <>
      <PageHeader
        title="Payment links"
        description="One link per product or price. A person who opens it gets a checkout page; an AI agent that opens it pays automatically."
        actions={
          <>
            <BusinessFilter value={business} onChange={setBusiness} />
            {can("links.write") && !platformView && (
              <Button asChild>
                <Link href="/links/new">
                  <Plus /> New payment link
                </Link>
              </Button>
            )}
          </>
        }
      />
      <CountTabs
        label="Filter links"
        value={filter}
        onChange={setFilter}
        tabs={[
          { key: "all", label: "All", count: links.data ? all.length : null },
          { key: "active", label: "Active", count: count("active") },
          { key: "expired", label: "Expired", count: count("expired") },
          { key: "inactive", label: "Turned off", count: count("inactive") },
        ]}
      />
      <Panel className="mt-4" bodyClassName="p-0 sm:p-0">
        {links.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : links.isError ? (
          <ErrorState className="m-4" error={links.error} onRetry={() => void links.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState icon={<Link2 className="size-4" />} title={all.length ? "No links in this view" : "No payment links yet"} action={can("links.write") && !platformView ? <Button asChild><Link href="/links/new">Create a payment link</Link></Button> : undefined}>
            A link is the fastest way to get paid: share it anywhere, no code needed.
          </EmptyState>
        ) : (
          <>
            <ListHead cols={cols}>
              <span>Title</span>
              {platformView && <span>Business</span>}
              <span>Price</span>
              <span className="text-right">Payments</span>
              <span className="text-right">Volume</span>
              <span className="text-right">Created</span>
              <span className="sr-only">Copy</span>
            </ListHead>
            <ul className="stagger divide-y">
              {shown.map((l) => {
                const state = linkState(l);
                return (
                <li key={l.id} className={`relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 md:gap-4 ${cols}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={withBusiness(`/links/${l.id}`, l.merchant_id)} className="truncate font-medium after:absolute after:inset-0 hover:underline">
                      {l.title}
                    </Link>
                    <Chip tone={state === "active" ? "positive" : state === "expired" ? "warning" : "neutral"}>{state === "active" ? "Active" : state === "expired" ? "Expired" : "Turned off"}</Chip>
                  </span>
                  {platformView && <span className="min-w-0 truncate text-sm text-muted-foreground max-md:hidden">{nameOf(l.merchant_id) ?? "-"}</span>}
                  <span className="text-sm max-md:col-start-1 max-md:row-start-2 max-md:text-muted-foreground">{linkPrice(l, t)}</span>
                  <span className="num text-right text-sm max-md:hidden">{formatInt(l.payments_count)}</span>
                  <span className="text-right text-sm max-md:row-start-1">
                    <Money atomic={l.paid_total} />
                  </span>
                  <span className="text-right text-sm text-muted-foreground max-md:hidden">
                    <TimeAgo iso={l.created_at} />
                  </span>
                  <span className="relative z-10 justify-self-end max-md:row-start-2">
                    <CopyAction value={l.url} label="Copy link" className="h-8 px-2.5 text-xs" />
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
