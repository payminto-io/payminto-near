"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CreditCard, Link2, Search } from "lucide-react";
import { useLinks, usePayments } from "@/lib/gateway-queries";
import { TAB_LABELS, TAB_STATUSES, tabCounts } from "@/lib/gateway";
import { plural } from "@/lib/format";
import { PAYMENT_TABS, type PaymentTab } from "@/lib/schemas";
import type { PaymentsQuery } from "@/lib/gateway-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { CountTabs, ListHead } from "@/components/gateway/kit";
import { PAYMENT_COLS as COLS, PAYMENT_COLS_BUSINESS, PaymentRow } from "@/components/gateway/payment-row";
import { AGENT_METHODS, BusinessFilter, useBusinessNames } from "@/components/gateway/business-filter";
import { ReportButton } from "@/components/gateway/report-dialog";
import { useCan } from "@/lib/session";


export default function PaymentsPage() {
  return (
    <Suspense>
      <Payments />
    </Suspense>
  );
}

function Payments() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (PAYMENT_TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as PaymentTab) : "all";
  const [text, setText] = useState(params.get("q") ?? "");
  const linkId = params.get("link") ?? "";
  const q = params.get("q") ?? "";
  const links = useLinks();
  const can = useCan();
  const agentOnly = params.get("method") === "agent";
  const business = params.get("business");
  const { platformView, nameOf } = useBusinessNames();

  const query = useMemo<PaymentsQuery>(
    () => ({
      ...(tab === "refunded" ? { refunded: true } : tab === "all" ? {} : { status: TAB_STATUSES[tab] }),
      ...(linkId ? { link_id: linkId } : {}),
      ...(q ? { q } : {}),
      ...(agentOnly ? { method: [...AGENT_METHODS] } : {}),
      ...(business && platformView ? { merchant_id: business } : {}),
      limit: 50,
    }),
    [tab, linkId, q, agentOnly, business, platformView],
  );
  const payments = usePayments(query);
  const items = payments.data?.items ?? [];
  const counts = payments.data?.counts ? tabCounts(payments.data.counts) : null;

  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.replace(`/payments${sp.size ? `?${sp}` : ""}`, { scroll: false });
  };

  return (
    <>
      <PageHeader
        title={agentOnly ? "Agent payments" : "Payments"}
        description={
          agentOnly
            ? "Payments made by AI agents, automatically or from a budget."
            : platformView
              ? "Every payment to every business on this server. The hub credits each business's own payout account."
              : "Every checkout, link and API payment. The hub credits your payout account; Payminto keeps the records."
        }
        actions={
          <>
            {/* The report is one business's: on the platform view, once a business is picked in the filter. */}
            {(!platformView || business) && <ReportButton merchantId={platformView ? business : null} />}
            {can("links.write") && !platformView && (
              <Button asChild>
                <Link href="/links/new">
                  <Link2 /> New payment link
                </Link>
              </Button>
            )}
          </>
        }
      />
      <CountTabs label="Filter by status" value={tab} onChange={(k) => set({ tab: k === "all" ? null : k })} tabs={PAYMENT_TABS.map((k) => ({ key: k, label: TAB_LABELS[k], count: counts?.[k] }))} />

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: text.trim() || null });
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input
            aria-label="Search payments"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text.trim() !== q && set({ q: text.trim() || null })}
            placeholder="Search payment ID, reference, email, payer or transaction"
            className="h-9 pl-9"
          />
        </div>
        <BusinessFilter value={business} onChange={(v) => set({ business: v })} />
        <Select value={linkId || "any"} onValueChange={(v) => set({ link: v === "any" ? null : v })}>
          <SelectTrigger aria-label="Filter by payment link" className="h-9 w-full sm:w-56">
            <SelectValue placeholder="Any link" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any link or API</SelectItem>
            {(links.data ?? []).map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </form>

      <Panel className="mt-4" bodyClassName="p-0 sm:p-0">
        {payments.isPending ? (
          <RowsSkeleton className="px-5" rows={8} />
        ) : payments.isError ? (
          <ErrorState className="m-4" error={payments.error} onRetry={() => void payments.refetch()} />
        ) : items.length === 0 ? (
          q || linkId || business || agentOnly || tab !== "all" ? (
            <EmptyState icon={<Search className="size-4" />} title="No payments match" action={<Button variant="outline" onClick={() => (setText(""), set({ q: null, link: null, tab: null, business: null, method: null }))}>Clear filters</Button>}>
              {agentOnly ? "No AI agent has paid yet with these filters." : "Try another status, link or search."}
            </EmptyState>
          ) : (
            <EmptyState icon={<CreditCard className="size-4" />} title="No payments yet" action={can("links.write") ? <Button asChild><Link href="/links/new">Create a payment link</Link></Button> : undefined}>
              Share a link and the first payment shows up here as it happens.
            </EmptyState>
          )
        ) : (
          <>
            <ListHead cols={platformView ? PAYMENT_COLS_BUSINESS : COLS}>
              <span className="text-right">Amount</span>
              <span>Status</span>
              <span>Description</span>
              {platformView && <span>Business</span>}
              <span>Payer</span>
              <span className="text-right">Created</span>
            </ListHead>
            <ul className="stagger divide-y">
              {items.map((p) => (
                <PaymentRow key={p.id} p={p} linkTitle={links.data?.find((l) => l.id === p.link_id)?.title} business={platformView ? nameOf(p.merchant_id) : undefined} />
              ))}
            </ul>
            <p className="border-t px-5 py-3 text-xs text-muted-foreground">
              Showing {items.length}
              {payments.data.nextCursor ? " most recent" : ""} {plural(items.length, "payment")}
            </p>
          </>
        )}
      </Panel>
    </>
  );
}
