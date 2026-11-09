"use client";

import { RequirePermission } from "@/components/app/states";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Percent, Plus } from "lucide-react";
import { useApi, useCan } from "@/lib/session";
import { ok, useFeePlans, useMerchants, usePlatform } from "@/lib/operator-queries";
import { useToken } from "@/lib/queries";
import { describeFeePlan, parseAmountInput, parsePercentToBps, plainAmount } from "@/lib/gateway";
import type { FeePlan } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { FormRow, ListHead, Unit } from "@/components/gateway/kit";
import { FeePreview } from "@/components/operator/fee-preview";

const COLS = "md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_6rem_6rem]";

function FeePlansPagePage() {
  const plans = useFeePlans();
  const platform = usePlatform();
  const merchants = useMerchants();
  const t = useToken();
  const can = useCan();
  // Older servers do not count businesses per plan, so the list counts them from the businesses it already has.
  const countFor = (p: FeePlan) => p.merchant_count ?? p.merchants ?? merchants.data?.filter((m) => m.fee_plan_id === p.id).length ?? null;
  const [editing, setEditing] = useState<FeePlan | "new" | null>(null);
  return (
    <>
      <PageHeader
        title="Pricing plans"
        description={can("pricing.manage") ? "What the platform charges a business per payment. Fees are split off on chain in the same transaction that pays the business, so they can never be redirected." : "What the platform charges a business per payment. Only the platform owner can change pricing."}
        actions={
          can("pricing.manage") && (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New plan
            </Button>
          )
        }
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {plans.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : plans.isError ? (
          <ErrorState className="m-4" error={plans.error} onRetry={() => void plans.refetch()} />
        ) : plans.data.length === 0 ? (
          <EmptyState icon={<Percent className="size-4" />} title="No pricing plans" action={can("pricing.manage") ? <Button onClick={() => setEditing("new")}>Create a plan</Button> : undefined} />
        ) : (
          <>
            <ListHead cols={COLS}>
              <span>Plan</span>
              <span>Platform fee</span>
              <span className="text-right">Businesses</span>
              <span className="sr-only">Edit</span>
            </ListHead>
            <ul className="divide-y">
              {plans.data.map((p) => (
                <li key={p.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5 md:gap-4 ${COLS}`}>
                  <span className="flex items-center gap-2 font-medium">
                    {p.name} {platform.data?.default_fee_plan_id === p.id && <Chip tone="info" dot={false}>Default</Chip>}
                  </span>
                  <span className="text-muted-foreground max-md:col-start-1">{describeFeePlan(p, t)}</span>
                  <span className="num text-muted-foreground max-md:hidden md:text-right">{countFor(p) ?? "-"}</span>
                  <span className="justify-self-end max-md:col-start-2 max-md:row-start-1">
                    {can("pricing.manage") && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      {editing && <PlanDialog plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PlanDialog({ plan, onClose }: { plan: FeePlan | null; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
  const [name, setName] = useState(plan?.name ?? "");
  const [pct, setPct] = useState(plan ? String(plan.platform_fee_bps / 100) : "0.5");
  const [fixed, setFixed] = useState(plan && BigInt(plan.platform_fee_fixed) > 0n ? plainAmount(plan.platform_fee_fixed, t.decimals) : "");
  const [min, setMin] = useState(plan?.min_fee ? plainAmount(plan.min_fee, t.decimals) : "");
  const [max, setMax] = useState(plan?.max_fee ? plainAmount(plan.max_fee, t.decimals) : "");
  const [sample, setSample] = useState("25");
  const bps = parsePercentToBps(pct);
  const amt = (s: string) => (s.trim() ? parseAmountInput(s, t.decimals) : null);
  const zeroOk = (s: string) => (s.trim() === "0" ? ({ ok: true, atomic: 0n } as const) : amt(s));
  const f = zeroOk(fixed);
  const mn = zeroOk(min);
  const mx = amt(max);
  const errs = {
    name: !name.trim() ? "Name the plan." : null,
    pct: bps === null ? "A percentage from 0 to 10, up to 2 decimals." : null,
    fixed: f && !f.ok ? f.error : null,
    min: mn && !mn.ok ? mn.error : null,
    max: mx && !mx.ok ? mx.error : mn?.ok && mx?.ok && mx.atomic < mn.atomic ? "At least the minimum." : null,
  };
  const valid = !Object.values(errs).some(Boolean);
  // The preview needs only the fee fields, so it is live before the plan has a name.
  const feesValid = !errs.pct && !errs.fixed && !errs.min && !errs.max;
  const fees = feesValid
    ? { platform_fee_bps: bps!, platform_fee_fixed: (f?.ok ? f.atomic : 0n).toString(), min_fee: mn?.ok && mn.atomic > 0n ? mn.atomic.toString() : null, max_fee: mx?.ok ? mx.atomic.toString() : null }
    : null;
  const body = valid && fees ? { name: name.trim(), ...fees } : null;
  const s = parseAmountInput(sample, t.decimals);
  const save = useMutation({
    mutationFn: () => (plan ? api.operator.updateFeePlan(plan.id, body!) : api.operator.createFeePlan(body!)),
    onSuccess: () => {
      toast.success(plan ? "Pricing plan saved. New payments use it; existing ones keep their quote." : "Pricing plan created");
      void qc.invalidateQueries({ queryKey: ok.all });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>{plan ? `Edit ${plan.name}` : "New pricing plan"}</DialogTitle>
          <DialogDescription>Platform fee = fixed fee + amount × percent, kept between the minimum and maximum.</DialogDescription>
        </DialogHeader>
        <form
          id="plan-form"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="sm:col-span-2">
            <FormRow id="p-name" label="Name" error={name ? errs.name : null}>
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard" />
            </FormRow>
          </div>
          <FormRow id="p-pct" label="Percent" error={errs.pct}>
            <Unit unit="%">
              <Input id="p-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className="num pr-10" />
            </Unit>
          </FormRow>
          <FormRow id="p-fixed" label="Fixed fee" optional error={errs.fixed}>
            <Unit unit={t.symbol}>
              <Input id="p-fixed" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder="0.00" className="num pr-16" />
            </Unit>
          </FormRow>
          <FormRow id="p-min" label="Minimum fee" optional error={errs.min}>
            <Unit unit={t.symbol}>
              <Input id="p-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="None" className="num pr-16" />
            </Unit>
          </FormRow>
          <FormRow id="p-max" label="Maximum fee" optional error={errs.max}>
            <Unit unit={t.symbol}>
              <Input id="p-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="None" className="num pr-16" />
            </Unit>
          </FormRow>
        </form>
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr] sm:items-start">
          <FormRow id="p-sample" label="Example payment">
            <Unit unit={t.symbol}>
              <Input id="p-sample" inputMode="decimal" value={sample} onChange={(e) => setSample(e.target.value)} className="num pr-16" />
            </Unit>
          </FormRow>
          <FeePreview amount={s.ok ? s.atomic : 25_000_000n} plan={fees} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="plan-form" disabled={!valid || save.isPending}>
            {plan ? "Save plan" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FeePlansPage() {
  return (
    <RequirePermission permission={"pricing.read"}>
      <FeePlansPagePage />
    </RequirePermission>
  );
}
