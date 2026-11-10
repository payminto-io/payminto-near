"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, Clock3, ExternalLink, Globe, LoaderCircle, Mail, Printer, RotateCw, SearchX, ShieldCheck, Wallet, WifiOff, XCircle } from "lucide-react";
import { checkoutPayTx, type CheckoutTerms, type WalletTx } from "@payminto/protocol";
import { cn } from "@/lib/utils";
import { useDocumentTitle } from "@/lib/use-title";
import { formatDateTime, formatToken, shortHash } from "@/lib/format";
import { gatewayNetwork, safeRedirectUrl, type GatewayNetwork } from "@/lib/gateway";
import {
  availableMethods,
  checkoutModel,
  CONFIRM_STEPS,
  confirmationProgress,
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
import { captureOpenerOrigin, notifyOpener } from "@/lib/embed";
import { activeQuote, amountText, anyChainOffered, initialTab, intentsAnnouncement, paidFromText, payTabs, showsDeposit, TAB_LABEL, type PayTab } from "@/lib/intents";
import type { CheckoutApi } from "@/lib/gateway-api";
import type { CheckoutView } from "@/lib/schemas";
import { ApiError } from "@/lib/http";
import { ensureConnected, signAndSendTransaction, toWalletError, walletAvailable } from "@/lib/wallet";
import { useWallet } from "@/lib/use-wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNow } from "@/components/app/time-ago";
import {
  BigAmount,
  BrandButton,
  CheckoutLayout,
  CopyIcon,
  LineItems,
  LivePill,
  MessageCard,
  NetworkChip,
  Notice,
  OrderHash,
  PaidDirectly,
  Rows,
  StateIcon,
  SummaryFrame,
  TimeBar,
  TokenAmount,
  TokenMark,
} from "./parts";
import { Bar, EASE_OUT, ProgressRing, RollingText, ShakeOn, Shimmer, Stagger, StaggerItem, SuccessMark, Swap, T, useCalm } from "./motion";
import { AccountText } from "@/components/ds/account-id";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnyChainPanel, IntentsLabel, TxValue, useIntentsOptions } from "./intents";

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function CheckoutScreen({ id }: { id: string }) {
  const { api, query, live, network } = useCheckout(id);
  const view = query.data;
  useCheckoutTitle(view ? `Pay ${view.merchant.name}` : null);
  // Opened by embed.js on a business's page: remember that page's origin, and tell it whenever the payment's state changes.
  useEffect(() => captureOpenerOrigin(), []);
  const status = view?.status;
  useEffect(() => {
    if (status) notifyOpener({ id, status });
  }, [id, status]);

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

function useNetwork(): GatewayNetwork {
  return useContext(NetworkContext) ?? gatewayNetwork();
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
    () => walletAvailable(),
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
  const [picked, setPicked] = useState<PayTab | null>(null);
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
  // "NEAR wallet" first and unchanged; "Any chain" beside it when the business takes payments from other chains.
  const tabs = payTabs(view, initialMethod(view) === "wallet");
  const tab: PayTab | null = picked && tabs.includes(picked) ? picked : hasWallet === null ? null : initialTab(view, initialMethod(view) === "wallet");
  const active: PayMethod | null = tab === "wallet" ? "wallet" : null;
  const quote = active ? quoteFor(view, active, cache) : null;
  const options = useIntentsOptions(api, view.id, tab === "oneclick" && anyChainOffered(view));
  const anyChain = tab === "oneclick" && (model.panel === "pay" || model.panel === "signing" || (model.panel === "confirming" && showsDeposit(activeQuote(view))));

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
      summary={
        <CheckoutSummary
          view={view}
          api={api}
          quote={!anyChain && (model.panel === "pay" || model.panel === "signing") ? quote : null}
          method={anyChain ? "oneclick" : model.panel === "pay" || model.panel === "signing" ? active : null}
          anyChainTo={anyChain || (view.method === "oneclick" && model.panel === "success") ? (activeQuote(view)?.recipient ?? options.data?.recipient ?? null) : undefined}
          dim={ended}
        />
      }
      panel={
        <CheckoutPanel
          view={view}
          api={api}
          live={live}
          model={model}
          methods={methods}
          active={active}
          quote={quote}
          tabs={tabs}
          tab={tab}
          anyChain={anyChain}
          options={options}
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

export function CheckoutSummary({
  view,
  api,
  quote = null,
  method = null,
  dim = false,
  anyChainTo,
}: {
  view: CheckoutView;
  api?: CheckoutApi;
  quote?: MethodQuote | null;
  method?: PayMethod | "oneclick" | null;
  dim?: boolean;
  /** Paying from another chain: the business's NEAR account the USDC is delivered to (null while it loads). */
  anyChainTo?: string | null;
}) {
  const network = useNetwork();
  const order = useQuery({ queryKey: ["order", view.id], queryFn: () => api!.order(view.id), enabled: Boolean(api), staleTime: Infinity, retry: 1 });
  const items = order.data?.order.line_items ?? [];
  const t = view.token;
  const fmt = (v: bigint | string) => formatToken(v, t.symbol, t.decimals);
  const due = quote ? quote.due : BigInt(view.amount_due);
  const surcharge = quote ? quote.surcharge : BigInt(view.surcharge);
  const feeMethod = method ?? view.method ?? "wallet";
  const pending = Boolean(quote && !quote.known);
  const title = view.description || `Payment to ${view.merchant.name}`;
  const showItems = items.length > 1 || (items.length === 1 && items[0]!.quantity !== 1);

  return (
    <div className={cn("transition-[filter,opacity] duration-300", dim && "opacity-75 grayscale")}>
      <SummaryFrame merchant={view.merchant} livemode={view.livemode} compactTitle={title} compactAmount={<RollingText text={fmt(due)} className={cn(pending && "opacity-50")} />}>
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
            {anyChainTo === undefined ? (
              <PaidDirectly merchant={view.merchant.name} payout={view.payout} explorer={network.explorer} />
            ) : (
              <PaidDirectly
                merchant={view.merchant.name}
                payout={anyChainTo}
                explorer={view.intents?.mode === "live" ? "https://nearblocks.io" : null}
                note={view.intents?.mode === "live" ? "Delivered as USDC to this NEAR mainnet account through NEAR Intents." : "Delivered as USDC to this account through NEAR Intents (simulated on a local chain)."}
              />
            )}
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
  return network.explorer ? `${network.explorer}/txns/${hash}` : null;
}

type PanelProps = {
  view: CheckoutView;
  api: CheckoutApi;
  live: CheckoutLive;
  model: CheckoutModel;
  methods: PayMethod[];
  active: PayMethod | null;
  quote: MethodQuote | null;
  tabs: PayTab[];
  tab: PayTab | null;
  /** The any-chain screens are on the panel (the tab is picked and the payment takes money or one is on its way). */
  anyChain: boolean;
  options: ReturnType<typeof useIntentsOptions>;
  onPick: (t: PayTab) => void;
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
  const { view, model, live, anyChain } = props;
  const network = useNetwork();
  const watching = model.panel === "pay" || model.panel === "signing" || model.panel === "confirming";
  // While an any-chain deposit address is on screen, its own deadline counts down there instead of the payment's.
  const iq = activeQuote(view);
  const deposit = anyChain && showsDeposit(iq);
  const panel = anyChain ? "pay" : model.panel;
  // Every screen with any-chain data carries its label: the pay screens, and the receipt of a payment made that way.
  const intentsHeader = Boolean(view.intents) && (anyChain || (panel === "success" && view.method === "oneclick"));
  const announce = anyChain ? (iq ? intentsAnnouncement(iq) : "Pay from another chain.") : model.announce;
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Swap id={intentsHeader ? "intents" : "near"} mode="popLayout">
          {intentsHeader && view.intents ? <IntentsLabel mode={view.intents.mode} label={view.intents.label} className="h-7" /> : <NetworkChip name={network.name} symbol={view.token.symbol} />}
        </Swap>
        <Swap id={watching ? `live-${live}` : model.chip.label} mode="popLayout">
          {watching ? <LivePill live={live} /> : <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium", CHIP_TONE[model.chip.tone])}>{model.chip.label}</span>}
        </Swap>
      </div>
      <AnimatePresence initial={false}>
        {model.countdown && !deposit && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="mt-3">
            <TimeBar {...model.countdown} />
          </motion.div>
        )}
      </AnimatePresence>
      {/* One polite announcement per state change. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <div className="mt-5 flex-1 lg:min-h-[31rem]">
        <Swap id={panel === "signing" ? "pay" : panel} shift={0}>
          {panel === "pay" || panel === "signing" ? (
            <PayBody {...props} />
          ) : panel === "confirming" ? (
            <Confirming view={view} model={model} />
          ) : panel === "success" ? (
            <Success view={view} model={model} watched={props.watched} />
          ) : (
            <Ended view={view} model={model} />
          )}
        </Swap>
      </div>
    </div>
  );
}

/**
 * The pay panel: the NEAR wallet, exactly as before, and "Any chain" in a second tab when the business takes payments
 * from other chains. With the wallet alone there are no tabs at all.
 */
function PayBody(props: PanelProps) {
  const { view, api, tabs, tab, onPick, live, options, refresh } = props;
  if (tabs.length === 0 || tab === null) return <WalletBody {...props} />;
  const anyChain = (
    <div className="flex flex-col gap-5">
      <AnyChainPanel view={view} api={api} streaming={live === "live"} options={options} onRefresh={refresh} />
      {view.status === "open" && <ReceiptEmail view={view} api={api} />}
    </div>
  );
  if (tabs.length === 1 && tab === "wallet") return <WalletBody {...props} />;
  // While a deposit from another chain is on its way the wallet is not offered, but its tab stays (disabled), so the
  // panel keeps its shape from the first screen to the last.
  const shown: PayTab[] = ["wallet", "oneclick"];
  return (
    <Tabs value={tab} onValueChange={(v) => onPick(v as PayTab)} className="gap-5">
      <TabsList aria-label="How to pay" className="h-11 w-full shrink-0 md:h-10">
        {shown.map((t) => (
          <TabsTrigger
            key={t}
            value={t}
            disabled={!tabs.includes(t)}
            title={tabs.includes(t) ? undefined : "Not available while your deposit from another chain is on its way"}
            className="h-full min-w-0 gap-2 px-3 text-sm focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 data-[state=active]:bg-card dark:data-[state=active]:bg-input/40"
          >
            {t === "wallet" ? <Wallet aria-hidden /> : <Globe aria-hidden />}
            {TAB_LABEL[t]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="wallet" className="mt-0 focus-visible:outline-none">
        <WalletBody {...props} />
      </TabsContent>
      <TabsContent value="oneclick" className="mt-0 focus-visible:outline-none">
        {anyChain}
      </TabsContent>
    </Tabs>
  );
}

function WalletBody({ view, api, model, methods, active, quote, step, setStep, refresh, hasWallet }: PanelProps) {
  const partial = model.phase === "partially_paid";
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
  return (
    <div className="flex flex-col gap-5">
      {partial && <PartlyPaid view={view} model={model} />}
      {!partial && (
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.01em]">{METHOD_COPY.wallet.label}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{model.copy.next}</p>
        </div>
      )}
      <WalletPay view={view} api={api} quote={quote} ready={quote.ready} step={step} setStep={setStep} refresh={refresh} hasWallet={hasWallet} />
      {view.status === "open" && <ReceiptEmail view={view} api={api} />}
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
// Pay with a NEAR wallet: one ft_transfer_call to the hub carrying the node-signed checkout terms
// ---------------------------------------------------------------------------

/**
 * The transaction the payer's wallet will sign: the node's prebuilt `ft_transfer_call`, accepted only when it is exactly
 * what the chain package builds from the signed terms, the token and the hub. Null while there are no terms; "mismatch"
 * when the server's transaction says anything else, so the page never asks a wallet to sign it.
 */
export function checkoutTxOf(view: Pick<CheckoutView, "wallet" | "hub" | "token">): WalletTx | "mismatch" | null {
  const w = view.wallet;
  if (!w) return null;
  const terms: CheckoutTerms = { paymentId: w.terms.payment_id, merchant: w.terms.merchant, amount: BigInt(w.terms.amount), expiryMs: BigInt(w.terms.expiry_ms) };
  const built = checkoutPayTx(view.token.address, view.hub, terms, w.signature);
  return JSON.stringify(built) === JSON.stringify(w.transaction) ? built : "mismatch";
}

function WalletPay({
  view,
  api,
  quote,
  ready,
  step,
  setStep,
  refresh,
}: {
  view: CheckoutView;
  api: CheckoutApi;
  quote: MethodQuote;
  ready: boolean;
  step: WalletStep;
  setStep: (s: WalletStep) => void;
  refresh: () => void;
  hasWallet: boolean | null;
}) {
  const network = useNetwork();
  const wallet = useWallet();
  const [error, setError] = useState<{ text: string; canceled?: boolean } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const amountText = formatToken(quote.remaining, view.token.symbol, view.token.decimals);
  const built = checkoutTxOf(view);
  const tx = built === "mismatch" ? null : built;
  const busy = step !== "idle";
  const current = walletStepIndex(step);

  async function pay() {
    setError(null);
    if (!tx) return;
    try {
      setStep("connecting");
      await ensureConnected();
      setStep("approving");
      const r = await signAndSendTransaction(tx);
      if (r.status === "failed") {
        setShake((n) => n + 1);
        setError({ text: r.error });
        setStep("idle");
        return;
      }
      // The node confirms from the hub's payment record; the view updates from server state, not from here.
      setSent(r.hash);
      // Tell the node which transaction paid; it still confirms from the hub's own record, never from this report.
      void api.walletSent(view.id, r.hash).catch(() => undefined);
      setStep("submitting");
      refresh();
    } catch (e) {
      const err = toWalletError(e);
      if (err.kind !== "rejected") setShake((n) => n + 1);
      setError({ text: err.message, canceled: err.kind === "rejected" });
      setStep("idle");
    }
  }

  const copy = walletStepCopy(step, network.name);
  return (
    <ShakeOn token={shake} className="flex flex-col gap-4">
      <ol className="flex flex-col gap-0.5 rounded-xl border p-1.5" aria-label="Steps to pay with your wallet">
        {WALLET_STEPS.map((s, i) => {
          const done = current > i;
          const now = current === i;
          const c = walletStepCopy(s, network.name);
          const label = s === "connecting" ? (wallet.account ? `Connected as ${wallet.account}` : "Connect a NEAR wallet") : "Approve the transfer";
          return (
            <li key={s} aria-current={now ? "step" : undefined} className={cn("flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-200", now && "bg-muted")}>
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
                <span className={cn("block truncate text-sm", done || now ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
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
      {tx && <TransferDetails tx={tx} view={view} />}
      <AnimatePresence initial={false}>
        {built === "mismatch" && (
          <Notice tone="negative" icon={<AlertTriangle />}>
            The server&apos;s transaction does not match its signed terms, so this page will not ask your wallet to sign it. No money moved. Contact {view.merchant.name}.
          </Notice>
        )}
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={T.base} className="overflow-hidden">
            <Notice tone={error.canceled ? "neutral" : "negative"} icon={error.canceled ? <XCircle /> : <AlertTriangle />}>
              {error.canceled ? error.text : <>{error.text} No money moved.</>}
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>
      {sent && step === "submitting" && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          Sent in <span className="hash text-foreground">{shortHash(sent)}</span>
          {explorerTx(network, sent) && (
            <a href={explorerTx(network, sent)!} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 font-medium text-foreground underline underline-offset-2">
              View on the NEAR explorer <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </p>
      )}
      <div className="sticky bottom-0 z-10 -mx-1 bg-card px-1 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:pb-0">
        <BrandButton onClick={() => void pay()} disabled={busy || !ready || !tx} aria-describedby="wallet-step" className={cn(busy && "disabled:opacity-100")}>
          <Swap id={busy ? step : ready && tx ? "pay" : "quote"} mode="popLayout" className="flex items-center gap-2">
            {busy ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden /> {copy.title}
              </>
            ) : (
              <>
                <Wallet aria-hidden /> Pay {ready && tx ? amountText : <Shimmer className="inline-block h-4 w-20 bg-white/30" />}
              </>
            )}
          </Swap>
        </BrandButton>
        <p id="wallet-step" className="sr-only" aria-live="polite">
          {busy ? copy.title : ""}
        </p>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          You pay in {view.token.symbol} on {network.name}. Your wallet adds a small NEAR network fee.
        </p>
      </div>
    </ShakeOn>
  );
}

/** What the wallet will be asked to sign, readable before approving: a transfer to the hub carrying this payment's terms. */
function TransferDetails({ tx, view }: { tx: WalletTx; view: CheckoutView }) {
  const call = tx.actions[0]!;
  const t = view.wallet!.terms;
  return (
    <details className="group rounded-xl border text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 font-medium focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
        What your wallet will sign
        <ArrowRight aria-hidden className="size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-90" />
      </summary>
      <dl className="grid gap-2.5 border-t px-3.5 py-3 text-xs">
        <Row label="Transfer">
          <TokenAmount atomic={t.amount} token={view.token} className="text-foreground" />
        </Row>
        <Row label="To the hub">
          <AccountText value={view.hub} className="hash text-foreground" />
        </Row>
        <Row label="For">
          <AccountText value={t.merchant} className="hash text-foreground" />
        </Row>
        <Row label="Call">
          <span className="hash text-foreground">
            {call.params.methodName} on {view.token.symbol}
          </span>
        </Row>
        <Row label="Valid until">
          <span className="hash text-foreground">{formatDateTime(new Date(Number(t.expiry_ms)).toISOString())}</span>
        </Row>
      </dl>
      <p className="border-t px-3.5 py-2.5 text-xs text-muted-foreground">The hub checks this business&apos;s signed terms and sends the money back if anything does not match.</p>
    </details>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
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
  const network = useNetwork();
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
  const network = useNetwork();
  const calm = useCalm();
  const payer = view.payer ?? null;
  const payout = view.payout ?? null;
  const t = view.token;
  // Paid from another chain: the quote that delivered says from where, to which NEAR account, and with which transactions.
  const iq = view.method === "oneclick" && view.intents?.active_quote?.status === "confirmed" ? view.intents.active_quote : null;
  const at: [ReactNode, ReactNode][] = view.paid_at ? [["Paid at", <span key="p" className="num">{formatDateTime(view.paid_at)}</span>]] : [];
  const rows: [ReactNode, ReactNode][] = iq
    ? [
        ["Amount", <TokenAmount key="a" atomic={view.amount_paid} token={t} />],
        ["Paid with", "Any chain (NEAR Intents)"],
        ["You sent", <span key="s" className="num font-medium whitespace-nowrap">{amountText(iq.deposited ?? iq.send_exactly)} on {iq.origin.chain_name}</span>],
        ["From", <span key="f" className="hash text-[0.8125rem]">{iq.refund_to}</span>],
        ["To", <AddressValue key="to" address={iq.recipient} label={view.merchant.name} />],
        ...(iq.origin_txs[0] ? ([[`${iq.origin.chain_name} deposit`, <TxValue key="o" tx={iq.origin_txs[0]} />]] as [ReactNode, ReactNode][]) : []),
        ...(iq.delivery_tx ? ([["NEAR delivery", <TxValue key="d" tx={iq.delivery_tx} />]] as [ReactNode, ReactNode][]) : []),
        ...at,
      ]
    : [
        ["Amount", <TokenAmount key="a" atomic={view.amount_paid} token={t} />],
        ["Paid with", view.method === "voucher" ? "AI agent with a Budget" : "NEAR wallet"],
        ["Network", network.name],
        ...(payer ? ([["From", <AddressValue key="f" address={payer} />]] as [ReactNode, ReactNode][]) : []),
        ["To", payout ? <AddressValue key="to" address={payout} label={view.merchant.name} /> : view.merchant.name],
        ...(view.tx_hash ? ([["Transaction", <TxLink key="tx" hash={view.tx_hash} href={explorerTx(network, view.tx_hash)} />]] as [ReactNode, ReactNode][]) : []),
        ...at,
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
          {/* The panel's header carries the Simulated or Live label for this receipt. */}
          {iq && <p className="mt-2 text-sm font-medium">{paidFromText(iq)}</p>}
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
          {/* The proof page checks the hub's record of a wallet payment, and the NEAR delivery of an any-chain payment. */}
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

/** A NEAR account on the receipt: one line, never broken at "-" or ".", with the full value in the title and copy. */
function AddressValue({ address, label }: { address: string; label?: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 flex-col items-end gap-0.5">
      {label && <span>{label}</span>}
      <AccountText value={address} className={cn("hash text-[0.8125rem]", label && "text-muted-foreground")} />
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
