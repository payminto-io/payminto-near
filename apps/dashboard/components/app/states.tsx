"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Lock, RotateCw, Unplug } from "lucide-react";
import { useCan } from "@/lib/session";
import type { Permission } from "@/lib/permissions";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const api = error instanceof ApiError ? error : null;
  const unreachable = api?.code === "NODE_UNREACHABLE";
  const title = unreachable
    ? "Your Payminto server is not answering"
    : api?.code === "SHAPE_MISMATCH"
      ? "The server sent data this dashboard does not understand"
      : api?.status === 404
        ? "Not found"
        : api?.code === "UNAUTHORIZED"
          ? "You need to sign in again"
          : api?.code === "FORBIDDEN"
            ? "You do not have access to this"
            : "This view could not load";
  const body = api?.message ?? (error instanceof Error ? error.message : "Unknown error.");
  const Icon = unreachable ? Unplug : AlertTriangle;
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 rounded-lg border border-dashed bg-card px-5 py-6 sm:flex-row sm:items-center", className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-negative-soft text-negative">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-sm break-words text-muted-foreground">
          {body}
        </p>
        {api && api.code !== "NODE_UNREACHABLE" && <p className="hash mt-1 text-xs text-subtle">{api.code}{api.status ? ` (HTTP ${api.status})` : ""}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {icon && <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</span>}
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-[46ch] text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function RowsSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-0 divide-y", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 py-3">
          <Skeleton className="h-4 w-[22%]" />
          <Skeleton className="h-4 w-[30%]" />
          <Skeleton className="ml-auto h-4 w-[14%]" />
        </div>
      ))}
    </div>
  );
}

export function BlockSkeleton({ className }: { className?: string }) {
  return <Skeleton aria-busy="true" aria-label="Loading" className={cn("h-40 w-full rounded-xl", className)} />;
}

/**
 * Pages a role cannot open are hidden from the sidebar; a pasted URL lands here instead of a broken screen. The server
 * refuses the data anyway, so this is only the friendly face of that refusal.
 */
export function RequirePermission({ permission, children }: { permission: Permission | Permission[]; children: ReactNode }) {
  const can = useCan();
  const list = Array.isArray(permission) ? permission : [permission];
  if (list.some((p) => can(p))) return <>{children}</>;
  return (
    <EmptyState icon={<Lock className="size-4" />} title="You do not have access to this page" action={<Button asChild variant="outline"><Link href="/">Go to Home</Link></Button>}>
      Ask an Admin of this business, or the platform owner, if you need it.
    </EmptyState>
  );
}
