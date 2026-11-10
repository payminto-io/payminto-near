"use client";

/**
 * Shared pieces of the account screens (docs/PRODUCT.md section 4.13): a centered card on a quiet background, the
 * product mark and the three lines from section 1 on wide screens, and a network badge in the corner.
 */
import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { checkPassword } from "@/lib/account";
import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/account";
import { MOCK_MODE } from "@/lib/config";
import { requestJson } from "@/lib/http";
import { qk } from "@/lib/queries";
import { infoSchema } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/shell";

const LINES = ["Get paid in stablecoins by people and AI agents.", "Funds are escrowed in an unaudited contract on NEAR.", "Self-hosted on NEAR. Set up in minutes."];

/** The network for the corner badge, from the public GET /v1/info; nothing until the server answers, so it is never wrong. */
function useNetworkBadge(): { name: string; testnet: boolean } | null {
  // Signed-out pages have no API session, so this reads the public GET /v1/info directly.
  const info = useQuery({
    queryKey: [...qk.info, "public"],
    queryFn: () => requestJson(API_BASE, "/v1/info", infoSchema),
    enabled: !MOCK_MODE,
    staleTime: 60_000,
    retry: false,
  });
  if (MOCK_MODE) return { name: "NEAR testnet", testnet: true };
  if (!info.data) return null;
  return { name: info.data.network.name, testnet: info.data.network.testnet };
}

export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const net = useNetworkBadge();
  return (
    <div className="relative flex min-h-dvh bg-background">
      {net && (
        <span
          className={cn(
            "absolute top-4 right-4 inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
            net.testnet ? "border-warning/30 bg-warning-soft text-warning" : "bg-card text-muted-foreground",
          )}
        >
          <span className={cn("size-1.5 rounded-full", net.testnet ? "bg-warning" : "bg-positive")} aria-hidden />
          {net.name}
        </span>
      )}
      <aside className="hidden w-[26rem] shrink-0 flex-col justify-between border-r bg-rail px-10 py-10 lg:flex">
        <Link href="/login" className="flex items-center gap-2.5" aria-label="Payminto">
          <BrandMark />
          <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">Payminto</span>
        </Link>
        <div className="space-y-3">
          {LINES.map((l, i) => (
            <p key={l} className={cn("max-w-[22rem] text-balance", i === 0 ? "text-[1.375rem] leading-snug font-semibold tracking-[-0.015em]" : "text-[0.9375rem] text-muted-foreground")}>
              {l}
            </p>
          ))}
        </div>
        <p className="text-xs text-subtle">Payminto runs on your own server.</p>
      </aside>
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className={cn("page-in w-full", wide ? "max-w-[28rem]" : "max-w-[24rem]")}>
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <BrandMark className="size-8" />
            <span className="text-[0.9375rem] font-semibold">Payminto</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function AuthCard({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card p-6 shadow-xs", className)}>
      <h1 className="text-lg leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
      {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** One outcome (link sent, expired, verified): an icon, one headline, one sentence, one action. */
export function StateCard({ tone, title, children, action }: { tone: "positive" | "negative" | "neutral" | "info"; title: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === "positive" ? CheckCircle2 : tone === "negative" ? AlertCircle : tone === "info" ? Info : Loader2;
  return (
    <section className="rounded-xl border bg-card p-6 text-center shadow-xs">
      <span
        className={cn(
          "mx-auto flex size-11 items-center justify-center rounded-full",
          tone === "positive" ? "bg-positive-soft text-positive" : tone === "negative" ? "bg-negative-soft text-negative" : tone === "info" ? "bg-info-soft text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className={cn("size-5", tone === "neutral" && "animate-spin")} aria-hidden />
      </span>
      <h1 className="mt-4 text-lg font-semibold tracking-[-0.01em]">{title}</h1>
      {children && <div className="mt-1.5 text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-5 flex flex-col gap-2">{action}</div>}
    </section>
  );
}

export function Notice({ tone, children }: { tone: "info" | "warning" | "negative" | "positive"; children: ReactNode }) {
  return (
    <p
      role={tone === "negative" ? "alert" : "status"}
      className={cn(
        "mb-4 flex items-start gap-2 rounded-md px-3 py-2 text-sm",
        tone === "info" && "bg-info-soft text-foreground",
        tone === "warning" && "bg-warning-soft text-warning",
        tone === "negative" && "bg-negative-soft text-negative",
        tone === "positive" && "bg-positive-soft text-positive",
      )}
    >
      {tone === "negative" ? <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

export function TextField({
  label,
  error,
  hint,
  trailing,
  ...props
}: React.ComponentProps<typeof Input> & { label: string; error?: string | null; hint?: ReactNode; trailing?: ReactNode }) {
  const id = useId();
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {trailing}
      </div>
      <Input id={id} aria-invalid={Boolean(error) || undefined} aria-describedby={described} {...props} />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-negative">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const METER = ["bg-border", "bg-negative", "bg-warning", "bg-positive", "bg-positive"];

/** A new password with a show toggle and a strength meter (section 4.3: length rules only, paste allowed). */
export function NewPasswordField({ label = "Password", value, onChange, email, error, autoFocus }: { label?: string; value: string; onChange: (v: string) => void; email?: string; error?: string | null; autoFocus?: boolean }) {
  const id = useId();
  const [show, setShow] = useState(false);
  const check = checkPassword(value, email);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={`${id}-meter`}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-subtle transition-colors hover:text-foreground"
        >
          {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
      <div className="flex gap-1 pt-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors duration-200 ease-out", value && check.score >= i ? METER[check.score] : "bg-border")} />
        ))}
      </div>
      <p id={`${id}-meter`} className={cn("text-xs", error ? "text-negative" : "text-muted-foreground")} aria-live="polite">
        {error ?? check.message}
      </p>
    </div>
  );
}

export function SubmitButton({ busy, children, disabled }: { busy: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <Button type="submit" className="w-full" disabled={busy || disabled}>
      {busy && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}

export function FooterLink({ children }: { children: ReactNode }) {
  return <p className="mt-5 text-center text-sm text-muted-foreground">{children}</p>;
}
