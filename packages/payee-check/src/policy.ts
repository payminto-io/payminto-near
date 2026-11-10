import { z } from "zod";
import { isAccountId } from "./account.ts";

/** How much a fired signal weighs. The verdict is the heaviest one: any `block` blocks, else any `warn` warns, else allow. */
export type Severity = "info" | "warn" | "block";

/** Every signal this package can fire, in the order verdicts list them. */
export const SIGNAL_IDS = [
  "invalid_account_id",
  "check_failed",
  "account_missing",
  "lookalike_payee",
  "reported_by_several",
  "reported",
  "code_changed",
  "new_account",
  "account_not_indexed",
  "no_keys_no_contract",
  "token_unregistered",
  "check_incomplete",
  "account_age_unknown",
  "account_age",
  "implicit_account",
  "has_contract",
  "full_access_key",
  "locked_contract",
  "first_payment",
  "paid_before",
] as const;

export type SignalId = (typeof SIGNAL_IDS)[number];

const zSeverity = z.enum(["off", "info", "warn", "block"]);
const zCount = z.number().int().nonnegative();

/**
 * The defaults, chosen so that a block means "this is very likely wrong" and a warn means "a person should look".
 * `off` silences a signal entirely.
 */
export const DEFAULT_SEVERITY: Record<SignalId, z.infer<typeof zSeverity>> = {
  // The payee text is not a NEAR account id. Nothing can be paid to it, and odd characters are a spoofing sign.
  invalid_account_id: "block",
  // The chain could not be read, so nothing is known about the payee.
  check_failed: "block",
  // No such account. A payout cannot land there.
  account_missing: "block",
  // The name is a near miss of an account the Budget already allows. Adding the payee to the Budget clears it.
  lookalike_payee: "block",
  // Enough distinct reporters, or one trusted reporter.
  reported_by_several: "block",
  // At least one report. One reporter can be wrong or hostile, so a person decides.
  reported: "warn",
  // The contract's code was seen to change inside the window. What was reviewed is not what runs now.
  code_changed: "warn",
  // Created inside the minimum age. New is not fraud, but a throwaway account is what a scam uses.
  new_account: "warn",
  // On chain, yet unknown to the indexer: it looks like an account newer than the index.
  account_not_indexed: "warn",
  // No key and no contract: nobody can ever move what is paid there.
  no_keys_no_contract: "warn",
  // Not registered with the settlement token: a payout waits until the payee registers.
  token_unregistered: "warn",
  // A secondary source did not answer, so part of the picture is missing.
  check_incomplete: "warn",
  // The indexer knows the account but not its creation, as with accounts from genesis.
  account_age_unknown: "info",
  // The account is older than the minimum age; the creation date is listed.
  account_age: "info",
  // A key-derived account: the name says nothing about who holds it.
  implicit_account: "info",
  // The payee is a contract. The hash is recorded.
  has_contract: "info",
  // A full-access key can deploy or replace code and move every asset.
  full_access_key: "info",
  // A contract with no keys: only its own code can change it.
  locked_contract: "info",
  // This payer has not paid this payee before.
  first_payment: "info",
  // This payer has paid this payee before; the count and total are listed.
  paid_before: "info",
};

/** Signals that mean nothing could be judged. A policy may choose between warn and block for them, and nothing lighter. */
const MUST_STOP = ["invalid_account_id", "check_failed"] as const satisfies readonly SignalId[];

export const policySchema = z.strictObject({
  /** `new_account` fires for accounts created fewer than this many days ago. */
  minAccountAgeDays: z.number().nonnegative().default(7),
  /** `code_changed` keeps firing for this many days after a change was seen. */
  codeChangeWindowDays: z.number().nonnegative().default(7),
  /**
   * After this many payments from the same payer, `new_account` and `account_not_indexed` drop to info: the payer's own
   * history says more than the account's age. 0 turns this off.
   */
  establishedAfterPayments: zCount.default(3),
  blocklist: z
    .strictObject({
      /** `reported` fires at this many distinct reporters. */
      warnAtReporters: zCount.min(1).default(1),
      /** `reported_by_several` fires at this many distinct reporters. */
      blockAtReporters: zCount.min(1).default(3),
      /** One report from any of these accounts fires `reported_by_several` on its own. */
      trustedReporters: z.array(z.string().refine(isAccountId, "must be a NEAR account id")).max(100).default([]),
    })
    .refine((b) => b.blockAtReporters >= b.warnAtReporters, "blockAtReporters must not be below warnAtReporters")
    .prefault({}),
  lookalike: z
    .strictObject({
      /** The most edits between two names that still count as a lookalike. */
      maxEdits: zCount.default(2),
      /** One edit is tolerated per this many characters of the shorter name. */
      charsPerEdit: zCount.min(1).default(4),
    })
    .prefault({}),
  /** Severity per signal. Give only the ones to change. */
  severity: z
    .partialRecord(z.enum(SIGNAL_IDS), zSeverity)
    .refine((s) => MUST_STOP.every((id) => s[id] === undefined || s[id] === "warn" || s[id] === "block"), `${MUST_STOP.join(" and ")} must be warn or block`)
    .default({}),
});

/** A policy as a caller writes it: every field optional. */
export type PolicyInput = z.input<typeof policySchema>;

/** A policy with every default filled in. */
export type Policy = Omit<z.output<typeof policySchema>, "severity"> & { severity: Record<SignalId, z.infer<typeof zSeverity>> };

/** Fills in defaults and validates. Throws a `ZodError` on a malformed policy, because a guessed policy is not a policy. */
export function resolvePolicy(input: PolicyInput = {}): Policy {
  const p = policySchema.parse(input);
  return { ...p, severity: { ...DEFAULT_SEVERITY, ...p.severity } };
}

export const DEFAULT_POLICY: Policy = resolvePolicy();
