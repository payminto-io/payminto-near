"use client";

import { TimeAgo, useNow } from "@/components/app/time-ago";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2, Check, FileSignature, Layers, Plus, Radio, ShieldBan, ShieldCheck, UserPlus, Wallet, Waypoints } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBatches, useCalls, useDenials, useDirectory, useMandates, useNettingPreview, useOverview, useProviders, useToken } from "@/lib/queries";
import { formatInt, formatMoney, formatRatio, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Batch, Call, Denial } from "@/lib/schemas";
import { axisTick, chartColor } from "@/lib/chart-theme";
import { bucketCalls } from "@/lib/calls-chart";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip, RuleChip, RuleKindChip } from "@/components/app/status";
import { NoMoneyMoved } from "@/components/app/denial";
import { RULE_INFO, ruleDescription, ruleTitle } from "@/lib/denials";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccess } from "@/lib/session";
import { useMerchants, usePlatform, usePlatformFees } from "@/lib/operator-queries";
import { useBlocked24h } from "@/components/app/nav-badges";
import { useSwitchView } from "@/components/app/account-switcher";
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
  const fees = usePlatformFees();
  const blocked = useBlocked24h();
  const agents = access.can("agents.read");
  const list = merchants.data ?? [];
  const active = list.filter((m) => m.status === "active").length;
  const volume = fees.data?.volume ?? list.reduce((a, m) => a + BigInt(m.volume_30d ?? "0"), 0n).toString();
  const payments = fees.data?.payments ?? list.reduce((a, m) => a + (m.payments_30d ?? 0), 0);
  const firstRun = merchants.data !== undefined && platform.data !== undefined && (list.length === 0 || !platform.data.fee_recipient);
  const name = access.session.user?.name?.split(" ")[0];
  return (
    <>
      <PageHeader
        title={name ? `Welcome back, ${name}` : "Home"}
        description="Every business on this server at a glance. Money goes straight to each business's own wallet; this server never holds it."
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
      {firstRun && <SetupChecklist hasBusiness={list.length > 0} hasFeeWallet={Boolean(platform.data?.fee_recipient)} />}
      {merchants.isPending ? (
        <Skeleton className="h-[5.75rem] w-full rounded-xl" />
      ) : (
        <StatStrip
          stats={[
            { label: "Active businesses", value: <span className="num">{formatInt(active)}</span>, note: list.length > active ? `${list.length - active} suspended` : "all active" },
            { label: "Volume, 30 days", value: <Money atomic={volume} maxFraction={2} />, note: `${formatInt(payments)} ${plural(payments, "payment")}` },
            ...(access.can("earnings.read") ? [{ label: "Platform earnings, 30 days", value: <Money atomic={fees.data?.total ?? "0"} maxFraction={2} />, note: "your fee from every payment" }] : []),
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
function SetupChecklist({ hasBusiness, hasFeeWallet }: { hasBusiness: boolean; hasFeeWallet: boolean }) {
  const access = useAccess();
  const steps = [
    { icon: Building2, title: "Add your first business", body: "Each business gets its own payment links, checkout page and payout wallet. You can also run this server for your own business.", done: hasBusiness, href: "/platform/businesses/new", label: "Add business", show: access.can("businesses.manage") },
    { icon: Wallet, title: "Set the platform fee wallet", body: "Where your platform fee arrives. It is set on the server (PLATFORM_FEE_ADDRESS) so nobody can redirect it from the dashboard.", done: hasFeeWallet, href: "/settings/platform", label: "Open platform settings", show: access.can("platform.read") },
    { icon: UserPlus, title: "Invite your team", body: "Add platform admins who help you manage businesses. They cannot change pricing or the fee wallet.", done: false, href: "/platform/team", label: "Invite teammates", show: access.can("team.read") },
  ].filter((s) => s.show);
  return (
    <section aria-labelledby="first-run" className="mb-5 rounded-xl border bg-card">
      <div className="border-b px-5 py-5 sm:px-6">
        <h2 id="first-run" className="text-lg font-semibold tracking-[-0.01em]">
          Set up your platform
        </h2>
        <p className="mt-1 max-w-[64ch] text-sm text-muted-foreground">Three steps and your server is ready to take payments for businesses.</p>
      </div>
      <ol className="stagger grid divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
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
  const switchView = useSwitchView();
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
          <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: m.brand_color ?? "var(--primary)" }}>
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <Link href={`/platform/businesses/${m.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
              {m.name}
            </Link>
            {m.status === "suspended" && <Chip tone="warning">Suspended</Chip>}
            <span className="num text-muted-foreground max-sm:hidden">{m.volume_30d ? <Money atomic={m.volume_30d} maxFraction={2} /> : "-"}</span>
            <Button variant="ghost" size="sm" onClick={() => switchView({ kind: "business", merchantId: m.id })}>
              Open
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The agents area on Home: AI agents paying per charge, bundled into settlements. */
function AgentsOverview() {
  const overview = useOverview();
  const mandates = useMandates();
  const providers = useProviders();
  const access = useAccess();

  if (overview.isError) return <ErrorState className="mt-5" error={overview.error} onRetry={() => void overview.refetch()} />;

  // The guide is for an empty server. A server with budgets already open shows the live area at zero, so the first
  // charges fill it in place instead of swapping the whole section.
  const firstRun = overview.data && overview.data.calls.all === 0 && overview.data.batches === 0 && mandates.data !== undefined && mandates.data.length === 0;

  return (
    <section aria-labelledby="agents-title" className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="agents-title" className="text-[1.0625rem] font-semibold tracking-[-0.01em]">
            AI agents
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Agents pay per charge from a budget with hard limits. Payminto bundles the charges into a few settlements, and each one can still be checked on chain.</p>
        </div>
        {!firstRun && access.can("agents.read") && (
          <Button asChild variant="outline" size="sm">
            <Link href="/netting">
              <Waypoints /> Next settlement
            </Link>
          </Button>
        )}
      </div>
      {overview.isPending || (overview.data?.calls.all === 0 && mandates.isPending) ? (
        <Skeleton className="h-[5.75rem] w-full rounded-xl" />
      ) : firstRun ? (
        <FirstRun hasMandates={(mandates.data?.length ?? 0) > 0} hasProviders={(providers.data?.length ?? 0) > 0} />
      ) : (
        <Kpis />
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
        { label: "Settled by agents", value: <Money atomic={data.volume.settled} maxFraction={2} />, note: <>Waiting <Money atomic={data.volume.pending} maxFraction={4} /></> },
        { label: "Charges, last 24h", value: <span className="num">{formatInt(data.calls.last24h)}</span>, note: `${formatInt(data.calls.all)} all time` },
        projected !== null
          ? { label: "Charges per transfer", value: <span className="num">{formatRatio(projected)}</span>, note: "expected in the next settlement" }
          : data.batches === 0
            ? { label: "Charges per transfer", value: <span className="text-muted-foreground">-</span>, note: "measured at settlement" }
            : { label: "Charges per transfer", value: <span className="num">{formatRatio(data.compressionRatio)}</span>, note: "on average, per transfer" },
        data.batches === 0
          ? { label: "Network fee saved", value: <span className="text-muted-foreground">-</span>, note: "measured at settlement" }
          : { label: "Network fee saved", value: <span className="num">{data.compressionRatio > 1 ? Math.round((1 - 1 / data.compressionRatio) * 100) : 0}%</span>, note: "vs one transfer per charge" },
        {
          label: "Blocked, last 24h",
          value: <span className={cn("num", blocked > 0 && "text-negative")}>{formatInt(blocked)}</span>,
          note: blocked > 0 ? "refused, no money moved" : "every charge passed",
        },
        { label: "Active budgets", value: <span className="num">{formatInt(data.activeMandates)}</span>, note: `${data.providers} paid ${plural(data.providers, "service")}` },
      ]}
    />
  );
}

/** Teaches how agent payments work on a fresh server, with the next action for each step. */
function FirstRun({ hasMandates, hasProviders }: { hasMandates: boolean; hasProviders: boolean }) {
  const steps = [
    {
      icon: FileSignature,
      title: "An owner sets a budget",
      body: "One signature gives an AI agent a budget with hard limits: total limit, limit per charge, daily limit, charges per minute, allowed services and an end date.",
      done: hasMandates,
      action: { href: "/mandates/new", label: "New budget" },
    },
    {
      icon: Radio,
      title: "The agent pays per charge",
      body: "Each paid call carries a signed charge with no network fee. Your server checks it against the budget, books it and returns a signed receipt.",
      done: false,
      action: hasProviders ? { href: "/providers", label: "See paid services" } : { href: "/providers?register=1", label: "Add a paid service" },
    },
    {
      icon: Waypoints,
      title: "Charges settle in bundles",
      body: "Hundreds of charges settle in one transaction. Every signature and limit is checked again on chain, and only the difference moves, wallet to wallet.",
      done: false,
      action: { href: "/netting", label: "Next settlement" },
    },
  ];
  return (
    <section aria-labelledby="first-run" className="rounded-xl border bg-card">
      <div className="border-b px-5 py-5 sm:px-6">
        <h2 id="first-run" className="text-lg font-semibold tracking-[-0.01em]">
          No agent charges yet
        </h2>
        <p className="mt-1 max-w-[64ch] text-sm text-muted-foreground">
          Agent payments work in three steps. Nobody, including this server, ever holds the money: agents pay services directly when a settlement runs.
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
    <Panel title="Agent charges" description={hourly ? "Accepted charges per hour, last 12 hours" : `Accepted charges per ${unit}`}>
      {calls.isPending ? (
        <BlockSkeleton className="h-48" />
      ) : calls.isError ? (
        <ErrorState error={calls.error} onRetry={() => void calls.refetch()} />
      ) : (
        <div className="h-48 w-full" role="img" aria-label={`Charges per ${unit}, peak ${Math.max(...data.map((d) => d.calls))}`}>
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
                        {p.calls} {plural(p.calls, "charge")}, {formatMoney(p.volume, token.decimals, { maxFraction: 4 })} {token.symbol}
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
  const name = (a: string | null | undefined) => (a ? dir.lookup(a)?.name ?? `${a.slice(0, 8)}…` : "Unknown");
  const fresh = useFreshIds(
    rows.map((r) => (r.kind === "call" ? r.call.id : r.denial.id)),
    Boolean(calls.data && denials.data),
  );

  return (
    <Panel
      title="Live charges"
      description="Every charge your server accepted or refused"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/mandates">All budgets</Link>
        </Button>
      }
      bodyClassName="p-0 sm:p-0"
    >
      {calls.isPending ? (
        <RowsSkeleton className="px-5" rows={8} />
      ) : calls.isError ? (
        <ErrorState className="m-4" error={calls.error} onRetry={() => void calls.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Radio className="size-4" />} title="Waiting for the first charge">
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
                <Link href={`/receipts/${r.call.id}`} className="shrink-0 rounded hover:underline" aria-label="Verify this charge">
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
                <RuleChip rule={r.denial.rule} />
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
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">Accepted charges not yet in a settlement</p>
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
            <Money atomic={p.grossTotal ?? "0"} maxFraction={4} />
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="num">{formatInt(p.calls ?? 0)}</span> {plural(p.calls ?? 0, "charge")} bundle into <span className="num">{p.net.length}</span> {plural(p.net.length, "transfer")} moving{" "}
            <Money atomic={p.netTotal ?? "0"} maxFraction={4} className="text-foreground" />.
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
  const dir = useDirectory();
  // Lead with the most recent attack when there is one; an honest agent hitting a cap is less telling.
  const latest = denials.data?.find((d) => RULE_INFO[d.rule]?.kind === "attack") ?? denials.data?.[0];
  const n24 = useBlocked24h();
  const name = (a: string | null | undefined) => (a ? dir.lookup(a)?.name ?? `${a.slice(0, 8)}…` : "an unknown wallet");
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="blocked-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="blocked-title" className="text-[0.9375rem] font-semibold">
            Attacks and overspending blocked
          </h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">Refused by budget limits and safety checks before any money moved</p>
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
          <ShieldCheck className="size-4 text-positive" /> Every charge so far stayed inside its budget.
        </p>
      ) : (
        <>
          <div className="mt-4 rounded-lg border border-negative/25 bg-negative-soft/60 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldBan className="size-4 text-negative" aria-hidden />
              <span className="text-sm font-medium">{ruleTitle(latest.rule)}</span>
              <RuleKindChip rule={latest.rule} />
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              <span className="text-foreground">{name(latest.agent)}</span> tried to pay <span className="text-foreground">{name(latest.payee)}</span>
              {latest.amount ? (
                <>
                  {" "}
                  <Money atomic={latest.amount} className="text-foreground" />
                </>
              ) : null}
              . {ruleDescription(latest.rule)}
            </p>
            <div className="mt-2 flex items-center justify-between gap-3">
              <NoMoneyMoved />
              <TimeAgo iso={latest.createdAt} className="num text-xs text-subtle" />
            </div>
          </div>
          <Button asChild variant="outline" className="mt-3 w-full">
            <Link href="/blocked">
              See all blocked attempts <ArrowRight />
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
          <span className="num">{formatInt(batch.calls)}</span> {plural(batch.calls, "charge")}, <Money atomic={batch.gross} maxFraction={4} /> in total, {batch.transfers} {plural(batch.transfers, "transfer")}
        </p>
        <p className="mt-0.5 text-xs text-subtle">
          <span className="num">{formatRatio(ratio)}</span> {plural(ratio, "charge")} per transfer, <TimeAgo iso={batch.confirmedAt ?? batch.createdAt} />
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
