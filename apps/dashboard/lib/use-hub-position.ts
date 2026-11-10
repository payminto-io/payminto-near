"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NearReadError } from "@payminto/protocol";
import { useApi } from "./session";
import { useInfo } from "./queries";
import { readErrorText, readerLabel, type ReaderSource } from "./near-reader";
import type { HubPositionRead } from "./seller-settlement";
import type { ReceiptProof } from "./schemas";

export type HubPosition = { read: HubPositionRead; source: ReaderSource | null; hub: string | null; retry: () => void };

/**
 * Reads the hub's settled position of one Budget and Payee (`settled_of`) from this browser, at final finality. It is
 * what a Call its seller settled itself is checked against, since that Call has no batch root. Never the server's word.
 */
export function useHubPosition(p: Pick<ReceiptProof, "receipt">, enabled = true): HubPosition {
  const api = useApi();
  const info = useInfo();
  const source = useMemo(() => (info.data ? api.nearReader(info.data) : null), [api, info.data]);
  const hub = info.data?.hub ?? null;
  const { budgetId, payee } = p.receipt;
  const q = useQuery({
    queryKey: ["near-settled", budgetId, payee, source?.reader.rpcUrl, hub],
    enabled: Boolean(enabled && source && hub),
    queryFn: async () => {
      const r = await source!.reader.view<unknown>(hub!, "settled_of", { budget_id: budgetId, payee });
      if (typeof r.value !== "string" || !/^\d+$/.test(r.value)) throw new NearReadError("invalid_response", `${hub}.settled_of`, "expected an amount");
      return { settled: r.value, blockHeight: r.blockHeight };
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  let read: HubPositionRead;
  if (!enabled) read = { state: "none" };
  else if (info.isPending) read = { state: "reading" };
  else if (info.isError) read = { state: "error", message: "The server's network details could not be loaded, so NEAR was not read." };
  else if (!source) read = { state: "none" };
  else if (q.isPending) read = { state: "reading" };
  else if (q.isError) read = { state: "error", message: readErrorText(q.error) };
  else read = { state: "done", settled: q.data.settled, blockHeight: q.data.blockHeight, source: readerLabel(source) };
  return { read, source, hub, retry: () => void q.refetch() };
}
