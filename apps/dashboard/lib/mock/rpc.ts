/**
 * A NEAR JSON-RPC endpoint inside the browser, for NEXT_PUBLIC_MOCK. `NearReader` talks to it through `fetch` exactly
 * as it talks to a real RPC, so mock pages run the real proof code. Only views and `tx` are answered; nothing is sent.
 */
import { NearReader, type AccountId } from "@payminto/protocol";
import { DEMO_RPC_URL, READ_TIMEOUT_MS, type ReaderSource } from "../near-reader";

/** Thrown by a view handler to answer as the hub would when it panics. */
export class MockPanic extends Error {}

/** A view may answer later, as the demo DAO does while its add-on loads. */
export type MockView = (method: string, args: Record<string, unknown>) => unknown | Promise<unknown>;

export type MockRpcHandlers = {
  hub: AccountId;
  /** Returns the view's JSON value, or throws MockPanic. Unknown methods answer as a missing method. */
  view: MockView;
  /** Views of contracts other than the hub (a demo DAO); null answers as an account that does not exist. */
  contract?(account: AccountId): MockView | null;
  /** Final for a transaction the demo applied, unknown otherwise. */
  txFinal(hash: string): boolean;
  /** The panic of a transaction that reached the demo hub and failed there, or null. */
  txFailure?(hash: string): string | null;
  /** The nonce of an access key on a demo account, or null when the account has no such key. */
  accessKey?(account: AccountId, publicKey: string): { nonce: number } | null;
};

const DEMO_HEIGHT = 219_400_000;
// One demo chain per tab: every reader, the demo wallet and the demo relayer see the same height.
let height = DEMO_HEIGHT;
/** The demo chain's current block height. */
export const demoHeight = (): number => height;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeArgs(b64: string): Record<string, unknown> {
  const bin = atob(b64);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
}

function answer(id: unknown, body: { result?: unknown; error?: unknown }): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { status: 200, headers: { "content-type": "application/json" } });
}

const handlerError = (cause: string, data: string, info: Record<string, unknown> = {}) => ({ name: "HANDLER_ERROR", cause: { name: cause, info }, code: -32000, message: "Server error", data });

export function mockRpcFetch(h: MockRpcHandlers, latencyMs = 240): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    await delay(latencyMs);
    const req = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: Record<string, string> };
    height += 1;
    const block = { block_height: height, block_hash: `DemoBlock${height}` };
    if (req.method === "query" && req.params.request_type === "call_function") {
      const view = req.params.account_id === h.hub ? h.view : (h.contract?.(req.params.account_id!) ?? null);
      if (!view) return answer(req.id, { error: handlerError("UNKNOWN_ACCOUNT", `account ${req.params.account_id} does not exist while viewing`) });
      try {
        const value = await view(req.params.method_name!, decodeArgs(req.params.args_base64 ?? "e30="));
        return answer(req.id, { result: { ...block, logs: [], result: [...new TextEncoder().encode(JSON.stringify(value ?? null))] } });
      } catch (e) {
        const vm = `wasm execution failed with error: FunctionCallError(ExecutionError("Smart contract panicked: ${e instanceof Error ? e.message : String(e)}"))`;
        return answer(req.id, { error: handlerError("CONTRACT_EXECUTION_ERROR", vm, { vm_error: vm, ...block }) });
      }
    }
    if (req.method === "query" && req.params.request_type === "view_access_key") {
      const key = h.accessKey?.(req.params.account_id!, req.params.public_key!) ?? null;
      if (!key) return answer(req.id, { error: handlerError("UNKNOWN_ACCESS_KEY", `access key ${req.params.public_key} does not exist while viewing`) });
      return answer(req.id, { result: { ...block, nonce: key.nonce, permission: "FullAccess" } });
    }
    if (req.method === "block") return answer(req.id, { result: { header: { height, hash: block.block_hash } } });
    if (req.method === "tx") {
      const hash = req.params.tx_hash!;
      const failure = h.txFailure?.(hash) ?? null;
      if (failure === null && !h.txFinal(hash)) return answer(req.id, { error: handlerError("UNKNOWN_TRANSACTION", `Transaction ${hash} doesn't exist`) });
      const outcome = failure === null ? { SuccessValue: "" } : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${failure}` } } } } };
      return answer(req.id, { result: { final_execution_status: "FINAL", status: outcome, transaction: { hash }, receipts_outcome: [] } });
    }
    return answer(req.id, { error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND", info: {} }, code: -32601, message: "Method not found", data: req.method } });
  }) as typeof fetch;
}

export function mockReader(h: MockRpcHandlers): ReaderSource {
  const fetch = mockRpcFetch(h);
  return { reader: new NearReader({ rpcUrl: DEMO_RPC_URL, hub: h.hub, fetch, timeoutMs: READ_TIMEOUT_MS }), demo: true, fetch };
}
