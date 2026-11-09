import { domainSeparator, getAddress, isAddressEqual, type Address, type Hex, type TypedDataDomain } from "viem";
import { networks } from "./chains.ts";

/** EIP-2612 Permit, as USDC.e (FiatToken v2) and OpenZeppelin ERC20Permit define it. */
export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type PermitMessage = { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint };

export function permitTypedData(domain: { name: string; version: string; chainId: number; verifyingContract: Address }, message: PermitMessage) {
  return { domain, types: permitTypes, primaryType: "Permit" as const, message };
}

/**
 * The token's EIP-712 domain from chains.ts when `token` is the network's default settlement token (USDC.e on 177 is
 * name "Bridged USDC", version "2"; signing with "USD Coin" yields signatures the token rejects). Null otherwise.
 */
export function knownTokenDomain(chainId: number, token: Address): { name: string; version: string } | null {
  const t = networks[chainId]?.token;
  if (!t || !isAddressEqual(t.address, token)) return null;
  return t.eip712;
}

/** EIP-712 domain separator for a token domain, to compare with the token's own DOMAIN_SEPARATOR() before signing. */
export function tokenDomainSeparator(chainId: number, token: Address, d: { name: string; version: string }): Hex {
  const domain: TypedDataDomain = { name: d.name, version: d.version, chainId, verifyingContract: getAddress(token) };
  return domainSeparator({ domain });
}
