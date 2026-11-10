"use client";

import Link from "next/link";
import { ArrowRight, CreditCard, Link2, Plus, Undo2, UserPlus } from "lucide-react";
import { useGatewayOverview, useLinks, usePayments } from "@/lib/gateway-queries";
import { useAccess } from "@/lib/session";
import { useBlocked24h } from "@/components/app/nav-badges";
import { formatInt } from "@/lib/format";
import { ApiError } from "@/lib/http";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { DayBars } from "./day-bars";
import { PaymentRow } from "./payment-row";

/** Payment volume, last 30 days; hidden when the server runs without payments. */
export function GatewayOverviewCard() {
  const q = useGatewayOverview();
  // Hidden only when the node has no gateway routes; an unknown merchant id is a real error worth showing.
  if (q.isError && q.error instanceof ApiError && q.error.code !== "UNKNOWN_MERCHANT" && (q.error.status === 404 || q.error.code === "GATEWAY_DISABLED")) return null;
  return (
    <Panel
      title="Payments, last 30 days"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/payments">
            Payments <ArrowRight />
          </Link>
        </Button>
      }
    >
      {q.isPending ? (
        <BlockSkeleton className="h-28" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-3">
            <div>
              <dt className="text-xs text-muted-foreground">Volume</dt>
              <dd className="mt-0.5 font-semibold"><Money atomic={q.data.volume} /></dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Payments</dt>
              <dd className="num mt-0.5 font-semibold">{formatInt(q.data.payments)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Conversion</dt>
              <dd className="num mt-0.5 font-semibold">{Math.round(q.data.conversion * 100)}%</dd>
            </div>
          </dl>
          <DayBars className="mt-4 h-12" days={q.data.days.map((d) => ({ day: d.day, value: d.volume }))} label="Payment volume per day for the last 30 days" />
        </>
      )}
    </Panel>
  );
}

/** Home for a business (Admin, Staff or Viewer, or a platform role inside one business): its payments at a glance. */
export function GatewayHome() {
  const q = useGatewayOverview();
  const recent = usePayments({ limit: 8 });
  const links = useLinks();
  const access = useAccess();
  const blocked = useBlocked24h();
  const view = access.view;
  const membership = view?.kind === "business" ? access.session.memberships.find((m) => m.merchantId === view.merchantId) : undefined;
  const readOnly = !access.can("links.write");
  const activeLinks = (links.data ?? []).filter((l) => l.active && !(l as { expired?: boolean }).expired).length;
  return (
    <>
      <PageHeader
        title={membership ? membership.name : "Home"}
        description={readOnly ? "Your payments over the last 30 days. You can view everything here; an Admin makes changes." : "Your payments over the last 30 days. The hub credits each payment to your payout account as it lands."}
        actions={
          access.can("links.write") && (
            <Button asChild>
              <Link href="/links/new">
                <Plus /> New payment link
              </Link>
            </Button>
          )
        }
      />
      {q.isPending ? (
        <BlockSkeleton className="h-[5.75rem]" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <StatStrip
          stats={[
            { label: "Received, 30 days", value: <Money atomic={q.data.volume} /> },
            { label: "Payments", value: <span className="num">{formatInt(q.data.payments)}</span>, note: `${Math.round(q.data.conversion * 100)}% of finished checkouts paid` },
            { label: "Active payment links", value: <span className="num">{formatInt(activeLinks)}</span>, note: links.data ? `${links.data.length} in total` : undefined },
            { label: "Blocked, last 24h", value: <span className="num">{formatInt(blocked)}</span>, note: blocked > 0 ? "refused, no money moved" : "nothing refused", tone: blocked > 0 ? "negative" : undefined },
          ]}
        />
      )}
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel
          title="Recent payments"
          bodyClassName="p-0 sm:p-0"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/payments">
                All payments <ArrowRight />
              </Link>
            </Button>
          }
        >
          {recent.isPending ? (
            <RowsSkeleton className="px-5" rows={5} />
          ) : recent.isError ? (
            <ErrorState className="m-4" error={recent.error} />
          ) : recent.data.items.length === 0 ? (
            <EmptyState icon={<CreditCard className="size-4" />} title="No payments yet" action={access.can("links.write") ? <Button asChild size="sm"><Link href="/links/new">Create a payment link</Link></Button> : undefined}>
              Share a payment link and payments show up here the moment they arrive.
            </EmptyState>
          ) : (
            <ul className="stagger divide-y">
              {recent.data.items.map((p) => (
                <PaymentRow key={p.id} p={p} />
              ))}
            </ul>
          )}
        </Panel>
        <div className="flex min-w-0 flex-col gap-5">
          {q.data && (
            <Panel title="Daily volume">
              <DayBars className="h-16" days={q.data.days.map((d) => ({ day: d.day, value: d.volume }))} label="Payment volume per day for the last 30 days" />
            </Panel>
          )}
          <Panel title="Quick actions">
            <div className="flex flex-col gap-2">
              {access.can("links.write") && <QuickAction href="/links/new" icon={<Link2 className="size-4" />} label="New payment link" hint="A link anyone can pay, people or AI agents" />}
              <QuickAction href="/payments" icon={<CreditCard className="size-4" />} label="Find a payment" hint="Search by email, amount or wallet" />
              {access.can("refunds.request") && <QuickAction href="/payments?tab=paid" icon={<Undo2 className="size-4" />} label={access.can("refunds.issue") ? "Issue a refund" : "Request a refund"} hint="Open a paid payment, then Refund" />}
              {access.can("members.manage") && <QuickAction href="/settings/team" icon={<UserPlus className="size-4" />} label="Invite a teammate" hint="Admin, Staff or Viewer" />}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function QuickAction({ href, icon, label, hint }: { href: string; icon: React.ReactNode; label: string; hint: string }) {
  return (
    <Link href={href} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-muted/50">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <ArrowRight className="size-4 text-subtle transition-transform duration-150 ease-out group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}
