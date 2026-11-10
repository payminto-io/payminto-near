"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A 24px icon control that keeps a 44px hit area on coarse pointers (design system: "Give a 24px icon button a 44px box
 * on coarse pointers"). The extra area is a pseudo-element, so rows keep their rhythm.
 */
export const ICON_CONTROL =
  "relative inline-flex size-6 shrink-0 items-center justify-center rounded text-subtle transition-[background-color,color] duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:outline-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']";

/** Copies the full value and confirms for 1200ms. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      className={cn(ICON_CONTROL, done && "bg-positive-soft", className)}
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
      {done ? <Check key="done" aria-hidden className="copied-pop size-3.5 text-positive" /> : <Copy key="idle" aria-hidden className="size-3.5" />}
    </button>
  );
}

/** Opens the NEAR explorer in a new tab. Renders nothing without a link (a sandbox has no explorer). */
export function ExplorerLink({ href, label, className }: { href: string | null | undefined; label: string; className?: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${label} in the NEAR explorer`} className={cn(ICON_CONTROL, className)} onClick={(e) => e.stopPropagation()}>
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}
