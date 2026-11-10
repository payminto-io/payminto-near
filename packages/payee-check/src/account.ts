/** A NEAR account id. The same shape as `AccountId` in `@payminto/chain`, repeated here so this package has no workspace dependency. */
export type AccountId = string;

/**
 * How an account id came to be.
 * - `named`: a registered name such as `acme.near`.
 * - `implicit`: 64 lowercase hex characters, the hex of an ed25519 public key. Anyone can make one offline, for free.
 * - `eth_implicit`: `0x` and 40 lowercase hex characters, derived from an Ethereum address.
 */
export type AccountKind = "named" | "implicit" | "eth_implicit";

// NEAR account id rules: 2 to 64 characters, lowercase alphanumerics separated by single `-`, `_` or `.` characters.
const ACCOUNT = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/;

/**
 * True for a syntactically valid NEAR account id. Anything else is refused before a single read is made, which also
 * rules out every non-ASCII lookalike: a Cyrillic letter is not a valid account id character.
 */
export const isAccountId = (v: unknown): v is AccountId => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);

/** The kind of a valid account id, or null when the text is not an account id at all. */
export function accountKindOf(v: unknown): AccountKind | null {
  if (!isAccountId(v)) return null;
  if (IMPLICIT.test(v)) return "implicit";
  if (ETH_IMPLICIT.test(v)) return "eth_implicit";
  return "named";
}

/**
 * Text from outside, made safe to print or log: control characters and line breaks become spaces and the length is
 * capped. Use it for anything that did not pass `isAccountId`.
 */
export function printable(v: unknown, max = 80): string {
  const flat = String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
