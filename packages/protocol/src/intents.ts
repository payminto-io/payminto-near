/**
 * Any-chain checkout through NEAR Intents (1Click): the buyer pays from another chain and the merchant receives exactly
 * the invoice amount of USDC in its own NEAR mainnet account. These are the shared names and the public JSON shapes of
 * the node's intents routes (docs/DEVELOPERS.md, "Any-chain checkout"). The rail is an add-on: the core's
 * `PAYMENT_METHODS` stays `wallet` and `voucher`, and `oneclick` appears only where `CHECKOUT_METHODS` is used.
 */
import type { AccountId, WalletTx } from "@payminto/chain";
import { PAYMENT_METHODS, type Payment } from "./gateway.ts";

/** Every method a payment can carry on a node with the any-chain checkout on. */
export const CHECKOUT_METHODS = [...PAYMENT_METHODS, "oneclick"] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

/** Webhooks of the any-chain checkout. `payment.deposit_failed` also goes to platform alert endpoints. */
export const INTENTS_EVENT_TYPES = ["payment.deposit_returned", "payment.deposit_failed"] as const;
export type IntentsEventType = (typeof INTENTS_EVENT_TYPES)[number];

/** `INTENTS_CHECKOUT`: off by default; simulated runs against the fake 1Click server; live only by an operator flag. */
export const INTENTS_MODES = ["off", "simulated", "live"] as const;
export type IntentsMode = (typeof INTENTS_MODES)[number];

/** The label every response that carries intents data shows, so simulated money is never mistaken for real money. */
export const INTENTS_LABELS: Record<Exclude<IntentsMode, "off">, string> = {
  live: "Live - NEAR mainnet",
  simulated: "Simulated - no real money",
};

/**
 * One quote's state. `delivered`: 1Click says the USDC was delivered; `confirmed`: the node read the delivery on NEAR
 * itself (or, after 10 minutes without a readable transaction, took 1Click's word: `verification = provider_only`).
 * Terminal: confirmed, refunded, failed, expired.
 */
export const INTENTS_QUOTE_STATUSES = ["awaiting_deposit", "deposit_detected", "incomplete_deposit", "processing", "delivered", "confirmed", "refunded", "failed", "expired"] as const;
export type IntentsQuoteStatus = (typeof INTENTS_QUOTE_STATUSES)[number];
export const TERMINAL_INTENTS_STATUSES: readonly IntentsQuoteStatus[] = ["confirmed", "refunded", "failed", "expired"];

/** An amount in base units, the same in decimal units of its token, and the token's symbol. */
export type IntentsAmount = { amount: string; formatted: string; symbol: string };

export type IntentsOrigin = {
  /** The 1Click asset id, for example `nep141:base-0x8335...omft.near`. */
  asset: string;
  /** The 1Click chain code: base, eth, arb, sol or pol. */
  chain: string;
  /** For people: Base, Ethereum, Arbitrum, Solana, Polygon. */
  chain_name: string;
  symbol: string;
  decimals: number;
};

/** The deposit screen's fee lines, all read from the signed quote. */
export type IntentsFeeLines = {
  send_exactly: IntentsAmount;
  merchant_receives: IntentsAmount;
  /** Stablecoin: in the origin token; any other token: `unit` USD and `amount` in micro-dollars. */
  swap_cost: { amount: string; formatted: string; unit: string };
  /** Returned to the refund address when the price holds. */
  price_buffer: IntentsAmount;
  refund_fee: IntentsAmount | null;
  /** The delivery fee to NEAR, already inside the price. */
  delivery_fee: IntentsAmount | null;
  time_estimate_sec: number;
};

/** `GET /v1/checkout/{id}/intents/options`: one row per offered origin, from dry quotes cached 30 s. */
export type IntentsOption = {
  origin: IntentsOrigin;
  /** False when 1Click refused the route or the quote failed a check; the row is shown greyed with `reason`. */
  available: boolean;
  reason: string | null;
  slippage_bps: number;
  /** Indicative only: the deposit screen's amount comes from the wet quote. */
  amount_in: IntentsAmount | null;
  amount_in_usd: string | null;
  time_estimate_sec: number | null;
  fees: IntentsFeeLines | null;
};

export type IntentsOptions = {
  object: "intents_options";
  payment_id: string;
  mode: Exclude<IntentsMode, "off">;
  label: string;
  /** What the merchant receives: the payment's amount due, in USDC. */
  amount_out: IntentsAmount;
  recipient: AccountId;
  settlement_network: string;
  quoted_at: string;
  /** When the cached prices are refreshed. */
  valid_until: string;
  options: IntentsOption[];
};

export type IntentsTx = { hash: string; explorer_url: string | null };

/** The live progress steps under the deposit screen. */
export type IntentsStep = { key: "waiting" | "received" | "converting" | "delivered"; label: string; state: "done" | "current" | "pending" | "failed" };

/** `POST` and `GET /v1/checkout/{id}/intents/quotes[/{qid}]`, `intents.active_quote`, and each of `intents.quotes`. */
export type IntentsQuote = {
  id: string;
  object: "intents_quote";
  payment_id: string;
  mode: Exclude<IntentsMode, "off">;
  label: string;
  status: IntentsQuoteStatus;
  /** The last raw 1Click status, for support. */
  provider_status: string | null;
  origin: IntentsOrigin;
  /** Where the buyer sends `send_exactly` of the origin token, on the origin chain. */
  deposit_address: string;
  /** Always null: memo chains are not offered. */
  deposit_memo: null;
  send_exactly: IntentsAmount;
  /** Less than this is returned by the deadline unless topped up. */
  min_amount_in: IntentsAmount;
  amount_out: IntentsAmount;
  amount_in_usd: string | null;
  fees: IntentsFeeLines;
  slippage_bps: number;
  time_estimate_sec: number;
  refund_to: string;
  recipient: AccountId;
  settlement_network: string;
  /** The deposit address goes inactive at this time: show it, not the payment's expiry. */
  deadline: string;
  /**
   * True once `deadline` has passed. The quote is still watched for a day (a late deposit can still be swapped or
   * returned), so its status may still be `awaiting_deposit`; the page offers "Get a new address" instead.
   */
  deadline_passed: boolean;
  inactive_at: string | null;
  deposited: IntentsAmount | null;
  delivered: IntentsAmount | null;
  refunded: IntentsAmount | null;
  refund_reason: string | null;
  origin_txs: IntentsTx[];
  destination_txs: IntentsTx[];
  near_txs: string[];
  /** The NEAR transaction that delivered the USDC, once 1Click reports it. */
  delivery_tx: IntentsTx | null;
  verification: "rpc_checked" | "provider_only" | null;
  steps: IntentsStep[];
  /** The plain warning for the deposit screen. */
  warning: string;
  correlation_id: string;
  signature_valid: boolean;
  created_at: string;
  updated_at: string;
  /** Merchant views only: the whole signed 1Click response, kept for disputes. */
  quote_response?: unknown;
};

/** `intents` on `GET /v1/checkout/{id}` and on its SSE stream; null when the node runs with INTENTS_CHECKOUT=off. */
export type IntentsCheckout = {
  mode: Exclude<IntentsMode, "off">;
  label: string;
  /** True when this payment can be paid from another chain now (`methods` then contains `oneclick`). */
  available: boolean;
  /** Why not, in plain words, when `available` is false. */
  reason: string | null;
  settlement_network: string;
  /** The newest quote of the payment that has not expired, whatever its state. */
  active_quote: IntentsQuote | null;
};

/** `intents` on `GET /v1/payments/{id}`: null when the payment has no intents quote. */
export type PaymentIntents = { mode: Exclude<IntentsMode, "off">; label: string; quotes: IntentsQuote[] };

/** `GET` and `PUT /v1/merchant/intents-payout`. */
export type IntentsPayout = {
  object: "intents_payout";
  mode: IntentsMode;
  label: string | null;
  settlement_network: string;
  /** The merchant's NEAR account the any-chain checkout delivers to; null until set. */
  account: AccountId | null;
  /** All three checks passed: `oneclick` can be enabled. */
  verified: boolean;
  checks: { exists: boolean | null; usdc_registered: boolean | null; proven: boolean; proven_at: string | null };
  usdc: { contract: AccountId; asset_id: string; decimals: 6 };
  /** The one human step when the account is not registered with USDC yet: a `storage_deposit` it signs itself. */
  storage_step: { why: string; deposit_near: string; transaction: WalletTx } | null;
  /** Whether the `oneclick` method is on for this business. */
  enabled: boolean;
  /** What the proof message is bound to (`intentsPayoutProofRequest`). */
  proof_scope: { settlement_network: string; hub: AccountId };
  checked_at: string;
};

/** `GET /v1/platform/intents`. */
export type IntentsPlatformStatus = {
  object: "intents_status";
  mode: IntentsMode;
  label: string | null;
  base_url: string | null;
  api_key_set: boolean;
  /** `1click` (the published manager key) or `test` (the fake server's). */
  manager_key: "1click" | "test" | null;
  near_rpc_url: string | null;
  usdc_contract: AccountId | null;
  settlement_network: string | null;
  origins: string[];
  slippage_bps: { stable: number; volatile: number };
  referral: string | null;
  last_call: { at: string; method: string; path: string; status: number; ok: boolean; error: string | null } | null;
  rate_limit_remaining: number | null;
  counts: Record<IntentsQuoteStatus, number>;
};

/** The object of a `payment.deposit_returned` or `payment.deposit_failed` webhook: the payment, with the quote it is about. */
export type IntentsDepositEvent = Payment & { intents: PaymentIntents | null; deposit: IntentsQuote };
