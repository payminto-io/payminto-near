"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, Pause, Pencil, Play } from "lucide-react";
import { useApi } from "@/lib/session";
import { ak, useAgent, useAgentAccess, useAgentRuns, useAiConnections, useAiProviders, useAiUsage, useBusinessId } from "@/lib/agents-queries";
import { CONNECTION_STATUS, KIND_HINT, KIND_LABEL, OPS_TOOLS, formatTokens } from "@/lib/agents";
import { formatDate, formatInt } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-title";
import type { Agent, AiConnection, AiProvider } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, Fields, InfoTip, PageHeader, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState, RequirePermission, RowsSkeleton } from "@/components/app/states";
import { AgentStatusChip, ModelId, OpenABusiness, ProblemNote, ProviderBadge } from "@/components/agents/parts";
import { AskBox } from "@/components/agents/ask-box";
import { SkillPanel } from "@/components/agents/skill-panel";
import { RunHistory } from "@/components/agents/run-timeline";

function AgentPage({ id }: { id: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const b = useBusinessId();
  const access = useAgentAccess();
  const agent = useAgent(id);
  const connections = useAiConnections();
  const providers = useAiProviders();
  const usage = useAiUsage();
  const runs = useAgentRuns({ agent_id: id, limit: 25 });
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDocumentTitle(agent.data?.name);

  const setStatus = useMutation({
    mutationFn: (status: "active" | "paused") => api.agents.updateAgent(id, { status }),
    onSuccess: (a) => {
      qc.setQueryData(ak.agent(b, id), a);
      void qc.invalidateQueries({ queryKey: ak.agents(b) });
      toast.success(a.status === "paused" ? `${a.name} is paused. ${a.kind === "skill" ? "Buyers are refused before they pay." : "Nobody can start runs."}` : `${a.name} is active again.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.agents.deleteAgent(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ak.agents(b) });
      toast.success("Agent deleted. Its runs stay in the history.");
      router.push("/agents");
    },
    onError: (e) => toast.error(e.message),
  });

  if (agent.isPending) return <BlockSkeleton className="h-96" />;
  if (agent.isError) return <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />;
  const a = agent.data;
  const conn = connections.data?.find((c) => c.id === a.connection_id) ?? null;
  const used = usage.data?.agents.find((u) => u.agent_id === a.id);
  const paused = a.status === "paused";

  // Why this agent cannot run right now, in plain words, before anyone tries.
  const connProblem = connections.isSuccess
    ? !conn
      ? { title: "This agent has no AI connection.", action: access.manage ? "Edit the agent and pick one." : "Ask an Admin to pick one.", href: access.manage ? `/agents/${a.id}/edit` : undefined, hrefLabel: "Edit agent" }
      : conn.status === "invalid"
        ? { title: `The key for ${conn.label} was rejected.`, action: "Rotate it in Settings > AI models; this agent cannot run until then.", href: "/settings/ai", hrefLabel: "Open AI models" }
        : conn.status === "disabled"
          ? { title: `${conn.label} is turned off.`, action: "Turn it on in Settings > AI models, or edit the agent to use another connection.", href: "/settings/ai", hrefLabel: "Open AI models" }
          : null
    : null;
  const blocked = paused ? "This agent is paused. Resume it to ask it something." : connProblem ? connProblem.title : !access.run ? "Viewers can read runs but not start them." : null;

  return (
    <>
      <PageHeader
        back={{ href: "/agents", label: "AI agents" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.name} <AgentStatusChip status={a.status} />
          </span>
        }
        description={a.description ?? KIND_HINT[a.kind]}
        actions={
          access.manage && (
            <>
              <Button variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate(paused ? "active" : "paused")}>
                {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
              </Button>
              <Button asChild variant="outline">
                <Link href={`/agents/${a.id}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                    Delete agent
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          {connProblem && <ProblemNote {...connProblem} />}
          {a.kind === "skill" ? <SkillPanel agent={a} /> : <AskBox agent={a} provider={conn?.provider ?? null} connectionLabel={conn?.label} providers={providers.data} blocked={blocked} />}
          <Panel title="Run history" description="Every question and paid call, newest first." bodyClassName="p-0 sm:p-0">
            {runs.isPending ? (
              <RowsSkeleton className="px-5" rows={4} />
            ) : runs.isError ? (
              <ErrorState className="m-4" error={runs.error} onRetry={() => void runs.refetch()} />
            ) : (
              <RunHistory runs={runs.data.items} emptyText={a.kind === "skill" ? "No paid calls yet." : "No runs yet. Ask it something above."} />
            )}
          </Panel>
        </div>
        <Details agent={a} conn={conn} providers={providers.data} tokens={used ? used.input_tokens + used.output_tokens : null} runsThisMonth={used?.runs ?? null} />
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {a.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {a.kind === "skill" ? `Its address stops answering at once, and buyers can no longer pay for it. ` : ""}Its runs and their usage stay in the history. To stop it for a while instead, pause it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep agent</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                remove.mutate();
              }}
            >
              Delete agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Details({ agent: a, conn, providers, tokens, runsThisMonth }: { agent: Agent; conn: AiConnection | null; providers: AiProvider[] | undefined; tokens: number | null; runsThisMonth: number | null }) {
  const tools = (a.tools ?? []).map((t) => OPS_TOOLS.find((x) => x.name === t)?.label ?? t);
  return (
    <Panel title="Details" className="xl:self-start">
      <Fields className="sm:[&>div]:grid-cols-[6.5rem_minmax(0,1fr)]">
        <Field label="Kind">{KIND_LABEL[a.kind]}</Field>
        <Field label="Connection">
          {conn ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate">{conn.label}</span>
              <ProviderBadge provider={conn.provider} providers={providers} />
              {conn.status !== "active" && <span className="text-xs text-negative">{CONNECTION_STATUS[conn.status].label}</span>}
            </span>
          ) : (
            <span className="text-subtle">None</span>
          )}
        </Field>
        <Field label="Model">
          <ModelId id={a.model} />
        </Field>
        <Field label="This month">
          {tokens === null ? <span className="text-subtle">-</span> : formatTokens(tokens)}
          {runsThisMonth !== null && <span className="block text-xs text-muted-foreground">{formatInt(runsThisMonth)} {runsThisMonth === 1 ? "run" : "runs"}</span>}
        </Field>
        <Field label="Limits" hint="Per run: model steps, output tokens, and the time limit for each try.">
          <span className="num">
            {a.limits.max_turns} steps, {formatInt(a.limits.max_output_tokens)} tokens, {a.limits.timeout_seconds} s
          </span>
        </Field>
        {a.kind === "ops" && (
          <Field label="May">
            {tools.length ? (
              <ul className="flex flex-col gap-0.5">
                {tools.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : (
              <span className="text-subtle">Nothing</span>
            )}
          </Field>
        )}
        {a.instructions && (
          <Field label="Instructions">
            <span className="flex items-start gap-1">
              <span className="line-clamp-4 text-muted-foreground">{a.instructions}</span>
              <InfoTip label="Full instructions">{a.instructions}</InfoTip>
            </span>
          </Field>
        )}
        <Field label="Created">{formatDate(a.created_at)}</Field>
      </Fields>
    </Panel>
  );
}

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const b = useBusinessId();
  if (!b) return <OpenABusiness what="AI agents" />;
  return (
    <RequirePermission permission="payments.read">
      <AgentPage id={id} />
    </RequirePermission>
  );
}
