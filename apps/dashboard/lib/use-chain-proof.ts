"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { checkReceiptOnChain, type Id32 } from "@payminto/protocol";
import { useApi } from "./session";
import { networkIdOf, useInfo } from "./queries";
import { readErrorText, readerLabel, type ReaderSource } from "./near-reader";
import { rebuildLeaf, receiptFieldsOf, type ChainRead } from "./proof";
import type { ReceiptProof } from "./schemas";

export type ChainProof = {
  read: ChainRead;
  /** The leaf rebuilt here, once the hub and network are known and the Call is in a batch. */
  leaf: Id32 | null;
  source: ReaderSource | null;
  hub: string | null;
  retry: () => void;
};

/**
 * Proves one Call against NEAR from this browser: reads the stored batch root and the hub's verify_receipt through the
 * configured RPC, and rebuilds the leaf and root here. Shared by the verdict and the Merkle path, so one read serves both.
 */
export function useChainProof(p: ReceiptProof): ChainProof {
  const api = useApi();
  const info = useInfo();
  const network = info.data ? networkIdOf(info.data) : null;
  const source = useMemo(() => (info.data ? api.nearReader(info.data) : null), [api, info.data]);
  const hub = info.data?.hub ?? null;
  const leaf = useMemo(() => (hub && network ? rebuildLeaf(p, { hub, network }) : null), [hub, network, p]);
  const q = useQuery({
    queryKey: ["near-proof", p.receipt.callId, p.batchId, source?.reader.rpcUrl, hub],
    enabled: Boolean(source && network && p.batchId),
    queryFn: () => checkReceiptOnChain(source!.reader, { network: network!, batchId: p.batchId!, fields: receiptFieldsOf(p.receipt), proof: p.proof }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  let read: ChainRead;
  if (!p.batchId) read = { state: "none" };
  else if (info.isPending) read = { state: "reading" };
  else if (info.isError) read = { state: "error", message: "The server's network details could not be loaded, so NEAR was not read." };
  else if (!source) read = { state: "none" };
  else if (q.isPending) read = { state: "reading" };
  else if (q.isError) read = { state: "error", message: readErrorText(q.error) };
  else read = { state: "done", check: q.data, source: readerLabel(source) };
  return { read, leaf, source, hub, retry: () => void q.refetch() };
}
