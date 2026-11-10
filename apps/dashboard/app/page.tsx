"use client";

import { TimeAgo, useNow } from "@/components/app/time-ago";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2, Check, ChevronRight, FileSignature, Layers, Plus, Radio, ShieldBan, ShieldCheck, UserPlus, Waypoints } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBatches, useCalls, useDenials, useDirectory, useBudgets, useNettingPreview, useOverview, useProviders, useToken } from "@/lib/queries";
import { formatInt, formatMoney, formatRatio, plural, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Batch, Call, Denial } from "@/lib/schemas";
import { axisTick, chartColor } from "@/lib/chart-theme";
import { bucketCalls } from "@/lib/calls-chart";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip, RuleChip } from "@/components/app/status";
import { DenialItem } from "@/components/app/denial";
import { RULE_INFO, refusalOf } from "@/lib/denials";
import { OperatorWarnings } from "@/components/app/operator-warnings";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccess } from "@/lib/session";
import { useMerchants, usePlatform } from "@/lib/operator-queries";
import { useBlocked24h } from "@/components/app/nav-badges";
import { Chip } from "@/components/app/status";
import { GatewayHome } from "@/components/gateway/overview-card";

export default function HomePage() {
  const access = useAccess();
  if (access.platformView) return <PlatformHome />;
  return <GatewayHome />;
}

/** Platform view: businesses, money and what needs attention, then the agents area for platform roles. */
function PlatformHome() {
  const access = useAccess();
  const merchants = useMerchants();
  const platform = usePlatform();
  const blocked = useBlocked24h();
  const agents = access.can("agents.read");
  const batches = useBatches();
  const list = merchants.data ?? [];
  const active = list.filter((m) => m.status === "active").length;
  const volume = list.reduce((a, m) => a + BigInt(m.volume_30d ?? "0"), 0n).toString();
  const payments = list.reduce((a, m) => a + (m.payments_30d ?? 0), 0);
  const confirmed = (batches.data ?? []).filter((b) => b.status === "confirmed");
  const lastSettled = confirmed.reduce<string | null>((a, b) => {
    const at = b.confirmedAt ?? b.createdAt;
    return !a || at > a ? at : a;
  }, null);
  const firstRun = merchants.data !== undefined && platform.data !== undefined && list.length === 0;
  const name = access.session.user?.name?.split(" ")[0];
  return (
    <>
      <PageHeader
        title={name ? `Welcome back, ${name}` : "Home"}
        description="Every business on this server at a glance. Funds are escrowed in an unaudited contract on NEAR."
        actions={
          access.can("businesses.manage") && (
            <Button asChild>
              <Link href="/platform/businesses/new">
                <Plus /> Add business
              </Link>
            </Button>
          )
        }
      />
      <OperatorWarnings className="mb-5" />
      {firstRun && <SetupChecklist hasBusiness={list.length > 0} />}
      {merchants.isPending ? (
        <Skeleton className="h-[5.75rem] w-full rounded-xl" />
      ) : (
        <StatStrip
          stats={[
            { label: "Active businesses", value: <span className="num">{formatInt(active)}</span>, note: list.length > active ? `${list.length - active} suspended` : "all active" },
            { label: "Volume, 30 days", value: <Money atomic={volume} />, note: `${formatInt(payments)} ${plural(payments, "payment")}` },
            ...(agents
              ? [
                  {
                    label: "Settlements on NEAR",
                    value: <span className="num">{batches.data ? formatInt(confirmed.length) : "-"}</span>,
                    note: lastSettled ? <>last <TimeAgo iso={lastSettled} /></> : "none final yet",
                  },
                ]
              : []),
            { label: "Blocked, last 24h", value: <span className={cn("num", blocked > 0 && "text-negative")}>{formatInt(blocked)}</span>, note: blocked > 0 ? "refused, no money moved" : "nothing refused", tone: blocked > 0 ? ("negative" as const) : undefined },
          ]}
        />
      )}
      {list.length > 0 && <BusinessesCard />}
      {agents && <AgentsOverview />}
    </>
  );
}

/** First run (PRODUCT.md section 4.2): the three things a new platform owner does. */
function SetupChecklist({ hasBusiness }: { hasBusiness: boolean }) {
  const access = useAccess();
  const steps = [
    { icon: Building2, title: "Add your first business", body: "Each business gets its own payment links, checkout page and payout wallet. You can also run this server for your own business.", done: hasBusiness, href: "/platform/businesses/new", label: "Add business", show: access.can("businesses.manage") },
    { icon: UserPlus, title: "Invite your team", body: "Add platform admins who help you manage businesses. They cannot remove you or change who runs this server.", done: false, href: "/platform/team", label: "Invite teammates", show: access.can("team.read") },
  ].filter((s) => s.show);
  return (
    <section aria-labelledby="first-run" className="mb-5 rounded-xl border bg-card">
      <div className="border-b px-5 py-5 sm:px-6">
        <h2 id="first-run" className="text-lg font-semibold tracking-[-0.01em]">
          Set up your platform
        </h2>
        <p className="mt-1 max-w-[64ch] text-sm text-muted-foreground">Your server takes payments as soon as a business is added. Payminto charges no processing fee.</p>
      </div>
      <ol className={cn("stagger grid divide-y md:divide-x md:divide-y-0", steps.length > 1 && "md:grid-cols-2")}>
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-3 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <span className={cn("num flex size-7 items-center justify-center rounded-full text-sm font-semibold", s.done ? "bg-positive-soft text-positive" : "bg-accent text-accent-foreground")}>{s.done ? <Check className="size-4" aria-label="Done" /> : i + 1}</span>
              <s.icon className="size-4 text-muted-foreground" aria-hidden />
            </div>
            <h3 className={cn("font-medium", s.done && "text-muted-foreground line-through decoration-1")}>{s.title}</h3>
            <p className="text-sm text-muted-foreground">{s.body}</p>
            <div className="mt-auto pt-1">
              <Button asChild variant={!s.done && i === steps.findIndex((x) => !x.done) ? "default" : "outline"} size="sm">
                <Link href={s.href}>{s.label}</Link>
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function BusinessesCard() {
  const merchants = useMerchants();
  const list = [...(merchants.data ?? [])].sort((a, b) => Number(BigInt(b.volume_30d ?? "0") - BigInt(a.volume_30d ?? "0"))).slice(0, 6);
  return (
    <Panel
      className="mt-5"
      title="Businesses"
      description="By volume over the last 30 days"
      bodyClassName="p-0 sm:p-0"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/platform/businesses">
            All businesses <ArrowRight />
          </Link>
        </Button>
      }
    >
      <ul className="stagger divide-y">
        {list.map((m) => (
          <li key={m.id}>
            <Link
              href={`/platform/businesses/${m.id}`}
              className="group flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none sm:px-5"
            >
              <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: m.brand_color ?? "var(--primary)" }}>
                {m.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium group-hover:underline">{m.name}</span>
              {m.status === "suspended" && <Chip tone="warning">Suspended</Chip>}
              <span className="text-muted-foreground">{m.volume_30d ? <Money atomic={m.volume_30d} size="sm" /> : "-"}</span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The agents area on Home: AI agents paying per charge, bundled into settlements. */
function AgentsOverview() {
  const overview = useOverview();
  const budgets = useBudgets();
  const providers = useProviders();
  const access = useAccess();

  if (overview.isError) return <ErrorState className="mt-5" error={overview.error} onRetry={() => void overview.refetch()} />;

  // The guide is for an empty server. A server with budgets already open shows the live area at zero, so the first
  // charges fill it in place instead of swapping the whole section.
  const firstRun = overview.data && overview.data.calls.all === 0 && overview.data.batches === 0 && budgets.data !== undefined && budgets.data.length === 0;

  return (
    <section aria-labelledby="agents-title" className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="agents-title" className="text-[1.0625rem] font-semibold tracking-[-0.01em]">
            AI agents
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Agents pay per Call from a Budget with hard limits. Payminto clears the Calls in a few settlement batches, and each Call can still be proven on chain.</p>
        </div>
        {!firstRun && access.can("agents.read") && (
          <Button asChild variant="outline" size="sm">
            <Link href="/netting">
              <Waypoints /> Next settlement
            </Link>
          </Button>
        )}
      </div>
      {overview.isPending || (overview.data?.calls.all === 0 && budgets.isPending) ? (
        <Skeleton className="h-[5.75rem] w-full rounded-xl" />
      ) : firstRun ? (
        <FirstRun hasBudgets={(budgets.data?.length ?? 0) > 0} hasProviders={(providers.data?.length ?? 0) > 0} />
      ) : (
        <>
          <Kpis />
          <SellerSettledLine />
        </>
      )}
      {!firstRun && (
        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <CallsChart />
            <LiveStream />
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <PendingCard />
            <BlockedCard />
            <Timeline />
          </div>
        </div>
      )}
    </section>
  );
}

function Kpis() {
  const { data } = useOverview();
  const preview = useNettingPreview();
  const blocked = useBlocked24h();
  if (!data) return null;
  // Before the first batch the measured figures are zero; show what the pending calls will net to instead.
  const projected = data.batches === 0 && (preview.data?.calls ?? 0) > 0 ? preview.data!.compression : null;
  return (
    <StatStrip
      stats={[
        { label: "Settled by agents", value: <Money atomic={data.volume.settled} />, note: <>Waiting <Money atomic={data.volume.pending} /></> },
        { label: "Calls, last 24h", value: <span className="num">{formatInt(data.calls.last24h)}</span>, note: `${formatInt(data.calls.all)} all time` },
        projected !== null
          ? { label: "Calls per transfer", value: <span className="num">{formatRatio(projected)}</span>, note: "expected in the next settlement" }
          : data.batches === 0
            ? { label: "Calls per transfer", value: <span className="text-muted-foreground">-</span>, note: "measured at settlement" }
            : { label: "Calls per transfer", value: <span className="num">{formatRatio(data.compressionRatio)}</span>, note: "on average" },
        data.settled && BigInt(data.settled.gross) > 0n
          ? { label: "Tokens moved", value: <Money atomic={data.settled.net} />, note: <>for <Money atomic={data.settled.gross} /> gross cleared</> }
          : { label: "Tokens moved", value: <span className="text-muted-foreground">-</span>, note: "measured at settlement" },
        {
          label: "Refused, last 24h",
          value: <span className={cn("num", blocked > 0 && "text-negative")}>{formatInt(blocked)}</span>,
          note: blocked > 0 ? "no money moved" : "every Call passed",
        },
        { label: "Active Budgets", value: <span className="num">{formatInt(data.activeBudgets)}</span>, note: `${data.providers} ${plural(data.providers, "Payee")} on this server` },
      ]}
    />
  );
}

/**
 * What sellers settled themselves on the hub, next to the batch totals above. These Calls are in no settlement batch, so
 * nothing offsets and the gross amount is what the hub moved. Hidden until a seller has settled something.
 */
function SellerSettledLine() {
  const { data } = useOverview();
  const s = data?.settledBySeller;
  if (!s || (s.calls === 0 && s.settlements === 0 && BigInt(s.gross) === 0n)) return null;
  return (
    <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm sm:px-5">
      <span className="font-medium">Settled by sellers on the hub</span>
      <Money atomic={s.gross} />
      <span className="text-muted-foreground">
        in <span className="num">{formatInt(s.calls)}</span> {plural(s.calls, "Call")} across <span className="num">{formatInt(s.settlements)}</span> seller {plural(s.settlements, "settlement")}, outside any settlement batch. Nothing
        offsets there, so this is the amount the hub moved from escrow to the sellers&apos; hub credit.
      </span>
    </p>
  );
}

/** Teaches how agent payments work on a fresh server, with the next action for each step. */
function FirstRun({ hasBudgets, hasProviders }: { hasBudgets: boolean; hasProviders: boolean }) {
  const steps = [
    {
      icon: FileSignature,
      title: "An owner opens a Budget",
      body: "From their NEAR wallet, the owner gives an agent a Budget with hard limits (cap, limit per Call, daily limit, Calls per minute, allowed Payees, end date) and funds its escrow.",
      done: hasBudgets,
      action: { href: "/budgets/new", label: "New Budget" },
    },
    {
      icon: Radio,
      title: "The agent pays per Call",
      body: "Each paid Call carries a voucher the agent signs, with no network fee. Your server checks it against the Budget, books it and returns a signed receipt.",
      done: false,
      action: hasProviders ? { href: "/providers", label: "See paid services" } : { href: "/providers?register=1", label: "Add a paid service" },
    },
    {
      icon: Waypoints,
      title: "Calls settle in bundles",
      body: "Hundreds of Calls settle in one transaction on the hub. Every signature and limit is checked again on chain, and only each owner's net amount moves.",
      done: false,
      action: { href: "/netting", label: "Next settlement" },
    },
  ];
  return (
    <section aria-labelledby="first-run" className="rounded-xl border bg-card">
      <div className="border-b px-5 py-5 sm:px-6">
        <h2 id="first-run" className="text-lg font-semibold tracking-[-0.01em]">
          No agent Calls yet
        </h2>
        <p className="mt-1 max-w-[64ch] text-sm text-muted-foreground">
          Agent payments work in three steps. Funds are escrowed in an unaudited contract on NEAR that this server cannot move them out of.
        </p>
      </div>
      <ol className="grid divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-3 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="num flex size-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">{i + 1}</span>
              <s.icon className="size-4 text-muted-foreground" />
            </div>
            <h3 className="font-medium">{s.title}</h3>
            <p className="text-sm text-muted-foreground">{s.body}</p>
            <div className="mt-auto pt-1">
              <Button asChild variant={i === 0 && !s.done ? "default" : "outline"} size="sm">
                <Link href={s.action.href}>{s.action.label}</Link>
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CallsChart() {
  const calls = useCalls({ limit: 500 });
  const token = useToken();
  // Re-bucket every 5 s so the window keeps up with the clock without re-rendering the chart every second.
  const tick = Math.floor(useNow() / 5000);
  const { bars: data, unit, hourly } = useMemo(() => bucketCalls(calls.data?.items ?? [], (tick + 1) * 5000), [calls.data, tick]);

  return (
    <Panel title="Agent Calls" description={hourly ? "Accepted Calls per hour, last 12 hours" : `Accepted Calls per ${unit}`}>
      {calls.isPending ? (
        <BlockSkeleton className="h-48" />
      ) : calls.isError ? (
        <ErrorState error={calls.error} onRetry={() => void calls.refetch()} />
      ) : (
        <div className="h-48 w-full" role="img" aria-label={`Calls per ${unit}, peak ${Math.max(...data.map((d) => d.calls))}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: -18 }} barCategoryGap={3}>
              <CartesianGrid vertical={false} stroke={chartColor("grid")} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} interval="preserveStartEnd" minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} tick={axisTick} allowDecimals={false} width={44} />
              <Tooltip
                cursor={{ fill: chartColor("cursor") }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-sm">
                      <p className="font-medium">{p.label}</p>
                      <p className="num mt-0.5 text-muted-foreground">
                        {p.calls} {plural(p.calls, "Call")}, {formatMoney(p.volume, token.decimals)} {token.symbol}
                      </p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="calls" fill={chartColor("bar")} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

type StreamRow = { kind: "call"; at: string; call: Call } | { kind: "denial"; at: string; denial: Denial };

function LiveStream() {
  const calls = useCalls({ limit: 14 });
  const denials = useDenials();
  const dir = useDirectory();
  const rows = useMemo<StreamRow[]>(() => {
    const all: StreamRow[] = [
      ...(calls.data?.items ?? []).map((c) => ({ kind: "call" as const, at: c.createdAt, call: c })),
      ...(denials.data ?? []).slice(0, 6).map((d) => ({ kind: "denial" as const, at: d.createdAt, denial: d })),
    ];
    return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 14);
  }, [calls.data, denials.data]);
  const name = (a: string | null | undefined) => (a ? dir.lookup(a)?.name ?? shortAddress(a) : "Unknown");
  const fresh = useFreshIds(
    rows.map((r) => (r.kind === "call" ? r.call.id : r.denial.id)),
    Boolean(calls.data && denials.data),
  );

  return (
    <Panel
      title="Live Calls"
      description="Every Call your server accepted or refused"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/budgets">All budgets</Link>
        </Button>
      }
      bodyClassName="p-0 sm:p-0"
    >
      {calls.isPending ? (
        <RowsSkeleton className="px-5" rows={8} />
      ) : calls.isError ? (
        <ErrorState className="m-4" error={calls.error} onRetry={() => void calls.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Radio className="size-4" />} title="Waiting for the first Call">
          Charges appear here the moment an agent pays a service through this server.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {rows.map((r) =>
            r.kind === "call" ? (
              <li key={r.call.id} className={cn(fresh.has(r.call.id) && "row-in", "flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5")}>
                <span className="size-1.5 shrink-0 rounded-full bg-positive" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{name(r.call.agent)}</span>
                  <span className="text-subtle"> paid </span>
                  <span className="font-medium">{name(r.call.payee)}</span>
                </span>
                <Link href={`/receipts/${r.call.id}`} className="shrink-0 rounded hover:underline" aria-label="Verify this Call">
                  <Money atomic={r.call.amount} />
                </Link>
                <TimeAgo iso={r.at} className="num w-16 shrink-0 text-right text-xs text-subtle max-sm:hidden" />
              </li>
            ) : (
              <li key={r.denial.id} className={cn(fresh.has(r.denial.id) && "row-in", "flex items-center gap-3 bg-negative-soft/60 px-4 py-2.5 text-sm sm:px-5")}>
                <ShieldBan className="size-3.5 shrink-0 text-negative" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-negative">Blocked</span>
                  <span className="text-subtle"> </span>
                  <span className="font-medium">{name(r.denial.agent)}</span>
                  <span className="text-subtle"> to </span>
                  <span className="font-medium">{name(r.denial.payee)}</span>
                </span>
                <RuleChip rule={r.denial.rule} retry={refusalOf(r.denial).retry} />
                <TimeAgo iso={r.at} className="num w-16 shrink-0 text-right text-xs text-subtle max-sm:hidden" />
              </li>
            ),
          )}
        </ul>
      )}
    </Panel>
  );
}

function PendingCard() {
  const preview = useNettingPreview();
  const p = preview.data;
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">Waiting to settle</h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">Accepted Calls not yet in a settlement</p>
        </div>
        <Waypoints className="size-4 text-subtle" />
      </div>
      {preview.isPending ? (
        <Skeleton className="mt-4 h-16 w-full" />
      ) : !p || (p.calls ?? 0) === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Everything accepted so far is settled.</p>
      ) : (
        <>
          <p className="mt-4 text-[1.75rem] leading-none font-semibold tracking-[-0.02em]">
            <Money atomic={p.grossTotal ?? "0"} />
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="num">{formatInt(p.calls ?? 0)}</span> {plural(p.calls ?? 0, "Call")} bundle into <span className="num">{p.net.length}</span> {plural(p.net.length, "transfer")} moving{" "}
            <Money atomic={p.netTotal ?? "0"} className="text-foreground" />.
          </p>
          <Button asChild className="mt-4 w-full">
            <Link href="/netting">
              Review and settle <ArrowRight />
            </Link>
          </Button>
        </>
      )}
    </section>
  );
}

/** The latest refusal, stated as an outcome: what was tried, which rule stopped it, and that nothing moved. */
function BlockedCard() {
  const denials = useDenials();
  // Lead with the most recent attack when there is one; an honest agent hitting a cap is less telling.
  const latest = denials.data?.find((d) => RULE_INFO[d.rule]?.kind === "attack") ?? denials.data?.[0];
  const n24 = useBlocked24h();
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="blocked-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="blocked-title" className="text-[0.9375rem] font-semibold">
            Refused Calls
          </h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">Stopped by a Budget rule before any money moved</p>
        </div>
        <span className={cn("num text-[1.75rem] leading-none font-semibold tracking-[-0.02em]", n24 > 0 ? "text-negative" : "text-muted-foreground")}>
          {formatInt(n24)}
          <span className="sr-only"> blocked in the last 24 hours</span>
        </span>
      </div>
      {denials.isPending ? (
        <Skeleton className="mt-4 h-20 w-full" />
      ) : !latest ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 text-positive" /> Every Call so far stayed inside its Budget.
        </p>
      ) : (
        <>
          <DenialItem as="div" denial={latest} className="mt-4 rounded-lg border px-3.5 sm:px-3.5" />
          <Button asChild variant="outline" className="mt-3 w-full">
            <Link href="/blocked">
              See all Refusals <ArrowRight />
            </Link>
          </Button>
        </>
      )}
    </section>
  );
}

function Timeline() {
  const batches = useBatches();
  return (
    <Panel
      title="Settlement timeline"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/batches">All settlements</Link>
        </Button>
      }
    >
      {batches.isPending ? (
        <RowsSkeleton rows={3} />
      ) : batches.isError ? (
        <ErrorState error={batches.error} onRetry={() => void batches.refetch()} />
      ) : batches.data.length === 0 ? (
        <EmptyState icon={<Layers className="size-4" />} title="No settlements yet" className="py-6">
          The first settlement appears here with its transaction and how many charges it bundled.
        </EmptyState>
      ) : (
        <ol className="relative">
          {batches.data.slice(0, 5).map((b, i, arr) => (
            <TimelineItem key={b.id} batch={b} last={i === arr.length - 1} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function TimelineItem({ batch, last }: { batch: Batch; last: boolean }) {
  const ratio = batch.transfers ? batch.calls / batch.transfers : 0;
  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[0.6875rem] w-px bg-border" />}
      <span
        className={cn(
          "relative mt-0.5 flex size-[1.375rem] shrink-0 items-center justify-center rounded-full border-2 bg-card",
          batch.status === "confirmed" ? "border-positive" : batch.status === "failed" ? "border-negative" : "border-primary",
        )}
        aria-hidden
      >
        <span className={cn("size-1.5 rounded-full", batch.status === "confirmed" ? "bg-positive" : batch.status === "failed" ? "bg-negative" : "bg-primary")} />
      </span>
      <Link href={`/batches/${batch.id}`} className="-m-1.5 min-w-0 flex-1 rounded-md p-1.5 hover:bg-muted/60">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Settlement #{batch.seq}</span>
          <BatchStatusChip status={batch.status} />
        </div>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          <span className="num">{formatInt(batch.calls)}</span> {plural(batch.calls, "Call")}, <Money atomic={batch.gross} /> in total, {batch.transfers} {plural(batch.transfers, "transfer")}
        </p>
        <p className="mt-0.5 text-xs text-subtle">
          <span className="num">{formatRatio(ratio)}</span> {plural(ratio, "Call")} per transfer, <TimeAgo iso={batch.confirmedAt ?? batch.createdAt} />
        </p>
      </Link>
    </li>
  );
}


/** Ids that arrived after the stream first rendered, so only genuinely new rows get the arrival highlight. */
function useFreshIds(ids: string[], ready: boolean): Set<string> {
  const [initial, setInitial] = useState<Set<string> | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- snapshot of the rows already on screen at first paint
    if (ready && !initial) setInitial(new Set(ids));
  }, [ready, initial, ids]);
  return useMemo(() => (initial ? new Set(ids.filter((id) => !initial.has(id))) : new Set<string>()), [initial, ids]);
}
