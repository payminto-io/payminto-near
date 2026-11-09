"use client";

import { useBusinessId } from "@/lib/agents-queries";
import { PageHeader } from "@/components/app/primitives";
import { RequirePermission } from "@/components/app/states";
import { AgentForm } from "@/components/agents/agent-form";
import { OpenABusiness } from "@/components/agents/parts";

export default function NewAgentPage() {
  const b = useBusinessId();
  if (!b) {
    return (
      <>
        <PageHeader back={{ href: "/agents", label: "AI agents" }} title="New AI agent" />
        <OpenABusiness what="AI agents" />
      </>
    );
  }
  // Creating agents is for Admins (docs/AGENTS.md section 6), the same permission lib/agents.ts agentAccess reads.
  return (
    <RequirePermission permission="business.update">
      <AgentForm />
    </RequirePermission>
  );
}
