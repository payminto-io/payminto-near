"use client";

import { isId32 } from "@payminto/protocol";

import { TimeAgo } from "@/components/app/time-ago";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Search, ShieldCheck } from "lucide-react";
import { flattenCallPages, useCallPages, useDirectory } from "@/lib/queries";
import { useCan } from "@/lib/session";
import { SELLER_SETTLED_LABEL, isSellerSettled } from "@/lib/seller-settlement";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

export default function ReceiptsPage() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Proving a Call needs only its id: the server's proof route is public. Listing Calls needs agents.read, so a role
  // without it proves the Calls it has ids for (from a receipt) and is not shown a list it cannot read.
  const listCalls = useCan()("agents.read");
  const pages = useCallPages({ status: "settled", limit: 10 }, listCalls);
  const items = flattenCallPages(pages.data?.pages);
  const dir = useDirectory();

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!isId32(v)) {
      setError("A Call id is 64 hex characters. It is in the PAYMENT-RESPONSE receipt the Payee returned.");
      return;
    }
    router.push(`/receipts/${v}`);
  }

  return (
    <>
      <PageHeader
        title="Verify"
        description={`Any single Call can be proven against the receipts root its settlement batch stored on chain. A Call its seller settled on the hub is in no batch, and is checked against the hub's settled position instead. ${listCalls ? "Paste a Call id, or pick a recent settled Call." : "Paste the Call id from the receipt a Payee returned."}`}
      />
      <div className={listCalls ? "grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" : "max-w-xl"}>
        <Panel title="Look up a Call" className="h-fit">
          <form onSubmit={submit} noValidate className="space-y-3">
            <Label htmlFor="callId">Call id</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="callId"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder="64 hex characters"
                className="hash flex-1"
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "callId-error" : undefined}
              />
              <Button type="submit">
                <Search /> Prove
              </Button>
            </div>
            {error && (
              <p id="callId-error" className="text-sm text-negative">
                {error}
              </p>
            )}
          </form>
          {!listCalls && <p className="mt-3 text-xs text-muted-foreground">The id is in the PAYMENT-RESPONSE receipt the Payee returned with the paid answer. Anyone can prove a Call with it: the check reads NEAR, not this server&apos;s records.</p>}
        </Panel>
        {listCalls && (
        <Panel title="Recent settled Calls" bodyClassName="p-0 sm:p-0">
          {pages.isPending ? (
            <RowsSkeleton className="px-5" rows={5} />
          ) : pages.isError ? (
            <ErrorState className="m-4" error={pages.error} onRetry={() => void pages.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-4" />} title="No settled Calls yet">
              A Call becomes provable once the settlement batch that cleared it is confirmed on chain, or once its seller settles it on the hub.
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {items.map((c) => (
                <li key={c.id}>
                  <Link href={`/receipts/${c.id}`} className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 focus-visible:-outline-offset-2 sm:px-5">
                    <span className="hash w-28 shrink-0 text-xs text-muted-foreground max-sm:hidden">
                      {c.id.slice(0, 8)}…{c.id.slice(-4)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {dir.lookup(c.agent)?.name ?? "Agent"} <span className="text-subtle">paid</span> {dir.lookup(c.payee)?.name ?? "Payee"}
                      </span>
                      {/* On a phone the id sits under the names, so the names keep the width of the row. */}
                      <span className="hash block text-xs text-muted-foreground sm:hidden">
                        {c.id.slice(0, 8)}…{c.id.slice(-4)}
                      </span>
                      {isSellerSettled(c) && <span className="block truncate text-xs text-muted-foreground">{SELLER_SETTLED_LABEL}</span>}
                    </span>
                    <Money atomic={c.amount} />
                    <span className="num hidden w-16 text-right text-xs text-subtle sm:block"><TimeAgo iso={c.createdAt} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {pages.hasNextPage && (
            <div className="border-t px-4 py-3 sm:px-5">
              <Button variant="outline" size="sm" className="w-full" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
                {pages.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more Calls
              </Button>
            </div>
          )}
        </Panel>
        )}
      </div>
    </>
  );
}
