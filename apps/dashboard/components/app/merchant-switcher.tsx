"use client";

/** Business scope helpers kept for screens written before the account switcher (components/app/account-switcher.tsx). */
import { useCallback } from "react";
import { useView } from "@/lib/session";
import { useSwitchView } from "./account-switcher";

/** The open business, or null on the platform view. */
export function useMerchantScope(): string | null {
  const v = useView();
  return v?.kind === "business" ? v.merchantId : null;
}

/** Opens one business (for example "Open this business" on a business detail page). */
export function useSwitchMerchant(): (id: string) => void {
  const switchView = useSwitchView();
  return useCallback((id: string) => switchView({ kind: "business", merchantId: id }), [switchView]);
}
