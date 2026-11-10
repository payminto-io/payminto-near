"use client";

import { CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import type { IntentsQuote, PaymentIntents } from "@/lib/schemas";
import { amountText, QUOTE_STATUS, refundReasonText, verificationText } from "@/lib/intents";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Field, Fields, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { CopyAction, CopyIcon } from "@/components/checkout/parts";
import { IntentsLabel, TxValue } from "@/components/checkout/intents";
import { CodeBlock } from "./kit";

/**
 * A payment's "NEAR Intents" card: for each deposit address the buyer asked for, where the money came from, how much,
 * what 1Click did with it, the NEAR delivery and how the server checked it, and the signed quote kept for disputes.
 */
export function IntentsCard({ intents }: { intents: PaymentIntents }) {
  const quotes = [...intents.quotes].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <Panel
      title="NEAR Intents"
      description={quotes.length === 1 ? "The buyer paid from another chain through 1Click; the USDC goes straight to your NEAR account." : `${quotes.length} deposit addresses, newest first. The USDC goes straight to your NEAR account.`}
      actions={<IntentsLabel mode={intents.mode} label={intents.label} />}
      bodyClassName="p-0 sm:p-0"
    >
      <ul className="divide-y">
        {quotes.map((q) => (
          <li key={q.id} className="px-4 py-4 sm:px-5">
            <QuoteBlock q={q} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function QuoteBlock({ q }: { q: IntentsQuote }) {
  const s = QUOTE_STATUS[q.status];
  const reason = refundReasonText(q.refund_reason);
  const checked = q.verification === "rpc_checked";
  const ended = ["refunded", "failed", "expired"].includes(q.status);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {q.origin.symbol} on {q.origin.chain_name}
        </p>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <Fields>
        <Field label="Amount sent">
          {q.deposited ? <span className="num font-medium">{amountText(q.deposited)}</span> : <span className="text-muted-foreground">Nothing yet</span>}
          <span className="block text-xs text-muted-foreground">Asked for {amountText(q.send_exactly)}, at least {amountText(q.min_amount_in)}</span>
        </Field>
        <Field label={ended ? "Invoice amount" : "You receive"}>
          <span className="num font-medium">{q.delivered ? amountText(q.delivered) : amountText(q.amount_out)}</span>
          <span className="block text-xs text-muted-foreground">
            {q.delivered ? "Delivered to" : ended ? "Nothing reached" : "To"} <span className="hash">{q.recipient}</span>
          </span>
        </Field>
        <Field label="Deposit address">
          <span className="inline-flex max-w-full items-start gap-0.5">
            <span className="hash text-[0.8125rem] [overflow-wrap:anywhere]">{q.deposit_address}</span>
            <CopyIcon value={q.deposit_address} label="deposit address" />
          </span>
        </Field>
        <Field label="Refund address">
          <span className="inline-flex max-w-full items-start gap-0.5">
            <span className="hash text-[0.8125rem] [overflow-wrap:anywhere]">{q.refund_to}</span>
            <CopyIcon value={q.refund_to} label="refund address" />
          </span>
        </Field>
        <Field label="1Click status">
          {q.provider_status ? <span className="hash text-[0.8125rem]">{q.provider_status}</span> : <span className="text-muted-foreground">Not reported yet</span>}
        </Field>
        <Field label={`${q.origin.chain_name} deposit`}>
          {q.origin_txs.length ? (
            <span className="flex flex-col items-start gap-1">
              {q.origin_txs.map((t) => (
                <TxValue key={t.hash} tx={t} />
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </Field>
        <Field label="NEAR delivery">{q.delivery_tx ? <TxValue tx={q.delivery_tx} /> : <span className="text-muted-foreground">-</span>}</Field>
        <Field label="Delivery check">
          {ended ? (
            <span className="text-muted-foreground">Nothing was delivered</span>
          ) : (
          <span className={cn("inline-flex items-center gap-1.5", checked ? "text-positive" : q.verification === "provider_only" ? "text-warning" : "text-muted-foreground")}>
            {checked ? <CircleCheck className="size-4" aria-hidden /> : q.verification === "provider_only" ? <CircleAlert className="size-4" aria-hidden /> : <Clock3 className="size-4" aria-hidden />}
            {verificationText(q.verification)}
          </span>
          )}
        </Field>
        {(q.refunded || q.status === "refunded") && (
          <Field label="Returned to buyer">
            {q.refunded ? <span className="num font-medium">{amountText(q.refunded)}</span> : "Yes"}
            {reason && <span className="block text-xs text-muted-foreground">Reason: {reason}</span>}
          </Field>
        )}
        <Field label="Quote signature">
          <span className={cn("inline-flex items-center gap-1.5", q.signature_valid ? "text-positive" : "text-negative")}>
            {q.signature_valid ? <CircleCheck className="size-4" aria-hidden /> : <CircleAlert className="size-4" aria-hidden />}
            {q.signature_valid ? "Valid" : "Not valid"}
          </span>
          <span className="block text-xs text-muted-foreground">
            Correlation id <span className="hash">{q.correlation_id}</span>
          </span>
        </Field>
        <Field label="Address deadline">
          <span className="num" title={q.deadline}>
            {formatDateTime(q.deadline)}
          </span>
        </Field>
      </Fields>
      {q.quote_response !== undefined && (
        <details className="group rounded-lg border">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-sm font-medium focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
            Signed 1Click answer, kept for disputes
            <span className="text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
          </summary>
          <div className="border-t p-3">
            <CodeBlock code={JSON.stringify(q.quote_response, null, 2)} label="Signed 1Click answer" copy={<CopyAction value={JSON.stringify(q.quote_response)} label="Copy" className="h-7 px-2 text-xs" />} />
          </div>
        </details>
      )}
    </div>
  );
}
