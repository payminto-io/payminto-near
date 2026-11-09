"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { isAddressEqual, toHex, type Address } from "viem";
import { Info, LoaderCircle, XCircle } from "lucide-react";
import { useApi, useCan } from "@/lib/session";
import { gk } from "@/lib/gateway-queries";
import { useInfo, useToken } from "@/lib/queries";
import { checksum, parseAmountInput, plainAmount } from "@/lib/gateway";
import { formatToken, shortAddress } from "@/lib/format";
import { connectWallet, ensureChain, injected, sendTransfer, signRefund, walletErrorMessage } from "@/lib/wallet";
import { gatewayNetwork } from "@/lib/gateway";
import { ApiError } from "@/lib/http";
import type { MerchantProfile, PaymentDetail, Refund } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormRow } from "./kit";

const REASONS = ["Requested by customer", "Duplicate", "Overpayment", "Other"] as const;

/** What can still be refunded: paid, minus refunds sent or waiting on the payout wallet. */
export function refundable(p: Pick<PaymentDetail, "amount_paid" | "refunds">): bigint {
  const held = p.refunds.filter((r) => r.status === "pending" || r.status === "succeeded").reduce((a, r) => a + BigInt(r.amount), 0n);
  const left = BigInt(p.amount_paid) - held;
  return left > 0n ? left : 0n;
}

type Step = "form" | "wallet" | "error";

/**
 * Refunds are sent by the merchant's payout wallet (GATEWAY.md section 6): create the pending refund, have the
 * connected payout wallet sign a gasless router authorization (or send a plain transfer), then submit it.
 */
export function RefundDialog({ payment, merchant, open, onOpenChange, retry }: { payment: PaymentDetail; merchant: MerchantProfile | undefined; open: boolean; onOpenChange: (o: boolean) => void; retry?: Refund | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
  const info = useInfo();
  // Once this dialog has created the refund, a failed wallet step retries that same refund (its amount no longer
  // counts as available, so recomputing it would show 0.00).
  const [created, setCreated] = useState<Refund | null>(null);
  const active = retry ?? created;
  const max = active ? BigInt(active.amount) : refundable(payment);
  const [mode, setMode] = useState<"full" | "partial">(payment.status === "overpaid" ? "partial" : "full");
  const excess = BigInt(payment.amount_paid) - BigInt(payment.amount_due);
  const [partial, setPartial] = useState(payment.status === "overpaid" && excess > 0n ? plainAmount(excess, t.decimals) : "");
  const [to, setTo] = useState<string>(retry?.to ?? payment.payer ?? "");
  const [reason, setReason] = useState<string>(retry?.reason ?? (payment.status === "overpaid" ? "Overpayment" : REASONS[0]));
  const [note, setNote] = useState<string>(retry?.note ?? "");
  const canIssue = useCan()("refunds.issue");
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState<string | null>(null);
  const [idem] = useState(() => toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2));

  const parsed = mode === "partial" ? parseAmountInput(partial, t.decimals, { max }) : null;
  const amount = mode === "full" ? max : parsed?.ok ? parsed.atomic : null;
  const recipient = checksum(to);
  const can = amount !== null && amount > 0n && amount <= max && recipient !== null && step !== "wallet";
  const label = amount !== null ? `${canIssue ? "Refund" : "Request refund of"} ${formatToken(amount, t.symbol, t.decimals)}` : canIssue ? "Refund" : "Request refund";

  /** Staff ask; an Admin approves and sends it from the payout wallet (PRODUCT.md section 10.12). */
  async function request() {
    if (!can) return;
    setError(null);
    try {
      await api.gateway.createRefund({ paymentId: payment.id, amount: amount!.toString(), reason, to: recipient!, note: note.trim() || undefined }, idem);
      void qc.invalidateQueries({ queryKey: gk.all });
      toast.success("Refund requested. An Admin approves it and sends the money from the payout wallet.");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setStep("error");
    }
  }

  async function execute(kind: "sign" | "transfer") {
    if (!can || !merchant) return;
    setError(null);
    setStep("wallet");
    let refund: Refund | null = active;
    try {
      if (!refund) {
        refund = await api.gateway.createRefund({ paymentId: payment.id, amount: amount!.toString(), reason, to: recipient!, note: note.trim() || undefined }, idem);
        setCreated(refund);
      }
      if (!injected() && api.mock) {
        // Mock mode without a wallet: stand in for the payout wallet's signature.
        await new Promise((r) => setTimeout(r, 1200));
        await api.gateway.submitRefund(refund.id, { txHash: toHex(crypto.getRandomValues(new Uint8Array(32))) });
      } else {
        const from = await connectWallet();
        if (!isAddressEqual(from, merchant.payout as Address)) {
          throw new Error(`Connect the payout wallet ${shortAddress(merchant.payout)}. The connected wallet is ${shortAddress(from)}.`);
        }
        const net = gatewayNetwork(merchant.chain_id, info.data);
        await ensureChain({ chainId: net.chainId, name: net.name, rpcUrl: net.rpcUrl, explorer: net.explorer });
        if (kind === "sign" && (refund.authorization || merchant.payment_router)) {
          const node = refund.authorization;
          const nodeToken = typeof info.data?.token === "object" ? info.data.token : null;
          const signed = await signRefund({
            chainId: merchant.chain_id,
            token: merchant.token as Address,
            router: (node?.router ?? merchant.payment_router) as Address,
            refundId: refund.id,
            from,
            to: (node?.to ?? recipient!) as Address,
            amount: node ? BigInt(node.value) : amount!,
            terms: node?.terms ?? null,
            eip712: nodeToken && isAddressEqual(nodeToken.address as Address, merchant.token as Address) ? nodeToken.eip712 : undefined,
          });
          await api.gateway.submitRefund(refund.id, signed);
        } else {
          const hash = await sendTransfer({ token: merchant.token as Address, to: recipient!, amount: amount!, from });
          await api.gateway.submitRefund(refund.id, { txHash: hash });
        }
      }
      void qc.invalidateQueries({ queryKey: gk.all });
      toast.success(`Refund of ${formatToken(amount!, t.symbol, t.decimals)} sent to ${shortAddress(recipient!)}`);
      onOpenChange(false);
      setStep("form");
    } catch (e) {
      void qc.invalidateQueries({ queryKey: gk.all });
      setError(e instanceof ApiError ? e.message : walletErrorMessage(e));
      setStep("error");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => step !== "wallet" && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{active ? (active.status === "failed" ? "Retry refund" : "Send refund") : canIssue ? "Refund payment" : "Request a refund"}</DialogTitle>
          <DialogDescription>
            Up to <span className="num font-medium text-foreground">{formatToken(max, t.symbol, t.decimals)}</span> is available to refund.
          </DialogDescription>
        </DialogHeader>
        {step === "wallet" ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center" aria-live="polite">
            <LoaderCircle className="size-8 animate-spin text-primary" aria-hidden />
            <p className="font-medium">Confirm in your wallet</p>
            <p className="max-w-[34ch] text-sm text-muted-foreground">Approve the refund with the payout wallet {merchant ? shortAddress(merchant.payout) : ""}. Do not close this window.</p>
          </div>
        ) : (
          <form
            id="refund-form"
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canIssue) void execute("sign");
              else void request();
            }}
          >
            {!active && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 text-sm font-medium">Amount</legend>
                <label className="flex items-center gap-2.5 text-sm">
                  <input type="radio" name="refund-mode" checked={mode === "full"} onChange={() => setMode("full")} className="size-4 accent-primary" />
                  Full amount: <span className="num font-medium">{formatToken(max, t.symbol, t.decimals)}</span>
                </label>
                <label className="flex items-center gap-2.5 text-sm">
                  <input type="radio" name="refund-mode" checked={mode === "partial"} onChange={() => setMode("partial")} className="size-4 accent-primary" />
                  Partial amount
                </label>
                {mode === "partial" && (
                  <div className="ml-6.5">
                    <div className="relative">
                      <Input aria-label="Partial refund amount" inputMode="decimal" value={partial} onChange={(e) => setPartial(e.target.value)} placeholder="0.00" className="num pr-16" aria-invalid={Boolean(parsed && !parsed.ok && partial)} />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{t.symbol}</span>
                    </div>
                    <p className={parsed && !parsed.ok && partial ? "mt-1 text-xs text-negative" : "mt-1 text-xs text-muted-foreground"}>
                      {parsed && !parsed.ok && partial ? parsed.error : `Up to ${formatToken(max, t.symbol, t.decimals)} available`}
                    </p>
                  </div>
                )}
              </fieldset>
            )}
            <FormRow id="refund-to" label="Send to" hint={recipient ? "The payer's address on the payment, on the same network." : undefined} error={to && !recipient ? "Enter a valid 0x address." : null}>
              <Input id="refund-to" value={to} onChange={(e) => setTo(e.target.value)} className="hash text-[0.8125rem]" spellCheck={false} autoComplete="off" readOnly={Boolean(active)} />
            </FormRow>
            <FormRow id="refund-reason" label="Reason">
              <Select value={reason} onValueChange={setReason} disabled={Boolean(active)}>
                <SelectTrigger id="refund-reason" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow id="refund-note" label="Internal note" optional hint="Only your team can see this. The customer never does.">
              <Textarea id="refund-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={2} placeholder="Why, ticket number, who asked" readOnly={Boolean(active)} />
            </FormRow>
            <p className="flex gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-[0.8125rem] text-primary">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {canIssue ? null : "An Admin approves the request first. "}Refunds are sent on-chain from your payout wallet and cannot be reversed. They land in minutes. Fees are not returned on refunds
                {BigInt(payment.fee_total) > 0n ? ` (${formatToken(payment.fee_total, t.symbol, t.decimals)} on this payment)` : ""}.
              </span>
            </p>
            {error && (
              <p role="alert" className="flex gap-2 rounded-lg bg-negative-soft px-3 py-2.5 text-[0.8125rem] text-negative">
                <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{error} No funds were moved.</span>
              </p>
            )}
          </form>
        )}
        {step !== "wallet" && (
          <DialogFooter className="gap-2 sm:justify-between">
            {canIssue ? (
              <Button type="button" variant="ghost" disabled={!can || !merchant} onClick={() => void execute("transfer")}>
                Send a transfer instead
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" form="refund-form" disabled={!can || (canIssue && !merchant)}>
              {label}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
