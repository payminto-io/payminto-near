import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type GasLedgerState = { day: string; usedGas: bigint };

/** Where the daily count is kept. The default keeps it in memory; `FileGasLedger` keeps it across restarts. */
export interface GasLedgerStore {
  load(): GasLedgerState | null;
  save(state: GasLedgerState): void;
}

export class GasLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GasLedgerError";
  }
}

/**
 * The daily count in one small JSON file, replaced atomically on every change. A file that cannot be read as a ledger
 * stops the relayer instead of silently starting the day again from zero.
 */
export class FileGasLedger implements GasLedgerStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  load(): GasLedgerState | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new GasLedgerError(`GAS_LEDGER_PATH: cannot read ${this.path} (${(err as NodeJS.ErrnoException).code ?? "error"}); fix its permissions or point GAS_LEDGER_PATH at a writable file`);
    }
    try {
      const j = JSON.parse(text) as { day?: unknown; usedGas?: unknown };
      if (typeof j.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.day) && typeof j.usedGas === "string" && /^\d{1,30}$/.test(j.usedGas)) {
        return { day: j.day, usedGas: BigInt(j.usedGas) };
      }
    } catch {
      // Falls through to the error below.
    }
    throw new GasLedgerError(`GAS_LEDGER_PATH: ${this.path} is not a gas ledger; delete it to start today's count from zero, then start the relayer again`);
  }

  save(state: GasLedgerState): void {
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ day: state.day, usedGas: state.usedGas.toString() }) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      throw new GasLedgerError(`GAS_LEDGER_PATH: cannot write ${this.path} (${(err as NodeJS.ErrnoException).code ?? "error"}); make its directory writable`);
    }
  }
}

export type ReserveResult = { ok: true } | { ok: false; retryAfterSec: number; remainingGas: bigint };

const DAY_MS = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The global cap on what the relayer spends: gas reserved per UTC day, across all senders.
 * Gas is reserved before a transaction is signed and released only when the relayer knows nothing was sent, so an
 * unknown outcome always counts as spent.
 */
export class DailyGasBudget {
  readonly limitGas: bigint;
  readonly #now: () => number;
  readonly #store: GasLedgerStore | null;
  #state: GasLedgerState;

  constructor(opts: { limitGas: bigint; now?: () => number; store?: GasLedgerStore | null }) {
    this.limitGas = opts.limitGas;
    this.#now = opts.now ?? (() => Date.now());
    this.#store = opts.store ?? null;
    const today = dayOf(this.#now());
    const loaded = this.#store?.load() ?? null;
    this.#state = loaded && loaded.day === today ? loaded : { day: today, usedGas: 0n };
    // Proves the ledger is writable before the first relay, not during it.
    this.#store?.save(this.#state);
  }

  #roll(): void {
    const today = dayOf(this.#now());
    if (this.#state.day !== today) this.#state = { day: today, usedGas: 0n };
  }

  #secondsToReset(): number {
    const now = this.#now();
    return Math.max(1, Math.ceil((Math.floor(now / DAY_MS) * DAY_MS + DAY_MS - now) / 1000));
  }

  /** Takes `gas` out of today's budget, or refuses and leaves the count unchanged. */
  reserve(gas: bigint): ReserveResult {
    this.#roll();
    if (this.#state.usedGas + gas > this.limitGas) {
      return { ok: false, retryAfterSec: this.#secondsToReset(), remainingGas: this.limitGas - this.#state.usedGas };
    }
    const next = { day: this.#state.day, usedGas: this.#state.usedGas + gas };
    // Saved first: if the ledger cannot be written, nothing is reserved and the relay is refused.
    this.#store?.save(next);
    this.#state = next;
    return { ok: true };
  }

  /** Gives a reservation back. Only for a submission that certainly sent nothing. */
  release(gas: bigint): void {
    this.#roll();
    const next = { day: this.#state.day, usedGas: this.#state.usedGas > gas ? this.#state.usedGas - gas : 0n };
    this.#state = next;
    try {
      this.#store?.save(next);
    } catch {
      // The file keeps the higher count, which errs on the side of spending less.
    }
  }

  snapshot(): { day: string; usedGas: bigint; limitGas: bigint; resetsAt: string } {
    this.#roll();
    const now = this.#now();
    return { day: this.#state.day, usedGas: this.#state.usedGas, limitGas: this.limitGas, resetsAt: new Date(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS).toISOString() };
  }
}
