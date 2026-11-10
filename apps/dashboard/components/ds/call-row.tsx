import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Call lists at every width. The list is a size container: wide, each row has five columns (time, who, detail, status,
 * amount); below 600px of list width, two lines at least 64px tall with the whole row as the link. Names truncate,
 * amounts never do.
 */
export function CallList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <ul aria-label={label} className={cn("@container divide-y", className)}>
      {children}
    </ul>
  );
}

export function CallRow({
  href,
  time,
  who,
  detail,
  status,
  amount,
  refused = false,
  longStatus = false,
}: {
  href: string;
  /** Exact time, mono; hidden on narrow rows, where `detail` carries the context. */
  time: ReactNode;
  /** "Agent -> Payee", or just the Payee inside a Budget. */
  who: ReactNode;
  /** The Budget name, or on a refused row the Refusal reason. */
  detail: ReactNode;
  status: ReactNode;
  amount: ReactNode;
  refused?: boolean;
  /**
   * The status is a long phrase ("Settled by the seller on the hub"). Below 440px of list width it then takes a line of
   * its own under the detail, so it never squeezes the Payee's name or the running total out of the row.
   */
  longStatus?: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          "grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/50 focus-visible:-outline-offset-2 sm:px-5",
          "@[600px]:min-h-12 @[600px]:grid-cols-[5.5rem_minmax(0,1.6fr)_minmax(0,1fr)_auto_8.5rem] @[600px]:gap-y-0 @[600px]:py-2.5",
          refused && "[&_.call-amount]:text-muted-foreground",
        )}
      >
        <span className="hidden font-mono text-xs text-muted-foreground @[600px]:col-start-1 @[600px]:row-start-1 @[600px]:block">{time}</span>
        <span className="col-start-1 row-start-1 min-w-0 truncate font-medium @[600px]:col-start-2">{who}</span>
        <span className="call-amount col-start-2 row-start-1 text-right @[600px]:col-start-5">{amount}</span>
        <span className={cn("col-start-1 row-start-2 min-w-0 truncate text-[0.8125rem] text-muted-foreground @[600px]:col-start-3 @[600px]:row-start-1", refused && "text-negative")}>{detail}</span>
        <span
          className={cn(
            longStatus
              ? "col-span-2 col-start-1 row-start-3 justify-self-start @[440px]:col-span-1 @[440px]:col-start-2 @[440px]:row-start-2 @[440px]:justify-self-end"
              : "col-start-2 row-start-2 justify-self-end",
            "@[600px]:col-start-4 @[600px]:row-start-1",
          )}
        >
          {status}
        </span>
      </Link>
    </li>
  );
}
