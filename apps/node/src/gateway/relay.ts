import { BaseError, erc20Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { eip3009Abi, isReceiveAuthorizationSignedBy, isTransferAuthorizationSignedBy, type TokenDomain, type TransferAuthorization } from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import { ApiError } from "../errors.ts";
import type { RelayCall } from "./rails.ts";

const USED_OR_CANCELED = /authorization is used or canceled/i;

const errText = (e: unknown) => (e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ""}` : e instanceof Error ? e.message : String(e));

export type RelayOutcome = {
  receipt: TransactionReceipt;
  /** True when someone else submitted the authorization first; the node credits that transaction. */
  submittedByOther: boolean;
};

/** TransferWithAuthorization (x402 exact) or ReceiveWithAuthorization (PaymentRouter: wallet method, gasless refunds). */
export type AuthorizationKind = "transfer" | "receive";

/**
 * Relays signed EIP-3009 authorizations through the operator's serial sender (GATEWAY.md section 3): verify the
 * signature off chain, check the payer's balance, simulate, then send. An authorization anyone already used is not a
 * failure: its AuthorizationUsed log is looked up and that transaction is returned instead.
 */
export class AuthorizationRelay {
  readonly #chain: ChainClient;
  readonly #domain: TokenDomain;
  readonly #lookbackChunk = 5_000n;

  constructor(chain: ChainClient, domain: TokenDomain) {
    this.#chain = chain;
    this.#domain = domain;
  }

  get domain(): TokenDomain {
    return this.#domain;
  }

  /** EOA signature check; contract wallets (ERC-1271, FiatToken v2.2) are left to the simulation. */
  async verify(kind: AuthorizationKind, message: TransferAuthorization, signature: Hex): Promise<boolean> {
    const signed = kind === "receive" ? isReceiveAuthorizationSignedBy : isTransferAuthorizationSignedBy;
    if (await signed(this.#domain, message, signature)) return true;
    return this.#chain.isContract(message.from).catch(() => false);
  }

  async isUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
    return this.#chain.public.readContract({ address: this.#domain.verifyingContract, abi: eip3009Abi, functionName: "authorizationState", args: [authorizer, nonce] });
  }

  async balanceOf(who: Address): Promise<bigint> {
    return this.#chain.public.readContract({ address: this.#domain.verifyingContract, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  }

  /** The transaction that emitted AuthorizationUsed(authorizer, nonce), searched from `fromBlock` in 5,000-block chunks. */
  async findUsed(authorizer: Address, nonce: Hex, fromBlock: bigint): Promise<TransactionReceipt | null> {
    const latest = await this.#chain.public.getBlockNumber({ cacheTime: 0 });
    const event = eip3009Abi.find((x) => x.type === "event" && x.name === "AuthorizationUsed") as Extract<
      (typeof eip3009Abi)[number],
      { type: "event"; name: "AuthorizationUsed" }
    >;
    for (let from = fromBlock; from <= latest; from += this.#lookbackChunk) {
      const to = from + this.#lookbackChunk - 1n < latest ? from + this.#lookbackChunk - 1n : latest;
      const logs = await this.#chain.public.getLogs({ address: this.#domain.verifyingContract, event, args: { authorizer, nonce }, fromBlock: from, toBlock: to });
      if (logs[0]) return this.#chain.receiptOf(logs[0].transactionHash);
    }
    return null;
  }

  /**
   * Checks, simulates and sends. `onSent` runs synchronously after each broadcast so the caller can persist the hash.
   * Throws ApiError for anything the payer must fix (bad signature, funds, expired or canceled authorization).
   */
  async relay(
    kind: AuthorizationKind,
    call: RelayCall,
    message: TransferAuthorization,
    signature: Hex,
    fromBlock: bigint,
    onSent: (hash: Hex) => void,
  ): Promise<RelayOutcome> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (message.validBefore <= now) throw new ApiError(400, "AUTHORIZATION_EXPIRED", "the authorization has expired");
    if (message.validAfter >= now) throw new ApiError(400, "AUTHORIZATION_NOT_YET_VALID", "the authorization is not valid yet");
    if (!(await this.verify(kind, message, signature))) throw new ApiError(400, "BAD_SIGNATURE", "the signature does not recover to the payer");
    const used = async (): Promise<RelayOutcome> => {
      const r = await this.findUsed(message.from, message.nonce, fromBlock);
      if (!r) throw new ApiError(409, "AUTHORIZATION_CANCELED", "the authorization was canceled by the payer");
      return { receipt: r, submittedByOther: true };
    };
    if (await this.isUsed(message.from, message.nonce)) return used();
    const balance = await this.balanceOf(message.from);
    if (balance < message.value) {
      throw new ApiError(402, "INSUFFICIENT_FUNDS", "the payer's balance is below the authorized amount", { balance: balance.toString(), value: message.value.toString() });
    }
    try {
      await this.#chain.public.call({ account: this.#chain.operator.address, to: call.to, data: call.data });
    } catch (err) {
      if (USED_OR_CANCELED.test(errText(err))) return used();
      throw new ApiError(400, "AUTHORIZATION_REJECTED", `the token rejects the authorization: ${errText(err).trim().slice(0, 200)}`);
    }
    try {
      const receipt = await this.#chain.send(call, { onSent: (tx) => onSent(tx.hash) });
      if (receipt.status !== "success") {
        // Raced: someone submitted the same authorization between our simulation and inclusion.
        if (await this.isUsed(message.from, message.nonce)) return used();
        throw new ApiError(502, "RELAY_REVERTED", `the relay transaction reverted in ${receipt.transactionHash}`);
      }
      return { receipt, submittedByOther: false };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (USED_OR_CANCELED.test(errText(err))) return used();
      throw err;
    }
  }
}
