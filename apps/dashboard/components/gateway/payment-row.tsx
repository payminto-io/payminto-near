"use client";

import Link from "next/link";
import { withBusiness } from "@/lib/merchant-scope";
import type { Payment } from "@/lib/schemas";
import { Address, Money } from "@/components/app/primitives";
import { PaymentStatusChip } from "@/components/app/status";
import { TimeAgo } from "@/components/app/time-ago";

export const PAYMENT_COLS = "md:grid-cols-[8.5rem_10.5rem_minmax(0,1.6fr)_minmax(0,1fr)_6.5rem]";
/** With a Business column, on the platform view. */
export const PAYMENT_COLS_BUSINESS = "md:grid-cols-[8.5rem_10.5rem_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)_6.5rem]";

/** One payment: amount first and bold, status right after it, the whole row links to the detail. */
export function PaymentRow({ p, linkTitle, business }: { p: Payment; linkTitle?: string; business?: string | null }) {
  const withCol = business !== undefined;
  return (
    <li className={`relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 md:gap-4 ${withCol ? PAYMENT_COLS_BUSINESS : PAYMENT_COLS}`}>
      <Link href={withBusiness(`/payments/${p.id}`, p.merchant_id)} className="font-semibold after:absolute after:inset-0 md:text-right" aria-label={`Payment ${p.id}`}>
        <Money atomic={p.amount_due} maxFraction={2} />
      </Link>
      <span className="justify-self-end md:justify-self-start">
        <PaymentStatusChip status={p.status} late={p.late} />
      </span>
      <span className="min-w-0 truncate text-sm">
        {p.description ?? "Payment"}
        <span className="text-muted-foreground">{linkTitle || p.link_id ? " - link" : p.reference ? ` - ${p.reference}` : " - API"}</span>
        {p.refund_status !== "none" && <span className="ml-2 text-xs text-muted-foreground">{p.refund_status === "full" ? "Refunded" : "Partly refunded"}</span>}
      </span>
      {withCol && <span className="min-w-0 truncate text-sm text-muted-foreground max-md:hidden">{business ?? "-"}</span>}
      <span className="relative z-10 min-w-0 text-sm text-muted-foreground max-md:justify-self-end">{p.payer ? <Address address={p.payer} showName={false} copy={false} explorer={false} /> : <span className="text-subtle max-md:hidden">-</span>}</span>
      <span className="text-sm text-muted-foreground max-md:hidden md:text-right">
        <TimeAgo iso={p.created_at} />
      </span>
    </li>
  );
}
