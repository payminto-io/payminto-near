import { describe, expect, it } from "vitest";
import { computeNetting } from "../src/index.ts";

describe("computeNetting", () => {
  it("offsets opposite obligations between owners: A owes B 10, B owes A 7", () => {
    const r = computeNetting([
      { owner: "a.testnet", payee: "b.testnet", delta: 10n },
      { owner: "b.testnet", payee: "a.testnet", delta: 7n },
    ]);
    expect(r.gross).toBe(17n);
    expect(r.net).toBe(3n);
    expect(r.entries).toEqual([
      { account: "a.testnet", debit: 3n, credit: 0n },
      { account: "b.testnet", debit: 0n, credit: 3n },
    ]);
  });

  it("omits accounts that net to zero and sorts by account bytes", () => {
    const r = computeNetting([
      { owner: "z.testnet", payee: "m.testnet", delta: 5n },
      { owner: "m.testnet", payee: "z.testnet", delta: 5n },
      { owner: "c.testnet", payee: "b.testnet", delta: 1n },
    ]);
    expect(r.entries).toEqual([
      { account: "b.testnet", debit: 0n, credit: 1n },
      { account: "c.testnet", debit: 1n, credit: 0n },
    ]);
    expect(r.gross).toBe(11n);
    expect(r.net).toBe(1n);
  });

  it("treats a self payment as gross spend with no cash movement", () => {
    const r = computeNetting([{ owner: "a.testnet", payee: "a.testnet", delta: 4n }]);
    expect(r).toEqual({ gross: 4n, net: 0n, entries: [] });
  });

  it("aggregates single direction flows without offset", () => {
    const r = computeNetting([
      { owner: "a.testnet", payee: "s.testnet", delta: 2n },
      { owner: "a.testnet", payee: "t.testnet", delta: 3n },
    ]);
    expect(r.net).toBe(5n);
    expect(r.entries).toEqual([
      { account: "a.testnet", debit: 5n, credit: 0n },
      { account: "s.testnet", debit: 0n, credit: 2n },
      { account: "t.testnet", debit: 0n, credit: 3n },
    ]);
  });
});
