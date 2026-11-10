/**
 * The node-local NEAR RPC reads against a scripted JSON-RPC endpoint (no network): access key kinds for NEP-413 payout
 * proofs, and ft_transfer actions of a refund transaction.
 */
import { describe, expect, it } from "vitest";
import { NearRpc, NearRpcError } from "../src/near-rpc.ts";

type Req = { method: string; params: Record<string, unknown> };

function rpc(answer: (r: Req) => unknown, status = 200) {
  const seen: Req[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Req & { jsonrpc: string };
    seen.push({ method: body.method, params: body.params });
    return new Response(JSON.stringify(answer(body)), { status });
  }) as unknown as typeof fetch;
  return { client: new NearRpc("http://rpc.test", { fetch: f }), seen };
}

const args = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const KEY = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" as const;

describe("view_access_key", () => {
  it("tells full-access keys from function-call keys and unknown ones, at final finality", async () => {
    const full = rpc(() => ({ jsonrpc: "2.0", id: "x", result: { nonce: 1, permission: "FullAccess" } }));
    expect(await full.client.accessKey("shop.testnet", KEY)).toBe("full_access");
    expect(full.seen[0]).toEqual({ method: "query", params: { request_type: "view_access_key", finality: "final", account_id: "shop.testnet", public_key: KEY } });
    const fc = rpc(() => ({ result: { permission: { FunctionCall: { allowance: "1", receiver_id: "hub.testnet", method_names: [] } } } }));
    expect(await fc.client.accessKey("shop.testnet", KEY)).toBe("function_call");
    const unknown = rpc(() => ({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } }));
    expect(await unknown.client.accessKey("shop.testnet", KEY)).toBeNull();
    const noAccount = rpc(() => ({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }));
    expect(await noAccount.client.accessKey("nobody.testnet", KEY)).toBeNull();
    const legacy = rpc(() => ({ result: { error: "access key ed25519:... does not exist while viewing" } }));
    expect(await legacy.client.accessKey("shop.testnet", KEY)).toBeNull();
  });

  it("throws on anything it cannot read, so a proof is never accepted on a failed read", async () => {
    await expect(rpc(() => ({ error: { name: "INTERNAL_ERROR", cause: { name: "UNAVAILABLE_SHARD" } } })).client.accessKey("shop.testnet", KEY)).rejects.toThrow(NearRpcError);
    await expect(rpc(() => ({}), 503).client.accessKey("shop.testnet", KEY)).rejects.toThrow(/HTTP 503/);
    await expect(rpc(() => ({ result: { permission: "Something" } })).client.accessKey("shop.testnet", KEY)).rejects.toThrow(/unknown permission/);
  });
});

describe("transaction transfers", () => {
  const tx = (status: Record<string, unknown>, actions: unknown[], receipts: unknown[] = []) => ({
    result: { status, transaction: { signer_id: "shop.testnet", receiver_id: "usdc.testnet", actions }, receipts_outcome: receipts },
  });

  it("reads ft_transfer actions of a successful final transaction", async () => {
    const r = rpc(() =>
      tx({ SuccessValue: "" }, [
        { FunctionCall: { method_name: "ft_transfer", args: args({ receiver_id: "payer.testnet", amount: "500000", memo: "refund" }), gas: 1, deposit: "1" } },
        { FunctionCall: { method_name: "storage_deposit", args: args({ account_id: "x.testnet" }), gas: 1, deposit: "1" } },
        { FunctionCall: { method_name: "ft_transfer", args: "not base64 json", gas: 1, deposit: "1" } },
      ]),
    );
    expect(await r.client.transfers("HASH", "shop.testnet")).toEqual({ status: "final", signer: "shop.testnet", transfers: [{ token: "usdc.testnet", receiverId: "payer.testnet", amount: 500_000n }] });
    expect(r.seen[0]).toEqual({ method: "tx", params: { tx_hash: "HASH", sender_account_id: "shop.testnet", wait_until: "FINAL" } });
  });

  it("reports failures, including a failed token receipt behind a successful transaction", async () => {
    expect(await rpc(() => tx({ Failure: { ActionError: { kind: "x" } } }, [])).client.transfers("H", "shop.testnet")).toMatchObject({ status: "failed" });
    const receiptFailed = rpc(() => tx({ SuccessValue: "" }, [], [{ outcome: { status: { SuccessValue: "" } } }, { outcome: { status: { Failure: { ActionError: { kind: "FunctionCallError" } } } } }]));
    expect(await receiptFailed.client.transfers("H", "shop.testnet")).toMatchObject({ status: "failed", error: expect.stringContaining("FunctionCallError") });
  });

  it("reports unknown and pending transactions without throwing", async () => {
    expect(await rpc(() => ({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } })).client.transfers("H", "shop.testnet")).toEqual({ status: "unknown" });
    expect(await rpc(() => ({ error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } })).client.transfers("H", "shop.testnet")).toEqual({ status: "pending" });
    expect(await rpc(() => tx({ NotStarted: null }, [])).client.transfers("H", "shop.testnet")).toEqual({ status: "pending" });
  });
});
