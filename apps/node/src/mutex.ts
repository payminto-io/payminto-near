/**
 * A FIFO async lock. The node sends every hub write (`settle_batch`, `payout`) from one operator key, and two writes in
 * flight at once would race for the key's nonce, so settlement and payouts both take this lock around the call.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.#tail;
    this.#tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
