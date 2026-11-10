import { describe, expect, it } from "vitest";
import { publicKeyBytes, toHex } from "@payminto/protocol";
import { MIN_SETTLE_STORAGE_YOCTO, hubReadinessProblems, nearText, receiptKeyText } from "@/lib/hub-readiness";

const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const OTHER = "ed25519:8b6b8c51ez81e8576ae32ace42debd7a2d938cac15c6";
const node = { operator: "node.payminto.testnet", hub: "hub.payminto.testnet", nodeKey: KEY };
const NEAR = 10n ** 24n;

describe("hubReadinessProblems", () => {
  it("finds nothing wrong with a registered key and enough prepaid storage", () => {
    expect(hubReadinessProblems(node, { receiptKeys: [KEY], storageYocto: NEAR })).toEqual([]);
    expect(hubReadinessProblems(node, { receiptKeys: [OTHER, KEY], storageYocto: MIN_SETTLE_STORAGE_YOCTO })).toEqual([]);
  });
  it("warns when the server's receipt key is not registered, and says who signs what", () => {
    const [p, ...rest] = hubReadinessProblems(node, { receiptKeys: [], storageYocto: NEAR });
    expect(rest).toEqual([]);
    expect(p!.check).toBe("receipt_key_registered");
    expect(p!.title).toBe("This server's receipt key is not registered on the hub");
    expect(p!.happened).toContain("The hub holds no receipt key for node.payminto.testnet.");
    expect(p!.happened).toContain("no seller can settle a Call this server accepts without the server");
    expect(p!.todo).toBe("Sign register_receipt_key on hub.payminto.testnet as node.payminto.testnet, with a full-access key and exactly 1 yoctoNEAR. The key to register is the receipt key shown under Settings, Network.");
  });
  it("says the hub holds another key when the registered one is not the server's", () => {
    expect(hubReadinessProblems(node, { receiptKeys: [OTHER], storageYocto: NEAR })[0]!.happened).toContain("The hub holds another receipt key for node.payminto.testnet.");
    expect(hubReadinessProblems(node, { receiptKeys: [OTHER, "ed25519:x"], storageYocto: NEAR })[0]!.happened).toContain("2 other receipt keys");
  });
  it("warns when prepaid storage is below 100 batch records, with exact figures", () => {
    const [p] = hubReadinessProblems(node, { receiptKeys: [KEY], storageYocto: 12n * 10n ** 22n });
    expect(p!.check).toBe("settle_storage_balance");
    expect(p!.happened).toContain("node.payminto.testnet holds 0.12 NEAR of prepaid storage on the hub, below the 0.281 NEAR that 100 settlement batch records cost.");
    expect(p!.happened).toContain("INSUFFICIENT_STORAGE");
    expect(p!.todo).toBe("Call fund_storage on hub.payminto.testnet for node.payminto.testnet with NEAR attached. Anyone may fund it, and the unused part can be withdrawn later.");
  });
  it("reports both problems, the key first", () => {
    expect(hubReadinessProblems(node, { receiptKeys: [], storageYocto: 0n }).map((p) => p.check)).toEqual(["receipt_key_registered", "settle_storage_balance"]);
  });
  it("does not guess about the key when the server reports none", () => {
    expect(hubReadinessProblems({ ...node, nodeKey: null }, { receiptKeys: [], storageYocto: NEAR })).toEqual([]);
    expect(hubReadinessProblems({ operator: node.operator, hub: node.hub }, { receiptKeys: [], storageYocto: 0n }).map((p) => p.check)).toEqual(["settle_storage_balance"]);
  });
  it("uses the threshold of 100 batch records", () => {
    expect(nearText(MIN_SETTLE_STORAGE_YOCTO)).toBe("0.281 NEAR");
  });
});

describe("hub values", () => {
  it("turns the hub's hex receipt key into NEAR text form", () => {
    expect(receiptKeyText(toHex(publicKeyBytes(KEY)))).toBe(KEY);
    expect(receiptKeyText("not hex")).toBe("not hex");
  });
  it("writes yoctoNEAR as an exact NEAR figure", () => {
    expect(nearText(0n)).toBe("0 NEAR");
    expect(nearText(NEAR)).toBe("1 NEAR");
    expect(nearText(1n)).toBe("0.000000000000000000000001 NEAR");
    expect(nearText(1_228_410_000_000_000_000_000_000n)).toBe("1.22841 NEAR");
  });
});
