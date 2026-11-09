"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CopyAction } from "@/components/checkout/parts";

/**
 * Shown once (OpenAI and Gamma pattern): the full secret with a copy button, and a close button that stays disabled
 * until the secret was copied or the user confirms they stored it. Escape and outside clicks do not dismiss it.
 */
export function SecretDialog({ secret, title, what, onClose }: { secret: string | null; title: string; what: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);
  const can = copied || ack;
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && can && onClose()}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => !can && e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <strong className="font-semibold text-foreground">You will not be able to see it again.</strong> Store this {what} somewhere safe, such as your secret manager.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <code className="hash min-w-0 flex-1 rounded-md border bg-muted/50 px-3 py-2 text-[0.8125rem] break-all select-all">{secret}</code>
          <CopyAction value={secret ?? ""} label="Copy" className="shrink-0 self-start" onCopied={() => setCopied(true)} />
        </div>
        <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[0.8125rem] text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {what === "key" ? "Anyone with this key can create payments, links and refunds as this business." : `Anyone with this ${what} can forge events that look like they came from Payminto.`} Never paste it into a browser page or a public repository.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="size-4 accent-primary" />
          I have stored this {what}
        </label>
        <DialogFooter>
          <Button disabled={!can} onClick={onClose}>
            I have saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
