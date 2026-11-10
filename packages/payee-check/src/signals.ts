import { distinctReporters } from "./blocklist.ts";
import { contractIdOf, type AccountView, type PayeeFacts } from "./facts.ts";
import { findLookalike } from "./lookalike.ts";
import type { Policy, Severity, SignalId } from "./policy.ts";

const DAY_MS = 86_400_000;

/** JSON a signal may carry as facts. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What a signal function finds. The policy adds the severity. */
export type Finding = {
  /** One sentence for a person. Built only from checked values, never from report text. */
  reason: string;
  /** The values behind the reason, for a machine. */
  facts: { [key: string]: Json };
  /** Set by a signal that the policy tells to step down, with the most it may weigh. */
  atMost?: Severity;
};

export type Signal = { id: SignalId; severity: Severity; reason: string; facts: { [key: string]: Json } };

/** A signal: a pure function from facts and policy to a finding, or null when it does not fire. */
export type SignalFn = (facts: PayeeFacts, policy: Policy) => Finding | null;

const day = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : "an unknown date");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const daysAgo = (n: number): string => (n === 0 ? "less than a day ago" : `${plural(n, "day")} ago`);

/** The account view when the account is known to exist. */
function existing(f: PayeeFacts): AccountView | null {
  return f.account.state === "known" ? f.account.value : null;
}

/** True once this payer has paid this payee often enough for their own history to outweigh the account's age. */
function established(f: PayeeFacts, p: Policy): boolean {
  return p.establishedAfterPayments > 0 && f.history.state === "known" && f.history.value.count >= p.establishedAfterPayments;
}

export const invalidAccountId: SignalFn = (f) =>
  f.kind === null ? { reason: "The payee is not a valid NEAR account id, so nothing can be paid to it.", facts: { length: f.payee.length } } : null;

export const checkFailed: SignalFn = (f) =>
  f.kind !== null && f.account.state === "unknown"
    ? { reason: "The chain could not be read, so nothing is known about this payee.", facts: { cause: f.account.reason } }
    : null;

export const accountMissing: SignalFn = (f) => {
  if (f.kind === null || f.account.state !== "known" || f.account.value !== null) return null;
  const reason =
    f.kind === "named"
      ? "No account with this name exists on chain."
      : "This key-derived account does not exist on chain yet: nothing has ever been sent to it.";
  return { reason, facts: { kind: f.kind } };
};

export const lookalikePayee: SignalFn = (f, p) => {
  if (f.kind === null || !f.budgetPayees) return null;
  const m = findLookalike(f.payee, f.budgetPayees, p.lookalike);
  if (!m) return null;
  const how = m.how === "confusable" ? "it reads the same once lookalike characters are folded" : `it is ${plural(m.distance, "edit")} away`;
  return {
    reason: `The name resembles ${m.resembles}, which the Budget allows, but is a different account: ${how}.`,
    facts: { resembles: m.resembles, how: m.how, distance: m.distance },
  };
};

/** Reporter counts shared by the two blocklist signals. */
function reportCounts(f: PayeeFacts, p: Policy): { reporters: string[]; trusted: string[]; blocks: boolean } | null {
  if (f.reports.state !== "known" || f.reports.value.length === 0) return null;
  const reporters = distinctReporters(f.reports.value);
  const trusted = reporters.filter((r) => p.blocklist.trustedReporters.includes(r));
  return { reporters, trusted, blocks: trusted.length > 0 || reporters.length >= p.blocklist.blockAtReporters };
}

export const reportedBySeveral: SignalFn = (f, p) => {
  const c = reportCounts(f, p);
  if (!c || !c.blocks) return null;
  const why = c.trusted.length > 0 ? `including ${plural(c.trusted.length, "trusted reporter")}` : `at or above the limit of ${p.blocklist.blockAtReporters}`;
  return {
    reason: `Reported on the shared blocklist by ${plural(c.reporters.length, "distinct reporter")}, ${why}.`,
    facts: { distinctReporters: c.reporters.length, reporters: c.reporters, trustedReporters: c.trusted, blockAtReporters: p.blocklist.blockAtReporters },
  };
};

export const reported: SignalFn = (f, p) => {
  const c = reportCounts(f, p);
  if (!c || c.blocks || c.reporters.length < p.blocklist.warnAtReporters) return null;
  return {
    reason: `Reported on the shared blocklist by ${plural(c.reporters.length, "distinct reporter")}, below the limit of ${p.blocklist.blockAtReporters} that blocks.`,
    facts: { distinctReporters: c.reporters.length, reporters: c.reporters, blockAtReporters: p.blocklist.blockAtReporters },
  };
};

export const codeChanged: SignalFn = (f, p) => {
  if (f.code.state !== "known") return null;
  const r = f.code.value;
  if (r.changedAtMs === null || f.nowMs - r.changedAtMs > p.codeChangeWindowDays * DAY_MS) return null;
  const what = r.contractId === null ? "the contract was removed" : r.previousContractId === null ? "a contract was deployed" : "the contract code was replaced";
  return {
    reason: `Since an earlier check ${what}: the change was first seen on ${day(r.changedAtMs)}, inside the ${p.codeChangeWindowDays} day window.`,
    facts: { previous: r.previousContractId, current: r.contractId, changeSeenAtMs: r.changedAtMs, windowDays: p.codeChangeWindowDays },
  };
};

export const newAccount: SignalFn = (f, p) => {
  if (f.age.state !== "known" || f.age.value.status !== "known" || !existing(f)) return null;
  const ageMs = Math.max(0, f.nowMs - f.age.value.createdAtMs);
  if (ageMs >= p.minAccountAgeDays * DAY_MS) return null;
  const ageDays = Math.floor(ageMs / DAY_MS);
  const calm = established(f, p);
  return {
    reason:
      `The account was created on ${day(f.age.value.createdAtMs)}, ${daysAgo(ageDays)}, inside the ${p.minAccountAgeDays} day minimum (source: ${f.age.value.source}).` +
      (calm ? " This payer has paid it before, so it is noted only." : ""),
    facts: { createdAtMs: f.age.value.createdAtMs, ageDays, minAccountAgeDays: p.minAccountAgeDays, source: f.age.value.source, creationTx: f.age.value.txHash, established: calm },
    ...(calm ? { atMost: "info" as const } : {}),
  };
};

export const accountNotIndexed: SignalFn = (f, p) => {
  if (f.age.state !== "known" || f.age.value.status !== "not_indexed" || !existing(f)) return null;
  const calm = established(f, p);
  return {
    reason:
      `The account exists on chain but ${f.age.value.source} has never seen it, which is how an account newer than the index looks. Its age is unknown.` +
      (calm ? " This payer has paid it before, so it is noted only." : ""),
    facts: { source: f.age.value.source, established: calm },
    ...(calm ? { atMost: "info" as const } : {}),
  };
};

export const accountAgeUnknown: SignalFn = (f) =>
  f.age.state === "known" && f.age.value.status === "no_record" && existing(f)
    ? {
        reason: `${f.age.value.source} knows the account but holds no creation transaction, as with accounts that exist since genesis. Its age is unknown.`,
        facts: { source: f.age.value.source },
      }
    : null;

export const accountAge: SignalFn = (f, p) => {
  if (f.age.state !== "known" || f.age.value.status !== "known" || !existing(f)) return null;
  const ageMs = Math.max(0, f.nowMs - f.age.value.createdAtMs);
  if (ageMs < p.minAccountAgeDays * DAY_MS) return null;
  const ageDays = Math.floor(ageMs / DAY_MS);
  return {
    reason: `The account was created on ${day(f.age.value.createdAtMs)}, ${daysAgo(ageDays)} (source: ${f.age.value.source}).`,
    facts: { createdAtMs: f.age.value.createdAtMs, ageDays, source: f.age.value.source, creationTx: f.age.value.txHash },
  };
};

export const noKeysNoContract: SignalFn = (f) => {
  const a = existing(f);
  if (!a || f.keys.state !== "known" || f.keys.value.fullAccess + f.keys.value.functionCall > 0 || contractIdOf(a) !== null) return null;
  return { reason: "The account has no access keys and no contract, so nobody can ever move what is paid to it.", facts: { fullAccess: 0, functionCall: 0 } };
};

export const tokenUnregistered: SignalFn = (f) =>
  existing(f) && f.token.state === "known" && !f.token.value.registered
    ? {
        reason: `The account is not registered with the settlement token ${f.token.value.token}, so a payout cannot reach it until it registers.`,
        facts: { token: f.token.value.token },
      }
    : null;

export const checkIncomplete: SignalFn = (f) => {
  // An unreadable account is `check_failed`, and nothing else was read in that case.
  if (f.kind === null || f.account.state !== "known") return null;
  const missing = (["keys", "age", "code", "token", "history", "reports"] as const).flatMap((name) => {
    const fact = f[name];
    return fact.state === "unknown" ? [{ fact: name, cause: fact.reason }] : [];
  });
  if (missing.length === 0) return null;
  return { reason: `Part of the check could not be completed: ${missing.map((m) => m.fact).join(", ")}.`, facts: { missing } };
};

export const implicitAccount: SignalFn = (f) => {
  if (f.kind !== "implicit" && f.kind !== "eth_implicit") return null;
  const from = f.kind === "implicit" ? "an ed25519 public key" : "an Ethereum address";
  return { reason: `This is an implicit account derived from ${from}: its name says nothing about who holds it.`, facts: { kind: f.kind } };
};

export const hasContract: SignalFn = (f) => {
  const a = existing(f);
  const id = a ? contractIdOf(a) : null;
  if (!a || id === null) return null;
  const follows = id.startsWith("global-by-account:") ? a.globalContractAccountId : null;
  return {
    reason: follows
      ? `The account runs the global contract published by ${follows}, whose code can change without this account changing.`
      : `The account is a contract with code ${id}.`,
    facts: { contractId: id, codeHash: a.codeHash, globalContractHash: a.globalContractHash, globalContractAccountId: a.globalContractAccountId },
  };
};

export const fullAccessKey: SignalFn = (f) => {
  const a = existing(f);
  if (!a || f.keys.state !== "known" || f.keys.value.fullAccess === 0) return null;
  const n = `${f.keys.value.more ? "at least " : ""}${plural(f.keys.value.fullAccess, "full-access key")}`;
  return {
    reason:
      contractIdOf(a) !== null
        ? `The contract account has ${n}: whoever holds one can replace the code at any time.`
        : `The account has ${n}, as a personal account does. Its holder could deploy a contract to it later.`,
    facts: { ...f.keys.value },
  };
};

export const lockedContract: SignalFn = (f) => {
  const a = existing(f);
  if (!a || f.keys.state !== "known" || f.keys.value.fullAccess + f.keys.value.functionCall > 0 || contractIdOf(a) === null) return null;
  return { reason: "The contract account has no access keys: only its own code can change it or move its funds.", facts: { fullAccess: 0, functionCall: 0 } };
};

export const firstPayment: SignalFn = (f) =>
  f.history.state === "known" && f.history.value.count === 0 && f.payer !== null
    ? { reason: `${f.payer} has not paid this account before.`, facts: { payer: f.payer, count: 0 } }
    : null;

export const paidBefore: SignalFn = (f) => {
  if (f.history.state !== "known" || f.history.value.count === 0 || f.payer === null) return null;
  const h = f.history.value;
  return {
    reason: `${f.payer} has paid this account ${plural(h.count, "time")} before, ${h.totalPaid} atomic units in total.`,
    facts: { payer: f.payer, count: h.count, totalPaid: h.totalPaid, lastAtMs: h.lastAtMs },
  };
};

/** Every signal by id. `evaluate` runs them in `SIGNAL_IDS` order. */
export const SIGNALS: Record<SignalId, SignalFn> = {
  invalid_account_id: invalidAccountId,
  check_failed: checkFailed,
  account_missing: accountMissing,
  lookalike_payee: lookalikePayee,
  reported_by_several: reportedBySeveral,
  reported,
  code_changed: codeChanged,
  new_account: newAccount,
  account_not_indexed: accountNotIndexed,
  no_keys_no_contract: noKeysNoContract,
  token_unregistered: tokenUnregistered,
  check_incomplete: checkIncomplete,
  account_age_unknown: accountAgeUnknown,
  account_age: accountAge,
  implicit_account: implicitAccount,
  has_contract: hasContract,
  full_access_key: fullAccessKey,
  locked_contract: lockedContract,
  first_payment: firstPayment,
  paid_before: paidBefore,
};
