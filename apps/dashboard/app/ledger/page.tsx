"use client";

import { RequirePermission } from "@/components/app/states";
import { useMemo, useState } from "react";
import { BookOpenCheck, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDirectory, useLedger, useTrialBalance } from "@/lib/queries";
import { formatDateTime, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LedgerEntry } from "@/lib/schemas";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

/** Entries per step; the node caps one request at 1000. */
const LEDGER_PAGE = 200;
const LEDGER_MAX = 1000;

const KIND_LABEL: Record<string, string> = { payable: "payable", receivable: "receivable", wallet: "wallet" };

function useAccountName() {
  const dir = useDirectory();
  return (account: string) => {
    const [, addr = "", kind = ""] = account.split(":");
    const who = dir.lookup(addr)?.name ?? shortAddress(addr);
    return { who, kind: KIND_LABEL[kind] ?? kind, addr };
  };
}

function LedgerPagePage() {
  const [account, setAccount] = useState<string>("all");
  const tb = useTrialBalance();
  const [limit, setLimit] = useState(LEDGER_PAGE);
  const ledger = useLedger(account === "all" ? undefined : account, limit);
  const nameOf = useAccountName();

  const journals = useMemo(() => {
    const map = new Map<string, LedgerEntry[]>();
    for (const e of ledger.data ?? []) {
      const list = map.get(e.journalId) ?? [];
      list.push(e);
      map.set(e.journalId, list);
    }
    // Debits first within each journal, the accounting convention, whatever order the node returns.
    const isDebit = (e: LedgerEntry) => BigInt(e.debit) > 0n;
    return [...map.entries()].map(([id, lines]) => [id, [...lines].sort((a, b) => Number(isDebit(b)) - Number(isDebit(a)))] as const);
  }, [ledger.data]);

  return (
    <>
      <PageHeader
        title="Balances"
        description="Who owes what, and what has been paid, with every entry. Each accepted charge is booked as owed; each settlement clears it and records the money that moved."
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Panel title="Trial balance" description="Every journal balances, so the books always sum to zero" bodyClassName="p-0 sm:p-0" className="h-fit">
          {tb.isPending ? (
            <RowsSkeleton className="px-5" rows={6} />
          ) : tb.isError ? (
            <ErrorState className="m-4" error={tb.error} onRetry={() => void tb.refetch()} />
          ) : (
            <>
              <div className={cn("mx-4 mt-4 flex items-start gap-3 rounded-lg px-4 py-3 sm:mx-5", BigInt(tb.data.balance) === 0n ? "bg-positive-soft" : "bg-negative-soft")}>
                {BigInt(tb.data.balance) === 0n ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-negative" />}
                <div className="min-w-0">
                  <p className={cn("font-medium", BigInt(tb.data.balance) === 0n ? "text-positive" : "text-negative")}>
                    {BigInt(tb.data.balance) === 0n ? "Balanced" : "Out of balance"}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Debits <Money atomic={tb.data.totalDebit} className="text-foreground" /> minus credits <Money atomic={tb.data.totalCredit} className="text-foreground" /> is{" "}
                    <Money atomic={tb.data.balance} className="font-medium text-foreground" />.
                  </p>
                </div>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm sm:min-w-[26rem]">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2.5 pr-2 pl-5 font-normal">Account</th>
                      <th className="px-2 py-2.5 text-right font-normal max-sm:hidden">Debit</th>
                      <th className="px-2 py-2.5 text-right font-normal max-sm:hidden">Credit</th>
                      <th className="py-2.5 pr-5 pl-2 text-right font-normal">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {tb.data.accounts.map((a) => {
                      const n = nameOf(a.account);
                      return (
                        <tr key={a.account}>
                          <td className="py-2.5 pr-2 pl-5">
                            <span className="block font-medium">{n.who}</span>
                            <span className="block text-xs text-muted-foreground">{n.kind}</span>
                          </td>
                          <td className="px-2 py-2.5 text-right text-muted-foreground max-sm:hidden"><Money atomic={a.debit} maxFraction={4} /></td>
                          <td className="px-2 py-2.5 text-right text-muted-foreground max-sm:hidden"><Money atomic={a.credit} maxFraction={4} /></td>
                          <td className="py-2.5 pr-5 pl-2 text-right font-medium"><Money atomic={a.balance} maxFraction={4} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="py-3 pr-2 pl-5">Total</td>
                      <td className="px-2 py-3 text-right max-sm:hidden"><Money atomic={tb.data.totalDebit} maxFraction={4} /></td>
                      <td className="px-2 py-3 text-right max-sm:hidden"><Money atomic={tb.data.totalCredit} maxFraction={4} /></td>
                      <td className="py-3 pr-5 pl-2 text-right"><Money atomic={tb.data.balance} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Journal"
          description="Newest first"
          actions={
            <Select
              value={account}
              onValueChange={(v) => {
                setAccount(v);
                setLimit(LEDGER_PAGE);
              }}
            >
              <SelectTrigger size="sm" className="w-[13.5rem] max-w-full" aria-label="Filter by account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">All accounts</SelectItem>
                {(tb.data?.accounts ?? []).map((a) => {
                  const n = nameOf(a.account);
                  return (
                    <SelectItem key={a.account} value={a.account}>
                      {n.who} {n.kind}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          }
          bodyClassName="p-0 sm:p-0"
        >
          {ledger.isPending ? (
            <RowsSkeleton className="px-5" rows={8} />
          ) : ledger.isError ? (
            <ErrorState className="m-4" error={ledger.error} onRetry={() => void ledger.refetch()} />
          ) : journals.length === 0 ? (
            <EmptyState icon={<BookOpenCheck className="size-4" />} title="No journal entries">
              Entries appear when the server accepts its first charge.
            </EmptyState>
          ) : (
            <ul className="divide-y">
              <li aria-hidden className="flex justify-end bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-5">
                <span className="w-28 text-right">Debit</span>
                <span className="w-28 text-right">Credit</span>
              </li>
              {journals.map(([id, lines]) => (
                <li key={id} className="px-4 py-3 sm:px-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium">{journalTitle(lines)}</p>
                    <time className="num shrink-0 text-xs text-subtle">{lines[0] ? formatDateTime(lines[0].createdAt) : ""}</time>
                  </div>
                  <table className="mt-1.5 w-full text-[0.8125rem]">
                    <tbody>
                      {lines.map((l) => {
                        const n = nameOf(l.account);
                        const debit = BigInt(l.debit) > 0n;
                        return (
                          <tr key={l.id}>
                            <td className={cn("py-0.5 pr-3", !debit && "pl-5")}>
                              <span className="text-foreground">{n.who}</span> <span className="text-muted-foreground">{n.kind}</span>
                            </td>
                            <td className="w-28 py-0.5 text-right">{debit ? <Money atomic={l.debit} maxFraction={4} /> : null}</td>
                            <td className="w-28 py-0.5 text-right text-muted-foreground">{!debit ? <Money atomic={l.credit} maxFraction={4} /> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </li>
              ))}
            </ul>
          )}
          {ledger.data && ledger.data.length >= limit && limit < LEDGER_MAX && (
            <div className="border-t px-4 py-3 sm:px-5">
              <Button variant="outline" size="sm" className="w-full" onClick={() => setLimit((l) => Math.min(LEDGER_MAX, l + LEDGER_PAGE))} disabled={ledger.isFetching}>
                {ledger.isFetching && <Loader2 className="animate-spin" />} Show older entries
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

const KIND_TITLE: Record<string, string> = {
  "call.accepted": "Charge accepted",
  "batch.settled": "Settlement paid",
  refund: "Refund",
};

/** "Charge accepted (Market Data)" from a live node's kind and memo, or the memo itself from older shapes. */
function journalTitle(lines: LedgerEntry[]): string {
  const first = lines[0];
  if (!first) return "Journal";
  const base = first.kind ? KIND_TITLE[first.kind] : undefined;
  if (!base) return first.memo ?? "Journal";
  if (first.kind === "call.accepted" && first.memo?.startsWith("call ")) return `${base} (${first.memo.slice(5)})`;
  return base;
}

export default function LedgerPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <LedgerPagePage />
    </RequirePermission>
  );
}
