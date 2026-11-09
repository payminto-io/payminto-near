"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Monitor, Smartphone } from "lucide-react";
import { toHex } from "viem";
import { useApi } from "@/lib/session";
import { gk, useMerchant } from "@/lib/gateway-queries";
import { chainIdOf, useInfo, useToken } from "@/lib/queries";
import { gatewayNetwork, linkExpiry, parseAmountInput, safeRedirectUrl, type ExpiryChoice } from "@/lib/gateway";
import { ExpiryField } from "@/components/gateway/link-expiry";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, Panel } from "@/components/app/primitives";
import { CheckoutLayout } from "@/components/checkout/parts";
import { LinkPanel, LinkSummary } from "@/components/checkout/link-screen";
import { FormRow, Segmented } from "@/components/gateway/kit";
import { ScaledFrame } from "@/components/gateway/scaled-frame";

export default function NewLinkPage() {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const t = useToken();
  const info = useInfo();
  const merchant = useMerchant();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"fixed" | "open">("fixed");
  const [amount, setAmount] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [description, setDescription] = useState("");
  const [successUrl, setSuccessUrl] = useState("");
  // Off by default: the checkout already offers an optional receipt email after the pay controls (DESIGN_REFERENCES Gateway 1).
  const [collectEmail, setCollectEmail] = useState(false);
  const [collectName, setCollectName] = useState(false);
  const [listed, setListed] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [maxPayments, setMaxPayments] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [expiryCustom, setExpiryCustom] = useState("");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [idem] = useState(() => toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2));

  const fixed = kind === "fixed" ? parseAmountInput(amount, t.decimals) : null;
  const minP = kind === "open" && min ? parseAmountInput(min, t.decimals) : null;
  const maxP = kind === "open" && max ? parseAmountInput(max, t.decimals) : null;
  const rangeError = minP?.ok && maxP?.ok && minP.atomic > maxP.atomic ? "The maximum must be at least the minimum." : null;
  const redirect = successUrl.trim();
  const redirectError = redirect && (!safeRedirectUrl(redirect) || (!redirect.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(redirect))) ? "Use an https:// address." : null;
  const maxPay = maxPayments.trim() ? Number(maxPayments) : null;
  const maxPayError = maxPay !== null && (!Number.isInteger(maxPay) || maxPay < 1) ? "A whole number of 1 or more." : null;
  const errors = {
    title: !title.trim() ? "Give the link a title." : null,
    amount: kind === "fixed" && fixed && !fixed.ok ? fixed.error : null,
    min: minP && !minP.ok ? minP.error : null,
    max: maxP && !maxP.ok ? maxP.error : rangeError,
  };
  const exp = linkExpiry(expiry, expiryCustom);
  const expiryError = exp.ok ? null : exp.error;
  const valid = !errors.title && !errors.amount && !errors.min && !errors.max && !redirectError && !maxPayError && !expiryError;

  const brand = merchant.data ?? { name: "Your business", support_email: null, brand_color: null, logo_url: null, livemode: false };
  const preview = {
    merchant: { name: brand.name, support_email: brand.support_email, brand_color: brand.brand_color, logo_url: brand.logo_url },
    livemode: brand.livemode,
    chain_id: chainIdOf(info.data) || undefined,
    title: title.trim() || "Untitled link",
    description: description.trim() || null,
    // A fixed link with no amount typed yet previews as 0.00 rather than flipping to "Customer chooses".
    amount: kind === "fixed" ? (fixed?.ok ? fixed.atomic.toString() : "0") : null,
    min_amount: minP?.ok ? minP.atomic.toString() : null,
    max_amount: maxP?.ok ? maxP.atomic.toString() : null,
    collect_email: collectEmail,
    collect_name: collectName,
    active: true,
    token: { address: info.data?.token.address ?? "0x0000000000000000000000000000000000000000", symbol: t.symbol, decimals: t.decimals },
  };
  const network = gatewayNetwork(chainIdOf(info.data), info.data);

  async function create() {
    setSubmitted(true);
    if (!valid || busy) return;
    setBusy(true);
    try {
      const l = await api.gateway.createLink(
        {
          title: title.trim(),
          description: description.trim() || undefined,
          amount: kind === "fixed" && fixed?.ok ? fixed.atomic.toString() : null,
          min_amount: minP?.ok ? minP.atomic.toString() : null,
          max_amount: maxP?.ok ? maxP.atomic.toString() : null,
          collect_email: collectEmail,
          collect_name: collectName,
          success_url: redirect || null,
          max_payments: maxPay,
          listed,
          // Recomputed at submit so "24 hours" counts from now, not from when the form opened.
          expires_at: (() => {
            const e = linkExpiry(expiry, expiryCustom);
            return e.ok ? e.iso : null;
          })(),
        },
        idem,
      );
      void qc.invalidateQueries({ queryKey: gk.links });
      toast.success("Payment link created");
      router.push(`/links/${l.id}?share=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The link could not be created.");
      setBusy(false);
    }
  }

  const show = (e: string | null) => (submitted ? e : null);

  return (
    <>
      <PageHeader
        back={{ href: "/links", label: "Payment links" }}
        title="New payment link"
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/links">Cancel</Link>
            </Button>
            <Button onClick={() => void create()} disabled={busy || (submitted && !valid)}>
              Create link
            </Button>
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Panel>
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <FormRow id="l-title" label="Title" error={show(errors.title)} hint="What the customer sees, e.g. Pro plan, monthly.">
              <Input id="l-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} aria-invalid={Boolean(show(errors.title))} />
            </FormRow>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Amount type</span>
              <Segmented
                label="Amount type"
                value={kind}
                onChange={setKind}
                className="w-full"
                options={[
                  { key: "fixed", label: "Fixed amount" },
                  { key: "open", label: "Customer chooses" },
                ]}
              />
            </div>
            {kind === "fixed" ? (
              <FormRow id="l-amount" label="Amount" error={amount || submitted ? errors.amount : null} hint={`Paid in ${t.symbol} on ${network.name}.`}>
                <Suffix symbol={t.symbol}>
                  <Input id="l-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" className="num pr-16" aria-invalid={Boolean(errors.amount && (amount || submitted))} />
                </Suffix>
              </FormRow>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <FormRow id="l-min" label="Minimum" optional error={errors.min}>
                  <Suffix symbol={t.symbol}>
                    <Input id="l-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="1.00" className="num pr-16" />
                  </Suffix>
                </FormRow>
                <FormRow id="l-max" label="Maximum" optional error={errors.max}>
                  <Suffix symbol={t.symbol}>
                    <Input id="l-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="500.00" className="num pr-16" />
                  </Suffix>
                </FormRow>
              </div>
            )}
            <FormRow id="l-desc" label="Description" optional>
              <Textarea id="l-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} />
            </FormRow>
            <FormRow id="l-redirect" label="Redirect after payment" optional error={redirectError} hint="The customer returns here 5 seconds after paying, with a visible countdown.">
              <Input id="l-redirect" type="url" value={successUrl} onChange={(e) => setSuccessUrl(e.target.value)} placeholder="https://example.com/thanks" />
            </FormRow>
            <ExpiryField choice={expiry} custom={expiryCustom} onChoice={setExpiry} onCustom={setExpiryCustom} error={submitted || expiryCustom ? expiryError : null} />
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-medium">Ask the customer for</legend>
              <Toggle id="l-email" checked={collectEmail} onChange={setCollectEmail} label="Email" hint="For the receipt; you see it on the payment." />
              <Toggle id="l-name" checked={collectName} onChange={setCollectName} label="Name" />
            </fieldset>
            <Toggle id="l-listed" checked={listed} onChange={setListed} label="Listed for AI agents" hint="Agents can find this link and its price automatically." />
            <div className="border-t pt-4">
              <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
                <ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} aria-hidden /> Advanced
              </button>
              {advanced && (
                <div className="mt-4">
                  <FormRow id="l-maxpay" label="Maximum number of payments" optional error={maxPayError} hint="The link shows as no longer active once this many payments were made.">
                    <Input id="l-maxpay" inputMode="numeric" value={maxPayments} onChange={(e) => setMaxPayments(e.target.value)} placeholder="Unlimited" />
                  </FormRow>
                </div>
              )}
            </div>
            <button type="submit" className="sr-only">
              Create link
            </button>
          </form>
        </Panel>

        <section aria-label="Preview" className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Preview</p>
            <div role="radiogroup" aria-label="Preview size" className="inline-flex rounded-md border p-0.5">
              {(
                [
                  ["desktop", Monitor, "Desktop"],
                  ["phone", Smartphone, "Phone"],
                ] as const
              ).map(([k, Icon, label]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={device === k}
                  aria-label={label}
                  onClick={() => setDevice(k)}
                  className={cn("flex size-7 items-center justify-center rounded", device === k ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border bg-muted/40 p-3 sm:p-4">
            <div aria-hidden inert className={cn("mx-auto overflow-hidden rounded-lg border bg-background shadow-sm", device === "phone" ? "max-w-[390px]" : "max-w-full")}>
              <ScaledFrame width={device === "phone" ? 390 : 1040}>
                <div className="@container">
                  <CheckoutLayout preview merchant={preview.merchant} summary={<LinkSummary link={preview} networkName={network.name} />} panel={<LinkPanel link={preview} preview />} />
                </div>
              </ScaledFrame>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Suffix({ symbol, children }: { symbol: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{symbol}</span>
    </div>
  );
}

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
