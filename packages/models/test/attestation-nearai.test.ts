/**
 * verifyNearAiAttestation against a real attestation report recorded from NEAR AI Cloud (LIVE), and
 * verifyNearAiResponse against signatures made with throwaway keys (SYNTHETIC, see nearai-fixtures.ts). No network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ATTESTATION_AGE_MS,
  nearAiSignedText,
  recoverEip191Signer,
  replayRtmr3,
  summarizeAttestation,
  verifyNearAiAttestation,
  verifyNearAiResponse,
  type NearAiAttestationVerification,
  type VerifyNearAiResponseInput,
} from "../src/attestation/nearai.ts";
import type { AttestationCheck } from "../src/model.ts";
import { LIVE_MODEL, LIVE_NONCE, LIVE_NOW, ecdsaKey, ed25519Key, eip191Sign, flipHex, liveReport, sha256Hex, signatureBody, withSigners } from "./nearai-fixtures.ts";

const verify = (report: unknown, over: Partial<Parameters<typeof verifyNearAiAttestation>[0]> = {}) => verifyNearAiAttestation({ report, nonce: LIVE_NONCE, model: LIVE_MODEL, now: LIVE_NOW, ...over });
const ids = (checks: AttestationCheck[], status: AttestationCheck["status"]) => checks.filter((c) => c.status === status).map((c) => `${c.scope}/${c.id}`);
const failed = (a: { checks: AttestationCheck[] }) => ids(a.checks, "fail");

let live: NearAiAttestationVerification;
beforeAll(async () => {
  live = await verify(liveReport());
});

describe("verifyNearAiAttestation (live recording)", () => {
  it("verifies the gateway and the model enclave, and says what it did not verify", () => {
    expect(live).toMatchObject({ kind: "nearai_attestation", status: "partially_verified", model: LIVE_MODEL, nonce: LIVE_NONCE, verifiedAt: LIVE_NOW.toISOString() });
    expect(failed(live)).toEqual([]);
    expect(ids(live.checks, "pass")).toEqual([
      "attestation/model_evidence",
      "gateway/quote_parsed",
      "gateway/quote_signature",
      "gateway/pck_chain",
      "gateway/qe_identity",
      "gateway/debug_disabled",
      "gateway/nonce_binding",
      "gateway/signer_binding",
      "gateway/config_measurement",
      "gateway/event_log",
      "model:0/quote_parsed",
      "model:0/quote_signature",
      "model:0/pck_chain",
      "model:0/qe_identity",
      "model:0/debug_disabled",
      "model:0/nonce_binding",
      "model:0/signer_binding",
      "model:0/signing_public_key",
      "model:0/config_measurement",
      "model:0/event_log",
      "model:0/gpu_nonce",
    ]);
    // Exactly these are not checked in this process, and each says so.
    expect(ids(live.checks, "not_verified")).toEqual(["gateway/tcb_status", "gateway/measurement_policy", "model:0/tcb_status", "model:0/gpu_verdict", "model:0/measurement_policy"]);
    for (const c of live.checks.filter((x) => x.status === "not_verified")) expect([c.trust, c.detail]).toEqual(["none", expect.stringMatching(/^not verified/)]);
    for (const c of live.checks.filter((x) => x.status === "pass")) expect(c.trust).toBe("local");
    expect(live.notVerifiedLocally).toHaveLength(3);
    expect(live.summary).toMatch(/partially verified/);
    expect(live.summary).not.toMatch(/\u2014/);
  });

  it("reports the signing keys and measurements read from the quotes", () => {
    const report = liveReport();
    expect(live.gateway).toMatchObject({ scope: "gateway", status: "partially_verified", signer: { algo: "ecdsa", address: report.gateway_attestation.signing_address } });
    expect(live.models).toHaveLength(1);
    expect(live.models[0]).toMatchObject({ scope: "model", index: 0, status: "partially_verified", signer: { algo: "ecdsa", address: report.model_attestations[0]!.signing_address } });
    const m = live.models[0]!.measurements!;
    expect(m.composeHash).toBe(report.model_attestations[0]!.info.tcb_info.compose_hash);
    expect(m.mrConfigId).toBe(`01${m.composeHash}${"00".repeat(15)}`);
    expect(m.reportData.slice(64)).toBe(LIVE_NONCE);
    const events = live.models[0]!.checks.find((c) => c.id === "event_log")!.evidence!;
    expect(events.compose_hash).toBe(m.composeHash);
    expect(JSON.parse(JSON.stringify(live))).toEqual(live);
  });

  it("becomes verified only when the open checks are supplied and pass", async () => {
    const report = liveReport();
    const hashes = [report.gateway_attestation.info.tcb_info.compose_hash, report.model_attestations[0]!.info.tcb_info.compose_hash];
    const quoteVerifier = async () => ({ tcbStatus: "UpToDate", trust: "local" as const, verifier: "test verifier" });
    const gpuVerifier = async () => ({ ok: true, detail: "overall attestation result true", trust: "remote" as const, verifier: "test NRAS" });
    const full = await verify(report, { quoteVerifier, gpuVerifier, policy: { acceptedComposeHashes: hashes } });
    expect(full.status).toBe("verified");
    expect(ids(full.checks, "not_verified")).toEqual([]);
    expect(full.checks.find((c) => c.id === "gpu_verdict")).toMatchObject({ status: "pass", trust: "remote" });

    const outdated = await verify(report, { quoteVerifier: async () => ({ tcbStatus: "OutOfDate", advisoryIds: ["INTEL-SA-01"], trust: "local" as const, verifier: "test verifier" }) });
    expect(outdated.status).toBe("failed");
    expect(failed(outdated)).toEqual(["gateway/tcb_status", "model:0/tcb_status"]);
    expect(outdated.checks.find((c) => c.id === "tcb_status")!.detail).toMatch(/OutOfDate, advisories INTEL-SA-01/);

    expect(failed(await verify(report, { quoteVerifier: async () => Promise.reject(new Error("collateral unavailable")) }))).toContain("gateway/tcb_status");
    expect(failed(await verify(report, { gpuVerifier: async () => ({ ok: false, detail: "verdict false", trust: "remote" as const, verifier: "test NRAS" }) }))).toEqual(["model:0/gpu_verdict"]);
    expect(failed(await verify(report, { policy: { acceptedComposeHashes: [hashes[0]!] } }))).toEqual(["model:0/measurement_policy"]);
  });
});

describe("verifyNearAiAttestation (negative)", () => {
  it("fails a stale or replayed report: the quote was made for another nonce", async () => {
    const other = "ab".repeat(32);
    const a = await verify(liveReport(), { nonce: other });
    expect(a.status).toBe("failed");
    expect(failed(a)).toEqual(["gateway/nonce_binding", "model:0/nonce_binding", "model:0/gpu_nonce"]);
    expect(a.checks.find((c) => c.id === "nonce_binding")!.detail).toMatch(/stale or replayed evidence/);
    expect(a.summary).toMatch(/^Attestation failed/);

    // The server echoing the client's nonce does not help: the quote is what counts.
    const echoed = liveReport();
    echoed.gateway_attestation.request_nonce = other;
    echoed.model_attestations[0]!.request_nonce = other;
    expect(failed(await verify(echoed, { nonce: other }))).toContain("model:0/nonce_binding");
    expect((await verify(liveReport(), { nonce: "xyz" })).status).toBe("failed");
  });

  it("fails a mismatched signing key: the reported address is not the one in the quote", async () => {
    const r = liveReport();
    r.model_attestations[0]!.signing_address = r.gateway_attestation.signing_address;
    const a = await verify(r);
    expect(failed(a)).toEqual(["model:0/signer_binding", "model:0/signing_public_key"]);
    expect(a.models[0]!.status).toBe("failed");
    expect(a.gateway!.status).toBe("partially_verified");

    const copy = liveReport();
    copy.gateway_attestation.report_data = flipHex(copy.gateway_attestation.report_data, 3);
    expect(failed(await verify(copy))).toEqual(["gateway/signer_binding"]);
    const algo = liveReport();
    algo.gateway_attestation.signing_algo = "rsa";
    expect(failed(await verify(algo))).toEqual(["gateway/signer_binding"]);
  });

  it("fails a tampered quote, configuration or event log", async () => {
    const quote = liveReport();
    quote.model_attestations[0]!.intel_quote = flipHex(quote.model_attestations[0]!.intel_quote, (48 + 520) * 2 + 3);
    expect(failed(await verify(quote))).toEqual(expect.arrayContaining(["model:0/quote_signature", "model:0/signer_binding"]));

    const compose = liveReport();
    compose.gateway_attestation.info.tcb_info.app_compose += " ";
    expect(failed(await verify(compose))).toEqual(["gateway/config_measurement"]);

    const log = liveReport();
    const events = JSON.parse(log.gateway_attestation.event_log);
    events.find((e: { event: string }) => e.event === "compose-hash").event_payload = "00".repeat(32);
    log.gateway_attestation.event_log = JSON.stringify(events);
    expect(failed(await verify(log))).toEqual(["gateway/event_log"]);

    const dropped = liveReport();
    dropped.model_attestations[0]!.event_log = dropped.model_attestations[0]!.event_log.filter((e: { imr: number }, i: number, all: unknown[]) => !(e.imr === 3 && i === all.length - 1));
    expect(failed(await verify(dropped))).toEqual(["model:0/event_log"]);

    const garbage = liveReport();
    garbage.gateway_attestation.intel_quote = "zz";
    expect(failed(await verify(garbage))).toEqual(["gateway/quote_parsed"]);
    expect(failed(await verify({ gateway_attestation: null }))).toEqual(["attestation/report_shape", "attestation/model_evidence"]);
    expect((await verify("not json")).status).toBe("failed");
  });

  it("fails GPU evidence made for another nonce and a report for another model", async () => {
    const gpu = liveReport();
    gpu.model_attestations[0]!.nvidia_payload = JSON.stringify({ nonce: "cd".repeat(32), evidence_list: [], arch: "HOPPER" });
    expect(failed(await verify(gpu))).toEqual(["model:0/gpu_nonce"]);

    const name = liveReport();
    name.model_attestations[0]!.model_name = "Qwen/Qwen3.8-27B";
    const a = await verify(name);
    expect(failed(a)).toEqual(["model:0/model_name"]);
    expect(a.models[0]!.status).toBe("failed");
  });

  it("fails without model evidence unless the caller accepts a gateway-only result", async () => {
    const r = liveReport();
    const gatewayOnly = { gateway_attestation: r.gateway_attestation };
    const required = await verify(gatewayOnly, { modelEvidenceError: "No provider found that supports attestation reports for model: openai/gpt-5-nano", model: "openai/gpt-5-nano" });
    expect(required.status).toBe("failed");
    expect(required.checks.find((c) => c.id === "model_evidence")).toMatchObject({ status: "fail", detail: expect.stringMatching(/no NEAR model report for openai\/gpt-5-nano: No provider found/) });

    const accepted = await verify(gatewayOnly, { policy: { requireModelEvidence: false } });
    expect(accepted.status).toBe("partially_verified");
    expect(accepted.checks.find((c) => c.id === "model_evidence")).toMatchObject({ status: "not_verified", trust: "none" });
    expect(accepted.models).toEqual([]);

    const bare = await verify(gatewayOnly, { model: null });
    expect(bare.status).toBe("partially_verified");
    expect(bare.checks.some((c) => c.id === "model_evidence")).toBe(false);
  });
});

describe("helpers", () => {
  it("recovers the signer of an EIP-191 personal message (vectors from an independent implementation)", () => {
    // Made with viem 2.57.10 (privateKeyToAccount(0x0123...0123).signMessage), which shares no code with this package's check.
    const signature = Buffer.from("e0ed34fbbe927a58267ce2e8067a611c69869e20e731bc99187a8bc97058664c16de07f7660f06ce0985d1d8e063726783033fda59b307897f26a21392d62b3a1c", "hex");
    expect(recoverEip191Signer("Hello World", signature)).toBe("0x14791697260e4c9a71f18484c9f997b308e59325");
    const shaped = Buffer.from("a3331e7b896fa08e309c423dcf94dd975714954b78efc5863f6dbb0e414acfff16522a00899c32aec45ffb64b6c10776716765458bafa1ab4cfe7efb431d24891b", "hex");
    expect(recoverEip191Signer("z-ai/glm-5.3-flash:aa:bb", shaped)).toBe("0x14791697260e4c9a71f18484c9f997b308e59325");
    expect(recoverEip191Signer("Hello World!", signature)).not.toBe("0x14791697260e4c9a71f18484c9f997b308e59325");
    expect(recoverEip191Signer("Hello World", signature.subarray(0, 64))).toBeNull();
    expect(recoverEip191Signer("Hello World", Buffer.concat([signature.subarray(0, 64), Buffer.from([9])]))).toBeNull();
  });

  it("round-trips a synthetic signature and builds the signed text", () => {
    const key = ecdsaKey(7);
    expect(recoverEip191Signer("a:b", Buffer.from(eip191Sign("a:b", key), "hex"))).toBe(key.signer.address);
    expect(nearAiSignedText("provider_tee", "aa", "bb", "m/x")).toBe("m/x:aa:bb");
    expect(nearAiSignedText("gateway", "aa", "bb", "m/x")).toBe("aa:bb");
  });

  it("replays an event log and refuses a malformed one", () => {
    const g = liveReport().gateway_attestation;
    expect(replayRtmr3(g.event_log).rtmr3).toHaveLength(96);
    expect(() => replayRtmr3("nope")).toThrow(/not a list/);
    expect(() => replayRtmr3([{ imr: 3, event_type: 1, event: "x", event_payload: "zz" }])).toThrow(/not hex/);
    expect(() => replayRtmr3([{ imr: 3, event_type: 1, event: "x", event_payload: "", digest: "00" }])).toThrow(/differs from the computed one/);
  });
});

describe("verifyNearAiResponse (synthetic signatures)", () => {
  const request = JSON.stringify({ model: LIVE_MODEL, messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 64 });
  const response = JSON.stringify({ id: "chatcmpl-synthetic-1", object: "chat.completion", model: LIVE_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } });
  const modelKey = ecdsaKey(1);
  const gatewayKey = ecdsaKey(2);
  const strangerKey = ecdsaKey(3);
  const sentAt = new Date(LIVE_NOW.getTime() + 2_000);
  const preflight = () => withSigners(live, { model: modelKey.signer, gateway: gatewayKey.signer });
  const teeSignature = (o: Partial<Parameters<typeof signatureBody>[0]> = {}) => signatureBody({ kind: "provider_tee", model: LIVE_MODEL, request, response, sign: (t) => eip191Sign(t, modelKey), signer: modelKey.signer, ...o });
  const run = (over: Partial<VerifyNearAiResponseInput> = {}) => verifyNearAiResponse({ requestBody: request, responseBody: response, model: LIVE_MODEL, signature: teeSignature(), attestation: preflight(), chatId: "chatcmpl-synthetic-1", requestSentAt: sentAt, ...over });

  it("accepts a model enclave signature over the exact bytes, and stays partial while the preflight is partial", () => {
    const r = run();
    expect(failed(r)).toEqual([]);
    expect(r).toMatchObject({ kind: "nearai_response", status: "partially_verified", signatureKind: "provider_tee", boundTo: "model_enclave", signer: modelKey.signer, model: LIVE_MODEL, chatId: "chatcmpl-synthetic-1" });
    expect([r.requestHash, r.responseHash]).toEqual([sha256Hex(request), sha256Hex(response)]);
    expect(ids(r.checks, "pass")).toEqual(["response/signature_available", "response/signature_kind", "response/signed_text", "response/signature_valid", "response/signer_attested", "response/preflight_fresh", "response/model_binding"]);
    expect(ids(r.checks, "not_verified")).toEqual(["response/enclave_attestation"]);
    expect(r.checks.find((c) => c.id === "enclave_attestation")!.detail).toMatch(/only partly verified; not checked in this process: Intel's TCB status of the platform, NVIDIA's verdict on the GPU evidence, whether the measured software is on an accepted list$/);
    expect(r.summary).toMatch(/signed by the model enclave key/);
    expect(r.attestation).toEqual({ status: "partially_verified", verifiedAt: LIVE_NOW.toISOString(), nonce: LIVE_NONCE });
    expect(r.limits.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    // Bytes and strings hash alike.
    expect(run({ requestBody: Buffer.from(request), responseBody: new TextEncoder().encode(response) }).status).toBe("partially_verified");
  });

  it("is verified only on top of a fully verified preflight", () => {
    const r = run({ attestation: withSigners(live, { model: modelKey.signer, fully: true }) });
    expect(r.status).toBe("verified");
    expect(r.summary).toMatch(/Every check passed/);
    expect(summarizeAttestation(r)).toMatchObject({ status: "verified", failed: [], not_verified: [], signature_kind: "provider_tee", signer: modelKey.signer.address, bound_to: "model_enclave", request_hash: sha256Hex(request) });
  });

  it("fails a tampered response or request", () => {
    const tampered = run({ responseBody: response.replace('"ok"', '"no"') });
    expect(tampered).toMatchObject({ status: "failed", boundTo: null });
    expect(failed(tampered)).toEqual(["response/signed_text", "response/model_binding"]);
    expect(tampered.summary).toMatch(/^Not verified: the signed text does not match/);
    // One byte of whitespace is enough: the hash is over the exact bytes.
    expect(failed(run({ responseBody: `${response}\n` }))).toContain("response/signed_text");
    expect(failed(run({ requestBody: request.replace("ok", "no") }))).toContain("response/signed_text");
    // A signature for another model's name does not match either.
    expect(failed(run({ model: "Qwen/Qwen3.8-27B" }))).toContain("response/signed_text");
  });

  it("fails a signature from another key", () => {
    // The stranger signs and says who it is: valid signature, but not an attested enclave.
    const honest = run({ signature: teeSignature({ sign: (t) => eip191Sign(t, strangerKey), signer: strangerKey.signer }) });
    expect(failed(honest)).toEqual(["response/signer_attested", "response/model_binding"]);
    expect(honest.checks.find((c) => c.id === "signer_attested")!.detail).toMatch(/matches no model enclave report/);
    // The stranger signs but claims the enclave's address: the signature does not recover to it.
    const forged = run({ signature: teeSignature({ sign: (t) => eip191Sign(t, strangerKey) }) });
    expect(failed(forged)).toEqual(["response/signature_valid", "response/model_binding"]);
    expect(forged.status).toBe("failed");
    // A garbled signature.
    expect(failed(run({ signature: { ...teeSignature(), signature: "00" } }))).toContain("response/signature_valid");
    const flipped = teeSignature();
    expect(failed(run({ signature: { ...flipped, signature: flipHex(flipped.signature, 10) } }))).toContain("response/signature_valid");
  });

  it("fails a stale preflight, and a preflight made after the request", () => {
    const old = withSigners(live, { model: modelKey.signer, verifiedAt: new Date(sentAt.getTime() - DEFAULT_MAX_ATTESTATION_AGE_MS - 1_000) });
    const stale = run({ attestation: old });
    expect(failed(stale)).toEqual(["response/preflight_fresh"]);
    expect(stale.checks.find((c) => c.id === "preflight_fresh")!.detail).toMatch(/stale/);
    expect(run({ attestation: old, maxAttestationAgeMs: 60 * 60_000 }).status).toBe("partially_verified");

    const late = run({ attestation: withSigners(live, { model: modelKey.signer, verifiedAt: new Date(sentAt.getTime() + 5_000) }) });
    expect(failed(late)).toEqual(["response/preflight_fresh"]);
    expect(late.checks.find((c) => c.id === "preflight_fresh")!.detail).toMatch(/cannot replace a preflight check/);
  });

  it("fails against a mismatched attestation: failed, ambiguous or without model reports", async () => {
    // The real enclave key is not the throwaway key: the unmodified live preflight does not cover this signature.
    expect(failed(run({ attestation: live }))).toEqual(["response/signer_attested", "response/model_binding"]);

    const failedPreflight = withSigners(await verify(liveReport(), { nonce: "ab".repeat(32) }), { model: modelKey.signer });
    const onFailed = run({ attestation: { ...failedPreflight, verifiedAt: LIVE_NOW.toISOString() } });
    expect(onFailed.checks.find((c) => c.id === "signer_attested")).toMatchObject({ status: "fail", detail: expect.stringMatching(/failed verification/) });

    const twice = preflight();
    twice.models.push(structuredClone(twice.models[0]!));
    expect(run({ attestation: twice }).checks.find((c) => c.id === "signer_attested")!.detail).toMatch(/ambiguous/);

    const none = preflight();
    none.models = [];
    expect(failed(run({ attestation: none }))).toContain("response/signer_attested");
  });

  it("treats a gateway signature as the gateway's, never as the model's", () => {
    const gatewaySignature = signatureBody({ kind: "gateway", model: LIVE_MODEL, request, response, sign: (t) => eip191Sign(t, gatewayKey), signer: gatewayKey.signer });
    const r = run({ signature: gatewaySignature });
    expect(r).toMatchObject({ status: "partially_verified", signatureKind: "gateway", boundTo: "gateway_enclave" });
    expect(r.checks.find((c) => c.id === "model_binding")).toMatchObject({ status: "not_verified", detail: expect.stringMatching(/does not tie the answer to a model enclave/) });
    expect(r.summary).toMatch(/not tied to a model enclave/);
    // Even on a fully verified preflight a gateway signature cannot be "verified": the model binding stays open.
    expect(run({ signature: gatewaySignature, attestation: withSigners(live, { gateway: gatewayKey.signer, fully: true }) }).status).toBe("partially_verified");
    // The model key signing a gateway-kind text is not the gateway.
    const wrong = signatureBody({ kind: "gateway", model: LIVE_MODEL, request, response, sign: (t) => eip191Sign(t, modelKey), signer: modelKey.signer });
    expect(failed(run({ signature: wrong }))).toEqual(["response/signer_attested"]);
    // A gateway key signing a provider_tee text is not a model enclave.
    const cross = signatureBody({ kind: "provider_tee", model: LIVE_MODEL, request, response, sign: (t) => eip191Sign(t, gatewayKey), signer: gatewayKey.signer });
    expect(failed(run({ signature: cross }))).toEqual(["response/signer_attested", "response/model_binding"]);
  });

  it("verifies Ed25519 signatures and never compares identities across algorithms", () => {
    const ed = ed25519Key();
    const sig = signatureBody({ kind: "gateway", model: LIVE_MODEL, request, response, sign: ed.sign, signer: ed.signer });
    expect(run({ signature: sig, attestation: withSigners(live, { gateway: ed.signer }) })).toMatchObject({ status: "partially_verified", signer: ed.signer });
    expect(failed(run({ signature: { ...sig, signature: flipHex(sig.signature, 4) }, attestation: withSigners(live, { gateway: ed.signer }) }))).toContain("response/signature_valid");
    expect(failed(run({ signature: sig }))).toEqual(["response/signer_attested"]);
    expect(failed(run({ signature: { ...teeSignature(), signing_algo: "rsa" } }))).toEqual(expect.arrayContaining(["response/signature_valid", "response/signer_attested"]));
  });

  it("is unverified without a signature or without a known signature kind", () => {
    const none = run({ signature: null, signatureError: "NEAR AI Cloud refused the request (404): Signature not found" });
    expect(none).toMatchObject({ status: "failed", signatureKind: null, signer: null, boundTo: null });
    expect(none.summary).toMatch(/no signature available, so the answer is unverified \(NEAR AI Cloud refused the request \(404\): Signature not found\)/);
    // A 2xx with error_code and message is an unavailable result, not a signature.
    const unavailable = run({ signature: { error_code: "STREAM_DISCONNECTED", message: "the stream was disconnected" } });
    expect(failed(unavailable)).toEqual(["response/signature_available"]);
    expect(unavailable.summary).toMatch(/the stream was disconnected/);

    const noKind = run({ signature: signatureBody({ kind: null, model: LIVE_MODEL, request, response, sign: (t) => eip191Sign(t, modelKey), signer: modelKey.signer, text: `${LIVE_MODEL}:${sha256Hex(request)}:${sha256Hex(response)}` }) });
    expect(failed(noKind)).toEqual(["response/signature_kind"]);
    expect(noKind.boundTo).toBeNull();
    expect(failed(run({ signature: { ...teeSignature(), signature_kind: "third_party" } }))).toEqual(["response/signature_kind"]);
    expect(summarizeAttestation(none)).toMatchObject({ status: "failed", failed: ["signature_available"], signature_kind: null, signer: null, bound_to: null });
  });
});
