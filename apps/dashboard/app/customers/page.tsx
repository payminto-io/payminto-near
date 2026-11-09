"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bot, Search, Users } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { useMerchants } from "@/lib/operator-queries";
import { withBusiness } from "@/lib/merchant-scope";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Address, Money, PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { Dash, NoAccess } from "@/components/account/parts";

export default function CustomersPage() {
  return (
    <Suspense>
      <Customers />
    </Suspense>
  );
}

function Customers() {
  const access = useAccess();
  const { account } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const allowed = access.can("payments.read");
  const merchants = useMerchants();
  const platform = access.platformView;
  const cols = platform ? "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5rem_8rem_7rem_7rem]" : "md:grid-cols-[minmax(0,1.8fr)_5rem_8rem_7rem_7rem]";

  // Apply the search 250 ms after typing stops, and keep it in the URL so it can be shared.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text.trim() === q) return;
      const sp = new URLSearchParams(params.toString());
      if (text.trim()) sp.set("q", text.trim());
      else sp.delete("q");
      router.replace(`${pathname}${sp.toString() ? `?${sp.toString()}` : ""}`);
    }, 250);
    return () => window.clearTimeout(t);
  }, [text, q, params, pathname, router]);

  const query = useInfiniteQuery({
    queryKey: accountKeys.customers({ q, view: access.view }),
    queryFn: ({ pageParam }) => account.customers({ q: q || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
    placeholderData: (prev) => prev,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const nameOf = (id: string | null) => (id ? merchants.data?.find((m) => m.id === id)?.name ?? id : null);
  if (!allowed) return <NoAccess title="Customers" />;

  return (
    <>
      <PageHeader title="Customers" description="Everyone who paid you, by email, or by wallet when they paid without one. An AI agent shows up by its wallet." />
      <div className="mb-4 max-w-md">
        <label className="relative block">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by email or wallet" aria-label="Search customers" className="pl-9" />
        </label>
      </div>
      <Panel bodyClassName="p-0 sm:p-0">
        <ListHead cols={cols}>
          <span>Customer</span>
          {platform && <span>Business</span>}
          <span className="text-right">Payments</span>
          <span className="text-right">Total paid</span>
          <span className="text-right">Refunded</span>
          <span className="text-right">Last payment</span>
        </ListHead>
        {query.isPending ? (
          <RowsSkeleton className="px-5" rows={6} />
        ) : query.isError ? (
          <ErrorState className="m-4" error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Users className="size-4" />} title={q ? `No customer matches "${q}"` : "No customers yet"}>
            {q ? "Search by the start of an email or a wallet address." : "Once someone pays a payment link or a checkout page, they show up here."}
          </EmptyState>
        ) : (
          <ul className="stagger divide-y">
            {rows.map((c) => {
              const key = c.email ?? c.wallets[0] ?? "";
              const href = withBusiness(`/payments?q=${encodeURIComponent(key)}`, c.merchantId);
              return (
                <li key={`${c.merchantId}:${c.id}`} className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 ${cols}`}>
                  <span className="min-w-0">
                    {c.email ? (
                      <Link href={href} className="block truncate font-medium after:absolute after:inset-0 hover:underline">
                        {c.name ? `${c.name}` : c.email}
                      </Link>
                    ) : (
                      <Link href={href} className="flex items-center gap-1.5 font-medium after:absolute after:inset-0 hover:underline">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Bot className="relative z-10 size-3.5 text-muted-foreground" aria-label="Paid without an email" />
                          </TooltipTrigger>
                          <TooltipContent>Paid without an email, often an AI agent.</TooltipContent>
                        </Tooltip>
                        Wallet customer
                      </Link>
                    )}
                    <span className="relative z-10 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {c.email && c.name && <span className="truncate">{c.email}</span>}
                      {c.wallets.slice(0, 1).map((w) => (
                        <Address key={w} address={w} showName={false} />
                      ))}
                      {c.wallets.length > 1 && <span>+{c.wallets.length - 1} more</span>}
                    </span>
                  </span>
                  {platform && <span className="truncate text-muted-foreground max-md:hidden">{nameOf(c.merchantId) ?? <Dash />}</span>}
                  <span className="num text-right max-md:hidden">{c.payments}</span>
                  <span className="text-right font-medium">
                    <Money atomic={c.totalPaid} />
                  </span>
                  <span className="text-right text-muted-foreground max-md:hidden">{BigInt(c.totalRefunded) > 0n ? <Money atomic={c.totalRefunded} /> : <Dash />}</span>
                  <span className="text-right text-xs text-muted-foreground max-md:hidden">{c.lastPaymentAt ? <TimeAgo iso={c.lastPaymentAt} /> : <Dash />}</span>
                </li>
              );
            })}
          </ul>
        )}
        {query.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="ghost" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? "Loading" : "Load more"}
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}
