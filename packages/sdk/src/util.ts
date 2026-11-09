import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";

/** Minimal typed event emitter that works in Node, browsers and edge runtimes. */
export class Emitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as (payload: never) => void);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    this.#listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const l of this.#listeners.get(event) ?? []) {
      try {
        (l as (p: Events[K]) => void)(payload);
      } catch {
        // Listener errors never break payment flow.
      }
    }
  }
}

/** Runs tasks with the same key strictly one after another; different keys run in parallel. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#tails.set(key, tail);
    tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

/**
 * Binds a voucher to what it bought: method, path with query, and the body digest.
 * Agent and provider compute it independently; the node records it in the receipt leaf.
 */
export function computeRequestHash(method: string, url: string, body?: Uint8Array | null): Hex {
  const u = new URL(url, "http://localhost");
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "bytes32" }],
      [method.toUpperCase(), `${u.pathname}${u.search}`, keccak256(body ?? new Uint8Array())],
    ),
  );
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Message an agent or owner signs (EIP-191) to revoke a mandate through the node without the admin token. */
export function revokeMessage(mandateId: Hex): string {
  return `Payminto Clearing: revoke mandate ${mandateId.toLowerCase()}`;
}

export function utf8(s: string): Uint8Array {
  return toBytes(s);
}
