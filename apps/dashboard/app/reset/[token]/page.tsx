"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ApiError } from "@/lib/http";
import { authErrorText, checkPassword } from "@/lib/account";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthCard, AuthLayout, NewPasswordField, Notice, StateCard, SubmitButton, TextField } from "@/components/auth/kit";

type State = { kind: "checking" } | { kind: "form"; email: string } | { kind: "bad"; code: string } | { kind: "done" };

export default function ResetPage() {
  const { token } = useParams<{ token: string }>();
  const session = useSession();
  const [state, setState] = useState<State>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    session.account
      .resetCheck(token)
      .then((r) => !off && setState({ kind: "form", email: r.email }))
      .catch((e) => !off && setState({ kind: "bad", code: e instanceof ApiError ? e.code : "TOKEN_INVALID" }));
    return () => {
      off = true;
    };
  }, [session.account, token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (state.kind !== "form") return;
    const pw = checkPassword(password, state.email);
    const next: typeof errors = {};
    if (!pw.ok) next.password = pw.message;
    if (confirm !== password) next.confirm = "The two passwords do not match.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await session.account.reset(token, password);
      // A reset ends every session, this one included.
      if (session.status === "signed-in") await session.signOut();
      setState({ kind: "done" });
    } catch (err) {
      if (err instanceof ApiError && ["TOKEN_EXPIRED", "TOKEN_USED", "TOKEN_INVALID"].includes(err.code)) setState({ kind: "bad", code: err.code });
      else if (err instanceof ApiError && err.code === "WEAK_PASSWORD") setErrors({ password: authErrorText(err) });
      else setErrors({ form: authErrorText(err, "Could not change the password. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "checking") {
    return (
      <AuthLayout>
        <StateCard tone="neutral" title="Checking your link" />
      </AuthLayout>
    );
  }
  if (state.kind === "bad") {
    const title = state.code === "TOKEN_EXPIRED" ? "This link has expired" : state.code === "TOKEN_USED" ? "This link was already used" : "This link is not valid";
    return (
      <AuthLayout>
        <StateCard
          tone="negative"
          title={title}
          action={
            <Button asChild>
              <Link href="/forgot">Send a new link</Link>
            </Button>
          }
        >
          Reset links work once, for 30 minutes. Ask for a new one and use the newest email.
        </StateCard>
      </AuthLayout>
    );
  }
  if (state.kind === "done") {
    return (
      <AuthLayout>
        <StateCard
          tone="positive"
          title="Your password was changed"
          action={
            <Button asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          }
        >
          Every device was signed out. Sign in with your new password.
        </StateCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard title="Choose a new password" description={<>For <span className="font-medium text-foreground">{state.email}</span>. Every device will be signed out.</>}>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {errors.form && <Notice tone="negative">{errors.form}</Notice>}
          <input type="email" autoComplete="username" value={state.email} readOnly hidden />
          <NewPasswordField label="New password" autoFocus value={password} onChange={setPassword} email={state.email} error={errors.password} />
          <TextField label="Type it again" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
          <SubmitButton busy={busy}>{busy ? "Saving" : "Change password"}</SubmitButton>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
