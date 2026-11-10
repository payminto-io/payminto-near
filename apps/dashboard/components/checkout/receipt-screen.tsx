"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ExternalLink, LoaderCircle, Minus, Printer, RotateCw, ShieldAlert, ShieldCheck, ShieldX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime, formatToken, shortHash } from "@/lib/format";
import { gatewayNetwork } from "@/lib/gateway";
import { ApiError } from "@/lib/http";
import { expectedCheckIds, plainCheckTitle, proofVerdict, runProofChecks, settlementName, type ProofCheck } from "@/lib/payment-proof";
import { useCheckoutApi } from "@/lib/use-checkout";
import { deliveryReader, readErrorText, readerLabel } from "@/lib/near-reader";
import { mainnetTxUrl, verificationText } from "@/lib/intents";
import type { CheckoutView, IntentsProof, PaymentProof } from "@/lib/schemas";
import { IntentsLabel } from "./intents";
import { Button } from "@/components/ui/button";
import { brandStyle, CheckoutFooter, LineItems, MerchantRow, Notice, OrderHash, Rows, TokenAmount } from "./parts";
import { CheckoutMotion, EASE_OUT, ProgressRing, Shimmer, T, useCalm } from "./motion";
import { NotFoundScreen, UnavailableScreen, useCheckoutTitle } from "./checkout";
import { AccountText } from "@/components/ds/account-id";

/** Time between checklist rows resolving, so the reader sees each check land. */
const REVEAL_MS = 380;

/**
 * Public payment proof (GATEWAY.md section 13.3): the node's claims, each re-checked in this browser against the chain
 * RPC, told as a short plain-language checklist with the technical evidence one click away.
 */
export function ReceiptScreen({ id }: { id: string }) {
  const api = useCheckoutApi();
  const enabled = Boolean(api);
  const retryable = (n: number, e: unknown) => !(e instanceof ApiError && e.status < 500) && n < 2;
  const view = useQuery({ queryKey: ["checkout", id], queryFn: () => api!.checkout(id), enabled, retry: retryable });
  const proof = useQuery({ queryKey: ["proof", id], queryFn: () => api!.proof(id), enabled, retry: retryable });
  const order = useQuery({ queryKey: ["order", id], queryFn: () => api!.order(id), enabled, retry: retryable });
  const info = useQuery({ queryKey: ["checkout-info"], queryFn: () => api!.info(), enabled, staleTime: Infinity, retry: 1 });
  const network = view.data ? gatewayNetwork(info.data) : null;
  const hub = view.data?.hub ?? null;
  const source = useMemo(() => (api && network && hub ? api.reader({ network: network.id, hub, rpcUrl: info.data?.network.rpc_url }) : null), [api, network, hub, info.data]);
  // Paid from another chain: the delivery is read where the USDC landed (NEAR mainnet when live), not on the hub.
  const settlement = proof.data?.intents?.settlement_network ?? null;
  const delivery = useMemo(() => (settlement ? deliveryReader(settlement, source) : null), [settlement, source]);
  const checks = useQuery({
    queryKey: ["proof-checks", id, source?.reader.rpcUrl ?? null, delivery?.reader.rpcUrl ?? null],
    enabled: Boolean(proof.data && (order.data || order.isError) && network && !info.isPending),
    queryFn: () => runProofChecks({ ...proof.data!, tx_hash: proof.data!.tx_hash ?? view.data?.tx_hash ?? null }, order.data ?? null, source?.reader ?? null, delivery?.reader ?? null),
    staleTime: Infinity,
    retry: false,
  });
  useCheckoutTitle(view.data ? `Payment proof - ${view.data.merchant.name}` : null);

  const err = view.error ?? proof.error;
  if (err) {
    if (err instanceof ApiError && err.status === 404) return <NotFoundScreen what="payment" />;
    if (err instanceof ApiError && err.code === "PAYMENT_NOT_PAID") return <NotFoundScreen what="proof" />;
    return <UnavailableScreen error={err} onRetry={() => void (view.refetch(), proof.refetch())} />;
  }

  const v = view.data;
  const p = proof.data;
  return (
    <CheckoutMotion>
      <div style={brandStyle(v?.merchant.brand_color)} className="flex min-h-dvh flex-col bg-background [--ink:var(--brand-ink,var(--primary))] dark:[--ink:var(--brand-ink-dark,var(--primary))]">
        <main className="flex-1 px-4 pt-4 pb-6 sm:px-6 sm:pt-8 lg:py-16">
          <div className="mx-auto w-full max-w-[680px] overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgb(14_23_38/0.04),0_12px_40px_-16px_rgb(14_23_38/0.18)] dark:shadow-none">
            {!v || !p || !network ? (
              <div aria-busy="true" aria-label="Loading proof" className="p-6 sm:p-10">
                <Shimmer className="h-9 w-48" />
                <Shimmer className="mx-auto mt-10 size-20 rounded-full" />
                <Shimmer className="mx-auto mt-5 h-6 w-64" />
                <Shimmer className="mt-10 h-56 w-full rounded-xl" />
              </div>
            ) : (
              <ProofBody
                v={v}
                p={p}
                network={network}
                checks={checks.data ?? null}
                failedToRead={checks.isError ? readErrorText(checks.error) : null}
                onRetry={() => void checks.refetch()}
                source={
                  p?.intents
                    ? delivery
                      ? `The delivery is read from ${settlementName(p.intents.settlement_network)} in this browser, through ${readerLabel(delivery)}. The order is hashed here too. The NEAR Intents status is the server's last read of 1Click.`
                      : `The order is hashed in this browser. No RPC is configured for ${settlementName(p.intents.settlement_network)}, so the delivery is not checked.`
                    : source
                      ? `Every check reads NEAR from this browser, through ${readerLabel(source)}${checks.data?.read?.blockHeight ? ` at final block ${checks.data.read.blockHeight.toLocaleString("en-US")}` : ""}. The order is hashed here too.`
                      : "The order is hashed in this browser. No NEAR RPC is configured for this network, so the chain checks are skipped."
                }
                items={order.data?.order.line_items ?? []}
                reference={order.data?.order.reference ?? null}
              />
            )}
          </div>
        </main>
        <CheckoutFooter supportEmail={v?.merchant.support_email ?? null} />
      </div>
    </CheckoutMotion>
  );
}

type Checked = Awaited<ReturnType<typeof runProofChecks>>;

function ProofBody({
  v,
  p,
  network,
  checks,
  failedToRead,
  onRetry,
  source,
  items,
  reference,
}: {
  v: CheckoutView;
  p: PaymentProof;
  network: ReturnType<typeof gatewayNetwork>;
  checks: Checked | null;
  /** Why NEAR could not be read, or null. */
  failedToRead: string | null;
  onRetry: () => void;
  source: string;
  items: { name: string; quantity: number; unit_amount: string }[];
  reference: string | null;
}) {
  const calm = useCalm();
  const ids = checks ? checks.checks.map((c) => c.id) : expectedCheckIds(p);
  const [revealed, setRevealed] = useState(0);
  const total = ids.length;
  useEffect(() => {
    if (!checks || revealed >= total) return;
    const t = setTimeout(() => setRevealed((n) => n + 1), calm ? 0 : REVEAL_MS);
    return () => clearTimeout(t);
  }, [checks, revealed, total, calm]);
  const done = Boolean(checks) && revealed >= total;
  const verdict = checks ? proofVerdict(checks.checks) : null;
  // A payment paid from another chain is proven where the USDC landed (NEAR mainnet when live).
  const any = p.intents ?? null;
  const ctx = { merchant: v.merchant.name, network: any ? settlementName(any.settlement_network) : network.name };
  const explorer = network.explorer;
  const amount = formatToken(p.amount_paid, v.token.symbol, v.token.decimals);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4 sm:px-8">
        <MerchantRow merchant={v.merchant} livemode={v.livemode} />
        <Button variant="ghost" size="sm" onClick={() => window.print()} className="print:hidden">
          <Printer /> <span className="max-sm:sr-only">Print</span>
        </Button>
      </div>

      <div className="flex flex-col items-center px-5 pt-8 pb-6 text-center sm:px-8">
        <Seal state={failedToRead ? "unverified" : !done ? "checking" : verdict!.state} fraction={total ? revealed / total : 0} />
        <p className="mt-5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Payment proof</p>
        {any && <IntentsLabel mode={any.mode} label={any.label} className="mt-2" />}
        <div aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1 key={failedToRead ? "f" : done ? verdict!.state : "c"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={T.base} className="mt-1 text-2xl font-semibold tracking-[-0.015em] text-balance">
              {failedToRead ? "We could not read the chain" : !done ? `Checking ${ctx.network}` : verdict!.state === "verified" ? `Verified on ${ctx.network}` : verdict!.state === "unverified" ? "Not verified on chain yet" : "Some checks did not pass"}
            </motion.h1>
          </AnimatePresence>
        </div>
        <p className="mt-2 max-w-[46ch] text-sm text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">{amount}</span> paid to {v.merchant.name}
          {p.paid_at ? <> on {formatDateTime(p.paid_at)}</> : null}. {v.description ? <>For {v.description}. </> : null}
          Every check below runs in your browser.
        </p>
      </div>

      <div className="px-5 sm:px-8">
        <ul className="divide-y rounded-xl border" aria-label="Checks">
          {ids.map((cid, i) => {
            const c = checks?.checks[i];
            return <CheckRow key={cid} title={plainCheckTitle(cid, ctx)} c={c && i < revealed ? c : null} />;
          })}
        </ul>
        {done && verdict && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={T.base} className="mt-3 text-center text-xs text-muted-foreground">
            {verdict.passed} of {verdict.run} checks passed{verdict.skipped ? `, ${verdict.skipped} not used on this server` : ""}.
          </motion.p>
        )}
        {failedToRead && (
          <Notice tone="warning" icon={<ShieldAlert />} className="mt-3">
            <span className="block">{failedToRead}</span>
            <Button variant="outline" size="sm" onClick={onRetry} className="mt-2 h-11 sm:h-8">
              <RotateCw aria-hidden /> Read NEAR again
            </Button>
          </Notice>
        )}
        {done && verdict?.state === "failed" && (
          <Notice tone="negative" icon={<ShieldX />} className="mt-3">
            Do not rely on this receipt until {v.merchant.name} explains why.
          </Notice>
        )}
        {any ? (
          <IntentsRows any={any} merchant={v.merchant.name} />
        ) : (
          <Rows
            className="mt-5"
            rows={[
              ["Amount", <TokenAmount key="a" atomic={p.amount_paid} token={v.token} />],
              [
                "Paid to",
                <span key="o" className="flex min-w-0 flex-col items-end gap-0.5">
                  <span>{v.merchant.name}</span>
                  <ChainLink text={p.payout} title={p.payout} href={explorer ? `${explorer}/address/${p.payout}` : null} />
                </span>,
              ],
              [
                "Transaction",
                p.tx_hash ? (
                  <span key="t" className="flex min-w-0 flex-col items-end gap-0.5 text-right">
                    <ChainLink text={shortHash(p.tx_hash)} title={p.tx_hash} href={explorer ? `${explorer}/txns/${p.tx_hash}` : null} />
                    <span className="text-xs text-muted-foreground">
                      {p.method === "voucher" ? "The settlement that paid it." : "As the payer's wallet reported it. The hub's own record of the payment is the proof."}
                    </span>
                  </span>
                ) : (
                  <span key="t" className="text-right text-muted-foreground">
                    None reported. The hub&apos;s own record of the payment is the proof.
                  </span>
                ),
              ],
            ]}
          />
        )}
      </div>

      <Technical>
        {any ? (
          <IntentsTechnical any={any} orderHash={p.order_hash} />
        ) : (
          <Rows
            rows={[
              ["Hub", p.hub ? <ChainLink key="h" text={p.hub} title={p.hub} href={explorer ? `${explorer}/address/${p.hub}` : null} /> : "-"],
              ["Hub payment id", p.hub_payment_id ? <span key="i" className="hash text-[0.8125rem]" title={p.hub_payment_id}>{shortHash(p.hub_payment_id)}</span> : "-"],
              ["Payer", p.payer ? <ChainLink key="p" text={p.payer} title={p.payer} href={explorer ? `${explorer}/address/${p.payer}` : null} /> : "-"],
              ["Paid with", p.method === "wallet" ? "NEAR wallet" : p.method === "voucher" ? "AI agent with a Budget" : p.method === "oneclick" ? "Any chain (NEAR Intents)" : p.method ? "Transfer" : "-"],
              ["Order fingerprint", <OrderHash key="h" value={p.order_hash} className="justify-end" />],
            ]}
          />
        )}
        {checks && (
          <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
            {checks.checks.map((c) => (
              <li key={c.id}>
                <span className="font-medium text-foreground">{c.label}:</span> {c.detail}
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <div className="mt-5">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Order</p>
            <LineItems items={items} token={v.token} />
            {reference && <p className="mt-2 text-xs text-muted-foreground">Reference {reference}</p>}
          </div>
        )}
        <p className="mt-4 text-xs text-subtle">{source}</p>
      </Technical>
    </div>
  );
}

/** The NEAR delivery link: 1Click's explorer link, else NearBlocks for NEAR mainnet; none on the local chain. */
function deliveryHref(any: IntentsProof): string | null {
  if (!any.delivery_tx) return null;
  return any.delivery_tx.explorer_url ?? (any.settlement_network === "near:mainnet" ? mainnetTxUrl(any.delivery_tx.hash) : null);
}

/** What a reader checks first for a payment paid from another chain: what was paid, from where, and where it landed. */
function IntentsRows({ any, merchant }: { any: IntentsProof; merchant: string }) {
  const mainnet = any.settlement_network === "near:mainnet";
  const usdc = { address: any.token, symbol: "USDC", decimals: 6 };
  return (
    <Rows
      className="mt-5"
      rows={[
        ["Amount", <TokenAmount key="a" atomic={any.amount} token={usdc} />],
        [
          "Paid to",
          <span key="o" className="flex min-w-0 flex-col items-end gap-0.5">
            <span>{merchant}</span>
            <ChainLink text={any.recipient} title={any.recipient} href={mainnet ? `https://nearblocks.io/address/${any.recipient}` : null} />
          </span>,
        ],
        [
          "Paid from",
          <span key="f" className="flex min-w-0 flex-col items-end gap-0.5 text-right">
            <span>
              {any.deposited ? `${any.deposited.formatted} ${any.deposited.symbol}` : any.origin.symbol} on {any.origin.chain_name}
            </span>
            <span className="text-xs text-muted-foreground">Through NEAR Intents (1Click)</span>
          </span>,
        ],
        [
          "Delivery",
          any.delivery_tx ? (
            <span key="d" className="flex min-w-0 flex-col items-end gap-0.5 text-right">
              <ChainLink text={shortHash(any.delivery_tx.hash)} title={any.delivery_tx.hash} href={deliveryHref(any)} />
              <span className="text-xs text-muted-foreground">The NEAR transaction that delivered the USDC. It is the proof.</span>
            </span>
          ) : (
            <span key="d" className="text-right text-muted-foreground">
              None reported.
            </span>
          ),
        ],
        [
          "NEAR Intents",
          <span key="s" className="flex min-w-0 flex-col items-end gap-0.5 text-right">
            <span className="hash text-[0.8125rem]">{any.oneclick.status ?? "No status"}</span>
            <span className="text-xs text-muted-foreground">1Click&apos;s status as the server last read it, {formatDateTime(any.oneclick.read_at)}. Its word, not the proof.</span>
          </span>,
        ],
      ]}
    />
  );
}

function IntentsTechnical({ any, orderHash }: { any: IntentsProof; orderHash: string }) {
  return (
    <Rows
      rows={[
        ["Settled on", any.settlement_network],
        ["USDC contract", <span key="t" className="hash text-[0.8125rem] [overflow-wrap:anywhere]" title={any.token}>{shortHash(any.token)}</span>],
        ["Buyer refund address", <span key="p" className="hash text-[0.8125rem]">{any.payer ?? "-"}</span>],
        ["Origin transaction", any.origin_txs[0] ? <span key="o" className="hash text-[0.8125rem]" title={any.origin_txs[0].hash}>{shortHash(any.origin_txs[0].hash)}</span> : "-"],
        ["Deposit address", <span key="a" className="hash text-[0.8125rem]" title={any.oneclick.deposit_address}>{shortHash(any.oneclick.deposit_address)}</span>],
        ["1Click correlation id", <span key="c" className="hash text-[0.8125rem] [overflow-wrap:anywhere]">{any.oneclick.correlation_id}</span>],
        ["How the server checked", verificationText(any.verification)],
        ["Paid with", "Any chain (NEAR Intents)"],
        ["Order fingerprint", <OrderHash key="h" value={orderHash} className="justify-end" />],
      ]}
    />
  );
}

/** The seal: a ring that fills as checks land, then a shield that settles, a crossed shield, or a neutral one when nothing was proven. */
function Seal({ state, fraction }: { state: "checking" | "verified" | "failed" | "unverified"; fraction: number }) {
  const calm = useCalm();
  const tone = state === "verified" ? "text-positive" : state === "failed" ? "text-negative" : state === "unverified" ? "text-warning" : "text-[var(--ink)]";
  return (
    <ProgressRing fraction={state === "checking" ? Math.max(0.04, fraction) : 1} size={88} stroke={4} barClassName={cn("transition-colors duration-300", tone)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          initial={calm ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={state === "checking" ? T.base : T.spring}
          className={cn("flex size-16 items-center justify-center rounded-full", state === "verified" ? "bg-positive text-white dark:text-background" : state === "failed" ? "bg-negative-soft text-negative" : state === "unverified" ? "bg-warning-soft text-warning" : "bg-muted text-[var(--ink)]")}
        >
          {state === "checking" ? (
            <LoaderCircle className="size-6 animate-spin" aria-hidden />
          ) : state === "verified" ? (
            <ShieldCheck className="size-7" aria-hidden />
          ) : state === "unverified" ? (
            <ShieldAlert className="size-7" aria-hidden />
          ) : (
            <ShieldX className="size-7" aria-hidden />
          )}
        </motion.span>
      </AnimatePresence>
    </ProgressRing>
  );
}

function CheckRow({ title, c }: { title: string; c: ProofCheck | null }) {
  const Icon = !c ? null : c.state === "pass" ? Check : c.state === "fail" ? X : Minus;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        <AnimatePresence mode="popLayout" initial={false}>
          {!c ? (
            <motion.span key="wait" exit={{ opacity: 0, scale: 0.6 }} transition={T.fast} className="flex">
              <LoaderCircle className="size-4 animate-spin text-subtle" aria-hidden />
            </motion.span>
          ) : (
            <motion.span
              key="done"
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={T.spring}
              className={cn(
                "flex size-6 items-center justify-center rounded-full",
                c.state === "pass" ? "bg-positive text-white dark:text-background" : c.state === "fail" ? "bg-negative text-white dark:text-background" : "bg-muted text-muted-foreground",
              )}
            >
              {Icon && <Icon className="size-3.5" strokeWidth={3} aria-hidden />}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm transition-colors duration-200", c ? "font-medium text-foreground" : "text-muted-foreground")}>
          {title}
          <span className="sr-only">: {!c ? "checking" : c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : "not used"}</span>
        </p>
        {c && c.state !== "pass" && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={{ duration: 0.22, ease: EASE_OUT }} className="text-xs text-muted-foreground">
            {c.state === "skip" ? "Not used on this server." : c.detail}
          </motion.p>
        )}
      </div>
    </li>
  );
}

function Technical({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const calm = useCalm();
  return (
    <div className="mt-5 border-t px-5 py-4 sm:px-8 print:block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="proof-technical" className="flex w-full items-center justify-between rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4">
        Technical details
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={T.base}>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="proof-technical"
            initial={calm ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={calm ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={calm ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={T.base}
            className="overflow-hidden"
          >
            <div className="pt-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChainLink({ text, title, href }: { text: string; title: string; href: string | null }) {
  const t = <AccountText value={text} className="hash text-[0.8125rem]" />;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={title} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded hover:underline">
      {t}
      <ExternalLink className="size-3.5 shrink-0 text-subtle" aria-hidden />
      <span className="sr-only">(opens the explorer)</span>
    </a>
  ) : (
    <span title={title}>{t}</span>
  );
}
