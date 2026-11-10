"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Ban, Coins, Fuel, Loader2, RotateCw, Undo2, Vote } from "lucide-react";
import { depositBudgetTx, fundFromCreditTx, reclaimTx, revokeBudgetTx, type WalletTx } from "@payminto/protocol";
import { networkIdOf, qk, useInfo, useToken } from "@/lib/queries";
import { useApi, useCan } from "@/lib/session";
import { parseAmountInput, plainAmount } from "@/lib/gateway";
import { reclaimAt } from "@/lib/spend";
import { graceAdjective } from "@/lib/grace";
import { formatDateTime } from "@/lib/format";
import { useNetworkWords } from "@/lib/use-network-words";
import { bondText, daoFailureText, innerTx, isDaoAccount } from "@/lib/dao";
import { daoKey, daoReadErrorText, useDaoAddon, useDaoMembership, useDaoPolicy } from "@/lib/use-dao";
import { confirmOnHub, reclaimedOnHub, revokedOnHub, sendGasless } from "@/lib/gasless";
import { useGaslessOffer, type GaslessOffer } from "@/lib/use-gasless";
import { delegateSupport, delegateUnsupportedText } from "@/lib/wallet";
import type { BudgetDetail, BudgetRecord } from "@/lib/schemas";
import { useNow } from "@/components/app/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountId, AccountSentence } from "@/components/ds/account-id";
import { useTxFlow, type TxPlan } from "@/components/ds/tx-flow";
import { Field, Fields, Money, Panel } from "./primitives";

type BudgetLike = Pick<BudgetRecord, "id" | "label" | "owner" | "cap" | "escrow" | "ownerCredit" | "status" | "revokedAt" | "budget">;

/** What is still needed in escrow for the Budget to be spendable up to its cap without any offset. */
export function escrowShortfall(m: Pick<BudgetDetail, "cap" | "escrow" | "spend">): bigint {
  const need = BigInt(m.cap) - BigInt(m.spend.settled) - BigInt(m.escrow ?? "0");
  return need > 0n ? need : 0n;
}

/** Whether this Budget's owner is a Sputnik DAO on the server's network, so owner actions are proposals. */
export function useDaoOwner(owner: string): boolean {
  const info = useInfo();
  return info.data ? isDaoAccount(owner, networkIdOf(info.data)) : false;
}

export type OwnerPlans = {
  deposit: (amount: bigint) => TxPlan;
  moveCredit: (amount: bigint) => TxPlan;
  revoke: () => TxPlan;
  reclaim: () => TxPlan;
};

/**
 * The four owner actions on chain, each as a reviewed transaction plan. Builders come from the chain package. When the
 * owner is a DAO, each action is the same hub call wrapped in an `add_proposal` by the add-on's builders, signed by
 * the connected member with the DAO's exact bond.
 *
 * `plans` is null until everything needed to build them is known; `problem` says why when it never will be.
 */
export function useOwnerPlans(m: BudgetLike): { plans: OwnerPlans | null; viaDao: boolean; problem: string | null; retry: () => void } {
  const info = useInfo();
  const t = useToken();
  const viaDao = useDaoOwner(m.owner);
  const addon = useDaoAddon(viaDao);
  const policy = useDaoPolicy(viaDao ? m.owner : null);
  const member = useDaoMembership(viaDao ? m.owner : null, policy.data);

  const plans = useMemo((): OwnerPlans | null => {
    const hub = info.data?.hub;
    const token = info.data?.token.address;
    if (!hub || !token) return null;
    const amountRow = (label: string, atomic: bigint) => ({ label, value: <Money atomic={atomic} /> });
    const budgetRow = { label: "Budget", value: <span className="font-medium">{m.label}</span> };
    const money = (atomic: bigint) => `${plainAmount(atomic, t.decimals)} ${t.symbol}`;

    if (!viaDao) {
      const plan = (p: Omit<TxPlan, "signer">): TxPlan => ({ ...p, signer: m.owner });
      return {
        deposit: (amount) =>
          plan({
            title: "Deposit into this Budget",
            description: "Raises escrow only. The cap, which limits gross spending, stays where it is.",
            summary: [amountRow("Amount", amount), budgetRow],
            txs: [depositBudgetTx(token, hub, m.id, amount)],
            confirmLabel: `Deposit ${money(amount)}`,
            finalNote: "The hub holds the deposit for this Budget. Your server reads the new escrow within a few seconds.",
          }),
        moveCredit: (amount) =>
          plan({
            title: "Move credit into this Budget",
            description: "Moves credit you earned in settled batches into this Budget's escrow. No tokens leave the hub.",
            summary: [amountRow("Amount", amount), budgetRow],
            txs: [fundFromCreditTx(hub, m.id, amount)],
            confirmLabel: `Move ${money(amount)}`,
            finalNote: "Escrow went up and your credit went down by the same amount.",
          }),
        revoke: () =>
          plan({
            title: "Revoke this Budget on NEAR",
            description: `The hub stops new settlement for this Budget after a ${graceAdjective()} grace period, so Payees are paid for Calls already served. Your server refuses new Calls at once.`,
            summary: [budgetRow],
            txs: [revokeBudgetTx(hub, m.id)],
            confirmLabel: "Revoke on NEAR",
            finalNote: `Revoked on chain. You can reclaim the remaining escrow once the ${graceAdjective()} grace period ends.`,
          }),
        reclaim: () =>
          plan({
            title: "Reclaim escrow",
            description: "Returns everything still in escrow to your account. The Budget can no longer settle.",
            summary: [amountRow("Escrow", BigInt(m.escrow ?? "0")), budgetRow],
            txs: [reclaimTx(hub, m.id)],
            confirmLabel: "Reclaim escrow",
            finalNote: "The hub sent the escrow back to your account.",
          }),
      };
    }

    if (!addon.data || !policy.data) return null;
    const dao = addon.data;
    const ctx = { dao: m.owner, hub, network: networkIdOf(info.data), proposalBond: policy.data.proposal_bond };
    const blocked =
      member.account && member.ability && !member.ability.canPropose
        ? `${member.account} may not add proposals to this DAO. Connect a member's account, or ask a member to propose this.`
        : undefined;
    const proposal = (p: Pick<TxPlan, "title" | "description" | "confirmLabel"> & { rows: TxPlan["summary"]; built: { tx: WalletTx; proposal: { kind: Parameters<typeof innerTx>[1] } } }): TxPlan => ({
      title: p.title,
      description: p.description,
      summary: [
        ...p.rows,
        budgetRow,
        { label: "DAO", value: <AccountId value={m.owner} mode="wrap" explorer={false} /> },
        { label: "Bond", value: <span>{bondText(ctx.proposalBond)}, attached to the proposal and returned by the DAO when it is approved or rejected</span> },
      ],
      txs: [p.built.tx],
      inner: { heading: "What the DAO runs if its members approve", txs: [innerTx(dao, p.built.proposal.kind)] },
      confirmLabel: p.confirmLabel,
      finalNote: "The proposal is with the DAO. Nothing has changed on the hub yet; members approve it under Proposals on this page.",
      blocked,
      explainFailure: daoFailureText,
    });
    return {
      deposit: (amount) =>
        proposal({
          title: "Propose a deposit into this Budget",
          description: "Adds a proposal to the DAO that owns this Budget. No tokens move until its members approve it; then the DAO deposits from its own balance. Raises escrow only, never the cap.",
          rows: [amountRow("Amount", amount)],
          built: dao.depositProposal(ctx, token, m.id, amount),
          confirmLabel: `Propose deposit of ${money(amount)}`,
        }),
      moveCredit: (amount) =>
        proposal({
          title: "Propose moving credit into this Budget",
          description: "Adds a proposal to the DAO that owns this Budget. If its members approve it, credit the DAO earned in settled batches moves into this Budget's escrow. No tokens leave the hub.",
          rows: [amountRow("Amount", amount)],
          built: dao.fundFromCreditProposal(ctx, m.id, amount),
          confirmLabel: `Propose moving ${money(amount)}`,
        }),
      revoke: () =>
        proposal({
          title: "Propose revoking this Budget",
          description: `Adds a proposal to the DAO that owns this Budget. If its members approve it, the hub stops new settlement after a ${graceAdjective()} grace period. To stop new Calls now, also stop it on this server.`,
          rows: [],
          built: dao.revokeProposal(ctx, m.id),
          confirmLabel: "Propose revoke",
        }),
      reclaim: () =>
        proposal({
          title: "Propose reclaiming escrow",
          description: "Adds a proposal to the DAO that owns this Budget. If its members approve it, the hub returns everything still in escrow to the DAO.",
          rows: [amountRow("Escrow", BigInt(m.escrow ?? "0"))],
          built: dao.reclaimProposal(ctx, m.id),
          confirmLabel: "Propose reclaim",
        }),
    };
  }, [info.data, m.id, m.label, m.owner, m.escrow, t.decimals, t.symbol, viaDao, addon.data, policy.data, member.account, member.ability]);

  const problem = !viaDao
    ? null
    : addon.isError
      ? "The DAO add-on could not load, so proposals cannot be built. Check your connection."
      : policy.isError
        ? daoReadErrorText(policy.error, m.owner)
        : null;
  return {
    plans,
    viaDao,
    problem,
    retry: () => {
      if (addon.isError) void addon.refetch();
      if (policy.isError) void policy.refetch();
    },
  };
}

/** Opens a TxFlow for a plan and refreshes the Budget, and the owner DAO's proposals, once it is final. */
function useFlow(m: Pick<BudgetLike, "id" | "owner">) {
  const qc = useQueryClient();
  const { open, flow } = useTxFlow();
  const refresh = () => {
    refreshBudgetAfterChain(qc, m.id);
    void qc.invalidateQueries({ queryKey: daoKey(m.owner) });
  };
  return { open: (plan: TxPlan) => open(plan, refresh), flow };
}

/**
 * Reads a Budget again once a transaction it started is final: at once, then twice more. The page shows what the hub
 * held when the server answered, and a read at final finality can trail the wallet's answer by a block, so one read
 * is not always enough. The Budgets list follows the server's own periodic read of escrow.
 */
export function refreshBudgetAfterChain(qc: QueryClient, budgetId: string): void {
  const read = () => {
    void qc.invalidateQueries({ queryKey: qk.budget(budgetId) });
    void qc.invalidateQueries({ queryKey: qk.budgets });
  };
  read();
  setTimeout(read, 3_000);
  setTimeout(read, 10_000);
}

/** One line under the owner actions of a DAO-owned Budget when the DAO could not be read, with a way to try again. */
function PlanProblem({ problem, retry }: { problem: string; retry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-negative">
      <span>
        <AccountSentence>{problem}</AccountSentence>
      </span>
      <button type="button" onClick={retry} className="inline-flex items-center gap-1 rounded font-medium underline underline-offset-2 focus-visible:outline-2">
        <RotateCw aria-hidden className="size-3" /> Read again
      </button>
    </p>
  );
}

/** Escrow, the owner's credit, and the owner actions that change them. */
export function EscrowPanel({ m }: { m: BudgetDetail }) {
  const words = useNetworkWords();
  const can = useCan();
  const t = useToken();
  const { plans, viaDao, problem, retry } = useOwnerPlans(m);
  const { open, flow } = useFlow(m);
  const now = useNow();
  const [text, setText] = useState("");
  const short = escrowShortfall(m);
  const credit = BigInt(m.ownerCredit ?? "0");
  const escrow = BigInt(m.escrow ?? "0");
  const active = m.status === "open" || m.status === "pending";
  const parsed = text ? parseAmountInput(text, t.decimals) : null;
  const amount = parsed?.ok ? parsed.atomic : null;
  const creditTooLow = amount !== null && amount > credit;
  const reclaimFrom = reclaimAt({ validUntil: m.budget.validUntil, revokedAt: m.revokedAt });
  const closed = m.status === "revoked" || m.status === "expired" || Number(m.budget.validUntil) <= now;
  const manage = can("agents.manage");
  const help = viaDao
    ? creditTooLow
      ? "More than the DAO's credit; it can still be deposited from the DAO's own balance."
      : "The owner is a DAO, so each of these adds a proposal for its members to approve."
    : creditTooLow
      ? "More than your credit; you can still deposit it from your wallet."
      : "Deposit from your wallet, or move hub credit you already earned.";

  return (
    <Panel title="Escrow" description={words.escrowFull}>
      <Fields>
        <Field label="In escrow" hint="Pays this owner's net debit when a batch settles. Deposits raise escrow, never the cap.">
          {m.escrow == null ? <span className="text-muted-foreground">Not read yet</span> : <Money atomic={m.escrow} />}
        </Field>
        <Field label="Cap" hint="The most this Budget may spend in gross. With offsetting, it can clear more than its escrow.">
          <Money atomic={m.cap} />
        </Field>
        <Field label="Owner credit" hint="Earned in settled batches and withdrawable by the owner, or movable into a Budget.">
          {m.ownerCredit == null ? <span className="text-muted-foreground">Not read yet</span> : <Money atomic={m.ownerCredit} />}
        </Field>
        <Field label="Escrow below cap">
          <Money atomic={short} />
        </Field>
        <Field label="Owner">
          <AccountId value={m.owner} name={viaDao ? "DAO treasury" : undefined} mode="wrap" />
        </Field>
      </Fields>

      {manage && active && (
        <form
          className="mt-4 flex flex-col gap-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (amount && plans) open(plans.deposit(amount));
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="escrow-amount">Amount</Label>
            <div className="relative">
              <Input
                id="escrow-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder={short > 0n ? plainAmount(short, t.decimals) : "0.00"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={parsed !== null && !parsed.ok}
                aria-describedby="escrow-amount-help"
                className="h-11 pr-14 font-mono md:h-9"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{t.symbol}</span>
            </div>
            <p id="escrow-amount-help" className={parsed && !parsed.ok ? "text-xs text-negative" : "text-xs text-muted-foreground"}>
              {parsed && !parsed.ok ? parsed.error : help}
            </p>
            {(short > 0n || credit > 0n) && (
              <div className="flex flex-wrap gap-2" aria-label="Suggested amounts">
                {short > 0n && (
                  <Button type="button" variant="secondary" size="sm" className="h-9 rounded-full sm:h-7" onClick={() => setText(plainAmount(short, t.decimals))}>
                    Up to the cap: {plainAmount(short, t.decimals)} {t.symbol}
                  </Button>
                )}
                {credit > 0n && (
                  <Button type="button" variant="secondary" size="sm" className="h-9 rounded-full sm:h-7" onClick={() => setText(plainAmount(short > 0n && short < credit ? short : credit, t.decimals))}>
                    {short > 0n && short < credit ? "Cap from credit" : "All credit"}: {plainAmount(short > 0n && short < credit ? short : credit, t.decimals)} {t.symbol}
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="submit" disabled={!amount || !plans} className="h-11 rounded-xl sm:h-9 sm:rounded-md">
              {viaDao ? <Vote aria-hidden /> : <ArrowDownToLine aria-hidden />} {viaDao ? "Propose deposit" : "Deposit"}
            </Button>
            <Button type="button" variant="outline" disabled={!amount || !plans || credit === 0n || creditTooLow} onClick={() => amount && plans && open(plans.moveCredit(amount))} className="h-11 rounded-xl sm:h-9 sm:rounded-md">
              <Coins aria-hidden /> {viaDao ? "Propose moving credit" : "Move credit"}
            </Button>
          </div>
          {problem && <PlanProblem problem={problem} retry={retry} />}
        </form>
      )}

      {manage && closed && escrow > 0n && (
        <div className="mt-4 flex flex-col gap-2 border-t pt-4">
          <div className="grid gap-x-2 gap-y-3 sm:grid-cols-2">
            <Button variant="outline" disabled={now < reclaimFrom || !plans} onClick={() => plans && open(plans.reclaim())} className="h-11 rounded-xl sm:h-9 sm:rounded-md">
              {viaDao ? <Vote aria-hidden /> : <Undo2 aria-hidden />} {viaDao ? "Propose reclaim" : "Reclaim escrow"}
            </Button>
            {!viaDao && now >= reclaimFrom && <GaslessButton m={m} action="reclaim" />}
          </div>
          <p className="text-xs text-muted-foreground">
            {now < reclaimFrom
              ? `Available from ${formatDateTime(new Date(reclaimFrom).toISOString())}, after the settlement grace period.`
              : viaDao
                ? "The grace period has ended; the DAO's members can approve returning the remaining escrow to the DAO."
                : "The grace period has ended; the remaining escrow can return to the owner."}
          </p>
          {problem && <PlanProblem problem={problem} retry={retry} />}
        </div>
      )}
      {flow}
    </Panel>
  );
}

/** "Move credit into this Budget", offered on a NET_EXPOSURE Refusal when the owner has hub credit. */
export function MoveCreditAction({ m, shortBy }: { m: BudgetLike; shortBy: bigint | null }) {
  const { plans, viaDao } = useOwnerPlans(m);
  const { open, flow } = useFlow(m);
  const credit = BigInt(m.ownerCredit ?? "0");
  if (!plans || credit === 0n) return null;
  const amount = shortBy && shortBy > 0n && shortBy < credit ? shortBy : credit;
  return (
    <>
      <Button size="sm" variant="outline" className="h-auto min-h-11 max-w-full rounded-xl py-1.5 text-left whitespace-normal sm:min-h-8 sm:rounded-md" onClick={() => open(plans.moveCredit(amount))}>
        <Coins aria-hidden /> {viaDao ? "Propose moving credit into this Budget" : "Move credit into this Budget"}
      </Button>
      {flow}
    </>
  );
}

/**
 * Stops the Budget on chain from the owner's wallet, then tells this server so it refuses new Calls at once. For a DAO
 * owner it adds the revoke as a proposal instead, and the server is left as it is until the DAO has decided.
 */
export function StopBudgetButton({ m }: { m: BudgetLike }) {
  const api = useApi();
  const qc = useQueryClient();
  const { plans, viaDao, problem, retry } = useOwnerPlans(m);
  const { open, flow } = useTxFlow();
  const onFinal = () => {
    if (viaDao) return void qc.invalidateQueries({ queryKey: daoKey(m.owner) });
    void api.revokeBudget(m.id).finally(() => refreshBudgetAfterChain(qc, m.id));
  };
  return (
    <>
      <Button variant="outline" className="h-11 w-full text-negative hover:text-negative sm:h-9 sm:w-auto" disabled={!plans} onClick={() => plans && open(plans.revoke(), onFinal)}>
        {viaDao ? <Vote aria-hidden /> : <Ban aria-hidden />} {viaDao ? "Propose revoke" : "Revoke on NEAR"}
      </Button>
      {problem && <PlanProblem problem={problem} retry={retry} />}
      {flow}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Without gas: the owner's wallet signs a delegate action and the relayer sends it (NEP-366)

const GASLESS = {
  revoke: {
    button: "Revoke without gas",
    title: "Revoke this Budget without gas",
    when: "No NEAR for gas? Your wallet only signs the revoke; the relayer sends it and pays.",
  },
  reclaim: {
    button: "Reclaim without gas",
    title: "Reclaim escrow without gas",
    when: "No NEAR for gas? Your wallet only signs the reclaim; the relayer sends it and pays.",
  },
} as const;
type GaslessAction = keyof typeof GASLESS;

function gaslessPlan(o: { action: GaslessAction; m: BudgetLike; tx: WalletTx; offer: Extract<GaslessOffer, { state: "ready" }>; blocked: string | null; escrow: ReactNode }): TxPlan {
  const { offer, m } = o;
  const budgetRow = { label: "Budget", value: <span className="font-medium">{m.label}</span> };
  const effect = o.action === "revoke" ? revokedOnHub(offer.node.hub, m.id) : reclaimedOnHub(offer.node.hub, m.id);
  const about =
    o.action === "revoke"
      ? `The hub stops new settlement for this Budget after a ${graceAdjective()} grace period, so Payees are paid for Calls already served.`
      : "The hub returns everything still in escrow to your account.";
  return {
    title: GASLESS[o.action].title,
    description: `Your wallet signs this one call and sends nothing. The relayer sends it to NEAR and pays the gas; the hub still sees you as the caller. ${about}`,
    summary: [
      budgetRow,
      ...(o.action === "reclaim" ? [{ label: "Escrow", value: o.escrow }] : []),
      { label: "Deposit", value: "None" },
      { label: "Gas", value: "Paid by the relayer. Your account needs no NEAR." },
    ],
    txs: [o.tx],
    signer: m.owner,
    txHeading: "The call your wallet will sign. The relayer sends it; your wallet sends nothing.",
    gasPayer: <AccountId value={offer.info.relayer} name={offer.client.demo ? "Demo relayer" : "Relayer"} mode="wrap" />,
    confirmLabel: GASLESS[o.action].button,
    blocked: o.blocked ? `${o.blocked} Or close this and use the button beside it, which sends from your own wallet and needs a little NEAR for gas.` : undefined,
    finalNote:
      o.action === "revoke"
        ? `Revoked on chain, and the relayer paid the gas. You can reclaim the remaining escrow once the ${graceAdjective()} grace period ends.`
        : "The hub sent the escrow back to your account, and the relayer paid the gas.",
    run: async ({ progress }) => [await sendGasless({ tx: o.tx, owner: m.owner, node: offer.node, client: offer.client, source: offer.source, effect, what: o.action, progress })],
    // "Check again" reads the Budget on the hub; it never sends anything.
    recheck: (results) => Promise.all(results.map((r) => (r.status === "pending" ? confirmOnHub(offer.source, effect, r.hash, { tries: 3, unknown: r.unknown }) : r))),
  };
}

/**
 * The gasless twin of an owner action, next to the normal one. It is a working button only when a relayer is
 * configured, answers, and sponsors this server's hub and this method; otherwise one line says why not, or how to turn
 * it on. Never offered for a DAO owner (a DAO acts by proposal) or for anything that attaches a deposit.
 */
export function GaslessButton({ m, action }: { m: BudgetLike; action: GaslessAction }) {
  const api = useApi();
  const qc = useQueryClient();
  const info = useInfo();
  const hub = info.data?.hub;
  const tx = useMemo(() => (hub ? (action === "revoke" ? revokeBudgetTx(hub, m.id) : reclaimTx(hub, m.id)) : null), [hub, action, m.id]);
  const offer = useGaslessOffer(tx);
  const { open, flow } = useTxFlow();
  const [opening, setOpening] = useState(false);
  const words = GASLESS[action];

  if (offer.state === "off") {
    return (
      <p className="text-xs text-muted-foreground">
        {words.button} is off, because this dashboard has no relayer. Set <code className="font-mono text-[0.6875rem]">NEXT_PUBLIC_RELAYER_URL</code> to a Payminto relayer for this hub to offer it.
      </p>
    );
  }
  if (offer.state === "unavailable") {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          {words.button} is unavailable. <AccountSentence>{offer.reason}</AccountSentence>
        </span>
        <button type="button" onClick={offer.retry} className="inline-flex items-center gap-1 rounded font-medium text-foreground underline underline-offset-2 focus-visible:outline-2">
          <RotateCw aria-hidden className="size-3" /> Check again
        </button>
      </p>
    );
  }

  async function review() {
    if (offer.state !== "ready" || !tx) return;
    setOpening(true);
    const blocked = delegateUnsupportedText(await delegateSupport());
    setOpening(false);
    open(gaslessPlan({ action, m, tx, offer, blocked, escrow: <Money atomic={m.escrow ?? "0"} /> }), () => {
      const refresh = () => refreshBudgetAfterChain(qc, m.id);
      // A revoke on chain is also told to this server, so it refuses new Calls at once.
      if (action === "revoke") void api.revokeBudget(m.id).finally(refresh);
      else refresh();
    });
  }

  return (
    <>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <Button variant="outline" className="h-11 w-full rounded-xl sm:h-9 sm:w-auto sm:rounded-md" disabled={offer.state !== "ready" || opening} onClick={() => void review()}>
          {offer.state === "checking" || opening ? <Loader2 aria-hidden className="animate-spin" /> : <Fuel aria-hidden />} {words.button}
        </Button>
        <p className="text-xs text-muted-foreground">{offer.state === "checking" ? "Checking the relayer." : words.when}</p>
      </div>
      {flow}
    </>
  );
}
