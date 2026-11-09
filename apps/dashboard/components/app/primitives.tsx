"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Check, ChevronLeft, Copy, ExternalLink, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney, shortAddress, shortHash } from "@/lib/format";
import { useDirectory, useExplorer, useToken } from "@/lib/queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function Money({
  atomic,
  className,
  unitClassName,
  maxFraction,
  signed,
}: {
  atomic: string | bigint | null | undefined;
  className?: string;
  unitClassName?: string;
  maxFraction?: number;
  signed?: boolean;
}) {
  const t = useToken();
  if (atomic === null || atomic === undefined) return <span className={cn("num text-subtle", className)}>-</span>;
  const v = BigInt(atomic);
  const text = formatMoney(v, t.decimals, { maxFraction });
  return (
    <span className={cn("num whitespace-nowrap", className)}>
      {signed && v > 0n ? "+" : ""}
      {text}
      <span className={cn("ml-1 text-[0.82em] font-normal text-muted-foreground", unitClassName)}>{t.symbol}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copy, address and hash chips
// ---------------------------------------------------------------------------

export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded text-subtle transition-[background-color,color] duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:outline-2",
        done && "bg-positive-soft",
        className,
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            toast.success(`${label.charAt(0).toUpperCase()}${label.slice(1)} copied`, { id: `copied:${label}`, duration: 1200 });
            setTimeout(() => setDone(false), 1200);
          },
          () => toast.error("Could not copy. Select the text and copy it instead."),
        );
      }}
    >
      {done ? <Check key="done" className="copied-pop size-3.5 text-positive" /> : <Copy key="idle" className="size-3.5" />}
    </button>
  );
}

function ExplorerLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${label} in explorer`}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-subtle transition-colors hover:bg-muted hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="size-3.5" />
    </a>
  );
}

/** A wallet: its name when the node knows it, the truncated address otherwise, always copyable and linkable. */
export function Address({
  address,
  showName = true,
  className,
  explorer = true,
  copy = true,
  nameOnly = false,
}: {
  address: string | null | undefined;
  showName?: boolean;
  className?: string;
  explorer?: boolean;
  copy?: boolean;
  /** Show just the wallet's name when it is known; the address stays in the tooltip. */
  nameOnly?: boolean;
}) {
  const dir = useDirectory();
  const ex = useExplorer();
  if (!address) return <span className="text-subtle">-</span>;
  const party = showName ? dir.lookup(address) : null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 align-middle", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-baseline gap-1.5" tabIndex={0}>
            {party && <span className="truncate font-medium text-foreground">{party.name}</span>}
            {!(party && nameOnly) && (
              <span className={cn("hash shrink-0 text-[0.86em]", party ? "text-subtle" : "text-foreground")}>{shortAddress(address)}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent className="hash max-w-none">{address}</TooltipContent>
      </Tooltip>
      {copy && <CopyButton value={address} label="address" />}
      {explorer && <ExplorerLink href={ex.address(address)} label="address" />}
    </span>
  );
}

export function Hash({
  value,
  kind = "id",
  href,
  className,
}: {
  value: string | null | undefined;
  kind?: "tx" | "id";
  href?: string;
  className?: string;
}) {
  const ex = useExplorer();
  if (!value) return <span className="text-subtle">-</span>;
  const text = <span className="hash text-[0.86em]">{shortHash(value)}</span>;
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          {href ? (
            <Link href={href} className="rounded underline-offset-2 hover:underline">
              {text}
            </Link>
          ) : (
            <span tabIndex={0}>{text}</span>
          )}
        </TooltipTrigger>
        <TooltipContent className="hash max-w-none">{value}</TooltipContent>
      </Tooltip>
      <CopyButton value={value} label={kind === "tx" ? "transaction hash" : "id"} />
      {kind === "tx" && <ExplorerLink href={ex.tx(value)} label="transaction" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="-ml-1 mb-2 inline-flex items-center gap-0.5 rounded text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        <h1 className="text-[1.625rem] leading-tight font-semibold tracking-[-0.015em] text-balance">{title}</h1>
        {description && <p className="mt-1.5 max-w-[68ch] text-[0.9375rem] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border bg-card text-card-foreground", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-[0.9375rem] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Label/value rows for detail screens. */
export function Fields({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid gap-x-6 gap-y-3 text-sm", className)}>{children}</dl>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="flex items-start gap-1 text-muted-foreground">
        {label}
        {hint && <InfoTip>{hint}</InfoTip>}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function Meter({ value, tone = "primary", label }: { value: number; tone?: "primary" | "warning" | "negative"; label: string }) {
  const color = tone === "negative" ? "bg-negative" : tone === "warning" ? "bg-warning" : "bg-primary";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${Math.max(value > 0 ? 1.5 : 0, value)}%` }} />
    </div>
  );
}

/** A wallet on two lines: its name, then the address with copy and explorer actions. */
export function PartyLine({ address }: { address: string | null | undefined }) {
  const dir = useDirectory();
  if (!address) return <span className="text-subtle">-</span>;
  const party = dir.lookup(address);
  if (!party) return <Address address={address} showName={false} />;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="font-medium">{party.name}</span>
      <Address address={address} showName={false} className="text-muted-foreground" />
    </span>
  );
}

/**
 * A small info icon with the plain explanation of a technical label (PRODUCT.md section 2.3). Technical words live
 * here, under the icon, rather than in the label itself.
 */
export function InfoTip({ children, label = "What is this?", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className={cn("inline-flex size-4 shrink-0 translate-y-0.5 items-center justify-center rounded-full text-subtle transition-colors duration-150 hover:text-foreground focus-visible:outline-2", className)}>
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-pretty">{children}</TooltipContent>
    </Tooltip>
  );
}
