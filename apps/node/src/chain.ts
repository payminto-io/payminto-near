import type { AccountId, Chain, CheckoutTerms, Id32, Keypair, Network, PublicKey, Sig64 } from "@payminto/chain";
import { checkoutDigest, signDigest } from "@payminto/chain";
import { refusalDigest, type RefusalRecord } from "@payminto/protocol";

/**
 * The node's view of NEAR: the `Chain` seam plus the node's own signing key.
 * The key signs per-call acceptance receipts and hosted-checkout terms (the hub's `checkout_key`). It is not a NEAR
 * account key and it cannot move funds: the two digests carry different domains and tags, so neither signature can
 * stand in for the other.
 */
export class ChainClient {
  readonly chain: Chain;
  readonly hub: AccountId;
  readonly token: AccountId;
  readonly network: Network;
  /** The account that settles. */
  readonly operator: AccountId;
  readonly nodeKey: PublicKey;
  readonly #secret: Uint8Array;

  constructor(chain: Chain, nodeKey: Keypair) {
    this.chain = chain;
    this.hub = chain.hub;
    this.token = chain.token;
    this.network = chain.network;
    this.operator = chain.operator;
    this.nodeKey = nodeKey.publicKey;
    this.#secret = nodeKey.secretKey;
  }

  signAcceptance(digest: Id32): Sig64 {
    return signDigest(this.#secret, digest);
  }

  /**
   * Signs the node's record of a refusal (`refusalDigest` in @payminto/protocol, domain "payminto.refused.v1"). The
   * domain differs from the acceptance digest's, so this signature can never stand in for a receipt.
   */
  signRefusal(hub: AccountId, network: Network, record: RefusalRecord): { digest: Id32; nodeSignature: Sig64 } {
    const digest = refusalDigest(hub, network, record);
    return { digest, nodeSignature: signDigest(this.#secret, digest) };
  }

  /** Signs checkout terms for the hub's `ft_on_transfer` payment branch, which checks them against `checkout_key`. */
  signCheckout(terms: CheckoutTerms): Sig64 {
    return signDigest(this.#secret, checkoutDigest(this.hub, this.network, terms));
  }
}
