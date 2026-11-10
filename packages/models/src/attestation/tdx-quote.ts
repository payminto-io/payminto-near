/**
 * Intel TDX quote, version 4 (ECDSA-256 with P-256): the parser and the part of DCAP verification that needs no
 * network and no collateral. Sources and layout: packages/models/SOURCES.md, section "TDX quote layout".
 *
 * What `verifyTdxQuoteLocally` checks, with node:crypto only:
 *   1. the quote signature over the header and the TD report, made by the attestation key in the quote;
 *   2. that the quoting enclave (QE) report commits to that attestation key (its report data);
 *   3. the QE report signature, made by the PCK leaf certificate in the quote;
 *   4. the PCK certificate chain up to the Intel SGX Root CA pinned in this file, and its validity at `now`;
 *   5. that the QE is Intel's TD quoting enclave by signer (MRSIGNER and product id pinned in this file).
 *
 * What it does NOT check (it needs signed collateral from Intel's PCS or a PCCS, fetched over the network):
 *   - the TCB status of the platform and of the TDX module (UpToDate, OutOfDate, Revoked and so on);
 *   - the QE's TCB level against Intel's current QE identity (only its signer is checked here);
 *   - certificate revocation lists for the PCK chain.
 * A caller that needs those plugs a full DCAP verifier into `verifyNearAiAttestation` (the `quoteVerifier` option).
 */
import { X509Certificate, createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Intel SGX Root CA, the trust anchor of every PCK certificate chain. Fetched on 2026-11-10 from
 * https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem
 * (SHA-256 fingerprint 44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3,
 * valid until 2049-12-31).
 */
export const INTEL_SGX_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIw
aDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENv
cnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJ
BgNVBAYTAlVTMB4XDTE4MDUyMTEwNDUxMFoXDTQ5MTIzMTIzNTk1OVowaDEaMBgG
A1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0
aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYT
AlVTMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi7
1OiOSLRFhWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxFP2sJBK5zlKOB
uzCBuDAfBgNVHSMEGDAWgBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJ
MEegRaBDhkFodHRwczovL2NlcnRpZmljYXRlcy50cnVzdGVkc2VydmljZXMuaW50
ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4EFgQUImUM1lqdNInzg7SV
Ur9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwCgYI
KoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9CiSDcNoowLuPRLsWGf/Yi7GSX94BgwTwg
AiEA4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=
-----END CERTIFICATE-----
`;

/**
 * MRSIGNER and product id of Intel's TD quoting enclave, from Intel's signed QE identity
 * (GET https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity, read on 2026-11-10: id TD_QE,
 * isvprodid 2). Pinned here; the identity's TCB levels are not evaluated locally.
 */
export const INTEL_TD_QE_MRSIGNER = "dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5";
export const INTEL_TD_QE_ISVPRODID = 2;
/** The QE vendor id of Intel's quoting enclave, as it appears in the quote header. */
export const INTEL_QE_VENDOR_ID = "939a7233f79c4ca9940a0db3957f0607";

const HEADER_LEN = 48;
const TD10_BODY_LEN = 584;
const SIGNED_LEN = HEADER_LEN + TD10_BODY_LEN;
const QE_REPORT_LEN = 384;
const TEE_TYPE_TDX = 0x81;
const ATT_KEY_TYPE_ECDSA_P256 = 2;
const CERT_TYPE_PCK_CHAIN = 5;
const CERT_TYPE_QE_REPORT = 6;

export class TdxQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdxQuoteError";
  }
}

/** The TD report (TD 1.0 body) of a quote. Every field is lowercase hex. */
export type TdReport = {
  teeTcbSvn: string;
  mrSeam: string;
  mrSignerSeam: string;
  seamAttributes: string;
  tdAttributes: string;
  xfam: string;
  mrTd: string;
  mrConfigId: string;
  mrOwner: string;
  mrOwnerConfig: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
  reportData: string;
};

export type TdxQuote = {
  version: number;
  teeType: number;
  qeVendorId: string;
  report: TdReport;
  /** Header and TD report: the bytes the attestation key signed. */
  signedBytes: Uint8Array;
  /** r and s, 32 bytes each. */
  signature: Uint8Array;
  /** The attestation public key: x and y, 32 bytes each. */
  attestationKey: Uint8Array;
  qeReport: Uint8Array;
  qeReportSignature: Uint8Array;
  qeAuthData: Uint8Array;
  qe: { mrSigner: string; isvProdId: number; isvSvn: number; reportData: string };
  /** PEM certificates as they appear in the quote: PCK leaf first. */
  pckChainPem: string[];
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class Reader {
  readonly #b: Buffer;
  #p = 0;
  constructor(b: Uint8Array, start = 0) {
    this.#b = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    this.#p = start;
  }
  #need(n: number, what: string) {
    if (n < 0 || this.#p + n > this.#b.length) throw new TdxQuoteError(`quote is truncated at ${what} (needs ${n} bytes at offset ${this.#p}, has ${this.#b.length})`);
  }
  bytes(n: number, what: string): Buffer {
    this.#need(n, what);
    const out = this.#b.subarray(this.#p, this.#p + n);
    this.#p += n;
    return out;
  }
  u16(what: string): number {
    return this.bytes(2, what).readUInt16LE(0);
  }
  u32(what: string): number {
    return this.bytes(4, what).readUInt32LE(0);
  }
}

/** Parses a version 4 TDX quote. Throws TdxQuoteError for anything else (SGX quotes, version 5, truncated input). */
export function parseTdxQuote(bytes: Uint8Array): TdxQuote {
  const r = new Reader(bytes);
  const version = r.u16("version");
  const attKeyType = r.u16("attestation key type");
  const teeType = r.u32("TEE type");
  r.bytes(4, "reserved");
  const qeVendorId = hex(r.bytes(16, "QE vendor id"));
  r.bytes(20, "user data");
  if (version !== 4) throw new TdxQuoteError(`unsupported quote version ${version}; only version 4 is supported`);
  if (teeType !== TEE_TYPE_TDX) throw new TdxQuoteError(`not a TDX quote (TEE type 0x${teeType.toString(16)})`);
  if (attKeyType !== ATT_KEY_TYPE_ECDSA_P256) throw new TdxQuoteError(`unsupported attestation key type ${attKeyType}; only ECDSA P-256 is supported`);

  const f = (n: number, what: string) => hex(r.bytes(n, what));
  const report: TdReport = {
    teeTcbSvn: f(16, "TEE TCB SVN"),
    mrSeam: f(48, "MRSEAM"),
    mrSignerSeam: f(48, "MRSIGNERSEAM"),
    seamAttributes: f(8, "SEAM attributes"),
    tdAttributes: f(8, "TD attributes"),
    xfam: f(8, "XFAM"),
    mrTd: f(48, "MRTD"),
    mrConfigId: f(48, "MRCONFIGID"),
    mrOwner: f(48, "MROWNER"),
    mrOwnerConfig: f(48, "MROWNERCONFIG"),
    rtMr0: f(48, "RTMR0"),
    rtMr1: f(48, "RTMR1"),
    rtMr2: f(48, "RTMR2"),
    rtMr3: f(48, "RTMR3"),
    reportData: f(64, "report data"),
  };

  const sigLen = r.u32("signature data length");
  const sigData = new Reader(r.bytes(sigLen, "signature data"));
  const signature = sigData.bytes(64, "quote signature");
  const attestationKey = sigData.bytes(64, "attestation key");
  const outerType = sigData.u16("certification data type");
  const outerSize = sigData.u32("certification data size");
  if (outerType !== CERT_TYPE_QE_REPORT) throw new TdxQuoteError(`unsupported certification data type ${outerType}; expected the QE report type ${CERT_TYPE_QE_REPORT}`);
  const outer = new Reader(sigData.bytes(outerSize, "certification data"));
  const qeReport = outer.bytes(QE_REPORT_LEN, "QE report");
  const qeReportSignature = outer.bytes(64, "QE report signature");
  const qeAuthData = outer.bytes(outer.u16("QE authentication data length"), "QE authentication data");
  const innerType = outer.u16("PCK certification data type");
  const innerSize = outer.u32("PCK certification data size");
  if (innerType !== CERT_TYPE_PCK_CHAIN) throw new TdxQuoteError(`unsupported PCK certification data type ${innerType}; expected a PEM certificate chain (type ${CERT_TYPE_PCK_CHAIN})`);
  const pem = outer.bytes(innerSize, "PCK certificate chain").toString("latin1");
  const pckChainPem = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (pckChainPem.length < 2) throw new TdxQuoteError(`the quote carries ${pckChainPem.length} PCK certificates; a leaf and an intermediate are needed`);

  return {
    version,
    teeType,
    qeVendorId,
    report,
    signedBytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(0, SIGNED_LEN),
    signature,
    attestationKey,
    qeReport,
    qeReportSignature,
    qeAuthData,
    qe: { mrSigner: hex(qeReport.subarray(128, 160)), isvProdId: qeReport.readUInt16LE(256), isvSvn: qeReport.readUInt16LE(258), reportData: hex(qeReport.subarray(320, 384)) },
    pckChainPem,
  };
}

export type LocalCheck = { ok: boolean; detail: string };

export type TdxLocalVerification = {
  /** Checks 1 to 3 of the file header: the quote is signed by a key the QE vouches for, and the PCK key signed the QE report. */
  quoteSignature: LocalCheck;
  /** Check 4: the PCK chain ends at the pinned Intel SGX Root CA and is inside its validity window. */
  pckChain: LocalCheck;
  /** Check 5: the QE is Intel's TD quoting enclave by signer. */
  qeIdentity: LocalCheck;
  /** True when all three hold: the TD report in the quote can be read as genuine, subject to the unchecked TCB status. */
  ok: boolean;
  pck: { subject: string; issuer: string; validFrom: string; validTo: string } | null;
};

function p256Key(raw: Uint8Array): KeyObject {
  const b = Buffer.from(raw);
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: b.subarray(0, 32).toString("base64url"), y: b.subarray(32, 64).toString("base64url") }, format: "jwk" });
}

function p256Verify(data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean {
  try {
    return verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

function oneLine(name: string): string {
  return name.split("\n").join(", ");
}

/**
 * The offline part of quote verification (see the file header for what it covers and what it leaves out).
 * Never throws: a malformed key or certificate is a failed check.
 */
export function verifyTdxQuoteLocally(q: TdxQuote, o: { now?: Date; rootCaPem?: string } = {}): TdxLocalVerification {
  const now = o.now ?? new Date();

  // 1 to 3: quote signature, QE binding of the attestation key, QE report signature.
  const quoteSignature = ((): LocalCheck => {
    let attKey: KeyObject;
    try {
      attKey = p256Key(q.attestationKey);
    } catch {
      return { ok: false, detail: "the attestation key in the quote is not a valid P-256 point" };
    }
    if (!p256Verify(q.signedBytes, attKey, q.signature)) return { ok: false, detail: "the quote signature does not verify over the header and TD report with the attestation key" };
    const committed = hex(createHash("sha256").update(q.attestationKey).update(q.qeAuthData).digest());
    if (committed !== q.qe.reportData.slice(0, 64)) return { ok: false, detail: "the QE report does not commit to the attestation key" };
    let leaf: X509Certificate;
    try {
      leaf = new X509Certificate(q.pckChainPem[0]!);
    } catch (err) {
      return { ok: false, detail: `the PCK leaf certificate does not parse: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!p256Verify(q.qeReport, leaf.publicKey, q.qeReportSignature)) return { ok: false, detail: "the QE report signature does not verify with the PCK certificate key" };
    return { ok: true, detail: "quote signed by the attestation key, which the QE report commits to; QE report signed by the PCK certificate key" };
  })();

  // 4: PCK chain to the pinned root.
  let pckChain: LocalCheck;
  let pck: TdxLocalVerification["pck"] = null;
  try {
    const root = new X509Certificate(o.rootCaPem ?? INTEL_SGX_ROOT_CA_PEM);
    const leafCert = new X509Certificate(q.pckChainPem[0]!);
    const intermediate = new X509Certificate(q.pckChainPem[1]!);
    pck = { subject: oneLine(leafCert.subject), issuer: oneLine(leafCert.issuer), validFrom: leafCert.validFromDate.toISOString(), validTo: leafCert.validToDate.toISOString() };
    const expired = [leafCert, intermediate, root].find((c) => now < c.validFromDate || now > c.validToDate);
    if (!intermediate.ca) pckChain = { ok: false, detail: "the PCK issuer certificate is not a CA" };
    else if (!leafCert.checkIssued(intermediate) || !leafCert.verify(intermediate.publicKey)) pckChain = { ok: false, detail: "the PCK certificate is not signed by the intermediate certificate in the quote" };
    else if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) pckChain = { ok: false, detail: "the PCK chain does not end at the pinned Intel SGX Root CA" };
    else if (expired) pckChain = { ok: false, detail: `a certificate of the PCK chain is outside its validity window at ${now.toISOString()} (${oneLine(expired.subject)}, ${expired.validFromDate.toISOString()} to ${expired.validToDate.toISOString()})` };
    else pckChain = { ok: true, detail: `${oneLine(leafCert.subject)} issued by ${oneLine(leafCert.issuer)}, chained to the pinned Intel SGX Root CA; revocation lists not checked` };
  } catch (err) {
    pckChain = { ok: false, detail: `the PCK certificate chain does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 5: the QE is Intel's.
  let qeIdentity: LocalCheck;
  if (q.qeVendorId !== INTEL_QE_VENDOR_ID) qeIdentity = { ok: false, detail: `QE vendor id ${q.qeVendorId} is not Intel's` };
  else if (q.qe.mrSigner !== INTEL_TD_QE_MRSIGNER) qeIdentity = { ok: false, detail: `QE MRSIGNER ${q.qe.mrSigner} is not Intel's TD quoting enclave signer` };
  else if (q.qe.isvProdId !== INTEL_TD_QE_ISVPRODID) qeIdentity = { ok: false, detail: `QE product id ${q.qe.isvProdId} is not the TD quoting enclave (${INTEL_TD_QE_ISVPRODID})` };
  else qeIdentity = { ok: true, detail: `QE signer and product id match Intel's TD quoting enclave (pinned); QE ISVSVN ${q.qe.isvSvn} not compared with Intel's current QE identity` };

  return { quoteSignature, pckChain, qeIdentity, ok: quoteSignature.ok && pckChain.ok && qeIdentity.ok, pck };
}
