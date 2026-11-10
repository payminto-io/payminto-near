import { DEFAULT_MIN_PAYMENT, checkoutPayTx, checkoutTermsToJson, type CheckoutTerms, type CheckoutWallet } from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { PaymentRow } from "./model.ts";

/**
 * A way a person pays a hosted checkout. The NEAR wallet rail is built in. The seam exists so that the add-ons layer
 * (any-chain checkout through 1Click, mainnet only) can register its own rail without the core importing it: a rail
 * names its method, says whether it can take a payment now, and gives the checkout page what the payer's side needs.
 */
export interface CheckoutRail<View = unknown> {
  readonly method: string;
  /** What the hosted page hands the payer, or null when this rail cannot take this payment now. */
  offer(p: PaymentRow): View | null;
}

/**
 * The `wallet` rail: the payer's NEAR wallet calls `ft_transfer_call(hub, amount, msg)` on the token, where `msg` carries
 * terms the node signed with its checkout key (`checkoutDigest`, checked by the hub against `checkout_key`). The hub
 * returns the tokens for a wrong amount, expired terms, a bad signature or a repeated payment id, and otherwise records
 * the payment under `checkout_id` and credits the merchant. No pre-registration on chain is needed.
 *
 * The terms are for the whole amount due and a payment id can be used once, so this rail takes an untouched payment
 * only. The hub credits the merchant in full, so it carries no fee. The node signs no terms below its minimum checkout
 * amount: the hub refunds such a payment anyway, and each accepted payment writes a permanent record on chain.
 */
export class WalletRail implements CheckoutRail<CheckoutWallet> {
  readonly method = "wallet";
  readonly #chain: ChainClient;
  readonly minAmount: bigint;

  constructor(chain: ChainClient, minAmount: bigint = DEFAULT_MIN_PAYMENT) {
    this.#chain = chain;
    this.minAmount = minAmount;
  }

  terms(p: Pick<PaymentRow, "checkout_id" | "payout" | "amount_due" | "expires_unix">): CheckoutTerms {
    return { paymentId: p.checkout_id, merchant: p.payout, amount: BigInt(p.amount_due), expiryMs: BigInt(p.expires_unix) * 1000n };
  }

  offer(p: PaymentRow): CheckoutWallet | null {
    if (p.amount_paid !== "0" || BigInt(p.fee_total) !== 0n || BigInt(p.amount_due) < this.minAmount) return null;
    const terms = this.terms(p);
    const signature = this.#chain.signCheckout(terms);
    return {
      terms: checkoutTermsToJson(terms),
      signature,
      checkout_key: this.#chain.nodeKey,
      transaction: checkoutPayTx(this.#chain.token, this.#chain.hub, terms, signature),
    };
  }
}
