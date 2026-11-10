"use client";

import { RequirePermission } from "@/components/app/states";
import { useParams } from "next/navigation";
import { Check, Circle } from "lucide-react";
import { useBatch, useBudgets } from "@/lib/queries";
import { useDocumentTitle } from "@/lib/use-title";
import { cn } from "@/lib/utils";
import type { BatchDetail } from "@/lib/schemas";
import Link from "next/link";
import { formatDateTime, formatInt, plural } from "@/lib/format";
import { Address, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip } from "@/components/app/status";
import { TransferRow } from "@/components/app/transfer-row";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { BatchSummary } from "@/components/ds/batch-summary";

function BatchDetailPagePage() {
  const { id } = useParams<{ id: string }>();
  const q = useBatch(id);
  const budgets = useBudgets();
  const back = { href: "/batches", label: "Settlement batches" };
  useDocumentTitle(q.data ? `Settlement batch #${q.data.seq}` : null);

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-48 animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-24" />
        <BlockSkeleton className="mt-5 h-72" />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Settlement" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const b = q.data;
  const labelOf = (budgetId: string) => budgets.data?.find((m) => m.id === budgetId)?.label ?? null;

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Settlement batch #{b.seq} <BatchStatusChip status={b.status} />
          </span>
        }
        description={b.confirmedAt ? `Final on NEAR ${formatDateTime(b.confirmedAt)}` : `Started ${formatDateTime(b.createdAt)}`}
      />
      {b.status === "failed" && b.error && <p className="mb-5 rounded-xl bg-negative-soft px-4 py-3 text-sm text-negative">{b.error}</p>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <BatchSummary
            label={`Settlement batch #${b.seq}`}
            calls={b.calls}
            transfers={b.transfers}
            gross={<Money atomic={b.gross} className="text-foreground" />}
            moved={<Money atomic={b.net} className="text-foreground" />}
            footer={
              <>
                <span className="text-muted-foreground">
                  {formatInt(b.claims)} {plural(b.claims, "claim")}, one per Budget and Payee
                </span>
                <Hash value={b.txHash} kind="tx" />
              </>
            }
          >
            {b.netTransfers.map((t) => (
              <TransferRow key={`${t.from}-${t.to}`} from={t.from} to={t.to} amount={t.amount} className="px-4 sm:px-5" />
            ))}
          </BatchSummary>

          <Panel title="Claims" description="The latest running total per Budget and Payee; the hub pays only what was not settled before" bodyClassName="p-0 sm:p-0">
            <ul className="@container divide-y">
              {b.claimList.map((c) => (
                <li key={`${c.budgetId}-${c.payee}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5 @[560px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
                  <span className="min-w-0">
                    <Link href={`/budgets/${c.budgetId}`} className="block truncate font-medium hover:underline">
                      {labelOf(c.budgetId) ?? "Budget"}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {c.calls ?? "-"} {plural(c.calls ?? 0, "Call")}, running total <Money atomic={c.cumulative} size="sm" className="font-normal" />
                    </span>
                  </span>
                  <span className="order-3 col-span-2 min-w-0 @[560px]:order-none @[560px]:col-span-1">
                    <Address address={c.payee} explorer={false} copy={false} nameOnly />
                  </span>
                  <span className="text-right">
                    <Money atomic={c.delta} />
                    <span className="block text-xs text-muted-foreground">this batch</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Finality b={b} />
          <Panel title="On chain" description="Prove any Call in this batch against this root">
            <Fields>
              <Field label="Transaction"><Hash value={b.txHash} kind="tx" /></Field>
              <Field label="Batch id"><Hash value={b.id} /></Field>
              <Field label="Receipts root" hint="The Merkle root of every Call in this batch, stored on the hub."><Hash value={b.receiptsRoot} /></Field>
              <Field label="Token"><Address address={b.token} showName={false} /></Field>
            </Fields>
          </Panel>
        </div>
      </div>
    </>
  );
}

/** Sent to the network, then final once the transaction outcome is final on NEAR. */
function Finality({ b }: { b: BatchDetail }) {
  const steps = [
    { label: "Sent", detail: "The settlement transaction left your server", at: b.submittedAt, done: Boolean(b.submittedAt) || b.status === "confirmed" },
    {
      label: "Final",
      detail: "The transaction is final on NEAR and can no longer be reversed. Balances update only now.",
      at: b.confirmedAt,
      done: b.status === "confirmed",
    },
  ];
  return (
    <Panel title="Sent, then final" description="When this settlement can no longer be reversed">
      <ol className="space-y-3.5">
        {steps.map((st) => (
          <li key={st.label} className="flex gap-3">
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                st.done ? "bg-positive-soft text-positive" : "bg-muted text-subtle",
              )}
              aria-hidden
            >
              {st.done ? <Check className="size-3" /> : <Circle className="size-2.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={cn("text-sm font-medium", !st.done && "text-muted-foreground")}>{st.label}</p>
                {st.at && <p className="num text-xs text-subtle">{formatDateTime(st.at)}</p>}
              </div>
              <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{st.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export default function BatchDetailPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <BatchDetailPagePage />
    </RequirePermission>
  );
}
