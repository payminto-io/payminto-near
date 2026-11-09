"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, CheckCircle2, CircleDashed, HelpCircle, X, XCircle } from "lucide-react";
import type { Hex } from "viem";
import { useBatches, useMandates, useProof } from "@/lib/queries";
import { useDocumentTitle } from "@/lib/use-title";
import { formatDateTime, shortHash } from "@/lib/format";
import { replayProof } from "@/lib/merkle-path";
import { isVerified, proofChecks, type CheckState } from "@/lib/proof";
import { cn } from "@/lib/utils";
import type { ReceiptProof } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Address, CopyButton, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

export default function ProofPage() {
  const { callId } = useParams<{ callId: string }>();
  const q = useProof(callId);
  const mandates = useMandates();
  const batches = useBatches();
  const back = { href: "/receipts", label: "Verify" };
  useDocumentTitle(q.data ? `Receipt ${shortHash(callId)}` : null);

  if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) {
    return (
      <>
        <PageHeader back={back} title="Verify" />
        <ErrorState error={new Error(`"${callId}" is not a call id. A call id is 0x followed by 64 hex characters.`)} />
      </>
    );
  }
  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title="Verify" />
        <BlockSkeleton className="h-24" />
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <BlockSkeleton className="h-96" />
          <BlockSkeleton className="h-96" />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Verify" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const p = q.data;
  const label = mandates.data?.find((m) => m.id === p.receipt.mandateId)?.label;
  const batchSeq = batches.data?.find((b) => b.id === p.batchId)?.seq;

  return (
    <>
      <PageHeader back={back} title="Charge receipt" description={<span className="hash break-all text-sm">{callId}</span>} />
      <Verdict p={p} />
      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel title="Receipt" description="Signed by the Payminto server when it accepted the charge">
          <Fields>
            <Field label="Amount"><Money atomic={p.receipt.amount} className="font-medium" /></Field>
            <Field label="Charge total" hint="Running total the agent has signed to this service, including this charge"><Money atomic={p.receipt.cumulative} /></Field>
            <Field label="Service"><Address address={p.receipt.payee} /></Field>
            <Field label="Budget">
              <span className="flex flex-col gap-0.5">
                {label && <span className="font-medium">{label}</span>}
                <Hash value={p.receipt.mandateId} href={`/mandates/${p.receipt.mandateId}`} />
              </span>
            </Field>
            <Field label="Accepted at">{formatDateTime(new Date(p.receipt.timestamp * 1000).toISOString())}</Field>
            <Field label="Request hash"><Hash value={p.receipt.requestHash} /></Field>
            <Field label="Leaf"><Hash value={p.leaf} /></Field>
            <Field label="Server"><Address address={p.receipt.node} /></Field>
            <Field label="Server signature"><Hash value={p.receipt.nodeSignature} /></Field>
            {p.batchId && (
              <Field label="Settlement">
                <span className="flex flex-col gap-0.5">
                  {batchSeq !== undefined && <span className="font-medium">Settlement #{batchSeq}</span>}
                  <Hash value={p.batchId} href={`/batches/${p.batchId}`} />
                </span>
              </Field>
            )}
            {p.txHash && <Field label="Settlement tx"><Hash value={p.txHash} kind="tx" /></Field>}
          </Fields>
        </Panel>
        <MerklePath p={p} />
      </div>
    </>
  );
}

const CHECK_ICON: Record<CheckState, { icon: typeof Check; className: string; label: string }> = {
  pass: { icon: Check, className: "bg-positive text-white dark:text-background", label: "Passed" },
  fail: { icon: X, className: "bg-negative text-white dark:text-background", label: "Failed" },
  pending: { icon: CircleDashed, className: "bg-muted text-muted-foreground", label: "Pending" },
  unknown: { icon: HelpCircle, className: "bg-muted text-muted-foreground", label: "Not evaluated" },
};

/** The verdict first, then each check that earns it, ticked one by one. */
function Verdict({ p }: { p: ReceiptProof }) {
  const pathMatches = useMemo(() => {
    if (!p.receiptsRoot || p.proof.length === 0) return null;
    return replayProof(p.leaf as Hex, p.proof as Hex[]).root.toLowerCase() === p.receiptsRoot.toLowerCase();
  }, [p.leaf, p.proof, p.receiptsRoot]);
  const checks = proofChecks(p, pathMatches);
  const verified = isVerified(checks);
  const failed = checks.some((c) => c.state === "fail");
  const settled = Boolean(p.batchId);

  const tone = verified ? "positive" : failed ? "negative" : "neutral";
  const Seal = verified ? CheckCircle2 : failed ? XCircle : CircleDashed;
  const title = verified ? "Verified on chain" : failed ? "Proof does not verify" : settled ? "Settled, on-chain check unavailable" : "Accepted, not settled yet";
  const body = verified
    ? "This exact charge is part of a finished settlement, and the settlement contract confirms it. Anyone can repeat this check."
    : failed
      ? "At least one check below failed. Do not treat this charge as settled."
      : settled
        ? "The settlement finished, but the server did not ask the hub to verify this receipt."
        : "Your server accepted and signed this charge. It becomes provable on chain once its settlement runs.";

  return (
    <section
      aria-label="Verification result"
      className={cn(
        "overflow-hidden rounded-xl border",
        tone === "positive" ? "border-positive/30 bg-positive-soft" : tone === "negative" ? "border-negative/30 bg-negative-soft" : "bg-card",
      )}
    >
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
        <span
          className={cn(
            "flex size-14 shrink-0 items-center justify-center rounded-full animate-in zoom-in-50 fade-in-0 duration-500",
            tone === "positive" ? "bg-positive text-white dark:text-background" : tone === "negative" ? "bg-negative text-white dark:text-background" : "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          <Seal className="size-7" strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={cn("text-xl font-semibold tracking-[-0.015em]", tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "")} role="status">
            {title}
          </h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{body}</p>
        </div>
        {!settled && (
          <Button asChild variant="outline" size="sm" className="self-start sm:self-center">
            <Link href="/netting">Open next settlement</Link>
          </Button>
        )}
      </div>
      <ol className="grid border-t border-current/10 bg-card/70 sm:grid-cols-2 xl:grid-cols-4" aria-label="Checks">
        {checks.map((c, i) => {
          const I = CHECK_ICON[c.state];
          return (
            <li
              key={c.key}
              className={cn("flex gap-3 px-5 py-4 animate-in fade-in-0 fill-mode-both", i > 0 && "max-sm:border-t sm:max-xl:[&:nth-child(n+3)]:border-t xl:border-l", i % 2 === 1 && "sm:border-l")}
              style={{ animationDelay: `${200 + i * 150}ms` }}
            >
              <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", I.className)}>
                <I.icon className="size-3" strokeWidth={3} aria-label={I.label} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.key === "onchain" ? <span className="hash text-[0.8125rem]">ClearingHub.verifyReceipt</span> : c.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{c.key === "onchain" && c.state === "pass" ? "Returned true. " : ""}{c.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function HashBox({ value, tone, label }: { value: string; tone?: "leaf" | "root" | "sibling" | "node"; label: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-md border px-2.5 py-1.5",
        tone === "leaf" && "border-primary/40 bg-accent",
        tone === "root" && "border-positive/40 bg-positive-soft",
        tone === "sibling" && "border-dashed bg-muted/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[0.6875rem] text-muted-foreground">{label}</p>
        <p className="hash truncate text-xs">{shortHash(value)}</p>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function MerklePath({ p }: { p: ReceiptProof }) {
  const replay = useMemo(() => replayProof(p.leaf as Hex, p.proof as Hex[]), [p.leaf, p.proof]);
  const matches = p.receiptsRoot ? replay.root.toLowerCase() === p.receiptsRoot.toLowerCase() : null;
  return (
    <Panel
      title="Merkle path"
      description={p.proof.length ? `${p.proof.length} sibling hashes from this call to the batch root` : "No proof until the call is in a settled batch"}
    >
      {p.proof.length === 0 ? (
        <div className="space-y-2">
          <HashBox value={p.leaf} tone="leaf" label="Leaf (this charge)" />
          <p className="text-sm text-muted-foreground">The path appears once a settlement includes this charge.</p>
        </div>
      ) : (
        <ol className="relative space-y-0" aria-label="Proof steps from leaf to root">
          {replay.steps.map((s, i) => (
            <li key={s.level} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center">
                <span className="num flex size-7 items-center justify-center rounded-full border bg-card text-xs text-muted-foreground">{i}</span>
                <span aria-hidden className="w-px flex-1 bg-border" />
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 pb-4 sm:grid-cols-2">
                <HashBox value={s.node} tone={i === 0 ? "leaf" : "node"} label={i === 0 ? "Leaf (this charge)" : `Level ${i} node`} />
                <HashBox value={s.sibling} tone="sibling" label={`Sibling ${s.siblingOnLeft ? "(left)" : "(right)"}`} />
                <p className="text-[0.6875rem] text-subtle sm:col-span-2">keccak256 of the sorted pair</p>
              </div>
            </li>
          ))}
          <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span className={cn("flex size-7 items-center justify-center rounded-full", matches ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
              {matches ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            </span>
            <div className="min-w-0 space-y-2">
              <HashBox value={replay.root} tone={matches ? "root" : undefined} label="Computed root" />
              <p className={cn("text-[0.8125rem]", matches ? "text-positive" : "text-negative")}>
                {matches ? "Equals the receiptsRoot stored on chain for this settlement." : `Does not equal the stored root ${p.receiptsRoot ? shortHash(p.receiptsRoot) : ""}.`}
              </p>
            </div>
          </li>
        </ol>
      )}
    </Panel>
  );
}
