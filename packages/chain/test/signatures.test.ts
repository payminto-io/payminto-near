// The hub's signature rule, pinned by shared vectors. contracts-near/src/tests/vectors.rs runs the same file through
// the hub's own verify function, so a vector whose `hub` answer is wrong fails there, and a verifier here that does not
// predict the hub fails here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { signWithTorsionedR } from "../src/testing.ts";
import { ed25519VerifyAsHub, isStrongPublicKey, keypairFromSeed, publicKeyProblem, signDigest, verifyDigest, type PublicKey } from "../src/index.ts";

type Vector = {
  name: string;
  public_key_hex: string;
  public_key: PublicKey;
  digest_hex: string;
  signature_hex: string;
  hub: boolean;
  key: "ok" | "non_canonical" | "small_order";
  valid: boolean;
  cofactored: boolean;
};

const file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "signatures.json"), "utf8")) as { cases: Vector[] };
const byName = (name: string) => file.cases.find((c) => c.name === name)!;

describe("the hub's ed25519 rule, from packages/chain/vectors/signatures.json", () => {
  it("covers every case the audit names", () => {
    const names = file.cases.map((c) => c.name);
    for (const n of ["valid", "torsioned_r", "non_canonical_r_y_plus_p", "non_canonical_a_identity", "non_canonical_a_large_order", "small_order_a_order_8", "small_order_a_all_zero", "s_plus_l"]) {
      expect(names).toContain(n);
    }
    expect(byName("small_order_a_all_zero").public_key_hex).toBe("00".repeat(32));
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s: verifyDigest says what the hub and the key check decide", (_name, c) => {
    expect(verifyDigest(c.public_key, c.digest_hex, c.signature_hex)).toBe(c.valid);
    expect(c.valid).toBe(c.hub && c.key === "ok");
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s: ed25519VerifyAsHub returns what env::ed25519_verify returns", (_name, c) => {
    expect(ed25519VerifyAsHub(hexToBytes(c.public_key_hex), hexToBytes(c.digest_hex), hexToBytes(c.signature_hex))).toBe(c.hub);
  });

  it.each(file.cases.map((c) => [c.name, c] as const))("%s: the key check names the key's problem", (_name, c) => {
    expect(publicKeyProblem(c.public_key)).toBe(c.key === "ok" ? null : c.key);
    expect(isStrongPublicKey(c.public_key)).toBe(c.key === "ok");
  });

  it("shows the divergence the audit found: a cofactored verifier accepts what the hub refuses", () => {
    // noble's ed25519.verify, which verifyDigest used before, says yes to these; the hub and verifyDigest say no.
    for (const name of ["torsioned_r", "mixed_order_a_plain_signature"]) {
      const c = byName(name);
      expect(c.cofactored, name).toBe(true);
      expect(c.hub, name).toBe(false);
      expect(ed25519.verify(hexToBytes(c.signature_hex), hexToBytes(c.digest_hex), hexToBytes(c.public_key_hex), { zip215: false }), `${name} zip215 false`).toBe(true);
    }
    expect(file.cases.filter((c) => c.cofactored && !c.valid).length).toBeGreaterThanOrEqual(4);
  });

  it("is never fooled by malformed input, and never throws", () => {
    const kp = keypairFromSeed(new Uint8Array(32).fill(7));
    const digest = "ab".repeat(32);
    const sig = signDigest(kp.secretKey, digest);
    expect(verifyDigest(kp.publicKey, digest, sig)).toBe(true);
    expect(verifyDigest("ed25519:notbase58!!" as PublicKey, digest, sig)).toBe(false);
    expect(verifyDigest(kp.publicKey, digest, sig.toUpperCase())).toBe(false);
    expect(ed25519VerifyAsHub(new Uint8Array(31), hexToBytes(digest), hexToBytes(sig))).toBe(false);
    expect(ed25519VerifyAsHub(hexToBytes(byName("valid").public_key_hex), hexToBytes(digest), new Uint8Array(63))).toBe(false);
    // A key that is not a curve point at all: y = 2 has no x on ed25519.
    const offCurve = new Uint8Array(32);
    offCurve[0] = 2;
    expect(ed25519VerifyAsHub(offCurve, hexToBytes(digest), hexToBytes(sig))).toBe(false);
    expect(publicKeyProblem(`ed25519:${"1".repeat(32)}` as PublicKey)).toBe("small_order");
  });

  it("the test helper signWithTorsionedR makes what the audit made: cofactored yes, hub no", () => {
    const kp = keypairFromSeed(new Uint8Array(32).fill(3));
    const digest = "cd".repeat(32);
    for (const nonce of [1, 2, 3]) {
      const sig = signWithTorsionedR(kp.secretKey, digest, nonce);
      expect(ed25519.verify(hexToBytes(sig), hexToBytes(digest), ed25519.getPublicKey(kp.secretKey))).toBe(true);
      expect(verifyDigest(kp.publicKey, digest, sig)).toBe(false);
    }
  });
});
