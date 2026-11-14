"use client";

import Link from "next/link";
import { ArrowRight, Globe, HandCoins, Landmark, TriangleAlert } from "lucide-react";
import { useAccess } from "@/lib/session";
import { ApiError } from "@/lib/http";
import { useMerchantBalance } from "@/lib/balance-api";
import { balanceTotals } from "@/lib/balance";
import { useHubCredits } from "@/lib/use-hub-credits";
import { useMerchantMethods } from "@/lib/operator-queries";
import { anyChainState } from "@/lib/setup-checklist";
import { formatDateTime, formatInt, plural, shortHash } from "@/lib/format";
import type { AnyChainDelivery, BalancePayout } from "@/lib/platform-schemas";
import { Button } from "@/components/ui/button";
import { Address, CopyButton, InfoTip, Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RequirePermission } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { ExplorerLink } from "@/components/ds/actions";
import { StatusPill } from "@/components/ds/status-pill";

const PAYOUT_COLS = "md:grid-cols-[11rem_minmax(0,1fr)_9rem_8rem]";
// The any-chain card sits in a narrow column on wide screens, so its columns follow the card's width, not the window's.
const ANY_COLS = "@xl:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1.2fr)_6.5rem]";

/** 1Click chain codes in plain names; an unknown code shows as it is. */
const CHAIN_NAME: Record<string, string> = { base: "Base", eth: "Ethereum", arb: "Arbitrum", op: "Optimism", pol: "Polygon", sol: "Solana", btc: "Bitcoin", bsc: "BNB Chain", tron: "Tron", near: "NEAR" };

const DESCRIPTION = "Money the hub holds for your payout account, what is on its way, and what has reached it. Payouts run on the server's schedule; nothing here moves money.";

function payoutState(p: BalancePayout): { status: "settled" | "waiting" | "refused"; label: string } {
  if (p.status === "confirmed") return p.outcome === "paid" ? { status: "settled", label: "Paid out" } : { status: "waiting", label: "Kept on the hub" };
  if (p.status === "submitted") return { status: "waiting", label: "Sending" };
  if (p.status === "unknown") return { status: "waiting", label: "Checking the hub" };
  return { status: "refused", label: "Failed" };
}

/** A transaction hash with copy and, when the server gave one, its explorer page. */
function TxCell({ hash, href, label }: { hash: string | null; href: string | null; label: string }) {
  if (!hash) return <span className="text-subtle">-</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 align-middle">
      <span className="hash truncate text-[0.8125rem]" title={hash}>
        {shortHash(hash)}
      </span>
      <CopyButton value={hash} label="transaction hash" />
      <ExplorerLink href={href} label={label} />
    </span>
  );
}

function BalancePagePage() {
  const access = useAccess();
  const merchantId = access.view?.kind === "business" ? access.view.merchantId : null;
  const q = useMerchantBalance(merchantId);
  const hub = useHubCredits(q.data?.payout ? [q.data.payout] : []);
  const methods = useMerchantMethods(merchantId ?? undefined);

  if (!merchantId) {
    return (
      <>
        <PageHeader title="Balance" description={DESCRIPTION} />
        <div className="rounded-xl border bg-card">
          <EmptyState icon={<Landmark className="size-4" />} title="You are on the platform view" action={access.can("agents.read") ? <Button asChild variant="outline"><Link href="/payouts">Open Payouts</Link></Button> : undefined}>
            Each business has its own balance. Open a business with the switcher at the top of the sidebar to see it.
          </EmptyState>
        </div>
      </>
    );
  }
  if (q.isPending) {
    return (
      <>
        <PageHeader title="Balance" description={DESCRIPTION} />
        <BlockSkeleton className="h-[5.75rem]" />
        <BlockSkeleton className="mt-5 h-64" />
      </>
    );
  }
  if (q.isError) {
    // A server older than this dashboard has no balance route yet.
    const old = q.error instanceof ApiError && q.error.status === 404 && q.error.code === "NOT_FOUND";
    return (
      <>
        <PageHeader title="Balance" description={DESCRIPTION} />
        {old ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={<Landmark className="size-4" />} title="Your Payminto server does not report balances yet">
              It is older than this dashboard. Ask the platform owner to update it; payments and payouts carry on as before.
            </EmptyState>
          </div>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </>
    );
  }

  const b = q.data;
  const hubCredit = b.payout && hub.state === "done" ? (hub.credits.get(b.payout) ?? null) : null;
  const totals = balanceTotals(b, hubCredit);
  const anyChain = anyChainState(methods.data ?? []);
  const showAnyChain = b.any_chain.count > 0 || anyChain !== "unavailable";
  const settingsHref = access.can("payout.change") || access.can("business.update") ? "/settings/payout" : null;

  return (
    <>
      <PageHeader title="Balance" description={DESCRIPTION} />
      {b.payout ? (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">Payout account</span>
          <Address address={b.payout} showName={false} />
          {settingsHref && (
            <Link href={settingsHref} className="inline-flex min-h-11 items-center rounded text-sm font-medium text-primary underline-offset-2 hover:underline md:min-h-0">
              Payout wallet settings
            </Link>
          )}
        </div>
      ) : (
        <p role="note" className="mb-5 flex items-start gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            No payout account yet, so the hub cannot credit this business.{" "}
            {settingsHref ? (
              <Link href={settingsHref} className="font-medium underline underline-offset-2">
                Set one in Settings
              </Link>
            ) : (
              "An Admin sets one in Settings."
            )}
          </span>
        </p>
      )}
      {b.status === "waiting_registration" && (
        <p role="note" className="mb-5 flex items-start gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Your payout account must register with the token (a one-time storage deposit) before the hub can pay it. The money stays on the hub until then.</span>
        </p>
      )}
      <StatStrip
        stats={[
          {
            label: "Waiting for payout",
            value: <Money atomic={totals.waiting} />,
            note:
              totals.source === "hub" ? (
                "read from the hub just now"
              ) : b.checked_at ? (
                <>
                  as of the server&apos;s last check, <TimeAgo iso={String(b.checked_at)} />
                </>
              ) : (
                "as the server last saw it"
              ),
          },
          { label: "On its way", value: <Money atomic={totals.inFlight} />, note: BigInt(totals.inFlight) > 0n ? "in a payout being sent now" : "nothing in flight" },
          { label: "Paid out, 30 days", value: <Money atomic={totals.paid30d} />, note: <>all time <Money atomic={b.paid_total} size="sm" className="font-normal" /></> },
        ]}
      />
      {hub.state === "error" && (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{hub.message} The figures above are the server&apos;s own.</span>
          <button type="button" onClick={hub.retry} className="rounded font-medium text-foreground underline underline-offset-2 focus-visible:outline-2">
            Read the hub again
          </button>
        </p>
      )}
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Payout history" description="Each payout from the hub to your payout account, newest first." bodyClassName="p-0 sm:p-0">
          {b.payouts.length === 0 ? (
            <EmptyState icon={<HandCoins className="size-4" />} title="No payouts yet">
              The server pays out hub credit on its schedule. Each payout shows here with its transaction.
            </EmptyState>
          ) : (
            <>
              <ListHead cols={PAYOUT_COLS}>
                <span>Date</span>
                <span>Transaction</span>
                <span>Status</span>
                <span className="text-right">Amount</span>
              </ListHead>
              <ul className="divide-y">
                {b.payouts.map((p) => {
                  const s = payoutState(p);
                  return (
                    <li key={p.seq} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-sm sm:px-5 md:gap-4 ${PAYOUT_COLS}`}>
                      <span className="text-muted-foreground max-md:text-foreground">{formatDateTime(String(p.at))}</span>
                      <span className="min-w-0 max-md:col-span-2 max-md:row-start-3">
                        <TxCell hash={p.tx_hash} href={p.explorer_url} label="payout transaction" />
                      </span>
                      <span className="max-md:row-start-2">
                        <StatusPill status={s.status} label={s.label} />
                      </span>
                      <span className="text-right max-md:row-start-1 max-md:col-start-2">
                        {p.outcome === "paid" ? <Money atomic={p.amount} /> : <Money atomic={p.credit_before} className="text-muted-foreground" />}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Panel>
        {showAnyChain && (
          <Panel
            title={
              <span className="flex items-center gap-1.5">
                Any-chain payments
                <InfoTip>Payments a customer sent from another chain. 1Click delivers them as USDC straight to your NEAR account, so they never wait on the hub and are not in the figures above.</InfoTip>
              </span>
            }
            description={b.any_chain.count > 0 ? `${formatInt(b.any_chain.count)} ${plural(b.any_chain.count, "delivery", "deliveries")} to your NEAR account` : "Delivered as USDC to your NEAR account."}
            actions={b.any_chain.count > 0 && <Money atomic={b.any_chain.total} className="font-semibold" />}
            bodyClassName="p-0 sm:p-0"
          >
            {b.any_chain.items.length === 0 ? (
              <EmptyState icon={<Globe className="size-4" />} title="No any-chain payments yet" action={anyChain === "off" && access.can("business.update") ? <Button asChild variant="outline" size="sm"><Link href="/settings/methods">Turn on any chain <ArrowRight /></Link></Button> : undefined}>
                {anyChain === "off" ? "Accept any chain is off for this business." : "When a customer pays from another chain, the delivery shows here."}
              </EmptyState>
            ) : (
              <div className="@container">
                <div className={`hidden gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground @xl:grid ${ANY_COLS}`}>
                  <span>Date</span>
                  <span>From</span>
                  <span>Delivery</span>
                  <span className="text-right">Amount</span>
                </div>
                <ul className="divide-y">
                  {b.any_chain.items.map((d: AnyChainDelivery) => (
                    <li key={d.quote_id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-sm sm:px-5 @xl:gap-4 ${ANY_COLS}`}>
                      <Link href={`/payments/${d.payment_id}`} className="text-muted-foreground underline-offset-2 hover:underline @max-xl:text-foreground">
                        {formatDateTime(String(d.delivered_at))}
                      </Link>
                      <span className="truncate text-muted-foreground @max-xl:col-span-2 @max-xl:row-start-2">
                        {d.origin_symbol} on {CHAIN_NAME[d.origin_chain] ?? d.origin_chain}
                      </span>
                      <span className="min-w-0 @max-xl:col-span-2 @max-xl:row-start-3">
                        {d.mode === "simulated" ? <Chip tone="neutral">Simulated, no real money</Chip> : <TxCell hash={d.tx_hash} href={d.explorer_url} label="delivery transaction" />}
                      </span>
                      <span className="text-right @max-xl:row-start-1 @max-xl:col-start-2">
                        <Money atomic={d.amount} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}

export default function BalancePage() {
  return (
    <RequirePermission permission={"payments.read"}>
      <BalancePagePage />
    </RequirePermission>
  );
}
