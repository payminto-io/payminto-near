import { NearRpcChain } from "@payminto/chain/node";
import type { AccountId, Network } from "@payminto/protocol";
import type { ChainReader } from "./wallet.ts";

/**
 * The read-only NEAR client behind `prove_receipt` and `get_budget`: a `NearRpcChain` with no operator key, so it can
 * read Budgets, batches and the hub's `verify_receipt` view and can never sign. Built from the node's /v1/info, then
 * checked against the configured hub and network by the wallet.
 */
export function rpcChainReader(rpcUrl: string) {
  return (info: { hub: AccountId; token: AccountId; network: Network; operator: AccountId }): ChainReader =>
    new NearRpcChain({ rpcUrl, hub: info.hub, token: info.token, network: info.network, operator: info.operator });
}
