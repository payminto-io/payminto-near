"use client";

import { RequirePermission } from "@/components/app/states";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Webhook } from "lucide-react";
import { useApi } from "@/lib/session";
import { gk, useWebhooks } from "@/lib/gateway-queries";
import { MOCK_MODE } from "@/lib/config";
import type { WebhookEndpoint } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { FormRow, ListHead } from "@/components/gateway/kit";
import { SecretDialog } from "@/components/gateway/secret-dialog";
import { EventPicker, endpointStatus } from "@/components/gateway/webhook-parts";

const COLS = "md:grid-cols-[minmax(0,2.4fr)_6rem_7rem_6.5rem_7rem]";

function WebhooksPagePage() {
  const hooks = useWebhooks();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<WebhookEndpoint | null>(null);
  const router = useRouter();

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Signed HTTP callbacks for payment and refund events. Every attempt is logged with its status code and can be retried."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Add endpoint
          </Button>
        }
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {hooks.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : hooks.isError ? (
          <ErrorState className="m-4" error={hooks.error} onRetry={() => void hooks.refetch()} />
        ) : hooks.data.length === 0 ? (
          <EmptyState icon={<Webhook className="size-4" />} title="No endpoints yet" action={<Button onClick={() => setCreating(true)}>Add an endpoint</Button>}>
            Your server learns about paid payments here instead of polling.
          </EmptyState>
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Endpoint</span>
              <span className="text-right">Events</span>
              <span>Status</span>
              <span className="text-right">Success, 7d</span>
              <span className="text-right">Last delivery</span>
            </ListHead>
            <ul className="divide-y">
              {hooks.data.map((e) => {
                const s = endpointStatus(e);
                return (
                  <li key={e.id} className={`relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/40 sm:px-5 md:gap-4 ${COLS}`}>
                    <span className="min-w-0">
                      <Link href={`/developers/webhooks/${e.id}`} className="hash block truncate text-[0.8125rem] font-medium after:absolute after:inset-0 hover:underline">
                        {e.url}
                      </Link>
                      {e.description && <span className="block truncate text-xs text-muted-foreground">{e.description}</span>}
                    </span>
                    <span className="num text-muted-foreground max-md:hidden md:text-right">{e.events.includes("*") ? "All" : e.events.length}</span>
                    <span className="max-md:col-start-2 max-md:row-start-1">
                      <Chip tone={s.tone}>{s.label}</Chip>
                    </span>
                    <span className="num text-muted-foreground max-md:hidden md:text-right">{e.success_rate_7d == null ? "-" : `${(e.success_rate_7d * 100).toFixed(1)}%`}</span>
                    <span className="text-muted-foreground max-md:hidden md:text-right">{e.last_delivery_at ? <TimeAgo iso={e.last_delivery_at} /> : "Never"}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>
      <CreateEndpoint open={creating} onOpenChange={setCreating} onCreated={setCreated} />
      <SecretDialog
        secret={created?.secret ?? null}
        title="Save your signing secret"
        what="signing secret"
        onClose={() => {
          const id = created?.id;
          setCreated(null);
          if (id) router.push(`/developers/webhooks/${id}`);
        }}
      />
    </>
  );
}

function CreateEndpoint({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (e: WebhookEndpoint) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["payment.paid", "payment.overpaid", "payment.underpaid", "refund.succeeded"]);
  const [touched, setTouched] = useState(false);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url.trim());
  const urlError = !/^https:\/\/[^\s/]+\.[^\s]+/.test(url.trim()) && !(local && MOCK_MODE) ? "Use an https:// URL your server answers on." : null;
  const create = useMutation({
    mutationFn: () => api.gateway.createWebhook({ url: url.trim(), description: description.trim() || undefined, events }),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: gk.webhooks });
      onOpenChange(false);
      setUrl("");
      setDescription("");
      setTouched(false);
      onCreated(e);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[34rem]">
        <DialogHeader>
          <DialogTitle>Add webhook endpoint</DialogTitle>
          <DialogDescription>Each delivery is signed with a Payminto-Signature header; reject anything older than 5 minutes.</DialogDescription>
        </DialogHeader>
        <form
          id="hook-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!urlError && events.length) create.mutate();
          }}
        >
          <FormRow id="hook-url" label="Endpoint URL" error={touched ? urlError : null} hint="Private and loopback addresses are refused on HashKey Chain.">
            <Input id="hook-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/payminto" className="hash text-[0.8125rem]" />
          </FormRow>
          <FormRow id="hook-desc" label="Description" optional>
            <Input id="hook-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Order fulfilment" />
          </FormRow>
          <EventPicker value={events} onChange={setEvents} />
          {touched && events.length === 0 && <p className="text-xs text-negative">Pick at least one event.</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="hook-form" disabled={create.isPending}>
            Add endpoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function WebhooksPage() {
  return (
    <RequirePermission permission={"developers.manage"}>
      <WebhooksPagePage />
    </RequirePermission>
  );
}
