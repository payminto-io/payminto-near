"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, UserPlus, X } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { authErrorText, type SignupRequest } from "@/lib/account";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { CountTabs } from "@/components/gateway/kit";
import { NoAccess } from "@/components/account/parts";

type Tab = "pending" | "approved" | "declined";

const EMPTY: Record<Tab, { title: string; body: string }> = {
  pending: { title: "No sign-ups waiting", body: "When sign-ups need approval (Settings, Platform, Sign-ups), new businesses wait here until you approve them." },
  approved: { title: "None approved yet", body: "Approved businesses get the default pricing plan and can take payments once they prove a payout wallet." },
  declined: { title: "None declined", body: "Declined applicants get an email with your reason." },
};

export default function SignupRequestsPage() {
  const access = useAccess();
  const { account } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");
  const [declining, setDeclining] = useState<SignupRequest | null>(null);
  const [reason, setReason] = useState("");
  const allowed = access.can("signups.review");
  // One request for every status, so the tab counts stay right while switching.
  const q = useQuery({ queryKey: accountKeys.signupRequests("all"), queryFn: () => account.signupRequests("all"), enabled: allowed });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["account", "signup-requests"] });
  const approve = useMutation({
    mutationFn: (r: SignupRequest) => account.approveSignup(r.id),
    onSuccess: (r) => {
      toast.success(`${r.businessName} approved. ${r.name} is now its Admin and got an email.`);
      refresh();
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const decline = useMutation({
    mutationFn: (r: SignupRequest) => account.declineSignup(r.id, reason.trim()),
    onSuccess: (r) => {
      toast.success(`${r.businessName} declined. ${r.name} got an email.`);
      setDeclining(null);
      setReason("");
      refresh();
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  if (!allowed) return <NoAccess title="Sign-up requests" />;
  const items = q.data?.items ?? [];
  const count = (t: Tab) => (q.data ? items.filter((i) => i.status === t).length : null);
  const shown = items.filter((i) => i.status === tab);

  return (
    <>
      <PageHeader title="Sign-up requests" description="People who created an account and a business on this server. Nothing can be paid to a business until you approve it and it proves a payout wallet." />
      <div className="mb-4">
        <CountTabs
          label="Filter by status"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "pending", label: "Waiting", count: count("pending") },
            { key: "approved", label: "Approved", count: count("approved") },
            { key: "declined", label: "Declined", count: count("declined") },
          ]}
        />
      </div>
      <Panel bodyClassName="p-0 sm:p-0">
        {q.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : q.isError ? (
          <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState icon={<UserPlus className="size-4" />} title={EMPTY[tab].title}>
            {EMPTY[tab].body}
          </EmptyState>
        ) : (
          <ul className="stagger divide-y">
            {shown.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 px-4 py-4 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:flex-row sm:items-center sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.businessName}</span>
                    {r.status === "approved" && <Chip tone="positive">Approved</Chip>}
                    {r.status === "declined" && <Chip tone="neutral">Declined</Chip>}
                    {!r.emailVerified && <Chip tone="warning" dot={false}>Email not verified</Chip>}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    {r.name} · {r.email}
                  </span>
                  <span className="mt-0.5 block text-xs text-subtle">
                    Asked <TimeAgo iso={r.createdAt} />
                    {r.decidedAt && (
                      <>
                        {" "}
                        · decided <TimeAgo iso={r.decidedAt} />
                      </>
                    )}
                    {r.reason && <> · Reason: {r.reason}</>}
                  </span>
                </span>
                {r.status === "pending" && (
                  <span className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDeclining(r)}>
                      <X /> Decline
                    </Button>
                    <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(r)}>
                      {approve.isPending && approve.variables?.id === r.id ? <Loader2 className="animate-spin" /> : <Check />} Approve
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Dialog open={Boolean(declining)} onOpenChange={(o) => !o && setDeclining(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline {declining?.businessName}?</DialogTitle>
            <DialogDescription>{declining?.name} gets an email saying the sign-up was declined, with your reason if you give one.</DialogDescription>
          </DialogHeader>
          <div className="mt-2 flex flex-col gap-1.5">
            <label htmlFor="decline-reason" className="flex items-baseline gap-2 text-sm font-medium">
              Reason <span className="text-xs font-normal text-muted-foreground">Optional</span>
            </label>
            <Textarea id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="For example: we only host businesses we already work with." />
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setDeclining(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={decline.isPending} onClick={() => declining && decline.mutate(declining)}>
              {decline.isPending && <Loader2 className="animate-spin" />} Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
