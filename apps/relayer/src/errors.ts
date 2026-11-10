/**
 * The error codes of `POST /relay`. The first seven are the published contract; `CALL_FAILED` reports a transaction
 * that was relayed and then refused by the hub, and the last three are plain HTTP conditions.
 */
export type RelayErrorCode =
  | "MALFORMED"
  | "NOT_SPONSORED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "NONCE_USED"
  | "RATE_LIMITED"
  | "RPC_FAILED"
  | "CALL_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "NOT_FOUND"
  | "INTERNAL";

export type RelayErrorDetails = {
  /** On `RPC_FAILED`: true when a transaction was sent and its result is not known. */
  outcomeUnknown?: boolean;
  /** The relayer's transaction, when one was signed. */
  txHash?: string;
  retryAfterSec?: number;
};

type Status = 400 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502;

/** An error rendered as `{ error: { code, message, ...details } }` with its HTTP status. Every message says what to do next. */
export class RelayError extends Error {
  readonly status: Status;
  readonly code: RelayErrorCode;
  readonly details: RelayErrorDetails;
  constructor(status: Status, code: RelayErrorCode, message: string, details: RelayErrorDetails = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

export const malformed = (message: string) => new RelayError(400, "MALFORMED", message);
export const notSponsored = (message: string) => new RelayError(403, "NOT_SPONSORED", message);
export const badSignature = (message: string) => new RelayError(403, "BAD_SIGNATURE", message);
export const expired = (message: string, details?: RelayErrorDetails) => new RelayError(409, "EXPIRED", message, details);
export const nonceUsed = (message: string, details?: RelayErrorDetails) => new RelayError(409, "NONCE_USED", message, details);
export const rateLimited = (message: string, retryAfterSec: number) => new RelayError(429, "RATE_LIMITED", message, { retryAfterSec });
export const rpcFailed = (message: string, outcomeUnknown: boolean, txHash?: string) =>
  new RelayError(502, "RPC_FAILED", message, { outcomeUnknown, ...(txHash ? { txHash } : {}) });
export const callFailed = (message: string, txHash?: string) => new RelayError(422, "CALL_FAILED", message, txHash ? { txHash } : {});
