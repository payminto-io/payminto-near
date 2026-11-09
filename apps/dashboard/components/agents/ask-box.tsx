"use client";

/**
 * The "Ask" box on a back-office agent's page (docs/AGENTS.md section 7): starts a run and shows its steps and the
 * answer as they arrive, through the same follower as the run page.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUp } from "lucide-react";
import { toHex } from "viem";
import { useApi } from "@/lib/session";
import { ak, useBusinessId, useFollowRun } from "@/lib/agents-queries";
import { runErrorText } from "@/lib/agents";
import type { Agent, AiProvider } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/app/primitives";
import { ProblemNote, RunStatusChip } from "@/components/agents/parts";
import { RunAnswer, RunTimeline } from "@/components/agents/run-timeline";

const EXAMPLES = ["How much did we earn this week?", "Are any refunds waiting?", "Make a payment link for the 49 USDC starter kit", "Who is blocked right now?"];

export function AskBox({ agent, provider, connectionLabel, providers, blocked }: { agent: Agent; provider: string | null; connectionLabel?: string | null; providers?: AiProvider[] | null; blocked: string | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const b = useBusinessId();
  const [input, setInput] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const follow = useFollowRun(runId);
  const start = useMutation({
    mutationFn: (text: string) => api.agents.startRun(agent.id, text, toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2)),
    onSuccess: (run) => {
      setRunId(run.id);
      setInput("");
      void qc.invalidateQueries({ queryKey: ak.runs(b, { agent_id: agent.id, limit: 25 }) });
    },
  });
  const run = follow.run && follow.run.id === runId ? follow.run : null;
  const busy = start.isPending || Boolean(run && !follow.done && (run.status === "queued" || run.status === "running"));
  const problem = run ? runErrorText(run, { provider: run.usage?.provider ?? provider, providers, connectionLabel, timeoutSeconds: agent.limits.timeout_seconds }) : null;

  const submit = () => {
    const text = input.trim();
    if (text && !busy && !blocked) start.mutate(text);
  };

  return (
    <Panel title="Ask" description="Ask about payments, links, refunds and blocked payers. It reads this business's data and answers in plain words.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <div className="relative">
          <Textarea
            aria-label={`Ask ${agent.name}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            maxLength={4000}
            disabled={Boolean(blocked)}
            placeholder={blocked ?? "How much did we earn this week, and are any refunds waiting?"}
            className="resize-none pr-14"
          />
          <Button type="submit" size="icon-sm" aria-label="Ask" disabled={!input.trim() || busy || Boolean(blocked)} className="absolute right-2 bottom-2">
            <ArrowUp />
          </Button>
        </div>
        {!blocked && !run && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Examples">
            {EXAMPLES.map((q) => (
              <button key={q} type="button" onClick={() => setInput(q)} className="h-7 rounded-full border bg-background px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2">
                {q}
              </button>
            ))}
          </div>
        )}
        {start.isError && <ProblemNote title="The question was not sent." action={start.error.message} />}
      </form>

      {run && (
        <div className="mt-5 border-t pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium" title={run.input ?? undefined}>
              {run.input}
            </p>
            <div className="flex items-center gap-2">
              <RunStatusChip status={run.status} />
              <Button asChild variant="ghost" size="sm">
                <Link href={`/agents/runs/${run.id}`}>
                  Open run <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
          {run.result?.answer && (
            <div className="mb-5 rounded-lg border bg-muted/30 p-4">
              <RunAnswer run={run} />
            </div>
          )}
          {problem && <ProblemNote className="mb-5" {...problem} />}
          <RunTimeline events={follow.events} status={run.status} compact />
        </div>
      )}
    </Panel>
  );
}
