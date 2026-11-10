"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortHash } from "@/lib/format";
import { useDirectory, useExplorer, useToken } from "@/lib/queries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton, ExplorerLink } from "@/components/ds/actions";
import { AccountId } from "@/components/ds/account-id";
import { Amount } from "@/components/ds/amount";

// ---------------------------------------------------------------------------
// Money, accounts and hashes: the design-system components bound to the node's token and explorer
// ---------------------------------------------------------------------------

/** An amount in the settlement token. See Amount for the rules. */
export function Money({
  atomic,
  className,
  unitClassName,
  signed,
  size,
}: {
  atomic: string | bigint | null | undefined;
  className?: string;
  unitClassName?: string;
  signed?: boolean;
  size?: "sm" | "md" | "lg" | "display";
}) {
  const t = useToken();
  return <Amount atomic={atomic} decimals={t.decimals} unit={t.symbol} className={className} unitClassName={unitClassName} signed={signed} size={size} />;
}

export { CopyButton };

/** A NEAR account: its name when the node knows it, the id truncated in the middle, always copyable and linkable. */
export function Address({
  address,
  showName = true,
  className,
  explorer = true,
  copy = true,
  nameOnly = false,
  mode = "middle",
}: {
  address: string | null | undefined;
  showName?: boolean;
  className?: string;
  explorer?: boolean;
  copy?: boolean;
  /** Show just the account's name when it is known; the id stays in the title and the copy action. */
  nameOnly?: boolean;
  mode?: "middle" | "wrap";
}) {
  const dir = useDirectory();
  const party = showName && address ? dir.lookup(address) : null;
  if (party && nameOnly && address) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1 align-middle", className)}>
        <span className="truncate font-medium text-foreground" title={address}>
          {party.name}
        </span>
        {copy && <CopyButton value={address} label="account" />}
      </span>
    );
  }
  return <AccountId value={address} name={party?.name} explorer={explorer} copy={copy} mode={mode} className={className} />;
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
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:[&>*]:h-11">{actions}</div>}
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
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Label/value rows. The list is a size container: from 28rem of its own width each row has a 9rem label column, and
 * below that the label stacks over the value, so a narrow side panel never squeezes an account id into a sliver.
 */
export function Fields({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("@container grid gap-x-6 gap-y-3 text-sm", className)}>{children}</dl>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1 @[28rem]:grid-cols-[9rem_minmax(0,1fr)] @[28rem]:gap-4">
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
