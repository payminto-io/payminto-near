/**
 * The node's payee check for mock mode: the verdict per Budget and Payee, the owner's decisions, the Calls that wait
 * for one, and reports. It follows the rules of apps/node/src/payees/service.ts, and its verdicts are real ones from
 * `@payminto/payee-check` over the demo accounts (lib/mock/payee-check.ts), so nothing here reads a network.
 */
import { StoreError, createPayeeCheck, type MemoryBlocklist, type PayeeCheck as RunCheck, type Verdict } from "@payminto/payee-check";
import type { AccountId, Id32 } from "@payminto/protocol";
import { ApiError } from "../http";
import type { EventType, PayeeApproval, PayeeApprovalRequest, PayeeApprovals, PayeeCheck, PayeeReport, PayeeReportFiled, PayeeReports, PayeeSignal } from "../schemas";
import { demoPayeeSources } from "./payee-check";

export type MockPayeeBudget = { id: Id32; owner: AccountId; payees: AccountId[] };
export type MockActor = { type: string; id: string | null };
export type DecisionInput = { payee: AccountId; decision: "approve" | "deny"; note?: string | null; overrideBlock?: boolean };

type Deps = {
  token: AccountId;
  /** The node's operator account: the reporter of every report filed through this node. */
  operator: AccountId;
  dashboardUrl: string;
  budgets: () => MockPayeeBudget[];
  /** What an owner's Budgets have paid a Payee before, from the mock's own Calls. */
  history: (payer: AccountId, payee: AccountId) => { count: number; total: bigint; lastAtMs: number | null };
  emit: (type: EventType, data: Record<string, unknown>) => void;
  /** True while the `payee-check-off` demo switch is set. */
  off: () => boolean;
  /** Each read of the demo accounts waits this long, so "checking" is visible. */
  latencyMs?: number;
};

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const INCOMPLETE = new Set(["check_failed", "check_incomplete"]);

/** The signals that carry a verdict: everything heavier than a note. */
export const heavySignals = (v: Verdict | null): PayeeSignal[] => (v?.signals ?? []).filter((s) => s.severity !== "info").map((s) => ({ id: s.id, severity: s.severity, reason: s.reason }));

export class MockPayees {
  readonly #deps: Deps;
  readonly #verdicts = new Map<string, Verdict>();
  readonly #approvals = new Map<string, PayeeApproval>();
  readonly #waiting = new Map<string, PayeeApprovalRequest>();
  readonly #filedBy = new Map<string, MockActor>();
  #check: RunCheck | null = null;
  #blocklist: MemoryBlocklist | null = null;
  #ready: Promise<void> | null = null;
  #requestSeq = 0;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Builds the check and judges every Payee on every Budget's list, as the node does at registration. Runs once. */
  ready(seed?: (payees: MockPayees) => void): Promise<void> {
    this.#ready ??= (async () => {
      const sources = await demoPayeeSources(this.#deps.token, { latencyMs: this.#deps.latencyMs ?? 0 });
      this.#blocklist = sources.blocklist as MemoryBlocklist;
      this.#check = createPayeeCheck({ ...sources, history: { paymentsBetween: async (payer, payee) => this.#deps.history(payer, payee) } });
      await Promise.all(this.#deps.budgets().map((b) => this.checkBudget(b)));
      seed?.(this);
    })();
    return this.#ready;
  }

  approveAt(budgetId: Id32): string {
    return `${this.#deps.dashboardUrl.replace(/\/+$/, "")}/budgets/${budgetId}`;
  }

  #requireOn(): RunCheck {
    if (this.#deps.off() || !this.#check) {
      throw new ApiError(409, "PAYEE_CHECK_OFF", "The payee check is off on this node (PAYEE_CHECK is off). Set PAYEE_CHECK=on with a reachable RPC_URL and restart the node, then ask again.");
    }
    return this.#check;
  }

  async #judge(budget: MockPayeeBudget, payee: string): Promise<Verdict> {
    const v = await this.#requireOn()({ payee, payer: budget.owner, budgetPayees: budget.payees.length > 0 ? budget.payees.filter((p) => p !== payee) : null });
    this.#verdicts.set(`${budget.id}:${payee}`, v);
    return v;
  }

  async checkBudget(budget: MockPayeeBudget): Promise<void> {
    if (!this.#check) return;
    await Promise.all(budget.payees.map((p) => this.#judge(budget, p).catch(() => undefined)));
  }

  /** The verdicts held for a Budget, for the Budget JSON. Null with the check off. */
  payeeChecks(budgetId: Id32): PayeeCheck[] | null {
    if (this.#deps.off() || !this.#check) return null;
    const prefix = `${budgetId}:`;
    return [...this.#verdicts.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, verdict]): PayeeCheck => {
        const payee = k.slice(prefix.length);
        return {
          payee,
          status: verdict.verdict,
          complete: !verdict.signals.some((s) => INCOMPLETE.has(s.id)),
          checkedAt: new Date(verdict.checkedAtMs).toISOString(),
          approval: this.#approvals.get(k)?.decision ?? null,
          verdict,
        };
      })
      .sort((a, b) => a.payee.localeCompare(b.payee));
  }

  /** `GET /v1/payees/check`: a look made now. With a Budget the verdict is kept. */
  async verdictFor(account: string, budget: MockPayeeBudget | null): Promise<Verdict> {
    const check = this.#requireOn();
    if (account.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "account is too long to be a NEAR account id (at most 64 characters)");
    return budget ? this.#judge(budget, account) : check({ payee: account, payer: null, budgetPayees: null });
  }

  approvals(budgetId: Id32): PayeeApprovals {
    const mine = <T extends { budgetId: string }>(all: Iterable<T>) => [...all].filter((x) => x.budgetId === budgetId);
    return {
      budgetId,
      approveAt: this.approveAt(budgetId),
      approvals: mine(this.#approvals.values()).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
      // With the check off the node refuses no voucher for its Payee, so nothing waits.
      waiting: this.#deps.off() ? [] : mine(this.#waiting.values()).sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    };
  }

  /** Records that a Call waits for the owner, and tells the dashboard the first time, as the node does. */
  wait(budget: MockPayeeBudget, payee: AccountId, amount: bigint, at = Date.now(), source: "voucher" | "wallet" = "voucher"): PayeeApprovalRequest {
    const key = `${budget.id}:${payee}`;
    const v = this.#verdicts.get(key) ?? null;
    const now = new Date(at).toISOString();
    const held = this.#waiting.get(key);
    const request: PayeeApprovalRequest = held
      ? { ...held, attempts: held.attempts + 1, lastAt: now, amount: amount.toString(), verdict: v?.verdict ?? null, signals: heavySignals(v) }
      : { id: `par_demo${++this.#requestSeq}`, budgetId: budget.id, payee, amount: amount.toString(), source, attempts: 1, firstAt: now, lastAt: now, verdict: v?.verdict ?? null, signals: heavySignals(v) };
    this.#waiting.set(key, request);
    if (!held) this.#deps.emit("payee.approval_requested", { request, approveAt: this.approveAt(budget.id) });
    return request;
  }

  /**
   * An owner's decision. An approval of a blocked Payee is refused unless `overrideBlock` is set, and the flag is
   * refused where nothing is blocked. The owner decides on a look made now.
   */
  async decide(budget: MockPayeeBudget, input: DecisionInput, actor: MockActor, at = Date.now()): Promise<PayeeApproval> {
    const { payee, decision } = input;
    const overrideBlock = input.overrideBlock === true;
    const note = input.note?.trim() ? input.note.trim() : null;
    const off = this.#deps.off() || !this.#check;
    const v = off ? null : await this.#judge(budget, payee);
    const heavy = heavySignals(v);
    const blocks = heavy.filter((s) => s.severity === "block");
    if (overrideBlock && decision !== "approve") throw new ApiError(400, "VALIDATION_ERROR", "overrideBlock goes with decision approve; send a deny without it");
    if (decision === "approve") {
      if (blocks.length > 0 && !overrideBlock) {
        throw new ApiError(409, "PAYEE_BLOCKED", `The payee check blocks ${payee} (${blocks.map((s) => s.id).join(", ")}), and an approval does not override a block. To pay it anyway send the same request with overrideBlock: true; that is written to the activity log.`, { payee, signals: blocks });
      }
      if (blocks.length === 0 && overrideBlock) {
        throw new ApiError(400, "NOTHING_TO_OVERRIDE", `The payee check does not block ${payee} now, so there is nothing to override. Send the approval without overrideBlock.`, { payee });
      }
    }
    const approval: PayeeApproval = {
      budgetId: budget.id,
      payee,
      decision,
      overrideBlock: decision === "approve" && overrideBlock,
      // Blocks first, then warnings: the ids the owner saw.
      signals: v ? [...blocks.map((s) => s.id), ...heavy.filter((s) => s.severity === "warn").map((s) => s.id)] : null,
      note,
      decidedBy: { type: actor.type, id: actor.id },
      decidedAt: new Date(at).toISOString(),
    };
    const key = `${budget.id}:${payee}`;
    this.#approvals.set(key, approval);
    this.#waiting.delete(key);
    this.#deps.emit("payee.approval_decided", { approval });
    return approval;
  }

  withdraw(budget: MockPayeeBudget, payee: AccountId): PayeeApproval {
    const key = `${budget.id}:${payee}`;
    const held = this.#approvals.get(key);
    if (!held) throw new ApiError(404, "NOT_FOUND", `No decision is recorded for ${payee} on this Budget. GET /v1/budgets/${budget.id}/payee-approvals lists the decisions that are.`);
    this.#approvals.delete(key);
    this.#deps.emit("payee.approval_decided", { approval: held, withdrawn: true });
    return held;
  }

  /**
   * Files a report in the name of the operator account. The body must not name a reporter. The real node looks at the
   * account again in the background; the mock finishes that look before it answers, so the next read already shows it.
   */
  async fileReport(body: Record<string, unknown>, actor: MockActor): Promise<PayeeReportFiled> {
    if ("reporter" in body) throw new ApiError(400, "VALIDATION_ERROR", "reporter is not accepted: a report is filed in the name of the account you are signed in to. Remove the field and send again.");
    const blocklist = this.#blocklist;
    if (!blocklist) throw new ApiError(503, "NOT_READY", "The demo node is still starting. Try again in a moment.");
    const e = body.evidence;
    const evidence = typeof e === "string" ? (TX_HASH.test(e) ? { type: "tx", hash: e } : { type: "url", url: e }) : e;
    let filed;
    try {
      filed = await blocklist.report({ account: body.account, reporter: this.#deps.operator, reason: body.reason, evidence } as Parameters<MemoryBlocklist["report"]>[0]);
    } catch (err) {
      if (err instanceof StoreError && err.code === "invalid_report") {
        throw new ApiError(400, "VALIDATION_ERROR", `${err.message}. The reason is one line of at most 280 characters, and the evidence a NEAR transaction hash or an https URL of at most 300.`);
      }
      if (err instanceof StoreError && err.code === "account_full") throw new ApiError(409, "REPORTS_FULL", `${err.message}. Nothing more is recorded for this account.`);
      throw err;
    }
    this.#filedBy.set(`${filed.account} ${filed.reporter}`, actor);
    if (!this.#deps.off()) {
      const known = this.#deps.budgets().filter((b) => this.#verdicts.has(`${b.id}:${filed.account}`));
      await Promise.all(known.map((b) => this.#judge(b, filed.account).catch(() => undefined)));
    }
    const all = await this.reports(filed.account);
    return { report: all.reports.find((r) => r.reporter === filed.reporter)!, reporters: all.reporters };
  }

  async reports(account: AccountId): Promise<PayeeReports> {
    const rows = this.#blocklist ? await this.#blocklist.reportsFor(account) : [];
    const reports = rows.map((r): PayeeReport => ({ account: r.account, reporter: r.reporter, reason: r.reason, evidence: r.evidence, at: new Date(r.atMs).toISOString(), filedBy: this.#filedBy.get(`${r.account} ${r.reporter}`) ?? null }));
    return { account, reporters: new Set(reports.map((r) => r.reporter)).size, reports };
  }

  /** For seeding: a decision as it was made in the past, on the verdict held now. No event is sent. */
  seedApproval(budget: MockPayeeBudget, payee: AccountId, a: { decision: "approve" | "deny"; note: string | null; decidedBy: MockActor; at: number; overrideBlock?: boolean }): void {
    const heavy = heavySignals(this.#verdicts.get(`${budget.id}:${payee}`) ?? null);
    this.#approvals.set(`${budget.id}:${payee}`, {
      budgetId: budget.id,
      payee,
      decision: a.decision,
      overrideBlock: a.overrideBlock === true,
      signals: [...heavy.filter((s) => s.severity === "block"), ...heavy.filter((s) => s.severity === "warn")].map((s) => s.id),
      note: a.note,
      decidedBy: a.decidedBy,
      decidedAt: new Date(a.at).toISOString(),
    });
  }

  /** The verdict held for one Budget and Payee, for the refusal rows the mock seeds. */
  held(budgetId: Id32, payee: AccountId): Verdict | null {
    return this.#verdicts.get(`${budgetId}:${payee}`) ?? null;
  }
}
