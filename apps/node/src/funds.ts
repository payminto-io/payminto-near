import type { Address } from "viem";
import type { ChainClient } from "./chain.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./store.ts";

/**
 * Tracks agent wallet balance and hub allowance. Values are refreshed on demand (first sight, or when a
 * stale snapshot would deny a call) and every FUNDS_REFRESH_SEC while there are unsettled calls.
 */
export class FundsTracker {
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #events: EventBus;
  readonly #log: Logger;
  readonly #inflight = new Map<string, Promise<{ balance: bigint; allowance: bigint }>>();
  readonly #warned = new Map<string, string>();

  constructor(store: Store, chain: ChainClient, events: EventBus, log: Logger) {
    this.#store = store;
    this.#chain = chain;
    this.#events = events;
    this.#log = log;
  }

  snapshot(address: Address) {
    return this.#store.funds(address, this.#chain.token);
  }

  /** Reads balance and allowance from chain; concurrent refreshes of one address share a request. */
  refresh(address: Address): Promise<{ balance: bigint; allowance: bigint }> {
    const key = address.toLowerCase();
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const p = this.#chain
      .funds(address)
      .then((f) => {
        this.#store.setFunds(address, this.#chain.token, f.balance, f.allowance);
        return f;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  async ensure(address: Address): Promise<void> {
    if (!this.snapshot(address)) await this.refresh(address);
  }

  /** Refreshes every agent with unsettled spend and emits funds.warning when outstanding exceeds what it can pay. */
  async sweep(): Promise<void> {
    const agents = this.#store.agentsWithOutstanding(this.#chain.token);
    await Promise.all(
      agents.map(async (agent) => {
        try {
          const f = await this.refresh(agent);
          this.check(agent, f);
        } catch (err) {
          this.#log.warn("funds refresh failed", { agent, err });
        }
      }),
    );
  }

  check(agent: Address, f: { balance: bigint; allowance: bigint }): void {
    const outstanding = this.#store.agentOutstanding(agent, this.#chain.token);
    const available = f.balance < f.allowance ? f.balance : f.allowance;
    const key = agent.toLowerCase();
    if (outstanding > available) {
      const sig = `${outstanding}:${available}`;
      if (this.#warned.get(key) === sig) return;
      this.#warned.set(key, sig);
      this.warn({
        agent,
        reason: f.balance < f.allowance ? "balance" : "allowance",
        outstanding: outstanding.toString(),
        balance: f.balance.toString(),
        allowance: f.allowance.toString(),
      });
    } else this.#warned.delete(key);
  }

  warn(w: Record<string, string | number | null>): void {
    this.#log.warn("funds warning", w);
    this.#events.emit("funds.warning", { warning: w });
  }
}
