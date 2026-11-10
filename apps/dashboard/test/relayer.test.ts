import { describe, expect, it } from "vitest";
import { depositBudgetTx, reclaimTx, revokeBudgetTx } from "@payminto/protocol";
import { RelayError, RelayerClient, relayErrorText, relayRefusal, type RelayerFetch, type RelayerInfo } from "@/lib/relayer";

const HUB = "hub.payminto.testnet";
const TOKEN = "usdc.fakes.testnet";
const BUDGET = "ab".repeat(32);
const INFO: RelayerInfo = { relayer: "relayer.payminto.testnet", hub: HUB, network: "near:testnet", methods: ["revoke_budget", "reclaim", "payout"], maxGasTgas: 300 };
const NODE = { hub: HUB, network: "near:testnet" as const };

/** A relayer that answers from a table and records what it was asked. Nothing leaves the test. */
function fakeRelayer(routes: Record<string, { status: number; body: unknown } | Error>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetch: RelayerFetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${init.method} ${new URL(url).pathname}`];
    if (!r) throw new Error(`no fixture for ${init.method} ${url}`);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { client: new RelayerClient("https://relayer.example.test/", { fetch }), calls };
}

const relayFails = async (status: number, error: Record<string, unknown>) => {
  const { client } = fakeRelayer({ "POST /relay": { status, body: { error } } });
  return (await client.relay("AAAA").catch((e: unknown) => e)) as RelayError;
};

describe("GET /info", () => {
  it("reads who the relayer is and what it pays for", async () => {
    const { client, calls } = fakeRelayer({ "GET /info": { status: 200, body: INFO } });
    expect(await client.info()).toEqual(INFO);
    expect(calls).toEqual([{ method: "GET", url: "https://relayer.example.test/info", body: undefined }]);
  });

  it("refuses an answer in another shape, and a relayer that cannot be reached", async () => {
    const odd = fakeRelayer({ "GET /info": { status: 200, body: { relayer: "Not An Account", hub: HUB } } });
    expect(await odd.client.info().catch((e: RelayError) => e.code)).toBe("BAD_RESPONSE");
    const down = fakeRelayer({ "GET /info": new TypeError("Failed to fetch") });
    const err = (await down.client.info().catch((e: unknown) => e)) as RelayError;
    expect(err.code).toBe("UNREACHABLE");
    expect(err.outcomeUnknown).toBe(false);
  });
});

describe("POST /relay", () => {
  it("posts the signed delegate as the contract says and returns the transaction", async () => {
    const receipt = { txHash: "6mYnuaNBup6Zf29v7zHsym9HfqVRpySqBVWnrFwCfho6", sender: "alice.testnet", receiver: HUB, methods: ["revoke_budget"] };
    const { client, calls } = fakeRelayer({ "POST /relay": { status: 200, body: receipt } });
    expect(await client.relay("c2lnbmVk")).toEqual(receipt);
    expect(calls[0]).toEqual({ method: "POST", url: "https://relayer.example.test/relay", body: { signedDelegate: "c2lnbmVk" } });
  });

  it("maps every refusal code, with the extra fields the relayer sends", async () => {
    for (const [status, code] of [[400, "MALFORMED"], [403, "NOT_SPONSORED"], [403, "BAD_SIGNATURE"], [409, "EXPIRED"], [413, "PAYLOAD_TOO_LARGE"]] as const) {
      const e = await relayFails(status, { code, message: "x" });
      expect([e.code, e.status, e.txHash, e.outcomeUnknown]).toEqual([code, status, null, false]);
    }
    expect((await relayFails(422, { code: "CALL_FAILED", message: "Smart contract panicked: NOT_OWNER", txHash: "Tx1" })).txHash).toBe("Tx1");
    expect((await relayFails(409, { code: "NONCE_USED", message: "already submitted", txHash: "Tx0" })).txHash).toBe("Tx0");
    expect((await relayFails(429, { code: "RATE_LIMITED", message: "slow down", retryAfterSec: 40 })).retryAfterSec).toBe(40);
    const unknown = await relayFails(502, { code: "RPC_FAILED", message: "sent, result unknown", outcomeUnknown: true, txHash: "Tx2" });
    expect([unknown.outcomeUnknown, unknown.txHash]).toEqual([true, "Tx2"]);
    expect((await relayFails(502, { code: "RPC_FAILED", message: "could not read", outcomeUnknown: false })).outcomeUnknown).toBe(false);
  });

  it("treats a code it does not know, or a body that is not the error shape, as an answer it cannot read", async () => {
    expect((await relayFails(418, { code: "TEAPOT", message: "?" })).code).toBe("BAD_RESPONSE");
    const html = fakeRelayer({ "POST /relay": { status: 404, body: "<html>not found</html>" } });
    expect(await html.client.relay("AAAA").catch((e: RelayError) => e.code)).toBe("BAD_RESPONSE");
    const crash = fakeRelayer({ "POST /relay": { status: 503, body: "" } });
    expect(await crash.client.relay("AAAA").catch((e: RelayError) => e.code)).toBe("UNREACHABLE");
  });
});

describe("what the person is told", () => {
  it("says what happened and what to do next, and never claims nothing was sent when something may have been", () => {
    const text = (code: RelayError["code"], extra = {}) => relayErrorText(new RelayError(code, "raw relayer words", null, extra));
    expect(text("NOT_SPONSORED")).toContain("Nothing was sent");
    expect(text("NOT_SPONSORED")).toContain("wallet that holds NEAR for gas");
    expect(text("RATE_LIMITED", { retryAfterSec: 10800 })).toContain("about 3 hours");
    expect(text("RATE_LIMITED", { retryAfterSec: 40 })).toContain("about 40 seconds");
    expect(text("RATE_LIMITED")).toContain("gas budget");
    expect(text("BAD_SIGNATURE")).toContain("key that is not on your account");
    expect(text("BAD_RESPONSE")).not.toContain("Nothing was sent");
    for (const code of ["MALFORMED", "EXPIRED", "NONCE_USED", "RPC_FAILED", "UNREACHABLE", "CALL_FAILED", "PAYLOAD_TOO_LARGE"] as const) {
      expect(text(code)).not.toContain("raw relayer words");
      expect(text(code)).not.toContain("\u2014");
    }
  });
});

describe("relayRefusal: checked before any wallet is asked", () => {
  const revoke = revokeBudgetTx(HUB, BUDGET);
  it("lets a zero-deposit hub call the relayer lists through", () => {
    expect(relayRefusal(INFO, NODE, revoke)).toBeNull();
    expect(relayRefusal(INFO, NODE, reclaimTx(HUB, BUDGET))).toBeNull();
    expect(relayRefusal({ ...INFO, network: "testnet" }, NODE, revoke)).toBeNull();
  });
  it("refuses a relayer for another hub or network", () => {
    expect(relayRefusal({ ...INFO, hub: "hub.someone-else.testnet" }, NODE, revoke)).toContain("hub.someone-else.testnet");
    expect(relayRefusal({ ...INFO, network: "near:mainnet" }, NODE, revoke)).toContain("mainnet");
  });
  it("refuses a method the relayer does not list, and more gas than it pays for", () => {
    expect(relayRefusal({ ...INFO, methods: ["reclaim"] }, NODE, revoke)).toContain("revoke_budget");
    expect(relayRefusal({ ...INFO, maxGasTgas: 10 }, NODE, revoke)).toContain("10 Tgas");
  });
  it("never carries anything with a deposit, or a call to another contract", () => {
    expect(relayRefusal({ ...INFO, hub: TOKEN, methods: ["ft_transfer_call"] }, { ...NODE, hub: TOKEN }, depositBudgetTx(TOKEN, HUB, BUDGET, 5n))).toContain("deposit");
    expect(relayRefusal(INFO, NODE, depositBudgetTx(TOKEN, HUB, BUDGET, 5n))).toContain("hub");
  });
});
