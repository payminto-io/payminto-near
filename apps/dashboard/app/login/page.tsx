"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, KeyRound } from "lucide-react";
import { ApiError } from "@/lib/http";
import { authErrorText } from "@/lib/account";
import { MOCK_MODE } from "@/lib/config";
import { safeNext } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AuthCard, AuthLayout, FooterLink, Notice, SubmitButton, TextField } from "@/components/auth/kit";

export default function LoginPage() {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const reason = params.get("reason");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(session.status === "signed-out" && Boolean(session.unreachable));
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  // "Create an account" only when this server takes sign-ups (unknown until the server answers: shown, as before).
  const [signupOff, setSignupOff] = useState(false);
  // Demo accounts are loaded only in mock mode, so the mock server never ships in a real build.
  const [demo, setDemo] = useState<{ accounts: { email: string; label: string }[]; password: string } | null>(null);
  useEffect(() => {
    if (!MOCK_MODE) return;
    void import("@/lib/mock/accounts").then((m) => setDemo({ accounts: m.MOCK_ACCOUNTS, password: m.MOCK_PASSWORD }));
  }, []);

  // A server with no owner yet goes to first-run setup.
  useEffect(() => {
    let off = false;
    session.account
      .setupInfo()
      .then((s) => {
        if (off) return;
        if (s.needed) router.replace("/setup");
        setSignupOff(s.signupMode === "off");
      })
      .catch((e) => {
        if (!off && e instanceof ApiError && e.code === "NODE_UNREACHABLE") setUnreachable(true);
      });
    return () => {
      off = true;
    };
  }, [session.account, router]);

  const fail = (msg: string) => {
    setError(msg);
    setShake((n) => n + 1);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return fail("Enter your email and password.");
    setBusy(true);
    setError(null);
    try {
      const s = await session.account.login({ email: email.trim(), password });
      setUnreachable(false);
      await session.adopt(s);
      router.replace(next);
    } catch (err) {
      if (err instanceof ApiError && err.code === "NODE_UNREACHABLE") setUnreachable(true);
      fail(authErrorText(err, "Could not sign in. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function onRecovery(e: FormEvent) {
    e.preventDefault();
    if (!recoveryKey.trim()) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      await session.signInWithRecoveryKey(recoveryKey.trim());
      router.replace(next);
    } catch (err) {
      setRecoveryError(
        err instanceof ApiError && (err.code === "UNAUTHORIZED" || err.code === "INVALID_CREDENTIALS") ? "This recovery key was not accepted." : authErrorText(err, "Could not use the recovery key."),
      );
    } finally {
      setRecoveryBusy(false);
    }
  }

  return (
    <AuthLayout>
      <AuthCard title="Sign in to Payminto" description="Use the email and password for your account on this server.">
        {reason === "expired" && <Notice tone="info">Your session expired. Sign in again.</Notice>}
        {reason === "revoked" && <Notice tone="info">You were signed out on this device. Sign in again.</Notice>}
        {reason === "signed_out" && <Notice tone="positive">You are signed out.</Notice>}
        {unreachable && <Notice tone="warning">Cannot reach the Payminto server. Check that it is running, then try again.</Notice>}
        <form onSubmit={onSubmit} noValidate key={shake} className={cn("space-y-4", shake > 0 && "shake-x")}>
          <TextField label="Email" type="email" autoComplete="username" inputMode="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error}
            trailing={
              <Link href="/forgot" className="text-xs text-primary underline-offset-2 hover:underline">
                Forgot password?
              </Link>
            }
          />
          <SubmitButton busy={busy}>{busy ? "Signing in" : "Sign in"}</SubmitButton>
        </form>

        {demo && (
          <div className="mt-5 rounded-lg border border-dashed p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Demo accounts. Every one uses the password <span className="hash text-foreground">{demo.password}</span>
            </p>
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {demo.accounts.map((a) => (
                <button
                  key={a.email}
                  type="button"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(demo.password);
                    setError(null);
                  }}
                  className="rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-muted"
                >
                  <span className="block font-medium">{a.label}</span>
                  <span className="block truncate text-muted-foreground">{a.email}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 border-t pt-4">
          <button
            type="button"
            onClick={() => setRecoveryOpen((o) => !o)}
            aria-expanded={recoveryOpen}
            aria-controls="recovery-form"
            className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <KeyRound className="size-3.5" aria-hidden />
            <span className="flex-1">Use the recovery key</span>
            <ChevronDown className={cn("size-3.5 transition-transform duration-200 ease-out", recoveryOpen && "rotate-180")} aria-hidden />
          </button>
          <div id="recovery-form" className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", recoveryOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} inert={!recoveryOpen}>
            <div className="min-h-0 overflow-hidden">
              <form onSubmit={onRecovery} noValidate className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  Emergency access for the server owner, not a login. After setup it only works while the server runs with ADMIN_TOKEN_BREAK_GLASS turned on, and every use is written to the activity log.
                </p>
                <TextField label="Recovery key" type="password" autoComplete="off" spellCheck={false} className="hash" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} error={recoveryError} />
                <Button type="submit" variant="outline" size="sm" className="w-full" disabled={recoveryBusy || !recoveryKey.trim()}>
                  {recoveryBusy ? "Checking" : "Use recovery key"}
                </Button>
              </form>
            </div>
          </div>
        </div>
      </AuthCard>
      {signupOff ? (
        <FooterLink>New here? Ask the platform owner for an invite.</FooterLink>
      ) : (
        <FooterLink>
          New here?{" "}
          <Link href="/signup" className="font-medium text-primary underline-offset-2 hover:underline">
            Create an account
          </Link>
        </FooterLink>
      )}
    </AuthLayout>
  );
}
