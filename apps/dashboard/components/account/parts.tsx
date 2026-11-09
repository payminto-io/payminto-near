"use client";

/** Shared pieces of the team, platform and records pages: no-access state, role chips and the invite dialog. */
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Info, Loader2, Lock, UserPlus } from "lucide-react";
import { useSession } from "@/lib/session";
import { authErrorText, type InviteResult, type InviteRole } from "@/lib/account";
import { ROLE_LABEL, ROLE_TOOLTIP, type RoleLabelKey } from "@/lib/permissions";
import { accountKeys } from "@/components/app/nav-badges";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/app/states";
import { PageHeader } from "@/components/app/primitives";
import { CopyButton } from "@/components/app/primitives";

export function NoAccess({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="rounded-xl border bg-card">
        <EmptyState icon={<Lock className="size-4" />} title="You do not have access to this page">
          Ask an Admin of this business, or the platform owner, if you need it.
        </EmptyState>
      </div>
    </>
  );
}

/** A role name with its plain explanation on hover (PRODUCT.md section 2.2). */
export function RoleChip({ role, className }: { role: RoleLabelKey; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium text-foreground", className)}>
          {ROLE_LABEL[role]}
          <Info className="size-3 text-subtle" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{ROLE_TOOLTIP[role]}</TooltipContent>
    </Tooltip>
  );
}

export function inviteRoleKey(role: InviteRole): RoleLabelKey {
  return role === "platform_admin" ? "platform_admin" : role;
}

/** Splits "a@x.com, b@y.com" or one per line into clean, unique emails. */
export function parseEmails(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const ok = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  return { valid: unique.filter(ok), invalid: unique.filter((e) => !ok(e)) };
}

/** Invite one or more people (PRODUCT.md 4.8, 10.8). Shows the result per email, with the link to copy. */
export function InviteDialog({
  open,
  onOpenChange,
  scope,
  roles,
  title,
  description,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Merchant id for a business team, null for the platform team. */
  scope: string | null;
  roles: InviteRole[];
  title: string;
  description: ReactNode;
}) {
  const { account } = useSession();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [role, setRole] = useState<InviteRole>(roles.includes("staff") ? "staff" : roles[0]!);
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const [touched, setTouched] = useState(false);
  const parsed = parseEmails(text);
  const send = useMutation({
    mutationFn: () => account.invite(scope, { emails: parsed.valid, role }),
    onSuccess: (r) => {
      setResults(r);
      const sent = r.filter((x) => x.ok).length;
      if (sent) toast.success(`${sent} invite${sent === 1 ? "" : "s"} sent.`);
      void qc.invalidateQueries({ queryKey: accountKeys.invites(scope) });
      void qc.invalidateQueries({ queryKey: accountKeys.outbox });
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setText("");
      setResults(null);
      setTouched(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {results ? (
          <ul className="stagger mt-2 divide-y rounded-lg border text-sm">
            {results.map((r) =>
              r.ok ? (
                <li key={r.invite.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.invite.email}</span>
                    <span className="block text-xs text-muted-foreground">Invited as {ROLE_LABEL[inviteRoleKey(r.invite.role)]}. The link works for 7 days.</span>
                  </span>
                  {r.invite.link && <CopyButton value={r.invite.link} label="invite link" />}
                </li>
              ) : (
                <li key={r.email} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.email}</span>
                    <span className="block text-xs text-negative">{authErrorText({ code: r.code, message: r.message })}</span>
                  </span>
                </li>
              ),
            )}
          </ul>
        ) : (
          <form
            id="invite-form"
            className="mt-2 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (parsed.valid.length && !parsed.invalid.length) send.mutate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="invite-emails" className="text-sm font-medium">
                Emails
              </label>
              <Textarea
                id="invite-emails"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"jordan@example.com\nmira@example.com"}
                rows={3}
                autoFocus
                aria-invalid={touched && (parsed.invalid.length > 0 || parsed.valid.length === 0)}
                aria-describedby="invite-emails-hint"
              />
              <p id="invite-emails-hint" className={cn("text-xs", touched && (parsed.invalid.length || !parsed.valid.length) ? "text-negative" : "text-muted-foreground")}>
                {touched && parsed.invalid.length
                  ? `Not an email: ${parsed.invalid.join(", ")}`
                  : touched && !parsed.valid.length
                    ? "Enter at least one email."
                    : "One per line, or separated by commas."}
              </p>
            </div>
            {roles.length > 1 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 text-sm font-medium">Role</legend>
                {roles.map((r) => {
                  const key = inviteRoleKey(r);
                  return (
                    <label
                      key={r}
                      className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-150 ease-out", role === r ? "border-primary bg-accent/60" : "hover:bg-muted/60")}
                    >
                      <input type="radio" name="invite-role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-1 accent-[var(--primary)]" />
                      <span>
                        <span className="block text-sm font-medium">{ROLE_LABEL[key]}</span>
                        <span className="block text-xs text-muted-foreground">{ROLE_TOOLTIP[key]}</span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </form>
        )}
        <DialogFooter className="mt-2">
          {results ? (
            <>
              <Button variant="outline" onClick={() => setResults(null)}>
                Invite more
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" form="invite-form" disabled={send.isPending}>
                {send.isPending ? <Loader2 className="animate-spin" /> : <UserPlus />}
                {parsed.valid.length > 1 ? `Send ${parsed.valid.length} invites` : "Send invite"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "3 min. ago" or a dash. */
export function Dash() {
  return <span className="text-subtle">-</span>;
}
