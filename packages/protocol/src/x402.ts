/**
 * x402 v2 transport for Payminto vouchers.
 *
 * Providers answer an unpaid request with HTTP 402 and a PAYMENT-REQUIRED header (base64 JSON).
 * Agents retry with a PAYMENT-SIGNATURE header carrying a signed cumulative voucher.
 * Providers return PAYMENT-RESPONSE with the clearing receipt.
 * The scheme name "payminto-voucher" lets standard x402 clients ignore it and x402-aware gateways list it
 * next to "exact" offers.
 */
import type { Address, Hex } from "viem";

export const X402_VERSION = 2;
export const SCHEME = "payminto-voucher";

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

export type PaymentRequirement = {
  scheme: typeof SCHEME;
  network: `eip155:${number}`;
  asset: Address;
  payTo: Address;
  /** Exact price of this call in atomic units, as a decimal string. */
  amount: string;
  resource: string;
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra: {
    clearingNode: string; // base URL of the clearing node that clears this provider
    clearingHub: Address;
    providerId: string;
    tokenSymbol: string;
    tokenDecimals: number;
  };
};

export type PaymentRequired = {
  x402Version: typeof X402_VERSION;
  error?: string;
  accepts: PaymentRequirement[];
};

export type VoucherPayment = {
  x402Version: typeof X402_VERSION;
  scheme: typeof SCHEME;
  network: `eip155:${number}`;
  payload: {
    mandateId: Hex;
    payee: Address;
    amount: string;
    cumulative: string;
    signature: Hex;
    requestHash: Hex;
  };
};

export type ClearingReceipt = {
  callId: Hex;
  mandateId: Hex;
  payee: Address;
  amount: string;
  cumulative: string;
  requestHash: Hex;
  timestamp: number;
  leaf: Hex;
  /** Operator signature over leaf, proving this node accepted the call before settlement. */
  nodeSignature: Hex;
  node: Address;
};

// Runtime-neutral base64 (Node, browsers, edge) over UTF-8 bytes.
function toBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeHeader(value: unknown): string {
  return toBase64(JSON.stringify(value));
}

export function decodeHeader<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(fromBase64(value)) as T;
  } catch {
    return null;
  }
}
