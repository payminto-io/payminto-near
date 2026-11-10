/**
 * Message tags for signed payloads, per NEP-461: anything at or above 2^31 cannot parse as a NEAR transaction, because
 * a Borsh transaction starts with a u32 account-id length that protocol limits keep far below 2^31.
 *
 * 2147484000 + 20402 is 2^31 + 20754, and 2147484000 + 20403 is 2^31 + 20755. NEP-461 reserves 2^31 + N for off-chain
 * messages of NEP number N, and NEP numbers are three digits today (NEP-413 is 2^31 + 413 = 2147484061), so these
 * values are clear of NEP-413 and of every assigned NEP. "402" is a nod to HTTP 402.
 */
export const VOUCHER_TAG = 2147484000 + 20402;
export const CHECKOUT_TAG = 2147484000 + 20403;

export const VOUCHER_DOMAIN = "payminto.voucher.v1";
export const BUDGET_DOMAIN = "payminto.budget.v1";
export const RECEIPT_DOMAIN = "payminto.receipt.v1";
export const CHECKOUT_DOMAIN = "payminto.checkout.v1";
/** Text domains of the node's call id and of the acceptance the node signs for each call it accepts. */
export const CALL_DOMAIN = "payminto.call.v1";
export const ACCEPTANCE_DOMAIN = "payminto.accepted.v1";

export const MAX_CLAIMS = 100;
/** Payees a Budget can list. */
export const MAX_PAYEES = 16;
/** Distinct payees a Budget with `allow_any_payee` can declare it will ever pay (`max_payees`). */
export const MAX_ANY_PAYEES = 256;
/**
 * What `budgetTermsArgs` declares as `max_payees` for a Budget with no payee list, unless `BudgetTerms.maxPayees`
 * says otherwise. The owner prepays settlement storage for this many payees.
 */
export const DEFAULT_MAX_PAYEES = 16;
/** Payees one `prune` call can clear. */
export const MAX_PRUNE_PAYEES = 100;
export const MAX_PAYOUT_ACCOUNTS = 10;
export const MAX_MERKLE_DEPTH = 32;
/** Receipt keys one settler can register on the hub. Keys are append-only. */
export const MAX_RECEIPT_KEYS = 4;

/** Settlement stays open this long after a revoke, so payees can claim calls already served. */
export const REVOKE_GRACE_MS = 86_400_000n;
/** Settlement stays open this long after a Budget expires, for the same reason. */
export const EXPIRY_GRACE_MS = 3n * 86_400_000n;

/**
 * Codes the hub panics with, sorted. The RPC client maps a panic message starting with one of these onto ChainError.
 * This list is identical to `ALL` in `contracts-near/src/errors.rs`: both sides test against `vectors/errors.json`.
 */
export const HUB_ERRORS = [
  "ACCEPTANCE_KEY_UNKNOWN",
  "ACCEPTANCE_TOO_LATE",
  "ADMIN_IS_HUB",
  "ALREADY_REVOKED",
  "AMOUNT_ABOVE_STEP",
  "BAD_ACCEPTANCE",
  "BAD_SIGNATURE",
  "BATCH_EXISTS",
  "BUDGET_CLOSED",
  "BUDGET_EXISTS",
  "BUDGET_NOT_OPEN",
  "CAP_EXCEEDED",
  "DEPOSIT_REQUIRED",
  "ENCODING_FAILED",
  "INSUFFICIENT_CREDIT",
  "INSUFFICIENT_DEPOSIT",
  "INSUFFICIENT_ESCROW",
  "INSUFFICIENT_GAS",
  "INSUFFICIENT_RESERVE",
  "INSUFFICIENT_STORAGE",
  "INVALID_BUDGET",
  "INVALID_KEY",
  "NET_MISMATCH",
  "NOT_ADMIN",
  "NOT_BUDGET_SETTLER",
  "NOT_OWNER",
  "NOT_PAYEE",
  "NOT_PENDING_ADMIN",
  "NOT_SELF",
  "NOT_SETTLER",
  "ONE_BUDGET_PER_OWNER",
  "ONE_YOCTO_REQUIRED",
  "OVERFLOW",
  "PAYEE_IS_OWNER",
  "PAYEE_NOT_ALLOWED",
  "RECEIPT_KEY_EXISTS",
  "RESERVED_ACCOUNT",
  "STALE_VOUCHER",
  "TOO_EARLY",
  "TOO_MANY_ACCOUNTS",
  "TOO_MANY_CLAIMS",
  "TOO_MANY_RECEIPT_KEYS",
  "UNKNOWN_BUDGET",
  "ZERO_AMOUNT",
  "ZERO_GROSS",
] as const;

/** True for any of the hub's error codes. */
export const isHubError = (v: unknown): v is HubError => typeof v === "string" && (HUB_ERRORS as readonly string[]).includes(v);

/**
 * The hub code a panic message carries, or null. Accepts the bare message (`NOT_OWNER`) and the runtime's wrapped form
 * (`Smart contract panicked: NOT_OWNER`). A code matches only as a whole word, so no code is mistaken for a longer one.
 */
export function hubErrorOf(message: string): HubError | null {
  const text = message.replace(/^.*?Smart contract panicked:\s*/s, "").trim();
  for (const code of HUB_ERRORS) {
    if (text === code || (text.startsWith(code) && /^[^A-Z0-9_]/.test(text.slice(code.length)))) return code;
  }
  return null;
}

export type HubError = (typeof HUB_ERRORS)[number];

export class ChainError extends Error {
  readonly code: HubError;
  constructor(code: HubError, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ChainError";
    this.code = code;
  }
}
