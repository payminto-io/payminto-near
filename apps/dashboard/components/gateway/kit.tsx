"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatInt } from "@/lib/format";

/** Status tabs as count cards (Stripe transactions): a radiogroup of filters, each with its count. */
export function CountTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: K; label: string; count?: number | null }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(t.key)}
            className={cn(
              "flex min-w-[6.5rem] shrink-0 flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-2",
              on ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted/60",
            )}
          >
            <span className={cn("text-xs", on ? "font-medium" : "text-muted-foreground")}>{t.label}</span>
            <span className="num mt-0.5 text-[1.0625rem] font-semibold">{t.count == null ? "-" : formatInt(t.count)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Column header row for a grid list; hidden on phones, where rows stack. */
export function ListHead({ cols, children }: { cols: string; children: ReactNode }) {
  return <div className={cn("hidden gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground md:grid", cols)}>{children}</div>;
}

/** A labelled form row with an optional muted "Optional" tag and hint. */
export function FormRow({ id, label, optional, hint, error, children }: { id: string; label: string; optional?: boolean; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium">
        {label}
        {optional && <span className="text-xs font-normal text-muted-foreground">Optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-negative">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Two-option segmented control (radiogroup). */
export function Segmented<K extends string>({ value, onChange, options, label, className }: { value: K; onChange: (k: K) => void; options: { key: K; label: string }[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-muted p-1", className)}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "h-8 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2",
            value === o.key ? "bg-card text-foreground shadow-sm ring-1 ring-border dark:bg-input dark:ring-transparent" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Mono code block with wrapping and a copy button, for payloads, snippets and secrets. */
export function CodeBlock({ code, label, className, copy }: { code: string; label: string; className?: string; copy?: ReactNode }) {
  return (
    <div className={cn("relative rounded-lg border bg-muted/50", className)}>
      <div className="absolute top-1.5 right-1.5">{copy}</div>
      <pre aria-label={label} className="hash max-h-80 overflow-auto p-3 pr-10 text-[0.75rem] leading-relaxed break-all whitespace-pre-wrap">
        {code}
      </pre>
    </div>
  );
}

/** An input with its unit ("USDC", "%") inside the right edge. */
export function Unit({ unit, children }: { unit: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{unit}</span>
    </div>
  );
}
