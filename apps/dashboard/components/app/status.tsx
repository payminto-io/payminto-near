"use client";

import type { ReactNode } from "react";
import { DENIAL_RULES, type RetryHint } from "@payminto/protocol";
import { cn } from "@/lib/utils";
import type { BatchStatus, BudgetStatus, PaymentStatus, RefundStatus } from "@/lib/schemas";
import { PAYMENT_STATUS_META } from "@/lib/gateway";
import { RULE_INFO, isHubUnreadable, refusalReason, refusalTitle, ruleTitle } from "@/lib/denials";
import { callStatusLabel } from "@/lib/seller-settlement";
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

const BATCH: Record<BatchStatus, { tone: Tone; label: string }> = {
  building: { tone: "neutral", label: "Preparing" },
  submitted: { tone: "info", label: "Sending" },
  confirmed: { tone: "positive", label: "Final" },
  failed: { tone: "negative", label: "Failed" },
  unknown: { tone: "warning", label: "Checking the hub" },
};

export function BatchStatusChip({ status }: { status: BatchStatus }) {
  const b = BATCH[status];
  return <Chip tone={b.tone}>{b.label}</Chip>;
}

const BUDGET: Record<BudgetStatus, { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "Opening" },
  open: { tone: "positive", label: "Active" },
  revoked: { tone: "neutral", label: "Stopped" },
  expired: { tone: "neutral", label: "Expired" },
  failed: { tone: "negative", label: "Failed" },
};

export function BudgetStatusChip({ status }: { status: BudgetStatus }) {
  const m = BUDGET[status];
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

/** A Call's status. One its seller settled on the hub is settled, and says so: it is in no batch and has no Merkle proof. */
export function CallStatusChip({ status, settledBy }: { status: string; settledBy?: "batch" | "seller" | null }) {
  const label = callStatusLabel({ status, settledBy });
  if (status === "settled") return <Chip tone="positive">{label}</Chip>;
  if (status === "settling") return <Chip tone="info">{label}</Chip>;
  return <Chip tone="warning">{label}</Chip>;
}

/** The rule that refused a Call. With the node's `retry` hint it names a hub that could not be read as that, not as the rule. */
export function RuleChip({ rule, retry }: { rule: keyof typeof DENIAL_RULES; retry?: RetryHint }) {
  if (retry && isHubUnreadable(retry)) return <Explained chip={<Chip tone="negative">{refusalTitle(rule, retry)}</Chip>} text={`${refusalReason(rule, retry)} (${rule})`} />;
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
