import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { id32Bytes, isId32, isSig64, publicKeyBytes, publicKeyToString, toHex } from "./bytes.ts";
import type { Id32, PublicKey, Sig64 } from "./types.ts";

export type Keypair = {
  /** The 32-byte ed25519 seed. */
  secretKey: Uint8Array;
  publicKey: PublicKey;
};

export function keypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  return { secretKey: seed, publicKey: publicKeyToString(ed25519.getPublicKey(seed)) };
}

export function generateKeypair(): Keypair {
  return keypairFromSeed(ed25519.utils.randomSecretKey());
}

/** Signs the 32 digest bytes themselves. `env::ed25519_verify` on the hub verifies exactly this. */
export function signDigest(secretKey: Uint8Array, digest: Id32): Sig64 {
  return toHex(ed25519.sign(id32Bytes(digest, "digest"), secretKey));
}

/** False for any malformed input; never throws. */
export function verifyDigest(publicKey: PublicKey, digest: Id32, signature: Sig64): boolean {
  if (!isId32(digest) || !isSig64(signature)) return false;
  try {
    return ed25519.verify(hexToBytes(signature), hexToBytes(digest), publicKeyBytes(publicKey));
  } catch {
    return false;
  }
}

export const sha256Hex = (bytes: Uint8Array): Id32 => toHex(sha256(bytes));

/** sha256 of UTF-8 text, as an Id32. */
export const sha256Text = (text: string): Id32 => sha256Hex(new TextEncoder().encode(text));
