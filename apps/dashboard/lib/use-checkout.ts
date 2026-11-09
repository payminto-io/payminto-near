"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCheckoutApi, type CheckoutApi } from "./gateway-api";
import { checkoutViewSchema, type CheckoutView } from "./schemas";
import { gatewayNetwork } from "./gateway";

export type CheckoutLive = "connecting" | "live" | "polling";

const FINAL = new Set(["paid", "overpaid", "underpaid", "expired", "canceled"]);

/** Nothing left to watch: a terminal status with no credit still confirming. Late deposits still show on reload. */
export function isSettledView(v: Pick<CheckoutView, "status" | "confirmations">): boolean {
  return FINAL.has(v.status) && !v.confirmations;
}

/** The public client, resolved once per tab (mock mode loads the in-browser node lazily). */
export function useCheckoutApi(): CheckoutApi | null {
  const [api, setApi] = useState<CheckoutApi | null>(null);
  useEffect(() => {
    let alive = true;
    void getCheckoutApi().then((a) => alive && setApi(a));
    return () => {
      alive = false;
    };
  }, []);
  return api;
}

/**
 * The public payment view, kept current by the SSE stream (`status` events) with polling as the fallback whenever the
 * stream is not open.
 */
export function useCheckout(id: string) {
  const api = useCheckoutApi();
  const qc = useQueryClient();
  const [live, setLive] = useState<CheckoutLive>("connecting");
  const key = ["checkout", id] as const;

  const q = useQuery({
    queryKey: key,
    queryFn: () => api!.checkout(id),
    enabled: Boolean(api),
    retry: (n, e) => !(e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) && n < 2,
    refetchInterval: (query) => {
      const v = query.state.data;
      if (v && isSettledView(v)) return false;
      return live === "live" ? false : 4000;
    },
  });

  useEffect(() => {
    if (!api) return;
    const put = (v: CheckoutView) => qc.setQueryData(["checkout", id], v);
    if (api.subscribe) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the in-process stream is open as soon as it is subscribed
      setLive("live");
      return api.subscribe(id, put);
    }
    const url = api.eventsUrl(id);
    if (!url) {
      setLive("polling");
      return;
    }
    const es = new EventSource(url);
    es.onopen = () => setLive("live");
    es.onerror = () => setLive("polling");
    const onStatus = (m: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(m.data) as unknown;
        const parsed = checkoutViewSchema.safeParse(raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw);
        if (parsed.success) put(parsed.data);
        else void qc.invalidateQueries({ queryKey: ["checkout", id] });
      } catch {
        // The poll stays authoritative when a frame is malformed.
        void qc.invalidateQueries({ queryKey: ["checkout", id] });
      }
    };
    es.addEventListener("status", onStatus as EventListener);
    return () => {
      es.removeEventListener("status", onStatus as EventListener);
      es.close();
    };
  }, [api, id, qc]);

  const info = useQuery({ queryKey: ["checkout-info"], queryFn: () => api!.info(), enabled: Boolean(api), staleTime: Infinity, retry: 1 });
  const network = q.data ? gatewayNetwork(q.data.chain_id, info.data) : null;

  return { api, query: q, live, key, network };
}
