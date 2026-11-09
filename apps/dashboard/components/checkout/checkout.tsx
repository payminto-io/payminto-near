"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import type { Address } from "viem";
import { AnimatePresence, motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Mail,
  Printer,
  QrCode,
  RotateCw,
  SearchX,
  Send,
  ShieldCheck,
  Wallet,
  WifiOff,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDocumentTitle } from "@/lib/use-title";
import { formatDateTime, formatToken, shortAddress, shortHash } from "@/lib/format";
import { gatewayNetwork, groupAddress, manualPaymentUri, plainAmount, safeRedirectUrl, type GatewayNetwork } from "@/lib/gateway";
import {
  availableMethods,
  checkoutModel,
  CONFIRM_STEPS,
  confirmationProgress,
  HSP_STEPS,
  hspInFlight,
  hspProgress,
  initialMethod,
  METHOD_COPY,
  METHOD_FEE_LABEL,
  quoteFor,
  redirectFraction,
  redirectSecondsLeft,
  REDIRECT_SECONDS,
  rememberedReceiptEmail,
  rememberQuote,
  rememberReceiptEmail,
  WALLET_STEPS,
  walletStepCopy,
  walletStepIndex,
  type CheckoutModel,
  type MethodQuote,
  type PayMethod,
  type QuoteCache,
  type WalletStep,
} from "@/lib/checkout";
import { useCheckout, type CheckoutLive } from "@/lib/use-checkout";
import type { CheckoutApi } from "@/lib/gateway-api";
import type { CheckoutView } from "@/lib/schemas";
import { ApiError } from "@/lib/http";
import { connectWallet, ensureChain, injected, sendTransfer, signAuthorization, signHspPayment, tokenBalance, walletErrorMessage, type ChainTarget } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNow } from "@/components/app/time-ago";
import {
  BigAmount,
  BrandButton,
  CheckoutLayout,
  CopyAction,
  CopyIcon,
  LineItems,
  LivePill,
  MessageCard,
  NetworkChip,
  Notice,
  OrderHash,
  PaidDirectly,
  Rows,
  splitToken,
  StateIcon,
  SummaryFrame,
  TimeBar,
  TokenAmount,
  TokenMark,
} from "./parts";
import { Bar, EASE_OUT, ProgressRing, PulseDot, RollingText, ShakeOn, Shimmer, Stagger, StaggerItem, SuccessMark, Sweep, Swap, T, useCalm } from "./motion";

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function CheckoutScreen({ id }: { id: string }) {
  const { api, query, live, network } = useCheckout(id);
  const view = query.data;
  useCheckoutTitle(view ? `Pay ${view.merchant.name}` : null);

  if (query.isError && !view) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return notFound ? <NotFoundScreen what="payment" /> : <UnavailableScreen error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!api || !view || !network) return <LoadingLayout />;

  return (
    <NetworkContext.Provider value={network}>
      <Checkout view={view} api={api} live={live} refresh={() => void query.refetch()} />
    </NetworkContext.Provider>
  );
}

/** The checkout's chain (name, explorer, RPC), from /v1/info with the protocol package as the fallback. */
const NetworkContext = createContext<GatewayNetwork | null>(null);

function useNetwork(view: Pick<CheckoutView, "chain_id">): GatewayNetwork {
  return useContext(NetworkContext) ?? gatewayNetwork(view.chain_id);
}

/** The payer-facing tab title ("Pay Acme Store - Payminto"), kept over the route's static metadata title. */
export function useCheckoutTitle(title: string | null) {
  useDocumentTitle(title, "Payminto");
}

const noopSubscribe = () => () => undefined;
/** Whether this browser has a wallet; null during server rendering and hydration. */
function useHasWallet(): boolean | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => Boolean(injected()),
    () => null,
  );
}

function LoadingLayout() {
  return (
    <CheckoutLayout
      merchant={null}
      summary={
        <div aria-busy="true" aria-label="Loading payment">
          <div className="flex items-center gap-3">
            <Shimmer className="size-9 rounded-lg" />
            <Shimmer className="h-4 w-32" />
          </div>
          <Shimmer className="mt-6 h-4 w-40 lg:mt-10" />
          <Shimmer className="mt-4 h-11 w-56 max-lg:hidden" />
          <Shimmer className="mt-8 h-24 w-full max-lg:hidden" />
        </div>
      }
      panel={
        <div aria-hidden className="lg:min-h-[34rem]">
          <Shimmer className="h-7 w-48 rounded-full" />
          <Shimmer className="mt-6 h-11 w-full rounded-xl" />
          <Shimmer className="mt-6 h-40 w-full rounded-xl" />
          <Shimmer className="mt-6 h-12 w-full rounded-xl" />
        </div>
      }
    />
  );
}

export function NotFoundScreen({ what }: { what: "payment" | "link" | "proof" }) {
  useCheckoutTitle(what === "payment" ? "Payment not found" : what === "proof" ? "No proof yet" : "Link not found");
  return (
    <CheckoutLayout
      merchant={null}
      single
      summary={null}
      panel={
        <MessageCard
          icon={
            <StateIcon tone="neutral">
              <SearchX />
            </StateIcon>
          }
          title={what === "payment" ? "We could not find this payment" : what === "proof" ? "This payment has no proof yet" : "We could not find this payment link"}
          body={what === "proof" ? "A proof exists once the payment is paid and final on chain." : "Check the address, or ask the business for a new link."}
        >
          <Notice tone="warning" icon={<AlertTriangle />} className="text-left">
            Never send money using details from an error page.
          </Notice>
        </MessageCard>
      }
    />
  );
}

export function UnavailableScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const message = error instanceof Error ? error.message : "The payment service did not answer.";
  return (
    <CheckoutLayout
      merchant={null}
      single
      summary={null}
      panel={
        <MessageCard
          role="alert"
          icon={
            <StateIcon tone="negative">
              <WifiOff />
            </StateIcon>
          }
          title="We cannot reach the payment service"
          body={
            <>
              <p>Check your connection and try again. Nothing was charged.</p>
              <p className="mt-2 text-xs break-words text-subtle">{message}</p>
            </>
          }
        >
          <BrandButton
            onClick={() => {
              setBusy(true);
              onRetry();
              setTimeout(() => setBusy(false), 1200);
            }}
            disabled={busy}
          >
            <RotateCw className={cn(busy && "animate-spin")} /> Try again
          </BrandButton>
        </MessageCard>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Checkout: method and quote state shared by both columns
// ---------------------------------------------------------------------------

function Checkout({ view, api, live, refresh }: { view: CheckoutView; api: CheckoutApi; live: CheckoutLive; refresh: () => void }) {
  const now = useNow();
  const qc = useQueryClient();
  const hasWallet = useHasWallet();
  const [step, setStep] = useState<WalletStep>("idle");
  const [picked, setPicked] = useState<PayMethod | null>(null);
  const [cache, setCache] = useState<QuoteCache>({});
  const [seen, setSeen] = useState({ view, status: view.status });
  // Celebrate and auto-return only when the payer watched it complete, never when reopening an old receipt.
  const [sawPending] = useState(() => !["paid", "overpaid"].includes(view.status) || Date.now() - new Date(view.paid_at ?? 0).getTime() < 30_000);

  // Derived state from earlier renders: remember each quote the node sends, and drop the wallet progress once the
  // payment moves on (the node's update, not our request, ends the wallet step, so nothing flashes back to "Pay").
  if (seen.view !== view) {
    setSeen({ view, status: view.status });
    const next = rememberQuote(cache, view);
    if (next !== cache) setCache(next);
    if (seen.status !== view.status && step !== "idle") setStep("idle");
  }

  const signing = step === "approving" || step === "submitting";
  const model = checkoutModel(view, { now, signing });
  const methods = availableMethods(view);
  const walletUsable = hasWallet === true || Boolean(api.mockSign);
  const active: PayMethod | null = picked && methods.includes(picked) ? picked : hasWallet === null ? null : initialMethod(view, walletUsable);
  const quote = active ? quoteFor(view, active, cache) : null;

  // Fees depend on the method (GATEWAY.md section 14.3): re-quote an open, untouched payment for the method on screen.
  const requoteFor = view.status === "open" && view.amount_paid === "0" && active && view.method !== active ? active : null;
  useEffect(() => {
    if (!requoteFor) return;
    let alive = true;
    api.chooseMethod(view.id, requoteFor).then(
      (v) => alive && qc.setQueryData(["checkout", view.id], v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, qc, view.id, requoteFor]);

  const ended = model.phase === "expired" || model.phase === "canceled";
  return (
    <CheckoutLayout
      merchant={view.merchant}
      summary={<CheckoutSummary view={view} api={api} quote={model.panel === "pay" || model.panel === "signing" ? quote : null} method={model.panel === "pay" || model.panel === "signing" ? active : null} dim={ended} />}
      panel={
        <CheckoutPanel
          view={view}
          api={api}
          live={live}
          model={model}
          methods={methods}
          active={active}
          quote={quote}
          onPick={setPicked}
          step={step}
          setStep={setStep}
          refresh={refresh}
          hasWallet={hasWallet}
          watched={sawPending}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Order column
// ---------------------------------------------------------------------------

export function CheckoutSummary({ view, api, quote = null, method = null, dim = false }: { view: CheckoutView; api?: CheckoutApi; quote?: MethodQuote | null; method?: PayMethod | null; dim?: boolean }) {
  const network = useNetwork(view);
  const order = useQuery({ queryKey: ["order", view.id], queryFn: () => api!.order(view.id), enabled: Boolean(api), staleTime: Infinity, retry: 1 });
  const items = order.data?.order.line_items ?? [];
  const t = view.token;
  const fmt = (v: bigint | string) => formatToken(v, t.symbol, t.decimals);
  const due = quote ? quote.due : BigInt(view.amount_due);
  const surcharge = quote ? quote.surcharge : BigInt(view.surcharge);
  const feeMethod = method ?? view.method ?? "deposit";
  const pending = Boolean(quote && !quote.known);
  const title = view.description || `Payment to ${view.merchant.name}`;
  const showItems = items.length > 1 || (items.length === 1 && items[0]!.quantity !== 1);

  return (
    <div className={cn("transition-[filter,opacity] duration-300", dim && "opacity-75 grayscale")}>
      <SummaryFrame merchant={view.merchant} livemode={view.livemode} chainId={view.chain_id} compactTitle={title} compactAmount={<RollingText text={fmt(due)} className={cn(pending && "opacity-50")} />}>
        <Stagger>
          <StaggerItem>
            <p className="text-[0.9375rem] font-medium">{title}</p>
            {view.reference && <p className="mt-0.5 text-sm text-muted-foreground">Reference {view.reference}</p>}
          </StaggerItem>
          <StaggerItem className="mt-3">
            <BigAmount atomic={due} token={t} pending={pending} label={<span className="sr-only">Total to pay</span>} />
          </StaggerItem>
          <StaggerItem className="mt-7">
            {showItems && <LineItems items={items} token={t} total={false} className="mb-1" />}
            <dl className="space-y-2 border-t pt-3 text-sm">
              <div className="flex justify-between gap-4 text-muted-foreground">
                <dt>{showItems ? "Subtotal" : "Price"}</dt>
                <dd className="num">{fmt(view.amount)}</dd>
              </div>
              <div className="flex min-h-5 justify-between gap-4 text-muted-foreground">
                <dt className="relative min-w-0 flex-1 overflow-hidden">
                  <Swap id={feeMethod} className="truncate">
                    {METHOD_FEE_LABEL[feeMethod]}
                  </Swap>
                </dt>
                <dd className="num">
                  {pending ? <Shimmer className="mt-0.5 h-4 w-16" /> : surcharge > 0n ? <RollingText text={`+${fmt(surcharge)}`} /> : <span>None</span>}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t pt-2.5 font-semibold">
                <dt>Total to pay</dt>
                <dd>
                  <RollingText text={fmt(due)} className={cn(pending && "opacity-50")} />
                </dd>
              </div>
            </dl>
          </StaggerItem>
          <StaggerItem className="mt-7">
            <PaidDirectly merchant={view.merchant.name} payout={view.payout} explorer={network.explorer} />
          </StaggerItem>
          <StaggerItem className="mt-6 flex items-center gap-1.5 text-xs text-subtle">
            Order fingerprint <OrderHash value={view.order_hash} />
          </StaggerItem>
        </Stagger>
      </SummaryFrame>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay panel
// ---------------------------------------------------------------------------

function explorerTx(network: GatewayNetwork, hash: string): string | null {
  return network.explorer ? `${network.explorer}/tx/${hash}` : null;
}

function chainTarget(network: GatewayNetwork): ChainTarget {
  return { chainId: network.chainId, name: network.name, rpcUrl: network.rpcUrl, explorer: network.explorer };
}

type PanelProps = {
  view: CheckoutView;
  api: CheckoutApi;
  live: CheckoutLive;
  model: CheckoutModel;
  methods: PayMethod[];
  active: PayMethod | null;
  quote: MethodQuote | null;
  onPick: (m: PayMethod) => void;
  step: WalletStep;
  setStep: (s: WalletStep) => void;
  refresh: () => void;
  hasWallet: boolean | null;
  watched: boolean;
};

const CHIP_TONE: Record<CheckoutModel["chip"]["tone"], string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-info-soft text-primary",
  warning: "bg-warning-soft text-warning",
  positive: "bg-positive-soft text-positive",
  negative: "bg-negative-soft text-negative",
};

export function CheckoutPanel(props: PanelProps) {
  const { view, model, live } = props;
  const network = useNetwork(view);
  const watching = model.panel === "pay" || model.panel === "signing" || model.panel === "confirming";
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <NetworkChip name={network.name} symbol={view.token.symbol} />
        <Swap id={watching ? `live-${live}` : model.chip.label} mode="popLayout">
          {watching ? <LivePill live={live} /> : <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium", CHIP_TONE[model.chip.tone])}>{model.chip.label}</span>}
        </Swap>
      </div>
      <AnimatePresence initial={false}>
        {model.countdown && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="mt-3">
            <TimeBar {...model.countdown} />
          </motion.div>
        )}
      </AnimatePresence>
      {/* One polite announcement per state change. */}
      <p className="sr-only" role="status" aria-live="polite">
        {model.announce}
      </p>
      <div className="mt-5 flex-1 lg:min-h-[31rem]">
        <Swap id={model.panel === "signing" ? "pay" : model.panel} shift={0}>
          {model.panel === "pay" || model.panel === "signing" ? (
            <PayBody {...props} />
          ) : model.panel === "confirming" ? (
            <Confirming view={view} model={model} />
          ) : model.panel === "success" ? (
            <Success view={view} model={model} watched={props.watched} />
          ) : (
            <Ended view={view} model={model} />
          )}
        </Swap>
      </div>
    </div>
  );
}

function PayBody({ view, api, model, methods, active, quote, onPick, step, setStep, refresh, hasWallet }: PanelProps) {
  const partial = model.phase === "partially_paid";
  const busy = step !== "idle";
  // A submitted HSP payment holds the checkout: show where it is instead of ways to pay.
  if (hspInFlight(view.hsp)) return <HspProgress view={view} />;
  if (!active || !quote) {
    return methods.length === 0 ? (
      <Notice tone="neutral" icon={<AlertTriangle />}>
        {view.merchant.name} has no way to pay switched on for this payment. Contact them for help.
      </Notice>
    ) : (
      <div aria-hidden className="space-y-6">
        <Shimmer className="h-11 w-full rounded-xl" />
        <Shimmer className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  const index = methods.indexOf(active);
  return (
    <div className="flex flex-col gap-5">
      {partial && <PartlyPaid view={view} model={model} />}
      {!partial && (
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.01em]">How would you like to pay?</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{model.copy.next}</p>
        </div>
      )}
      {methods.length > 1 && <MethodSwitch methods={methods} active={active} onPick={onPick} disabled={busy} />}
      <div className="grid">
        {methods.map((m, i) => {
          const on = m === active;
          return (
            <motion.div
              key={m}
              id={`panel-${m}`}
              role={methods.length > 1 ? "tabpanel" : undefined}
              aria-labelledby={methods.length > 1 ? `tab-${m}` : undefined}
              inert={!on}
              className="[grid-area:1/1]"
              initial={false}
              animate={on ? { opacity: 1, x: 0, visibility: "visible" } : { opacity: 0, x: i < index ? -6 : 6, transitionEnd: { visibility: "hidden" } }}
              transition={T.base}
            >
              {m === "wallet" ? (
                <WalletPay view={view} api={api} quote={on ? quote : quoteFor(view, m)} active={on} ready={on && quote.ready} step={step} setStep={setStep} refresh={refresh} hasWallet={hasWallet} onUseDeposit={methods.includes("deposit") ? () => onPick("deposit") : null} />
              ) : m === "hsp" ? (
                <HspPay view={view} api={api} quote={on ? quote : quoteFor(view, m)} active={on} ready={on && quote.ready} step={step} setStep={setStep} refresh={refresh} hasWallet={hasWallet} onUseDeposit={methods.includes("deposit") ? () => onPick("deposit") : null} />
              ) : (
                <DepositPay view={view} api={api} quote={on ? quote : quoteFor(view, m)} hasWallet={hasWallet === true} />
              )}
            </motion.div>
          );
        })}
      </div>
      {view.hsp?.availability === "unavailable" && view.status === "open" && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="mt-px size-3.5 shrink-0" aria-hidden /> Pay with HSP is not available right now. {view.hsp.message}
        </p>
      )}
      {view.status === "open" && <ReceiptEmail view={view} api={api} />}
    </div>
  );
}

/** Segmented control; the selected pill slides under the active option. */
function MethodSwitch({ methods, active, onPick, disabled }: { methods: PayMethod[]; active: PayMethod; onPick: (m: PayMethod) => void; disabled: boolean }) {
  const icon = { wallet: <Wallet aria-hidden />, deposit: <QrCode aria-hidden />, hsp: <ShieldCheck aria-hidden /> };
  const short = { wallet: "Wallet", deposit: "Address", hsp: "HSP" };
  return (
    <div role="tablist" aria-label="How to pay" className={cn("grid gap-1 rounded-xl bg-muted p-1", methods.length > 2 ? "grid-cols-3" : "grid-cols-2")}>
      {methods.map((m) => {
        const on = m === active;
        return (
          <button
            key={m}
            id={`tab-${m}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`panel-${m}`}
            tabIndex={on ? 0 : -1}
            disabled={disabled && !on}
            onClick={() => onPick(m)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = methods[(methods.indexOf(active) + (e.key === "ArrowRight" ? 1 : methods.length - 1)) % methods.length]!;
              onPick(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
            className={cn(
              "relative flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50 [&_svg]:size-4",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && <motion.span layoutId="method-pill" className="absolute inset-0 rounded-lg bg-card shadow-sm ring-1 ring-border dark:bg-input dark:ring-transparent" transition={T.base} />}
            <span className="relative flex items-center gap-2">
              {icon[m]}
              {methods.length > 2 ? <span title={METHOD_COPY[m].label}>{short[m]}</span> : METHOD_COPY[m].label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PartlyPaid({ view, model }: { view: CheckoutView; model: CheckoutModel }) {
  const t = view.token;
  return (
    <div className="flex items-center gap-4 rounded-xl border border-warning/30 bg-warning-soft/60 p-4">
      <ProgressRing fraction={model.paid} size={64} stroke={5} barClassName="text-warning" trackClassName="text-warning/20" label="Paid so far">
        <span className="num text-xs font-semibold text-warning">{Math.floor(model.paid * 100)}%</span>
      </ProgressRing>
      <div className="min-w-0">
        <h1 className="text-base font-semibold">Partly paid</h1>
        <p className="text-sm text-muted-foreground">
          Received <TokenAmount atomic={view.amount_paid} token={t} className="text-foreground" /> of <TokenAmount atomic={view.amount_due} token={t} />.
        </p>
        <p className="mt-1 text-sm">
          Still to pay <RollingText text={formatToken(view.amount_remaining, t.symbol, t.decimals)} className="font-semibold" />
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay with wallet
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function WalletPay({
  view,
  api,
  quote,
  active,
  ready,
  step,
  setStep,
  refresh,
  hasWallet,
  onUseDeposit,
}: {
  view: CheckoutView;
  api: CheckoutApi;
  quote: MethodQuote;
  active: boolean;
  ready: boolean;
  step: WalletStep;
  setStep: (s: WalletStep) => void;
  refresh: () => void;
  hasWallet: boolean | null;
  onUseDeposit: (() => void) | null;
}) {
  const network = useNetwork(view);
  const [account, setAccount] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState<{ text: string; wrongNetwork?: boolean } | null>(null);
  const [shake, setShake] = useState(0);
  const amountText = formatToken(quote.remaining, view.token.symbol, view.token.decimals);
  const short = balance !== null && balance < quote.remaining;
  const simulated = !injected() && Boolean(api.mockSign);
  const busy = step !== "idle";
  const current = walletStepIndex(active ? step : "idle");

  async function pay() {
    setError(null);
    let at: WalletStep = "connecting";
    try {
      if (simulated) {
        for (const s of ["connecting", "switching", "approving"] as const) {
          setStep((at = s));
          await sleep(650);
        }
        setStep((at = "submitting"));
        await api.mockSign!(view.id);
      } else {
        setStep("connecting");
        const from = account ?? (await connectWallet());
        setAccount(from);
        setStep((at = "switching"));
        await ensureChain(chainTarget(network));
        const bal = await tokenBalance(view.token.address as Address, from).catch(() => null);
        setBalance(bal);
        if (bal !== null && bal < quote.remaining) throw new Error(`This wallet holds less than ${amountText} on ${network.name}.`);
        const auth = view.authorization;
        if (!auth) throw new Error("This payment cannot be signed from a wallet right now. Use Send to address.");
        setStep((at = "approving"));
        const signature = await signAuthorization(auth, from);
        setStep((at = "submitting"));
        await api.authorize(view.id, { payer: from, signature });
      }
      refresh();
    } catch (e) {
      const wrongNetwork = at === "switching";
      if (wrongNetwork) setShake((n) => n + 1);
      setError({ text: e instanceof ApiError ? e.message : walletErrorMessage(e), wrongNetwork });
      setStep("idle");
    }
  }

  if (hasWallet === false && !api.mockSign) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center">
          <StateIcon tone="neutral">
            <Wallet />
          </StateIcon>
          <p className="text-sm font-medium">No browser wallet on this device</p>
          <p className="max-w-[32ch] text-sm text-muted-foreground">Install one such as MetaMask or Rabby, or send the money from any wallet or exchange instead.</p>
        </div>
        {onUseDeposit && (
          <BrandButton onClick={onUseDeposit}>
            <QrCode /> Send to address instead
          </BrandButton>
        )}
      </div>
    );
  }

  const copy = walletStepCopy(active ? step : "idle", network.name);
  return (
    <ShakeOn token={shake} className="flex flex-col gap-4">
      <ol className="flex flex-col gap-0.5 rounded-xl border p-1.5" aria-label="Steps to pay with your wallet">
        {WALLET_STEPS.map((s, i) => {
          const done = current > i;
          const now = current === i;
          const c = walletStepCopy(s, network.name);
          const label = s === "connecting" ? (account ? `Connected ${shortAddress(account)}` : "Connect your wallet") : s === "switching" ? `Use ${network.name}` : "Approve the payment";
          return (
            <li key={s} aria-current={now ? "step" : undefined} className={cn("flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-200", now && "bg-muted")}>
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-200",
                  done ? "border-transparent bg-positive text-white dark:text-background" : now ? "border-[var(--ink)] text-[var(--ink)]" : "text-muted-foreground",
                )}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={done ? "d" : now ? "n" : "p"} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={T.fast} className="flex">
                    {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : now ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : i + 1}
                  </motion.span>
                </AnimatePresence>
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm", done || now ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
                {now && (
                  <motion.span initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={T.base} className="block text-xs text-muted-foreground">
                    {c.hint}
                  </motion.span>
                )}
              </span>
              <span className="sr-only">{done ? "done" : now ? "in progress" : "to do"}</span>
            </li>
          );
        })}
      </ol>
      <div className="min-h-5 text-xs text-muted-foreground">
        {account && balance !== null ? (
          <p className="flex justify-between gap-3">
            <span>Wallet balance</span>
            <TokenAmount atomic={balance} token={view.token} className={cn("text-foreground", short && "text-warning")} />
          </p>
        ) : (
          <p>No network fee. You only need {view.token.symbol} on {network.name}.</p>
        )}
      </div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={T.base} className="overflow-hidden">
            <Notice tone={error.wrongNetwork ? "warning" : "negative"} icon={error.wrongNetwork ? <ArrowLeftRight /> : <XCircle />}>
              {error.wrongNetwork ? (
                <>
                  Your wallet is on another network. <strong>Switch to {network.name}</strong> to pay. No money moved.
                </>
              ) : (
                <>{error.text} No money moved.</>
              )}
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="sticky bottom-0 z-10 -mx-1 bg-card px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] lg:static lg:pb-0">
        <BrandButton onClick={() => void pay()} disabled={busy || !ready || short} aria-describedby="wallet-step" className={cn(busy && "disabled:opacity-100")}>
          <Swap id={busy ? step : ready ? "pay" : "quote"} mode="popLayout" className="flex items-center gap-2">
            {busy ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden /> {copy.title}
              </>
            ) : error?.wrongNetwork ? (
              <>
                <ArrowLeftRight aria-hidden /> Switch network and pay {amountText}
              </>
            ) : (
              <>
                <Wallet aria-hidden /> Pay {ready ? amountText : <Shimmer className="inline-block h-4 w-20 bg-white/30" />}
              </>
            )}
          </Swap>
        </BrandButton>
        <p id="wallet-step" className="sr-only" aria-live="polite">
          {busy ? copy.title : ""}
        </p>
      </div>
      {simulated && <p className="text-center text-xs text-subtle">Demo data: no wallet is installed, so paying walks through the steps without one.</p>}
    </ShakeOn>
  );
}

// ---------------------------------------------------------------------------
// Pay with HSP (GATEWAY.md section 17)
// ---------------------------------------------------------------------------

/**
 * HashKey's HSP: the payer's wallet signs the EIP-712 data HSP prepared, the node submits it through HSP, and HSP's
 * gateway sends the money into this payment's address. Same wallet steps as Pay with wallet.
 */
function HspPay({
  view,
  api,
  quote,
  active,
  ready,
  step,
  setStep,
  refresh,
  hasWallet,
  onUseDeposit,
}: {
  view: CheckoutView;
  api: CheckoutApi;
  quote: MethodQuote;
  active: boolean;
  ready: boolean;
  step: WalletStep;
  setStep: (s: WalletStep) => void;
  refresh: () => void;
  hasWallet: boolean | null;
  onUseDeposit: (() => void) | null;
}) {
  const network = useNetwork(view);
  const [error, setError] = useState<string | null>(null);
  const amountText = formatToken(quote.remaining, view.token.symbol, view.token.decimals);
  const busy = step !== "idle";
  const failed = view.hsp?.status === "payment-failed";

  async function pay() {
    setError(null);
    try {
      setStep("connecting");
      const from = await connectWallet();
      setStep("switching");
      await ensureChain(chainTarget(network));
      const bal = await tokenBalance(view.token.address as Address, from).catch(() => null);
      if (bal !== null && bal < quote.remaining) throw new Error(`This wallet holds less than ${amountText} on ${network.name}.`);
      // An HSP quote lasts five minutes. If it ran out while the wallet was open, get a new one and sign that; an old
      // signature is never sent again.
      for (let attempt = 0; ; attempt++) {
        const prepared = await api.hspPrepare!(view.id, from);
        setStep("approving");
        const signature = await signHspPayment(prepared.eip712, from);
        setStep("submitting");
        try {
          await api.hspSubmit!(view.id, { payer: from, signature });
          break;
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "HSP_QUOTE_EXPIRED" && attempt === 0)) throw e;
        }
      }
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : walletErrorMessage(e));
      setStep("idle");
    }
  }

  if (!api.hspPrepare || !api.hspSubmit) {
    return (
      <Notice tone="neutral" icon={<ShieldCheck />}>
        Pay with HSP needs a live server. Demo data has no HSP behind it.
      </Notice>
    );
  }
  if (hasWallet === false) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center">
          <StateIcon tone="neutral">
            <Wallet />
          </StateIcon>
          <p className="text-sm font-medium">No browser wallet on this device</p>
          <p className="max-w-[32ch] text-sm text-muted-foreground">Pay with HSP needs a browser wallet to sign. You can send the money from any wallet or exchange instead.</p>
        </div>
        {onUseDeposit && (
          <BrandButton onClick={onUseDeposit}>
            <QrCode /> Send to address instead
          </BrandButton>
        )}
      </div>
    );
  }
  const copy = walletStepCopy(active ? step : "idle", network.name);
  const intro = hspProgress(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl border p-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 text-sm">
          <p className="font-medium">{intro.title}</p>
          <p className="text-muted-foreground">{intro.hint}</p>
        </div>
      </div>
      {failed && (
        <Notice tone="warning" icon={<AlertTriangle />}>
          {hspProgress("payment-failed").title}
          {view.hsp?.status_reason ? `: ${view.hsp.status_reason}.` : "."} {hspProgress("payment-failed").hint}
        </Notice>
      )}
      <AnimatePresence initial={false}>
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={T.base} className="overflow-hidden">
            <Notice tone="negative" icon={<XCircle />}>
              {error} No money moved.
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="sticky bottom-0 z-10 -mx-1 bg-card px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] lg:static lg:pb-0">
        <BrandButton onClick={() => void pay()} disabled={busy || !ready} aria-describedby="hsp-step" className={cn(busy && "disabled:opacity-100")}>
          <Swap id={busy ? step : ready ? "pay" : "quote"} mode="popLayout" className="flex items-center gap-2">
            {busy ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden /> {copy.title}
              </>
            ) : (
              <>
                <ShieldCheck aria-hidden /> Pay {ready ? amountText : <Shimmer className="inline-block h-4 w-20 bg-white/30" />} with HSP
              </>
            )}
          </Swap>
        </BrandButton>
        <p id="hsp-step" className="sr-only" aria-live="polite">
          {busy ? copy.title : ""}
        </p>
      </div>
    </div>
  );
}

/** A submitted HSP payment: submitted, on chain, final, with HSP's transaction once there is one. */
function HspProgress({ view }: { view: CheckoutView }) {
  const network = useNetwork(view);
  const p = hspProgress(view.hsp?.status ?? null);
  const tx = view.hsp?.tx_hash ?? null;
  return (
    <div className="flex flex-col items-center gap-5 pt-2 text-center" role="status">
      <StateIcon tone="info">
        <LoaderCircle className="animate-spin" />
      </StateIcon>
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{p.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{p.hint}</p>
      </div>
      <ol className="grid w-full grid-cols-3 gap-2" aria-label="HSP progress">
        {HSP_STEPS.map((label, i) => {
          const done = p.step > i + 1 || (p.step === 3 && i === 2);
          const now = p.step === i + 1;
          return (
            <li key={label} aria-current={now ? "step" : undefined} className="flex flex-col items-center gap-1.5">
              <Bar fraction={done ? 1 : now ? 0.5 : 0} className="h-1 w-full" barClassName={done ? "bg-positive" : "bg-[var(--ink)]"} />
              <span className={cn("flex items-center gap-1 text-xs", done || now ? "font-medium text-foreground" : "text-muted-foreground")}>
                {done && <Check className="size-3 text-positive" aria-hidden />}
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      <Rows
        className="w-full text-left"
        rows={[
          ["Amount", <TokenAmount key="a" atomic={view.amount_due} token={view.token} />],
          ["Paid with", "HSP"],
          ["Transaction", tx ? <TxLink key="t" hash={tx} href={explorerTx(network, tx)} /> : <span key="t" className="text-muted-foreground">Waiting for HSP</span>],
        ]}
      />
      <p className="text-xs text-muted-foreground">We mark it paid as soon as the money reaches {view.merchant.name}. You can keep this page open.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Send to address
// ---------------------------------------------------------------------------

function DepositPay({ view, api, quote, hasWallet }: { view: CheckoutView; api: CheckoutApi; quote: MethodQuote; hasWallet: boolean }) {
  const network = useNetwork(view);
  const calm = useCalm();
  const t = view.token;
  const remaining = quote.remaining;
  const uri = manualPaymentUri({ ...view, amount_remaining: remaining.toString() });
  const [qrOpen, setQrOpen] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [num, sym] = splitToken(formatToken(remaining, t.symbol, t.decimals));

  async function sendFromWallet() {
    setError(null);
    setSending(true);
    try {
      const from = await connectWallet();
      await ensureChain(chainTarget(network));
      setSent(await sendTransfer({ token: t.address as Address, to: view.deposit_address as Address, amount: remaining, from }));
      setClaimed(true);
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3 rounded-xl border p-3.5">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Send exactly</p>
          <p className={cn("mt-0.5 text-2xl font-semibold tracking-[-0.02em] transition-opacity", !quote.known && "opacity-50")}>
            <RollingText text={num} /> <span className="text-base font-medium text-muted-foreground">{sym}</span>
          </p>
        </div>
        <CopyAction value={plainAmount(remaining, t.decimals)} label="Copy amount" toast="Amount copied" className="shrink-0" />
      </div>

      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {/* QR codes need a light quiet zone to scan in either theme. On a phone the payer usually pays from the same
            device, so the code waits behind a toggle and the copy rows come first. */}
        <motion.div
          initial={calm ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.24, ease: EASE_OUT }}
          className={cn("relative shrink-0 overflow-hidden rounded-xl border bg-white p-2.5 shadow-sm max-sm:order-2", !qrOpen && "max-sm:hidden")}
        >
          <QRCodeSVG value={uri} size={136} level="H" marginSize={0} title={`Pay ${plainAmount(remaining, t.decimals)} ${t.symbol} to this payment's address`} />
          <span className="absolute top-1/2 left-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white">
            <TokenMark symbol={t.symbol} className="size-6" />
          </span>
          <Sweep />
        </motion.div>
        <div className="w-full min-w-0 flex-1 max-sm:order-1">
          <p className="text-xs text-muted-foreground">To this one-time payment address</p>
          <p className="hash mt-1 flex flex-wrap gap-x-1.5 text-[0.8125rem] leading-relaxed break-all" aria-label={`Payment address ${view.deposit_address}`}>
            {groupAddress(view.deposit_address).map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </p>
          <CopyAction value={view.deposit_address} label="Copy address" toast="Address copied" className="mt-2 w-full" />
        </div>
      </div>
      <button
        type="button"
        onClick={() => setQrOpen((v) => !v)}
        aria-expanded={qrOpen}
        className="-mt-1 inline-flex items-center gap-1.5 self-center rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 sm:hidden"
      >
        <QrCode className="size-3.5" aria-hidden /> {qrOpen ? "Hide QR code" : "Show QR code to pay from another device"}
      </button>

      <Notice tone="warning" icon={<AlertTriangle />}>
        Send only <strong>{t.symbol}</strong> on <strong>{network.name}</strong>. Money sent in another token or on another network cannot be recovered.
        <span className="mt-1 block text-[0.75rem] opacity-90">
          {t.symbol} contract ends with <span className="hash">{t.address.slice(-6)}</span>
        </span>
      </Notice>

      {error && (
        <Notice tone="negative" icon={<XCircle />}>
          {error} No money moved.
        </Notice>
      )}

      <div className="min-h-[4.25rem]">
        <Swap id={claimed ? "watching" : "actions"}>
          {claimed ? (
            <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-3.5" role="status">
              <span className="mt-1.5 text-positive">
                <PulseDot />
              </span>
              <div className="min-w-0 text-sm">
                <p className="font-medium">Watching for your payment</p>
                <p className="text-muted-foreground">
                  We detect it automatically, usually seconds after it lands. Keep this page open.{" "}
                  {sent && explorerTx(network, sent) && (
                    <a href={explorerTx(network, sent)!} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-2">
                      View transfer
                    </a>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" className="h-11 flex-1 rounded-xl" onClick={() => setClaimed(true)}>
                <Check /> I&apos;ve sent it
              </Button>
              {hasWallet && (
                <Button variant="outline" className="h-11 flex-1 rounded-xl" onClick={() => void sendFromWallet()} disabled={sending}>
                  {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
                  Send from wallet
                </Button>
              )}
            </div>
          )}
        </Swap>
      </div>

      {api.mockDeposit && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <span>Demo data, simulate a payment:</span>
          <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void api.mockDeposit!(view.id, remaining.toString())}>
            Full
          </button>
          <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void api.mockDeposit!(view.id, ((remaining * 4n) / 5n).toString())}>
            Partial
          </button>
        </div>
      )}
    </div>
  );
}

function ReceiptEmail({ view, api }: { view: CheckoutView; api: CheckoutApi }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "on-file" | "error">("idle");
  // An email given on the link page already goes with the payment; say so instead of asking again.
  useEffect(() => {
    const known = rememberedReceiptEmail(view.id);
    if (known) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is readable only after hydration
      setEmail(known);
      setState("saved");
    }
  }, [view.id]);
  return (
    <div className="border-t pt-3">
      <Swap id={state === "saved" || state === "on-file" ? "done" : open ? "form" : "closed"}>
        {state === "saved" || state === "on-file" ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Check className="size-3.5 text-positive" aria-hidden /> {state === "saved" ? `We will email a receipt to ${email}.` : "A receipt email is already on file for this payment."}
          </p>
        ) : !open ? (
          <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2">
            <Mail className="size-3.5" aria-hidden /> Email me a receipt (optional)
          </button>
        ) : (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              setState("saving");
              api.addEmail(view.id, email.trim()).then(
                () => (rememberReceiptEmail(view.id, email.trim()), setState("saved")),
                // The node keeps the first email (409 EMAIL_ALREADY_SET); that is a fine outcome for the payer.
                (err: unknown) => setState(err instanceof ApiError && err.code === "EMAIL_ALREADY_SET" ? "on-file" : "error"),
              );
            }}
          >
            <label htmlFor="receipt-email" className="text-xs font-medium">
              Email for your receipt
            </label>
            <div className="flex gap-2">
              <Input id="receipt-email" type="email" required autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              <Button type="submit" variant="outline" disabled={state === "saving"}>
                Save
              </Button>
            </div>
            {state === "error" && <p className="text-xs text-negative">That email could not be saved. Try again.</p>}
          </form>
        )}
      </Swap>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

function Confirming({ view, model }: { view: CheckoutView; model: CheckoutModel }) {
  const network = useNetwork(view);
  const calm = useCalm();
  const conf = confirmationProgress(view);
  const href = view.tx_hash ? explorerTx(network, view.tx_hash) : null;
  const { step, fraction } = model.stage;
  return (
    <div className="flex flex-col items-center gap-5 pt-2 text-center">
      {calm ? (
        <StateIcon tone="info">
          <LoaderCircle className="animate-spin" />
        </StateIcon>
      ) : (
        <ProgressRing fraction={fraction} size={104} stroke={5} label="Progress to final">
          <motion.span animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }} className="flex">
            <TokenMark symbol={view.token.symbol} className="size-12 text-base" />
          </motion.span>
        </ProgressRing>
      )}
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{model.copy.headline}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{model.copy.body}</p>
      </div>
      <ol className="grid w-full grid-cols-3 gap-2" aria-label="Payment progress">
        {CONFIRM_STEPS.map((label, i) => {
          const done = step > i + 1 || (step === 3 && i === 2);
          const now = step === i + 1;
          return (
            <li key={label} aria-current={now ? "step" : undefined} className="flex flex-col items-center gap-1.5">
              <Bar fraction={done ? 1 : now ? 0.5 : 0} className="h-1 w-full" barClassName={done ? "bg-positive" : "bg-[var(--ink)]"} />
              <span className={cn("flex items-center gap-1 text-xs", done || now ? "font-medium text-foreground" : "text-muted-foreground")}>
                {done && <Check className="size-3 text-positive" aria-hidden />}
                {label}
                {i === 1 && now && conf && (
                  <span className="num font-normal text-muted-foreground">
                    {conf.current}/{conf.required}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <Rows
        className="w-full text-left"
        rows={[
          ["Amount", <TokenAmount key="a" atomic={view.amount_due} token={view.token} />],
          ["Transaction", view.tx_hash ? <TxLink key="t" hash={view.tx_hash} href={href} /> : <span key="t" className="text-muted-foreground">Waiting for the network</span>],
        ]}
      />
      <p className="text-xs text-muted-foreground">{model.copy.next}</p>
    </div>
  );
}

function TxLink({ hash, href }: { hash: string; href: string | null }) {
  const text = <span className="hash text-[0.8125rem]">{shortHash(hash)}</span>;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded underline-offset-2 hover:underline" title={hash}>
      {text}
      <ExternalLink className="size-3.5 text-subtle" aria-hidden />
      <span className="sr-only">(opens the explorer)</span>
    </a>
  ) : (
    <span className="inline-flex items-center gap-0.5" title={hash}>
      {text}
      <CopyIcon value={hash} label="transaction" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Success and receipt
// ---------------------------------------------------------------------------

function Success({ view, model, watched }: { view: CheckoutView; model: CheckoutModel; watched: boolean }) {
  const back = safeRedirectUrl(view.success_url);
  const network = useNetwork(view);
  const calm = useCalm();
  const payer = view.payer ?? null;
  const payout = view.payout ?? null;
  const t = view.token;
  const rows: [ReactNode, ReactNode][] = [
    ["Amount", <TokenAmount key="a" atomic={view.amount_paid} token={t} />],
    ["Paid with", view.method === "wallet" ? "Browser wallet" : view.method === "hsp" ? "HSP" : "Sent to address"],
    ...(view.hsp?.status && view.hsp.status !== "order-created"
      ? ([["HSP status", hspProgress(view.hsp.status).title]] as [ReactNode, ReactNode][])
      : []),
    ["Network", network.name],
    ...(payer ? ([["From", <AddressValue key="f" address={payer} />]] as [ReactNode, ReactNode][]) : []),
    ["To", payout ? <AddressValue key="to" address={payout} label={view.merchant.name} /> : view.merchant.name],
    ...(view.tx_hash ? ([["Transaction", <TxLink key="tx" hash={view.tx_hash} href={explorerTx(network, view.tx_hash)} />]] as [ReactNode, ReactNode][]) : []),
    ...(view.paid_at ? ([["Paid at", <span key="p" className="num">{formatDateTime(view.paid_at)}</span>]] as [ReactNode, ReactNode][]) : []),
  ];
  return (
    <div className="relative flex flex-col gap-5">
      {!calm && watched && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -top-20 h-64 bg-[radial-gradient(closest-side,var(--positive-soft),transparent)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0.55] }}
          transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.35 }}
        />
      )}
      <div className="relative flex flex-col items-center gap-3 pt-1 text-center">
        <SuccessMark celebrate={watched} />
        <motion.div initial={calm ? false : { opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...T.spring, delay: 0.55 }}>
          <h1 className="text-xl font-semibold tracking-[-0.01em]">{model.copy.headline}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{model.copy.body}</p>
        </motion.div>
      </div>
      {(view.status === "overpaid" || view.late) && <Notice tone="neutral">{model.copy.next}</Notice>}
      <Stagger as="dl" className="relative divide-y rounded-xl border bg-card text-sm">
        {rows.map(([k, v], i) => (
          <StaggerItem key={i} className="flex min-h-10 items-center justify-between gap-4 px-3.5 py-2">
            <dt className="shrink-0 text-muted-foreground">{k}</dt>
            <dd className="min-w-0 text-right break-words">{v}</dd>
          </StaggerItem>
        ))}
      </Stagger>
      <div className="relative flex flex-col gap-2 print:hidden">
        {back && <ReturnButton url={back} merchant={view.merchant.name} auto={watched} />}
        <div className="flex gap-2">
          <Button asChild variant="outline" className="h-11 flex-1 rounded-xl">
            <Link href={`/receipt/${view.id}`}>
              <ShieldCheck /> Payment proof
            </Link>
          </Button>
          <Button variant="outline" className="h-11 rounded-xl" onClick={() => window.print()} aria-label="Print receipt">
            <Printer />
            <span className="max-sm:sr-only">Print</span>
          </Button>
        </div>
        {!back && <p className="mt-1 text-center text-xs text-muted-foreground">You can close this page. This receipt stays at the same address.</p>}
      </div>
    </div>
  );
}

function AddressValue({ address, label }: { address: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={address}>
      {label && <span>{label}</span>}
      <span className={cn("hash text-[0.8125rem]", label && "text-muted-foreground")}>{shortAddress(address)}</span>
    </span>
  );
}

/** "Return to Acme Store" with a ring that fills over 5 seconds, then goes; "Stay on this page" stops it. */
function ReturnButton({ url, merchant, auto }: { url: string; merchant: string; auto: boolean }) {
  const [stay, setStay] = useState(!auto);
  const [started] = useState(() => Date.now());
  const now = useNow();
  const left = redirectSecondsLeft(started, now, REDIRECT_SECONDS);
  useEffect(() => {
    if (!stay && left === 0) window.location.assign(url);
  }, [left, stay, url]);
  return (
    <>
      <a
        href={url}
        className="relative inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand,var(--primary))] px-4 text-[0.9375rem] font-semibold text-[var(--brand-fg,var(--primary-foreground))] transition-[filter,transform] duration-[120ms] hover:brightness-[1.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
      >
        {!stay && (
          <ProgressRing fraction={redirectFraction(started, now)} size={20} stroke={2.5} trackClassName="text-current opacity-25" barClassName="text-current" className="-ml-1" />
        )}
        Return to {merchant} <ArrowRight className="size-4" aria-hidden />
      </a>
      <AnimatePresence initial={false}>
        {!stay && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center text-xs text-muted-foreground" aria-live="polite">
            Returning you in <span className="num">{left}s</span>.{" "}
            <button type="button" onClick={() => setStay(true)} className="rounded font-medium text-foreground underline underline-offset-2 focus-visible:outline-2">
              Stay on this page
            </button>
          </motion.p>
        )}
      </AnimatePresence>
    </>
  );
}

// ---------------------------------------------------------------------------
// Underpaid, expired, canceled
// ---------------------------------------------------------------------------

function Ended({ view, model }: { view: CheckoutView; model: CheckoutModel }) {
  const phase = model.phase;
  const calm = useCalm();
  const icon = phase === "underpaid" ? <AlertTriangle /> : phase === "canceled" ? <XCircle /> : <Clock3 />;
  const restart = phase === "expired" && view.link?.active;
  const contact = view.merchant.support_email ? `mailto:${view.merchant.support_email}?subject=${encodeURIComponent(`Payment ${view.id}`)}` : null;
  return (
    <div className="flex flex-col items-center gap-4 pt-2 text-center">
      <motion.span initial={calm ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={T.slow}>
        <StateIcon tone={phase === "underpaid" ? "warning" : "neutral"} className="size-14">
          {icon}
        </StateIcon>
      </motion.span>
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-balance">{model.copy.headline}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{model.copy.body}</p>
      </div>
      {phase === "underpaid" && (
        <div className="w-full space-y-2 text-left">
          <Bar fraction={model.paid} barClassName="bg-warning" />
          <Rows
            rows={[
              ["Asked for", <TokenAmount key="r" atomic={view.amount_due} token={view.token} />],
              ["Received", <TokenAmount key="p" atomic={view.amount_paid} token={view.token} />],
              ["Missing", <TokenAmount key="m" atomic={view.amount_remaining} token={view.token} className="text-warning" />],
            ]}
          />
        </div>
      )}
      <div className="w-full rounded-xl bg-muted/60 px-4 py-3 text-left text-sm">
        <p className="font-medium">What to do next</p>
        <p className="mt-0.5 text-muted-foreground">{model.copy.next}</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {restart && (
          <Link
            href={`/l/${view.link!.slug}`}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand,var(--primary))] px-4 text-[0.9375rem] font-semibold text-[var(--brand-fg,var(--primary-foreground))] transition-[filter,transform] duration-[120ms] hover:brightness-[1.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            <RotateCw className="size-4" aria-hidden /> Start a new payment
          </Link>
        )}
        {contact && (
          <Button asChild variant="outline" className="h-11 w-full rounded-xl">
            <a href={contact}>
              <Mail /> Contact {view.merchant.name}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
