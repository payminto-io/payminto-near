import { printable } from "./account.ts";
import type { Severity, SignalId } from "./policy.ts";
import type { Json } from "./signals.ts";
import type { Verdict, VerdictKind } from "./verdict.ts";

/** A short plain-words name for each signal, for a heading or a badge. */
export const SIGNAL_TITLES: Record<SignalId, string> = {
  invalid_account_id: "Not a valid account name",
  check_failed: "Could not check",
  account_missing: "Account does not exist",
  lookalike_payee: "Looks like an allowed payee",
  reported_by_several: "Reported by several parties",
  reported: "Reported",
  code_changed: "Contract code changed",
  new_account: "New account",
  account_not_indexed: "Unknown to the indexer",
  no_keys_no_contract: "Nobody can move funds from it",
  token_unregistered: "Not registered with the token",
  check_incomplete: "Check incomplete",
  account_age_unknown: "Age unknown",
  account_age: "Account age",
  implicit_account: "Implicit account",
  has_contract: "Contract account",
  full_access_key: "Has a full-access key",
  locked_contract: "Locked contract",
  first_payment: "First payment",
  paid_before: "Paid before",
};

const NOT_CHECKED_LABELS: Record<string, string> = {
  keys: "Access keys",
  age: "Account age (no indexer configured)",
  code: "Contract code changes (no code store configured)",
  token: "Token registration (no settlement token configured)",
  history: "Prior payments (no payer or history source given)",
  reports: "Shared blocklist (no blocklist configured)",
  lookalike: "Lookalike names (no allowed payees given)",
};

export type Tone = "ok" | "caution" | "danger" | "neutral";

export type SignalView = {
  id: SignalId;
  severity: Severity;
  tone: Tone;
  /** A few plain words. */
  title: string;
  /** One full sentence. */
  reason: string;
  /** The values behind the reason, as label and text pairs ready to list. */
  facts: Array<{ label: string; value: string }>;
};

export type ReportView = {
  reporter: string;
  /** The reporter's own words. Render as a quote, as text only. */
  quote: string;
  /** A transaction hash or an https URL. `href` is set only for an https URL. */
  evidence: { label: string; text: string; href: string | null };
  /** ISO 8601. */
  at: string;
};

/** Everything a page needs to show a verdict, already in plain words. All strings are text, never markup. */
export type VerdictView = {
  verdict: VerdictKind;
  tone: Tone;
  /** "Do not pay", "Ask a person first" or "No concerns found". */
  headline: string;
  /** One sentence on what the verdict means for this payee. */
  summary: string;
  /** One sentence on what the person can do now. */
  nextStep: string;
  payee: string;
  /** For example "Named account". */
  accountKind: string;
  /** Heaviest first. */
  signals: SignalView[];
  reports: ReportView[];
  notChecked: Array<{ id: string; label: string }>;
  /** ISO 8601. */
  checkedAt: string;
};

const TONE: Record<Severity, Tone> = { block: "danger", warn: "caution", info: "neutral" };

const iso = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : "unknown");

/** `minAccountAgeDays` becomes `Min account age days`. */
const labelOf = (key: string): string => {
  const words = key.replace(/AtMs$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function textOf(key: string, value: Json): string {
  if (value === null) return "none";
  if (typeof value === "number" && key.endsWith("AtMs")) return iso(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map((v) => (typeof v === "object" && v !== null ? Object.values(v).join(": ") : String(v))).join(", ");
  if (typeof value === "object") return Object.entries(value).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  return String(value);
}

const KINDS = { named: "Named account", implicit: "Implicit account (64 hex characters)", eth_implicit: "Implicit account (Ethereum address)" } as const;

function nextStepOf(v: Verdict): string {
  const ids = new Set(v.signals.filter((s) => s.severity !== "info").map((s) => s.id));
  if (v.verdict === "allow") return "No action is needed.";
  if (ids.has("invalid_account_id")) return "Check the spelling: an account id is 2 to 64 characters of lowercase letters, digits, hyphen, underscore and dot.";
  if (ids.has("check_failed")) return "Try again in a moment. If it keeps failing, check the RPC endpoint.";
  if (ids.has("lookalike_payee")) return "Compare the name with the allowed payee letter by letter. Add it to the Budget only if it really is a different party you mean to pay.";
  if (ids.has("account_missing")) return "Check the spelling and the network. Do not pay an account that does not exist.";
  if (ids.has("reported_by_several") || ids.has("reported")) return "Read the reports and their evidence before paying. Do not add this payee to a Budget unless you know the reports are wrong.";
  if (ids.has("code_changed")) return "Review what the contract does now before paying it again.";
  if (ids.has("token_unregistered")) return "Ask the payee to register with the settlement token, then check again.";
  if (ids.has("check_incomplete")) return "Check again in a moment so the missing parts can be read.";
  return "Confirm with the payee through a channel you trust before paying.";
}

/**
 * Turns a verdict into a view model for a page: the verdict, each signal with its reason and facts, the reports as
 * quotes, and what to do next, all in plain words. Pure, and it adds no judgment of its own.
 */
export function toView(v: Verdict): VerdictView {
  const payee = v.kind === null ? printable(v.payee, 64) : v.payee;
  const weighty = v.signals.filter((s) => s.severity === (v.verdict === "block" ? "block" : "warn"));
  const count = `${weighty.length} ${weighty.length === 1 ? "reason" : "reasons"}`;
  return {
    verdict: v.verdict,
    tone: v.verdict === "block" ? "danger" : v.verdict === "warn" ? "caution" : "ok",
    headline: v.verdict === "block" ? "Do not pay" : v.verdict === "warn" ? "Ask a person first" : "No concerns found",
    summary:
      v.verdict === "block"
        ? `Payments to ${payee} are refused for ${count}.`
        : v.verdict === "warn"
          ? `Payments to ${payee} wait for a person's approval for ${count}.`
          : `Nothing that was checked speaks against paying ${payee}. This is a set of heuristics, not a guarantee.`,
    nextStep: nextStepOf(v),
    payee,
    accountKind: v.kind === null ? "Not an account id" : KINDS[v.kind],
    signals: v.signals.map((s) => ({
      id: s.id,
      severity: s.severity,
      tone: TONE[s.severity],
      title: SIGNAL_TITLES[s.id] ?? s.id,
      reason: s.reason,
      facts: Object.entries(s.facts).map(([key, value]) => ({ label: labelOf(key), value: textOf(key, value) })),
    })),
    reports: v.reports.map((r) => ({
      reporter: r.reporter,
      quote: r.reason,
      evidence: r.evidence.type === "tx" ? { label: "Transaction", text: r.evidence.hash, href: null } : { label: "Link", text: r.evidence.url, href: r.evidence.url },
      at: iso(r.atMs),
    })),
    notChecked: v.notChecked.map((id) => ({ id, label: NOT_CHECKED_LABELS[id] ?? id })),
    checkedAt: iso(v.checkedAtMs),
  };
}
