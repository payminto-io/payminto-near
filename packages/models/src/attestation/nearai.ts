/**
 * Verification of NEAR AI Cloud attestation reports and response signatures, following the flow NEAR documents
 * (packages/models/SOURCES.md lists the pages). Two entry points:
 *
 *   verifyNearAiAttestation  checks the body of GET /v1/attestation/report: the gateway report and every NEAR model
 *                            report in it. Run it BEFORE the completion (preflight) and keep the result.
 *   verifyNearAiResponse     checks the body of GET /v1/signature/{id} against the exact request and response bytes
 *                            and against that preflight result.
 *
 * Both are pure: no network, no clock unless `now` is left out. They never throw for bad evidence; every problem is a
 * failed check in the result. A result is `verified` only when every listed check passed. With the defaults that
 * cannot happen, because three things are not checked in this process and are reported as `not_verified`:
 *   - the Intel TCB status of the quote, the QE's TCB level and certificate revocation (need Intel collateral);
 *   - NVIDIA's verdict on the GPU evidence (needs NVIDIA's remote attestation service);
 *   - whether the measured software is software you accept (needs a policy: accepted compose hashes).
 * The first two can be supplied by the caller (`quoteVerifier`, `gpuVerifier`), the third by `policy`.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { AttestationCheck, AttestationStatus, TurnAttestation } from "../model.ts";
import { TdxQuoteError, parseTdxQuote, verifyTdxQuoteLocally, type TdxQuote } from "./tdx-quote.ts";

export type NearAiSigningAlgo = "ecdsa" | "ed25519";

/** A signing identity as NEAR reports it: an Ethereum-style address (ecdsa) or an Ed25519 public key, lowercase hex. */
export type NearAiSigner = { algo: NearAiSigningAlgo; address: string };

/** What a full DCAP verifier reports for a quote (for example @phala/dcap-qvl with Intel or PCCS collateral). */
export type QuoteVerdict = {
  /** Intel's TCB status string, for example "UpToDate", "SWHardeningNeeded", "OutOfDate". */
  tcbStatus: string;
  advisoryIds?: string[];
  /** `local` when the verifier checked Intel's signatures on the collateral itself, `remote` when it trusts a service's verdict. */
  trust: "local" | "remote";
  /** Name of the verifier, shown in the check detail. */
  verifier: string;
};
export type QuoteVerifier = (quote: Uint8Array) => Promise<QuoteVerdict>;

export type GpuVerdict = { ok: boolean; detail: string; trust: "local" | "remote"; verifier: string };
/** Receives the decoded `nvidia_payload` object of a model report. */
export type GpuVerifier = (payload: unknown) => Promise<GpuVerdict>;

export type NearAiAttestationPolicy = {
  /**
   * Fail when no NEAR model report comes back. Defaults to true when a model id is given: without a model report
   * nothing ties an answer to a model enclave.
   */
  requireModelEvidence?: boolean;
  /** TCB statuses accepted from `quoteVerifier` (default: only "UpToDate"). */
  acceptedTcbStatuses?: string[];
  /** SHA-256 hashes (hex) of the `app_compose` configurations you accept. Without it the measurement is reported, not judged. */
  acceptedComposeHashes?: string[];
  /** Replaces the pinned Intel SGX Root CA (tests). */
  rootCaPem?: string;
};

export type VerifyNearAiAttestationInput = {
  /** The parsed body of GET /v1/attestation/report. */
  report: unknown;
  /** The nonce this client generated and sent: 32 random bytes as 64 hex characters. */
  nonce: string;
  /** The canonical model id the report was requested for; leave out for a gateway-only report. */
  model?: string | null;
  /** Why the model report could not be fetched, when the caller fell back to a gateway-only report. */
  modelEvidenceError?: string | null;
  now?: Date;
  policy?: NearAiAttestationPolicy;
  quoteVerifier?: QuoteVerifier;
  gpuVerifier?: GpuVerifier;
};

/** The measurements of one verified quote, lowercase hex. Read from the quote, never from the HTTP copies. */
export type NearAiMeasurements = {
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
  mrConfigId: string;
  tdAttributes: string;
  reportData: string;
  /** SHA-256 of `app_compose`, when the report carries it. */
  composeHash: string | null;
  qeIsvSvn: number;
};

export type NearAiReportVerification = {
  scope: "gateway" | "model";
  /** Position in `model_attestations[]`; 0 for the gateway. */
  index: number;
  status: AttestationStatus;
  /** Null when the report names no usable signing identity. */
  signer: NearAiSigner | null;
  measurements: NearAiMeasurements | null;
  checks: AttestationCheck[];
};

export type NearAiAttestationVerification = TurnAttestation & {
  kind: "nearai_attestation";
  model: string | null;
  nonce: string;
  /** When the verification ran (ISO 8601). `verifyNearAiResponse` requires it to precede the completion. */
  verifiedAt: string;
  gateway: NearAiReportVerification | null;
  /** One entry per `model_attestations[]` candidate, in order. */
  models: NearAiReportVerification[];
  /** The checks that did not run in this process, as plain sentences without duplicates. */
  notVerifiedLocally: string[];
};

export type NearAiSignatureKind = "provider_tee" | "gateway";

export type VerifyNearAiResponseInput = {
  /** The exact bytes of the request body that was sent (a string is hashed as UTF-8). */
  requestBody: Uint8Array | string;
  /** The exact bytes of the response body as received, before any parsing. */
  responseBody: Uint8Array | string;
  /** The canonical model id of the request (it is part of the text a model enclave signs). */
  model: string;
  /** The parsed body of GET /v1/signature/{id}; null when none could be fetched. */
  signature: unknown;
  /** Why there is no signature, when `signature` is null. */
  signatureError?: string | null;
  /** The preflight result, verified before the completion was sent. */
  attestation: NearAiAttestationVerification;
  /** The completion id the signature was fetched for. */
  chatId?: string | null;
  /** When the completion request was sent (default: now). The preflight must be older than this, and not by too much. */
  requestSentAt?: Date;
  /** The oldest preflight accepted, in milliseconds (default 10 minutes). */
  maxAttestationAgeMs?: number;
};

export type NearAiResponseVerification = TurnAttestation & {
  kind: "nearai_response";
  model: string;
  chatId: string | null;
  /** SHA-256 of the exact request bytes, hex. */
  requestHash: string;
  /** SHA-256 of the exact response bytes, hex. */
  responseHash: string;
  /** Who signed, as the signature endpoint says; null when it does not say or there is no signature. */
  signatureKind: NearAiSignatureKind | null;
  signer: NearAiSigner | null;
  /**
   * What the signature ties these bytes to, once every signature check passed: a model-serving enclave
   * (`provider_tee`), the gateway enclave only (`gateway`), or nothing.
   */
  boundTo: "model_enclave" | "gateway_enclave" | null;
  /** The preflight this result rests on. */
  attestation: { status: AttestationStatus; verifiedAt: string; nonce: string };
  /** What a passing result still does not show (from NEAR's own documentation). */
  limits: string[];
};

export const DEFAULT_MAX_ATTESTATION_AGE_MS = 10 * 60_000;

// ------------------------------------------------------------------ helpers

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const short = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}...${h.slice(-8)}` : h);

/** Strict hex to bytes: an optional 0x prefix, an even number of hex digits, and the expected length when given. */
function hexBytes(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== "string") return null;
  const h = value.replace(/^0x/i, "");
  if (!h || h.length % 2 || !/^[0-9a-f]+$/i.test(h)) return null;
  const b = Buffer.from(h, "hex");
  return expectedBytes !== undefined && b.length !== expectedBytes ? null : b;
}

function signerOf(v: Rec): NearAiSigner | null {
  const algo = v.signing_algo;
  if (algo !== "ecdsa" && algo !== "ed25519") return null;
  const id = hexBytes(v.signing_address, algo === "ecdsa" ? 20 : 32);
  return id ? { algo, address: (algo === "ecdsa" ? "0x" : "") + toHex(id) } : null;
}

const sameSigner = (a: NearAiSigner | null, b: NearAiSigner | null) => !!a && !!b && a.algo === b.algo && a.address === b.address;

function rollUp(checks: AttestationCheck[]): AttestationStatus {
  if (checks.some((c) => c.status === "fail") || !checks.some((c) => c.status === "pass")) return "failed";
  return checks.every((c) => c.status === "pass") ? "verified" : "partially_verified";
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/**
 * Replays the RTMR3 events of a dstack event log (NEAR's documented rule): each event's digest is
 * SHA-384(event_type as 4 little-endian bytes || ":" || event || ":" || payload), and RTMR3 extends once per event
 * from 48 zero bytes. Throws when the log is malformed or an event's stated digest differs from the computed one.
 */
export function replayRtmr3(eventLog: unknown): { rtmr3: string; events: Record<string, string> } {
  const log = parseMaybeJson(eventLog);
  if (!Array.isArray(log)) throw new Error("the event log is not a list");
  let rtmr3: Buffer = Buffer.alloc(48);
  const events: Record<string, string> = {};
  for (const e of log) {
    if (!isRec(e)) throw new Error("the event log has an entry that is not an object");
    if (e.imr !== 3) continue;
    if (typeof e.event_type !== "number" || !Number.isInteger(e.event_type) || e.event_type < 0 || e.event_type > 0xffffffff) throw new Error("an RTMR3 event has no valid event_type");
    if (typeof e.event !== "string") throw new Error("an RTMR3 event has no name");
    const payload = e.event_payload === undefined || e.event_payload === null || e.event_payload === "" ? Buffer.alloc(0) : hexBytes(e.event_payload);
    if (!payload) throw new Error(`the payload of event ${e.event} is not hex`);
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const digest = createHash("sha384").update(type).update(":").update(Buffer.from(e.event, "utf8")).update(":").update(payload).digest();
    if (typeof e.digest === "string" && e.digest !== "" && e.digest.toLowerCase() !== toHex(digest)) throw new Error(`the stated digest of event ${e.event} differs from the computed one`);
    rtmr3 = createHash("sha384").update(rtmr3).update(digest).digest();
    if (!(e.event in events)) events[e.event] = toHex(payload);
  }
  return { rtmr3: toHex(rtmr3), events };
}

/** The Ethereum address (0x, lowercase) that signed `text` as an EIP-191 personal message, or null for a malformed signature. */
export function recoverEip191Signer(text: string, signature: Uint8Array): string | null {
  if (signature.length !== 65) return null;
  const v = signature[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  const message = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, "utf8"), message]));
  try {
    const r = BigInt(`0x${toHex(signature.subarray(0, 32))}`);
    const s = BigInt(`0x${toHex(signature.subarray(32, 64))}`);
    const publicKey = new secp256k1.Signature(r, s, recovery).recoverPublicKey(digest).toBytes(false);
    return `0x${toHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

function ed25519Verifies(text: string, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" });
    return verifySignature(null, Buffer.from(text, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** The text a signature must cover: `<model>:<request hash>:<response hash>` from a model enclave, without the model from the gateway. */
export function nearAiSignedText(kind: NearAiSignatureKind, requestHash: string, responseHash: string, model: string): string {
  return kind === "provider_tee" ? `${model}:${requestHash}:${responseHash}` : `${requestHash}:${responseHash}`;
}

// ------------------------------------------------------------------ one report

type ReportContext = { nonce: string; now: Date; policy: NearAiAttestationPolicy; quoteVerifier?: QuoteVerifier; gpuVerifier?: GpuVerifier };

async function verifyReport(report: unknown, scope: "gateway" | "model", index: number, ctx: ReportContext): Promise<NearAiReportVerification> {
  const label = scope === "gateway" ? "gateway" : `model:${index}`;
  const checks: AttestationCheck[] = [];
  const add = (id: string, title: string, status: AttestationCheck["status"], trust: AttestationCheck["trust"], detail: string, evidence?: Record<string, string>) =>
    checks.push({ id, scope: label, title, status, trust: status === "not_verified" ? "none" : trust, detail, ...(evidence ? { evidence } : {}) });
  const local = (id: string, title: string, ok: boolean, detail: string, evidence?: Record<string, string>) => add(id, title, ok ? "pass" : "fail", "local", detail, evidence);
  const done = (signer: NearAiSigner | null, measurements: NearAiMeasurements | null): NearAiReportVerification => ({ scope, index, status: rollUp(checks), signer, measurements, checks });

  if (!isRec(report)) {
    local("quote_parsed", "The report carries an Intel TDX quote", false, "the report is not an object");
    return done(null, null);
  }
  const signer = signerOf(report);

  // The quote: structure, then signatures up to Intel's root. Everything below reads the TD report from these bytes.
  const quoteBytes = hexBytes(report.intel_quote);
  let quote: TdxQuote;
  try {
    if (!quoteBytes) throw new TdxQuoteError("intel_quote is missing or not hex");
    quote = parseTdxQuote(quoteBytes);
  } catch (err) {
    local("quote_parsed", "The report carries an Intel TDX quote", false, err instanceof Error ? err.message : String(err));
    return done(signer, null);
  }
  local("quote_parsed", "The report carries an Intel TDX quote", true, `version ${quote.version} TDX quote, ${quoteBytes!.length} bytes`);
  const chain = verifyTdxQuoteLocally(quote, { now: ctx.now, rootCaPem: ctx.policy.rootCaPem });
  local("quote_signature", "The quote is signed by a key the Intel quoting enclave vouches for", chain.quoteSignature.ok, chain.quoteSignature.detail);
  local("pck_chain", "The platform certificate chains to Intel's root", chain.pckChain.ok, chain.pckChain.detail, chain.pck ? { pck_valid_to: chain.pck.validTo } : undefined);
  local("qe_identity", "The quoting enclave is Intel's", chain.qeIdentity.ok, chain.qeIdentity.detail);

  const tcbTitle = "The platform's TCB status is acceptable to Intel's current collateral";
  if (ctx.quoteVerifier) {
    try {
      const verdict = await ctx.quoteVerifier(quoteBytes!);
      const accepted = ctx.policy.acceptedTcbStatuses ?? ["UpToDate"];
      const ok = accepted.includes(verdict.tcbStatus);
      const advisories = verdict.advisoryIds?.length ? `, advisories ${verdict.advisoryIds.join(", ")}` : "";
      add("tcb_status", tcbTitle, ok ? "pass" : "fail", verdict.trust, `${verdict.verifier} reports TCB status ${verdict.tcbStatus}${advisories}; accepted: ${accepted.join(", ")}`, { tcb_status: verdict.tcbStatus });
    } catch (err) {
      add("tcb_status", tcbTitle, "fail", "local", `the quote verifier rejected the quote: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    add("tcb_status", tcbTitle, "not_verified", "none", "not verified locally: the TCB status of the platform and TDX module, the quoting enclave's TCB level and certificate revocation need Intel's signed collateral (plug in a DCAP verifier with the quoteVerifier option)");
  }

  const r = quote.report;
  const composeSource = isRec(report.info) ? parseMaybeJson(report.info.tcb_info) : undefined;
  const appCompose = isRec(composeSource) ? str(composeSource.app_compose) : null;
  const composeHash = appCompose === null ? null : toHex(sha256(Buffer.from(appCompose, "utf8")));
  const measurements: NearAiMeasurements = { mrTd: r.mrTd, rtMr0: r.rtMr0, rtMr1: r.rtMr1, rtMr2: r.rtMr2, rtMr3: r.rtMr3, mrConfigId: r.mrConfigId, tdAttributes: r.tdAttributes, reportData: r.reportData, composeHash, qeIsvSvn: quote.qe.isvSvn };

  const debug = (Number.parseInt(r.tdAttributes.slice(0, 2), 16) & 1) === 1;
  local("debug_disabled", "The enclave does not run in debug mode", !debug, debug ? "TDX debug mode is enabled (bit 0 of TD_ATTRIBUTES)" : `TD_ATTRIBUTES ${r.tdAttributes}: debug bit is off`);

  // Freshness: the last 32 bytes of the quote's report data are the nonce this client generated.
  const nonce = ctx.nonce.toLowerCase();
  const echoed = str(report.request_nonce)?.toLowerCase() ?? null;
  const quoteNonce = r.reportData.slice(64);
  const nonceOk = /^[0-9a-f]{64}$/.test(nonce) && quoteNonce === nonce && echoed === nonce;
  local(
    "nonce_binding",
    "The quote was made for this client's nonce",
    nonceOk,
    nonceOk
      ? `the quote's report data ends with the client nonce ${short(nonce)}`
      : !/^[0-9a-f]{64}$/.test(nonce)
        ? "the client nonce is not 32 bytes of hex"
        : quoteNonce !== nonce
          ? `the quote carries nonce ${short(quoteNonce)}, not the client nonce ${short(nonce)}: stale or replayed evidence`
          : `the echoed request_nonce (${echoed === null ? "missing" : short(echoed)}) differs from the client nonce`,
  );

  // Signer binding: the first 32 bytes of the report data are the signing identity (or its hash with the TLS key).
  const identity = signer ? hexBytes(signer.address)! : null;
  const fingerprint = str(report.tls_cert_fingerprint);
  const fingerprintBytes = fingerprint ? hexBytes(fingerprint, 32) : null;
  let signerOk = false;
  let signerDetail: string;
  if (!signer || !identity) signerDetail = "the report names no usable signing identity (signing_algo must be ecdsa or ed25519 with an address of the matching length)";
  else if (fingerprint && !fingerprintBytes) signerDetail = "tls_cert_fingerprint is not 32 bytes of hex";
  else {
    const expected = fingerprintBytes ? toHex(sha256(identity, fingerprintBytes)) : toHex(Buffer.concat([identity, Buffer.alloc(32 - identity.length)]));
    const httpCopy = str(report.report_data)?.replace(/^0x/i, "").toLowerCase() ?? null;
    if (r.reportData.slice(0, 64) !== expected) signerDetail = `the quote's report data does not bind the reported signing identity ${signer.address}`;
    else if (httpCopy !== null && httpCopy !== r.reportData) signerDetail = "the report_data field of the HTTP response differs from the report data in the quote";
    else {
      signerOk = true;
      signerDetail = `the quote's report data binds the ${signer.algo} signing identity ${signer.address}${fingerprintBytes ? " together with the TLS key fingerprint" : ""}`;
    }
  }
  local("signer_binding", "The response-signing key is bound to the quote", signerOk, signerDetail, signer ? { signing_address: signer.address, signing_algo: signer.algo } : undefined);

  const publicKey = report.signing_public_key === undefined ? undefined : hexBytes(report.signing_public_key, 64);
  if (signer?.algo === "ecdsa" && publicKey !== undefined) {
    const derived = publicKey ? `0x${toHex(keccak_256(publicKey).subarray(12))}` : null;
    local("signing_public_key", "The published public key belongs to the signing address", derived === signer.address, derived === signer.address ? "signing_public_key hashes to signing_address" : "signing_public_key does not hash to signing_address");
  }

  // Configuration: MRCONFIGID is 01, then SHA-256 of the raw app_compose string, then 15 zero bytes.
  if (composeHash === null) local("config_measurement", "The measured configuration is the one the report shows", false, "the report has no info.tcb_info.app_compose to compare with the quote's MRCONFIGID");
  else {
    const ok = r.mrConfigId === `01${composeHash}${"00".repeat(15)}`;
    local("config_measurement", "The measured configuration is the one the report shows", ok, ok ? `MRCONFIGID commits to app_compose (SHA-256 ${short(composeHash)})` : "the quote's MRCONFIGID does not match the hash of app_compose", { compose_hash: composeHash });
  }

  // Runtime measurements: the event log must replay to the quote's RTMR3.
  try {
    const replay = replayRtmr3(report.event_log);
    const ok = replay.rtmr3 === r.rtMr3;
    const evidence: Record<string, string> = {};
    for (const k of ["app-id", "compose-hash", "os-image-hash", "instance-id"]) if (replay.events[k]) evidence[k.replace(/-/g, "_")] = replay.events[k]!;
    local("event_log", "The runtime event log matches the quote", ok, ok ? "the RTMR3 events replay to the RTMR3 in the quote" : "the event log does not replay to the RTMR3 in the quote", evidence);
  } catch (err) {
    local("event_log", "The runtime event log matches the quote", false, err instanceof Error ? err.message : String(err));
  }

  // GPU evidence (model reports): the nonce is checked here, NVIDIA's verdict is not.
  if (scope === "model") {
    const gpuTitle = "NVIDIA accepts the GPU evidence";
    const payload = report.nvidia_payload === undefined || report.nvidia_payload === null ? null : parseMaybeJson(report.nvidia_payload);
    if (payload === null) add("gpu_verdict", gpuTitle, "not_verified", "none", "the report carries no NVIDIA GPU evidence");
    else if (!isRec(payload)) local("gpu_nonce", "The GPU evidence was made for this client's nonce", false, "nvidia_payload is not a JSON object");
    else {
      const gpuNonce = str(payload.nonce)?.toLowerCase() ?? null;
      local("gpu_nonce", "The GPU evidence was made for this client's nonce", gpuNonce === nonce, gpuNonce === nonce ? "the GPU evidence carries the client nonce" : "the GPU evidence carries a different nonce: stale or replayed evidence");
      if (ctx.gpuVerifier && gpuNonce === nonce) {
        try {
          const verdict = await ctx.gpuVerifier(payload);
          add("gpu_verdict", gpuTitle, verdict.ok ? "pass" : "fail", verdict.trust, `${verdict.verifier}: ${verdict.detail}`);
        } catch (err) {
          add("gpu_verdict", gpuTitle, "fail", "remote", `the GPU verifier failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (gpuNonce === nonce) {
        add("gpu_verdict", gpuTitle, "not_verified", "none", "not verified locally: the GPU evidence is judged by NVIDIA's remote attestation service (plug it in with the gpuVerifier option)");
      }
    }
  }

  const accepted = ctx.policy.acceptedComposeHashes?.map((h) => h.toLowerCase());
  const policyTitle = "The measured software is software you accept";
  if (accepted && composeHash !== null) local("measurement_policy", policyTitle, accepted.includes(composeHash), accepted.includes(composeHash) ? "the compose hash is on the accepted list" : `the compose hash ${short(composeHash)} is not on the accepted list`);
  else add("measurement_policy", policyTitle, "not_verified", "none", "not verified: no accepted-measurement or image-provenance policy is configured, so the measurements are reported, not judged");

  return done(signer, measurements);
}

// ------------------------------------------------------------------ attestation

/**
 * Verifies the body of GET /v1/attestation/report: the gateway report and every `model_attestations[]` candidate.
 * Never throws for bad evidence. The result is JSON-serializable.
 */
export async function verifyNearAiAttestation(input: VerifyNearAiAttestationInput): Promise<NearAiAttestationVerification> {
  const now = input.now ?? new Date();
  const model = input.model ?? null;
  const policy = input.policy ?? {};
  const ctx: ReportContext = { nonce: input.nonce, now, policy, quoteVerifier: input.quoteVerifier, gpuVerifier: input.gpuVerifier };
  const top: AttestationCheck[] = [];
  const body = isRec(input.report) ? input.report : null;

  let gateway: NearAiReportVerification | null = null;
  if (!body || !isRec(body.gateway_attestation)) {
    top.push({ id: "report_shape", scope: "attestation", title: "The attestation report has a gateway report", status: "fail", trust: "local", detail: "the response has no gateway_attestation object" });
  } else {
    gateway = await verifyReport(body.gateway_attestation, "gateway", 0, ctx);
  }

  const candidates = body && Array.isArray(body.model_attestations) ? body.model_attestations : [];
  const models: NearAiReportVerification[] = [];
  for (let i = 0; i < candidates.length; i++) models.push(await verifyReport(candidates[i], "model", i, ctx));
  for (const [i, m] of models.entries()) {
    const named = isRec(candidates[i]) ? str(candidates[i].model_name) : null;
    if (model !== null && named !== null && named !== model) {
      m.checks.push({ id: "model_name", scope: `model:${i}`, title: "The model report is for the requested model", status: "fail", trust: "local", detail: `the report is for ${named}, not ${model}` });
      m.status = rollUp(m.checks);
    }
  }

  const requireModel = policy.requireModelEvidence ?? model !== null;
  if (model !== null || models.length > 0) {
    const title = "A NEAR model enclave report came back for the model";
    if (models.length > 0) top.push({ id: "model_evidence", scope: "attestation", title, status: "pass", trust: "local", detail: `${models.length} model report${models.length === 1 ? "" : "s"} for ${model ?? "the model"}; every one is checked` });
    else {
      const why = input.modelEvidenceError ? `no NEAR model report for ${model}: ${input.modelEvidenceError}` : `the report has no model_attestations for ${model}: the model does not run in a NEAR-operated enclave, or the id is an alias`;
      top.push({ id: "model_evidence", scope: "attestation", title, status: requireModel ? "fail" : "not_verified", trust: requireModel ? "local" : "none", detail: why });
    }
  }

  const checks = [...top, ...(gateway?.checks ?? []), ...models.flatMap((m) => m.checks)];
  const status = rollUp(checks);
  const notVerifiedLocally = [...new Set(checks.filter((c) => c.status === "not_verified").map((c) => c.detail))];
  const firstFail = checks.find((c) => c.status === "fail");
  const what = models.length > 0 ? `the NEAR AI Cloud gateway and ${models.length === 1 ? "the model enclave" : `${models.length} model enclaves`} for ${model ?? "the model"}` : "the NEAR AI Cloud gateway";
  const summary =
    status === "failed"
      ? `Attestation failed (${firstFail ? `${firstFail.scope}: ${firstFail.detail}` : "no check passed"}).`
      : status === "verified"
        ? `Attestation verified for ${what}: every check passed.`
        : `Attestation partially verified for ${what}: the Intel TDX quotes, their signature chain to Intel's root, the nonce and the signing keys were checked in this process; ${notVerifiedLocally.length} thing${notVerifiedLocally.length === 1 ? " was" : "s were"} not verified (see the checks).`;
  return { kind: "nearai_attestation", status, summary, checks, model, nonce: input.nonce.toLowerCase(), verifiedAt: now.toISOString(), gateway, models, notVerifiedLocally };
}

// ------------------------------------------------------------------ response

/** The checks a default preflight leaves open, in words for a summary line. */
const OPEN_IN_PLAIN_WORDS: Record<string, string> = {
  tcb_status: "Intel's TCB status of the platform",
  gpu_verdict: "NVIDIA's verdict on the GPU evidence",
  measurement_policy: "whether the measured software is on an accepted list",
};

const RESPONSE_LIMITS = [
  "Instances of one model share a signing key, so a matching signer does not show that the verified report and this answer came from the same serving instance.",
  "A gateway signature shows that the verified gateway signed the bytes you received, not that a verified model produced them; a model signature does not tie the model's bytes to the gateway or to the TLS connection.",
  "Attestation says which measured software signed the bytes. It says nothing about the quality or truth of the answer.",
];

/**
 * Verifies one completion against its signature and the preflight attestation. Never throws for bad evidence.
 * `boundTo` is set only when the signature checks all pass: "model_enclave" for a `provider_tee` signature whose
 * signer matches exactly one model report of the preflight, "gateway_enclave" for a `gateway` signature.
 */
export function verifyNearAiResponse(input: VerifyNearAiResponseInput): NearAiResponseVerification {
  const bytes = (v: Uint8Array | string) => (typeof v === "string" ? Buffer.from(v, "utf8") : v);
  const requestHash = toHex(sha256(bytes(input.requestBody)));
  const responseHash = toHex(sha256(bytes(input.responseBody)));
  const att = input.attestation;
  const checks: AttestationCheck[] = [];
  const add = (id: string, title: string, status: AttestationCheck["status"], detail: string, evidence?: Record<string, string>) =>
    checks.push({ id, scope: "response", title, status, trust: status === "not_verified" ? "none" : "local", detail, ...(evidence ? { evidence } : {}) });
  const base = { kind: "nearai_response" as const, model: input.model, chatId: input.chatId ?? null, requestHash, responseHash, attestation: { status: att.status, verifiedAt: att.verifiedAt, nonce: att.nonce }, limits: RESPONSE_LIMITS };
  const finish = (signatureKind: NearAiSignatureKind | null, signer: NearAiSigner | null, boundTo: NearAiResponseVerification["boundTo"], okSummary: string): NearAiResponseVerification => {
    const status = rollUp(checks);
    const fail = checks.find((c) => c.status === "fail");
    const open = checks.filter((c) => c.status === "not_verified").map((c) => c.detail);
    const summary = status === "failed" ? `Not verified: ${fail ? fail.detail : "no check passed"}.` : status === "verified" ? `${okSummary} Every check passed.` : `${okSummary} Not verified here: ${open.join("; ")}.`;
    return { ...base, status, summary, checks, signatureKind, signer, boundTo: status === "failed" ? null : boundTo };
  };

  const sig = isRec(input.signature) ? input.signature : null;
  const unavailable = sig && ("error_code" in sig || typeof sig.text !== "string" || typeof sig.signature !== "string");
  if (!sig || unavailable) {
    const why = input.signatureError ?? (sig && typeof sig.message === "string" ? `the signature endpoint answered: ${sig.message}` : "no signature was returned for this completion");
    add("signature_available", "A signature exists for this completion", "fail", `no signature available, so the answer is unverified (${why})`);
    return finish(null, null, null, "");
  }
  add("signature_available", "A signature exists for this completion", "pass", `signature fetched for ${input.chatId ?? "the completion"}`);

  const kind = sig.signature_kind === "provider_tee" || sig.signature_kind === "gateway" ? sig.signature_kind : null;
  const signer = signerOf(sig);
  if (!kind) {
    add("signature_kind", "The signature says who signed", "fail", `signature_kind is ${sig.signature_kind === undefined || sig.signature_kind === null ? "absent" : JSON.stringify(sig.signature_kind)}, so the signer cannot be classified`);
    return finish(null, signer, null, "");
  }
  add("signature_kind", "The signature says who signed", "pass", kind === "provider_tee" ? "signed by a model-serving enclave (provider_tee)" : "signed by the gateway enclave (gateway)");

  const expected = nearAiSignedText(kind, requestHash, responseHash, input.model);
  const textOk = sig.text === expected;
  add(
    "signed_text",
    "The signature covers exactly the bytes sent and received",
    textOk ? "pass" : "fail",
    textOk ? "the signed text is the hash of the exact request bytes and the exact response bytes" : "the signed text does not match the hashes of the request and response bytes this client holds: the request or the answer was altered, or the signature belongs to another completion",
    { request_hash: requestHash, response_hash: responseHash, signed_text: String(sig.text).slice(0, 300) },
  );

  let signatureOk = false;
  if (!signer) add("signature_valid", "The signature is valid for the stated signer", "fail", "the signature names no usable signing identity (signing_algo must be ecdsa or ed25519)");
  else {
    const raw = hexBytes(sig.signature, signer.algo === "ecdsa" ? 65 : 64);
    if (!raw) add("signature_valid", "The signature is valid for the stated signer", "fail", `the signature is not ${signer.algo === "ecdsa" ? 65 : 64} bytes of hex`);
    else if (signer.algo === "ecdsa") {
      const recovered = recoverEip191Signer(sig.text as string, raw);
      signatureOk = recovered === signer.address;
      add("signature_valid", "The signature is valid for the stated signer", signatureOk ? "pass" : "fail", signatureOk ? `the EIP-191 signature recovers to ${signer.address}` : `the signature recovers to ${recovered ?? "no address"}, not to the stated signer ${signer.address}`, { signing_address: signer.address });
    } else {
      signatureOk = ed25519Verifies(sig.text as string, raw, hexBytes(signer.address)!);
      add("signature_valid", "The signature is valid for the stated signer", signatureOk ? "pass" : "fail", signatureOk ? `the Ed25519 signature verifies with ${short(signer.address)}` : "the Ed25519 signature does not verify with the stated public key", { signing_address: signer.address });
    }
  }

  // The signer must be one the preflight verified: exactly one model report, or the gateway report.
  const pool = kind === "provider_tee" ? att.models : att.gateway ? [att.gateway] : [];
  const matches = pool.filter((r) => sameSigner(r.signer, signer));
  const who = kind === "provider_tee" ? "model enclave report" : "gateway report";
  const title = "The signer is the key of an enclave verified before the request";
  let matched: NearAiReportVerification | null = null;
  if (matches.length === 0) add("signer_attested", title, "fail", `the signer ${signer?.address ?? "(none)"} matches no ${who} of the preflight attestation: the signature comes from another key`);
  else if (matches.length > 1) add("signer_attested", title, "fail", `the signer matches ${matches.length} model reports, so the match is ambiguous`);
  else if (matches[0]!.status === "failed") add("signer_attested", title, "fail", `the signer matches a ${who} that failed verification`);
  else {
    matched = matches[0]!;
    add("signer_attested", title, "pass", `the signer ${signer!.address} is the signing key of the ${who} verified at ${att.verifiedAt}`);
  }

  const sentAt = input.requestSentAt ?? new Date();
  const age = sentAt.getTime() - Date.parse(att.verifiedAt);
  const maxAge = input.maxAttestationAgeMs ?? DEFAULT_MAX_ATTESTATION_AGE_MS;
  const fresh = Number.isFinite(age) && age >= 0 && age <= maxAge;
  add(
    "preflight_fresh",
    "The enclave was verified shortly before the request",
    fresh ? "pass" : "fail",
    fresh ? `attestation verified ${Math.round(age / 1000)} s before the request` : !Number.isFinite(age) || age < 0 ? "the attestation was verified after the request was sent; evidence fetched afterwards cannot replace a preflight check" : `the attestation is stale: verified ${Math.round(age / 1000)} s before the request, more than the ${Math.round(maxAge / 1000)} s allowed`,
  );

  if (matched) {
    const open = matched.checks.filter((c) => c.status === "not_verified");
    if (matched.status === "verified") add("enclave_attestation", "The enclave's attestation is fully verified", "pass", `every check of the ${who} passed`);
    else add("enclave_attestation", "The enclave's attestation is fully verified", "not_verified", `the ${who} is only partly verified; not checked in this process: ${[...new Set(open.map((c) => OPEN_IN_PLAIN_WORDS[c.id] ?? c.id))].join(", ")}`);
  }
  if (kind === "gateway") add("model_binding", "The answer is tied to a model enclave", "not_verified", "the gateway enclave signed these bytes; that does not tie the answer to a model enclave");
  else add("model_binding", "The answer is tied to a model enclave", matched && signatureOk && textOk ? "pass" : "fail", matched && signatureOk && textOk ? `a model enclave attested for ${input.model} signed the model id and both hashes` : "the model enclave signature did not verify");

  const okSummary =
    kind === "provider_tee"
      ? `This answer was signed by the model enclave key ${signer?.address ?? ""} for ${input.model}, a key bound to an Intel TDX quote that was checked before the request.`
      : `This answer was signed by the NEAR AI Cloud gateway enclave key ${signer?.address ?? ""}, a key bound to an Intel TDX quote that was checked before the request; it is not tied to a model enclave.`;
  return finish(kind, signer, kind === "provider_tee" ? "model_enclave" : "gateway_enclave", okSummary);
}

/** The few fields worth storing next to a model turn (a run step, a log line). */
export function summarizeAttestation(a: TurnAttestation): { status: AttestationStatus; summary: string; passed: string[]; failed: string[]; not_verified: string[]; request_hash?: string; response_hash?: string; signature_kind?: string | null; signer?: string | null; bound_to?: string | null } {
  const ids = (s: AttestationCheck["status"]) => [...new Set(a.checks.filter((c) => c.status === s).map((c) => c.id))];
  const r = a as Partial<NearAiResponseVerification>;
  return {
    status: a.status,
    summary: a.summary,
    passed: ids("pass"),
    failed: ids("fail"),
    not_verified: ids("not_verified"),
    ...(r.kind === "nearai_response" ? { request_hash: r.requestHash, response_hash: r.responseHash, signature_kind: r.signatureKind ?? null, signer: r.signer?.address ?? null, bound_to: r.boundTo ?? null } : {}),
  };
}
