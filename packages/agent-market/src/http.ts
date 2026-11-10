import type { z } from "zod";
import { DEFAULT_REQUESTS_PER_MINUTE, MARKET_REQUESTS_PER_MINUTE } from "./constants.ts";
import { MarketError, printable, type MarketErrorCode } from "./errors.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type Clock = {
  /** Unix milliseconds. */
  now: () => number;
  /** Resolves after `ms`, or rejects with an ABORTED MarketError when the signal fires first. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new MarketError("ABORTED", "aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new MarketError("ABORTED", "aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * A sliding one-minute window. `take()` waits until a request may be sent, so a caller in a loop slows down instead of
 * drawing 429s. One limiter is shared by everything a client sends, because the market counts per IP.
 */
export class RateLimiter {
  readonly perMinute: number;
  readonly #clock: Clock;
  #sent: number[] = [];

  constructor(perMinute: number = DEFAULT_REQUESTS_PER_MINUTE, clock: Clock = systemClock) {
    if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > MARKET_REQUESTS_PER_MINUTE) {
      throw new MarketError("INVALID_ARGUMENT", `requestsPerMinute must be a whole number from 1 to ${MARKET_REQUESTS_PER_MINUTE}`);
    }
    this.perMinute = perMinute;
    this.#clock = clock;
  }

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.#clock.now();
      this.#sent = this.#sent.filter((t) => now - t < 60_000);
      if (this.#sent.length < this.perMinute) {
        this.#sent.push(now);
        return;
      }
      await this.#clock.sleep(this.#sent[0]! + 60_000 - now + 1, signal);
    }
  }
}

export type HttpRequest = {
  url: string;
  method: "GET" | "POST" | "PATCH";
  headers?: Record<string, string>;
  /** Sent as a JSON body. */
  json?: unknown;
  timeoutMs: number;
  /** The response body is abandoned once it grows past this many bytes. */
  maxBytes: number;
  signal?: AbortSignal;
};

export type HttpResponse = { status: number; headers: Headers; text: string };

export type HttpOptions = {
  fetch?: FetchLike;
  clock?: Clock;
  requestsPerMinute?: number;
  limiter?: RateLimiter;
  userAgent?: string;
};

/** Refuses anything that is not an https URL, before a request or a credential can leave. */
export function httpsUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MarketError("INVALID_ARGUMENT", "not a URL");
  }
  if (parsed.protocol !== "https:") throw new MarketError("INVALID_ARGUMENT", "only https URLs are requested");
  if (parsed.username || parsed.password) throw new MarketError("INVALID_ARGUMENT", "URLs with credentials are refused");
  return parsed;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new MarketError("RESPONSE_TOO_LARGE", `the response is larger than ${maxBytes} bytes`, { status: res.status });
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MarketError("RESPONSE_TOO_LARGE", `the response is larger than ${maxBytes} bytes`, { status: res.status });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    throw new MarketError("MALFORMED_RESPONSE", "the response is not UTF-8 text", { status: res.status });
  }
}

/** The one place requests leave from: rate limited, timed, size capped, https only, and following no redirect. */
export class Http {
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;

  constructor(o: HttpOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.limiter = o.limiter ?? new RateLimiter(o.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE, this.clock);
    this.#fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#userAgent = o.userAgent ?? "payminto-agent-market/0.1";
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const url = httpsUrl(req.url).toString();
    await this.limiter.take(req.signal);
    if (req.signal?.aborted) throw new MarketError("ABORTED", "aborted");
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    const headers: Record<string, string> = { accept: "application/json", "user-agent": this.#userAgent, ...req.headers };
    if (req.json !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await this.#fetch(url, {
        method: req.method,
        headers,
        ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : {}),
        // A redirect could carry the request, and its credential, to another host.
        redirect: "error",
        signal,
      });
      return { status: res.status, headers: res.headers, text: await readCapped(res, req.maxBytes) };
    } catch (err) {
      if (err instanceof MarketError) throw err;
      if (req.signal?.aborted) throw new MarketError("ABORTED", "aborted");
      if (timeout.aborted) throw new MarketError("TIMEOUT", `no answer within ${req.timeoutMs} ms`);
      throw new MarketError("NETWORK", `the request failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
}

export function parseJson(text: string, what: string, status?: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MarketError("MALFORMED_RESPONSE", `${what} is not JSON`, status === undefined ? {} : { status });
  }
}

/** Validates a decoded value. The error names the field and the rule, never the value. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new MarketError("MALFORMED_RESPONSE", `${what} does not have the documented shape: ${first ? `${first.path.join(".") || "value"}: ${first.message}` : "invalid"}`);
}

/** Validates a value this package was given by its caller. Nothing is sent when it is wrong. */
export function argument<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new MarketError("INVALID_ARGUMENT", `${what}: ${first ? `${first.path.join(".") || "value"} ${first.message}` : "invalid"}`);
}

const STATUS_CODES: Record<number, MarketErrorCode> = { 400: "REJECTED", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 413: "REJECTED", 422: "REJECTED", 429: "RATE_LIMITED" };
const MAX_RETRY_AFTER_SECONDS = 3_600;

/** Turns a non-2xx answer into a typed error. Only the market's short machine code and message are kept. */
export function errorFromResponse(res: HttpResponse, what: string): MarketError {
  const code: MarketErrorCode = STATUS_CODES[res.status] ?? (res.status >= 500 ? "SERVER" : "HTTP");
  let marketCode: string | undefined;
  let detail = "";
  let retryAfter = Number(res.headers.get("retry-after"));
  try {
    const body = JSON.parse(res.text) as unknown;
    if (body !== null && typeof body === "object") {
      const b = body as { error?: unknown; message?: unknown; retry_after?: unknown };
      if (typeof b.error === "string" && /^[a-z0-9_]{1,64}$/.test(b.error)) marketCode = b.error;
      if (typeof b.message === "string") detail = printable(b.message, 300);
      else if (typeof b.error === "string" && !marketCode) detail = printable(b.error, 300);
      if (!Number.isFinite(retryAfter) || retryAfter <= 0) retryAfter = Number(b.retry_after);
    }
  } catch {
    // A plain-text body (the 429 of the thread routes, for example) carries nothing a program can use.
  }
  const retryAfterSeconds = code === "RATE_LIMITED" ? (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), MAX_RETRY_AFTER_SECONDS) : 60) : undefined;
  return new MarketError(code, `${what} answered HTTP ${res.status}${marketCode ? ` ${marketCode}` : ""}${detail ? `: ${detail}` : ""}`, {
    status: res.status,
    ...(marketCode ? { marketCode } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}
