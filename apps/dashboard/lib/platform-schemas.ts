/**
 * Wire shapes for the Balance, Earnings and setup screens: `GET /v1/merchant/balance`, `GET /v1/platform/fees/months`
 * and the payout history `GET /v1/merchant` carries. Kept apart from lib/schemas.ts so these screens own their contract.
 */
import { z } from "zod";
import { addressSchema, atomicSchema, timeSchema } from "./schemas";

const payoutStatus = z.enum(["submitted", "confirmed", "failed", "unknown"]);

/** One payout to the business's payout account: what reached it, and the transaction that sent it. */
export const balancePayoutSchema = z.object({
  seq: z.number(),
  status: payoutStatus,
  outcome: z.enum(["pending", "paid", "kept"]),
  amount: atomicSchema,
  credit_before: atomicSchema,
  tx_hash: z.string().nullable(),
  explorer_url: z.string().nullable(),
  at: timeSchema,
});
export type BalancePayout = z.infer<typeof balancePayoutSchema>;

/** One any-chain payment 1Click delivered as USDC to the business's NEAR account. */
export const anyChainDeliverySchema = z.object({
  quote_id: z.string(),
  payment_id: z.string(),
  amount: atomicSchema,
  origin_chain: z.string(),
  origin_symbol: z.string(),
  recipient: addressSchema,
  tx_hash: z.string().nullable(),
  explorer_url: z.string().nullable(),
  mode: z.enum(["live", "simulated"]),
  delivered_at: timeSchema,
});
export type AnyChainDelivery = z.infer<typeof anyChainDeliverySchema>;

/** `GET /v1/merchant/balance`: the open business's money after the hub credited it. */
export const merchantBalanceSchema = z.object({
  object: z.literal("merchant_balance"),
  merchant_id: z.string(),
  payout: addressSchema.nullable(),
  network: z.string(),
  /** The server's last read of the hub, for its payout queue; the page reads the hub itself too. */
  credit: atomicSchema,
  status: z.enum(["due", "waiting_registration", "clear", "none"]),
  checked_at: timeSchema.nullable(),
  last_error: z.string().nullable(),
  in_flight: atomicSchema,
  paid_30d: atomicSchema,
  paid_total: atomicSchema,
  payouts: z.array(balancePayoutSchema),
  any_chain: z.object({ total: atomicSchema, count: z.number(), items: z.array(anyChainDeliverySchema) }),
});
export type MerchantBalance = z.infer<typeof merchantBalanceSchema>;

/** One business-month of platform fees, by the UTC month payments were paid in. */
export const feeMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  merchant_id: z.string(),
  merchant_name: z.string(),
  payments: z.number(),
  volume: atomicSchema,
  platform_fee: atomicSchema,
  method_fee: atomicSchema,
  fee_total: atomicSchema,
});
export type FeeMonth = z.infer<typeof feeMonthSchema>;

export const feeMonthsSchema = z.object({ items: z.array(feeMonthSchema) }).transform((o) => o.items);

/** The payout part of `GET /v1/merchant`: whether the current payout account signed for itself. */
export const payoutHistorySchema = z.object({
  payout: addressSchema.nullable(),
  payout_history: z
    .array(z.object({ old_payout: z.string().nullable(), new_payout: z.string(), proven: z.boolean(), changed_at: z.string() }).passthrough())
    .optional(),
});
export type PayoutHistory = z.infer<typeof payoutHistorySchema>;
