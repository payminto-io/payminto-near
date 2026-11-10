import { isAccountId, type AccountId, type WalletTx } from "@payminto/chain";
import type { FetchLike } from "../intents/client.ts";
import type { ViewRpc } from "../rpc.ts";

/**
 * Omni Bridge, NEAR side. Contract ids from Near-One/omni-bridge README and bridge-sdk-js config; both answer views live.
 * The indexer API is documented by its OpenAPI file at
 * https://near-one.github.io/bridge-indexer-rs/omni-indexer-endpoint/openapi.json.
 */
export const OMNI = {
  mainnet: { bridge: "omni.bridge.near", api: "https://mainnet.api.bridge.nearone.org" },
  testnet: { bridge: "omni.n-bridge.testnet", api: "https://testnet.api.bridge.nearone.org" },
} as const;

/** `ChainKind` in near/omni-types, as the contract's JSON names it. */
export const CHAIN_KINDS = ["Eth", "Near", "Sol", "Arb", "Base", "Bnb", "Btc", "Zcash", "Pol", "HlEvm", "Strk", "Abs", "Fogo", "Aptos", "Avax"] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];

/** The `OmniAddress` text prefix of each chain (`OmniAddress::encode` in near/omni-types). */
export const OMNI_PREFIX: Record<ChainKind, string> = {
  Eth: "eth",
  Near: "near",
  Sol: "sol",
  Arb: "arb",
  Base: "base",
  Bnb: "bnb",
  Btc: "btc",
  Zcash: "zcash",
  Pol: "pol",
  HlEvm: "hlevm",
  Strk: "strk",
  Abs: "abs",
  Fogo: "fogo",
  Aptos: "aptos",
  Avax: "avax",
};
const EVM: ReadonlySet<ChainKind> = new Set(["Eth", "Arb", "Base", "Bnb", "Pol", "HlEvm", "Abs", "Avax"]);

/** `"<prefix>:<address>"`. EVM addresses are checked for shape only; other chains are passed through. */
export function omniAddress(chain: ChainKind, address: string): string {
  if (chain === "Near" && !isAccountId(address)) throw new Error("not a NEAR account id");
  if (EVM.has(chain) && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address for ${chain}`);
  if (!address) throw new Error("address is required");
  return `${OMNI_PREFIX[chain]}:${address}`;
}

/** `GET /api/v3/transfer-fee` response. `native_token_fee` is yoctoNEAR; `transferred_token_fee` is in the token's units. */
export type TransferFee = {
  native_token_fee: string | null;
  transferred_token_fee: string | null;
  gas_fee: string | null;
  protocol_fee: string | null;
  min_amount: string | null;
  usd_fee: number;
  insufficient_utxo: boolean;
};

/** `TransferStatusV4`. `Settled` is terminal. */
export type TransferStatusV4 = "Initialised" | "Signed" | "FastFinalisedOnNear" | "FinalisedOnNear" | "FastFinalised" | "Finalised" | "Settled";

export type TransferRef = { originChain: ChainKind; originNonce: number } | { transactionHash: string };

const refQuery = (r: TransferRef): URLSearchParams =>
  "transactionHash" in r ? new URLSearchParams({ transaction_hash: r.transactionHash }) : new URLSearchParams({ origin_chain: r.originChain, origin_nonce: String(r.originNonce) });

/** Read-only client for the Omni Bridge indexer API. Every method is a GET. */
export class OmniApi {
  readonly baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async #get<T>(path: string): Promise<T> {
    const res = await this.#fetch(`${this.baseUrl}${path}`, { method: "GET", headers: { accept: "application/json" } });
    const text = await res.text();
    if (res.status < 200 || res.status > 299) throw new Error(`Omni API ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  /**
   * Fee quote. It answers even for a token with no route to the destination (checked live for native USDC to Base), so
   * it never proves a route exists; use `tokenRoute` for that.
   */
  transferFee(p: { sender: string; recipient: string; token: string; amount: bigint }): Promise<TransferFee> {
    const q = new URLSearchParams({ sender: p.sender, recipient: p.recipient, token: p.token, amount: p.amount.toString() });
    return this.#get(`/api/v3/transfer-fee?${q.toString()}`);
  }

  async transferStatus(ref: TransferRef): Promise<TransferStatusV4[]> {
    return (await this.#get<{ statuses: TransferStatusV4[] }>(`/api/v4/transfers/transfer/status?${refQuery(ref).toString()}`)).statuses;
  }

  async transfer(ref: TransferRef): Promise<unknown[]> {
    return (await this.#get<{ transfers: unknown[] }>(`/api/v4/transfers/transfer?${refQuery(ref).toString()}`)).transfers;
  }
}

/**
 * The token's address on `chain` as the bridge knows it, or null when the bridge has no mapping. `init_transfer` does
 * not check this, so sending a token with no mapping locks it on NEAR; always check first.
 */
export async function tokenRoute(rpc: ViewRpc, bridge: AccountId, token: AccountId, chain: ChainKind): Promise<string | null> {
  return rpc.view<string | null>(bridge, "get_token_address", { chain_kind: chain, token });
}

/** `storage_deposit` on the bridge for `account`, which pays the bridge's storage and native fee for its transfers. */
export const bridgeStorageDepositTx = (bridge: AccountId, account: AccountId, deposit: bigint): WalletTx => ({
  receiverId: bridge,
  actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: account }, gas: "10000000000000", deposit: deposit.toString() } }],
});

/**
 * `ft_transfer_call` of `amount` to the bridge with an `InitTransferMsg` (`recipient`, `fee`, `native_token_fee`, `msg`),
 * 300 Tgas and 1 yoctoNEAR, as bridge-sdk-js builds it. `fee` is taken from the transferred amount and must be below it.
 */
export function initTransferTx(p: { token: AccountId; bridge: AccountId; amount: bigint; recipient: string; fee: bigint; nativeFee: bigint }): WalletTx {
  if (!isAccountId(p.token) || !isAccountId(p.bridge)) throw new Error("token and bridge must be NEAR account ids");
  if (p.amount <= 0n || p.fee < 0n || p.nativeFee < 0n) throw new Error("amounts must be positive and fees not negative");
  if (p.fee >= p.amount) throw new Error("fee must be below amount");
  const prefix = p.recipient.split(":")[0] ?? "";
  if (!Object.values(OMNI_PREFIX).includes(prefix) || prefix === "near") throw new Error("recipient must be an OmniAddress on another chain");
  const msg = JSON.stringify({ recipient: p.recipient, fee: p.fee.toString(), native_token_fee: p.nativeFee.toString(), msg: null });
  return {
    receiverId: p.token,
    actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: { receiver_id: p.bridge, amount: p.amount.toString(), memo: null, msg }, gas: "300000000000000", deposit: "1" } }],
  };
}

export type OutboundPlan = { route: string; txs: WalletTx[]; storageDeposit: bigint; nativeFee: bigint; fee: bigint; refusals: string[] };

/**
 * Plans a transfer out of NEAR: checks the route read-only, reads the signer's bridge storage and the bridge's storage
 * requirements, takes the fee from the indexer, and builds the storage deposit (if needed) and the transfer. It refuses
 * a token with no route. It sends nothing.
 */
export async function planOutbound(
  rpc: ViewRpc,
  api: OmniApi,
  p: { bridge: AccountId; token: AccountId; signer: AccountId; chain: ChainKind; recipient: string; amount: bigint; payFeeIn?: "native" | "token" },
): Promise<OutboundPlan> {
  const recipient = omniAddress(p.chain, p.recipient);
  const route = await tokenRoute(rpc, p.bridge, p.token, p.chain);
  if (route === null) {
    return { route: "", txs: [], storageDeposit: 0n, nativeFee: 0n, fee: 0n, refusals: [`${p.token} has no Omni Bridge route to ${p.chain}; the bridge would accept it but could not sign it, which can lock the tokens`] };
  }
  const quote = await api.transferFee({ sender: `near:${p.signer}`, recipient, token: `near:${p.token}`, amount: p.amount });
  const inToken = (p.payFeeIn ?? "native") === "token";
  const fee = inToken ? BigInt(quote.transferred_token_fee ?? "0") : 0n;
  const nativeFee = inToken ? 0n : BigInt(quote.native_token_fee ?? "0");
  const refusals: string[] = [];
  if (inToken && quote.transferred_token_fee === null) refusals.push("the indexer quotes no fee in this token; pay in NEAR instead");
  if (fee >= p.amount) refusals.push("the fee is not below the amount");
  if (quote.min_amount !== null && p.amount < BigInt(quote.min_amount)) refusals.push(`amount is below the minimum ${quote.min_amount}`);

  const [balance, forAccount, forInit] = await Promise.all([
    rpc.view<{ total: string; available: string } | null>(p.bridge, "storage_balance_of", { account_id: p.signer }),
    rpc.view<string>(p.bridge, "required_balance_for_account", {}),
    rpc.view<string>(p.bridge, "required_balance_for_init_transfer", {}),
  ]);
  // The bridge charges the signer's storage balance for the transfer record plus the native fee.
  const need = (balance === null ? BigInt(forAccount) : 0n) + BigInt(forInit) + nativeFee;
  const have = balance === null ? 0n : BigInt(balance.available);
  const storageDeposit = need > have ? need - have : 0n;
  const txs: WalletTx[] = [];
  if (refusals.length === 0) {
    if (storageDeposit > 0n) txs.push(bridgeStorageDepositTx(p.bridge, p.signer, storageDeposit));
    txs.push(initTransferTx({ token: p.token, bridge: p.bridge, amount: p.amount, recipient, fee, nativeFee }));
  }
  return { route, txs, storageDeposit, nativeFee, fee, refusals };
}
