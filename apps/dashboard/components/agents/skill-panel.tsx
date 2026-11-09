"use client";

/** How buyers reach a paid skill (docs/AGENTS.md section 4): its public address, price, and copyable examples. */
import { useState } from "react";
import { agentExample, curlExample, skillUrl } from "@/lib/agents";
import { useInfo } from "@/lib/queries";
import { SERVER_URL } from "@/lib/api";
import type { Agent } from "@/lib/schemas";
import { CopyButton, Field, Fields, Money, Panel } from "@/components/app/primitives";
import { CodeBlock, Segmented } from "@/components/gateway/kit";

export function SkillPanel({ agent }: { agent: Agent }) {
  const info = useInfo();
  const [tab, setTab] = useState<"curl" | "agent">("curl");
  const url = skillUrl(agent, info.data?.publicUrl ?? SERVER_URL);
  if (!url) return null;
  const code = tab === "curl" ? curlExample(url, agent.input_hint) : agentExample(url, agent.price, agent.input_hint);
  return (
    <Panel title="Selling it" description="Anyone can call this address. The first answer asks for the price; a paying client pays and gets the result.">
      <Fields>
        <Field label="Address">
          <span className="flex min-w-0 items-center gap-1">
            <span className="hash min-w-0 text-[0.8125rem] break-all">{url}</span>
            <CopyButton value={url} label="skill address" />
          </span>
        </Field>
        <Field label="Price per call">
          <Money atomic={agent.price ?? null} maxFraction={6} />
        </Field>
        {agent.input_hint && <Field label="Input hint">{agent.input_hint}</Field>}
        <Field label="Listed" hint="AI agents find this skill and its price in this server's service directory.">
          Listed for AI agents
        </Field>
      </Fields>
      <div className="mt-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Try it</p>
          <Segmented
            label="Example"
            value={tab}
            onChange={setTab}
            options={[
              { key: "curl", label: "curl" },
              { key: "agent", label: "Agent" },
            ]}
          />
        </div>
        <CodeBlock code={code} label={tab === "curl" ? "curl example" : "Agent example"} copy={<CopyButton value={code} label="example" />} />
        <p className="text-xs text-muted-foreground">
          {tab === "curl"
            ? "Without payment the answer is 402 with the price. Any x402 client pays it and retries; the result comes back, or a poll address after 25 seconds."
            : "The agent signs one payment for at most the price and never sends a transaction itself. A slow run answers 202 with a poll address that only the payer can read."}
        </p>
      </div>
    </Panel>
  );
}
