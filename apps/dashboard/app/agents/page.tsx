"use client";

import Link from "next/link";
import { BrainCircuit, Plus } from "lucide-react";
import { useAgentAccess, useAgentRuns, useAgents, useAiConnections, useAiProviders, useBusinessId } from "@/lib/agents-queries";
import { KIND_LABEL, providerName } from "@/lib/agents";
import type { Agent } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RequirePermission, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { AgentStatusChip, OpenABusiness, RunStatusChip } from "@/components/agents/parts";

const COLS = "md:grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1fr)_6rem_10rem]";

function AgentsPage() {
  const access = useAgentAccess();
  const agents = useAgents();
  const connections = useAiConnections();
  const providers = useAiProviders();
  // The latest run per agent when the server does not send `last_run` with each agent.
  const runs = useAgentRuns({ limit: 50 });
  const lastRun = (a: Agent) => a.last_run ?? runs.data?.items.find((r) => r.agent_id === a.id) ?? null;
  const connectionOf = (a: Agent) => connections.data?.find((c) => c.id === a.connection_id);
  const noConnections = connections.isSuccess && connections.data.length === 0;

  const create = access.manage && (
    <Button asChild>
      <Link href="/agents/new">
        <Plus /> New AI agent
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader title="AI agents" description="Agents that work for this business: a back-office assistant for your team, or a paid skill people and their agents buy per call." actions={create} />
      <Panel bodyClassName="p-0 sm:p-0">
        {agents.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : agents.isError ? (
          <ErrorState className="m-4" error={agents.error} onRetry={() => void agents.refetch()} />
        ) : agents.data.length === 0 ? (
          <EmptyState
            icon={<BrainCircuit className="size-4" />}
            title="No AI agents yet"
            action={
              access.manage ? (
                noConnections ? (
                  <Button asChild>
                    <Link href="/settings/ai">Add an AI connection</Link>
                  </Button>
                ) : (
                  <Button asChild>
                    <Link href="/agents/new">Create an agent</Link>
                  </Button>
                )
              ) : undefined
            }
          >
            {noConnections
              ? "Agents run on your own AI provider account. Add a key in Settings > AI models first."
              : "A back-office agent answers questions about payments, links and refunds. A paid skill earns per call."}
          </EmptyState>
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Agent</span>
              <span>Kind</span>
              <span>Model</span>
              <span>Status</span>
              <span>Last run</span>
            </ListHead>
            <ul className="stagger divide-y">
              {agents.data.map((a) => {
                const last = lastRun(a);
                const conn = connectionOf(a);
                return (
                  <li key={a.id} className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 md:gap-4 ${COLS}`}>
                    <span className="min-w-0">
                      <Link href={`/agents/${a.id}`} className="block truncate font-medium after:absolute after:inset-0 hover:underline">
                        {a.name}
                      </Link>
                      {a.description && <span className="block truncate text-xs text-muted-foreground">{a.description}</span>}
                    </span>
                    <span className="text-muted-foreground max-md:col-start-1 max-md:row-start-2 max-md:text-xs">
                      {KIND_LABEL[a.kind]}
                      <span className="md:hidden"> · {a.model}</span>
                    </span>
                    <span className="min-w-0 max-md:hidden">
                      <span className="hash block truncate text-[0.8125rem]" title={a.model}>
                        {a.model}
                      </span>
                      {conn && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {conn.label} · {providerName(conn.provider, providers.data)}
                        </span>
                      )}
                    </span>
                    <span className="max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end">
                      <AgentStatusChip status={a.status} />
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground max-md:col-start-2 max-md:row-start-2 max-md:justify-self-end">
                      {last ? (
                        <>
                          <RunStatusChip status={last.status} className="max-md:hidden" />
                          <TimeAgo iso={last.created_at} />
                        </>
                      ) : (
                        "Never run"
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

export default function Page() {
  const b = useBusinessId();
  if (!b) {
    return (
      <>
        <PageHeader title="AI agents" />
        <OpenABusiness what="AI agents" />
      </>
    );
  }
  return (
    <RequirePermission permission="payments.read">
      <AgentsPage />
    </RequirePermission>
  );
}
