"use client";

/** The password prompt a sensitive action raises (403 STEP_UP_REQUIRED, PRODUCT.md section 10.6); the request then retries. */
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { getStepUp, subscribeStepUp } from "@/lib/step-up";
import { authErrorText } from "@/lib/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function StepUpDialog() {
  const req = useSyncExternalStore(subscribeStepUp, getStepUp, () => null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (ok: boolean) => {
    req?.resolve(ok);
    setPassword("");
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      await req.verify(password);
      close(true);
    } catch (err) {
      setError(authErrorText(err, "That password is not right."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(req)} onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <DialogTitle>Confirm it is you</DialogTitle>
            <DialogDescription>This change needs your password again. You will not be asked for the next 10 minutes.</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="step-up-password">Password</Label>
            <Input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "step-up-error" : undefined}
            />
            {error && (
              <p id="step-up-error" role="alert" className="text-sm text-negative">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy && <Loader2 className="animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
