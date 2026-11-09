"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/http";
import { authErrorText } from "@/lib/account";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthCard, AuthLayout, FooterLink, Notice, StateCard, SubmitButton, TextField } from "@/components/auth/kit";

export default function ForgotPage() {
  const { account } = useSession();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Enter a valid email.");
    setBusy(true);
    setError(null);
    setLimited(false);
    try {
      await account.forgot(email.trim());
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED") setLimited(true);
      else setError(authErrorText(err, "Could not send the link. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
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
          If an account exists for <span className="font-medium text-foreground">{email.trim()}</span>, we sent a link to reset the password. It works for 30 minutes.
        </StateCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard title="Reset your password" description="Enter the email you sign in with. We will send a link to choose a new password.">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {limited && <Notice tone="warning">Too many requests for this email. Wait a while and try again.</Notice>}
          <TextField label="Email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} error={error} />
          <SubmitButton busy={busy}>{busy ? "Sending" : "Send reset link"}</SubmitButton>
        </form>
      </AuthCard>
      <FooterLink>
        <Link href="/login" className="font-medium text-primary underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </FooterLink>
    </AuthLayout>
  );
}
