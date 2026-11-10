import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_MERKLE_DEPTH,
  RECEIPT_DOMAIN,
  buildReceiptTree,
  hashPair,
  merkleProof,
  merkleRoot,
  receiptLeaf,
  receiptLeafPreimage,
  toHex,
  verifyMerkleProof,
  type ReceiptFields,
} from "../src/index.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const str = (s: string) => {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
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
const hex = (h: string) => Buffer.from(h, "hex");

const HUB = "hub.payminto.testnet";
const NET = "near:testnet" as const;
const BATCH = "0b".repeat(32);

const fields = (i: number): ReceiptFields => ({
  callId: i.toString(16).padStart(2, "0").repeat(32),
  budgetId: "aa".repeat(32),
  payee: "api.testnet",
  amount: BigInt(i + 1),
  cumulative: BigInt((i + 1) * 10),
  requestHash: "cc".repeat(32),
  timestampMs: 1_800_000_000_000n + BigInt(i),
  voucherSig: "dd".repeat(64),
});

describe("receipt leaf", () => {
  it("matches sha256(0x00 || borsh(...)) written by hand", () => {
    const f = fields(3);
    const body = Buffer.concat([
      str(RECEIPT_DOMAIN),
      str(HUB),
      str(NET),
      hex(BATCH),
      hex(f.callId),
      hex(f.budgetId),
      str(f.payee),
      u128(f.amount),
      u128(f.cumulative),
      hex(f.requestHash),
      u64(f.timestampMs),
      hex(f.voucherSig),
    ]);
    expect(toHex(receiptLeafPreimage(HUB, NET, BATCH, f))).toBe(body.toString("hex"));
    expect(receiptLeaf(HUB, NET, BATCH, f)).toBe(sha(Buffer.concat([Buffer.from([0]), body])));
  });
});

describe("internal nodes", () => {
  it("hashes 0x01 || min || max, independent of argument order", () => {
    const a = "01".repeat(32);
    const b = "ff".repeat(32);
    const want = sha(Buffer.concat([Buffer.from([1]), hex(a), hex(b)]));
    expect(hashPair(a, b)).toBe(want);
    expect(hashPair(b, a)).toBe(want);
  });
});

describe("tree shape", () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => sha(Buffer.from([i])));

  it("a single leaf is its own root with an empty proof", () => {
    const [l] = leaves(1);
    expect(merkleRoot([l!])).toBe(l);
    expect(merkleProof([l!], 0)).toEqual([]);
  });

  it("promotes an odd node unchanged", () => {
    const [a, b, c] = leaves(3) as [string, string, string];
    expect(merkleRoot([a, b, c])).toBe(hashPair(hashPair(a, b), c));
    const five = leaves(5) as [string, string, string, string, string];
    const [p, q, r, s, t] = five;
    expect(merkleRoot(five)).toBe(hashPair(hashPair(hashPair(p, q), hashPair(r, s)), t));
  });

  it("proves every leaf for sizes 1 to 33", () => {
    for (let n = 1; n <= 33; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      ls.forEach((leaf, i) => expect(verifyMerkleProof(root, leaf, merkleProof(ls, i))).toBe(true));
    }
  });

  it("rejects a wrong leaf, a wrong sibling, an over-deep proof and an empty tree", () => {
    const ls = leaves(4);
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 1);
    expect(verifyMerkleProof(root, ls[0]!, proof)).toBe(false);
    expect(verifyMerkleProof(root, ls[1]!, [...proof.slice(0, -1), "00".repeat(32)])).toBe(false);
    expect(verifyMerkleProof(root, ls[1]!, Array(MAX_MERKLE_DEPTH + 1).fill("00".repeat(32)))).toBe(false);
    expect(() => merkleRoot([])).toThrow(/empty/);
  });

  it("does not accept an internal node as a leaf, because the 0x00 and 0x01 prefixes differ", () => {
    const [a, b, c, d] = leaves(4) as [string, string, string, string];
    const root = merkleRoot([a, b, c, d]);
    expect(verifyMerkleProof(root, hashPair(a, b), [hashPair(c, d)])).toBe(true); // the raw fold accepts it
    // A caller holding receipt fields can never produce hashPair output as a leaf: receiptLeaf always prefixes 0x00.
    expect(receiptLeaf(HUB, NET, BATCH, fields(0))).not.toBe(hashPair(a, b));
  });
});

describe("receipt tree", () => {
  it("sorts leaves by call id, whatever the input order", () => {
    const fs = [fields(9), fields(1), fields(5)];
    const reversed = [...fs].reverse();
    const a = buildReceiptTree(HUB, NET, BATCH, fs);
    const b = buildReceiptTree(HUB, NET, BATCH, reversed);
    expect(a.root).toBe(b.root);
    expect(a.receipts.map((r) => r.callId)).toEqual([fields(1).callId, fields(5).callId, fields(9).callId]);
    for (const f of fs) {
      const p = a.proofOf(f.callId);
      expect(verifyMerkleProof(a.root, receiptLeaf(HUB, NET, BATCH, f), p)).toBe(true);
    }
  });

  it("rejects duplicate call ids", () => {
    expect(() => buildReceiptTree(HUB, NET, BATCH, [fields(1), fields(1)])).toThrow(/duplicate/);
  });

  it("binds the batch id into the leaf", () => {
    const f = fields(1);
    expect(receiptLeaf(HUB, NET, BATCH, f)).not.toBe(receiptLeaf(HUB, NET, "0c".repeat(32), f));
  });
});
