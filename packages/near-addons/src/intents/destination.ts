/**
 * Where a business's USDC lands ("receive as"): native USDC on NEAR, the default, or USDC on an EVM chain delivered by
 * 1Click to the business's own address there. Only USDC with 6 decimals is offered, so an invoice amount passes through
 * unchanged. Also the EIP-191 proof a business signs to show it controls the EVM address.
 */
import { NEAR_MAINNET_USDC, NEAR_MAINNET_USDC_ASSET } from "./types.ts";

export const EVM_PAYOUT_CHAINS = ["base", "arb", "eth", "pol", "op"] as const;
export type EvmPayoutChain = (typeof EVM_PAYOUT_CHAINS)[number];
export type PayoutChain = "near" | EvmPayoutChain;

export type PayoutDestination = {
  /** The 1Click `blockchain` code. */
  blockchain: PayoutChain;
  chainName: string;
  symbol: "USDC";
  /** The 1Click asset id: `destinationAsset` of the quote. */
  assetId: string;
  decimals: 6;
  /** The token contract on its chain (the NEP-141 account on NEAR, the ERC-20 on an EVM chain). */
  contractAddress: string;
  /** The EVM chain id; null on NEAR. */
  chainId: number | null;
};

/**
 * Verbatim from the live `/v0/tokens` (2026-11-13). Every other USDC 1Click lists is left out: BNB Chain's has 18
 * decimals, and the rest are chains this checkout cannot read a delivery on.
 */
export const PAYOUT_DESTINATIONS: readonly PayoutDestination[] = [
  { blockchain: "near", chainName: "NEAR", symbol: "USDC", assetId: NEAR_MAINNET_USDC_ASSET, decimals: 6, contractAddress: NEAR_MAINNET_USDC, chainId: null },
  { blockchain: "base", chainName: "Base", symbol: "USDC", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", chainId: 8453 },
  { blockchain: "arb", chainName: "Arbitrum", symbol: "USDC", assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", chainId: 42161 },
  { blockchain: "eth", chainName: "Ethereum", symbol: "USDC", assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", chainId: 1 },
  { blockchain: "pol", chainName: "Polygon", symbol: "USDC", assetId: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", decimals: 6, contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", chainId: 137 },
  { blockchain: "op", chainName: "Optimism", symbol: "USDC", assetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ", decimals: 6, contractAddress: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", chainId: 10 },
];

/** A payout destination by its chain code (`near`, `base`, ...) or its asset id. */
export const payoutDestinationOf = (chainOrAsset: string): PayoutDestination | undefined => PAYOUT_DESTINATIONS.find((d) => d.blockchain === chainOrAsset || d.assetId === chainOrAsset);

export const isEvmPayoutChain = (c: string): c is EvmPayoutChain => (EVM_PAYOUT_CHAINS as readonly string[]).includes(c);

/** A well-formed EVM address that is not the zero address (format only). */
export const isEvmAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);

/** keccak256("Transfer(address,address,uint256)"): topic 0 of every ERC-20 Transfer log. */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type EvmPayoutProofScope = { merchantId: string; address: string; timestamp: number; chainId: number; hub: string };

/**
 * What the business signs with `personal_sign` (EIP-191) to prove it controls `address`:
 * `Payminto intents payout <merchant id> <address lowercased> <timestamp> network eip155:<chain id> hub <hub account>`.
 */
export function evmPayoutProofMessage(s: EvmPayoutProofScope): string {
  return `Payminto intents payout ${s.merchantId} ${s.address.toLowerCase()} ${s.timestamp} network eip155:${s.chainId} hub ${s.hub}`;
}

/** True only when `signature` is an EIP-191 signature of the proof message by `address`. Throws only when viem is missing. */
export async function verifyEvmPayoutProof(s: EvmPayoutProofScope & { signature: string }): Promise<boolean> {
  if (!isEvmAddress(s.address) || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(s.signature)) return false;
  // Loaded on first use: the kit never needs viem until a business proves an EVM address. A missing viem throws here
  // rather than reading as a bad signature.
  const { verifyMessage } = await import("viem");
  try {
    return await verifyMessage({ address: s.address as `0x${string}`, message: evmPayoutProofMessage(s), signature: s.signature as `0x${string}` });
  } catch {
    return false;
  }
}
