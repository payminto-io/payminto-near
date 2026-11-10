"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HandCoins, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useApi, useCan } from "@/lib/session";
import { formatDateTime, formatInt, plural } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { PayoutAccount } from "@/lib/schemas";
import { payoutRows, useHubCredits } from "@/lib/use-hub-credits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RequirePermission, RowsSkeleton } from "@/components/app/states";
import { AccountId } from "@/components/ds/account-id";
import { StatusPill } from "@/components/ds/status-pill";

const ACCOUNT_STATE: Record<PayoutAccount["status"], { status: "settled" | "waiting"; label: string }> = {
  clear: { status: "settled", label: "Paid out" },
  due: { status: "waiting", label: "Due" },
  waiting_registration: { status: "waiting", label: "Waiting for registration" },
};

function PayoutsPagePage() {
  const api = useApi();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["payouts"], queryFn: () => api.payouts(), refetchInterval: 15_000 });
  const run = useMutation({
    mutationFn: () => api.runPayouts(),
    onSuccess: (r) => {
      if ("skipped" in r) toast.message("Nothing to pay out", { description: r.skipped });
      else {
        const paid = r.payouts.reduce((n, p) => n + p.items.filter((i) => i.outcome === "paid").length, 0);
        toast.success(`Paid out to ${paid} ${plural(paid, "account")}`, {
          description: r.waitingRegistration.length ? `${r.waitingRegistration.length} ${plural(r.waitingRegistration.length, "account")} must register with the token first.` : undefined,
        });
      }
      void qc.invalidateQueries({ queryKey: ["payouts"] });
      void qc.invalidateQueries({ queryKey: ["near-credit"] });
    },
    onError: (e) => toast.error("Payout not sent", { description: e instanceof ApiError ? e.message : String(e) }),
  });
  const listed = q.data?.accounts ?? [];
  const hub = useHubCredits(listed.map((a) => a.account));
  const accounts = payoutRows(listed, hub.credits);
  const due = accounts.filter((a) => a.status === "due");
  const waiting = accounts.some((a) => a.status === "waiting_registration");

  return (
    <>
      <PageHeader
        title="Payouts"
        description="Settlement batches credit each net creditor on the hub. A payout sends that credit to the account itself; the hub zeroes credit before sending and restores it if the transfer fails."
        actions={
          can("settlements.run") ? (
            <Button onClick={() => run.mutate()} disabled={run.isPending || due.length === 0}>
              {run.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />} Pay out now
            </Button>
          ) : null
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel
            title="Hub credit by account"
            description={
              hub.state === "done"
                ? "Read from the hub just now, by this browser."
                : hub.state === "error"
                  ? "The hub could not be read, so these are the server's own figures from its last payout run."
                  : "The server's own figures from its last payout run, until the hub has been read."
            }
            bodyClassName="p-0 sm:p-0"
          >
            {waiting && (
              <p className="border-b px-4 py-3 text-xs text-muted-foreground sm:px-5">
                Waiting for registration: the account must call <code className="font-mono">storage_deposit</code> on the token before the hub can pay it. Its credit stays on the hub until then.
              </p>
            )}
            {hub.state === "error" && (
              <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-3 text-xs text-muted-foreground sm:px-5">
                <span>{hub.message}</span>
                <button type="button" onClick={hub.retry} className="rounded font-medium text-foreground underline underline-offset-2 focus-visible:outline-2">
                  Read the hub again
                </button>
              </p>
            )}
            {q.isPending ? (
              <RowsSkeleton className="px-5" rows={4} />
            ) : q.isError ? (
              <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
            ) : accounts.length === 0 ? (
              <EmptyState icon={<HandCoins className="size-4" />} title="No credit yet">
                Net creditors appear here once a settlement batch credits them.
              </EmptyState>
            ) : (
              <ul className="@container divide-y">
                {accounts.map((a) => (
                  <li key={a.account} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-sm sm:px-5 @[560px]:grid-cols-[minmax(0,1fr)_auto_8rem]">
                    <AccountId value={a.account} className="col-span-2 min-w-0 @[560px]:col-span-1" />
                    <span className="justify-self-start @[560px]:justify-self-end">
                      <StatusPill status={ACCOUNT_STATE[a.status].status} label={ACCOUNT_STATE[a.status].label} />
                    </span>
                    <span className="text-right">
                      <Money atomic={a.credit} />
                      <span className="block text-xs text-muted-foreground">
                        paid out <Money atomic={a.paidTotal} size="sm" className="font-normal" />
                      </span>
                    </span>
                    {a.lastError && a.status !== "clear" && <p className="col-span-full text-xs text-muted-foreground">{a.lastError}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Recent payouts" bodyClassName="p-0 sm:p-0">
            {q.data && q.data.payouts.length === 0 ? (
              <EmptyState icon={<Send className="size-4" />} title="No payouts yet">
                Payouts run on the server&apos;s interval, or now with Pay out now.
              </EmptyState>
            ) : (
              <ul className="divide-y">
                {(q.data?.payouts ?? []).map((p) => (
                  <li key={p.seq} className="flex flex-col gap-1.5 px-4 py-3 text-sm sm:px-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">Payout #{p.seq}</span>
                      <StatusPill status={p.status === "confirmed" ? "settled" : p.status === "failed" ? "refused" : "waiting"} label={p.status === "confirmed" ? "Final" : p.status === "failed" ? "Failed" : p.status === "unknown" ? "Checking the hub" : "Sent"} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatInt(p.items.length)} {plural(p.items.length, "account")}, {formatDateTime(p.finishedAt ?? p.createdAt)}
                    </p>
                    {p.txHash && <Hash value={p.txHash} kind="tx" />}
                    {p.error && <p className="text-xs text-negative">{p.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <ExportPanel />
      </div>
    </>
  );
}

/** Decision 9: books need gross per counterparty next to the net cash movement. */
function ExportPanel() {
  const api = useApi();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const csv = await api.settlementExportCsv({ from: from || undefined, to: to || undefined, account: account.trim() || undefined });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `payminto-settlements-${from || "all"}-${to || "now"}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Export not made", { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Settlement export" description="Gross paid and received per counterparty, next to the net debit or credit each batch moved, so books record expense and revenue apart from cash." className="h-fit">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void download();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exp-from">From</Label>
            <Input id="exp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-11 md:h-9" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exp-to">To</Label>
            <Input id="exp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-11 md:h-9" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="exp-account">One account (optional)</Label>
          <Input id="exp-account" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="treasury.testnet" autoCapitalize="none" spellCheck={false} className="hash h-11 text-base md:h-9 md:text-[0.8125rem]" />
        </div>
        <Button type="submit" variant="outline" disabled={busy} className="h-11 md:h-9">
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />} Download CSV
        </Button>
      </form>
    </Panel>
  );
}

export default function PayoutsPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <PayoutsPagePage />
    </RequirePermission>
  );
}
