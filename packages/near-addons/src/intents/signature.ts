import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import type { QuoteResponse } from "./types.ts";

/**
 * The 1Click manager key that signs quotes, from `ONE_CLICK_MANAGER_PUB_KEY` in
 * `@defuse-protocol/one-click-sdk-typescript` 0.1.26 (`src/quote-signature.ts`). The recorded live quote in
 * `test/fixtures/oneclick/quote-dry.live.json` verifies against it.
 */
export const ONECLICK_MANAGER_PUBLIC_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/** JSON with keys sorted at every level and undefined members dropped, as `json-stable-stringify` produces. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined || typeof o[k] === "function") continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(o[k])}`);
  }
  return `{${parts.join(",")}}`;
}

const orUndef = <T>(v: T | undefined | null | "" | 0): T | undefined => (v ? v : undefined);

/**
 * The fields 1Click signs, mirroring `buildSignedQuoteRequest` and `buildSignedQuote` in the official SDK. Request fields
 * the SDK drops (`appFees`, `depositMode`, `sessionId` and others) are not covered by the signature.
 */
export function signedQuotePayload(r: QuoteResponse): Record<string, unknown> {
  const q = r.quoteRequest;
  const request = {
    dry: q.dry,
    swapType: q.swapType,
    slippageTolerance: q.slippageTolerance,
    originAsset: q.originAsset,
    depositType: q.depositType,
    destinationAsset: q.destinationAsset,
    amount: q.amount,
    refundTo: q.refundTo,
    refundType: q.refundType,
    recipient: q.recipient,
    recipientType: q.recipientType,
    deadline: q.deadline,
    quoteWaitingTimeMs: orUndef(q.quoteWaitingTimeMs),
    referral: orUndef(q.referral),
    virtualChainRecipient: orUndef(q.virtualChainRecipient),
    virtualChainRefundRecipient: orUndef(q.virtualChainRefundRecipient),
    customRecipientMsg: orUndef(q.customRecipientMsg),
  };
  const x = r.quote;
  const amounts = {
    amountIn: x.amountIn,
    amountInFormatted: x.amountInFormatted,
    amountInUsd: x.amountInUsd,
    minAmountIn: x.minAmountIn,
    amountOut: x.amountOut,
    amountOutFormatted: x.amountOutFormatted,
    amountOutUsd: x.amountOutUsd,
    minAmountOut: x.minAmountOut,
  };
  const quote = q.dry
    ? amounts
    : {
        ...amounts,
        depositAddress: orUndef(x.depositAddress),
        depositMemo: orUndef(x.depositMemo),
        deadline: orUndef(x.deadline),
        timeWhenInactive: orUndef(x.timeWhenInactive),
        timeEstimate: orUndef(x.timeEstimate),
        refundFee: orUndef(x.refundFee),
        withdrawFee: orUndef(x.withdrawFee),
      };
  return { ...request, ...quote, timestamp: r.timestamp };
}

/** The message bytes: the UTF-8 of base58(sha256(stableStringify(payload))). */
export function quoteSigningMessage(r: QuoteResponse): Uint8Array {
  return new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(stableStringify(signedQuotePayload(r))))));
}

const decodeKey = (v: string): Uint8Array => base58.decode(v.startsWith("ed25519:") ? v.slice("ed25519:".length) : v);

/** True only when the 1Click manager key signed this quote. Never throws. */
export function verifyQuoteSignature(r: QuoteResponse, managerPublicKey: string = ONECLICK_MANAGER_PUBLIC_KEY): boolean {
  try {
    return ed25519.verify(decodeKey(r.signature), quoteSigningMessage(r), decodeKey(managerPublicKey));
  } catch {
    return false;
  }
}
