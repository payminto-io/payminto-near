"use client";

import { RequirePermission } from "@/components/app/states";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { useApi } from "@/lib/session";
import { ok, useFeePlans, usePlatform } from "@/lib/operator-queries";
import { useToken } from "@/lib/queries";
import { describeFeePlan, normalizeBrandColor } from "@/lib/gateway";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { FormRow } from "@/components/gateway/kit";
import { FeePreview } from "@/components/operator/fee-preview";
import { DEFAULT_METHODS, METHOD_INFO, MethodsEditor, methodFeeText, type MethodRow } from "@/components/operator/methods-editor";
import { PayoutProofField, type PayoutProof } from "@/components/operator/payout-proof";

const STEPS = ["Profile", "Payout", "Pricing plan", "Methods", "Review"] as const;

function NewMerchantPagePage() {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const plans = useFeePlans();
  const platform = usePlatform();
  const t = useToken();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState("");
  const [color, setColor] = useState("");
  const [proof, setProof] = useState<PayoutProof | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [methods, setMethods] = useState<MethodRow[]>(DEFAULT_METHODS);
  const [busy, setBusy] = useState(false);
  // Until the operator picks one, the platform's default plan is selected, the same plan the node would apply.
  const defaultPlanId = platform.data?.default_fee_plan_id ?? plans.data?.[0]?.id;
  const plan = plans.data?.find((p) => p.id === (planId ?? defaultPlanId)) ?? plans.data?.[0] ?? null;

  const autoSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  const finalSlug = slugTouched ? slug : autoSlug;
  const slugOk = /^[a-z0-9][a-z0-9-]{1,31}$/.test(finalSlug);
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const colorOk = !color.trim() || normalizeBrandColor(color) !== null;
  const canNext = [name.trim() && slugOk && emailOk && colorOk, proof !== null, plan !== null, methods.some((m) => m.enabled), true][step];

  async function create() {
    if (!proof || !plan) return;
    setBusy(true);
    try {
      const m = await api.operator.createMerchant({
        name: name.trim(),
        slug: finalSlug,
        payout: proof.payout,
        fee_plan_id: plan.id,
        support_email: email.trim() || null,
        brand_color: normalizeBrandColor(color),
        payout_proof: { timestamp: proof.timestamp, signature: proof.signature },
        methods,
      });
      void qc.invalidateQueries({ queryKey: ok.all });
      toast.success(`${m.name} is ready to take payments`);
      router.push(`/platform/businesses/${m.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The business could not be created.");
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader back={{ href: "/platform/businesses", label: "Businesses" }} title="Add business" />
      <ol className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2" aria-current={i === step ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs font-medium",
                i < step ? "border-positive bg-positive text-white dark:text-background" : i === step ? "border-primary text-primary" : "text-muted-foreground",
              )}
            >
              {i < step ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-sm", i === step ? "font-medium" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-border sm:w-10" />}
          </li>
        ))}
      </ol>
      <Panel className="max-w-[44rem]" title={STEPS[step]}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canNext) return;
            if (step < STEPS.length - 1) setStep(step + 1);
            else void create();
          }}
        >
          {step === 0 && (
            <>
              <FormRow id="m-name" label="Business name">
                <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />
              </FormRow>
              <FormRow id="m-slug" label="Short name" hint="Used in web addresses for this business. Lowercase letters, digits and dashes." error={finalSlug && !slugOk ? "2 to 32 characters: a-z, 0-9 and dashes." : null}>
                <Input id="m-slug" value={finalSlug} onChange={(e) => (setSlug(e.target.value), setSlugTouched(true))} className="hash text-[0.8125rem]" />
              </FormRow>
              <FormRow id="m-email" label="Support email" optional hint="Shown to payers on the checkout." error={emailOk ? null : "Enter a valid email."}>
                <Input id="m-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormRow>
              <FormRow id="m-color" label="Brand color" optional hint="A hex color for the logo and pay button, e.g. #0f766e." error={colorOk ? null : "Use a hex color such as #0f766e."}>
                <div className="flex gap-2">
                  <Input id="m-color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#0f766e" className="hash text-[0.8125rem]" />
                  <span aria-hidden className="size-9 shrink-0 rounded-md border" style={{ background: normalizeBrandColor(color) ?? "transparent" }} />
                </div>
              </FormRow>
            </>
          )}
          {step === 1 && <PayoutProofField subject="new" value={proof} onChange={setProof} />}
          {step === 2 && (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_17rem]">
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Pricing plan</legend>
                {(plans.data ?? []).map((p) => (
                  <label key={p.id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm", plan?.id === p.id && "border-primary bg-accent/50")}>
                    <input type="radio" name="plan" checked={plan?.id === p.id} onChange={() => setPlanId(p.id)} className="mt-0.5 size-4 accent-primary" />
                    <span>
                      <span className="flex items-center gap-2 font-medium">
                        {p.name}
                        {p.id === platform.data?.default_fee_plan_id && <span className="text-xs font-normal text-muted-foreground">Default</span>}
                      </span>
                      <span className="text-muted-foreground">{describeFeePlan(p, t)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <FeePreview amount={25_000_000n} plan={plan} />
            </div>
          )}
          {step === 3 && <MethodsEditor rows={methods} onChange={setMethods} editableFees />}
          {step === 4 && (
            <Fields>
              <Field label="Name">{name}</Field>
              <Field label="Short name"><span className="hash">{finalSlug}</span></Field>
              <Field label="Support email">{email || <span className="text-muted-foreground">None</span>}</Field>
              <Field label="Brand color">
                {normalizeBrandColor(color) ? (
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden className="size-3.5 rounded-sm border" style={{ background: normalizeBrandColor(color)! }} />
                    <span className="hash">{normalizeBrandColor(color)}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Payminto default</span>
                )}
              </Field>
              <Field label="Payout">{proof && <span className="hash" title={proof.payout}>{shortAddress(proof.payout)}, signed</span>}</Field>
              <Field label="Pricing plan">{plan && `${plan.name}: ${describeFeePlan(plan, t)}`}</Field>
              <Field label="Methods">
                <span className="flex flex-col gap-0.5">
                  {methods.filter((m) => m.enabled).map((m) => (
                    <span key={m.method}>
                      {METHOD_INFO[m.method].label} <span className="text-muted-foreground">· {methodFeeText(m, t)}{(m.fee_bps || BigInt(m.fee_fixed)) ? `, ${m.bearer} pays` : ""}</span>
                    </span>
                  ))}
                </span>
              </Field>
            </Fields>
          )}
          <div className="mt-2 flex justify-between gap-2 border-t pt-4">
            {step === 0 ? (
              <Button asChild variant="ghost">
                <Link href="/platform/businesses">Cancel</Link>
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button type="submit" disabled={!canNext || busy}>
              {step < STEPS.length - 1 ? "Continue" : "Create business"}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}

export default function NewMerchantPage() {
  return (
    <RequirePermission permission={"businesses.manage"}>
      <NewMerchantPagePage />
    </RequirePermission>
  );
}
