import { describe, expect, it } from "vitest";
import { generateKeypair, publicKeyToString } from "@payminto/chain";
import { agentKeyProblem, isAgentKey } from "@/lib/sign";

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

// The shared vectors in packages/chain/vectors/signatures.json (audit F3).
const SMALL_ORDER_8 = publicKeyToString(hexToBytes("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"));
const ALL_ZERO = publicKeyToString(new Uint8Array(32));
const NON_CANONICAL = publicKeyToString(hexToBytes("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"));

describe("agentKeyProblem: the New Budget form's check of the agent key", () => {
  it("accepts a real agent key", () => {
    const key = generateKeypair().publicKey;
    expect(agentKeyProblem(key)).toBeNull();
    expect(agentKeyProblem(`  ${key} `)).toBeNull();
    expect(isAgentKey(key)).toBe(true);
  });

  it("asks for a key in the NEAR text form", () => {
    expect(agentKeyProblem("")).toBe("Enter the agent public key (ed25519: followed by base58).");
    expect(agentKeyProblem("ed25519:not-base58!")).toBe("Enter the agent public key (ed25519: followed by base58).");
  });

  it("refuses a small-order key, which anyone could sign for", () => {
    for (const key of [SMALL_ORDER_8, ALL_ZERO]) {
      expect(agentKeyProblem(key)).toBe("This key is unsafe: anyone could sign Calls with it. Make a new key with payminto-agent keygen.");
      expect(isAgentKey(key)).toBe(false);
    }
  });

  it("refuses a key that is not in its one standard encoding", () => {
    expect(agentKeyProblem(NON_CANONICAL)).toBe("This key is not in its standard form, so the hub would not treat it as one key. Make a new key with payminto-agent keygen.");
    expect(isAgentKey(NON_CANONICAL)).toBe(false);
  });

  it("refuses 32 bytes that are not a key at all", () => {
    const offCurve = new Uint8Array(32);
    offCurve[0] = 2;
    expect(agentKeyProblem(publicKeyToString(offCurve))).toBe("This is not a valid ed25519 public key. Copy it again from payminto-agent keygen.");
  });

  it("never uses an em dash", () => {
    for (const k of ["", SMALL_ORDER_8, NON_CANONICAL]) expect(agentKeyProblem(k) ?? "").not.toMatch(/—/);
  });
});
