"use client";

import { RequirePermission } from "@/components/app/states";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Eye, EyeOff, MoreHorizontal, RotateCw, Send, Webhook } from "lucide-react";
import { useApi } from "@/lib/session";
import { gk, useDeliveries, useWebhook } from "@/lib/gateway-queries";
import { formatDateTime, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WebhookDelivery } from "@/lib/schemas";
import { useDocumentTitle } from "@/lib/use-title";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip, DeliveryChip } from "@/components/app/status";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { CopyAction } from "@/components/checkout/parts";
import { CodeBlock, Segmented } from "@/components/gateway/kit";
import { endpointStatus } from "@/components/gateway/webhook-parts";
import { WEBHOOK_RETRY_SCHEDULE_SECONDS } from "@payminto/protocol";

function WebhookDetailPagePage() {
  const { id } = useParams<{ id: string }>();
  const q = useWebhook(id);
  const deliveries = useDeliveries(id);
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "succeeded" | "failed">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);
  useDocumentTitle(q.data ? q.data.url.replace(/^https?:\/\//, "") : null);
  const refresh = () => void qc.invalidateQueries({ queryKey: gk.all });

  const reveal = useMutation({ mutationFn: () => api.gateway.revealWebhookSecret(id), onSuccess: setSecret, onError: (e) => toast.error(e.message) });
  const rotate = useMutation({
    mutationFn: () => api.gateway.rotateWebhookSecret(id),
    onSuccess: (e) => {
      setSecret(e.secret ?? null);
      toast.success("Secret rotated. Update your server before the next delivery.");
    },
    onError: (e) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: () => api.gateway.testWebhook(id),
    onSuccess: () => {
      toast.success("Test event sent");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const setActive = useMutation({ mutationFn: (active: boolean) => api.gateway.updateWebhook(id, { active }), onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const remove = useMutation({
    mutationFn: () => api.gateway.deleteWebhook(id),
    onSuccess: () => {
      toast.success("Endpoint deleted");
      refresh();
      router.push("/developers/webhooks");
    },
  });
  const retry = useMutation({
    mutationFn: (d: WebhookDelivery) => api.gateway.retryDelivery(d.id),
    onSuccess: (d) => {
      toast[d.status === "succeeded" ? "success" : "error"](d.status === "succeeded" ? `Delivered: HTTP ${d.response_status}` : `Still failing: ${d.response_status ? `HTTP ${d.response_status}` : d.error ?? "no response"}`);
      setSelected(d.id);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const back = { href: "/developers/webhooks", label: "Webhooks" };
  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-72 animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-40" />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Webhook endpoint" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const e = q.data;
  const s = endpointStatus(e);
  const all = deliveries.data?.items ?? [];
  const shown = all.filter((d) => filter === "all" || d.status === filter);
  const current = shown.find((d) => d.id === selected) ?? shown[0] ?? null;

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="hash min-w-0 text-[1.25rem] break-all">{e.url}</span> <Chip tone={s.tone}>{s.label}</Chip>
          </span>
        }
        description={e.description ?? undefined}
        actions={
          <>
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
              <Send /> Send test event
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setActive.mutate(!e.active)}>{e.active ? "Pause deliveries" : "Enable deliveries"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConfirm("rotate")}>Rotate signing secret</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("delete")}>
                  Delete endpoint
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {!e.active && e.disabled_reason && (
        <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-lg bg-negative-soft px-4 py-3 text-sm text-negative">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{e.disabled_reason} Fix the endpoint, then re-enable it.</span>
          <Button size="sm" variant="outline" onClick={() => setActive.mutate(true)}>
            Re-enable
          </Button>
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <Panel
          title="Event deliveries"
          description="One row per attempt"
          actions={
            <Segmented
              label="Filter deliveries"
              value={filter}
              onChange={setFilter}
              options={[
                { key: "all", label: "All" },
                { key: "succeeded", label: "Succeeded" },
                { key: "failed", label: "Failed" },
              ]}
            />
          }
          bodyClassName="p-0 sm:p-0"
        >
          {deliveries.isPending ? (
            <RowsSkeleton className="px-5" rows={5} />
          ) : deliveries.isError ? (
            <ErrorState className="m-4" error={deliveries.error} onRetry={() => void deliveries.refetch()} />
          ) : shown.length === 0 ? (
            <EmptyState icon={<Webhook className="size-4" />} title="No deliveries in this view" action={<Button variant="outline" onClick={() => test.mutate()}>Send a test event</Button>} />
          ) : (
            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:divide-x">
              <ul className="max-h-[36rem] divide-y overflow-y-auto" aria-label="Deliveries">
                {shown.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(d.id)}
                      aria-current={current?.id === d.id ? "true" : undefined}
                      className={cn("grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 sm:px-5", current?.id === d.id && "bg-accent/60")}
                    >
                      <span className="hash truncate text-[0.8125rem]">{d.event_type}</span>
                      <DeliveryChip status={d.status} code={d.response_status} error={d.error} />
                      <span className="text-xs text-muted-foreground">
                        Attempt {d.attempt} · <TimeAgo iso={d.created_at} />
                      </span>
                      <span className="num text-xs text-muted-foreground">{d.duration_ms != null ? `${formatInt(d.duration_ms)} ms` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {current && <DeliveryDetail d={current} onRetry={() => retry.mutate(current)} retrying={retry.isPending} />}
            </div>
          )}
        </Panel>
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Signing secret" description="Verify the Payminto-Signature header with it">
            <div className="flex items-center gap-2">
              <code className="hash min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 text-[0.8125rem]">{secret ?? "whsec_••••••••••••••••••••••••"}</code>
              {secret ? (
                <>
                  <CopyAction value={secret} label="Copy" className="shrink-0" />
                  <Button variant="ghost" size="icon" aria-label="Hide secret" onClick={() => setSecret(null)}>
                    <EyeOff />
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={() => reveal.mutate()} disabled={reveal.isPending}>
                  <Eye /> Reveal
                </Button>
              )}
            </div>
          </Panel>
          <Panel title="Details">
            <Fields>
              <Field label="Events">
                {e.events.includes("*") ? (
                  "All events"
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {e.events.map((ev) => (
                      <span key={ev} className="hash rounded bg-muted px-1.5 py-0.5 text-[0.75rem]">
                        {ev}
                      </span>
                    ))}
                  </span>
                )}
              </Field>
              <Field label="Success, 7 days">{e.success_rate_7d == null ? "-" : `${(e.success_rate_7d * 100).toFixed(1)}%`}</Field>
              <Field label="Retries">Immediately, then {WEBHOOK_RETRY_SCHEDULE_SECONDS.slice(1).map(fmtDelay).join(", ")}</Field>
              <Field label="Created">{formatDateTime(e.created_at)}</Field>
            </Fields>
          </Panel>
        </div>
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "rotate" ? "Rotate the signing secret?" : "Delete this endpoint?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "rotate" ? "The old secret stops working at once. Deliveries fail verification until your server has the new one." : "No more events are sent to it. Its delivery log is removed with it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "delete" ? "destructive" : "default"} onClick={() => (confirm === "rotate" ? rotate.mutate() : remove.mutate())}>
              {confirm === "rotate" ? "Rotate secret" : "Delete endpoint"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Indented JSON for reading; the copy button still copies the exact bytes that were signed and sent. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function fmtDelay(s: number) {
  return s >= 3600 ? `${s / 3600} h` : `${s / 60} m`;
}

function DeliveryDetail({ d, onRetry, retrying }: { d: WebhookDelivery; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 border-t p-4 sm:p-5 lg:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="hash truncate text-sm font-medium">{d.event_type}</p>
          <p className="text-xs text-muted-foreground">{formatDateTime(d.created_at)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          <RotateCw className={retrying ? "animate-spin" : undefined} /> Retry now
        </Button>
      </div>
      <Fields className="text-[0.8125rem]">
        <Field label="Event ID"><span className="hash break-all">{d.event_id}</span></Field>
        <Field label="HTTP status"><DeliveryChip status={d.status} code={d.response_status} error={d.error} /></Field>
        <Field label="Duration">{d.duration_ms != null ? `${formatInt(d.duration_ms)} ms` : "-"}</Field>
        <Field label="Attempt">{d.attempt} of {WEBHOOK_RETRY_SCHEDULE_SECONDS.length}</Field>
        {d.status === "pending" ? (
          <Field label="Scheduled">{formatDateTime(d.created_at)}</Field>
        ) : (
          <Field label="Next retry">{d.next_attempt_at ? formatDateTime(d.next_attempt_at) : d.status === "failed" && d.attempt >= WEBHOOK_RETRY_SCHEDULE_SECONDS.length ? "None, retries used up" : "None"}</Field>
        )}
        {d.error && <Field label="Error"><span className="text-negative">{d.error}</span></Field>}
      </Fields>
      {d.request_body && <CodeBlock label="Request payload" code={prettyJson(d.request_body)} copy={<CopyAction value={d.request_body} label="Copy" className="h-7 px-2 text-xs" />} />}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Response body</p>
        <CodeBlock label="Response body" code={d.response_body ? prettyJson(d.response_body) : "(empty)"} />
      </div>
    </div>
  );
}

export default function WebhookDetailPage() {
  return (
    <RequirePermission permission={"developers.manage"}>
      <WebhookDetailPagePage />
    </RequirePermission>
  );
}
