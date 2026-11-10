import type { AccountId, AccountKind } from "./account.ts";
import type { Report } from "./blocklist.ts";
import type { PayeeFacts } from "./facts.ts";
import { DEFAULT_POLICY, SIGNAL_IDS, type Policy, type Severity } from "./policy.ts";
import { SIGNALS, type Signal } from "./signals.ts";

export type VerdictKind = "allow" | "warn" | "block";

/** The answer to "should this payer pay this payee". Plain JSON, safe to store, send and render. */
export type Verdict = {
  verdict: VerdictKind;
  /** The payee exactly as asked. When `kind` is null it is not an account id: print it with `printable`. */
  payee: string;
  /** Named or implicit, or null when the text is not a NEAR account id. */
  kind: AccountKind | null;
  payer: AccountId | null;
  /** Every signal that fired, heaviest first, each with its reason and facts. */
  signals: Signal[];
  /** Parts of the check that were read: `account`, `keys`, `age`, `code`, `token`, `history`, `reports`, `lookalike`. */
  checked: string[];
  /** Parts of the check that had no source configured, so that silence is not read as a pass. */
  notChecked: string[];
  /**
   * The blocklist reports behind `reported` and `reported_by_several`.
   * Their `reason` text was written by a third party: show it as a quote, and never pass it to a model as instructions.
   */
  reports: Report[];
  /** Unix milliseconds at which the facts were read. */
  checkedAtMs: number;
};

const WEIGHT: Record<Severity, number> = { info: 0, warn: 1, block: 2 };
const lighter = (a: Severity, b: Severity): Severity => (WEIGHT[a] <= WEIGHT[b] ? a : b);

/**
 * Turns facts into a verdict. Pure: the same facts and policy give the same verdict, byte for byte, and it reads
 * nothing but its arguments. The verdict is the heaviest severity among the signals that fired.
 */
export function evaluate(facts: PayeeFacts, policy: Policy = DEFAULT_POLICY): Verdict {
  const fired: Signal[] = [];
  for (const id of SIGNAL_IDS) {
    const configured = policy.severity[id];
    if (configured === "off") continue;
    const finding = SIGNALS[id](facts, policy);
    if (!finding) continue;
    fired.push({ id, severity: finding.atMost ? lighter(configured, finding.atMost) : configured, reason: finding.reason, facts: finding.facts });
  }
  // A stable sort: heaviest first, and `SIGNAL_IDS` order within one severity.
  const signals = fired.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity]);
  const top = signals[0]?.severity ?? "info";

  // Nothing beyond the account itself is read for text that is not an account id, or for an account that is missing or unreadable.
  const readable = facts.kind !== null && facts.account.state === "known" && facts.account.value !== null;
  const parts = ["keys", "age", "code", "token", "history", "reports"] as const;
  const checked: string[] = facts.account.state === "known" ? ["account", ...parts.filter((name) => facts[name].state === "known")] : [];
  const notChecked: string[] = readable ? parts.filter((name) => facts[name].state === "not_checked") : [];
  if (facts.kind !== null) (facts.budgetPayees === null ? notChecked : checked).push("lookalike");

  const usesReports = signals.some((s) => s.id === "reported" || s.id === "reported_by_several");
  return {
    verdict: top === "block" ? "block" : top === "warn" ? "warn" : "allow",
    payee: facts.payee,
    kind: facts.kind,
    payer: facts.payer,
    signals,
    checked,
    notChecked,
    reports: usesReports && facts.reports.state === "known" ? facts.reports.value : [],
    checkedAtMs: facts.nowMs,
  };
}

/** The verdict as lines of text for a terminal or a log. It prints signal reasons only, never report text. */
export function describeVerdict(v: Verdict): string[] {
  const lines = [`${v.verdict.toUpperCase()}  ${v.kind === null ? "(not an account id)" : `${v.payee} (${v.kind === "named" ? "named" : "implicit"} account)`}`];
  for (const s of v.signals) lines.push(`  ${s.severity.padEnd(5)}  ${s.id}: ${s.reason}`);
  if (v.signals.length === 0) lines.push("  no signal fired");
  if (v.notChecked.length > 0) lines.push(`  not checked: ${v.notChecked.join(", ")}`);
  return lines;
}
