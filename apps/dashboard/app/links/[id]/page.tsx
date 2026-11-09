"use client";

import { Suspense, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, MoreHorizontal, Share2 } from "lucide-react";
import { gk, useLink, usePayments } from "@/lib/gateway-queries";
import { useToken } from "@/lib/queries";
import { useApi, useCan } from "@/lib/session";
import { useDocumentTitle } from "@/lib/use-title";
import { linkExpiry, linkPrice, toLocalInput, type ExpiryChoice } from "@/lib/gateway";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ExpiryField } from "@/components/gateway/link-expiry";
import { formatDateTime, formatInt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { CopyAction } from "@/components/checkout/parts";
import { ShareSheet } from "@/components/gateway/share-sheet";
import { PaymentRow } from "@/components/gateway/payment-row";

export default function LinkDetailPage() {
  return (
    <Suspense>
      <LinkDetail />
    </Suspense>
  );
}

function LinkDetail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const q = useLink(id);
  const payments = usePayments({ link_id: id, limit: 20 });
  const t = useToken();
  const api = useApi();
  const qc = useQueryClient();
  const can = useCan();
  const [share, setShare] = useState(params.get("share") === "1");
  const [expiryOpen, setExpiryOpen] = useState(false);
  useDocumentTitle(q.data?.title ?? null);
  const toggle = useMutation({
    mutationFn: (active: boolean) => api.gateway.updateLink(id, { active }),
    onSuccess: (l) => {
      toast.success(l.active ? "Link turned on" : "Link turned off. Customers now see that it is no longer active.");
      void qc.invalidateQueries({ queryKey: gk.all });
    },
    onError: (e) => toast.error(e.message),
  });
  const back = { href: "/links", label: "Payment links" };

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-56 animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-24" />
        <BlockSkeleton className="mt-5 h-72" />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Payment link" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const l = q.data;
  // When every payment of the link is loaded, count them here; the node's counts are only a fallback for longer lists.
  const counts: Record<string, number> =
    payments.data && !payments.data.nextCursor
      ? payments.data.items.reduce<Record<string, number>>((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {})
      : (payments.data?.counts ?? {});
  const terminal = ["paid", "overpaid", "underpaid", "expired", "canceled"].reduce((a, s) => a + (counts[s] ?? 0), 0);
  const paid = (counts.paid ?? 0) + (counts.overpaid ?? 0);

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {l.title}{" "}
            <Chip tone={!l.active ? "neutral" : l.expired ? "warning" : "positive"}>{!l.active ? "Turned off" : l.expired ? "Expired" : "Active"}</Chip>
          </span>
        }
        description={linkPrice(l, t)}
        actions={
          <>
            <CopyAction value={l.url} label="Copy link" />
            <Button onClick={() => setShare(true)}>
              <Share2 /> Share
            </Button>
            {can("links.write") && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setExpiryOpen(true)}>Change expiry</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => toggle.mutate(!l.active)}>{l.active ? "Turn off link" : "Turn on link"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => api.gateway.updateLink(id, { listed: !l.listed }).then(() => qc.invalidateQueries({ queryKey: gk.all }))}>
                  {l.listed ? "Stop listing for AI agents" : "List for AI agents"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </>
        }
      />
      <StatStrip
        stats={[
          { label: "Payments", value: <span className="num">{formatInt(l.payments_count)}</span>, note: l.max_payments ? `of ${formatInt(l.max_payments)} allowed` : "no limit" },
          { label: "Volume", value: <Money atomic={l.paid_total} maxFraction={2} />, note: "paid, including extra" },
          { label: "Conversion", value: <span className="num">{terminal ? `${Math.round((paid / terminal) * 100)}%` : "-"}</span>, note: "paid of finished checkouts" },
        ]}
      />
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Panel title="Payments through this link" bodyClassName="p-0 sm:p-0">
          {payments.isPending ? (
            <RowsSkeleton className="px-5" rows={4} />
          ) : payments.isError ? (
            <ErrorState className="m-4" error={payments.error} onRetry={() => void payments.refetch()} />
          ) : payments.data.items.length === 0 ? (
            <EmptyState icon={<CreditCard className="size-4" />} title="No payments yet" action={<Button variant="outline" onClick={() => setShare(true)}>Share the link</Button>} />
          ) : (
            <ul className="stagger divide-y">
              {payments.data.items.map((p) => (
                <PaymentRow key={p.id} p={p} linkTitle={l.title} />
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Details">
          <Fields>
            <Field label="URL"><span className="hash text-[0.8125rem] break-all">{l.url}</span></Field>
            <Field label="Link ID"><Hash value={l.id} /></Field>
            <Field label="Price">{linkPrice(l, t)}</Field>
            <Field label="Description">{l.description ?? <span className="text-muted-foreground">-</span>}</Field>
            <Field label="Collects">{[l.collect_email && "Email", l.collect_name && "Name"].filter(Boolean).join(", ") || <span className="text-muted-foreground">Nothing</span>}</Field>
            <Field label="Expires">
              {l.expires_at ? (
                <span className={l.expired ? "text-warning" : undefined}>
                  {l.expired ? "Expired " : ""}
                  {formatDateTime(String(l.expires_at))}
                </span>
              ) : (
                <span className="text-muted-foreground">Never</span>
              )}
            </Field>
            <Field label="After payment">{l.success_url ? <span className="break-all">{l.success_url}</span> : <span className="text-muted-foreground">Stays on the payment proof</span>}</Field>
            <Field label="AI agents" hint="Listed links can be found by agents with their price automatically.">{l.listed ? "Listed for AI agents" : "Not listed"}</Field>
            <Field label="Created">{formatDateTime(l.created_at)}</Field>
          </Fields>
        </Panel>
      </div>
      <ShareSheet link={l} open={share} onOpenChange={setShare} />
      {expiryOpen && <ExpiryDialog id={id} current={l.expires_at ?? null} onClose={() => setExpiryOpen(false)} />}
    </>
  );
}

function ExpiryDialog({ id, current, onClose }: { id: string; current: string | number | null; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<ExpiryChoice>(current ? "custom" : "never");
  const [custom, setCustom] = useState(toLocalInput(current));
  const e = linkExpiry(choice, custom);
  const save = useMutation({
    mutationFn: () => api.gateway.updateLink(id, { expires_at: e.ok ? e.iso : null }),
    onSuccess: () => {
      toast.success(e.ok && e.iso ? "Expiry saved." : "This link no longer expires.");
      void qc.invalidateQueries({ queryKey: gk.all });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[26rem]">
        <DialogHeader>
          <DialogTitle>Change expiry</DialogTitle>
          <DialogDescription>Payments already made are not affected.</DialogDescription>
        </DialogHeader>
        <ExpiryField choice={choice} custom={custom} onChoice={setChoice} onCustom={setCustom} error={e.ok ? null : choice === "custom" && custom ? e.error : null} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!e.ok || save.isPending}>
            Save expiry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
