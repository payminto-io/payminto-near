"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2, UserPlus, Users } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { authErrorText, type Member } from "@/lib/account";
import { ROLE_LABEL, ROLE_TOOLTIP, type BusinessRole } from "@/lib/permissions";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { Avatar } from "@/components/app/user-menu";
import { Dash, InviteDialog, NoAccess, RoleChip } from "@/components/account/parts";
import { PendingInvites } from "@/components/account/pending-invites";

const ROLES: BusinessRole[] = ["admin", "staff", "viewer"];
const COLS = "md:grid-cols-[minmax(0,1.6fr)_10rem_7rem_7rem_2.5rem]";

type Pending = { kind: "role"; member: Member; role: BusinessRole } | { kind: "remove"; member: Member };

export default function TeamPage() {
  const access = useAccess();
  const { account } = useSession();
  const qc = useQueryClient();
  const params = useSearchParams();
  const view = access.view;
  const merchantId = view?.kind === "business" ? view.merchantId : null;
  const canRead = merchantId ? access.can("members.read") : false;
  const canManage = merchantId ? access.can("members.manage") : false;
  const [inviteOpen, setInviteOpen] = useState(params.get("invite") === "1" && canManage);
  const [pending, setPending] = useState<Pending | null>(null);
  const members = useQuery({ queryKey: accountKeys.members(merchantId ?? ""), queryFn: () => account.members(merchantId!), enabled: Boolean(merchantId) && canRead });
  const businessName = access.session.memberships.find((m) => m.merchantId === merchantId)?.name ?? "this business";
  const me = access.session.user?.id;
  const admins = (members.data ?? []).filter((m) => m.role === "admin").length;

  const refresh = () => void qc.invalidateQueries({ queryKey: accountKeys.members(merchantId ?? "") });
  const change = useMutation({
    mutationFn: (p: Pending) => (p.kind === "role" ? account.setMemberRole(merchantId!, p.member.userId, p.role).then(() => undefined) : account.removeMember(merchantId!, p.member.userId)),
    onSuccess: (_, p) => {
      toast.success(p.kind === "role" ? `${p.member.name} is now ${ROLE_LABEL[p.role]}.` : `${p.member.name} was removed from ${businessName}.`);
      setPending(null);
      refresh();
    },
    onError: (e) => {
      toast.error(authErrorText(e));
      setPending(null);
    },
  });

  if (!merchantId) {
    return (
      <>
        <PageHeader title="Team" description="Each business has its own team. Open a business with the switcher at the top of the sidebar to manage it." />
        <div className="rounded-xl border bg-card">
          <EmptyState icon={<Users className="size-4" />} title="You are on the platform view" action={access.can("team.read") ? <Button asChild variant="outline"><Link href="/platform/team">Open Platform team</Link></Button> : undefined}>
            People who help run this server are on the Platform team.
          </EmptyState>
        </div>
      </>
    );
  }
  if (!canRead) return <NoAccess title="Team" />;

  /** The last Admin cannot be demoted or removed (409 LAST_ADMIN); the dashboard says so before asking. */
  const lastAdmin = (m: Member) => m.role === "admin" && admins <= 1;

  return (
    <>
      <PageHeader
        title="Team"
        description={`People who can open ${businessName}, and what each of them can do.`}
        actions={
          canManage && (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite people
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-5">
        <Panel title="Members" bodyClassName="p-0 sm:p-0">
          <ListHead cols={COLS}>
            <span>Person</span>
            <span>Role</span>
            <span>Joined</span>
            <span>Last active</span>
            <span className="sr-only">Actions</span>
          </ListHead>
          {members.isPending ? (
            <RowsSkeleton className="px-5" rows={3} />
          ) : members.isError ? (
            <ErrorState className="m-4" error={members.error} onRetry={() => void members.refetch()} />
          ) : members.data.length === 0 ? (
            <EmptyState icon={<Users className="size-4" />} title="No members yet" />
          ) : (
            <ul className="stagger divide-y">
              {members.data.map((m) => (
                <li key={m.userId} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 ${COLS}`}>
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar name={m.name} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{m.name}</span>
                        {m.userId === me && <Chip tone="neutral" dot={false}>You</Chip>}
                        {!m.emailVerified && <Chip tone="warning" dot={false}>Email not verified</Chip>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                    </span>
                  </span>
                  <span className="max-md:col-start-1 max-md:row-start-2">
                    {canManage && m.userId !== me ? (
                      <Select value={m.role} onValueChange={(r) => r !== m.role && setPending({ kind: "role", member: m, role: r as BusinessRole })}>
                        <SelectTrigger size="sm" aria-label={`Role of ${m.name}`} className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r} value={r} title={ROLE_TOOLTIP[r]}>
                              {ROLE_LABEL[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <RoleChip role={m.role} />
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground max-md:hidden">{m.joinedAt ? <TimeAgo iso={m.joinedAt} /> : <Dash />}</span>
                  <span className="text-xs text-muted-foreground max-md:hidden">{m.lastActiveAt ? <TimeAgo iso={m.lastActiveAt} /> : <Dash />}</span>
                  <span className="justify-self-end max-md:col-start-2 max-md:row-start-1">
                    {canManage && m.userId !== me && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => setPending({ kind: "remove", member: m })}>
                        <Trash2 />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <PendingInvites scope={merchantId} canManage={canManage} />
      </div>
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope={merchantId}
        roles={ROLES}
        title={`Invite people to ${businessName}`}
        description="Each person gets an email with a link to join. Without an email server the link waits in the platform's Email outbox, and you can copy it here."
      />
      <AlertDialog open={Boolean(pending)} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{pending.kind === "role" ? `Make ${pending.member.name} ${ROLE_LABEL[pending.role]}?` : `Remove ${pending.member.name}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {lastAdmin(pending.member) && (pending.kind === "remove" || pending.role !== "admin")
                    ? `${pending.member.name} is the only Admin of ${businessName}. Make someone else Admin first, so the business keeps someone who can manage it.`
                    : pending.kind === "role"
                      ? `${ROLE_TOOLTIP[pending.role]} The change applies the next time they load a page.`
                      : `${pending.member.name} will lose access to ${businessName} at once. Their payment links and history stay.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                {!(lastAdmin(pending.member) && (pending.kind === "remove" || pending.role !== "admin")) && (
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      change.mutate(pending);
                    }}
                    disabled={change.isPending}
                    className={pending.kind === "remove" ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
                  >
                    {pending.kind === "role" ? "Change role" : "Remove"}
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
