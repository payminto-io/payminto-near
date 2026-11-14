"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Inbox, Loader2, MailCheck, Send } from "lucide-react";
import { useAccess, useApi, useSession } from "@/lib/session";
import { ok, useFeePlans, usePlatform } from "@/lib/operator-queries";
import { useToken } from "@/lib/queries";
import { describeFeePlan } from "@/lib/gateway";
import { authErrorText, type SignupMode } from "@/lib/account";
import type { Platform } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Address, Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { BlockSkeleton, ErrorState, RequirePermission } from "@/components/app/states";
import { FeePreview } from "@/components/operator/fee-preview";
import { FormRow } from "@/components/gateway/kit";

const SIGNUP: { key: SignupMode; label: string; hint: string }[] = [
  { key: "off", label: "Invite only", hint: "Only people you invite can join. The platform team adds every business." },
  { key: "approval", label: "Ask to join", hint: "Anyone can ask for a business. A platform admin approves each one in Sign-up requests." },
  { key: "open", label: "Open", hint: "Anyone can sign up and start taking payments straight away." },
];

function PlatformSettingsPagePage() {
  const platform = usePlatform();
  const header = <PageHeader title="Platform" description="How this Payminto server presents itself, who can join, what it charges and how it sends email. Changes apply to every business." />;
  if (platform.isPending) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-5">
          <BlockSkeleton className="h-72" />
          <BlockSkeleton className="h-56" />
        </div>
      </>
    );
  }
  if (platform.isError) {
    return (
      <>
        {header}
        <ErrorState error={platform.error} onRetry={() => void platform.refetch()} />
      </>
    );
  }
  const p = platform.data;
  return (
    <>
      {header}
      <div className="flex flex-col gap-5">
        <GeneralForm key={`${p.name}|${p.signup_mode ?? "off"}`} p={p} />
        <PricingPanel p={p} />
        <div className="grid gap-5 lg:grid-cols-2">
          <EmailPanel p={p} />
          <AccessPanel p={p} />
        </div>
      </div>
    </>
  );
}

/** Platform name and sign-up mode (platform.manage). */
function GeneralForm({ p }: { p: Platform }) {
  const access = useAccess();
  const { refresh } = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const readOnly = !access.can("platform.manage");
  const [name, setName] = useState(p.name);
  const [mode, setMode] = useState<SignupMode>(p.signup_mode ?? "off");
  const nameError = name.trim() ? (name.trim().length > 120 ? "At most 120 characters." : null) : "Give the platform a name.";
  const dirty = name.trim() !== p.name || mode !== (p.signup_mode ?? "off");
  const save = useMutation({
    mutationFn: () => api.operator.updatePlatform({ ...(name.trim() !== p.name ? { name: name.trim() } : {}), ...(mode !== (p.signup_mode ?? "off") ? { signup_mode: mode } : {}) }),
    onSuccess: (next) => {
      qc.setQueryData(ok.platform, next);
      void qc.invalidateQueries({ queryKey: ok.platform });
      // The sidebar and the sign-in screens read the name and the sign-up mode from the session.
      void refresh();
      toast.success("Platform settings saved.");
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  return (
    <Panel title="General" description={readOnly ? "What people see when they sign in or join. Only the platform owner can change it." : "What people see when they sign in or join."}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nameError && dirty) save.mutate();
        }}
      >
        <fieldset disabled={readOnly} className="contents">
          <FormRow id="pf-name" label="Platform name" error={nameError} hint="Shown on the sign-in page, in emails and in the sidebar.">
            <Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-invalid={Boolean(nameError)} className="h-11 md:h-9" />
          </FormRow>
          <div className="flex flex-col gap-1.5">
            <span id="pf-signup" className="text-sm font-medium">
              Who can join
            </span>
            <div role="radiogroup" aria-labelledby="pf-signup" className="grid gap-2 md:grid-cols-3">
              {SIGNUP.map((o) => {
                const on = mode === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setMode(o.key)}
                    className={cn(
                      "flex min-h-11 flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ease-out focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60",
                      on ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted/60",
                    )}
                  >
                    <span className="text-sm font-medium">{o.label}</span>
                    <span className={cn("text-xs", on ? "text-accent-foreground/80" : "text-muted-foreground")}>{o.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </fieldset>
        {!readOnly && (
          <div className="flex justify-end border-t pt-4">
            <Button type="submit" disabled={!dirty || Boolean(nameError) || save.isPending} className="h-11 max-sm:w-full md:h-9">
              {save.isPending && <Loader2 aria-hidden className="animate-spin" />} Save changes
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

/** The default plan new businesses get (owner only) and the fee wallet, which the server's environment sets. */
function PricingPanel({ p }: { p: Platform }) {
  const access = useAccess();
  const api = useApi();
  const qc = useQueryClient();
  const plans = useFeePlans();
  const t = useToken();
  const canChange = access.can("platform.manage") && access.can("pricing.manage");
  const update = useMutation({
    mutationFn: (id: string) => api.operator.updatePlatform({ default_fee_plan_id: id }),
    onSuccess: (next) => {
      qc.setQueryData(ok.platform, next);
      void qc.invalidateQueries({ queryKey: ok.all });
      toast.success("Default pricing plan saved. New businesses start on it.");
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const plan = plans.data?.find((x) => x.id === p.default_fee_plan_id) ?? null;
  return (
    <Panel
      title="Pricing"
      description={canChange ? "The plan every new business starts on. Existing businesses keep theirs." : "The plan every new business starts on. Only the platform owner can change it."}
      actions={
        access.can("pricing.read") && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/platform/pricing">
              Pricing plans <ArrowRight />
            </Link>
          </Button>
        )
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="flex min-w-0 flex-col gap-5">
          <FormRow id="pf-plan" label="Default pricing plan">
            {plans.isPending ? (
              <BlockSkeleton className="h-11 md:h-9" />
            ) : plans.isError ? (
              <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
            ) : (
              <Select value={p.default_fee_plan_id} onValueChange={(v) => v !== p.default_fee_plan_id && update.mutate(v)} disabled={!canChange || update.isPending}>
                <SelectTrigger id="pf-plan" aria-label="Default pricing plan" className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.data.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.name} · {describeFeePlan(x, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormRow>
          <Fields>
            <Field label="Fee wallet" hint="The NEAR account platform fees are paid to. It comes from PLATFORM_FEE_ACCOUNT in the server's environment; change it there and restart the server.">
              {p.fee_recipient ? (
                <Address address={p.fee_recipient} showName={false} />
              ) : (
                <span className="flex flex-col gap-0.5">
                  <Chip tone="warning">Not set</Chip>
                  <span className="text-xs text-muted-foreground">Every fee stays at zero until the server names a fee wallet.</span>
                </span>
              )}
            </Field>
          </Fields>
        </div>
        <FeePreview amount={25_000_000n} plan={plan} className="h-fit" />
      </div>
    </Panel>
  );
}

/** SMTP configured, or every email waits in the Email outbox. */
function EmailPanel({ p }: { p: Platform }) {
  const access = useAccess();
  const { account, session } = useSession();
  const me = session?.user?.email ?? null;
  const test = useMutation({
    mutationFn: () => account.testEmail(),
    onSuccess: (r) => (r.delivered === "smtp" ? toast.success(`Test email sent to ${me}.`) : toast.message("The test email is in the Email outbox.")),
    onError: (e) => toast.error(authErrorText(e)),
  });
  const smtp = p.smtp_configured === true;
  return (
    <Panel title="Email" description="Invites, email checks and password resets.">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", smtp ? "bg-positive-soft text-positive" : "bg-warning-soft text-warning")}>
          {smtp ? <MailCheck className="size-4" aria-hidden /> : <Inbox className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <Chip tone={smtp ? "positive" : "warning"}>{smtp ? "SMTP configured" : "Outbox only"}</Chip>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {smtp
              ? "Emails go out through your email server."
              : "No email server is set up, so emails wait in the Email outbox and you pass the links on yourself. Set SMTP_URL in the server's environment to send them."}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 max-sm:flex-col max-sm:[&>*]:h-11">
        {smtp && access.can("platform.manage") && me && (
          <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />} Send a test email to me
          </Button>
        )}
        {!smtp && access.can("outbox.read") && (
          <Button asChild variant="outline" size="sm">
            <Link href="/platform/outbox">
              <Inbox aria-hidden /> Open Email outbox
            </Link>
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** How people sign in to the platform; all from the server's environment, so shown, not edited. */
function AccessPanel({ p }: { p: Platform }) {
  return (
    <Panel title="Sign-in and recovery" description="Set in the server's environment.">
      <Fields>
        <Field label="Two-step sign-in" hint="Whether platform owners and admins must use a second step when they sign in.">
          {p.require_2fa_platform ? <Chip tone="positive">Required for platform roles</Chip> : <span className="text-muted-foreground">Not required</span>}
        </Field>
        <Field label="Recovery key" hint="Emergency access for the server owner when nobody can sign in. It is not a login.">
          {p.recovery_key_enabled ? <Chip tone="neutral">On</Chip> : <span className="text-muted-foreground">Off</span>}
        </Field>
        <Field label="Dashboard address">{p.dashboard_url ? <span className="hash break-all text-[0.8125rem]">{p.dashboard_url}</span> : <span className="text-muted-foreground">Not set</span>}</Field>
      </Fields>
    </Panel>
  );
}

export default function PlatformSettingsPage() {
  return (
    <RequirePermission permission={"platform.read"}>
      <PlatformSettingsPagePage />
    </RequirePermission>
  );
}
