import { describe, expect, it } from "vitest";
import { accountKindOf, isAccountId, printable } from "../src/account.ts";
import { editDistance, findLookalike, skeleton } from "../src/lookalike.ts";

const RULE = { maxEdits: 2, charsPerEdit: 4 };

describe("account ids", () => {
  it("accepts NEAR account ids and nothing else", () => {
    for (const ok of ["acme.near", "a1", "sub.acme.testnet", "my-shop_1.near", "0".repeat(64)]) expect(isAccountId(ok)).toBe(true);
    for (const bad of ["", "a", "Acme.near", "acme..near", "-acme.near", "acme.near.", "acme near", "a".repeat(65), "\u0430cme.near", 42, null]) {
      expect(isAccountId(bad)).toBe(false);
    }
  });

  it("tells named, implicit and Ethereum-implicit accounts apart", () => {
    expect(accountKindOf("acme.near")).toBe("named");
    expect(accountKindOf("641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5")).toBe("implicit");
    expect(accountKindOf("0x8ba1f109551bd432803012645ac136ddd64dba72")).toBe("eth_implicit");
    // 63 hex characters is just an odd name.
    expect(accountKindOf("641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a")).toBe("named");
    expect(accountKindOf("Not An Account")).toBeNull();
  });

  it("flattens and caps untrusted text for printing", () => {
    expect(printable("line one\nline two\u2028three\u0007")).toBe("line one line two three");
    expect(printable("x".repeat(200), 10)).toBe("xxxxxxxxxx...");
  });
});

describe("lookalike names", () => {
  it("folds confusable spellings to one skeleton", () => {
    expect(skeleton("acrne.near")).toBe(skeleton("acme.near"));
    expect(skeleton("vvallet.near")).toBe(skeleton("wallet.near"));
    expect(skeleton("g00gle.near")).toBe(skeleton("google.near"));
    expect(skeleton("pay_pal.near")).toBe(skeleton("pay-pal.near"));
    expect(skeleton("acme.near")).not.toBe(skeleton("acne.near"));
  });

  it("counts edits, with a swap of neighbours as one", () => {
    expect(editDistance("acme", "acme")).toBe(0);
    expect(editDistance("acme", "acne")).toBe(1);
    expect(editDistance("acme", "amce")).toBe(1);
    expect(editDistance("acme", "acmee")).toBe(1);
    expect(editDistance("acme", "")).toBe(4);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("catches the rn-for-m trick against an allowed payee", () => {
    expect(findLookalike("acrne.near", ["acme.near"], RULE)).toEqual({ resembles: "acme.near", how: "confusable", distance: 2 });
  });

  it("catches a one-letter change in a name of four or more characters", () => {
    expect(findLookalike("acne.near", ["acme.near"], RULE)).toMatchObject({ resembles: "acme.near", how: "edit_distance", distance: 1 });
    expect(findLookalike("acme-dota.near", ["acme-data.near"], RULE)).toMatchObject({ how: "edit_distance", distance: 1 });
    expect(findLookalike("acne-dota.near", ["acme-data.near"], RULE)).toMatchObject({ how: "edit_distance", distance: 2 });
  });

  it("does not flag the payee itself, its sub-accounts, short names or unrelated names", () => {
    expect(findLookalike("acme.near", ["acme.near"], RULE)).toBeNull();
    expect(findLookalike("pay.acme.near", ["acme.near"], RULE)).toBeNull();
    // Three characters tolerate no edit: bob and rob are simply two people.
    expect(findLookalike("rob.near", ["bob.near"], RULE)).toBeNull();
    expect(findLookalike("weather-api.near", ["acme.near"], RULE)).toBeNull();
    // The shared parent does not pad the names: ab and cd differ entirely.
    expect(findLookalike("cd.testnet", ["ab.testnet"], RULE)).toBeNull();
    expect(findLookalike("acrne.near", [], RULE)).toBeNull();
  });

  it("still flags a short name when only confusable characters differ", () => {
    expect(findLookalike("b0b.near", ["bob.near"], RULE)).toMatchObject({ how: "confusable" });
  });

  it("picks the closest match, and the same one whatever the list order", () => {
    const a = findLookalike("acrne.near", ["acne.near", "acme.near"], RULE);
    const b = findLookalike("acrne.near", ["acme.near", "acne.near"], RULE);
    expect(a).toEqual(b);
    expect(a?.resembles).toBe("acme.near");
  });

  it("respects a stricter rule", () => {
    expect(findLookalike("acne.near", ["acme.near"], { maxEdits: 0, charsPerEdit: 4 })).toBeNull();
  });
});
