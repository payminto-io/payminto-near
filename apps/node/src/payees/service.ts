/**
 * The payee check on the node. It keeps the latest verdict per Budget and payee, the owners' approvals, the calls
 * that wait for one and the reports, and it decides for the voucher path whether a payee may be paid.
 *
 * The judgment itself is @payminto/payee-check. What this module adds is the node's rules around it:
 * - A voucher is refused with PAYEE_BLOCKED when the verdict is block or the Budget's owner denied the payee, and with
 *   PAYEE_NEEDS_APPROVAL when the verdict is warn and the owner has not approved the warnings it carries.
 * - An approval covers the warnings the owner saw. A warning that appears later asks again. It stands against a block
 *   only when the owner said so (`overrideBlock`), and then only against the blocks the owner saw.
 * - A payee the owner approved, or one the Budget has already paid `establishedAfterPayments` times, is decided on the
 *   verdict the node holds, with no network read on the call path. The node looks again in the background.
 * - When the check cannot run (the chain or the indexer does not answer), the node decides on the verdict it holds.
 *   Only a payee it has never seen is refused for that reason, with a hint to try again shortly.
 * - The call path waits a short time for a look (3 s by default). A person waits longer: registration, the check route,
 *   an approval and the wallet's question use a patient look (20 s). When the call path's look does not finish, a
 *   patient one runs in the background and its verdict is kept, so the next call decides on it.
 */
import { randomBytes } from "node:crypto";
import { payeeCheckForNode, resolvePolicy, type AgeSource, type NearReader, type NodePayeeCheck, type PolicyInput, type Report, type Verdict, type VerdictKind } from "@payminto/payee-check";
import { DENIAL_RULES, type AccountId, type Id32, type PayeeCheckRule, type RetryHint } from "@payminto/protocol";
import type { AuditActor, AuditLog } from "../auth/audit.ts";
import type { PayeeCheckConfig } from "../config.ts";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { EventBus } from "../events.ts";
import type { Logger } from "../logger.ts";
import { nowIso, type BudgetRow } from "../store.ts";
import { SqliteBlocklist, SqliteCodeStore, callHistory, type FiledBy } from "./stores.ts";

/** What the check reads. Tests pass the package's fakes; a running node reads RPC_URL (see `rpcSources`). */
export type PayeeCheckSources = {
  reader: NearReader;
  /** Where account ages come from. Without it the age is not checked, and every verdict says so. */
  ageSource?: AgeSource | null;
  policy?: PolicyInput;
  /** Unix milliseconds. */
  clock?: () => number;
  /** Passed to the package: how long a verdict is reused, and how long the call path waits for one (default 3000). */
  cacheMs?: number;
  timeLimitMs?: number;
  /** How long a look waits when a person asked or nobody waits at all. Default 20000. */
  patientLimitMs?: number;
  /** A held verdict older than this is looked at again in the background when a call uses it. Default 5 minutes. */
  refreshAfterMs?: number;
};

export type SignalJson = { id: string; severity: "info" | "warn" | "block"; reason: string };

/** The verdict the node holds for one Budget and payee. */
export type StoredVerdict = { status: VerdictKind; complete: boolean; checkedAtMs: number; verdict: Verdict };

export type ApprovalJson = {
  budgetId: Id32;
  payee: AccountId;
  decision: "approve" | "deny";
  overrideBlock: boolean;
  /** Ids of the warn and block signals the owner saw when deciding. Null: the check was off, so any warning is covered. */
  signals: string[] | null;
  note: string | null;
  decidedBy: { type: string; id: string | null };
  decidedAt: string;
};

export type ApprovalRequestJson = {
  id: string;
  budgetId: Id32;
  payee: AccountId;
  /** The price of the latest call that waited, atomic units. */
  amount: string;
  /** Who asked: the node, when it refused a voucher, or the agent's wallet before it signed. */
  source: "voucher" | "wallet";
  attempts: number;
  firstAt: string;
  lastAt: string;
  /** The node's verdict when the request was last made. Null with the check off. */
  verdict: VerdictKind | null;
  signals: SignalJson[];
};

export type PayeeCheckJson = {
  payee: AccountId;
  status: VerdictKind;
  /** False when a source did not answer, so the verdict is heavier than a full look might be. */
  complete: boolean;
  checkedAt: string;
  approval: "approve" | "deny" | null;
  /** The package's verdict, ready for `toView`. */
  verdict: Verdict;
};

export type ReportJson = { account: AccountId; reporter: AccountId; reason: string; evidence: Report["evidence"]; at: string; filedBy: FiledBy | null };

/** What the voucher path does with a payee: null to go on to the Budget's rules, or the refusal to record. */
export type PayeeRefusal = {
  rule: PayeeCheckRule;
  message: string;
  retry: RetryHint;
  details: Record<string, unknown>;
};

export type PayeeDecision =
  | { outcome: "allow" }
  /** `verdict`: a blocking signal. `owner_denied`: the owner said no. `check_unavailable`: nothing is known and nothing could be read. */
  | { outcome: "blocked"; why: "verdict" | "owner_denied" | "check_unavailable" }
  /** The warn signals no approval covers. */
  | { outcome: "needs_approval"; newSignals: string[] };

type ApprovalRow = { budget_id: Id32; payee: AccountId; decision: "approve" | "deny"; override_block: number; signals: string | null; note: string | null; decided_by_type: string; decided_by_id: string | null; decided_at: string };
type RequestRow = { id: string; budget_id: Id32; payee: AccountId; amount: string; source: "voucher" | "wallet"; status: VerdictKind | null; signals: string; attempts: number; first_at: string; last_at: string };
type VerdictRow = { budget_id: Id32; payee: AccountId; status: VerdictKind; verdict: string; complete: number; checked_at_ms: number };

/** Seconds an agent is told to wait when a payee could not be checked: long enough for a public endpoint to recover. */
export const CHECK_RETRY_SEC = 30;
/** Calls that may wait for a decision per Budget. Past it no further request is recorded; the calls are still refused. */
export const MAX_WAITING_PER_BUDGET = 50;
const MAX_MESSAGE = 480;

const INCOMPLETE = new Set(["check_failed", "check_incomplete"]);
const isComplete = (v: Verdict): boolean => !v.signals.some((s) => INCOMPLETE.has(s.id));
const weight = { allow: 0, warn: 1, block: 2 } as const;
const idsAt = (v: Verdict, severity: "warn" | "block"): string[] => v.signals.filter((s) => s.severity === severity).map((s) => s.id);
/** The signals that carry a verdict: everything heavier than a note. */
export const heavySignals = (v: Verdict | null): SignalJson[] => (v?.signals ?? []).filter((s) => s.severity !== "info").map((s) => ({ id: s.id, severity: s.severity, reason: s.reason }));

/**
 * Decides one payee from the verdict the node holds and the owner's decision. Pure: the same inputs always give the
 * same answer, and it is the only place that turns a verdict into allow, blocked or needs approval.
 */
export function decidePayee(i: { verdict: StoredVerdict | null; approval: { decision: "approve" | "deny"; signals: string[] | null; overrideBlock: boolean } | null }): PayeeDecision {
  const { approval } = i;
  if (approval?.decision === "deny") return { outcome: "blocked", why: "owner_denied" };
  if (!i.verdict) return { outcome: "allow" };
  const v = i.verdict.verdict;
  const approved = approval?.decision === "approve";
  const seen = approval?.signals ?? null;
  const blocks = idsAt(v, "block");
  if (blocks.length > 0) {
    const overridden = approved && approval.overrideBlock && seen !== null && blocks.every((id) => seen.includes(id));
    if (!overridden) return { outcome: "blocked", why: blocks.every((id) => id === "check_failed") ? "check_unavailable" : "verdict" };
  }
  const warns = idsAt(v, "warn");
  if (warns.length === 0) return { outcome: "allow" };
  if (!approved) return { outcome: "needs_approval", newSignals: warns };
  const fresh = seen === null ? [] : warns.filter((id) => !seen.includes(id));
  return fresh.length === 0 ? { outcome: "allow" } : { outcome: "needs_approval", newSignals: fresh };
}

/**
 * The verdict to decide on when a look came back incomplete and the node holds an earlier one: the held verdict
 * stands in for what could not be read, and whatever the partial look did find still counts.
 */
function heldWith(held: StoredVerdict, partial: Verdict): StoredVerdict {
  const have = new Set(held.verdict.signals.map((s) => s.id));
  const extra = partial.signals.filter((s) => !INCOMPLETE.has(s.id) && !have.has(s.id) && s.severity !== "info");
  if (extra.length === 0) return held;
  const signals = [...held.verdict.signals, ...extra].sort((a, b) => weight[b.severity === "info" ? "allow" : b.severity] - weight[a.severity === "info" ? "allow" : a.severity]);
  const top = signals[0]!.severity;
  const status: VerdictKind = top === "block" ? "block" : top === "warn" ? "warn" : "allow";
  return { ...held, status, verdict: { ...held.verdict, verdict: status, signals } };
}

const cap = (text: string): string => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text);

export class PayeeService {
  readonly blocklist: SqliteBlocklist;
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #audit: AuditLog;
  readonly #log: Logger;
  readonly #operator: AccountId;
  readonly #dashboardUrl: string;
  /**
   * The check. Called directly it is the call path's look, which answers within the short time limit or says the check
   * failed; `.patient` is the same look with the long limit, for a person who asked and for looks nobody waits for.
   * Both share one cache and one set of running looks.
   */
  readonly #check: NodePayeeCheck | null;
  readonly #clock: () => number;
  readonly #established: number;
  readonly #refreshAfterMs: number;
  /** Looks running in the background, by Budget and payee. */
  readonly #running = new Map<string, Promise<void>>();
  #closed = false;
  /** Why the check is off, for the route that says how to turn it on. Null while it is on. */
  readonly offBecause: string | null;

  constructor(deps: {
    db: Database;
    events: EventBus;
    audit: AuditLog;
    log: Logger;
    /** The node's operator account: the reporter of every report filed through this node. */
    operator: AccountId;
    /** The settlement token, for the registration signal. */
    token: AccountId;
    /** The node's own dashboard origin. `approveAt` is built from it and from nothing else. */
    dashboardUrl: string;
    config: PayeeCheckConfig;
    /** Null when there is nothing to read with (an injected chain and no injected sources). */
    sources: PayeeCheckSources | null;
  }) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#audit = deps.audit;
    this.#log = deps.log;
    this.#operator = deps.operator;
    this.#dashboardUrl = deps.dashboardUrl.replace(/\/+$/, "");
    const s = deps.sources;
    this.#clock = s?.clock ?? Date.now;
    this.blocklist = new SqliteBlocklist(deps.db, this.#clock);
    this.#refreshAfterMs = s?.refreshAfterMs ?? 300_000;
    this.#established = resolvePolicy(s?.policy).establishedAfterPayments;
    this.offBecause = !deps.config.enabled ? "PAYEE_CHECK is off" : !s ? "this node was started without a chain reader for the check" : null;
    this.#check =
      deps.config.enabled && s
        ? payeeCheckForNode({
            reader: s.reader,
            token: deps.token,
            ...(s.ageSource ? { ageSource: s.ageSource } : {}),
            history: callHistory(deps.db),
            blocklist: this.blocklist,
            codeStore: new SqliteCodeStore(deps.db),
            ...(s.policy ? { policy: s.policy } : {}),
            ...(s.clock ? { clock: s.clock } : {}),
            ...(s.cacheMs !== undefined ? { cacheMs: s.cacheMs } : {}),
            ...(s.timeLimitMs !== undefined ? { timeLimitMs: s.timeLimitMs } : {}),
            patientLimitMs: Math.max(s.patientLimitMs ?? 20_000, s.timeLimitMs ?? 3_000),
          })
        : null;
  }

  get enabled(): boolean {
    return this.#check !== null;
  }

  /** Where the owner of a Budget decides about its payees: a page of this node's own dashboard. */
  approveAt(budgetId: Id32): string {
    return `${this.#dashboardUrl}/budgets/${budgetId}`;
  }

  /** The look, or the error that says how to turn it on. `patient` picks the long time limit. */
  #requireOn(patient: boolean): NodePayeeCheck["patient"] {
    const check = this.#check;
    if (!check) {
      throw new ApiError(409, "PAYEE_CHECK_OFF", `The payee check is off on this node (${this.offBecause}). Set PAYEE_CHECK=on with a reachable RPC_URL and restart the node, then ask again.`);
    }
    return patient ? check.patient : check;
  }

  // ------------------------------------------------------------------ verdicts

  #stored(budgetId: Id32, payee: string): StoredVerdict | null {
    const r = this.#db.get<VerdictRow>("SELECT * FROM payee_verdicts WHERE budget_id = ? AND payee = ?", budgetId, payee);
    return r ? { status: r.status, complete: r.complete === 1, checkedAtMs: r.checked_at_ms, verdict: JSON.parse(r.verdict) as Verdict } : null;
  }

  /** Keeps a verdict. A complete verdict replaces what is held; an incomplete one is kept only while nothing is held. */
  #keep(budgetId: Id32, payee: string, v: Verdict): StoredVerdict {
    const complete = isComplete(v);
    const fresh: StoredVerdict = { status: v.verdict, complete, checkedAtMs: v.checkedAtMs, verdict: v };
    // A complete verdict the node holds is not thrown away for a look that could not finish.
    const held = complete ? null : this.#stored(budgetId, payee);
    if (held?.complete) return heldWith(held, v);
    this.#db.run(
      `INSERT INTO payee_verdicts (budget_id, payee, status, verdict, complete, checked_at_ms) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (budget_id, payee) DO UPDATE SET status = excluded.status, verdict = excluded.verdict, complete = excluded.complete, checked_at_ms = excluded.checked_at_ms`,
      budgetId,
      payee,
      v.verdict,
      JSON.stringify(v),
      complete ? 1 : 0,
      v.checkedAtMs,
    );
    return fresh;
  }

  /**
   * Looks at one payee of a Budget now and returns the verdict to decide on: the fresh one when it is complete, else
   * the held one with whatever the partial look found. `basis` says which.
   */
  async #judge(budget: BudgetRow, payee: string, amount: bigint, o: { patient: boolean }): Promise<{ v: StoredVerdict; basis: "fresh" | "held"; unavailable: boolean; complete: boolean }> {
    const check = this.#requireOn(o.patient);
    const payees = JSON.parse(budget.payees) as AccountId[];
    const held = this.#stored(budget.id, payee);
    const fresh = await check(budget.owner, payee, amount, payees.length > 0 ? payees : null);
    const v = this.#keep(budget.id, payee, fresh);
    const complete = isComplete(fresh);
    const usedHeld = !complete && held?.complete === true;
    return { v, basis: usedHeld ? "held" : "fresh", unavailable: !complete && !usedHeld && fresh.signals.some((s) => s.id === "check_failed"), complete };
  }

  /** The verdict for an account, as the package returns it. With a Budget it knows the payer and the allowed list, and it is kept. */
  async verdictFor(account: string, budget: BudgetRow | null): Promise<Verdict> {
    const check = this.#requireOn(true);
    // A person asked: answer from a look made now, not from the short cache the call path uses.
    this.forget(account);
    if (!budget) return check(null, account, 0n, null);
    const payees = JSON.parse(budget.payees) as AccountId[];
    const v = await check(budget.owner, account, 0n, payees.length > 0 ? payees : null);
    this.#keep(budget.id, account, v);
    return v;
  }

  /** Checks every payee on a Budget's list and keeps the verdicts. Never throws: registration does not depend on it. */
  async checkBudget(budget: BudgetRow): Promise<void> {
    if (!this.#check) return;
    const payees = JSON.parse(budget.payees) as AccountId[];
    await Promise.all(
      payees.map((p) =>
        this.#judge(budget, p, 0n, { patient: true }).catch((err: unknown) => {
          this.#log.warn("payee check failed at registration", { budgetId: budget.id, payee: p, err });
        }),
      ),
    );
  }

  /** The verdicts the node holds for a Budget, for the Budget JSON. Null with the check off. */
  payeeChecks(budget: BudgetRow): PayeeCheckJson[] | null {
    if (!this.#check) return null;
    const decisions = new Map(this.#db.all<ApprovalRow>("SELECT * FROM payee_approvals WHERE budget_id = ?", budget.id).map((a) => [a.payee, a.decision]));
    return this.#db.all<VerdictRow>("SELECT * FROM payee_verdicts WHERE budget_id = ? ORDER BY payee", budget.id).map((r) => ({
      payee: r.payee,
      status: r.status,
      complete: r.complete === 1,
      checkedAt: new Date(r.checked_at_ms).toISOString(),
      approval: decisions.get(r.payee) ?? null,
      verdict: JSON.parse(r.verdict) as Verdict,
    }));
  }

  // ------------------------------------------------------------------ the voucher path

  /**
   * Decides a payee for a voucher the Budget's agent signed, before the Budget's own rules run. Returns null to go on,
   * or the refusal. It leaves a Budget that is not open, and a payee that is not on a non-empty list, to the rules that
   * already answer for them, except that a blocking verdict about such a payee (a lookalike of an allowed one) is said.
   */
  async guard(budget: BudgetRow, payee: AccountId, amount: bigint): Promise<PayeeRefusal | null> {
    if (budget.status !== "open" || this.#clock() > budget.valid_until_ms) return null;
    const approval = this.#approval(budget.id, payee);
    let v: StoredVerdict | null = null;
    let basis: "fresh" | "held" | "approved" | "established" | "none" = "none";
    let unavailable = false;
    if (this.#check && approval?.decision !== "deny") {
      const paid = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ? AND payee = ?", budget.id, payee)!.n;
      const approved = approval?.decision === "approve";
      if (approved || (this.#established > 0 && paid >= this.#established)) {
        // No network read on the call path: decide on what is held, and look again in the background when it is old.
        v = this.#stored(budget.id, payee);
        basis = approved ? "approved" : "established";
        if (!v || this.#clock() - v.checkedAtMs > this.#refreshAfterMs) this.#refresh(budget, payee);
      } else {
        const looked = await this.#judge(budget, payee, amount, { patient: false });
        ({ v, basis, unavailable } = looked);
        // The look did not finish in the time a call may wait. A patient one runs behind it, so the next call has a verdict.
        if (!looked.complete) this.#refresh(budget, payee);
      }
    }
    const d = decidePayee({ verdict: v, approval: approval ? { decision: approval.decision, signals: approval.signals, overrideBlock: approval.overrideBlock } : null });
    const payees = JSON.parse(budget.payees) as AccountId[];
    const onList = payees.length === 0 || payees.includes(payee);
    // An approval could not help a payee the list refuses, and "could not be checked" would only hide that.
    if (d.outcome === "allow" || (!onList && !(d.outcome === "blocked" && d.why !== "check_unavailable"))) return null;
    const signals = heavySignals(v?.verdict ?? null);
    const payeeCheck = v ? { verdict: v.status, basis, checkedAtMs: v.checkedAtMs, complete: v.complete, signals, ...(unavailable ? { unavailable: true } : {}) } : null;
    if (d.outcome === "blocked") {
      if (d.why === "owner_denied") {
        return { rule: "PAYEE_BLOCKED", message: "The Budget's owner denied this payee, so nothing is paid to it", retry: { kind: "never" }, details: { payee, payeeCheck, approval: { status: "denied", approveAt: this.approveAt(budget.id) } } };
      }
      if (d.why === "check_unavailable") {
        return {
          rule: "PAYEE_BLOCKED",
          message: "The payee could not be checked and this node has never seen it, so nothing is paid to it yet; retry shortly",
          retry: { kind: "after", seconds: CHECK_RETRY_SEC },
          details: { payee, payeeCheck },
        };
      }
      const top = signals.find((s) => s.severity === "block");
      return { rule: "PAYEE_BLOCKED", message: cap(`${DENIAL_RULES.PAYEE_BLOCKED}: ${top ? `${top.id} (${top.reason})` : "blocked"}`), retry: { kind: "never" }, details: { payee, payeeCheck } };
    }
    const request = this.#wait(budget.id, payee, amount, "voucher", v);
    const approveAt = this.approveAt(budget.id);
    return {
      rule: "PAYEE_NEEDS_APPROVAL",
      message: cap(`${DENIAL_RULES.PAYEE_NEEDS_APPROVAL}: ${d.newSignals.join(", ")}`),
      retry: { kind: "approval", payee, approveAt },
      details: { payee, payeeCheck, approval: { status: "waiting", approveAt, requestId: request?.id ?? null, newSignals: d.newSignals } },
    };
  }

  /** Looks at a payee again without making anyone wait, and keeps the verdict when it is complete. */
  #refresh(budget: BudgetRow, payee: AccountId): void {
    const key = `${budget.id}:${payee}`;
    if (this.#closed || !this.#check || this.#running.has(key)) return;
    const run = this.#judge(budget, payee, 0n, { patient: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        if (!this.#closed) this.#log.warn("background payee check failed", { budgetId: budget.id, payee, err });
      })
      .finally(() => this.#running.delete(key));
    this.#running.set(key, run);
  }

  /** Drops the short cache for a payee (or all of it), so the next look reads the sources again. */
  forget(payee?: string): void {
    this.#check?.forget(payee);
  }

  /** Something changed about a payee (a report was filed): look again, in the background, for every Budget that knows it. */
  recheck(payee: AccountId): void {
    if (!this.#check) return;
    this.forget(payee);
    const budgets = this.#db.all<BudgetRow>("SELECT b.* FROM budgets b JOIN payee_verdicts v ON v.budget_id = b.id WHERE v.payee = ?", payee);
    for (const b of budgets) this.#refresh(b, payee);
  }

  /** Resolves once no background look is running. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running.values()]);
  }

  /** Stops background looks from writing to a database that is about to close. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 5_000).unref())]);
  }

  // ------------------------------------------------------------------ approvals

  #approval(budgetId: Id32, payee: string): ApprovalJson | null {
    const r = this.#db.get<ApprovalRow>("SELECT * FROM payee_approvals WHERE budget_id = ? AND payee = ?", budgetId, payee);
    return r ? approvalJson(r) : null;
  }

  approvals(budgetId: Id32): ApprovalJson[] {
    return this.#db.all<ApprovalRow>("SELECT * FROM payee_approvals WHERE budget_id = ? ORDER BY decided_at DESC, payee", budgetId).map(approvalJson);
  }

  waiting(budgetId: Id32): ApprovalRequestJson[] {
    return this.#db.all<RequestRow>("SELECT * FROM payee_approval_requests WHERE budget_id = ? ORDER BY last_at DESC, payee", budgetId).map(requestJson);
  }

  /** Records that a call waits for the owner, and tells the dashboard the first time. Null when too many already wait. */
  #wait(budgetId: Id32, payee: AccountId, amount: bigint, source: "voucher" | "wallet", v: StoredVerdict | null): ApprovalRequestJson | null {
    const now = nowIso();
    const signals = JSON.stringify(heavySignals(v?.verdict ?? null));
    return this.#db.tx(() => {
      const held = this.#db.get<RequestRow>("SELECT * FROM payee_approval_requests WHERE budget_id = ? AND payee = ?", budgetId, payee);
      if (held) {
        this.#db.run("UPDATE payee_approval_requests SET attempts = attempts + 1, last_at = ?, amount = ?, status = ?, signals = ? WHERE id = ?", now, amount.toString(), v?.status ?? null, signals, held.id);
        return requestJson({ ...held, attempts: held.attempts + 1, last_at: now, amount: amount.toString(), status: v?.status ?? null, signals });
      }
      if (this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payee_approval_requests WHERE budget_id = ?", budgetId)!.n >= MAX_WAITING_PER_BUDGET) return null;
      const row: RequestRow = { id: `par_${randomBytes(8).toString("hex")}`, budget_id: budgetId, payee, amount: amount.toString(), source, status: v?.status ?? null, signals, attempts: 1, first_at: now, last_at: now };
      this.#db.run(
        "INSERT INTO payee_approval_requests (id, budget_id, payee, amount, source, status, signals, attempts, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        row.id,
        row.budget_id,
        row.payee,
        row.amount,
        row.source,
        row.status,
        row.signals,
        row.first_at,
        row.last_at,
      );
      const request = requestJson(row);
      this.#events.emit("payee.approval_requested", { request, approveAt: this.approveAt(budgetId) });
      return request;
    });
  }

  /**
   * An owner's decision about a payee. An approval of a blocked payee is refused unless `overrideBlock` is set, and
   * the flag is refused where nothing is blocked, so it cannot be set in advance. Every decision is written to the
   * activity log with who made it, and an override gets its own entry.
   */
  async decide(budget: BudgetRow, input: { payee: AccountId; decision: "approve" | "deny"; note: string | null; overrideBlock: boolean }, actor: AuditActor): Promise<ApprovalJson> {
    const { payee, decision, note } = input;
    // The owner decides on what a look made now shows. With the check off there is nothing to show.
    let v: StoredVerdict | null = null;
    if (this.#check) {
      this.forget(payee);
      v = (await this.#judge(budget, payee, 0n, { patient: true })).v;
    }
    const blocks = v ? heavySignals(v.verdict).filter((s) => s.severity === "block") : [];
    if (input.overrideBlock && decision !== "approve") throw new ApiError(400, "VALIDATION_ERROR", "overrideBlock goes with decision approve; send a deny without it");
    if (decision === "approve") {
      if (blocks.length > 0 && !input.overrideBlock) {
        throw new ApiError(409, "PAYEE_BLOCKED", `The payee check blocks ${payee} (${blocks.map((s) => s.id).join(", ")}), and an approval does not override a block. To pay it anyway send the same request with overrideBlock: true; that is written to the activity log.`, { payee, signals: blocks });
      }
      if (blocks.length === 0 && input.overrideBlock) {
        throw new ApiError(400, "NOTHING_TO_OVERRIDE", `The payee check does not block ${payee} now, so there is nothing to override. Send the approval without overrideBlock.`, { payee });
      }
    }
    const seen = v ? [...idsAt(v.verdict, "block"), ...idsAt(v.verdict, "warn")] : null;
    const row: ApprovalRow = {
      budget_id: budget.id,
      payee,
      decision,
      override_block: decision === "approve" && input.overrideBlock ? 1 : 0,
      signals: seen === null ? null : JSON.stringify(seen),
      note,
      decided_by_type: actor.type,
      decided_by_id: actor.id,
      decided_at: nowIso(),
    };
    return this.#db.tx(() => {
      this.#db.run(
        `INSERT INTO payee_approvals (budget_id, payee, decision, override_block, signals, note, decided_by_type, decided_by_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (budget_id, payee) DO UPDATE SET decision = excluded.decision, override_block = excluded.override_block, signals = excluded.signals,
           note = excluded.note, decided_by_type = excluded.decided_by_type, decided_by_id = excluded.decided_by_id, decided_at = excluded.decided_at`,
        row.budget_id,
        row.payee,
        row.decision,
        row.override_block,
        row.signals,
        row.note,
        row.decided_by_type,
        row.decided_by_id,
        row.decided_at,
      );
      this.#db.run("DELETE FROM payee_approval_requests WHERE budget_id = ? AND payee = ?", budget.id, payee);
      const target = `${budget.id}:${payee}`;
      const meta = { budget_id: budget.id, payee, signals: seen, ...(note ? { note } : {}) };
      this.#audit.write(actor, decision === "approve" ? "payee.approved" : "payee.denied", { target, meta });
      if (row.override_block) this.#audit.write(actor, "payee.block_overridden", { target, meta: { budget_id: budget.id, payee, signals: blocks.map((s) => s.id) } });
      const approval = approvalJson(row);
      this.#events.emit("payee.approval_decided", { approval });
      return approval;
    });
  }

  /** Withdraws a decision: the payee is judged by the check alone again. */
  withdraw(budget: BudgetRow, payee: AccountId, actor: AuditActor): ApprovalJson {
    return this.#db.tx(() => {
      const held = this.#approval(budget.id, payee);
      if (!held) throw new ApiError(404, "NOT_FOUND", `No decision is recorded for ${payee} on this Budget. GET /v1/budgets/${budget.id}/payee-approvals lists the decisions that are.`);
      this.#db.run("DELETE FROM payee_approvals WHERE budget_id = ? AND payee = ?", budget.id, payee);
      this.#audit.write(actor, "payee.approval_withdrawn", { target: `${budget.id}:${payee}`, meta: { budget_id: budget.id, payee, decision: held.decision } });
      this.#events.emit("payee.approval_decided", { approval: held, withdrawn: true });
      return held;
    });
  }

  /**
   * What the agent's wallet asks before it signs, when its own check says warn: has the owner approved this payee?
   * The caller has verified the agent's signature. Nothing here approves anything.
   */
  async ask(budget: BudgetRow, payee: AccountId, amount: bigint) {
    const approval = this.#approval(budget.id, payee);
    const approveAt = this.approveAt(budget.id);
    let v: StoredVerdict | null = null;
    if (this.#check && approval?.decision !== "deny") v = (await this.#judge(budget, payee, amount, { patient: true })).v;
    const payeeCheck = { enabled: this.enabled, verdict: v?.status ?? null, signals: heavySignals(v?.verdict ?? null) };
    const base = { budgetId: budget.id, payee, approveAt, approval, payeeCheck };
    const d = decidePayee({ verdict: v, approval });
    if (d.outcome === "blocked") return { ...base, status: d.why === "owner_denied" ? ("denied" as const) : ("blocked" as const), request: null };
    if (approval?.decision === "approve" && d.outcome === "allow") return { ...base, status: "approved" as const, request: null };
    const request = this.#wait(budget.id, payee, amount, "wallet", v);
    if (!request) throw new ApiError(429, "TOO_MANY_WAITING", `${MAX_WAITING_PER_BUDGET} payees of this Budget already wait for the owner's decision. The owner decides them at ${approveAt}; ask again after that.`);
    return { ...base, status: "waiting" as const, request };
  }

  // ------------------------------------------------------------------ reports

  /** Files a report in the name of this node's operator account. The text is a claim, kept as data and never acted on. */
  fileReport(input: { account: string; reason: string; evidence: unknown }, actor: AuditActor): { report: ReportJson; reporters: number } {
    const filedBy: FiledBy = { type: actor.type, id: actor.id };
    const report = this.blocklist.file({ account: input.account, reporter: this.#operator, reason: input.reason, evidence: input.evidence as Report["evidence"] }, filedBy);
    this.#audit.write(actor, "payee.reported", { target: report.account, meta: { account: report.account } });
    this.recheck(report.account);
    return { report: reportJson(report, filedBy), reporters: this.reporters(report.account) };
  }

  reports(account: AccountId | null, limit: number): ReportJson[] {
    return (account ? this.blocklist.rows(account, limit) : this.blocklist.latest(limit)).map((r) => reportJson(r.report, r.filedBy));
  }

  reporters(account: AccountId): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(DISTINCT reporter) AS n FROM payee_reports WHERE account = ?", account)!.n;
  }
}

function approvalJson(r: ApprovalRow): ApprovalJson {
  return {
    budgetId: r.budget_id,
    payee: r.payee,
    decision: r.decision,
    overrideBlock: r.override_block === 1,
    signals: r.signals === null ? null : (JSON.parse(r.signals) as string[]),
    note: r.note,
    decidedBy: { type: r.decided_by_type, id: r.decided_by_id },
    decidedAt: r.decided_at,
  };
}

function requestJson(r: RequestRow): ApprovalRequestJson {
  return { id: r.id, budgetId: r.budget_id, payee: r.payee, amount: r.amount, source: r.source, attempts: r.attempts, firstAt: r.first_at, lastAt: r.last_at, verdict: r.status, signals: JSON.parse(r.signals) as SignalJson[] };
}

function reportJson(r: Report, filedBy: FiledBy | null): ReportJson {
  return { account: r.account, reporter: r.reporter, reason: r.reason, evidence: r.evidence, at: new Date(r.atMs).toISOString(), filedBy };
}
