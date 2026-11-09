"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/http";
import { authErrorText, checkPassword, type SetupInfo } from "@/lib/account";
import { MOCK_MODE } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useSession } from "@/lib/session";
import { AuthCard, AuthLayout, NewPasswordField, Notice, StateCard, SubmitButton, TextField } from "@/components/auth/kit";
import { Button } from "@/components/ui/button";

type Step = "loading" | "code" | "owner" | "done" | "already";

export default function SetupPage() {
  const session = useSession();
  const router = useRouter();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<{ text: string; done?: boolean } | null>(null);
  const [form, setForm] = useState({ platform: "", name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof form | "form", string>>>({});
  const [busy, setBusy] = useState(false);
  const [mockCode, setMockCode] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    session.account
      .setupInfo()
      .then((s) => {
        if (off) return;
        setInfo(s);
        setForm((f) => ({ ...f, platform: f.platform || s.platformName }));
        setStep(s.needed ? "code" : "already");
      })
      .catch(() => !off && setStep("code"));
    if (MOCK_MODE) void import("@/lib/mock/accounts").then((m) => !off && setMockCode(m.MOCK_SETUP_CODE));
    return () => {
      off = true;
    };
  }, [session.account]);

  async function onCode(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return setCodeError({ text: "Paste the setup code from the server log." });
    setBusy(true);
    setCodeError(null);
    try {
      await session.account.setupCheck(code.trim());
      setStep("owner");
    } catch (err) {
      setCodeError({ text: authErrorText(err, "Could not check the code."), done: err instanceof ApiError && err.code === "SETUP_DONE" });
    } finally {
      setBusy(false);
    }
  }

  async function onOwner(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = "Enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = "Enter a valid email.";
    const pw = checkPassword(form.password, form.email);
    if (!pw.ok) next.password = pw.message;
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const s = await session.account.setup({ code: code.trim(), platform_name: form.platform.trim() || undefined, name: form.name.trim(), email: form.email.trim(), password: form.password });
      setStep("done");
      await session.adopt(s);
      router.replace("/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "WEAK_PASSWORD") setErrors({ password: authErrorText(err) });
      else if (err instanceof ApiError && ["SETUP_CODE_INVALID", "SETUP_CODE_EXPIRED"].includes(err.code)) {
        setCodeError({ text: authErrorText(err) });
        setStep("code");
      } else setErrors({ form: authErrorText(err, "Could not finish setup. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  if (step === "loading") {
    return (
      <AuthLayout>
        <StateCard tone="neutral" title="Checking this server" />
      </AuthLayout>
    );
  }
  if (step === "already") {
    return (
      <AuthLayout>
        <StateCard
          tone="info"
          title="This server is already set up"
          action={
            <Button asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          }
        >
          The platform owner exists. Sign in with your email, or ask the owner for an invite.
        </StateCard>
      </AuthLayout>
    );
  }
  if (step === "done") {
    return (
      <AuthLayout>
        <StateCard tone="positive" title="Your server is ready">
          Opening Home.
        </StateCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide>
      <p className="mb-3 text-xs font-medium text-muted-foreground">Step {step === "code" ? 1 : 2} of 2</p>
      {step === "code" ? (
        <AuthCard title="Set up Payminto" description="Prove you control this server: copy the one-time setup code it printed to its log.">
          <form onSubmit={onCode} noValidate className="space-y-4">
            {codeError && (
              <Notice tone="negative">
                {codeError.text}{" "}
                {codeError.done && (
                  <Link href="/login" className="font-medium underline">
                    Sign in
                  </Link>
                )}
              </Notice>
            )}
            <TextField
              label="Setup code"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="hash uppercase"
              placeholder="ABCD-EFGH-..."
              value={code}
              onChange={(e) => setCode(e.target.value)}
              hint={
                <>
                  The log line reads <span className="hash">[setup] Open .../setup and enter code ...</span>. The server&apos;s ADMIN_TOKEN works too.
                  {mockCode && (
                    <>
                      {" "}
                      Demo code: <span className="hash text-foreground">{mockCode}</span>
                    </>
                  )}
                </>
              }
            />
            <SubmitButton busy={busy}>{busy ? "Checking" : "Continue"}</SubmitButton>
          </form>
        </AuthCard>
      ) : (
        <AuthCard title="Create the platform owner" description="You run this server, add businesses and set pricing. This account cannot be removed.">
          <form onSubmit={onOwner} noValidate className="space-y-4">
            {errors.form && <Notice tone="negative">{errors.form}</Notice>}
            <TextField label="Platform name" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} hint="Shown on checkout pages, emails and this sign-in screen. You can change it later." />
            <TextField label="Your name" autoFocus autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} />
            <TextField label="Email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={errors.email} />
            <NewPasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} email={form.email} error={errors.password} />
            {info && (info.network || info.feeWallet) && (
              <dl className="grid gap-1.5 rounded-lg bg-muted/60 p-3 text-xs">
                <p className="font-medium text-muted-foreground">Read from the server settings</p>
                {info.network?.name && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Network</dt>
                    <dd>{info.network.name}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Platform fee wallet</dt>
                  <dd className="hash">{info.feeWallet ? shortAddress(info.feeWallet) : "Not set"}</dd>
                </div>
                {info.payoutDefault && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Default payout wallet</dt>
                    <dd className="hash">{shortAddress(info.payoutDefault)}</dd>
                  </div>
                )}
              </dl>
            )}
            <SubmitButton busy={busy}>{busy ? "Creating your account" : "Finish setup"}</SubmitButton>
          </form>
        </AuthCard>
      )}
    </AuthLayout>
  );
}
