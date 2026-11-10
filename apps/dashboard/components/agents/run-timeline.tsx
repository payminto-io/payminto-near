"use client";

/**
 * A run's steps, oldest first (docs/AGENTS.md section 7): model turns with their token counts, tool calls with their
 * input and a short result, retries with when the next try starts, and the end. Built by `timelineSteps`, so a tool
 * call waiting for its result shows as in progress. Also the answer block and the run history list.
 */
import { useId, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ChevronDown, Clock3, CornerDownRight, Loader2, Play, RotateCw, ShieldAlert, ShieldCheck, ShieldHalf, ShieldOff, ShieldQuestion, Sparkles, Square, Wrench } from "lucide-react";
import { ATTESTATION_LIMIT, RUN_STATUS, TRIGGER_LABEL, attestationView, formatTokens, isTerminal, runTokens, splitIds, timelineSteps, type AttestationState, type StepAttestation, type TimelineStep } from "@/lib/agents";
import { compactTokens } from "@/lib/agents";
import { formatDateTime, formatInt } from "@/lib/format";
import type { AgentRun, AgentRunEvent, AgentRunStatus } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { TimeAgo, useNow } from "@/components/app/time-ago";
import { AccountText } from "@/components/ds/account-id";
import { CopyButton } from "@/components/ds/actions";
import { RunStatusChip } from "@/components/agents/parts";

type Tone = "positive" | "negative" | "warning" | "info" | "neutral";
const DOT: Record<Tone, string> = {
  positive: "bg-positive-soft text-positive",
  negative: "bg-negative-soft text-negative",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-primary",
  neutral: "bg-muted text-muted-foreground",
};

/** Tool input as short `key: value` pairs; the full JSON stays in the tooltip. */
function inputLine(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const parts = Object.entries(input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? parts.join(", ") : null;
}

function modelTitle(s: Extract<TimelineStep, { kind: "model" }>): string {
  if (s.stop === "tool_use") return "Decided what to look at";
  if (s.stop === "end") return "Wrote the answer";
  if (s.stop === "max_tokens") return "Stopped at the output limit";
  if (s.stop === "refusal") return "Declined to answer";
  return "Model reply";
}

// ---------------------------------------------------------------------------
// Enclave attestation of a model turn (NEAR AI Cloud). Rules: docs/design-system/components/Attestation/README.md
// ---------------------------------------------------------------------------

const ATTESTATION_ICON: Record<AttestationState, typeof ShieldCheck> = { verified: ShieldCheck, partial: ShieldHalf, failed: ShieldAlert, unavailable: ShieldQuestion, none: ShieldOff };
/**
 * The result's ink and its shield's. Green is kept for a result where every check passed and red for one where a check
 * failed; a partial result is plain text on a quiet ground. Missing evidence is plain text too, with only its shield in
 * the warning colour, as ProofPanel draws a Proof it could not read.
 */
const ATTESTATION_SHIELD: Record<Tone, string> = { positive: "text-positive", negative: "text-negative", warning: "text-warning", info: "text-primary", neutral: "text-foreground" };
const attestationInk = (tone: Tone) => (tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-foreground");
const attestationGround = (tone: Tone) => (tone === "positive" ? "border-positive/30 bg-positive-soft/50" : tone === "negative" ? "border-negative/25 bg-negative-soft/60" : "bg-muted/40");

/** One label and value of the attestation details: stacked in a narrow panel, side by side from 28rem of panel width. */
function AttestationRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-0.5 @md:grid-cols-[7.5rem_minmax(0,1fr)] @md:gap-3">
      <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[0.8125rem] leading-5">{children}</dd>
    </div>
  );
}

/** A key or hash on one line: the middle gives way when space runs out, the end never does, and copy takes all of it. */
function AttestationId({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1" title={hint}>
      <AccountText value={value} className="text-[0.8125rem] leading-5 tracking-[-0.01em]" />
      <CopyButton value={value} label={label} />
    </span>
  );
}

function AttestationList({ items, marker }: { items: string[]; marker: string }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((t) => (
        <li key={t} className="flex gap-2">
          <span aria-hidden className={cn("mt-2 size-1 shrink-0 rounded-full", marker)} />
          <span className="min-w-0">{t}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the node could check about the enclave that answered one model turn: the verdict in a word, what it means in
 * plain sentences, what to do when something is wrong, and the evidence (who signed, what was not checked, the hashes
 * the signature covers). A partial result is the normal one and is never drawn as a green "verified". Nothing here
 * speaks about whether the answer is right.
 */
function AttestationPanel({ a, defaultOpen }: { a: StepAttestation; defaultOpen: boolean }) {
  const v = attestationView(a);
  const Icon = ATTESTATION_ICON[v.state];
  const detailsId = useId();
  // A result that needs attention is never folded away; a normal one folds so a long run stays readable.
  const folds = v.state === "partial" || v.state === "verified";
  const [open, setOpen] = useState(defaultOpen);
  const shown = !folds || open;
  const signed = v.state !== "unavailable";
  return (
    <div role="group" aria-label="Enclave attestation" className={cn("@container mt-2 rounded-lg border px-3 py-2.5", attestationGround(v.tone))}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <p className={cn("flex items-center gap-1.5 text-sm font-medium", attestationInk(v.tone))}>
          <Icon aria-hidden className={cn("size-4 shrink-0", ATTESTATION_SHIELD[v.tone])} />
          {v.label}
        </p>
        <p className="text-xs text-subtle">Enclave attestation</p>
      </div>
      <p className="mt-1 text-[0.8125rem] leading-5 text-muted-foreground">{v.meaning}</p>
      {v.next && <p className="mt-1 text-[0.8125rem] leading-5">{v.next}</p>}
      {folds && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 mt-1 inline-flex min-h-7 items-center gap-1 rounded px-1 text-xs font-medium text-primary underline-offset-4 hover:underline pointer-coarse:-mt-1 pointer-coarse:-mb-2 pointer-coarse:min-h-11"
        >
          <ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-180")} />
          {open ? "Hide attestation details" : "Show attestation details"}
        </button>
      )}
      {shown && (
        <div id={detailsId} className={cn("border-t pt-2.5", folds ? "mt-1" : "mt-2.5")}>
          <dl className="grid gap-y-2.5">
            {v.problems.length > 0 && (
              <AttestationRow label="Did not pass">
                <AttestationList items={v.problems} marker="bg-negative" />
              </AttestationRow>
            )}
            {v.signer && (
              <AttestationRow label={v.signer.title}>
                {v.signer.who && <span className="block">{v.signer.who}</span>}
                <AttestationId value={v.signer.key} label="signing key" />
              </AttestationRow>
            )}
            {v.checked.length > 0 && (
              <AttestationRow label="Checked">
                <AttestationList items={v.checked} marker="bg-subtle" />
              </AttestationRow>
            )}
            {v.unchecked.length > 0 && (
              <AttestationRow label="Not checked">
                <AttestationList items={v.unchecked} marker="bg-subtle" />
                {v.uncheckedWhy && <p className="mt-1.5 text-xs leading-[1.125rem] text-muted-foreground">{v.uncheckedWhy}</p>}
              </AttestationRow>
            )}
            {signed && a.requestHash && (
              <AttestationRow label="Request hash">
                <AttestationId value={a.requestHash} label="request hash" hint="SHA-256 of the exact request your node sent" />
              </AttestationRow>
            )}
            {signed && a.responseHash && (
              <AttestationRow label="Answer hash">
                <AttestationId value={a.responseHash} label="answer hash" hint="SHA-256 of the exact answer your node received" />
              </AttestationRow>
            )}
            {v.nodeNote && (
              <AttestationRow label="Node's note">
                <span className="text-muted-foreground [overflow-wrap:anywhere]">
                  {splitIds(v.nodeNote).map((p, i) => (p.id ? <AccountText key={i} value={p.text} className="align-bottom text-[0.95em]" /> : p.text))}
                </span>
              </AttestationRow>
            )}
          </dl>
          {folds && <p className="mt-2.5 border-t pt-2 text-xs leading-[1.125rem] text-muted-foreground">{ATTESTATION_LIMIT}</p>}
        </div>
      )}
    </div>
  );
}

/** The attestation of a model turn on one line, for the short timeline under the ask box. The full sentence is in the title. */
function AttestationLine({ a }: { a: StepAttestation }) {
  const v = attestationView(a);
  const Icon = ATTESTATION_ICON[v.state];
  const who = v.signer?.who;
  return (
    <p className={cn("mt-1 flex items-start gap-1.5 text-xs font-medium", attestationInk(v.tone))} title={v.meaning}>
      <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", ATTESTATION_SHIELD[v.tone])} />
      <span className="min-w-0">
        {v.short}
        {who ? `, signed by ${who.charAt(0).toLowerCase()}${who.slice(1)}` : ""}
      </span>
    </p>
  );
}

/** A model turn that carries no attestation: said once, quietly, with where an attestation comes from. */
function NoAttestation() {
  const v = attestationView(null);
  const Icon = ATTESTATION_ICON.none;
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs leading-[1.125rem] text-muted-foreground">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-subtle" />
      <span className="min-w-0">
        <span className="font-medium">{v.label}.</span> {v.meaning}
      </span>
    </p>
  );
}

function Row({ icon, tone, title, meta, last, children }: { icon: React.ReactNode; tone: Tone; title: React.ReactNode; meta?: React.ReactNode; last: boolean; children?: React.ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute top-5 bottom-0 left-[9px] w-px bg-border" />}
      <span className={cn("relative mt-0.5 flex size-[1.1875rem] shrink-0 items-center justify-center rounded-full [&_svg]:size-3", DOT[tone])}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-sm font-medium">{title}</p>
          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
        </div>
        {children}
      </div>
    </li>
  );
}

function At({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className="num">
      {formatDateTime(iso).slice(-8)}
    </time>
  );
}

export function RunTimeline({ events, status, compact = false }: { events: readonly AgentRunEvent[]; status: AgentRunStatus | null; compact?: boolean }) {
  const steps = timelineSteps(events);
  const now = useNow();
  const working = status !== null && !isTerminal(status);
  if (steps.length === 0 && !working) return <p className="text-sm text-muted-foreground">No steps recorded.</p>;
  // The newest attested turn starts with its details open; earlier ones start folded.
  const lastAttested = steps.findLastIndex((s) => s.kind === "model" && s.attestation !== undefined);
  const rows = steps.map((s, i) => {
    const last = i === steps.length - 1 && !working;
    switch (s.kind) {
      case "started":
        return (
          <Row key={s.key} icon={<Play />} tone="info" title={s.attempt && s.attempt > 1 ? `Started try ${s.attempt}` : "Started"} meta={<At iso={s.at} />} last={last} />
        );
      case "model":
        return (
          <Row
            key={s.key}
            icon={<Sparkles />}
            tone="neutral"
            title={modelTitle(s)}
            meta={
              <>
                <span className="num">{formatInt(s.inputTokens)} in, {formatInt(s.outputTokens)} out</span> · <At iso={s.at} />
              </>
            }
            last={last}
          >
            {!compact && s.model && <p className="hash text-xs text-subtle">{s.model}</p>}
            {s.attestation ? compact ? <AttestationLine a={s.attestation} /> : <AttestationPanel a={s.attestation} defaultOpen={i === lastAttested} /> : !compact && <NoAttestation />}
          </Row>
        );
      case "tool": {
        const line = inputLine(s.input);
        // A call without a result is in progress while the run works; once it ended, the call was cut short.
        const pending = !s.done && working;
        return (
          <Row
            key={s.key}
            icon={s.isError ? <AlertTriangle /> : pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Wrench />}
            tone={s.isError ? "negative" : s.done ? "positive" : pending ? "info" : "neutral"}
            title={s.label}
            meta={<At iso={s.at} />}
            last={last}
          >
            {line && (
              <p className="hash mt-0.5 truncate text-xs text-muted-foreground" title={JSON.stringify(s.input, null, 2)}>
                {line}
              </p>
            )}
            {s.done ? (
              s.result && (
                <p className={cn("mt-1 flex gap-1.5 text-sm", s.isError ? "text-negative" : "text-muted-foreground")}>
                  <CornerDownRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 break-words">{s.result}</span>
                </p>
              )
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">{pending ? "Waiting for the result..." : "The run ended before this step finished."}</p>
            )}
          </Row>
        );
      }
      case "retry":
        return (
          <Row key={s.key} icon={<RotateCw />} tone="warning" title={s.code === "MODEL_RATE_LIMITED" ? "Provider is limiting requests" : s.code === "MODEL_OVERLOADED" ? "Provider was busy" : "Will try again"} meta={<At iso={s.at} />} last={last}>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {s.nextAt ? (
                <>
                  Next try at <At iso={s.nextAt} />
                  {working && new Date(s.nextAt).getTime() > now && (
                    <>
                      {" "}
                      (<TimeAgo iso={s.nextAt} />)
                    </>
                  )}
                </>
              ) : (
                "Trying again shortly"
              )}
              {s.message && <span className="block break-words">{s.message}</span>}
            </p>
          </Row>
        );
      case "finished": {
        const st = (s.status && s.status in RUN_STATUS ? s.status : null) as AgentRunStatus | null;
        const tone: Tone = st === "succeeded" ? "positive" : st === "failed" ? "negative" : st === "timed_out" ? "warning" : "neutral";
        return <Row key={s.key} icon={st === "succeeded" ? <Check strokeWidth={3} /> : st === "cancelled" ? <Square /> : st === "timed_out" ? <Clock3 /> : <AlertTriangle />} tone={tone} title={st ? RUN_STATUS[st].label : "Finished"} meta={<At iso={s.at} />} last={last} />;
      }
      default:
        return <Row key={s.key} icon={<Check />} tone="neutral" title={s.type.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase())} meta={<At iso={s.at} />} last={last} />;
    }
  });
  return (
    <ol className="relative" aria-live="polite">
      {rows}
      {working && (
        <li className="relative flex gap-3">
          <span className="relative mt-0.5 flex size-[1.1875rem] shrink-0 items-center justify-center rounded-full bg-info-soft text-primary">
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground">{status === "queued" ? "Waiting for a free worker..." : "Working..."}</p>
        </li>
      )}
    </ol>
  );
}

/** The answer as written, keeping its line breaks. */
export function RunAnswer({ run }: { run: AgentRun }) {
  const answer = run.result?.answer;
  if (!answer) return null;
  return <div className="text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap">{answer}</div>;
}

/** Tokens a run used so far, "4,250 in, 278 out". */
export function RunTokens({ run, events }: { run: AgentRun; events: readonly AgentRunEvent[] }) {
  const t = runTokens(run, events);
  if (!t.input && !t.output) return <span className="text-subtle">-</span>;
  return (
    <span className="num" title={`${formatTokens(t.input + t.output)} in all`}>
      {formatInt(t.input)} in, {formatInt(t.output)} out
    </span>
  );
}

/** Run history rows, newest first. */
export function RunHistory({ runs, emptyText }: { runs: AgentRun[]; emptyText: string }) {
  if (runs.length === 0) return <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">{emptyText}</p>;
  return (
    <ul className="stagger divide-y">
      {runs.map((r) => {
        const tokens = r.usage ? r.usage.input_tokens + r.usage.output_tokens : 0;
        return (
          <li key={r.id} className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 md:grid-cols-[6.5rem_minmax(0,1fr)_6rem_5rem_6.5rem]">
            <span className="max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end">
              <RunStatusChip status={r.status} />
            </span>
            <Link href={`/agents/runs/${r.id}`} className="min-w-0 truncate after:absolute after:inset-0 hover:underline max-md:col-start-1 max-md:row-start-1" title={r.input ?? undefined}>
              {r.input || <span className="text-muted-foreground">No input</span>}
            </Link>
            <span className="text-xs text-muted-foreground max-md:hidden">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
            <span className="num text-xs text-muted-foreground max-md:hidden">{tokens ? `${compactTokens(tokens)} tokens` : "-"}</span>
            <span className="text-xs text-muted-foreground md:text-right max-md:col-start-1 max-md:row-start-2">
              <TimeAgo iso={r.created_at} />
              <span className="md:hidden"> · {TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
