import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { NearReadError, NearReader, checkReceiptOnChain, receiptFieldsJson, rootFromProof, type ReceiptFields } from "../src/index.ts";
import { receiptFieldsArgs } from "../src/node.ts";

/**
 * NEAR JSON-RPC answers in the shape the public RPC returns, kept in test/fixtures/rpc. Each fixture names the request it
 * answers; the fake fetch below refuses any other request, so the tests also pin what the reader sends.
 */
type Fixture = { note: string; request: { method: string; params: Record<string, unknown> }; response: unknown };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/rpc/${name}.json`, import.meta.url), "utf8")) as Fixture;

const merkle = JSON.parse(readFileSync(new URL("../vectors/merkle.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; hub: string; network: "near:testnet"; batch_id: string; root: string; receipts_in_leaf_order: Array<Record<string, string> & { proof: string[]; leaf_hex: string }> }>;
};
const vec = merkle.cases.find((c) => c.name === "leaves_5")!;
const r2 = vec.receipts_in_leaf_order[2]!;
const fields: ReceiptFields = {
  callId: r2.call_id!,
  budgetId: r2.budget_id!,
  payee: r2.payee!,
  amount: BigInt(r2.amount!),
  cumulative: BigInt(r2.cumulative!),
  requestHash: r2.request_hash!,
  timestampMs: BigInt(r2.timestamp_ms!),
  voucherSig: r2.voucher_sig!,
};

const RPC = "https://rpc.testnet.near.org";
/** The settler whose batch the vector is, as in the fixtures. */
const SETTLER = "node.payminto.testnet";

/** Decodes what the reader posted, in the fixture's request shape. */
function sent(init: RequestInit | undefined): Fixture["request"] {
  const body = JSON.parse(String(init?.body)) as { jsonrpc: string; method: string; params: Record<string, unknown> };
  expect(body.jsonrpc).toBe("2.0");
  const { args_base64, ...rest } = body.params as { args_base64?: string };
  const params = args_base64 === undefined ? rest : { ...rest, args: JSON.parse(new TextDecoder().decode(base64.decode(args_base64))) };
  return { method: body.method, params };
}

/** Answers each request with the next fixture, and fails the test on any request the fixture does not describe. */
function replay(...names: string[]): typeof fetch {
  const queue = names.map(fixture);
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(RPC);
    const f = queue.shift();
    if (!f) throw new Error("unexpected extra request");
    expect(sent(init)).toEqual(f.request);
    return new Response(JSON.stringify(f.response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const reader = (f: typeof fetch, timeoutMs?: number) => new NearReader({ rpcUrl: RPC, hub: vec.hub, fetch: f, timeoutMs });

describe("NearReader views", () => {
  it("reads a batch at final finality and reports the block", async () => {
    const r = await reader(replay("batch")).batch(vec.batch_id, SETTLER);
    expect(r.value).toEqual({ root: vec.root, settler: "node.payminto.testnet", gross: 15000n, net: 9000n, at: 1800000060000n });
    expect(r.blockHeight).toBe(219_402_871);
    expect(r.blockHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("returns null for a batch the hub never stored", async () => {
    expect((await reader(replay("batch-missing")).batch("ab".repeat(32), SETTLER)).value).toBeNull();
  });

  it("reads payments aligned with the ids asked for", async () => {
    const ids = ["0bafe22156d2698c143b86040446d366ead863ba600d5c924f3d15c786ef4057", "cd".repeat(32)];
    const r = await reader(replay("payments")).payments(ids);
    expect(r.value).toEqual([{ id: ids[0], merchant: "shop.testnet", amount: 25000000n, payer: "buyer.testnet", at: 1800000001000n }, null]);
  });

  it("sends verify_receipt the same field JSON as the server client", async () => {
    expect(receiptFieldsJson(fields)).toEqual(receiptFieldsArgs(fields));
    expect((await reader(replay("verify-receipt")).verifyReceipt(vec.batch_id, SETTLER, fields, r2.proof)).value).toBe(true);
  });
});

describe("NearReader errors", () => {
  it("names a missing hub account as not_found", async () => {
    await expect(reader(replay("unknown-account")).batch(vec.batch_id, SETTLER)).rejects.toMatchObject({ kind: "not_found", what: `${vec.hub}.batch` });
  });

  it("maps a hub panic to contract_error with the hub code", async () => {
    await expect(reader(replay("contract-panic")).verifyReceipt(vec.batch_id, SETTLER, fields, r2.proof)).rejects.toMatchObject({ kind: "contract_error", hubCode: "UNKNOWN_BUDGET" });
  });

  it("reads a panic that older nodes put inside a successful answer", async () => {
    const e = await reader(replay("legacy-panic")).batch(vec.batch_id, SETTLER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearReadError);
    expect(e).toMatchObject({ kind: "contract_error", hubCode: null });
  });

  it("aborts a slow RPC at the deadline", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    await expect(reader(hang, 20).batch(vec.batch_id, SETTLER)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports an unreachable RPC and a rate limit as unavailable", async () => {
    const down = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await expect(reader(down).batch(vec.batch_id, SETTLER)).rejects.toMatchObject({ kind: "unavailable" });
    const limited = (async () => new Response("Too Many Requests", { status: 429 })) as typeof fetch;
    await expect(reader(limited).batch(vec.batch_id, SETTLER)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("refuses an answer that is not a batch", async () => {
    const odd = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { block_hash: "x", block_height: 1, logs: [], result: [...new TextEncoder().encode('{"root":"nope"}')] } }))) as typeof fetch;
    await expect(reader(odd).batch(vec.batch_id, SETTLER)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("NearReader.txState", () => {
  const hash = "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH";
  it.each([
    ["tx-final", { status: "final" }],
    ["tx-pending", { status: "pending" }],
    ["tx-unknown", { status: "unknown" }],
    ["tx-failed", { status: "failed", error: "NOT_OWNER" }],
  ])("%s", async (name, want) => {
    expect(await reader(replay(name)).txState(hash, "buyer.testnet")).toEqual(want);
  });
});

describe("checkReceiptOnChain", () => {
  it("verifies when the recomputed root equals the stored root and the hub agrees", async () => {
    const c = await checkReceiptOnChain(reader(replay("batch", "verify-receipt")), { network: vec.network, batchId: vec.batch_id, settler: SETTLER, fields, proof: r2.proof });
    expect(c).toMatchObject({ rpcUrl: RPC, hub: vec.hub, batchId: vec.batch_id, settler: SETTLER, storedRoot: vec.root, recomputedRoot: vec.root, leaf: r2.leaf_hex, rootMatches: true, hubVerified: true, verified: true });
  });

  it("fails an altered receipt: the root no longer matches and the hub says false", async () => {
    const batch = replay("batch");
    let calls = 0;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      if (calls++ === 0) return batch(url, init);
      const answer = fixture("verify-receipt").response as { result: Record<string, unknown> };
      return new Response(JSON.stringify({ ...answer, result: { ...answer.result, result: [...new TextEncoder().encode("false")] } }));
    }) as typeof fetch;
    const altered = { ...fields, amount: fields.amount + 1n };
    const c = await checkReceiptOnChain(reader(f), { network: vec.network, batchId: vec.batch_id, settler: SETTLER, fields: altered, proof: r2.proof });
    expect(c).toMatchObject({ storedRoot: vec.root, rootMatches: false, hubVerified: false, verified: false });
    expect(c.recomputedRoot).not.toBe(vec.root);
    expect(rootFromProof(r2.leaf_hex, r2.proof)).toBe(vec.root);
  });

  it("does not verify a batch the hub does not have", async () => {
    const c = await checkReceiptOnChain(reader(replay("batch-missing")), { network: vec.network, batchId: "ab".repeat(32), settler: SETTLER, fields, proof: r2.proof });
    expect(c).toMatchObject({ storedRoot: null, rootMatches: false, hubVerified: null, verified: false });
  });
});

describe("NearReader.txTransfers", () => {
  const hash = "9sK2zUvbYgq7bhUGkNsrJtQJMdz6aRuC5U3hyGJxR7fH";
  const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const ev = (to: string, amount: string) => `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: "intents.near", new_owner_id: to, amount }] })}`;
  const final = {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: "intents.near", logs: [], status: { SuccessReceiptId: "r2" } } },
      { id: "r2", outcome: { executor_id: USDC, logs: [ev("shop.near", "1500000")], status: { SuccessValue: "" } } },
      { id: "r3", outcome: { executor_id: USDC, logs: [ev("shop.near", "9")], status: { Failure: { ActionError: {} } } } },
    ],
  };
  /** Answers by sender: an unknown transaction for every sender but `signer`. */
  const bySender = (signer: string, answer: unknown, asked: string[] = []): typeof fetch =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const req = sent(init);
      expect(req.method).toBe("tx");
      expect(req.params).toMatchObject({ tx_hash: hash, wait_until: "NONE" });
      const sender = String(req.params.sender_account_id);
      asked.push(sender);
      const body = sender === signer ? { jsonrpc: "2.0", id: "x", result: answer } : { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, message: "unknown" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("tries each sender until one knows the transaction, and returns the transfers of successful receipts only", async () => {
    const asked: string[] = [];
    const r = await reader(bySender("relay.near", final, asked)).txTransfers(hash, ["shop.near", "relay.near"]);
    expect(asked).toEqual(["shop.near", "relay.near"]);
    expect(r).toEqual({ status: "final", sender: "relay.near", transfers: [{ token: USDC, from: "intents.near", to: "shop.near", amount: 1_500_000n }] });
  });

  it("answers unknown when no sender knows it, pending before it is final, and failed with the reason", async () => {
    expect(await reader(bySender("nobody.near", final)).txTransfers(hash, ["shop.near"])).toEqual({ status: "unknown" });
    const notYet = { final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" }, receipts_outcome: [] };
    expect(await reader(bySender("shop.near", notYet)).txTransfers(hash, ["shop.near"])).toEqual({ status: "pending" });
    const failed = await reader(bySender("shop.near", { final_execution_status: "FINAL", status: { Failure: { ActionError: { kind: "x" } } }, receipts_outcome: [] })).txTransfers(hash, ["shop.near"]);
    expect(failed.status).toBe("failed");
  });

  it("refuses a sender that is not an account id", async () => {
    await expect(reader(bySender("shop.near", final)).txTransfers(hash, ["Not An Account"])).rejects.toThrow(/sender/);
  });
});
