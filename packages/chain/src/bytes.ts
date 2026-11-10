import { base58 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AccountId, Id32, PublicKey, Sig64 } from "./types.ts";

const ID32 = /^[0-9a-f]{64}$/;
const SIG64 = /^[0-9a-f]{128}$/;
// NEAR account id rules: 2-64 characters, lowercase alphanumerics separated by single - _ or . characters.
const ACCOUNT = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/;

export const isId32 = (v: unknown): v is Id32 => typeof v === "string" && ID32.test(v);
export const isSig64 = (v: unknown): v is Sig64 => typeof v === "string" && SIG64.test(v);
export const isAccountId = (v: unknown): v is AccountId => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);

export function isPublicKey(v: unknown): v is PublicKey {
  if (typeof v !== "string" || !v.startsWith("ed25519:")) return false;
  try {
    return base58.decode(v.slice("ed25519:".length)).length === 32;
  } catch {
    return false;
  }
}

export const toHex = (b: Uint8Array): string => bytesToHex(b);

export function assertId32(v: unknown, what = "value"): asserts v is Id32 {
  if (!isId32(v)) throw new Error(`${what} must be an Id32 (64 lowercase hex characters)`);
}

export function assertAccountId(v: unknown, what = "value"): asserts v is AccountId {
  if (!isAccountId(v)) throw new Error(`${what} must be a NEAR account id`);
}

export function id32Bytes(v: Id32, what = "value"): Uint8Array {
  assertId32(v, what);
  return hexToBytes(v);
}

export function sig64Bytes(v: Sig64, what = "signature"): Uint8Array {
  if (!isSig64(v)) throw new Error(`${what} must be a Sig64 (128 lowercase hex characters)`);
  return hexToBytes(v);
}

export function publicKeyBytes(pk: PublicKey): Uint8Array {
  if (!pk.startsWith("ed25519:")) throw new Error("public key must start with ed25519:");
  const raw = base58.decode(pk.slice("ed25519:".length));
  if (raw.length !== 32) throw new Error("public key must decode to 32 bytes");
  return raw;
}

export function publicKeyToString(raw: Uint8Array): PublicKey {
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  return `ed25519:${base58.encode(raw)}`;
}

/** Canonical byte order for accounts and hex ids. NEAR account ids and lowercase hex are ASCII, so code units equal bytes. */
export const compareAscii = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
