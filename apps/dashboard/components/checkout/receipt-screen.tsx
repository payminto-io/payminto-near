"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ExternalLink, LoaderCircle, Minus, Printer, ShieldCheck, ShieldX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime, formatToken, shortAddress, shortHash } from "@/lib/format";
import { gatewayNetwork } from "@/lib/gateway";
import { ApiError } from "@/lib/http";
import { expectedCheckIds, plainCheckTitle, proofVerdict, rpcReader, runProofChecks, type ProofCheck } from "@/lib/payment-proof";
import { useCheckoutApi } from "@/lib/use-checkout";
import type { CheckoutView, PaymentProof } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { brandStyle, CheckoutFooter, LineItems, MerchantRow, Notice, OrderHash, Rows, TokenAmount } from "./parts";
import { CheckoutMotion, EASE_OUT, ProgressRing, Shimmer, T, useCalm } from "./motion";
import { NotFoundScreen, UnavailableScreen, useCheckoutTitle } from "./checkout";

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
  const network = view.data ? gatewayNetwork(view.data.chain_id, info.data) : null;
  const checks = useQuery({
    queryKey: ["proof-checks", id, network?.rpcUrl],
    enabled: Boolean(proof.data && (order.data || order.isError) && network && (api?.chainReader || network.rpcUrl)),
    queryFn: () => runProofChecks({ ...proof.data!, deposit_address: proof.data!.deposit_address ?? view.data?.deposit_address ?? null }, order.data ?? null, api!.chainReader ? api!.chainReader() : rpcReader(network!.rpcUrl!)),
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
                failedToRead={checks.isError}
                source={api?.chainReader ? "Demo data: these checks run against an in-browser stand-in for the chain." : `Read straight from ${network.rpcUrl?.replace(/^https?:\/\//, "")}, not from the Payminto server.`}
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
  source,
  items,
  reference,
}: {
  v: CheckoutView;
  p: PaymentProof;
  network: ReturnType<typeof gatewayNetwork>;
  checks: Checked | null;
  failedToRead: boolean;
  source: string;
  items: { name: string; quantity: number; unit_amount: string }[];
  reference: string | null;
}) {
  const calm = useCalm();
  const ids = checks ? checks.checks.map((c) => c.id) : expectedCheckIds(p.method);
  const [revealed, setRevealed] = useState(0);
  const total = ids.length;
  useEffect(() => {
    if (!checks || revealed >= total) return;
    const t = setTimeout(() => setRevealed((n) => n + 1), calm ? 0 : REVEAL_MS);
    return () => clearTimeout(t);
  }, [checks, revealed, total, calm]);
  const done = Boolean(checks) && revealed >= total;
  const verdict = checks ? proofVerdict(checks.checks) : null;
  const ctx = { merchant: v.merchant.name, network: network.name };
  const explorer = network.explorer;
  const amount = formatToken(p.amount_paid, v.token.symbol, v.token.decimals);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4 sm:px-8">
        <MerchantRow merchant={v.merchant} livemode={v.livemode} chainId={v.chain_id} />
        <Button variant="ghost" size="sm" onClick={() => window.print()} className="print:hidden">
          <Printer /> <span className="max-sm:sr-only">Print</span>
        </Button>
      </div>

      <div className="flex flex-col items-center px-5 pt-8 pb-6 text-center sm:px-8">
        <Seal state={failedToRead ? "failed" : !done ? "checking" : verdict!.state} fraction={total ? revealed / total : 0} />
        <p className="mt-5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Payment proof</p>
        <div aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1 key={failedToRead ? "f" : done ? verdict!.state : "c"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={T.base} className="mt-1 text-2xl font-semibold tracking-[-0.015em] text-balance">
              {failedToRead ? "We could not read the chain" : !done ? `Checking ${network.name}` : verdict!.state === "verified" ? `Verified on ${network.name}` : "Some checks did not pass"}
            </motion.h1>
          </AnimatePresence>
        </div>
        <p className="mt-2 max-w-[46ch] text-sm text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">{amount}</span> paid to {v.merchant.name}
          {p.paid_at ? <> on {formatDateTime(p.paid_at)}</> : null}. {v.description ? <>For {v.description}. </> : null}
          Every check below runs in your browser, straight against the chain.
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
          <Notice tone="negative" icon={<ShieldX />} className="mt-3">
            The chain could not be read from this browser, so nothing here is verified yet. Try again later.
          </Notice>
        )}
        {done && verdict?.state === "failed" && (
          <Notice tone="negative" icon={<ShieldX />} className="mt-3">
            Do not rely on this receipt until {v.merchant.name} explains why.
          </Notice>
        )}
        <Rows
          className="mt-5"
          rows={[
            ["Amount", <TokenAmount key="a" atomic={p.amount_paid} token={v.token} />],
            [
              "Paid to",
              <span key="o" className="inline-flex items-center gap-1.5">
                {v.merchant.name} <ChainLink text={shortAddress(p.payout)} title={p.payout} href={explorer ? `${explorer}/address/${p.payout}` : null} />
              </span>,
            ],
            ["Transaction", p.tx_hash ? <ChainLink key="t" text={shortHash(p.tx_hash)} title={p.tx_hash} href={explorer ? `${explorer}/tx/${p.tx_hash}` : null} /> : "Not on chain yet"],
          ]}
        />
      </div>

      <Technical>
        <Rows
          rows={[
            ["Block", <span key="b" className="num">{checks?.blockNumber?.toString() ?? p.block_number ?? "-"}</span>],
            ["Final at", <span key="f">{p.finality_tag} head {checks?.finalBlock != null ? <span className="num text-muted-foreground">(block {checks.finalBlock.toString()})</span> : null}</span>],
            ["Payer", p.payer ? <ChainLink key="p" text={shortAddress(p.payer)} title={p.payer} href={explorer ? `${explorer}/address/${p.payer}` : null} /> : "-"],
            ["Paid with", p.method === "wallet" ? "Browser wallet" : p.method === "deposit" ? "Sent to address" : p.method === "hsp" ? "HSP" : p.method === "x402" || p.method === "voucher" ? "AI agent" : "-"],
            ["Order fingerprint", <OrderHash key="h" value={p.order_hash} className="justify-end" />],
            ["Public record", p.attestation ? <span key="a" className="hash text-[0.8125rem]" title={p.attestation.uid}>{shortHash(p.attestation.uid)}</span> : "Not kept on this server"],
          ]}
        />
        {checks && checks.events.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Token events in the transaction</p>
            <ul className="space-y-1.5 text-[0.8125rem]">
              {checks.events.map((e, i) => (
                <li key={i} className="hash rounded-md bg-muted px-2.5 py-1.5 break-all">
                  {e.name === "Transfer"
                    ? `Transfer(${shortAddress(e.from)} → ${shortAddress(e.to)}, ${formatToken(e.value, v.token.symbol, v.token.decimals)})`
                    : `AuthorizationUsed(${shortAddress(e.authorizer)}, ${shortHash(e.nonce)})`}
                </li>
              ))}
            </ul>
          </div>
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

/** The seal: a ring that fills as checks land, then a shield that settles (or a crossed shield). */
function Seal({ state, fraction }: { state: "checking" | "verified" | "failed"; fraction: number }) {
  const calm = useCalm();
  const tone = state === "verified" ? "text-positive" : state === "failed" ? "text-negative" : "text-[var(--ink)]";
  return (
    <ProgressRing fraction={state === "checking" ? Math.max(0.04, fraction) : 1} size={88} stroke={4} barClassName={cn("transition-colors duration-300", tone)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          initial={calm ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={state === "checking" ? T.base : T.spring}
          className={cn("flex size-16 items-center justify-center rounded-full", state === "verified" ? "bg-positive text-white dark:text-background" : state === "failed" ? "bg-negative-soft text-negative" : "bg-muted text-[var(--ink)]")}
        >
          {state === "checking" ? <LoaderCircle className="size-6 animate-spin" aria-hidden /> : state === "verified" ? <ShieldCheck className="size-7" aria-hidden /> : <ShieldX className="size-7" aria-hidden />}
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
  const t = <span className="hash text-[0.8125rem]">{text}</span>;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={title} className="inline-flex items-center gap-1 rounded hover:underline">
      {t}
      <ExternalLink className="size-3.5 text-subtle" aria-hidden />
      <span className="sr-only">(opens the explorer)</span>
    </a>
  ) : (
    <span title={title}>{t}</span>
  );
}
