"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Eye, Inbox, MailCheck } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { CopyButton, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { NoAccess } from "@/components/account/parts";

/** Email kinds from PRODUCT.md section 10.9, in plain words. */
const EMAIL_KIND: Record<string, string> = {
  verify_email: "Verify email",
  reset_password: "Reset password",
  invite: "Invite",
  password_changed: "Password changed",
  signup_received: "Sign-up received",
  signup_approved: "Sign-up approved",
  signup_declined: "Sign-up declined",
  account_exists: "Account already exists",
  test: "Test email",
};

export default function OutboxPage() {
  const access = useAccess();
  const { account } = useSession();
  const allowed = access.can("outbox.read");
  const q = useQuery({ queryKey: accountKeys.outbox, queryFn: () => account.outbox(), enabled: allowed });
  if (!allowed) return <NoAccess title="Email outbox" />;

  if (q.data?.smtpConfigured) {
    return (
      <>
        <PageHeader title="Email outbox" />
        <div className="rounded-xl border bg-card">
          <EmptyState icon={<MailCheck className="size-4" />} title="Email server is set up" action={<Button asChild variant="outline"><Link href="/settings/platform">Open email settings</Link></Button>}>
            Emails go out through your SMTP server, so nothing waits here. Send a test email from Settings.
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Email outbox" description="This server has no email server set up, so emails it would send (invites, email checks, password resets) wait here. Copy a link and pass it on yourself." />
      <section role="note" className="mb-5 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm">
        <Eye className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <p>
          <span className="font-medium">You can see every link here, including password resets.</span>{" "}
          <span className="text-muted-foreground">
            Only the platform owner can open this page, and every visit is written to the Activity log.
          </span>
        </p>
      </section>
      <Panel title="Emails" description="Newest first" bodyClassName="p-0 sm:p-0">
        {q.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : q.isError ? (
          <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState icon={<Inbox className="size-4" />} title="No emails yet">
            Invites, sign-ups and password resets appear here.
          </EmptyState>
        ) : (
          <ul className="stagger divide-y">
            {q.data.items.map((e) => (
              <li key={e.id} className="flex flex-col gap-2 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:flex-row sm:items-center sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={e.kind === "reset_password" ? "warning" : "neutral"} dot={false}>
                      {EMAIL_KIND[e.kind] ?? e.kind}
                    </Chip>
                    <span className="truncate font-medium">{e.subject}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    To {e.to} · <TimeAgo iso={e.createdAt} />
                    {e.error && <span className="text-negative"> · {e.error}</span>}
                  </span>
                  {e.link && <span className="hash mt-1 block truncate text-xs text-subtle">{e.link}</span>}
                </span>
                {e.link && (
                  <span className="flex shrink-0 items-center gap-1">
                    <CopyButton value={e.link} label="link" className="size-8" />
                    <Button variant="ghost" size="icon-sm" asChild>
                      <a href={e.link} target="_blank" rel="noreferrer" aria-label={`Open the link for ${e.to}`}>
                        <ExternalLink />
                      </a>
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
