"use client";

import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { AlertTriangle, ArrowLeft, Check, Clock3, ExternalLink, FlaskConical, LoaderCircle, Mail, RotateCw, Undo2, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/http";
import type { CheckoutApi } from "@/lib/gateway-api";
import type { CheckoutView, IntentsOption, IntentsQuote, IntentsStep, IntentsTx } from "@/lib/schemas";
import {
  amountText,
  deadlineModel,
  exactUnits,
  expiredCopy,
  failedCopy,
  incompleteCopy,
  intentsStage,
  modeChip,
  refundAddressProblem,
  refundPlaceholder,
  returnedCopy,
  shortAmount,
  timeEstimateText,
} from "@/lib/intents";
import { useNow } from "@/components/app/time-ago";
import { Input } from "@/components/ui/input";
import { BrandButton, CopyAction, CopyIcon, Notice, StateIcon } from "./parts";
import { Bar, Shimmer, Swap, T, useCalm } from "./motion";

/**
 * The any-chain checkout on the hosted page (docs/DEVELOPERS.md, "Any-chain checkout"): pick a token and chain (screen
 * B), send to a deposit address (C), follow it to the merchant (C's steps), or see why it came back (E). The success
 * screen (D) is the checkout's own. The node talks to 1Click and checks every quote; this page only shows what it says.
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
 * The quote on screen, kept current: the checkout's SSE stream carries `intents.active_quote`; when the stream is not
 * open the page asks for the quote every few seconds until it reaches an end.
 */
function useQuoteOnScreen(api: CheckoutApi, view: CheckoutView, local: IntentsQuote | null, streaming: boolean): IntentsQuote | null {
  const fromView = view.intents?.active_quote ?? null;
  const target = local && (!fromView || local.id === fromView.id || local.created_at >= fromView.created_at) ? local : fromView;
  const ended = target ? ["confirmed", "refunded", "failed", "expired"].includes(target.status) : true;
  const poll = useQuery({
    queryKey: ["intents-quote", view.id, target?.id ?? null],
    queryFn: () => api.intentsQuote(view.id, target!.id),
    enabled: Boolean(target) && !streaming && !ended,
    refetchInterval: 3_000,
  });
  if (!target) return null;
  return newest(...[fromView, local, poll.data].filter((q) => q?.id === target.id));
}

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

export function AnyChainPanel({ view, api, streaming, options, onRefresh }: { view: CheckoutView; api: CheckoutApi; streaming: boolean; options: ReturnType<typeof useIntentsOptions>; onRefresh: () => void }) {
  const [local, setLocal] = useState<IntentsQuote | null>(null);
  const [picking, setPicking] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);
  const [refund, setRefund] = useState("");
  const q = useQuoteOnScreen(api, view, local, streaming);
  const mode = view.intents?.mode ?? q?.mode ?? "simulated";
  const open = view.status === "open";

  const show = (next: IntentsQuote) => {
    setLocal(next);
    setPicking(false);
  };
  const startOver = () => {
    setPicking(true);
    if (q) setOrigin(q.origin.asset);
  };

  const stage = q ? intentsStage(q) : null;
  const choosing = !q || picking;
  return (
    <Swap id={choosing ? "choose" : `quote-${q?.id}-${stage}`} className="flex flex-col gap-5">
      {choosing ? (
        <ChooseOrigin
          view={view}
          api={api}
          mode={mode}
          options={options}
          origin={origin}
          setOrigin={setOrigin}
          refund={refund}
          setRefund={setRefund}
          onQuote={show}
          back={q && (stage === "deposit" || stage === "incomplete") ? () => setPicking(false) : null}
        />
      ) : stage === "deposit" || stage === "incomplete" ? (
        <DepositScreen view={view} api={api} q={q!} onQuote={setLocal} onChangeToken={startOver} onRefresh={onRefresh} />
      ) : stage === "done" ? (
        <DepositScreen view={view} api={api} q={q!} onQuote={setLocal} onChangeToken={null} onRefresh={onRefresh} />
      ) : (
        <Ended view={view} q={q!} stage={stage!} onTryAgain={open ? startOver : null} />
      )}
    </Swap>
  );
}

// ---------------------------------------------------------------------------
// Screen B: one list of tokens and chains, one refund address, one button
// ---------------------------------------------------------------------------

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ChooseOrigin({
  view,
  api,
  mode,
  options,
  origin,
  setOrigin,
  refund,
  setRefund,
  onQuote,
  back,
}: {
  view: CheckoutView;
  api: CheckoutApi;
  mode: "simulated" | "live";
  options: ReturnType<typeof useIntentsOptions>;
  origin: string | null;
  setOrigin: (a: string) => void;
  refund: string;
  setRefund: (v: string) => void;
  onQuote: (q: IntentsQuote) => void;
  back: (() => void) | null;
}) {
  const qc = useQueryClient();
  const refundId = useId();
  const [touched, setTouched] = useState(false);
  // One key per attempt: a retry of the same press (a lost answer, a double click) gets the same deposit address.
  const [attempt, setAttempt] = useState<{ key: string; body: string } | null>(null);
  const rows = options.data?.options ?? [];
  const picked = rows.find((o) => o.origin.asset === origin && o.available) ?? null;
  const problem = picked ? refundAddressProblem(picked.origin, refund) : null;
  const ready = Boolean(picked) && problem === null;
  const create = useMutation({
    mutationFn: () => {
      const body = { origin_asset: picked!.origin.asset, refund_to: refund.trim() };
      const text = JSON.stringify(body);
      const key = attempt && attempt.body === text ? attempt.key : newKey();
      if (!attempt || attempt.key !== key) setAttempt({ key, body: text });
      return api.createIntentsQuote(view.id, body, key);
    },
    onSuccess: (q) => {
      setAttempt(null);
      qc.setQueryData(["intents-quote", view.id, q.id], q);
      onQuote(q);
    },
  });
  const error = create.error;
  const unavailable = view.intents && !view.intents.available ? view.intents.reason : null;

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-[-0.01em]">Pay from another chain</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Pick a token you hold. {view.merchant.name} receives USDC on NEAR.</p>
        </div>
      </div>
      {back && (
        <button type="button" onClick={back} className="-mt-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2">
          <ArrowLeft className="size-4" aria-hidden /> Back to your deposit address
        </button>
      )}
      {unavailable ? (
        <Notice tone="neutral" icon={<AlertTriangle />}>
          {unavailable}
        </Notice>
      ) : options.isError ? (
        <Notice tone="negative" icon={<AlertTriangle />}>
          <p>{options.error instanceof Error ? options.error.message : "The prices could not be loaded."}</p>
          <button type="button" onClick={() => void options.refetch()} className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-2">
            <RotateCw className="size-3.5" aria-hidden /> Try again
          </button>
        </Notice>
      ) : (
        <fieldset className="min-w-0">
          <legend className="mb-2 flex w-full items-center justify-between gap-3 text-sm font-medium">
            Token and network
            {options.data && <span className="text-xs font-normal text-muted-foreground">Prices are estimates</span>}
          </legend>
          {options.isPending ? (
            <div aria-busy="true" aria-label="Loading prices" className="divide-y overflow-hidden rounded-xl border">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex h-[3.75rem] items-center gap-3 px-3.5">
                  <Shimmer className="size-8 rounded-full" />
                  <Shimmer className="h-4 w-28" />
                  <Shimmer className="ml-auto h-4 w-24" />
                </div>
              ))}
            </div>
          ) : (
            <OriginList rows={rows} value={origin} onChange={(a) => (setOrigin(a), create.reset())} />
          )}
        </fieldset>
      )}
      <AnimatePresence initial={false}>
        {picked && (
          <motion.div key="refund" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={T.base} className="overflow-hidden">
            <div className="flex flex-col gap-1.5 p-px">
              <label htmlFor={refundId} className="text-sm font-medium">
                Refund address on {picked.origin.chain_name}
              </label>
              <Input
                id={refundId}
                value={refund}
                onChange={(e) => (setRefund(e.target.value), create.reset())}
                onBlur={() => setTouched(true)}
                placeholder={refundPlaceholder(picked.origin)}
                aria-invalid={touched && refund.trim() !== "" && problem !== null}
                aria-describedby={`${refundId}-hint`}
                className="hash h-11 text-base md:text-[0.8125rem]"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
              />
              <p id={`${refundId}-hint`} className={cn("text-xs", touched && refund.trim() !== "" && problem ? "text-negative" : "text-muted-foreground")}>
                {touched && refund.trim() !== "" && problem ? problem : "If anything goes wrong, the money goes back here. Use the address you pay from."}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={T.base} className="overflow-hidden">
            <Notice tone="negative" icon={<AlertTriangle />}>
              {quoteErrorText(error)} No money moved.
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="sticky bottom-0 z-10 -mx-1 bg-card px-1 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:pb-0">
        <BrandButton onClick={() => create.mutate()} disabled={!ready || create.isPending || Boolean(unavailable)} className={cn(create.isPending && "disabled:opacity-100")}>
          {create.isPending ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden /> Getting your address
            </>
          ) : (
            "Get deposit address"
          )}
        </BrandButton>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          You send from your own wallet. NEAR Intents swaps it to USDC for {view.merchant.name}
          {mode === "simulated" ? ". Simulated: no real money moves." : "."}
        </p>
      </div>
    </>
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

/** One radio row per token and chain: the estimate and the time, or the reason it cannot be used. */
function OriginList({ rows, value, onChange }: { rows: IntentsOption[]; value: string | null; onChange: (asset: string) => void }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label="Token and network" className="divide-y overflow-hidden rounded-xl border">
      {rows.map((o) => {
        const id = `${name}-${o.origin.asset}`;
        const checked = value === o.origin.asset;
        const eta = timeEstimateText(o.time_estimate_sec);
        return (
          <label
            key={o.origin.asset}
            htmlFor={id}
            className={cn(
              "relative flex min-h-[3.75rem] items-center gap-3 px-3.5 py-2.5 transition-colors duration-150",
              o.available ? "cursor-pointer hover:bg-muted/50" : "cursor-not-allowed",
              checked && "bg-[color-mix(in_srgb,var(--ink)_7%,var(--card))] hover:bg-[color-mix(in_srgb,var(--ink)_9%,var(--card))]",
            )}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={o.origin.asset}
              checked={checked}
              disabled={!o.available}
              onChange={() => onChange(o.origin.asset)}
              className="peer sr-only"
              aria-label={`${o.origin.symbol} on ${o.origin.chain_name}`}
              aria-describedby={`${id}-d`}
            />
            {/* The selected row: an ink frame, drawn inside so rows never shift; the keyboard focus ring sits inside it too. */}
            <span aria-hidden className={cn("pointer-events-none absolute inset-0 border-2 transition-colors duration-150", checked ? "border-[var(--ink)]" : "border-transparent", "peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-4 peer-focus-visible:outline-ring")} />
            <OriginMark symbol={o.origin.symbol} chain={o.origin.chain} muted={!o.available} />
            <span className={cn("min-w-0 flex-1", !o.available && "text-muted-foreground")}>
              <span className="block truncate text-sm">
                <span className="font-medium">{o.origin.symbol}</span> <span className="text-muted-foreground">on {o.origin.chain_name}</span>
              </span>
              {o.available ? (
                eta && <span className="block text-xs text-muted-foreground">{eta}</span>
              ) : (
                <span id={`${id}-d`} className="block text-xs text-pretty text-muted-foreground">
                  {o.reason ?? "Not available for this payment."}
                </span>
              )}
            </span>
            {o.available && o.amount_in && (
              <span id={`${id}-d`} className="shrink-0 text-right">
                <span className="block text-xs text-muted-foreground">about</span>
                <span className="num block text-[0.8125rem] font-medium">{amountText(o.amount_in)}</span>
              </span>
            )}
            {checked && (
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--ink)] text-card">
                <Check className="size-3" strokeWidth={3} />
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

const CHAIN_TINT: Record<string, string> = { base: "#2151f5", eth: "#5b6b8c", arb: "#1b4add", sol: "#7c3aed", pol: "#7b3fe4" };
const TOKEN_TINT: Record<string, string> = { USDC: "#2775ca", USDT: "#26a17b", ETH: "#454a75" };

/** A plain coin mark with the chain's initial beside it; no third-party logo. */
function OriginMark({ symbol, chain, muted }: { symbol: string; chain: string; muted?: boolean }) {
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

function DepositScreen({ view, api, q, onQuote, onChangeToken, onRefresh }: { view: CheckoutView; api: CheckoutApi; q: IntentsQuote; onQuote: (q: IntentsQuote) => void; onChangeToken: (() => void) | null; onRefresh: () => void }) {
  const now = useNow();
  const d = deadlineModel(q, now);
  const amount = exactUnits(q.send_exactly.formatted);
  const waiting = q.status === "awaiting_deposit" || q.status === "incomplete_deposit";
  const chain = q.origin.chain_name;
  return (
    <>
      <div>
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 text-lg leading-snug font-semibold tracking-[-0.01em] text-balance">
            Send exactly{" "}
            <span className="num whitespace-nowrap">
              {amount} {q.send_exactly.symbol}
            </span>{" "}
            on {chain}
          </h1>
          <CopyAction value={amount} label="Copy amount" toast="Amount copied" className="shrink-0" />
        </div>
        {waiting && <DeadlineLine d={d} />}
      </div>
      {q.status === "incomplete_deposit" && (
        <Notice tone="warning" icon={<AlertTriangle />}>
          {incompleteCopy(q)}
        </Notice>
      )}
      <DepositAddress q={q} dim={!waiting} />
      <Notice tone="warning" icon={<AlertTriangle />}>
        {q.warning}
      </Notice>
      <Steps steps={q.steps} />
      <FeeLines q={q} merchant={view.merchant.name} />
      {waiting && q.mode === "simulated" && <SimulatePanel view={view} api={api} q={q} onQuote={onQuote} />}
      {waiting && <SentIt view={view} api={api} q={q} onQuote={onQuote} onRefresh={onRefresh} />}
      {onChangeToken && waiting && (
        <button type="button" onClick={onChangeToken} className="-mt-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2">
          <Undo2 className="size-4" aria-hidden /> Change token
        </button>
      )}
    </>
  );
}

function DeadlineLine({ d }: { d: ReturnType<typeof deadlineModel> }) {
  const calm = useCalm();
  const color = d.tone === "danger" ? "text-negative" : d.tone === "warning" ? "text-warning" : "text-muted-foreground";
  const bar = d.tone === "danger" ? "bg-negative" : d.tone === "warning" ? "bg-warning" : "bg-[var(--ink)]";
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className={cn("flex items-center gap-1.5 text-xs transition-colors duration-[400ms]", color)}>
        <Clock3 className="size-3.5 shrink-0" aria-hidden />
        <span>
          Send before <span className="num font-medium">{d.clock}</span> <span className="num" aria-hidden>({d.text} left)</span>
          <span className="sr-only">, {Math.ceil(d.seconds / 60)} minutes left</span>
        </span>
      </p>
      {!calm && <Bar fraction={d.fraction} linear className="h-1" barClassName={cn("transition-colors duration-[400ms]", bar)} />}
    </div>
  );
}

function DepositAddress({ q, dim }: { q: IntentsQuote; dim: boolean }) {
  return (
    <div className={cn("flex flex-col items-center gap-4 rounded-xl border p-4 transition-opacity duration-300 sm:flex-row sm:items-start", dim && "opacity-60")}>
      <div className="shrink-0 rounded-lg border bg-white p-2.5">
        <QRCodeSVG value={q.deposit_address} size={132} level="M" marginSize={0} title={`QR code of the deposit address ${q.deposit_address}`} className="block size-[7.5rem] sm:size-[6.5rem]" />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Deposit address on {q.origin.chain_name}</p>
        <p className="hash text-[0.8125rem] leading-relaxed [overflow-wrap:anywhere] select-all">{q.deposit_address}</p>
        <CopyAction value={q.deposit_address} label="Copy address" toast="Address copied" className="self-start" />
      </div>
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
  const f = q.fees;
  const swap = f.swap_cost.unit === "USD" ? `$${exactUnits(f.swap_cost.formatted)}` : `${exactUnits(f.swap_cost.formatted)} ${f.swap_cost.unit}`;
  const eta = timeEstimateText(f.time_estimate_sec);
  const rows: [ReactNode, ReactNode, ReactNode?][] = [
    [`${merchant} receives`, `${amountText(f.merchant_receives)} on NEAR`],
    ["Swap and delivery cost", swap, "Paid by you, from the quote NEAR Intents signed."],
    ["Price buffer", amountText(f.price_buffer), "Returned to your refund address if unused."],
    ...(eta ? ([["Arrives in", eta, "After your deposit is confirmed on its chain."]] as [ReactNode, ReactNode, ReactNode][]) : []),
  ];
  return (
    <dl className="divide-y rounded-xl border text-sm">
      {rows.map(([k, v, hint], i) => (
        <div key={i} className="flex flex-col gap-0.5 px-3.5 py-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="min-w-0 text-muted-foreground">{k}</dt>
            <dd className="num shrink-0 text-right font-medium">{v}</dd>
          </div>
          {hint && <p className="text-xs text-subtle">{hint}</p>}
        </div>
      ))}
    </dl>
  );
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
      {stage === "returned" && (
        <dl className="w-full divide-y rounded-xl border text-left text-sm">
          {q.deposited && <Line k="You sent" v={<span className="num font-medium">{amountText(q.deposited)}</span>} />}
          {q.refunded && <Line k="Returned" v={<span className="num font-medium">{amountText(q.refunded)}</span>} />}
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
