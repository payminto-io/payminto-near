"use client";

import { TimeAgo } from "@/components/app/time-ago";
import { useBudgets, useDirectory, useToken } from "@/lib/queries";
import { useCan } from "@/lib/session";
import Link from "next/link";
import { RULE_INFO, approvalHref, isHubUnreadable, isPayeeCheckRule, payeeRefusalReason, refusalOf, refusalReason, refusalTitle, retryText } from "@/lib/denials";
import { formatToken } from "@/lib/format";
import type { Denial } from "@/lib/schemas";
import { AccountId } from "@/components/ds/account-id";
import { RefusalReason } from "@/components/ds/refusal-reason";
import { Button } from "@/components/ui/button";
import { MoveCreditAction } from "./budget-actions";
import { Money } from "./primitives";

export { NoMoneyMoved } from "@/components/ds/refusal-reason";

/**
 * One refused Call as a RefusalReason: the rule, the attempted amount, the remaining Budget and the retry hint. On an
 * escrow shortfall (NET_EXPOSURE counts escrow only) the owner can move hub credit into the Budget from here.
 */
export function DenialItem({ denial, showBudget = true, className, as = "li" }: { denial: Denial; showBudget?: boolean; className?: string; as?: "li" | "div" }) {
  const dir = useDirectory();
  const budgets = useBudgets();
  const can = useCan();
  const t = useToken();
  const refusal = refusalOf(denial);
  const budget = denial.budgetId ? budgets.data?.find((m) => m.id === denial.budgetId) : undefined;
  const agentName = denial.agent ? dir.lookup(denial.agent)?.name : null;
  const payeeName = denial.payee ? dir.lookup(denial.payee)?.name : null;
  // The node names the exact amount credit can cover (retry.fromCredit); older nodes leave it to the Budget's credit.
  const fromCredit = refusal.retry.kind === "fund" ? refusal.retry.fromCredit : undefined;
  const shortBy = fromCredit ? BigInt(fromCredit.amount) : refusal.retry.kind === "fund" ? BigInt(refusal.retry.shortBy) : null;
  const hasCredit = fromCredit ? BigInt(fromCredit.credit) > 0n : BigInt(budget?.ownerCredit ?? "0") > 0n;
  // A hub that could not be read says nothing about escrow, so there is no shortfall for credit to cover.
  const hubUnreadable = isHubUnreadable(refusal.retry);
  const offerCredit = denial.rule === "NET_EXPOSURE" && !hubUnreadable && budget && hasCredit && can("agents.manage") && budget.status === "open";
  return (
    <RefusalReason
      as={as}
      className={className}
      title={refusalTitle(denial.rule, refusal.retry)}
      kind={hubUnreadable ? "state" : (RULE_INFO[denial.rule]?.kind ?? "state")}
      kindLabel={hubUnreadable ? "Hub not readable" : denial.rule === "PAYEE_NEEDS_APPROVAL" ? "Waiting for the owner" : denial.rule === "PAYEE_BLOCKED" ? "Payee check" : undefined}
      rule={denial.rule}
      agent={agentName ?? (denial.agent ? <AccountId value={denial.agent} copy={false} explorer={false} /> : "An agent")}
      payee={payeeName ?? (denial.payee ? <AccountId value={denial.payee} copy={false} explorer={false} /> : null)}
      attempted={<Money atomic={refusal.attemptedAmount} />}
      remaining={refusal.remainingBudget === null ? null : <Money atomic={refusal.remainingBudget} />}
      reason={payeeRefusalReason(denial) ?? refusalReason(denial.rule, refusal.retry)}
      retry={retryText(refusal.retry, (a) => formatToken(a, t.symbol, t.decimals))}
      budget={showBudget && budget ? { label: budget.label, href: `/budgets/${budget.id}` } : null}
      time={<TimeAgo iso={denial.createdAt} className="num" />}
      action={
        offerCredit ? (
          <MoveCreditAction m={budget} shortBy={shortBy} />
        ) : isPayeeCheckRule(denial.rule) && denial.budgetId ? (
          // The owner decides on the Budget's own page: the node's approveAt when it points there, never anywhere else.
          <Button asChild size="sm" variant="outline" className="h-11 sm:h-8">
            <Link
              href={
                denial.rule === "PAYEE_NEEDS_APPROVAL"
                  ? approvalHref(denial.budgetId, refusal.retry.kind === "approval" ? refusal.retry.approveAt : null, typeof window === "undefined" ? null : window.location.origin)
                  : `/budgets/${denial.budgetId}#payees`
              }
            >
              {denial.rule === "PAYEE_NEEDS_APPROVAL" ? "Approve or deny this Payee" : "Review this Payee"}
            </Link>
          </Button>
        ) : null
      }
    />
  );
}
