"use client";

import { TimeAgo } from "@/components/app/time-ago";
import Link from "next/link";
import { ShieldBan } from "lucide-react";
import { useDirectory, useMandates } from "@/lib/queries";
import { ruleDescription, ruleTitle } from "@/lib/denials";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Denial } from "@/lib/schemas";
import { Money } from "./primitives";
import { RuleKindChip } from "./status";

/** "No money moved" stated in so many words, next to every refusal. */
export function NoMoneyMoved({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-positive", className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      No money moved
    </span>
  );
}

/** One refused charge: the reason, who tried to pay whom and how much, and that nothing settled. */
export function DenialItem({ denial, showMandate = true, className }: { denial: Denial; showMandate?: boolean; className?: string }) {
  const dir = useDirectory();
  const mandates = useMandates();
  const who = (a: string | null | undefined) => (a ? dir.lookup(a)?.name ?? shortAddress(a) : null);
  const agent = who(denial.agent) ?? "An agent";
  const payee = who(denial.payee);
  const mandate = denial.mandateId ? mandates.data?.find((m) => m.id === denial.mandateId) : undefined;
  return (
    <li className={cn("flex gap-3 px-4 py-3 sm:px-5", className)}>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-negative-soft text-negative" aria-hidden>
        <ShieldBan className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{ruleTitle(denial.rule)}</span>
          <RuleKindChip rule={denial.rule} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="text-foreground">{agent}</span> tried to pay{" "}
          {payee ? <span className="text-foreground">{payee}</span> : "a paid service"}
          {denial.amount ? (
            <>
              {" "}
              <Money atomic={denial.amount} className="text-foreground" />
            </>
          ) : null}
          . {ruleDescription(denial.rule)}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          <NoMoneyMoved />
          {showMandate && mandate && (
            <Link href={`/mandates/${mandate.id}`} className="rounded hover:text-foreground hover:underline">
              {mandate.label}
            </Link>
          )}
          <TimeAgo iso={denial.createdAt} className="num" />
        </div>
      </div>
    </li>
  );
}
