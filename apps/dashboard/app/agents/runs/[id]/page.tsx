"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCw, Square } from "lucide-react";
import { toHex } from "@payminto/protocol";
import { useApi } from "@/lib/session";
import { ak, useAgent, useAgentAccess, useAiConnections, useAiProviders, useBusinessId, useFollowRun } from "@/lib/agents-queries";
import { TRIGGER_LABEL, canCancel, canRunAgain, isTerminal, providerName, runErrorText, whoAnswers } from "@/lib/agents";
import { formatDateTime, formatInt } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-title";
import type { AgentRun } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState, RequirePermission } from "@/components/app/states";
import { TimeAgo, useNow } from "@/components/app/time-ago";
import { ModelId, OpenABusiness, ProblemNote, RunStatusChip } from "@/components/agents/parts";
import { RunAnswer, RunTimeline, RunTokens } from "@/components/agents/run-timeline";

function duration(run: AgentRun, now: number): string | null {
  if (!run.started_at) return null;
  const end = run.finished_at ? new Date(run.finished_at).getTime() : now;
  const s = Math.max(0, Math.round((end - new Date(run.started_at).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

function RunPage({ id }: { id: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const access = useAgentAccess();
  const follow = useFollowRun(id);
  const run = follow.run;
  const agent = useAgent(run?.agent_id ?? "");
  const connections = useAiConnections();
  const providers = useAiProviders();
  const now = useNow();
  useDocumentTitle(agent.data ? `Run of ${agent.data.name}` : null);

  const cancel = useMutation({
    mutationFn: () => api.agents.cancelRun(id),
    onSuccess: (r) => {
      follow.adopt(r);
      follow.nudge();
      toast.success("Cancel requested. The agent stops at its next step.");
    },
    onError: (e) => toast.error(e.message),
  });
  const again = useMutation({
    mutationFn: (r: AgentRun) => api.agents.startRun(r.agent_id, r.input ?? "", toHex(crypto.getRandomValues(new Uint8Array(16)))),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ak.all });
      router.push(`/agents/runs/${r.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!run) {
    if (follow.error) return <ErrorState error={follow.error} onRetry={follow.done ? undefined : follow.nudge} />;
    return <BlockSkeleton className="h-96" />;
  }

  const a = agent.data;
  const conn = connections.data?.find((c) => c.id === a?.connection_id);
  const provider = run.usage?.provider ?? conn?.provider ?? null;
  const who = whoAnswers(provider, providers.data, conn?.label);
  const problem = runErrorText(run, { provider, providers: providers.data, connectionLabel: conn?.label, timeoutSeconds: a?.limits.timeout_seconds });
  const working = !isTerminal(run.status);
  const back = a ? { href: `/agents/${a.id}`, label: a.name } : { href: "/agents", label: "AI agents" };

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Run <RunStatusChip status={run.status} />
          </span>
        }
        description={run.input ? <span className="line-clamp-3">“{run.input}”</span> : undefined}
        actions={
          access.run && (
            <>
              {canCancel(run) && (
                <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  <Square /> Cancel
                </Button>
              )}
              {run.cancel_requested && working && <span className="text-sm text-muted-foreground">Stopping at the next step...</span>}
              {canRunAgain(run) && a && a.status === "paused" && <span className="text-sm text-muted-foreground">Resume {a.name} to run this again.</span>}
              {canRunAgain(run) && a && a.status === "active" && (
                <Button disabled={again.isPending} onClick={() => again.mutate(run)}>
                  <RotateCw /> Run again
                </Button>
              )}
            </>
          )
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          {problem && <ProblemNote {...problem} />}
          {run.status === "queued" && run.next_attempt_at && new Date(run.next_attempt_at).getTime() > now && (
            <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              {who} asked Payminto to slow down. Try {run.attempt + 1} of {run.max_attempts} starts <TimeAgo iso={run.next_attempt_at} />
            </p>
          )}
          {(run.result?.answer || run.status === "succeeded") && (
            <Panel title="Answer">
              {run.result?.answer ? <RunAnswer run={run} /> : <p className="text-sm text-muted-foreground">The agent finished without a written answer.</p>}
            </Panel>
          )}
          <Panel
            title="Steps"
            actions={
              working && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-positive motion-reduce:animate-none" /> Updating as it works
                </span>
              )
            }
          >
            <RunTimeline events={follow.events} status={run.status} />
            {follow.error !== null && !follow.done && <p className="mt-3 text-xs text-warning">Lost contact with the server; trying again.</p>}
          </Panel>
        </div>

        <Panel title="Details" className="xl:self-start">
          <Fields className="sm:[&>div]:grid-cols-[6.5rem_minmax(0,1fr)]">
            <Field label="Agent">{a ? <Link href={`/agents/${a.id}`} className="font-medium hover:underline">{a.name}</Link> : <span className="hash text-[0.8125rem]">{run.agent_id}</span>}</Field>
            <Field label="Started from">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</Field>
            <Field label="Model">
              {run.usage?.model || a?.model ? <ModelId id={(run.usage?.model || a?.model)!} /> : <span className="text-subtle">-</span>}
              {provider && <span className="block text-xs text-muted-foreground">{conn ? `${conn.label} · ${providerName(provider, providers.data)}` : providerName(provider, providers.data)}</span>}
            </Field>
            <Field label="Tokens" hint="Billed by your AI provider to your own account.">
              <RunTokens run={run} events={follow.events} />
            </Field>
            <Field label="Tries" hint="A busy or rate-limited provider is tried again, up to the limit.">
              <span className="num">
                {formatInt(Math.max(1, run.attempt))} of {formatInt(run.max_attempts)}
              </span>
            </Field>
            <Field label="Queued">
              <span title={formatDateTime(run.created_at)}>{formatDateTime(run.created_at)}</span>
            </Field>
            {run.started_at && <Field label="Took">{duration(run, now)}{working && " so far"}</Field>}
            {run.finished_at && <Field label="Finished">{formatDateTime(run.finished_at)}</Field>}
            <Field label="Run id">
              <span className="hash text-[0.8125rem] break-all">{run.id}</span>
            </Field>
          </Fields>
        </Panel>
      </div>
    </>
  );
}

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const b = useBusinessId();
  if (!b) return <OpenABusiness what="AI agent runs" />;
  return (
    <RequirePermission permission="payments.read">
      <RunPage id={id} />
    </RequirePermission>
  );
}
