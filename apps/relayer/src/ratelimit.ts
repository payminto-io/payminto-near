import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

type Bucket = { tokens: number; at: number };

/**
 * In-memory token buckets keyed by a string (a client address or a sender account).
 * Each key refills at `perMin` tokens per minute up to `burst`. `perMin` 0 disables the limiter.
 * Memory is bounded: full buckets are dropped first, and past `maxKeys` the oldest keys are evicted.
 */
export class TokenBuckets {
  readonly perMin: number;
  readonly burst: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(opts: { perMin: number; burst: number; maxKeys?: number; now?: () => number }) {
    this.perMin = opts.perMin;
    this.burst = Math.max(1, opts.burst);
    this.#maxKeys = opts.maxKeys ?? 50_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.perMin > 0;
  }

  get size(): number {
    return this.#buckets.size;
  }

  #refilled(b: Bucket, now: number): number {
    return Math.min(this.burst, b.tokens + (Math.max(0, now - b.at) / 60_000) * this.perMin);
  }

  take(key: string): TakeResult {
    if (!this.enabled) return { ok: true };
    const now = this.#now();
    let b = this.#buckets.get(key);
    if (b) {
      b.tokens = this.#refilled(b, now);
      b.at = now;
    } else {
      if (this.#buckets.size >= this.#maxKeys) this.#evict(now);
      b = { tokens: this.burst, at: now };
      this.#buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - b.tokens) / this.perMin) * 60)) };
  }

  #evict(now: number): void {
    // Buckets that have refilled completely behave exactly like a new key, so dropping them loses nothing.
    for (const [key, b] of this.#buckets) {
      if (this.#refilled(b, now) >= this.burst) this.#buckets.delete(key);
    }
    if (this.#buckets.size < this.#maxKeys) return;
    // Still full of active keys: evict the oldest tenth (Map iterates in insertion order).
    let drop = Math.max(1, Math.floor(this.#maxKeys / 10));
    for (const key of this.#buckets.keys()) {
      if (drop-- <= 0) break;
      this.#buckets.delete(key);
    }
  }
}

/**
 * The client address used for per-IP limits. With `trustedHops` reverse proxies in front of the relayer, the client is
 * the entry that many places from the right of X-Forwarded-For (each proxy appends the address it saw); entries further
 * left are client-controlled and ignored. With 0 hops the header is ignored and the socket address is used.
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
