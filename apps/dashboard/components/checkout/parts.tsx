"use client";

import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Clock3, Copy, ExternalLink, LockKeyhole, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { testMoneyLabel } from "@/lib/disclosures";
import { useNetworkId, useNetworkWords } from "@/lib/use-network-words";
import { formatToken } from "@/lib/format";
import { brandVars, countdownLabel, countdownTone, formatCountdown, secondsLeft } from "@/lib/checkout";
import type { CheckoutLive } from "@/lib/use-checkout";
import type { MerchantBrand, Token } from "@/lib/schemas";
import { useNow } from "@/components/app/time-ago";
import { Bar, CheckoutMotion, PulseDot, RollingText, T, useCalm, useToast } from "./motion";
import { AccountText } from "@/components/ds/account-id";

/**
 * Building blocks of the hosted checkout, link page and payment proof. They take plain props (no console session), so
 * the dashboard can render the same pieces as a live preview while a business creates a link.
 */

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * Brand variables for a subtree. The business colour fills the pay button and draws rings and accents only where it
 * keeps 3:1 contrast with the card in that theme (`--ink`), so a pale or very dark brand never disappears.
 */
export function brandStyle(color: string | null | undefined): CSSProperties {
  return brandVars(color) as CSSProperties;
}

const INK = "[--ink:var(--brand-ink,var(--primary))] dark:[--ink:var(--brand-ink-dark,var(--primary))]";

/** True inside the dashboard's live preview, where breakpoints follow the preview frame, not the window. */
const PreviewContext = createContext(false);
export const usePreview = () => useContext(PreviewContext);

/**
 * One card, two columns at 1024px and up: the order on a brand-tinted left, the pay panel on the right. Below that it
 * is one column: a compact order bar that opens to the full breakdown, then the pay panel. The order column is the
 * same element in every state, so the amount never moves.
 */
export function CheckoutLayout({
  merchant,
  summary,
  panel,
  className,
  preview = false,
  single = false,
}: {
  merchant: MerchantBrand | null;
  summary: ReactNode;
  panel: ReactNode;
  className?: string;
  /** Rendered inside the dashboard: fills its container instead of the viewport. */
  preview?: boolean;
  /** One centred card with no order column (not found, server unreachable). */
  single?: boolean;
}) {
  const calm = useCalm();
  const wide = preview ? "@min-[860px]" : "lg";
  return (
    <CheckoutMotion>
      <PreviewContext.Provider value={preview}>
        <div style={brandStyle(merchant?.brand_color)} className={cn("flex flex-col bg-background", INK, preview ? "min-h-full" : "min-h-dvh", className)}>
          <main className={cn("flex-1 px-4 pt-4 pb-6 sm:px-6", preview ? "@min-[860px]:py-12" : "sm:pt-8 lg:py-16")}>
            <motion.div
              initial={calm || preview ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
              className={cn(
                "mx-auto w-full overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-[0_1px_2px_rgb(14_23_38/0.04),0_12px_40px_-16px_rgb(14_23_38/0.18)] dark:shadow-none",
                single ? "max-w-md" : cn("max-w-[920px]", preview ? "@min-[860px]:grid @min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]" : "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,26.5rem)]"),
              )}
            >
              {!single && (
                <section
                  aria-label="Order summary"
                  className={cn(
                    "min-w-0 border-b bg-[color-mix(in_srgb,var(--brand,var(--primary))_6%,var(--card))] px-4 py-3.5 sm:px-6",
                    wide === "lg" ? "lg:border-r lg:border-b-0 lg:px-10 lg:py-10" : "@min-[860px]:border-r @min-[860px]:border-b-0 @min-[860px]:px-10 @min-[860px]:py-10",
                  )}
                >
                  {summary}
                </section>
              )}
              <section aria-label="Payment" className={cn("min-w-0 px-4 py-5 sm:px-6", wide === "lg" ? "lg:px-8 lg:py-8" : "@min-[860px]:px-8 @min-[860px]:py-8")}>
                {panel}
              </section>
            </motion.div>
          </main>
          <CheckoutFooter supportEmail={merchant?.support_email ?? null} />
        </div>
      </PreviewContext.Provider>
    </CheckoutMotion>
  );
}

export function CheckoutFooter({ supportEmail }: { supportEmail: string | null }) {
  const words = useNetworkWords();
  return (
    <footer className="pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-[920px] flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-4 pt-1 pb-6 text-xs text-muted-foreground sm:px-6">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
          <LockKeyhole className="size-3.5" aria-hidden /> Secured by Payminto
        </span>
        <span aria-hidden className="text-subtle max-sm:hidden">
          ·
        </span>
        <span className="max-sm:basis-full max-sm:text-center">{words.escrowShort}</span>
        {supportEmail && (
          <>
            <span aria-hidden className="text-subtle max-sm:hidden">
              ·
            </span>
            <a href={`mailto:${supportEmail}`} className="rounded underline-offset-2 hover:text-foreground hover:underline max-sm:basis-full max-sm:text-center">
              Need help? {supportEmail}
            </a>
          </>
        )}
      </div>
    </footer>
  );
}

/** The business logo, or its initial on the brand colour. */
export function MerchantMark({ merchant, className }: { merchant: MerchantBrand; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (merchant.logo_url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a business-hosted logo on an arbitrary origin
      <img src={merchant.logo_url} alt="" onError={() => setBroken(true)} className={cn("size-9 shrink-0 rounded-lg border bg-card object-contain", className)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand,var(--primary))] text-[0.9375rem] font-semibold text-[var(--brand-fg,var(--primary-foreground))]", className)}
    >
      {merchant.name.trim().slice(0, 1).toUpperCase() || "P"}
    </span>
  );
}

export function MerchantRow({ merchant, livemode, className }: { merchant: MerchantBrand; livemode: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <MerchantMark merchant={merchant} />
      <span className="min-w-0 truncate text-[0.9375rem] font-semibold">{merchant.name}</span>
      <TestnetBadge livemode={livemode} />
    </div>
  );
}

/** The test-money label for the network the server runs on: "Local sandbox" on a sandbox, "Testnet" otherwise off live mode. */
export function networkBadgeLabel(livemode: boolean, networkId: string | null = null): string | null {
  return testMoneyLabel(livemode, networkId);
}

/** `compact` (the phone order bar) says only "Test", so the business name keeps its room. */
export function TestnetBadge({ livemode = false, compact = false }: { livemode?: boolean; compact?: boolean }) {
  const full = networkBadgeLabel(livemode, useNetworkId());
  const label = full && compact ? (full === "Local sandbox" ? "Local" : "Test") : full;
  if (!label) return null;
  return (
    <span className="inline-flex h-[1.375rem] shrink-0 items-center rounded-full bg-warning-soft px-2 text-xs font-medium whitespace-nowrap text-warning" title={`${full ?? ""}: test money, nothing here has real value.`}>
      {label}
    </span>
  );
}

/** The largest element on the page: "25.00 USDC", rolling its digits when a re-quote changes it. */
export function BigAmount({ atomic, token, network, label, pending = false }: { atomic: string | bigint | null; token: Token; network?: string; label?: ReactNode; pending?: boolean }) {
  const [num, sym] = atomic === null ? [null, token.symbol] : splitToken(formatToken(atomic, token.symbol, token.decimals));
  return (
    <div>
      {label && <p className="mb-1.5 text-sm text-muted-foreground">{label}</p>}
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        {num !== null ? (
          <span className={cn("text-[2.25rem] leading-none font-semibold tracking-[-0.025em] transition-opacity duration-200 sm:text-[2.75rem]", pending && "opacity-50")}>
            <RollingText text={num} />
            <span className="ml-2 text-[0.5em] font-medium tracking-normal text-muted-foreground">{sym}</span>
          </span>
        ) : (
          <span className="text-[1.75rem] leading-none font-semibold tracking-[-0.02em] sm:text-[2rem]">Choose an amount</span>
        )}
        {network && <NetworkChip name={network} />}
      </p>
    </div>
  );
}

function splitToken(text: string): [string, string] {
  const i = text.lastIndexOf(" ");
  return [text.slice(0, i), text.slice(i + 1)];
}

/** "USDC on NEAR testnet", with the token and chain marks. */
export function NetworkChip({ name, symbol, className }: { name: string; symbol?: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2 pr-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground", className)}>
      {symbol && <TokenMark symbol={symbol} className="size-4" />}
      {symbol ? `${symbol} on` : "on"}
      <ChainMark className="size-3.5" />
      <span className="text-foreground/90">{name}</span>
    </span>
  );
}

/** A plain coin mark with the token's first letters; no third-party logo. */
export function TokenMark({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[#2775ca] text-[0.5rem] leading-none font-bold text-white", className)}>
      {symbol.slice(0, 1)}
    </span>
  );
}

/** A small hexagon standing in for the chain; decorative. */
export function ChainMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("shrink-0", className)}>
      <path d="M8 1.2 13.9 4.6v6.8L8 14.8 2.1 11.4V4.6Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M5.6 6v4M10.4 6v4M5.6 8h4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** "25.00 USDC" in running text. */
export function TokenAmount({ atomic, token, className }: { atomic: string | bigint; token: Token; className?: string }) {
  return <span className={cn("num font-medium whitespace-nowrap", className)}>{formatToken(atomic, token.symbol, token.decimals)}</span>;
}

// ---------------------------------------------------------------------------
// Order column
// ---------------------------------------------------------------------------

/**
 * The order column's frame: on phones a compact bar (logo, name, total) that opens to the full breakdown; from 1024px
 * (or in the wide preview) the full breakdown always.
 */
export function SummaryFrame({ merchant, livemode, compactTitle, compactAmount, children }: { merchant: MerchantBrand; livemode: boolean; compactTitle: string; compactAmount: ReactNode; children: ReactNode }) {
  const preview = usePreview();
  const [open, setOpen] = useState(false);
  const calm = useCalm();
  const wideOnly = preview ? "hidden @min-[860px]:block" : "hidden lg:block";
  const narrowOnly = preview ? "@min-[860px]:hidden" : "lg:hidden";
  return (
    <>
      <div className={narrowOnly}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="order-details"
          className="flex w-full items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <MerchantMark merchant={merchant} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{merchant.name}</span>
              <TestnetBadge livemode={livemode} compact />
            </span>
            <span className="block truncate text-xs text-muted-foreground">{compactTitle}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[0.9375rem] font-semibold">
            {compactAmount}
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={T.base} className="text-muted-foreground">
              <ChevronDown className="size-4" aria-hidden />
            </motion.span>
            <span className="sr-only">{open ? "Hide order details" : "Show order details"}</span>
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id="order-details"
              initial={calm ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={calm ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={calm ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={T.base}
              className="overflow-hidden"
            >
              <div className="pt-4 pb-1">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className={wideOnly}>
        <MerchantRow merchant={merchant} livemode={livemode} />
        <div className="mt-10">{children}</div>
      </div>
    </>
  );
}

/** "Paid to Acme Store" and its full NEAR payout account, which the payer can check, linking to the explorer when there is one. */
export function PaidDirectly({ merchant, payout, explorer, className, note }: { merchant: string; payout?: string | null; explorer?: string | null; className?: string; note?: string }) {
  const words = useNetworkWords();
  const addr = payout ? (
    explorer ? (
      <a href={`${explorer}/address/${payout}`} target="_blank" rel="noreferrer" className="hash inline-flex max-w-full min-w-0 items-center gap-0.5 rounded underline-offset-2 hover:text-foreground hover:underline">
        <AccountText value={payout} />
        <ExternalLink className="size-3 shrink-0" aria-hidden />
        <span className="sr-only">(opens the explorer)</span>
      </a>
    ) : (
      <AccountText value={payout} className="hash" />
    )
  ) : null;
  return (
    <div className={cn("space-y-1.5 text-[0.8125rem] text-muted-foreground", className)}>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <ShieldCheck className="size-3.5 shrink-0 text-[var(--ink)]" aria-hidden />
        <span>Paid to {merchant}</span>
        {addr}
      </p>
      <p className="pl-5">{note ?? `${words.escrowShort}.`}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel pieces
// ---------------------------------------------------------------------------

/** A bordered sub-card; the checkout panel itself lives in CheckoutLayout's card. */
export function PanelCard({ header, children, className }: { header?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground", className)}>
      {header && <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2.5">{header}</div>}
      <div className="p-4">{children}</div>
    </div>
  );
}

/** The one filled button that carries the business colour, pressing to 0.98. */
export function BrandButton({ className, children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "relative inline-flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-[var(--brand,var(--primary))] px-4 text-[0.9375rem] font-semibold text-[var(--brand-fg,var(--primary-foreground))] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(14_23_38/0.08)] transition-[filter,opacity,transform,box-shadow] duration-[120ms] hover:shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06),0_6px_16px_-6px_rgb(14_23_38/0.35)] hover:brightness-[1.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A labelled copy button ("Copy address") whose icon morphs into a check, with a "Copied" toast in the checkout. */
export function CopyAction({ value, label, className, onCopied, toast = "Copied" }: { value: string; label: string; className?: string; onCopied?: () => void; toast?: string }) {
  const [done, setDone] = useState(false);
  const show = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          show(toast);
          onCopied?.();
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border bg-background px-3 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-2 dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:size-3.5",
        done && "border-positive/40 bg-positive-soft text-positive hover:bg-positive-soft dark:bg-positive-soft",
        className,
      )}
    >
      <CopyGlyph done={done} />
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

/** Copy icon that morphs into a check. */
export function CopyGlyph({ done }: { done: boolean }) {
  return (
    <span className="relative inline-flex size-3.5" aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={done ? "y" : "n"} className="absolute inset-0" initial={{ opacity: 0, scale: 0.5, rotate: -30 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: 0.5 }} transition={T.fast}>
          {done ? <Check className="size-3.5" strokeWidth={3} /> : <Copy className="size-3.5" />}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** "Expires in 14:52", for the link preview and anywhere the bar would be too much. */
export function Countdown({ expiresAt, className, bare = false }: { expiresAt: string; className?: string; bare?: boolean }) {
  const now = useNow();
  const s = secondsLeft(expiresAt, now);
  const tone = countdownTone(s);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm transition-colors duration-[400ms]", tone === "danger" ? "font-medium text-negative" : tone === "warning" ? "font-medium text-warning" : "text-muted-foreground", className)}>
      {!bare && <Clock3 className="size-3.5" aria-hidden />}
      <span aria-hidden>
        {!bare && "Expires in "}
        <span className="num">{formatCountdown(s)}</span>
      </span>
      <span className="sr-only">{countdownLabel(s)}</span>
    </span>
  );
}

/** Time left as a thin shrinking bar with "Expires in 24:13"; amber under 5 minutes, red under 1; text only when calm. */
export function TimeBar({ fraction, text, label, tone }: { fraction: number; text: string; label: string; tone: "neutral" | "warning" | "danger" }) {
  const calm = useCalm();
  const color = tone === "danger" ? "text-negative" : tone === "warning" ? "text-warning" : "text-muted-foreground";
  const bar = tone === "danger" ? "bg-negative" : tone === "warning" ? "bg-warning" : "bg-[var(--ink)]";
  return (
    <div className="flex flex-col gap-1.5">
      <p className={cn("flex items-center justify-between text-xs transition-colors duration-[400ms]", color)}>
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3.5" aria-hidden />
          <span aria-hidden>
            Expires in <span className="num font-medium">{text}</span>
          </span>
          <span className="sr-only">{label}</span>
        </span>
      </p>
      {!calm && <Bar fraction={fraction} linear className="h-1" barClassName={cn("transition-colors duration-[400ms]", bar)} />}
    </div>
  );
}

/**
 * What the page is doing for the shopper, not a connection state: "Watching for payment" while the payment is seen as
 * it lands, "Checking for payment" while it falls back to asking every few seconds. It never says "Live", which a
 * shopper would read against the Testnet label.
 */
export function LivePill({ live }: { live: CheckoutLive }) {
  const label = live === "live" ? "Watching for payment" : live === "polling" ? "Checking for payment" : "Connecting";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground"
      title={live === "live" ? "Your payment shows here the moment it lands" : "Checking for your payment every few seconds"}
    >
      <PulseDot className={live === "live" ? "text-positive" : "text-warning"} />
      {label}
    </span>
  );
}

/** Label/value list. */
export function Rows({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("divide-y rounded-xl border text-sm", className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex min-h-10 items-center justify-between gap-4 px-3.5 py-2">
          <dt className="shrink-0 text-muted-foreground">{k}</dt>
          <dd className="flex min-w-0 justify-end text-right break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone, icon, children, className }: { tone: "warning" | "info" | "negative" | "neutral" | "positive"; icon?: ReactNode; children: ReactNode; className?: string }) {
  const cls = {
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-primary",
    negative: "bg-negative-soft text-negative",
    neutral: "bg-muted text-muted-foreground",
    positive: "bg-positive-soft text-positive",
  }[tone];
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[0.8125rem] leading-snug", cls, className)}>
      {icon && <span className="mt-px shrink-0 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 [&_strong]:font-semibold">{children}</div>
    </div>
  );
}

export function StateIcon({ tone, children, className }: { tone: "positive" | "warning" | "neutral" | "negative" | "info"; children: ReactNode; className?: string }) {
  const cls = {
    positive: "bg-positive text-white dark:text-background",
    warning: "bg-warning-soft text-warning",
    neutral: "bg-muted text-muted-foreground",
    negative: "bg-negative-soft text-negative",
    info: "bg-info-soft text-primary",
  }[tone];
  return <span className={cn("flex size-12 items-center justify-center rounded-full [&_svg]:size-5", cls, className)}>{children}</span>;
}

/** What the order is made of, with the total; used on the checkout, the receipt and the payment detail. */
export function LineItems({ items, token, className, total = true }: { items: { name: string; quantity: number; unit_amount: string }[]; token: Token; className?: string; total?: boolean }) {
  if (items.length === 0) return null;
  const sum = items.reduce((a, i) => a + BigInt(i.quantity) * BigInt(i.unit_amount), 0n);
  return (
    <div className={cn("text-sm", className)}>
      <ul className="divide-y divide-border/70">
        {items.map((i, n) => (
          <li key={n} className="flex items-baseline justify-between gap-4 py-2">
            <span className="min-w-0">
              <span className="block truncate">{i.name}</span>
              {i.quantity !== 1 && (
                <span className="num text-xs text-muted-foreground">
                  {i.quantity} x {formatToken(i.unit_amount, token.symbol, token.decimals)}
                </span>
              )}
            </span>
            <span className="num shrink-0">{formatToken(BigInt(i.quantity) * BigInt(i.unit_amount), token.symbol, token.decimals)}</span>
          </li>
        ))}
      </ul>
      {total && (
        <p className="flex justify-between gap-4 border-t pt-2 font-medium">
          <span>Total</span>
          <span className="num">{formatToken(sum, token.symbol, token.decimals)}</span>
        </p>
      )}
    </div>
  );
}

/** The order fingerprint in mono with a copy action; the full value stays readable on hover and when copied. */
export function OrderHash({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)} title={value}>
      <span className="hash truncate text-[0.8125rem]">
        {value.slice(0, 10)}…{value.slice(-8)}
      </span>
      <CopyIcon value={value} label="order fingerprint" />
    </span>
  );
}

export function CopyIcon({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const show = useToast();
  return (
    <button
      type="button"
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      onClick={() => void navigator.clipboard?.writeText(value).then(() => (setDone(true), show("Copied"), setTimeout(() => setDone(false), 1200)))}
      className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-subtle transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2", done && "text-positive")}
    >
      <CopyGlyph done={done} />
    </button>
  );
}

/** A centred card with an icon, a headline, a sentence and actions, for the screens with no order behind them. */
export function MessageCard({ icon, title, body, children, role }: { icon: ReactNode; title: string; body: ReactNode; children?: ReactNode; role?: "alert" }) {
  return (
    <div role={role} className="flex flex-col items-center gap-3 py-4 text-center">
      {icon}
      <h1 className="mt-1 text-xl font-semibold tracking-[-0.01em] text-balance">{title}</h1>
      <div className="max-w-[34ch] text-sm text-pretty text-muted-foreground">{body}</div>
      {children && <div className="mt-2 flex w-full flex-col gap-2">{children}</div>}
    </div>
  );
}
