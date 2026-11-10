"use client";

/**
 * Warnings for whoever runs the server: `operator.alert` events from the live stream, and problems in the server's
 * standing on the hub (its receipt key and its prepaid storage). Each one says what happened and what to do. The shell
 * shows one line that leads to Home, where the full warnings are.
 */
import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, TriangleAlert, X } from "lucide-react";
import { useLive } from "@/lib/live";
import { useCan } from "@/lib/session";
import { operatorAlerts, type AlertFact, type OperatorAlertView } from "@/lib/operator-alerts";
import { useHubReadiness } from "@/lib/use-hub-readiness";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AccountSentence, AccountText } from "@/components/ds/account-id";
import { CopyButton, Money } from "./primitives";

/**
 * Which alerts the operator dismissed, for as long as the console stays open. One store for the strip in the shell and
 * the warnings on the page, so dismissing an alert clears it from both.
 */
let dismissedIds: ReadonlySet<string> = new Set();
const dismissListeners = new Set<() => void>();
const subscribeDismissed = (l: () => void) => {
  dismissListeners.add(l);
  return () => void dismissListeners.delete(l);
};
const readDismissed = () => dismissedIds;
function dismissAlert(id: string) {
  dismissedIds = new Set(dismissedIds).add(id);
  for (const l of dismissListeners) l();
}

/** Operator alerts from the live stream, for people who run the server. Empty for everyone else. */
function useOperatorAlerts(): OperatorAlertView[] {
  const { events } = useLive();
  const can = useCan();
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, readDismissed);
  const allowed = can("platform.read") || can("agents.manage");
  return useMemo(() => (allowed ? operatorAlerts(events, dismissed) : []), [allowed, events, dismissed]);
}

function Fact({ fact }: { fact: AlertFact }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 @[34rem]:grid @[34rem]:grid-cols-[10rem_minmax(0,1fr)] @[34rem]:gap-3">
      <dt className="text-muted-foreground">{fact.label}</dt>
      <dd className="min-w-0">
        {fact.as === "amount" ? (
          <Money atomic={fact.value} size="sm" />
        ) : fact.as === "account" ? (
          <AccountText value={fact.value} className="text-xs" />
        ) : fact.as === "id" ? (
          <span className="flex min-w-0 items-start gap-1">
            <span className="min-w-0 font-mono text-xs leading-4 [overflow-wrap:anywhere]">{fact.value}</span>
            <CopyButton value={fact.value} label={fact.label.toLowerCase()} className="-mt-1" />
          </span>
        ) : (
          fact.value
        )}
      </dd>
    </div>
  );
}

/** One warning: what happened, what to do, and the figures that identify it. */
function Warning({ title, happened, todo, facts = [], time, onDismiss }: { title: string; happened: string; todo: string; facts?: AlertFact[]; time?: string; onDismiss?: () => void }) {
  return (
    <li className="@container flex items-start gap-3 px-4 py-4 sm:px-5">
      <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning">
        <TriangleAlert className="size-4" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1 text-pretty text-muted-foreground">
          <AccountSentence>{happened}</AccountSentence>
        </p>
        <p className="mt-2 text-pretty">
          <span className="font-medium">What to do: </span>
          <AccountSentence>{todo}</AccountSentence>
        </p>
        {facts.length > 0 && (
          <dl className="mt-3 grid gap-2 border-t pt-3 text-xs">
            {facts.map((f) => (
              <Fact key={f.label} fact={f} />
            ))}
          </dl>
        )}
        {time && <p className="mt-2 font-mono text-xs text-muted-foreground">Raised {formatDateTime(time)}</p>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss: ${title}`}
          className="-mt-1.5 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground sm:size-8 sm:-mt-1 sm:-mr-1"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </li>
  );
}

/**
 * The full warnings, on Home and on Settings, Network. Renders nothing while there is nothing to resolve, and nothing
 * while the hub cannot be read: no warning is raised on a guess.
 */
export function OperatorWarnings({ className }: { className?: string }) {
  const alerts = useOperatorAlerts();
  const readiness = useHubReadiness();
  const count = alerts.length + readiness.problems.length;
  if (count === 0) return null;
  return (
    <section id="operator-warnings" aria-labelledby="operator-warnings-title" className={cn("scroll-mt-24 overflow-hidden rounded-xl border border-warning/40 bg-card", className)}>
      <div className="border-b border-warning/30 bg-warning-soft px-4 py-2.5 sm:px-5">
        <h2 id="operator-warnings-title" className="text-sm font-semibold text-warning">
          {count === 1 ? "1 thing needs the operator" : `${count} things need the operator`}
        </h2>
      </div>
      <ul className="divide-y" role="list">
        {alerts.map((a) => (
          <Warning key={a.id} title={a.title} happened={a.happened} todo={a.todo} facts={a.facts} time={a.at} onDismiss={() => dismissAlert(a.id)} />
        ))}
        {readiness.problems.map((p) => (
          <Warning key={p.check} title={p.title} happened={p.happened} todo={p.todo} />
        ))}
      </ul>
    </section>
  );
}

/** One line under the header on every screen while something needs the operator, leading to the full warnings. */
export function OperatorWarningStrip() {
  const alerts = useOperatorAlerts();
  const readiness = useHubReadiness();
  const titles = [...alerts.map((a) => a.title), ...readiness.problems.map((p) => p.title)];
  if (titles.length === 0) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning-soft px-4 py-1.5 text-xs font-medium text-warning sm:px-6">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 text-pretty">
          {titles[0]}
          {titles.length > 1 ? `, and ${titles.length - 1} more` : ""}
        </span>
      </span>
      <Link href="/#operator-warnings" className="inline-flex items-center gap-1 rounded underline underline-offset-2 hover:no-underline">
        See what to do <ArrowRight className="size-3" aria-hidden />
      </Link>
    </div>
  );
}
