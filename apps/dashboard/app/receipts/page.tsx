"use client";

import { TimeAgo } from "@/components/app/time-ago";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Search, ShieldCheck } from "lucide-react";
import { flattenCallPages, useCallPages, useDirectory } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

export default function ReceiptsPage() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pages = useCallPages({ status: "settled", limit: 10 });
  const items = flattenCallPages(pages.data?.pages);
  const dir = useDirectory();

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      setError("A call id is 0x followed by 64 hex characters. It is in the PAYMENT-RESPONSE receipt the provider returned.");
      return;
    }
    router.push(`/receipts/${v}`);
  }

  return (
    <>
      <PageHeader
        title="Verify"
        description="Any single charge can be proven against the receipts root its settlement stored on chain. Paste a charge id, or pick a recent settled charge."
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel title="Look up a charge" className="h-fit">
          <form onSubmit={submit} noValidate className="space-y-3">
            <Label htmlFor="callId">Charge id</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="callId"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder="0x..."
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
        </Panel>
        <Panel title="Recent settled charges" bodyClassName="p-0 sm:p-0">
          {pages.isPending ? (
            <RowsSkeleton className="px-5" rows={5} />
          ) : pages.isError ? (
            <ErrorState className="m-4" error={pages.error} onRetry={() => void pages.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-4" />} title="No settled charges yet">
              A charge becomes provable once the settlement that cleared it is confirmed on chain.
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {items.map((c) => (
                <li key={c.id}>
                  <Link href={`/receipts/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40 sm:px-5">
                    <span className="hash w-28 shrink-0 text-xs text-muted-foreground">
                      {c.id.slice(0, 8)}…{c.id.slice(-4)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {dir.lookup(c.agent)?.name ?? "Agent"} <span className="text-subtle">paid</span> {dir.lookup(c.payee)?.name ?? "payee"}
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
                {pages.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more calls
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
