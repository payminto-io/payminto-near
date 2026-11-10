import type { ReactNode } from "react";
import Link from "next/link";
import { RotateCcw, ShieldBan } from "lucide-react";
import { cn } from "@/lib/utils";
import { VerdictWords } from "./payee-verdict";

/** A reason or a hint may name an account or a date: both stay on one line, and neither is parsed as markup. */
const NO_ACCOUNTS: readonly string[] = [];

export type RefusalKind = "attack" | "limit" | "state";

const KIND: Record<RefusalKind, { label: string; className: string }> = {
  attack: { label: "Attack", className: "bg-negative-soft text-negative" },
  // The one sanctioned exception to the three-colour rule: an honest agent over a limit reads as waiting, not refused.
  limit: { label: "Over a limit", className: "bg-warning-soft text-warning" },
  state: { label: "Budget not usable", className: "bg-muted text-muted-foreground" },
};

/** "No money moved", stated in so many words next to every Refusal. */
export function NoMoneyMoved({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-positive", className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      No money moved
    </span>
  );
}

/**
 * Why a Call was stopped (decision 8): who tried to pay whom and how much, the reason in one sentence, the rule code,
 * the attempted amount, what remains in the Budget and the retry hint. A Refusal is the system working, so it never says
 * "error" or "failed".
 */
export function RefusalReason({
  title,
  kind,
  kindLabel,
  rule,
  agent,
  payee,
  attempted,
  remaining,
  reason,
  retry,
  budget,
  time,
  action,
  as: Tag = "li",
  className,
}: {
  title: string;
  kind: RefusalKind;
  /** Names the kind more precisely in the same tone, for a Refusal that is not about the Budget ("Hub not readable"). */
  kindLabel?: string;
  /** The machine rule code, for example PER_CALL_CAP. */
  rule: string;
  agent: ReactNode;
  payee: ReactNode | null;
  attempted: ReactNode;
  /** Remaining Budget under its cap; null when the Budget is unknown. */
  remaining: ReactNode | null;
  reason: string;
  retry: string;
  budget?: { label: string; href: string } | null;
  time: ReactNode;
  /** An owner action that resolves the Refusal, such as moving credit into the Budget. */
  action?: ReactNode;
  as?: "li" | "div";
  className?: string;
}) {
  const k = KIND[kind];
  return (
    <Tag className={cn("flex gap-3 px-4 py-3.5 sm:px-5", className)}>
      <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-negative-soft text-negative">
        <ShieldBan className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{title}</span>
          <span className={cn("inline-flex h-[1.375rem] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", k.className)}>
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {kindLabel ?? k.label}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="text-foreground">{agent}</span> tried to pay {payee ? <span className="text-foreground">{payee}</span> : "a paid service"} {attempted}. <VerdictWords accounts={NO_ACCOUNTS}>{reason}</VerdictWords>
        </p>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs sm:flex sm:flex-wrap sm:gap-x-5">
          <div className="contents sm:flex sm:items-baseline sm:gap-1.5">
            <dt className="text-muted-foreground">Attempted</dt>
            <dd>{attempted}</dd>
          </div>
          <div className="contents sm:flex sm:items-baseline sm:gap-1.5">
            <dt className="text-muted-foreground">Remaining Budget</dt>
            <dd>{remaining ?? <span className="text-subtle">-</span>}</dd>
          </div>
          <div className="contents sm:flex sm:items-baseline sm:gap-1.5">
            <dt className="text-muted-foreground">Rule</dt>
            <dd>
              <code className="font-mono text-[0.75rem]">{rule}</code>
            </dd>
          </div>
        </dl>
        <p className="mt-2 flex items-start gap-1.5 text-xs text-foreground">
          <RotateCcw aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          <span>
            <VerdictWords accounts={NO_ACCOUNTS}>{retry}</VerdictWords>
          </span>
        </p>
        {action && <div className="mt-2.5">{action}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <NoMoneyMoved />
          {budget && (
            <Link href={budget.href} className="rounded hover:text-foreground hover:underline">
              {budget.label}
            </Link>
          )}
          {time}
        </div>
      </div>
    </Tag>
  );
}
