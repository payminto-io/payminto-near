import {
  agentKeyRefusal,
  budgetIdOf,
  budgetTermsToJson,
  canonicalPayees,
  canonicalPolicy,
  policyHash,
  revokeBudgetTx,
  revokeMessage,
  sha256Text,
  verifyDigest,
  type BudgetTerms,
  type Id32,
  type Policy,
  type Sig64,
  type WalletTx,
} from "@payminto/protocol";
import { ApiError } from "./errors.ts";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import { nowIso, type BudgetRow, type Store } from "./store.ts";

export type CreateBudgetInput = {
  budget: BudgetTerms;
  policy: Policy;
  label: string;
};

/** Digest an agent signs to ask the node to stop accepting its vouchers. */
export const revokeDigest = (budgetId: Id32): Id32 => sha256Text(revokeMessage(budgetId));

/**
 * The node's record of Budgets opened on the hub. Owners open and revoke from their own wallet, because `open_budget`
 * makes the caller the authority and pays its storage, so registering here only mirrors chain state and checks the policy
 * and payee list the owner committed to.
 */
export class BudgetService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #events: EventBus;
  readonly #log: Logger;

  constructor(deps: { db: Database; store: Store; chain: ChainClient; events: EventBus; log: Logger }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#events = deps.events;
    this.#log = deps.log;
  }

  get chain(): ChainClient {
    return this.#chain;
  }

  async create(input: CreateBudgetInput): Promise<BudgetRow> {
    const { hub, network } = this.#chain;
    const m = input.budget;
    if (policyHash(input.policy) !== m.policyHash) throw new ApiError(400, "POLICY_HASH_MISMATCH", "policyHash(policy) does not equal budget.policyHash");
    const cap = m.cap;
    if (BigInt(input.policy.perCallCap) > cap || BigInt(input.policy.dailyCap) <= 0n) {
      throw new ApiError(400, "INVALID_POLICY", "perCallCap must not exceed cap and dailyCap must be positive");
    }
    if (cap <= 0n) throw new ApiError(400, "INVALID_BUDGET", "cap must be positive");
    if (m.validUntil <= BigInt(Date.now())) throw new ApiError(400, "INVALID_BUDGET", "budget already expired");
    if (m.settler !== this.#chain.operator) throw new ApiError(400, "WRONG_SETTLER", `budget.settler must be this node's account ${this.#chain.operator}`);
    // The hub v1 takes any 32 bytes as agent_pk; a key anyone can sign for is refused here, before anything is read or written.
    const weak = agentKeyRefusal(m.agentPk);
    if (weak) throw new ApiError(400, weak.code, weak.message, { agentPk: m.agentPk });
    let payees: string[];
    try {
      payees = canonicalPayees(m.payees);
    } catch (err) {
      throw new ApiError(400, "INVALID_PAYEES", err instanceof Error ? err.message : "invalid payees");
    }

    const id = budgetIdOf(hub, network, { ...m, payees });
    const existing = this.#store.budget(id);
    if (existing && existing.status !== "pending") return existing;

    const onchain = await this.#chain.chain.budget(id);
    if (!onchain) throw new ApiError(409, "BUDGET_NOT_ON_CHAIN", "open this Budget on the hub first, then register it here", { budgetId: id, terms: budgetTermsToJson(m) });

    if (!existing) {
      this.#db.run(
        `INSERT INTO budgets (id, owner, agent, settler, cap, valid_until_ms, policy_hash, salt, policy, payees, label, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id,
        m.owner,
        m.agentPk,
        m.settler,
        cap.toString(),
        Number(m.validUntil),
        m.policyHash,
        m.salt,
        canonicalPolicy(input.policy),
        JSON.stringify(payees),
        input.label,
        nowIso(),
      );
    }
    const row = this.#db.tx(() => {
      this.#db.run("UPDATE budgets SET status = 'open' WHERE id = ? AND status = 'pending'", id);
      const r = this.#store.budget(id)!;
      this.#events.emit("budget.opened", { budget: this.#store.budgetSummary(r, Math.floor(Date.now() / 1000)) });
      return r;
    });
    this.#log.info("budget opened", { budgetId: id, agent: row.agent });
    return row;
  }

  /** Verifies an agent-signed request to stop this Budget. Agents cannot revoke on chain, so this only stops the node. */
  authorizeSignedRevoke(m: BudgetRow, signature: Sig64): "agent" {
    if (!verifyDigest(m.agent, revokeDigest(m.id), signature)) throw new ApiError(403, "BAD_REVOKE_SIGNATURE", "revoke must be signed by the Budget agent key");
    return "agent";
  }

  /** Stops new vouchers immediately. Revoking on chain is the owner's own transaction, returned here as `call` when still needed. */
  async revoke(id: Id32, by: string): Promise<{ budget: ReturnType<Store["budgetSummary"]>; onchain: { revoked: boolean; call: WalletTx | null } }> {
    const m = this.#store.budget(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "budget not found");
    if (m.status !== "revoked") this.#markRevoked(m.id, by);
    const onchain = await this.#chain.chain.budget(m.id).catch(() => null);
    const revoked = !!onchain && onchain.revokedAt !== null;
    return {
      budget: this.#store.budgetSummary(this.#store.budget(m.id)!, Math.floor(Date.now() / 1000)),
      onchain: { revoked, call: revoked ? null : revokeBudgetTx(this.#chain.hub, m.id) },
    };
  }

  #markRevoked(id: Id32, by: string): void {
    this.#db.tx(() => {
      this.#db.run("UPDATE budgets SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?", nowIso(), by, id);
      this.#events.emit("budget.revoked", { budget: this.#store.budgetSummary(this.#store.budget(id)!, Math.floor(Date.now() / 1000)) });
    });
  }

  /**
   * The owner revoked on the hub. New calls stop now, fail closed, even though the hub keeps settlement open for the
   * revoke grace period: the grace exists only so calls accepted before the revoke can still settle.
   */
  revokedOnChain(id: Id32): void {
    const m = this.#store.budget(id);
    if (!m || m.status === "revoked") return;
    this.#markRevoked(m.id, `chain:${m.owner}`);
    this.#log.info("budget revoked on chain", { budgetId: m.id });
  }

  /** Picks up revocations made directly on the hub by owners. Polls chain state, because NEAR needs no log cursor here. */
  async scanRevocations(): Promise<void> {
    for (const m of this.#store.budgets()) {
      if (m.status !== "open") continue;
      const onchain = await this.#chain.chain.budget(m.id);
      if (onchain && onchain.revokedAt !== null) this.revokedOnChain(m.id);
    }
  }
}
