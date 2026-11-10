/**
 * Any-chain checkout, the pay-in direction of 1Click: a buyer pays from another chain and the merchant receives exactly
 * the invoice amount of native USDC on NEAR, in the merchant's own account (`EXACT_OUTPUT`, `recipientType:
 * DESTINATION_CHAIN`). This module builds the quote request, checks what 1Click answered before a deposit address may
 * be shown, maps 1Click statuses to checkout states and computes the fee lines from the signed quote. It never signs,
 * never sends and never asks for a quote itself.
 */
import { isAccountId } from "@payminto/chain";
import { base58 } from "@scure/base";
import { verifyQuoteSignature } from "./signature.ts";
import { NEAR_MAINNET_USDC_ASSET, type ExecutionStatus, type QuoteRequest, type QuoteResponse } from "./types.ts";

export type AddressFormat = "evm" | "solana";

/** An origin a buyer may pay from. Asset ids, chains and decimals are verbatim from the live `/v0/tokens` (2026-11-10). */
export type CheckoutOrigin = {
  assetId: string;
  /** The 1Click `blockchain` code. */
  blockchain: "base" | "eth" | "arb" | "sol" | "pol";
  chainName: string;
  symbol: string;
  decimals: number;
  /** A dollar stablecoin: its swap cost is shown in its own units, and its default slippage is the stable one. */
  stable: boolean;
  addressFormat: AddressFormat;
};

/**
 * The agreed first origins: USDC on Base, Ethereum, Arbitrum, Solana and Polygon; USDT on Ethereum; ETH on Base and
 * Ethereum. Not Bitcoin (the quote signature check fails on Bitcoin quotes today), Tron or BNB (high minimums), and no
 * memo chain.
 */
export const CHECKOUT_ORIGINS: readonly CheckoutOrigin[] = [
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", blockchain: "base", chainName: "Base", symbol: "USDC", decimals: 6, stable: true, addressFormat: "evm" },
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", blockchain: "eth", chainName: "Ethereum", symbol: "USDC", decimals: 6, stable: true, addressFormat: "evm" },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", blockchain: "arb", chainName: "Arbitrum", symbol: "USDC", decimals: 6, stable: true, addressFormat: "evm" },
  { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", blockchain: "sol", chainName: "Solana", symbol: "USDC", decimals: 6, stable: true, addressFormat: "solana" },
  { assetId: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", blockchain: "pol", chainName: "Polygon", symbol: "USDC", decimals: 6, stable: true, addressFormat: "evm" },
  { assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", blockchain: "eth", chainName: "Ethereum", symbol: "USDT", decimals: 6, stable: true, addressFormat: "evm" },
  { assetId: "nep141:base.omft.near", blockchain: "base", chainName: "Base", symbol: "ETH", decimals: 18, stable: false, addressFormat: "evm" },
  { assetId: "nep141:eth.omft.near", blockchain: "eth", chainName: "Ethereum", symbol: "ETH", decimals: 18, stable: false, addressFormat: "evm" },
];

export const originOf = (assetId: string): CheckoutOrigin | undefined => CHECKOUT_ORIGINS.find((o) => o.assetId === assetId);

/**
 * A refund address of the right format for a dry quote, which needs one although nothing can be refunded. Both are
 * what the live API accepted on 2026-11-10: a repeated-digit EVM address and the wrapped SOL mint.
 */
export const DRY_QUOTE_REFUND_TO: Record<AddressFormat, string> = {
  evm: "0x1111111111111111111111111111111111111111",
  solana: "So11111111111111111111111111111111111111112",
};

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** True when `address` is a well-formed address on the origin's chain (format only; it says nothing about who owns it). */
export function isOriginAddress(origin: Pick<CheckoutOrigin, "addressFormat">, address: string): boolean {
  if (typeof address !== "string") return false;
  if (origin.addressFormat === "evm") return EVM.test(address) && !/^0x0{40}$/.test(address);
  if (address.length < 32 || address.length > 44 || address === SOLANA_SYSTEM_PROGRAM) return false;
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}

export type SlippageConfig = { stable: number; volatile: number };
export const DEFAULT_SLIPPAGE: SlippageConfig = { stable: 10, volatile: 100 };

export const slippageFor = (origin: CheckoutOrigin, s: SlippageConfig = DEFAULT_SLIPPAGE): number => (origin.stable ? s.stable : s.volatile);

export type PayInRequest = {
  /** An offered origin, or its asset id. */
  origin: CheckoutOrigin | string;
  /** The invoice amount the merchant receives, in USDC base units (6 decimals). */
  amount: bigint;
  /** The merchant's NEAR account that receives the USDC. */
  recipient: string;
  /** The buyer's address on the origin chain, where 1Click returns a failed or short deposit. */
  refundTo: string;
  slippageBps: number;
  /** When refunds begin if the swap is not done: an ISO time, a Date or unix milliseconds. */
  deadline: string | Date | number;
  dry: boolean;
  /** The 1Click channel id, for example `payminto`. */
  referral?: string;
};

const asOrigin = (o: CheckoutOrigin | string): CheckoutOrigin => {
  const found = typeof o === "string" ? originOf(o) : originOf(o.assetId);
  if (!found) throw new Error(`${typeof o === "string" ? o : o.assetId} is not an offered origin`);
  return found;
};

/** `EXACT_OUTPUT` of native USDC on NEAR to the merchant's account, deposited and refunded on the origin chain. */
export function payInQuoteRequest(r: PayInRequest): QuoteRequest {
  const origin = asOrigin(r.origin);
  if (r.amount <= 0n) throw new Error("amount must be positive");
  if (!isAccountId(r.recipient)) throw new Error("recipient must be a NEAR account id");
  if (!isOriginAddress(origin, r.refundTo)) throw new Error(`the refund address is not a valid ${origin.chainName} address`);
  if (!Number.isInteger(r.slippageBps) || r.slippageBps < 0 || r.slippageBps > 10_000) throw new Error("slippage must be an integer from 0 to 10000 basis points");
  const ms = r.deadline instanceof Date ? r.deadline.getTime() : typeof r.deadline === "number" ? r.deadline : Date.parse(r.deadline);
  if (!Number.isFinite(ms)) throw new Error("deadline must be a time");
  return {
    dry: r.dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: r.slippageBps,
    originAsset: origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_MAINNET_USDC_ASSET,
    amount: r.amount.toString(),
    refundTo: r.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: r.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(ms).toISOString(),
    ...(r.referral ? { referral: r.referral } : {}),
  };
}

export type PayInCheckOptions = {
  /** The merchant's verified NEAR account: the only recipient a quote may name. */
  recipient: string;
  /** The 1Click manager key; only tests and the simulated mode pass another one. */
  managerPublicKey?: string;
  now?: number;
};

const INT = /^(0|[1-9][0-9]*)$/;

/**
 * Everything that must hold before a buyer is shown a deposit address (or a dry price): 1Click signed the quote, the
 * echoed request is what was asked, the merchant receives exactly the amount (`minAmountOut == amount`), the recipient
 * is the merchant's verified account, and for a wet quote a well-formed deposit address for the origin chain with no
 * memo and a deadline in the future. Returns the refusals; empty means the quote passed.
 */
export function checkPayInQuote(asked: QuoteRequest, res: QuoteResponse, o: PayInCheckOptions): string[] {
  const refusals: string[] = [];
  const got = res.quoteRequest;
  const q = res.quote;
  const now = o.now ?? Date.now();

  if (!verifyQuoteSignature(res, o.managerPublicKey)) refusals.push("the quote signature does not verify against the 1Click manager key");
  if (got.dry !== asked.dry) refusals.push(asked.dry ? "a dry quote was asked, but 1Click answered a wet one" : "this is a dry quote; it has no deposit address");
  for (const k of ["swapType", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType"] as const) {
    if (got[k] !== asked[k]) refusals.push(`quoteRequest.${k} is ${JSON.stringify(got[k])}, but ${JSON.stringify(asked[k])} was asked`);
  }
  if (got.recipient !== o.recipient) refusals.push(`the recipient ${JSON.stringify(got.recipient)} is not the merchant's account ${o.recipient}`);
  if (!(got.slippageTolerance <= asked.slippageTolerance)) refusals.push("quoted slippage is above what was asked");
  if (got.customRecipientMsg !== undefined || q.customRecipientMsg !== undefined) refusals.push("the quote carries customRecipientMsg, which the docs say can lose funds");
  const origin = originOf(got.originAsset);
  if (!origin) refusals.push(`${got.originAsset} is not an offered origin`);

  const ints = [q.amountIn, q.minAmountIn, q.amountOut, q.minAmountOut].every((v) => typeof v === "string" && INT.test(v));
  if (!ints) refusals.push("the quote amounts are not integers");
  else {
    if (q.minAmountOut !== asked.amount) refusals.push(`minAmountOut is ${q.minAmountOut}, but the merchant must receive exactly ${asked.amount}`);
    if (BigInt(q.amountOut) < BigInt(asked.amount)) refusals.push(`amountOut ${q.amountOut} is below the invoice amount ${asked.amount}`);
    if (BigInt(q.minAmountIn) > BigInt(q.amountIn) || BigInt(q.minAmountIn) <= 0n) refusals.push(`minAmountIn ${q.minAmountIn} is not between 1 and amountIn ${q.amountIn}`);
  }

  if (!asked.dry) {
    const address = q.depositAddress ?? "";
    if (!address) refusals.push("the quote has no deposit address");
    else if (origin && !isOriginAddress(origin, address)) refusals.push(`the deposit address is not a valid ${origin.chainName} address`);
    if (q.depositMemo) refusals.push("the quote needs a deposit memo, which this checkout never offers");
    if (!q.deadline) refusals.push("the quote has no deadline");
    else if (!(Date.parse(q.deadline) > now)) refusals.push("the quote deadline has passed");
  }
  return refusals;
}

/** The checkout's own state of one quote. `confirmed` and `expired` are the node's (after it read NEAR, or gave up). */
export type IntentsState = "awaiting_deposit" | "deposit_detected" | "incomplete_deposit" | "processing" | "delivered" | "confirmed" | "refunded" | "failed" | "expired";

const STATUS_MAP: Record<ExecutionStatus, IntentsState> = {
  PENDING_DEPOSIT: "awaiting_deposit",
  KNOWN_DEPOSIT_TX: "deposit_detected",
  INCOMPLETE_DEPOSIT: "incomplete_deposit",
  PROCESSING: "processing",
  SUCCESS: "delivered",
  REFUNDED: "refunded",
  FAILED: "failed",
};

/** 1Click status to checkout state. SUCCESS is only `delivered`: the node confirms after reading the delivery itself. */
export function mapStatus(s: ExecutionStatus): IntentsState {
  const out = STATUS_MAP[s];
  if (!out) throw new Error(`unknown 1Click status ${String(s)}`);
  return out;
}

/** Base units as a decimal string with exactly `decimals` places ("5010154", 6 -> "5.010154"). */
export function formatUnits(v: bigint | string, decimals: number): string {
  const x = typeof v === "bigint" ? v : BigInt(v);
  const neg = x < 0n;
  const s = (neg ? -x : x).toString();
  if (decimals === 0) return `${neg ? "-" : ""}${s}`;
  const padded = s.padStart(decimals + 1, "0");
  return `${neg ? "-" : ""}${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

/** A decimal string as an integer scaled by 10^scale, truncated. */
function scaled(v: string, scale: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`not a decimal: ${v}`);
  const frac = (m[3] ?? "").padEnd(scale, "0").slice(0, scale);
  const n = BigInt(`${m[2]}${frac}`);
  return m[1] ? -n : n;
}

export type Amount = { amount: string; formatted: string; symbol: string };

/** What the deposit screen shows, all from the signed quote. Never a constant. */
export type FeeLines = {
  /** What the buyer sends: `amountIn`, slippage buffer included. */
  send_exactly: Amount;
  /** What the merchant receives: `amountOut`, which equals the invoice amount. */
  merchant_receives: Amount;
  /**
   * Swap and delivery cost borne by the buyer: `minAmountIn - amount` in the origin token for a stablecoin, and the
   * difference of the quote's own USD figures for any other token (then `unit` is USD and `amount` is micro-dollars).
   */
  swap_cost: { amount: string; formatted: string; unit: string };
  /** `amountIn - minAmountIn`: returned to the refund address when the price holds. */
  price_buffer: Amount;
  /** What 1Click keeps if it has to refund the deposit, in the origin token. */
  refund_fee: Amount | null;
  /** The delivery fee to NEAR, in USDC, already inside the price. */
  delivery_fee: Amount | null;
  time_estimate_sec: number;
};

const USD_SCALE = 12;

export function feeLines(res: QuoteResponse, origin: Pick<CheckoutOrigin, "symbol" | "decimals" | "stable">): FeeLines {
  const q = res.quote;
  const inAmt = (v: string | bigint): Amount => ({ amount: v.toString(), formatted: formatUnits(v, origin.decimals), symbol: origin.symbol });
  const usdc = (v: string | bigint): Amount => ({ amount: v.toString(), formatted: formatUnits(v, 6), symbol: "USDC" });
  const amountIn = BigInt(q.amountIn);
  const minIn = BigInt(q.minAmountIn);
  let swapCost: FeeLines["swap_cost"];
  if (origin.stable) {
    // Same dollar value, possibly other decimals: the invoice in the origin token's units.
    const out = BigInt(res.quoteRequest.amount);
    const outInOrigin = origin.decimals >= 6 ? out * 10n ** BigInt(origin.decimals - 6) : out / 10n ** BigInt(6 - origin.decimals);
    const cost = minIn - outInOrigin;
    swapCost = { amount: cost.toString(), formatted: formatUnits(cost, origin.decimals), unit: origin.symbol };
  } else {
    const inUsd = scaled(q.amountInUsd, USD_SCALE);
    const outUsd = scaled(q.amountOutUsd, USD_SCALE);
    const minInUsd = amountIn === 0n ? 0n : (inUsd * minIn) / amountIn;
    const diff = minInUsd - outUsd;
    // Micro-dollars, rounded half up.
    const step = 10n ** BigInt(USD_SCALE - 6);
    const micro = (diff + (diff >= 0n ? step / 2n : -step / 2n)) / step;
    swapCost = { amount: micro.toString(), formatted: formatUnits(micro, 6), unit: "USD" };
  }
  return {
    send_exactly: inAmt(amountIn),
    merchant_receives: usdc(q.amountOut),
    swap_cost: swapCost,
    price_buffer: inAmt(amountIn - minIn),
    refund_fee: q.refundFee && INT.test(q.refundFee) ? inAmt(q.refundFee) : null,
    delivery_fee: q.withdrawFee && INT.test(q.withdrawFee) ? usdc(q.withdrawFee) : null,
    time_estimate_sec: q.timeEstimate,
  };
}

/**
 * A 1Click quote refusal in plain words for the buyer. The API's messages are short and technical; the ones recorded
 * live are mapped, anything else gets a generic line (the raw message is still logged by the caller).
 */
export function quoteErrorReason(message: string, destination: { decimals: number; symbol: string } = { decimals: 6, symbol: "USDC" }): string {
  const min = /minimum swap amount is \$(\d+(?:\.\d+)?)/i.exec(message);
  if (min) return `The minimum on this network is $${min[1]}.`;
  const bridge = /try at least (\d+)/i.exec(message);
  if (bridge) return `The bridge needs at least ${formatUnits(BigInt(bridge[1]!), destination.decimals)} ${destination.symbol} for this route.`;
  if (/refundTo is not valid/i.test(message)) return "The refund address is not valid on this network.";
  if (/deadline is not valid/i.test(message)) return "The checkout expires too soon for this route.";
  if (/not supported|unsupported/i.test(message)) return "This token is not supported for this payment.";
  return "NEAR Intents could not quote this route right now.";
}
