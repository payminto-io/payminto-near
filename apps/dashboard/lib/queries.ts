"use client";

import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { explorerAddress, explorerTx } from "@payminto/protocol";
import { useApi, useSession } from "./session";
import type { CallsQuery } from "./api";
import type { Call, Info } from "./schemas";

export const qk = {
  info: ["info"] as const,
  health: ["health"] as const,
  overview: ["overview"] as const,
  mandates: ["mandates"] as const,
  mandate: (id: string) => ["mandates", id] as const,
  providers: ["providers"] as const,
  calls: (q: CallsQuery) => ["calls", q] as const,
  denials: ["denials"] as const,
  batches: ["batches"] as const,
  batch: (id: string) => ["batches", id] as const,
  preview: ["netting-preview"] as const,
  ledger: (account?: string, limit = 200) => ["ledger", account ?? "all", limit] as const,
  trialBalance: ["trial-balance"] as const,
  proof: (id: string) => ["proof", id] as const,
};

export function useInfo() {
  const api = useApi();
  return useQuery({ queryKey: qk.info, queryFn: () => api.info(), staleTime: 60_000 });
}

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: qk.health, queryFn: () => api.health(), refetchInterval: 15_000 });
}

export function useOverview() {
  const api = useApi();
  return useQuery({ queryKey: qk.overview, queryFn: () => api.overview() });
}

/** Agent data needs `agents.read` (platform roles only this round); business screens skip it instead of a 403. */
function useAgentsReadable(): boolean {
  const s = useSession();
  if (s.status !== "signed-in") return false;
  return s.session.actorType === "recovery_key" || s.session.grants.platform.includes("agents.read");
}

export function useMandates() {
  const api = useApi();
  const enabled = useAgentsReadable();
  return useQuery({ queryKey: qk.mandates, queryFn: () => api.mandates(), enabled });
}

export function useMandate(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.mandate(id), queryFn: () => api.mandate(id), enabled: Boolean(id) });
}

/** The public provider catalog in one request: enough to name payee wallets without waiting for per-provider detail. */
export function useProviderCatalog() {
  const api = useApi();
  return useQuery({ queryKey: [...qk.providers, "catalog"], queryFn: () => api.providerCatalog(), staleTime: 30_000 });
}

export function useProviders() {
  const api = useApi();
  return useQuery({ queryKey: qk.providers, queryFn: () => api.providers() });
}

export function useCalls(q: CallsQuery = {}) {
  const api = useApi();
  return useQuery({ queryKey: qk.calls(q), queryFn: () => api.calls(q) });
}

/** Cursor-paged calls for "Load more" lists; pages follow the node's nextCursor. */
export function useCallPages(q: Omit<CallsQuery, "cursor">) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ["calls", "pages", q],
    queryFn: ({ pageParam }) => api.calls({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Flattens loaded pages, dropping repeats when new calls shift a page boundary between fetches. */
export function flattenCallPages(pages: { items: Call[] }[] | undefined): Call[] {
  const seen = new Set<string>();
  const out: Call[] = [];
  for (const p of pages ?? []) {
    for (const c of p.items) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export function useDenials() {
  const api = useApi();
  return useQuery({ queryKey: qk.denials, queryFn: () => api.denials(100) });
}

export function useBatches() {
  const api = useApi();
  return useQuery({ queryKey: qk.batches, queryFn: () => api.batches() });
}

export function useBatch(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.batch(id), queryFn: () => api.batch(id), enabled: Boolean(id) });
}

export function useNettingPreview() {
  const api = useApi();
  return useQuery({ queryKey: qk.preview, queryFn: () => api.nettingPreview() });
}

export function useLedger(account?: string, limit = 200) {
  const api = useApi();
  return useQuery({ queryKey: qk.ledger(account, limit), queryFn: () => api.ledger({ account, limit }), placeholderData: (prev) => prev });
}

export function useTrialBalance() {
  const api = useApi();
  return useQuery({ queryKey: qk.trialBalance, queryFn: () => api.trialBalance() });
}

export function useProof(callId: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.proof(callId), queryFn: () => api.receiptProof(callId), enabled: /^0x[0-9a-fA-F]{64}$/.test(callId), retry: false });
}

export type TokenMeta = { symbol: string; decimals: number };

/** Settlement token display metadata, with USDC / 6 dp as the honest default until /v1/info answers. */
export function useToken(): TokenMeta {
  const { data } = useInfo();
  return { symbol: data?.token.symbol ?? "USDC", decimals: data?.token.decimals ?? 6 };
}

export function chainIdOf(info: Info | undefined): number {
  if (!info) return 0;
  return info.chainId ?? info.network.chainId;
}

/** Explorer links, preferring the explorer base the node advertises. */
export function useExplorer() {
  const { data } = useInfo();
  return useMemo(() => {
    const base = data?.explorer?.replace(/\/+$/, "") || null;
    const chainId = chainIdOf(data);
    return {
      tx: (hash: string) => (base ? `${base}/tx/${hash}` : explorerTx(chainId, hash)),
      address: (a: string) => (base ? `${base}/address/${a}` : explorerAddress(chainId, a)),
    };
  }, [data]);
}

export type Party = { name: string; kind: "agent" | "provider" | "owner" | "operator" | "hub" | "unknown"; address: string };

/** Names wallets the way an operator thinks about them: by provider name or mandate agent label. */
export function useDirectory() {
  const mandates = useMandates();
  const providers = useProviderCatalog();
  const info = useInfo();
  return useMemo(() => {
    const map = new Map<string, Party>();
    const put = (address: string, p: Omit<Party, "address">) => {
      const k = address.toLowerCase();
      if (!map.has(k)) map.set(k, { ...p, address });
    };
    for (const p of providers.data ?? []) put(p.payee, { name: p.name, kind: "provider" });
    for (const m of mandates.data ?? []) {
      put(m.mandate.agent, { name: m.label.split(" - ")[0] ?? m.label, kind: "agent" });
    }
    for (const m of mandates.data ?? []) put(m.mandate.owner, { name: "Budget owner", kind: "owner" });
    if (info.data) {
      put(info.data.operator, { name: "Server wallet", kind: "operator" });
      put(info.data.hub, { name: "Settlement contract", kind: "hub" });
    }
    const lookup = (address: string | null | undefined): Party | null => (address ? map.get(address.toLowerCase()) ?? null : null);
    const isAlsoAgent = (address: string) => (mandates.data ?? []).some((m) => m.mandate.agent.toLowerCase() === address.toLowerCase());
    return { lookup, isAlsoAgent, ready: Boolean(mandates.data && providers.data) };
  }, [mandates.data, providers.data, info.data]);
}
