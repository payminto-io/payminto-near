import { z } from "zod";
import type { AccountId } from "./account.ts";
import type { AgeAnswer } from "./facts.ts";
import { ReadError, defaultFetch, fetchJson, type FetchLike } from "./http.ts";
import type { NearNetwork } from "./rpc.ts";

/**
 * Where account creation times come from. NEAR RPC does not expose them: `view_account` describes the account now, and
 * walking back through archival blocks to find its first one is not practical. An indexer that stores the creating
 * transaction is the honest source, and it is a third party the caller chooses to trust.
 */
export interface AgeSource {
  /** Shown in reasons and facts, so a reader can see who vouched for the age. */
  readonly name: string;
  /** Throws `ReadError` when the source cannot answer. It must never estimate. */
  createdAt(account: AccountId): Promise<AgeAnswer>;
}

/**
 * NearBlocks API hosts. Paths and shapes follow API v3, read from https://api-testnet.nearblocks.io/api-docs/migration
 * and checked against live answers on 2026-11-10. Testnet serves v3 only, and v1 and v2 are announced to end on 2026-11-22.
 */
export const NEARBLOCKS_URLS: Record<NearNetwork, string> = {
  testnet: "https://api-testnet.nearblocks.io",
  mainnet: "https://api.nearblocks.io",
};

// GET /v3/accounts/{account} answers { data: null } for an account it has never seen, and
// { data: { account_id, created: {} } } for one it knows without a creation transaction.
const zAccount = z.object({
  data: z
    .object({
      account_id: z.string(),
      created: z.object({ block_timestamp: z.string().regex(/^\d{1,30}$/).optional(), transaction_hash: z.string().max(64).nullish() }),
    })
    .nullable(),
});

/**
 * Account creation times from the NearBlocks indexer. It answered without an API key on 2026-11-10; `apiKey` is sent
 * as a bearer token when given. The account id being checked is disclosed to NearBlocks.
 */
export function nearBlocksAgeSource(options: { network?: NearNetwork; baseUrl?: string; fetch?: FetchLike; timeoutMs?: number; apiKey?: string }): AgeSource {
  const base = (options.baseUrl ?? NEARBLOCKS_URLS[options.network ?? "testnet"]).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? defaultFetch;
  const headers: Record<string, string> = { accept: "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) };
  const name = "nearblocks";
  return {
    name,
    async createdAt(account) {
      const body = await fetchJson(fetchImpl, name, `${base}/v3/accounts/${encodeURIComponent(account)}`, { method: "GET", headers }, options.timeoutMs ?? 8_000);
      const parsed = zAccount.safeParse(body);
      if (!parsed.success) throw new ReadError("invalid_response", name, "nearblocks answered in an unexpected shape");
      const data = parsed.data.data;
      if (data === null) return { status: "not_indexed" };
      if (data.account_id !== account) throw new ReadError("invalid_response", name, "nearblocks answered for a different account");
      if (data.created.block_timestamp === undefined) return { status: "no_record" };
      // Block timestamps are nanoseconds since the Unix epoch, sent as a string.
      return { status: "known", createdAtMs: Number(BigInt(data.created.block_timestamp) / 1_000_000n), txHash: data.created.transaction_hash ?? null };
    },
  };
}
