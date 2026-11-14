"use client";

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { depositEvmTransaction, depositPaymentUri } from "@payminto/protocol";
import { AlertTriangle, Check, ChevronDown, Clock3, ExternalLink, FlaskConical, LoaderCircle, Mail, RotateCw, Smartphone, Undo2, Wallet, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/http";
import type { CheckoutApi } from "@/lib/gateway-api";
import { checkEvmTransaction, evmProvider, evmWalletErrorMessage, payWithEvmWallet } from "@/lib/evm-wallet";
import type { CheckoutView, IntentsOption, IntentsQuote, IntentsStep, IntentsTx } from "@/lib/schemas";
import {
  amountText,
  DEPOSIT_QR_CAPTION,
  deadlineModel,
  depositFeeLines,
  depositQr,
  exactUnits,
  expiredCopy,
  failedCopy,
  incompleteCopy,
  intentsStage,
  modeChip,
  preselectOrigin,
  refundWhere,
  refundKept,
  returnedCopy,
  sendNow,
  sendNowAtomic,
  shortAmount,
  wrongDepositCopy,
} from "@/lib/intents";
import { useNow } from "@/components/app/time-ago";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BrandButton, CopyAction, CopyIcon, Notice, StateIcon } from "./parts";
import { Shimmer, T } from "./motion";

/**
 * The any-chain checkout on the hosted page, on one screen (docs/superpowers/specs/2026-11-14-one-screen-checkout.md): pay
 * with a token and chain, and its deposit address is already there to scan; or see why a deposit came back. The success
 * screen is the checkout's own. The node talks to 1Click and checks every quote; this page only shows what it says.
 */

// ---------------------------------------------------------------------------
// The label every intents element carries
// ---------------------------------------------------------------------------

/** "Simulated" or "Live - NEAR mainnet", always beside intents data, so simulated money is never taken for real money. */
export function IntentsLabel({ mode, label, className }: { mode: "simulated" | "live"; label?: string; className?: string }) {
  const live = mode === "live";
  return (
    <span
      title={label ?? (live ? "Live - NEAR mainnet: real money" : "Simulated - no real money")}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        live ? "bg-info-soft text-primary" : "bg-warning-soft text-warning",
        className,
      )}
    >
      {live ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : <FlaskConical className="size-3.5" aria-hidden />}
      {modeChip(mode)}
      {!live && <span className="sr-only"> - no real money</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Newest of the views of one quote: the stream's, a mutation's answer or a poll's. */
function newest(...qs: (IntentsQuote | null | undefined)[]): IntentsQuote | null {
  return qs.filter((q): q is IntentsQuote => Boolean(q)).reduce<IntentsQuote | null>((a, q) => (!a || q.updated_at >= a.updated_at ? q : a), null);
}

/**
 * Money is on its way through this quote: it stays on screen whatever the buyer picks. A quote that ended without paying
 * (returned, failed) shows until the buyer tries again or picks another chain.
 */
const MONEY_IN = new Set(["deposit_detected", "incomplete_deposit", "processing", "delivered", "confirmed"]);
const ENDED = new Set(["confirmed", "refunded", "failed", "expired"]);

export function useIntentsOptions(api: CheckoutApi, paymentId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["intents-options", paymentId],
    queryFn: () => api.intentsOptions(paymentId),
    enabled,
    // The node caches dry quotes for 30 seconds; asking again then shows fresh prices without a reload.
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 1,
  });
}

/**
 * The any-chain checkout on one screen (docs/superpowers/specs/2026-11-14-one-screen-checkout.md): "Pay with" a token
 * and chain, and the deposit address for it, already there to scan. The address is made as the screen opens and again
 * when the buyer picks another chain (the node reuses one per chain). Nothing is asked of the buyer: a deposit that
 * cannot complete goes back to the business's NEAR Intents balance. NEAR Intents converts it in the background.
 */
export function AnyChainPanel({ view, api, streaming, options, onRefresh }: { view: CheckoutView; api: CheckoutApi; streaming: boolean; options: ReturnType<typeof useIntentsOptions>; onRefresh: () => void }) {
  const qc = useQueryClient();
  const rows = options.data?.options ?? [];
  const fromView = view.intents?.active_quote ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [byOrigin, setByOrigin] = useState<Record<string, IntentsQuote>>({});
  const open = view.status === "open";
  const unavailable = view.intents && !view.intents.available ? view.intents.reason : null;

  // A quote that money reached stays on screen; otherwise the buyer's pick, else the one already waiting, else the default.
  const locked = fromView && MONEY_IN.has(fromView.status) ? fromView : null;
  const waiting = fromView && fromView.status === "awaiting_deposit" && !fromView.deadline_passed ? fromView.origin.asset : null;
  const firstOpen = rows.find((o) => o.available)?.origin.asset ?? null;
  const chosen = locked?.origin.asset ?? picked ?? waiting ?? preselectOrigin(rows, view.intents?.default_origin) ?? firstOpen;
  const row = rows.find((o) => o.origin.asset === chosen) ?? null;

  const create = useMutation({
    mutationFn: (asset: string) => api.createIntentsQuote(view.id, { origin_asset: asset }, `${view.id}:${asset}:${newKey()}`),
    onSuccess: (q) => {
      setByOrigin((m) => ({ ...m, [q.origin.asset]: q }));
      qc.setQueryData(["intents-quote", view.id, q.id], q);
    },
  });

  const local = chosen ? byOrigin[chosen] : undefined;
  const target = locked ?? (local && fromView?.id === local.id ? newest(local, fromView) : (local ?? (fromView && fromView.origin.asset === chosen ? fromView : null)));
  const ended = target ? ENDED.has(target.status) : true;
  const poll = useQuery({
    queryKey: ["intents-quote", view.id, target?.id ?? null],
    queryFn: () => api.intentsQuote(view.id, target!.id),
    enabled: Boolean(target) && !streaming && !ended,
    refetchInterval: 3_000,
  });
  const q = target ? newest(target, poll.data?.id === target.id ? poll.data : null, fromView?.id === target.id ? fromView : null) : null;

  // The address for the chosen chain, as soon as it is chosen: once per chain, unless the buyer asks again.
  const wants = open && !unavailable && !locked && Boolean(row?.available) && !q && !create.isPending && !(create.isError && create.variables === chosen);
  useEffect(() => {
    if (wants && chosen) create.mutate(chosen);
  }, [wants, chosen, create]);

  const choose = (asset: string) => {
    if (asset === chosen) return;
    create.reset();
    setPicked(asset);
  };
  const again = () => {
    if (!chosen) return;
    setByOrigin((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== chosen)));
    create.reset();
    create.mutate(chosen);
  };

  const stage = q ? intentsStage(q) : null;
  return (
    <div className="flex flex-col gap-4">
      {!locked && (
        <PayWith rows={rows} value={chosen} onChange={choose} loading={options.isPending} error={options.isError ? (options.error instanceof Error ? options.error.message : "The prices could not be loaded.") : null} onRetry={() => void options.refetch()} merchant={view.merchant.name} />
      )}
      {/* While money it already took is confirming, the node offers no new address; the deposit on screen stays. */}
      {unavailable && !locked ? (
        <Notice tone="neutral" icon={<AlertTriangle />}>
          {unavailable}
        </Notice>
      ) : row && !row.available && !locked ? (
        <Notice tone="neutral" icon={<AlertTriangle />}>
          {row.reason ?? "This token is not available for this payment. Pick another one."}
        </Notice>
      ) : create.isError && !q ? (
        <Notice tone="negative" icon={<AlertTriangle />}>
          <p>{quoteErrorText(create.error)} No money moved.</p>
          <button type="button" onClick={again} className="mt-1 inline-flex min-h-11 items-center gap-1 font-medium underline underline-offset-2 md:min-h-8">
            <RotateCw className="size-3.5" aria-hidden /> Try again
          </button>
        </Notice>
      ) : !q ? (
        <SendSkeleton />
      ) : stage === "returned" || stage === "failed" || stage === "expired" ? (
        <Ended view={view} q={q} stage={stage} onTryAgain={open ? again : null} />
      ) : RECEIVED.has(q.status) ? (
        <ReceivedScreen view={view} q={q} />
      ) : (
        <SendScreen view={view} api={api} q={q} onQuote={(next) => setByOrigin((m) => ({ ...m, [next.origin.asset]: next }))} onRefresh={onRefresh} />
      )}
    </div>
  );
}

/** How long a wallet's transaction may stay unknown to the chain before the page says the wallet did not send it. */
const UNSEEN_AFTER_MS = 60_000;

const noChange = () => () => undefined;
/** Whether this browser has an EVM wallet (an extension, or a wallet app's own browser); false while rendering on the server. */
function useHasEvmWallet(): boolean {
  return useSyncExternalStore(noChange, () => evmProvider() !== null, () => false);
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// "Pay with": the token, then the chain, on the same screen
// ---------------------------------------------------------------------------

function PayWith({
  rows,
  value,
  onChange,
  loading,
  error,
  onRetry,
  merchant,
}: {
  rows: IntentsOption[];
  value: string | null;
  onChange: (asset: string) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  merchant: string;
}) {
  const current = rows.find((o) => o.origin.asset === value) ?? null;
  const tokens = [...new Set(rows.map((o) => o.origin.symbol))];
  const token = current?.origin.symbol ?? tokens[0] ?? null;
  const chains = rows.filter((o) => o.origin.symbol === token);
  const pickToken = (symbol: string) => {
    const same = rows.find((o) => o.origin.symbol === symbol && o.origin.chain === current?.origin.chain && o.available);
    const any = rows.find((o) => o.origin.symbol === symbol && o.available) ?? rows.find((o) => o.origin.symbol === symbol);
    const next = same ?? any;
    if (next) onChange(next.origin.asset);
  };
  if (error) {
    return (
      <Notice tone="negative" icon={<AlertTriangle />}>
        <p>{error}</p>
        <button type="button" onClick={onRetry} className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-2">
          <RotateCw className="size-3.5" aria-hidden /> Try again
        </button>
      </Notice>
    );
  }
  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading ways to pay" className="flex flex-col gap-2.5">
        <Shimmer className="h-4 w-28" />
        <Shimmer className="h-10 w-full rounded-xl" />
        <Shimmer className="h-10 w-full rounded-xl" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Pay with</h1>
        <p className="text-xs text-muted-foreground">Whatever you pick, NEAR Intents converts it and {merchant} receives USDC.</p>
      </div>
      {tokens.length > 1 && (
        <div role="radiogroup" aria-label="Token" className="grid gap-1 rounded-xl bg-muted p-1" style={{ gridTemplateColumns: `repeat(${tokens.length}, minmax(0, 1fr))` }}>
          {tokens.map((t) => {
            const on = t === token;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pickToken(t)}
                className={cn("h-11 rounded-lg text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring md:h-9", on ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}
      <div role="radiogroup" aria-label="Network" className="flex flex-wrap gap-1.5">
        {chains.map((o) => {
          const on = o.origin.asset === value;
          return (
            <button
              key={o.origin.asset}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${o.origin.symbol} on ${o.origin.chain_name}`}
              disabled={!o.available}
              title={o.available ? undefined : (o.reason ?? "Not available for this payment.")}
              onClick={() => onChange(o.origin.asset)}
              className={cn(
                "inline-flex h-11 items-center gap-2 rounded-full border px-3 pr-3.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 md:h-9",
                on ? "border-[var(--ink)] bg-[color-mix(in_srgb,var(--ink)_8%,var(--card))] text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <ChainDot chain={o.origin.chain} />
              {o.origin.chain_name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The node's words, with what to do for the cases a buyer can act on. */
function quoteErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "The deposit address could not be made.";
  switch (e.code) {
    case "RATE_LIMITED":
      return "Too many deposit addresses from this connection. Wait a minute and try again.";
    case "INTENTS_BUSY":
      return "NEAR Intents is busy right now. Try again in a moment.";
    case "INTENTS_QUOTE_REFUSED":
      return "The quote did not pass the payment server's checks, so no deposit address is shown. Try another token or try again.";
    default:
      return e.message;
  }
}

const CHAIN_TINT: Record<string, string> = { base: "#2151f5", eth: "#5b6b8c", arb: "#1b4add", sol: "#7c3aed", pol: "#7b3fe4" };
const TOKEN_TINT: Record<string, string> = { USDC: "#2775ca", USDT: "#26a17b", ETH: "#454a75" };

/** The chain's initial on its tint; no third-party logo. */
function ChainDot({ chain }: { chain: string }) {
  return (
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full text-[0.5625rem] leading-none font-bold text-white" style={{ background: CHAIN_TINT[chain] ?? "#475569" }}>
      {chain.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A plain coin mark with the chain's initial beside it; no third-party logo. */
export function OriginMark({ symbol, chain, muted }: { symbol: string; chain: string; muted?: boolean }) {
  return (
    <span aria-hidden className={cn("relative flex size-8 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-bold text-white", muted && "opacity-45 grayscale")} style={{ background: TOKEN_TINT[symbol] ?? "#475569" }}>
      {symbol.slice(0, 1)}
      <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border-2 border-card text-[0.5rem] leading-none" style={{ background: CHAIN_TINT[chain] ?? "#475569" }}>
        {chain.slice(0, 1).toUpperCase()}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Screen C: send exactly this, to this address, before this time
// ---------------------------------------------------------------------------

/** While the address for the chosen chain is being made: the shape of the send block, so nothing jumps. */
function SendSkeleton() {
  return (
    <div aria-busy="true" aria-label="Getting your payment address" className="flex flex-col gap-3">
      <Shimmer className="h-6 w-64" />
      <div className="flex items-center gap-4 rounded-xl border p-3.5">
        <Shimmer className="size-[6.5rem] rounded-lg" />
        <div className="flex flex-1 flex-col gap-2">
          <Shimmer className="h-4 w-32" />
          <Shimmer className="h-3 w-40" />
        </div>
      </div>
      <Shimmer className="h-14 w-full rounded-xl" />
    </div>
  );
}

/**
 * The deposit for the chosen chain, on the same screen as the picker: what to send, the wallet button, one status
 * line, and the rest (fees, progress, a transaction hash) folded under "Details".
 */
function SendScreen({ view, api, q, onQuote, onRefresh }: { view: CheckoutView; api: CheckoutApi; q: IntentsQuote; onQuote: (q: IntentsQuote) => void; onRefresh: () => void }) {
  const send = sendNow(q);
  const waiting = q.status === "awaiting_deposit" || q.status === "incomplete_deposit";
  return (
    <>
      <h2 className="text-base leading-snug font-semibold text-balance">
        {send.remaining ? "Send the remaining" : "Send exactly"}{" "}
        <span className="num whitespace-nowrap">
          {send.amount} {send.symbol}
        </span>{" "}
        on {q.origin.chain_name}
      </h2>
      {q.status === "incomplete_deposit" && (
        <Notice tone="warning" icon={<AlertTriangle />}>
          {incompleteCopy(q)}
        </Notice>
      )}
      {waiting && <PayFromWallet view={view} api={api} q={q} onQuote={onQuote} onRefresh={onRefresh} />}
      <SendBlock q={q} amount={`${send.amount} ${send.symbol}`} copyAmount={send.amount} dim={!waiting} />
      <StatusLine q={q} merchant={view.merchant.name} />
      {waiting && <p className="text-xs text-pretty text-muted-foreground">{q.warning}</p>}
      {waiting && q.mode === "simulated" && <SimulatePanel view={view} api={api} q={q} onQuote={onQuote} />}
      <details className="group rounded-xl border text-sm [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3.5 font-medium text-muted-foreground hover:text-foreground">
          Details
          <ChevronDown className="size-4 transition-transform duration-200 group-open:rotate-180" aria-hidden />
        </summary>
        <div className="flex flex-col gap-4 border-t p-3.5">
          <FeeLines q={q} merchant={view.merchant.name} />
          <Steps steps={q.steps} />
          <p className="text-xs text-pretty text-muted-foreground">{refundWhere(q, view.merchant.name)}</p>
          {q.status !== "confirmed" && <WrongDeposit view={view} q={q} />}
          {waiting && <SentIt view={view} api={api} q={q} onQuote={onQuote} onRefresh={onRefresh} />}
        </div>
      </details>
    </>
  );
}

/** The buyer's money arrived in full: their part is done, whatever NEAR Intents and the business still do with it. */
const RECEIVED = new Set(["deposit_detected", "processing", "delivered"]);

/**
 * "Payment received", as soon as the deposit is seen in full: the buyer is done. Converting it and delivering USDC to the
 * business happens in the background (the node keeps following it); the page moves on to the receipt once it lands.
 */
function ReceivedScreen({ view, q }: { view: CheckoutView; q: IntentsQuote }) {
  const sent = q.deposited ?? q.send_exactly;
  const tx = q.origin_txs[0] ?? null;
  return (
    <div className="flex flex-col items-center gap-4 pt-2 text-center">
      <StateIcon tone="positive" className="size-14">
        <Check />
      </StateIcon>
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.01em]">Payment received</h2>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          You&apos;re done. We received {amountText(sent)} on {q.origin.chain_name}. NEAR Intents is now converting it to USDC for {view.merchant.name}, usually within a minute; you can close this page.
        </p>
      </div>
      <dl className="w-full divide-y rounded-xl border text-left text-sm">
        <Line k="You sent" v={<span className="num font-medium">{amountText(sent)} on {q.origin.chain_name}</span>} />
        {tx && <Line k={`${q.origin.chain_name} transaction`} v={<TxValue tx={tx} />} />}
        <Line k={`${view.merchant.name} receives`} v={<span className="num font-medium">{amountText(q.amount_out)}</span>} />
      </dl>
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Finishing in the background: converting, then delivering to {view.merchant.name}.
      </p>
    </div>
  );
}

/** One line for where the payment is, instead of a list of steps: waiting (with the time left), received, or done. */
function StatusLine({ q, merchant }: { q: IntentsQuote; merchant: string }) {
  const now = useNow();
  const d = deadlineModel(q, now);
  const waiting = q.status === "awaiting_deposit" || q.status === "incomplete_deposit";
  const done = q.status === "confirmed";
  const color = waiting ? (d.tone === "danger" ? "text-negative" : d.tone === "warning" ? "text-warning" : "text-muted-foreground") : done ? "text-positive" : "text-foreground";
  return (
    <p role="status" className={cn("flex items-center gap-2 text-sm transition-colors duration-[400ms]", color)}>
      {done ? <Check className="size-4 shrink-0" aria-hidden /> : <LoaderCircle className={cn("size-4 shrink-0", waiting ? "animate-[spin_2.4s_linear_infinite]" : "animate-spin")} aria-hidden />}
      {waiting ? (
        <span>
          Waiting for your payment. Send before <span className="num font-medium">{d.clock}</span> <span className="num">({d.text} left)</span>
        </span>
      ) : done ? (
        <span>Paid. {merchant} received it.</span>
      ) : (
        <span>Payment received. Converting it for {merchant}, usually under a minute.</span>
      )}
    </p>
  );
}

/**
 * What to send, as one block: the QR, then the amount, the token on its network, and the address, each with its copy
 * button. Nothing here can be read apart from the rest, so the network is never far from the address.
 */
function SendBlock({ q, amount, copyAmount, dim }: { q: IntentsQuote; amount: string; copyAmount: string; dim: boolean }) {
  const [addressOnly, setAddressOnly] = useState(false);
  const toggleId = useId();
  const titleId = useId();
  // A wallet payment request only where it names the deposit address itself; the buyer can still ask for the bare address.
  const offered = depositQr(q, false, depositPaymentUri).wallet;
  const qr = depositQr(q, addressOnly, depositPaymentUri);
  return (
    <section role="group" aria-labelledby={titleId} className={cn("flex flex-col rounded-xl border transition-opacity duration-300", dim && "opacity-60")}>
      <h2 id={titleId} className="sr-only">
        What to send
      </h2>
      <div className="flex items-center gap-4 p-3.5">
        {/* Two modules of quiet zone inside the white tile, plus its padding, keep the code readable by phone cameras. */}
        <div className="shrink-0 rounded-lg border bg-white p-1.5">
          <QRCodeSVG
            value={qr.value}
            size={132}
            level="M"
            marginSize={2}
            title={qr.wallet ? `QR code of the payment request ${qr.value}` : `QR code of the deposit address ${q.deposit_address}`}
            className="block size-[6.5rem]"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-sm font-medium">{qr.wallet ? "Scan with your wallet app" : "Scan the address with your wallet app"}</p>
          <p className="text-xs text-pretty text-muted-foreground">{qr.wallet ? DEPOSIT_QR_CAPTION : "The code holds the address only. Type the exact amount in your wallet."}</p>
          {offered && (
            <label htmlFor={toggleId} className="-my-1 inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 self-start text-xs font-medium text-muted-foreground md:min-h-9">
              Address only
              <Switch id={toggleId} size="sm" checked={addressOnly} onCheckedChange={setAddressOnly} />
            </label>
          )}
        </div>
      </div>
      <dl className="divide-y border-t text-sm">
        <SendRow label="Amount, exactly" copy={<CopyAction value={copyAmount} label="Copy amount" short="Copy" toast="Amount copied" className="max-sm:h-11" />}>
          <span className="num text-[0.9375rem] font-semibold whitespace-nowrap">{amount}</span>
        </SendRow>
        <SendRow label="Token and network">
          <span className="font-medium">
            {q.origin.symbol} on {q.origin.chain_name}
          </span>
        </SendRow>
        <SendRow label={`Address on ${q.origin.chain_name}`} copy={<CopyAction value={q.deposit_address} label="Copy address" short="Copy" toast="Address copied" className="max-sm:h-11" />}>
          <span className="hash text-[0.8125rem] leading-relaxed [overflow-wrap:anywhere] select-all">{q.deposit_address}</span>
        </SendRow>
      </dl>
    </section>
  );
}

function SendRow({ label, children, copy }: { label: string; children: ReactNode; copy?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-0.5">{children}</dd>
      </div>
      {copy && <div className="shrink-0">{copy}</div>}
    </div>
  );
}

/**
 * "Pay with your wallet": the browser wallet (an extension, or a wallet app's own browser on a phone) sends the exact
 * transfer, so the buyer types no address and no amount. Live money only: a simulated deposit address is not real, and a
 * real wallet must never be asked to pay it. Solana and tokens without a transfer to build fall back to the address.
 */
function PayFromWallet({ view, api, q, onQuote, onRefresh }: { view: CheckoutView; api: CheckoutApi; q: IntentsQuote; onQuote: (q: IntentsQuote) => void; onRefresh: () => void }) {
  const has = useHasEvmWallet();
  const [hash, setHash] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState(0);
  // The wallet answered a hash: follow it on the chain, so a send that fails in the wallet is said, not waited on forever.
  const onChain = useQuery({
    queryKey: ["wallet-tx", hash],
    queryFn: () => checkEvmTransaction(hash!),
    enabled: Boolean(hash),
    refetchInterval: (query) => (query.state.data === "mined" || query.state.data === "reverted" ? false : 3_000),
  });
  const now = useNow();
  const o = q.origin;
  const tx = q.mode === "live" ? depositEvmTransaction({ chain: o.chain, chainId: o.chain_id ?? null, contractAddress: o.contract_address ?? null, decimals: o.decimals, symbol: o.symbol }, q.deposit_address, sendNowAtomic(q)) : null;
  const send = sendNow(q);
  const pay = useMutation({
    mutationFn: async () => {
      const need = { token: o.contract_address ?? null, amount: BigInt(sendNowAtomic(q)), decimals: o.decimals, symbol: o.symbol, chainName: o.chain_name };
      const r = await payWithEvmWallet(tx!, o.chain_name, need);
      setHash(r.hash);
      setSentAt(Date.now());
      // The money has left the wallet: telling the server only helps it see the deposit sooner, so a failure here is quiet.
      const next = await api.submitIntentsDeposit(view.id, q.id, r.hash).catch(() => null);
      if (next) onQuote(next);
      onRefresh();
    },
  });
  if (!tx) return null;
  if (!has) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-dashed px-3.5 py-2.5 text-xs text-pretty text-muted-foreground md:hidden">
        <Smartphone className="mt-px size-4 shrink-0 text-[var(--ink)]" aria-hidden />
        <span>On your phone? Open this page in your wallet app&apos;s browser to pay with one tap, or send to the address below.</span>
      </p>
    );
  }
  // Unknown to the chain a minute after the wallet answered: the wallet did not send it (its "Send failed").
  const failed = onChain.data === "reverted" || (onChain.data === "unknown" && now - sentAt > UNSEEN_AFTER_MS);
  if (hash && failed) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-xl border border-negative/40 bg-negative-soft/40 px-3.5 py-3 text-sm">
        <p className="flex items-start gap-2">
          <XCircle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden />
          <span className="min-w-0 text-pretty">
            {onChain.data === "reverted"
              ? `Your wallet's transaction failed on ${o.chain_name}. No money moved.`
              : `${o.chain_name} has not seen your wallet's transaction. If your wallet shows it failed, no money moved: check its balance of ${o.symbol} on ${o.chain_name} and try again.`}
          </span>
        </p>
        <button
          type="button"
          onClick={() => {
            setHash(null);
            pay.reset();
          }}
          className="inline-flex min-h-11 items-center gap-1.5 self-start rounded text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 md:min-h-8"
        >
          <RotateCw className="size-3.5" aria-hidden /> Try again
        </button>
      </div>
    );
  }
  if (hash) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm">
        <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {onChain.data === "mined" ? `Confirmed on ${o.chain_name}. NEAR Intents is converting it now: ` : `Sent from your wallet. Waiting for ${o.chain_name} to confirm it: `}
          <span className="hash text-[0.8125rem]">{hash}</span>
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <BrandButton onClick={() => pay.mutate()} disabled={pay.isPending} className={cn(pay.isPending && "disabled:opacity-100")}>
        {pay.isPending ? (
          <>
            <LoaderCircle className="animate-spin" aria-hidden /> Confirm in your wallet
          </>
        ) : (
          <>
            <Wallet aria-hidden /> Pay {send.amount} {send.symbol} with your wallet
          </>
        )}
      </BrandButton>
      {pay.error ? (
        <p className="text-center text-xs text-negative">{evmWalletErrorMessage(pay.error, "pay")}</p>
      ) : (
        <p className="text-center text-xs text-muted-foreground">Your wallet fills in the address, network and amount. Or send it yourself below.</p>
      )}
    </div>
  );
}

function Steps({ steps }: { steps: IntentsStep[] }) {
  return (
    <ol className="flex flex-col gap-0.5 rounded-xl border p-1.5" aria-label="Progress of your payment">
      {steps.map((s, i) => {
        const done = s.state === "done";
        const now = s.state === "current";
        const failed = s.state === "failed";
        return (
          <li key={s.key} aria-current={now ? "step" : undefined} className={cn("flex min-h-10 items-center gap-3 rounded-lg px-2.5 py-1.5 transition-colors duration-200", now && "bg-muted")}>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-200",
                done ? "border-transparent bg-positive text-white dark:text-background" : failed ? "border-transparent bg-negative-soft text-negative" : now ? "border-[var(--ink)] text-[var(--ink)]" : "text-muted-foreground",
              )}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={s.state} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={T.fast} className="flex">
                  {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : failed ? <X className="size-3.5" strokeWidth={3} aria-hidden /> : now ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : i + 1}
                </motion.span>
              </AnimatePresence>
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-sm", done || now ? "font-medium text-foreground" : failed ? "font-medium text-negative" : "text-muted-foreground")}>{s.label}</span>
            <span className="sr-only">{done ? "done" : now ? "in progress" : failed ? "stopped" : "to do"}</span>
          </li>
        );
      })}
    </ol>
  );
}

function FeeLines({ q, merchant }: { q: IntentsQuote; merchant: string }) {
  return (
    <dl className="divide-y rounded-xl border text-sm">
      {depositFeeLines(q.fees, merchant, q.destination).map(({ label, value, hint }) => (
        <div key={label} className="flex flex-col gap-0.5 px-3.5 py-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="min-w-0 text-muted-foreground">{label}</dt>
            <dd className="num shrink-0 text-right font-medium">{value}</dd>
          </div>
          {hint && <p className="text-xs text-subtle">{hint}</p>}
        </div>
      ))}
    </dl>
  );
}

/** Who to contact after a deposit that cannot count, with the address to quote; the address wraps, never scrolls. */
function WrongDeposit({ view, q }: { view: CheckoutView; q: IntentsQuote }) {
  return <p className="text-xs text-pretty text-muted-foreground [overflow-wrap:anywhere]">{wrongDepositCopy(view, q)}</p>;
}

/** Simulated mode only: what the buyer's wallet would do on another chain, done by the fake 1Click server. */
function SimulatePanel({ view, api, q, onQuote }: { view: CheckoutView; api: CheckoutApi; q: IntentsQuote; onQuote: (q: IntentsQuote) => void }) {
  const send = useMutation({ mutationFn: (amount?: string) => api.simulateIntentsDeposit(view.id, q.id, amount), onSuccess: onQuote });
  const short = shortAmount(q);
  const shortText = `${exactUnits(unitsFor(short, q.origin.decimals))} ${q.send_exactly.symbol}`;
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-warning/50 bg-warning-soft/40 p-3.5">
      <p className="flex items-center gap-2 text-sm font-medium">
        <FlaskConical className="size-4 text-warning" aria-hidden /> Simulated - no real money
      </p>
      <p className="text-xs text-muted-foreground">On this local setup no wallet can pay another chain. These buttons send the deposit for you on the simulated 1Click server.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => send.mutate(undefined)}
          disabled={send.isPending}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background transition-[filter,transform] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:opacity-50 md:h-10"
        >
          {send.isPending && send.variables === undefined ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
          Simulate deposit (local only)
        </button>
        <button
          type="button"
          onClick={() => send.mutate(short)}
          disabled={send.isPending}
          className="inline-flex h-11 items-center rounded-lg px-3 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 disabled:opacity-50 md:h-9"
        >
          Send too little ({shortText})
        </button>
      </div>
      {send.error && <p className="text-xs text-negative">{send.error.message}</p>}
    </div>
  );
}

const unitsFor = (atomic: string, decimals: number) => {
  const s = atomic.padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s;
};

/** "I've sent it": an optional transaction hash, which only helps 1Click see the deposit sooner. */
function SentIt({ view, api, q, onQuote, onRefresh }: { view: CheckoutView; api: CheckoutApi; q: IntentsQuote; onQuote: (q: IntentsQuote) => void; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [hash, setHash] = useState("");
  const id = useId();
  const valid = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,90})$/.test(hash.trim());
  const submit = useMutation({
    mutationFn: () => api.submitIntentsDeposit(view.id, q.id, hash.trim()),
    onSuccess: (next) => {
      onQuote(next);
      onRefresh();
    },
  });
  if (submit.isSuccess) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5 text-positive" aria-hidden /> Thanks. We are watching for that transaction; the steps above move when it lands.
      </p>
    );
  }
  return (
    <div className="border-t pt-3">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 md:min-h-9">
          <Check className="size-4" aria-hidden /> I&apos;ve sent it
        </button>
      ) : (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit.mutate();
          }}
        >
          <label htmlFor={id} className="text-sm font-medium">
            Transaction hash on {q.origin.chain_name} <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <div className="flex gap-2">
            <Input id={id} value={hash} onChange={(e) => setHash(e.target.value)} placeholder={q.origin.chain === "sol" ? "Signature" : "0x..."} className="hash h-11 text-base md:h-9 md:text-[0.8125rem]" spellCheck={false} autoCapitalize="none" autoComplete="off" autoFocus />
            <button
              type="submit"
              disabled={!valid || submit.isPending}
              className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 disabled:opacity-50 md:h-9 dark:bg-input/30"
            >
              {submit.isPending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : "Send"}
            </button>
          </div>
          <p className={cn("text-xs", hash && !valid ? "text-negative" : "text-muted-foreground")}>{hash && !valid ? "That does not look like a transaction hash." : "It only helps NEAR Intents see your deposit sooner. You do not need it."}</p>
          {submit.error && <p className="text-xs text-negative">{submit.error.message}</p>}
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen E: returned, failed, expired
// ---------------------------------------------------------------------------

function Ended({ view, q, stage, onTryAgain }: { view: CheckoutView; q: IntentsQuote; stage: "returned" | "failed" | "expired" | "deposit" | "incomplete" | "done"; onTryAgain: (() => void) | null }) {
  const refundTx = stage === "returned" ? (q.origin_txs.at(-1) ?? null) : null;
  const contact = view.merchant.support_email ? `mailto:${view.merchant.support_email}?subject=${encodeURIComponent(`Payment ${view.id}`)}` : null;
  const copy = stage === "returned" ? returnedCopy(q) : stage === "failed" ? failedCopy(view) : expiredCopy(q);
  const title = stage === "returned" ? "Your deposit was returned" : stage === "failed" ? "This payment could not be completed" : "This deposit address expired";
  return (
    <div className="flex flex-col items-center gap-4 pt-2 text-center">
      <StateIcon tone={stage === "failed" ? "negative" : stage === "returned" ? "warning" : "neutral"} className="size-14">
        {stage === "failed" ? <XCircle /> : stage === "returned" ? <Undo2 /> : <Clock3 />}
      </StateIcon>
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-balance">{title}</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">{copy}</p>
      </div>
      {stage === "expired" && <WrongDeposit view={view} q={q} />}
      {stage === "returned" && (
        <dl className="w-full divide-y rounded-xl border text-left text-sm">
          {q.deposited && <Line k="You sent" v={<span className="num font-medium">{amountText(q.deposited)}</span>} />}
          {q.refunded && <Line k="Returned" v={<span className="num font-medium">{amountText(q.refunded)}</span>} />}
          {refundKept(q) && <Line k="Refund fee, kept by NEAR Intents" v={<span className="num">{refundKept(q)}</span>} />}
          <Line k="To" v={<span className="hash text-[0.8125rem]">{q.refund_to}</span>} />
          {refundTx && <Line k="Your deposit" v={<TxValue tx={refundTx} />} />}
        </dl>
      )}
      <div className="flex w-full flex-col gap-2">
        {onTryAgain && (
          <BrandButton onClick={onTryAgain}>
            <RotateCw aria-hidden /> {stage === "expired" ? "Get a new address" : "Try again"}
          </BrandButton>
        )}
        {stage === "failed" && contact && (
          <a href={contact} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border bg-background text-sm font-medium hover:bg-muted focus-visible:outline-2 dark:bg-input/30">
            <Mail className="size-4" aria-hidden /> Contact {view.merchant.name}
          </a>
        )}
      </div>
    </div>
  );
}

function Line({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 px-3.5 py-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className="flex min-w-0 justify-end text-right break-words">{v}</dd>
    </div>
  );
}

/** A transaction on another chain or on NEAR: a link when there is an explorer, else the hash with copy. */
export function TxValue({ tx, className }: { tx: IntentsTx; className?: string }) {
  const short = tx.hash.length > 20 ? `${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}` : tx.hash;
  return tx.explorer_url ? (
    <a href={tx.explorer_url} target="_blank" rel="noreferrer" title={tx.hash} className={cn("inline-flex items-center gap-1 rounded underline-offset-2 hover:underline", className)}>
      <span className="hash text-[0.8125rem]">{short}</span>
      <ExternalLink className="size-3.5 text-subtle" aria-hidden />
      <span className="sr-only">(opens the explorer)</span>
    </a>
  ) : (
    <span className={cn("inline-flex items-center gap-0.5", className)} title={tx.hash}>
      <span className="hash text-[0.8125rem]">{short}</span>
      <CopyIcon value={tx.hash} label="transaction" />
    </span>
  );
}
