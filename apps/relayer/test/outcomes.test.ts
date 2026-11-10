import { describe, expect, it } from "vitest";
import { SubmitError } from "../src/chain.ts";
import { createLogger } from "../src/logger.ts";
import { HUB, OWNER, OWNER_KEY, RELAYER, bodyOf, errorOf, harness, revoke } from "./helpers.ts";

describe("POST /relay: when the send goes wrong", () => {
  it("unknown outcome: 502 RPC_FAILED with outcomeUnknown true and the tx hash, and never a second send", async () => {
    const h = harness();
    h.chain.failNextSubmit = new SubmitError("unknown", "timeout: delegate of alice.testnet did not reach final execution", "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH");
    const body = bodyOf(revoke());
    const res = await h.post(body);
    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "RPC_FAILED", outcomeUnknown: true, txHash: "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH" });
    expect(error.message).toContain("will not send it again");
    expect(h.chain.submissions).toHaveLength(1);

    // The client retries the very same delegate. The relayer answers from memory and sends nothing.
    const retry = await h.post(body);
    expect(retry.status).toBe(409);
    expect(await errorOf(retry)).toMatchObject({ code: "NONCE_USED", txHash: "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH" });
    expect(h.chain.submissions).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("submission outcome unknown"))).toBe(true);
  });

  it("an error of a shape the relayer does not know counts as unknown, not as unsent", async () => {
    const h = harness();
    h.chain.failNextSubmit = new Error("socket hang up");
    const body = bodyOf(revoke());
    const res = await h.post(body);
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "RPC_FAILED", outcomeUnknown: true });
    expect((await h.post(body)).status).toBe(409);
    expect(h.chain.submissions).toHaveLength(1);
  });

  it("nothing sent: 502 RPC_FAILED with outcomeUnknown false, and the same delegate may be tried again", async () => {
    const h = harness();
    h.chain.failNextSubmit = new SubmitError("not_sent", "unavailable: Network request failed: fetch failed");
    const body = bodyOf(revoke());
    const res = await h.post(body);
    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "RPC_FAILED", outcomeUnknown: false });
    expect(error.txHash).toBeUndefined();
    expect(error.message).toContain("nothing was sent");
    const again = await h.post(body);
    expect(again.status).toBe(200);
    expect(h.chain.submissions).toHaveLength(2);
  });

  it("the network refuses the relayer's own transaction: 502, outcome known, logged as an operator problem", async () => {
    const h = harness();
    h.chain.failNextSubmit = new SubmitError("rejected", "Sender relayer.payminto.testnet does not have enough balance", "Tx1");
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "RPC_FAILED", outcomeUnknown: false });
    expect(error.message).toContain("operator");
    expect(h.logs.some((l) => l.includes('"level":"error"') && l.includes("refused the relayer's own transaction"))).toBe(true);
  });

  it("the chain read fails before anything is signed: 502, outcome known, nothing sent", async () => {
    const h = harness();
    h.chain.readsFail = true;
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "RPC_FAILED", outcomeUnknown: false });
    expect(h.chain.submissions).toHaveLength(0);
  });

  it("the nonce was taken while the request was on its way: 409 NONCE_USED with the tx hash", async () => {
    const h = harness();
    h.chain.failNextSubmit = new SubmitError("nonce_used", "DelegateActionInvalidNonce (delegate_nonce: 5, ak_nonce: 5)", "Tx2");
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "NONCE_USED", txHash: "Tx2" });
  });

  it("the window closed before the transaction ran: 409 EXPIRED", async () => {
    const h = harness();
    h.chain.failNextSubmit = new SubmitError("expired", "DelegateActionExpired", "Tx3");
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "EXPIRED", txHash: "Tx3" });
  });

  it("the key was removed before the transaction ran: 403 BAD_SIGNATURE", async () => {
    const h = harness();
    h.chain.failNextSubmit = new SubmitError("key_error", "DelegateActionAccessKeyError", "Tx4");
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("BAD_SIGNATURE");
  });

  it("the hub refuses the call: 422 CALL_FAILED with the hub's code, never a 200", async () => {
    const h = harness();
    h.chain.hubRefuses.set("revoke_budget", "NOT_OWNER");
    const res = await h.post(bodyOf(revoke()));
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("CALL_FAILED");
    expect(error.message).toContain("NOT_OWNER");
    expect(error.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // The protocol used the nonce, so the same delegate is not offered to the network again.
    expect((await h.post(bodyOf(revoke()))).status).toBe(409);
    expect(h.chain.submissions).toHaveLength(1);
  });
});

describe("logs", () => {
  const SECRET = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";

  it("never contain the signed delegate, a signature or a secret key", async () => {
    const h = harness();
    const ok = bodyOf(revoke());
    const signatureB64 = Buffer.from(Buffer.from(ok.signedDelegate, "base64").subarray(-64)).toString("base64");
    await h.post(ok);
    await h.post(bodyOf(revoke({ receiverId: "other.testnet" })));
    h.chain.failNextSubmit = new SubmitError("unknown", `boom ${SECRET}`, "Tx9");
    await h.post(bodyOf(revoke({ nonce: 6n })));
    h.chain.failNextSubmit = new Error(`relayerKey=${SECRET}`);
    await h.post(bodyOf(revoke({ nonce: 7n })));

    expect(h.logs.length).toBeGreaterThanOrEqual(4);
    const all = h.logs.join("\n");
    expect(all).not.toContain(ok.signedDelegate);
    expect(all).not.toContain(signatureB64);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SECRET.slice(8, 40));
    // What they do contain: who, what, and how it ended.
    const relayed = JSON.parse(h.logs.find((l) => l.includes('"msg":"relayed"'))!) as Record<string, unknown>;
    expect(relayed).toMatchObject({ level: "info", sender: OWNER, receiver: HUB, methods: ["revoke_budget"], gasTgas: 30 });
    const refusedLine = JSON.parse(h.logs.find((l) => l.includes('"msg":"relay refused"'))!) as Record<string, unknown>;
    expect(refusedLine).toMatchObject({ code: "NOT_SPONSORED", status: 403, sender: OWNER, receiver: "other.testnet" });
  });

  it("the logger redacts secret fields and secret-key-shaped strings wherever they appear", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    log.info(`key is ${SECRET}`, {
      relayerKey: SECRET,
      signature: "abc",
      signedDelegate: "def",
      nested: { private_key: SECRET, note: `leaked ${SECRET} here` },
      err: new Error(`bad ${SECRET}`),
      bytes: new Uint8Array(64),
      relayer: RELAYER,
      publicKey: OWNER_KEY.publicKey,
    });
    const line = lines[0]!;
    expect(line).not.toContain(SECRET.slice(8));
    expect(line).not.toContain('"abc"');
    expect(line).not.toContain('"def"');
    // Public values stay readable.
    expect(JSON.parse(line)).toMatchObject({ relayer: RELAYER, publicKey: OWNER_KEY.publicKey, bytes: "[64 bytes]", relayerKey: "[redacted]", signature: "[redacted]" });
  });
});
