"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { checkoutWords, escrowFull, escrowShort, networkInWords } from "./disclosures";
import { qk } from "./queries";
import type { Info } from "./schemas";

const ENV_NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK ? `near:${process.env.NEXT_PUBLIC_NEAR_NETWORK}` : null;

/**
 * The network this page's server runs on, from the `/v1/info` already read by the console (signed in) or by a public
 * checkout page. It only listens to those reads and never starts one, so it works on every page; until one has
 * answered, the wallet network this dashboard was built for stands in.
 */
export function useNetworkId(): string | null {
  const console = useQuery<Info>({ queryKey: qk.info, queryFn: skipToken });
  const checkout = useQuery<Info>({ queryKey: ["checkout-info"], queryFn: skipToken });
  return console.data?.network.id ?? checkout.data?.network.id ?? ENV_NETWORK;
}

/** The custody wording for the network this page's server runs on; a live any-chain server says the money is never held. */
export function useNetworkWords() {
  const id = useNetworkId();
  const console = useQuery<Info>({ queryKey: qk.info, queryFn: skipToken });
  const checkout = useQuery<Info>({ queryKey: ["checkout-info"], queryFn: skipToken });
  const info = console.data ?? checkout.data;
  const short = info ? checkoutWords(info).escrowShort : escrowShort(id);
  return { id, network: networkInWords(id), escrowShort: short, escrowFull: escrowFull(id) };
}
