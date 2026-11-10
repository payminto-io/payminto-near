import type { AccountId, Network } from "@payminto/chain";

export type TokenInfo = { address: AccountId; symbol: string; decimals: number };

export type NetworkConfig = {
  network: Network;
  name: string;
  testnet: boolean;
  rpcUrl: string;
  /** Empty when the network has no public explorer. */
  explorer: string;
  token: TokenInfo;
  /** The shared public hub for this network, when one is deployed. Nodes may override it in config. */
  clearingHub?: AccountId;
};

/** Circle testnet USDC on NEAR. */
export const NEAR_TESTNET_USDC: AccountId = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/** There is no mainnet node mode in this submission, so `near:mainnet` is deliberately absent. */
export const networks: Partial<Record<Network, NetworkConfig>> = {
  "near:testnet": {
    network: "near:testnet",
    name: "NEAR testnet",
    testnet: true,
    rpcUrl: "https://rpc.testnet.near.org",
    explorer: "https://testnet.nearblocks.io",
    token: { address: NEAR_TESTNET_USDC, symbol: "USDC", decimals: 6 },
  },
  "near:sandbox": {
    network: "near:sandbox",
    name: "Local NEAR sandbox",
    testnet: true,
    rpcUrl: "http://127.0.0.1:3030",
    explorer: "",
    token: { address: "usdc.sandbox", symbol: "USDC", decimals: 6 },
  },
};

export function networkFor(network: Network): NetworkConfig {
  const n = networks[network];
  if (!n) throw new Error(`Unsupported network ${network}. Supported: ${Object.keys(networks).join(", ")}`);
  return n;
}

export function explorerTx(network: Network, hash: string): string | null {
  const base = networks[network]?.explorer;
  return base ? `${base}/txns/${hash}` : null;
}

export function explorerAddress(network: Network, account: string): string | null {
  const base = networks[network]?.explorer;
  return base ? `${base}/address/${account}` : null;
}
