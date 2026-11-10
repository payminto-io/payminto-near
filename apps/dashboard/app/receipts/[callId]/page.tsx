"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, CircleDashed, RotateCw, XCircle } from "lucide-react";
import { isId32 } from "@payminto/protocol";
import { useBatches, useBudgets, useExplorer, useProof } from "@/lib/queries";
import { useDocumentTitle } from "@/lib/use-title";
import { formatDateTime, shortHash } from "@/lib/format";
import { replayProof } from "@/lib/merkle-path";
import { isVerified, proofChecks } from "@/lib/proof";
import { useChainProof, type ChainProof } from "@/lib/use-chain-proof";
import { useHubPosition } from "@/lib/use-hub-position";
import { isSellerSettled } from "@/lib/seller-settlement";
import { cn } from "@/lib/utils";
import type { ReceiptProof } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Address, CopyButton, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { AccountId } from "@/components/ds/account-id";
import { ProofPanel, type ProofVerdict } from "@/components/ds/proof-panel";
import { SellerSettledVerdict, SellerSettlementPanel, WrapId } from "@/components/app/seller-settled-proof";

const BACK = { href: "/receipts", label: "Proofs" };
const DESCRIPTION = "One paid Call, checked in this browser against the root stored on NEAR.";
const SELLER_DESCRIPTION = "One paid Call that its seller settled on the hub, checked in this browser against the hub's settled position on NEAR.";

export default function ProofPage() {
  const { callId } = useParams<{ callId: string }>();
  const q = useProof(callId);
  useDocumentTitle(q.data ? `Proof ${shortHash(callId)}` : null);

  if (!isId32(callId)) {
    return (
      <>
        <PageHeader back={BACK} title="Proof" />
        <ErrorState error={new Error(`"${callId}" is not a Call id. A Call id is 64 hex characters.`)} />
      </>
    );
  }
  if (q.isPending) {
    return (
      <>
        <PageHeader back={BACK} title="Proof" />
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
        <PageHeader back={BACK} title="Proof" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  return <ProofBody p={q.data} />;
}

function ProofBody({ p }: { p: ReceiptProof }) {
  const budgets = useBudgets();
  const batches = useBatches();
  const chain = useChainProof(p);
  // A Call its seller settled itself is in no batch: there is no root to read, so the hub's settled position is read instead.
  const seller = isSellerSettled(p);
  const position = useHubPosition(p, seller);
  const label = budgets.data?.find((m) => m.id === p.receipt.budgetId)?.label;
  const batchSeq = batches.data?.find((b) => b.id === p.batchId)?.seq;

  return (
    <>
      <PageHeader back={BACK} title="Call proof" description={seller ? SELLER_DESCRIPTION : DESCRIPTION} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {seller ? <SellerSettledVerdict p={p} position={position} /> : <Verdict p={p} chain={chain} />}
          <Panel title="Receipt" description="Signed by the Payminto server when it accepted the Call">
            <Fields>
              <Field label="Amount"><Money atomic={p.receipt.amount} /></Field>
              <Field label="Running total" hint="Running total the agent has signed to this Payee, including this Call"><Money atomic={p.receipt.cumulative} /></Field>
              <Field label="Payee"><Address address={p.receipt.payee} mode="wrap" /></Field>
              <Field label="Budget">
                <span className="flex flex-col gap-0.5">
                  {label && <span className="font-medium">{label}</span>}
                  <Hash value={p.receipt.budgetId} href={`/budgets/${p.receipt.budgetId}`} />
                </span>
              </Field>
              <Field label="Accepted at" hint="Attested by the node; the chain does not prove the time."><span className="font-mono text-[0.8125rem]">{formatDateTime(new Date(p.receipt.timestamp * 1000).toISOString())}</span></Field>
              <Field label="Request hash"><Hash value={p.receipt.requestHash} /></Field>
              <Field label="Node digest" hint="What the server signed when it accepted the Call."><Hash value={p.receipt.digest} /></Field>
              <Field label="Agent signature" hint="The voucher signature: it proves the agent authorized this exact request."><Hash value={p.receipt.voucherSig} /></Field>
              <Field label="Server key"><AccountId value={p.receipt.node} /></Field>
              <Field label="Server signature"><Hash value={p.receipt.nodeSignature} /></Field>
              {p.batchId && (
                <Field label="Settlement batch">
                  <span className="flex flex-col gap-0.5">
                    {batchSeq !== undefined && <span className="font-medium">Settlement batch #{batchSeq}</span>}
                    <Hash value={p.batchId} href={`/batches/${p.batchId}`} />
                  </span>
                </Field>
              )}
              {seller && (
                <Field label="Settled" hint="The seller settled its own voucher on the hub. The Call is settled, in no settlement batch.">
                  By the seller on the hub, in no settlement batch
                </Field>
              )}
            </Fields>
          </Panel>
        </div>
        {seller ? <SellerSettlementPanel p={p} /> : <MerklePath p={p} chain={chain} />}
      </div>
    </>
  );
}

const VERDICT_TEXT: Record<ProofVerdict, { title: string; body: string }> = {
  verified: { title: "Verified on NEAR", body: "This browser read the batch root from NEAR, rebuilt the path to it, and the hub contract agrees." },
  failed: { title: "Does not verify", body: "At least one check failed. Do not treat this Call as settled." },
  checking: { title: "Reading NEAR", body: "Reading the batch root and asking the hub, from this browser." },
  unreachable: { title: "Not checked yet", body: "" },
  waiting: { title: "Waiting for settlement", body: "Your server accepted and signed this Call. It becomes provable once its batch settles." },
};

/** The verdict first, then exactly what was read and from where, then each check that earns it. */
function Verdict({ p, chain }: { p: ReceiptProof; chain: ChainProof }) {
  const ex = useExplorer();
  const { read, leaf, source, hub } = chain;
  const checks = proofChecks(p, leaf, read);
  const verdict: ProofVerdict = !p.batchId
    ? "waiting"
    : checks.some((c) => c.state === "fail")
      ? "failed"
      : isVerified(checks)
        ? "verified"
        : read.state === "reading"
          ? "checking"
          : "unreachable";
  const text = VERDICT_TEXT[verdict];
  const body =
    verdict === "unreachable"
      ? read.state === "error"
        ? read.message
        : "This page has no NEAR RPC configured, so nothing was read. Set NEXT_PUBLIC_NEAR_RPC_URL."
      : text.body;
  const local = leaf ? replayProof(leaf, p.proof).root : null;
  const done = read.state === "done" ? read.check : null;
  const txHref = p.txHash ? (p.explorerUrl ?? ex.tx(p.txHash)) : null;
  const pending = (t: string) => <span className="text-muted-foreground">{t}</span>;

  return (
    <div className="flex flex-col gap-3">
      <ProofPanel
        verdict={verdict}
        title={text.title}
        body={body}
        action={
          read.state === "error" ? (
            <Button variant="outline" size="sm" onClick={chain.retry} className="h-11 sm:h-8">
              <RotateCw aria-hidden /> Read NEAR again
            </Button>
          ) : null
        }
        fields={[
          { label: "Call id", value: <WrapId value={p.receipt.callId} label="Call id" /> },
          ...(p.batchId
            ? [
                {
                  label: "Read from",
                  value: source ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs [overflow-wrap:anywhere]">{source.reader.rpcUrl}</span>
                      {source.demo && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">Demo, no network</span>}
                    </span>
                  ) : (
                    pending("No RPC configured")
                  ),
                },
                { label: "Hub", value: hub ? <AccountId value={hub} mode="wrap" /> : pending("Loading") },
                { label: "Batch id", value: <WrapId value={p.batchId} label="batch id" /> },
                {
                  label: "Root on NEAR",
                  value: done ? (
                    done.storedRoot ? (
                      <span className="flex flex-col gap-0.5">
                        <WrapId value={done.storedRoot} label="stored root" />
                        <span className="text-[0.6875rem] text-muted-foreground">Final block {done.blockHeight.toLocaleString("en-US")}</span>
                      </span>
                    ) : (
                      <span className="text-negative">The hub has no such batch</span>
                    )
                  ) : read.state === "reading" ? (
                    pending("Reading...")
                  ) : (
                    pending("Not read")
                  ),
                },
                {
                  label: "Recomputed root",
                  value: local ? (
                    <span className="flex flex-col gap-0.5">
                      <WrapId value={done?.recomputedRoot ?? local} label="recomputed root" />
                      {done?.storedRoot && (
                        <span className={cn("text-[0.6875rem] font-medium", done.rootMatches ? "text-positive" : "text-negative")}>
                          {done.rootMatches ? "Equals the root on NEAR" : "Differs from the root on NEAR"}
                        </span>
                      )}
                    </span>
                  ) : (
                    pending("Waiting for the hub and network")
                  ),
                },
                { label: "Settlement transaction", value: p.txHash ? <WrapId value={p.txHash} label="transaction hash" /> : pending("Not reported") },
              ]
            : [{ label: "Payee", value: <AccountId value={p.receipt.payee} mode="wrap" /> }]),
        ]}
        checks={checks.map((c) => ({ key: c.key, label: c.label, state: c.state, detail: c.detail }))}
        explorer={txHref ? { href: txHref, label: "Open in the NEAR explorer" } : null}
      />
      {!p.batchId && (
        <Button asChild variant="outline" className="h-11 self-start rounded-xl sm:h-9 sm:rounded-md">
          <Link href="/netting">Open the next settlement</Link>
        </Button>
      )}
    </div>
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
        <p className="hash text-xs [overflow-wrap:anywhere]">{value}</p>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** Every step from the leaf rebuilt here to the root, compared with the root this browser read from NEAR. */
function MerklePath({ p, chain }: { p: ReceiptProof; chain: ChainProof }) {
  const leaf = chain.leaf ?? p.leaf ?? null;
  const replay = useMemo(() => (leaf ? replayProof(leaf, p.proof) : null), [leaf, p.proof]);
  const stored = chain.read.state === "done" ? chain.read.check.storedRoot : null;
  const matches = stored && replay ? replay.root === stored : null;
  const verdictLine =
    chain.read.state === "done"
      ? stored
        ? matches
          ? "Equals the root this browser read from NEAR."
          : `Does not equal the root on NEAR, ${shortHash(stored)}.`
        : "The hub has no such batch on NEAR."
      : chain.read.state === "reading"
        ? "Reading the root from NEAR..."
        : "Not compared: NEAR was not read.";
  return (
    <Panel
      title="Merkle path"
      description={p.proof.length ? `${p.proof.length} sibling ${p.proof.length === 1 ? "hash" : "hashes"} from this Call to the batch root` : "No proof until the Call is in a settled batch"}
    >
      {!p.batchId || !replay ? (
        <div className="space-y-2">
          {leaf && <HashBox value={leaf} tone="leaf" label="Leaf (this Call)" />}
          <p className="text-sm text-muted-foreground">{!p.batchId ? "The path appears once a settlement batch includes this Call." : "Waiting for the hub and network to rebuild the leaf."}</p>
        </div>
      ) : (
        <ol className="relative space-y-0" aria-label="Proof steps from leaf to root">
          {replay.steps.map((s, i) => (
            <li key={s.level} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center">
                <span className="num flex size-7 items-center justify-center rounded-full border bg-card text-xs text-muted-foreground">{i}</span>
                <span aria-hidden className="w-px flex-1 bg-border" />
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 pb-4">
                <HashBox value={s.node} tone={i === 0 ? "leaf" : "node"} label={i === 0 ? "Leaf (rebuilt in this browser)" : `Level ${i} node`} />
                <HashBox value={s.sibling} tone="sibling" label={`Sibling ${s.siblingOnLeft ? "(left)" : "(right)"}`} />
                <p className="text-[0.6875rem] text-muted-foreground">sha256 of the sorted pair</p>
              </div>
            </li>
          ))}
          <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-full",
                matches === true ? "bg-positive-soft text-positive" : matches === false || (chain.read.state === "done" && !stored) ? "bg-negative-soft text-negative" : "bg-muted text-muted-foreground",
              )}
            >
              {matches === true ? <CheckCircle2 className="size-4" /> : matches === false || (chain.read.state === "done" && !stored) ? <XCircle className="size-4" /> : <CircleDashed className="size-4" />}
            </span>
            <div className="min-w-0 space-y-2">
              <HashBox value={replay.root} tone={matches ? "root" : undefined} label="Recomputed root" />
              <p className={cn("text-[0.8125rem]", matches === true ? "text-positive" : matches === false ? "text-negative" : "text-muted-foreground")}>{verdictLine}</p>
            </div>
          </li>
        </ol>
      )}
    </Panel>
  );
}
