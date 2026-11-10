"use client";

import { useQuery } from "@tanstack/react-query";
import type { WalletTx } from "@payminto/protocol";
import { useApi } from "./session";
import { networkIdOf, useInfo } from "./queries";
import { RelayError, relayRefusal, relayer, type RelayerClient, type RelayerInfo } from "./relayer";
import type { ReaderSource } from "./near-reader";

/**
 * Whether one zero-deposit hub call can be sent without gas right now, and if not, why in one sentence.
 * - `off`: no relayer is configured, so the option is not offered.
 * - `checking`: the relayer's `/info` has not answered yet.
 * - `unavailable`: a relayer is configured and cannot carry this call; `reason` says why and `retry` asks it again.
 * - `ready`: the relayer sponsors this server's hub and this method.
 */
export type GaslessOffer =
  | { state: "off" }
  | { state: "checking" }
  | { state: "unavailable"; reason: string; retry: () => void }
  | { state: "ready"; info: RelayerInfo; client: RelayerClient; source: ReaderSource; node: { hub: string; network: ReturnType<typeof networkIdOf> } };

function unreachableReason(client: RelayerClient, e: unknown): string {
  const who = client.demo ? "The demo relayer" : `The relayer at ${client.host}`;
  if (e instanceof RelayError && e.code === "BAD_RESPONSE") return `${who} answered with something this page does not understand, so sending without gas is unavailable. Use the button beside this, which sends from your own wallet.`;
  return `${who} is not answering, so sending without gas is unavailable. Use the button beside this, which sends from your own wallet.`;
}

/** Reads the relayer's `/info` once per page and judges `tx` against it. A null `tx` only reports whether one is set up. */
export function useGaslessOffer(tx: WalletTx | null): GaslessOffer {
  const api = useApi();
  const info = useInfo();
  const client = relayer();
  const q = useQuery({
    queryKey: ["relayer-info", client?.url ?? "none"],
    queryFn: () => client!.info(),
    enabled: client !== null,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!client) return { state: "off" };
  const retry = () => void q.refetch();
  if (q.isPending || info.isPending || q.isRefetching) return { state: "checking" };
  if (q.isError) return { state: "unavailable", reason: unreachableReason(client, q.error), retry };
  if (!info.data || !tx) return { state: "checking" };
  const node = { hub: info.data.hub, network: networkIdOf(info.data) };
  const refusal = relayRefusal(q.data, node, tx);
  if (refusal) return { state: "unavailable", reason: refusal, retry };
  const source = api.nearReader(info.data);
  if (!source) return { state: "unavailable", reason: "No NEAR RPC is configured for this network, so a signed action could not be checked before sending.", retry };
  return { state: "ready", info: q.data, client, source, node };
}
