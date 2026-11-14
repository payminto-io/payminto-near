/**
 * The any-chain checkout rail (method `oneclick`): a buyer pays from another chain through NEAR Intents (the 1Click
 * API) and the merchant receives exactly the invoice amount of USDC in its own NEAR account. The node, never the
 * browser, talks to 1Click: it builds every quote, checks the signed answer before a deposit address is shown, keeps
 * the whole signed quote, watches the status, and counts a payment only after it read the delivery on NEAR itself.
 *
 * The node core never imports @payminto/near-addons: this module only takes its types, and server.ts loads the package
 * with a dynamic import when INTENTS_CHECKOUT is not off. Nothing here signs or sends a transaction.
 */
import type * as Kit from "@payminto/near-addons/intents";
import {
  INTENTS_LABELS,
  INTENTS_QUOTE_STATUSES,
  intentsPayoutProofRequest,
  isTerminalPaymentStatus,
  newIntentsQuoteId,
  PAYOUT_PROOF_MAX_AGE_SECONDS,
  storageDepositTx,
  TERMINAL_INTENTS_STATUSES,
  verifyIntentsPayoutSignature,
  type AccountId,
  type IntentsCheckout,
  type IntentsDepositEvent,
  type IntentsOption,
  type IntentsOptions,
  type IntentsOrigin,
  type IntentsPayout,
  type IntentsPayoutProof,
  type IntentsPlatformStatus,
  type IntentsProofCredit,
  type IntentsQuote,
  type IntentsQuoteStatus,
  type IntentsStep,
  type IntentsSummary,
  type IntentsTx,
  type PaymentIntents,
  type PublicLinkIntents,
} from "@payminto/protocol";
import { INTENTS_EVM_RPC_DEFAULTS, type IntentsConfig, type IntentsEvmChain } from "../config.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { addCollector, INTENTS_ALERT_KINDS, intentsAlertsMetric, type IntentsAlertKind } from "../metrics.ts";
import { Mutex } from "../mutex.ts";
import { nowIso } from "../store.ts";
import type { CheckoutRail } from "./checkout.ts";
import { EvmRpc, type IntentsChainReader, type RpcFetch } from "./intents-rpc.ts";
import type { MerchantRow, MerchantService } from "./merchants.ts";
import { isoOf, type CreditRow, type PaymentRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";
import type { WebhookService } from "./webhooks.ts";

export type IntentsKit = typeof Kit;
type FetchLike = Kit.FetchLike;
type QuoteResponse = Kit.QuoteResponse;
type StatusResponse = Kit.StatusResponse;
type CheckoutOrigin = Kit.CheckoutOrigin;
type PayoutDestination = Kit.PayoutDestination;

/** An origin in JSON: `IntentsOrigin` with the token contract on its chain and the EVM chain id (null when not EVM). */
export type IntentsOriginJson = IntentsOrigin & { contract_address: string | null; chain_id: number | null };
/** Where the USDC of a quote lands. */
export type IntentsQuoteDestination = { chain: string; chain_name: string; symbol: "USDC"; address: string };
/** `IntentsQuote` with origin token details and its destination (packages/protocol does not carry these yet). */
export type IntentsQuoteJson = IntentsQuote & { origin: IntentsOriginJson; destination: IntentsQuoteDestination };
/** How the node confirms a delivery on a destination: reading it (`rpc`), or on 1Click's word (`provider_only`). */
export type DestinationVerify = "rpc" | "provider_only";
/** The business's destination on `GET /v1/merchant/intents-payout`. */
export type IntentsPayoutDestination = { chain: string; chain_name: string; symbol: "USDC"; asset: string; address: string | null; proven: boolean; verify: DestinationVerify };
/** One destination a business can choose. */
export type IntentsDestinationOption = { chain: string; chain_name: string; symbol: "USDC"; asset: string; decimals: 6; verify: DestinationVerify };
/** `IntentsPayout` with the default token and the destination (packages/protocol does not carry these yet). */
export type IntentsPayoutJson = IntentsPayout & { default_origin: string | null; destination: IntentsPayoutDestination; destinations: IntentsDestinationOption[] };
/** `IntentsCheckout` with the token the checkout pre-selects. */
export type IntentsCheckoutJson = IntentsCheckout & { default_origin: string | null };

/**
 * Names and EVM chain ids of the destinations, for code that runs without the kit (reports). The kit's
 * PAYOUT_DESTINATIONS is the source of asset ids and contracts; a test pins both to the same chains.
 */
export const DESTINATION_CHAINS: Record<string, { name: string; chainId: number | null; explorer: string | null }> = {
  near: { name: "NEAR", chainId: null, explorer: "https://nearblocks.io/txns/" },
  base: { name: "Base", chainId: 8453, explorer: "https://basescan.org/tx/" },
  arb: { name: "Arbitrum", chainId: 42161, explorer: "https://arbiscan.io/tx/" },
  eth: { name: "Ethereum", chainId: 1, explorer: "https://etherscan.io/tx/" },
  pol: { name: "Polygon", chainId: 137, explorer: "https://polygonscan.com/tx/" },
  op: { name: "Optimism", chainId: 10, explorer: "https://optimistic.etherscan.io/tx/" },
};

/** Where the USDC of a quote lands, as `settlement_network`: `near:mainnet`, `eip155:8453`, with ` (simulated)` when it is. */
export function settlementNetworkOf(mode: "live" | "simulated", chain: string): string {
  const id = DESTINATION_CHAINS[chain]?.chainId;
  const network = chain === "near" || id === undefined ? "near:mainnet" : `eip155:${id}`;
  return mode === "live" ? network : `${network} (simulated)`;
}

/** A wet quote is refused with less than this left before the payment expires. */
export const MIN_QUOTE_WINDOW_SEC = 600;
/** The longest a deposit address is asked for. */
export const QUOTE_TTL_SEC = 1_800;
/** Active quotes a payment may have at once. */
export const MAX_ACTIVE_QUOTES = 8;
/** Dry prices are reused this long per origin, amount and recipient. */
export const OPTIONS_CACHE_SEC = 30;
/** A 404 for a new deposit address is "not seen yet" for this long. */
export const NOT_FOUND_GRACE_SEC = 120;
/** After this, a delivery 1Click reports but the node cannot read is confirmed on 1Click's word (`provider_only`). */
export const PROVIDER_ONLY_AFTER_SEC = 600;
/** A quote whose address never saw a deposit is watched this long after its deadline, then marked expired. */
export const WATCH_AFTER_DEADLINE_SEC = 86_400;
/** A deposit address is only issued after the payout account's USDC registration was read this recently. */
export const REGISTRATION_CACHE_SEC = 300;
/** A quote that saw a deposit and is still not final this long after its deadline raises a `stuck` alert. */
export const STUCK_AFTER_SEC = 6 * 3600;
/** After a 401 or 403 from 1Click (a revoked or wrong API key) a quote is read again this often, not backed off. */
export const AUTH_RETRY_SEC = 900;
/** Quotes the watcher polls at once, so one hung 1Click or RPC call never stalls the others. */
export const WATCH_CONCURRENCY = 4;
/** The platform event of an operator alert, stored once per quote and kind; a platform webhook endpoint with `*` receives it. */
export const INTENTS_ALERT_EVENT = "intents.alert";
/** NEP-145 registration of native USDC on NEAR mainnet: 0.00125 NEAR (storage_balance_bounds, read live 2026-11-10). */
export const USDC_STORAGE_DEPOSIT = "1250000000000000000000";

export type QuoteRow = {
  id: string;
  payment_id: string;
  merchant_id: string;
  mode: "live" | "simulated";
  origin_asset: string;
  origin_chain: string;
  origin_symbol: string;
  origin_decimals: number;
  /** The business's account at quote time on the destination chain: a NEAR account, or an EVM address (lowercased). */
  recipient: AccountId;
  refund_to: string;
  refund_type: "ORIGIN_CHAIN" | "INTENTS";
  send_by_unix: number | null;
  slippage_bps: number;
  amount_out: string;
  amount_in: string;
  min_amount_in: string;
  amount_in_usd: string | null;
  refund_fee: string | null;
  withdraw_fee: string | null;
  time_estimate_sec: number;
  deposit_address: string;
  deposit_memo: string | null;
  deadline_unix: number;
  inactive_unix: number | null;
  correlation_id: string;
  signature_valid: number;
  quote_json: string;
  status: IntentsQuoteStatus;
  provider_status: string | null;
  deposited_amount: string | null;
  delivered_amount: string | null;
  refunded_amount: string | null;
  refund_reason: string | null;
  origin_txs: string;
  destination_txs: string;
  near_txs: string;
  delivery_tx: string | null;
  verification: "rpc_checked" | "provider_only" | null;
  delivered_unix: number | null;
  last_status_json: string | null;
  next_poll_unix: number;
  poll_errors: number;
  created_at: string;
  updated_at: string;
  /** Migration 009: `near`, or the EVM chain the USDC is delivered on, and its 1Click asset id (null on older rows). */
  destination_chain: string;
  destination_asset: string | null;
};

type WireTx = { hash: string; explorerUrl?: string };
type LastCall = NonNullable<IntentsPlatformStatus["last_call"]>;

const STEP_LABELS: Record<IntentsStep["key"], string> = {
  waiting: "Waiting for deposit",
  received: "Deposit received",
  converting: "Converting to USDC",
  delivered: "Delivered to merchant",
};
/** How many steps each state has finished, and whether the next one failed. */
const STEP_PROGRESS: Record<IntentsQuoteStatus, { done: number; failed: boolean }> = {
  awaiting_deposit: { done: 0, failed: false },
  incomplete_deposit: { done: 0, failed: false },
  deposit_detected: { done: 1, failed: false },
  processing: { done: 2, failed: false },
  delivered: { done: 3, failed: false },
  confirmed: { done: 4, failed: false },
  refunded: { done: 1, failed: true },
  failed: { done: 1, failed: true },
  expired: { done: 0, failed: true },
};
const ACTIVE: readonly IntentsQuoteStatus[] = ["awaiting_deposit", "deposit_detected", "incomplete_deposit", "processing", "delivered"];
/** Active states in which 1Click has seen a deposit: money is on its way. */
const DEPOSIT_SEEN: readonly IntentsQuoteStatus[] = ["deposit_detected", "incomplete_deposit", "processing", "delivered"];
const inList = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(", ");

const mask = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
const hhmm = (unix: number) => new Date(unix * 1000).toISOString().slice(11, 16);

/** A transaction hash on any of the origin chains: 0x and 64 hex (EVM), or base58 (Solana, NEAR). */
export const ORIGIN_TX_HASH = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,90})$/;

export type IntentsDeps = {
  config: IntentsConfig;
  kit: IntentsKit;
  reader: IntentsChainReader;
  /** The HTTP client for 1Click (tests pass the fake server's in-process fetch). */
  fetch?: FetchLike;
  db: Database;
  payments: PaymentService;
  merchants: MerchantService;
  webhooks: WebhookService;
  log: Logger;
  hub: AccountId;
  /** Unix seconds. */
  clock: () => number;
  /** Per 1Click request. Default the client's 15 s. */
  oneClickTimeoutMs?: number;
};

/** What the hosted page needs to offer `oneclick` on a payment, or null when this rail cannot take it now. */
export class IntentsRail implements CheckoutRail<IntentsCheckout> {
  readonly method = "oneclick";
  readonly #s: IntentsService;
  constructor(s: IntentsService) {
    this.#s = s;
  }
  offer(p: PaymentRow): IntentsCheckout | null {
    const view = this.#s.checkout(p);
    return view.available ? view : null;
  }
}

export class IntentsService {
  readonly mode: "simulated" | "live";
  readonly label: string;
  /** Where the USDC lands: `near:mainnet`, or `near:mainnet (simulated)`. */
  readonly settlementNetwork: string;
  readonly usdcContract: AccountId;
  readonly origins: readonly CheckoutOrigin[];
  readonly config: IntentsConfig;
  readonly kit: IntentsKit;
  readonly #reader: IntentsChainReader;
  /** Deliveries on EVM destinations: the chains' JSON-RPC live, the fake server's simulated chains when simulated. */
  readonly #evm: EvmRpc;
  readonly #client: Kit.OneClickClient;
  readonly #fetch: FetchLike;
  readonly #db: Database;
  readonly #payments: PaymentService;
  readonly #merchants: MerchantService;
  readonly #webhooks: WebhookService;
  readonly #log: Logger;
  readonly #hub: AccountId;
  readonly #clock: () => number;
  readonly #locks = new Map<string, { mutex: Mutex; users: number }>();
  readonly #options = new Map<string, { at: number; rows: Promise<IntentsOption[]> }>();
  #lastCall: LastCall | null = null;
  #rateRemaining: number | null = null;
  /** The USDC registration of payout accounts as last read, by account. */
  readonly #registration = new Map<AccountId, { at: number; registered: boolean }>();
  /** Alerts raised by this process, for the metric; `#alerted` also holds those found already in the event log. */
  readonly #alertCounts = Object.fromEntries(INTENTS_ALERT_KINDS.map((k) => [k, 0])) as Record<IntentsAlertKind, number>;
  readonly #alerted = new Set<string>();

  constructor(d: IntentsDeps) {
    const k = d.kit;
    this.config = d.config;
    this.kit = k;
    this.mode = d.config.mode;
    this.label = INTENTS_LABELS[this.mode];
    this.settlementNetwork = this.mode === "live" ? "near:mainnet" : "near:mainnet (simulated)";
    // Live mode always pays into native USDC on NEAR mainnet and checks quotes against the published 1Click key.
    if (this.mode === "live" && (d.config.usdcContract || d.config.managerPublicKey)) throw new Error("INTENTS_CHECKOUT=live always uses native USDC and the published 1Click key");
    if (this.mode === "live" && d.config.baseUrl !== k.ONECLICK_BASE_URL && !/^https:/.test(d.config.baseUrl)) throw new Error("INTENTS_CHECKOUT=live needs an https 1Click URL");
    if (this.mode === "simulated" && d.config.managerPublicKey === k.ONECLICK_MANAGER_PUBLIC_KEY) throw new Error("INTENTS_CHECKOUT=simulated must not use the published 1Click key");
    this.usdcContract = d.config.usdcContract ?? k.NEAR_MAINNET_USDC;
    const wanted = d.config.origins ?? k.CHECKOUT_ORIGINS.map((o) => o.assetId);
    const unknown = wanted.filter((a) => !k.originOf(a));
    if (unknown.length) throw new Error(`INTENTS_ORIGINS: not offered origins: ${unknown.join(", ")}`);
    this.origins = k.CHECKOUT_ORIGINS.filter((o) => wanted.includes(o.assetId));
    this.#reader = d.reader;
    this.#db = d.db;
    this.#payments = d.payments;
    this.#merchants = d.merchants;
    this.#webhooks = d.webhooks;
    this.#log = d.log;
    this.#hub = d.hub;
    this.#clock = d.clock;
    this.#fetch = this.#recording(d.fetch ?? (globalThis.fetch as unknown as FetchLike));
    // Simulated mode never reads a real chain: the fake 1Click server serves the receipts of its simulated deliveries.
    const evmUrls =
      d.config.evmRpcUrls ??
      (this.mode === "live"
        ? INTENTS_EVM_RPC_DEFAULTS
        : (Object.fromEntries(k.EVM_PAYOUT_CHAINS.map((c) => [c, `${d.config.baseUrl}/_fake/rpc/${c}`])) as Record<IntentsEvmChain, string>));
    this.#evm = new EvmRpc(evmUrls, { fetch: (d.fetch ?? globalThis.fetch) as unknown as RpcFetch });
    this.#client = new k.OneClickClient({
      baseUrl: d.config.baseUrl,
      ...(d.config.apiKey ? { apiKey: d.config.apiKey } : {}),
      ...(d.oneClickTimeoutMs ? { timeoutMs: d.oneClickTimeoutMs } : {}),
      fetch: this.#fetch,
    });
    addCollector(d.db, () => [intentsAlertsMetric(this.#alertCounts)]);
  }

  /** Every 1Click call goes through here: a timeout, the last call and the rate limit left, for the platform status. */
  #recording(inner: FetchLike): FetchLike {
    return async (url, init) => {
      const at = nowIso();
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      try {
        const res = await inner(url, init);
        const r = res as typeof res & { headers?: { get(n: string): string | null } };
        const remaining = r.headers?.get("x-ratelimit-remaining") ?? r.headers?.get("x-ratelimit-remaining-unauth") ?? null;
        if (remaining !== null && /^\d+$/.test(remaining)) this.#rateRemaining = Number(remaining);
        this.#lastCall = { at, method, path, status: res.status, ok: res.status >= 200 && res.status < 300, error: null };
        return res;
      } catch (err) {
        this.#lastCall = { at, method, path, status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    };
  }

  #mgr(): { managerPublicKey: string } | Record<string, never> {
    return this.config.managerPublicKey ? { managerPublicKey: this.config.managerPublicKey } : {};
  }

  /** Runs `fn` alone for this payment; the lock is dropped once nobody waits on it. */
  async #locked<T>(paymentId: string, fn: () => Promise<T>): Promise<T> {
    let l = this.#locks.get(paymentId);
    if (!l) this.#locks.set(paymentId, (l = { mutex: new Mutex(), users: 0 }));
    l.users++;
    try {
      return await l.mutex.run(fn);
    } finally {
      if (--l.users === 0) this.#locks.delete(paymentId);
    }
  }

  // ------------------------------------------------------------------ the merchant's NEAR account

  /**
   * Where the business receives USDC now: its NEAR account (the default), or its proven address on an EVM chain. Null
   * `recipient` until one is set.
   */
  destinationOf(m: MerchantRow): { dest: PayoutDestination; recipient: string | null; proven: boolean } {
    const chain = m.intents_destination_chain ?? "near";
    const evm = chain !== "near" ? this.kit.payoutDestinationOf(chain) : undefined;
    if (evm) return { dest: evm, recipient: m.intents_destination_address ?? null, proven: !!m.intents_destination_address && !!m.intents_destination_proven_at };
    return { dest: this.kit.payoutDestinationOf("near")!, recipient: m.intents_payout ?? null, proven: !!m.intents_payout && !!m.intents_payout_proven_at };
  }

  /** `rpc` when the node reads deliveries on this destination chain itself; `provider_only` when it takes 1Click's word. */
  verifyOn(chain: string): DestinationVerify {
    return chain === "near" || this.#evm.canRead(chain) ? "rpc" : "provider_only";
  }

  /**
   * The destination is ready: on NEAR the account is proven, exists and is registered with USDC; on an EVM chain the
   * address is proven. Only then can `oneclick` be on.
   */
  verified(m: MerchantRow): boolean {
    const d = this.destinationOf(m);
    if (d.dest.blockchain !== "near") return d.proven;
    return !!m.intents_payout && !!m.intents_payout_proven_at && m.intents_payout_registered === 1;
  }

  /** The token the checkout pre-selects, when it is still offered. */
  defaultOrigin(m: MerchantRow): string | null {
    const a = m.intents_default_origin ?? null;
    return a && this.origins.some((o) => o.assetId === a) ? a : null;
  }

  #destinationsJson(): IntentsDestinationOption[] {
    return this.kit.PAYOUT_DESTINATIONS.map((d) => ({ chain: d.blockchain, chain_name: d.chainName, symbol: "USDC", asset: d.assetId, decimals: 6, verify: this.verifyOn(d.blockchain) }));
  }

  #scope() {
    return { settlementNetwork: this.settlementNetwork, hub: this.#hub };
  }

  /** The proof request a wallet signs for this merchant and account (the dashboard builds the same one itself). */
  proofRequest(merchantId: string, account: AccountId, timestamp: number) {
    return intentsPayoutProofRequest(merchantId, account, timestamp, this.#scope());
  }

  async payoutView(m: MerchantRow, fresh = true): Promise<IntentsPayoutJson> {
    const account = m.intents_payout ?? null;
    let exists: boolean | null = null;
    let registered: boolean | null = account ? m.intents_payout_registered === 1 : null;
    if (account && fresh) {
      // Read now: a human may have just sent the storage_deposit. A failed read leaves the stored answer.
      try {
        [exists, registered] = await Promise.all([this.#reader.accountExists(account), this.#reader.storageRegistered(this.usdcContract, account)]);
        this.#registration.set(account, { at: this.#clock(), registered });
        if ((registered ? 1 : 0) !== m.intents_payout_registered) {
          this.#db.run("UPDATE merchants SET intents_payout_registered = ?, updated_at = ? WHERE id = ?", registered ? 1 : 0, nowIso(), m.id);
          m = this.#merchants.merchant(m.id);
        }
      } catch (err) {
        this.#log.warn("could not read the any-chain payout account", { merchantId: m.id, account, err });
        exists = null;
      }
    }
    const proven = !!account && !!m.intents_payout_proven_at;
    const d = this.destinationOf(m);
    const onNear = d.dest.blockchain === "near";
    return {
      object: "intents_payout",
      mode: this.mode,
      label: this.label,
      settlement_network: this.settlementNetwork,
      account,
      verified: this.verified(m) && (!onNear || exists !== false),
      checks: { exists, usdc_registered: registered, proven, proven_at: m.intents_payout_proven_at ?? null },
      usdc: { contract: this.usdcContract, asset_id: `nep141:${this.kit.NEAR_MAINNET_USDC}`, decimals: 6 },
      storage_step:
        onNear && account && registered === false
          ? {
              why: `${account} is not registered with USDC yet, so a delivery to it would fail. Send this storage_deposit from ${account} (it costs 0.00125 NEAR, once).`,
              deposit_near: "0.00125",
              transaction: storageDepositTx(this.usdcContract, account, USDC_STORAGE_DEPOSIT),
            }
          : null,
      enabled: this.#merchants.method(m.id, "oneclick")?.enabled === 1,
      proof_scope: { settlement_network: this.settlementNetwork, hub: this.#hub },
      checked_at: nowIso(),
      default_origin: this.defaultOrigin(m),
      destination: { chain: d.dest.blockchain, chain_name: d.dest.chainName, symbol: "USDC", asset: d.dest.assetId, address: d.recipient, proven: d.proven, verify: this.verifyOn(d.dest.blockchain) },
      destinations: this.#destinationsJson(),
    };
  }

  /**
   * Sets the merchant's NEAR account after checking, on the settlement chain: the NEP-413 signature (fresh, for this
   * merchant, this account and this node), that the key is a full-access key of the account, and that the account
   * exists. USDC registration is stored as read; without it the account is saved but not verified.
   */
  async setPayout(m: MerchantRow, account: AccountId, proof: IntentsPayoutProof): Promise<IntentsPayoutJson> {
    const age = this.#clock() - proof.timestamp;
    if (age > PAYOUT_PROOF_MAX_AGE_SECONDS || age < -60) throw new ApiError(400, "PAYOUT_PROOF_EXPIRED", `the signed timestamp must be within ${PAYOUT_PROOF_MAX_AGE_SECONDS}s`);
    if (!verifyIntentsPayoutSignature(account, proof, m.id, this.#scope())) {
      throw new ApiError(400, "PAYOUT_PROOF_INVALID", "the signature does not match the any-chain payout message for this business, account and node");
    }
    const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> =>
      fn().catch((err: unknown) => {
        this.#log.warn(`could not read ${what}`, { account, err });
        throw new ApiError(503, "CHAIN_UNAVAILABLE", `could not read ${what} from NEAR; try again`);
      });
    if (!(await read("the account", () => this.#reader.accountExists(account)))) {
      throw new ApiError(400, "ACCOUNT_NOT_FOUND", `${account} does not exist on ${this.mode === "live" ? "NEAR mainnet" : "the local chain"}`);
    }
    const kind = await read("the account's keys", () => this.#reader.accessKey(account, proof.public_key));
    if (kind !== "full_access") {
      throw new ApiError(400, "PAYOUT_PROOF_INVALID", kind === "function_call" ? "the signing key is a function-call key; sign with a full-access key of the account" : "the signing key is not a key of this account");
    }
    const registered = await read("the USDC registration", () => this.#reader.storageRegistered(this.usdcContract, account));
    const at = nowIso();
    // NEAR becomes the destination again; a proven EVM address stays on file for the record.
    this.#db.run(
      "UPDATE merchants SET intents_payout = ?, intents_payout_proven_at = ?, intents_payout_registered = ?, intents_payout_proof = ?, intents_destination_chain = 'near', intents_destination_asset = NULL, updated_at = ? WHERE id = ?",
      account,
      at,
      registered ? 1 : 0,
      JSON.stringify({ public_key: proof.public_key, signature: proof.signature, timestamp: proof.timestamp, settlement_network: this.settlementNetwork, hub: this.#hub }),
      at,
      m.id,
    );
    this.#log.info("any-chain payout account set", { merchantId: m.id, account, registered });
    if (m.intents_payout !== account || (m.intents_destination_chain ?? "near") !== "near") this.payoutChanged(m.id, account, "near");
    // Read the chain again for the answer, so every check has one (a page never shows "not read" right after a save).
    return this.payoutView(this.#merchants.merchant(m.id));
  }

  /**
   * Makes USDC on an EVM chain the destination, delivered to `address`, after checking the EIP-191 proof: signed by the
   * address, within the same window as the NEAR proof, for this business, this chain and this node. Nothing is read on
   * the chain: an EVM address needs no registration. Open quotes to the old destination expire.
   */
  async setEvmPayout(m: MerchantRow, chain: string, address: string, proof: { timestamp: number; signature: string }): Promise<IntentsPayoutJson> {
    const dest = this.kit.isEvmPayoutChain(chain) ? this.kit.payoutDestinationOf(chain) : undefined;
    if (!dest || dest.chainId === null) {
      const offered = this.kit.EVM_PAYOUT_CHAINS.join(", ");
      throw new ApiError(400, "DESTINATION_NOT_OFFERED", `USDC on ${chain} is not a destination here; choose one of ${offered}, or send { account, proof } for NEAR`);
    }
    if (!this.kit.isEvmAddress(address)) throw new ApiError(400, "INVALID_ADDRESS", `the address is not a valid ${dest.chainName} address`);
    const lower = address.toLowerCase();
    const age = this.#clock() - proof.timestamp;
    if (age > PAYOUT_PROOF_MAX_AGE_SECONDS || age < -60) throw new ApiError(400, "PAYOUT_PROOF_EXPIRED", `the signed timestamp must be within ${PAYOUT_PROOF_MAX_AGE_SECONDS}s`);
    const ok = await this.kit.verifyEvmPayoutProof({ merchantId: m.id, address: lower, timestamp: proof.timestamp, chainId: dest.chainId, hub: this.#hub, signature: proof.signature });
    if (!ok) throw new ApiError(400, "PAYOUT_PROOF_INVALID", "the signature does not match the any-chain payout message for this business, address, chain and node");
    const at = nowIso();
    this.#db.run(
      `UPDATE merchants SET intents_destination_chain = ?, intents_destination_asset = ?, intents_destination_address = ?, intents_destination_proof = ?,
              intents_destination_proven_at = ?, updated_at = ? WHERE id = ?`,
      dest.blockchain,
      dest.assetId,
      lower,
      JSON.stringify({ type: "eip191", timestamp: proof.timestamp, signature: proof.signature, chain_id: dest.chainId, hub: this.#hub }),
      at,
      at,
      m.id,
    );
    this.#log.info("any-chain payout destination set", { merchantId: m.id, chain: dest.blockchain, address: lower });
    if ((m.intents_destination_chain ?? "near") !== dest.blockchain || m.intents_destination_address !== lower) this.payoutChanged(m.id, lower, dest.blockchain);
    return this.payoutView(this.#merchants.merchant(m.id));
  }

  /** `PATCH /v1/merchant/intents-payout`: the token the checkout pre-selects, one of the offered origins, or none. */
  async setDefaultOrigin(m: MerchantRow, asset: string | null): Promise<IntentsPayoutJson> {
    if (asset !== null && !this.origins.some((o) => o.assetId === asset)) throw new ApiError(400, "ORIGIN_NOT_OFFERED", `${asset} is not an origin this checkout offers`);
    this.#db.run("UPDATE merchants SET intents_default_origin = ?, updated_at = ? WHERE id = ?", asset, nowIso(), m.id);
    return this.payoutView(this.#merchants.merchant(m.id));
  }

  /**
   * The business now receives any-chain payments at `account` on `chain` (`near` by default; null account: none). Every
   * open quote of the business to another account or chain that has seen no deposit (`awaiting_deposit`) is expired, so
   * no new money goes to the old destination; quotes with a deposit already seen keep theirs and are logged. Returns how
   * many expired. setPayout and setEvmPayout call it; call it too wherever else the destination changes.
   */
  payoutChanged(merchantId: string, account: string | null, chain = "near"): number {
    const stale = this.#db.all<QuoteRow>(
      `SELECT * FROM intents_quotes WHERE merchant_id = ? AND (recipient IS NOT ? OR destination_chain IS NOT ?) AND status IN (${inList(ACTIVE)})`,
      merchantId,
      account,
      chain,
    );
    const open = stale.filter((r) => r.status === "awaiting_deposit");
    let expired = 0;
    this.#db.tx(() => {
      for (const r of open) expired += Number(this.#db.run("UPDATE intents_quotes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_deposit'", nowIso(), r.id).changes);
      for (const paymentId of new Set(open.map((r) => r.payment_id))) this.#payments.notify(paymentId);
    });
    if (expired) this.#log.info("payout destination changed: open any-chain deposit addresses to the old destination expired", { merchantId, account, chain, expired, quoteIds: open.map((r) => r.id) });
    for (const r of stale.filter((x) => x.status !== "awaiting_deposit")) {
      this.#log.warn("payout destination changed while a deposit is on its way; it is still delivered to the old destination", { merchantId, quoteId: r.id, paymentId: r.payment_id, status: r.status, recipient: r.recipient, destinationChain: r.destination_chain, account, chain });
    }
    return expired;
  }

  /**
   * Before a deposit address is issued: the payout account's USDC registration, read again at most every
   * REGISTRATION_CACHE_SEC. Gone: the stored flag is cleared, so the method is greyed like an unfinished setup, and the
   * request is refused with the reason the availability check gives. A failed read keeps the stored answer.
   */
  async #ensureRegistered(p: PaymentRow, m: MerchantRow): Promise<void> {
    // Only a NEAR account needs a USDC registration; an EVM address takes an ERC-20 transfer as it is.
    if (this.destinationOf(m).dest.blockchain !== "near") return;
    const account = m.intents_payout;
    if (!account) return;
    const now = this.#clock();
    let cached = this.#registration.get(account);
    if (!cached || now - cached.at >= REGISTRATION_CACHE_SEC) {
      try {
        cached = { at: now, registered: await this.#reader.storageRegistered(this.usdcContract, account) };
        this.#registration.set(account, cached);
      } catch (err) {
        // The stored answer was "registered" (availability checked it); read again in a minute, not on every request.
        this.#log.warn("could not read the payout account's USDC registration; using the stored answer", { merchantId: m.id, account, err });
        this.#registration.set(account, { at: now - REGISTRATION_CACHE_SEC + 60, registered: true });
        return;
      }
    }
    if (cached.registered) return;
    if (m.intents_payout_registered === 1) {
      this.#db.run("UPDATE merchants SET intents_payout_registered = 0, updated_at = ? WHERE id = ? AND intents_payout = ?", nowIso(), m.id, account);
      this.#log.warn("the any-chain payout account is no longer registered with USDC; the method is greyed until it is", { merchantId: m.id, account });
    }
    const a = this.availability(p, this.#merchants.merchant(m.id));
    throw new ApiError(409, "INTENTS_UNAVAILABLE", a.reason ?? "This business has not finished setting up payments from other chains.");
  }

  /** `PUT /v1/merchants/{id}/methods` turning `oneclick` on. */
  assertCanEnable(m: MerchantRow): void {
    const d = this.destinationOf(m);
    if (d.dest.blockchain !== "near") {
      if (!d.proven) throw new ApiError(409, "INTENTS_PAYOUT_REQUIRED", `prove the ${d.dest.chainName} address for any-chain payments with a signed message first`);
      return;
    }
    if (!m.intents_payout) throw new ApiError(409, "INTENTS_PAYOUT_REQUIRED", "set a NEAR account for any-chain payments first (PUT /v1/merchant/intents-payout)");
    if (!m.intents_payout_proven_at) throw new ApiError(409, "INTENTS_PAYOUT_REQUIRED", "prove the NEAR account for any-chain payments with a signed message first");
    if (m.intents_payout_registered !== 1) throw new ApiError(409, "INTENTS_PAYOUT_NOT_REGISTERED", `${m.intents_payout} is not registered with USDC yet; send the storage_deposit shown by GET /v1/merchant/intents-payout`);
  }

  // ------------------------------------------------------------------ the hosted checkout

  /** Whether this payment can be paid from another chain now, and why not. */
  availability(p: PaymentRow, m: MerchantRow = this.#merchants.merchant(p.merchant_id)): { available: boolean; reason: string | null } {
    const no = (reason: string) => ({ available: false, reason });
    if (this.#merchants.method(m.id, "oneclick")?.enabled !== 1) return no("This business does not take payments from other chains.");
    if (!this.verified(m)) return no("This business has not finished setting up payments from other chains.");
    if (m.status !== "active") return no("This business is not taking payments.");
    if (isTerminalPaymentStatus(p.status) || this.#clock() >= p.expires_unix) return no("This payment is closed.");
    if (p.status === "processing") return no("A payment for this checkout is already being confirmed.");
    if (BigInt(p.fee_total) > 0n) return no("This payment carries a platform fee, which a payment from another chain cannot split off.");
    if (BigInt(p.amount_due) - BigInt(p.amount_paid) <= 0n) return no("Nothing is left to pay.");
    if (p.expires_unix - this.#clock() < MIN_QUOTE_WINDOW_SEC) return no("This checkout expires too soon to pay from another chain.");
    return { available: true, reason: null };
  }

  /**
   * `intents` on `GET /v1/links/public/{slug}`: whether a buyer of this link can pay from another chain. Each payment
   * still checks its own expiry window when it is created; this answers what the link can promise.
   */
  linkOffer(m: MerchantRow, amount: bigint | null): PublicLinkIntents {
    const no = (reason: string): PublicLinkIntents => ({ mode: this.mode, label: this.label, offered: false, reason });
    if (this.#merchants.method(m.id, "oneclick")?.enabled !== 1) return no("This business does not take payments from other chains.");
    if (!this.verified(m)) return no("This business has not finished setting up payments from other chains.");
    if (m.status !== "active") return no("This business is not taking payments.");
    if (amount !== null) {
      let fee = 0n;
      try {
        fee = this.#payments.quote(m, amount, null).fee_total;
      } catch {
        // Outside the business's limits: the link itself says so when a payment is started.
      }
      if (fee > 0n) return no("This payment carries a platform fee, which a payment from another chain cannot split off.");
    }
    return { mode: this.mode, label: this.label, offered: true, reason: null };
  }

  /** `intents` of each item of `GET /v1/payments`: the confirmed quote of each payment, else its newest one. */
  summaries(paymentIds: readonly string[]): Map<string, IntentsSummary> {
    const out = new Map<string, IntentsSummary>();
    if (!paymentIds.length) return out;
    const rows = this.#db.all<Pick<QuoteRow, "payment_id" | "mode" | "status" | "origin_asset" | "origin_chain" | "origin_symbol">>(
      `SELECT payment_id, mode, status, origin_asset, origin_chain, origin_symbol FROM intents_quotes WHERE payment_id IN (${paymentIds.map(() => "?").join(", ")})
       ORDER BY (status = 'confirmed') DESC, created_at DESC, rowid DESC`,
      ...paymentIds,
    );
    for (const r of rows) {
      if (out.has(r.payment_id)) continue;
      out.set(r.payment_id, {
        mode: r.mode,
        label: INTENTS_LABELS[r.mode],
        status: r.status,
        origin: { asset: r.origin_asset, chain: r.origin_chain, chain_name: this.kit.originOf(r.origin_asset)?.chainName ?? r.origin_chain, symbol: r.origin_symbol },
      });
    }
    return out;
  }

  /**
   * One any-chain credit of `GET /v1/checkout/{id}/proof`: the delivery transaction on NEAR read again now (the
   * evidence), and what 1Click last reported (its word, kept beside it). Null when the credit names no quote.
   */
  async proofCredit(c: CreditRow): Promise<IntentsProofCredit | null> {
    const r = c.intents_quote_id ? this.row(c.intents_quote_id) : undefined;
    if (!r) return null;
    const q = this.json(r);
    if (r.destination_chain !== "near") {
      let onChain: bigint | null = null;
      if (q.delivery_tx && this.#evm.canRead(r.destination_chain)) {
        const read = await this.#readEvm(r, [q.delivery_tx.hash]);
        if (read.allFinal) onChain = read.total;
      }
      return {
        method: "oneclick",
        amount: c.amount,
        payer: r.refund_type === "INTENTS" ? this.#payer(r) : `${r.origin_chain}:${mask(r.refund_to)}`,
        quote_id: r.id,
        mode: r.mode,
        label: INTENTS_LABELS[r.mode],
        settlement_network: q.settlement_network,
        token: this.#evmToken(r) ?? "",
        recipient: r.recipient,
        origin: q.origin,
        deposited: q.deposited,
        origin_txs: q.origin_txs,
        delivery_tx: q.delivery_tx,
        delivery_senders: [],
        oneclick: { status: r.provider_status, correlation_id: r.correlation_id, deposit_address: r.deposit_address, read_at: r.updated_at },
        verification: r.verification,
        delivered_on_chain: onChain === null ? null : onChain.toString(),
        verified: onChain === null ? null : onChain >= BigInt(c.amount),
      };
    }
    const senders = [...new Set([...this.config.deliverySenders, r.recipient])];
    let delivered: bigint | null = null;
    if (q.delivery_tx) {
      try {
        const read = await this.#reader.delivery(q.delivery_tx.hash, senders);
        if (read.status === "final") delivered = read.transfers.filter((t) => t.token === this.usdcContract && t.to === r.recipient).reduce((sum, t) => sum + t.amount, 0n);
      } catch (err) {
        this.#log.warn("could not read a delivery transaction for a proof", { quoteId: r.id, hash: q.delivery_tx.hash, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      method: "oneclick",
      amount: c.amount,
      payer: r.refund_type === "INTENTS" ? this.#payer(r) : `${r.origin_chain}:${mask(r.refund_to)}`,
      quote_id: r.id,
      mode: r.mode,
      label: INTENTS_LABELS[r.mode],
      settlement_network: q.settlement_network,
      token: this.usdcContract,
      recipient: r.recipient,
      origin: q.origin,
      deposited: q.deposited,
      origin_txs: q.origin_txs,
      delivery_tx: q.delivery_tx,
      delivery_senders: senders,
      oneclick: { status: r.provider_status, correlation_id: r.correlation_id, deposit_address: r.deposit_address, read_at: r.updated_at },
      verification: r.verification,
      delivered_on_chain: delivered === null ? null : delivered.toString(),
      verified: delivered === null ? null : delivered >= BigInt(c.amount),
    };
  }

  /** `intents` on the checkout view and its SSE stream. */
  checkout(p: PaymentRow): IntentsCheckoutJson {
    const m = this.#merchants.merchant(p.merchant_id);
    const a = this.availability(p, m);
    // The confirmed quote once there is one, so the receipt names the method and transactions that paid.
    const row = this.#db.get<QuoteRow>(
      "SELECT * FROM intents_quotes WHERE payment_id = ? AND status != 'expired' ORDER BY (status = 'confirmed') DESC, created_at DESC, rowid DESC LIMIT 1",
      p.id,
    );
    return {
      mode: this.mode,
      label: this.label,
      available: a.available,
      reason: a.reason,
      settlement_network: settlementNetworkOf(this.mode, this.destinationOf(m).dest.blockchain),
      active_quote: row ? this.json(row) : null,
      default_origin: this.defaultOrigin(m),
    };
  }

  /**
   * True while a quote of this payment has seen a deposit and is not final (deposit_detected, incomplete_deposit with a
   * deposit, processing, delivered): money is on its way, so the checkout must not take a second payment.
   */
  inFlight(paymentId: string): boolean {
    return !!this.#db.get<{ x: number }>(
      `SELECT 1 AS x FROM intents_quotes WHERE payment_id = ? AND (status IN ('deposit_detected', 'processing', 'delivered') OR (status = 'incomplete_deposit' AND deposited_amount IS NOT NULL)) LIMIT 1`,
      paymentId,
    );
  }

  /** `intents` on `GET /v1/payments/{id}`: every quote with its signed 1Click response, or null when there is none. */
  paymentIntents(paymentId: string): PaymentIntents | null {
    const rows = this.#db.all<QuoteRow>("SELECT * FROM intents_quotes WHERE payment_id = ? ORDER BY created_at, rowid", paymentId);
    if (!rows.length) return null;
    return { mode: this.mode, label: this.label, quotes: rows.map((r) => this.json(r, true)) };
  }

  #remaining(p: PaymentRow): bigint {
    return BigInt(p.amount_due) - BigInt(p.amount_paid);
  }

  /** The destination quotes deliver to now, with the business's account or address there. */
  #recipient(m: MerchantRow): { recipient: string; dest: PayoutDestination } {
    const d = this.destinationOf(m);
    if (!d.recipient) throw new ApiError(409, "INTENTS_UNAVAILABLE", "This business has not finished setting up payments from other chains.");
    return { recipient: d.recipient, dest: d.dest };
  }

  /** `GET /v1/checkout/{id}/intents/options`: each offered origin with an indicative dry price, or why it is greyed. */
  async options(p: PaymentRow): Promise<IntentsOptions> {
    const m = this.#merchants.merchant(p.merchant_id);
    const a = this.availability(p, m);
    if (!a.available) throw new ApiError(409, "INTENTS_UNAVAILABLE", a.reason!);
    await this.#ensureRegistered(p, m);
    const amount = this.#remaining(p);
    const { recipient, dest } = this.#recipient(m);
    const now = this.#clock();
    const key = `${amount}|${dest.assetId}|${recipient}`;
    let cached = this.#options.get(key);
    if (!cached || now - cached.at >= OPTIONS_CACHE_SEC) {
      cached = { at: now, rows: Promise.all(this.origins.map((o) => this.#dryOption(o, amount, recipient, dest))) };
      this.#options.set(key, cached);
      // Old entries go once they cannot be served any more.
      for (const [k, v] of this.#options) if (now - v.at >= OPTIONS_CACHE_SEC) this.#options.delete(k);
    }
    const rows = await cached.rows;
    return {
      object: "intents_options",
      payment_id: p.id,
      mode: this.mode,
      label: this.label,
      amount_out: { amount: amount.toString(), formatted: this.kit.formatUnits(amount, 6), symbol: "USDC" },
      recipient,
      settlement_network: settlementNetworkOf(this.mode, dest.blockchain),
      quoted_at: isoOf(cached.at),
      valid_until: isoOf(cached.at + OPTIONS_CACHE_SEC),
      options: rows,
    };
  }

  /** An origin with its token contract and EVM chain id, pinned in the kit (never fetched). */
  #originJson(o: Pick<CheckoutOrigin, "assetId" | "blockchain" | "chainName" | "symbol" | "decimals">): IntentsOriginJson {
    const pinned = this.kit.originOf(o.assetId);
    return { asset: o.assetId, chain: o.blockchain, chain_name: o.chainName, symbol: o.symbol, decimals: o.decimals, contract_address: pinned?.contractAddress ?? null, chain_id: pinned?.chainId ?? null };
  }

  async #dryOption(origin: CheckoutOrigin, amount: bigint, recipient: string, dest: PayoutDestination): Promise<IntentsOption> {
    const slippage = this.kit.slippageFor(origin, this.config.slippage);
    const base = { origin: this.#originJson(origin), slippage_bps: slippage };
    const greyed = (reason: string): IntentsOption => ({ ...base, available: false, reason, amount_in: null, amount_in_usd: null, time_estimate_sec: null, fees: null });
    const asked = this.kit.payInQuoteRequest({
      origin,
      amount,
      recipient,
      destination: dest,
      refundTo: this.kit.DRY_QUOTE_REFUND_TO[origin.addressFormat],
      slippageBps: slippage,
      deadline: (this.#clock() + QUOTE_TTL_SEC) * 1000,
      dry: true,
      ...(this.config.referral ? { referral: this.config.referral } : {}),
    });
    let res: QuoteResponse;
    try {
      res = await this.#client.quote(asked);
    } catch (err) {
      if (err instanceof this.kit.OneClickError) {
        this.#log.info("1Click refused a dry quote", { origin: origin.assetId, status: err.status, message: err.message });
        if (err.status === 429) return greyed("NEAR Intents is busy; try again in a minute.");
        return greyed(this.kit.quoteErrorReason(err.message.replace(/^1Click \d+: /, "")));
      }
      this.#log.warn("dry quote failed", { origin: origin.assetId, err });
      return greyed("NEAR Intents could not be reached; try again in a minute.");
    }
    const refusals = this.kit.checkPayInQuote(asked, res, { recipient, now: this.#clock() * 1000, ...this.#mgr() });
    if (refusals.length) {
      this.#log.error("a dry 1Click quote failed the checks; the origin is shown greyed", { origin: origin.assetId, correlationId: res.correlationId, refusals });
      return greyed("The price for this route could not be verified.");
    }
    const fees = this.kit.feeLines(res, origin);
    return { ...base, available: true, reason: null, amount_in: fees.send_exactly, amount_in_usd: res.quote.amountInUsd, time_estimate_sec: res.quote.timeEstimate, fees };
  }

  /**
   * `POST /v1/checkout/{id}/intents/quotes`: a wet quote, checked before its deposit address is stored or shown. An
   * active quote for the same origin and refund address with 10 minutes or more left is reused.
   */
  async createQuote(p0: PaymentRow, b: { origin_asset: string; refund_to?: string | undefined }): Promise<{ quote: IntentsQuote; reused: boolean }> {
    const origin = this.origins.find((o) => o.assetId === b.origin_asset);
    if (!origin) throw new ApiError(400, "ORIGIN_NOT_OFFERED", `${b.origin_asset} is not an origin this checkout offers`);
    if (b.refund_to !== undefined && !this.kit.isOriginAddress(origin, b.refund_to)) throw new ApiError(400, "INVALID_REFUND_ADDRESS", `the refund address is not a valid ${origin.chainName} address`);
    return this.#locked(p0.id, async () => {
      const p = this.#payments.row(p0.id)!;
      const m = this.#merchants.merchant(p.merchant_id);
      const a = this.availability(p, m);
      if (!a.available) throw new ApiError(409, "INTENTS_UNAVAILABLE", a.reason!);
      // No buyer address: a failed or short deposit goes back to the business's own NEAR Intents balance, and the business
      // returns it to the buyer (the one-screen checkout asks the buyer for nothing).
      const refundType = b.refund_to === undefined ? "INTENTS" : "ORIGIN_CHAIN";
      const refundTo = b.refund_to ?? m.intents_payout;
      if (!refundTo) throw new ApiError(400, "REFUND_ADDRESS_REQUIRED", `this business has no NEAR account for returned deposits; give a refund address on ${origin.chainName}`);
      // Even a reused address: a delivery to an account that is no longer registered would fail after the buyer paid.
      await this.#ensureRegistered(p, m);
      const amount = this.#remaining(p);
      const { recipient, dest } = this.#recipient(m);
      const now = this.#clock();
      const reuse = this.#db.get<QuoteRow>(
        `SELECT * FROM intents_quotes WHERE payment_id = ? AND origin_asset = ? AND refund_to = ? AND refund_type = ? AND recipient = ? AND destination_chain = ? AND amount_out = ?
           AND status = 'awaiting_deposit' AND COALESCE(send_by_unix, deadline_unix) >= ? ORDER BY created_at DESC LIMIT 1`,
        p.id,
        origin.assetId,
        refundTo,
        refundType,
        recipient,
        dest.blockchain,
        amount.toString(),
        now + MIN_QUOTE_WINDOW_SEC,
      );
      if (reuse) return { quote: this.json(reuse), reused: true };
      const active = this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM intents_quotes WHERE payment_id = ? AND status IN (${inList(ACTIVE)}) AND deadline_unix > ?`, p.id, now)!.n;
      if (active >= MAX_ACTIVE_QUOTES) throw new ApiError(409, "INTENTS_QUOTE_LIMIT", `this payment already has ${MAX_ACTIVE_QUOTES} deposit addresses waiting; use one of them`);
      const deadline = Math.min(p.expires_unix, now + QUOTE_TTL_SEC);
      if (deadline - now < MIN_QUOTE_WINDOW_SEC) throw new ApiError(409, "INTENTS_UNAVAILABLE", "This checkout expires too soon to pay from another chain.");
      const slippage = this.kit.slippageFor(origin, this.config.slippage);
      const asked = this.kit.payInQuoteRequest({
        origin,
        amount,
        recipient,
        destination: dest,
        refundTo,
        refundType,
        slippageBps: slippage,
        deadline: deadline * 1000,
        dry: false,
        ...(this.config.referral ? { referral: this.config.referral } : {}),
      });
      let res: QuoteResponse;
      try {
        res = await this.#client.quote(asked);
      } catch (err) {
        if (err instanceof this.kit.OneClickError) {
          this.#log.warn("1Click refused a quote", { paymentId: p.id, origin: origin.assetId, status: err.status, message: err.message, correlationId: err.correlationId });
          if (err.status === 429 || err.status >= 500) throw new ApiError(503, "INTENTS_BUSY", "NEAR Intents is busy; try again in a minute.");
          if (err.status === 401 || err.status === 403) {
            this.#alert("auth", p.id, `1Click refused this node's API key (HTTP ${err.status}) creating a deposit address; check ONECLICK_API_KEY`, { paymentId: p.id, merchantId: m.id });
          }
          throw new ApiError(502, "INTENTS_QUOTE_FAILED", this.kit.quoteErrorReason(err.message.replace(/^1Click \d+: /, "")), { provider_message: err.message });
        }
        this.#log.warn("1Click could not be reached", { paymentId: p.id, err });
        throw new ApiError(503, "INTENTS_BUSY", "NEAR Intents could not be reached; try again in a minute.");
      }
      const refusals = this.kit.checkPayInQuote(asked, res, { recipient, now: now * 1000, ...this.#mgr() });
      if (refusals.length) {
        // The deposit address of a refused quote is never stored or shown: nobody can be told to pay into it.
        this.#log.error("a 1Click quote failed the checks; no deposit address is shown", { paymentId: p.id, correlationId: res.correlationId, refusals });
        throw new ApiError(502, "INTENTS_QUOTE_REFUSED", "The quote from NEAR Intents did not pass this checkout's checks, so no deposit address is shown. Try again or pay another way.", { refusals });
      }
      const q = res.quote;
      const id = newIntentsQuoteId();
      const at = nowIso();
      this.#db.tx(() => {
        this.#db.run(
          `INSERT INTO intents_quotes (id, payment_id, merchant_id, mode, origin_asset, origin_chain, origin_symbol, origin_decimals, recipient, refund_to, slippage_bps,
                                      amount_out, amount_in, min_amount_in, amount_in_usd, refund_fee, withdraw_fee, time_estimate_sec, deposit_address, deposit_memo,
                                      deadline_unix, inactive_unix, correlation_id, signature_valid, quote_json, status, next_poll_unix, created_at, updated_at,
                                      destination_chain, destination_asset, refund_type, send_by_unix)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, 'awaiting_deposit', ?, ?, ?, ?, ?, ?, ?)`,
          id,
          p.id,
          m.id,
          this.mode,
          origin.assetId,
          origin.blockchain,
          origin.symbol,
          origin.decimals,
          recipient,
          refundTo,
          res.quoteRequest.slippageTolerance,
          amount.toString(),
          q.amountIn,
          q.minAmountIn,
          q.amountInUsd ?? null,
          q.refundFee ?? null,
          q.withdrawFee ?? null,
          q.timeEstimate,
          q.depositAddress!,
          Math.floor(Date.parse(q.deadline!) / 1000),
          q.timeWhenInactive ? Math.floor(Date.parse(q.timeWhenInactive) / 1000) : null,
          res.correlationId,
          JSON.stringify(res),
          now + 5,
          at,
          at,
          dest.blockchain,
          dest.assetId,
          refundType,
          deadline,
        );
        // The payment now shows the method a person is paying with.
        const cur = this.#payments.row(p.id)!;
        if (cur.quote_method !== "oneclick" && cur.status === "open" && this.#payments.credits(p.id).length === 0) this.#payments.requote(cur, "oneclick");
        this.#payments.notify(p.id);
      });
      this.#log.info("any-chain deposit address issued", { paymentId: p.id, quoteId: id, origin: origin.assetId, destination: dest.blockchain, amountIn: q.amountIn, correlationId: res.correlationId });
      return { quote: this.json(this.row(id)!), reused: false };
    });
  }

  row(id: string): QuoteRow | undefined {
    return this.#db.get<QuoteRow>("SELECT * FROM intents_quotes WHERE id = ?", id);
  }

  /** A quote of this payment, or 404 (ids never leak across payments). */
  quoteOf(p: PaymentRow, qid: string): QuoteRow {
    const r = this.row(qid);
    if (!r || r.payment_id !== p.id) throw new ApiError(404, "NOT_FOUND", "no such quote for this payment");
    return r;
  }

  /** `POST .../deposit`: tells 1Click about the buyer's transaction (it only speeds detection) and checks now. */
  async submitDeposit(r: QuoteRow, txHash: string): Promise<QuoteRow> {
    try {
      await this.#client.submitDeposit({ txHash, depositAddress: r.deposit_address });
    } catch (err) {
      // The deposit is found without it; the buyer is not told anything went wrong.
      this.#log.warn("1Click did not take the deposit transaction", { quoteId: r.id, err });
    }
    return this.checkNow(r.id);
  }

  /** `POST .../simulate`, simulated mode only: the fake server's control API reports a deposit. */
  async simulateDeposit(r: QuoteRow, amount: bigint): Promise<QuoteRow> {
    if (this.mode !== "simulated") throw new ApiError(404, "NOT_FOUND", "not found");
    if (TERMINAL_INTENTS_STATUSES.includes(r.status)) throw new ApiError(409, "QUOTE_CLOSED", `this quote is ${r.status}`);
    const res = await this.#fetch(`${this.config.baseUrl}/_fake/deposits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depositAddress: r.deposit_address, amount: amount.toString() }),
    });
    if (res.status !== 200) throw new ApiError(409, "SIMULATION_REFUSED", `the fake 1Click server refused the deposit: ${(await res.text()).slice(0, 200)}`);
    this.#log.info("simulated deposit reported to the fake 1Click server", { quoteId: r.id, amount: amount.toString() });
    return this.checkNow(r.id);
  }

  // ------------------------------------------------------------------ the watcher's work

  readonly #inflight = new Map<string, Promise<void>>();

  /** Polls one quote now (shared with a tick that is polling it already). */
  async checkNow(id: string): Promise<QuoteRow> {
    await this.poll(id);
    return this.row(id)!;
  }

  poll(id: string): Promise<void> {
    let p = this.#inflight.get(id);
    if (!p) {
      p = this.#poll(id).finally(() => this.#inflight.delete(id));
      this.#inflight.set(id, p);
    }
    return p;
  }

  /** Quotes due for a poll. */
  due(limit = 100): QuoteRow[] {
    return this.#db.all<QuoteRow>(`SELECT * FROM intents_quotes WHERE status IN (${inList(ACTIVE)}) AND next_poll_unix <= ? ORDER BY next_poll_unix LIMIT ?`, this.#clock(), limit);
  }

  /** 5 s while a checkout page watches the payment, 15 s otherwise, 60 s after the deadline. */
  #nextPoll(r: Pick<QuoteRow, "payment_id" | "deadline_unix">, errors = 0): number {
    const now = this.#clock();
    if (errors > 0) return now + Math.min(300, 15 * 2 ** Math.min(errors - 1, 4));
    if (now > r.deadline_unix) return now + 60;
    return now + (this.#payments.hasSubscribers(r.payment_id) ? 5 : 15);
  }

  async #poll(id: string): Promise<void> {
    const r = this.row(id);
    if (!r || !ACTIVE.includes(r.status)) return;
    const now = this.#clock();
    if (DEPOSIT_SEEN.includes(r.status) && now > r.deadline_unix + STUCK_AFTER_SEC) {
      this.#alert("stuck", r.id, `an any-chain payment is still ${r.status} ${Math.floor((now - r.deadline_unix) / 3600)} h after its deadline`, { quote: r });
    }
    if (r.status === "delivered") return this.#confirmDelivery(r);
    let s: StatusResponse;
    try {
      s = await this.#client.status(r.deposit_address, r.deposit_memo ?? undefined);
    } catch (err) {
      const status = err instanceof this.kit.OneClickError ? err.status : 0;
      const fresh = now - Date.parse(r.created_at) / 1000 < NOT_FOUND_GRACE_SEC;
      if (status === 404 && fresh) return this.#touch(r, { next: this.#nextPoll(r) });
      if (r.status === "awaiting_deposit" && now > r.deadline_unix + WATCH_AFTER_DEADLINE_SEC) return this.#expire(r);
      if (status === 401 || status === 403) {
        // A revoked or wrong API key does not heal by backing off: read again every AUTH_RETRY_SEC and tell the operator once.
        this.#log.error("1Click refused this node's API key reading a status; retrying slowly", { quoteId: r.id, status });
        this.#alert("auth", r.id, `1Click refused this node's API key (HTTP ${status}) reading a payment's status; check ONECLICK_API_KEY`, { quote: r });
        return this.#touch(r, { errors: r.poll_errors + 1, next: now + AUTH_RETRY_SEC });
      }
      // 404 after the grace, 429, 5xx or the network: back off and never change state.
      this.#log.warn("1Click status read failed; backing off", { quoteId: r.id, status, err: err instanceof Error ? err.message : String(err) });
      return this.#touch(r, { errors: r.poll_errors + 1, next: this.#nextPoll(r, r.poll_errors + 1) });
    }
    // The status must describe the quote this node stored: the same 1Click signature over it, for the same deposit address.
    // The live API embeds the quote without its correlationId (seen 2026-11-14), so that id is compared only when present.
    const stored = JSON.parse(r.quote_json) as QuoteResponse;
    const embedded = s.quoteResponse;
    const otherId = embedded?.correlationId !== undefined && embedded.correlationId !== stored.correlationId;
    if (embedded && (otherId || embedded.signature !== stored.signature || embedded.quote?.depositAddress !== r.deposit_address)) {
      this.#log.error("1Click's status names another quote than the one stored; ignoring it", { quoteId: r.id, stored: stored.correlationId, got: embedded.correlationId });
      return this.#touch(r, { errors: r.poll_errors + 1, next: this.#nextPoll(r, r.poll_errors + 1) });
    }
    let next: IntentsQuoteStatus;
    try {
      next = this.kit.mapStatus(s.status);
    } catch {
      this.#log.error("1Click answered an unknown status", { quoteId: r.id, status: s.status });
      return this.#touch(r, { errors: r.poll_errors + 1, next: this.#nextPoll(r, r.poll_errors + 1) });
    }
    if (next === "awaiting_deposit" && now > r.deadline_unix + WATCH_AFTER_DEADLINE_SEC) return this.#expire(r);
    this.#apply(r, s, next);
    const after = this.row(id)!;
    if (after.status === "delivered") await this.#confirmDelivery(after);
  }

  #touch(r: QuoteRow, o: { errors?: number; next: number }) {
    this.#db.run("UPDATE intents_quotes SET poll_errors = ?, next_poll_unix = ?, updated_at = ? WHERE id = ?", o.errors ?? 0, o.next, nowIso(), r.id);
  }

  #expire(r: QuoteRow) {
    this.#db.tx(() => {
      this.#db.run("UPDATE intents_quotes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_deposit'", nowIso(), r.id);
      this.#payments.notify(r.payment_id);
    });
    this.#log.info("any-chain deposit address expired unused", { quoteId: r.id });
  }

  #credit(r: QuoteRow): CreditRow | undefined {
    return this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE intents_quote_id = ?", r.id);
  }

  /** A new 1Click status, applied with its credit and the payment's recompute in one transaction. */
  #apply(r: QuoteRow, s: StatusResponse, next: IntentsQuoteStatus) {
    const d = s.swapDetails;
    // Never back out of a terminal state, nor back from delivered.
    const status = TERMINAL_INTENTS_STATUSES.includes(r.status) || (r.status === "delivered" && ACTIVE.includes(next) && next !== "delivered") ? r.status : next;
    const txs = (xs: WireTx[] | undefined) => JSON.stringify((xs ?? []).map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl ?? "" })));
    const now = this.#clock();
    let event: "payment.deposit_returned" | "payment.deposit_failed" | null = null;
    this.#db.tx(() => {
      this.#db.run(
        `UPDATE intents_quotes SET status = ?, provider_status = ?, last_status_json = ?, deposited_amount = COALESCE(?, deposited_amount), refunded_amount = COALESCE(?, refunded_amount),
                refund_reason = COALESCE(?, refund_reason), delivered_amount = COALESCE(?, delivered_amount), origin_txs = ?, destination_txs = ?, near_txs = ?,
                delivered_unix = COALESCE(delivered_unix, ?), poll_errors = 0, next_poll_unix = ?, updated_at = ? WHERE id = ?`,
        status,
        s.status,
        JSON.stringify(s),
        d.depositedAmount ?? null,
        d.refundedAmount ?? null,
        d.refundReason ?? null,
        status === "delivered" ? (d.amountOut ?? null) : null,
        txs(d.originChainTxHashes),
        txs(d.destinationChainTxHashes),
        JSON.stringify(d.nearTxHashes ?? []),
        status === "delivered" ? now : null,
        this.#nextPoll(r),
        nowIso(),
        r.id,
      );
      const credit = this.#credit(r);
      if (["deposit_detected", "incomplete_deposit", "processing", "delivered"].includes(status) && !credit) {
        // Money is on its way: a pending credit holds the payment's expiry until the delivery is read on NEAR.
        this.#payments.addCredit({ paymentId: r.payment_id, method: "oneclick", payer: this.#payer(r), amount: BigInt(r.amount_out), txHash: null, intentsQuoteId: r.id, status: "pending", mayBeLate: true });
      }
      if ((status === "refunded" || status === "failed") && r.status !== status) {
        if (credit?.status === "pending") this.#payments.removeCredit(credit.id);
        event = status === "refunded" ? "payment.deposit_returned" : "payment.deposit_failed";
      }
      if (event) this.#emit(event, this.row(r.id)!);
      this.#payments.notify(r.payment_id);
    });
    if (status !== r.status) this.#log.info("any-chain payment moved", { quoteId: r.id, from: r.status, to: status, provider: s.status });
  }

  /** The buyer as `chain:address`; a quote without a buyer address knows only the chain. */
  #payer(r: Pick<QuoteRow, "origin_chain" | "refund_to" | "refund_type">): string {
    return r.refund_type === "INTENTS" ? `${r.origin_chain}:unknown` : `${r.origin_chain}:${r.refund_to}`;
  }

  /** When the buyer must send by: what this node asked 1Click for, never 1Click's later refund deadline. */
  #sendBy(r: Pick<QuoteRow, "send_by_unix" | "deadline_unix">): number {
    return r.send_by_unix === null ? r.deadline_unix : Math.min(r.send_by_unix, r.deadline_unix);
  }

  #emit(type: "payment.deposit_returned" | "payment.deposit_failed", r: QuoteRow) {
    const p = this.#payments.row(r.payment_id)!;
    const object: IntentsDepositEvent = { ...this.#payments.json(p), intents: this.paymentIntents(p.id), deposit: this.json(r, true) };
    this.#webhooks.emit(r.merchant_id, type, r.id, p.id, object);
    // A failed swap is also an alert for the platform.
    if (type === "payment.deposit_failed" && this.#webhooks.hasSubscribers(null, type)) this.#webhooks.emit(null, type, r.id, p.id, object);
  }

  /**
   * An operator alert, once per object (a quote, or a payment for a refused deposit address) and kind: the
   * `payminto_intents_alerts_total{kind}` metric and a platform `intents.alert` event, kept in the event log (which is
   * also how a restarted node knows it raised one already) and sent to platform webhook endpoints that take it.
   */
  #alert(kind: IntentsAlertKind, objectId: string, message: string, o: { quote?: QuoteRow; paymentId?: string; merchantId?: string }) {
    const key = `${kind} ${objectId}`;
    if (this.#alerted.has(key)) return;
    this.#alerted.add(key);
    const seen = this.#db.get<{ x: number }>(
      "SELECT 1 AS x FROM gateway_events WHERE merchant_id IS NULL AND type = ? AND object_id = ? AND json_extract(body, '$.data.object.kind') = ? LIMIT 1",
      INTENTS_ALERT_EVENT,
      objectId,
      kind,
    );
    if (seen) return;
    const r = o.quote ? this.row(o.quote.id) : undefined;
    const object = {
      object: "intents_alert",
      kind,
      message,
      mode: this.mode,
      merchant_id: r?.merchant_id ?? o.merchantId ?? null,
      payment_id: r?.payment_id ?? o.paymentId ?? null,
      quote: r ? this.json(r, true) : null,
    };
    // Not on the payment's timeline: the business does not see platform alerts.
    this.#db.tx(() => this.#webhooks.emit(null, INTENTS_ALERT_EVENT, objectId, null, object));
    this.#alertCounts[kind]++;
    this.#log.error(`any-chain operator alert (${kind}): ${message}`, { kind, objectId, paymentId: object.payment_id });
  }

  /**
   * 1Click says the USDC was delivered: read each delivery transaction on NEAR and look for the NEP-141 `ft_transfer`
   * event of the USDC contract to the merchant's account for at least the invoice amount. Found: confirmed
   * (`rpc_checked`). Not readable for 10 minutes: confirmed on 1Click's word (`provider_only`), with a warning. Read
   * but short or to someone else: never confirmed; it stays delivered and is logged as an error.
   */
  async #confirmDelivery(r: QuoteRow): Promise<void> {
    if (r.destination_chain !== "near") return this.#confirmEvmDelivery(r);
    const destination = (JSON.parse(r.destination_txs) as WireTx[]).map((t) => t.hash);
    const hashes = [...new Set([...destination, ...(JSON.parse(r.near_txs) as string[])])];
    let contradicted = false;
    for (const hash of hashes) {
      let read;
      try {
        read = await this.#reader.delivery(hash, [...this.config.deliverySenders, r.recipient]);
      } catch (err) {
        this.#log.warn("could not read a delivery transaction", { quoteId: r.id, hash, err: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (read.status !== "final") continue;
      const to = read.transfers.filter((t) => t.token === this.usdcContract && t.to === r.recipient);
      const total = to.reduce((s, t) => s + t.amount, 0n);
      if (total >= BigInt(r.amount_out)) return this.#confirm(r, { verification: "rpc_checked", amount: total, tx: hash });
      contradicted = true;
      this.#log.error("a delivery transaction on NEAR does not pay the merchant the invoice amount", { quoteId: r.id, hash, recipient: r.recipient, token: this.usdcContract, found: total.toString(), due: r.amount_out });
      this.#alert("contradicted", r.id, `1Click reported a delivery, but transaction ${hash} on NEAR pays ${r.recipient} ${total} of the ${r.amount_out} due; the payment is not counted`, { quote: r });
    }
    const now = this.#clock();
    if (!contradicted && now - (r.delivered_unix ?? now) >= PROVIDER_ONLY_AFTER_SEC) {
      this.#log.warn("delivery not readable on NEAR after 10 minutes; confirming on 1Click's report (provider_only)", { quoteId: r.id, hashes });
      return this.#confirm(r, { verification: "provider_only", amount: BigInt(r.delivered_amount ?? r.amount_out), tx: destination[0] ?? null });
    }
    this.#touch(r, { next: contradicted ? now + 60 : this.#nextPoll(r) });
  }

  /** The USDC contract of a quote's EVM destination, lowercased; null when the chain is not a destination any more. */
  #evmToken(r: Pick<QuoteRow, "destination_chain" | "destination_asset">): string | null {
    const d = this.kit.payoutDestinationOf(r.destination_asset ?? r.destination_chain);
    return d && d.blockchain === r.destination_chain ? d.contractAddress.toLowerCase() : null;
  }

  /** USDC base units the final receipts of `hashes` transfer to the quote's address, and whether every hash was read final. */
  async #readEvm(r: QuoteRow, hashes: readonly string[]): Promise<{ total: bigint; firstTx: string | null; allFinal: boolean }> {
    const token = this.#evmToken(r);
    const to = r.recipient.toLowerCase();
    let total = 0n;
    let firstTx: string | null = null;
    let allFinal = hashes.length > 0 && token !== null;
    for (const hash of hashes) {
      if (!token) break;
      try {
        const read = await this.#evm.delivery(r.destination_chain, hash);
        if (read.status !== "final") {
          allFinal = false;
          continue;
        }
        const paid = read.transfers.filter((t) => t.token === token && t.to === to).reduce((sum, t) => sum + t.amount, 0n);
        if (paid > 0n) firstTx ??= hash;
        total += paid;
      } catch (err) {
        allFinal = false;
        this.#log.warn("could not read a delivery transaction", { quoteId: r.id, chain: r.destination_chain, hash, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return { total, firstTx, allFinal };
  }

  /**
   * A delivery on an EVM destination: read each destination transaction's receipt over JSON-RPC and sum the ERC-20
   * Transfer logs of the chain's USDC contract to the business's address. Covers the invoice amount: confirmed
   * (`rpc_checked`). Every receipt read and short: never confirmed, an alert. Unreadable for 10 minutes (or the chain is
   * not read at all, INTENTS_RPC_<CHAIN>=off): confirmed on 1Click's word (`provider_only`).
   */
  async #confirmEvmDelivery(r: QuoteRow): Promise<void> {
    const hashes = [...new Set((JSON.parse(r.destination_txs) as WireTx[]).map((t) => t.hash))];
    const now = this.#clock();
    let contradicted = false;
    if (this.#evm.canRead(r.destination_chain)) {
      const { total, firstTx, allFinal } = await this.#readEvm(r, hashes);
      if (total >= BigInt(r.amount_out)) return this.#confirm(r, { verification: "rpc_checked", amount: total, tx: firstTx });
      if (allFinal) {
        contradicted = true;
        this.#log.error("the delivery transactions on the destination chain do not pay the business the invoice amount", { quoteId: r.id, chain: r.destination_chain, hashes, recipient: r.recipient, found: total.toString(), due: r.amount_out });
        this.#alert("contradicted", r.id, `1Click reported a delivery, but its transactions on ${r.destination_chain} pay ${r.recipient} ${total} of the ${r.amount_out} due; the payment is not counted`, { quote: r });
      }
    }
    if (!contradicted && now - (r.delivered_unix ?? now) >= PROVIDER_ONLY_AFTER_SEC) {
      this.#log.warn("delivery not readable on the destination chain after 10 minutes; confirming on 1Click's report (provider_only)", { quoteId: r.id, chain: r.destination_chain, hashes });
      return this.#confirm(r, { verification: "provider_only", amount: BigInt(r.delivered_amount ?? r.amount_out), tx: hashes[0] ?? null });
    }
    this.#touch(r, { next: contradicted ? now + 60 : this.#nextPoll(r) });
  }

  #confirm(r: QuoteRow, o: { verification: "rpc_checked" | "provider_only"; amount: bigint; tx: string | null }) {
    let confirmed = false;
    this.#db.tx(() => {
      const cur = this.row(r.id)!;
      if (cur.status !== "delivered") return;
      confirmed = true;
      this.#db.run(
        "UPDATE intents_quotes SET status = 'confirmed', verification = ?, delivered_amount = ?, delivery_tx = ?, updated_at = ? WHERE id = ?",
        o.verification,
        o.amount.toString(),
        o.tx,
        nowIso(),
        r.id,
      );
      const credit = this.#credit(r);
      if (credit) this.#payments.confirmCredit(credit.id, { txHash: o.tx, amount: o.amount });
      else this.#payments.addCredit({ paymentId: r.payment_id, method: "oneclick", payer: this.#payer(r), amount: o.amount, txHash: o.tx, intentsQuoteId: r.id, status: "confirmed", mayBeLate: true });
      this.#payments.notify(r.payment_id);
    });
    if (!confirmed) return;
    this.#log.info("any-chain payment confirmed", { quoteId: r.id, verification: o.verification, tx: o.tx, amount: o.amount.toString() });
    if (o.verification === "provider_only") {
      const where = r.destination_chain === "near" ? "NEAR" : (DESTINATION_CHAINS[r.destination_chain]?.name ?? r.destination_chain);
      this.#alert("provider_only", r.id, `an any-chain payment was confirmed on 1Click's report alone: its delivery could not be read on ${where} for ${PROVIDER_ONLY_AFTER_SEC / 60} minutes; check it by hand`, { quote: r });
    }
  }

  // ------------------------------------------------------------------ JSON

  #amount(v: string | null, decimals: number, symbol: string) {
    return v === null ? null : { amount: v, formatted: this.kit.formatUnits(v, decimals), symbol };
  }

  #tx(t: WireTx): IntentsTx {
    return { hash: t.hash, explorer_url: t.explorerUrl ? t.explorerUrl : null };
  }

  /** NEAR mainnet transactions link to NearBlocks; the local chain has no explorer. */
  nearExplorer(hash: string): string | null {
    return this.#explorer("near", hash);
  }

  /** A live delivery links to its chain's explorer; a simulated one has none. */
  #explorer(chain: string, hash: string): string | null {
    const base = DESTINATION_CHAINS[chain]?.explorer;
    return this.mode === "live" && base ? `${base}${hash}` : null;
  }

  #steps(status: IntentsQuoteStatus): IntentsStep[] {
    const p = STEP_PROGRESS[status];
    const keys: Array<IntentsStep["key"]> = ["waiting", "received", "converting", "delivered"];
    return keys.map((key, i) => ({
      key,
      label: STEP_LABELS[key],
      state: i < p.done ? "done" : i === p.done ? (p.failed ? "failed" : "current") : "pending",
    }));
  }

  /** The public JSON of a quote; `merchant` adds the full refund address and the signed 1Click response. */
  json(r: QuoteRow, merchant = false): IntentsQuoteJson {
    const res = JSON.parse(r.quote_json) as QuoteResponse;
    const origin = this.kit.originOf(r.origin_asset);
    const o = { assetId: r.origin_asset, blockchain: r.origin_chain as CheckoutOrigin["blockchain"], chainName: origin?.chainName ?? r.origin_chain, symbol: r.origin_symbol, decimals: r.origin_decimals };
    const fees = this.kit.feeLines(res, { symbol: r.origin_symbol, decimals: r.origin_decimals, stable: origin?.stable ?? false });
    const destination = (JSON.parse(r.destination_txs) as WireTx[]).map((t) => this.#tx(t));
    const deliveryHash = r.delivery_tx ?? destination[0]?.hash ?? null;
    const chain = r.destination_chain ?? "near";
    const out: IntentsQuoteJson = {
      id: r.id,
      object: "intents_quote",
      payment_id: r.payment_id,
      mode: r.mode,
      label: INTENTS_LABELS[r.mode],
      status: r.status,
      provider_status: r.provider_status,
      origin: this.#originJson(o),
      deposit_address: r.deposit_address,
      deposit_memo: null,
      send_exactly: this.#amount(r.amount_in, r.origin_decimals, r.origin_symbol)!,
      min_amount_in: this.#amount(r.min_amount_in, r.origin_decimals, r.origin_symbol)!,
      amount_out: this.#amount(r.amount_out, 6, "USDC")!,
      amount_in_usd: r.amount_in_usd,
      fees,
      slippage_bps: r.slippage_bps,
      time_estimate_sec: r.time_estimate_sec,
      refund_to: merchant || r.refund_type === "INTENTS" ? r.refund_to : mask(r.refund_to),
      refund_type: r.refund_type,
      recipient: r.recipient,
      destination: { chain, chain_name: DESTINATION_CHAINS[chain]?.name ?? chain, symbol: "USDC", address: r.recipient },
      settlement_network: settlementNetworkOf(r.mode, chain),
      deadline: isoOf(r.deadline_unix),
      send_by: isoOf(this.#sendBy(r)),
      deadline_passed: this.#clock() >= r.deadline_unix,
      inactive_at: r.inactive_unix === null ? null : isoOf(r.inactive_unix),
      deposited: this.#amount(r.deposited_amount, r.origin_decimals, r.origin_symbol),
      delivered: r.status === "confirmed" || r.status === "delivered" ? this.#amount(r.delivered_amount, 6, "USDC") : null,
      refunded: this.#amount(r.refunded_amount, r.origin_decimals, r.origin_symbol),
      refund_reason: r.refund_reason,
      origin_txs: (JSON.parse(r.origin_txs) as WireTx[]).map((t) => this.#tx(t)),
      destination_txs: destination,
      near_txs: JSON.parse(r.near_txs) as string[],
      delivery_tx: deliveryHash ? { hash: deliveryHash, explorer_url: destination.find((t) => t.hash === deliveryHash)?.explorer_url ?? this.#explorer(chain, deliveryHash) } : null,
      verification: r.verification,
      steps: this.#steps(r.status),
      warning: `Send only ${r.origin_symbol} on the ${o.chainName} network, to this address. Other tokens, other networks, or a deposit after ${hhmm(this.#sendBy(r))} UTC may be lost.`,
      correlation_id: r.correlation_id,
      signature_valid: r.signature_valid === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    if (merchant) out.quote_response = res;
    return out;
  }

  /** `GET /v1/platform/intents`. */
  platformStatus(): IntentsPlatformStatus {
    const counts = Object.fromEntries(INTENTS_QUOTE_STATUSES.map((s) => [s, 0])) as Record<IntentsQuoteStatus, number>;
    for (const c of this.#db.all<{ status: IntentsQuoteStatus; n: number }>("SELECT status, COUNT(*) AS n FROM intents_quotes GROUP BY status")) counts[c.status] = c.n;
    return {
      object: "intents_status",
      mode: this.mode,
      label: this.label,
      base_url: this.config.baseUrl,
      api_key_set: !!this.config.apiKey,
      manager_key: this.config.managerPublicKey ? "test" : "1click",
      near_rpc_url: redact(this.config.nearRpcUrl),
      usdc_contract: this.usdcContract,
      settlement_network: this.settlementNetwork,
      origins: this.origins.map((o) => o.assetId),
      slippage_bps: { ...this.config.slippage },
      referral: this.config.referral,
      last_call: this.#lastCall,
      rate_limit_remaining: this.#rateRemaining,
      counts,
    };
  }
}

function redact(u: string): string {
  try {
    const url = new URL(u);
    return url.username || url.password || url.search || /[0-9a-f]{16,}|[A-Za-z0-9_-]{24,}/.test(url.pathname) ? `${url.protocol}//${url.host}/***` : u;
  } catch {
    return "***";
  }
}

/**
 * Polls every quote that is due, like the payment watcher: overlapping ticks share one pass, and a quote checked by a
 * route at the same moment is polled once.
 */
export class IntentsWatcher {
  readonly #s: IntentsService;
  readonly #log: Logger;
  readonly #concurrency: number;
  #busy: Promise<number> | null = null;

  constructor(s: IntentsService, log: Logger, o: { concurrency?: number } = {}) {
    this.#s = s;
    this.#log = log;
    this.#concurrency = Math.max(1, o.concurrency ?? WATCH_CONCURRENCY);
  }

  tick(): Promise<number> {
    this.#busy ??= this.#run().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  /** The due quotes in order (the longest due first), a few at a time: a hung call holds up one worker, not the pass. */
  async #run(): Promise<number> {
    const due = this.#s.due();
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const r = due[next++]!;
        await this.#s.poll(r.id).catch((err: unknown) => this.#log.warn("any-chain quote poll failed", { quoteId: r.id, err }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, due.length) }, worker));
    return due.length;
  }
}

/** The reconciliation columns of one payment's confirmed any-chain quotes. */
export function reconciliationOf(rows: QuoteRow[], formatUnits: (v: string, d: number) => string) {
  const confirmed = rows.filter((r) => r.status === "confirmed");
  if (!confirmed.length) return null;
  const live = confirmed.some((r) => r.mode === "live");
  const parsedOrigin = (r: QuoteRow) => JSON.parse(r.origin_txs) as WireTx[];
  const chains = [...new Set(confirmed.map((r) => r.destination_chain ?? "near"))];
  const where = (c: string) => (c === "near" ? "NEAR mainnet" : (DESTINATION_CHAINS[c]?.name ?? c));
  return {
    settlement_network: chains.map((c) => settlementNetworkOf(live ? "live" : "simulated", c)).join(" "),
    currency: chains.map((c) => (live ? `USDC (${where(c)})` : `USDC (${where(c)}, simulated)`)).join(" "),
    origin_asset: [...new Set(confirmed.map((r) => r.origin_asset))].join(" "),
    origin_amount: confirmed.map((r) => `${formatUnits(r.deposited_amount ?? r.amount_in, r.origin_decimals)} ${r.origin_symbol}`).join(" "),
    deposit_address: confirmed.map((r) => r.deposit_address).join(" "),
    origin_txs: confirmed.flatMap((r) => parsedOrigin(r).map((t) => ({ quote: r, hash: t.hash, explorerUrl: t.explorerUrl || null }))),
    live,
  };
}
