import { nep141Transfers, type AccountId, type Nep141Transfer, type PublicKey, type ReceiptOutcome } from "@payminto/protocol";
import { INTENTS_EVM_RPC_DEFAULTS, type IntentsEvmChain } from "../config.ts";
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

/** Settles like `p`, or rejects once `signal` aborts, whether or not the fetch honours the signal. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? onAbort() : err);
      },
    );
  });
}

/** JSON-RPC over fetch at final finality. Each call, its answer and its body, must finish within the timeout (10 s). */
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
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const timedOut = () => new Error(`NEAR RPC ${method} did not answer within ${this.#timeoutMs} ms`);
    const r = await untilAborted(
      this.#fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "payminto", method, params }),
        signal,
      }),
      signal,
      timedOut,
    );
    if (!r.ok) throw new Error(`RPC ${method} answered HTTP ${r.status}`);
    return (await untilAborted(r.json(), signal, timedOut)) as { result?: any; error?: RpcError };
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

// ---------------------------------------------------------------------------------------------------- EVM destinations

/** The EVM chains a business can receive USDC on, by their 1Click chain code. */
export type EvmChain = IntentsEvmChain;

/** Each chain's public JSON-RPC, what live mode reads unless INTENTS_RPC_<CHAIN> says otherwise. */
export const EVM_RPC_DEFAULTS = INTENTS_EVM_RPC_DEFAULTS;

/**
 * Blocks a delivery must be under before it counts: Ethereum a few (reorgs past three blocks are rare, and its
 * finality takes longer than the provider_only fallback), Polygon more (it has reorged deeper), and the rollups one (the
 * sequencer's block).
 */
export const EVM_CONFIRMATIONS: Record<EvmChain, number> = { base: 1, arb: 1, op: 1, eth: 3, pol: 16 };

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** One ERC-20 Transfer log: `token` is the contract that emitted it. Addresses lowercased. */
export type EvmTransfer = { token: string; from: string; to: string; amount: bigint };

export type EvmDeliveryRead =
  | { status: "unknown" }
  | { status: "pending" }
  | { status: "final"; hash: string; success: boolean; transfers: EvmTransfer[] };

/** What the EVM reader needs of fetch: the node's 1Click fetch has this shape too (tests route both to the fake server). */
export type RpcFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;
const HEX = /^0x[0-9a-fA-F]+$/;

/** The ERC-20 Transfer logs of a receipt (three topics, a 32-byte amount); removed and malformed logs are skipped. */
export function erc20Transfers(logs: unknown): EvmTransfer[] {
  if (!Array.isArray(logs)) return [];
  const out: EvmTransfer[] = [];
  for (const l of logs as Array<{ address?: unknown; topics?: unknown; data?: unknown; removed?: unknown }>) {
    if (!l || l.removed === true || typeof l.address !== "string" || !Array.isArray(l.topics) || l.topics.length !== 3) continue;
    const [t0, t1, t2] = l.topics as unknown[];
    if (typeof t0 !== "string" || t0.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    const from = typeof t1 === "string" ? ADDRESS_WORD.exec(t1) : null;
    const to = typeof t2 === "string" ? ADDRESS_WORD.exec(t2) : null;
    if (!from || !to || typeof l.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) continue;
    out.push({ token: l.address.toLowerCase(), from: `0x${from[1]!.toLowerCase()}`, to: `0x${to[1]!.toLowerCase()}`, amount: BigInt(l.data) });
  }
  return out;
}

/**
 * Reads a delivery on an EVM chain over JSON-RPC: the transaction receipt, and the head to count its confirmations.
 * Read-only: `eth_getTransactionReceipt` and `eth_blockNumber` are the only methods it sends. Each call must finish
 * within the timeout (10 s).
 */
export class EvmRpc {
  readonly #urls: Partial<Record<string, string | null>>;
  readonly #fetch: RpcFetch;
  readonly #timeoutMs: number;
  readonly #confirmations: Record<string, number>;

  constructor(urls: Partial<Record<EvmChain, string | null>>, o: { fetch?: RpcFetch; timeoutMs?: number; confirmations?: Partial<Record<EvmChain, number>> } = {}) {
    this.#urls = { ...urls };
    this.#fetch = o.fetch ?? (globalThis.fetch as unknown as RpcFetch);
    this.#timeoutMs = o.timeoutMs ?? 10_000;
    this.#confirmations = { ...EVM_CONFIRMATIONS, ...o.confirmations };
  }

  /** True when the node reads deliveries on this chain; false: they are confirmed on 1Click's word. */
  canRead(chain: string): boolean {
    return !!this.#urls[chain];
  }

  async #call(chain: string, method: "eth_getTransactionReceipt" | "eth_blockNumber", params: unknown[]): Promise<any> {
    const url = this.#urls[chain];
    if (!url) throw new Error(`no RPC for ${chain}`);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const timedOut = () => new Error(`${chain} RPC ${method} did not answer within ${this.#timeoutMs} ms`);
    const r = await untilAborted(
      this.#fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal }),
      signal,
      timedOut,
    );
    if (r.status < 200 || r.status >= 300) throw new Error(`${chain} RPC ${method} answered HTTP ${r.status}`);
    const body = JSON.parse(await untilAborted(r.text(), signal, timedOut)) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${chain} RPC ${method} failed: ${body.error.message ?? "error"}`);
    return body.result;
  }

  /** The receipt of `hash` on `chain`: unknown (no receipt yet), pending (too few confirmations), or final. */
  async delivery(chain: string, hash: string): Promise<EvmDeliveryRead> {
    const receipt = await this.#call(chain, "eth_getTransactionReceipt", [hash]);
    if (receipt === null || receipt === undefined) return { status: "unknown" };
    if (typeof receipt !== "object" || typeof receipt.blockNumber !== "string" || !HEX.test(receipt.blockNumber)) throw new Error(`${chain} RPC answered a receipt without a block number`);
    const head = await this.#call(chain, "eth_blockNumber", []);
    if (typeof head !== "string" || !HEX.test(head)) throw new Error(`${chain} RPC answered a block number that is not hex`);
    if (BigInt(head) - BigInt(receipt.blockNumber) + 1n < BigInt(this.#confirmations[chain] ?? 1)) return { status: "pending" };
    const success = receipt.status === "0x1";
    return { status: "final", hash, success, transfers: success ? erc20Transfers(receipt.logs) : [] };
  }
}
