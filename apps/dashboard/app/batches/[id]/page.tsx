"use client";

import { RequirePermission } from "@/components/app/states";
import { useParams } from "next/navigation";
import { Check, Circle } from "lucide-react";
import { useBatch, useInfo, useMandates } from "@/lib/queries";
import { useDocumentTitle } from "@/lib/use-title";
import { cn } from "@/lib/utils";
import type { BatchDetail } from "@/lib/schemas";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatGas, formatInt, formatNative, formatRatio } from "@/lib/format";
import type { HspStatus } from "@/lib/schemas";
import { Address, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip, Chip, HSP_EXPLAIN } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { TransferRow } from "@/components/app/transfer-row";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

const LEGEND: HspStatus[] = ["ACCEPT", "SETTLED", "UNSIGNED", "REJECT"];

function BatchDetailPagePage() {
  const { id } = useParams<{ id: string }>();
  const q = useBatch(id);
  const mandates = useMandates();
  const back = { href: "/batches", label: "Settlements" };
  useDocumentTitle(q.data ? `Batch #${q.data.seq}` : null);

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
  const labelOf = (mandateId: string) => mandates.data?.find((m) => m.id === mandateId)?.label ?? null;
  const gross = BigInt(b.gross);
  const net = BigInt(b.net);
  const counts = LEGEND.map((s) => ({ s, n: b.netTransfers.filter((t) => t.hsp?.status === s).length }));

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Settlement #{b.seq} <BatchStatusChip status={b.status} />
          </span>
        }
        description={b.confirmedAt ? `Confirmed ${formatDateTime(b.confirmedAt)}` : `Started ${formatDateTime(b.createdAt)}`}
      />
      {b.status === "failed" && b.error && <p className="mb-5 rounded-lg bg-negative-soft px-4 py-3 text-sm text-negative">{b.error}</p>}

      <StatStrip
        stats={[
          { label: "Charges cleared", value: <span className="num">{formatInt(b.calls)}</span>, note: `${b.claims} claims, one per budget and service` },
          { label: "Owed before bundling", value: <Money atomic={b.gross} maxFraction={4} /> },
          {
            label: "Moved on chain",
            value: <Money atomic={b.net} maxFraction={4} />,
            note: gross > 0n ? `${(Number(((gross - net) * 1000n) / gross) / 10).toFixed(1)}% less than owed` : undefined,
            tone: "positive",
          },
          { label: "Compression", value: <span className="num">{formatRatio(b.transfers ? b.calls / b.transfers : 0)}</span>, note: `calls per transfer, ${b.transfers} transfers` },
        ]}
      />

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel
            title="Net transfers"
            description={
              <>
                Direct wallet-to-wallet transfers, each wrapped as one <HspTerm /> payment bound to this settlement
              </>
            }
            bodyClassName="p-0 sm:p-0"
          >
            <ul className="divide-y">
              {b.netTransfers.map((t) => (
                <TransferRow key={`${t.from}-${t.to}`} from={t.from} to={t.to} amount={t.amount} status={t.hsp?.status ?? null} className="sm:px-5">
                  {t.hsp?.reason && <p className="mt-2 text-[0.8125rem] text-muted-foreground">{t.hsp.reason}</p>}
                  {t.hsp?.paymentId && (
                    <p className="mt-1.5 text-xs text-subtle">
                      HSP payment <Hash value={t.hsp.paymentId} />
                    </p>
                  )}
                </TransferRow>
              ))}
            </ul>
          </Panel>

          <Panel title="Claims" description="The latest charge total per budget and service; the hub pays only what was not settled before" bodyClassName="p-0 sm:p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-normal">Budget</th>
                    <th className="px-3 py-2.5 font-normal">Service</th>
                    <th className="px-3 py-2.5 text-right font-normal">Charges</th>
                    <th className="px-3 py-2.5 text-right font-normal">Charge total</th>
                    <th className="px-5 py-2.5 text-right font-normal whitespace-nowrap">Paid this settlement</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {b.claimList.map((c) => (
                    <tr key={`${c.mandateId}-${c.payee}`}>
                      <td className="px-5 py-2.5">
                        <span className="block font-medium">{labelOf(c.mandateId) ?? "Budget"}</span>
                        <Hash value={c.mandateId} href={`/mandates/${c.mandateId}`} className="text-xs text-muted-foreground" />
                      </td>
                      <td className="px-3 py-2.5"><Address address={c.payee} explorer={false} copy={false} nameOnly /></td>
                      <td className="num px-3 py-2.5 text-right">{c.calls ?? "-"}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground"><Money atomic={c.cumulative} maxFraction={4} /></td>
                      <td className="px-5 py-2.5 text-right font-medium"><Money atomic={c.delta} maxFraction={4} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Finality b={b} />
          <Panel title="On chain">
            <Fields>
              <Field label="Transaction"><Hash value={b.txHash} kind="tx" /></Field>
              <Field label="Settlement id"><Hash value={b.id} /></Field>
              <Field label="Receipts root"><Hash value={b.receiptsRoot} /></Field>
              <Field label="Token"><Address address={b.token} showName={false} /></Field>
              {b.gasUsed && <Field label="Network fee used"><span className="num">{formatGas(b.gasUsed)}</span></Field>}
              {b.l1Fee && <Field label="L1 data fee"><span className="num">{formatNative(b.l1Fee)}</span></Field>}
              {b.attestation && <Field label="EAS attestation"><Hash value={b.attestation.uid} /></Field>}
            </Fields>
          </Panel>
          <Panel title={<><HspTerm /> status</>} description="What each status on a transfer means">
            <ul className="space-y-3.5">
              {counts.map(({ s, n }) => (
                <li key={s} className="flex gap-3">
                  <span className="w-[5.75rem] shrink-0">
                    <Chip tone={HSP_EXPLAIN[s].tone}>{s}</Chip>
                  </span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    <span className="num font-medium text-foreground">{n}</span> in this settlement. {HSP_EXPLAIN[s].text}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

/** "HSP" with its expansion on hover, for viewers who do not know HashKey's settlement protocol. */
function HspTerm() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <abbr tabIndex={0} className="cursor-help no-underline decoration-dotted underline-offset-2 hover:underline">
          HashKey settlement receipt
        </abbr>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">HashKey&apos;s standard record that the transfer matches this settlement (HSP, the HashKey Settlement Protocol): the paying agent co-signs it and a verifier checks it.</TooltipContent>
    </Tooltip>
  );
}

const TAG_TEXT: Record<string, string> = {
  safe: "the safe head: its settlement data is posted to Ethereum (about 24 s on HashKey Chain)",
  finalized: "the finalized head: Ethereum has finalized the settlement data",
  latest: "the latest head (local chain, no reorgs)",
};

/** Submitted, included at one confirmation, then final once the block is at or below the node's finality head. */
function Finality({ b }: { b: BatchDetail }) {
  const info = useInfo();
  const tag = info.data?.settlement?.confirmTag ?? "safe";
  const steps = [
    { label: "Sending", detail: "The settlement transaction left your server", at: b.submittedAt, done: Boolean(b.submittedAt) || b.status === "included" || b.status === "confirmed" },
    {
      label: "Sent",
      detail: b.blockNumber != null ? `In block ${formatInt(b.blockNumber)}, waiting to become final` : "In a block, waiting to become final",
      at: b.includedAt,
      done: b.status === "included" || b.status === "confirmed",
    },
    {
      label: "Final",
      detail: `Can no longer be reversed: the block is at or below ${TAG_TEXT[tag] ?? `the ${tag} head`}. Balances update only now.`,
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
