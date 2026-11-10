/** The part of `fetch` this package uses, so tests and browsers can supply their own. */
export type FetchLike = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type ReadErrorCode =
  /** No answer inside the time limit. */
  | "timeout"
  /** The request never got an HTTP answer. */
  | "network"
  /** An HTTP status other than 200, rate limiting included. */
  | "http"
  /** An answer that is not the documented shape. */
  | "invalid_response"
  /** The RPC node answered with an error this reader does not map to a value. */
  | "rpc"
  /** A view call on an account that has no contract. */
  | "no_contract"
  /** A view call on a method the contract does not have. */
  | "method_missing"
  /** The contract ran and failed. */
  | "contract_error";

/** A read that did not produce a value. A check turns it into an unknown fact, never into good news. */
export class ReadError extends Error {
  readonly code: ReadErrorCode;
  /** Which source failed, for example `near-rpc` or `nearblocks`. */
  readonly source: string;
  constructor(code: ReadErrorCode, source: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReadError";
    this.code = code;
    this.source = source;
  }
}

/**
 * One HTTP request with a hard time limit, returning the parsed JSON body of a 200 answer.
 * The limit holds even when the `fetch` in use ignores the abort signal.
 */
export async function fetchJson(
  fetchImpl: FetchLike,
  source: string,
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<unknown> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new ReadError("timeout", source, `${source} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const request = (async () => {
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await fetchImpl(url, { ...init, signal: abort.signal });
      text = await res.text();
    } catch (e) {
      throw new ReadError("network", source, `${source} request failed`, { cause: e });
    }
    if (res.status !== 200) throw new ReadError("http", source, `${source} answered HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ReadError("invalid_response", source, `${source} answered with a body that is not JSON`);
    }
  })();
  // If the time limit wins, the request is left to settle on its own; this keeps its late failure from going unhandled.
  request.catch(() => {});
  try {
    return await Promise.race([request, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);
