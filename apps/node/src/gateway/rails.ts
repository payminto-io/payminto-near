import { encodeFunctionData, erc20Abi, isAddressEqual, parseEventLogs, zeroAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import {
  depositFlushData,
  depositSalt,
  eip3009Abi,
  paymentRef,
  paymentRouterAbi,
  paymentTermsNonce,
  payWithAuthorizationData,
  predictForwarder,
  refundRef,
  type DepositTerms,
  type PaymentTerms,
  type ReceiveAuthorization,
  type TransferAuthorization,
} from "@payminto/protocol";

/** What a payment row binds on chain. Fixed at creation (or re-quote while open and untouched). */
export type PaymentBinding = { paymentId: string; payout: Address; feeRecipient: Address | null; fee: bigint; amountDue: bigint };

export type RelayCall = { to: Address; data: Hex };

/**
 * The chain-touching part of the gateway (GATEWAY.md section 14.2) behind one seam:
 * - deposits and x402 pay the payment's fee-splitting DepositForwarder (EIP-1167 clone with immutable terms);
 * - the wallet method is a TransferWithAuthorization to the same forwarder, so the forwarder is the only place customer
 *   money goes and its fee counter is the single source of truth for the split;
 * - gasless refunds go through PaymentRouter.payWithAuthorization, a ReceiveWithAuthorization to the router whose nonce
 *   is the hash of the terms (payout = the refund recipient, no fee).
 */
export class GatewayRails {
  readonly #chainId: number;
  readonly #token: Address;
  readonly #factory: Address;
  readonly #implementation: Address;
  readonly router: Address;

  constructor(o: { chainId: number; token: Address; factory: Address; implementation: Address; router: Address }) {
    this.#chainId = o.chainId;
    this.#token = o.token;
    this.#factory = o.factory;
    this.#implementation = o.implementation;
    this.router = o.router;
  }

  depositTerms(b: PaymentBinding): DepositTerms {
    return { token: this.#token, payout: b.payout, feeRecipient: b.fee > 0n ? b.feeRecipient! : zeroAddress, fee: b.fee, amountDue: b.amountDue };
  }

  /** The forwarder for these terms (deterministic; may have no code yet). */
  deposit(b: PaymentBinding): { address: Address; salt: Hex } {
    const salt = depositSalt(this.#chainId, b.paymentId);
    return { address: predictForwarder(this.#factory, this.#implementation, this.depositTerms(b), salt), salt };
  }

  flushCall(b: PaymentBinding, salt: Hex): RelayCall {
    return { to: this.#factory, data: depositFlushData(this.depositTerms(b), salt) };
  }

  routerCall(terms: PaymentTerms, m: ReceiveAuthorization, signature: Hex): RelayCall {
    return { to: this.router, data: payWithAuthorizationData(this.#token, terms, m, signature) };
  }

  /** Router terms of a gasless refund: paid to `to`, no fee. */
  refundTerms(refundId: string, to: Address): PaymentTerms {
    return { paymentRef: refundRef(this.#chainId, refundId), payout: to, feeRecipient: zeroAddress, fee: 0n };
  }

  termsNonce(t: PaymentTerms): Hex {
    return paymentTermsNonce(t);
  }

  /** x402 exact: the client's TransferWithAuthorization to the forwarder, relayed on the token. */
  transferCall(m: TransferAuthorization, signature: Hex): RelayCall {
    return {
      to: this.#token,
      data: encodeFunctionData({ abi: eip3009Abi, functionName: "transferWithAuthorization", args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, signature] }),
    };
  }

  /** PaymentRouted(paymentRef, from, payout, value, fee) of a router transaction: the gross value that was paid. */
  routedOf(receipt: TransactionReceipt, ref: Hex, from: Address): { value: bigint; fee: bigint; payout: Address; logIndex: number } | null {
    const logs = parseEventLogs({ abi: paymentRouterAbi, eventName: "PaymentRouted", logs: receipt.logs.filter((l) => isAddressEqual(l.address, this.router)) });
    const hit = logs.find((l) => l.args.paymentRef.toLowerCase() === ref.toLowerCase() && isAddressEqual(l.args.from, from));
    return hit ? { value: hit.args.value, fee: hit.args.fee, payout: hit.args.payout, logIndex: Number(hit.logIndex) } : null;
  }

  /** The token Transfer from `from` to `to` in a receipt. */
  transferOf(receipt: TransactionReceipt, from: Address, to: Address): { value: bigint; logIndex: number } | null {
    const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => isAddressEqual(l.address, this.#token)) });
    const hit = logs.find((l) => isAddressEqual(l.args.from, from) && isAddressEqual(l.args.to, to));
    return hit ? { value: hit.args.value, logIndex: Number(hit.logIndex) } : null;
  }

  paymentRefOf(paymentId: string): Hex {
    return paymentRef(this.#chainId, paymentId);
  }
}
