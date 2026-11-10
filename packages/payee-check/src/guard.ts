import { isAccountId, printable, type AccountId } from "./account.ts";
import type { PayeeCheck } from "./check.ts";
import type { Severity, SignalId } from "./policy.ts";
import type { Verdict, VerdictKind } from "./verdict.ts";

/** What a person is asked when a verdict is warn. */
export type WarnRequest = {
  payer: AccountId;
  payee: AccountId;
  /** Atomic token units. */
  amount: bigint;
  /** The full verdict, reasons included, to show the person. */
  verdict: Verdict;
};

/** Asks a person. Anything other than the exact answer `"approve"` counts as a denial. */
export type WarnHandler = (request: WarnRequest) => Promise<"approve" | "deny">;

/**
 * How a guarded payment ended.
 * - `allowed`: the verdict was allow.
 * - `approved`: the verdict was warn and a person approved.
 * - `denied`: the verdict was warn and a person denied.
 * - `approval_timeout`: the verdict was warn and nobody answered in time.
 * - `approval_error`: the verdict was warn and asking failed.
 * - `no_approver`: the verdict was warn and there is nobody to ask.
 * - `blocked`: the verdict was block.
 * - `check_failed`: the check threw, timed out or answered nonsense, and the failure policy is to block.
 */
export type GuardOutcome = "allowed" | "approved" | "denied" | "approval_timeout" | "approval_error" | "no_approver" | "blocked" | "check_failed";

/** One line of the decision log. Plain JSON. It carries signal reasons, and never the free text of blocklist reports. */
export type GuardLogEntry = {
  event: "payee_guard";
  atMs: number;
  payer: string;
  /** The payee as asked, cut to a printable line. */
  payee: string;
  /** Atomic token units, as a decimal string. */
  amount: string;
  /** The verdict the decision was made on, or `error` when the check produced none. */
  verdict: VerdictKind | "error";
  outcome: GuardOutcome;
  /** True only for `allowed` and `approved`. */
  proceed: boolean;
  signals: Array<{ id: SignalId; severity: Severity; reason: string }>;
  /** Null when nobody was asked. */
  approval: { answer: "approve" | "deny" | "timeout" | "error"; waitedMs: number } | null;
  /** Why the check produced no verdict, or null. */
  error: string | null;
  durationMs: number;
};

export type GuardDecision = {
  /** Sign and send only when this is true. */
  proceed: boolean;
  outcome: GuardOutcome;
  /** Null when the check produced no verdict. */
  verdict: Verdict | null;
  /** One sentence for the agent or the person, built from checked values only. */
  message: string;
  log: GuardLogEntry;
};

export type GuardInput = {
  payer: AccountId;
  /** The payee as the agent got it. It is untrusted text until the check has judged it. */
  payee: string;
  /** Atomic token units. */
  amount: bigint;
  /** The Budget's allowed payees, for the lookalike signal. */
  budgetPayees?: readonly AccountId[] | null;
  check: PayeeCheck;
  /** Asks a person on warn. Without it, warn denies. */
  onWarn?: WarnHandler;
  /** The check must answer within this time. Default 10000. */
  checkTimeoutMs?: number;
  /** The person must answer within this time, or the payment is denied. Default 120000. */
  approvalTimeoutMs?: number;
  /**
   * What to do when the check throws, times out or answers nonsense: `block` refuses, `warn` asks the person with a
   * verdict that says so. Allow is not an option. Default `block`.
   */
  onCheckFailure?: "block" | "warn";
  /** Receives every log entry as it is made. A throwing sink never changes the decision. */
  log?: (entry: GuardLogEntry) => void;
  /** Unix milliseconds. Default `Date.now`. */
  clock?: () => number;
};

const TIMED_OUT = Symbol("timed out");

async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True for a verdict this guard can act on: about the payee that was asked, and no lighter than its own signals.
 * A check that says allow while listing a blocking signal is treated as broken, not believed.
 */
function usable(v: unknown, payee: string): v is Verdict {
  const x = v as Partial<Verdict> | null;
  if (typeof x !== "object" || x === null || x.payee !== payee || !Array.isArray(x.signals)) return false;
  if (x.verdict !== "allow" && x.verdict !== "warn" && x.verdict !== "block") return false;
  const heaviest = x.signals.some((s) => s?.severity === "block") ? "block" : x.signals.some((s) => s?.severity === "warn") ? "warn" : "allow";
  return heaviest === x.verdict;
}

/** The verdict a failed check stands in for when the failure policy is to ask a person. */
function failedCheckVerdict(input: GuardInput, cause: string, nowMs: number): Verdict {
  return {
    verdict: "warn",
    payee: input.payee,
    kind: null,
    payer: input.payer,
    signals: [{ id: "check_failed", severity: "warn", reason: "The payee could not be checked, so nothing is known about it.", facts: { cause } }],
    checked: [],
    notChecked: [],
    reports: [],
    checkedAtMs: nowMs,
  };
}

const MESSAGES: Record<GuardOutcome, string> = {
  allowed: "Payment may proceed: no signal against the payee.",
  approved: "Payment may proceed: a person reviewed the warnings and approved.",
  denied: "Payment refused: a person reviewed the warnings and denied.",
  approval_timeout: "Payment refused: the payee needs a person's approval and nobody answered in time.",
  approval_error: "Payment refused: the payee needs a person's approval and asking failed.",
  no_approver: "Payment refused: the payee needs a person's approval and there is nobody to ask.",
  blocked: "Payment refused: the payee check says block.",
  check_failed: "Payment refused: the payee could not be checked.",
};

/**
 * Decides whether a payment may be signed. It proceeds on allow, asks a person on warn and refuses on block.
 * It fails closed: every path that is not an explicit allow or an explicit approval ends with `proceed: false`, and it
 * never rejects. Call it before signing, and sign only when `proceed` is true.
 */
export async function guardPayment(input: GuardInput): Promise<GuardDecision> {
  const clock = input.clock ?? Date.now;
  const startedMs = clock();
  let verdict: Verdict | null = null;
  let error: string | null = null;
  let approval: GuardLogEntry["approval"] = null;
  let outcome: GuardOutcome;

  try {
    if (!isAccountId(input.payer)) throw new TypeError("payer must be a NEAR account id");
    if (typeof input.amount !== "bigint" || input.amount <= 0n) throw new TypeError("amount must be a positive bigint");
    const answer = await within(
      Promise.resolve().then(() => input.check({ payee: input.payee, payer: input.payer, budgetPayees: input.budgetPayees ?? null })),
      input.checkTimeoutMs ?? 10_000,
    );
    if (answer === TIMED_OUT) throw new Error("the check did not answer in time");
    if (!usable(answer, input.payee)) throw new Error("the check answered without a usable verdict");
    verdict = answer;
  } catch (e) {
    error = printable(e instanceof Error ? e.message : e, 160);
    if (input.onCheckFailure === "warn") verdict = failedCheckVerdict(input, error, clock());
  }

  if (verdict === null) {
    outcome = "check_failed";
  } else if (verdict.verdict === "block") {
    outcome = "blocked";
  } else if (verdict.verdict === "allow") {
    outcome = "allowed";
  } else if (!input.onWarn) {
    outcome = "no_approver";
  } else {
    const askedMs = clock();
    const onWarn = input.onWarn;
    const request: WarnRequest = { payer: input.payer, payee: input.payee, amount: input.amount, verdict };
    let answer: "approve" | "deny" | "timeout" | "error";
    try {
      const said = await within(
        Promise.resolve().then(() => onWarn(request)),
        input.approvalTimeoutMs ?? 120_000,
      );
      answer = said === TIMED_OUT ? "timeout" : said === "approve" ? "approve" : "deny";
    } catch {
      answer = "error";
    }
    approval = { answer, waitedMs: Math.max(0, clock() - askedMs) };
    outcome = answer === "approve" ? "approved" : answer === "deny" ? "denied" : answer === "timeout" ? "approval_timeout" : "approval_error";
  }

  // The single place that grants a payment.
  const proceed = outcome === "allowed" || outcome === "approved";
  const top = verdict?.signals[0];
  const log: GuardLogEntry = {
    event: "payee_guard",
    atMs: startedMs,
    payer: printable(input.payer, 64),
    payee: printable(input.payee, 64),
    amount: typeof input.amount === "bigint" ? input.amount.toString() : printable(input.amount, 40),
    verdict: verdict ? verdict.verdict : "error",
    outcome,
    proceed,
    signals: (verdict?.signals ?? []).map((s) => ({ id: s.id, severity: s.severity, reason: s.reason })),
    approval,
    error,
    durationMs: Math.max(0, clock() - startedMs),
  };
  try {
    input.log?.(log);
  } catch {
    // A broken log sink must not turn a refusal into anything else, or an approval into a crash.
  }
  const detail = !proceed && top && outcome !== "check_failed" ? ` ${top.reason}` : "";
  return { proceed, outcome, verdict, message: `${MESSAGES[outcome]}${detail}`, log };
}
