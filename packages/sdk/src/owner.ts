import {
  budgetIdOf,
  budgetTermsToJson,
  depositBudgetTx,
  openBudgetTx,
  policyHash,
  reclaimTx,
  revokeBudgetTx,
  toHex,
  type AccountId,
  type BudgetTerms,
  type Id32,
  type Network,
  type Policy,
  type PublicKey,
  type WalletTx,
} from "@payminto/protocol";
import { z } from "zod";
import { NodeHttp } from "./node-api.ts";

export type OwnerClientOptions = {
  nodeUrl: string;
  network: Network;
  hub: AccountId;
  token: AccountId;
  /** The owner's NEAR account: the account that signs `open_budget`, because the hub makes the caller the authority. */
  owner: AccountId;
  /** The node's settler account, the only account allowed to include these Budgets in a batch. GET /v1/info `operator`. */
  settler: AccountId;
  /** Node admin credential: POST /v1/budgets is an operator route. */
  adminToken?: string;
  fetch?: typeof fetch;
};

export type CreateBudgetArgs = {
  /** The agent's bare ed25519 key. It needs no NEAR account and no gas. */
  agentPk: PublicKey;
  /** Gross spending limit in atomic units. Escrow is funded separately. */
  cap: bigint;
  validForSeconds: number;
  /** Empty means any payee. At most 16. */
  payees: readonly AccountId[];
  policy: Policy;
  salt?: Id32;
};

/** Covers the Budget record and the storage reserved for `settle_own`. The hub refunds the excess. */
export const DEFAULT_OPEN_BUDGET_DEPOSIT = "100000000000000000000000"; // 0.1 NEAR in yoctoNEAR

const budgetCreatedSchema = z.object({ id: z.string(), status: z.string() }).loose();

/**
 * Owner side: builds Budget terms and the wallet transactions for them, and registers an opened Budget with a node.
 * It never signs or sends anything on chain: every transaction is returned for the owner's own wallet.
 */
export class OwnerClient {
  readonly network: Network;
  readonly hub: AccountId;
  readonly token: AccountId;
  readonly owner: AccountId;
  readonly settler: AccountId;
  readonly #o: OwnerClientOptions;

  constructor(o: OwnerClientOptions) {
    this.#o = o;
    this.network = o.network;
    this.hub = o.hub;
    this.token = o.token;
    this.owner = o.owner;
    this.settler = o.settler;
  }

  /** Builds the terms a Budget commits to. Nothing leaves this process. */
  createBudget(a: CreateBudgetArgs): { terms: BudgetTerms; budgetId: Id32 } {
    if (a.cap <= 0n) throw new Error("cap must be positive");
    if (!(a.validForSeconds > 0)) throw new Error("validForSeconds must be positive");
    if (BigInt(a.policy.perCallCap) > a.cap) throw new Error("policy.perCallCap exceeds cap");
    const terms: BudgetTerms = {
      owner: this.owner,
      agentPk: a.agentPk,
      settler: this.settler,
      cap: a.cap,
      validUntil: BigInt(Date.now()) + BigInt(Math.floor(a.validForSeconds)) * 1000n,
      payees: [...a.payees],
      policyHash: policyHash(a.policy),
      salt: a.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    return { terms, budgetId: budgetIdOf(this.hub, this.network, terms) };
  }

  /** The transaction that opens the Budget. The owner signs it and pays its storage. */
  openTx(terms: BudgetTerms, storageDeposit: string = DEFAULT_OPEN_BUDGET_DEPOSIT): WalletTx {
    return openBudgetTx(this.hub, terms, storageDeposit);
  }

  /** The transaction that funds escrow. It never raises the cap. */
  depositTx(budgetId: Id32, amount: bigint): WalletTx {
    return depositBudgetTx(this.token, this.hub, budgetId, amount);
  }

  /** The on-chain revoke, which starts the settlement grace period. */
  revokeTx(budgetId: Id32): WalletTx {
    return revokeBudgetTx(this.hub, budgetId);
  }

  /** Returns remaining escrow after the settlement deadline. */
  reclaimTx(budgetId: Id32): WalletTx {
    return reclaimTx(this.hub, budgetId);
  }

  #http(): NodeHttp {
    return new NodeHttp(this.#o.nodeUrl, { fetch: this.#o.fetch, bearer: this.#o.adminToken });
  }

  /** POST /v1/budgets: the node checks a Budget already opened on chain and starts clearing it. */
  submit(args: { terms: BudgetTerms; policy: Policy; label: string }) {
    return this.#http().post("/v1/budgets", budgetCreatedSchema, { budget: budgetTermsToJson(args.terms), policy: args.policy, label: args.label });
  }

  /** Stops new vouchers at the node immediately, with the admin credential. The on-chain revoke is `revokeTx`. */
  stopAtNode(budgetId: Id32) {
    return this.#http().post(`/v1/budgets/${budgetId}/revoke`, z.unknown(), {});
  }
}
