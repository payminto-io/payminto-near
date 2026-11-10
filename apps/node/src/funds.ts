import type { AccountId, Id32 } from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import type { BudgetRow, Store } from "./store.ts";

export type BudgetFunds = { escrow: bigint; credit: bigint };

/**
 * Tracks each Budget's escrow and its owner's withdrawable credit, from the hub. Escrow is what the fail-closed exposure
 * limit counts; credit is shown and named in retry hints, because only `fund_from_credit` turns it into escrow.
 * Every read also checks the on-chain Budget: a revoke the owner sent from their own wallet stops new calls as soon as
 * any read sees it, without waiting for the revocation scan.
 */
export class FundsTracker {
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #events: EventBus;
  readonly #log: Logger;
  readonly #inflight = new Map<Id32, Promise<BudgetFunds>>();
  readonly #warned = new Map<Id32, string>();
  /** The node's clock, so a snapshot's time and its age are read from the same clock as the policy windows. */
  readonly #clockMs: () => number;
  /** Called when a read finds the Budget revoked on chain while the node still has it open. */
  onRevokedOnChain: ((budgetId: Id32) => void) | null = null;

  constructor(store: Store, chain: ChainClient, events: EventBus, log: Logger, clockMs: () => number = () => Date.now()) {
    this.#store = store;
    this.#chain = chain;
    this.#events = events;
    this.#log = log;
    this.#clockMs = clockMs;
  }

  /** How old a snapshot read at `refreshedAt` is now, in milliseconds, on the node's clock. */
  ageMs(refreshedAt: number): number {
    return this.#clockMs() - refreshedAt;
  }

  snapshot(budgetId: Id32) {
    return this.#store.budgetFunds(budgetId);
  }

  /** Reads escrow and credit from the hub; concurrent refreshes of one Budget share a request. */
  refresh(b: Pick<BudgetRow, "id" | "owner">): Promise<BudgetFunds> {
    const pending = this.#inflight.get(b.id);
    if (pending) return pending;
    const p = Promise.all([this.#chain.chain.budget(b.id), this.#chain.chain.creditOf(b.owner)])
      .then(([onchain, credit]) => {
        const f = { escrow: onchain?.escrow ?? 0n, credit };
        this.#store.setBudgetFunds(b.id, f.escrow, f.credit, this.#clockMs());
        if (onchain && onchain.revokedAt !== null && this.#store.budget(b.id)?.status === "open") this.onRevokedOnChain?.(b.id);
        return f;
      })
      .finally(() => this.#inflight.delete(b.id));
    this.#inflight.set(b.id, p);
    return p;
  }

  /** Refreshes when there is no snapshot, or when it is older than `maxAgeMs`. */
  async ensure(b: Pick<BudgetRow, "id" | "owner">, maxAgeMs = Number.POSITIVE_INFINITY): Promise<void> {
    const s = this.snapshot(b.id);
    if (!s || this.ageMs(s.refreshedAt) > maxAgeMs) await this.refresh(b);
  }

  /** Refreshes every Budget with unsettled spend and emits funds.warning when its exposure exceeds escrow. */
  async sweep(): Promise<void> {
    await Promise.all(
      this.#store.budgetsWithOutstanding().map(async (b) => {
        try {
          this.check(b, await this.refresh(b));
        } catch (err) {
          this.#log.warn("funds refresh failed", { budgetId: b.id, err });
        }
      }),
    );
  }

  check(b: Pick<BudgetRow, "id" | "owner">, f: BudgetFunds): void {
    const outstanding = this.#store.budgetOutstanding(b.id);
    if (outstanding > f.escrow) {
      const sig = `${outstanding}:${f.escrow}`;
      if (this.#warned.get(b.id) === sig) return;
      this.#warned.set(b.id, sig);
      this.warn({ budgetId: b.id, owner: b.owner as AccountId, reason: "exposure", outstanding: outstanding.toString(), escrow: f.escrow.toString(), credit: f.credit.toString() });
    } else this.#warned.delete(b.id);
  }

  warn(w: Record<string, string | number | null>): void {
    this.#log.warn("funds warning", w);
    this.#events.emit("funds.warning", { warning: w });
  }
}
