"use client";

import { useId, useState } from "react";
import { ChevronDown, Flag, Loader2, RotateCcw, ShieldCheck, TriangleAlert, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import type { AccountId as NearAccount } from "@payminto/protocol";
import { useApi, useCan } from "@/lib/session";
import { useDirectory } from "@/lib/queries";
import { REPORT_REASON_MAX, NOTE_MAX, STANDING, VERDICT_WORDS, decidedText, deciderText, decisionFor, evidenceText, firstStep, payeeErrorText, reportFor, standingOf, stepAfterRefusal, type DecideStep } from "@/lib/payee-approvals";
import { useDecidePayee, useDeciderNames, useFreshPayeeCheck, usePayeeApprovals, usePayeeReports, useReportPayee, useSignalTitles, useVerdictView, useWithdrawPayeeDecision } from "@/lib/use-payee-approvals";
import type { BudgetDetail, PayeeApproval, PayeeApprovalRequest, PayeeCheck, PayeeSignal } from "@/lib/schemas";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AccountId, AccountText } from "@/components/ds/account-id";
import { ApprovalSheet, type ApprovalRisk, type ApprovalRow } from "@/components/ds/approval-sheet";
import { NoMoneyMoved } from "@/components/ds/refusal-reason";
import { PayeeVerdict, PayeeVerdictMark, VerdictWords } from "@/components/ds/payee-verdict";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Address, Money, Panel } from "./primitives";
import { EmptyState, ErrorState } from "./states";
import { TimeAgo } from "./time-ago";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A small action inside a row: 44px tall on a phone, compact from 640px. */
const ROW_BUTTON = "h-11 sm:h-8";
const NO_ACCOUNTS: readonly string[] = [];

/** The agent's short name, as the rest of the Budget page says it: "Vendor Agent". */
const agentNameOf = (m: Pick<BudgetDetail, "label">) => m.label.split(" - ")[0] || "The agent";

const WEIGHT: Record<PayeeSignal["severity"], { label: string; className: string }> = {
  block: { label: "Blocks", className: "bg-negative-soft text-negative" },
  warn: { label: "Ask first", className: "bg-warning-soft text-warning" },
  info: { label: "Note", className: "bg-muted text-muted-foreground" },
};

/** The reasons behind a verdict as the server sent them: a weight in words, a short name when known, and the sentence. */
function SignalList({ signals, titles, className }: { signals: readonly PayeeSignal[]; titles: Readonly<Record<string, string>>; className?: string }) {
  if (signals.length === 0) return null;
  return (
    <ul aria-label="Reasons" className={cn("space-y-2", className)}>
      {signals.map((s) => (
        <li key={s.id} data-signal={s.id}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap", WEIGHT[s.severity].className)}>
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              {WEIGHT[s.severity].label}
            </span>
            {titles[s.id] && <span className="text-sm font-medium text-foreground">{titles[s.id]}</span>}
          </div>
          <p className="mt-0.5 text-sm [overflow-wrap:anywhere] text-muted-foreground">
            <VerdictWords accounts={NO_ACCOUNTS}>{s.reason}</VerdictWords>
          </p>
        </li>
      ))}
    </ul>
  );
}

type Outcome = { title: string; body: string; payee: NearAccount };

/** What a decision changed, kept on screen after the row it was about has gone. */
function OutcomeNotice({ outcome, onDismiss, className }: { outcome: Outcome; onDismiss: () => void; className?: string }) {
  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-xl border bg-rail p-3 text-sm", className)}>
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-positive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {outcome.title}: <AccountText value={outcome.payee} className="align-bottom text-[0.95em]" />
        </p>
        <p className="mt-0.5 text-muted-foreground">{outcome.body}</p>
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="relative inline-flex size-6 shrink-0 items-center justify-center rounded text-subtle hover:bg-muted hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']">
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The owner's decision about one Payee, in the ApprovalSheet. A Payee the check blocks never offers Approve: the
 * owner sees what is blocked, types the account id, and chooses "Approve anyway", which is the only path that sends
 * `overrideBlock`. The same step appears when the server answers 409 PAYEE_BLOCKED to a plain approval.
 */
function PayeeDecisionSheet({
  m,
  payee,
  request,
  check,
  onClose,
  onDecided,
}: {
  m: BudgetDetail;
  payee: NearAccount;
  /** The Call that waits, when one does. */
  request: PayeeApprovalRequest | null;
  /** The verdict the server holds, when it holds one. */
  check: PayeeCheck | null;
  onClose: () => void;
  onDecided: (approval: PayeeApproval, wasWaiting: boolean) => void;
}) {
  const known: PayeeSignal[] | null = check ? check.verdict.signals.filter((s) => s.severity !== "info").map((s) => ({ id: s.id, severity: s.severity, reason: s.reason })) : request ? request.signals : null;
  const [step, setStep] = useState<DecideStep>(() => firstStep(known));
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<{ field: "note" | "typed"; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<"approve" | "refuse" | null>(null);
  const decide = useDecidePayee(m.id);
  const titles = useSignalTitles();
  const view = useVerdictView(check?.verdict ?? null);
  const api = useApi();
  const name = useDirectory().lookup(payee)?.name ?? null;
  const blocked = step.step === "blocked";
  const verdictKind = blocked ? "block" : (check?.status ?? request?.verdict ?? null);
  const shown = blocked ? [...step.signals, ...(known ?? []).filter((s) => s.severity === "warn" && !step.signals.some((b) => b.id === s.id))] : (known ?? []);

  const send = (action: "approve" | "deny") => {
    setError(null);
    const attempt = decisionFor(step, action, payee, { note, typed });
    if (!attempt.ok) return setProblem({ field: attempt.field, message: attempt.message });
    setProblem(null);
    setSending(action === "approve" ? "approve" : "refuse");
    decide.mutate(attempt.body, {
      onSuccess: (approval) => onDecided(approval, request !== null),
      onError: (e) => {
        const next = stepAfterRefusal(e);
        if (next) {
          setStep(next);
          setTyped("");
        } else setError(payeeErrorText(e, "decide"));
      },
      onSettled: () => setSending(null),
    });
  };

  const rows: ApprovalRow[] = [
    { label: "From", value: <span className="flex min-w-0 flex-col"><span className="font-medium">{agentNameOf(m)}</span><AccountId value={m.agent} copy={false} explorer={false} idClassName="text-muted-foreground" /></span> },
    { label: "To", value: <AccountId value={payee} name={name} mode="wrap" explorer={false} /> },
    ...(request
      ? [
          { label: "Amount", value: <span><Money atomic={request.amount} /> <span className="text-muted-foreground">for the Call that waits</span></span> },
          { label: "Tried", value: <span>{plural(request.attempts, "time")}, last <TimeAgo iso={request.lastAt} /></span> },
        ]
      : [{ label: "Amount", value: <span className="text-muted-foreground">No Call waits. The decision applies to the agent&apos;s next Calls.</span> }]),
    { label: "Rule", value: verdictKind ? <span>Payee check: {VERDICT_WORDS[verdictKind]}</span> : <span className="text-muted-foreground">This server holds no verdict for this Payee</span> },
  ];
  const risks: ApprovalRisk[] = shown.map((s) => ({ key: s.id, tone: s.severity === "block" ? "block" : "warn", title: titles[s.id] ?? (s.severity === "block" ? "Blocks" : "Warning"), body: <VerdictWords accounts={NO_ACCOUNTS}>{s.reason}</VerdictWords> }));

  return (
    <ApprovalSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={blocked ? "The Payee check blocks this Payee" : "Approve this Payee?"}
      description={
        blocked
          ? "An approval does not override a block. You can deny the Payee, or approve it anyway by typing its account id. That is written to the activity log."
          : "Approving lets the agent pay this account under this Budget. Denying refuses every Call to it. Nothing is signed or sent to NEAR by this choice."
      }
      amount={request ? <Money atomic={request.amount} size="display" /> : undefined}
      amountLabel="Amount of the Call that waits"
      rows={rows}
      notice={step.notice}
      risks={risks}
      error={error}
      refuseLabel="Deny"
      approveLabel={blocked ? "Approve anyway" : "Approve"}
      approveTone={blocked ? "destructive" : "primary"}
      busy={sending}
      onRefuse={() => send("deny")}
      onApprove={() => send("approve")}
    >
      {shown.length === 0 && !blocked && <p className="mb-4 text-sm text-muted-foreground">{check ? "The check has no warning about this Payee." : "This server's Payee check holds nothing about this Payee, so there are no reasons to show."}</p>}
      {check && view.data && (
        <details className="group mb-4">
          <summary className="flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-3.5 transition-transform duration-150 group-open:rotate-180" />
            Everything the check found
          </summary>
          <div className="mt-2 rounded-lg border bg-rail p-3">
            <PayeeVerdict dense showPayee={false} view={view.data} from={api.mock ? "demo data on the demo server (no network)" : "NEAR by this Payminto server"} />
          </div>
        </details>
      )}
      {blocked && (
        <div className="mb-4 space-y-1.5">
          <Label htmlFor="payee-override-id">Type the Payee&apos;s account id to approve it anyway</Label>
          <p id="payee-override-hint" className="text-xs text-muted-foreground">
            Type <AccountText value={payee} className="align-bottom text-foreground" /> exactly as shown. Deny needs no typing.
          </p>
          <Input
            id="payee-override-id"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              if (problem?.field === "typed") setProblem(null);
            }}
            aria-invalid={problem?.field === "typed"}
            aria-describedby={problem?.field === "typed" ? "payee-override-error" : "payee-override-hint"}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="hash"
          />
          {problem?.field === "typed" && (
            <p id="payee-override-error" role="alert" className="text-xs text-negative">
              {problem.message}
            </p>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="payee-decision-note">
          Note <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="payee-decision-note"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (problem?.field === "note") setProblem(null);
          }}
          aria-invalid={problem?.field === "note"}
          aria-describedby={problem?.field === "note" ? "payee-note-error" : "payee-note-hint"}
          placeholder="Why you decided this"
          autoComplete="off"
        />
        {problem?.field === "note" ? (
          <p id="payee-note-error" role="alert" className="text-xs text-negative">
            {problem.message}
          </p>
        ) : (
          <p id="payee-note-hint" className="text-xs text-muted-foreground">
            Kept with the decision for the other owners. {note.trim().length}/{NOTE_MAX}
          </p>
        )}
      </div>
    </ApprovalSheet>
  );
}

/**
 * The Calls that wait for the owner, at the top of the Budget page: who the agent tried to pay, how much, how often
 * and why the check hesitates, with the decision one press away. It follows the live events, and after a decision it
 * says what the agent's next attempt will meet.
 */
export function WaitingPayees({ m }: { m: BudgetDetail }) {
  const can = useCan();
  const manage = can("agents.manage");
  const q = usePayeeApprovals(m.id);
  const titles = useSignalTitles();
  const dir = useDirectory();
  const [deciding, setDeciding] = useState<NearAccount | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const waiting = q.data?.waiting ?? [];
  const open = deciding ? (waiting.find((r) => r.payee === deciding) ?? null) : null;
  if (waiting.length === 0 && !outcome) return null;
  const agent = agentNameOf(m);
  return (
    <section id="waiting-payees" aria-labelledby="waiting-payees-title" className="mb-5 scroll-mt-28 rounded-xl border bg-card">
      {waiting.length > 0 && (
        <div className="flex items-start gap-3 border-b px-4 py-3.5 sm:px-5">
          <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning">
            <TriangleAlert className="size-3.5" />
          </span>
          <div className="min-w-0">
            <h2 id="waiting-payees-title" className="text-[0.9375rem] font-semibold">
              Waiting for your approval
            </h2>
            <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
              {agent} tried to pay {waiting.length === 1 ? "a Payee" : `${waiting.length} Payees`} the Payee check has a warning about. Each Call was refused and waits for an owner.
            </p>
          </div>
        </div>
      )}
      {outcome && <OutcomeNotice outcome={outcome} onDismiss={() => setOutcome(null)} className={cn("m-4 sm:mx-5", waiting.length === 0 && "border-0 bg-transparent p-0")} />}
      {waiting.length > 0 && (
        <ul className="divide-y">
          {waiting.map((r) => {
            const name = dir.lookup(r.payee)?.name ?? null;
            return (
              <li key={r.id} data-waiting={r.payee} className="px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">{agent}</span> tried to pay
                    </p>
                    <AccountId value={r.payee} name={name} mode="wrap" className="mt-0.5" />
                  </div>
                  <div className="text-right max-sm:text-left">
                    <Money atomic={r.amount} size="lg" />
                    <p className="text-xs text-muted-foreground">
                      {plural(r.attempts, "attempt")}, last <TimeAgo iso={r.lastAt} />
                    </p>
                  </div>
                </div>
                {r.signals.length > 0 ? (
                  <SignalList signals={r.signals} titles={titles} className="mt-3" />
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">{r.source === "wallet" ? "The agent's wallet has a warning about this Payee and asked before signing. This server holds no reasons of its own." : "The server recorded no reasons with this request."}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {manage ? (
                    <Button type="button" className="h-11 rounded-xl sm:h-9 sm:rounded-md" onClick={() => setDeciding(r.payee)}>
                      Approve or deny
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">Your role can see this but cannot decide it. Ask a platform owner or admin.</p>
                  )}
                  <NoMoneyMoved />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {q.isError && <p className="border-t px-4 py-3 text-sm text-muted-foreground sm:px-5">{payeeErrorText(q.error, "read")}</p>}
      {open && (
        <PayeeDecisionSheet
          key={open.id}
          m={m}
          payee={open.payee}
          request={open}
          check={m.payeeChecks?.find((c) => c.payee === open.payee) ?? null}
          onClose={() => setDeciding(null)}
          onDecided={(approval, wasWaiting) => {
            setDeciding(null);
            setOutcome({ ...decidedText(approval, wasWaiting), payee: approval.payee });
          }}
        />
      )}
    </section>
  );
}

/** Reports against an account, as quotes. A report is a third party's claim: its words and its evidence are text only. */
function ReportQuotes({ account, enabled }: { account: NearAccount; enabled: boolean }) {
  const q = usePayeeReports(account, enabled);
  if (q.isPending) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3.5 animate-spin" /> Reading the reports this server holds.
      </p>
    );
  }
  if (q.isError) return <p className="text-xs text-muted-foreground">{payeeErrorText(q.error, "read")}</p>;
  if (q.data === null) return <p className="text-xs text-muted-foreground">This server does not keep reports.</p>;
  const { reports, reporters } = q.data;
  if (reports.length === 0) return <p className="text-xs text-muted-foreground">No reports against this account on this server.</p>;
  return (
    <div>
      <p className="text-xs font-medium">
        {plural(reports.length, "report")} from {plural(reporters, "reporter")} - claims by third parties, quoted as written
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">Payminto did not verify them and does not open their evidence.</p>
      <ul aria-label="Reports" className="mt-2 space-y-2.5">
        {reports.map((r) => {
          const e = evidenceText(r.evidence);
          return (
            <li key={`${r.reporter} ${r.at}`}>
              <figure className="border-l-2 border-border pl-3">
                <blockquote className="text-sm [overflow-wrap:anywhere] text-foreground">{r.reason}</blockquote>
                <figcaption className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                  <span>Claimed by</span>
                  <AccountText value={r.reporter} className="text-[0.75rem] text-foreground" />
                  <span>
                    on{" "}
                    <time dateTime={r.at} className="hash whitespace-nowrap">
                      {formatDateTime(r.at)}
                    </time>
                  </span>
                  <span className="min-w-0 basis-full [overflow-wrap:anywhere]">
                    {e.label}: <span className="hash text-foreground">{e.text}</span>
                  </span>
                </figcaption>
              </figure>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * "Report this account": the reports this server already holds, and a form for one more, with a reason and evidence.
 * The report is filed in the name of the server's operator account, so the form never asks who reports.
 */
function ReportPayeeDialog({ budgetId, account, onClose }: { budgetId: string; account: NearAccount; onClose: () => void }) {
  const can = useCan();
  const manage = can("agents.manage");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [problems, setProblems] = useState<{ reason?: string; evidence?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<number | null>(null);
  const report = useReportPayee(budgetId);
  return (
    <Dialog open onOpenChange={(o) => !o && !report.isPending && onClose()}>
      <DialogContent sheetOnMobile showCloseButton={!report.isPending} className="gap-0 p-0 sm:max-w-lg max-sm:p-0">
        <DialogHeader className="border-b px-4 py-4 text-left sm:px-6">
          <DialogTitle className="pr-8 text-[0.9375rem] leading-[1.375rem]">Report this account</DialogTitle>
          <DialogDescription className="text-[0.8125rem]">A report is a claim that every owner on this server sees when this account is checked. It is filed in the name of the server&apos;s operator account, not in yours.</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setError(null);
            const attempt = reportFor(account, { reason, evidence });
            if (!attempt.ok) return setProblems(attempt.problems);
            setProblems({});
            report.mutate(attempt.body, {
              onSuccess: (r) => {
                setFiled(r.reporters);
                setReason("");
                setEvidence("");
                toast.success("Report filed", { description: "The server counts it the next time it checks this account." });
              },
              onError: (err) => setError(payeeErrorText(err, "report")),
            });
          }}
        >
          <div className="max-h-[58dvh] space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
            <AccountId value={account} mode="wrap" explorer={false} />
            <ReportQuotes account={account} enabled />
            {filed !== null && (
              <p role="status" className="flex items-start gap-2 rounded-xl border bg-rail p-3 text-sm">
                <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-positive" />
                <span>
                  <span className="font-medium">Report filed.</span> The next check of this account counts it, and its Payees list shows the new verdict once the server has looked. One server is one voice, so a report from here alone leads to a warning, not a block.
                </span>
              </p>
            )}
            {manage ? (
              <div className="space-y-4 border-t pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="report-reason">What happened</Label>
                  <Input
                    id="report-reason"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setProblems((p) => ({ ...p, reason: undefined }));
                    }}
                    aria-invalid={Boolean(problems.reason)}
                    aria-describedby={problems.reason ? "report-reason-error" : "report-reason-hint"}
                    autoComplete="off"
                  />
                  {problems.reason ? (
                    <p id="report-reason-error" role="alert" className="text-xs text-negative">
                      {problems.reason}
                    </p>
                  ) : (
                    <p id="report-reason-hint" className="text-xs text-muted-foreground">
                      One line that others will read as your claim. {reason.trim().length}/{REPORT_REASON_MAX}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="report-evidence">Evidence</Label>
                  <Input
                    id="report-evidence"
                    value={evidence}
                    onChange={(e) => {
                      setEvidence(e.target.value);
                      setProblems((p) => ({ ...p, evidence: undefined }));
                    }}
                    aria-invalid={Boolean(problems.evidence)}
                    aria-describedby={problems.evidence ? "report-evidence-error" : "report-evidence-hint"}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="hash"
                  />
                  {problems.evidence ? (
                    <p id="report-evidence-error" role="alert" className="text-xs text-negative">
                      {problems.evidence}
                    </p>
                  ) : (
                    <p id="report-evidence-hint" className="text-xs text-muted-foreground">
                      A NEAR transaction hash, or an https link. Others see it as text; Payminto never opens it.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="border-t pt-4 text-sm text-muted-foreground">Your role can read reports but cannot file one. Ask a platform owner or admin.</p>
            )}
            {error && (
              <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:justify-end sm:px-6 max-sm:sticky max-sm:bottom-0 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button type="button" variant="outline" className={cn("max-sm:h-11 max-sm:rounded-xl", !manage && "max-sm:col-span-2")} disabled={report.isPending} onClick={onClose}>
              {filed !== null || !manage ? "Close" : "Cancel"}
            </Button>
            {manage && (
              <Button type="submit" className="max-sm:h-12 max-sm:rounded-xl" disabled={report.isPending}>
                {report.isPending && <Loader2 aria-hidden className="animate-spin" />}
                File report
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WithdrawButton({ m, approval, onWithdrawn }: { m: BudgetDetail; approval: PayeeApproval; onWithdrawn?: (a: PayeeApproval) => void }) {
  const withdraw = useWithdrawPayeeDecision(m.id);
  const denied = approval.decision === "deny";
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} disabled={withdraw.isPending}>
          {withdraw.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Undo2 aria-hidden />} Withdraw decision
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{denied ? "Withdraw this denial?" : "Withdraw this approval?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {denied
              ? "The Payee is judged by the Payee check alone again. The agent can pay it if the check has no concerns, and its Calls wait for an owner if the check has a warning."
              : "The Payee is judged by the Payee check alone again. If the check has a warning or a block, the agent's next Call to it is refused until an owner decides."}{" "}
            Calls already accepted still settle.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep the decision</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              withdraw.mutate(approval.payee, {
                onSuccess: (a) => {
                  toast.success("Decision withdrawn", { description: "The Payee is judged by the Payee check alone again." });
                  onWithdrawn?.(a);
                },
                onError: (e) => toast.error("The decision was not withdrawn", { description: payeeErrorText(e, "withdraw") }),
              })
            }
          >
            Withdraw decision
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One Payee of a Budget: where it stands, with the reasons one press away. The verdict is the server's when it has
 * the Payee check on. When it is off, the look is made by this browser on request, and the row says so.
 */
function BudgetPayeeRow({
  m,
  payee,
  check,
  approval,
  waiting,
  listed,
  decisions,
}: {
  m: BudgetDetail;
  payee: NearAccount;
  check: PayeeCheck | null;
  approval: PayeeApproval | null;
  waiting: PayeeApprovalRequest | null;
  /** False for an account the agent tried that is not on a Budget's own list. */
  listed: boolean;
  /** False on a server that has no Payee approvals at all. */
  decisions: boolean;
}) {
  const can = useCan();
  const manage = can("agents.manage");
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const regionId = useId();
  const name = useDirectory().lookup(payee)?.name ?? null;
  const standing = standingOf(check, approval, waiting);
  const s = STANDING[standing];
  // With no verdict from the server the look is made when the row opens; with one, only when the owner asks again.
  const fresh = useFreshPayeeCheck(m.id, payee, m.payees.filter((p) => p !== payee), m.owner, open && (asked || !check));
  const held = useVerdictView(check && fresh.check.state !== "done" ? check.verdict : null);
  const serverFrom = api.mock ? "demo data on the demo server (no network)" : "NEAR by this Payminto server";
  const again = () => {
    if (asked || !check) fresh.again();
    else setAsked(true);
  };
  const toggle = (
    <Button type="button" size="sm" variant="outline" className={cn(ROW_BUTTON, "shrink-0")} aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(!open)}>
      {open ? "Hide details" : check ? "Details" : "Check Payee"}
    </Button>
  );
  const checkAgain = (
    <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={again}>
      <RotateCcw aria-hidden /> Check again
    </Button>
  );
  return (
    <div data-payee={payee} data-standing={standing}>
      {/* The account id keeps a line of its own, so the action beside the name never squeezes it. */}
      {name && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium">{name}</span>
          {toggle}
        </div>
      )}
      <Address address={payee} showName={false} className={cn(name && "text-muted-foreground")} />
      <div className={cn("mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5", !name && "justify-between")}>
        {s.tone === "none" ? <span className="text-xs text-muted-foreground">{s.label}</span> : <PayeeVerdictMark verdict={s.tone}>{s.label}</PayeeVerdictMark>}
        {!name && toggle}
      </div>
      {outcome && <OutcomeNotice outcome={outcome} onDismiss={() => setOutcome(null)} className="mt-2" />}
      {open && (
        <div id={regionId} className="mt-2 rounded-lg border bg-rail p-3 text-muted-foreground">
          <p className="text-xs">
            {s.next}
            {!listed && " It is not on this Budget's list of allowed Payees, so it cannot be paid under this Budget whatever is decided here."}
            {check && !check.complete && " A source did not answer when the server looked, so this verdict may be heavier than a full look would be."}
          </p>
          <div className="mt-2.5 border-t pt-2.5">
            {fresh.check.state === "checking" ? (
              <p role="status" className="flex items-start gap-1.5 text-xs">
                <Loader2 aria-hidden className="mt-px size-3.5 shrink-0 animate-spin" />
                Checking this Payee. Nothing changes on chain.
              </p>
            ) : fresh.check.state === "unavailable" ? (
              <>
                <p className="flex items-start gap-1.5 text-xs">
                  <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
                  <span>
                    <span className="font-medium text-foreground">Could not check.</span> {fresh.check.message}
                  </span>
                </p>
                <div className="mt-2">{checkAgain}</div>
              </>
            ) : fresh.check.state === "done" ? (
              <>
                {fresh.check.by === "browser" && <p className="mb-2 text-xs">This server&apos;s Payee check is off, so this look was made by this browser. The server judges Calls by the Budget&apos;s rules alone.</p>}
                <PayeeVerdict dense showPayee={false} className="text-foreground" view={fresh.check.view} from={fresh.check.from} action={checkAgain} />
              </>
            ) : held.data ? (
              <PayeeVerdict dense showPayee={false} className="text-foreground" view={held.data} from={serverFrom} action={checkAgain} />
            ) : held.isError ? (
              <>
                <p className="text-xs">The reasons could not be loaded. Check your connection, then check again.</p>
                <div className="mt-2">{checkAgain}</div>
              </>
            ) : (
              <p role="status" className="flex items-start gap-1.5 text-xs">
                <Loader2 aria-hidden className="mt-px size-3.5 shrink-0 animate-spin" />
                Loading the reasons.
              </p>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t pt-2.5">
            {decisions && manage && listed && (
              <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={() => setDeciding(true)}>
                {approval ? "Change decision" : "Approve or deny"}
              </Button>
            )}
            {decisions && manage && approval && <WithdrawButton m={m} approval={approval} />}
            {decisions && (
              <Button type="button" size="sm" variant="ghost" className={ROW_BUTTON} onClick={() => setReporting(true)}>
                <Flag aria-hidden /> Report this account
              </Button>
            )}
            {decisions && !manage && <p className="basis-full text-xs">Your role can see this but cannot decide it.</p>}
          </div>
        </div>
      )}
      {deciding && (
        <PayeeDecisionSheet
          m={m}
          payee={payee}
          request={waiting}
          check={check}
          onClose={() => setDeciding(false)}
          onDecided={(a, wasWaiting) => {
            setDeciding(false);
            setOutcome({ ...decidedText(a, wasWaiting), payee: a.payee });
          }}
        />
      )}
      {reporting && <ReportPayeeDialog budgetId={m.id} account={payee} onClose={() => setReporting(false)} />}
    </div>
  );
}

/**
 * The Payees of a Budget inside "Allowed Payees": every Payee on the list with its badge, and below them any account
 * the agent tried that the server holds a verdict or a decision for.
 */
export function BudgetPayees({ m }: { m: BudgetDetail }) {
  const q = usePayeeApprovals(m.id);
  const checks = m.payeeChecks;
  const approvals = q.data?.approvals ?? [];
  const waiting = q.data?.waiting ?? [];
  const known = new Set<string>([...(checks ?? []).map((c) => c.payee), ...approvals.map((a) => a.payee), ...waiting.map((w) => w.payee)]);
  const others = [...known].filter((p) => !m.payees.includes(p)).sort();
  if (m.payees.length === 0 && others.length === 0) return null;
  const row = (payee: NearAccount, listed: boolean) => (
    <li key={payee}>
      <BudgetPayeeRow
        m={m}
        payee={payee}
        listed={listed}
        decisions={q.data !== null && q.data !== undefined}
        check={checks?.find((c) => c.payee === payee) ?? null}
        approval={approvals.find((a) => a.payee === payee) ?? null}
        waiting={waiting.find((w) => w.payee === payee) ?? null}
      />
    </li>
  );
  return (
    <div id="payees" className="scroll-mt-28 text-sm text-foreground">
      {!Array.isArray(checks) && (
        <p className="mb-2.5 text-xs text-muted-foreground">
          {checks === null ? "This server's Payee check is off, so it holds no verdicts and judges Calls by the Budget's rules alone." : "This server sends no Payee verdicts."} Open a Payee to have this browser check it.
        </p>
      )}
      {m.payees.length > 0 && <ul className="mt-1 space-y-3">{m.payees.map((p) => row(p, true))}</ul>}
      {others.length > 0 && (
        <>
          <p className="mt-3 mb-2 text-xs font-medium text-muted-foreground">{m.payees.length > 0 ? "Not on the list, tried by the agent" : "Tried by the agent"}</p>
          <ul className="space-y-3">{others.map((p) => row(p, m.payees.length === 0))}</ul>
        </>
      )}
    </div>
  );
}

const DECISION: Record<"approve" | "override" | "deny", { label: string; tone: "allow" | "warn" | "block" }> = {
  approve: { label: "Approved", tone: "allow" },
  override: { label: "Approved despite a block", tone: "warn" },
  deny: { label: "Denied", tone: "block" },
};

/** Past decisions about a Budget's Payees: what was decided, by whom, when, and what the owner saw. Each can be withdrawn. */
export function PayeeDecisionsPanel({ m }: { m: BudgetDetail }) {
  const can = useCan();
  const manage = can("agents.manage");
  const q = usePayeeApprovals(m.id);
  const titles = useSignalTitles();
  const dir = useDirectory();
  const { me, names } = useDeciderNames();
  const [withdrawn, setWithdrawn] = useState<Outcome | null>(null);
  // A server without Payee approvals has nothing to list, and no panel.
  if (q.data === null) return null;
  const approvals = q.data?.approvals ?? [];
  return (
    <Panel title="Payee decisions" description="Who approved or denied a Payee of this Budget, and when" bodyClassName="p-0 sm:p-0">
      {withdrawn && <OutcomeNotice outcome={withdrawn} onDismiss={() => setWithdrawn(null)} className="m-4 sm:mx-5" />}
      {q.isPending ? (
        <p role="status" className="flex items-center gap-1.5 px-4 py-4 text-sm text-muted-foreground sm:px-5">
          <Loader2 aria-hidden className="size-3.5 animate-spin" /> Reading the decisions.
        </p>
      ) : q.isError ? (
        <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
      ) : approvals.length === 0 ? (
        <EmptyState className="py-8" icon={<ShieldCheck className="size-4" />} title="No decisions yet">
          When the Payee check has a warning about a Payee, the agent&apos;s Call waits for an owner. Each decision is listed here with who made it.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {approvals.map((a) => {
            const d = DECISION[a.decision === "deny" ? "deny" : a.overrideBlock ? "override" : "approve"];
            const name = dir.lookup(a.payee)?.name ?? null;
            return (
              <li key={a.payee} data-decision={a.payee} className="px-4 py-3.5 text-sm sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <PayeeVerdictMark verdict={d.tone} className="text-sm">
                    {d.label}
                  </PayeeVerdictMark>
                  <span className="text-xs text-muted-foreground">
                    by {deciderText(a.decidedBy, me, names)}, <TimeAgo iso={a.decidedAt} />
                  </span>
                </div>
                <AccountId value={a.payee} name={name} mode="wrap" className="mt-1" />
                {a.signals && a.signals.length > 0 && <p className="mt-1.5 text-xs text-muted-foreground">Saw: {a.signals.map((id) => titles[id] ?? id.replaceAll("_", " ")).join(", ")}.</p>}
                {a.signals === null && <p className="mt-1.5 text-xs text-muted-foreground">Decided while the Payee check was off, so it covers any warning.</p>}
                {a.note && (
                  <figure className="mt-1.5 border-l-2 border-border pl-3">
                    <figcaption className="text-xs text-muted-foreground">Note</figcaption>
                    <blockquote className="text-sm [overflow-wrap:anywhere]">{a.note}</blockquote>
                  </figure>
                )}
                {manage && (
                  <div className="mt-2.5">
                    <WithdrawButton m={m} approval={a} onWithdrawn={(gone) => setWithdrawn({ title: "Decision withdrawn", body: "The Payee is judged by the Payee check alone again. If the check has a warning, the agent's next Call to it waits for an owner.", payee: gone.payee })} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
