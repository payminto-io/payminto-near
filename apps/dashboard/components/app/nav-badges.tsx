"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccess, useApi, useSession } from "@/lib/session";
import { gk } from "@/lib/gateway-queries";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { NavBadge } from "@/lib/nav";
import { useNow } from "./time-ago";

export const accountKeys = {
  all: ["account"] as const,
  signupRequests: (status: string) => ["account", "signup-requests", status] as const,
  members: (merchantId: string) => ["account", "members", merchantId] as const,
  invites: (scope: string | null) => ["account", "invites", scope ?? "platform"] as const,
  platformTeam: ["account", "platform-team"] as const,
  outbox: ["account", "outbox"] as const,
  audit: (q: unknown) => ["account", "audit", q] as const,
  sessions: ["account", "sessions"] as const,
  customers: (q: unknown) => ["gateway", "customers", q] as const,
};

const DAY = 86_400_000;

/**
 * Blocked in the last 24 hours: refused agent charges (clearing) plus refused payments (gateway screening), so the
 * stat counts every refusal (carry-over item 8).
 */
export function useBlocked24h(): number {
  const api = useApi();
  const access = useAccess();
  const agents = access.can("agents.read");
  const screening = access.can("screening.read");
  const overview = useQuery({ queryKey: qk.overview, queryFn: () => api.overview(), enabled: agents && access.platformView, staleTime: 30_000 });
  const decisions = useQuery({ queryKey: gk.screening, queryFn: () => api.gateway.screeningDecisions(), enabled: screening, staleTime: 30_000 });
  const since = useNow() - DAY;
  const gateway = (decisions.data ?? []).filter((d) => new Date(d.created_at).getTime() >= since).length;
  return (agents && access.platformView ? overview.data?.denials24h ?? 0 : 0) + gateway;
}

export function usePendingSignups(): number {
  const { account } = useSession();
  const access = useAccess();
  const q = useQuery({ queryKey: accountKeys.signupRequests("pending"), queryFn: () => account.signupRequests("pending"), enabled: access.can("signups.review"), staleTime: 30_000 });
  return q.data?.pending ?? 0;
}

export function useBadgeCounts(): Record<NavBadge, number> {
  return { blocked: useBlocked24h(), requests: usePendingSignups() };
}

export function CountBadge({ n, label, className, tone = "negative" }: { n: number; label: string; className?: string; tone?: "negative" | "primary" }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "num inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.6875rem] font-semibold",
        // Mercury: a plain count for work waiting on you; colour only for something that went wrong.
        tone === "negative" ? "bg-negative-soft text-negative" : "bg-muted text-foreground",
        className,
      )}
      aria-label={label}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function badgeLabel(badge: NavBadge, n: number): string {
  return badge === "blocked" ? `${n} blocked in the last 24 hours` : `${n} sign-up request${n === 1 ? "" : "s"} waiting`;
}
