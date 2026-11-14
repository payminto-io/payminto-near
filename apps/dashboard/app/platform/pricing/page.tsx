"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Percent, Plus, TriangleAlert } from "lucide-react";
import { useApi, useCan } from "@/lib/session";
import { ok, useFeePlans, usePlatform } from "@/lib/operator-queries";
import { useToken } from "@/lib/queries";
import { formatBps } from "@/lib/gateway";
import { formatInt, formatToken, plural } from "@/lib/format";
import { authErrorText } from "@/lib/account";
import { exampleFee, EXAMPLE_AMOUNT, planDraft, planPatch, validatePlan, type PlanDraft, type PlanErrors } from "@/lib/fee-plans";
import type { FeePlan } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InfoTip, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RequirePermission, RowsSkeleton } from "@/components/app/states";
import { FormRow, ListHead, Unit } from "@/components/gateway/kit";
import { FeePreview } from "@/components/operator/fee-preview";

const COLS = "md:grid-cols-[minmax(0,1.4fr)_5rem_7rem_minmax(0,1fr)_6.5rem_8rem_10.5rem]";
const businessesOn = (p: FeePlan) => p.merchant_count ?? p.merchants ?? null;

function PricingPagePage() {
  const plans = useFeePlans();
  const platform = usePlatform();
  const can = useCan();
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
  const [editing, setEditing] = useState<FeePlan | "new" | null>(null);
  const manage = can("pricing.manage");
  const canDefault = manage && can("platform.manage");
  const makeDefault = useMutation({
    mutationFn: (id: string) => api.operator.updatePlatform({ default_fee_plan_id: id }),
    onSuccess: (next) => {
      qc.setQueryData(ok.platform, next);
      void qc.invalidateQueries({ queryKey: ok.all });
      toast.success("Default plan saved. New businesses start on it.");
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const defaultId = platform.data?.default_fee_plan_id ?? null;
  const noWallet = platform.data !== undefined && !platform.data.fee_recipient;
  const amount = (v: string | null | undefined) => (v && BigInt(v) > 0n ? formatToken(v, t.symbol, t.decimals) : null);

  return (
    <>
      <PageHeader
        title="Pricing plans"
        description="What the platform charges a business on each payment, taken from what the business receives. Payminto itself charges no processing fee."
        actions={
          manage && (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New plan
            </Button>
          )
        }
      />
      {noWallet && manage && (
        <p role="note" className="mb-5 flex items-start gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>No fee wallet is set, so the server keeps every fee at zero. Set PLATFORM_FEE_ACCOUNT in its environment and restart it before you charge a fee.</span>
        </p>
      )}
      <Panel bodyClassName="p-0 sm:p-0">
        {plans.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : plans.isError ? (
          <ErrorState className="m-4" error={plans.error} onRetry={() => void plans.refetch()} />
        ) : plans.data.length === 0 ? (
          <EmptyState icon={<Percent className="size-4" />} title="No pricing plans yet" action={manage ? <Button onClick={() => setEditing("new")}>Create the first plan</Button> : undefined}>
            A plan sets the percent and fixed fee a business pays per payment.
          </EmptyState>
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Plan</span>
              <span className="text-right">Percent</span>
              <span className="text-right">Fixed fee</span>
              <span>Limits</span>
              <span className="flex items-center gap-1">
                Paid by <InfoTip>The platform fee always comes out of what the business receives. A payment method fee can be passed to the customer, per business, under Payment methods.</InfoTip>
              </span>
              <span className="text-right">On {formatToken(EXAMPLE_AMOUNT, t.symbol, t.decimals)}</span>
              <span className="sr-only">Actions</span>
            </ListHead>
            <ul className="divide-y">
              {plans.data.map((p) => {
                const n = businessesOn(p);
                const ex = exampleFee(p);
                const limits = [amount(p.min_fee) && `at least ${amount(p.min_fee)}`, p.max_fee !== null && `at most ${formatToken(p.max_fee, t.symbol, t.decimals)}`].filter(Boolean).join(", ");
                const isDefault = p.id === defaultId;
                return (
                  <li key={p.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-sm sm:px-5 md:gap-4 ${COLS}`}>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        {isDefault && <Chip tone="positive">Default</Chip>}
                      </span>
                      <span className="block text-xs text-muted-foreground">{n === null ? "-" : `${formatInt(n)} ${plural(n, "business", "businesses")}`}</span>
                      {/* Phones: the figures in one line under the name. */}
                      <span className="mt-1 block text-xs text-muted-foreground md:hidden">
                        {formatBps(p.platform_fee_bps)}
                        {amount(p.platform_fee_fixed) ? ` + ${amount(p.platform_fee_fixed)}` : ""}
                        {limits ? `, ${limits}` : ""}, paid by the business
                      </span>
                    </span>
                    <span className="num text-right max-md:hidden">{formatBps(p.platform_fee_bps)}</span>
                    <span className="num text-right text-muted-foreground max-md:hidden">{amount(p.platform_fee_fixed) ?? "-"}</span>
                    <span className="truncate text-muted-foreground max-md:hidden">{limits || "-"}</span>
                    <span className="text-muted-foreground max-md:hidden">Business</span>
                    <span className="num text-right max-md:row-start-1 max-md:col-start-2 max-md:self-start">
                      {ex ? formatToken(ex.fee, t.symbol, t.decimals) : "-"}
                      <span className="block text-xs text-muted-foreground md:hidden">on {formatToken(EXAMPLE_AMOUNT, t.symbol, t.decimals)}</span>
                    </span>
                    <span className="flex flex-wrap justify-end gap-1 max-md:col-span-2 max-md:justify-start max-md:[&>*]:h-11">
                      {canDefault && !isDefault && (
                        <Button variant="ghost" size="sm" onClick={() => makeDefault.mutate(p.id)} disabled={makeDefault.isPending}>
                          Make default
                        </Button>
                      )}
                      {manage && (
                        <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                          Edit
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>
      {editing && <PlanDialog key={editing === "new" ? "new" : editing.id} plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Create or edit a plan. The server asks for the password again before it saves (step-up). */
function PlanDialog({ plan, onClose }: { plan: FeePlan | null; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
  const [draft, setDraft] = useState<PlanDraft>(() => planDraft(plan, t.decimals));
  const [shown, setShown] = useState<PlanErrors>({});
  const checked = validatePlan(draft, t.decimals);
  const set = (k: keyof PlanDraft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    // Once a field has shown an error, it clears as soon as the text is right.
    if (shown[k]) setShown((s) => ({ ...s, [k]: undefined }));
  };
  const n = plan ? businessesOn(plan) : null;
  const save = useMutation({
    mutationFn: async () => {
      if (!checked.ok) throw new Error("Fix the fields first.");
      if (!plan) return api.operator.createFeePlan(checked.body);
      const patch = planPatch(plan, checked.body);
      return Object.keys(patch).length ? api.operator.updateFeePlan(plan.id, patch) : plan;
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ok.all });
      toast.success(plan ? `${p.name} saved. New payments are charged with it.` : `${p.name} created.`);
      onClose();
    },
    onError: (e) => toast.error(authErrorText(e)),
  });
  const err = (k: keyof PlanDraft) => shown[k] ?? null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[34rem]">
        <DialogHeader>
          <DialogTitle>{plan ? `Edit ${plan.name}` : "New pricing plan"}</DialogTitle>
          <DialogDescription>
            {plan && n ? `${formatInt(n)} ${plural(n, "business", "businesses")} use this plan. Payments created after you save are charged with the new fees.` : "The platform fee on each payment: a percent, a fixed amount, or both, with an optional least and most."}
          </DialogDescription>
        </DialogHeader>
        <form
          id="plan-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!checked.ok) {
              setShown(checked.errors);
              return;
            }
            save.mutate();
          }}
          noValidate
        >
          <FormRow id="plan-name" label="Name" error={err("name")}>
            <Input id="plan-name" value={draft.name} onChange={set("name")} maxLength={120} placeholder="Standard" aria-invalid={Boolean(err("name"))} className="h-11 md:h-9" autoFocus />
          </FormRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow id="plan-percent" label="Percent" error={err("percent")} hint="0 to 10, up to 2 decimals.">
              <Unit unit="%">
                <Input id="plan-percent" inputMode="decimal" value={draft.percent} onChange={set("percent")} placeholder="1" aria-invalid={Boolean(err("percent"))} className="num h-11 pr-8 md:h-9" />
              </Unit>
            </FormRow>
            <FormRow id="plan-fixed" label="Fixed fee" optional error={err("fixed")}>
              <Unit unit={t.symbol}>
                <Input id="plan-fixed" inputMode="decimal" value={draft.fixed} onChange={set("fixed")} placeholder="0.00" aria-invalid={Boolean(err("fixed"))} className="num h-11 pr-14 md:h-9" />
              </Unit>
            </FormRow>
            <FormRow id="plan-min" label="Least fee" optional error={err("min")}>
              <Unit unit={t.symbol}>
                <Input id="plan-min" inputMode="decimal" value={draft.min} onChange={set("min")} placeholder="0.00" aria-invalid={Boolean(err("min"))} className="num h-11 pr-14 md:h-9" />
              </Unit>
            </FormRow>
            <FormRow id="plan-max" label="Most fee" optional error={err("max")} hint="Blank for no cap.">
              <Unit unit={t.symbol}>
                <Input id="plan-max" inputMode="decimal" value={draft.max} onChange={set("max")} placeholder="No cap" aria-invalid={Boolean(err("max"))} className="num h-11 pr-14 md:h-9" />
              </Unit>
            </FormRow>
          </div>
          <FeePreview amount={EXAMPLE_AMOUNT} plan={checked.ok ? checked.body : null} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11 md:h-9">
            Cancel
          </Button>
          <Button type="submit" form="plan-form" disabled={save.isPending} className="h-11 md:h-9">
            {save.isPending && <Loader2 aria-hidden className="animate-spin" />} {plan ? "Save plan" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PricingPage() {
  return (
    <RequirePermission permission={"pricing.read"}>
      <PricingPagePage />
    </RequirePermission>
  );
}
