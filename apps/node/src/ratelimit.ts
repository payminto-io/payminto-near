import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

type Bucket = { tokens: number; at: number };

/**
 * In-memory token buckets keyed by a string (provider id or client IP).
 * Each key refills at `rps` tokens per second up to `burst`. `rps` 0 disables the limiter.
 * Memory is bounded: full buckets are dropped by `prune()`, and past `maxKeys` the oldest keys are evicted.
 */
export class TokenBuckets {
  readonly rps: number;
  readonly burst: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(opts: { rps: number; burst: number; maxKeys?: number; now?: () => number }) {
    this.rps = opts.rps;
    this.burst = Math.max(1, opts.burst);
    this.#maxKeys = opts.maxKeys ?? 50_000;
    this.#now = opts.now ?? (() => performance.now());
  }

  get enabled(): boolean {
    return this.rps > 0;
  }

  get size(): number {
    return this.#buckets.size;
  }

  take(key: string): TakeResult {
    if (!this.enabled) return { ok: true };
    const now = this.#now();
    let b = this.#buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rps);
      b.at = now;
    } else {
      if (this.#buckets.size >= this.#maxKeys) this.#evict();
      b = { tokens: this.burst, at: now };
      this.#buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.rps)) };
  }

  /** Drops buckets that have refilled completely: they behave exactly like a new key. */
  prune(): number {
    const now = this.#now();
    let n = 0;
    for (const [key, b] of this.#buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.rps >= this.burst) {
        this.#buckets.delete(key);
        n++;
      }
    }
    return n;
  }

  #evict(): void {
    if (this.prune() > 0 && this.#buckets.size < this.#maxKeys) return;
    // Still full of active keys: evict the oldest tenth (Map iterates in insertion order).
    let drop = Math.max(1, Math.floor(this.#maxKeys / 10));
    for (const key of this.#buckets.keys()) {
      if (drop-- <= 0) break;
      this.#buckets.delete(key);
    }
  }
}

/**
 * The client address used for per-IP limits. With `trustedHops` reverse proxies in front of the node, the client is the
 * entry that many places from the right of X-Forwarded-For (each proxy appends the address it saw); entries further left
 * are client-controlled and ignored. With 0 hops the header is ignored and the socket address is used.
 */
export function clientIp(c: Context, trustedHops: number): string {
  if (trustedHops > 0) {
    const xff = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = xff.length >= trustedHops ? xff[xff.length - trustedHops] : xff[0];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
