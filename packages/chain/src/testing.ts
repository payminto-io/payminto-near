/**
 * Adversarial signers, for tests only. Each builds a signature that a cofactored ed25519 verifier accepts and the hub's
 * `env::ed25519_verify` refuses (internal audit F1 and F2), so a test can prove that a check which stands in for the hub
 * refuses it too. Never used by production code.
 */
import { ED25519_TORSION_SUBGROUP, ed25519 } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, concatBytes, numberToBytesLE } from "@noble/curves/utils.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { id32Bytes, toHex } from "./bytes.ts";
import type { Id32, Sig64 } from "./types.ts";

const Point = ed25519.Point;
const L = Point.Fn.ORDER;
/** A point of order 8 (curve25519-dalek `EIGHT_TORSION[1]`). */
const T8 = Point.fromHex(ED25519_TORSION_SUBGROUP[1]!);

/**
 * Signs `digest` with `secretKey` the way the audit's proof of concept does: R = [r]B + T for an order-8 point T and
 * s = r + ka. The cofactored equation holds, so noble's `ed25519.verify` says true; the hub recomputes R without T and
 * says false. `nonce` picks r, so a test can make several different ones.
 */
export function signWithTorsionedR(secretKey: Uint8Array, digest: Id32, nonce = 1): Sig64 {
  const { scalar: a, pointBytes: publicKey } = ed25519.utils.getExtendedPublicKey(secretKey);
  const message = id32Bytes(digest, "digest");
  const r = bytesToNumberLE(sha512(concatBytes(new TextEncoder().encode(`payminto-torsioned-nonce:${nonce}`), message))) % L || 1n;
  const rBytes = Point.BASE.multiply(r).add(T8).toBytes();
  const k = bytesToNumberLE(sha512(concatBytes(rBytes, publicKey, message))) % L;
  return toHex(concatBytes(rBytes, numberToBytesLE((r + k * a) % L, 32)));
}
