import { z } from "zod";
import type { AccountId } from "./account.ts";
import type { AccountView } from "./facts.ts";
import { ReadError, defaultFetch, fetchJson, type FetchLike } from "./http.ts";

export type NearNetwork = "testnet" | "mainnet";

/** Public RPC endpoints. Both answered the three read-only queries below on 2026-11-10. Pass your own for real traffic. */
export const NEAR_RPC_URLS: Record<NearNetwork, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

/** A second public endpoint per network, used when the first does not answer. Checked the same day. */
export const NEAR_RPC_FALLBACK_URLS: Record<NearNetwork, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

/** USDC, the settlement token, per network. */
export const SETTLEMENT_TOKENS: Record<NearNetwork, AccountId> = {
  testnet: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
};

export type AccessKey = {
  publicKey: string;
  permission: "full_access" | "function_call";
  /** The one contract a function-call key may call. Null for a full-access key. */
  receiverId: AccountId | null;
};

/** An account's access keys. `more` is true when the account has more keys than this reader was willing to page through. */
export type AccessKeyList = { keys: AccessKey[]; more: boolean };

export type StorageBalance = { total: string; available: string };

/** The three reads a check needs from NEAR. Implement it to use another transport, or use `FakeNearReader` in tests. */
export interface NearReader {
  /** The account at a final block, or null when it does not exist. */
  viewAccount(account: AccountId): Promise<AccountView | null>;
  /** The access keys of the account. Empty for a locked account, and also for an account that does not exist. */
  accessKeys(account: AccountId): Promise<AccessKeyList>;
  /** NEP-145 `storage_balance_of` on a token: null means the account is not registered with it. */
  storageBalanceOf(token: AccountId, account: AccountId): Promise<StorageBalance | null>;
}

const SOURCE = "near-rpc";

const zAccountView = z.object({
  amount: z.string(),
  locked: z.string(),
  code_hash: z.string().min(32).max(44),
  storage_usage: z.number(),
  global_contract_hash: z.string().nullish(),
  global_contract_account_id: z.string().nullish(),
  block_height: z.number(),
  block_hash: z.string(),
});

// A gas key is an access key that also holds a balance for gas. Its permission is one of the same two kinds.
const zReceiver = z.object({ receiver_id: z.string() });
const zKeyList = z.object({
  keys: z.array(
    z.object({
      public_key: z.string(),
      access_key: z.object({
        permission: z.union([
          z.literal("FullAccess"),
          z.object({ FunctionCall: zReceiver }),
          z.object({ GasKeyFullAccess: z.object({}) }),
          z.object({ GasKeyFunctionCall: zReceiver }),
        ]),
      }),
    }),
  ),
  /** Present when the list was cut short: the next request continues after this key. */
  last_key: z.string().nullish(),
});

/** Keys asked for per request. NEAR nodes refuse a larger page. */
const KEY_PAGE = 100;

const zCallResult = z.object({ result: z.array(z.number().int().min(0).max(255)) });
const zStorageBalance = z.object({ total: z.string(), available: z.string().default("0") }).nullable();

type Query =
  | { request_type: "view_account"; account_id: AccountId }
  | { request_type: "view_access_key_list"; account_id: AccountId; limit?: number; after_key?: string }
  | { request_type: "call_function"; account_id: AccountId; method_name: "storage_balance_of"; args_base64: string };

/** Internal marker for "no such account", which each read maps to its own empty value. */
class UnknownAccount extends Error {}
/** Internal marker for a key list too long for one answer, which `accessKeys` then reads page by page. */
class TooManyKeys extends Error {}

/** The name and text of an RPC failure, from either the structured `cause` or the older plain string. */
function failureOf(error: unknown): { name: string; text: string } {
  const e = (error ?? {}) as { cause?: { name?: unknown }; data?: unknown; message?: unknown };
  const name = typeof e.cause?.name === "string" ? e.cause.name : "";
  const text = typeof e.data === "string" ? e.data : typeof e.message === "string" ? e.message : "";
  return { name, text: text.slice(0, 200) };
}

function contractFailure(text: string): ReadError {
  if (/CodeDoesNotExist/.test(text)) return new ReadError("no_contract", SOURCE, "the account has no contract");
  if (/MethodNotFound/.test(text)) return new ReadError("method_missing", SOURCE, "the contract has no such method");
  return new ReadError("contract_error", SOURCE, "the view call failed inside the contract");
}

/**
 * A read-only NEAR JSON-RPC reader on plain `fetch`. It holds no key and can only send the three queries in `Query`,
 * all at `finality: "final"`, so nothing built on it can submit a transaction. It runs unchanged in a browser.
 */
export class RpcNearReader implements NearReader {
  readonly url: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  /** Pages of 100 keys read before giving up on the rest. Default 3. */
  readonly #maxKeyPages: number;

  constructor(options: { url: string; fetch?: FetchLike; timeoutMs?: number; maxKeyPages?: number }) {
    this.url = options.url;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#maxKeyPages = Math.max(1, options.maxKeyPages ?? 3);
  }

  /** Returns the `result` of one query. Throws `ReadError`; an unknown account is the error name `UNKNOWN_ACCOUNT`. */
  async #query(query: Query): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: "payminto", method: "query", params: { finality: "final", ...query } });
    const answer = await fetchJson(this.#fetch, SOURCE, this.url, { method: "POST", headers: { "content-type": "application/json" }, body }, this.#timeoutMs);
    if (typeof answer !== "object" || answer === null) throw new ReadError("invalid_response", SOURCE, "the RPC answer is not an object");
    const { error, result } = answer as { error?: unknown; result?: unknown };
    if (error !== undefined && error !== null) {
      const f = failureOf(error);
      if (f.name === "UNKNOWN_ACCOUNT" || /does not exist while viewing/.test(f.text)) throw new UnknownAccount();
      if (f.name === "TOO_MANY_ACCESS_KEYS") throw new TooManyKeys();
      if (f.name === "NO_CONTRACT_CODE") throw contractFailure("CodeDoesNotExist");
      if (f.name === "CONTRACT_EXECUTION_ERROR") throw contractFailure(f.text);
      throw new ReadError("rpc", SOURCE, `the RPC node answered with an error${f.name ? ` (${f.name})` : ""}`);
    }
    if (typeof result !== "object" || result === null) throw new ReadError("invalid_response", SOURCE, "the RPC answer has no result");
    // Some nodes report a failed view call inside a successful answer.
    const inner = (result as { error?: unknown }).error;
    if (typeof inner === "string") throw contractFailure(inner);
    return result;
  }

  async viewAccount(account: AccountId): Promise<AccountView | null> {
    let result: unknown;
    try {
      result = await this.#query({ request_type: "view_account", account_id: account });
    } catch (e) {
      if (e instanceof UnknownAccount) return null;
      throw e;
    }
    const v = parse(zAccountView, result, "view_account");
    return {
      amount: v.amount,
      locked: v.locked,
      codeHash: v.code_hash,
      storageUsage: v.storage_usage,
      globalContractHash: v.global_contract_hash ?? null,
      globalContractAccountId: v.global_contract_account_id ?? null,
      blockHeight: v.block_height,
      blockHash: v.block_hash,
    };
  }

  /**
   * One plain request serves an account with up to 100 keys on every node version. A node that refuses it for length,
   * or that cuts the list short, is then read page by page, up to `maxKeyPages` pages.
   */
  async accessKeys(account: AccountId): Promise<AccessKeyList> {
    const keys: AccessKey[] = [];
    let page: { limit?: number; after_key?: string } = {};
    for (let pages = 0; pages < this.#maxKeyPages; ) {
      let result: unknown;
      try {
        result = await this.#query({ request_type: "view_access_key_list", account_id: account, ...page });
      } catch (e) {
        if (e instanceof UnknownAccount) return { keys: [], more: false };
        if (e instanceof TooManyKeys && page.limit === undefined) {
          page = { limit: KEY_PAGE };
          continue;
        }
        throw e instanceof TooManyKeys ? new ReadError("rpc", SOURCE, "the RPC node refused a paged key list") : e;
      }
      pages++;
      const list = parse(zKeyList, result, "view_access_key_list");
      for (const k of list.keys) {
        const p = k.access_key.permission;
        if (p === "FullAccess" || "GasKeyFullAccess" in p) keys.push({ publicKey: k.public_key, permission: "full_access", receiverId: null });
        else keys.push({ publicKey: k.public_key, permission: "function_call", receiverId: ("FunctionCall" in p ? p.FunctionCall : p.GasKeyFunctionCall).receiver_id });
      }
      if (!list.last_key) return { keys, more: false };
      page = { limit: KEY_PAGE, after_key: list.last_key };
    }
    return { keys, more: true };
  }

  async storageBalanceOf(token: AccountId, account: AccountId): Promise<StorageBalance | null> {
    let result: unknown;
    try {
      result = await this.#query({
        request_type: "call_function",
        account_id: token,
        method_name: "storage_balance_of",
        args_base64: btoa(JSON.stringify({ account_id: account })),
      });
    } catch (e) {
      if (e instanceof UnknownAccount) throw new ReadError("no_contract", SOURCE, "the token account does not exist");
      throw e;
    }
    const bytes = parse(zCallResult, result, "call_function").result;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    } catch {
      throw new ReadError("invalid_response", SOURCE, "storage_balance_of did not return JSON");
    }
    return parse(zStorageBalance, value, "storage_balance_of");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new ReadError("invalid_response", SOURCE, `${what} answered in an unexpected shape`);
}

/**
 * A reader that asks each given reader in turn and returns the first answer. It moves on only when an endpoint itself
 * fails (timeout, network, HTTP or RPC error), never when it answers that a contract call failed.
 */
export function firstAnswering(readers: readonly NearReader[]): NearReader {
  if (readers.length === 0) throw new TypeError("firstAnswering needs at least one reader");
  const ENDPOINT_FAILURES = new Set(["timeout", "network", "http", "rpc", "invalid_response"]);
  async function each<T>(read: (r: NearReader) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const reader of readers) {
      try {
        return await read(reader);
      } catch (e) {
        if (!(e instanceof ReadError) || !ENDPOINT_FAILURES.has(e.code)) throw e;
        last = e;
      }
    }
    throw last;
  }
  return {
    viewAccount: (account) => each((r) => r.viewAccount(account)),
    accessKeys: (account) => each((r) => r.accessKeys(account)),
    storageBalanceOf: (token, account) => each((r) => r.storageBalanceOf(token, account)),
  };
}

/**
 * The endpoints a reader for `url` asks, in order. A network's public default endpoint is paired with the second
 * public endpoint for that network, because the public endpoints are rate limited and a 429 would otherwise fail every
 * look. Any other URL is an endpoint of your own, and stands alone: nothing you did not name is ever asked.
 */
export function rpcEndpoints(url: string): string[] {
  const network = (Object.keys(NEAR_RPC_URLS) as NearNetwork[]).find((n) => NEAR_RPC_URLS[n] === url.replace(/\/+$/, ""));
  return network ? [url, NEAR_RPC_FALLBACK_URLS[network]] : [url];
}

/**
 * The ready-made reader for an RPC URL: read-only JSON-RPC, with the second public endpoint tried when `url` is a
 * network's public default and does not answer (see `rpcEndpoints`). The node, the wallet and the command line all
 * read through this one function.
 */
export function rpcReader(url: string, options: { fetch?: FetchLike; timeoutMs?: number; maxKeyPages?: number } = {}): NearReader {
  const readers = rpcEndpoints(url).map((endpoint) => new RpcNearReader({ url: endpoint, ...options }));
  return readers.length === 1 ? readers[0]! : firstAnswering(readers);
}
