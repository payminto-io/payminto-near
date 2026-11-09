"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApi } from "@/lib/session";
import { ok } from "@/lib/operator-queries";
import { gk } from "@/lib/gateway-queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PayoutProofField, type PayoutProof } from "./payout-proof";

/** Change a business's payout wallet; the new wallet signs a proof (payout.change, plus step-up on the server). */
export function ChangePayout({ merchantId, onClose }: { merchantId: string; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [proof, setProof] = useState<PayoutProof | null>(null);
  const save = useMutation({
    mutationFn: () => api.operator.changePayout(merchantId, proof!),
    onSuccess: () => {
      toast.success("Payout wallet changed. New payments go to it straight away.");
      void qc.invalidateQueries({ queryKey: ok.all });
      void qc.invalidateQueries({ queryKey: gk.merchant });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>Change payout wallet</DialogTitle>
          <DialogDescription>The new wallet signs a short message to prove you control it, so nobody can redirect your money. The change is written to the activity log.</DialogDescription>
        </DialogHeader>
        <PayoutProofField subject={merchantId} value={proof} onChange={setProof} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!proof || save.isPending} onClick={() => save.mutate()}>
            Change payout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
