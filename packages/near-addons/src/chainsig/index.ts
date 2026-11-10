import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { isAccountId, type AccountId, type WalletTx } from "@payminto/chain";
import { base58 } from "@scure/base";
import type { ViewRpc } from "../rpc.ts";
import { addressOfUncompressed, eip1559SigningHash, erc20TransferData, signedEip1559, type Eip1559Tx } from "./evm.ts";

export * from "./evm.ts";

/**
 * NEAR Chain Signatures (the MPC signer). Contract ids from docs.near.org and near/mpc `crates/contract/README.md`;
 * both answered `version` "3.18.0" and the root keys below on 2026-11-10.
 */
export const MPC_SIGNER = {
  mainnet: { contract: "v1.signer", rootKey: "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya" },
  testnet: { contract: "v1.signer-prod.testnet", rootKey: "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3" },
} as const;

/** Domain 0 is secp256k1 ECDSA, domain 1 is ed25519. */
export const ECDSA_DOMAIN = 0;
/** `TWEAK_DERIVATION_PREFIX` in near/mpc `crates/near-mpc-crypto-types/src/kdf.rs`. */
export const TWEAK_DERIVATION_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";
const N = secp256k1.Point.Fn.ORDER;
const Point = secp256k1.Point;

/** sha3-256 (NIST SHA3, not keccak) of `<prefix><predecessor>,<path>`. */
export function deriveTweak(predecessor: AccountId, path: string): Uint8Array {
  if (!isAccountId(predecessor)) throw new Error("predecessor must be a NEAR account id");
  return sha3_256(new TextEncoder().encode(`${TWEAK_DERIVATION_PREFIX}${predecessor},${path}`));
}

/** `secp256k1:<base58 of 64 bytes X||Y>` to a curve point. */
export function parseSecp256k1Key(key: string): InstanceType<typeof Point> {
  if (!key.startsWith("secp256k1:")) throw new Error("expected a secp256k1: key");
  const raw = base58.decode(key.slice("secp256k1:".length));
  if (raw.length !== 64) throw new Error("a NEAR secp256k1 key is 64 bytes");
  return Point.fromBytes(Uint8Array.of(4, ...raw));
}

export const formatSecp256k1Key = (p: InstanceType<typeof Point>): string => `secp256k1:${base58.encode(p.toBytes(false).subarray(1))}`;

/**
 * The key the MPC network signs with for `predecessor` and `path`: root + tweak * G, where the tweak is read big-endian
 * and must be below the curve order (near/mpc `crates/contract/src/crypto_shared/kdf.rs`, `derive_key_secp256k1`).
 */
export function deriveSecp256k1Key(rootKey: string, predecessor: AccountId, path: string): { key: string; uncompressed: Uint8Array; evmAddress: string } {
  const tweak = BigInt(`0x${bytesToHex(deriveTweak(predecessor, path))}`);
  if (tweak === 0n || tweak >= N) throw new Error("tweak is not a valid scalar");
  const derived = Point.BASE.multiply(tweak).add(parseSecp256k1Key(rootKey));
  const uncompressed = derived.toBytes(false);
  return { key: formatSecp256k1Key(derived), uncompressed, evmAddress: addressOfUncompressed(uncompressed) };
}

/** The derived key as the contract computes it, read with the `derived_public_key` view. */
export const readDerivedKey = (rpc: ViewRpc, contract: AccountId, predecessor: AccountId, path: string): Promise<string> =>
  rpc.view<string>(contract, "derived_public_key", { path, predecessor, domain_id: ECDSA_DOMAIN });

/**
 * The `sign` call: `{ request: { payload_v2: { Ecdsa: <hex of 32 bytes> }, path, domain_id: 0 } }`, 1 yoctoNEAR, 300 Tgas
 * as chainsig.js attaches. The contract panics on a payload at or above the curve order, so this refuses it first.
 */
export function signRequestTx(contract: AccountId, payload: Uint8Array, path: string): WalletTx {
  if (payload.length !== 32) throw new Error("an ECDSA payload is 32 bytes");
  if (BigInt(`0x${bytesToHex(payload)}`) >= N) throw new Error("payload is not below the secp256k1 order; the MPC contract would reject it");
  if (!path) throw new Error("path is required");
  return {
    receiverId: contract,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: "sign", args: { request: { payload_v2: { Ecdsa: bytesToHex(payload) }, path, domain_id: ECDSA_DOMAIN } }, gas: "300000000000000", deposit: "1" },
      },
    ],
  };
}

/** The `Secp256k1` signature response: `{ scheme?, big_r: { affine_point }, s: { scalar }, recovery_id }`. */
export type MpcSignature = { scheme?: "Secp256k1"; big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

/** r, s and the parity from a response. r is the x-coordinate of `big_r` (bytes 1..33 of its compressed form). */
export function parseMpcSignature(sig: MpcSignature): { r: bigint; s: bigint; yParity: number } {
  if (sig.scheme !== undefined && sig.scheme !== "Secp256k1") throw new Error(`unexpected scheme ${String(sig.scheme)}`);
  const bigR = hexToBytes(sig.big_r.affine_point);
  if (bigR.length !== 33 || (bigR[0] !== 2 && bigR[0] !== 3)) throw new Error("big_r must be a 33-byte compressed point");
  const r = BigInt(`0x${bytesToHex(bigR.subarray(1))}`);
  const s = BigInt(`0x${sig.s.scalar}`);
  if (r === 0n || r >= N || s === 0n || s > N / 2n) throw new Error("r or s out of range (s must be low)");
  if (sig.recovery_id !== 0 && sig.recovery_id !== 1) throw new Error("recovery_id must be 0 or 1");
  return { r, s, yParity: sig.recovery_id };
}

/** True when the signature over `payload` recovers to `expectedKey`. Recovery yields some key for any input, so the comparison is the check. */
export function verifyMpcSignature(sig: MpcSignature, payload: Uint8Array, expectedKey: string): boolean {
  try {
    const { r, s, yParity } = parseMpcSignature(sig);
    const recovered = new secp256k1.Signature(r, s, yParity).recoverPublicKey(payload);
    return formatSecp256k1Key(recovered) === expectedKey;
  } catch {
    return false;
  }
}

export type EvmPayout = {
  /** The NEAR account that will call `sign`; it controls the derived EVM address. */
  nearAccount: AccountId;
  path: string;
  rootKey: string;
  chainId: bigint;
  /** ERC-20 token on the EVM chain, for example USDC on Base Sepolia. */
  token: string;
  to: string;
  amount: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit?: bigint;
};

/**
 * An ERC-20 payout from the EVM address that `nearAccount` controls through Chain Signatures: the unsigned EIP-1559
 * transaction, its signing hash, and the `sign` call the NEAR account must send. It moves nothing: the NEAR account
 * signs the `sign` call, and someone broadcasts the assembled transaction on the EVM chain.
 */
export function evmPayoutRequest(p: EvmPayout, mpcContract: AccountId): { from: string; derivedKey: string; tx: Eip1559Tx; payload: Uint8Array; signTx: WalletTx } {
  const derived = deriveSecp256k1Key(p.rootKey, p.nearAccount, p.path);
  if (p.amount <= 0n) throw new Error("amount must be positive");
  const tx: Eip1559Tx = {
    chainId: p.chainId,
    nonce: p.nonce,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    maxFeePerGas: p.maxFeePerGas,
    gasLimit: p.gasLimit ?? 100_000n,
    to: p.token,
    value: 0n,
    data: erc20TransferData(p.to, p.amount),
  };
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) throw new Error("maxPriorityFeePerGas cannot exceed maxFeePerGas");
  const payload = eip1559SigningHash(tx);
  return { from: derived.evmAddress, derivedKey: derived.key, tx, payload, signTx: signRequestTx(mpcContract, payload, p.path) };
}

/** Joins the MPC response to the unsigned transaction, after checking it recovers to the derived key. */
export function assembleEvmPayout(req: { tx: Eip1559Tx; payload: Uint8Array; derivedKey: string }, sig: MpcSignature): Uint8Array {
  if (!verifyMpcSignature(sig, req.payload, req.derivedKey)) throw new Error("the signature does not recover to the derived key");
  return signedEip1559(req.tx, parseMpcSignature(sig));
}
