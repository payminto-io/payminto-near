"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CircleHelp, CircleX, Clock, Loader2, RotateCw, TriangleAlert, Wallet } from "lucide-react";
import type { AccountId as NearAccount, WalletTx } from "@payminto/protocol";
import { FlowError, ensureConnected, signAndSendTransactions, toWalletError, type TxResult } from "@/lib/wallet";
import { txLines } from "@/lib/tx-display";
import { useExplorer } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccountId, AccountSentence, splitForMiddle } from "./account-id";
import { CopyButton, ExplorerLink } from "./actions";

/** One line of progress while a flow is between the wallet and NEAR, with the transaction once there is one. */
export type TxStep = { title: string; body: string; hash?: string; /** Who is being waited on, for the disabled button: "Waiting for the relayer". */ waiting?: string };

export type TxPlan = {
  /** "Deposit into this Budget". */
  title: string;
  /** One sentence on what happens and what does not. */
  description: ReactNode;
  /** The decision in plain rows, for example the amount and the Budget. */
  summary: Array<{ label: string; value: ReactNode }>;
  /** Sent in order with one approval. */
  txs: WalletTx[];
  /** The primary button: the action and its object. */
  confirmLabel: string;
  /** What to tell the person once every transaction is final. */
  finalNote?: ReactNode;
  /** The account that must sign, such as the Budget owner; any other connected account is refused before sending. */
  signer?: NearAccount;
  /** Heading above the transaction cards, when the wallet signs something other than a transaction it sends itself. */
  txHeading?: string;
  /** Who pays the gas when it is not the signer, shown on every transaction card. */
  gasPayer?: ReactNode;
  /** Calls that run later if others agree, such as the hub call inside a DAO proposal, decoded for review. */
  inner?: { heading: string; txs: WalletTx[] };
  /** A reason this cannot be sent as things stand. Shown above the review, and the primary button is disabled. */
  blocked?: ReactNode;
  /**
   * Replaces sign-and-send for flows where the wallet signs and someone else sends (a relayer). Reports each step in
   * plain words, and may return a result that is still pending on NEAR.
   */
  run?: (ctx: { progress: (step: TxStep) => void }) => Promise<TxResult[]>;
  /** Reads pending results again from NEAR. Without it, a pending result can only be closed. */
  recheck?: (results: TxResult[]) => Promise<TxResult[]>;
  /** Turns a failure text from NEAR into what happened and what to do next, for contracts with their own error codes. */
  explainFailure?: (error: string) => string;
  /**
   * Another wallet connection than the dashboard's own, such as NEAR mainnet for the any-chain payout account: it
   * connects (refusing any account but `signer`) and sends in place of the default wallet, and its transactions link to
   * its own explorer. The review names its network in `label`.
   */
  wallet?: TxWallet;
};

export type TxWallet = {
  /** "NEAR mainnet". */
  label: string;
  connect: (signer?: NearAccount) => Promise<unknown>;
  send: (txs: WalletTx[]) => Promise<TxResult[]>;
  explorerTx: (hash: string) => string | null;
};

type Phase =
  | { kind: "review"; notice?: string }
  | { kind: "pending"; step?: TxStep }
  | { kind: "final"; results: TxResult[] }
  | { kind: "sent"; results: TxResult[]; checking: boolean }
  | { kind: "failed"; error: string; results: TxResult[] };

/**
 * Every owner action on chain goes through here: the exact transactions before signing (receiver, method, arguments,
 * deposit and gas), then pending, final or failed. A cancel in the wallet returns to the review with a note, never an
 * error. Below 640px it is a bottom sheet.
 */
export function TxFlow({ plan, open, onOpenChange, onFinal }: { plan: TxPlan; open: boolean; onOpenChange: (open: boolean) => void; onFinal?: (results: TxResult[]) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "review" });
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = phase.kind === "pending" || (phase.kind === "sent" && phase.checking);

  function close(next: boolean) {
    if (busy) return; // The wallet or NEAR decides; closing now would hide the outcome.
    onOpenChange(next);
    if (!next) setPhase({ kind: "review" });
  }

  /** Files a set of results under failed, sent or final, and reports final once. */
  function settle(results: TxResult[]) {
    const failed = results.find((r) => r.status === "failed");
    if (failed && failed.status === "failed") setPhase({ kind: "failed", error: plan.explainFailure?.(failed.error) ?? failed.error, results });
    else if (results.some((r) => r.status === "pending")) setPhase({ kind: "sent", results, checking: false });
    else {
      setPhase({ kind: "final", results });
      onFinal?.(results);
    }
  }

  async function send() {
    setPhase({ kind: "pending" });
    try {
      await (plan.wallet ? plan.wallet.connect(plan.signer) : ensureConnected(plan.signer));
      settle(plan.run ? await plan.run({ progress: (step) => setPhase({ kind: "pending", step }) }) : plan.wallet ? await plan.wallet.send(plan.txs) : await signAndSendTransactions(plan.txs));
    } catch (e) {
      if (e instanceof FlowError) return setPhase({ kind: "failed", error: e.message, results: [] });
      const err = toWalletError(e);
      if (err.kind === "rejected") setPhase({ kind: "review", notice: err.message });
      else setPhase({ kind: "failed", error: err.message, results: [] });
    }
  }

  async function checkAgain(results: TxResult[]) {
    if (!plan.recheck) return;
    setPhase({ kind: "sent", results, checking: true });
    try {
      settle(await plan.recheck(results));
    } catch {
      setPhase({ kind: "sent", results, checking: false });
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        sheetOnMobile
        showCloseButton={!busy}
        className="gap-0 p-0 sm:max-w-xl max-sm:p-0"
        onOpenAutoFocus={(e) => {
          // Land on the decision, not on the first copy button inside the transaction.
          e.preventDefault();
          (plan.blocked ? cancelRef : confirmRef).current?.focus();
        }}
      >
        <DialogHeader className="border-b px-4 py-4 text-left sm:px-6">
          <DialogTitle className="pr-8 text-[0.9375rem] leading-[1.375rem]">{plan.title}</DialogTitle>
          <DialogDescription className="text-[0.8125rem]">{plan.description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60dvh] overflow-y-auto px-4 py-4 sm:px-6">
          {phase.kind === "review" && <Review plan={plan} notice={phase.notice} />}
          {phase.kind === "pending" && <Pending count={plan.txs.length} step={phase.step} txHref={plan.wallet?.explorerTx} />}
          {phase.kind === "final" && <Outcome tone="final" results={phase.results} note={plan.finalNote} txHref={plan.wallet?.explorerTx} />}
          {phase.kind === "sent" && <Outcome tone={phase.results.some((r) => r.status === "pending" && r.unknown) ? "unknown" : "sent"} results={phase.results} txHref={plan.wallet?.explorerTx} />}
          {phase.kind === "failed" && <Outcome tone="failed" results={phase.results} error={phase.error} txHref={plan.wallet?.explorerTx} />}
        </div>

        {/* Sticky only in the bottom sheet, which scrolls itself. The centred dialog is moved by a transform, and a sticky child of a transformed box is placed as if it had not moved, which drew the footer over the review. */}
        <DialogFooter className="gap-2 border-t bg-background px-4 py-3 sm:px-6 max-sm:sticky max-sm:bottom-0 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {phase.kind === "review" && (
            <>
              <Button ref={cancelRef} variant="outline" className="max-sm:h-11 max-sm:rounded-xl" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                ref={confirmRef}
                disabled={Boolean(plan.blocked)}
                className="max-sm:h-12 max-sm:rounded-xl max-sm:text-[0.9375rem] max-sm:font-semibold max-sm:whitespace-normal max-sm:leading-tight"
                onClick={() => void send()}
              >
                <Wallet aria-hidden /> {plan.confirmLabel}
              </Button>
            </>
          )}
          {phase.kind === "pending" && (
            <Button disabled className="max-sm:col-span-2 max-sm:h-12 max-sm:rounded-xl">
              <Loader2 aria-hidden className="animate-spin" /> {phase.step?.waiting ?? (phase.step?.hash ? "Waiting for NEAR" : "Waiting for your wallet")}
            </Button>
          )}
          {phase.kind === "final" && (
            <Button className="max-sm:col-span-2 max-sm:h-12 max-sm:rounded-xl" onClick={() => close(false)}>
              Done
            </Button>
          )}
          {phase.kind === "sent" &&
            (plan.recheck ? (
              <>
                <Button variant="outline" className="max-sm:h-11 max-sm:rounded-xl" disabled={phase.checking} onClick={() => close(false)}>
                  Close
                </Button>
                <Button className="max-sm:h-12 max-sm:rounded-xl" disabled={phase.checking} onClick={() => void checkAgain(phase.results)}>
                  {phase.checking ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />} Check again
                </Button>
              </>
            ) : (
              <Button className="max-sm:col-span-2 max-sm:h-12 max-sm:rounded-xl" onClick={() => close(false)}>
                Close
              </Button>
            ))}
          {phase.kind === "failed" && (
            <>
              <Button variant="outline" className="max-sm:h-11 max-sm:rounded-xl" onClick={() => close(false)}>
                Close
              </Button>
              <Button className="max-sm:h-12 max-sm:rounded-xl" onClick={() => setPhase({ kind: "review" })}>
                Review and try again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type OpenFlow = (plan: TxPlan, onFinal?: (results: TxResult[]) => void) => void;
const FlowHost = createContext<OpenFlow | null>(null);

/**
 * Holds the open TxFlow for a whole screen. An action often changes the very thing its button sits in (a revoke hides
 * the stop controls), and a flow kept beside that button would vanish with it, before the person saw how it ended.
 * Under a provider the flow outlives the control that opened it.
 */
export function TxFlowProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ plan: TxPlan; onFinal?: (results: TxResult[]) => void; key: number } | null>(null);
  const seq = useRef(0);
  const open = useCallback<OpenFlow>((plan, onFinal) => setCurrent({ plan, onFinal, key: ++seq.current }), []);
  return (
    <FlowHost.Provider value={open}>
      {children}
      {current && <TxFlow key={current.key} plan={current.plan} open onOpenChange={(o) => !o && setCurrent(null)} onFinal={current.onFinal} />}
    </FlowHost.Provider>
  );
}

/**
 * Opens a TxFlow from any control. With a `TxFlowProvider` above, the screen holds the flow and `flow` is null; without
 * one, the caller renders `flow` itself and the flow lives as long as the caller does.
 */
export function useTxFlow(): { open: OpenFlow; flow: ReactNode } {
  const host = useContext(FlowHost);
  const [local, setLocal] = useState<{ plan: TxPlan; onFinal?: (results: TxResult[]) => void; key: number } | null>(null);
  const seq = useRef(0);
  const openLocal = useCallback<OpenFlow>((plan, onFinal) => setLocal({ plan, onFinal, key: ++seq.current }), []);
  return useMemo(
    () => ({
      open: host ?? openLocal,
      flow: host || !local ? null : <TxFlow key={local.key} plan={local.plan} open onOpenChange={(o) => !o && setLocal(null)} onFinal={local.onFinal} />,
    }),
    [host, openLocal, local],
  );
}

function Review({ plan, notice }: { plan: TxPlan; notice?: string }) {
  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <AccountSentence>{notice}</AccountSentence>
        </p>
      )}
      {plan.blocked && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 text-foreground">{typeof plan.blocked === "string" ? <AccountSentence>{plan.blocked}</AccountSentence> : plan.blocked}</div>
        </div>
      )}
      <dl className="divide-y rounded-xl border">
        {[
          ...(plan.wallet ? [{ label: "Network", value: <span className="font-medium">{plan.wallet.label}</span> }] : []),
          ...plan.summary,
          ...(plan.signer ? [{ label: "Signed by", value: <AccountId value={plan.signer} mode="wrap" explorer={false} /> }] : []),
        ].map((r) => (
          <div key={r.label} className="grid min-h-12 items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm sm:grid-cols-[6rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0">{r.value}</dd>
          </div>
        ))}
      </dl>
      <section aria-label="What your wallet will sign" className="flex flex-col gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          {plan.txHeading ?? (plan.txs.length === 1 ? "The transaction your wallet will sign" : `The ${plan.txs.length} transactions your wallet will sign, in order`)}
        </h3>
        {plan.txs.map((tx, i) => (
          <TxCard key={i} tx={tx} index={plan.txs.length > 1 ? i + 1 : null} gasPayer={plan.gasPayer} explorer={!plan.wallet} />
        ))}
      </section>
      {plan.inner && (
        <section aria-label={plan.inner.heading} className="flex flex-col gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">{plan.inner.heading}</h3>
          {plan.inner.txs.map((tx, i) => (
            <TxCard key={i} tx={tx} index={plan.inner!.txs.length > 1 ? i + 1 : null} />
          ))}
        </section>
      )}
    </div>
  );
}

/** `explorer` false: the receiver is on another network than the dashboard's explorer shows. */
function TxCard({ tx, index, gasPayer, explorer = true }: { tx: WalletTx; index: number | null; gasPayer?: ReactNode; explorer?: boolean }) {
  return (
    <div className="rounded-xl border bg-rail">
      {txLines(tx).map((l, j) => (
        <dl key={j} className="flex flex-col gap-2.5 p-3 text-sm">
          <Row label={index ? `${index}. Receiver` : "Receiver"}>
            <AccountId value={l.receiver} mode="wrap" explorer={explorer} />
          </Row>
          <Row label="Method">
            <code className="font-mono text-[0.8125rem]">{l.method}</code>
          </Row>
          <Row label="Arguments">
            <div className="relative">
              <pre className="max-h-48 overflow-auto rounded-md border bg-card p-2.5 pr-9 font-mono text-xs leading-4 [overflow-wrap:anywhere] whitespace-pre-wrap">{l.args}</pre>
              <CopyButton value={l.args} label="arguments" className="absolute top-1.5 right-1.5" />
            </div>
          </Row>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Deposit">
              <span className="font-mono text-[0.8125rem]">{l.deposit}</span>
            </Row>
            <Row label="Gas limit">
              <span className="font-mono text-[0.8125rem]">{l.gas}</span>
            </Row>
          </div>
          {gasPayer && <Row label="Gas paid by">{gasPayer}</Row>}
        </dl>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** `txHref` replaces the dashboard's explorer for a flow on another network (NEAR mainnet). */
type TxHref = ((hash: string) => string | null) | undefined;

function HashLine({ hash, txHref }: { hash: string; txHref?: TxHref }) {
  const ex = useExplorer();
  const href = txHref ? txHref(hash) : ex.tx(hash);
  const [head, tail] = splitForMiddle(hash);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span className="flex min-w-0 font-mono text-xs" title={hash}>
        <span className="truncate">{head}</span>
        <span className="shrink-0">{tail}</span>
      </span>
      <CopyButton value={hash} label="transaction hash" />
      <ExplorerLink href={href} label="transaction" />
    </span>
  );
}

function Pending({ count, step, txHref }: { count: number; step?: TxStep; txHref?: TxHref }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-info-soft text-primary">
        <Loader2 aria-hidden className="size-5 animate-spin" />
      </span>
      <p className="text-[1.25rem] leading-7 font-semibold tracking-[-0.015em]">{step?.title ?? "Approve in your wallet"}</p>
      <p className="max-w-[40ch] text-sm text-muted-foreground">
        {step?.body ?? `Your wallet shows the same ${count === 1 ? "transaction" : `${count} transactions`}. Once you approve, NEAR runs ${count === 1 ? "it" : "them"} and this updates in a few seconds.`}
      </p>
      {step?.hash && (
        <div className="flex w-full max-w-sm items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Sent</span>
          <HashLine hash={step.hash} txHref={txHref} />
        </div>
      )}
    </div>
  );
}

const OUTCOME = {
  final: { box: "border-positive/30 bg-positive-soft", seal: "bg-positive", text: "text-positive", title: "Final on NEAR", Icon: CircleCheck },
  failed: { box: "border-negative/30 bg-negative-soft", seal: "bg-negative", text: "text-negative", title: "Not completed", Icon: CircleX },
  sent: { box: "border-warning/40 bg-warning-soft", seal: "bg-warning", text: "text-warning", title: "Sent, not final yet", Icon: Clock },
  unknown: { box: "border-warning/40 bg-warning-soft", seal: "bg-warning", text: "text-warning", title: "The result is unknown", Icon: CircleHelp },
} as const;

const WAITING_TEXT = {
  sent: "The transaction was sent and this page does not see its effect on the hub yet. Check again in a moment. Do not send it a second time.",
  unknown: "The relayer could not say whether its transaction landed, and the hub does not show the change. Check the Budget before trying again: use Check again here, and do not sign a second one until the hub has been read.",
} as const;

const RESULT_WORD = { final: "Final", failed: "Failed", pending: "Waiting" } as const;
const RESULT_TONE = { final: "text-positive", failed: "text-negative", pending: "text-warning" } as const;

function Outcome({ tone, results, error, note, txHref }: { tone: keyof typeof OUTCOME; results: TxResult[]; error?: string; note?: ReactNode; txHref?: TxHref }) {
  const o = OUTCOME[tone];
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <div className={cn("flex items-center gap-4 rounded-xl border p-4", o.box)}>
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-full", o.seal)}>
          <o.Icon aria-hidden className="size-6 text-white dark:text-background" />
        </span>
        <div className="min-w-0">
          <p className={cn("text-[1.25rem] leading-7 font-semibold tracking-[-0.015em]", o.text)}>{o.title}</p>
          <p className="text-sm text-muted-foreground">
            {tone === "final" ? note ?? "NEAR executed every transaction." : tone === "failed" ? <AccountSentence>{error ?? ""}</AccountSentence> : WAITING_TEXT[tone]}
          </p>
        </div>
      </div>
      {results.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {results.map((r, i) => (
            <li key={i} className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm">
              <span className={cn("shrink-0 text-xs font-medium", RESULT_TONE[r.status])}>{RESULT_WORD[r.status]}</span>
              {r.hash ? <HashLine hash={r.hash} txHref={txHref} /> : <span className="text-muted-foreground">{r.status === "pending" ? "The relayer gave no transaction hash" : "Not sent"}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
