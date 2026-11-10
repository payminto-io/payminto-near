import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptanceDigest, budgetTermsFromJson, budgetTermsToJson, canonicalPolicy, decodeHeader, encodeHeader, formatAmount, keypairFromSeed, networkFor, nodeDigest, policyHash, sha256Text, toAtomic, voucherCallId } from "../src/index.ts";

type AcceptanceCase = { name: string; input: { budget_id: string; payee: string; amount: string; cumulative: string; request_hash: string; timestamp_s: string; voucher_sig: string }; call_id: string; text: string; digest_hex: string };
/** The vectors the hub contract, the chain package and every digest test share. */
const acceptanceCases = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "chain", "vectors", "acceptance.json"), "utf8")) as { cases: AcceptanceCase[] }).cases;
const attestationOf = (c: AcceptanceCase) => ({
  callId: c.call_id,
  budgetId: c.input.budget_id,
  payee: c.input.payee,
  amount: BigInt(c.input.amount),
  cumulative: BigInt(c.input.cumulative),
  requestHash: c.input.request_hash,
  timestamp: BigInt(c.input.timestamp_s),
  voucherSig: c.input.voucher_sig,
});

describe("policy", () => {
  it("hashes a canonical, key-ordered encoding", () => {
    const a = { purpose: "x", perCallCap: "1", maxCallsPerMinute: 2, dailyCap: "3" };
    const b = { dailyCap: "3", maxCallsPerMinute: 2, perCallCap: "1", purpose: "x" };
    expect(canonicalPolicy(a)).toBe(canonicalPolicy(b));
    expect(policyHash(a)).toBe(policyHash(b));
    expect(policyHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("helpers", () => {
  it("formats and parses atomic amounts without floats", () => {
    expect(formatAmount(1_500_000n)).toBe("1.50");
    expect(formatAmount(10_000n)).toBe("0.01");
    expect(formatAmount(1_234n)).toBe("0.001234");
    expect(formatAmount(0n)).toBe("0.00");
    expect(toAtomic("1.5")).toBe(1_500_000n);
    expect(toAtomic("0.000001")).toBe(1n);
    expect(() => toAtomic("0.0000001")).toThrow(/decimals/);
    expect(() => toAtomic("1e3")).toThrow();
  });

  it("round-trips x402 headers", () => {
    expect(decodeHeader(encodeHeader({ a: 1, s: "é" }))).toEqual({ a: 1, s: "é" });
    expect(decodeHeader("not-base64-json")).toBeNull();
  });

  it("round-trips Budget terms through JSON", () => {
    const t = { owner: "a.testnet", agentPk: keypairFromSeed(new Uint8Array(32).fill(1)).publicKey, settler: "n.testnet", cap: 2n ** 100n, validUntil: 1n, payees: ["s.testnet"], policyHash: "aa".repeat(32), salt: "bb".repeat(32) };
    const j = budgetTermsToJson(t);
    expect(j.cap).toBe((2n ** 100n).toString());
    expect(budgetTermsFromJson(JSON.parse(JSON.stringify(j)))).toEqual(t);
  });

  it("binds every attested field into the node digest", () => {
    const a = { callId: "01".repeat(32), budgetId: "02".repeat(32), payee: "s.testnet", amount: 1n, cumulative: 2n, requestHash: "03".repeat(32), timestamp: 4n, voucherSig: "05".repeat(64) };
    expect(nodeDigest({ ...a, timestamp: 5n })).not.toBe(nodeDigest(a));
    expect(nodeDigest({ ...a, amount: 2n })).not.toBe(nodeDigest(a));
  });

  it("the node digest is the chain package's acceptance digest, byte for byte, on every shared vector", () => {
    expect(acceptanceCases.length).toBeGreaterThanOrEqual(4);
    for (const c of acceptanceCases) {
      const a = attestationOf(c);
      expect(nodeDigest(a), c.name).toBe(c.digest_hex);
      expect(nodeDigest(a), c.name).toBe(acceptanceDigest({ budgetId: a.budgetId, payee: a.payee, amount: a.amount, cumulative: a.cumulative, requestHash: a.requestHash, signature: a.voucherSig }, a.timestamp));
    }
  });

  it("the node digest has no text layout of its own: an attestation of a real call goes through acceptanceDigest", () => {
    // The text layout lives in @payminto/chain. A second copy here could drift from what the hub rebuilds in settle_own.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hub.ts"), "utf8");
    expect(source).not.toContain("payminto.accepted.v1");
    expect(source).toMatch(/acceptanceDigest\(/);
  });

  it("the node digest still names its call id: a receipt whose call id was changed gets another digest", () => {
    for (const c of acceptanceCases) {
      const a = attestationOf(c);
      const other = sha256Text(`not the call id of ${c.name}`);
      const fields = c.text.split("|");
      expect(fields[1]).toBe(voucherCallId(a));
      fields[1] = other;
      // The same nine fields in the same order, with the id the attestation names in the second place.
      expect(nodeDigest({ ...a, callId: other })).toBe(sha256Text(fields.join("|")));
      expect(nodeDigest({ ...a, callId: other })).not.toBe(c.digest_hex);
    }
    expect(() => nodeDigest({ ...attestationOf(acceptanceCases[0]!), callId: "not-an-id|x" })).toThrow(/callId/);
  });

  it("knows testnet and sandbox, and has no mainnet node mode", () => {
    expect(networkFor("near:testnet").token.address).toBe("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af");
    expect(() => networkFor("near:mainnet")).toThrow(/Unsupported/);
  });
});
