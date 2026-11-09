"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2, MailPlus, RotateCw, X } from "lucide-react";
import { useSession } from "@/lib/session";
import { authErrorText, type Invite } from "@/lib/account";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { RoleChip, inviteRoleKey } from "./parts";

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}

/**
 * Pending invites with Copy link, Resend and Revoke (PRODUCT.md 4.8). A link is only returned when an invite is
 * created or resent (10.8), so Copy link makes a fresh link and the old one stops working.
 */
export function PendingInvites({ scope, canManage }: { scope: string | null; canManage: boolean }) {
  const { account } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: accountKeys.invites(scope), queryFn: () => account.invites(scope), enabled: canManage });
  const refresh = () => void qc.invalidateQueries({ queryKey: accountKeys.invites(scope) });
  const resend = useMutation({
    mutationFn: async ({ invite, copyLink }: { invite: Invite; copyLink: boolean }) => {
      const r = await account.resendInvite(scope, invite.id);
      if (copyLink && r.link) await copy(r.link);
      return { r, copyLink };
    },
    onSuccess: ({ r, copyLink }) => {
      toast.success(copyLink ? `New invite link for ${r.email} copied. The previous link no longer works.` : `Invite sent again to ${r.email}.`);
      refresh();
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const revoke = useMutation({
    mutationFn: (invite: Invite) => account.revokeInvite(scope, invite.id),
    onSuccess: () => {
      toast.success("Invite revoked. Its link no longer works.");
      refresh();
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  if (!canManage) return null;
  return (
    <Panel title="Pending invites" description="People who have not accepted yet. Invite links work for 7 days." bodyClassName="p-0 sm:p-0">
      {q.isPending ? (
        <RowsSkeleton className="px-5" rows={2} />
      ) : q.isError ? (
        <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState icon={<MailPlus className="size-4" />} title="No pending invites" />
      ) : (
        <ul className="stagger divide-y">
          {q.data.map((i) => (
            <li key={i.id} className="flex flex-col gap-2 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:flex-row sm:items-center sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{i.email}</span>
                  <RoleChip role={inviteRoleKey(i.role)} />
                  {i.status === "expired" && <Chip tone="warning">Expired</Chip>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {i.invitedBy ? `Invited by ${i.invitedBy}` : "Invited"}
                  {i.createdAt && (
                    <>
                      {" "}
                      <TimeAgo iso={i.createdAt} />
                    </>
                  )}
                  {i.expiresAt && i.status !== "expired" && <> · expires {new Date(i.expiresAt).toLocaleDateString()}</>}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" disabled={resend.isPending} onClick={() => resend.mutate({ invite: i, copyLink: true })}>
                      <Link2 /> Copy link
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-60">Makes a fresh link and copies it. The link sent before stops working.</TooltipContent>
                </Tooltip>
                <Button variant="ghost" size="sm" disabled={resend.isPending} onClick={() => resend.mutate({ invite: i, copyLink: false })}>
                  <RotateCw /> Resend
                </Button>
                <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(i)} aria-label={`Revoke the invite for ${i.email}`}>
                  <X /> Revoke
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
