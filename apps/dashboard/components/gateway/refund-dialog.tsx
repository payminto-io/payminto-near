"use client";

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { refundTransferTx, toHex } from "@payminto/protocol";
import { Globe, Info, LoaderCircle, XCircle } from "lucide-react";
import { useApi, useCan } from "@/lib/session";
import { gk } from "@/lib/gateway-queries";
import { useToken } from "@/lib/queries";
import { parseAccount, parseAmountInput, plainAmount } from "@/lib/gateway";
import { formatToken } from "@/lib/format";
import { walletErrorMessage, type TxResult } from "@/lib/wallet";
import { ApiError } from "@/lib/http";
import { manualRefundFromError, manualRefundOf, originTxProblem } from "@/lib/intents";
import type { ManualRefundDetails, MerchantProfile, PaymentDetail, Refund } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TxFlow, type TxPlan } from "@/components/ds/tx-flow";
import { AccountId } from "@/components/ds/account-id";
import { CopyAction } from "@/components/checkout/parts";
import { TxValue } from "@/components/checkout/intents";
import { FormRow } from "./kit";

const REASONS = ["Requested by customer", "Duplicate", "Overpayment", "Other"] as const;

/** What can still be refunded: paid, minus refunds sent or waiting on the payout account. */
export function refundable(p: Pick<PaymentDetail, "amount_paid" | "refunds">): bigint {
  const held = p.refunds.filter((r) => r.status === "pending" || r.status === "succeeded").reduce((a, r) => a + BigInt(r.amount), 0n);
  const left = BigInt(p.amount_paid) - held;
  return left > 0n ? left : 0n;
}

type Step = "form" | "wallet" | "error";

type RefundDialogProps = { payment: PaymentDetail; merchant: MerchantProfile | undefined; open: boolean; onOpenChange: (o: boolean) => void; retry?: Refund | null };

/**
 * A payment made on NEAR is refunded with a NEAR transfer from the payout account. A payment that came from another
 * chain cannot be: the buyer has no NEAR account, so the business sends the refund from its own wallet on the buyer's
 * chain and records it here. The node also answers 409 REFUND_MANUAL_REQUIRED, with the same details, to a dialog that
 * did not know (an older payment view), and the dialog then switches to the manual form.
 */
export function RefundDialog(props: RefundDialogProps) {
  const [required, setRequired] = useState<ManualRefundDetails | null>(null);
  const manual = props.retry ? null : (required ?? manualRefundOf(props.payment, refundable(props.payment)));
  if (manual) return <ManualRefundDialog payment={props.payment} details={manual} open={props.open} onOpenChange={props.onOpenChange} />;
  return <NearRefundDialog {...props} onManualRequired={setRequired} />;
}

/**
 * Refunds are sent by the merchant's own payout account (spec: "Payments for people"): create the pending refund, show
 * the exact NEAR transfer, have the payout account sign it, then submit the transaction hash for the node to verify.
 */
function NearRefundDialog({ payment, merchant, open, onOpenChange, retry, onManualRequired }: RefundDialogProps & { onManualRequired: (d: ManualRefundDetails) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
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
  const [idem] = useState(() => toHex(crypto.getRandomValues(new Uint8Array(16))));
  const [plan, setPlan] = useState<{ refund: Refund; plan: TxPlan } | null>(null);

  const parsed = mode === "partial" ? parseAmountInput(partial, t.decimals, { max }) : null;
  const amount = mode === "full" ? max : parsed?.ok ? parsed.atomic : null;
  const recipient = parseAccount(to);
  const can = amount !== null && amount > 0n && amount <= max && recipient !== null && step !== "wallet";
  const label = amount !== null ? `${canIssue ? "Refund" : "Request refund of"} ${formatToken(amount, t.symbol, t.decimals)}` : canIssue ? "Refund" : "Request refund";

  /** Staff ask; an Admin approves and sends it from the payout wallet (PRODUCT.md section 10.12). */
  async function request() {
    if (!can) return;
    setError(null);
    try {
      await api.gateway.createRefund({ paymentId: payment.id, amount: amount!.toString(), reason, to: recipient!, note: note.trim() || undefined }, idem);
      void qc.invalidateQueries({ queryKey: gk.all });
      toast.success("Refund requested. An Admin approves it and sends the money from the payout account.");
      onOpenChange(false);
    } catch (e) {
      const manual = manualRefundFromError(e);
      if (manual) return onManualRequired(manual);
      setError(e instanceof ApiError ? e.message : String(e));
      setStep("error");
    }
  }

  /** Creates the pending refund once, then shows the exact NEAR transfer the payout account will sign. */
  async function execute() {
    if (!can || !merchant) return;
    setError(null);
    if (!merchant.payout) {
      setError("This business has no payout account yet, so there is no account to send the refund from.");
      setStep("error");
      return;
    }
    setStep("wallet");
    try {
      let refund: Refund | null = active;
      if (!refund) {
        refund = await api.gateway.createRefund({ paymentId: payment.id, amount: amount!.toString(), reason, to: recipient!, note: note.trim() || undefined }, idem);
        setCreated(refund);
      }
      const value = BigInt(refund.amount);
      setPlan({
        refund,
        plan: {
          title: "Send the refund",
          description: "Your payout account sends the refund itself, as a plain token transfer. Your server then checks the transaction. A refund cannot be reversed.",
          summary: [
            { label: "Amount", value: <span className="num font-medium">{formatToken(value, t.symbol, t.decimals)}</span> },
            { label: "To", value: <AccountId value={refund.to} mode="wrap" explorer={false} /> },
          ],
          txs: [refundTransferTx(merchant.token, refund.to, value, refund.id)],
          confirmLabel: `Send ${formatToken(value, t.symbol, t.decimals)}`,
          signer: merchant.payout ?? undefined,
          finalNote: "NEAR executed the transfer. Your server is checking it now.",
        },
      });
    } catch (e) {
      const manual = manualRefundFromError(e);
      if (manual) return onManualRequired(manual);
      void qc.invalidateQueries({ queryKey: gk.all });
      setError(e instanceof ApiError ? e.message : walletErrorMessage(e));
      setStep("error");
    }
  }

  async function submit(refund: Refund, results: TxResult[]) {
    const hash = results[0]?.hash;
    if (!hash) return;
    try {
      await api.gateway.submitRefund(refund.id, { txHash: hash });
      toast.success(`Refund of ${formatToken(refund.amount, t.symbol, t.decimals)} sent to ${refund.to}`);
    } catch (e) {
      toast.error("The refund was sent, but your server has not confirmed it yet", { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      void qc.invalidateQueries({ queryKey: gk.all });
    }
  }

  if (plan) {
    return (
      <TxFlow
        plan={plan.plan}
        open={open}
        onOpenChange={(o) => {
          if (o) return;
          setPlan(null);
          setStep("form");
          onOpenChange(false);
        }}
        onFinal={(results) => void submit(plan.refund, results)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => step !== "wallet" && onOpenChange(o)}>
      <DialogContent sheetOnMobile className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{active ? (active.status === "failed" ? "Retry refund" : "Send refund") : canIssue ? "Refund payment" : "Request a refund"}</DialogTitle>
          <DialogDescription>
            Up to <span className="num font-medium text-foreground">{formatToken(max, t.symbol, t.decimals)}</span> is available to refund.
          </DialogDescription>
        </DialogHeader>
        {step === "wallet" ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center" aria-live="polite">
            <LoaderCircle className="size-8 animate-spin text-primary" aria-hidden />
            <p className="font-medium">Preparing the refund</p>
            <p className="max-w-[34ch] text-sm text-muted-foreground">Your server records the refund, then your payout account signs it.</p>
          </div>
        ) : (
          <form
            id="refund-form"
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canIssue) void execute();
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
            <FormRow id="refund-to" label="Send to" hint={recipient ? "The NEAR account that paid. It must be registered with the token to receive it." : undefined} error={to && !recipient ? "Enter a valid NEAR account." : null}>
              <Input id="refund-to" value={to} onChange={(e) => setTo(e.target.value)} className="hash h-11 text-base md:h-9 md:text-[0.8125rem]" autoCapitalize="none" spellCheck={false} autoComplete="off" readOnly={Boolean(active)} />
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
                {canIssue ? null : "An Admin approves the request first. "}Refunds are sent on NEAR from your payout account and cannot be reversed. They land in seconds. Fees are not returned on refunds
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
            <span />
            <Button type="submit" form="refund-form" disabled={!can || (canIssue && !merchant)}>
              {label}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The refund of a payment that came from another chain: who to send it to and from where, then a short form to record
 * it once the business sent it from its own wallet. The node records it as succeeded; nothing moves on NEAR.
 */
function ManualRefundDialog({ payment, details, open, onOpenChange }: { payment: PaymentDetail; details: ManualRefundDetails; open: boolean; onOpenChange: (o: boolean) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const t = useToken();
  const canIssue = useCan()("refunds.issue");
  const max = BigInt(details.refundable);
  const [amount, setAmount] = useState(max > 0n ? plainAmount(max, t.decimals) : "");
  const [hash, setHash] = useState("");
  const [touched, setTouched] = useState(false);
  const [reason, setReason] = useState<string>(payment.status === "overpaid" ? "Overpayment" : REASONS[0]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idem] = useState(() => toHex(crypto.getRandomValues(new Uint8Array(16))));

  const parsed = parseAmountInput(amount, t.decimals, { max });
  const atomic = parsed.ok && parsed.atomic > 0n ? parsed.atomic : null;
  const problem = originTxProblem(details.chain, details.chain_name, hash);
  const can = canIssue && atomic !== null && problem === null && !busy;
  const token = details.symbol ? `${details.symbol} on ${details.chain_name}` : details.chain_name;

  async function record() {
    setTouched(true);
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      await api.gateway.createRefund({ paymentId: payment.id, amount: atomic!.toString(), reason, note: note.trim() || undefined, manual: { chain: details.chain, tx_hash: hash.trim() } }, idem);
      toast.success(`Refund of ${formatToken(atomic!, t.symbol, t.decimals)} recorded`, { description: `Sent from your wallet on ${details.chain_name}.` });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: gk.all });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent sheetOnMobile className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{canIssue ? "Refund payment" : "Refund details"}</DialogTitle>
          <DialogDescription>
            Up to <span className="num font-medium text-foreground">{formatToken(max, t.symbol, t.decimals)}</span> is available to refund.
          </DialogDescription>
        </DialogHeader>
        <form
          id="manual-refund-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
        >
          <div className="flex flex-col gap-2.5">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden /> This payment came from another chain
            </p>
            <dl className="divide-y rounded-xl border text-sm">
              <div className="flex flex-col gap-2 px-3.5 py-2.5">
                <dt className="text-muted-foreground">Buyer&apos;s refund address</dt>
                {details.refund_to ? (
                  <>
                    <dd className="hash text-[0.8125rem] leading-relaxed [overflow-wrap:anywhere] select-all">{details.refund_to}</dd>
                    <CopyAction value={details.refund_to} label="Copy address" className="h-11 self-start md:h-9" />
                  </>
                ) : (
                  <dd className="text-pretty">The buyer paid without giving an address. Ask them for their {details.chain_name} address, then send the refund there.</dd>
                )}
              </div>
              <ManualLine k="Chain and token" v={token} />
              <ManualLine k="Original deposit" v={details.deposit_tx ? <TxValue tx={details.deposit_tx} /> : <span className="text-muted-foreground">-</span>} />
              <ManualLine k="Refundable" v={<span className="num font-medium">{formatToken(max, t.symbol, t.decimals)}</span>} />
            </dl>
          </div>
          <p className="flex gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-[0.8125rem] text-primary">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Send the refund from your business&apos;s own wallet on {details.chain_name} to the address above, then record it here with that transaction. Payminto does not move this money, and a refund cannot be reversed.
            </span>
          </p>
          {canIssue ? (
            <>
              <FormRow id="manual-amount" label="Amount refunded" hint={`In ${t.symbol}, up to ${formatToken(max, t.symbol, t.decimals)}.`} error={amount && !parsed.ok ? parsed.error : null}>
                <div className="relative">
                  <Input id="manual-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="num h-11 pr-16 text-base md:h-9 md:text-sm" aria-invalid={Boolean(amount && !parsed.ok)} />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{t.symbol}</span>
                </div>
              </FormRow>
              <FormRow
                id="manual-hash"
                label={`Transaction hash on ${details.chain_name}`}
                hint="The transaction your wallet sent the refund in."
                error={(touched || hash.trim() !== "") && problem ? problem : null}
              >
                <Input
                  id="manual-hash"
                  value={hash}
                  onChange={(e) => setHash(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder={details.chain === "sol" ? "Signature" : "0x..."}
                  className="hash h-11 text-base md:h-9 md:text-[0.8125rem]"
                  aria-invalid={(touched || hash.trim() !== "") && problem !== null}
                  autoCapitalize="none"
                  spellCheck={false}
                  autoComplete="off"
                />
              </FormRow>
              <FormRow id="manual-reason" label="Reason">
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger id="manual-reason" className="w-full">
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
              <FormRow id="manual-note" label="Internal note" optional hint="Only your team can see this. The customer never does.">
                <Textarea id="manual-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={2} placeholder="Why, ticket number, who asked" />
              </FormRow>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">An Admin sends this refund from the business&apos;s wallet and records it here.</p>
          )}
          {error && (
            <p role="alert" className="flex gap-2 rounded-lg bg-negative-soft px-3 py-2.5 text-[0.8125rem] text-negative">
              <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error} Nothing was recorded.</span>
            </p>
          )}
        </form>
        {canIssue && (
          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <Button type="submit" form="manual-refund-form" disabled={busy || atomic === null || max === 0n}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden />}
              {atomic !== null ? `Record refund of ${formatToken(atomic, t.symbol, t.decimals)}` : "Record refund"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ManualLine({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 px-3.5 py-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className="flex min-w-0 justify-end text-right break-words">{v}</dd>
    </div>
  );
}
