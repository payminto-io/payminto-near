import type { AccountId, PublicKey } from "@payminto/protocol";

/**
 * Two NEAR RPC reads the gateway needs and the frozen `Chain` seam does not carry: whether a key is a full-access key of
 * an account (NEP-413 payout proofs), and what a transaction did (merchant refunds). Node-local on purpose; tests and
 * the fake-chain demo pass a fake.
 */

/** `full_access`, `function_call`, or null when the account has no such key (or does not exist). */
export type AccessKeyKind = "full_access" | "function_call" | null;

export interface AccessKeyReader {
  accessKey(account: AccountId, publicKey: PublicKey): Promise<AccessKeyKind>;
}

/** One NEP-141 `ft_transfer` a transaction made, read from its actions. */
export type FtTransfer = { token: AccountId; receiverId: AccountId; amount: bigint };

export type TxTransfers =
  | { status: "unknown" }
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "final"; signer: AccountId; transfers: FtTransfer[] };

export interface TxReader {
  /** The transfers of a transaction signed by `signer`, once it is final. */
  transfers(hash: string, signer: AccountId): Promise<TxTransfers>;
}

type RpcError = { name?: string; cause?: { name?: string }; message?: string; data?: unknown };

export class NearRpcError extends Error {
  readonly cause: RpcError;
  constructor(message: string, cause: RpcError) {
    super(message);
    this.name = "NearRpcError";
    this.cause = cause;
  }
}

const decodeArgs = (b64: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
  } catch {
    return null;
  }
};

/** JSON-RPC over fetch, at final finality. */
export class NearRpc implements AccessKeyReader, TxReader {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.#url = url;
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 10_000;
  }

  async #call(method: string, params: unknown): Promise<{ result?: any; error?: RpcError }> {
    const r = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "payminto", method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!r.ok) throw new NearRpcError(`RPC ${method} answered HTTP ${r.status}`, {});
    return (await r.json()) as { result?: any; error?: RpcError };
  }

  async accessKey(account: AccountId, publicKey: PublicKey): Promise<AccessKeyKind> {
    const r = await this.#call("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
    const cause = r.error?.cause?.name;
    if (cause === "UNKNOWN_ACCESS_KEY" || cause === "UNKNOWN_ACCOUNT") return null;
    // Older RPC nodes answer an unknown key with a result carrying `error`.
    if (r.result && typeof r.result.error === "string") return null;
    if (r.error) throw new NearRpcError(`view_access_key failed: ${r.error.cause?.name ?? r.error.name ?? r.error.message ?? "error"}`, r.error);
    const permission = r.result?.permission;
    if (permission === "FullAccess") return "full_access";
    if (permission && typeof permission === "object" && "FunctionCall" in permission) return "function_call";
    throw new NearRpcError("view_access_key returned an unknown permission", { data: permission });
  }

  async transfers(hash: string, signer: AccountId): Promise<TxTransfers> {
    const r = await this.#call("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
    const cause = r.error?.cause?.name;
    if (cause === "UNKNOWN_TRANSACTION") return { status: "unknown" };
    if (cause === "TIMEOUT_ERROR") return { status: "pending" };
    if (r.error) throw new NearRpcError(`tx failed: ${cause ?? r.error.name ?? r.error.message ?? "error"}`, r.error);
    const status = r.result?.status ?? {};
    if ("Failure" in status) return { status: "failed", error: JSON.stringify(status.Failure) };
    if (!("SuccessValue" in status)) return { status: "pending" };
    const tx = r.result.transaction as { signer_id: AccountId; receiver_id: AccountId; actions: Array<Record<string, any>> };
    // A failed receipt anywhere (the token's own ft_transfer) fails the transfer even when the transaction status is success.
    const failed = (r.result.receipts_outcome as Array<{ outcome?: { status?: Record<string, unknown> } }> | undefined)?.find((o) => o.outcome?.status && "Failure" in o.outcome.status);
    if (failed) return { status: "failed", error: JSON.stringify(failed.outcome!.status!.Failure) };
    const transfers: FtTransfer[] = [];
    for (const a of tx.actions ?? []) {
      const call = a.FunctionCall as { method_name?: string; args?: string } | undefined;
      if (!call || call.method_name !== "ft_transfer" || typeof call.args !== "string") continue;
      const args = decodeArgs(call.args) as { receiver_id?: unknown; amount?: unknown } | null;
      if (!args || typeof args.receiver_id !== "string" || typeof args.amount !== "string" || !/^\d+$/.test(args.amount)) continue;
      transfers.push({ token: tx.receiver_id, receiverId: args.receiver_id, amount: BigInt(args.amount) });
    }
    return { status: "final", signer: tx.signer_id, transfers };
  }
}
