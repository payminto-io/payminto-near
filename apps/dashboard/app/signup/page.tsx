"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/http";
import { authErrorText, checkPassword } from "@/lib/account";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthCard, AuthLayout, FooterLink, NewPasswordField, Notice, StateCard, SubmitButton, TextField } from "@/components/auth/kit";

export default function SignupPage() {
  const { account } = useSession();
  const [form, setForm] = useState({ name: "", business: "", email: "", password: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof form | "form", string>>>({});
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"form" | "sent" | "disabled">("form");
  const [approval, setApproval] = useState(false);
  // Say it before anyone fills the form: sign-up can be off, or need the platform owner's approval.
  useEffect(() => {
    let off = false;
    account
      .setupInfo()
      .then((s) => {
        if (off) return;
        if (s.signupMode === "off") setState("disabled");
        setApproval(s.signupMode === "approval");
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [account]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = "Enter your name.";
    if (!form.business.trim()) next.business = "Enter the name of your business.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = "Enter a valid email.";
    const pw = checkPassword(form.password, form.email);
    if (!pw.ok) next.password = pw.message;
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await account.signup({ name: form.name.trim(), business_name: form.business.trim(), email: form.email.trim(), password: form.password });
      setState("sent");
    } catch (err) {
      if (err instanceof ApiError && err.code === "SIGNUP_DISABLED") setState("disabled");
      else if (err instanceof ApiError && err.code === "WEAK_PASSWORD") setErrors({ password: authErrorText(err) });
      else setErrors({ form: authErrorText(err, "Could not create the account. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  if (state === "disabled") {
    return (
      <AuthLayout>
        <StateCard
          tone="info"
          title="Sign-up is off on this server"
          action={
            <Button asChild variant="outline">
              <Link href="/login">Back to sign in</Link>
            </Button>
          }
        >
          Ask your platform owner for an invite. The invite link lets you create your account.
        </StateCard>
      </AuthLayout>
    );
  }
  if (state === "sent") {
    return (
      <AuthLayout>
        <StateCard
          tone="positive"
          title="Check your inbox"
          action={
            <Button asChild variant="outline">
              <Link href="/login">Back to sign in</Link>
            </Button>
          }
        >
          We sent a link to <span className="font-medium text-foreground">{form.email.trim()}</span>. Open it to verify your email and finish creating your account. If you already have an account, the email says so.
        </StateCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide>
      <AuthCard
        title="Create an account"
        description={
          approval
            ? "Set up a business on this Payminto server. The platform owner approves new businesses; payments go straight to your own wallet."
            : "Set up a business on this Payminto server. Payments go straight to your own wallet."
        }
      >
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {errors.form && <Notice tone="negative">{errors.form}</Notice>}
          <TextField label="Your name" autoFocus autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} />
          <TextField label="Business name" autoComplete="organization" value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} error={errors.business} />
          <TextField label="Work email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={errors.email} />
          <NewPasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} email={form.email} error={errors.password} />
          <SubmitButton busy={busy}>{busy ? "Creating your account" : "Create account"}</SubmitButton>
        </form>
      </AuthCard>
      <FooterLink>
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-2 hover:underline">
          Sign in
        </Link>
      </FooterLink>
    </AuthLayout>
  );
}
