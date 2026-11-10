/**
 * The payee check over HTTP. A signed-in owner (a platform role) or the operator reads verdicts, decides approvals and
 * files reports; reads need `agents.read` and changes `agents.manage`, like the Budget routes. The one public route is
 * the question an agent's wallet asks, which is answered only for a signature of the Budget's own agent key.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { REPORT_LIMITS, StoreError } from "@payminto/payee-check";
import { payeeApprovalRequestDigest, verifyDigest } from "@payminto/protocol";
import { auditActor, type Access } from "../auth/actor.ts";
import type { ChainClient } from "../chain.ts";
import { ApiError } from "../errors.ts";
import { body, limitOf, parse, zAccount, zId32, zSig, zUint } from "../gateway/http.ts";
import type { BudgetRow, Store } from "../store.ts";
import type { PayeeService } from "./service.ts";

/** Longest note an owner can leave with a decision. */
export const NOTE_MAX = 280;

// One printable line: no control characters and no line breaks.
const zNote = z
  .string()
  .max(NOTE_MAX)
  .refine((s) => ![...s].some((ch) => ch.charCodeAt(0) < 0x20 || (ch.charCodeAt(0) >= 0x7f && ch.charCodeAt(0) <= 0x9f) || ch.charCodeAt(0) === 0x2028 || ch.charCodeAt(0) === 0x2029), "must be one line of plain text")
  .transform((s) => s.trim());

const decisionSchema = z.strictObject({
  payee: zAccount,
  decision: z.enum(["approve", "deny"]),
  note: zNote.nullish(),
  overrideBlock: z.boolean().optional(),
});

const askSchema = z.strictObject({ payee: zAccount, amount: zUint, signature: zSig });

// Lengths are capped here so an oversized body is refused before anything else reads it; the package validates the rest.
const reportSchema = z.strictObject({
  account: z.string().max(64),
  reason: z.string().max(REPORT_LIMITS.reasonMax),
  evidence: z.union([z.string().max(REPORT_LIMITS.urlMax), z.strictObject({ type: z.literal("tx"), hash: z.string().max(64) }), z.strictObject({ type: z.literal("url"), url: z.string().max(REPORT_LIMITS.urlMax) })]),
});

/** A plain string is a transaction hash when it looks like one, else a URL: the package then holds it to its rules. */
function evidenceOf(e: z.infer<typeof reportSchema>["evidence"]): unknown {
  if (typeof e !== "string") return e;
  return /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(e) ? { type: "tx", hash: e } : { type: "url", url: e };
}

export function mountPayees(app: Hono<any>, payees: PayeeService, deps: { access: Access; store: Store; chain: ChainClient }): void {
  const { access, store, chain } = deps;
  const read = (c: Context) => access.platform(c, "agents.read");
  const manage = (c: Context) => access.platform(c, "agents.manage");

  const budgetOf = (c: Context): BudgetRow => {
    const id = parse(c.req.param("id"), zId32, "invalid Budget id");
    const m = store.budget(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "No Budget with this id is registered on this node. GET /v1/budgets lists the ones that are.");
    return m;
  };

  // ------------------------------------------------------------------ verdicts

  app.get("/v1/payees/check", async (c) => {
    read(c);
    const account = c.req.query("account");
    if (!account) throw new ApiError(400, "VALIDATION_ERROR", "Pass the account to check: GET /v1/payees/check?account=<NEAR account id>, and optionally &budget=<Budget id> to judge it for that Budget.");
    if (account.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "account is too long to be a NEAR account id (at most 64 characters)");
    const budgetId = c.req.query("budget");
    let budget: BudgetRow | null = null;
    if (budgetId) {
      budget = store.budget(parse(budgetId, zId32, "invalid budget")) ?? null;
      if (!budget) throw new ApiError(404, "NOT_FOUND", "No Budget with this id is registered on this node. GET /v1/budgets lists the ones that are, or leave budget out.");
    }
    return c.json(await payees.verdictFor(account, budget));
  });

  // ------------------------------------------------------------------ approvals

  app.get("/v1/budgets/:id/payee-approvals", (c) => {
    read(c);
    const m = budgetOf(c);
    return c.json({ budgetId: m.id, approveAt: payees.approveAt(m.id), approvals: payees.approvals(m.id), waiting: payees.waiting(m.id) });
  });

  app.post("/v1/budgets/:id/payee-approvals", async (c) => {
    const actor = manage(c);
    const m = budgetOf(c);
    const b = await body(c, decisionSchema);
    const approval = await payees.decide(m, { payee: b.payee, decision: b.decision, note: b.note ? b.note : null, overrideBlock: b.overrideBlock === true }, auditActor(actor));
    return c.json({ approval });
  });

  app.delete("/v1/budgets/:id/payee-approvals/:payee", (c) => {
    const actor = manage(c);
    const m = budgetOf(c);
    const payee = parse(c.req.param("payee"), zAccount, "invalid payee");
    return c.json({ withdrawn: true, approval: payees.withdraw(m, payee, auditActor(actor)) });
  });

  // Public, and answered only for the Budget's own agent key: the wallet asks whether the owner approved a payee its
  // own check has warnings about. The body carries no decision, and nothing here can approve one.
  app.post("/v1/budgets/:id/payee-approvals/requests", async (c) => {
    const m = budgetOf(c);
    const b = await body(c, askSchema);
    const digest = payeeApprovalRequestDigest(chain.hub, chain.network, { budgetId: m.id, payee: b.payee, amount: b.amount });
    if (!verifyDigest(m.agent, digest, b.signature)) {
      throw new ApiError(403, "BAD_REQUEST_SIGNATURE", "The request must be signed by the Budget's agent key over payeeApprovalRequestDigest(hub, network, { budgetId, payee, amount }) from @payminto/protocol.");
    }
    return c.json(await payees.ask(m, b.payee, BigInt(b.amount)));
  });

  // ------------------------------------------------------------------ reports

  app.post("/v1/payees/reports", async (c) => {
    const actor = manage(c);
    let raw: unknown;
    try {
      const text = await c.req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
    }
    if (raw && typeof raw === "object" && "reporter" in raw) {
      throw new ApiError(400, "VALIDATION_ERROR", "reporter is not accepted: a report is filed in the name of the account you are signed in to. Remove the field and send again.");
    }
    const b = parse(raw, reportSchema, "the report failed validation: send { account, reason, evidence }, where evidence is a transaction hash or an https URL");
    try {
      return c.json(payees.fileReport({ account: b.account, reason: b.reason, evidence: evidenceOf(b.evidence) }, auditActor(actor)), 201);
    } catch (err) {
      if (err instanceof StoreError && err.code === "invalid_report") {
        // The package names the fields and the rules they broke. It never echoes the text that was sent.
        throw new ApiError(400, "VALIDATION_ERROR", `${err.message}. The reason is one line of at most ${REPORT_LIMITS.reasonMax} characters, and the evidence a NEAR transaction hash or an https URL of at most ${REPORT_LIMITS.urlMax}.`);
      }
      if (err instanceof StoreError && err.code === "account_full") throw new ApiError(409, "REPORTS_FULL", `${err.message}. Nothing more is recorded for this account.`);
      throw err;
    }
  });

  app.get("/v1/payees/reports", (c) => {
    read(c);
    const raw = c.req.query("account");
    const account = raw ? parse(raw, zAccount, "invalid account") : null;
    const reports = payees.reports(account, limitOf(c, 100, REPORT_LIMITS.perAccount));
    return c.json({ account, reporters: account ? payees.reporters(account) : new Set(reports.map((r) => `${r.account} ${r.reporter}`)).size, reports });
  });
}
