import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allocate, apportion, commitmentOf, dataHostOf, messageDigest, messageSigned, phaseAt, signMessage, storageSupplierOf, type DemandMsg } from "../src/rules.ts";
import { buyer, keyOf, playRound, RESERVE, rosterOf, salt, seller } from "./helpers.ts";

describe("rule 5: the commitment", () => {
  it("is the SHA-256 of the six parts joined by newlines, as printf and shasum would compute it", () => {
    const text = `payminto.swarm.bid.v1\ntest-r1\n${seller(1)}\n431000\n80\n${salt(1)}`;
    const byHand = createHash("sha256").update(text, "utf8").digest("hex");
    expect(commitmentOf("test-r1", seller(1), { unitPrice: 431_000n, capacity: 80, salt: salt(1) })).toBe(byHand);
  });

  it("changes with every part: the round, the seller, the price, the capacity and the salt", () => {
    const base = { unitPrice: 431_000n, capacity: 80, salt: salt(1) };
    const c = commitmentOf("test-r1", seller(1), base);
    expect(commitmentOf("test-r2", seller(1), base)).not.toBe(c);
    expect(commitmentOf("test-r1", seller(2), base)).not.toBe(c);
    expect(commitmentOf("test-r1", seller(1), { ...base, unitPrice: 431_001n })).not.toBe(c);
    expect(commitmentOf("test-r1", seller(1), { ...base, capacity: 81 })).not.toBe(c);
    expect(commitmentOf("test-r1", seller(1), { ...base, salt: salt(2) })).not.toBe(c);
  });

  it("reads a price given as a string or a bigint the same way", () => {
    expect(commitmentOf("test-r1", seller(1), { unitPrice: "431000", capacity: 80, salt: salt(1) })).toBe(commitmentOf("test-r1", seller(1), { unitPrice: 431_000n, capacity: 80, salt: salt(1) }));
  });
});

describe("rule 3: phases and signed messages", () => {
  const d = { poolDeadline: 100, commitDeadline: 200, revealDeadline: 300 };
  it("puts each instant in exactly one phase, with the deadline belonging to the next phase", () => {
    expect([0, 99, 100, 199, 200, 299, 300, 9_999].map((t) => phaseAt(d, t))).toEqual(["pooling", "pooling", "commit", "commit", "reveal", "reveal", "late", "late"]);
    expect(phaseAt(d, 150, true)).toBe("closed");
  });

  it("binds a signature to the kind, the round, the sender and every field", () => {
    const roster = rosterOf(2, 1);
    const m: DemandMsg = { kind: "demand", seq: 1, at: 10, buyer: buyer(1), units: 4, maxUnitPrice: "700000", sig: signMessage(keyOf(buyer(1)).secretKey, "demand", "test-r1", buyer(1), [4, "700000"]) };
    expect(messageSigned("test-r1", roster, m)).toBe(true);
    expect(messageSigned("test-r2", roster, m)).toBe(false);
    expect(messageSigned("test-r1", roster, { ...m, units: 5 })).toBe(false);
    expect(messageSigned("test-r1", roster, { ...m, buyer: buyer(2) })).toBe(false);
    expect(messageDigest("demand", "test-r1", buyer(1), [4, "700000"])).not.toBe(messageDigest("commit", "test-r1", buyer(1), [4, "700000"]));
  });
});

describe("rule 9: the largest remainder method", () => {
  const split = (units: number[], awarded: number) => allocate(units.map((u, i) => ({ buyer: buyer(i + 1), units: u })), awarded, 433_000n);

  it("gives every buyer its full demand when everything is awarded", () => {
    expect(split([5, 2, 4], 11).map((a) => a.units)).toEqual([5, 2, 4]);
  });

  it("gives the leftover units to the largest remainders", () => {
    // 7 units for demands 5, 3, 2 (Q = 10): 3.5, 2.1, 1.4, so the bases are 3, 2, 1 and the one left goes to remainder 5.
    expect(split([5, 3, 2], 7).map((a) => a.units)).toEqual([4, 2, 1]);
    // 8 units for demands 3, 3, 3: 2.67 each, bases 2, 2, 2 and two left.
    expect(split([3, 3, 3], 8).map((a) => a.units)).toEqual([3, 3, 2]);
  });

  it("breaks a tie between equal remainders by account in ASCII order, so buyer-10 comes before buyer-2", () => {
    const tied = allocate(
      [
        { buyer: buyer(2), units: 1 },
        { buyer: buyer(10), units: 1 },
      ],
      1,
      1n,
    );
    expect(tied).toEqual([
      { buyer: buyer(2), demanded: 1, units: 0, share: "0" },
      { buyer: buyer(10), demanded: 1, units: 1, share: "1" },
    ]);
  });

  it("prices each share as units times the clearing price, with no remainder in money", () => {
    const out = split([6, 5, 4, 3, 2, 1], 13);
    expect(out.reduce((s, a) => s + a.units, 0)).toBe(13);
    expect(out.reduce((s, a) => s + BigInt(a.share), 0n)).toBe(13n * 433_000n);
    for (const a of out) expect(BigInt(a.share)).toBe(BigInt(a.units) * 433_000n);
  });

  it("always sums to the awarded units and never gives a buyer more than it asked for", () => {
    let seed = 12_345;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const units = Array.from({ length: 1 + next(25) }, () => 1 + next(9));
      const pooled = units.reduce((a, b) => a + b, 0);
      const awarded = next(pooled + 1);
      const out = split(units, awarded);
      expect(out.reduce((s, a) => s + a.units, 0)).toBe(awarded);
      for (const a of out) {
        expect(a.units).toBeLessThanOrEqual(a.demanded);
        // Never further than one unit from the exact proportion.
        expect(Math.abs(a.units - (awarded * a.demanded) / pooled)).toBeLessThan(1);
      }
    }
  });

  it("refuses to award more than the pool asked for", () => {
    expect(() => split([2, 2], 5)).toThrow(/more units than the pool/);
  });

  it("handles a zero total and an empty pool", () => {
    expect(split([3, 4], 0).map((a) => a.units)).toEqual([0, 0]);
    expect([...apportion([], 0)]).toEqual([]);
  });
});

describe("rules 6 to 8: void bids, the winner and the clearing price", () => {
  const demands = [4, 3, 3];

  it("picks the lowest valid price and charges the second-lowest", () => {
    const { file } = playRound({ demands, bids: [{ seller: 1, unitPrice: 450_000n, capacity: 50 }, { seller: 2, unitPrice: 430_000n, capacity: 50 }, { seller: 3, unitPrice: 470_000n, capacity: 50 }] });
    expect(file.result).toMatchObject({ status: "cleared", winner: seller(2), winnerUnitPrice: "430000", clearingPrice: "450000", pooledUnits: 10, awardedUnits: 10, totalDue: "4500000" });
  });

  it("breaks a price tie by the earlier commitment, and the price is then the winner's own", () => {
    const { file } = playRound({ demands, bids: [{ seller: 2, unitPrice: 430_000n, capacity: 50 }, { seller: 1, unitPrice: 430_000n, capacity: 50 }] });
    expect(file.result.winner).toBe(seller(2));
    expect(file.result.clearingPrice).toBe("430000");
  });

  it("charges the reserve when only one bid is valid", () => {
    const { file } = playRound({ demands, bids: [{ seller: 1, unitPrice: 450_000n, capacity: 50 }, { seller: 2, unitPrice: 430_000n, capacity: 50, reveal: "never" }] });
    expect(file.result.winner).toBe(seller(1));
    expect(file.result.clearingPrice).toBe(RESERVE.toString());
  });

  it("voids a bid that is never revealed, revealed late, mismatched or above the reserve, each with its reason", () => {
    const { file } = playRound({
      demands,
      bids: [
        { seller: 1, unitPrice: 300_000n, capacity: 50, reveal: "never" },
        { seller: 2, unitPrice: 310_000n, capacity: 50, reveal: "late" },
        { seller: 3, unitPrice: 320_000n, capacity: 50, reveal: "other" },
        { seller: 4, unitPrice: 800_000n, capacity: 50 },
        { seller: 5, unitPrice: 500_000n, capacity: 50 },
        { seller: 6, unitPrice: 520_000n, capacity: 50 },
      ],
    });
    expect(file.result.bids.map((b) => [b.status, b.reason])).toEqual([
      ["void", "NOT_REVEALED"],
      ["void", "LATE_REVEAL"],
      ["void", "COMMITMENT_MISMATCH"],
      ["void", "ABOVE_RESERVE"],
      ["valid", null],
      ["valid", null],
    ]);
    // The four cheaper bids are void, so they neither win nor set the price.
    expect(file.result.winner).toBe(seller(5));
    expect(file.result.clearingPrice).toBe("520000");
    // A late reveal is still shown, so anyone can see what was opened too late.
    expect(file.result.bids[1]).toMatchObject({ unitPrice: "310000", capacity: 50 });
    expect(file.result.bids[0]).toMatchObject({ unitPrice: null, capacity: null });
  });

  it("ends with no winner when no bid is valid, and nothing is owed", () => {
    const { file } = playRound({ demands, bids: [{ seller: 1, unitPrice: 300_000n, capacity: 50, reveal: "never" }] });
    expect(file.result).toMatchObject({ status: "no-winner", winner: null, clearingPrice: null, awardedUnits: 0, totalDue: "0" });
    expect(file.result.allocations.every((a) => a.units === 0 && a.share === "0")).toBe(true);
  });

  it("ends with no demand when no buyer joined", () => {
    const { file } = playRound({ demands: [0, 0], bids: [{ seller: 1, unitPrice: 300_000n, capacity: 50 }] });
    expect(file.result).toMatchObject({ status: "no-demand", pooledUnits: 0, winner: null });
  });

  it("awards only the winner's capacity and splits it by the largest remainder rule", () => {
    const { file } = playRound({ demands: [5, 3, 2], bids: [{ seller: 1, unitPrice: 400_000n, capacity: 7 }, { seller: 2, unitPrice: 410_000n, capacity: 50 }] });
    expect(file.result).toMatchObject({ pooledUnits: 10, awardedUnits: 7, clearingPrice: "410000", totalDue: "2870000" });
    expect(file.result.allocations.map((a) => [a.units, a.share])).toEqual([
      [4, "1640000"],
      [2, "820000"],
      [1, "410000"],
    ]);
  });
});

describe("rule 12: who supplies whom", () => {
  const roster = rosterOf(6, 3, 2);
  it("names the next seller on the roster as storage supplier, wrapping around", () => {
    expect([1, 2, 3].map((n) => storageSupplierOf(roster, seller(n)))).toEqual([seller(2), seller(3), seller(1)]);
    expect(storageSupplierOf(rosterOf(2, 1), seller(1))).toBeNull();
  });
  it("rotates the data host by round number", () => {
    expect([1, 2, 3].map((n) => dataHostOf(roster, n))).toEqual([buyer(1), buyer(2), buyer(1)]);
    expect(dataHostOf(rosterOf(2, 2, 0), 1)).toBeNull();
  });
});
