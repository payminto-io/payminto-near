"use client";

/**
 * Reads for the Balance, Earnings and setup screens. A live server answers them on its own routes (lib/operator-api.ts);
 * the in-browser demo (NEXT_PUBLIC_MOCK=1) has no such routes, so each read is put together here from what the demo
 * does serve, and Earnings falls back to the 30 days of `GET /v1/platform/fees`.
 */
import { useQuery } from "@tanstack/react-query";
import type { ClearingApi } from "./api";
import { ApiError } from "./http";
import { HttpOperatorApi } from "./operator-api";
import { balanceFromPayouts } from "./balance";
import type { FeeMonth, MerchantBalance, PayoutHistory } from "./platform-schemas";
import { useApi, useCan } from "./session";

export async function fetchMerchantBalance(api: ClearingApi, merchantId: string): Promise<MerchantBalance> {
  if (api.operator instanceof HttpOperatorApi) return api.operator.merchantBalance(merchantId);
  const [m, p] = await Promise.all([api.gateway.merchant(), api.payouts()]);
  return balanceFromPayouts(merchantId, m.payout, m.network, p);
}

/** Null when the server predates the route (or in the demo): Earnings then groups the last 30 days instead. */
export async function fetchFeeMonths(api: ClearingApi): Promise<FeeMonth[] | null> {
  if (!(api.operator instanceof HttpOperatorApi)) return null;
  try {
    return await api.operator.feeMonths();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchPayoutHistory(api: ClearingApi, merchantId: string): Promise<PayoutHistory> {
  if (api.operator instanceof HttpOperatorApi) return api.operator.payoutHistory(merchantId);
  const m = await api.gateway.merchant();
  return { payout: m.payout, payout_history: undefined };
}

export const bk = {
  balance: (merchantId: string) => ["balance", merchantId] as const,
  feeMonths: ["operator", "fee-months"] as const,
  payoutHistory: (merchantId: string) => ["balance", "payout-history", merchantId] as const,
};

export function useMerchantBalance(merchantId: string | null) {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: bk.balance(merchantId ?? ""), queryFn: () => fetchMerchantBalance(api, merchantId!), enabled: Boolean(merchantId) && can("payments.read"), refetchInterval: 30_000 });
}

export function useFeeMonths() {
  const api = useApi();
  const can = useCan();
  return useQuery({ queryKey: bk.feeMonths, queryFn: () => fetchFeeMonths(api), enabled: can("earnings.read") });
}

export function usePayoutHistory(merchantId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: bk.payoutHistory(merchantId ?? ""), queryFn: () => fetchPayoutHistory(api, merchantId!), enabled: Boolean(merchantId), staleTime: 60_000 });
}
