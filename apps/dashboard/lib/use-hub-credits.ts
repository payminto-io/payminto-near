"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NearReadError } from "@payminto/protocol";
import { useApi } from "./session";
import { useInfo } from "./queries";
import { readErrorText } from "./near-reader";
import type { PayoutAccount } from "./schemas";

export type HubCredits = { credits: ReadonlyMap<string, string>; state: "reading" | "done" | "error" | "none"; message: string | null; retry: () => void };

/**
 * The hub's credit of each account, read from this browser with `credit_of` at final finality. The server keeps its
 * own copy for its payout queue and updates it only when it runs, so a payment that just credited a merchant shows
 * here before the server has looked. Never the server's word.
 */
export function useHubCredits(accounts: readonly string[]): HubCredits {
  const api = useApi();
  const info = useInfo();
  const source = useMemo(() => (info.data ? api.nearReader(info.data) : null), [api, info.data]);
  const hub = info.data?.hub ?? null;
  const key = [...accounts].sort().join(",");
  const q = useQuery({
    queryKey: ["near-credit", hub, source?.reader.rpcUrl, key],
    enabled: Boolean(source && hub && accounts.length > 0),
    queryFn: async () => {
      const out = new Map<string, string>();
      // One view per account, in parallel. A hub has no batch read for credit.
      await Promise.all(
        accounts.map(async (account) => {
          const r = await source!.reader.view<unknown>(hub!, "credit_of", { account });
          if (typeof r.value !== "string" || !/^\d+$/.test(r.value)) throw new NearReadError("invalid_response", `${hub}.credit_of`, "expected an amount");
          out.set(account, r.value);
        }),
      );
      return out;
    },
    refetchInterval: 15_000,
    retry: false,
  });
  if (!source || accounts.length === 0) return { credits: new Map(), state: "none", message: null, retry: () => undefined };
  if (q.isPending) return { credits: new Map(), state: "reading", message: null, retry: () => void q.refetch() };
  if (q.isError) return { credits: new Map(), state: "error", message: readErrorText(q.error), retry: () => void q.refetch() };
  return { credits: q.data, state: "done", message: null, retry: () => void q.refetch() };
}

export type PayoutRow = PayoutAccount & { hubCredit: string | null };

/**
 * Where an account stands, by the hub's credit when it was read: credit on the hub is due unless the server knows the
 * account waits for token registration, and an account the hub owes nothing is paid out. Without a hub read, the
 * server's own figures stand.
 */
export function payoutRows(accounts: readonly PayoutAccount[], credits: ReadonlyMap<string, string>): PayoutRow[] {
  return accounts.map((a) => {
    const hubCredit = credits.get(a.account) ?? null;
    if (hubCredit === null) return { ...a, hubCredit };
    const owed = BigInt(hubCredit) > 0n;
    const status: PayoutAccount["status"] = !owed ? "clear" : a.status === "waiting_registration" ? "waiting_registration" : "due";
    return { ...a, status, credit: hubCredit, hubCredit };
  });
}
