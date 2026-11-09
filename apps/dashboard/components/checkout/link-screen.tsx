"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowRight, LoaderCircle, Mail, QrCode, Store, Wallet, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatToken } from "@/lib/format";
import { gatewayNetwork, parseAmountInput, plainAmount } from "@/lib/gateway";
import { amountPresets, rememberReceiptEmail } from "@/lib/checkout";
import { ApiError } from "@/lib/http";
import { useCheckoutApi } from "@/lib/use-checkout";
import type { PublicLink } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BigAmount, BrandButton, CheckoutLayout, MessageCard, NetworkChip, Notice, PaidDirectly, StateIcon, SummaryFrame } from "./parts";
import { RollingText, Shimmer, Stagger, StaggerItem, Swap, T } from "./motion";
import { NotFoundScreen, UnavailableScreen, useCheckoutTitle } from "./checkout";

export function LinkScreen({ slug }: { slug: string }) {
  const api = useCheckoutApi();
  const router = useRouter();
  const q = useQuery({
    queryKey: ["public-link", slug],
    queryFn: () => api!.link(slug),
    enabled: Boolean(api),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const info = useQuery({ queryKey: ["checkout-info"], queryFn: () => api!.info(), enabled: Boolean(api), staleTime: Infinity, retry: 1 });
  const [chosen, setChosen] = useState<bigint | null>(null);
  useCheckoutTitle(q.data ? `${q.data.title} - ${q.data.merchant.name}` : null);

  if (q.isError) {
    return q.error instanceof ApiError && q.error.status === 404 ? <NotFoundScreen what="link" /> : <UnavailableScreen error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (!q.data) {
    return (
      <CheckoutLayout
        merchant={null}
        summary={
          <div aria-busy="true" aria-label="Loading payment link">
            <div className="flex items-center gap-3">
              <Shimmer className="size-9 rounded-lg" />
              <Shimmer className="h-4 w-32" />
            </div>
            <Shimmer className="mt-10 h-4 w-40 max-lg:hidden" />
            <Shimmer className="mt-4 h-11 w-56 max-lg:hidden" />
          </div>
        }
        panel={
          <div aria-hidden>
            <Shimmer className="h-7 w-48 rounded-full" />
            <Shimmer className="mt-6 h-6 w-40" />
            <Shimmer className="mt-6 h-11 w-full rounded-xl" />
            <Shimmer className="mt-6 h-12 w-full rounded-xl" />
          </div>
        }
      />
    );
  }
  const link = q.data;
  const networkName = gatewayNetwork(link.chain_id, info.data).name;
  return (
    <CheckoutLayout
      merchant={link.merchant}
      summary={<LinkSummary link={link} networkName={networkName} chosen={chosen} />}
      panel={
        <LinkPanel
          link={link}
          networkName={networkName}
          onAmountChange={setChosen}
          onSubmit={async (body) => {
            const created = await api!.payFromLink(slug, body);
            if (body.email) rememberReceiptEmail(created.id, body.email);
            router.push(`/pay/${created.id}`);
          }}
        />
      }
    />
  );
}

type SummaryLink = Pick<PublicLink, "merchant" | "livemode" | "title" | "description" | "amount" | "min_amount" | "max_amount" | "token"> & { chain_id?: number };

function rangeText(link: Pick<PublicLink, "min_amount" | "max_amount" | "token">): string | null {
  const t = link.token;
  const f = (v: string) => formatToken(v, t.symbol, t.decimals);
  if (link.min_amount && link.max_amount) return `Between ${f(link.min_amount)} and ${f(link.max_amount)}`;
  if (link.min_amount) return `At least ${f(link.min_amount)}`;
  if (link.max_amount) return `Up to ${f(link.max_amount)}`;
  return null;
}

export function LinkSummary({ link, networkName, chosen = null }: { link: SummaryLink; networkName: string; chosen?: bigint | null }) {
  const t = link.token;
  const shown = link.amount !== null ? BigInt(link.amount) : chosen;
  const title = link.title || "Untitled link";
  const range = link.amount === null ? rangeText(link) : null;
  return (
    <SummaryFrame
      merchant={link.merchant}
      livemode={link.livemode}
      chainId={link.chain_id}
      compactTitle={title}
      compactAmount={shown !== null ? <RollingText text={formatToken(shown, t.symbol, t.decimals)} /> : <span className="text-sm font-medium text-muted-foreground">You choose</span>}
    >
      <Stagger>
        <StaggerItem>
          <p className="text-[0.9375rem] font-medium">{title}</p>
          {link.description && <p className="mt-1 max-w-[52ch] text-sm whitespace-pre-line text-muted-foreground">{link.description}</p>}
        </StaggerItem>
        <StaggerItem className="mt-3">
          <BigAmount atomic={shown} token={t} />
          {range && <p className="mt-2 text-sm text-muted-foreground">{range}</p>}
        </StaggerItem>
        <StaggerItem className="mt-6">
          <NetworkChip name={networkName} symbol={t.symbol} />
        </StaggerItem>
        <StaggerItem className="mt-7">
          <PaidDirectly merchant={link.merchant.name} />
        </StaggerItem>
      </Stagger>
    </SummaryFrame>
  );
}

type LinkBody = { amount?: string; email?: string; name?: string };
type PanelLink = Pick<PublicLink, "active" | "merchant" | "amount" | "min_amount" | "max_amount" | "collect_email" | "collect_name" | "token">;

/** Amount (when the payer chooses), email and name as the business configured, then one button to the checkout. */
export function LinkPanel({
  link,
  onSubmit,
  preview = false,
  networkName,
  onAmountChange,
}: {
  link: PanelLink;
  onSubmit?: (b: LinkBody) => Promise<void>;
  preview?: boolean;
  networkName?: string;
  /** The valid amount the payer has chosen so far (open-amount links), for the order column. */
  onAmountChange?: (atomic: bigint | null) => void;
}) {
  const t = link.token;
  const [amount, setAmount] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!link.active) {
    return (
      <MessageCard
        icon={
          <StateIcon tone="neutral">
            <XCircle />
          </StateIcon>
        }
        title="This payment link is no longer active"
        body={`${link.merchant.name} is not taking payments on this link. No money was taken.`}
      >
        {link.merchant.support_email ? (
          <Button asChild variant="outline" className="h-11 w-full rounded-xl">
            <a href={`mailto:${link.merchant.support_email}`}>
              <Mail /> Contact {link.merchant.name}
            </a>
          </Button>
        ) : (
          <p className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            <Store className="size-4" aria-hidden /> Ask {link.merchant.name} for a new link.
          </p>
        )}
      </MessageCard>
    );
  }

  const open = link.amount === null;
  const min = link.min_amount ? BigInt(link.min_amount) : null;
  const max = link.max_amount ? BigInt(link.max_amount) : null;
  const presets = open ? amountPresets(min, max, t.decimals) : [];
  const parsed = open ? parseAmountInput(amount, t.decimals, { min, max }) : null;
  const atomic = open ? (parsed?.ok ? parsed.atomic : null) : BigInt(link.amount!);
  const amountError = open && touched && parsed && !parsed.ok ? parsed.error : null;
  const fmt = (v: bigint) => formatToken(v, t.symbol, t.decimals);
  const choose = (text: string) => {
    setAmount(text);
    if (!onAmountChange) return;
    const r = parseAmountInput(text, t.decimals, { min, max });
    onAmountChange(r.ok ? r.atomic : null);
  };

  return (
    <form
      className="flex flex-col gap-5"
      noValidate={preview}
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (preview || !onSubmit || atomic === null) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ ...(open ? { amount: atomic.toString() } : {}), ...(link.collect_email ? { email: email.trim() } : {}), ...(link.collect_name ? { name: name.trim() } : {}) });
        } catch (err) {
          setError(err instanceof Error ? err.message : "The payment could not be started.");
          setBusy(false);
        }
      }}
    >
      {networkName && (
        <div className="flex min-h-8 items-center">
          <NetworkChip name={networkName} symbol={t.symbol} />
        </div>
      )}
      <div>
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{open ? "Choose an amount" : link.collect_email || link.collect_name ? "Your details" : "Ready to pay"}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Next you pay with your wallet, or send from any wallet or exchange.</p>
      </div>

      {open && (
        <fieldset className="flex flex-col gap-2.5">
          <legend className="sr-only">Amount</legend>
          {presets.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Suggested amounts">
              {presets.map((p) => {
                const on = atomic === p;
                return (
                  <button
                    key={p.toString()}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={preview}
                    onClick={() => {
                      choose(plainAmount(p, t.decimals));
                      setTouched(true);
                    }}
                    className={cn(
                      "relative h-11 rounded-xl border text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.98] motion-reduce:active:scale-100",
                      on ? "border-transparent text-[var(--brand-fg,var(--primary-foreground))]" : "hover:bg-muted",
                    )}
                  >
                    {on && <motion.span layoutId="preset-pill" className="absolute inset-0 rounded-xl bg-[var(--brand,var(--primary))]" transition={T.base} />}
                    <span className="num relative">{plainAmount(p, t.decimals)}</span>
                  </button>
                );
              })}
            </div>
          )}
          <Label htmlFor="link-amount" className="mt-1">
            {presets.length > 0 ? "Or enter an amount" : "Amount"}
          </Label>
          <div className="relative">
            <Input
              id="link-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              onChange={(e) => choose(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={Boolean(amountError)}
              aria-describedby="link-amount-hint"
              className="num h-12 rounded-xl pr-16 text-lg"
              disabled={preview}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-sm text-muted-foreground">{t.symbol}</span>
          </div>
          <p id="link-amount-hint" className={cn("min-h-4 text-xs", amountError ? "text-negative" : "text-muted-foreground")} aria-live="polite">
            {amountError ?? rangeText(link) ?? "Any amount"}
          </p>
        </fieldset>
      )}
      {link.collect_email && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="link-email">Email</Label>
          <Input id="link-email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 rounded-xl" disabled={preview} />
          <p className="text-xs text-muted-foreground">For your receipt. {link.merchant.name} sees it.</p>
        </div>
      )}
      {link.collect_name && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="link-name">Name</Label>
          <Input id="link-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="h-11 rounded-xl" disabled={preview} />
        </div>
      )}

      <ul className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <li className="flex items-center gap-2 rounded-xl border px-3 py-2.5">
          <Wallet className="size-4 shrink-0 text-[var(--ink)]" aria-hidden /> Pay with wallet, no network fee
        </li>
        <li className="flex items-center gap-2 rounded-xl border px-3 py-2.5">
          <QrCode className="size-4 shrink-0 text-[var(--ink)]" aria-hidden /> Send from any wallet or exchange
        </li>
      </ul>

      {error && (
        <Notice tone="negative" icon={<XCircle />}>
          {error} No money moved.
        </Notice>
      )}
      <div className="sticky bottom-0 z-10 -mx-1 bg-card px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] lg:static lg:pb-0">
        <BrandButton type="submit" disabled={busy || (!preview && open && touched && atomic === null)} tabIndex={preview ? -1 : undefined} className={cn(busy && "disabled:opacity-100")}>
          <Swap id={busy ? "busy" : atomic !== null ? "amount" : "none"} mode="popLayout" className="flex items-center gap-2">
            {busy ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden /> Starting your payment
              </>
            ) : atomic !== null ? (
              <>
                Continue to pay <RollingText text={fmt(atomic)} /> <ArrowRight aria-hidden />
              </>
            ) : (
              <>
                Continue to payment <ArrowRight aria-hidden />
              </>
            )}
          </Swap>
        </BrandButton>
        <p className="mt-2 text-center text-xs text-muted-foreground">Any payment method fee is shown as its own line before you pay.</p>
      </div>
    </form>
  );
}
