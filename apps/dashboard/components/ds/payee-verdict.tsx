import type { ReactNode } from "react";
import { ArrowRight, ChevronRight, ShieldBan, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReportView, SignalView, VerdictKind, VerdictView } from "@payminto/payee-check";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AccountSentence, AccountText } from "./account-id";

/** Each verdict has its own icon and its own words, so it never rests on colour alone. */
export const VERDICT_TONE: Record<VerdictKind, { Icon: LucideIcon; soft: string; text: string }> = {
  allow: { Icon: ShieldCheck, soft: "bg-positive-soft text-positive", text: "text-positive" },
  warn: { Icon: TriangleAlert, soft: "bg-warning-soft text-warning", text: "text-warning" },
  block: { Icon: ShieldBan, soft: "bg-negative-soft text-negative", text: "text-negative" },
};

const WEIGHT: Record<SignalView["severity"], { label: string; className: string }> = {
  block: { label: "Blocks", className: "bg-negative-soft text-negative" },
  warn: { label: "Ask first", className: "bg-warning-soft text-warning" },
  info: { label: "Note", className: "bg-muted text-muted-foreground" },
};

/** More notes than this are folded away, so the reasons that decide the verdict stay on screen. */
const NOTES_SHOWN = 3;

/** A named account with at least one dot, or a 64 character implicit account: text that must stay on one line. */
const ACCOUNT_LIKE = /^(?=.{2,64}$)(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)+$|^[0-9a-f]{64}$/;

/** The account ids a verdict names: the Payee, and any account among the values behind its signals. */
export function accountsNamed(view: VerdictView): string[] {
  const found = new Set<string>();
  if (ACCOUNT_LIKE.test(view.payee)) found.add(view.payee);
  for (const s of view.signals) for (const f of s.facts) for (const part of f.value.split(", ")) if (ACCOUNT_LIKE.test(part)) found.add(part);
  for (const r of view.reports) if (ACCOUNT_LIKE.test(r.reporter)) found.add(r.reporter);
  return [...found].sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A sentence from the check, as text. Every account id in it is set on one line, so it is never broken at "-" or ".".
 * The words are never parsed as markup.
 */
export function VerdictWords({ children, accounts }: { children: string; accounts: readonly string[] }) {
  // The accounts the verdict names, any implicit account (64 hex characters, such as the settlement token), which is
  // truncated in the middle rather than pushing a phone screen sideways, and any date such as 2026-11-07, which must
  // not break at its hyphens either.
  const whole = new RegExp(`${accounts.length ? `(?<![\\w.-])(?:${accounts.map(escapeRe).join("|")})(?![\\w-]|\\.[a-z0-9])|` : ""}(?<![\\w-])[0-9a-f]{64}(?![\\w-])|(?<![\\w-])\\d{4}-\\d{2}-\\d{2}(?![\\w-])`, "g");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of children.matchAll(whole)) {
    if (m.index > last) parts.push(<AccountSentence key={`t${last}`}>{children.slice(last, m.index)}</AccountSentence>);
    if (/^\d{4}-\d{2}-\d{2}$/.test(m[0]) && !accounts.includes(m[0])) {
      parts.push(
        <span key={`d${m.index}`} className="whitespace-nowrap">
          {m[0]}
        </span>,
      );
    } else {
      // A comma or full stop right after an account stays on its line, rather than starting the next one.
      const stop = /^[,.;:]/.exec(children.slice(m.index + m[0].length))?.[0] ?? "";
      parts.push(
        <span key={`a${m.index}`} className="inline-flex max-w-full min-w-0 items-baseline align-bottom">
          <AccountText value={m[0]} className="text-[0.95em] text-foreground" />
          {stop}
        </span>,
      );
      last = m.index + m[0].length + stop.length;
      continue;
    }
    last = m.index + m[0].length;
  }
  if (last < children.length) parts.push(<AccountSentence key={`t${last}`}>{children.slice(last)}</AccountSentence>);
  return <>{parts}</>;
}

const Words = VerdictWords;

function Time({ iso }: { iso: string }) {
  if (Number.isNaN(Date.parse(iso))) return <span>at an unknown time</span>;
  return (
    <time dateTime={iso} title={iso} className="hash whitespace-nowrap">
      {formatDateTime(iso)}
    </time>
  );
}

function SignalItem({ signal, accounts }: { signal: SignalView; accounts: readonly string[] }) {
  const w = WEIGHT[signal.severity];
  const quiet = signal.severity === "info";
  return (
    <li data-signal={signal.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap", w.className)}>
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {w.label}
        </span>
        <span className={cn("font-medium", quiet ? "text-xs" : "text-sm")}>{signal.title}</span>
      </div>
      <p className={cn("mt-0.5 [overflow-wrap:anywhere] text-muted-foreground", quiet ? "text-xs" : "text-sm")}>
        <Words accounts={accounts}>{signal.reason}</Words>
      </p>
    </li>
  );
}

/**
 * A report is a claim by a third party. Its words are shown as a quote and its evidence as a line of text, and nothing
 * in it is ever markup or a link: a person who wants to follow the evidence copies it, knowing whose claim it is.
 */
function ReportItem({ report }: { report: ReportView }) {
  const label = report.evidence.label === "Link" ? "Link, as text" : report.evidence.label;
  return (
    <li>
      <figure className="border-l-2 border-border pl-3">
        <blockquote className="text-sm [overflow-wrap:anywhere] text-foreground">{report.quote}</blockquote>
        <figcaption className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span>Claimed by</span>
          <AccountText value={report.reporter} className="text-[0.75rem] text-foreground" />
          <span>
            on <Time iso={report.at} />
          </span>
          <span className="min-w-0 basis-full [overflow-wrap:anywhere]">
            {label}: <span className="hash text-foreground">{report.evidence.text}</span>
          </span>
        </figcaption>
      </figure>
    </li>
  );
}

/**
 * The answer of the payee check, laid out like a Refusal: the verdict in words, why, what was not checked, and what
 * to do next. It shows what `toView(verdict)` from `@payminto/payee-check` says and adds no judgment of its own.
 * Reports are claims by third parties: they are quoted as text, never rendered as markup.
 */
export function PayeeVerdict({
  view,
  from,
  name,
  dense = false,
  showPayee = true,
  action,
  as: Tag = "div",
  className,
}: {
  view: VerdictView;
  /** Where the facts were read from, in words: an RPC host, or the demo wording. */
  from: string;
  /** A friendly name for the Payee, such as a provider's name. */
  name?: string | null;
  /** For a narrow column: the icon sits beside the headline and takes no column of its own. */
  dense?: boolean;
  /** False when the row around it already names the Payee. */
  showPayee?: boolean;
  /** What the person can do here, such as "Check again". */
  action?: ReactNode;
  as?: "li" | "div";
  className?: string;
}) {
  const tone = VERDICT_TONE[view.verdict];
  const accounts = accountsNamed(view);
  const weighty = view.signals.filter((s) => s.severity !== "info");
  const notes = view.signals.filter((s) => s.severity === "info");
  const isAccount = ACCOUNT_LIKE.test(view.payee);
  return (
    <Tag data-verdict={view.verdict} className={cn("flex gap-3", className)}>
      {!dense && (
        <span aria-hidden className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", tone.soft)}>
          <tone.Icon className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {dense && <tone.Icon aria-hidden className={cn("size-4 shrink-0", tone.text)} />}
          {view.headline}
        </p>
        {showPayee && (
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {name && <span className="font-medium text-foreground">{name}</span>}
            {isAccount ? <AccountText value={view.payee} className="text-[0.8125rem] text-foreground" /> : <span className="hash [overflow-wrap:anywhere] text-foreground">{view.payee}</span>}
            <span>{view.accountKind}</span>
          </p>
        )}
        <p className="mt-1 text-sm [overflow-wrap:anywhere] text-muted-foreground">
          <Words accounts={accounts}>{view.summary}</Words>
        </p>

        {weighty.length > 0 && (
          <ul aria-label="Reasons" className="mt-2.5 space-y-2.5">
            {weighty.map((s) => (
              <SignalItem key={s.id} signal={s} accounts={accounts} />
            ))}
          </ul>
        )}

        {view.reports.length > 0 && (
          <section className="mt-3">
            <p className="text-xs font-medium">Reports - claims by third parties, quoted as written</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Payminto did not verify them and does not open their evidence.</p>
            <ul className="mt-2 space-y-2.5">
              {view.reports.map((r) => (
                <ReportItem key={`${r.reporter} ${r.at}`} report={r} />
              ))}
            </ul>
          </section>
        )}

        {notes.length > NOTES_SHOWN ? (
          <details className="group mt-2.5">
            <summary className="flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="size-3.5 transition-transform duration-150 group-open:rotate-90" />
              {notes.length} notes that do not change the verdict
            </summary>
            <ul aria-label="Notes" className="mt-2 space-y-2">
              {notes.map((s) => (
                <SignalItem key={s.id} signal={s} accounts={accounts} />
              ))}
            </ul>
          </details>
        ) : (
          notes.length > 0 && (
            <ul aria-label="Notes" className="mt-2.5 space-y-2">
              {notes.map((s) => (
                <SignalItem key={s.id} signal={s} accounts={accounts} />
              ))}
            </ul>
          )
        )}

        {view.notChecked.length > 0 && (
          <div className="mt-2.5 text-xs">
            <p className="font-medium">Not checked</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground marker:text-subtle">
              {view.notChecked.map((n) => (
                <li key={n.id}>{n.label}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-foreground">
          <ArrowRight aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <Words accounts={accounts}>{view.nextStep}</Words>
          </span>
        </p>
        {action && <div className="mt-2.5 flex flex-wrap items-center gap-2">{action}</div>}
        <p className="mt-2.5 text-xs text-muted-foreground">
          Checked <Time iso={view.checkedAt} />, read from <span className="[overflow-wrap:anywhere]">{from}</span>. These are heuristics, not a guarantee.
        </p>
      </div>
    </Tag>
  );
}

/** The verdict in one line: its icon and its words. For a row that opens the full verdict on request. */
export function PayeeVerdictMark({ verdict, children, className }: { verdict: VerdictKind; children: ReactNode; className?: string }) {
  const tone = VERDICT_TONE[verdict];
  return (
    <span data-verdict={verdict} className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
      <tone.Icon aria-hidden className={cn("size-3.5 shrink-0", tone.text)} />
      {children}
    </span>
  );
}
