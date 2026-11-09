"use client";

import type { ReactNode } from "react";
import { DENIAL_RULES } from "@payminto/protocol";
import { cn } from "@/lib/utils";
import type { BatchStatus, HspStatus, MandateStatus, PaymentStatus, RefundStatus } from "@/lib/schemas";
import { PAYMENT_STATUS_META } from "@/lib/gateway";
import { RULE_INFO, ruleTitle } from "@/lib/denials";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Tone = "positive" | "warning" | "negative" | "info" | "neutral";

const toneClass: Record<Tone, string> = {
  positive: "bg-positive-soft text-positive",
  warning: "bg-warning-soft text-warning",
  negative: "bg-negative-soft text-negative",
  info: "bg-info-soft text-primary",
  neutral: "bg-muted text-muted-foreground",
};

export function Chip({ tone, children, className, dot = true }: { tone: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-[1.375rem] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", toneClass[tone], className)}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

function Explained({ chip, text }: { chip: ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-full">
          {chip}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left">{text}</TooltipContent>
    </Tooltip>
  );
}

export const HSP_EXPLAIN: Record<HspStatus, { tone: Tone; label: string; text: string }> = {
  ACCEPT: {
    tone: "positive",
    label: "Matched",
    text: "HashKey settlement receipt: the transfer was seen and matches this settlement (HSP ACCEPT).",
  },
  SETTLED: {
    tone: "positive",
    label: "Settled",
    text: "HashKey's coordinator saw the transaction and marked it settled (HSP SETTLED).",
  },
  UNSIGNED: {
    tone: "warning",
    label: "Not co-signed",
    text: "Settled on chain from charges the agents signed. The paying agent did not co-sign the HashKey record in time (HSP UNSIGNED).",
  },
  REJECT: {
    tone: "negative",
    label: "Not matched",
    text: "The transfer happened on chain, but HashKey's check found something the receipt does not cover, so it does not vouch for it (HSP REJECT).",
  },
  PENDING: { tone: "neutral", label: "Waiting", text: "Waiting for the paying agent to co-sign the HashKey record (HSP PENDING)." },
  COSIGNED: { tone: "info", label: "Co-signed", text: "The paying agent co-signed; waiting for the settlement transaction (HSP COSIGNED)." },
  SUBMITTED: { tone: "info", label: "Submitted", text: "Sent to HashKey's coordinator; waiting for it to see the transaction (HSP SUBMITTED)." },
  FAILED: { tone: "negative", label: "Retrying", text: "The HashKey record failed and will be retried. Balances are not affected (HSP FAILED)." },
};

export function HspChip({ status }: { status: HspStatus | null | undefined }) {
  if (!status) return <Chip tone="neutral">No HashKey record</Chip>;
  const e = HSP_EXPLAIN[status];
  return <Explained chip={<Chip tone={e.tone}>{e.label}</Chip>} text={e.text} />;
}

const BATCH: Record<BatchStatus, { tone: Tone; label: string }> = {
  building: { tone: "neutral", label: "Preparing" },
  cosigning: { tone: "info", label: "Co-signing" },
  submitted: { tone: "info", label: "Sending" },
  included: { tone: "info", label: "Sent" },
  confirmed: { tone: "positive", label: "Final" },
  failed: { tone: "negative", label: "Failed" },
};

export function BatchStatusChip({ status }: { status: BatchStatus }) {
  const b = BATCH[status];
  return <Chip tone={b.tone}>{b.label}</Chip>;
}

const MANDATE: Record<MandateStatus, { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "Opening" },
  open: { tone: "positive", label: "Active" },
  revoked: { tone: "neutral", label: "Stopped" },
  expired: { tone: "neutral", label: "Expired" },
  failed: { tone: "negative", label: "Failed" },
};

export function MandateStatusChip({ status }: { status: MandateStatus }) {
  const m = MANDATE[status];
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

export function CallStatusChip({ status }: { status: string }) {
  if (status === "settled") return <Chip tone="positive">Settled</Chip>;
  if (status === "settling") return <Chip tone="info">Settling</Chip>;
  return <Chip tone="warning">In next settlement</Chip>;
}

export function RuleChip({ rule }: { rule: keyof typeof DENIAL_RULES }) {
  return <Explained chip={<Chip tone="negative">{ruleTitle(rule)}</Chip>} text={`${DENIAL_RULES[rule]} (${rule})`} />;
}

const KIND: Record<"attack" | "limit" | "state", { tone: Tone; label: string }> = {
  attack: { tone: "negative", label: "Attack" },
  limit: { tone: "warning", label: "Over a limit" },
  state: { tone: "neutral", label: "Budget not usable" },
};

/** What kind of refusal this was, beside its plain title; the rule code stays in the tooltip. */
export function RuleKindChip({ rule }: { rule: keyof typeof DENIAL_RULES }) {
  const k = KIND[RULE_INFO[rule]?.kind ?? "state"];
  return <Explained chip={<Chip tone={k.tone}>{k.label}</Chip>} text={`${DENIAL_RULES[rule]} (${rule})`} />;
}

export function PaymentStatusChip({ status, late }: { status: PaymentStatus; late?: boolean }) {
  const m = PAYMENT_STATUS_META[status];
  return (
    <Chip tone={m.tone}>
      {m.label}
      {late ? <span className="font-normal opacity-80">, late</span> : null}
    </Chip>
  );
}

const REFUND: Record<RefundStatus, { tone: Tone; label: string }> = {
  pending: { tone: "warning", label: "Not sent yet" },
  succeeded: { tone: "positive", label: "Sent" },
  failed: { tone: "negative", label: "Failed" },
  canceled: { tone: "neutral", label: "Canceled" },
};

export function RefundStatusChip({ status }: { status: RefundStatus }) {
  const r = REFUND[status];
  return <Chip tone={r.tone}>{r.label}</Chip>;
}

/** 2xx positive, 4xx and 5xx negative, no response (timeout) warning, still queued neutral. */
/**
 * One delivery attempt: its HTTP code, or why there is none. With no response, a timeout is told apart from a
 * connection that never opened (refused, DNS, TLS), which is a different fix on the merchant's side.
 */
export function DeliveryChip({ status, code, error }: { status: "pending" | "succeeded" | "failed"; code: number | null | undefined; error?: string | null }) {
  if (status === "pending" && code == null) return <Chip tone="neutral">Queued</Chip>;
  if (code == null) return /time ?out|abort/i.test(error ?? "timeout") ? <Chip tone="warning">Timeout</Chip> : <Chip tone="negative">No connection</Chip>;
  return (
    <Chip tone={code >= 200 && code < 300 ? "positive" : "negative"} className="num">
      {code}
    </Chip>
  );
}
