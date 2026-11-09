"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { useApi } from "@/lib/session";
import { ApiError } from "@/lib/http";
import { ak, useAgentAccess, useAgents, useAiConnections, useAiProviders, useAiUsage, useBusinessId } from "@/lib/agents-queries";
import { agentsUsing, deleteRefusalText, inUseFromDetails, providerName } from "@/lib/agents";
import type { AiConnection } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RequirePermission, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { ConnectionStatusChip, OpenABusiness, OwnAccountNote, ProviderBadge, TokenUsage } from "@/components/agents/parts";
import { ConnectionDialog, RotateKeyDialog } from "@/components/agents/connection-dialogs";

const COLS = "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_7.5rem_8.5rem_2.5rem]";

type Confirm = { kind: "delete"; connection: AiConnection; refusal: string | null } | { kind: "disable"; connection: AiConnection };

function AiModelsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const b = useBusinessId();
  const access = useAgentAccess();
  const connections = useAiConnections();
  const providers = useAiProviders();
  const usage = useAiUsage();
  const agents = useAgents();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiConnection | null>(null);
  const [rotating, setRotating] = useState<AiConnection | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ak.connections(b) });
  const tokensOf = (c: AiConnection) => {
    if (c.usage) return c.usage.input_tokens + c.usage.output_tokens;
    const row = usage.data?.connections.find((u) => u.connection_id === c.id);
    return row ? row.input_tokens + row.output_tokens : null;
  };

  const verify = useMutation({
    mutationFn: (c: AiConnection) => api.agents.verifyConnection(c.id),
    onSuccess: (c) => {
      refresh();
      if (c.status === "active") toast.success(`${providerName(c.provider, providers.data)} accepted the key for ${c.label}.`);
      else if (c.status === "invalid") toast.error(`${providerName(c.provider, providers.data)} rejected the key for ${c.label}. Rotate the key to fix it.`);
      else toast.message(`${c.label} is turned off; turn it on to use it.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const setStatus = useMutation({
    mutationFn: ({ c, status }: { c: AiConnection; status: "active" | "disabled" }) => api.agents.updateConnection(c.id, { status }),
    onSuccess: (c) => {
      refresh();
      setConfirm(null);
      toast.success(c.status === "disabled" ? `${c.label} is turned off. Agents on it stop starting runs.` : `${c.label} is on again.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (c: AiConnection) => api.agents.deleteConnection(c.id),
    onSuccess: (_, c) => {
      refresh();
      void qc.invalidateQueries({ queryKey: ak.agents(b) });
      setConfirm(null);
      toast.success(`${c.label} deleted. The key is gone from this server.`);
    },
    onError: (e, c) => {
      // Refused while an active agent uses it: say who, in plain words, instead of a raw error.
      if (e instanceof ApiError && e.status === 409) {
        const named = inUseFromDetails(e.details);
        setConfirm({ kind: "delete", connection: c, refusal: deleteRefusalText(c, named.length ? named : agentsUsing(c.id, agents.data ?? [])) });
      } else toast.error(e.message);
    },
  });

  const askDelete = (c: AiConnection) => {
    const users = agentsUsing(c.id, agents.data ?? []);
    setConfirm({ kind: "delete", connection: c, refusal: users.length ? deleteRefusalText(c, users) : null });
  };

  const list = connections.data ?? [];
  return (
    <>
      <PageHeader
        title="AI models"
        description="The AI provider accounts your agents run on. Add one per provider or team; each agent picks one."
        actions={
          access.manage && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add connection
            </Button>
          )
        }
      />
      <OwnAccountNote className="mb-5" />
      <Panel bodyClassName="p-0 sm:p-0">
        {connections.isPending ? (
          <RowsSkeleton className="px-5" rows={2} />
        ) : connections.isError ? (
          <ErrorState className="m-4" error={connections.error} onRetry={() => void connections.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="size-4" />}
            title="No AI connections yet"
            action={access.manage ? <Button onClick={() => setAdding(true)}>Add a connection</Button> : undefined}
          >
            {access.manage ? "Add a key from Anthropic, OpenAI, Google Gemini or any OpenAI-compatible provider to start using AI agents." : "An Admin of this business adds the AI provider account agents run on."}
          </EmptyState>
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Connection</span>
              <span>Default model</span>
              <span>Status</span>
              <span>This month</span>
              <span className="sr-only">Actions</span>
            </ListHead>
            <ul className="stagger divide-y">
              {list.map((c) => {
                const used = tokensOf(c);
                return (
                  <li key={c.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 px-4 py-3.5 text-sm sm:px-5 md:items-center ${COLS}`}>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <ProviderBadge provider={c.provider} providers={providers.data} />
                        <span className="truncate font-medium">{c.label}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {c.key_hint ? (
                          <>
                            Key ending <span className="hash text-foreground">{c.key_hint}</span>
                          </>
                        ) : (
                          "No key"
                        )}
                        {c.verified_at && (
                          <>
                            {" "}
                            · checked <TimeAgo iso={c.verified_at} />
                          </>
                        )}
                      </span>
                      {c.status === "invalid" && c.last_error && <span className="text-xs text-negative">{c.last_error}</span>}
                    </span>
                    <span className="hash min-w-0 truncate text-[0.8125rem] text-muted-foreground max-md:col-start-1" title={c.default_model}>
                      {c.default_model}
                      {c.base_url && <span className="block truncate text-[0.6875rem] text-subtle">{c.base_url}</span>}
                    </span>
                    <span className="max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end">
                      <ConnectionStatusChip status={c.status} />
                    </span>
                    <span className="min-w-0 max-md:col-start-1">{used === null ? <span className="text-subtle">-</span> : <TokenUsage used={used} limit={c.monthly_token_limit} className="max-w-36" />}</span>
                    <span className="justify-self-end max-md:col-start-2 max-md:row-start-2">
                      {access.manage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.label}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem disabled={verify.isPending} onSelect={() => verify.mutate(c)}>
                              Check key now
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setEditing(c)}>Edit</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setRotating(c)}>Rotate key</DropdownMenuItem>
                            {c.status === "disabled" ? (
                              <DropdownMenuItem onSelect={() => setStatus.mutate({ c, status: "active" })}>Turn on</DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => setConfirm({ kind: "disable", connection: c })}>Turn off</DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => askDelete(c)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>
      {!access.manage && list.length > 0 && <p className="mt-3 text-sm text-muted-foreground">Only Admins of this business can add, change or delete AI connections.</p>}

      <ConnectionDialog open={adding} onOpenChange={setAdding} />
      <ConnectionDialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)} connection={editing} />
      <RotateKeyDialog connection={rotating} onOpenChange={(o) => !o && setRotating(null)} />

      <AlertDialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          {confirm?.kind === "disable" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Turn off {confirm.connection.label}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Agents on this connection stop starting runs, and paid skills on it stop taking calls before anyone pays. Runs already working finish. The key stays saved; turn it on again any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it on</AlertDialogCancel>
                <AlertDialogAction
                  disabled={setStatus.isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    setStatus.mutate({ c: confirm.connection, status: "disabled" });
                  }}
                >
                  Turn off
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {confirm?.kind === "delete" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirm.refusal ? `${confirm.connection.label} is still in use` : `Delete ${confirm.connection.label}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm.refusal ?? `The key ending ${confirm.connection.key_hint ?? "****"} is erased from this server. Past runs and their usage stay. Paused agents on it need another connection before they run again.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{confirm.refusal ? "Close" : "Cancel"}</AlertDialogCancel>
                {!confirm.refusal && (
                  <AlertDialogAction
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={(e) => {
                      e.preventDefault();
                      remove.mutate(confirm.connection);
                    }}
                  >
                    Delete connection
                  </AlertDialogAction>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function Page() {
  const b = useBusinessId();
  if (!b) {
    return (
      <>
        <PageHeader title="AI models" description="The AI provider accounts your agents run on." />
        <OpenABusiness what="AI connections" />
      </>
    );
  }
  return (
    <RequirePermission permission="payments.read">
      <AiModelsPage />
    </RequirePermission>
  );
}
