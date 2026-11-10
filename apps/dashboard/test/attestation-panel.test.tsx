import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RunTimeline } from "@/components/agents/run-timeline";
import type { AgentRunEvent } from "@/lib/schemas";

const KEY = "0xc63e0e2fb427041e861b5e4a670908b943626d1f";
const REQUEST = "e5".repeat(32);
const ANSWER = "82".repeat(32);
const SUMMARY = `This answer was signed by the model enclave key ${KEY} for z-ai/glm-5.3-flash, a key bound to an Intel TDX quote that was checked before the request. Not verified here: the model enclave report is only partly verified; not checked in this process: Intel's TCB status of the platform, NVIDIA's verdict on the GPU evidence, whether the measured software is on an accepted list.`;

const partial = { status: "partially_verified", summary: SUMMARY, passed: ["signed_text"], failed: [], not_verified: ["enclave_attestation"], request_hash: REQUEST, response_hash: ANSWER, signature_kind: "provider_tee", signer: KEY, bound_to: "model_enclave" };
const noSignature = { status: "failed", summary: "Not verified: no signature available, so the answer is unverified (no signature was recorded for this completion (404)).", passed: [], failed: ["signature_available"], not_verified: [], request_hash: REQUEST, response_hash: ANSWER, signature_kind: null, signer: null, bound_to: null };
const STRANGER = "0xcaa8d6d83b35db2eef7e903d587a5fb9244762d0";
const wrongKey = { status: "failed", summary: `Not verified: the signer ${STRANGER} matches no model enclave report of the preflight attestation: the signature comes from another key.`, passed: ["signed_text"], failed: ["signer_attested", "model_binding"], not_verified: [], request_hash: REQUEST, response_hash: ANSWER, signature_kind: "provider_tee", signer: STRANGER, bound_to: null };

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): AgentRunEvent => ({ seq, type, data, at: new Date(Date.UTC(2026, 10, 1, 10, 0, seq)).toISOString() });
const turn = (seq: number, stop: string, attestation?: Record<string, unknown>) => ev(seq, "model_turn", { turn: seq, stop, model: "z-ai/glm-5.3-flash", input_tokens: 10, output_tokens: 2, ...(attestation ? { attestation } : {}) });
const panels = () => screen.getAllByRole("group", { name: "Enclave attestation" });

describe("the attestation of a model turn in the run timeline", () => {
  it("shows a partial result in words, with the newest turn's evidence open and earlier ones folded", () => {
    render(<RunTimeline status="succeeded" events={[ev(1, "started"), turn(2, "tool_use", partial), turn(3, "end", partial), ev(4, "finished", { status: "succeeded" })]} />);
    const [first, last] = panels();
    expect(within(first!).getByText("Partially verified")).toBeInTheDocument();
    expect(within(first!).getByText(/This is the normal result\.$/)).toBeInTheDocument();
    expect(within(first!).getByRole("button", { name: "Show attestation details" })).toHaveAttribute("aria-expanded", "false");
    expect(within(first!).queryByText("Not checked")).toBeNull();

    const open = within(last!);
    expect(open.getByRole("button", { name: "Hide attestation details" })).toHaveAttribute("aria-expanded", "true");
    expect(open.getByText("Signed by")).toBeInTheDocument();
    expect(open.getByText("The model enclave")).toBeInTheDocument();
    // The whole key is in the title and the copy action, however the middle is cut on screen.
    expect(open.getByTitle(KEY)).toBeInTheDocument();
    expect(open.getByRole("button", { name: "Copy signing key" })).toBeInTheDocument();
    expect(open.getByText("Checked")).toBeInTheDocument();
    expect(open.getByText("The signature is valid and covers the exact request sent and the answer received")).toBeInTheDocument();
    expect(open.getByText("Not checked")).toBeInTheDocument();
    expect(open.getByText("Whether NVIDIA accepts the evidence from the GPU")).toBeInTheDocument();
    expect(open.getByTitle(REQUEST)).toBeInTheDocument();
    expect(open.getByRole("button", { name: "Copy answer hash" })).toBeInTheDocument();
    expect(open.getByText("An attestation shows which enclave signed the request and the answer. It does not show that the answer is correct.")).toBeInTheDocument();
    // A partial result is never drawn in the colour of a settled one.
    expect(open.getByText("Partially verified").className).not.toMatch(/positive/);

    fireEvent.click(within(first!).getByRole("button", { name: "Show attestation details" }));
    expect(within(first!).getByText("Not checked")).toBeInTheDocument();
    fireEvent.click(open.getByRole("button", { name: "Hide attestation details" }));
    expect(open.queryByText("Signed by")).toBeNull();
  });

  it("says a missing signature could not be checked, what to do, and shows no signer", () => {
    render(<RunTimeline status="succeeded" events={[turn(1, "end", noSignature)]} />);
    const p = within(panels()[0]!);
    expect(p.getByText("Could not be checked")).toBeInTheDocument();
    expect(p.getByText("NEAR AI Cloud returned no signature for this answer, so nothing could be checked. The answer was still delivered and is unverified.")).toBeInTheDocument();
    expect(p.getByText(/^Run the agent again to get a signed answer\./)).toBeInTheDocument();
    expect(p.getByText("Node's note")).toBeInTheDocument();
    expect(p.queryByText("Signed by")).toBeNull();
    expect(p.queryByText("Request hash")).toBeNull();
    // Nothing to fold: a result that needs attention is always shown in full.
    expect(p.queryByRole("button", { name: /attestation details/ })).toBeNull();
  });

  it("says which check failed and names the key without calling it an enclave's", () => {
    render(<RunTimeline status="succeeded" events={[turn(1, "end", wrongKey)]} />);
    const p = within(panels()[0]!);
    expect(p.getByText("Verification failed")).toBeInTheDocument();
    expect(p.getByText("Did not pass")).toBeInTheDocument();
    expect(p.getByText("The signing key is not the key of an enclave your node checked before the request.")).toBeInTheDocument();
    expect(p.getByText("Key in the signature")).toBeInTheDocument();
    expect(p.queryByText("Signed by")).toBeNull();
    expect(p.getByText(/^Run the agent again for a fresh check\./)).toBeInTheDocument();
    // The key is set whole on one line both in its own row and inside the node's sentence.
    expect(p.getAllByTitle(STRANGER)).toHaveLength(2);
    expect(p.getByText(/matches no model enclave report/)).toBeInTheDocument();
  });

  it("says a turn without an attestation was not checked", () => {
    render(<RunTimeline status="succeeded" events={[turn(1, "end")]} />);
    expect(screen.getByText("No attestation.")).toBeInTheDocument();
    expect(screen.getByText(/Only agents on a NEAR AI Cloud connection get an attestation\./)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Enclave attestation" })).toBeNull();
  });

  it("keeps to one line under the ask box and stays quiet about turns without an attestation", () => {
    render(<RunTimeline compact status="succeeded" events={[turn(1, "tool_use", partial), turn(2, "tool_use", noSignature), turn(3, "end")]} />);
    expect(screen.getByText("Attestation partially verified, signed by the model enclave")).toBeInTheDocument();
    expect(screen.getByText("Attestation could not be checked")).toBeInTheDocument();
    expect(screen.queryByText("No attestation.")).toBeNull();
    expect(screen.queryByRole("group", { name: "Enclave attestation" })).toBeNull();
  });
});
