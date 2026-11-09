import { defineChain, type Address, type Chain } from "viem";
import { sepolia } from "viem/chains";
import { chainConfig as opStackChainConfig } from "viem/op-stack";
import { hashkeyContracts, hashkeyNetworkFacts } from "./hashkey.ts";

export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  /** EIP-712 domain of the token itself, needed for EIP-2612 permit and EIP-3009. */
  eip712: { name: string; version: string };
};

export type NetworkConfig = {
  chain: Chain;
  /** CAIP-2 id used in x402 payment requirements. */
  caip2: `eip155:${number}`;
  explorer: string;
  /** Default settlement stablecoin. */
  token: TokenInfo;
  /** Deployed ClearingHub, when known at build time. Nodes may override via config. */
  clearingHub?: Address;
};

// HashKey Chain is an OP Stack L2: the op-stack config adds receipt formatters that expose l1Fee and l1GasUsed.
export const hashkeyMainnet: Chain = defineChain({
  ...opStackChainConfig,
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HashKey Platform Token", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz", ...hashkeyNetworkFacts[177].fallbackRpcUrls] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://hsk.blockscout.com", apiUrl: "https://hsk.blockscout.com/api" } },
  contracts: { ...opStackChainConfig.contracts, multicall3: { address: hashkeyContracts[177].multicall3 } },
});

// The testnet explorer lives at hskchain.net; testnet-explorer.hsk.xyz does not resolve (checked 2026-10-29).
export const hashkeyTestnet: Chain = defineChain({
  ...opStackChainConfig,
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HashKey Platform Token", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz", ...hashkeyNetworkFacts[133].fallbackRpcUrls] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://testnet-explorer.hskchain.net", apiUrl: "https://testnet-explorer.hskchain.net/api" },
  },
  contracts: { ...opStackChainConfig.contracts, multicall3: { address: hashkeyContracts[133].multicall3 } },
  testnet: true,
});

// Ethereum Sepolia: where Circle publishes its official test USDC (faucet.circle.com), so payments can be tested with
// a real FiatToken. The hackathon organisers name it as the USDC test network.
export const ethereumSepolia: Chain = {
  ...sepolia,
  rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com", ...sepolia.rpcUrls.default.http] } },
};

export const localAnvil: Chain = defineChain({
  id: 31337,
  name: "Local test network",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const networks: Record<number, NetworkConfig> = {
  177: {
    chain: hashkeyMainnet,
    caip2: "eip155:177",
    explorer: "https://hsk.blockscout.com",
    // Verified live: supports EIP-2612 and EIP-3009; domain name is "Bridged USDC".
    token: {
      address: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
      symbol: "USDC.e",
      decimals: 6,
      eip712: { name: "Bridged USDC", version: "2" },
    },
  },
  133: {
    chain: hashkeyTestnet,
    caip2: "eip155:133",
    explorer: "https://testnet-explorer.hskchain.net",
    token: {
      address: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USD Coin", version: "2" },
    },
  },
  11155111: {
    chain: ethereumSepolia,
    caip2: "eip155:11155111",
    explorer: "https://sepolia.etherscan.io",
    // Circle's FiatToken v2.2 on Sepolia, verified live on 2026-11-02: name() "USDC", version() "2", EIP-3009.
    token: {
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USDC", version: "2" },
    },
  },
  31337: {
    chain: localAnvil,
    caip2: "eip155:31337",
    explorer: "",
    // Address is filled from contracts/deployments/31337.json at runtime.
    token: {
      address: "0x0000000000000000000000000000000000000000",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USD Coin", version: "1" },
    },
  },
};

export function networkFor(chainId: number): NetworkConfig {
  const n = networks[chainId];
  if (!n) throw new Error(`Unsupported chain ${chainId}. Supported: ${Object.keys(networks).join(", ")}`);
  return n;
}

export function explorerTx(chainId: number, hash: string): string | null {
  const base = networks[chainId]?.explorer;
  return base ? `${base}/tx/${hash}` : null;
}

export function explorerAddress(chainId: number, address: string): string | null {
  const base = networks[chainId]?.explorer;
  return base ? `${base}/address/${address}` : null;
}
