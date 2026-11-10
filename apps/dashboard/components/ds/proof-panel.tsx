import type { ReactNode } from "react";
import { Check, CircleAlert, CircleCheck, CircleDashed, CircleX, ExternalLink, HelpCircle, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * verified: every check passed. failed: a check ran and did not match. waiting: the Call is not settled yet.
 * checking: the browser is reading NEAR now. unreachable: NEAR could not be read, so nothing was proven either way.
 */
export type ProofVerdict = "verified" | "waiting" | "failed" | "checking" | "unreachable";
export type ProofCheckState = "pass" | "fail" | "pending" | "unknown";

const CHECK: Record<ProofCheckState, { icon: typeof Check; className: string; word: string }> = {
  pass: { icon: Check, className: "bg-positive text-white dark:text-background", word: "passed" },
  fail: { icon: X, className: "bg-negative text-white dark:text-background", word: "failed" },
  pending: { icon: CircleDashed, className: "bg-muted text-muted-foreground", word: "waiting" },
  unknown: { icon: HelpCircle, className: "bg-muted text-muted-foreground", word: "not checked" },
};

/**
 * Whether one Call is proven against the root stored on NEAR. Leads with the verdict, wraps every id, lists the checks
 * that earn the verdict and links the settlement transaction in the NEAR explorer with a 44px target. Verified shows
 * only when every check passed.
 */
export function ProofPanel({
  verdict,
  title,
  body,
  fields,
  checks,
  explorer,
  action,
}: {
  verdict: ProofVerdict;
  title: string;
  body: ReactNode;
  fields: Array<{ label: string; value: ReactNode }>;
  checks: Array<{ key: string; label: ReactNode; state: ProofCheckState; detail: ReactNode }>;
  explorer?: { href: string; label: string } | null;
  /** One next step under the verdict, such as "Read NEAR again". */
  action?: ReactNode;
}) {
  const Seal = verdict === "verified" ? CircleCheck : verdict === "failed" ? CircleX : verdict === "checking" ? LoaderCircle : verdict === "unreachable" ? CircleAlert : CircleDashed;
  return (
    <section
      aria-label="Proof"
      className={cn(
        "overflow-hidden rounded-xl border",
        verdict === "verified" ? "border-positive/30 bg-positive-soft" : verdict === "failed" ? "border-negative/30 bg-negative-soft" : "bg-card",
      )}
    >
      <div className="flex items-start gap-4 p-4 sm:p-5">
        <span
          aria-hidden
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full",
            verdict === "verified" ? "bg-positive text-white dark:text-background" : verdict === "failed" ? "bg-negative text-white dark:text-background" : verdict === "unreachable" ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground",
          )}
        >
          <Seal className={cn("size-6", verdict === "checking" && "animate-spin motion-reduce:animate-none")} strokeWidth={2.2} />
        </span>
        <div className="min-w-0">
          <h2 role="status" className={cn("text-xl leading-7 font-semibold tracking-[-0.015em]", verdict === "verified" ? "text-positive" : verdict === "failed" ? "text-negative" : "")}>
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
          {action && <div className="mt-2.5">{action}</div>}
        </div>
      </div>
      <div className="border-t border-current/10 bg-card px-4 pb-4 sm:px-5">
        <dl>
          {fields.map((f) => (
            <div key={f.label} className="flex flex-col gap-0.5 border-b py-2.5 sm:grid sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
              <dt className="text-xs text-muted-foreground sm:text-sm">{f.label}</dt>
              <dd className="min-w-0">{f.value}</dd>
            </div>
          ))}
        </dl>
        <ol className="flex flex-col gap-2.5 pt-3.5" aria-label="Checks">
          {checks.map((c) => {
            const s = CHECK[c.state];
            return (
              <li key={c.key} className="flex items-start gap-2.5">
                <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", s.className)}>
                  <s.icon className="size-3" strokeWidth={3} aria-hidden />
                </span>
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {c.label}
                    <span className="sr-only">: {s.word}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{c.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
          <span>Anyone can repeat this check.</span>
          {explorer && (
            <a href={explorer.href} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4">
              {explorer.label} <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
