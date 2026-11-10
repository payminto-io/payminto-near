"use client";

import { RequirePermission } from "@/components/app/states";
import { useEffect } from "react";
import Link from "next/link";
import { ChevronRight, FileSignature, Plus } from "lucide-react";
import { useBudgets } from "@/lib/queries";
import { useCan } from "@/lib/session";
import { formatDate, percentOf } from "@/lib/format";
import type { BudgetRecord } from "@/lib/schemas";
import { removeDaoDraft, useDaoDrafts } from "@/lib/dao-drafts";
import { Chip } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { AccountId } from "@/components/ds/account-id";
import { MeterBar } from "@/components/ds/budget-meter";
import { BudgetStatusChip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

/**
 * Budgets this browser proposed to a DAO that the hub does not hold yet. They are not on the server, so they are
 * listed apart, each leading to the page where the DAO's members approve it.
 */
function ProposedBudgets({ registered }: { registered: BudgetRecord[] | undefined }) {
  const all = useDaoDrafts();
  const drafts = all.filter((d) => !registered?.some((b) => b.id === d.id));
  useEffect(() => {
    // A proposed Budget the server now holds is listed below as a real one; the copy kept in this browser has done its job.
    for (const d of all) if (registered?.some((b) => b.id === d.id)) removeDaoDraft(d.id);
  }, [all, registered]);
  if (drafts.length === 0) return null;
  return (
    <Panel className="mb-5" title="Proposed to a DAO" description="Waiting for the DAO's members. Not spendable until they approve and the hub holds the Budget." bodyClassName="p-0 sm:p-0">
      <ul className="divide-y">
        {drafts.map((d) => (
          <li key={d.id} className="relative flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:px-5">
            <div className="min-w-0 flex-1">
              <Link href={`/budgets/proposed/${d.id}?dao=${d.dao}`} className="font-medium after:absolute after:inset-0 hover:underline">
                {d.label}
              </Link>
              <div className="relative z-10 mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span className="shrink-0">Owner</span> <AccountId value={d.dao} explorer={false} idClassName="text-xs text-muted-foreground" />
              </div>
            </div>
            <Chip tone="warning" className="max-sm:hidden">
              Waiting for the DAO
            </Chip>
            <span className="shrink-0 text-right text-sm">
              <span className="block text-xs text-muted-foreground">Cap</span>
              <Money atomic={d.budget.cap} />
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function BudgetsPagePage() {
  const budgets = useBudgets();
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Budgets"
        description="Each Budget is opened by its owner on the NEAR hub: a cap on what an AI agent may spend, rules for every Call, allowed Payees and an end date, backed by escrow. Your server checks every Call, and the hub checks again at settlement."
        actions={
          can("agents.manage") && (
            <Button asChild>
              <Link href="/budgets/new">
                <Plus /> New Budget
              </Link>
            </Button>
          )
        }
      />
      <ProposedBudgets registered={budgets.data} />
      <Panel bodyClassName="p-0 sm:p-0">
        {budgets.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : budgets.isError ? (
          <ErrorState className="m-4" error={budgets.error} onRetry={() => void budgets.refetch()} />
        ) : budgets.data.length === 0 ? (
          <EmptyState
            icon={<FileSignature className="size-4" />}
            title="No Budgets yet"
            action={
              can("agents.manage") ? (
                <Button asChild>
                  <Link href="/budgets/new">Open the first Budget</Link>
                </Button>
              ) : undefined
            }
          >
            An agent cannot pay anyone until an owner opens a Budget for it.
          </EmptyState>
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,2.2fr)_6.5rem_minmax(0,2fr)_minmax(0,1fr)_7rem] gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground md:grid">
              <span>Budget</span>
              <span>Status</span>
              <span>Used of cap</span>
              <span className="text-right">In escrow</span>
              <span className="text-right">Expires</span>
            </div>
            <ul className="divide-y">
              {budgets.data.map((m) => (
                <BudgetRow key={m.id} m={m} />
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

function BudgetRow({ m }: { m: BudgetRecord }) {
  const used = BigInt(m.spend.settled) + BigInt(m.spend.pending);
  const pct = percentOf(used, m.cap);
  return (
    <li className="relative grid gap-3 px-4 py-4 transition-colors hover:bg-muted/40 sm:px-5 md:grid-cols-[minmax(0,2.2fr)_6.5rem_minmax(0,2fr)_minmax(0,1fr)_7rem] md:items-center md:gap-4">
      <div className="min-w-0">
        <Link href={`/budgets/${m.id}`} className="font-medium after:absolute after:inset-0 hover:underline">
          {m.label}
        </Link>
        <div className="relative z-10 mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">Owner</span> <AccountId value={m.owner} explorer={false} idClassName="text-xs text-muted-foreground" />
        </div>
      </div>
      <div className="flex items-center justify-between md:block">
        <BudgetStatusChip status={m.status} />
        <span className="text-xs text-muted-foreground md:hidden">Expires {formatDate(m.expiresAt)}</span>
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
          <Money atomic={used} className="font-medium" />
          <span className="text-xs text-muted-foreground">
            of <Money atomic={m.cap} />
          </span>
        </div>
        <MeterBar settled={m.spend.settled} waiting={m.spend.pending} limit={m.cap} size="sm" label={`${m.label}: ${pct.toFixed(1)} percent of cap used`} />
      </div>
      <div className="flex items-baseline justify-between text-sm md:block md:text-right">
        <span className="text-xs text-muted-foreground md:hidden">In escrow</span>
        <span>
          <Money atomic={m.escrow ?? null} />
          {BigInt(m.ownerCredit ?? "0") > 0n && (
            <span className="block text-xs text-muted-foreground max-md:inline max-md:ml-1">
              credit <Money atomic={m.ownerCredit} size="sm" className="font-normal" />
            </span>
          )}
        </span>
      </div>
      <span className="num hidden text-right text-sm text-muted-foreground md:block">{formatDate(m.expiresAt)}</span>
    </li>
  );
}

export default function BudgetsPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <BudgetsPagePage />
    </RequirePermission>
  );
}
