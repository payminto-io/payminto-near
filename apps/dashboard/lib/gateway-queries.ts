"use client";

import { getView } from "@/lib/merchant-scope";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./session";
import type { PaymentsQuery, WebhookApi, WebhookScope } from "./gateway-api";

/** Query keys for the gateway screens; every key starts with "gateway" so one invalidation refreshes them all. */
export const gk = {
  all: ["gateway"] as const,
  overview: ["gateway", "overview"] as const,
  payments: (q: PaymentsQuery) => ["gateway", "payments", q] as const,
  payment: (id: string) => ["gateway", "payment", id] as const,
  links: ["gateway", "links"] as const,
  link: (id: string) => ["gateway", "link", id] as const,
  refunds: (paymentId?: string) => ["gateway", "refunds", paymentId ?? "all"] as const,
  webhooks: ["gateway", "webhooks"] as const,
  webhook: (id: string) => ["gateway", "webhook", id] as const,
  deliveries: (id: string) => ["gateway", "deliveries", id] as const,
  keys: ["gateway", "keys"] as const,
  merchant: ["gateway", "merchant"] as const,
  denyList: ["gateway", "deny-list"] as const,
  screening: ["gateway", "screening"] as const,
};

export function useGatewayOverview() {
  const api = useApi();
  return useQuery({ queryKey: gk.overview, queryFn: () => api.gateway.overview(), retry: false });
}

export function usePayments(q: PaymentsQuery) {
  const api = useApi();
  return useQuery({ queryKey: gk.payments(q), queryFn: () => api.gateway.payments(q), placeholderData: (prev) => prev, refetchInterval: 15_000 });
}

export function usePayment(id: string) {
  const api = useApi();
  return useQuery({ queryKey: gk.payment(id), queryFn: () => api.gateway.payment(id), enabled: Boolean(id), refetchInterval: 10_000 });
}

export function useLinks() {
  const api = useApi();
  return useQuery({ queryKey: gk.links, queryFn: () => api.gateway.links() });
}

export function useLink(id: string) {
  const api = useApi();
  return useQuery({ queryKey: gk.link(id), queryFn: () => api.gateway.link(id), enabled: Boolean(id) });
}

export function useRefunds(paymentId?: string) {
  const api = useApi();
  return useQuery({ queryKey: gk.refunds(paymentId), queryFn: () => api.gateway.refunds({ payment_id: paymentId }) });
}

/** The webhook routes for a scope: a business's endpoints, or the platform's refusal alerts. */
export function useWebhookApi(scope: WebhookScope = "business"): WebhookApi {
  const api = useApi();
  return scope === "platform" ? api.platformWebhooks : api.gateway;
}

export function useWebhooks(scope: WebhookScope = "business") {
  const hooks = useWebhookApi(scope);
  return useQuery({ queryKey: [...gk.webhooks, scope], queryFn: () => hooks.webhooks() });
}

export function useWebhook(id: string, scope: WebhookScope = "business") {
  const hooks = useWebhookApi(scope);
  return useQuery({ queryKey: [...gk.webhook(id), scope], queryFn: () => hooks.webhook(id), enabled: Boolean(id) });
}

export function useDeliveries(endpointId: string, scope: WebhookScope = "business") {
  const hooks = useWebhookApi(scope);
  return useQuery({ queryKey: [...gk.deliveries(endpointId), scope], queryFn: () => hooks.deliveries(endpointId), enabled: Boolean(endpointId) });
}

export function useApiKeys() {
  const api = useApi();
  return useQuery({ queryKey: gk.keys, queryFn: () => api.gateway.apiKeys() });
}

/** The open business; `merchantId` names a record's own business (a detail page opened on the platform view). */
export function useMerchant(merchantId?: string | null) {
  const api = useApi();
  const scoped = merchantId && getView()?.kind !== "business" ? merchantId : undefined;
  return useQuery({ queryKey: scoped ? [...gk.merchant, scoped] : gk.merchant, queryFn: () => api.gateway.merchant(scoped), staleTime: 60_000 });
}

export function useDenyList() {
  const api = useApi();
  return useQuery({ queryKey: gk.denyList, queryFn: () => api.gateway.denyList() });
}

export function useScreeningDecisions() {
  const api = useApi();
  return useQuery({ queryKey: gk.screening, queryFn: () => api.gateway.screeningDecisions() });
}
