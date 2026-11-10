import {
  ONECLICK_BASE_URL,
  TERMINAL_STATUSES,
  type ExecutionStatus,
  type OneClickToken,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  type SubmitDepositRequest,
} from "./types.ts";

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** A non-2xx answer from 1Click, or a body that is not the documented shape. */
export class OneClickError extends Error {
  readonly status: number;
  readonly correlationId: string | undefined;
  constructor(status: number, message: string, correlationId?: string) {
    super(`1Click ${status}: ${message}`);
    this.name = "OneClickError";
    this.status = status;
    this.correlationId = correlationId;
  }
}

export type OneClickClientOptions = {
  baseUrl?: string;
  /**
   * Partner JWT from the 1Click partner dashboard, sent as `X-API-Key`. Without one the docs say 1Click adds 25 bps;
   * live quotes on 2026-11-10 showed 1 bp on stablecoin routes and 20 bps on others. Read fees from each quote.
   */
  apiKey?: string;
  fetch?: FetchLike;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const INT = /^(0|[1-9][0-9]*)$/;

function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new OneClickError(0, `unexpected response shape: ${what}`);
}

export function parseQuoteResponse(v: unknown): QuoteResponse {
  need(isObject(v), "quote response is not an object");
  need(isStr(v.signature) && v.signature.startsWith("ed25519:"), "signature");
  need(isStr(v.timestamp), "timestamp");
  need(isObject(v.quoteRequest), "quoteRequest");
  need(isObject(v.quote), "quote");
  const q = v.quote;
  for (const f of ["amountIn", "minAmountIn", "amountOut", "minAmountOut"] as const) need(isStr(q[f]) && INT.test(q[f]), `quote.${f}`);
  need(typeof q.timeEstimate === "number", "quote.timeEstimate");
  return v as unknown as QuoteResponse;
}

export function parseStatusResponse(v: unknown): StatusResponse {
  need(isObject(v), "status response is not an object");
  need(isStr(v.status), "status");
  need(isStr(v.updatedAt), "updatedAt");
  need(isObject(v.swapDetails), "swapDetails");
  return v as unknown as StatusResponse;
}

export function parseTokens(v: unknown): OneClickToken[] {
  need(Array.isArray(v), "tokens is not an array");
  for (const t of v) need(isObject(t) && isStr(t.assetId) && typeof t.decimals === "number" && isStr(t.blockchain) && isStr(t.symbol), "token entry");
  return v as OneClickToken[];
}

/**
 * A thin client for the four 1Click endpoints the exit needs. It never signs and never moves funds: `quote` and
 * `submitDeposit` are POSTs that only describe or report a transfer the human makes from their own wallet.
 */
export class OneClickClient {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;

  constructor(opts: OneClickClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? ONECLICK_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#apiKey) headers["x-api-key"] = this.#apiKey;
    const res = await this.#fetch(`${this.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      throw new OneClickError(res.status, `non-JSON body: ${text.slice(0, 200)}`);
    }
    // The live API answers a quote with 201, so any 2xx is success.
    if (res.status < 200 || res.status > 299) {
      const message = isObject(parsed) && (isStr(parsed.message) || Array.isArray(parsed.message)) ? String(parsed.message) : text.slice(0, 200);
      throw new OneClickError(res.status, message, isObject(parsed) && isStr(parsed.correlationId) ? parsed.correlationId : undefined);
    }
    return parsed;
  }

  /** `GET /v0/tokens`. */
  async tokens(): Promise<OneClickToken[]> {
    return parseTokens(await this.#call("GET", "/v0/tokens"));
  }

  /** `POST /v0/quote`. A dry quote returns no deposit address and commits to nothing. */
  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    if (req.customRecipientMsg !== undefined) throw new Error("customRecipientMsg is never sent: the 1Click docs say funds can be lost with it");
    return parseQuoteResponse(await this.#call("POST", "/v0/quote", req));
  }

  /** `GET /v0/status`. `depositMemo` is required when the quote returned one. */
  async status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    return parseStatusResponse(await this.#call("GET", `/v0/status?${q.toString()}`));
  }

  /** `POST /v0/deposit/submit`. Optional: it only tells 1Click about a deposit the human already sent, to speed it up. */
  async submitDeposit(req: SubmitDepositRequest): Promise<StatusResponse> {
    return parseStatusResponse(await this.#call("POST", "/v0/deposit/submit", req));
  }
}

export type PollOptions = {
  depositMemo?: string;
  intervalMs?: number;
  /** Stop waiting after this long and return the last status seen. */
  timeoutMs?: number;
  onUpdate?: (s: StatusResponse) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const isTerminal = (s: ExecutionStatus): boolean => TERMINAL_STATUSES.includes(s);

/**
 * Polls `/v0/status` until SUCCESS, REFUNDED or FAILED, or until the timeout. `onUpdate` fires on every change of status.
 * A 404 before the deposit is seen is reported as an error, because 1Click does not know the address.
 */
export async function pollStatus(client: OneClickClient, depositAddress: string, opts: PollOptions = {}): Promise<{ final: boolean; last: StatusResponse }> {
  const interval = opts.intervalMs ?? 5_000;
  const timeout = opts.timeoutMs ?? 30 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  let seen: ExecutionStatus | null = null;
  for (;;) {
    const s = await client.status(depositAddress, opts.depositMemo);
    if (s.status !== seen) {
      seen = s.status;
      opts.onUpdate?.(s);
    }
    if (isTerminal(s.status)) return { final: true, last: s };
    if (now() - start >= timeout) return { final: false, last: s };
    await sleep(interval);
  }
}
