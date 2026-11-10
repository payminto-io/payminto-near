import type { FetchLike } from "./intents/client.ts";

/** Public RPC endpoints that answered read-only views on 2026-11-10. */
export const RPC_URLS = {
  mainnet: "https://rpc.mainnet.near.org",
  testnet: "https://rpc.testnet.near.org",
} as const;

/** The only JSON-RPC methods this package ever calls. None of them can submit a transaction. */
const READ_ONLY_METHODS = new Set(["query", "block"]);
const READ_ONLY_QUERIES = new Set(["call_function", "view_access_key", "view_account"]);

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * A read-only NEAR JSON-RPC reader. It refuses any method other than view queries and block reads, so code built on it
 * cannot broadcast a transaction even by mistake.
 */
export class ViewRpc {
  readonly url: string;
  readonly #fetch: FetchLike;

  constructor(url: string, fetchImpl?: FetchLike) {
    this.url = url;
    this.#fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!READ_ONLY_METHODS.has(method)) throw new RpcError(`refusing non-read-only RPC method ${method}`);
    if (method === "query" && !READ_ONLY_QUERIES.has(String(params.request_type))) throw new RpcError(`refusing query ${String(params.request_type)}`);
    const res = await this.#fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "payminto", method, params }),
    });
    const text = await res.text();
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new RpcError(`RPC ${res.status}: non-JSON body`);
    }
    if (j.error) throw new RpcError(`RPC error: ${JSON.stringify(j.error).slice(0, 300)}`);
    const result = j.result as Record<string, unknown> | undefined;
    if (!result) throw new RpcError("RPC returned no result");
    if (typeof result.error === "string") throw new RpcError(result.error);
    return result;
  }

  /** A view call at final finality, decoded as JSON. */
  async view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.#rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const bytes = r.result;
    if (!Array.isArray(bytes)) throw new RpcError("view returned no result bytes");
    return JSON.parse(Buffer.from(bytes as number[]).toString("utf8")) as T;
  }

  /** The nonce and permission of one access key, or null if the key is not on the account. */
  async accessKey(account: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown; blockHeight: bigint } | null> {
    try {
      const r = await this.#rpc("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
      return { nonce: BigInt(r.nonce as number), permission: r.permission, blockHeight: BigInt(r.block_height as number) };
    } catch (e) {
      if (e instanceof RpcError && /does not exist|UNKNOWN_ACCESS_KEY/i.test(e.message)) return null;
      throw e;
    }
  }

  /** Height of the latest final block. */
  async finalHeight(): Promise<bigint> {
    const r = await this.#rpc("block", { finality: "final" });
    const header = r.header as { height?: number } | undefined;
    if (typeof header?.height !== "number") throw new RpcError("block has no height");
    return BigInt(header.height);
  }
}

/** NEP-145 view: is `account` registered at `token`, and what does registration cost. */
export async function storageRegistration(rpc: ViewRpc, token: string, account: string): Promise<{ registered: boolean; minDeposit: string }> {
  const [balance, bounds] = await Promise.all([
    rpc.view<{ total: string } | null>(token, "storage_balance_of", { account_id: account }),
    rpc.view<{ min: string }>(token, "storage_balance_bounds", {}),
  ]);
  return { registered: balance !== null, minDeposit: bounds.min };
}
