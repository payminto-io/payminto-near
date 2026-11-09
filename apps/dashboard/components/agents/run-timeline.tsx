"use client";

/**
 * A run's steps, oldest first (docs/AGENTS.md section 7): model turns with their token counts, tool calls with their
 * input and a short result, retries with when the next try starts, and the end. Built by `timelineSteps`, so a tool
 * call waiting for its result shows as in progress. Also the answer block and the run history list.
 */
import Link from "next/link";
import { AlertTriangle, Check, Clock3, CornerDownRight, Loader2, Play, RotateCw, Sparkles, Square, Wrench } from "lucide-react";
import { RUN_STATUS, TRIGGER_LABEL, formatTokens, isTerminal, runTokens, timelineSteps, type TimelineStep } from "@/lib/agents";
import { compactTokens } from "@/lib/agents";
import { formatDateTime, formatInt } from "@/lib/format";
import type { AgentRun, AgentRunEvent, AgentRunStatus } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { TimeAgo, useNow } from "@/components/app/time-ago";
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
