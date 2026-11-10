import { describe, expect, it } from "vitest";
import { verifyRound, type Delivery, type RoundFile } from "../src/rules.ts";
import { buyer, copy, playRound, seller } from "./helpers.ts";

/** Demands 5, 3, 2; the winner can serve 7; one bid is late and one never opens. */
const published = () =>
  playRound({
    demands: [5, 3, 2],
    bids: [
      { seller: 1, unitPrice: 400_000n, capacity: 7 },
      { seller: 2, unitPrice: 410_000n, capacity: 50 },
      { seller: 3, unitPrice: 390_000n, capacity: 50, reveal: "late" },
      { seller: 4, unitPrice: 380_000n, capacity: 50, reveal: "never" },
    ],
  }).file;

/** What an honest runner records for that round: every buyer got its allocation. */
const delivered = (file: RoundFile): Delivery => ({
  seller: seller(1),
  unitPrice: "410000",
  buyers: file.result.allocations.map((a) => ({ buyer: a.buyer, delivered: a.units, paid: a.share, stopped: null })),
  deliveredUnits: 7,
  sellerReceived: "2870000",
  storage: { from: seller(2), count: 3, paid: "180000" },
  data: { from: buyer(1), count: 1, paid: "80000" },
  inputRefused: null,
});

const failing = (file: unknown) => verifyRound(file).checks.filter((c) => !c.ok).map((c) => c.name);

describe("verifyRound on an honest round", () => {
  it("passes every check, with and without a delivery record", () => {
    const file = published();
    expect(verifyRound(file)).toMatchObject({ ok: true, problems: [] });
    const withDelivery = verifyRound({ ...file, delivery: delivered(file) });
    expect(withDelivery.problems).toEqual([]);
    expect(withDelivery.checks).toHaveLength(8);
  });

  it("returns the outcome it recomputed from the messages", () => {
    expect(verifyRound(published()).outcome).toMatchObject({ winner: seller(1), clearingPrice: "410000", awardedUnits: 7, pooledUnits: 10 });
  });

  it("is pure: the same file gives the same answer, and the file is not changed", () => {
    const file = published();
    const before = JSON.stringify(file);
    expect(JSON.stringify(verifyRound(file))).toBe(JSON.stringify(verifyRound(copy(file))));
    expect(JSON.stringify(file)).toBe(before);
  });

  it("does not depend on the order of the keys in the file", () => {
    const file = published();
    const reordered = copy(file);
    reordered.result.bids = reordered.result.bids.map((b) => Object.fromEntries(Object.entries(b).reverse())) as RoundFile["result"]["bids"];
    expect(verifyRound(reordered).ok).toBe(true);
  });
});

describe("verifyRound on a tampered round", () => {
  it("rejects a file that is not a round file, without throwing", () => {
    for (const junk of [null, 42, "round", {}, { kind: "payminto.swarm.round.v1" }, []]) {
      const v = verifyRound(junk);
      expect(v.ok).toBe(false);
      expect(v.outcome).toBeNull();
      expect(v.problems.length).toBeGreaterThan(0);
    }
  });

  it("catches a changed winner", () => {
    const file = published();
    file.result.winner = seller(2);
    expect(failing(file)).toEqual(["the winner is the lowest valid bid and the clearing price is the second-lowest valid price"]);
  });

  it("catches a changed clearing price, even when the shares are rewritten to match it", () => {
    const file = published();
    file.result.clearingPrice = "400000";
    file.result.totalDue = "2800000";
    for (const a of file.result.allocations) a.share = (BigInt(a.units) * 400_000n).toString();
    expect(failing(file)).toEqual(expect.arrayContaining(["the winner is the lowest valid bid and the clearing price is the second-lowest valid price", "the units are split by the largest remainder rule and the shares sum to price times units"]));
  });

  it("catches a share raised by one atomic unit", () => {
    const file = published();
    file.result.allocations[0]!.share = (BigInt(file.result.allocations[0]!.share) + 1n).toString();
    const v = verifyRound(file);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/shares sum to 2870001, not price times units 2870000/);
  });

  it("catches a unit moved from one buyer to another", () => {
    const file = published();
    file.result.allocations[0]!.units -= 1;
    file.result.allocations[1]!.units += 1;
    expect(failing(file)).toEqual(["the units are split by the largest remainder rule and the shares sum to price times units"]);
  });

  it("catches a revealed price edited after the fact: the signature and the commitment both break", () => {
    const file = published();
    const reveal = file.messages.find((m) => m.kind === "reveal" && m.seller === seller(2))!;
    if (reveal.kind === "reveal") reveal.unitPrice = "395000";
    expect(failing(file)).toEqual(expect.arrayContaining(["every message is signed by the roster key of its sender", "every commitment matches its reveal or is void for the stated reason"]));
  });

  it("catches a swapped commitment", () => {
    const file = published();
    const commit = file.messages.find((m) => m.kind === "commit" && m.seller === seller(1))!;
    if (commit.kind === "commit") commit.commitment = "0".repeat(64);
    expect(failing(file)).toEqual(expect.arrayContaining(["every message is signed by the roster key of its sender", "every commitment matches its reveal or is void for the stated reason"]));
  });

  it("catches a late reveal moved back in time to make a void bid win", () => {
    const file = published();
    const reveal = file.messages.find((m) => m.kind === "reveal" && m.seller === seller(3))!;
    reveal.at = file.params.revealDeadline - 1;
    const names = failing(file);
    expect(names).toContain("every commitment matches its reveal or is void for the stated reason");
    expect(names).toContain("the winner is the lowest valid bid and the clearing price is the second-lowest valid price");
  });

  it("catches a void bid published as valid, and a valid bid published as void", () => {
    const a = published();
    Object.assign(a.result.bids[3]!, { status: "valid", reason: null });
    expect(failing(a)).toContain("every commitment matches its reveal or is void for the stated reason");
    const b = published();
    Object.assign(b.result.bids[0]!, { status: "void", reason: "ABOVE_RESERVE" });
    expect(failing(b)).toContain("every commitment matches its reveal or is void for the stated reason");
  });

  it("catches a demand edited after it was signed", () => {
    const file = published();
    const demand = file.messages.find((m) => m.kind === "demand" && m.buyer === buyer(2))!;
    if (demand.kind === "demand") demand.units = 9;
    expect(failing(file)).toContain("every message is signed by the roster key of its sender");
  });

  it("catches a dropped message, a message out of its phase and a reveal ahead of a commitment", () => {
    const dropped = published();
    dropped.messages.splice(1, 1);
    expect(failing(dropped)).toContain("every message is in sequence and inside its phase, and every commitment precedes every reveal");

    const early = published();
    const reveal = early.messages.find((m) => m.kind === "reveal")!;
    reveal.at = early.params.commitDeadline - 1;
    expect(verifyRound(early).problems.join(" ")).toMatch(/before the commit deadline/);

    const reordered = published();
    const firstReveal = reordered.messages.findIndex((m) => m.kind === "reveal");
    const lastCommit = reordered.messages.findLastIndex((m) => m.kind === "commit");
    [reordered.messages[firstReveal], reordered.messages[lastCommit]] = [reordered.messages[lastCommit]!, reordered.messages[firstReveal]!];
    expect(verifyRound(reordered).ok).toBe(false);
  });

  it("catches a sender that is not on the roster and a roster key that was swapped", () => {
    const off = published();
    off.params.roster = off.params.roster.filter((r) => r.account !== seller(2));
    expect(verifyRound(off).problems.join(" ")).toMatch(/not on the roster/);

    const swapped = published();
    swapped.params.roster.find((r) => r.account === seller(1))!.publicKey = swapped.params.roster.find((r) => r.account === buyer(1))!.publicKey;
    expect(verifyRound(swapped).ok).toBe(false);
  });

  it("catches a round closed before its reveal deadline", () => {
    const file = published();
    file.result.closedAt = file.params.revealDeadline - 1;
    expect(verifyRound(file).problems.join(" ")).toMatch(/before the reveal deadline/);
  });
});

describe("verifyRound on a tampered delivery record", () => {
  const withDelivery = (change: (d: Delivery) => void) => {
    const file = published();
    const d = delivered(file);
    change(d);
    return verifyRound({ ...file, delivery: d });
  };
  const money = "no buyer paid more than its share, and the seller was paid exactly for the units it delivered";
  const inputs = "the seller's input purchases follow rules I1 and I2";

  it("catches a buyer that paid more than its share", () => {
    const v = withDelivery((d) => {
      d.buyers[0]!.delivered = 5;
      d.buyers[0]!.paid = "2050000";
    });
    expect(v.problems.join(" ")).toMatch(/more than its share|more than its 4 allocated/);
    expect(v.checks.find((c) => c.name === money)!.ok).toBe(false);
  });

  it("catches a buyer charged one atomic unit too much for what it received", () => {
    const v = withDelivery((d) => void (d.buyers[1]!.paid = "820001"));
    expect(v.checks.find((c) => c.name === money)!.ok).toBe(false);
  });

  it("catches a seller paid for units it did not deliver", () => {
    const v = withDelivery((d) => void (d.sellerReceived = "3280000"));
    expect(v.problems.join(" ")).toMatch(/the seller received 3280000/);
  });

  it("catches missing units with no recorded cause, and accepts them with one", () => {
    const silent = withDelivery((d) => {
      d.buyers[0]!.delivered = 2;
      d.buyers[0]!.paid = "820000";
      d.deliveredUnits = 5;
      d.sellerReceived = "2050000";
      d.storage = { from: seller(2), count: 2, paid: "120000" };
    });
    expect(silent.problems.join(" ")).toMatch(/2 units are missing with no recorded cause/);
    const explained = withDelivery((d) => {
      d.buyers[0]!.delivered = 2;
      d.buyers[0]!.paid = "820000";
      d.buyers[0]!.stopped = { atUnit: 3, cause: "refused", rule: "TOTAL_CAP", enforcedBy: "agent", attemptedAmount: "410000", remainingBudget: "100000" };
      d.deliveredUnits = 5;
      d.sellerReceived = "2050000";
      d.storage = { from: seller(2), count: 2, paid: "120000" };
    });
    expect(explained.problems).toEqual([]);
  });

  it("catches delivery by a seller that did not win, or at another price", () => {
    expect(withDelivery((d) => void (d.seller = seller(2))).ok).toBe(false);
    expect(withDelivery((d) => void (d.unitPrice = "400000")).ok).toBe(false);
  });

  it("catches input purchases that do not follow rules I1 and I2", () => {
    expect(withDelivery((d) => void (d.storage.count = 2)).checks.find((c) => c.name === inputs)!.ok).toBe(false);
    expect(withDelivery((d) => void (d.storage.from = seller(3))).checks.find((c) => c.name === inputs)!.ok).toBe(false);
    expect(withDelivery((d) => void (d.data.paid = "80001")).checks.find((c) => c.name === inputs)!.ok).toBe(false);
    expect(withDelivery((d) => void (d.data.from = buyer(2))).checks.find((c) => c.name === inputs)!.ok).toBe(false);
  });
});
