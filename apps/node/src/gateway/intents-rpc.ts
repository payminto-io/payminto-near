import { nep141Transfers, type AccountId, type Nep141Transfer, type PublicKey, type ReceiptOutcome } from "@payminto/protocol";
import type { AccessKeyKind } from "../near-rpc.ts";

/**
 * The NEAR reads of the any-chain checkout, on the chain the USDC lands on (NEAR mainnet live, the local chain when
 * simulated): whether the merchant's account exists, holds a full-access key and is registered with USDC, and what a
 * delivery transaction transferred. Read-only: it has no method that could send anything.
 */
export interface IntentsChainReader {
  accountExists(account: AccountId): Promise<boolean>;
  /** NEP-145: `storage_balance_of` is not null. */
  storageRegistered(token: AccountId, account: AccountId): Promise<boolean>;
  accessKey(account: AccountId, publicKey: PublicKey): Promise<AccessKeyKind>;
  /** The NEP-141 transfers a transaction made, from the `ft_transfer` events of its successful receipts. */
  delivery(hash: string, senders: readonly AccountId[]): Promise<DeliveryRead>;
}

/** One NEP-141 `ft_transfer` event: `token` is the contract that emitted it. */
export type DeliveryTransfer = Nep141Transfer;

export type DeliveryRead =
  | { status: "unknown" }
  | { status: "pending" }
  | { status: "final"; hash: string; transfers: DeliveryTransfer[] };

type RpcError = { name?: string; cause?: { name?: string }; message?: string };

/** The shared parser (`@payminto/chain`), which the browser's proof page uses too. */
export { nep141Transfers };

/** JSON-RPC over fetch at final finality, with a timeout. */
export class IntentsRpc implements IntentsChainReader {
  readonly url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.url = url;
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 10_000;
  }

  async #call(method: string, params: unknown): Promise<{ result?: any; error?: RpcError }> {
    if (!["query", "tx"].includes(method)) throw new Error(`refusing RPC method ${method}`);
    const r = await this.#fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "payminto", method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!r.ok) throw new Error(`RPC ${method} answered HTTP ${r.status}`);
    return (await r.json()) as { result?: any; error?: RpcError };
  }

  async #view<T>(contract: AccountId, method: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.#call("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    if (r.error) throw new Error(`view ${contract}.${method} failed: ${r.error.cause?.name ?? r.error.name ?? r.error.message ?? "error"}`);
    if (typeof r.result?.error === "string") throw new Error(`view ${contract}.${method} failed: ${r.result.error}`);
    return JSON.parse(Buffer.from(r.result.result as number[]).toString("utf8")) as T;
  }

  async accountExists(account: AccountId): Promise<boolean> {
    const r = await this.#call("query", { request_type: "view_account", finality: "final", account_id: account });
    if (r.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
    if (r.error) throw new Error(`view_account failed: ${r.error.cause?.name ?? r.error.name ?? "error"}`);
    return typeof r.result?.amount === "string";
  }

  async storageRegistered(token: AccountId, account: AccountId): Promise<boolean> {
    return (await this.#view<unknown>(token, "storage_balance_of", { account_id: account })) !== null;
  }

  async accessKey(account: AccountId, publicKey: PublicKey): Promise<AccessKeyKind> {
    const r = await this.#call("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
    const cause = r.error?.cause?.name;
    if (cause === "UNKNOWN_ACCESS_KEY" || cause === "UNKNOWN_ACCOUNT") return null;
    if (r.result && typeof r.result.error === "string") return null;
    if (r.error) throw new Error(`view_access_key failed: ${cause ?? r.error.name ?? "error"}`);
    const permission = r.result?.permission;
    if (permission === "FullAccess") return "full_access";
    if (permission && typeof permission === "object" && "FunctionCall" in permission) return "function_call";
    return null;
  }

  /**
   * NEAR RPC finds a transaction by its hash and its sender's shard, so each candidate sender is tried in turn. The first
   * that knows the transaction answers; none means it is unknown here (not yet, or never).
   */
  async delivery(hash: string, senders: readonly AccountId[]): Promise<DeliveryRead> {
    let pending = false;
    for (const sender of senders) {
      const r = await this.#call("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
      const cause = r.error?.cause?.name;
      if (cause === "UNKNOWN_TRANSACTION" || cause === "INVALID_TRANSACTION" || cause === "UNKNOWN_ACCOUNT") continue;
      if (cause === "TIMEOUT_ERROR") {
        pending = true;
        continue;
      }
      if (r.error) throw new Error(`tx failed: ${cause ?? r.error.name ?? r.error.message ?? "error"}`);
      const status = r.result?.status ?? {};
      if (!("SuccessValue" in status) && !("Failure" in status)) {
        pending = true;
        continue;
      }
      return { status: "final", hash, transfers: nep141Transfers((r.result?.receipts_outcome ?? []) as ReceiptOutcome[]) };
    }
    return pending ? { status: "pending" } : { status: "unknown" };
  }
}
