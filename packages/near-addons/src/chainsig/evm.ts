import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Minimal EVM pieces for one EIP-1559 ERC-20 transfer: RLP, the signing hash, the signed encoding and EIP-55 addresses. */

type Rlp = Uint8Array | Rlp[];

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = bigToBytes(BigInt(len));
  return Uint8Array.of(offset + 55 + lenBytes.length, ...lenBytes);
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function rlp(v: Rlp): Uint8Array {
  if (v instanceof Uint8Array) {
    if (v.length === 1 && v[0]! < 0x80) return v;
    return concat([lengthPrefix(v.length, 0x80), v]);
  }
  const body = concat(v.map(rlp));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

/** Minimal big-endian bytes; zero is empty, as RLP requires for integers. */
export function bigToBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("negative integer");
  if (v === 0n) return new Uint8Array();
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(hex);
}

const strip0x = (s: string): string => (s.startsWith("0x") ? s.slice(2) : s);

export function addressBytes(a: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an EVM address: ${a}`);
  return hexToBytes(strip0x(a).toLowerCase());
}

/** EIP-55 mixed-case checksum. */
export function checksumAddress(a: string): string {
  const lower = strip0x(a).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not an EVM address: ${a}`);
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

/** The address of an uncompressed secp256k1 key: the last 20 bytes of keccak256(X || Y). */
export function addressOfUncompressed(pub: Uint8Array): string {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("expected a 65-byte uncompressed key");
  return checksumAddress(`0x${bytesToHex(keccak_256(pub.subarray(1)).subarray(12))}`);
}

/** `transfer(address,uint256)` calldata: selector a9059cbb, then the two 32-byte words. */
export function erc20TransferData(to: string, amount: bigint): Uint8Array {
  if (amount < 0n || amount >= 1n << 256n) throw new Error("amount out of range");
  const word = (b: Uint8Array) => concat([new Uint8Array(32 - b.length), b]);
  return concat([hexToBytes("a9059cbb"), word(addressBytes(to)), word(bigToBytes(amount))]);
}

export type Eip1559Tx = {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
};

const fields = (t: Eip1559Tx): Rlp[] => [
  bigToBytes(t.chainId),
  bigToBytes(t.nonce),
  bigToBytes(t.maxPriorityFeePerGas),
  bigToBytes(t.maxFeePerGas),
  bigToBytes(t.gasLimit),
  addressBytes(t.to),
  bigToBytes(t.value),
  t.data,
  [], // access list
];

/** `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])`. */
export const unsignedEip1559 = (t: Eip1559Tx): Uint8Array => concat([Uint8Array.of(2), rlp(fields(t))]);

/** keccak256 of the unsigned encoding: the 32 bytes the sender's key signs (EIP-1559). */
export const eip1559SigningHash = (t: Eip1559Tx): Uint8Array => keccak_256(unsignedEip1559(t));

/** The raw signed transaction, ready for `eth_sendRawTransaction`. */
export function signedEip1559(t: Eip1559Tx, sig: { yParity: number; r: bigint; s: bigint }): Uint8Array {
  if (sig.yParity !== 0 && sig.yParity !== 1) throw new Error("yParity must be 0 or 1");
  return concat([Uint8Array.of(2), rlp([...fields(t), bigToBytes(BigInt(sig.yParity)), bigToBytes(sig.r), bigToBytes(sig.s)])]);
}
