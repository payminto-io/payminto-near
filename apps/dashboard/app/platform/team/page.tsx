"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserCog, UserPlus } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { authErrorText, type PlatformMember } from "@/lib/account";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { Avatar } from "@/components/app/user-menu";
import { Dash, InviteDialog, NoAccess, RoleChip } from "@/components/account/parts";
import { PendingInvites } from "@/components/account/pending-invites";

const COLS = "md:grid-cols-[minmax(0,1.6fr)_10rem_8rem_9rem]";

export default function PlatformTeamPage() {
  const access = useAccess();
  const { account } = useSession();
  const qc = useQueryClient();
  const params = useSearchParams();
  const canRead = access.can("team.read");
  const canManage = access.can("team.manage");
  const [inviteOpen, setInviteOpen] = useState(params.get("invite") === "1" && canManage);
  const [removing, setRemoving] = useState<PlatformMember | null>(null);
  const team = useQuery({ queryKey: accountKeys.platformTeam, queryFn: () => account.platformTeam(), enabled: canRead });
  const remove = useMutation({
    mutationFn: (m: PlatformMember) => account.setPlatformRole(m.userId, null),
    onSuccess: (_, m) => {
      toast.success(`${m.name} is no longer a platform admin. Their business memberships stay.`);
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: accountKeys.platformTeam });
    },
    onError: (e) => {
      toast.error(authErrorText(e));
      setRemoving(null);
    },
  });
  if (!canRead) return <NoAccess title="Platform team" />;
  const me = access.session.user?.id;
  return (
    <>
      <PageHeader
        title="Platform team"
        description="People who help run this Payminto server. Platform admins manage businesses; only the platform owner changes pricing, the fee wallet and this team."
        actions={
          canManage && (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite platform admin
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-5">
        <Panel title="People" bodyClassName="p-0 sm:p-0">
          <ListHead cols={COLS}>
            <span>Person</span>
            <span>Role</span>
            <span>Last active</span>
            <span className="sr-only">Actions</span>
          </ListHead>
          {team.isPending ? (
            <RowsSkeleton className="px-5" rows={2} />
          ) : team.isError ? (
            <ErrorState className="m-4" error={team.error} onRetry={() => void team.refetch()} />
          ) : team.data.length === 0 ? (
            <EmptyState icon={<UserCog className="size-4" />} title="Nobody here yet" />
          ) : (
            <ul className="stagger divide-y">
              {team.data.map((m) => (
                <li key={m.userId} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 ${COLS}`}>
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar name={m.name} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{m.name}</span>
                        {m.userId === me && <Chip tone="neutral" dot={false}>You</Chip>}
                        {m.status === "disabled" && <Chip tone="negative">Disabled</Chip>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                    </span>
                  </span>
                  <span className="max-md:col-start-1 max-md:row-start-2">{m.platformRole && <RoleChip role={m.platformRole === "owner" ? "platform_owner" : "platform_admin"} />}</span>
                  <span className="text-xs text-muted-foreground max-md:hidden">{m.lastActiveAt ? <TimeAgo iso={m.lastActiveAt} /> : <Dash />}</span>
                  <span className="justify-self-end max-md:col-start-2 max-md:row-start-1">
                    {canManage && m.platformRole === "admin" && m.userId !== me && (
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(m)}>
                        Remove admin
                      </Button>
                    )}
                    {m.platformRole === "owner" && <span className="text-xs text-subtle">Owner, protected</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <PendingInvites scope={null} canManage={canManage} />
      </div>
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope={null}
        roles={["platform_admin"]}
        title="Invite a platform admin"
        description="Platform admins can add and suspend businesses, review sign-ups and see every business. They cannot change pricing, the platform fee wallet or this team."
      />
      <AlertDialog open={Boolean(removing)} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name} as platform admin?</AlertDialogTitle>
            <AlertDialogDescription>They lose access to the platform view and every business they are not a member of. You may be asked for your password again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (removing) remove.mutate(removing);
              }}
              disabled={remove.isPending}
            >
              Remove admin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
