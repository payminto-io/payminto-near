import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { approvalHref, payeeRefusalReason, retryText } from "@/lib/denials";
import { MockClearingApi } from "@/lib/mock/server";
import { decidedText, deciderText, decisionFor, evidenceText, firstStep, payeeErrorText, payeeOutcome, reportFor, standingOf, stepAfterRefusal } from "@/lib/payee-approvals";
import { budgetSchema, denialSchema, payeeApprovalSchema, payeeApprovalsSchema, payeeReportsSchema, payeeVerdictSchema, type PayeeApproval, type PayeeCheck, type PayeeSignal } from "@/lib/schemas";

const BUDGET = "ab".repeat(32);
const warn = (id: string): PayeeSignal => ({ id, severity: "warn", reason: `${id} reason.` });
const block = (id: string): PayeeSignal => ({ id, severity: "block", reason: `${id} reason.` });
const approval = (over: Partial<PayeeApproval> = {}): PayeeApproval => ({ budgetId: BUDGET, payee: "vendor.testnet", decision: "approve", overrideBlock: false, signals: [], note: null, decidedBy: { type: "user", id: "usr_1" }, decidedAt: "2026-11-10T10:00:00.000Z", ...over });
const check = (signals: PayeeSignal[]): Pick<PayeeCheck, "verdict"> => ({ verdict: payeeVerdictSchema.parse({ verdict: signals.some((s) => s.severity === "block") ? "block" : signals.length ? "warn" : "allow", payee: "vendor.testnet", signals, checkedAtMs: 1 }) });

describe("what the node will do with the agent's next Call (as apps/node/src/payees/service.ts decides)", () => {
  it("lets a clear Payee through, asks on a warning, and refuses a block", () => {
    expect(payeeOutcome([], null)).toEqual({ outcome: "allow" });
    expect(payeeOutcome(null, null)).toEqual({ outcome: "allow" });
    expect(payeeOutcome([warn("new_account")], null)).toEqual({ outcome: "needs_approval", newSignals: ["new_account"] });
    expect(payeeOutcome([block("reported_by_several")], null)).toEqual({ outcome: "blocked", why: "verdict" });
    expect(payeeOutcome([block("check_failed")], null)).toEqual({ outcome: "blocked", why: "check_unavailable" });
  });

  it("covers only the warnings the owner saw, and asks again for a new one", () => {
    expect(payeeOutcome([warn("new_account")], approval({ signals: ["new_account"] }))).toEqual({ outcome: "allow" });
    expect(payeeOutcome([warn("new_account"), warn("reported")], approval({ signals: ["new_account"] }))).toEqual({ outcome: "needs_approval", newSignals: ["reported"] });
    // An approval made with the check off saw nothing in particular, so it covers any warning.
    expect(payeeOutcome([warn("reported")], approval({ signals: null }))).toEqual({ outcome: "allow" });
  });

  it("lets an approval stand against a block only with overrideBlock, and only against the blocks seen", () => {
    expect(payeeOutcome([block("reported_by_several")], approval({ signals: ["reported_by_several"] }))).toMatchObject({ outcome: "blocked" });
    expect(payeeOutcome([block("reported_by_several")], approval({ signals: ["reported_by_several"], overrideBlock: true }))).toEqual({ outcome: "allow" });
    expect(payeeOutcome([block("reported_by_several"), block("lookalike_payee")], approval({ signals: ["reported_by_several"], overrideBlock: true }))).toMatchObject({ outcome: "blocked" });
  });

  it("refuses everything an owner denied", () => {
    expect(payeeOutcome([], approval({ decision: "deny" }))).toEqual({ outcome: "blocked", why: "owner_denied" });
  });

  it("names where each Payee stands", () => {
    const w = [warn("token_unregistered")];
    const request = { id: "par_1", budgetId: BUDGET, payee: "vendor.testnet", amount: "40000", source: "voucher" as const, attempts: 2, firstAt: "", lastAt: "", verdict: "warn" as const, signals: w };
    expect(standingOf(check([]), null, null)).toBe("clear");
    expect(standingOf(check(w), null, null)).toBe("needs_approval");
    expect(standingOf(check(w), null, request)).toBe("waiting");
    expect(standingOf(check(w), approval({ signals: ["token_unregistered"] }), null)).toBe("approved");
    expect(standingOf(check([warn("reported")]), approval({ signals: ["token_unregistered"] }), null)).toBe("new_warning");
    expect(standingOf(check([block("reported_by_several")]), null, null)).toBe("blocked");
    expect(standingOf(check([block("reported_by_several")]), approval({ signals: ["reported_by_several"], overrideBlock: true }), null)).toBe("approved_override");
    expect(standingOf(check([block("check_failed")]), null, null)).toBe("unreadable");
    expect(standingOf(check([]), approval({ decision: "deny" }), null)).toBe("denied");
    expect(standingOf(null, null, null)).toBe("unchecked");
  });
});

describe("deciding", () => {
  const input = { note: "", typed: "" };
  it("never starts a blocked Payee on Approve", () => {
    expect(firstStep([warn("new_account")])).toEqual({ step: "review", notice: null });
    expect(firstStep(null)).toEqual({ step: "review", notice: null });
    expect(firstStep([warn("new_account"), block("reported_by_several")])).toMatchObject({ step: "blocked", signals: [block("reported_by_several")] });
  });

  it("sends a plain approval or a denial from review, with the note only when there is one", () => {
    const review = firstStep([]);
    expect(decisionFor(review, "approve", "vendor.testnet", input)).toEqual({ ok: true, body: { payee: "vendor.testnet", decision: "approve" } });
    expect(decisionFor(review, "deny", "vendor.testnet", { note: "  not ours ", typed: "" })).toEqual({ ok: true, body: { payee: "vendor.testnet", decision: "deny", note: "not ours" } });
  });

  it("sends overrideBlock only from the blocked step and only for the exact account id", () => {
    const blocked = firstStep([block("reported_by_several")]);
    expect(decisionFor(blocked, "approve", "fast-refunds.testnet", input)).toMatchObject({ ok: false, field: "typed" });
    expect(decisionFor(blocked, "approve", "fast-refunds.testnet", { note: "", typed: "fast-refund.testnet" })).toMatchObject({ ok: false, field: "typed" });
    expect(decisionFor(blocked, "approve", "fast-refunds.testnet", { note: "", typed: "FAST-REFUNDS.TESTNET" })).toMatchObject({ ok: false, field: "typed" });
    expect(decisionFor(blocked, "approve", "fast-refunds.testnet", { note: "", typed: " fast-refunds.testnet " })).toEqual({ ok: true, body: { payee: "fast-refunds.testnet", decision: "approve", overrideBlock: true } });
    // A denial never needs the typed id and never carries the flag.
    expect(decisionFor(blocked, "deny", "fast-refunds.testnet", input)).toEqual({ ok: true, body: { payee: "fast-refunds.testnet", decision: "deny" } });
  });

  it("refuses a note that is too long or not one line", () => {
    expect(decisionFor(firstStep([]), "approve", "a.testnet", { note: "x".repeat(281), typed: "" })).toMatchObject({ ok: false, field: "note" });
    expect(decisionFor(firstStep([]), "approve", "a.testnet", { note: "two\nlines", typed: "" })).toMatchObject({ ok: false, field: "note" });
  });

  it("moves to the blocked step on 409 PAYEE_BLOCKED, back to review on NOTHING_TO_OVERRIDE, and nowhere on other errors", () => {
    const blocked = stepAfterRefusal(new ApiError(409, "PAYEE_BLOCKED", "blocked", { payee: "x.testnet", signals: [{ id: "reported_by_several", reason: "Reported by 3." }] }));
    expect(blocked).toMatchObject({ step: "blocked", signals: [{ id: "reported_by_several", severity: "block", reason: "Reported by 3." }] });
    expect(blocked!.notice).toContain("Nothing was approved");
    expect(stepAfterRefusal(new ApiError(400, "NOTHING_TO_OVERRIDE", "nothing"))).toMatchObject({ step: "review" });
    expect(stepAfterRefusal(new ApiError(500, "INTERNAL", "boom"))).toBeNull();
    expect(stepAfterRefusal(new Error("boom"))).toBeNull();
  });

  it("says what a decision means for the agent, and after a waiting Call that the next attempt goes through", () => {
    expect(decidedText({ decision: "approve", overrideBlock: false }, true).body).toContain("The agent's next attempt will go through");
    expect(decidedText({ decision: "approve", overrideBlock: true }, false).title).toBe("Approved despite the block");
    expect(decidedText({ decision: "deny", overrideBlock: false }, false).body).toContain("no money moved");
  });

  it("names who decided", () => {
    expect(deciderText({ type: "user", id: "usr_1" }, "usr_1")).toBe("you");
    expect(deciderText({ type: "user", id: "usr_2" }, "usr_1", new Map([["usr_2", "Ken Adams"]]))).toBe("Ken Adams");
    expect(deciderText({ type: "user", id: "usr_3" }, "usr_1")).toBe("a signed-in person");
    expect(deciderText({ type: "recovery_key", id: null }, null)).toBe("the recovery key");
  });

  it("puts every refusal into words, never the raw error", () => {
    expect(payeeErrorText(new ApiError(403, "FORBIDDEN", "x"), "decide")).toContain("Your role");
    expect(payeeErrorText(new ApiError(404, "NOT_FOUND", "x"), "withdraw")).toContain("already withdrawn");
    expect(payeeErrorText(new ApiError(409, "REPORTS_FULL", "x"), "report")).toContain("Nothing more was recorded");
    expect(payeeErrorText(new TypeError("Failed to fetch"), "decide")).toContain("treat it as not done");
  });
});

describe("reports", () => {
  it("files a reason and evidence and never a reporter", () => {
    const r = reportFor("vendor.testnet", { reason: " Billed twice. ", evidence: "https://example.com/proof" });
    expect(r).toEqual({ ok: true, body: { account: "vendor.testnet", reason: "Billed twice.", evidence: "https://example.com/proof" } });
    expect(reportFor("vendor.testnet", { reason: "Billed twice.", evidence: "7Yc4sT9mQpZ3vXk2Hn8LrBw5dJf6GaUe1oCtNiRyVbE4" })).toMatchObject({ ok: true });
  });

  it("says what is wrong with each field", () => {
    const empty = reportFor("v.testnet", { reason: "", evidence: "" });
    expect(empty).toMatchObject({ ok: false, problems: { reason: expect.stringContaining("one line"), evidence: expect.stringContaining("transaction hash") } });
    for (const evidence of ["http://example.com/x", "javascript:alert(1)", "https://user:pw@example.com/x", "https://example.com/a b", `https://example.com/${"a".repeat(300)}`]) {
      expect(reportFor("v.testnet", { reason: "x", evidence })).toMatchObject({ ok: false, problems: { evidence: expect.any(String) } });
    }
    expect(reportFor("v.testnet", { reason: "a‮b", evidence: "https://example.com" })).toMatchObject({ ok: false, problems: { reason: expect.any(String) } });
    expect(reportFor("v.testnet", { reason: "x".repeat(281), evidence: "https://example.com" })).toMatchObject({ ok: false });
  });

  it("shows evidence as a line of text", () => {
    expect(evidenceText({ type: "url", url: "https://example.com/p" })).toEqual({ label: "Link, as text", text: "https://example.com/p" });
    expect(evidenceText({ type: "tx", hash: "Tx1" })).toEqual({ label: "Transaction", text: "Tx1" });
  });
});

describe("the node's shapes", () => {
  const verdict = { verdict: "warn", payee: "vendor.testnet", kind: "named", payer: "owner.testnet", signals: [{ id: "new_account", severity: "warn", reason: "Created 2 days ago.", facts: { createdAtMs: 1 } }], checked: ["account"], notChecked: ["code"], reports: [], checkedAtMs: 1794300000000 };

  it("reads a Budget with verdicts, with the check off, and from an older node", () => {
    const parse = (payeeChecks: unknown) => budgetSchema.shape.payeeChecks.parse(payeeChecks);
    expect(parse([{ payee: "vendor.testnet", status: "warn", complete: true, checkedAt: "2026-11-10T10:00:00.000Z", approval: null, verdict }])).toHaveLength(1);
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeUndefined();
    // One odd entry does not hide the others, and a field of the wrong type reads as absent, so the Budget still loads.
    expect(parse([{ payee: "vendor.testnet", status: "warn", checkedAt: "2026-11-10T10:00:00.000Z", verdict }, { nonsense: true }])).toHaveLength(1);
    expect(parse("not a list")).toBeUndefined();
  });

  it("reads approvals and waiting Calls as GET /v1/budgets/:id/payee-approvals sends them", () => {
    const a = payeeApprovalsSchema.parse({
      budgetId: BUDGET,
      approveAt: `https://dashboard.example/budgets/${BUDGET}`,
      approvals: [{ budgetId: BUDGET, payee: "vendor.testnet", decision: "approve", overrideBlock: false, signals: ["new_account"], note: null, decidedBy: { type: "user", id: "usr_1" }, decidedAt: "2026-11-10T10:00:00.000Z" }],
      waiting: [{ id: "par_1", budgetId: BUDGET, payee: "other.testnet", amount: "40000", source: "wallet", attempts: 3, firstAt: "2026-11-10T09:00:00.000Z", lastAt: "2026-11-10T09:30:00.000Z", verdict: null, signals: [{ id: "x", severity: "warn", reason: "r" }, "junk"] }],
    });
    expect(a.waiting[0]).toMatchObject({ source: "wallet", attempts: 3, verdict: null, signals: [{ id: "x", severity: "warn", reason: "r" }] });
    expect(payeeApprovalSchema.parse({ budgetId: BUDGET, payee: "v.testnet", decision: "deny", decidedAt: "2026-11-10T10:00:00.000Z" })).toMatchObject({ overrideBlock: false, signals: null, decidedBy: { type: "system", id: null } });
  });

  it("keeps report text as plain data", () => {
    const r = payeeReportsSchema.parse({ account: "v.testnet", reporters: 1, reports: [{ account: "v.testnet", reporter: "node.testnet", reason: "<img src=x onerror=alert(1)>", evidence: { type: "url", url: "https://e.example" }, at: "2026-11-10T10:00:00.000Z", filedBy: { type: "user", id: "usr_1" } }] });
    expect(r.reports[0]!.reason).toBe("<img src=x onerror=alert(1)>");
  });

  it("words the two refusal rules and the approval hint", () => {
    const d = (rule: string, details: Record<string, unknown>) => denialSchema.parse({ id: "dny_1", rule, message: "m", budgetId: BUDGET, details, createdAt: "2026-11-10T10:00:00.000Z" });
    expect(payeeRefusalReason(d("PAYEE_NEEDS_APPROVAL", { payeeCheck: { signals: [{ id: "new_account", severity: "warn", reason: "Created 2 days ago" }] } }))).toContain("Created 2 days ago.");
    expect(payeeRefusalReason(d("PAYEE_BLOCKED", { approval: { status: "denied" } }))).toContain("denied this Payee");
    expect(payeeRefusalReason(d("PAYEE_BLOCKED", { payeeCheck: { unavailable: true } }))).toContain("could not be checked");
    expect(payeeRefusalReason(d("PAYEE_BLOCKED", { payeeCheck: { signals: [{ id: "lookalike_payee", severity: "block", reason: "Reads like market-data.testnet" }] } }))).toContain("Reads like market-data.testnet.");
    expect(payeeRefusalReason(d("PAYEE_BLOCKED", { payeeCheck: "nonsense" }))).toBeTruthy();
    expect(payeeRefusalReason(d("PER_CALL_CAP", {}))).toBeNull();
    expect(retryText({ kind: "approval", payee: "vendor.testnet", approveAt: "https://x" }, String)).toBe("Waiting for the owner's approval of vendor.testnet. The same Call goes through once the owner approves it on the Budget's page.");
  });

  it("links an approval to this dashboard's Budget page, and never anywhere else", () => {
    const origin = "http://localhost:3210";
    expect(approvalHref(BUDGET, `${origin}/budgets/${BUDGET}#waiting-payees`, origin)).toBe(`/budgets/${BUDGET}#waiting-payees`);
    expect(approvalHref(BUDGET, `/budgets/${BUDGET}`, origin)).toBe(`/budgets/${BUDGET}#waiting-payees`);
    expect(approvalHref(BUDGET, `https://evil.example/budgets/${BUDGET}`, origin)).toBe(`/budgets/${BUDGET}#waiting-payees`);
    expect(approvalHref(BUDGET, `${origin}/settings`, origin)).toBe(`/budgets/${BUDGET}#waiting-payees`);
    expect(approvalHref(BUDGET, "javascript:alert(1)", origin)).toBe(`/budgets/${BUDGET}#waiting-payees`);
    expect(approvalHref(BUDGET, null, origin)).toBe(`/budgets/${BUDGET}#waiting-payees`);
  });
});

describe("the mock node's payee check", () => {
  const api = new MockClearingApi();
  const vendor = async () => (await api.budgets()).find((b) => b.label.startsWith("Vendor Agent"))!;

  it("seeds one Budget with a waiting request, an approved Payee and a blocked one", async () => {
    const b = await vendor();
    const a = await api.payeeApprovals(b.id);
    expect(a.waiting.map((w) => w.payee)).toEqual(["unregistered-vendor.testnet"]);
    expect(a.approvals.map((x) => [x.payee, x.decision])).toEqual([["research-writer.testnet", "approve"]]);
    const checks = (await api.budget(b.id)).payeeChecks!;
    expect(checks.find((c) => c.payee === "fast-refunds.testnet")?.status).toBe("block");
    expect(checks.find((c) => c.payee === "market-data.testnet")?.status).toBe("allow");
  });

  it("answers 409 PAYEE_BLOCKED to a plain approval of a blocked Payee, and takes it with overrideBlock", async () => {
    const b = await vendor();
    const plain = await api.decidePayee(b.id, { payee: "fast-refunds.testnet", decision: "approve" }).catch((e: unknown) => e);
    expect(plain).toMatchObject({ status: 409, code: "PAYEE_BLOCKED" });
    expect(stepAfterRefusal(plain)).toMatchObject({ step: "blocked" });
    const over = await api.decidePayee(b.id, { payee: "fast-refunds.testnet", decision: "approve", overrideBlock: true });
    expect(over).toMatchObject({ decision: "approve", overrideBlock: true, signals: expect.arrayContaining(["reported_by_several"]) });
    expect(await api.decidePayee(b.id, { payee: "market-data.testnet", decision: "approve", overrideBlock: true }).catch((e: unknown) => e)).toMatchObject({ status: 400, code: "NOTHING_TO_OVERRIDE" });
    await api.withdrawPayeeDecision(b.id, "fast-refunds.testnet");
    expect((await api.payeeApprovals(b.id)).approvals.some((x) => x.payee === "fast-refunds.testnet")).toBe(false);
  });

  it("clears the waiting request when the owner approves, and files reports without a reporter field", async () => {
    const b = await vendor();
    await api.decidePayee(b.id, { payee: "unregistered-vendor.testnet", decision: "approve", note: "confirmed" });
    expect((await api.payeeApprovals(b.id)).waiting).toEqual([]);
    const filed = await api.reportPayee({ account: "research-writer.testnet", reason: "Billed twice.", evidence: "https://example.com/proof" });
    expect(filed.report).toMatchObject({ account: "research-writer.testnet", reason: "Billed twice.", reporter: expect.any(String) });
    expect((await api.payeeReports("research-writer.testnet")).reports.some((r) => r.reason === "Billed twice.")).toBe(true);
  });
});
