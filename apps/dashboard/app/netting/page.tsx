"use client";

import { RequirePermission } from "@/components/app/states";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CheckCircle2, CircleDashed, Loader2, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { useApi, useCan } from "@/lib/session";
import { useLive } from "@/lib/live";
import { qk, useBatches, useNettingPreview, useToken } from "@/lib/queries";
import { plural, formatInt, formatRatio } from "@/lib/format";
import { beforeAfter, netPositions } from "@/lib/netting";
import { cn } from "@/lib/utils";
import type { BatchDetail, NettingPreview } from "@/lib/schemas";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FlowGraph } from "@/components/app/flow-graph";
import { Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { NettingHero } from "@/components/app/netting-hero";
import { TransferRow } from "@/components/app/transfer-row";
import { AccountText } from "@/components/ds/account-id";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/app/states";

type Phase = "idle" | "settling" | "done" | "failed";
const STEPS = [
  { key: "build", label: "Prepare the settlement" },
  { key: "submit", label: "Send the transaction" },
  { key: "confirm", label: "Final on NEAR" },
] as const;

function NettingPagePage() {
  const can = useCan();
  const api = useApi();
  const qc = useQueryClient();
  const preview = useNettingPreview();
  const token = useToken();
  const live = useLive();

  const [phase, setPhase] = useState<Phase>("idle");
  const [snapshot, setSnapshot] = useState<NettingPreview | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);

  const settle = useMutation({
    mutationFn: () => api.settle(),
    onMutate: () => {
      setStartedAt(Date.now());
      setSnapshot(preview.data ?? null);
      setPhase("settling");
      setError(null);
      setBatchId(null);
    },
    onSuccess: (res) => {
      if ("skipped" in res) {
        setPhase("idle");
        toast.info("Nothing settled", { description: res.skipped });
        return;
      }
      setBatchId(res.batchIds[0] ?? null);
    },
    onError: (e) => {
      setPhase("failed");
      setError(e instanceof ApiError ? e.message : "Settlement failed.");
    },
  });

  // The POST may return before the batch is confirmed on a live node; follow it until it is.
  const result = useQuery({
    queryKey: batchId ? qk.batch(batchId) : ["batch", "none"],
    queryFn: () => api.batch(batchId!),
    enabled: Boolean(batchId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "confirmed" || q.state.data.status === "failed") ? false : 1500),
  });

  useEffect(() => {
    const s = result.data?.status;
    if (s === "confirmed") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- phase follows the polled batch status
      setPhase("done");
      void qc.invalidateQueries();
    } else if (s === "failed") {
      setPhase("failed");
      setError(result.data?.error ?? "The settlement transaction failed.");
    }
  }, [result.data, qc]);

  // A settlement started elsewhere (the demo terminal, an auto-settle timer) plays out here exactly like a click.
  const [mountedAt] = useState(() => Date.now());
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (phase !== "idle" || settle.isPending) return;
    const started = live.events.find((e) => e.type === "batch.started" && !handled.current.has(e.id) && new Date(e.at).getTime() >= mountedAt - 1000);
    if (!started) return;
    handled.current.add(started.id);
    const id = (started.data.batch as { id?: string } | undefined)?.id;
    if (!id) return;
    // The phase follows a settlement the node announced over SSE.
    setStartedAt(Date.now() - 1000);
    setSnapshot(preview.data ?? null);
    setError(null);
    setBatchId(id);
    setPhase("settling");
  }, [live.events, phase, settle.isPending, preview.data, mountedAt]);

  const stepIndex = useMemo(() => {
    if (phase === "done") return 3;
    if (phase !== "settling") return -1;
    const mine = live.events.filter((e) => new Date(e.at).getTime() >= startedAt - 500);
    if (result.data?.status === "confirmed" || mine.some((e) => e.type === "batch.confirmed")) return 3;
    // Sent still waits for the transaction to be final before it counts.
    if (result.data?.status === "submitted" || mine.some((e) => e.type === "batch.submitted")) return 2;
    if (mine.some((e) => e.type === "batch.started")) return 1;
    return 0;
  }, [phase, live.events, result.data, startedAt]);

  const shown = phase === "idle" ? preview.data : snapshot ?? preview.data;
  // Netting is per account (a Budget owner on one side, a payee on the other), so parties are named by account. A service
  // name would mislabel an owner that also sells something, and say nothing about an account that sells nothing.
  const nameOf = (a: string) => a;

  return (
    <>
      <PageHeader
        title="Next settlement"
        description="What moves in the next bundled transfer. Payminto adds up who owes whom, so one transaction on the hub clears every Call and only each owner's net amount moves."
        actions={can("settlements.run") ? undefined : <span className="text-sm text-muted-foreground">A platform owner or admin runs settlements.</span>}
      />

      {preview.isPending && phase === "idle" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <BlockSkeleton className="h-[26rem]" />
          <BlockSkeleton className="h-[26rem]" />
        </div>
      ) : preview.isError && phase === "idle" ? (
        <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
      ) : !shown || (shown.gross.length === 0 && phase === "idle") ? (
        <NothingToNet />
      ) : (
        <>
          <NettingHero
            figures={beforeAfter(shown)}
            settled={phase === "done"}
            action={
              phase === "done" && result.data ? (
                <Confirmed
                  batch={result.data}
                  onBack={() => {
                    setPhase("idle");
                    setSnapshot(null);
                    setBatchId(null);
                  }}
                />
              ) : (
                <>
                  {(phase === "settling" || phase === "failed") && <Progress stepIndex={stepIndex} failed={phase === "failed"} error={error} />}
                  {phase !== "settling" && can("settlements.run") && (
                    <Button size="lg" className="h-12 w-full text-[0.9375rem]" onClick={() => settle.mutate()} disabled={shown.net.length === 0}>
                      {phase === "failed" ? "Try settling again" : "Settle now"} <ArrowRight />
                    </Button>
                  )}
                  {phase === "idle" && (
                    <p className="text-xs text-muted-foreground">
                      {"One transaction on the hub. It moves each owner's net amount from escrow to each creditor's balance on the hub, and a payout then sends that balance to the account. Your server pays the network fee."}
                    </p>
                  )}
                </>
              )
            }
          />
          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Panel
              title="Who owes whom"
              description={`${formatInt(shown.calls ?? 0)} ${plural(shown.calls ?? 0, "Call")} since the last settlement, grouped by account`}
            >
              <FlowGraph
                obligations={shown.gross}
                nameOf={nameOf}
                symbol={token.symbol}
                decimals={token.decimals}
                collapsed={phase === "settling" || phase === "done"}
              />
              <NetPositions preview={shown} />
            </Panel>

            <Panel
              title={phase === "done" ? "Settled" : "Transfers in the next settlement"}
              description={
                phase === "done"
                  ? "One transaction, verified and bundled on chain"
                  : `${shown.net.length} net ${shown.net.length === 1 ? "amount" : "amounts"} on the hub, from an owner's escrow to a creditor's balance`
              }
              bodyClassName="flex flex-col gap-5"
            >
              {phase === "done" && result.data ? (
                <SettledResult batch={result.data} />
              ) : (
                <>
                  <ul className="divide-y rounded-lg border">
                    {shown.net.map((t, i) => (
                      <TransferRow
                        key={`${t.from}-${t.to}`}
                        from={t.from}
                        to={t.to}
                        amount={t.amount}
                        marker={
                          <span className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                            {stepIndex >= 2 ? <Check className="size-3.5 text-positive" /> : i + 1}
                          </span>
                        }
                      />
                    ))}
                  </ul>
                  {(shown.skipped?.length ?? 0) > 0 && (
                    <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                      {shown.skipped!.length} budget(s) cannot pay right now and will stay pending: {shown.skipped!.map((s) => s.reason).join("; ")}
                    </p>
                  )}

                </>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function NetPositions({ preview }: { preview: NettingPreview }) {
  const rows = netPositions(preview.gross);
  const owes = new Map<string, bigint>();
  const owed = new Map<string, bigint>();
  for (const g of preview.gross) {
    owes.set(g.from, (owes.get(g.from) ?? 0n) + BigInt(g.amount));
    owed.set(g.to, (owed.get(g.to) ?? 0n) + BigInt(g.amount));
  }
  return (
    <div className="mt-5 border-t pt-4">
      <h3 className="text-sm font-medium">Net position per account</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">What each account owes minus what it is owed. Only these differences move.</p>
      <div className="mt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-normal">Account</th>
              <th className="py-2 pr-3 text-right font-normal max-sm:hidden">Owes</th>
              <th className="py-2 pr-3 text-right font-normal max-sm:hidden">Is owed</th>
              <th className="py-2 text-right font-normal">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.party}>
                <td className="py-2 pr-3">
                  <AccountText value={r.party} className="font-medium" />
                </td>
                <td className="py-2 pr-3 text-right text-muted-foreground max-sm:hidden">
                  <Money atomic={owes.get(r.party) ?? 0n} />
                </td>
                <td className="py-2 pr-3 text-right text-muted-foreground max-sm:hidden">
                  <Money atomic={owed.get(r.party) ?? 0n} />
                </td>
                <td className={cn("py-2 text-right font-medium", r.balance < 0n ? "text-negative" : r.balance > 0n ? "text-positive" : "text-muted-foreground")}>
                  <Money atomic={r.balance} signed unitClassName="text-current opacity-70" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Progress({ stepIndex, failed, error }: { stepIndex: number; failed: boolean; error: string | null }) {
  return (
    <ol className="space-y-2.5" aria-live="polite" aria-label="Settlement progress">
      {STEPS.map((s, i) => {
        const done = i < stepIndex;
        const current = i === stepIndex && !failed;
        return (
          <li key={s.key} className={cn("flex items-center gap-2.5 text-sm", !done && !current && "text-subtle")}>
            {done ? (
              <Check className="size-4 text-positive" />
            ) : current ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <CircleDashed className="size-4" />
            )}
            {s.label}
          </li>
        );
      })}
      {failed && <li className="pt-1 text-sm text-negative">{error}</li>}
    </ol>
  );
}

function Confirmed({ batch, onBack }: { batch: BatchDetail; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-3 animate-in fade-in-0 duration-500" role="status">
      <p className="flex items-center gap-2 font-medium text-positive">
        <CheckCircle2 className="size-5" /> Settlement #{batch.seq} confirmed
      </p>
      <p className="text-sm text-muted-foreground">Settled on NEAR in one transaction. The hub verified every Call signature and cap before moving funds.</p>
      <div className="text-sm">
        <p className="text-xs text-muted-foreground">Settlement transaction</p>
        <Hash value={batch.txHash} kind="tx" className="mt-0.5" />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row xl:flex-col">
        <Button asChild className="flex-1">
          <Link href={`/batches/${batch.id}`}>Open settlement #{batch.seq}</Link>
        </Button>
        <Button variant="outline" className="flex-1" onClick={onBack}>
          Back to next settlement
        </Button>
      </div>
    </div>
  );
}

function SettledResult({ batch }: { batch: BatchDetail }) {
  return (
    <div className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Calls cleared</dt>
          <dd className="num font-medium">{formatInt(batch.calls)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Owed before bundling</dt>
          <dd><Money atomic={batch.gross} /></dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Moved on chain</dt>
          <dd><Money atomic={batch.net} className="font-medium" /></dd>
        </div>
      </dl>
      <ul className="divide-y rounded-lg border">
        {batch.netTransfers.map((t, i) => (
          <TransferRow
            key={`${t.from}-${t.to}`}
            from={t.from}
            to={t.to}
            amount={t.amount}
            marker={
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-positive-soft">
                <Check className="size-3.5 text-positive" />
              </span>
            }
            className="animate-in fade-in-0 fill-mode-both"
            style={{ animationDelay: `${150 + i * 120}ms` }}
          />
        ))}
      </ul>
    </div>
  );
}

/** Empty netting: says what the last batch did, so a just-settled node does not look like it lost its data. */
function NothingToNet() {
  const batches = useBatches();
  const last = batches.data?.find((b) => b.status === "confirmed");
  return (
    <Panel>
      <EmptyState
        icon={last ? <CheckCircle2 className="size-4 text-positive" /> : <Waypoints className="size-4" />}
        title={last ? "All caught up" : "Nothing to settle yet"}
        action={
          last ? (
            <Button asChild>
              <Link href={`/batches/${last.id}`}>Open settlement #{last.seq}</Link>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/batches">See all settlements</Link>
            </Button>
          )
        }
      >
        {last ? (
          <>
            Settlement #{last.seq} cleared <span className="num">{formatInt(last.calls)}</span> Calls in{" "}
            <span className="num">{last.transfers}</span> on-chain {last.transfers === 1 ? "transfer" : "transfers"} (
            <span className="num">{formatRatio(last.transfers ? last.calls / last.transfers : 0)}</span> Calls per transfer). New Calls appear here as they are accepted.
          </>
        ) : (
          "Calls accepted since the last settlement appear here. Run your agents against a paid service, then come back to settle."
        )}
      </EmptyState>
    </Panel>
  );
}

export default function NettingPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <NettingPagePage />
    </RequirePermission>
  );
}
