import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, concatBytes, equalBytes, numberToBytesLE } from "@noble/curves/utils.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { id32Bytes, isId32, isPublicKey, isSig64, publicKeyBytes, publicKeyToString, toHex } from "./bytes.ts";
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

const Point = ed25519.Point;
type EdPoint = InstanceType<typeof Point>;
const L = Point.Fn.ORDER;
const P = Point.Fp.ORDER;
const Y_MASK = (1n << 255n) - 1n;

/**
 * Decodes a key the way the hub's host function does (curve25519-dalek `CompressedEdwardsY::decompress`): y is the low
 * 255 bits reduced mod p, so a y of p or more is accepted, and the sign bit picks x, where -0 is 0. Null when the
 * bytes are not a point on the curve.
 */
function decodeLikeHub(raw: Uint8Array): EdPoint | null {
  if (raw.length !== 32) return null;
  const y = (bytesToNumberLE(raw) & Y_MASK) % P;
  const normalized = numberToBytesLE(y, 32);
  normalized[31] = normalized[31]! | (raw[31]! & 0x80);
  try {
    // ZIP-215 decoding takes the sign bit on x = 0 as the hub does; y is already reduced, so nothing else differs.
    return Point.fromBytes(normalized, true);
  } catch {
    return null;
  }
}

/**
 * Exactly what the hub's `env::ed25519_verify` returns (nearcore's host function, ed25519-dalek 2 `verify`), for any
 * bytes. It is cofactorless and compares bytes:
 * - the signature is 64 bytes and the key 32, and the top three bits of s are clear (nearcore checks this first);
 * - s < L;
 * - the key decodes as a curve point, with y reduced mod p (so a non-canonical or small-order key is not refused here);
 * - k = SHA-512(R || A || M) mod L, over R and A exactly as given;
 * - R' = [s]B - [k]A, and the canonical encoding of R' must equal the signature's R bytes.
 * R itself is never decoded: a torsioned R, a non-canonical encoding of R or bytes that are no point at all simply never
 * equal R'. A cofactored verifier (noble's `ed25519.verify`, with or without ZIP-215) accepts signatures whose R carries
 * a torsion component; this does not. Payminto's own decision, which also refuses weak keys, is `verifyDigest`.
 */
export function ed25519VerifyAsHub(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  if ((signature[63]! & 0xe0) !== 0) return false;
  const s = bytesToNumberLE(signature.subarray(32));
  if (s >= L) return false;
  const a = decodeLikeHub(publicKey);
  if (!a) return false;
  const r = signature.subarray(0, 32);
  const k = bytesToNumberLE(sha512(concatBytes(r, publicKey, message))) % L;
  const recomputed = Point.BASE.multiplyUnsafe(s).subtract(a.multiplyUnsafe(k));
  return equalBytes(recomputed.toBytes(), r);
}

/** Why a public key is refused as a Payminto key. */
export type PublicKeyProblem =
  /** Not an `ed25519:` key of 32 bytes. */
  | "malformed"
  /** 32 bytes that are not a point on the curve. */
  | "not_a_point"
  /** A point whose bytes are not its one canonical encoding (y of p or more, or a sign bit on x = 0). */
  | "non_canonical"
  /** A point of order 1, 2, 4 or 8, the all-zero key among them. Anyone can sign for it without a secret. */
  | "small_order";

/**
 * Null for a key Payminto accepts: the canonical encoding of a curve point that is not of small order. For a
 * small-order key, [k]A takes at most 8 values, so a signature with s = 0 verifies for about one message in 8 and
 * anyone can forge vouchers for it (audit F3). The hub v1 accepts such keys; Payminto never registers or creates one.
 */
export function publicKeyProblem(publicKey: PublicKey | Uint8Array): PublicKeyProblem | null {
  let raw: Uint8Array;
  if (typeof publicKey === "string") {
    if (!isPublicKey(publicKey)) return "malformed";
    raw = publicKeyBytes(publicKey);
  } else {
    if (publicKey.length !== 32) return "malformed";
    raw = publicKey;
  }
  const a = decodeLikeHub(raw);
  if (!a) return "not_a_point";
  if (!equalBytes(a.toBytes(), raw)) return "non_canonical";
  if (a.isSmallOrder()) return "small_order";
  return null;
}

/** True for a key Payminto accepts as an agent, node or checkout key: see `publicKeyProblem`. */
export const isStrongPublicKey = (publicKey: PublicKey | Uint8Array): boolean => publicKeyProblem(publicKey) === null;

/**
 * Payminto's signature rule, used wherever a decision stands in for the hub: the node's voucher intake and its batch
 * pre-check, the SDK's acceptance and receipt checks and the wallet. True only when the hub's `env::ed25519_verify`
 * accepts (see `ed25519VerifyAsHub`) and the key is strong (see `publicKeyProblem`), so it never says yes where the
 * hub says no. False for any malformed input; never throws. The shared vectors in `packages/chain/vectors/signatures.json`
 * pin both halves, and the hub's own verify function is run over the same file in contracts-near.
 */
export function verifyDigest(publicKey: PublicKey, digest: Id32, signature: Sig64): boolean {
  if (!isId32(digest) || !isSig64(signature)) return false;
  try {
    const raw = publicKeyBytes(publicKey);
    if (publicKeyProblem(raw) !== null) return false;
    return ed25519VerifyAsHub(raw, hexToBytes(digest), hexToBytes(signature));
  } catch {
    return false;
  }
}

export const sha256Hex = (bytes: Uint8Array): Id32 => toHex(sha256(bytes));

/** sha256 of UTF-8 text, as an Id32. */
export const sha256Text = (text: string): Id32 => sha256Hex(new TextEncoder().encode(text));
