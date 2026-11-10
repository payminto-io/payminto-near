/**
 * The owner's side of the node's payee check: where a Payee of a Budget stands, what the owner may do about it, and
 * the words for each. Pure rules, so every one of them is tested without a node.
 *
 * The node decides (apps/node/src/payees/service.ts). `payeeOutcome` repeats its rule only to tell the owner what the
 * agent's next Call will meet; nothing here approves, and nothing is sent that the owner did not press.
 */
import type { AccountId } from "@payminto/protocol";
import type { PayeeDecisionBody, PayeeReportBody } from "./api";
import { ApiError } from "./http";
import { typedIdMatches } from "./payee-check";
import type { PayeeApproval, PayeeApprovalRequest, PayeeCheck, PayeeSignal, PayeeVerdictKind } from "./schemas";

export const NOTE_MAX = 280;
export const REPORT_REASON_MAX = 280;
export const REPORT_URL_MAX = 300;

/** The words for a verdict, the same as the package's headlines, so a badge needs no code from the package. */
export const VERDICT_WORDS: Record<PayeeVerdictKind, string> = { allow: "No concerns found", warn: "Ask a person first", block: "Do not pay" };

const heavy = (signals: readonly PayeeSignal[], severity: "warn" | "block"): string[] => signals.filter((s) => s.severity === severity).map((s) => s.id);

export type PayeeOutcome =
  | { outcome: "allow" }
  | { outcome: "blocked"; why: "verdict" | "owner_denied" | "check_unavailable" }
  /** The warnings no approval covers. */
  | { outcome: "needs_approval"; newSignals: string[] };

/**
 * What the node will do with the agent's next Call to a Payee, from the verdict it holds and the owner's decision.
 * An approval covers the warnings the owner saw; it stands against a block only with `overrideBlock`, and then only
 * against the blocks the owner saw. A denial refuses whatever the check says.
 */
export function payeeOutcome(signals: readonly PayeeSignal[] | null, approval: Pick<PayeeApproval, "decision" | "signals" | "overrideBlock"> | null): PayeeOutcome {
  if (approval?.decision === "deny") return { outcome: "blocked", why: "owner_denied" };
  if (!signals) return { outcome: "allow" };
  const approved = approval?.decision === "approve";
  const seen = approval?.signals ?? null;
  const blocks = heavy(signals, "block");
  if (blocks.length > 0) {
    const overridden = approved && approval.overrideBlock && seen !== null && blocks.every((id) => seen.includes(id));
    if (!overridden) return { outcome: "blocked", why: blocks.every((id) => id === "check_failed") ? "check_unavailable" : "verdict" };
  }
  const warns = heavy(signals, "warn");
  if (warns.length === 0) return { outcome: "allow" };
  if (!approved) return { outcome: "needs_approval", newSignals: warns };
  const fresh = seen === null ? [] : warns.filter((id) => !seen.includes(id));
  return fresh.length === 0 ? { outcome: "allow" } : { outcome: "needs_approval", newSignals: fresh };
}

export type PayeeStanding =
  /** Nothing speaks against it and nobody decided: the agent may pay it. */
  | "clear"
  /** The owner approved it, and the approval covers what the check says now. */
  | "approved"
  /** The owner approved it against a block. */
  | "approved_override"
  /** A Call waits for the owner's decision. */
  | "waiting"
  /** The check has warnings and nobody decided yet: the agent's next Call to it will wait. */
  | "needs_approval"
  /** Approved before, and the check has a warning the owner has not seen. */
  | "new_warning"
  /** The check blocks it. */
  | "blocked"
  /** The check could not read it and holds nothing about it. */
  | "unreadable"
  /** The owner denied it. */
  | "denied"
  /** The server holds no verdict for it. */
  | "unchecked";

/** Where one Payee stands. `check` is null when the server holds no verdict (the check is off, or it never looked). */
export function standingOf(check: Pick<PayeeCheck, "verdict"> | null, approval: PayeeApproval | null, waiting: PayeeApprovalRequest | null): PayeeStanding {
  const signals = check ? check.verdict.signals.map((s) => ({ id: s.id, severity: s.severity, reason: s.reason })) : null;
  const o = payeeOutcome(signals, approval);
  if (o.outcome === "blocked") return o.why === "owner_denied" ? "denied" : o.why === "check_unavailable" ? "unreadable" : "blocked";
  if (o.outcome === "needs_approval") return waiting ? "waiting" : approval?.decision === "approve" ? "new_warning" : "needs_approval";
  if (approval?.decision === "approve") return approval.overrideBlock ? "approved_override" : "approved";
  return check ? "clear" : waiting ? "waiting" : "unchecked";
}

/** How a badge marks a standing: the verdict icon it borrows, and whether it reads as quiet. */
export const STANDING: Record<PayeeStanding, { label: string; tone: PayeeVerdictKind | "none"; next: string }> = {
  clear: { label: "No concerns found", tone: "allow", next: "The agent may pay it under this Budget." },
  approved: { label: "Approved", tone: "allow", next: "The agent may pay it under this Budget." },
  approved_override: { label: "Approved despite a block", tone: "warn", next: "The agent may pay it, because an owner approved it against the check." },
  waiting: { label: "Waiting for your approval", tone: "warn", next: "A Call was refused and waits. Approve or deny this Payee." },
  needs_approval: { label: "Ask a person first", tone: "warn", next: "The agent's next Call to it is refused until an owner approves." },
  new_warning: { label: "New warning since the approval", tone: "warn", next: "The agent's next Call to it is refused until an owner approves again." },
  blocked: { label: "Do not pay", tone: "block", next: "The agent cannot pay it. Only an explicit approval against the block changes that." },
  unreadable: { label: "Could not check", tone: "block", next: "The server could not read this account. It looks again when the agent tries, or check it now." },
  denied: { label: "Denied", tone: "block", next: "The agent cannot pay it under this Budget until the denial is withdrawn." },
  unchecked: { label: "Not checked by the server", tone: "none", next: "The server holds no verdict for it." },
};

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Where the owner is in a decision. `review`: Approve and Deny. `blocked`: the check blocks the Payee, so Approve is
 * not offered; the owner types the account id and chooses "Approve anyway", which sends `overrideBlock`.
 */
export type DecideStep = { step: "review"; notice: string | null } | { step: "blocked"; signals: PayeeSignal[]; notice: string | null };

/** The step a decision starts on, from the verdict the server holds: a Payee it blocks never starts on Approve. */
export function firstStep(signals: readonly PayeeSignal[] | null): DecideStep {
  const blocks = (signals ?? []).filter((s) => s.severity === "block");
  return blocks.length > 0 ? { step: "blocked", signals: blocks, notice: null } : { step: "review", notice: null };
}

const signalsIn = (details: unknown): PayeeSignal[] => {
  const list = details && typeof details === "object" && "signals" in details ? (details as { signals: unknown }).signals : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) => (s && typeof s === "object" && typeof (s as PayeeSignal).id === "string" && typeof (s as PayeeSignal).reason === "string" ? [{ id: (s as PayeeSignal).id, severity: "block" as const, reason: (s as PayeeSignal).reason }] : []));
};

/**
 * The step after the server refused a decision, or null when the refusal changes nothing about the step.
 * 409 PAYEE_BLOCKED: the look the server made just now blocks the Payee, so the owner sees what is blocked and may
 * approve anyway. 400 NOTHING_TO_OVERRIDE: nothing is blocked any more, so a plain approval is enough.
 */
export function stepAfterRefusal(e: unknown): DecideStep | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 409 && e.code === "PAYEE_BLOCKED") {
    return { step: "blocked", signals: signalsIn(e.details), notice: "The server looked at this Payee again just now, and the check blocks it. Nothing was approved." };
  }
  if (e.code === "NOTHING_TO_OVERRIDE") return { step: "review", notice: "The check no longer blocks this Payee, so there is nothing to override. Nothing was approved yet: approve it as usual." };
  return null;
}

export type DecisionAttempt = { ok: true; body: PayeeDecisionBody } | { ok: false; field: "note" | "typed"; message: string };

/**
 * What to send for the owner's choice, or why not. `overrideBlock` is sent only from the blocked step, and only when
 * the owner typed the Payee's account id exactly; a denial never carries it.
 */
export function decisionFor(step: DecideStep, action: "approve" | "deny", payee: AccountId, input: { note: string; typed: string }): DecisionAttempt {
  const note = input.note.trim();
  if (note.length > NOTE_MAX) return { ok: false, field: "note", message: `The note is ${note.length} characters. Keep it to ${NOTE_MAX}.` };
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(note)) return { ok: false, field: "note", message: "The note must be one line of plain text." };
  const base = { payee, ...(note ? { note } : {}) };
  if (action === "deny") return { ok: true, body: { ...base, decision: "deny" } };
  if (step.step === "review") return { ok: true, body: { ...base, decision: "approve" } };
  if (!typedIdMatches(payee, input.typed)) return { ok: false, field: "typed", message: "That does not match, so nothing was approved. Type the account id exactly, with every dot and hyphen." };
  return { ok: true, body: { ...base, decision: "approve", overrideBlock: true } };
}

/** One sentence for a decision, a withdrawal or a report the server refused. Never a raw error. */
export function payeeErrorText(e: unknown, doing: "decide" | "withdraw" | "report" | "read"): string {
  if (e instanceof ApiError) {
    if (e.code === "NODE_UNREACHABLE") return `${e.message} Nothing was changed.`;
    if (e.status === 403 || e.status === 401) return "Your role on this server cannot do this. Ask a platform owner or admin.";
    if (e.status === 404 && doing === "withdraw") return "This decision was already withdrawn. The list below is up to date.";
    if (e.status === 404) return "This server does not know this Budget, or it is an older server without Payee approvals.";
    if (e.code === "REPORTS_FULL") return "This account already holds the most reports a server keeps. Nothing more was recorded.";
    if (e.code === "PAYEE_CHECK_OFF") return "The Payee check is off on this server, so it holds no verdict to show.";
    if (e.code === "SHAPE_MISMATCH") return "The server answered in a shape this dashboard does not know. Nothing here was changed by it; reload and check the list.";
    if (e.message) return /[.!?]$/.test(e.message) ? e.message : `${e.message}.`;
  }
  return doing === "read" ? "The server could not be read. Try again." : "The server did not confirm this, so treat it as not done. Reload to see where it stands, then try again.";
}

/** What happened after a decision, and what it means for the agent, in plain words. */
export function decidedText(approval: Pick<PayeeApproval, "decision" | "overrideBlock">, wasWaiting: boolean): { title: string; body: string } {
  if (approval.decision === "deny") {
    return { title: "Payee denied", body: "The agent cannot pay this account under this Budget. Calls to it are refused with no money moved. You can withdraw the denial under Payee decisions." };
  }
  const next = wasWaiting ? "The agent's next attempt will go through. The Calls refused before are not retried by Payminto: the agent sends them again." : "The agent's next Call to it will go through.";
  return approval.overrideBlock
    ? { title: "Approved despite the block", body: `${next} The approval stands only against the blocks you saw, and it is written to the activity log.` }
    : { title: "Payee approved", body: `${next} If the check finds a new warning later, it asks again.` };
}

/** Who made a decision, in words. `me` is the signed-in person's id, and `names` the people this session can name. */
export function deciderText(by: { type: string; id: string | null }, me: string | null, names: ReadonlyMap<string, string> = new Map()): string {
  if (by.type === "user") {
    if (by.id && me && by.id === me) return "you";
    const name = by.id ? names.get(by.id) : undefined;
    return name ?? "a signed-in person";
  }
  if (by.type === "api_key") return "an API key";
  if (by.type === "recovery_key") return "the recovery key";
  return "Payminto";
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function isPlainHttpsUrl(v: string): boolean {
  if (/\s/.test(v) || UNSAFE_TEXT.test(v) || v.length > REPORT_URL_MAX) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export type ReportAttempt = { ok: true; body: PayeeReportBody } | { ok: false; problems: { reason?: string; evidence?: string } };

/**
 * The report to send, or what is wrong with it, by the rules the server holds a report to: a reason of one plain line
 * of at most 280 characters, and evidence that is a NEAR transaction hash or an https link. It never names a reporter.
 */
export function reportFor(account: AccountId, input: { reason: string; evidence: string }): ReportAttempt {
  const reason = input.reason.trim();
  const evidence = input.evidence.trim();
  const problems: { reason?: string; evidence?: string } = {};
  if (!reason) problems.reason = "Say in one line what happened.";
  else if (reason.length > REPORT_REASON_MAX) problems.reason = `The reason is ${reason.length} characters. Keep it to ${REPORT_REASON_MAX}.`;
  else if (UNSAFE_TEXT.test(reason)) problems.reason = "The reason must be one line of plain text.";
  if (!evidence) problems.evidence = "Add a NEAR transaction hash or an https link that backs the claim.";
  else if (!TX_HASH.test(evidence) && !isPlainHttpsUrl(evidence)) problems.evidence = "Evidence is a NEAR transaction hash, or a link that starts with https:// and is at most 300 characters.";
  if (problems.reason || problems.evidence) return { ok: false, problems };
  return { ok: true, body: { account, reason, evidence } };
}

/** Evidence as one line of text. It is never a link here: a report is a claim, and this dashboard does not open it. */
export function evidenceText(e: { type: "tx"; hash: string } | { type: "url"; url: string }): { label: string; text: string } {
  return e.type === "tx" ? { label: "Transaction", text: e.hash } : { label: "Link, as text", text: e.url };
}
