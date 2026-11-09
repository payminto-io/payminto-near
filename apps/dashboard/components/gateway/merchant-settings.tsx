"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApi, useCan } from "@/lib/session";
import { useInfo } from "@/lib/queries";
import { gk, useMerchant } from "@/lib/gateway-queries";
import { ok, useMerchantMethods } from "@/lib/operator-queries";
import { normalizeBrandColor, safeRedirectUrl } from "@/lib/gateway";
import type { MerchantProfile } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Address, Field, Fields, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { MerchantMark } from "@/components/checkout/parts";
import { MethodsEditor, type MethodRow } from "@/components/operator/methods-editor";
import { ChangePayout } from "@/components/operator/change-payout";
import { FormRow } from "./kit";

function useBusiness() {
  return useMerchant();
}

function Loading({ h = "h-80" }: { h?: string }) {
  return <BlockSkeleton className={h} />;
}

/** Settings > Profile: what customers see on the checkout. Read-only without business.update. */
export function BusinessProfile() {
  const merchant = useBusiness();
  const can = useCan();
  if (merchant.isPending) return <Loading />;
  if (merchant.isError) return <ErrorState error={merchant.error} onRetry={() => void merchant.refetch()} />;
  return <ProfileForm key={merchant.data.id} m={merchant.data} readOnly={!can("business.update")} />;
}

/** Settings > Payout wallet: where money arrives, and the signed change (payout.change). */
export function PayoutSettings() {
  const merchant = useBusiness();
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (merchant.isPending) return <Loading h="h-56" />;
  if (merchant.isError) return <ErrorState error={merchant.error} onRetry={() => void merchant.refetch()} />;
  const m = merchant.data;
  return (
    <>
      <Panel
        title="Payout wallet"
        description="The wallet where your money arrives. Changing it needs a signature from the new wallet, so a stolen dashboard session cannot redirect your money."
        actions={
          can("payout.change") && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Change payout wallet
            </Button>
          )
        }
      >
        <Fields>
          <Field label="Payout wallet"><Address address={m.payout} showName={false} /></Field>
          <Field label="Checkout page address"><span className="hash text-[0.8125rem] break-all">{m.checkout_base_url}</span></Field>
        </Fields>
      </Panel>
      <Panel className="mt-5" title="Technical" description="Contracts this business is paid through, for developers and auditors.">
        <Fields>
          <Field label="Token"><Address address={m.token} showName={false} /></Field>
          <Field label="Payment address factory" hint="Creates the one-time payment addresses that can only forward to your wallet."><Address address={m.deposit_factory} showName={false} /></Field>
          <Field label="Payment router">{m.payment_router ? <Address address={m.payment_router} showName={false} /> : <span className="text-muted-foreground">Not reported</span>}</Field>
          <Field label="Chain id">{m.chain_id}</Field>
        </Fields>
      </Panel>
      {open && <ChangePayout merchantId={m.id} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Settings > Payment methods. */
export function MethodsSettings() {
  const merchant = useBusiness();
  if (merchant.isPending) return <Loading h="h-64" />;
  if (merchant.isError) return <ErrorState error={merchant.error} onRetry={() => void merchant.refetch()} />;
  return <MethodsPanel merchantId={merchant.data.id} />;
}

function ProfileForm({ m, readOnly }: { m: MerchantProfile; readOnly: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState(m.name);
  const [email, setEmail] = useState(m.support_email ?? "");
  const [color, setColor] = useState(m.brand_color ?? "");
  const [logo, setLogo] = useState(m.logo_url ?? "");
  const colorOk = !color.trim() || normalizeBrandColor(color) !== null;
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const logoOk = !logo.trim() || safeRedirectUrl(logo.trim())?.startsWith("https://") === true;
  const dirty = name !== m.name || email !== (m.support_email ?? "") || color !== (m.brand_color ?? "") || logo !== (m.logo_url ?? "");
  const save = useMutation({
    mutationFn: () => api.gateway.updateMerchant({ name: name.trim(), support_email: email.trim() || null, brand_color: normalizeBrandColor(color), logo_url: logo.trim() || null }),
    onSuccess: () => {
      toast.success("Profile saved. Your checkout page uses it straight away.");
      void qc.invalidateQueries({ queryKey: gk.merchant });
      void qc.invalidateQueries({ queryKey: ok.all });
    },
    onError: (e) => toast.error(e.message),
  });
  const preview = { name: name || "Your store", support_email: null, brand_color: normalizeBrandColor(color), logo_url: logoOk ? logo.trim() || null : null };
  return (
    <Panel title="Business profile" description={readOnly ? "What customers see on your checkout page. Only an Admin can change it." : "What customers see on your checkout page and payment links."}>
      <form
        className="flex flex-col gap-4 [&_fieldset]:contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && colorOk && emailOk && logoOk) save.mutate();
        }}
      >
        <fieldset disabled={readOnly}>
        <FormRow id="mp-name" label="Name">
          <Input id="mp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </FormRow>
        <FormRow id="mp-email" label="Support email" optional error={emailOk ? null : "Enter a valid email."}>
          <Input id="mp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormRow>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow id="mp-color" label="Brand color" optional error={colorOk ? null : "A hex color, e.g. #0f766e."}>
            <div className="flex gap-2">
              <Input id="mp-color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#0f766e" className="hash text-[0.8125rem]" />
              <span aria-hidden className="size-9 shrink-0 rounded-md border" style={{ background: normalizeBrandColor(color) ?? "transparent" }} />
            </div>
          </FormRow>
          <FormRow id="mp-logo" label="Logo URL" optional error={logoOk ? null : "An https:// image URL."}>
            <Input id="mp-logo" type="url" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://" />
          </FormRow>
        </div>
        </fieldset>
        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <span className="flex items-center gap-2 text-sm text-muted-foreground" style={preview.brand_color ? ({ "--brand": preview.brand_color } as React.CSSProperties) : undefined}>
            <MerchantMark merchant={preview} className="size-7 text-xs" /> Preview
          </span>
          {!readOnly && (
            <Button type="submit" disabled={!dirty || save.isPending}>
              Save profile
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

function MethodsPanel({ merchantId }: { merchantId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const methods = useMerchantMethods(merchantId);
  const [draft, setDraft] = useState<MethodRow[] | null>(null);
  const can = useCan();
  const save = useMutation({
    mutationFn: (rows: MethodRow[]) => api.operator.setMethods(merchantId, rows),
    onSuccess: () => {
      toast.success("Payment methods saved");
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ok.methods(merchantId) });
    },
    onError: (e) => toast.error(e.message),
  });
  const rows = draft ?? methods.data?.map(({ merchant_id: _m, ...r }) => (void _m, r)) ?? [];
  const hsp = useInfo().data?.gateway?.hspPayments;
  return (
    <Panel
      title="Payment methods"
      description={can("business.update") ? "Turn ways of paying on or off. Fees are set by the platform owner." : "Ways customers can pay you. Only an Admin can change them."}
      actions={
        draft && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button size="sm" onClick={() => save.mutate(draft)} disabled={save.isPending}>
              Save methods
            </Button>
          </>
        )
      }
    >
      {methods.isPending ? <BlockSkeleton className="h-48" /> : methods.isError ? <ErrorState error={methods.error} /> : <MethodsEditor rows={rows} onChange={setDraft} editableFees={false} readOnly={!can("business.update")} notes={{ hsp: <HspNote state={hsp} /> }} />}
    </Panel>
  );
}

/** Whether HashKey's HSP can take payments on this server now (GATEWAY.md section 17). */
function HspNote({ state }: { state: { state: string; message?: string | null; network?: string | null } | undefined }) {
  if (!state || state.state === "off") return <span className="text-muted-foreground">Not set up on this server. The server owner sets HSP_MCP_URL to offer it.</span>;
  if (state.state === "available") return <span className="text-positive">HSP is ready{state.network ? ` on ${state.network}` : ""}.</span>;
  if (state.state === "checking") return <span className="text-muted-foreground">Checking HSP access.</span>;
  return <span className="text-warning">{state.message ?? "HSP is not available right now."} Customers do not see it until it is.</span>;
}
