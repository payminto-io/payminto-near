import { revokeMessage, sha256Hex, sha256Text, voucherCallId, type Id32 } from "@payminto/protocol";

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
 * Agent and provider compute it independently; the voucher signature and the receipt leaf both commit to it.
 */
export function computeRequestHash(method: string, url: string, body?: Uint8Array | null): Id32 {
  const u = new URL(url, "http://localhost");
  return sha256Text(["payminto.request.v1", method.toUpperCase(), `${u.pathname}${u.search}`, sha256Hex(body ?? new Uint8Array())].join("\n"));
}

/**
 * The id a clearing node gives the call a voucher pays for. It is a hash of the voucher's own fields, so an agent can
 * ask its node about a voucher it signed without trusting anything a seller returned.
 * This is `voucherCallId` of @payminto/chain under the name the SDK has always exported: the node uses the same
 * function, and the hub contract rebuilds the same id in `settle_own`.
 */
export const callIdOf = voucherCallId;

/**
 * Text written by a party this client does not trust (a seller, a directory entry), made safe to show next to this
 * client's own words: control and invisible format characters removed, whitespace collapsed, length capped.
 * It is still untrusted data. Cleaning it does not make it an instruction.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 3))}...` : flat;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export { revokeMessage };

/** What an agent signs with its Budget key to ask the node to stop accepting its vouchers. */
export const revokeDigest = (budgetId: Id32): Id32 => sha256Text(revokeMessage(budgetId));
