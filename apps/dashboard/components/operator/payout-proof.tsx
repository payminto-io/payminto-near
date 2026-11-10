"use client";

import { useState } from "react";
import { CheckCircle2, LoaderCircle, PenLine, XCircle } from "lucide-react";
import { useInfo } from "@/lib/queries";
import { parseAccount } from "@/lib/gateway";
import { signMessage, walletErrorMessage } from "@/lib/wallet";
import { payoutProofRequest, type Network, type PayoutProof as WirePayoutProof } from "@payminto/protocol";
import { payoutChangeMessage } from "@/lib/operator-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormRow } from "@/components/gateway/kit";
import { AccountId } from "@/components/ds/account-id";

export type PayoutProof = WirePayoutProof;

const unixNow = () => Math.floor(Date.now() / 1000);

/**
 * The payout account proves control by signing a message bound to this node's network and hub with NEP-413. The
 * recipient is the hub, so a proof made for one node is refused by another; the node checks the key is a full-access
 * key of the payout account. A signature from any other account is refused here before anything is sent.
 */
export function PayoutProofField({ subject, value, onChange }: { subject: string; value: PayoutProof | null; onChange: (p: PayoutProof | null) => void }) {
  const { data: info } = useInfo();
  const [address, setAddress] = useState(value?.payout ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState(() => value?.timestamp ?? unixNow());
  const target = parseAccount(address);
  const scope = info ? { network: info.network.id, hub: info.hub } : null;
  const message = payoutChangeMessage(subject || "{merchant}", target ?? "{payout}", value?.timestamp ?? stamp, scope);

  async function sign() {
    setError(null);
    setBusy(true);
    try {
      if (!scope) throw new Error("Your server's network and hub are still loading. Try again in a moment.");
      if (!target) throw new Error("Enter the payout account first.");
      const timestamp = unixNow();
      setStamp(timestamp);
      // The protocol fixes the message, the recipient (this node's hub) and a nonce derived from the message, so the node
      // can rebuild every signed byte from the proof alone.
      const req = payoutProofRequest(subject, target, timestamp, { network: scope.network as Network, hub: scope.hub });
      const p = await signMessage(req.message, req.recipient, target, req.nonce);
      onChange({ payout: target, timestamp, public_key: p.publicKey as WirePayoutProof["public_key"], signature: p.signature });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FormRow id="payout" label="Payout account" hint="Payments for this business are credited to this NEAR account." error={address && !target ? "Enter a valid NEAR account, such as northwind.testnet." : null}>
        <Input
          id="payout"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setError(null);
            onChange(null);
          }}
          placeholder="business.testnet"
          className="hash h-11 text-base md:h-9 md:text-[0.8125rem]"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
        />
      </FormRow>
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="text-xs font-medium text-muted-foreground">Message the payout account signs (NEP-413, for this server&apos;s hub)</p>
        <p className="hash mt-1 text-[0.8125rem] [overflow-wrap:anywhere]">{message}</p>
      </div>
      {value ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-positive" role="status">
          <CheckCircle2 className="size-4" aria-hidden /> Signed by <AccountId value={value.payout} mode="wrap" explorer={false} className="text-foreground" />
        </p>
      ) : (
        <div>
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void sign()} disabled={busy || !target}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
            Sign with the payout account
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-negative">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}
