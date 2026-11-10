/**
 * The TDX quote parser and the offline signature-chain check, against two real quotes recorded from NEAR AI Cloud
 * (the gateway's and a model enclave's) and against tampered copies of them. No network.
 */
import { describe, expect, it } from "vitest";
import { INTEL_TD_QE_MRSIGNER, TdxQuoteError, parseTdxQuote, verifyTdxQuoteLocally } from "../src/attestation/tdx-quote.ts";
import { LIVE_NONCE, LIVE_NOW, flipHex, liveReport } from "./nearai-fixtures.ts";

const quoteHex = (which: "gateway" | "model") => (which === "gateway" ? liveReport().gateway_attestation.intel_quote : liveReport().model_attestations[0]!.intel_quote) as string;
const bytes = (hex: string) => Buffer.from(hex, "hex");

// Offsets in the quote, as hex digit positions: 48-byte header, then the TD report.
const BODY = 48 * 2;
const AT = { tdAttributes: BODY + 120 * 2, mrConfigId: BODY + 184 * 2, reportData: BODY + 520 * 2, signature: (48 + 584 + 4) * 2, qeReport: (48 + 584 + 4 + 64 + 64 + 6) * 2 };

describe("TDX quote (live recordings)", () => {
  for (const which of ["gateway", "model"] as const) {
    it(`parses the ${which} quote and verifies its signature chain to Intel's root`, () => {
      const q = parseTdxQuote(bytes(quoteHex(which)));
      expect([q.version, q.teeType, q.qeVendorId]).toEqual([4, 0x81, "939a7233f79c4ca9940a0db3957f0607"]);
      expect(q.report.reportData.slice(64)).toBe(LIVE_NONCE);
      expect(q.report.mrConfigId).toMatch(/^01[0-9a-f]{64}0{30}$/);
      expect(q.report.tdAttributes).toBe("0000001000000000");
      expect(q.qe).toMatchObject({ mrSigner: INTEL_TD_QE_MRSIGNER, isvProdId: 2 });
      expect(q.pckChainPem).toHaveLength(3);

      const v = verifyTdxQuoteLocally(q, { now: LIVE_NOW });
      expect(v).toMatchObject({ ok: true, quoteSignature: { ok: true }, pckChain: { ok: true }, qeIdentity: { ok: true } });
      expect(v.pck?.subject).toMatch(/Intel SGX PCK Certificate/);
      expect(v.pckChain.detail).toMatch(/revocation lists not checked/);
    });
  }

  it("reads the measurements the report repeats in its HTTP fields", () => {
    const q = parseTdxQuote(bytes(quoteHex("gateway")));
    const g = liveReport().gateway_attestation;
    expect(q.report.reportData).toBe(g.report_data);
    expect(q.report.reportData.slice(0, 40)).toBe(g.signing_address.slice(2));
  });
});

describe("TDX quote (tampered)", () => {
  const check = (hex: string, now = LIVE_NOW, rootCaPem?: string) => verifyTdxQuoteLocally(parseTdxQuote(bytes(hex)), { now, rootCaPem });

  it("rejects a changed TD report: report data, configuration or attributes", () => {
    for (const at of [AT.reportData, AT.reportData + 70, AT.mrConfigId + 10, AT.tdAttributes + 1]) {
      const v = check(flipHex(quoteHex("model"), at));
      expect(v.ok).toBe(false);
      expect(v.quoteSignature).toMatchObject({ ok: false, detail: expect.stringMatching(/quote signature does not verify/) });
    }
  });

  it("rejects a changed quote signature and a changed QE report", () => {
    expect(check(flipHex(quoteHex("gateway"), AT.signature + 5)).quoteSignature.ok).toBe(false);
    const qe = check(flipHex(quoteHex("gateway"), AT.qeReport + 10));
    expect(qe.quoteSignature).toMatchObject({ ok: false, detail: expect.stringMatching(/QE report signature does not verify/) });
    // The QE's signer field: both the signature over the QE report and the identity check fail.
    const signer = check(flipHex(quoteHex("gateway"), AT.qeReport + 128 * 2));
    expect([signer.quoteSignature.ok, signer.qeIdentity.ok]).toEqual([false, false]);
    expect(signer.qeIdentity.detail).toMatch(/not Intel's TD quoting enclave signer/);
  });

  it("rejects a chain that does not end at the pinned Intel root", () => {
    const q = parseTdxQuote(bytes(quoteHex("gateway")));
    // The intermediate certificate stands in for "some other root": the chain no longer ends at the trust anchor.
    const v = verifyTdxQuoteLocally(q, { now: LIVE_NOW, rootCaPem: q.pckChainPem[1]! });
    expect(v.pckChain).toMatchObject({ ok: false, detail: expect.stringMatching(/does not end at the pinned Intel SGX Root CA/) });
    expect(v.ok).toBe(false);
  });

  it("rejects certificates outside their validity window", () => {
    expect(check(quoteHex("gateway"), new Date("2020-01-01T00:00:00Z")).pckChain).toMatchObject({ ok: false, detail: expect.stringMatching(/outside its validity window/) });
    expect(check(quoteHex("gateway"), new Date("2040-01-01T00:00:00Z")).pckChain.ok).toBe(false);
  });

  it("refuses input that is not a version 4 TDX quote", () => {
    const hex = quoteHex("gateway");
    expect(() => parseTdxQuote(bytes(hex.slice(0, 400)))).toThrow(TdxQuoteError);
    expect(() => parseTdxQuote(bytes(hex.slice(0, 3000)))).toThrow(/truncated/);
    expect(() => parseTdxQuote(bytes(`0300${hex.slice(4)}`))).toThrow(/unsupported quote version 3/);
    expect(() => parseTdxQuote(bytes(`${hex.slice(0, 8)}00000000${hex.slice(16)}`))).toThrow(/not a TDX quote/);
    expect(() => parseTdxQuote(new Uint8Array(0))).toThrow(TdxQuoteError);
  });
});
