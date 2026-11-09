"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, LogOut, MonitorSmartphone } from "lucide-react";
import { ApiError } from "@/lib/http";
import { authErrorText, checkPassword, describeDevice } from "@/lib/account";
import { ROLE_LABEL } from "@/lib/permissions";
import { useAccess, useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { TimeAgo } from "@/components/app/time-ago";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { NewPasswordField, Notice, TextField } from "@/components/auth/kit";

const SESSIONS_KEY = ["account", "sessions"] as const;

export default function AccountPage() {
  const access = useAccess();
  const user = access.session.user;
  if (!user) {
    return (
      <>
        <PageHeader title="Your account" />
        <EmptyState
          icon={<KeyRound className="size-4" />}
          title="Signed in with the recovery key"
        >
          The recovery key is emergency access for the server owner, not an account, so it has no profile, password or sessions. Sign in with your email to manage your account.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Your account" description="Your profile, password and the devices signed in as you." />
      <div className="grid gap-5 lg:grid-cols-2">
        <ProfilePanel />
        <PasswordPanel />
        <SessionsPanel />
      </div>
    </>
  );
}

function ProfilePanel() {
  const { account, refresh } = useSession();
  const access = useAccess();
  const user = access.session.user!;
  const [name, setName] = useState(user.name);
  const [sent, setSent] = useState(false);
  const save = useMutation({
    mutationFn: () => account.updateMe({ name: name.trim() }),
    onSuccess: async () => {
      await refresh();
      toast.success("Name saved.");
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const resend = useMutation({
    mutationFn: () => account.resendVerification(),
    onSuccess: () => {
      setSent(true);
      toast.success(`Verification link sent to ${user.email}.`);
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const roles = [
    user.platformRole ? (user.platformRole === "owner" ? ROLE_LABEL.platform_owner : ROLE_LABEL.platform_admin) : null,
    ...access.session.memberships.map((m) => `${ROLE_LABEL[m.role]} of ${m.name}`),
  ].filter(Boolean) as string[];
  const dirty = name.trim() !== user.name && name.trim().length > 0;
  return (
    <Panel title="Profile">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <TextField label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <Fields>
          <Field label="Email">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-all">{user.email}</span>
              {user.emailVerified ? <Chip tone="positive">Verified</Chip> : <Chip tone="warning">Not verified</Chip>}
            </span>
          </Field>
          {!user.emailVerified && (
            <Field label="">
              <Button type="button" variant="outline" size="sm" onClick={() => resend.mutate()} disabled={resend.isPending || sent}>
                {sent ? "Link sent" : "Resend verification link"}
              </Button>
            </Field>
          )}
          <Field label="Roles">{roles.length ? roles.join(", ") : "No business yet"}</Field>
        </Fields>
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving" : "Save name"}
        </Button>
      </form>
    </Panel>
  );
}

function PasswordPanel() {
  const { account, adopt } = useSession();
  const access = useAccess();
  const qc = useQueryClient();
  const email = access.session.user!.email;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!current) errs.current = "Enter your current password.";
    const pw = checkPassword(next, email);
    if (!pw.ok) errs.next = pw.message;
    if (confirm !== next) errs.confirm = "The two passwords do not match.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const s = await account.changePassword({ current_password: current, new_password: next });
      await adopt(s);
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Every other device was signed out.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") setErrors({ current: "That is not your current password." });
      else if (err instanceof ApiError && err.code === "WEAK_PASSWORD") setErrors({ next: authErrorText(err) });
      else setErrors({ form: authErrorText(err, "Could not change the password.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Password" description="Changing it signs out every other device.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {errors.form && <Notice tone="negative">{errors.form}</Notice>}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} />
        <NewPasswordField label="New password" value={next} onChange={setNext} email={email} error={errors.next} />
        <TextField label="Type the new password again" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Changing" : "Change password"}
        </Button>
      </form>
    </Panel>
  );
}

function SessionsPanel() {
  const session = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirmAll, setConfirmAll] = useState(false);
  const q = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => session.account.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => session.account.revokeSession(id),
    onSuccess: () => {
      toast.success("That device was signed out.");
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const others = useMutation({
    mutationFn: () => session.account.revokeOtherSessions(),
    onSuccess: (n) => {
      toast.success(n > 0 ? `Signed out ${n} other device${n === 1 ? "" : "s"}.` : "No other devices were signed in.");
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const everywhere = async () => {
    await session.signOut({ everywhere: true });
    router.replace("/login?reason=signed_out");
  };
  const rows = q.data ?? [];
  const hasOthers = rows.some((r) => !r.current);
  return (
    <section id="sessions" className="scroll-mt-24 lg:col-span-2">
      <Panel
        title="Sessions"
        description="Devices signed in as you. Sign out any you do not recognise."
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!hasOthers || others.isPending} onClick={() => others.mutate()}>
              Sign out everywhere else
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmAll(true)}>
              <LogOut aria-hidden /> Sign out everywhere
            </Button>
          </>
        }
        bodyClassName="p-0 sm:p-0"
      >
        {q.isPending ? (
          <RowsSkeleton rows={3} className="p-4" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-4" />
        ) : (
          <ul className="stagger divide-y">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-150 hover:bg-muted/40 sm:px-5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
                  <MonitorSmartphone className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {describeDevice(r.userAgent)}
                    {r.current && <Chip tone="info">This device</Chip>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="hash">{r.ip ?? "Unknown IP"}</span> - last active {r.lastSeenAt ? <TimeAgo iso={r.lastSeenAt} /> : "unknown"} - signed in <TimeAgo iso={r.createdAt} />
                  </p>
                </div>
                {!r.current && (
                  <Button variant="ghost" size="sm" disabled={revoke.isPending && revoke.variables === r.id} onClick={() => revoke.mutate(r.id)}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
            <AlertDialogDescription>Every device signed in as you, including this one, will need to sign in again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void everywhere()}>Sign out everywhere</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
