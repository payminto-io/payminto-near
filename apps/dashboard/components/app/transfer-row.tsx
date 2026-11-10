"use client";

import type { CSSProperties, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountText } from "@/components/ds/account-id";
import { Money } from "./primitives";

/**
 * One net transfer between two accounts, with the amount on the right. Netting is per account (a Budget owner pays, a
 * payee is credited), so the row names accounts: a service name would mislabel an owner that also sells something.
 */
export function TransferRow({
  from,
  to,
  amount,
  marker,
  className,
  style,
  children,
}: {
  from: string;
  to: string;
  amount: string;
  marker?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Extra detail under the row. */
  children?: ReactNode;
}) {
  const fromName = from;
  const toName = to;
  return (
    <li className={cn("px-3.5 py-3", className)} style={style}>
      <div className="flex items-center gap-3">
        {marker}
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <p tabIndex={0} className="flex min-w-0 items-center text-sm font-medium" aria-label={`${fromName} pays ${toName}`}>
                <Party name={fromName} account={from} />
                <ArrowRight className="mx-1.5 size-3.5 shrink-0 text-subtle" aria-hidden />
                <Party name={toName} account={to} />
              </p>
            </TooltipTrigger>
            <TooltipContent>
              {fromName} pays {toName}
            </TooltipContent>
          </Tooltip>
          {(fromName !== from || toName !== to) && (
            <p className="hash mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <AccountText value={from} className="shrink" />
              <span className="shrink-0 font-sans">to</span>
              <AccountText value={to} className="shrink" />
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Money atomic={amount} className="text-[0.9375rem]" />
        </div>
      </div>
      {children}
    </li>
  );
}

/** A name truncates at its end; an account id without a name truncates in the middle, never at a hyphen. */
function Party({ name, account }: { name: string; account: string }) {
  return name === account ? <AccountText value={account} className="font-mono text-[0.8125rem]" /> : <span className="min-w-0 truncate">{name}</span>;
}
