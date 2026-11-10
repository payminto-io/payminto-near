"use client";

import { RequirePermission } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CalendarRange, Coins, Gauge, Loader2, PiggyBank, Radio, ServerOff, ShieldCheck, Store, type LucideIcon } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { useApi, useCan } from "@/lib/session";
import { qk, flattenCallPages, useCallPages, useInfo, useBudget, useToken, useDirectory } from "@/lib/queries";
import { formatDate, formatDateTime, formatInt, formatMoney, formatTime, percentOf } from "@/lib/format";
import { describeTimeLeft, spendableNow, validUntilSec } from "@/lib/spend";
import { graceAdjective, graceDuration } from "@/lib/grace";
import { useDocumentTitle } from "@/lib/use-title";
import { useNow } from "@/components/app/time-ago";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import type { BudgetDetail } from "@/lib/schemas";
import { axisTick, chartColor } from "@/lib/chart-theme";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Field, Fields, Hash, Meter, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BudgetStatusChip } from "@/components/app/status";
import { DenialItem } from "@/components/app/denial";
import { EscrowPanel, GaslessButton, StopBudgetButton, useDaoOwner } from "@/components/app/budget-actions";
import { DaoProposalsPanel } from "@/components/app/dao-proposals";
import { BudgetPayees, PayeeDecisionsPanel, WaitingPayees } from "@/components/app/payee-approvals";
import { TxFlowProvider } from "@/components/ds/tx-flow";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { AccountId } from "@/components/ds/account-id";
import { BudgetMeter } from "@/components/ds/budget-meter";
import { CallList, CallRow } from "@/components/ds/call-row";
import { StatusPill, callState } from "@/components/ds/status-pill";

function BudgetDetailPagePage() {
  const can = useCan();
  const { id } = useParams<{ id: string }>();
  const q = useBudget(id);
  const back = { href: "/budgets", label: "Budgets" };
  useDocumentTitle(q.data?.label ?? null);

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-72 max-w-full animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-24" />
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <BlockSkeleton className="h-72" />
          <BlockSkeleton className="h-72" />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Budget" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const m = q.data;
  const live = m.status === "open" || m.status === "pending";
  // The provider holds any open transaction flow, so it outlives controls that a revoke or an approval removes.
  return (
    <TxFlowProvider>
      <BudgetBody m={m} live={live} back={back} manage={can("agents.manage")} />
    </TxFlowProvider>
  );
}

function BudgetBody({ m, live, back, manage }: { m: BudgetDetail; live: boolean; back: { href: string; label: string }; manage: boolean }) {
  const daoOwned = useDaoOwner(m.owner);

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {m.label} <BudgetStatusChip status={m.status} />
          </span>
        }
        description={m.policy.purpose}
      />

      <WaitingPayees m={m} />

      {live && manage && <StopControls m={m} daoOwned={daoOwned} />}
      {m.status === "revoked" && <RevokedNotice m={m} daoOwned={daoOwned} />}

      <Glance m={m} />

      {/* Decisions waiting on the DAO come before the history, at every width: on a phone the side column is far down. */}
      {daoOwned && <DaoProposalsPanel className="mt-5" dao={m.owner} budgetId={m.id} />}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <DenialsList m={m} />
          <CallsTable m={m} />
          <SpendChart m={m} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <EscrowPanel m={m} />
          <SpendControls m={m} />
          <PayeeDecisionsPanel m={m} />
          <OnChain m={m} />
        </div>
      </div>
    </>
  );
}

/** The Budget at a glance: what is left, and a bar of settled, waiting and remaining. */
function Glance({ m }: { m: BudgetDetail }) {
  const now = useNow();
  const expired = Number(m.budget.validUntil) <= now;
  const used = percentOf(BigInt(m.spend.settled) + BigInt(m.spend.pending), m.cap);
  return (
    <BudgetMeter
      settled={m.spend.settled}
      waiting={m.spend.pending}
      limit={m.cap}
      remaining={m.spend.remaining}
      spendableNow={spendableNow(m)}
      money={(atomic, o) => <Money atomic={atomic} size={o?.size} />}
      aside={
        <>
          <span className="num font-medium text-foreground">{used.toFixed(1)}%</span> of <Money atomic={m.cap} className="text-foreground" /> cap used
          <span className="mx-2 text-subtle" aria-hidden>
            |
          </span>
          <span className={cn(expired && "text-negative")}>{describeTimeLeft(validUntilSec(m.budget.validUntil), now)}</span>
        </>
      }
    />
  );
}
function Control({ icon: Icon, title, value, children }: { icon: LucideIcon; title: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 px-4 py-3.5 sm:px-5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm">{value}</p>
        </div>
        {children && <div className="mt-1.5 text-xs text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

/** Each policy rule as a control row with its live usage, the way card programs show spend controls. */
function SpendControls({ m }: { m: BudgetDetail }) {
  const used = BigInt(m.spend.settled) + BigInt(m.spend.pending);
  const totalPct = percentOf(used, m.cap);
  const dailyPct = percentOf(m.spend.today, m.policy.dailyCap);
  const tone = (p: number): "negative" | "warning" | "primary" => (p > 90 ? "negative" : p > 75 ? "warning" : "primary");
  const now = useNow();
  const expired = Number(m.budget.validUntil) <= now;
  const short = Number(m.budget.validUntil) - new Date(m.createdAt).getTime() < 2 * 86_400_000;
  const when = (iso: string) => (short ? formatDateTime(iso) : formatDate(iso));
  return (
    <Panel
      title="Spend controls"
      description="Enforced on every Call by this server; the cap, expiry and Payees again by the hub at settlement"
      bodyClassName="p-0 sm:p-0"
    >
      <ul className="divide-y">
        <Control icon={PiggyBank} title="Cap" value={<><Money atomic={used} /> <span className="text-muted-foreground">of</span> <Money atomic={m.cap} /></>}>
          <Meter value={totalPct} tone={tone(totalPct)} label="Cap used" />
        </Control>
        <Control icon={CalendarClock} title="Daily limit" value={<><Money atomic={m.spend.today} /> <span className="text-muted-foreground">of</span> <Money atomic={m.policy.dailyCap} /></>}>
          <Meter value={dailyPct} tone={tone(dailyPct)} label="Daily limit used" />
          <p className="mt-1.5">Rolling 24 hours</p>
        </Control>
        <Control icon={Coins} title="Limit per Call" value={<>Up to <Money atomic={m.policy.perCallCap} /></>}>
          A Call priced above this is refused before any money moves.
        </Control>
        <Control
          icon={Gauge}
          title="Calls per minute"
          value={m.policy.maxCallsPerMinute ? <span className="num">{formatInt(m.policy.maxCallsPerMinute)} per minute</span> : <span className="text-muted-foreground">No limit</span>}
        />
        <Control
          icon={Store}
          title="Allowed Payees"
          value={m.payees.length === 0 ? <span className="text-muted-foreground">Any Payee</span> : <span className="num">{m.payees.length} {m.payees.length === 1 ? "Payee" : "Payees"}</span>}
        >
          <BudgetPayees m={m} />
        </Control>
        <Control icon={CalendarRange} title="Validity" value={<span className={cn("num", expired && "text-negative")}>{describeTimeLeft(validUntilSec(m.budget.validUntil), now)}</span>}>
          {when(m.createdAt)} to {when(m.expiresAt)}
        </Control>
      </ul>
      <p className="flex items-start gap-2 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-positive" aria-hidden />
        Committed on chain as the policy hash when the owner opened the Budget. Changing a rule needs a new Budget.
      </p>
    </Panel>
  );
}

/**
 * The ways to stop a Budget, side by side with what each one does: this server refusing new Calls, which is instant
 * and off chain, and the owner revoking on NEAR, which the hub enforces for every server. The owner's revoke has a
 * gasless twin beside it when a relayer is set up; a DAO owner revokes by proposal instead.
 */
function StopControls({ m, daoOwned }: { m: BudgetDetail; daoOwned: boolean }) {
  return (
    <section aria-labelledby="stop-title" className="mb-5 rounded-xl border bg-card px-4 py-3.5 sm:px-5">
      <h2 id="stop-title" className="text-sm font-medium">
        Stop this Budget
      </h2>
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-6">
        <div className="flex flex-col items-start gap-2">
          <ServerStopButton m={m} />
          <p className="text-xs text-muted-foreground">Your Payminto server refuses new Calls at once. Nothing changes on chain, and Calls already accepted still settle.</p>
        </div>
        <div className={cn("grid gap-4 sm:gap-6", !daoOwned && "sm:grid-cols-2")}>
          <div className="flex flex-col items-start gap-2">
            <StopBudgetButton m={m} />
            <p className="text-xs text-muted-foreground">
              {daoOwned
                ? `The owner is a DAO, so this adds a proposal for its members. Once they approve it, no server can settle new Calls, and unspent escrow can be reclaimed after the ${graceAdjective()} grace period.`
                : `The owner's wallet revokes it on the NEAR hub, so no server can settle new Calls. Unspent escrow can be reclaimed after the ${graceAdjective()} grace period.`}
            </p>
          </div>
          {!daoOwned && <GaslessButton m={m} action="revoke" />}
        </div>
      </div>
    </section>
  );
}

function ServerStopButton({ m }: { m: BudgetDetail }) {
  const api = useApi();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revokeBudget(m.id),
    onSuccess: () => {
      toast.success("Refused on this server", { description: "New Calls under this Budget are refused from now on. The owner can also stop it on chain." });
      void qc.invalidateQueries({ queryKey: qk.budgets });
    },
    onError: (e) => toast.error("Could not stop it on this server", { description: e instanceof ApiError ? e.message : String(e) }),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={revoke.isPending} className="h-11 w-full sm:h-9 sm:w-auto">
          <ServerOff aria-hidden /> Stop on this server
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Refuse new Calls on this server?</AlertDialogTitle>
          <AlertDialogDescription>
            Your server refuses new Calls from {m.label.split(" - ")[0]} immediately. Nothing changes on chain: only the owner&apos;s wallet can stop the Budget there. Calls already accepted still settle, so Payees are paid for work they did.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep accepting Calls</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => revoke.mutate()}>
            Refuse new Calls
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RevokedNotice({ m, daoOwned }: { m: BudgetDetail; daoOwned: boolean }) {
  const can = useCan();
  const pendingOnChain = m.onchain?.open === true && m.onchain.revokedAt == null;
  const act = pendingOnChain && can("agents.manage");
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-xl border bg-muted/60 px-4 py-3 text-sm">
      <p className="text-muted-foreground">
        Stopped {m.revokedAt ? <TimeAgo iso={m.revokedAt} /> : ""}. This server refuses new Calls. Calls already accepted can still settle on chain for {graceDuration()} after it was stopped.
        {pendingOnChain && (daoOwned ? " The hub has not recorded the stop yet; a member can propose it to the owner DAO." : " The hub has not recorded the stop yet; the owner can send it from their wallet.")}
      </p>
      {act && (
        <div className={cn("grid gap-4 sm:gap-6", !daoOwned && "sm:grid-cols-2")}>
          <div className="flex flex-col items-start gap-2">
            <StopBudgetButton m={m} />
          </div>
          {!daoOwned && <GaslessButton m={m} action="revoke" />}
        </div>
      )}
    </div>
  );
}

function OnChain({ m }: { m: BudgetDetail }) {
  const info = useInfo();
  const daoOwned = useDaoOwner(m.owner);
  const t = useToken();
  return (
    <Panel title="On chain" description="The Budget terms as the hub stores them">
      <Fields>
        <Field label="Budget id"><Hash value={m.id} /></Field>
        <Field label="Owner"><AccountId value={m.owner} name={daoOwned ? "DAO treasury" : undefined} mode="wrap" /></Field>
        <Field label="Agent key" hint="The agent signs vouchers with this ed25519 key. It holds no NEAR account and no funds."><AccountId value={m.agent} mode="wrap" /></Field>
        <Field label="Settler"><AccountId value={m.settler} mode="wrap" /></Field>
        <Field label="Token">
          <AccountId value={info.data?.token.address} name={t.symbol} mode="wrap" />
        </Field>
        <Field label="Hub"><AccountId value={info.data?.hub} mode="wrap" /></Field>
        <Field label="Opened by"><Hash value={m.openTxHash} kind="tx" /></Field>
        <Field label="Policy hash" hint="The hash of the spend controls below. The hub stores it, so the owner can prove which rules were agreed."><Hash value={m.budget.policyHash} /></Field>
      </Fields>
    </Panel>
  );
}

function SpendChart({ m }: { m: BudgetDetail }) {
  const t = useToken();
  // A budget that only spent in the last half hour reads better by minute than as one jump on a 14-day axis.
  const recent = useMemo(() => {
    const daily = m.spendSeries ?? [];
    const earlier = daily.slice(0, -1).some((p) => BigInt(p.amount) > 0n);
    const r = m.spendRecent ?? [];
    const sumRecent = r.reduce((a, p) => a + BigInt(p.amount), 0n);
    const today = daily.length ? BigInt(daily[daily.length - 1]!.amount) : 0n;
    return !earlier && r.length > 1 && sumRecent > 0n && sumRecent === today;
  }, [m.spendSeries, m.spendRecent]);
  const data = useMemo(() => {
    const out: { t: string; label: string; value: number; raw: string }[] = [];
    let run = 0n;
    if (recent) {
      const r = m.spendRecent!;
      const first = Math.max(0, r.findIndex((p) => BigInt(p.amount) > 0n) - 1);
      for (const p of r.slice(first)) {
        run += BigInt(p.amount);
        const label = new Date(p.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        out.push({ t: p.at, label, value: Number(run) / 10 ** t.decimals, raw: run.toString() });
      }
      return out;
    }
    for (const p of m.spendSeries ?? []) {
      run += BigInt(p.amount);
      // Live nodes bucket by day (YYYY-MM-DD); the mock buckets by hour (full ISO time).
      const daily = /^\d{4}-\d{2}-\d{2}$/.test(p.day);
      const d = new Date(daily ? `${p.day}T00:00:00Z` : p.day);
      const label = daily ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      out.push({ t: p.day, label, value: Number(run) / 10 ** t.decimals, raw: run.toString() });
    }
    return out;
  }, [m.spendSeries, m.spendRecent, recent, t.decimals]);
  const unit = recent ? "by minute" : m.spendSeries?.[0] && /^\d{4}-\d{2}-\d{2}$/.test(m.spendSeries[0].day) ? "by day" : "by hour";
  return (
    <Panel title="Cumulative spend" description={`${t.symbol}, ${unit}`}>
      {data.length < 2 || data[data.length - 1]!.raw === "0" ? (
        <EmptyState className="py-8" title="Nothing spent yet">Spend appears here once the agent has paid for Calls under this budget.</EmptyState>
      ) : (
        <div className="h-52" role="img" aria-label={`Cumulative spend reaching ${formatMoney(data[data.length - 1]!.raw, t.decimals)} ${t.symbol}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartColor("line")} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={chartColor("line")} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={chartColor("grid")} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} tick={axisTick} width={48} tickFormatter={(v: number) => v.toFixed(2)} />
              <Tooltip
                cursor={{ stroke: chartColor("axis"), strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-sm">
                      <p className="font-medium">{/^\d{4}-\d{2}-\d{2}$/.test(p.t) ? p.label : formatDateTime(p.t)}</p>
                      <p className="num mt-0.5 text-muted-foreground">
                        {formatMoney(p.raw, t.decimals)} {t.symbol} spent
                      </p>
                    </div>
                  );
                }}
              />
              <Area type="linear" dataKey="value" stroke={chartColor("line")} strokeWidth={2} fill="url(#spendFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function CallsTable({ m }: { m: BudgetDetail }) {
  const pages = useCallPages({ budgetId: m.id, limit: 15 });
  const dir = useDirectory();
  const calls = flattenCallPages(pages.data?.pages);
  return (
    <Panel title="Calls" description="Newest first; open one to see its Proof" bodyClassName="p-0 sm:p-0">
      {pages.isPending ? (
        <RowsSkeleton className="px-5" rows={6} />
      ) : pages.isError ? (
        <ErrorState className="m-4" error={pages.error} onRetry={() => void pages.refetch()} />
      ) : calls.length === 0 ? (
        <EmptyState icon={<Radio className="size-4" />} title="No Calls under this Budget yet">
          Calls appear here as the agent pays for them.
        </EmptyState>
      ) : (
        <CallList label="Calls under this Budget">
          {calls.map((c) => {
            const name = dir.lookup(c.payee)?.name;
            return (
              <CallRow
                key={c.id}
                href={`/receipts/${c.id}`}
                time={<time dateTime={c.createdAt}>{formatTime(c.createdAt)}</time>}
                who={
                  <span className="flex min-w-0 items-baseline gap-2">
                    {name && <span className="truncate">{name}</span>}
                    <AccountId value={c.payee} copy={false} explorer={false} className={cn(name && "hidden @[440px]:inline-flex")} idClassName="text-muted-foreground font-normal" />
                  </span>
                }
                detail={
                  <span className="text-muted-foreground">
                    Running total <Money atomic={c.cumulative} size="sm" className="font-normal" />
                  </span>
                }
                status={<StatusPill status={callState(c.status)} settledBy={c.settledBy} label={c.status === "settled" ? undefined : "In next settlement"} />}
                longStatus={c.status === "settled" && c.settledBy === "seller"}
                amount={<Money atomic={c.amount} />}
              />
            );
          })}
        </CallList>
      )}
      {pages.hasNextPage && (
        <div className="border-t px-4 py-3 sm:px-5">
          <Button variant="outline" className="h-11 w-full sm:h-8" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            {pages.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more Calls
          </Button>
        </div>
      )}
    </Panel>
  );
}

function DenialsList({ m }: { m: BudgetDetail }) {
  return (
    <Panel title="Refusals" description="Calls stopped by a rule before any money moved" bodyClassName="p-0 sm:p-0">
      {m.denials.length === 0 ? (
        <EmptyState className="py-8" icon={<ShieldCheck className="size-4" />} title="Nothing refused">
          Every Call under this Budget stayed inside its rules.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {m.denials.map((d) => (
            <DenialItem key={d.id} denial={d} showBudget={false} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function BudgetDetailPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <BudgetDetailPagePage />
    </RequirePermission>
  );
}
