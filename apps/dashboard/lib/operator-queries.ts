"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi, useCan } from "./session";

/** Operator query keys; all start with "operator" so one invalidation refreshes the area. */
export const ok = {
  all: ["operator"] as const,
  platform: ["operator", "platform"] as const,
  fees: ["operator", "fees"] as const,
  merchants: ["operator", "merchants"] as const,
  merchant: (id: string) => ["operator", "merchant", id] as const,
  methods: (id: string) => ["operator", "methods", id] as const,
  plans: ["operator", "plans"] as const,
};

export function usePlatform() {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: ok.platform, queryFn: () => api.operator.platform(), enabled: can("platform.read") });
}
export function usePlatformFees() {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: ok.fees, queryFn: () => api.operator.platformFees(), enabled: can("earnings.read") });
}
export function useMerchants() {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: ok.merchants, queryFn: () => api.operator.merchants(), enabled: can("businesses.read"), staleTime: 30_000 });
}
export function useOperatorMerchant(id: string) {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: ok.merchant(id), queryFn: () => api.operator.merchant(id), enabled: Boolean(id) && can("businesses.read") });
}
export function useMerchantMethods(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: ok.methods(id ?? ""), queryFn: () => api.operator.methods(id!), enabled: Boolean(id) });
}
export function useFeePlans() {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: ok.plans, queryFn: () => api.operator.feePlans(), enabled: can("pricing.read") });
}
