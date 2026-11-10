import { describe, expect, it } from "vitest";
import { Coordinator, coordinatorApp, ManualClock } from "../src/coordinator.ts";
import { commitFields, commitmentOf, demandFields, revealFields, signMessage, verifyRound, type RoundFile, type RoundParams } from "../src/rules.ts";
import { buyer, keyOf, rosterOf, salt, seller } from "./helpers.ts";

const ROUND = "http-r1";

function service(o: { openerToken?: string } = {}) {
  const clock = new ManualClock(1_000);
  const coordinator = new Coordinator({ clock });
  const app = coordinatorApp(coordinator, o);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const open = (headers?: Record<string, string>) =>
    call(
      "POST",
      "/rounds",
      { round: ROUND, roundNumber: 1, reserveUnitPrice: "700000", storage: { every: 2, price: "60000" }, data: { every: 4, price: "80000" }, roster: rosterOf(2, 2), poolWindow: 100, commitWindow: 100, revealWindow: 100 },
      headers,
    );
  const demand = (n: number, units = 3, max = "700000", signer = buyer(n)) => {
    const body = { buyer: buyer(n), units, maxUnitPrice: max };
    return call("POST", `/rounds/${ROUND}/demand`, { ...body, sig: signMessage(keyOf(signer).secretKey, "demand", ROUND, body.buyer, demandFields(body)) });
  };
  const bid = (n: number, unitPrice = 400_000n) => ({ unitPrice, capacity: 10, salt: salt(n) });
  const commit = (n: number, unitPrice?: bigint) => {
    const commitment = commitmentOf(ROUND, seller(n), bid(n, unitPrice));
    return call("POST", `/rounds/${ROUND}/commit`, { seller: seller(n), commitment, sig: signMessage(keyOf(seller(n)).secretKey, "commit", ROUND, seller(n), commitFields({ commitment })) });
  };
  const reveal = (n: number, unitPrice?: bigint) => {
    const b = bid(n, unitPrice);
    const body = { seller: seller(n), unitPrice: b.unitPrice.toString(), capacity: b.capacity, salt: b.salt };
    return call("POST", `/rounds/${ROUND}/reveal`, { ...body, sig: signMessage(keyOf(seller(n)).secretKey, "reveal", ROUND, seller(n), revealFields(body)) });
  };
  return { clock, call, open, demand, commit, reveal };
}

describe("the coordinator service", () => {
  it("runs a whole round over HTTP and publishes a round file that verifies", async () => {
    const s = service();
    const opened = await s.open();
    expect(opened.status).toBe(201);
    const params = opened.body as unknown as RoundParams;
    expect([params.poolDeadline, params.commitDeadline, params.revealDeadline]).toEqual([1_100, 1_200, 1_300]);

    expect((await s.demand(1, 4)).status).toBe(201);
    expect((await s.demand(2, 2)).status).toBe(201);
    expect((await s.call("GET", "/rounds")).body).toEqual([{ round: ROUND, phase: "pooling", pooledUnits: 6, reserveUnitPrice: "700000" }]);

    s.clock.set(1_100);
    expect((await s.commit(1, 400_000n)).status).toBe(201);
    expect((await s.commit(2, 450_000n)).status).toBe(201);
    // Before the reveal phase the price of a sealed bid is nowhere in what the service shows.
    const sealed = (await s.call("GET", `/rounds/${ROUND}`)).body;
    expect(sealed).toMatchObject({ phase: "commit", pooledUnits: 6, reveals: [] });
    expect(JSON.stringify(sealed)).not.toContain("400000");

    s.clock.set(1_200);
    expect((await s.reveal(1, 400_000n)).status).toBe(201);
    expect((await s.reveal(2, 450_000n)).status).toBe(201);
    expect((await s.call("GET", `/rounds/${ROUND}/log`)).body.error?.code).toBe("NOT_CLOSED");

    s.clock.set(1_300);
    const closed = await s.call("POST", `/rounds/${ROUND}/close`);
    expect(closed.status).toBe(200);
    const file = closed.body as unknown as RoundFile;
    expect(file.result).toMatchObject({ status: "cleared", winner: seller(1), clearingPrice: "450000", awardedUnits: 6 });
    expect(verifyRound(file).problems).toEqual([]);
    expect((await s.call("GET", `/rounds/${ROUND}/log`)).body).toEqual(closed.body);
    // Closing again changes nothing.
    expect((await s.call("POST", `/rounds/${ROUND}/close`)).body).toEqual(closed.body);
  });

  it("rejects a message outside its phase and does not record it", async () => {
    const s = service();
    await s.open();
    expect((await s.commit(1)).body.error?.code).toBe("WRONG_PHASE");
    expect((await s.reveal(1)).body.error?.code).toBe("NO_COMMITMENT");
    s.clock.set(1_100);
    expect((await s.demand(1)).body.error?.code).toBe("WRONG_PHASE");
    await s.commit(1);
    // A reveal before the commit deadline would leak a price while others can still bid.
    const early = await s.reveal(1);
    expect(early.status).toBe(409);
    expect(early.body.error?.message).toMatch(/reveals are accepted from the commit deadline/);
    expect((await s.call("POST", `/rounds/${ROUND}/close`)).body.error?.code).toBe("TOO_EARLY");
    s.clock.set(1_200);
    expect((await s.commit(2)).body.error?.code).toBe("WRONG_PHASE");
    const view = (await s.call("GET", `/rounds/${ROUND}`)).body as { commitments: unknown[]; reveals: unknown[]; demands: unknown[] };
    expect([view.demands.length, view.commitments.length, view.reveals.length]).toEqual([0, 1, 0]);
  });

  it("records a late reveal, which voids the bid, and takes nothing after the close", async () => {
    const s = service();
    await s.open();
    await s.demand(1);
    s.clock.set(1_100);
    await s.commit(1, 400_000n);
    await s.commit(2, 450_000n);
    s.clock.set(1_200);
    await s.reveal(2, 450_000n);
    s.clock.set(1_300);
    expect((await s.reveal(1, 400_000n)).status).toBe(201);
    const file = (await s.call("POST", `/rounds/${ROUND}/close`)).body as unknown as RoundFile;
    expect(file.result.bids[0]).toMatchObject({ seller: seller(1), status: "void", reason: "LATE_REVEAL", unitPrice: "400000" });
    expect(file.result).toMatchObject({ winner: seller(2), clearingPrice: "700000" });
    expect(verifyRound(file).ok).toBe(true);
    expect((await s.reveal(1, 400_000n)).body.error?.code).toBe("WRONG_PHASE");
  });

  it("accepts only the first demand, commitment and reveal of an account", async () => {
    const s = service();
    await s.open();
    await s.demand(1, 3);
    expect((await s.demand(1, 5)).body.error?.code).toBe("DUPLICATE");
    s.clock.set(1_100);
    await s.commit(1, 400_000n);
    expect((await s.commit(1, 300_000n)).body.error?.code).toBe("DUPLICATE");
    s.clock.set(1_200);
    await s.reveal(1, 400_000n);
    expect((await s.reveal(1, 400_000n)).body.error?.code).toBe("DUPLICATE");
  });

  it("rejects a message that is unsigned, signed by another key, from an outsider or from the wrong role", async () => {
    const s = service();
    await s.open();
    expect((await s.demand(1, 3, "700000", buyer(2))).body.error?.code).toBe("BAD_SIGNATURE");
    expect((await s.demand(9)).body.error?.code).toBe("NOT_ON_ROSTER");
    expect((await s.call("POST", `/rounds/${ROUND}/demand`, { buyer: buyer(1), units: 3, maxUnitPrice: "700000" })).body.error?.code).toBe("BAD_REQUEST");
    // A seller cannot join the pool with a demand of its own.
    const body = { buyer: seller(1), units: 3, maxUnitPrice: "700000" };
    const asSeller = await s.call("POST", `/rounds/${ROUND}/demand`, { ...body, sig: signMessage(keyOf(seller(1)).secretKey, "demand", ROUND, seller(1), demandFields(body)) });
    expect(asSeller.body.error?.code).toBe("WRONG_ROLE");
  });

  it("keeps a buyer whose limit is under the reserve out of the pool", async () => {
    const s = service();
    await s.open();
    const res = await s.demand(1, 3, "699999");
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("UNDER_RESERVE");
  });

  it("answers an unknown round, a bad round id and bad JSON with a reason", async () => {
    const s = service();
    expect((await s.call("GET", "/rounds/nope")).body.error?.code).toBe("UNKNOWN_ROUND");
    expect((await s.call("GET", "/rounds/Not_A_Round")).body.error?.code).toBe("BAD_ROUND_ID");
    await s.open();
    expect((await s.open()).body.error?.code).toBe("ROUND_EXISTS");
  });

  it("needs the opener token to open a round when one is set", async () => {
    const s = service({ openerToken: "secret" });
    expect((await s.open()).status).toBe(401);
    expect((await s.open({ authorization: "Bearer secret" })).status).toBe(201);
  });

  it("refuses a roster with a repeated account or a shared key", () => {
    const c = new Coordinator({ clock: new ManualClock() });
    const roster = rosterOf(2, 1);
    const base = { round: "r", roundNumber: 1, reserveUnitPrice: "700000", storage: { every: 2, price: "60000" }, data: { every: 4, price: "80000" }, poolWindow: 1, commitWindow: 1, revealWindow: 1 };
    expect(() => c.open({ ...base, roster: [...roster, roster[0]!] })).toThrow(/twice/);
    expect(() => c.open({ ...base, roster: [roster[0]!, { ...roster[1]!, publicKey: roster[0]!.publicKey }] })).toThrow(/share one key/);
  });
});
