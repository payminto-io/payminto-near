/**
 * Fixtures for the NEAR AI Cloud tests.
 *
 * LIVE: `test/fixtures/nearai/*.live.json` are recordings of public endpoints that need no API key, made on
 * 2026-11-10 and trimmed as each file's `_fixture` header says.
 *
 * SYNTHETIC: everything built in this file. No API key was available, so a signed completion could not be recorded.
 * Signatures are made here with throwaway keys, in the shapes NEAR documents (SOURCES.md), and the preflight results
 * they are checked against are the live result with a signer swapped for the throwaway key. A synthetic fixture shows
 * that the verifier accepts what the documentation describes and rejects what it should; it does not show that the
 * live service behaves as documented.
 */
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { NearAiAttestationVerification, NearAiSignatureKind, NearAiSigner } from "../src/attestation/nearai.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/nearai/${name}`, import.meta.url), "utf8"));

type Report = Record<string, any>;
export type LiveAttestation = { _fixture: { nonce: string; recorded_at: string }; gateway_attestation: Report; model_attestations: Report[] };

/** A fresh deep copy on every call, so a test can tamper with it. */
export const liveReport = (): LiveAttestation => load("attestation-report.live.json");
export const liveModels = () => load("models.live.json");
export const liveModelList = () => load("model-list.live.json");
export const liveErrors = () => load("errors.live.json");

export const LIVE_NONCE: string = liveReport()._fixture.nonce;
/** A moment inside the validity of the recorded certificates, shortly after the recording. */
export const LIVE_NOW = new Date(Date.parse(liveReport()._fixture.recorded_at) + 1_000);
export const LIVE_MODEL = "z-ai/glm-5.3-flash";

export const sha256Hex = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

/** Flips one hex digit at `at` (a nibble index). */
export function flipHex(hex: string, at: number): string {
  const c = hex[at]!;
  return hex.slice(0, at) + (c === "0" ? "1" : "0") + hex.slice(at + 1);
}

// ------------------------------------------------------------------ synthetic signers

export type TestEcdsaKey = { secret: Uint8Array; signer: NearAiSigner };

/** SYNTHETIC: a throwaway secp256k1 key and its Ethereum-style address. */
export function ecdsaKey(fill: number): TestEcdsaKey {
  const secret = new Uint8Array(32).fill(fill);
  const pub = secp256k1.getPublicKey(secret, false);
  return { secret, signer: { algo: "ecdsa", address: `0x${Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex")}` } };
}

/** SYNTHETIC: an EIP-191 personal-message signature (r, s, v with v 27 or 28), as an Ethereum wallet makes it. */
export function eip191Sign(text: string, key: TestEcdsaKey): string {
  const message = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, "utf8"), message]));
  const sig = secp256k1.sign(digest, key.secret, { prehash: false, format: "recovered" });
  // noble's "recovered" format is the recovery byte, then r and s.
  return Buffer.concat([Buffer.from(sig.subarray(1)), Buffer.from([27 + sig[0]!])]).toString("hex");
}

export type TestEd25519Key = { sign(text: string): string; signer: NearAiSigner };

/** SYNTHETIC: a throwaway Ed25519 key; its identity is the raw public key in hex. */
export function ed25519Key(): TestEd25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { signer: { algo: "ed25519", address: raw.toString("hex") }, sign: (text) => nodeSign(null, Buffer.from(text, "utf8"), privateKey).toString("hex") };
}

/** SYNTHETIC: the body of GET /v1/signature/{id} in the documented shape. */
export function signatureBody(o: { kind: NearAiSignatureKind | null; model: string; request: string | Uint8Array; response: string | Uint8Array; sign: (text: string) => string; signer: NearAiSigner; text?: string }) {
  const hashes = `${sha256Hex(o.request)}:${sha256Hex(o.response)}`;
  const text = o.text ?? (o.kind === "provider_tee" ? `${o.model}:${hashes}` : hashes);
  return { text, signature: o.sign(text), signing_address: o.signer.address, signing_algo: o.signer.algo, ...(o.kind ? { signature_kind: o.kind } : {}) };
}

/**
 * SYNTHETIC: a preflight result with the signer of the gateway report and of the model report replaced, so that a
 * throwaway key can stand in for an enclave key. `fully` also marks every open check as passed, to exercise the
 * `verified` path that the defaults never reach.
 */
export function withSigners(base: NearAiAttestationVerification, o: { model?: NearAiSigner; gateway?: NearAiSigner; fully?: boolean; verifiedAt?: Date }): NearAiAttestationVerification {
  const a: NearAiAttestationVerification = structuredClone(base);
  if (o.model && a.models[0]) a.models[0].signer = o.model;
  if (o.gateway && a.gateway) a.gateway.signer = o.gateway;
  if (o.verifiedAt) a.verifiedAt = o.verifiedAt.toISOString();
  if (o.fully) {
    for (const r of [a.gateway, ...a.models]) {
      if (!r) continue;
      for (const c of r.checks) if (c.status === "not_verified") Object.assign(c, { status: "pass", trust: "remote" });
      r.status = "verified";
    }
    for (const c of a.checks) if (c.status === "not_verified") Object.assign(c, { status: "pass", trust: "remote" });
    a.status = "verified";
  }
  return a;
}
