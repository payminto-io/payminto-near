"use client";

import { RequirePermission } from "@/components/app/states";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Plus } from "lucide-react";
import { useApi } from "@/lib/session";
import { gk, useApiKeys } from "@/lib/gateway-queries";
import type { ApiKey } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { FormRow, ListHead } from "@/components/gateway/kit";
import { SecretDialog } from "@/components/gateway/secret-dialog";

const COLS = "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_7rem_7rem_6.5rem_5.5rem]";

function ApiKeysPagePage() {
  const keys = useApiKeys();
  const api = useApi();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiKey | null>(null);
  const create = useMutation({
    mutationFn: () => api.gateway.createApiKey({ name: name.trim() }),
    onSuccess: (k) => {
      setCreating(false);
      setName("");
      setSecret(k.secret);
      void qc.invalidateQueries({ queryKey: gk.keys });
    },
    onError: (e) => toast.error(e.message),
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => api.gateway.revokeApiKey(id),
    onSuccess: () => {
      toast.success("Key revoked. Requests with it now fail with 401.");
      void qc.invalidateQueries({ queryKey: gk.keys });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="API keys"
        description="Secret keys let your server create payments, links and refunds. They are stored hashed, shown once, and can be revoked at any time."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Create secret key
          </Button>
        }
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {keys.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : keys.isError ? (
          <ErrorState className="m-4" error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.data.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-4" />} title="No API keys yet" action={<Button onClick={() => setCreating(true)}>Create a secret key</Button>}>
            Your server needs one to call the payments API.
          </EmptyState>
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Name</span>
              <span>Key</span>
              <span>Created</span>
              <span>Last used</span>
              <span>Status</span>
              <span className="sr-only">Actions</span>
            </ListHead>
            <ul className="divide-y">
              {keys.data.map((k) => (
                <li key={k.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5 md:gap-4 ${COLS}`}>
                  <span className="truncate font-medium">{k.name ?? "Unnamed key"}</span>
                  <span className="hash text-[0.8125rem] text-muted-foreground max-md:col-start-1">{k.prefix}…</span>
                  <span className="text-muted-foreground max-md:hidden">
                    <TimeAgo iso={k.created_at} />
                  </span>
                  <span className="text-muted-foreground max-md:hidden">{k.last_used_at ? <TimeAgo iso={k.last_used_at} /> : "Never"}</span>
                  <span className="max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end">
                    <Chip tone={k.revoked_at ? "neutral" : "positive"}>{k.revoked_at ? "Revoked" : "Active"}</Chip>
                  </span>
                  <span className="justify-self-end max-md:col-start-2 max-md:row-start-2">
                    {!k.revoked_at && (
                      <Button variant="ghost" size="sm" className="text-negative hover:text-negative" onClick={() => setRevoke(k)}>
                        Revoke
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-[26rem]">
          <DialogHeader>
            <DialogTitle>Create secret key</DialogTitle>
            <DialogDescription>A test-mode key on this network. It can create payments, links and refunds for this store.</DialogDescription>
          </DialogHeader>
          <form
            id="key-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <FormRow id="key-name" label="Name" hint="Where it is used, e.g. Production server.">
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
            </FormRow>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" form="key-form" disabled={!name.trim() || create.isPending}>
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretDialog secret={secret} title="Save your secret key" what="key" onClose={() => setSecret(null)} />

      <AlertDialog open={revoke !== null} onOpenChange={(o) => !o && setRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{revoke?.name ?? "Unnamed key"}”?</AlertDialogTitle>
            <AlertDialogDescription>Every request signed with {revoke?.prefix}… fails from now on. This cannot be undone; create a new key to replace it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep key</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => revoke && revokeM.mutate(revoke.id)}>
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function ApiKeysPage() {
  return (
    <RequirePermission permission={"developers.manage"}>
      <ApiKeysPagePage />
    </RequirePermission>
  );
}
