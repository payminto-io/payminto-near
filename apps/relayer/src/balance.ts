import type { AccountId } from "@payminto/chain";
import type { RelayChain } from "./chain.ts";
import { YOCTO_PER_NEAR } from "./config.ts";
import type { Logger } from "./logger.ts";

export type BalanceStatus = {
  /** yoctoNEAR as a decimal string, or null before the first successful read. */
  yocto: string | null;
  near: string | null;
  /** True when the balance is below the warning threshold; null while unknown. */
  low: boolean | null;
  checkedAt: string | null;
  /** Why the last read failed, when it did. */
  error: string | null;
};

/** `1234500000000000000000000` to `"1.2345"`, rounded down to four decimals. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = ((yocto % YOCTO_PER_NEAR) * 10_000n) / YOCTO_PER_NEAR;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

/**
 * The relayer's own NEAR balance, read at startup and again when `/health` finds it stale. It only warns: a low
 * balance never blocks a relay, because the network refuses an unaffordable transaction by itself and spends nothing.
 */
export class BalanceWatch {
  readonly #chain: RelayChain;
  readonly #account: AccountId;
  readonly #lowYocto: bigint;
  readonly #log: Logger | undefined;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  #status: BalanceStatus = { yocto: null, near: null, low: null, checkedAt: null, error: null };
  #checkedMs = Number.NEGATIVE_INFINITY;
  #running: Promise<BalanceStatus> | null = null;

  constructor(opts: { chain: RelayChain; account: AccountId; lowYocto: bigint; logger?: Logger; now?: () => number; maxAgeMs?: number }) {
    this.#chain = opts.chain;
    this.#account = opts.account;
    this.#lowYocto = opts.lowYocto;
    this.#log = opts.logger;
    this.#now = opts.now ?? (() => Date.now());
    this.#maxAgeMs = opts.maxAgeMs ?? 60_000;
  }

  status(): BalanceStatus {
    return this.#status;
  }

  /** Reads the balance now. Never throws: a failed read is recorded in `error` and keeps the last known balance. */
  refresh(): Promise<BalanceStatus> {
    this.#running ??= this.#read().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Starts a read in the background when the last one is older than `maxAgeMs`. */
  refreshIfStale(): void {
    if (this.#now() - this.#checkedMs >= this.#maxAgeMs) void this.refresh();
  }

  async #read(): Promise<BalanceStatus> {
    this.#checkedMs = this.#now();
    const checkedAt = new Date(this.#checkedMs).toISOString();
    try {
      const yocto = await this.#chain.balance(this.#account);
      const low = yocto < this.#lowYocto;
      this.#status = { yocto: yocto.toString(), near: formatNear(yocto), low, checkedAt, error: null };
      if (low) {
        this.#log?.warn("relayer balance is low; top it up or relays will start to fail", {
          relayer: this.#account,
          balanceNear: formatNear(yocto),
          warnBelowNear: formatNear(this.#lowYocto),
        });
      }
    } catch (err) {
      this.#status = { ...this.#status, checkedAt, error: err instanceof Error ? (err.message.split("\n")[0] ?? "read failed").slice(0, 200) : "read failed" };
      this.#log?.warn("could not read the relayer balance", { relayer: this.#account, err });
    }
    return this.#status;
  }
}
