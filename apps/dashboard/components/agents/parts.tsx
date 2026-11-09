"use client";

/** Small pieces shared by the AI models settings, the AI agents pages and the run page (docs/AGENTS.md section 7). */
import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Building2, Wallet } from "lucide-react";
import { AGENT_STATUS, CONNECTION_STATUS, KIND_LABEL, RUN_STATUS, compactTokens, formatTokens, limitShare, providerName } from "@/lib/agents";
import type { AgentKind, AgentRunStatus, AgentStatus, AiConnectionStatus, AiProvider } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Meter } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState } from "@/components/app/states";

/** The provider as plain text in an outlined badge: no logos (AGENTS.md section 7). */
export function ProviderBadge({ provider, providers, className }: { provider: string; providers?: AiProvider[] | null; className?: string }) {
  return (
    <span className={cn("inline-flex h-[1.375rem] shrink-0 items-center rounded-md border bg-background px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground", className)}>
      {providerName(provider, providers)}
    </span>
  );
}

function Explained({ children, text }: { children: ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-full">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left">{text}</TooltipContent>
    </Tooltip>
  );
}

export function ConnectionStatusChip({ status }: { status: AiConnectionStatus }) {
  const m = CONNECTION_STATUS[status];
  return (
    <Explained text={m.text}>
      <Chip tone={m.tone}>{m.label}</Chip>
    </Explained>
  );
}

export function AgentStatusChip({ status }: { status: AgentStatus }) {
  const m = AGENT_STATUS[status];
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

/** A run's status; a run still working gets a pulsing dot. */
export function RunStatusChip({ status, className }: { status: AgentRunStatus; className?: string }) {
  const m = RUN_STATUS[status];
  const busy = status === "queued" || status === "running";
  return (
    <Chip tone={m.tone} dot={!busy} className={className}>
      {busy && (
        <span aria-hidden className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      )}
      {m.label}
    </Chip>
  );
}

/** A model id in mono, wrapping after its slashes ("meta-llama/" then "llama-4-maverick") rather than mid-word. */
export function ModelId({ id, className }: { id: string; className?: string }) {
  const parts = id.split("/");
  return (
    <span className={cn("hash text-[0.8125rem] break-words", className)}>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </span>
  );
}

export function KindLabel({ kind, className }: { kind: AgentKind; className?: string }) {
  return <span className={cn("text-muted-foreground", className)}>{KIND_LABEL[kind]}</span>;
}

/** "48k of 2M tokens" with a meter, or "48k tokens" when there is no monthly limit. */
export function TokenUsage({ used, limit, className }: { used: number; limit: number | null | undefined; className?: string }) {
  const share = limitShare(used, limit);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="num text-sm whitespace-nowrap">
            {compactTokens(used)}
            <span className="text-muted-foreground">{limit ? ` of ${compactTokens(limit)}` : " tokens"}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{limit ? `${formatTokens(used)} of the ${formatTokens(limit)} monthly limit` : `${formatTokens(used)} this month, no limit set`}</TooltipContent>
      </Tooltip>
      {share !== null && <Meter value={share} tone={share >= 95 ? "negative" : share >= 80 ? "warning" : "primary"} label="Share of the monthly token limit used" />}
    </div>
  );
}

/** The plain-words line from AGENTS.md section 7, on every screen that spends model tokens. */
export function OwnAccountNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground", className)}>
      <Wallet className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>Your agents use your own AI account. You pay your AI provider directly; Payminto never sees your bill.</span>
    </p>
  );
}

/** AI agents belong to one business; on the platform view this asks to open one. */
export function OpenABusiness({ what }: { what: string }) {
  return (
    <div className="rounded-xl border bg-card">
      <EmptyState icon={<Building2 className="size-4" />} title="Open a business first">
        {what} belong to one business. Pick the business with the switcher at the top of the sidebar.
      </EmptyState>
    </div>
  );
}

/** A plain-words problem with what to do next, and a link when there is a place to fix it. */
export function ProblemNote({ title, action, href, hrefLabel, className }: { title: string; action: string; href?: string; hrefLabel?: string; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col gap-3 rounded-lg border border-negative/25 bg-negative-soft/60 px-4 py-3 sm:flex-row sm:items-start", className)}>
      <div className="flex min-w-0 flex-1 gap-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-muted-foreground">{action}</p>
        </div>
      </div>
      {href && (
        <Button asChild size="sm" variant="outline" className="shrink-0 self-start max-sm:ml-7">
          <Link href={href}>{hrefLabel ?? "Open"}</Link>
        </Button>
      )}
    </div>
  );
}
