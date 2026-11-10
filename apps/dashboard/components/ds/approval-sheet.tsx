"use client";

import { useRef, type ReactNode } from "react";
import { Loader2, ShieldBan, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type ApprovalRow = { label: string; value: ReactNode };
/** `block` marks a reason that refuses outright; everything else is a warning to weigh. */
export type ApprovalRisk = { key: string; title: ReactNode; body: ReactNode; tone?: "warn" | "block" };

/**
 * One decision an owner makes with everything in view: a large amount, From, To, Amount and Rule rows, the risk before
 * the actions, and the two actions in a footer that stays put while the body scrolls. Below 640px it is a bottom sheet
 * with the footer above the safe area. Approve is never the focused control when it opens.
 */
export function ApprovalSheet({
  open,
  onOpenChange,
  title,
  description,
  amount,
  amountLabel = "Amount",
  rows,
  risks = [],
  notice,
  children,
  error,
  refuseLabel = "Refuse",
  approveLabel = "Approve",
  onRefuse,
  onApprove,
  busy = null,
  approveTone = "primary",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One sentence on what the decision does and what it does not. */
  description: ReactNode;
  /** The exact amount, large. Left out when no amount is being approved. */
  amount?: ReactNode;
  amountLabel?: string;
  rows: ApprovalRow[];
  risks?: ApprovalRisk[];
  /** Something that changed since the sheet opened, said before the risks. */
  notice?: ReactNode;
  /** Fields that belong to the decision, such as a note. */
  children?: ReactNode;
  /** Why the last attempt did not go through, in one sentence. */
  error?: ReactNode;
  refuseLabel?: string;
  approveLabel?: string;
  onRefuse: () => void;
  onApprove: () => void;
  /** Which action is being sent. Both actions are disabled while one is. */
  busy?: "approve" | "refuse" | null;
  approveTone?: "primary" | "destructive";
}) {
  const refuseRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent
        sheetOnMobile
        showCloseButton={!busy}
        className="gap-0 p-0 sm:max-w-lg max-sm:p-0"
        onOpenAutoFocus={(e) => {
          // Land on the safe choice: a stray Enter or tap never approves.
          e.preventDefault();
          refuseRef.current?.focus();
        }}
      >
        <DialogHeader className="px-4 pt-4 pb-3 text-left sm:px-6">
          <DialogTitle className="pr-8 text-[0.9375rem] leading-[1.375rem]">{title}</DialogTitle>
          <DialogDescription className="text-[0.8125rem]">{description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[58dvh] overflow-y-auto px-4 pb-4 sm:px-6">
          {amount && (
            <div className="pb-4">
              <p className="mb-1.5 text-xs text-muted-foreground">{amountLabel}</p>
              {amount}
            </div>
          )}
          <dl className="divide-y rounded-xl border text-sm">
            {rows.map((r) => (
              <div key={r.label} className="grid min-h-12 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3 px-3 py-1.5">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="min-w-0">{r.value}</dd>
              </div>
            ))}
          </dl>
          {notice && (
            <p role="status" className="mt-3 rounded-xl border bg-rail p-3 text-sm">
              {notice}
            </p>
          )}
          {risks.map((r) => {
            const block = r.tone === "block";
            const Icon = block ? ShieldBan : TriangleAlert;
            return (
              <div key={r.key} role="note" className={cn("mt-3 flex gap-2.5 rounded-xl p-3 text-sm", block ? "bg-negative-soft" : "bg-warning-soft")}>
                <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", block ? "text-negative" : "text-warning")} />
                <div className="min-w-0">
                  <p className="font-semibold">{r.title}</p>
                  <p className="mt-0.5 [overflow-wrap:anywhere] text-muted-foreground">{r.body}</p>
                </div>
              </div>
            );
          })}
          {children && <div className="mt-4">{children}</div>}
        </div>

        {/* Sticky only in the bottom sheet, which scrolls itself; see TxFlow for why the centred dialog is not. */}
        <div className="border-t bg-background px-4 pt-3 pb-3 sm:px-6 max-sm:sticky max-sm:bottom-0 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
              {error}
            </p>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-2">
            <Button ref={refuseRef} type="button" variant="outline" className="h-11 rounded-xl" disabled={busy !== null} onClick={onRefuse}>
              {busy === "refuse" && <Loader2 aria-hidden className="animate-spin" />}
              {refuseLabel}
            </Button>
            <Button type="button" variant={approveTone === "destructive" ? "destructive" : "default"} className="h-12 rounded-xl text-[0.9375rem] font-semibold whitespace-normal" disabled={busy !== null} onClick={onApprove}>
              {busy === "approve" && <Loader2 aria-hidden className="animate-spin" />}
              {approveLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
