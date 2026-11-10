/**
 * Shared plumbing for the fetch-based adapters (OpenAI, OpenAI-compatible, Gemini, Replicate): one JSON request with a timeout,
 * provider errors mapped to ModelError, optional retries that honour Retry-After, and key redaction.
 */
import { ModelError, type ModelErrorKind, type Provider } from "../model.ts";

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** The longest wait a client-side retry accepts; anything longer goes back to the caller as the error. */
const MAX_CLIENT_WAIT_MS = 30_000;

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openai_compatible: "the OpenAI-compatible endpoint",
  replicate: "Replicate",
  nearai: "NEAR AI Cloud",
};

/** Key-shaped strings providers sometimes echo back in error messages (masked or not). */
const KEY_PATTERNS = [/sk-[A-Za-z0-9_\-*.]{6,}/g, /AIza[0-9A-Za-z_\-]{10,}/g, /gsk_[A-Za-z0-9*]{6,}/g, /xai-[A-Za-z0-9*]{6,}/g, /r8_[A-Za-z0-9*]{6,}/g];

/** Removes the key, and anything that looks like a key, from text that may reach logs or API responses. */
export function redact(text: string, apiKey: string): string {
  let out = apiKey && apiKey.length >= 4 ? text.split(apiKey).join("[redacted]") : text;
  for (const p of KEY_PATTERNS) out = out.replace(p, "[redacted]");
  return out.length > 500 ? `${out.slice(0, 499)}...` : out;
}

/** Retry-After as milliseconds: delta seconds or an HTTP-date. `retry-after-ms` wins when present. */
export function retryAfterMs(headers: Headers | undefined | null, now = Date.now()): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const v = headers.get("retry-after")?.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** The ModelError kind an HTTP status means. */
export function kindOfStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status === 529 || status === 503 || status >= 500) return "overloaded";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export function httpError(
  provider: Provider,
  status: number,
  detail: string,
  o: { headers?: Headers; apiKey: string; kind?: ModelErrorKind; retryable?: boolean; retryAfterMs?: number | null; label?: string },
): ModelError {
  const kind = o.kind ?? kindOfStatus(status);
  const who = o.label ?? PROVIDER_LABEL[provider];
  const what: Record<ModelErrorKind, string> = {
    auth: `${who} rejected the API key (${status})`,
    rate_limit: `rate limited by ${who} (${status})`,
    overloaded: `${who} is overloaded or failing (${status})`,
    bad_request: `${who} refused the request (${status})`,
    timeout: `${who} timed out (${status})`,
    network: `cannot reach ${who}`,
    refusal: `${who} declined the request`,
    unknown: `${who} error ${status}`,
  };
  const text = detail ? `${what[kind]}: ${redact(detail, o.apiKey)}` : what[kind];
  return new ModelError(kind, text, { status, provider, retryAfterMs: o.retryAfterMs ?? retryAfterMs(o.headers), retryable: o.retryable });
}

/** A failure before any HTTP status: our timeout or the caller's abort (timeout), or the network. */
export function transportError(provider: Provider, err: unknown, apiKey: string, timedOut: boolean, label?: string): ModelError {
  if (err instanceof ModelError) return err;
  const who = label ?? PROVIDER_LABEL[provider];
  const name = err instanceof Error ? err.name : "";
  if (timedOut || name === "AbortError" || name === "TimeoutError") {
    return new ModelError("timeout", timedOut ? `${who} did not answer in time` : `the request to ${who} was aborted`, { provider, cause: err });
  }
  const msg = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
  return new ModelError("network", `cannot reach ${who}: ${redact(msg, apiKey)}`, { provider, cause: err });
}

export type JsonRequest = {
  provider: Provider;
  apiKey: string;
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  /**
   * The request body as the exact text to send, instead of `body`. For providers that sign a hash of the request
   * bytes (NEAR AI Cloud): the caller serializes once and keeps the same text for verification.
   */
  bodyText?: string;
  /** Receives the exact bytes of a 2xx response body, before any parsing. */
  onRawResponse?: (bytes: Uint8Array) => void;
  /** The name errors use for the endpoint, when it is better known than the provider id says (NEAR AI Cloud). */
  label?: string;
  fetch: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Builds the ModelError for a non-2xx answer (each provider reads its own error body). */
  onError: (status: number, body: unknown, headers: Headers) => ModelError;
};

/** One JSON request. Resolves with the parsed body of a 2xx answer, rejects with a ModelError otherwise. */
export async function requestJson(r: JsonRequest): Promise<unknown> {
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), r.timeoutMs);
  const signal = r.signal ? AbortSignal.any([r.signal, timer.signal]) : timer.signal;
  const payload = r.bodyText ?? (r.body === undefined ? undefined : JSON.stringify(r.body));
  try {
    let res: Response;
    try {
      res = await r.fetch(r.url, {
        method: r.method ?? (payload === undefined ? "GET" : "POST"),
        headers: { accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...r.headers },
        body: payload,
        signal,
      });
    } catch (err) {
      throw transportError(r.provider, err, r.apiKey, timer.signal.aborted && !r.signal?.aborted, r.label);
    }
    let text: string;
    try {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.ok) r.onRawResponse?.(bytes);
      text = new TextDecoder().decode(bytes);
    } catch (err) {
      throw transportError(r.provider, err, r.apiKey, timer.signal.aborted && !r.signal?.aborted, r.label);
    }
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) throw r.onError(res.status, body, res.headers);
    if (body === null || typeof body !== "object") {
      throw new ModelError("unknown", `${r.label ?? PROVIDER_LABEL[r.provider]} answered ${res.status} without a JSON body`, { status: res.status, provider: r.provider, retryable: true });
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `once` and retries retryable ModelErrors up to `maxRetries` times, waiting Retry-After (or 1 s, 2 s, 4 s...).
 * A wait longer than 30 seconds is not worth holding a request open for: that error goes back to the caller.
 */
export async function withRetries<T>(maxRetries: number, signal: AbortSignal | undefined, once: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await once();
    } catch (err) {
      if (!(err instanceof ModelError) || !err.retryable || attempt >= maxRetries || signal?.aborted) throw err;
      const wait = err.retryAfterMs ?? 1_000 * 2 ** attempt;
      if (wait > MAX_CLIENT_WAIT_MS) throw err;
      await sleep(wait, signal);
    }
  }
}

/** Joins a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** A message string from the usual provider error bodies ({ error: { message } }, { error: "..." }, { message }). */
export function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.trim().slice(0, 300);
  if (!body || typeof body !== "object") return "";
  const b = body as { error?: unknown; message?: unknown };
  if (typeof b.error === "string") return b.error;
  if (b.error && typeof b.error === "object") {
    const m = (b.error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return typeof b.message === "string" ? b.message : "";
}

/**
 * Tool arguments as an object. Accepts an object, a JSON string of an object, or a JSON string of such a string
 * (double-encoded, as some compatible servers send); an empty string is an empty object. Anything else is an
 * inputError the runtime returns to the model as a tool error.
 */
export function parseToolArguments(raw: unknown): { input: Record<string, unknown>; inputError?: string } {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (raw === undefined || raw === null) return { input: {} };
  if (isObj(raw)) return { input: raw };
  if (typeof raw !== "string") return { input: {}, inputError: `arguments must be a JSON object, got ${Array.isArray(raw) ? "an array" : typeof raw}` };
  let v: unknown = raw;
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    const s: string = v.trim();
    if (s === "") return { input: {} };
    try {
      v = JSON.parse(s);
    } catch {
      return { input: {}, inputError: `arguments are not valid JSON: ${s.length > 120 ? `${s.slice(0, 119)}...` : s}` };
    }
  }
  return isObj(v) ? { input: v } : { input: {}, inputError: `arguments must be a JSON object, got ${Array.isArray(v) ? "an array" : typeof v}` };
}

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
