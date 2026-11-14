"use client";

/**
 * Getting started on a business's Home: six steps whose done state is read from what the dashboard already loads. A
 * person sees only the steps they can act on; the list hides once all are done or once they dismiss it for this
 * business (kept in this browser).
 */
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useAccess, useApi, useSession } from "@/lib/session";
import { gk, useLinks, usePayments } from "@/lib/gateway-queries";
import { useMerchantMethods } from "@/lib/operator-queries";
import { usePayoutHistory } from "@/lib/balance-api";
import { anyChainState, checklistProgress, checklistSteps, dismissChecklist, isChecklistDismissed, payoutProven, type StepKey } from "@/lib/setup-checklist";
import { cn } from "@/lib/utils";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const PAID = { status: ["paid", "overpaid"] as const, limit: 1 };

// Dismissals live in localStorage; this tab also remembers them in memory in case storage is blocked.
const hiddenHere = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
function hide(merchantId: string) {
  hiddenHere.add(merchantId);
  dismissChecklist(merchantId);
  for (const l of listeners) l();
}

export function BusinessSetupChecklist({ merchantId, className }: { merchantId: string; className?: string }) {
  const access = useAccess();
  const api = useApi();
  const { account } = useSession();
  const can = (p: Parameters<typeof access.can>[0]) => access.can(p);
  // The server render has no storage, so it renders nothing; a guide that flashes and then hides is worse than none.
  const dismissed = useSyncExternalStore(subscribe, () => hiddenHere.has(merchantId) || isChecklistDismissed(merchantId), () => true);

  const wantPayout = can("payout.change");
  const wantTeam = can("members.manage");
  const wantKeys = can("developers.manage");
  const payout = usePayoutHistory(wantPayout ? merchantId : null);
  const methods = useMerchantMethods(can("business.update") ? merchantId : undefined);
  const links = useLinks();
  const members = useQuery({ queryKey: accountKeys.members(merchantId), queryFn: () => account.members(merchantId), enabled: wantTeam });
  const invites = useQuery({ queryKey: accountKeys.invites(merchantId), queryFn: () => account.invites(merchantId), enabled: wantTeam });
  const keys = useQuery({ queryKey: gk.keys, queryFn: () => api.gateway.apiKeys(), enabled: wantKeys });
  const paid = usePayments({ status: [...PAID.status], limit: PAID.limit });

  const sources: { key: StepKey; q: { isPending: boolean; isError: boolean }; on: boolean }[] = [
    { key: "payout", q: payout, on: wantPayout },
    { key: "anyChain", q: methods, on: can("business.update") },
    { key: "link", q: links, on: can("links.write") },
    { key: "team", q: members, on: wantTeam },
    { key: "team", q: invites, on: wantTeam },
    { key: "apiKey", q: keys, on: wantKeys },
    { key: "firstPayment", q: paid, on: can("links.write") },
  ];
  if (dismissed || sources.some((s) => s.on && s.q.isPending && !s.q.isError)) return null;
  // A step whose data could not be read is left out rather than shown as not done.
  const failed = new Set(sources.filter((s) => s.on && s.q.isError).map((s) => s.key));

  const pendingInvites = (invites.data ?? []).filter((i) => !i.status || i.status === "pending").length;
  const steps = checklistSteps(
    {
      payoutProven: payout.data ? payoutProven(payout.data) : false,
      anyChain: methods.data ? anyChainState(methods.data) : "unavailable",
      links: links.data?.length ?? 0,
      team: (members.data?.length ?? 0) + pendingInvites,
      apiKeys: (keys.data ?? []).filter((k) => !k.revoked_at).length,
      paidPayments: paid.data?.items.length ?? 0,
    },
    can,
  ).filter((s) => !failed.has(s.key));
  const progress = checklistProgress(steps);
  if (steps.length === 0 || progress.complete) return null;
  const next = steps.findIndex((s) => !s.done);

  return (
    <section aria-labelledby="setup-guide" className={cn("rounded-xl border bg-card", className)}>
      <div className="flex items-start gap-3 border-b px-4 py-4 sm:px-6 sm:py-5">
        <div className="min-w-0 flex-1">
          <h2 id="setup-guide" className="text-lg font-semibold tracking-[-0.01em]">
            Get set up
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">A few steps so customers and AI agents can pay you, and your team can help.</p>
          <div className="mt-3 flex max-w-sm items-center gap-3">
            <Progress value={(progress.done / progress.total) * 100} aria-label={`Setup progress, ${progress.label} steps done`} className="h-1.5 bg-muted" />
            <span className="num shrink-0 text-xs font-medium text-muted-foreground">{progress.label} done</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Hide the setup guide"
          title="Hide the setup guide"
          className="-mt-1 -mr-2 size-11 shrink-0 text-muted-foreground md:size-9"
          onClick={() => hide(merchantId)}
        >
          <X />
        </Button>
      </div>
      <ol className="stagger divide-y">
        {steps.map((s, i) => (
          <li key={s.key} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-6">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span
                className={cn(
                  "num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  s.done ? "bg-positive-soft text-positive" : i === next ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground",
                )}
              >
                {s.done ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
              </span>
              <div className="min-w-0">
                <h3 className={cn("text-sm font-medium", s.done && "text-muted-foreground line-through decoration-1")}>{s.title}</h3>
                {!s.done && <p className="mt-0.5 text-sm text-muted-foreground">{s.body}</p>}
              </div>
            </div>
            {!s.done && (
              <Button asChild size="sm" variant={i === next ? "default" : "outline"} className="shrink-0 max-sm:ml-9 max-sm:h-11 max-sm:self-stretch">
                <Link href={s.href}>{s.action}</Link>
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
