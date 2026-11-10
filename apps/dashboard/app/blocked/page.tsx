"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldBan, ShieldCheck, UserX, Wallet } from "lucide-react";
import { useAccess, useApi } from "@/lib/session";
import { qk, useToken } from "@/lib/queries";
import { gk } from "@/lib/gateway-queries";
import { parseAccount } from "@/lib/gateway";
import { summarizeDenials } from "@/lib/denials";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Denial, ScreeningDecision, ScreeningRule } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Address, Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip, RuleChip } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { DenialItem, NoMoneyMoved } from "@/components/app/denial";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo, useNow } from "@/components/app/time-ago";
import { FormRow, Segmented } from "@/components/gateway/kit";
import { NoAccess } from "@/components/account/parts";

type Tab = "attempts" | "wallets";

/** One plain sentence per screening rule (PRODUCT.md section 2.3), used when the server sends no message. */
const PAYMENT_REASON: Record<ScreeningRule, string> = {
  PAYER_BLACKLISTED: "The token contract has blocked this account",
  PAYOUT_BLACKLISTED: "The token contract has blocked your payout account",
  PAYER_DENIED: "This wallet is on your blocked list",
  PAYER_TOO_NEW: "This wallet has too little history to accept payments from",
};

/** Reads after "with": how the refused payment was being made. */
const STAGE: Record<string, string> = { x402: "an AI agent", voucher: "an AI agent's Budget", wallet: "a NEAR wallet", deposit: "a direct transfer", authorize: "a NEAR wallet", relay: "a NEAR wallet" };

type Attempt = { kind: "agent"; at: string; denial: Denial } | { kind: "payment"; at: string; decision: ScreeningDecision };

export default function BlockedPage() {
  return (
    <Suspense>
      <Blocked />
    </Suspense>
  );
}

function Blocked() {
  const access = useAccess();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: Tab = params.get("tab") === "wallets" ? "wallets" : "attempts";
  if (!access.can("screening.read")) return <NoAccess title="Blocked" />;
  return (
    <>
      <PageHeader
        title="Blocked"
        description="Payments and agent Calls Payminto refused, with the reason, and the wallets you never want money from. A refused attempt never reaches your wallet or a settlement, so no money moves."
        actions={
          <Segmented
            label="Show"
            value={tab}
            onChange={(k) => router.replace(k === "wallets" ? `${pathname}?tab=wallets` : pathname)}
            options={[
              { key: "attempts", label: "Attempts" },
              { key: "wallets", label: "Blocked wallets" },
            ]}
          />
        }
      />
      {tab === "attempts" ? <Attempts /> : <BlockedWallets />}
    </>
  );
}

function Attempts() {
  const api = useApi();
  const access = useAccess();
  const token = useToken();
  const agents = access.can("agents.read");
  const denials = useQuery({ queryKey: qk.denials, queryFn: () => api.denials(100), enabled: agents });
  const decisions = useQuery({ queryKey: gk.screening, queryFn: () => api.gateway.screeningDecisions() });
  const summary = useMemo(() => summarizeDenials(denials.data ?? []), [denials.data]);
  const pending = decisions.isPending || (agents && denials.isPending);
  const error = decisions.error ?? (agents ? denials.error : null);

  const attempts = useMemo<Attempt[]>(() => {
    const list: Attempt[] = [
      ...(agents ? (denials.data ?? []).map((d): Attempt => ({ kind: "agent", at: d.createdAt, denial: d })) : []),
      ...(decisions.data ?? []).map((d): Attempt => ({ kind: "payment", at: d.created_at, decision: d })),
    ];
    return list.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [agents, denials.data, decisions.data]);

  const payments = decisions.data?.length ?? 0;
  const refusedCalls = agents ? denials.data?.length ?? 0 : 0;
  const refused = (decisions.data ?? []).reduce((a, d) => a + BigInt(d.amount ?? "0"), 0n) + (agents ? BigInt(summary.attempted) : 0n);
  const day = useNow() - 86_400_000;
  const last24 = attempts.filter((a) => new Date(a.at).getTime() >= day).length;

  return (
    <>
      <section className="mb-5 flex items-start gap-4 rounded-xl border bg-card p-4 sm:items-center sm:p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-positive-soft text-positive sm:size-11" aria-hidden>
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Safety checks are on</p>
          <p className="mt-0.5 text-muted-foreground">
            Payminto refuses accounts the token contract has blocked, accounts on your blocked list and brand-new accounts before it signs checkout terms for them.
            {agents && " Every agent Call is also checked against its Budget before anything is booked."}
          </p>
        </div>
      </section>

      {pending ? (
        <BlockSkeleton className="h-[5.75rem]" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void (decisions.refetch(), agents && denials.refetch())} />
      ) : (
        <StatStrip
          stats={[
            { label: "Blocked attempts", value: <span className={cn("num", attempts.length > 0 && "text-negative")}>{formatInt(attempts.length)}</span>, note: `${formatInt(last24)} in the last 24 hours` },
            agents
              ? { label: "Agent Calls refused", value: <span className="num">{formatInt(refusedCalls)}</span>, note: `${formatInt(summary.attacks)} looked like attacks` }
              : { label: "Payments refused", value: <span className="num">{formatInt(payments)}</span>, note: "by the safety checks" },
            agents ? { label: "Payments refused", value: <span className="num">{formatInt(payments)}</span>, note: "by the safety checks" } : { label: "Value refused", value: <Money atomic={refused.toString()} />, note: "asked for by refused attempts" },
            {
              label: "Money moved",
              value: (
                <span className="num text-positive">
                  0.00<span className="ml-1 text-[0.82em] font-normal">{token.symbol}</span>
                </span>
              ),
              note: "a refused attempt never settles",
              tone: "positive",
            },
          ]}
        />
      )}

      <div className={cn("mt-5 grid items-start gap-5", agents && summary.byRule.length > 0 && "xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]")}>
        <Panel title="Recent attempts" description="Newest first, payments and agent Calls together" bodyClassName="p-0 sm:p-0">
          {pending ? (
            <RowsSkeleton className="px-5" rows={6} />
          ) : attempts.length === 0 ? (
            <EmptyState icon={<ShieldBan className="size-4" />} title="Nothing blocked yet">
              Refused payments and agent charges appear here, with the reason.
            </EmptyState>
          ) : (
            <ul className="stagger divide-y">
              {attempts.slice(0, 60).map((a) =>
                a.kind === "agent" ? (
                  <DenialItem key={`a:${a.denial.id}`} denial={a.denial} className="transition-colors duration-150 ease-out hover:bg-muted/40" />
                ) : (
                  <PaymentAttempt key={`p:${a.decision.id}`} d={a.decision} />
                ),
              )}
            </ul>
          )}
        </Panel>
        {agents && summary.byRule.length > 0 && (
          <Panel title="Agent rules that fired" description="Grouped by the Budget rule that refused the Call" bodyClassName="p-0 sm:p-0">
            <ul className="divide-y">
              {summary.byRule.map((r) => (
                <li key={r.title} className="flex items-start gap-3 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{r.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{r.description}</span>
                    <span className="mt-1.5 block">
                      <RuleChip rule={r.rule} retry={r.hubUnreadable} />
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="num block font-medium">{formatInt(r.count)}</span>
                    <span className="block text-xs text-muted-foreground">
                      <TimeAgo iso={r.last} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

function PaymentAttempt({ d }: { d: ScreeningDecision }) {
  const wallet = d.payer ?? d.address;
  return (
    <li className="flex gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-negative-soft text-negative" aria-hidden>
        <Wallet className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{d.message || PAYMENT_REASON[d.rule]}</span>
          <Chip tone="neutral" dot={false}>
            Payment
          </Chip>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {wallet ? (
            <>
              <Address address={wallet} showName={false} /> tried to pay
            </>
          ) : (
            "Someone tried to pay"
          )}
          {d.amount && <Money atomic={d.amount} className="text-foreground" />}
          {(d.method ?? d.stage) && <span>with {STAGE[d.method ?? d.stage ?? ""] ?? d.method ?? d.stage}</span>}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          <NoMoneyMoved />
          {d.payment_id && (
            <Link href={`/payments/${d.payment_id}`} className="rounded hover:text-foreground hover:underline">
              Payment
            </Link>
          )}
          <TimeAgo iso={d.created_at} />
        </div>
      </div>
    </li>
  );
}

function BlockedWallets() {
  const api = useApi();
  const access = useAccess();
  const qc = useQueryClient();
  const business = access.view?.kind === "business";
  const canEdit = business && access.can("screening.manage");
  const list = useQuery({ queryKey: gk.denyList, queryFn: () => api.gateway.denyList(), enabled: business });
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const valid = parseAccount(address);
  const add = useMutation({
    mutationFn: () => api.gateway.addDeny({ address: valid!, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success("Wallet blocked. It can no longer pay this business.");
      setAddress("");
      setNote("");
      setTouched(false);
      void qc.invalidateQueries({ queryKey: gk.denyList });
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (a: string) => api.gateway.removeDeny(a as `0x${string}`),
    onSuccess: () => {
      toast.success("Wallet unblocked.");
      void qc.invalidateQueries({ queryKey: gk.denyList });
    },
    onError: (e) => toast.error(e.message),
  });

  if (!business) {
    return (
      <div className="rounded-xl border bg-card">
        <EmptyState icon={<UserX className="size-4" />} title="Blocked wallets belong to one business">
          Each business keeps its own list. Open a business with the switcher at the top of the sidebar to see and change it.
        </EmptyState>
      </div>
    );
  }

  return (
    <Panel title="Blocked wallets" description="Wallets you never want to accept money from. Payminto refuses them before it signs checkout terms." bodyClassName="p-0 sm:p-0" className="max-w-3xl">
      {canEdit && (
        <form
          className="grid gap-3 border-b p-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end sm:p-5"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (valid) add.mutate();
          }}
        >
          <FormRow id="deny-address" label="Wallet address" error={touched && !valid ? "Enter a valid 0x address." : null}>
            <Input id="deny-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="alice.testnet" className="hash text-[0.8125rem]" spellCheck={false} autoComplete="off" />
          </FormRow>
          <FormRow id="deny-note" label="Note" optional>
            <Input id="deny-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} placeholder="Only your team sees it" />
          </FormRow>
          <Button type="submit" disabled={add.isPending}>
            Block wallet
          </Button>
        </form>
      )}
      {list.isPending ? (
        <RowsSkeleton className="px-5" rows={2} />
      ) : list.isError ? (
        <ErrorState className="m-4" error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={<UserX className="size-4" />} title="No blocked wallets">
          {canEdit ? "Add a wallet above to refuse its payments." : "An Admin of this business can add wallets here."}
        </EmptyState>
      ) : (
        <ul className="stagger divide-y">
          {list.data.map((d) => (
            <li key={d.address} className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5">
              <span className="min-w-0">
                <Address address={d.address} showName={false} />
                <span className="block text-xs text-muted-foreground">
                  {d.note ?? "No note"} · added <TimeAgo iso={d.created_at} />
                </span>
              </span>
              {canEdit && (
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(d.address)} aria-label={`Unblock ${d.address}`}>
                  Unblock
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
