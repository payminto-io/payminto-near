"use client";

import { RequirePermission } from "@/components/app/states";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRightLeft } from "lucide-react";
import { useApi, useCan } from "@/lib/session";
import { ok, useFeePlans, useMerchantMethods, useOperatorMerchant } from "@/lib/operator-queries";
import { useSwitchMerchant } from "@/components/app/merchant-switcher";
import { useToken } from "@/lib/queries";
import { describeFeePlan } from "@/lib/gateway";
import { formatDateTime, formatInt } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-title";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Address, Field, Fields, Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { FeePreview } from "@/components/operator/fee-preview";
import { MethodsEditor, type MethodRow } from "@/components/operator/methods-editor";
import { ChangePayout } from "@/components/operator/change-payout";

function MerchantDetailPagePage() {
  const { id } = useParams<{ id: string }>();
  const q = useOperatorMerchant(id);
  const plans = useFeePlans();
  const methods = useMerchantMethods(id);
  const api = useApi();
  const qc = useQueryClient();
  const switchTo = useSwitchMerchant();
  const can = useCan();
  const t = useToken();
  const [draft, setDraft] = useState<MethodRow[] | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  useDocumentTitle(q.data?.name ?? null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ok.all });
  const update = useMutation({ mutationFn: (patch: Parameters<typeof api.operator.updateMerchant>[1]) => api.operator.updateMerchant(id, patch), onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const saveMethods = useMutation({
    mutationFn: (rows: MethodRow[]) => api.operator.setMethods(id, rows),
    onSuccess: () => {
      toast.success("Methods saved. New payments are quoted with them.");
      setDraft(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const back = { href: "/platform/businesses", label: "Businesses" };

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-56 animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-24" />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Business" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const m = q.data;
  const plan = plans.data?.find((p) => p.id === m.fee_plan_id) ?? null;
  const rows = draft ?? methods.data?.map(({ merchant_id: _m, ...r }) => (void _m, r)) ?? [];

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {m.name} <Chip tone={m.status === "active" ? "positive" : "warning"}>{m.status === "active" ? "Active" : "Suspended"}</Chip>
          </span>
        }
        description={<span className="hash">{m.slug}</span>}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                switchTo(m.id);
                toast.success(`Opened ${m.name}`);
              }}
            >
              <ArrowRightLeft /> Open this business
            </Button>
            {!can("businesses.manage") ? null : m.status === "active" ? (
              <Button variant="outline" className="text-negative hover:text-negative" onClick={() => setSuspendOpen(true)}>
                Suspend
              </Button>
            ) : (
              <Button onClick={() => update.mutate({ status: "active" })} disabled={update.isPending}>
                Reactivate
              </Button>
            )}
          </>
        }
      />
      {m.status === "suspended" && <p className="mb-5 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">Suspended: checkouts and links for this business refuse new payments. Money already sent still reaches its payout wallet.</p>}
      <StatStrip
        stats={[
          { label: "Volume, 30 days", value: m.volume_30d ? <Money atomic={m.volume_30d} maxFraction={2} /> : "-" },
          { label: "Payments, 30 days", value: <span className="num">{m.payments_30d != null ? formatInt(m.payments_30d) : "-"}</span> },
          { label: "Pricing plan", value: plan?.name ?? "-", note: plan ? describeFeePlan(plan, t) : undefined },
        ]}
      />
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Panel
          title="Payment methods"
          description="Fees the platform sets per payment method, and who pays them"
          actions={
            draft && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Discard
                </Button>
                <Button size="sm" onClick={() => saveMethods.mutate(draft)} disabled={saveMethods.isPending}>
                  Save methods
                </Button>
              </>
            )
          }
        >
          {methods.isPending ? <BlockSkeleton className="h-64" /> : <MethodsEditor rows={rows} onChange={setDraft} editableFees={can("businesses.manage")} readOnly={!can("businesses.manage")} />}
        </Panel>
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Pricing plan" description="What the platform charges this business per payment.">
            <Select value={m.fee_plan_id} onValueChange={(v) => update.mutate({ fee_plan_id: v })} disabled={!can("pricing.manage")}>
              <SelectTrigger aria-label="Pricing plan" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(plans.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {describeFeePlan(p, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FeePreview className="mt-3" amount={25_000_000n} plan={plan} />
          </Panel>
          <Panel title="Payout wallet" description="The wallet where this business's money arrives." actions={can("payout.change", m.id) && <Button size="sm" variant="outline" onClick={() => setPayoutOpen(true)}>Change payout wallet</Button>}>
            <Fields>
              <Field label="Current"><Address address={m.payout} showName={false} /></Field>
              {(m.payout_history ?? []).map((h, i) => (
                <Field key={`${h.new_payout}-${h.changed_at}`} label={formatDateTime(h.changed_at)}>
                  <span className="flex flex-col items-start gap-0.5">
                    <Address address={h.new_payout} showName={false} className={i === 0 ? undefined : "text-muted-foreground"} />
                    <span className="text-xs text-muted-foreground">{h.old_payout ? "Changed, signed by the new wallet" : h.proven ? "Registered, signed by the wallet" : "Set at setup, no signature"}</span>
                  </span>
                </Field>
              ))}
            </Fields>
          </Panel>
          <Panel title="Profile">
            <Fields>
              <Field label="Business ID"><span className="hash text-[0.8125rem]">{m.id}</span></Field>
              <Field label="Support email">{m.support_email ?? <span className="text-muted-foreground">-</span>}</Field>
              <Field label="Brand color">{m.brand_color ? <span className="inline-flex items-center gap-2"><span className="size-4 rounded border" style={{ background: m.brand_color }} /> <span className="hash">{m.brand_color}</span></span> : <span className="text-muted-foreground">Default</span>}</Field>
              <Field label="Created">{formatDateTime(m.created_at)}</Field>
            </Fields>
          </Panel>
        </div>
      </div>
      {payoutOpen && <ChangePayout merchantId={m.id} onClose={() => setPayoutOpen(false)} />}
      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <DialogContent className="sm:max-w-[28rem]">
          <DialogHeader>
            <DialogTitle>Suspend {m.name}?</DialogTitle>
            <DialogDescription>Its checkouts, links and API keys refuse new payments until you reactivate it. Money already sent still reaches its payout wallet.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuspendOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: "suspended" }, { onSuccess: () => setSuspendOpen(false) })}
            >
              Suspend business
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function MerchantDetailPage() {
  return (
    <RequirePermission permission={"businesses.read"}>
      <MerchantDetailPagePage />
    </RequirePermission>
  );
}
