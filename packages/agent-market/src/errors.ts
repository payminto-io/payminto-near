/** Every way a call to the market can fail, as a code a program can switch on. */
export type MarketErrorCode =
  /** The request did not finish inside its timeout. */
  | "TIMEOUT"
  /** The caller's AbortSignal fired. */
  | "ABORTED"
  /** DNS, TLS or connection failure, or a redirect (this client follows none). */
  | "NETWORK"
  /** HTTP 429: over the market's request limit. `retryAfterSeconds` says how long to wait. */
  | "RATE_LIMITED"
  /** HTTP 401: the agent token is missing, malformed or revoked. Retrying cannot help. */
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  /** HTTP 400, 413 or 422: the request itself is wrong. */
  | "REJECTED"
  /** HTTP 5xx. Retry with backoff. */
  | "SERVER"
  | "HTTP"
  /** The body was not JSON, or did not have the documented shape. */
  | "MALFORMED_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  /** A 402 whose `x402Version` is not 2. */
  | "UNSUPPORTED_VERSION"
  /** The agent cannot take a call now (JSON-RPC -32603 or -32004). Nothing was paid. */
  | "AGENT_UNAVAILABLE"
  /** A 402 with an empty `accepts`: the deployment takes no payments. */
  | "NO_PAYMENT_OPTIONS"
  /** The market answered an unpaid request with something other than a 402 or a JSON-RPC error. */
  | "UNEXPECTED_RESPONSE"
  /** The agent card names an endpoint that is not on the agent's own market host. */
  | "CARD_MISMATCH"
  /** An authenticated call was made on a client that has no agent token. */
  | "TOKEN_REQUIRED"
  /** A value this package was given is invalid. Nothing was sent. */
  | "INVALID_ARGUMENT"
  /** The signing callback returned a signature that does not verify against the payer's key. */
  | "SIGNATURE_INVALID"
  /** The market refused the payment header (HTTP 402 on a paid request). Nothing was charged. */
  | "PAYMENT_REFUSED"
  /** HTTP 502 on a paid request: the payment facilitator is unreachable. Retry with the same header. */
  | "FACILITATOR_UNAVAILABLE"
  /** Any other JSON-RPC error on the A2A endpoint. */
  | "RPC_ERROR";

const RETRYABLE: ReadonlySet<MarketErrorCode> = new Set(["TIMEOUT", "NETWORK", "RATE_LIMITED", "SERVER", "FACILITATOR_UNAVAILABLE"]);

export type MarketErrorDetails = {
  status?: number;
  /** The machine code in the market's error body, for example `invalid_state_transition`. */
  marketCode?: string;
  /** The JSON-RPC error code on an A2A answer. */
  rpcCode?: number;
  retryAfterSeconds?: number;
  /** What the person or program should do next. Defaults to the general advice for the code. */
  nextStep?: string;
};

/** What to do about each kind of failure, when the call site has nothing more specific to say. */
const NEXT_STEP: Record<MarketErrorCode, string> = {
  TIMEOUT: "The market did not answer in time. Try again in a minute.",
  ABORTED: "The call was cancelled. Run it again when ready.",
  NETWORK: "The market could not be reached. Check the network connection, then try again.",
  RATE_LIMITED: "The market allows 60 requests per minute per IP. Wait, then try again.",
  UNAUTHORIZED: "The agent token is missing, malformed or revoked. Ask the agent's owner to create a new token on the agent's Edit page and set AGENT_MARKET_TOKEN.",
  FORBIDDEN: "This token may not do that. An agent token acts only as its own agent; the owner changes listings in the dashboard.",
  NOT_FOUND: "Nothing with that id or handle is published. Run `market search <query>` to find live agents.",
  CONFLICT: "The market already has a record that conflicts with this request. Read its message and change the request.",
  REJECTED: "The market refused the request as invalid. Read its message, fix the request and send it again.",
  SERVER: "The market had an internal error. Try again in a few minutes.",
  HTTP: "The market answered with a status this client does not expect. Try again later.",
  MALFORMED_RESPONSE: "The market answered in a shape this version does not know. Nothing was done. Check SOURCES.md against the live documentation and update the schemas.",
  RESPONSE_TOO_LARGE: "The answer was larger than this client accepts. Narrow the request, for example with a smaller limit.",
  UNSUPPORTED_VERSION: "The market quoted with an x402 version this client does not support. Nothing was signed.",
  AGENT_UNAVAILABLE: "This agent cannot take a call now. Try again in a few minutes or pick another agent with `market search <query>`.",
  NO_PAYMENT_OPTIONS: "The market offered no way to pay for this call. Stop here.",
  UNEXPECTED_RESPONSE: "The market did not answer with a price. Nothing was paid. Try again later.",
  CARD_MISMATCH: "The agent card names an endpoint outside the agent's own market host. Do not call it.",
  TOKEN_REQUIRED: "Set AGENT_MARKET_TOKEN to the agent's `aat_` token. A person creates it on the agent's Edit page under Agent API tokens.",
  INVALID_ARGUMENT: "Fix the value and run the command again.",
  SIGNATURE_INVALID: "The signer returned a signature that does not match the payer's key. Nothing was sent. Check which key the signer uses.",
  PAYMENT_REFUSED: "The market refused the payment header. Nothing was charged. Ask for a new quote and sign again.",
  FACILITATOR_UNAVAILABLE: "The market's payment facilitator is unreachable. Retry later with the same header; do not sign again.",
  RPC_ERROR: "The agent endpoint refused the request. Read its message and change the request.",
};

export class MarketError extends Error {
  readonly code: MarketErrorCode;
  readonly status: number | undefined;
  readonly marketCode: string | undefined;
  readonly rpcCode: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** What to do next, in one or two plain sentences. */
  readonly nextStep: string;

  constructor(code: MarketErrorCode, message: string, details: MarketErrorDetails = {}) {
    super(redact(message));
    this.name = "MarketError";
    this.code = code;
    this.status = details.status;
    this.marketCode = details.marketCode;
    this.rpcCode = details.rpcCode;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.nextStep =
      details.nextStep ?? (code === "RATE_LIMITED" && details.retryAfterSeconds ? `The market allows 60 requests per minute per IP. Wait ${details.retryAfterSeconds} seconds, then try again.` : NEXT_STEP[code]);
  }

  /** True when the same request may succeed later without being changed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

const REDACTED = "[redacted]";

/** Removes anything that looks like an agent token or a bearer credential. Applied to every error message. */
export function redact(text: string): string {
  return text.replace(/aat_[A-Za-z0-9]{4,}/g, REDACTED).replace(/(bearer)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`);
}

/**
 * A value that must never reach a log. String conversion, JSON and `util.inspect` all print `[redacted]`; the value
 * leaves only through `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string" || value.length === 0) throw new MarketError("INVALID_ARGUMENT", "a secret must be a non-empty string");
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** Text from another party, made safe to print on a terminal: control characters removed, length capped. */
export function printable(text: string, max = 200): string {
  const clean = text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}
