"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ApiError } from "@/lib/http";
import { authErrorText, checkPassword, type InvitePreview } from "@/lib/account";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthCard, AuthLayout, NewPasswordField, Notice, StateCard, SubmitButton, TextField } from "@/components/auth/kit";

const ROLE: Record<string, string> = { admin: "Admin", staff: "Staff", viewer: "Viewer", platform_admin: "Platform admin" };

type State = { kind: "loading" } | { kind: "ready"; invite: InvitePreview } | { kind: "bad"; code: string } | { kind: "accepted"; where: string };

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const session = useSession();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ name?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const lookup = useCallback(() => {
    return session.account
      .inviteLookup(token)
      .then((invite) => setState({ kind: "ready", invite }))
      .catch((e) => setState({ kind: "bad", code: e instanceof ApiError ? e.code : "TOKEN_INVALID" }));
  }, [session.account, token]);

  useEffect(() => {
    void lookup();
  }, [lookup]);

  const accept = async (body: { name?: string; password?: string }) => {
    if (state.kind !== "ready") return;
    setBusy(true);
    setErrors({});
    try {
      const s = await session.account.acceptInvite({ token, ...body });
      setState({ kind: "accepted", where: state.invite.businessName ?? "this Payminto server" });
      await session.adopt(s);
      router.replace("/");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (["TOKEN_EXPIRED", "TOKEN_USED", "TOKEN_INVALID"].includes(code)) setState({ kind: "bad", code });
      else if (code === "WEAK_PASSWORD") setErrors({ password: authErrorText(err) });
      else if (code === "WRONG_ACCOUNT" || code === "SIGN_IN_REQUIRED") void lookup();
      else setErrors({ form: authErrorText(err, "Could not accept the invite. Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const onNew = (e: FormEvent) => {
    e.preventDefault();
    if (state.kind !== "ready") return;
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Enter your name.";
    const pw = checkPassword(password, state.invite.email);
    if (!pw.ok) next.password = pw.message;
    setErrors(next);
    if (Object.keys(next).length) return;
    void accept({ name: name.trim(), password });
  };

  const switchAccount = async () => {
    await session.signOut();
    setState({ kind: "loading" });
    void lookup();
  };

  if (state.kind === "loading") {
    return (
      <AuthLayout>
        <StateCard tone="neutral" title="Opening your invite" />
      </AuthLayout>
    );
  }
  if (state.kind === "accepted") {
    return (
      <AuthLayout>
        <StateCard tone="positive" title="You joined">
          Welcome to {state.where}. Opening Home.
        </StateCard>
      </AuthLayout>
    );
  }
  if (state.kind === "bad" || state.invite.status !== "pending") {
    const code = state.kind === "bad" ? state.code : state.invite.status;
    const title =
      code === "TOKEN_EXPIRED" || code === "expired"
        ? "This invite has expired"
        : code === "revoked"
          ? "This invite was revoked"
          : code === "TOKEN_USED" || code === "used"
            ? "This invite was already used"
            : "This invite link is not valid";
    return (
      <AuthLayout>
        <StateCard
          tone="negative"
          title={title}
          action={
            <Button asChild variant="outline">
              <Link href={session.status === "signed-in" ? "/" : "/login"}>{session.status === "signed-in" ? "Go to Home" : "Sign in"}</Link>
            </Button>
          }
        >
          Invites work once, for 7 days. Ask the person who invited you to send a new one.
        </StateCard>
      </AuthLayout>
    );
  }

  const inv = state.invite;
  const where = inv.platform ? "this Payminto server" : (inv.businessName ?? "a business");
  const role = ROLE[inv.role] ?? inv.role;
  const signedInAs = session.status === "signed-in" ? (session.session.user?.email ?? null) : inv.signedInAs;
  const description = (
    <>
      You were invited to <span className="font-medium text-foreground">{where}</span> as <span className="font-medium text-foreground">{role}</span>.
    </>
  );

  if (signedInAs && signedInAs.toLowerCase() !== inv.email.toLowerCase()) {
    return (
      <AuthLayout>
        <AuthCard title="This invite is for someone else" description={description}>
          <Notice tone="warning">
            The invite is for <span className="font-medium">{inv.email}</span>, but you are signed in as <span className="font-medium">{signedInAs}</span>.
          </Notice>
          <div className="flex flex-col gap-2">
            <Button onClick={() => void switchAccount()}>Sign out and continue</Button>
            <Button asChild variant="ghost">
              <Link href="/">Stay signed in as {signedInAs}</Link>
            </Button>
          </div>
        </AuthCard>
      </AuthLayout>
    );
  }

  if (signedInAs) {
    return (
      <AuthLayout>
        <AuthCard title="Accept your invite" description={description}>
          {errors.form && <Notice tone="negative">{errors.form}</Notice>}
          <Button className="w-full" disabled={busy} onClick={() => void accept({})}>
            {busy ? "Joining" : `Join ${where}`}
          </Button>
        </AuthCard>
      </AuthLayout>
    );
  }

  if (inv.userExists) {
    return (
      <AuthLayout>
        <AuthCard title="Sign in to accept" description={description}>
          <p className="mb-4 text-sm text-muted-foreground">
            There is already an account for <span className="font-medium text-foreground">{inv.email}</span>. Sign in, and you come straight back here.
          </p>
          <Button asChild className="w-full">
            <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
          </Button>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard title="Create your account" description={description}>
        <form onSubmit={onNew} noValidate className="space-y-4">
          {errors.form && <Notice tone="negative">{errors.form}</Notice>}
          <TextField label="Email" type="email" autoComplete="username" value={inv.email} readOnly disabled hint="The invite proves this inbox, so it is already verified." />
          <TextField label="Your name" autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
          <NewPasswordField value={password} onChange={setPassword} email={inv.email} error={errors.password} />
          <SubmitButton busy={busy}>{busy ? "Joining" : "Create account and join"}</SubmitButton>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
