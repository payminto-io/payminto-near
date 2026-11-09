/**
 * HSP Agentic Payment as a Payminto payment method (docs/GATEWAY.md section 17): the statuses HashKey's HSP gateway
 * reports, the `hsp` offer a 402 lists, and the HSP fields a payment carries. Runtime-neutral, like gateway.ts.
 *
 * The HSP gateway broadcasts an EIP-3009 (or Permit2) transfer the payer signed into the payment's own fee-splitting
 * DepositForwarder, so the node's deposit watcher, not the HSP status, decides when a payment is paid.
 */
import type { Address, Hex } from "viem";
import { X402_VERSION } from "./x402.ts";

/** Statuses `query_payment` reports, in the order a payment normally passes them. */
export const HSP_PAYMENT_STATUSES = [
  "payment-submitted",
  "payment-verified",
  "payment-processing",
  "payment-included",
  "payment-timeout",
  "payment-safe",
  "payment-finalized",
  "payment-failed",
] as const;
export type HspPaymentStatus = (typeof HSP_PAYMENT_STATUSES)[number];

/**
 * What the node stores as a payment's HSP status: an HSP status once a payment was submitted, else `order-created`
 * (an HSP order exists, nothing signed yet).
 */
export type HspStatus = "order-created" | HspPaymentStatus;

/** Final HSP statuses: polling stops. `payment-safe` is on chain at half the confirmations and is not final. */
export const HSP_FINAL_STATUSES: readonly HspStatus[] = ["payment-finalized", "payment-failed"];

/** True while an HSP payment was submitted and has not reached a final status: the node keeps polling. */
export function isHspInFlight(status: string | null | undefined): boolean {
  return !!status && status !== "order-created" && !HSP_FINAL_STATUSES.includes(status as HspStatus);
}

/** The x402 scheme name of the HSP offer in PAYMENT-REQUIRED. Standard x402 clients ignore it. */
export const HSP_SCHEME = "hsp";

/** HSP payments are priced in USD; Payminto prices in a USD stablecoin, so 1 token unit is quoted as 1 USD. */
export const HSP_CURRENCY = "USD";

/**
 * The `hsp` entry of a 402's `accepts` list: what an agent needs to start an HSP payment. It never signs this entry;
 * it posts its address to `prepareUrl`, signs the EIP-712 data that comes back, and posts the signature to `submitUrl`.
 */
export type HspRequirement = {
  scheme: typeof HSP_SCHEME;
  network: `eip155:${number}`;
  /** Base units of `asset` the payment is due (the HSP quote's token_total_raw must equal it). */
  amount: string;
  asset: Address;
  /** The payment's fee-splitting DepositForwarder, where the HSP gateway sends the transfer. */
  payTo: Address;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: {
    paymentId: string;
    /** POST {payer} returns the EIP-712 data to sign. */
    prepareUrl: string;
    /** POST {payer, signature} submits it through HSP. */
    submitUrl: string;
    /** GET returns the payment's HSP status. */
    statusUrl: string;
    x402Version: typeof X402_VERSION;
  };
};

/** The HSP fields of a payment (merchant API and webhooks). Null on a payment that never had an HSP order. */
export type PaymentHsp = {
  flow_id: string;
  payment_request_id: string | null;
  status: HspStatus;
  /** HSP's reason when the status is payment-failed or payment-timeout. */
  status_reason: string | null;
  /** The transaction the HSP gateway broadcast (HSP `payment.tx_signature`). */
  tx_hash: Hex | null;
  /** True once HSP confirmed the payment is attributed to this team's merchant name. */
  attribution_verified: boolean;
  payer: Address | null;
  submitted_at: string | null;
  updated_at: string | null;
};

/** Whether this node can take HSP payments now, and why not. */
export type HspAvailability = {
  /** off: HSP_MCP_URL is unset. */
  state: "off" | "checking" | "available" | "unavailable";
  reason: "not_allowlisted" | "network_mismatch" | "token_mismatch" | "unreachable" | "tools_missing" | "error" | null;
  message: string | null;
  checked_at: string | null;
  /** HSP's network name and the token's settlement protocol, once get_chain_config matched this node. */
  network: string | null;
  protocol: "eip3009" | "permit2" | null;
};

/** The HSP part of a public checkout view. */
export type CheckoutHsp = {
  availability: HspAvailability["state"];
  /** Plain words for the person paying when HSP cannot be used now. */
  message: string | null;
  status: HspStatus | null;
  status_reason: string | null;
  tx_hash: Hex | null;
  attribution_verified: boolean;
};

/**
 * A base-unit amount of a USD stablecoin as an HSP USD amount string: decimals of the token, trailing zeros trimmed
 * but at least two places ("1.5" is "1.50", 1 unit of a 6-decimal token is "0.000001").
 */
export function hspUsdAmount(baseUnits: bigint, decimals: number): string {
  if (baseUnits < 0n) throw new Error("amount must be non-negative");
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  let frac = (baseUnits % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** The EIP-712 data `prepare_payment` returns, as JSON (numbers may be decimal strings). */
export type HspEip712Json = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * The HSP EIP-712 data in the form viem signs and recovers: the same domain, types and message, with integer fields as
 * bigints (JSON carries them as strings) and EIP712Domain left to viem. Nothing is added, dropped or reordered, so the
 * digest is the one HSP's eip712 describes.
 */
export function hspAgenticTypedData(e: HspEip712Json) {
  const { EIP712Domain: _domain, ...types } = e.types;
  const int = (v: unknown): unknown => ((typeof v === "string" && /^-?\d+$/.test(v)) || typeof v === "number" ? BigInt(v) : v);
  const convert = (type: string, value: unknown): unknown => {
    if (type.endsWith("[]")) return Array.isArray(value) ? value.map((x) => convert(type.slice(0, -2), x)) : value;
    if (/^u?int\d*$/.test(type)) return int(value);
    const fields = types[type];
    if (fields && value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, convert(fields.find((f) => f.name === k)?.type ?? "", v)]));
    }
    return value;
  };
  const domain = { ...e.domain };
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: e.primaryType, message: convert(e.primaryType, e.message) as Record<string, unknown> };
}

/** The inverse of hspUsdAmount: a USD decimal string in base units of a `decimals` token. Throws on extra precision. */
export function hspBaseUnits(usd: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!m) throw new Error(`not a decimal amount: ${usd}`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(`${usd} has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
