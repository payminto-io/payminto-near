import {
  parsePaymentSignature as parseSignatureHeader,
  sameRequirement,
  vouchersOf,
  X402_VERSION,
  type ClearingReceipt,
  type Network,
  type PublicKey,
  type Refusal,
  type SettlementFailure,
  type SettlementSuccess,
  type VoucherRequirement,
} from "@payminto/protocol";
import { ApiError } from "../errors.ts";
import type { PositionJson, VoucherInput } from "../vouchers.ts";

/**
 * The gateway's side of the x402 v2 `payminto-voucher` wire.
 * Every shape comes from packages/protocol/src/x402.ts, the same schemas the SDK, MCP server and agents use, so the
 * gateway and its clients cannot drift. This file only maps them onto the node's errors and voucher inputs.
 */

export type { VoucherRequirement };
export { sameRequirement };

/** PAYMENT-REQUIRED as the gateway builds it: only voucher requirements. */
export type PaymentRequiredV2 = {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: { url: string; description: string };
  accepts: VoucherRequirement[];
};

/** A parsed PAYMENT-SIGNATURE: the requirement it accepted, its vouchers in requirement order, and the agent key that signed them. */
export type ParsedPayment = { accepted: VoucherRequirement; vouchers: VoucherInput[]; payer: PublicKey };

/**
 * Reads PAYMENT-SIGNATURE with the protocol schema: refuses any x402 version but 2, a network other than this node's,
 * and vouchers that do not match the requirement they accepted. Null when the header is absent.
 * Signatures are checked later, by the clearing core.
 */
export function parsePaymentSignature(header: string | null | undefined, network: Network): ParsedPayment | null {
  if (!header) return null;
  const r = parseSignatureHeader(header);
  if (!r.ok) {
    if (r.code === "UNSUPPORTED_VERSION") throw new ApiError(400, "UNSUPPORTED_X402_VERSION", r.message);
    // A readable payment that fails the schema (for example a voucher that does not match the requirement it accepted)
    // is a failed payment: 402 with PAYMENT-RESPONSE, so the agent learns why. Unreadable headers are plain 400s.
    if (r.code === "INVALID") throw new ApiError(402, "INVALID_PAYMENT", r.message);
    throw new ApiError(400, "INVALID_PAYMENT", r.message);
  }
  const { accepted } = r.value;
  if (accepted.network !== network) throw new ApiError(400, "NETWORK_MISMATCH", `network must be ${network}`);
  const vouchers = vouchersOf(r.value);
  return {
    accepted,
    payer: vouchers[0]!.publicKey,
    vouchers: vouchers.map((v) => ({
      budgetId: v.budgetId,
      payee: v.payee,
      amount: BigInt(v.amount),
      cumulative: BigInt(v.cumulative),
      requestHash: v.requestHash,
      signature: v.signature,
    })),
  };
}

export const paymentSuccess = (network: Network, payer: PublicKey | null, receipts: ClearingReceipt[], positions: PositionJson[]): SettlementSuccess => ({
  success: true,
  transaction: "",
  network,
  ...(payer ? { payer } : {}),
  receipts,
  positions,
});

export function paymentFailure(network: Network, errorReason: string, refusal?: Refusal): SettlementFailure {
  return {
    success: false,
    errorReason,
    transaction: "",
    network,
    ...(refusal
      ? {
          refusal: {
            rule: refusal.rule,
            // The refusal's own message: a NET_EXPOSURE given because the hub was unreadable says so.
            message: refusal.message,
            attemptedAmount: refusal.attemptedAmount,
            remainingBudget: refusal.remainingBudget,
            retry: refusal.retry,
          },
        }
      : {}),
  };
}
