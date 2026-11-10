/**
 * Signature vectors: what the hub's `env::ed25519_verify` answers, and what Payminto's `verifyDigest` answers, for
 * signatures that ed25519 libraries disagree on. Every expected answer here comes from how the case is built, never
 * from running the verifier under test: the TypeScript test (test/signatures.test.ts) checks `verifyDigest` against
 * them, and the Rust test (contracts-near/src/tests/vectors.rs) checks the hub's own verify function against them.
 *
 * The constructions follow the internal audit's proofs of concept (F1 to F3): a torsioned R, non-canonical R and A
 * encodings, small-order A including the all-zero key, and s >= L.
 */
import { createHash } from "node:crypto";
import { ED25519_TORSION_SUBGROUP, ed25519 } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, concatBytes, equalBytes, numberToBytesLE } from "@noble/curves/utils.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { publicKeyToString, toHex, type Id32, type Keypair, type PublicKey } from "../src/index.ts";

const Point = ed25519.Point;
const L = Point.Fn.ORDER;
const P = Point.Fp.ORDER;
const B = Point.BASE;
const modL = (n: bigint) => ((n % L) + L) % L;
const le32 = (n: bigint) => numberToBytesLE(n, 32);
const sha256 = (label: string) => new Uint8Array(createHash("sha256").update(label).digest());
const digestOf = (label: string): Uint8Array => sha256(`payminto-signature-vector:${label}`);
const scalarOf = (label: string) => modL(bytesToNumberLE(sha512(new TextEncoder().encode(`payminto-signature-vector:${label}`))));
/** k = SHA-512(R || A || M) mod L, over the bytes as given: the hub hashes the raw key bytes, canonical or not. */
const challenge = (r: Uint8Array, a: Uint8Array, m: Uint8Array) => modL(bytesToNumberLE(sha512(concatBytes(r, a, m))));
const sig = (r: Uint8Array, s: bigint) => concatBytes(r, le32(s));

/** The order-8 point the audit uses (curve25519-dalek `EIGHT_TORSION[1]`). */
const T8_HEX = ED25519_TORSION_SUBGROUP[1]!;
const T8 = Point.fromHex(T8_HEX);
const TORSION = ED25519_TORSION_SUBGROUP.map((h) => hexToBytes(h));
/** The identity with y written as p + 1: decodes to (0, 1) under the hub's lenient decoding, never what it encodes to. */
const IDENTITY_Y_PLUS_P = le32(P + 1n);
/** The identity with the sign bit set although x = 0. */
const IDENTITY_NEGATIVE_ZERO = (() => {
  const b = le32(1n);
  b[31] = b[31]! | 0x80;
  return b;
})();

/** What the key check (`publicKeyProblem`) says about a key: ok, or why the key is refused. */
export type KeyVerdict = "ok" | "non_canonical" | "small_order";

type Case = {
  name: string;
  about: string;
  publicKey: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
  /** env::ed25519_verify, by construction. */
  hub: boolean;
  key: KeyVerdict;
};

/**
 * A forgery for a small-order key with no secret: s = 0 and R = -[k]A. Because [k]A takes at most 8 values, some
 * message in a few tries has a challenge whose -[k]A is the R it was hashed with.
 */
function forgeForSmallOrder(publicKey: Uint8Array, label: string): { digest: Uint8Array; signature: Uint8Array } {
  const a = Point.fromBytes(publicKey, true);
  for (let i = 0; i < 4096; i++) {
    const digest = digestOf(`${label}:${i}`);
    for (const r of TORSION) {
      const k = challenge(r, publicKey, digest);
      if (equalBytes(a.multiplyUnsafe(k).negate().toBytes(), r)) return { digest, signature: sig(r, 0n) };
    }
  }
  throw new Error(`no forgery found for ${label}`);
}

/** A signature that is valid under the cofactorless rule for a key A = [a]B + T (mixed order): R = [r]B - [k]T. */
function signMixedOrder(a: bigint, publicKey: Uint8Array, label: string): { digest: Uint8Array; signature: Uint8Array } {
  const r = scalarOf(`${label}:nonce`);
  for (let i = 0; i < 4096; i++) {
    const digest = digestOf(`${label}:${i}`);
    for (let j = 0; j < 8; j++) {
      const t = j === 0 ? Point.ZERO : T8.multiplyUnsafe(BigInt(j));
      const rBytes = B.multiply(r).add(t).toBytes();
      const k = challenge(rBytes, publicKey, digest);
      // Valid when [s]B - [k]A = rB + t with s = r + ka, that is when t = -[k]T.
      if (T8.multiplyUnsafe(k).negate().equals(t)) return { digest, signature: sig(rBytes, modL(r + k * a)) };
    }
  }
  throw new Error(`no signature found for ${label}`);
}

/** A non-canonical encoding (y + p) of a point of large order with a small y, if the curve has one. */
function nonCanonicalLargeOrderKey(): Uint8Array {
  for (let y = 2n; y < 19n; y++) {
    try {
      const point = Point.fromBytes(le32(y), false);
      if (!point.isSmallOrder()) return le32(y + P);
    } catch {
      // Not on the curve.
    }
  }
  throw new Error("no non-canonical key of large order");
}

export function signatureCases(signer: Keypair): Case[] {
  const { scalar: a, pointBytes: A } = ed25519.utils.getExtendedPublicKey(signer.secretKey);
  const sign = (digest: Uint8Array) => ed25519.sign(digest, signer.secretKey);
  const cases: Case[] = [];

  {
    const digest = digestOf("valid");
    cases.push({ name: "valid", about: "An ordinary signature by agent1.", publicKey: A, digest, signature: sign(digest), hub: true, key: "ok" });
  }
  {
    const digest = digestOf("other-digest");
    cases.push({
      name: "signed_another_digest",
      about: "agent1's signature over a different digest.",
      publicKey: A,
      digest,
      signature: sign(digestOf("valid")),
      hub: false,
      key: "ok",
    });
  }
  {
    // F1: R carries an 8-torsion component. The cofactored equation [8][s]B = [8](R + [k]A) holds; R' = [s]B - [k]A
    // is R without the torsion, so its bytes differ from R's.
    const digest = digestOf("torsioned-r");
    const r = scalarOf("torsioned-r:nonce");
    const rBytes = B.multiply(r).add(T8).toBytes();
    const k = challenge(rBytes, A, digest);
    cases.push({
      name: "torsioned_r",
      about: "F1/F2: R = [r]B + T for an order-8 point T, s = r + ka. Cofactored verifiers accept it; the hub recomputes R without T and refuses.",
      publicKey: A,
      digest,
      signature: sig(rBytes, modL(r + k * a)),
      hub: false,
      key: "ok",
    });
  }
  {
    const digest = digestOf("identity-r");
    const rBytes = le32(1n);
    const k = challenge(rBytes, A, digest);
    cases.push({
      name: "identity_r_canonical",
      about: "R is the identity in its canonical encoding (nonce zero), s = ka. [s]B - [k]A is the identity, so the hub accepts it.",
      publicKey: A,
      digest,
      signature: sig(rBytes, modL(k * a)),
      hub: true,
      key: "ok",
    });
  }
  for (const [name, rBytes, about] of [
    ["non_canonical_r_y_plus_p", IDENTITY_Y_PLUS_P, "R is the identity written with y = p + 1. A decoder that reduces y sees the identity; the hub compares bytes with the canonical encoding and refuses."],
    ["non_canonical_r_negative_zero", IDENTITY_NEGATIVE_ZERO, "R is the identity written with the sign bit set although x = 0. The hub compares bytes with the canonical encoding and refuses."],
  ] as const) {
    const digest = digestOf(name);
    const k = challenge(rBytes, A, digest);
    cases.push({ name, about, publicKey: A, digest, signature: sig(rBytes, modL(k * a)), hub: false, key: "ok" });
  }
  {
    // s + L encodes the same scalar mod L, so only a canonical-s check refuses it. Pick a digest whose s + L stays
    // under 2^253, so the hub's separate top-three-bits check does not decide it first.
    let i = 0;
    for (;;) {
      const digest = digestOf(`s-plus-l:${i++}`);
      const good = sign(digest);
      const s = bytesToNumberLE(good.slice(32));
      if (s + L >= 2n ** 253n) continue;
      cases.push({
        name: "s_plus_l",
        about: "A valid signature with s replaced by s + L (still under 2^253). The hub requires s < L.",
        publicKey: A,
        digest,
        signature: sig(good.slice(0, 32), s + L),
        hub: false,
        key: "ok",
      });
      break;
    }
  }
  {
    const digest = digestOf("s-high-bits");
    const bad = sign(digest);
    bad[63] = bad[63]! | 0x80;
    cases.push({
      name: "s_top_bit_set",
      about: "A valid signature with the top bit of s set. The hub refuses any s whose top three bits are not zero.",
      publicKey: A,
      digest,
      signature: bad,
      hub: false,
      key: "ok",
    });
  }
  {
    const publicKey = hexToBytes(T8_HEX);
    const f = forgeForSmallOrder(publicKey, "small-order-a");
    cases.push({
      name: "small_order_a_order_8",
      about: "F3: A is a point of order 8. s = 0 and R = -[k]A, found without any secret. The hub's signature check accepts it; Payminto refuses the key.",
      publicKey,
      ...f,
      hub: true,
      key: "small_order",
    });
  }
  {
    const publicKey = new Uint8Array(32);
    const f = forgeForSmallOrder(publicKey, "zero-a");
    cases.push({
      name: "small_order_a_all_zero",
      about: "F3: the all-zero key, a point of order 4. A forgery as above: the hub's signature check accepts it; Payminto refuses the key.",
      publicKey,
      ...f,
      hub: true,
      key: "small_order",
    });
  }
  {
    const publicKey = IDENTITY_Y_PLUS_P;
    const digest = digestOf("non-canonical-a");
    // A decodes to the identity, so [k]A is the identity and R = [s]B verifies every message.
    cases.push({
      name: "non_canonical_a_identity",
      about: "A is the identity written with y = p + 1. The hub decodes it leniently, so R = B, s = 1 verifies any message; Payminto refuses the key.",
      publicKey,
      digest,
      signature: sig(B.toBytes(), 1n),
      hub: true,
      key: "non_canonical",
    });
  }
  {
    const publicKey = nonCanonicalLargeOrderKey();
    const digest = digestOf("non-canonical-a-large-order");
    cases.push({
      name: "non_canonical_a_large_order",
      about: "A is a point of large order with y written as y + p. Nobody knows its secret, so any signature fails at the hub; Payminto refuses the key as well.",
      publicKey,
      digest,
      signature: sign(digest),
      hub: false,
      key: "non_canonical",
    });
  }
  {
    // A = [a]B + T: canonical and not small order, so the key check passes; the cofactorless equation still decides.
    const publicKey = Point.fromBytes(A).add(T8).toBytes();
    const f = signMixedOrder(a, publicKey, "mixed-order-a");
    cases.push({
      name: "mixed_order_a_fitted_signature",
      about: "A = [a]B + T (mixed order), and R = [r]B - [k]T with s = r + ka, so [s]B - [k]A is R exactly. The hub accepts it, and so does Payminto.",
      publicKey,
      ...f,
      hub: true,
      key: "ok",
    });
    let i = 0;
    for (;;) {
      const digest = digestOf(`mixed-order-a-plain:${i++}`);
      const r = scalarOf(`mixed-order-a-plain-nonce:${i}`);
      const rBytes = B.multiply(r).toBytes();
      const k = challenge(rBytes, publicKey, digest);
      // Only k = 0 mod 8 would make [k]T vanish; pick a message where it does not.
      if (T8.multiplyUnsafe(k).is0()) continue;
      cases.push({
        name: "mixed_order_a_plain_signature",
        about: "A = [a]B + T, signed the ordinary way (R = [r]B, s = r + ka). The cofactored equation holds, but [s]B - [k]A = R - [k]T, so the hub refuses.",
        publicKey,
        digest,
        signature: sig(rBytes, modL(r + k * a)),
        hub: false,
        key: "ok",
      });
      break;
    }
  }
  return cases;
}

/** True when noble's cofactored `ed25519.verify` (its default, ZIP-215 decoding) accepts. Recorded to show the divergence. */
function cofactored(c: Case): boolean {
  try {
    return ed25519.verify(c.signature, c.digest, c.publicKey);
  } catch {
    return false;
  }
}

export function signatureVectors(signer: Keypair) {
  return {
    note: "Fixed public test vectors, for tests only. Generated by packages/chain/scripts/gen-vectors.ts.",
    about:
      "Each case is a public key, a 32-byte digest and a 64-byte signature. `hub` is what env::ed25519_verify returns (cofactorless: s < L, top three bits of s clear, A decoded with y reduced mod p, R' = [s]B - [k]A with k = SHA-512(R || A || M) mod L, and R' compressed must equal R byte for byte). `key` is Payminto's key check: a key must be the canonical encoding of a point that is not of small order. `valid` is what Payminto's verifyDigest returns: hub and key == ok. `cofactored` is what a cofactored verifier (noble ed25519.verify) returns, shown only to mark the cases where such a verifier would disagree with the hub.",
    cases: signatureCases(signer).map((c) => ({
      name: c.name,
      about: c.about,
      public_key_hex: toHex(c.publicKey) as Id32,
      public_key: publicKeyToString(c.publicKey) as PublicKey,
      digest_hex: toHex(c.digest) as Id32,
      signature_hex: toHex(c.signature),
      hub: c.hub,
      key: c.key,
      valid: c.hub && c.key === "ok",
      cofactored: cofactored(c),
    })),
  };
}
