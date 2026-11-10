import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildVectors } from "../scripts/vectors.ts";
import { HUB_ERRORS, STORAGE_BYTE_COST, acceptancePreimage, hubErrorOf, keypairFromSeed, sha256Text, storageBytes, verifyDigest, verifyMerkleProof, voucherCallId, type PublicKey } from "../src/index.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const load = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

describe("frozen vectors", () => {
  it.each(Object.entries(buildVectors()))("%s.json matches the code byte for byte", (name, value) => {
    expect(readFileSync(join(dir, `${name}.json`), "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it("contains valid signatures from the listed keys", () => {
    const keys = Object.fromEntries(load("keys").keys.map((k: { name: string; public_key: PublicKey }) => [k.name, k.public_key]));
    for (const file of ["voucher", "checkout", "acceptance"]) {
      for (const c of load(file).cases) expect(verifyDigest(keys[c.signer]!, c.digest_hex, c.signature_hex)).toBe(true);
    }
  });

  it("pins each acceptance as sha256 of its listed text, with the call id derived from the voucher", () => {
    const cases = load("acceptance").cases;
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) {
      const i = c.input;
      const claim = { budgetId: i.budget_id, payee: i.payee, amount: BigInt(i.amount), cumulative: BigInt(i.cumulative), requestHash: i.request_hash, signature: i.voucher_sig };
      expect(voucherCallId(claim)).toBe(c.call_id);
      expect(acceptancePreimage(claim, BigInt(i.timestamp_s))).toBe(c.text);
      expect(sha256Text(c.text)).toBe(c.digest_hex);
      expect(c.text.split("|")).toHaveLength(9);
    }
  });

  it("lists storage sizes that the byte formulas reproduce", () => {
    const file = load("storage");
    expect(BigInt(file.byte_cost_yocto)).toBe(STORAGE_BYTE_COST);
    for (const c of file.cases) {
      const bytes =
        c.record === "settled" ? storageBytes.settled(c.payee)
        : c.record === "credit" ? storageBytes.credit(c.account, c.funder)
        : c.record === "batch" ? storageBytes.batch(c.settler)
        : c.record === "payment" ? storageBytes.payment(c.merchant, c.payer)
        : c.record === "receipt_keys" ? storageBytes.receiptKeys(c.settler, c.keys)
        : c.record === "storage_balance" ? storageBytes.storageBalance(c.account)
        : c.record === "settler" ? storageBytes.settler(c.account)
        : c.record === "checkout" ? storageBytes.checkout(c.settler)
        : storageBytes.budget(c);
      expect(bytes, c.record).toBe(c.bytes);
    }
  });

  it("derives each listed public key from its seed", () => {
    for (const k of load("keys").keys) expect(keypairFromSeed(Buffer.from(k.seed_hex, "hex")).publicKey).toBe(k.public_key);
  });

  it("has a valid proof for every leaf in every tree", () => {
    for (const c of load("merkle").cases) {
      for (const r of c.receipts_in_leaf_order) expect(verifyMerkleProof(c.root, r.leaf_hex, r.proof)).toBe(true);
    }
  });

  it("lists exactly the hub error codes in errors.rs, sorted and with no code a prefix of another", () => {
    const codes: string[] = load("errors").codes;
    expect(codes).toEqual([...HUB_ERRORS]);
    expect([...codes].sort()).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
    for (const a of codes) for (const b of codes) if (a !== b) expect(b.startsWith(a)).toBe(false);
    // The Rust side checks errors.json against its ALL list; this reads the Rust source so a drift fails here too.
    const rust = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts-near", "src", "errors.rs"), "utf8");
    const declared = [...rust.matchAll(/^pub const ([A-Z_]+): &str = "([A-Z_]+)";$/gm)].map((m) => {
      expect(m[2]).toBe(m[1]);
      return m[1]!;
    });
    expect(declared.sort()).toEqual(codes);
  });

  it("maps panic messages onto hub codes by whole-word prefix", () => {
    expect(hubErrorOf("Smart contract panicked: NOT_SETTLER")).toBe("NOT_SETTLER");
    expect(hubErrorOf("Smart contract panicked: NOT_BUDGET_SETTLER")).toBe("NOT_BUDGET_SETTLER");
    expect(hubErrorOf("BATCH_EXISTS: abc")).toBe("BATCH_EXISTS");
    expect(hubErrorOf("INSUFFICIENT_CREDIT")).toBe("INSUFFICIENT_CREDIT");
    expect(hubErrorOf("Smart contract panicked: Requires attached deposit of exactly 1 yoctoNEAR")).toBeNull();
    expect(hubErrorOf("NOT_SETTLERS")).toBeNull();
    expect(hubErrorOf("")).toBeNull();
  });

  it("uses no wrapped or prefixed forms that Rust would have to special-case", () => {
    for (const c of load("voucher").cases) {
      expect(c.digest_hex).toMatch(/^[0-9a-f]{64}$/);
      expect(c.signature_hex).toMatch(/^[0-9a-f]{128}$/);
    }
  });
});
