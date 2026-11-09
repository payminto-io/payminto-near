"use client";

import { RequirePermission } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { useMemo, useState } from "react";
import { createWalletClient, custom, encodeFunctionData, type Address as Addr, type Hex } from "viem";
import { clearingHubAbi } from "@payminto/protocol";
import { hasInjectedWallet } from "@/lib/sign";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, CalendarRange, Coins, Fuel, Gauge, Loader2, PiggyBank, Radio, ShieldCheck, Store, Wallet, type LucideIcon } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { useApi, useCan } from "@/lib/session";
import { qk, flattenCallPages, useCallPages, useInfo, useMandate, useToken } from "@/lib/queries";
import { formatDate, formatDateTime, formatInt, formatMoney, percentOf } from "@/lib/format";
import { budgetSplit, describeTimeLeft } from "@/lib/spend";
import { useDocumentTitle } from "@/lib/use-title";
import { useNow } from "@/components/app/time-ago";
import { Chip } from "@/components/app/status";
import { Tooltip as Hint, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import type { MandateDetail } from "@/lib/schemas";
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
import { Address, Field, Fields, Hash, Meter, Money, PageHeader, Panel, PartyLine } from "@/components/app/primitives";
import { CallStatusChip, MandateStatusChip } from "@/components/app/status";
import { DenialItem } from "@/components/app/denial";
import { AgentWallet } from "@/components/app/agent-wallet";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

function MandateDetailPagePage() {
  const can = useCan();
  const { id } = useParams<{ id: string }>();
  const q = useMandate(id);
  const back = { href: "/mandates", label: "Budgets" };
  useDocumentTitle(q.data?.label ?? null);

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-72 animate-pulse rounded bg-muted" />} />
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

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {m.label} <MandateStatusChip status={m.status} />
          </span>
        }
        description={m.policy.purpose}
        actions={(m.status === "open" || m.status === "pending") && can("agents.manage") ? <RevokeButton m={m} /> : null}
      />

      {m.status === "revoked" && <RevokedNotice m={m} />}

      <Budget m={m} />

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <SpendChart m={m} />
          <CallsTable m={m} />
          <DenialsList m={m} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <SpendControls m={m} />
          <AgentWallet m={m} />
          <OnChain m={m} />
        </div>
      </div>
    </>
  );
}

/** The budget at a glance: what is left, and a bar of settled, awaiting netting and remaining. */
function Budget({ m }: { m: MandateDetail }) {
  const split = budgetSplit(m.spend.settled, m.spend.pending, m.mandate.totalCap);
  const now = useNow();
  const expired = Number(m.mandate.validUntil) * 1000 <= now;
  return (
    <section aria-label="Budget" className="rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="text-xs text-muted-foreground">Remaining budget</p>
          <p className="mt-1 text-[2rem] leading-none font-semibold tracking-[-0.025em]">
            <Money atomic={m.spend.remaining} maxFraction={4} />
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="num font-medium text-foreground">{split.usedPct.toFixed(1)}%</span> of <Money atomic={m.mandate.totalCap} maxFraction={2} className="text-foreground" /> used
          <span className="mx-2 text-subtle" aria-hidden>
            |
          </span>
          <span className={cn(expired && "text-negative")}>{describeTimeLeft(m.mandate.validUntil, now)}</span>
        </p>
      </div>
      <div
        className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="Total budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split.usedPct)}
      >
        <div className={cn("h-full transition-[width] duration-500", split.tone === "negative" ? "bg-negative" : split.tone === "warning" ? "bg-warning" : "bg-primary")} style={{ width: `${split.settledPct}%` }} />
        <div
          className={cn("h-full transition-[width] duration-500", split.tone === "negative" ? "bg-negative/40" : split.tone === "warning" ? "bg-warning/40" : "bg-primary/35")}
          style={{ width: `${split.pendingPct}%` }}
        />
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn("size-2 rounded-full", split.tone === "primary" ? "bg-primary" : split.tone === "warning" ? "bg-warning" : "bg-negative")} />
          <dt className="text-muted-foreground">Settled on chain</dt>
          <dd><Money atomic={m.spend.settled} maxFraction={4} /></dd>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn("size-2 rounded-full", split.tone === "primary" ? "bg-primary/35" : split.tone === "warning" ? "bg-warning/40" : "bg-negative/40")} />
          <dt className="text-muted-foreground">In next settlement</dt>
          <dd><Money atomic={m.spend.pending} maxFraction={4} /></dd>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full bg-muted ring-1 ring-border" />
          <dt className="text-muted-foreground">Remaining</dt>
          <dd><Money atomic={m.spend.remaining} maxFraction={4} /></dd>
        </div>
      </dl>
    </section>
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
function SpendControls({ m }: { m: MandateDetail }) {
  const used = BigInt(m.spend.settled) + BigInt(m.spend.pending);
  const totalPct = percentOf(used, m.mandate.totalCap);
  const dailyPct = percentOf(m.spend.today, m.policy.dailyCap);
  const tone = (p: number): "negative" | "warning" | "primary" => (p > 90 ? "negative" : p > 75 ? "warning" : "primary");
  const now = useNow();
  const expired = Number(m.mandate.validUntil) * 1000 <= now;
  const short = Number(m.mandate.validUntil) - Number(m.mandate.validAfter) < 2 * 86_400;
  const when = (sec: string) => (short ? formatDateTime(new Date(Number(sec) * 1000).toISOString()) : formatDate(Number(sec)));
  return (
    <Panel
      title="Spend controls"
      description="Enforced on every charge by this server and again on chain at settlement"
      bodyClassName="p-0 sm:p-0"
    >
      <ul className="divide-y">
        <Control icon={PiggyBank} title="Total budget" value={<><Money atomic={used} maxFraction={4} /> <span className="text-muted-foreground">of</span> <Money atomic={m.mandate.totalCap} maxFraction={2} /></>}>
          <Meter value={totalPct} tone={tone(totalPct)} label="Total budget used" />
        </Control>
        <Control icon={CalendarClock} title="Daily limit" value={<><Money atomic={m.spend.today} maxFraction={4} /> <span className="text-muted-foreground">of</span> <Money atomic={m.policy.dailyCap} maxFraction={2} /></>}>
          <Meter value={dailyPct} tone={tone(dailyPct)} label="Daily limit used" />
          <p className="mt-1.5">Rolling 24 hours</p>
        </Control>
        <Control icon={Coins} title="Limit per charge" value={<>Up to <Money atomic={m.policy.perCallCap} /></>}>
          A charge priced above this is refused before it is booked.
        </Control>
        <Control
          icon={Gauge}
          title="Charges per minute"
          value={m.policy.maxCallsPerMinute ? <span className="num">{formatInt(m.policy.maxCallsPerMinute)} calls / min</span> : <span className="text-muted-foreground">No limit</span>}
        />
        <Control
          icon={Store}
          title="Allowed services"
          value={m.payees.length === 0 ? <span className="text-muted-foreground">Any service</span> : <span className="num">{m.payees.length} {m.payees.length === 1 ? "service" : "services"}</span>}
        >
          {m.payees.length > 0 && (
            <ul className="mt-1 space-y-2 text-sm text-foreground">
              {m.payees.map((p) => (
                <li key={p}>
                  <PartyLine address={p} />
                </li>
              ))}
            </ul>
          )}
        </Control>
        <Control icon={CalendarRange} title="Validity" value={<span className={cn("num", expired && "text-negative")}>{describeTimeLeft(m.mandate.validUntil, now)}</span>}>
          {when(m.mandate.validAfter)} to {when(m.mandate.validUntil)}
        </Control>
        {m.onboarding && (
          <Control
            icon={Fuel}
            title="Onboarding"
            value={m.onboarding.gaslessPermit ? <Chip tone="positive">Gasless permit</Chip> : <span className="text-muted-foreground">Approve transaction</span>}
          >
            {m.onboarding.gaslessPermit ? (
              <>
                The agent signed an EIP-2612 permit and the server opened this budget with openMandateWithPermit. Agent wallet transactions sent:{" "}
                <span className="num font-medium text-foreground">{formatInt(m.onboarding.agentTransactions)}</span>.
              </>
            ) : (
              <>
                The agent approved the hub with its own transaction. Agent wallet transactions sent:{" "}
                <span className="num font-medium text-foreground">{formatInt(m.onboarding.agentTransactions)}</span>.
              </>
            )}
          </Control>
        )}
      </ul>
      <p className="flex items-start gap-2 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-positive" aria-hidden />
        Signed once by the owner and committed on chain as policyHash. Changing a control needs a new budget.
      </p>
    </Panel>
  );
}

function RevokeButton({ m }: { m: MandateDetail }) {
  const api = useApi();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revokeMandate(m.id),
    onSuccess: (res) => {
      const needsOwner = res.onchain && !res.onchain.revoked;
      toast.success("Budget stopped", {
        description: needsOwner
          ? "This server refuses new charges now. The owner or agent should also stop it on chain (revokeMandate)."
          : "New charges under this budget are refused from now on.",
      });
      void qc.invalidateQueries({ queryKey: qk.mandates });
    },
    onError: (e) => toast.error("Stop failed", { description: e instanceof ApiError ? e.message : String(e) }),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="text-negative hover:text-negative" disabled={revoke.isPending}>
          <Ban /> Stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this budget?</AlertDialogTitle>
          <AlertDialogDescription>
            Your server refuses new charges from {m.label.split(" - ")[0]} immediately. Charges already accepted can still settle for one hour, so paid services are still paid for work they did.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep budget</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => revoke.mutate()}>
            Stop budget
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RevokedNotice({ m }: { m: MandateDetail }) {
  const info = useInfo();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pendingOnChain = m.onchain?.open === true && m.onchain.revokedAt == null;

  async function revokeOnChain() {
    if (!info.data || !window.ethereum) return;
    setBusy(true);
    try {
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const [from] = await wallet.requestAddresses();
      if (!from) throw new Error("The wallet did not share an account.");
      if (![m.mandate.owner, m.mandate.agent].some((a) => a.toLowerCase() === from.toLowerCase())) {
        throw new Error("Only the budget owner or agent can stop it on chain. Switch to that account.");
      }
      const data = encodeFunctionData({ abi: clearingHubAbi, functionName: "revokeMandate", args: [m.id as Hex] });
      await wallet.sendTransaction({ account: from, to: info.data.hub as Addr, data, chain: null });
      toast.success("Stop sent", { description: "Your server sees the stop on chain within a few seconds." });
      void qc.invalidateQueries({ queryKey: qk.mandate(m.id) });
    } catch (e) {
      toast.error("On-chain revoke not sent", { description: e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-lg border bg-muted/60 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <p className="flex-1 text-muted-foreground">
        Stopped {m.revokedAt ? <TimeAgo iso={m.revokedAt} /> : ""}. This server refuses new charges. Charges already accepted can still settle on chain for one hour after it was stopped.
        {pendingOnChain && " The hub has not recorded the revoke yet; the owner or agent can send it."}
      </p>
      {pendingOnChain && hasInjectedWallet() && (
        <Button variant="outline" size="sm" onClick={() => void revokeOnChain()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Wallet />} Revoke on chain with wallet
        </Button>
      )}
    </div>
  );
}

function OnChain({ m }: { m: MandateDetail }) {
  const info = useInfo();
  const t = useToken();
  return (
    <Panel title="On chain" description="The signed budget as the settlement contract stores it">
      <Fields>
        <Field label="Budget id"><Hash value={m.id} /></Field>
        <Field label="Owner"><Address address={m.mandate.owner} showName={false} /></Field>
        <Field label="Agent"><PartyLine address={m.mandate.agent} /></Field>
        <Field label="Token">
          <span className="inline-flex items-center gap-2">
            {t.symbol} <Address address={m.mandate.token} showName={false} />
          </span>
        </Field>
        <Field label="Hub"><Address address={info.data?.hub} showName={false} /></Field>
        <Field label="Opened by tx"><Hash value={m.openTxHash} kind="tx" /></Field>
        <Field label="Services root"><Hash value={m.mandate.payeesRoot} /></Field>
        <Field label="Policy hash"><Hash value={m.mandate.policyHash} /></Field>
      </Fields>
    </Panel>
  );
}

function SpendChart({ m }: { m: MandateDetail }) {
  const t = useToken();
  // A mandate that only spent in the last half hour reads better by minute than as one jump on a 14-day axis.
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
        <EmptyState className="py-8" title="Nothing spent yet">Spend appears here once the agent has paid for charges under this budget.</EmptyState>
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
                        {formatMoney(p.raw, t.decimals, { maxFraction: 4 })} {t.symbol} spent
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

function CallsTable({ m }: { m: MandateDetail }) {
  const pages = useCallPages({ mandateId: m.id, limit: 15 });
  const calls = flattenCallPages(pages.data?.pages);
  return (
    <Panel title="Charges" description="Newest first; open one to see its proof" bodyClassName="p-0 sm:p-0">
      {pages.isPending ? (
        <RowsSkeleton className="px-5" rows={6} />
      ) : pages.isError ? (
        <ErrorState className="m-4" error={pages.error} onRetry={() => void pages.refetch()} />
      ) : calls.length === 0 ? (
        <EmptyState icon={<Radio className="size-4" />} title="No charges under this budget yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-5 py-2.5 font-normal">Service</th>
                <th className="px-3 py-2.5 text-right font-normal">Amount</th>
                <th className="px-3 py-2.5 text-right font-normal">
                  <Hint>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">Charge total</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Running total this agent has signed to this service. Each charge replaces the previous one, so only the latest is settled.
                    </TooltipContent>
                  </Hint>
                </th>
                <th className="px-3 py-2.5 font-normal">Status</th>
                <th className="px-5 py-2.5 text-right font-normal">When</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {calls.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-5 py-2.5"><Address address={c.payee} explorer={false} copy={false} /></td>
                  <td className="px-3 py-2.5 text-right">
                    <Link href={`/receipts/${c.id}`} className="hover:underline"><Money atomic={c.amount} /></Link>
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground"><Money atomic={c.cumulative} maxFraction={4} /></td>
                  <td className="px-3 py-2.5"><CallStatusChip status={c.status} /></td>
                  <td className="num px-5 py-2.5 text-right text-xs whitespace-nowrap text-muted-foreground"><TimeAgo iso={c.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages.hasNextPage && (
        <div className="border-t px-4 py-3 sm:px-5">
          <Button variant="outline" size="sm" className="w-full" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            {pages.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more calls
          </Button>
        </div>
      )}
    </Panel>
  );
}

function DenialsList({ m }: { m: MandateDetail }) {
  return (
    <Panel title="Blocked by these controls" description="Charges refused before any money moved" bodyClassName="p-0 sm:p-0">
      {m.denials.length === 0 ? (
        <EmptyState className="py-8" icon={<ShieldCheck className="size-4" />} title="Nothing blocked">
          Every charge under this budget stayed inside its controls.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {m.denials.map((d) => (
            <DenialItem key={d.id} denial={d} showMandate={false} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function MandateDetailPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <MandateDetailPagePage />
    </RequirePermission>
  );
}
