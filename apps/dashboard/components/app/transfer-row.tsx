"use client";

import type { CSSProperties, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortAddress } from "@/lib/format";
import { useDirectory } from "@/lib/queries";
import type { HspStatus } from "@/lib/schemas";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Money } from "./primitives";
import { HspChip } from "./status";

/**
 * One net transfer on two lines: payer and payee names (truncated, full text in a tooltip) over their addresses,
 * with the amount and, once settled, the HSP status stacked on the right.
 */
export function TransferRow({
  from,
  to,
  amount,
  marker,
  status,
  className,
  style,
  children,
}: {
  from: string;
  to: string;
  amount: string;
  marker?: ReactNode;
  /** Pass `undefined` for a projection (no HSP record yet); `null` renders "No HSP record". */
  status?: HspStatus | null;
  className?: string;
  style?: CSSProperties;
  /** Extra detail under the row, such as the HSP reason and payment id. */
  children?: ReactNode;
}) {
  const dir = useDirectory();
  const fromName = dir.lookup(from)?.name ?? shortAddress(from);
  const toName = dir.lookup(to)?.name ?? shortAddress(to);
  return (
    <li className={cn("px-3.5 py-3", className)} style={style}>
      <div className="flex items-center gap-3">
        {marker}
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <p tabIndex={0} className="truncate text-sm font-medium" aria-label={`${fromName} pays ${toName}`}>
                {fromName}
                <ArrowRight className="mx-1.5 inline size-3.5 -translate-y-px text-subtle" aria-hidden />
                {toName}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              {fromName} pays {toName}
            </TooltipContent>
          </Tooltip>
          <p className="hash mt-0.5 truncate text-xs text-subtle">
            {shortAddress(from)} <span className="font-sans">to</span> {shortAddress(to)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Money atomic={amount} className="text-[0.9375rem] font-semibold" />
          {status !== undefined && <HspChip status={status} />}
        </div>
      </div>
      {children}
    </li>
  );
}
