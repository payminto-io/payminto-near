"use client";

import { UserX } from "lucide-react";
import { useScreeningDecisions } from "@/lib/gateway-queries";
import type { ScreeningRule } from "@/lib/schemas";
import { Address, Money, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";

export const SCREENING_RULE_TITLE: Record<ScreeningRule, string> = {
  PAYER_BLACKLISTED: "Wallet frozen by the token issuer",
  PAYOUT_BLACKLISTED: "Your payout wallet is frozen by the token issuer",
  PAYER_DENIED: "Wallet on your blocked list",
  PAYER_TOO_NEW: "Wallet has too little history",
};

const METHOD_WORD: Record<string, string> = { wallet: "Pay with wallet", deposit: "Send to address", x402: "AI agent", voucher: "AI agent with budget", hsp: "Pay with HSP" };
const STAGE_WORD: Record<string, string> = { x402: "AI agent", authorize: "Pay with wallet", deposit: "Send to address", relay: "AI agent", hsp: "Pay with HSP" };

/** Refused gateway requests (GATEWAY.md section 13.1): no signature, requirements or relay was given for these. */
export function ScreeningDecisions({ title = "Blocked payments", className }: { title?: string; className?: string }) {
  const q = useScreeningDecisions();
  return (
    <Panel title={title} description="Payments Payminto refused before anything could be paid, with the reason. No money moved." className={className} bodyClassName="p-0 sm:p-0">
      {q.isPending ? (
        <RowsSkeleton className="px-5" rows={3} />
      ) : q.isError ? (
        <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState icon={<UserX className="size-4" />} title="No payment refused">
          Wallets that are frozen, on your blocked list or too new appear here when they try to pay.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {q.data.map((d) => (
            <li key={d.id} className="flex flex-col gap-1.5 px-4 py-3 text-sm sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="negative">Payment</Chip>
                <span className="font-medium" title={d.rule}>{SCREENING_RULE_TITLE[d.rule]}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  <TimeAgo iso={d.created_at} />
                </span>
              </div>
              {d.message && <p className="text-[0.8125rem] text-muted-foreground">{d.message}</p>}
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {(d.payer ?? d.address) && (
                  <span className="inline-flex items-center gap-1">
                    Wallet <Address address={d.payer ?? d.address} showName={false} />
                  </span>
                )}
                {(d.method ?? d.stage) && <span>with {METHOD_WORD[d.method ?? ""] ?? STAGE_WORD[d.stage ?? ""] ?? d.method ?? d.stage}</span>}
                {d.amount && (
                  <span>
                    asked <Money atomic={d.amount} />
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
