import type { AccountId } from "@payminto/protocol";

/** Plain NEAR JSON-RPC `query` at final finality, for the two account facts NearRpcChain does not expose. */
async function query<T>(rpcUrl: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "payminto", method: "query", params: { finality: "final", ...params } }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`RPC ${rpcUrl} answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
    if (body.error) throw new Error(`RPC error: ${body.error.cause?.name ?? body.error.message ?? JSON.stringify(body.error)}`);
    if (!body.result || body.result.error) throw new Error(`RPC error: ${body.result?.error ?? "empty result"}`);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

/** An account's NEAR balance in yoctoNEAR and the bytes of storage it uses. */
export async function accountNear(rpcUrl: string, account: AccountId): Promise<{ amountYocto: bigint; storageBytes: number }> {
  const a = await query<{ amount: string; storage_usage: number }>(rpcUrl, { request_type: "view_account", account_id: account });
  return { amountYocto: BigInt(a.amount), storageBytes: a.storage_usage };
}

/** The hub account's deployed code hash (base58 sha256 of the wasm) and how many access keys it still has. */
export async function hubAccountFacts(rpcUrl: string, hub: AccountId): Promise<{ codeHash: string; accessKeys: number }> {
  const [account, keys] = await Promise.all([
    query<{ code_hash: string }>(rpcUrl, { request_type: "view_account", account_id: hub }),
    query<{ keys: unknown[] }>(rpcUrl, { request_type: "view_access_key_list", account_id: hub }),
  ]);
  return { codeHash: account.code_hash, accessKeys: keys.keys.length };
}
