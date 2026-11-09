"use client";

import { RequirePermission } from "@/components/app/states";
/**
 * Settings > Platform > General (PRODUCT.md sections 3.5 and 10.9): platform name, platform fee wallet, default
 * pricing, sign-up rules, agent budgets, email and the recovery key. Platform admins see it read-only.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Mail, Send } from "lucide-react";
import { useAccess, useApi, useSession } from "@/lib/session";
import { ok, useFeePlans, usePlatform } from "@/lib/operator-queries";
import { useToken } from "@/lib/queries";
import { describeFeePlan } from "@/lib/gateway";
import type { PlatformPatch } from "@/lib/operator-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Address, Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

const SIGNUP_MODES = [
  { key: "off", label: "Invite only", hint: "Nobody can sign up. People join when an Admin invites them." },
  { key: "approval", label: "Sign up, then approval", hint: "Anyone can create an account and a business; it waits in Sign-up requests until you approve it." },
  { key: "open", label: "Open sign-up", hint: "Accounts and businesses are active as soon as the email is verified." },
] as const;

function PlatformSettingsPagePage() {
  const q = usePlatform();
  const plans = useFeePlans();
  const api = useApi();
  const { account, refresh } = useSession();
  const access = useAccess();
  const qc = useQueryClient();
  const t = useToken();
  const canEdit = access.can("platform.manage");
  const canPricing = access.can("pricing.manage");
  const [name, setName] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (patch: PlatformPatch) => api.operator.updatePlatform(patch),
    onSuccess: (_d, patch) => {
      toast.success(patch.name ? "Platform name saved. Checkout pages, emails and the sign-in screen use it now." : "Platform settings saved.");
      setName(null);
      void qc.invalidateQueries({ queryKey: ok.all });
      void refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const testEmail = useMutation({
    mutationFn: () => account.testEmail(),
    onSuccess: (r) => toast.success(r.delivered === "smtp" ? `Test email sent to ${access.session.user?.email ?? "you"}.` : "No email server is set up, so the test email is in the Email outbox."),
    onError: (e) => toast.error(e.message),
  });

  if (q.isPending) {
    return (
      <>
        <PageHeader title="Platform settings" />
        <div className="grid gap-5">
          <BlockSkeleton className="h-40" />
          <BlockSkeleton className="h-56" />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader title="Platform settings" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const p = q.data;
  const draftName = name ?? p.name;
  const mode = p.signup_mode ?? access.session.signupMode;
  const smtp = p.smtp_configured ?? access.session.smtpConfigured;
  const recovery = p.recovery_key_enabled ?? access.session.recoveryKeyEnabled;

  return (
    <>
      <PageHeader title="Platform settings" description={canEdit ? "How this Payminto server presents itself and who can join." : "Only the platform owner can change these settings."} />
      <div className="grid gap-5">
        <Panel title="General">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (draftName.trim() && draftName.trim() !== p.name) save.mutate({ name: draftName.trim() });
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
              <span className="font-medium">Platform name</span>
              <Input value={draftName} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canEdit} />
              <span className="text-xs text-muted-foreground">Shown on checkout pages, emails and the sign-in screen.</span>
            </label>
            {canEdit && (
              <Button type="submit" disabled={!draftName.trim() || draftName.trim() === p.name || save.isPending} className="sm:mb-5">
                Save name
              </Button>
            )}
          </form>
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Platform fee wallet" description="Where the platform fee from every payment arrives. It is set in the server's environment, so a stolen dashboard session cannot redirect it.">
            <Fields>
              <Field label="Wallet" hint="PLATFORM_FEE_ADDRESS in the server's environment.">
                {p.fee_recipient ? <Address address={p.fee_recipient} showName={false} /> : <span className="text-warning">Not set: every pricing plan must stay at zero fees</span>}
              </Field>
            </Fields>
          </Panel>
          <Panel title="Default pricing" description="The pricing plan new businesses start on.">
            <Select value={p.default_fee_plan_id} onValueChange={(v) => save.mutate({ default_fee_plan_id: v })} disabled={!canPricing}>
              <SelectTrigger aria-label="Default pricing plan" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(plans.data ?? []).map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name} - {describeFeePlan(plan, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Link href="/platform/pricing" className="mt-3 inline-block text-sm text-primary hover:underline">
              Pricing plans
            </Link>
          </Panel>
        </div>

        <Panel title="Sign-ups" description="Who can create an account and a business on this server.">
          <div role="radiogroup" aria-label="Sign-up mode" className="grid gap-2 sm:grid-cols-3">
            {SIGNUP_MODES.map((m) => {
              const checked = mode === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={!canEdit || save.isPending}
                  onClick={() => !checked && save.mutate({ signup_mode: m.key })}
                  className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-[border-color,background-color] duration-150 ease-out disabled:cursor-default ${checked ? "border-primary bg-accent/60" : "hover:bg-muted/60"}`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span aria-hidden className={`size-3.5 rounded-full border-2 ${checked ? "border-primary bg-primary shadow-[inset_0_0_0_2px_var(--card)]" : "border-input"}`} />
                    {m.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{m.hint}</span>
                </button>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel
            title="Email"
            actions={
              canEdit && (
                <Button size="sm" variant="outline" onClick={() => testEmail.mutate()} disabled={testEmail.isPending}>
                  <Send /> Send test email
                </Button>
              )
            }
          >
            <div className="flex items-start gap-3">
              <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="text-sm">
                <Chip tone={smtp ? "positive" : "warning"}>{smtp ? "Email server connected" : "No email server"}</Chip>
                <p className="mt-2 text-muted-foreground">
                  {smtp ? "Invites, password resets and receipts are sent by email." : "Emails are kept in the Email outbox instead, where the platform owner can copy each link. Set SMTP_URL on the server to send them."}
                </p>
                {!smtp && access.can("outbox.read") && (
                  <Link href="/platform/outbox" className="mt-2 inline-block text-primary hover:underline">
                    Open Email outbox
                  </Link>
                )}
              </div>
            </div>
          </Panel>
          <Panel title="Recovery key">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="text-sm">
                <Chip tone={recovery ? "negative" : "positive"}>{recovery ? "Enabled" : "Off"}</Chip>
                <p className="mt-2 text-muted-foreground">
                  {recovery
                    ? "Emergency access with the recovery key is on, and every use is written to the activity log. Turn ADMIN_TOKEN_BREAK_GLASS off on the server when you are done."
                    : "Emergency access for the server owner. It only works when someone with server access turns it on."}
                </p>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

export default function PlatformSettingsPage() {
  return (
    <RequirePermission permission={"platform.read"}>
      <PlatformSettingsPagePage />
    </RequirePermission>
  );
}
