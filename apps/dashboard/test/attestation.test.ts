import { describe, expect, it } from "vitest";
import { ATTESTATION_LIMIT, ATTESTATION_STATE, attestationState, attestationView, splitIds, timelineSteps, type StepAttestation } from "@/lib/agents";
import type { AgentRunEvent } from "@/lib/schemas";

const KEY = "0xc63e0e2fb427041e861b5e4a670908b943626d1f";
const GATEWAY_KEY = "0x5b1f0c7a9d2e4f60718293a4b5c6d7e8f9012345";

/** The node's own sentences, as packages/models writes them (verifyNearAiResponse). */
const MODEL_SUMMARY = `This answer was signed by the model enclave key ${KEY} for z-ai/glm-5.3-flash, a key bound to an Intel TDX quote that was checked before the request. Not verified here: the model enclave report is only partly verified; not checked in this process: Intel's TCB status of the platform, NVIDIA's verdict on the GPU evidence, whether the measured software is on an accepted list.`;
const GATEWAY_SUMMARY = `This answer was signed by the NEAR AI Cloud gateway enclave key ${GATEWAY_KEY}, a key bound to an Intel TDX quote that was checked before the request; it is not tied to a model enclave. Not verified here: the gateway report is only partly verified; not checked in this process: Intel's TCB status of the platform, whether the measured software is on an accepted list; the gateway enclave signed these bytes; that does not tie the answer to a model enclave.`;

const att = (over: Partial<StepAttestation> = {}): StepAttestation => ({
  status: "partially_verified",
  summary: MODEL_SUMMARY,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  signatureKind: "provider_tee",
  signer: KEY,
  failed: [],
  notVerified: ["enclave_attestation"],
  ...over,
});

const everyWord = (v: ReturnType<typeof attestationView>) => [v.label, v.short, v.meaning, v.next ?? "", v.uncheckedWhy ?? "", v.signer?.title ?? "", v.signer?.who ?? "", ...v.checked, ...v.unchecked, ...v.problems].join(" ");

describe("the state of a model turn's attestation", () => {
  it("tells a result with missing evidence apart from one where a check failed", () => {
    expect(attestationState(null)).toBe("none");
    expect(attestationState(undefined)).toBe("none");
    expect(attestationState(att({ status: "verified", notVerified: [] }))).toBe("verified");
    expect(attestationState(att())).toBe("partial");
    expect(attestationState(att({ status: "failed", failed: ["signer_attested", "model_binding"] }))).toBe("failed");
    expect(attestationState(att({ status: "failed", failed: ["signature_available"] }))).toBe("unavailable");
    expect(attestationState(att({ status: "failed", failed: ["report_fetched"] }))).toBe("unavailable");
    // A failed result that names no check is still a failure, never a quiet state.
    expect(attestationState(att({ status: "failed", failed: [] }))).toBe("failed");
  });

  it("keeps green for a result where every check passed", () => {
    expect(ATTESTATION_STATE.verified.tone).toBe("positive");
    for (const s of ["partial", "failed", "unavailable", "none"] as const) expect(ATTESTATION_STATE[s].tone).not.toBe("positive");
    expect(ATTESTATION_STATE.partial.label).toBe("Partially verified");
  });
});

describe("the attestation in plain words", () => {
  it("says a partial result is normal, who signed, and lists what was not checked", () => {
    const v = attestationView(att());
    expect(v).toMatchObject({ state: "partial", tone: "neutral", label: "Partially verified", next: null, problems: [], nodeNote: null });
    expect(v.meaning).toBe("The model enclave signed this exact request and answer. Your Payminto node checked the signature and the enclave's hardware report from Intel, and did not run 3 other checks. This is the normal result.");
    expect(v.signer).toEqual({ title: "Signed by", who: "The model enclave", key: KEY });
    expect(v.checked).toEqual([
      "The signature is valid and covers the exact request sent and the answer received",
      "The signing key is the one the model enclave presented when your node checked it before the request",
      "That enclave's Intel TDX quote chains to Intel's root certificate, answers your node's own challenge and shows debug mode off",
    ]);
    expect(v.unchecked).toEqual([
      "Whether Intel counts the enclave's hardware and firmware as up to date",
      "Whether NVIDIA accepts the evidence from the GPU",
      "Whether the software in the enclave is a build you accept",
    ]);
    expect(v.uncheckedWhy).toBe("The checks on the enclave itself need Intel's own service, NVIDIA's own service and a list of builds you accept. Payminto does not use them yet.");
  });

  it("says when only the gateway signed, and that nothing ties the answer to a model", () => {
    const v = attestationView(att({ summary: GATEWAY_SUMMARY, signatureKind: "gateway", signer: GATEWAY_KEY, notVerified: ["enclave_attestation", "model_binding"] }));
    expect(v.state).toBe("partial");
    expect(v.meaning).toBe("Only the NEAR AI Cloud gateway enclave signed this exact request and answer, so nothing ties the answer to a model. Your Payminto node checked the signature and the gateway's hardware report from Intel, and did not run 3 other checks.");
    expect(v.checked[1]).toBe("The signing key is the one the gateway enclave presented when your node checked it before the request");
    // The reason names only what the checks on this list would take: the gateway has no GPU evidence.
    expect(v.uncheckedWhy).toBe("The checks on the enclave itself need Intel's own service and a list of builds you accept. Payminto does not use them yet.");
    expect(v.meaning).not.toMatch(/normal result/);
    expect(v.signer).toEqual({ title: "Signed by", who: "The NEAR AI Cloud gateway enclave", key: GATEWAY_KEY });
    // What matters most comes first; the gateway has no GPU, so that check is not listed.
    expect(v.unchecked).toEqual([
      "Which model wrote the answer, because only the gateway signed it",
      "Whether Intel counts the enclave's hardware and firmware as up to date",
      "Whether the software in the enclave is a build you accept",
    ]);
    expect(v.next).toBe("To tie answers to a model enclave, choose a model that NEAR AI Cloud runs in its own enclaves.");
  });

  it("counts one open check in the singular and reads check ids stored flat", () => {
    const v = attestationView(att({ summary: null, notVerified: ["gpu_verdict"] }));
    expect(v.meaning).toMatch(/did not run 1 other check\./);
    expect(v.unchecked).toEqual(["Whether NVIDIA accepts the evidence from the GPU"]);
    expect(v.uncheckedWhy).toBe("The check on the enclave itself needs NVIDIA's own service. Payminto does not use it yet.");
  });

  it("falls back to the node's own note when the open checks are not named", () => {
    const summary = "Signed by the model enclave.";
    const v = attestationView(att({ summary }));
    expect(v.unchecked).toEqual(["Parts of the enclave's own report, named in the node's note"]);
    expect(v.uncheckedWhy).toBeNull();
    expect(v.nodeNote).toBe(summary);
    // An older step with no check ids at all still does not claim more than "partial".
    const bare = attestationView(att({ summary, notVerified: [] }));
    expect(bare.meaning).toMatch(/and left some checks unrun\. This is the normal result\.$/);
    expect(bare.unchecked).toEqual([]);
    expect(bare.nodeNote).toBe(summary);
  });

  it("shows a check it has no words for by its own name", () => {
    const v = attestationView(att({ summary: "Not verified here: x; not checked in this process: Intel's TCB status of the platform, firmware_rollback.", notVerified: ["enclave_attestation", "clock_skew"] }));
    expect(v.unchecked).toEqual(["Whether Intel counts the enclave's hardware and firmware as up to date", "Firmware rollback", "Clock skew"]);
  });

  it("says every check passed only for a verified result", () => {
    const v = attestationView(att({ status: "verified", notVerified: [] }));
    expect(v).toMatchObject({ state: "verified", tone: "positive", label: "Verified", unchecked: [], next: null });
    expect(v.meaning).toBe("The model enclave signed this exact request and answer, and every check your Payminto node ran passed.");
  });

  it("says what failed and what to do, and does not call the key an enclave's", () => {
    const summary = "Not verified: the signer 0x01 matches no model enclave report of the preflight attestation: the signature comes from another key.";
    const v = attestationView(att({ status: "failed", summary, signer: "0x01", failed: ["signer_attested", "model_binding"], notVerified: [] }));
    expect(v).toMatchObject({ state: "failed", tone: "negative", label: "Verification failed", checked: [], unchecked: [], nodeNote: summary });
    expect(v.meaning).toBe("A check did not pass, so nothing ties this answer to a checked enclave. Treat the answer as unverified.");
    // The missing tie to the model follows from the first failure, so it is not listed a second time.
    expect(v.problems).toEqual(["The signing key is not the key of an enclave your node checked before the request."]);
    expect(v.signer).toEqual({ title: "Key in the signature", who: null, key: "0x01" });
    expect(v.next).toBe("Run the agent again for a fresh check. If it fails again, treat answers from this connection as unverified.");
  });

  it("has a sentence for every check that can fail, and names an unknown one", () => {
    const v = attestationView(att({ status: "failed", failed: ["signature_kind", "signed_text", "signature_valid", "preflight_fresh", "tls_binding"], notVerified: [] }));
    expect(v.problems).toEqual([
      "The signature does not say whether the model enclave or the gateway signed.",
      "The signature covers a different request or answer than the one your node sent and received.",
      "The signature is not valid for the key it names.",
      "The enclave was not checked shortly before the request.",
      'The check "tls binding" did not pass.',
    ]);
    expect(attestationView(att({ status: "failed", failed: ["model_binding"], notVerified: [] })).problems).toEqual(["No model enclave signature ties the answer to the model."]);
  });

  it("says when there was nothing to check, and what to do", () => {
    const v = attestationView(att({ status: "failed", summary: "Not verified: no signature available, so the answer is unverified (no signature was recorded for this completion (404)).", signatureKind: null, signer: null, failed: ["signature_available"], notVerified: [] }));
    expect(v).toMatchObject({ state: "unavailable", tone: "warning", label: "Could not be checked", signer: null, problems: [], checked: [], unchecked: [] });
    expect(v.meaning).toBe("NEAR AI Cloud returned no signature for this answer, so nothing could be checked. The answer was still delivered and is unverified.");
    expect(v.next).toBe("Run the agent again to get a signed answer. If this keeps happening, NEAR AI Cloud may not be recording signatures.");
    expect(attestationView(att({ status: "failed", failed: ["report_fetched"], notVerified: [] })).meaning).toBe("The enclave report could not be fetched from NEAR AI Cloud, so nothing could be checked. The answer was still delivered and is unverified.");
  });

  it("says a turn without an attestation was not checked", () => {
    const v = attestationView(null);
    expect(v).toMatchObject({ state: "none", tone: "neutral", label: "No attestation", signer: null, next: null });
    expect(v.meaning).toBe("Nothing was checked about where this turn ran. Only agents on a NEAR AI Cloud connection get an attestation.");
  });

  it("never speaks about the answer being right, and keeps to the content voice", () => {
    const views = [
      attestationView(null),
      attestationView(att()),
      attestationView(att({ summary: GATEWAY_SUMMARY, signatureKind: "gateway", notVerified: ["enclave_attestation", "model_binding"] })),
      attestationView(att({ status: "verified", notVerified: [] })),
      attestationView(att({ status: "failed", failed: ["signed_text", "signature_valid", "signer_attested", "preflight_fresh", "signature_kind", "model_binding"], notVerified: [] })),
      attestationView(att({ status: "failed", failed: ["signature_available"], notVerified: [] })),
    ];
    for (const v of views) {
      const text = everyWord(v);
      // No exclamation mark and no long dash (U+2014), which is written here by its code so this file has none either.
      expect(text).not.toContain("!");
      expect(text).not.toContain(String.fromCharCode(0x2014));
      expect(text).not.toMatch(/\b(correct|accurate|true|trusted|safe|secure|guarantee)/i);
      // Sentence case: no word after the first is capitalised unless it is a name.
      expect(v.label).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    }
    expect(ATTESTATION_LIMIT).toBe("An attestation shows which enclave signed the request and the answer. It does not show that the answer is correct.");
  });
});

describe("keys and hashes inside a sentence", () => {
  it("are split out whole, so each can stay on one line", () => {
    const hash = "ab".repeat(32);
    expect(splitIds(`Not verified: the signer ${KEY} matches no report.`)).toEqual([
      { text: "Not verified: the signer ", id: false },
      { text: KEY, id: true },
      { text: " matches no report.", id: false },
    ]);
    expect(splitIds(`${hash} and ${KEY}`)).toEqual([
      { text: hash, id: true },
      { text: " and ", id: false },
      { text: KEY, id: true },
    ]);
    // Shorter or longer runs of hex are left as words.
    expect(splitIds("nonce 0x1234 and deadbeef")).toEqual([{ text: "nonce 0x1234 and deadbeef", id: false }]);
    expect(splitIds(`${hash}ab`)).toEqual([{ text: `${hash}ab`, id: false }]);
    expect(splitIds("")).toEqual([]);
  });
});

describe("the attestation on a timeline step", () => {
  const ev = (seq: number, data: Record<string, unknown>): AgentRunEvent => ({ seq, type: "model_turn", data, at: new Date(Date.UTC(2026, 10, 1, 10, 0, seq)).toISOString() });

  it("reads the node's check ids and drops anything that is not one", () => {
    const steps = timelineSteps([ev(1, { turn: 1, stop: "end", attestation: { status: "failed", summary: "Not verified.", failed: ["signature_available", 7, ""], not_verified: "none", signature_kind: null, signer: null } })]);
    expect(steps[0]).toMatchObject({ kind: "model", attestation: { status: "failed", failed: ["signature_available"], notVerified: [], signatureKind: null, signer: null } });
  });
});
