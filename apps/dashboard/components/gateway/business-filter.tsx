"use client";

/**
 * On the platform view, lists show every business (PRODUCT.md section 3.2): a Business column and this filter.
 * Items carry `merchant_id`; detail links add `?b=` so the detail asks the right business.
 */
import { useMemo } from "react";
import { useAccess } from "@/lib/session";
import { useMerchants } from "@/lib/operator-queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function useBusinessNames(): { platformView: boolean; nameOf: (id: string | null | undefined) => string | null } {
  const access = useAccess();
  const merchants = useMerchants();
  return useMemo(() => {
    const map = new Map((merchants.data ?? []).map((m) => [m.id, m.name]));
    return { platformView: access.platformView, nameOf: (id) => (id ? map.get(id) ?? id : null) };
  }, [access.platformView, merchants.data]);
}

export function BusinessFilter({ value, onChange, className }: { value: string | null; onChange: (id: string | null) => void; className?: string }) {
  const access = useAccess();
  const merchants = useMerchants();
  if (!access.platformView) return null;
  return (
    <Select value={value ?? "all"} onValueChange={(v) => onChange(v === "all" ? null : v)}>
      <SelectTrigger aria-label="Filter by business" className={className ?? "h-9 w-full sm:w-52"}>
        <SelectValue placeholder="All businesses" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All businesses</SelectItem>
        {(merchants.data ?? []).map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Payments an AI agent made: the agent methods (PRODUCT.md section 3.3, "Agent payments"). */
export const AGENT_METHODS = ["voucher"] as const;
export function isAgentPayment(p: { method: string | null }): boolean {
  return p.method === "voucher";
}
