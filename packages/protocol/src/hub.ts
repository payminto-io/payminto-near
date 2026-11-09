import {
  hashTypedData,
  recoverTypedDataAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

/** On-chain mandate, signed by the owner. Field order and names must match ClearingHub.MANDATE_TYPEHASH. */
export type Mandate = {
  owner: Address;
  agent: Address;
  token: Address;
  totalCap: bigint;
  validAfter: bigint;
  validUntil: bigint;
  payeesRoot: Hex;
  policyHash: Hex;
  salt: Hex;
};

/** Cumulative per-payee voucher, signed by the agent. Each call raises `cumulative` by exactly the call price. */
export type Voucher = {
  mandateId: Hex;
  payee: Address;
  cumulative: bigint;
};

export const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const mandateTypes = {
  Mandate: [
    { name: "owner", type: "address" },
    { name: "agent", type: "address" },
    { name: "token", type: "address" },
    { name: "totalCap", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "payeesRoot", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const voucherTypes = {
  Voucher: [
    { name: "mandateId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "cumulative", type: "uint256" },
  ],
} as const;

export function hubDomain(chainId: number, hub: Address): TypedDataDomain {
  return { name: "Payminto Clearing", version: "1", chainId, verifyingContract: hub };
}

/** The mandate id is its EIP-712 digest, exactly as ClearingHub.mandateDigest computes it. */
export function mandateId(chainId: number, hub: Address, m: Mandate): Hex {
  return hashTypedData({ domain: hubDomain(chainId, hub), types: mandateTypes, primaryType: "Mandate", message: m });
}

export function voucherDigest(chainId: number, hub: Address, v: Voucher): Hex {
  return hashTypedData({ domain: hubDomain(chainId, hub), types: voucherTypes, primaryType: "Voucher", message: v });
}

export function mandateTypedData(chainId: number, hub: Address, m: Mandate) {
  return { domain: hubDomain(chainId, hub), types: mandateTypes, primaryType: "Mandate" as const, message: m };
}

export function voucherTypedData(chainId: number, hub: Address, v: Voucher) {
  return { domain: hubDomain(chainId, hub), types: voucherTypes, primaryType: "Voucher" as const, message: v };
}

/** EOA check only. Smart-wallet owners are verified on chain by ClearingHub via ERC-1271. */
export async function isVoucherSignedBy(
  chainId: number,
  hub: Address,
  v: Voucher,
  signature: Hex,
  agent: Address,
): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ ...voucherTypedData(chainId, hub, v), signature });
    return isAddressEqual(signer, agent);
  } catch {
    return false;
  }
}

export async function isMandateSignedBy(
  chainId: number,
  hub: Address,
  m: Mandate,
  signature: Hex,
): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ ...mandateTypedData(chainId, hub, m), signature });
    return isAddressEqual(signer, m.owner);
  } catch {
    return false;
  }
}

/** JSON-safe mandate: bigints as decimal strings. */
export type MandateJson = Omit<Mandate, "totalCap" | "validAfter" | "validUntil"> & {
  totalCap: string;
  validAfter: string;
  validUntil: string;
};

export function mandateToJson(m: Mandate): MandateJson {
  return { ...m, totalCap: m.totalCap.toString(), validAfter: m.validAfter.toString(), validUntil: m.validUntil.toString() };
}

export function mandateFromJson(j: MandateJson): Mandate {
  return { ...j, totalCap: BigInt(j.totalCap), validAfter: BigInt(j.validAfter), validUntil: BigInt(j.validUntil) };
}
