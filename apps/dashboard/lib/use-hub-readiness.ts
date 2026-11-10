"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NearReadError } from "@payminto/protocol";
import { useApi, useCan } from "./session";
import { useInfo } from "./queries";
import { readErrorText, type ReaderSource } from "./near-reader";
import { MIN_SETTLE_STORAGE_YOCTO, hubReadinessProblems, receiptKeyText, type HubReadinessProblem, type HubStanding } from "./hub-readiness";

export type HubReadiness = {
  /** `off`: this person does not run the server, or the page has no RPC. `error`: the hub could not be read. */
  state: "off" | "reading" | "error" | "done";
  standing: HubStanding | null;
  problems: HubReadinessProblem[];
  /** Why the hub could not be read, when `state` is "error". Nothing is known either way then. */
  error: string | null;
  source: ReaderSource | null;
  minStorageYocto: bigint;
  retry: () => void;
};

/**
 * Reads the server's standing on the hub from this browser: the receipt keys its account registered (`receipt_keys`) and
 * its prepaid storage balance (`storage_of`), at final finality. The server checks the same at startup but reports it
 * only in its log and metrics, so the dashboard asks the hub itself. A read that fails raises no warning.
 */
export function useHubReadiness(): HubReadiness {
  const api = useApi();
  const can = useCan();
  const info = useInfo();
  const allowed = can("platform.read") || can("agents.manage");
  const source = useMemo(() => (allowed && info.data ? api.nearReader(info.data) : null), [allowed, api, info.data]);
  const hub = info.data?.hub ?? null;
  const operator = info.data?.operator ?? null;
  const q = useQuery({
    queryKey: ["hub-readiness", hub, operator, source?.reader.rpcUrl],
    enabled: Boolean(source && hub && operator),
    queryFn: async (): Promise<HubStanding> => {
      const [keys, storage] = await Promise.all([
        source!.reader.view<unknown>(hub!, "receipt_keys", { settler: operator }),
        source!.reader.view<unknown>(hub!, "storage_of", { account: operator }),
      ]);
      if (!Array.isArray(keys.value)) throw new NearReadError("invalid_response", `${hub}.receipt_keys`, "expected a list of keys");
      if (typeof storage.value !== "string" || !/^\d+$/.test(storage.value)) throw new NearReadError("invalid_response", `${hub}.storage_of`, "expected an amount");
      return { receiptKeys: keys.value.map(receiptKeyText), storageYocto: BigInt(storage.value) };
    },
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const problems = useMemo(
    () => (q.data && hub && operator ? hubReadinessProblems({ operator, hub, nodeKey: info.data?.nodeKey ?? null }, q.data) : []),
    [q.data, hub, operator, info.data?.nodeKey],
  );
  const state: HubReadiness["state"] = !allowed || (info.data && !source) ? "off" : info.isError || q.isError ? "error" : q.data ? "done" : "reading";
  return {
    state,
    standing: q.data ?? null,
    problems,
    error: q.isError ? readErrorText(q.error) : info.isError ? "The server's network details could not be loaded, so the hub was not read." : null,
    source,
    minStorageYocto: MIN_SETTLE_STORAGE_YOCTO,
    retry: () => void q.refetch(),
  };
}
