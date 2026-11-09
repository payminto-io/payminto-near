"use client";

import { useParams } from "next/navigation";
import { useAgent, useBusinessId } from "@/lib/agents-queries";
import { useDocumentTitle } from "@/lib/use-title";
import { BlockSkeleton, ErrorState, RequirePermission } from "@/components/app/states";
import { AgentForm } from "@/components/agents/agent-form";
import { OpenABusiness } from "@/components/agents/parts";

function EditAgent({ id }: { id: string }) {
  const agent = useAgent(id);
  useDocumentTitle(agent.data ? `Edit ${agent.data.name}` : null);
  if (agent.isPending) return <BlockSkeleton className="h-96" />;
  if (agent.isError) return <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />;
  return <AgentForm key={agent.data.id} agent={agent.data} />;
}

export default function EditAgentPage() {
  const { id } = useParams<{ id: string }>();
  const b = useBusinessId();
  if (!b) return <OpenABusiness what="AI agents" />;
  return (
    <RequirePermission permission="business.update">
      <EditAgent id={id} />
    </RequirePermission>
  );
}
