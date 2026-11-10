// Every byte layout below is written by hand with Buffer and node:crypto, so these tests do not depend on the borsh or
// noble libraries the package uses. A library behaviour change would fail here before it reached the Rust contract.
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUDGET_DOMAIN,
  CHECKOUT_DOMAIN,
  CHECKOUT_TAG,
  VOUCHER_DOMAIN,
  VOUCHER_TAG,
  acceptanceDigest,
  acceptanceInTime,
  acceptanceLimitMs,
  acceptancePreimage,
  acceptanceSignedFor,
  budgetIdOf,
  budgetPreimage,
  canonicalPayees,
  checkoutDigest,
  checkoutPreimage,
  keypairFromSeed,
  publicKeyBytes,
  publicKeyToString,
  sha256Text,
  signAcceptance,
  signDigest,
  toHex,
  verifyDigest,
  voucherCallId,
  voucherDigest,
  voucherPreimage,
  type BudgetTerms,
  type Claim,
  type Voucher,
} from "../src/index.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const str = (s: string) => {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u128 = (n: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
};
const b32 = (h: string) => Buffer.from(h, "hex");

const HUB = "hub.payminto.testnet";
const NET = "near:testnet" as const;
const BUDGET_ID = "11".repeat(32);
const REQ = "22".repeat(32);
const seed = new Uint8Array(32).fill(7);

describe("voucher digest", () => {
  const v: Voucher = { budgetId: BUDGET_ID, payee: "api.seller.testnet", amount: 1500n, cumulative: 2n ** 100n, requestHash: REQ };
  const expected = Buffer.concat([
    u32(VOUCHER_TAG),
    str(VOUCHER_DOMAIN),
    str(HUB),
    str(NET),
    b32(BUDGET_ID),
    str(v.payee),
    u128(v.amount),
    u128(v.cumulative),
    b32(REQ),
  ]);

  it("uses a tag at or above 2^31 that is not NEP-413", () => {
    expect(VOUCHER_TAG).toBeGreaterThanOrEqual(2 ** 31);
    expect(VOUCHER_TAG).toBeLessThan(2 ** 32);
    expect(VOUCHER_TAG).toBe(2147484000 + 20402);
    expect(VOUCHER_TAG).not.toBe(2 ** 31 + 413);
    expect(CHECKOUT_TAG).not.toBe(VOUCHER_TAG);
  });

  it("matches a hand-written Borsh layout", () => {
    expect(toHex(voucherPreimage(HUB, NET, v))).toBe(expected.toString("hex"));
    expect(voucherDigest(HUB, NET, v)).toBe(sha(expected));
  });

  it("binds every field", () => {
    const base = voucherDigest(HUB, NET, v);
    expect(voucherDigest("other.testnet", NET, v)).not.toBe(base);
    expect(voucherDigest(HUB, "near:sandbox", v)).not.toBe(base);
    expect(voucherDigest(HUB, NET, { ...v, budgetId: "33".repeat(32) })).not.toBe(base);
    expect(voucherDigest(HUB, NET, { ...v, payee: "x.testnet" })).not.toBe(base);
    expect(voucherDigest(HUB, NET, { ...v, amount: 1501n })).not.toBe(base);
    expect(voucherDigest(HUB, NET, { ...v, cumulative: 1n })).not.toBe(base);
    expect(voucherDigest(HUB, NET, { ...v, requestHash: "44".repeat(32) })).not.toBe(base);
  });

  it("refuses amounts outside u128 and malformed ids", () => {
    expect(() => voucherDigest(HUB, NET, { ...v, amount: -1n })).toThrow(/u128/);
    expect(() => voucherDigest(HUB, NET, { ...v, amount: 2n ** 128n })).toThrow(/u128/);
    expect(() => voucherDigest(HUB, NET, { ...v, budgetId: "0x" + BUDGET_ID })).toThrow(/Id32/);
    expect(() => voucherDigest(HUB, NET, { ...v, requestHash: "AB".repeat(32) })).toThrow(/Id32/);
  });
});

describe("budget id", () => {
  const kp = keypairFromSeed(seed);
  const terms: BudgetTerms = {
    owner: "acme.testnet",
    agentPk: kp.publicKey,
    settler: "node.testnet",
    cap: 5_000_000n,
    validUntil: 1_900_000_000_000n,
    payees: ["b.testnet", "a.testnet", "b.testnet"],
    policyHash: "aa".repeat(32),
    salt: "bb".repeat(32),
  };

  it("matches a hand-written Borsh layout with canonical payees", () => {
    const expected = Buffer.concat([
      str(BUDGET_DOMAIN),
      str(HUB),
      str(NET),
      str("acme.testnet"),
      Buffer.from(publicKeyBytes(kp.publicKey)),
      str("node.testnet"),
      u128(5_000_000n),
      u64(1_900_000_000_000n),
      u32(2),
      str("a.testnet"),
      str("b.testnet"),
      b32("aa".repeat(32)),
      b32("bb".repeat(32)),
    ]);
    expect(toHex(budgetPreimage(HUB, NET, terms))).toBe(expected.toString("hex"));
    expect(budgetIdOf(HUB, NET, terms)).toBe(sha(expected));
  });

  it("is order independent over payees, and changes with the agent key and settler", () => {
    const base = budgetIdOf(HUB, NET, terms);
    expect(budgetIdOf(HUB, NET, { ...terms, payees: ["a.testnet", "b.testnet"] })).toBe(base);
    const other = keypairFromSeed(new Uint8Array(32).fill(9));
    expect(budgetIdOf(HUB, NET, { ...terms, agentPk: other.publicKey })).not.toBe(base);
    expect(budgetIdOf(HUB, NET, { ...terms, settler: "other.testnet" })).not.toBe(base);
  });

  it("caps payees at 16", () => {
    const many = Array.from({ length: 17 }, (_, i) => `p${i}.testnet`);
    expect(() => canonicalPayees(many)).toThrow(/16/);
    expect(canonicalPayees(many.slice(0, 16))).toHaveLength(16);
  });
});

describe("checkout terms", () => {
  it("matches a hand-written Borsh layout", () => {
    const t = { paymentId: "cc".repeat(32), merchant: "shop.testnet", amount: 42n, expiryMs: 1_900_000_000_000n };
    const expected = Buffer.concat([u32(CHECKOUT_TAG), str(CHECKOUT_DOMAIN), str(HUB), str(NET), b32(t.paymentId), str(t.merchant), u128(t.amount), u64(t.expiryMs)]);
    expect(toHex(checkoutPreimage(HUB, NET, t))).toBe(expected.toString("hex"));
    expect(checkoutDigest(HUB, NET, t)).toBe(sha(expected));
  });
});

describe("ed25519", () => {
  it("signs the 32 digest bytes so node:crypto verifies them", () => {
    const kp = keypairFromSeed(seed);
    const digest = "ab".repeat(32);
    const sig = signDigest(kp.secretKey, digest);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyDigest(kp.publicKey, digest, sig)).toBe(true);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyBytes(kp.publicKey))]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    expect(verify(null, Buffer.from(digest, "hex"), key, Buffer.from(sig, "hex"))).toBe(true);
  });

  it("rejects another key, another digest and garbage without throwing", () => {
    const kp = keypairFromSeed(seed);
    const other = keypairFromSeed(new Uint8Array(32).fill(8));
    const digest = "ab".repeat(32);
    const sig = signDigest(kp.secretKey, digest);
    expect(verifyDigest(other.publicKey, digest, sig)).toBe(false);
    expect(verifyDigest(kp.publicKey, "cd".repeat(32), sig)).toBe(false);
    expect(verifyDigest(kp.publicKey, digest, "00".repeat(64))).toBe(false);
    expect(verifyDigest(kp.publicKey, digest, "zz")).toBe(false);
  });

  it("round trips the public key text form", () => {
    const kp = keypairFromSeed(seed);
    expect(kp.publicKey.startsWith("ed25519:")).toBe(true);
    expect(publicKeyToString(publicKeyBytes(kp.publicKey))).toBe(kp.publicKey);
  });
});

describe("the node's acceptance of a call", () => {
  const agent = keypairFromSeed(new Uint8Array(32).fill(7));
  const node = keypairFromSeed(new Uint8Array(32).fill(8));
  const voucher = { budgetId: "ab".repeat(32), payee: "seller.testnet", amount: 12n, cumulative: 34n, requestHash: "cd".repeat(32) };
  const claim: Claim = { ...voucher, signature: signDigest(agent.secretKey, voucherDigest("hub.testnet", "near:testnet", voucher)) };

  it("is sha256 of nine fields joined with |, with the call id derived from the voucher", () => {
    const callId = voucherCallId(claim);
    expect(callId).toBe(sha256Text(`payminto.call.v1|${claim.budgetId}|seller.testnet|34|${claim.requestHash}`));
    const text = acceptancePreimage(claim, 1_800_000_000n);
    expect(text).toBe(`payminto.accepted.v1|${callId}|${claim.budgetId}|seller.testnet|12|34|${claim.requestHash}|1800000000|${claim.signature}`);
    expect(text.split("|")).toHaveLength(9);
    expect(acceptanceDigest(claim, 1_800_000_000n)).toBe(sha256Text(text));
  });

  it("changes with every field, so one acceptance covers one call at one time", () => {
    const base = acceptanceDigest(claim, 5n);
    const variants: Array<[Claim, bigint]> = [
      [{ ...claim, budgetId: "ac".repeat(32) }, 5n],
      [{ ...claim, payee: "seller2.testnet" }, 5n],
      [{ ...claim, amount: 13n }, 5n],
      [{ ...claim, cumulative: 35n }, 5n],
      [{ ...claim, requestHash: "ce".repeat(32) }, 5n],
      [{ ...claim, signature: "00".repeat(64) }, 5n],
      [claim, 6n],
    ];
    const digests = new Set(variants.map(([c, t]) => acceptanceDigest(c, t)));
    expect(digests.size).toBe(variants.length);
    expect(digests.has(base)).toBe(false);
  });

  it("refuses any field that could make the text ambiguous", () => {
    // A separator inside a field, uppercase hex, or a negative number would give one call two texts or two calls one.
    expect(() => acceptanceDigest({ ...claim, payee: "a|b.testnet" }, 5n)).toThrow(/NEAR account id/);
    expect(() => acceptanceDigest({ ...claim, budgetId: "AB".repeat(32) }, 5n)).toThrow(/Id32/);
    expect(() => acceptanceDigest({ ...claim, requestHash: "cd".repeat(31) }, 5n)).toThrow(/Id32/);
    expect(() => acceptanceDigest({ ...claim, signature: "zz".repeat(64) }, 5n)).toThrow(/Sig64/);
    expect(() => acceptanceDigest({ ...claim, amount: -1n }, 5n)).toThrow(/u128/);
    expect(() => acceptanceDigest(claim, -1n)).toThrow(/u64/);
    expect(() => acceptanceDigest(claim, 2n ** 64n)).toThrow(/u64/);
  });

  it("signs and verifies, and tells a time inside the Budget's life from one after it", () => {
    const a = signAcceptance(node, claim, 1_800_000_000n);
    expect(a.nodeKey).toBe(node.publicKey);
    expect(acceptanceSignedFor(claim, a)).toBe(true);
    expect(acceptanceSignedFor({ ...claim, amount: 13n }, a)).toBe(false);
    expect(acceptanceSignedFor(claim, { ...a, timestampS: a.timestampS + 1n })).toBe(false);
    expect(acceptanceSignedFor(claim, { ...a, nodeKey: agent.publicKey })).toBe(false);
    expect(acceptanceSignedFor({ ...claim, payee: "not an account" }, a)).toBe(false);

    const budget = { validUntil: 2_000_000_000_500n, revokedAt: null as bigint | null };
    expect(acceptanceLimitMs(budget)).toBe(2_000_000_000_500n);
    expect(acceptanceInTime({ timestampS: 2_000_000_000n }, budget)).toBe(true);
    expect(acceptanceInTime({ timestampS: 2_000_000_001n }, budget)).toBe(false);
    const revoked = { ...budget, revokedAt: 1_900_000_000_250n };
    expect(acceptanceLimitMs(revoked)).toBe(1_900_000_000_250n);
    expect(acceptanceInTime({ timestampS: 1_900_000_000n }, revoked)).toBe(true);
    expect(acceptanceInTime({ timestampS: 1_900_000_001n }, revoked)).toBe(false);
    // A revoke after expiry does not extend anything.
    expect(acceptanceLimitMs({ validUntil: 10n, revokedAt: 20n })).toBe(10n);
    expect(acceptanceInTime({ timestampS: 2n ** 64n - 1n }, budget)).toBe(false);
  });
});
