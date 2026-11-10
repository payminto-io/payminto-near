import { gasless } from "@payminto/near-addons";
import { decodeSignedDelegateAction } from "near-kit";
import { describe, expect, it } from "vitest";
import { BUDGET, HEIGHT, HUB, OTHER_KEY, OTHER_SEED, OWNER, OWNER_KEY, RELAYER, TGAS, bodyOf, bodySignedBy, bytesOf, call, errorOf, harness, rawAction, rawBody, revoke } from "./helpers.ts";

/** Asserts a refusal and that nothing reached the chain. */
async function refused(h: ReturnType<typeof harness>, res: Response, status: number, code: string): Promise<string> {
  expect(res.status).toBe(status);
  const error = await errorOf(res);
  expect(error.code).toBe(code);
  expect(h.chain.submissions).toHaveLength(0);
  return error.message;
}

describe("GET /info and GET /health", () => {
  it("/info is exactly the published shape", async () => {
    const h = harness();
    const res = await h.app.request("/info");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ relayer: RELAYER, hub: HUB, network: "near:testnet", methods: ["revoke_budget", "reclaim", "payout"], maxGasTgas: 300 });
  });

  it("/info lists the configured methods, not a second hard-coded list", async () => {
    const h = harness({ methods: ["revoke_budget", "pause_agent"], maxGasTgas: 50 });
    expect(await (await h.app.request("/info")).json()).toMatchObject({ methods: ["revoke_budget", "pause_agent"], maxGasTgas: 50 });
  });

  it("/health reports the gas budget and the relayer's balance once it is read", async () => {
    const h = harness();
    h.chain.setBalance(RELAYER, 2n * 10n ** 24n);
    const first = (await (await h.app.request("/health")).json()) as { ok: boolean; gas: { usedTgas: number; budgetTgas: number; day: string }; pending: number };
    expect(first).toMatchObject({ ok: true, service: "payminto-relayer", network: "near:testnet", relayer: RELAYER, hub: HUB, pending: 0, gas: { usedTgas: 0, budgetTgas: 3_000, day: "2026-11-10" } });
    await new Promise((r) => setTimeout(r, 5));
    const second = (await (await h.app.request("/health")).json()) as { balance: { near: string; low: boolean } };
    expect(second.balance).toMatchObject({ near: "2.0000", low: false, error: null });
  });

  it("/health marks a low balance and logs a warning", async () => {
    const h = harness();
    h.chain.setBalance(RELAYER, 10n ** 23n);
    await h.app.request("/health");
    await new Promise((r) => setTimeout(r, 5));
    const body = (await (await h.app.request("/health")).json()) as { balance: { low: boolean; near: string } };
    expect(body.balance).toMatchObject({ low: true, near: "0.1000" });
    expect(h.logs.some((l) => l.includes("relayer balance is low"))).toBe(true);
  });

  it("answers an unknown route with a pointer to the real ones", async () => {
    const res = await harness().app.request("/nope");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).message).toContain("POST /relay");
  });

  it("allows the configured dashboard origin and no other", async () => {
    const h = harness({ corsOrigins: ["https://dash.example"] });
    const ok = await h.app.request("/info", { headers: { origin: "https://dash.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://dash.example");
    const other = await h.app.request("/info", { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /relay: sponsored calls", () => {
  it("relays a signed revoke and returns txHash, sender, receiver and methods", async () => {
    const h = harness();
    const body = bodyOf(revoke());
    const res = await h.post(body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["methods", "receiver", "sender", "txHash"]);
    expect(json).toMatchObject({ sender: OWNER, receiver: HUB, methods: ["revoke_budget"] });
    expect(json.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // The chain got the exact bytes the owner signed: the relayer cannot change them.
    expect(h.chain.submissions).toHaveLength(1);
    expect(Buffer.from(h.chain.submissions[0]!).toString("base64")).toBe(body.signedDelegate);
  });

  it("relays reclaim and payout, the other default methods", async () => {
    const h = harness();
    const reclaim = gasless.reclaimDelegate({ owner: OWNER, hub: HUB, budgetId: BUDGET, publicKey: OWNER_KEY.publicKey, nonce: 5n, maxBlockHeight: HEIGHT + 120n });
    const payout = gasless.payoutDelegate({ owner: OWNER, hub: HUB, accounts: ["seller.testnet"], publicKey: OWNER_KEY.publicKey, nonce: 6n, maxBlockHeight: HEIGHT + 120n });
    expect(((await (await h.post(bodyOf(reclaim))).json()) as { methods: string[] }).methods).toEqual(["reclaim"]);
    expect(((await (await h.post(bodyOf(payout))).json()) as { methods: string[] }).methods).toEqual(["payout"]);
    expect(h.chain.submissions).toHaveLength(2);
  });

  it("relays a method the operator added to the list, and refuses a default one the operator removed", async () => {
    const h = harness({ methods: ["revoke_budget", "pause_agent"] });
    const added = await h.post(bodyOf(revoke({ actions: [call("pause_agent")] })));
    expect(added.status).toBe(200);
    const removed = await h.post(bodyOf(revoke({ nonce: 6n, actions: [call("reclaim")] })));
    expect(removed.status).toBe(403);
    expect((await errorOf(removed)).code).toBe("NOT_SPONSORED");
    expect(h.chain.submissions).toHaveLength(1);
  });

  it("relays two allowed calls in one delegate when their gas fits the limit", async () => {
    const h = harness();
    const res = await h.post(bodyOf(revoke({ actions: [call("revoke_budget"), call("reclaim", { gas: 100n * TGAS })] })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { methods: string[] }).methods).toEqual(["revoke_budget", "reclaim"]);
  });

  it("accepts a function-call key that is limited to the hub and the method", async () => {
    const h = harness();
    h.chain.addKey(OWNER, OWNER_KEY.publicKey, 4n, { kind: "function_call", receiverId: HUB, methodNames: ["revoke_budget"] });
    expect((await h.post(bodyOf(revoke()))).status).toBe(200);
  });
});

describe("POST /relay: what is not sponsored (403 NOT_SPONSORED, nothing sent)", () => {
  it("refuses the same owner's call to any other contract", async () => {
    const h = harness();
    const message = await refused(h, await h.post(bodyOf(revoke({ receiverId: "usdc.fakes.testnet" }))), 403, "NOT_SPONSORED");
    expect(message).toContain("usdc.fakes.testnet is not the hub");
  });

  it("refuses a transfer hidden among function calls", async () => {
    const h = harness();
    const body = rawBody({
      actions: [rawAction.functionCall("revoke_budget", `{"budget_id":"${BUDGET}"}`, 30n * TGAS, 0n), rawAction.transfer(10n ** 24n), rawAction.functionCall("reclaim", "{}", 30n * TGAS, 0n)],
    });
    // The payload is a genuine, correctly signed delegate: an independent decoder reads the transfer in it.
    const kinds = decodeSignedDelegateAction(bytesOf(body)).signedDelegate.delegateAction.actions.map((a) => Object.keys(a)[0]);
    expect(kinds).toEqual(["functionCall", "transfer", "functionCall"]);
    const message = await refused(h, await h.post(body), 403, "NOT_SPONSORED");
    expect(message).toContain("transfer");
  });

  it.each([
    ["a transfer alone", rawAction.transfer(1n), "transfer"],
    ["adding a full-access key", rawAction.addFullAccessKey(OTHER_KEY.publicKey), "addKey"],
    ["deleting a key", rawAction.deleteKey(OWNER_KEY.publicKey), "deleteKey"],
    ["deleting the account", rawAction.deleteAccount("attacker.testnet"), "deleteAccount"],
    ["deploying a contract", rawAction.deployContract(Uint8Array.of(0, 97, 115, 109)), "deployContract"],
    ["staking", rawAction.stake(1n, OTHER_KEY.publicKey), "stake"],
    ["creating an account", rawAction.createAccount(), "createAccount"],
  ])("refuses %s", async (_name, action, kind) => {
    const h = harness();
    const body = rawBody({ actions: [action] });
    expect(Object.keys(decodeSignedDelegateAction(bytesOf(body)).signedDelegate.delegateAction.actions[0]!)[0]).toBe(kind);
    await refused(h, await h.post(body), 403, "NOT_SPONSORED");
  });

  it("refuses a deposit of 1 yoctoNEAR", async () => {
    const h = harness();
    const message = await refused(h, await h.post(bodyOf(revoke({ actions: [call("revoke_budget", { deposit: 1n })] }))), 403, "NOT_SPONSORED");
    expect(message).toContain("attaches 1 yoctoNEAR");
  });

  it("refuses a method that is not on the list", async () => {
    const h = harness();
    const message = await refused(h, await h.post(bodyOf(revoke({ actions: [call("fund_from_credit")] }))), 403, "NOT_SPONSORED");
    expect(message).toContain("revoke_budget, reclaim, payout");
  });

  it("refuses an allowed method followed by one that is not", async () => {
    const h = harness();
    await refused(h, await h.post(bodyOf(revoke({ actions: [call("revoke_budget"), call("set_settler")] }))), 403, "NOT_SPONSORED");
  });

  it("refuses more gas than the limit, per delegate", async () => {
    const h = harness({ maxGasTgas: 100 });
    await refused(h, await h.post(bodyOf(revoke({ actions: [call("revoke_budget", { gas: 101n * TGAS })] }))), 403, "NOT_SPONSORED");
    // Two calls that each fit, and together do not.
    await refused(h, await h.post(bodyOf(revoke({ actions: [call("revoke_budget", { gas: 60n * TGAS }), call("reclaim", { gas: 60n * TGAS })] }))), 403, "NOT_SPONSORED");
    expect((await h.post(bodyOf(revoke({ actions: [call("revoke_budget", { gas: 100n * TGAS })] })))).status).toBe(200);
  });

  it("refuses a call with no gas and a delegate with no actions", async () => {
    const h = harness();
    await refused(h, await h.post(bodyOf(revoke({ actions: [call("revoke_budget", { gas: 0n })] }))), 403, "NOT_SPONSORED");
    await refused(h, await h.post(bodyOf(revoke({ actions: [] }))), 403, "NOT_SPONSORED");
  });

  it("refuses the hub or the relayer as the sender", async () => {
    const h = harness();
    h.chain.addKey(HUB, OWNER_KEY.publicKey, 4n).addKey(RELAYER, OWNER_KEY.publicKey, 4n);
    await refused(h, await h.post(bodyOf(revoke({ senderId: HUB }))), 403, "NOT_SPONSORED");
    await refused(h, await h.post(bodyOf(revoke({ senderId: RELAYER }))), 403, "NOT_SPONSORED");
  });

  it("refuses a window that stays open too long", async () => {
    const h = harness({ maxTtlBlocks: 600 });
    await refused(h, await h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT + 601n }))), 403, "NOT_SPONSORED");
    expect((await h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT + 600n })))).status).toBe(200);
  });

  it("refuses a nonce the network would call too large", async () => {
    const h = harness();
    await refused(h, await h.post(bodyOf(revoke({ nonce: HEIGHT * 1_000_000n + 1n }))), 403, "NOT_SPONSORED");
  });
});

describe("POST /relay: signatures and keys (403 BAD_SIGNATURE, nothing sent)", () => {
  it("refuses a tampered signature", async () => {
    const h = harness();
    const bytes = bytesOf(bodyOf(revoke()));
    bytes[bytes.length - 1]! ^= 0x01;
    await refused(h, await h.post({ signedDelegate: Buffer.from(bytes).toString("base64") }), 403, "BAD_SIGNATURE");
  });

  it("refuses a delegate changed after it was signed", async () => {
    const h = harness();
    const signed = gasless.signDelegate(revoke(), new Uint8Array(32).fill(7));
    const other = gasless.revokeBudgetDelegate({ owner: OWNER, hub: HUB, budgetId: "cd".repeat(32), publicKey: OWNER_KEY.publicKey, nonce: 5n, maxBlockHeight: HEIGHT + 120n });
    await refused(h, await h.post(gasless.relayRequestBody({ delegateAction: other, signature: signed.signature })), 403, "BAD_SIGNATURE");
  });

  it("refuses a signature made by a key other than the one the delegate names", async () => {
    const h = harness();
    await refused(h, await h.post(bodySignedBy(revoke(), OTHER_SEED)), 403, "BAD_SIGNATURE");
  });

  it("refuses a key that is not on the sender's account, however valid its signature", async () => {
    const h = harness();
    // The attacker signs correctly with their own key and names the owner as sender.
    const body = bodyOf(revoke({ publicKey: OTHER_KEY.publicKey }), OTHER_SEED);
    const message = await refused(h, await h.post(body), 403, "BAD_SIGNATURE");
    expect(message).toContain(`is not an access key of ${OWNER}`);
  });

  it("refuses a sender account that does not exist", async () => {
    const h = harness();
    await refused(h, await h.post(bodyOf(revoke({ senderId: "ghost.testnet" }))), 403, "BAD_SIGNATURE");
  });

  it("refuses a function-call key for another contract, for another method, or with two calls", async () => {
    const h = harness();
    h.chain.addKey(OWNER, OWNER_KEY.publicKey, 4n, { kind: "function_call", receiverId: "game.testnet", methodNames: [] });
    await refused(h, await h.post(bodyOf(revoke())), 403, "BAD_SIGNATURE");
    h.chain.addKey(OWNER, OWNER_KEY.publicKey, 4n, { kind: "function_call", receiverId: HUB, methodNames: ["payout"] });
    await refused(h, await h.post(bodyOf(revoke())), 403, "BAD_SIGNATURE");
    h.chain.addKey(OWNER, OWNER_KEY.publicKey, 4n, { kind: "function_call", receiverId: HUB, methodNames: [] });
    await refused(h, await h.post(bodyOf(revoke({ actions: [call("revoke_budget"), call("reclaim")] }))), 403, "BAD_SIGNATURE");
  });

  it("refuses a key kind it does not know", async () => {
    const h = harness();
    h.chain.addKey(OWNER, OWNER_KEY.publicKey, 4n, { kind: "other", name: "GasKeyFullAccess" });
    await refused(h, await h.post(bodyOf(revoke())), 403, "BAD_SIGNATURE");
  });
});

describe("POST /relay: windows and nonces (409, nothing sent)", () => {
  it("refuses an expired window", async () => {
    const h = harness();
    await refused(h, await h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT - 1n }))), 409, "EXPIRED");
    await refused(h, await h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT }))), 409, "EXPIRED");
  });

  it("refuses a window too short to land, and accepts one block more", async () => {
    const h = harness({ expiryMarginBlocks: 5 });
    await refused(h, await h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT + 5n }))), 409, "EXPIRED");
    expect((await h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT + 6n })))).status).toBe(200);
  });

  it("refuses a nonce the key has already used", async () => {
    const h = harness();
    await refused(h, await h.post(bodyOf(revoke({ nonce: 4n }))), 409, "NONCE_USED");
    await refused(h, await h.post(bodyOf(revoke({ nonce: 3n }))), 409, "NONCE_USED");
  });

  it("does not send the same delegate twice", async () => {
    const h = harness();
    const body = bodyOf(revoke());
    const first = await h.post(body);
    expect(first.status).toBe(200);
    const { txHash } = (await first.json()) as { txHash: string };
    const again = await h.post(body);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("NONCE_USED");
    expect(h.chain.submissions).toHaveLength(1);
    // Even if the chain read still showed the old nonce, the relayer remembers what it sent.
    h.chain.addKey(OWNER, OWNER_KEY.publicKey, 4n);
    const third = await h.post(body);
    expect(third.status).toBe(409);
    expect(await errorOf(third)).toMatchObject({ code: "NONCE_USED", txHash });
    expect(h.chain.submissions).toHaveLength(1);
  });
});

describe("POST /relay: malformed requests (400 MALFORMED, nothing sent)", () => {
  const valid = () => bodyOf(revoke()).signedDelegate;

  it.each([
    ["a body that is not JSON", { raw: "signedDelegate=abc" }],
    ["an empty body", { raw: "" }],
    ["a JSON array", { raw: "[]" }],
    ["a body with no signedDelegate", { raw: '{"delegate":"abc"}' }],
    ["a signedDelegate that is not a string", { raw: '{"signedDelegate":12}' }],
    ["an empty signedDelegate", { raw: '{"signedDelegate":""}' }],
    ["a signedDelegate that is not base64", { raw: '{"signedDelegate":"not base64!!"}' }],
    ["base64url instead of base64", { raw: '{"signedDelegate":"ab-_"}' }],
    ["bytes that are no delegate", { raw: `{"signedDelegate":"${Buffer.from("hello relayer").toString("base64")}"}` }],
  ])("refuses %s", async (_name, opts) => {
    const h = harness();
    await refused(h, await h.post(undefined, opts), 400, "MALFORMED");
  });

  it("refuses a truncated delegate and one with trailing bytes", async () => {
    const h = harness();
    const bytes = bytesOf({ signedDelegate: valid() });
    await refused(h, await h.post({ signedDelegate: Buffer.from(bytes.subarray(0, bytes.length - 10)).toString("base64") }), 400, "MALFORMED");
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    await refused(h, await h.post({ signedDelegate: Buffer.from(padded).toString("base64") }), 400, "MALFORMED");
  });

  it("refuses a body over the size cap with 413", async () => {
    const h = harness({ maxBodyBytes: 1_024 });
    const res = await h.post({ signedDelegate: "A".repeat(4_000) });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.chain.submissions).toHaveLength(0);
  });
});

describe("error messages", () => {
  it("every refusal says what the caller should do next", async () => {
    const h = harness({ maxBodyBytes: 2_048 });
    h.chain.addKey("bob.testnet", OWNER_KEY.publicKey, 4n, { kind: "function_call", receiverId: "game.testnet", methodNames: [] });
    const cases: Array<Promise<Response> | Response> = [
      h.post(undefined, { raw: "nope" }),
      h.post({ signedDelegate: "!!" }),
      h.post({ signedDelegate: Buffer.from("junk").toString("base64") }),
      h.post({ signedDelegate: "A".repeat(4_000) }),
      h.post(bodyOf(revoke({ receiverId: "other.testnet" }))),
      h.post(rawBody({ actions: [rawAction.transfer(1n)] })),
      h.post(bodyOf(revoke({ actions: [call("nope")] }))),
      h.post(bodyOf(revoke({ actions: [call("revoke_budget", { deposit: 1n })] }))),
      h.post(bodyOf(revoke({ actions: [call("revoke_budget", { gas: 301n * TGAS })] }))),
      h.post(bodyOf(revoke({ actions: [] }))),
      h.post(bodySignedBy(revoke(), OTHER_SEED)),
      h.post(bodyOf(revoke({ publicKey: OTHER_KEY.publicKey }), OTHER_SEED)),
      h.post(bodyOf(revoke({ senderId: "bob.testnet" }))),
      h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT }))),
      h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT + 3n }))),
      h.post(bodyOf(revoke({ maxBlockHeight: HEIGHT + 10_000n }))),
      h.post(bodyOf(revoke({ nonce: 1n }))),
      h.app.request("/missing"),
    ];
    const next = /\b(Send|Sign|Build|Wait|Try|Remove|Encode|Check|Use|Fix|Look|serves)\b/;
    for (const res of await Promise.all(cases)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const error = await errorOf(res);
      expect(error.message.length).toBeGreaterThan(40);
      expect(error.message, error.code).toMatch(next);
    }
    expect(h.chain.submissions).toHaveLength(0);
  });
});
