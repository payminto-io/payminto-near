"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Circle, ExternalLink, MoreHorizontal, RotateCcw, ShieldCheck, Undo2 } from "lucide-react";
import { gk, useLinks, useMerchant, usePayment } from "@/lib/gateway-queries";
import { useToken } from "@/lib/queries";
import { useApi, useCan } from "@/lib/session";
import { useDocumentTitle } from "@/lib/use-title";
import { withBusiness } from "@/lib/merchant-scope";
import { formatDateTime, formatToken, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PaymentDetail, Refund, TimelineEvent } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Address, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip, PaymentStatusChip, RefundStatusChip } from "@/components/app/status";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { LineItems, OrderHash } from "@/components/checkout/parts";
import { RefundDialog, refundable } from "@/components/gateway/refund-dialog";
import { IntentsCard } from "@/components/gateway/intents-card";
import { anyChainMethodLabel, originPayer } from "@/lib/intents";

const METHOD_LABEL: Record<string, string> = { wallet: "Pay with a NEAR wallet", voucher: "AI agent with budget", oneclick: "Any chain (NEAR Intents)" };

/** How the payment was paid, naming the token and chain of an any-chain payment. */
function methodText(p: PaymentDetail): string | undefined {
  return p.method === "oneclick" ? anyChainMethodLabel(p, p.intents?.quotes) : p.method ? METHOD_LABEL[p.method] : undefined;
}

/** "from 0x5f2b...554f on Base" for an any-chain payer, "from alice.testnet" for a NEAR one. */
function PayerText({ payer }: { payer: string }) {
  const o = originPayer(payer);
  return o ? (
    <>
      from <span className="hash">{shortAddress(o.address, 6, 4)}</span> on {o.chain}
    </>
  ) : (
    <>
      from <span className="hash">{shortAddress(payer)}</span>
    </>
  );
}

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = usePayment(id);
  const merchant = useMerchant(q.data?.merchant_id);
  const links = useLinks();
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
  const can = useCan();
  const [refundOpen, setRefundOpen] = useState(false);
  const [retry, setRetry] = useState<Refund | null>(null);
  const back = { href: "/payments", label: "Payments" };
  useDocumentTitle(q.data ? `${formatToken(q.data.amount_due, t.symbol, t.decimals)} payment` : null);
  const cancel = useMutation({
    mutationFn: () => api.gateway.cancelPayment(id),
    onSuccess: () => {
      toast.success("Payment canceled. The checkout page now says so.");
      void qc.invalidateQueries({ queryKey: gk.all });
    },
    onError: (e) => toast.error(e.message),
  });

  const approve = useMutation({
    mutationFn: (refundId: string) => api.gateway.approveRefund(refundId),
    onSuccess: () => {
      toast.success("Refund approved. Send it with the payout wallet to finish.");
      void qc.invalidateQueries({ queryKey: gk.all });
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-56 animate-pulse rounded bg-muted" />} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <BlockSkeleton className="h-96" />
          <BlockSkeleton className="h-96" />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Payment" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const p = q.data;
  const link = links.data?.find((l) => l.id === p.link_id);
  const canRefund = refundable(p) > 0n;
  const paidOut = p.status === "paid" || p.status === "overpaid";

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Money atomic={p.amount_due} />
            <PaymentStatusChip status={p.status} late={p.late} />
            {p.refund_status !== "none" && <Chip tone="neutral">{p.refund_status === "full" ? "Refunded" : "Partly refunded"}</Chip>}
          </span>
        }
        description={
          <>
            {p.payer ? (originPayer(p.payer) ? <>Paid <PayerText payer={p.payer} /></> : <>Paid by <span className="hash">{shortAddress(p.payer)}</span></>) : "Not paid yet"}
            {p.payer && methodText(p) && <> - {methodText(p)}</>}
            {link ? <> via payment link <Link href={withBusiness(`/links/${link.id}`, p.merchant_id)} className="text-foreground hover:underline">{link.title}</Link></> : p.description ? <> - {p.description}</> : null}
          </>
        }
        actions={
          <>
            {/* The proof page reads the hub's record of a wallet payment; an any-chain payment's proof is its NEAR delivery. */}
            {paidOut && p.method !== "oneclick" && (
              <Button asChild variant="outline">
                <a href={`/receipt/${p.id}`} target="_blank" rel="noreferrer">
                  <ShieldCheck /> Payment proof
                </a>
              </Button>
            )}
            {can("refunds.request") && (
              <Button onClick={() => (setRetry(null), setRefundOpen(true))} disabled={!canRefund}>
                <Undo2 /> {can("refunds.issue") ? "Refund" : "Request refund"}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={p.checkout_url} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open checkout page
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={p.status !== "open" || cancel.isPending || !can("payments.write")} onSelect={() => cancel.mutate()}>
                  Cancel payment
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Timeline">
            <Timeline events={p.events} />
          </Panel>
          <Panel title="Payment breakdown">
            <Breakdown p={p} />
          </Panel>
          <Panel title="Money received" description="Each on-chain transfer or agent Call counted toward this payment" bodyClassName="p-0 sm:p-0">
            {p.credits.length === 0 ? (
              <EmptyState className="py-8" icon={<Circle className="size-4" />} title="No money received yet" />
            ) : (
              <ul className="divide-y">
                {p.credits.map((c, i) => (
                  <li key={`${c.tx_hash ?? c.batch_id}-${i}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5">
                    <span className="flex min-w-0 flex-col">
                      <Money atomic={c.amount} className="font-medium" />
                      <span className="text-xs text-muted-foreground">
                        {METHOD_LABEL[c.method]} {c.payer && <PayerText payer={c.payer} />}
                        {c.late && " - arrived late"}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {c.tx_hash ? <Hash value={c.tx_hash} kind="tx" /> : c.batch_id ? <Hash value={c.batch_id} href={`/batches/${c.batch_id}`} /> : null}
                      <Chip tone={c.status === "confirmed" ? "positive" : "info"}>{c.status === "confirmed" ? "Final" : "Sent"}</Chip>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {p.intents && p.intents.quotes.length > 0 && <IntentsCard intents={p.intents} />}
          <Panel title="Refunds" bodyClassName="p-0 sm:p-0">
            {p.refunds.length === 0 ? (
              <EmptyState className="py-8" icon={<Undo2 className="size-4" />} title="No refunds" action={canRefund && can("refunds.request") ? <Button variant="outline" onClick={() => (setRetry(null), setRefundOpen(true))}>{can("refunds.issue") ? "Refund this payment" : "Request a refund"}</Button> : undefined} />
            ) : (
              <ul className="divide-y">
                {p.refunds.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-5">
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2">
                        <Money atomic={r.amount} className="font-medium" /> <RefundStatusChip status={r.status} />
                        {r.approval === "requested" && r.status === "pending" && <Chip tone="warning">Waiting for approval</Chip>}
                        {r.approval === "approved" && r.status === "pending" && <Chip tone="info">Approved</Chip>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        To <span className="hash">{shortAddress(r.to)}</span> - {r.reason ?? "No reason"} - <TimeAgo iso={r.created_at} />
                      </span>
                      {r.note && (
                        <span className="mt-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Note:</span> {r.note} <span className="text-subtle">(only your team sees this)</span>
                        </span>
                      )}
                      {r.failure_reason && <span className="mt-1 text-xs text-negative">{r.failure_reason}</span>}
                    </span>
                    {r.tx_hash ? (
                      <Hash value={r.tx_hash} kind="tx" />
                    ) : r.approval === "requested" && r.status === "pending" ? (
                      can("refunds.approve") ? (
                        <Button size="sm" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
                          <Check /> Approve
                        </Button>
                      ) : null
                    ) : (r.status === "pending" || r.status === "failed") && can("refunds.issue") ? (
                      <Button size="sm" variant="outline" onClick={() => (setRetry(r), setRefundOpen(true))}>
                        <RotateCcw /> {r.status === "failed" ? "Retry" : "Send with wallet"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Details">
            <Fields>
              <Field label="Payment ID"><Hash value={p.id} /></Field>
              <Field label="Payment link">{link ? <Link href={withBusiness(`/links/${link.id}`, p.merchant_id)} className="hover:underline">{link.title}</Link> : <span className="text-muted-foreground">Created with the API</span>}</Field>
              <Field label="Reference">{p.reference ?? <span className="text-muted-foreground">-</span>}</Field>
              <Field label="Method">{methodText(p) ?? <span className="text-muted-foreground">Not chosen yet</span>}</Field>
              <Field label="Currency" hint="The stablecoin contract this payment is in.">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0">{t.symbol}</span> <Address address={p.token} showName={false} className="min-w-0" />
                </span>
              </Field>
              <Field label="Customer">{p.customer_name || p.customer_email ? <span className="flex flex-col">{p.customer_name && <span>{p.customer_name}</span>}{p.customer_email && <span className="text-muted-foreground">{p.customer_email}</span>}</span> : <span className="text-muted-foreground">-</span>}</Field>
              <Field label="Created"><span title={p.created_at}>{formatDateTime(p.created_at)}</span></Field>
              <Field label="Expires"><span title={p.expires_at}>{formatDateTime(p.expires_at)}</span></Field>
              {p.paid_at && <Field label="Paid"><span title={p.paid_at}>{formatDateTime(p.paid_at)}</span></Field>}
              <Field label="Order fingerprint" hint="A code that proves exactly what was bought (order_hash: keccak256 of the order JSON; the payment proof commits to it)."><OrderHash value={p.order_hash} /></Field>
            </Fields>
          </Panel>
          {p.line_items.length > 0 && (
            <Panel title="Order">
              <LineItems items={p.line_items} token={{ address: p.token, symbol: t.symbol, decimals: t.decimals }} />
            </Panel>
          )}
          {p.metadata && Object.keys(p.metadata).length > 0 && (
            <Panel title="Metadata">
              <Fields>
                {Object.entries(p.metadata).map(([k, v]) => (
                  <Field key={k} label={k}><span className="hash text-[0.8125rem]">{String(v)}</span></Field>
                ))}
              </Fields>
            </Panel>
          )}
        </div>
      </div>
      {refundOpen && <RefundDialog payment={p} merchant={merchant.data} open={refundOpen} onOpenChange={setRefundOpen} retry={retry} />}
    </>
  );
}

function Breakdown({ p }: { p: PaymentDetail }) {
  const rows: [string, string | bigint, string?][] = [
    ["Price", p.amount],
    ...(BigInt(p.surcharge) > 0n ? ([["Fee paid by customer", p.surcharge]] as [string, string][]) : []),
    ["Total to pay", p.amount_due],
    ["Amount received", p.amount_paid],
    ["Platform fee", `-${p.platform_fee}`],
    ["Payment method fee", `-${p.method_fee}`],
    ["You receive", p.net_amount, "font-semibold"],
    ...(BigInt(p.amount_refunded) > 0n ? ([["Refunded", `-${p.amount_refunded}`]] as [string, string][]) : []),
  ];
  return (
    <dl className="divide-y text-sm">
      {rows.map(([k, v, cls]) => (
        <div key={k} className={cn("flex justify-between gap-4 py-2 first:pt-0 last:pb-0", cls)}>
          <dt className={cls ? undefined : "text-muted-foreground"}>{k}</dt>
          <dd>
            <Money atomic={v} />
          </dd>
        </div>
      ))}
      <p className="pt-2 text-xs text-muted-foreground">Fees are split off on chain in the same transaction and are not returned on refunds. The network fee is covered by your Payminto server.</p>
    </dl>
  );
}

const EVENT_LABEL: Record<string, string> = {
  "payment.created": "Created",
  "checkout.opened": "Checkout opened",
  "wallet.connected": "Wallet connected",
  "authorization.signed": "Customer approved the payment",
  "transaction.broadcast": "Sent",
  "credit.confirmed": "Final",
  "payment.processing": "Confirming",
  "payment.partially_paid": "Partly paid",
  "payment.paid": "Paid",
  "payment.overpaid": "Paid extra",
  "payment.underpaid": "Ended partly paid",
  "payment.expired": "Expired",
  "payment.canceled": "Canceled",
  "payment.deposit_returned": "Deposit from another chain returned",
  "payment.deposit_failed": "Swap from another chain failed",
  "intents.quote_created": "Deposit address made (NEAR Intents)",
  "webhook.delivered": "Webhook delivered",
  "webhook.failed": "Webhook failed",
  "refund.created": "Refund created",
  "refund.requested": "Refund requested",
  "refund.approved": "Refund approved",
  "refund.succeeded": "Refund sent",
  "refund.failed": "Refund failed",
};

function humanize(type: string) {
  return EVENT_LABEL[type] ?? type.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Checked steps, oldest first, ending on the current state (Wise transaction updates). */
function shownAmount(d: Record<string, unknown>): string | null {
  if (typeof d.amount_paid === "string" && d.amount_paid !== "0") return d.amount_paid;
  if (typeof d.amount_due === "string") return d.amount_due;
  return typeof d.amount === "string" ? d.amount : null;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const t = useToken();
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;
  return (
    <ol className="relative">
      {events.map((e, i) => {
        const bad = /failed|expired|canceled|underpaid|returned/.test(e.type);
        const last = i === events.length - 1;
        const d = e.data ?? {};
        const extra = [
          // What moved at that moment: the amount received once money arrived, else the total to pay.
          typeof shownAmount(d) === "string" ? formatToken(shownAmount(d)!, t.symbol, t.decimals) : null,
          typeof d.confirmations === "number" ? `${d.confirmations} of ${d.confirmations} blocks` : null,
          typeof d.status_code === "number" ? `HTTP ${d.status_code}` : null,
          typeof d.event_type === "string" ? d.event_type : null,
        ].filter(Boolean);
        return (
          <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
            {!last && <span aria-hidden className="absolute top-5 bottom-0 left-[9px] w-px bg-border" />}
            <span className={cn("relative mt-0.5 flex size-[1.1875rem] shrink-0 items-center justify-center rounded-full", bad ? "bg-warning-soft text-warning" : "bg-positive-soft text-positive")}>
              <Check className="size-3" strokeWidth={3} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{humanize(e.type)}</p>
              <p className="text-xs text-muted-foreground">
                <time dateTime={e.created_at} title={new Date(e.created_at).toUTCString()}>
                  {formatDateTime(e.created_at)}
                </time>
                {extra.length > 0 && <> - {extra.join(" - ")}</>}
                {typeof d.tx_hash === "string" && <> - <span className="hash">{shortAddress(d.tx_hash, 10, 6)}</span></>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
