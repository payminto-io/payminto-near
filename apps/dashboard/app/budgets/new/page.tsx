"use client";

import { RequirePermission } from "@/components/app/states";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Vote, Wallet } from "lucide-react";
import { toast } from "sonner";
import { budgetTermsToJson, toAtomic, type AccountId as NearAccount, type Network } from "@payminto/protocol";
import { useApi } from "@/lib/session";
import { MOCK_MODE } from "@/lib/config";
import { networkIdOf, qk, useInfo, useProviders, useToken } from "@/lib/queries";
import { formatInt, formatMoney } from "@/lib/format";
import { OPEN_BUDGET_STORAGE_YOCTO, agentKeyProblem, buildBudgetTerms, isAgentKey, openBudgetPlan, parseAccountList, type BudgetDraft, type OpenBudget } from "@/lib/sign";
import { ensureConnected, walletErrorMessage } from "@/lib/wallet";
import { bondText, daoAccountError, daoFailureText, innerTx } from "@/lib/dao";
import { daoReadErrorText, useDaoAddon, useDaoMembership, useDaoPolicy } from "@/lib/use-dao";
import { saveDaoDraft } from "@/lib/dao-drafts";
import { useBudgetPayees } from "@/lib/use-payee-check";
import { useWallet } from "@/lib/use-wallet";
import { OwnerChoice, type OwnerKind } from "@/components/app/dao-owner";
import { AllowedPayeesField } from "@/components/app/payee-check";
import { TxFlow, type TxPlan } from "@/components/ds/tx-flow";
import { AccountId } from "@/components/ds/account-id";
import { useNetworkWords } from "@/lib/use-network-words";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Address as AddressView, Field, Fields, Money, PageHeader, Panel } from "@/components/app/primitives";
import { ErrorState } from "@/components/app/states";

const STEPS = ["Owner, agent and Budget", "Rules", "Review and open"] as const;

type Form = {
  ownerKind: OwnerKind;
  dao: string;
  label: string;
  agent: string;
  cap: string;
  deposit: string;
  validDays: string;
  perCallCap: string;
  dailyCap: string;
  maxCallsPerMinute: string;
  purpose: string;
  payees: NearAccount[];
  extraPayees: string;
};

const initial: Form = {
  ownerKind: "self",
  dao: "",
  label: "",
  agent: "",
  cap: "25",
  deposit: "10",
  validDays: "30",
  perCallCap: "0.10",
  dailyCap: "5",
  maxCallsPerMinute: "120",
  purpose: "",
  payees: [],
  extraPayees: "",
};

function amount(v: string, decimals: number): bigint | null {
  try {
    if (!/^\d+(\.\d+)?$/.test(v.trim())) return null;
    return toAtomic(v.trim(), decimals);
  } catch {
    return null;
  }
}

function NewBudgetPagePage() {
  const words = useNetworkWords();
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const info = useInfo();
  const providers = useProviders();
  const token = useToken();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>(initial);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<null | "connecting" | "submitting">(null);
  const [open, setOpen] = useState<{ plan: TxPlan; budget: OpenBudget; policy: BudgetDraft["policy"]; dao: { account: NearAccount; proposer: NearAccount; deposit: bigint } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const network = info.data ? networkIdOf(info.data) : null;
  const viaDao = f.ownerKind === "dao";
  const daoProblem = viaDao && network ? daoAccountError(f.dao, network) : null;
  const daoAccount = viaDao && !daoProblem ? f.dao : null;
  const daoAddon = useDaoAddon(viaDao);
  const daoPolicy = useDaoPolicy(daoAccount);
  const daoMember = useDaoMembership(daoAccount, daoPolicy.data);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const extra = useMemo(() => parseAccountList(f.extraPayees), [f.extraPayees]);
  // Every picked Payee is checked first; only the ones the check cleared or the owner confirmed are in the terms.
  const wallet = useWallet();
  const payeeChecks = useBudgetPayees(f.payees, f.extraPayees, viaDao ? daoAccount : wallet.account);
  const allPayees = payeeChecks.added;

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Form, string>> = {};
    const d = token.decimals;
    if (step === 0) {
      if (daoProblem) e.dao = daoProblem;
      if (!f.label.trim()) e.label = "Give the Budget a name you will recognise.";
      const keyProblem = agentKeyProblem(f.agent);
      if (keyProblem) e.agent = keyProblem;
      const cap = amount(f.cap, d);
      if (!cap || cap <= 0n) e.cap = `Enter a cap in ${token.symbol}, for example 25.`;
      const dep = f.deposit.trim() === "" ? 0n : amount(f.deposit, d);
      if (dep === null) e.deposit = `Enter an amount in ${token.symbol}, or 0 to fund later.`;
      const days = Number(f.validDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) e.validDays = "Between 1 and 365 days.";
    }
    if (step === 1) {
      const cap = amount(f.cap, d) ?? 0n;
      const per = amount(f.perCallCap, d);
      const daily = amount(f.dailyCap, d);
      if (!per || per <= 0n) e.perCallCap = "Enter the largest price one Call may have.";
      else if (per > cap) e.perCallCap = "Cannot exceed the cap.";
      if (!daily || daily <= 0n) e.dailyCap = "Enter a rolling 24 hour limit.";
      else if (daily > cap) e.dailyCap = "Cannot exceed the cap.";
      else if (per && daily < per) e.dailyCap = "Must be at least the limit per Call.";
      const rpm = Number(f.maxCallsPerMinute);
      if (!Number.isInteger(rpm) || rpm < 0) e.maxCallsPerMinute = "A whole number; 0 turns the limit off.";
      if (!f.purpose.trim()) e.purpose = "Payees and auditors see this. Say what the agent is for.";
      if (extra.invalid.length) e.extraPayees = `Not NEAR accounts: ${extra.invalid.slice(0, 3).join(", ")}`;
      if (payeeChecks.waiting.length) e.payees = "A Payee is still being checked.";
      else if (payeeChecks.undecided.length) e.payees = "A Payee is not added yet. Add or remove it to continue.";
    }
    return e;
  }, [f, step, token, extra.invalid, daoProblem, payeeChecks.waiting.length, payeeChecks.undecided.length]);
  const valid = Object.keys(errors).length === 0;

  const draft = (): BudgetDraft => ({
    agentPk: f.agent.trim() as BudgetDraft["agentPk"],
    settler: info.data!.operator,
    cap: amount(f.cap, token.decimals)!,
    validForSeconds: Number(f.validDays) * 86_400,
    payees: allPayees,
    policy: {
      perCallCap: amount(f.perCallCap, token.decimals)!.toString(),
      dailyCap: amount(f.dailyCap, token.decimals)!.toString(),
      maxCallsPerMinute: Number(f.maxCallsPerMinute),
      purpose: f.purpose.trim(),
    },
  });

  /** Connects the owner's wallet, then shows the exact transactions that open and fund the Budget. */
  async function review() {
    if (!info.data) return;
    if (viaDao) return reviewProposal();
    setError(null);
    setBusy("connecting");
    try {
      const owner = await ensureConnected();
      const d = draft();
      const terms = buildBudgetTerms(d, owner);
      const deposit = f.deposit.trim() === "" ? 0n : amount(f.deposit, token.decimals)!;
      const budget = openBudgetPlan({ hub: info.data.hub, token: info.data.token.address, network: info.data.network.id as Network, terms, deposit });
      setOpen({
        budget,
        policy: d.policy,
        dao: null,
        plan: {
          title: "Open this Budget",
          description: deposit > 0n ? "Two transactions with one approval: open the Budget on the hub, then deposit its first escrow." : "One transaction: open the Budget on the hub. Deposit escrow later from the Budget page.",
          summary: [
            { label: "Budget", value: <span className="font-medium">{f.label.trim()}</span> },
            { label: "Cap", value: <Money atomic={terms.cap} /> },
            { label: "First deposit", value: <Money atomic={deposit} /> },
            { label: "Agent key", value: <AccountId value={terms.agentPk} mode="wrap" /> },
          ],
          txs: budget.txs,
          confirmLabel: "Open Budget",
          signer: owner,
          finalNote: "The hub holds the Budget. Your server registers it now and accepts Calls once it reads it on chain.",
        },
      });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * For a DAO owner: connects the member's wallet, then shows the proposals that would open and fund the Budget. The
   * DAO is the owner in the terms, because the hub makes the caller of `open_budget` the owner and the DAO is the one
   * that calls it once its members approve. Proposals are built by the add-on, with the DAO's exact bond.
   */
  async function reviewProposal() {
    if (!info.data || !daoAccount) return;
    setError(null);
    if (daoAddon.isError) return setError("The DAO add-on could not load, so the proposal cannot be built. Check your connection and try again.");
    if (daoPolicy.isError) return setError(daoReadErrorText(daoPolicy.error, daoAccount));
    if (!daoAddon.data || !daoPolicy.data) return setError("Still reading the DAO's policy from NEAR. Try again in a moment.");
    setBusy("connecting");
    try {
      const proposer = await ensureConnected();
      const d = draft();
      const terms = buildBudgetTerms(d, daoAccount);
      const deposit = f.deposit.trim() === "" ? 0n : amount(f.deposit, token.decimals)!;
      const dao = daoAddon.data;
      const bond = daoPolicy.data.proposal_bond;
      const ctx = { dao: daoAccount, hub: info.data.hub, network: networkIdOf(info.data), proposalBond: bond };
      const opening = dao.openBudgetProposal(ctx, terms, OPEN_BUDGET_STORAGE_YOCTO);
      const funding = deposit > 0n ? dao.depositProposal(ctx, info.data.token.address, opening.budgetId, deposit) : null;
      const built = funding ? [opening, funding] : [opening];
      setOpen({
        budget: { id: opening.budgetId, terms, json: budgetTermsToJson(terms), txs: built.map((b) => b.tx) },
        policy: d.policy,
        dao: { account: daoAccount, proposer, deposit },
        plan: {
          title: "Propose this Budget to the DAO",
          description: funding
            ? "Two proposals with one approval: the DAO opens the Budget on the hub, then deposits its first escrow. Nothing happens on the hub until the DAO's members approve them, in this order."
            : "One proposal: the DAO opens the Budget on the hub. Nothing happens on the hub until the DAO's members approve it.",
          summary: [
            { label: "Budget", value: <span className="font-medium">{f.label.trim()}</span> },
            { label: "Owner", value: <AccountId value={daoAccount} name="DAO treasury" mode="wrap" explorer={false} /> },
            { label: "Cap", value: <Money atomic={terms.cap} /> },
            { label: "First deposit", value: <Money atomic={deposit} /> },
            { label: "Agent key", value: <AccountId value={terms.agentPk} mode="wrap" /> },
            { label: "Bond", value: <span>{bondText(bond)} on each proposal, from your wallet, returned by the DAO when it is approved or rejected</span> },
          ],
          txs: built.map((b) => b.tx),
          inner: { heading: funding ? "What the DAO runs if its members approve, in this order" : "What the DAO runs if its members approve", txs: built.map((b) => innerTx(dao, b.proposal.kind)) },
          confirmLabel: "Propose Budget",
          blocked:
            daoMember.ability && !daoMember.ability.canPropose && daoMember.account === proposer
              ? `${proposer} may not add proposals to this DAO. Connect a member's account, or ask a member to propose it.`
              : undefined,
          explainFailure: daoFailureText,
          finalNote: "The proposals are with the DAO. Next, its members approve them; this page takes you to where they do.",
        },
      });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * A Budget proposed to a DAO is not on the hub yet, so the server cannot register it. Its terms and rules are kept
   * in this browser, and the next screen follows the proposals until the hub holds the Budget.
   */
  function follow(o: { budget: OpenBudget; policy: BudgetDraft["policy"]; dao: { account: NearAccount; proposer: NearAccount; deposit: bigint } }) {
    const kept = saveDaoDraft({ id: o.budget.id, dao: o.dao.account, label: f.label.trim(), budget: o.budget.json, policy: o.policy, deposit: o.dao.deposit.toString(), proposedBy: o.dao.proposer, proposedAt: new Date().toISOString() });
    if (!kept) toast.warning("This browser would not keep the proposed Budget", { description: "Keep this tab open until the DAO has approved it, so it can be registered with your server." });
    else toast.success("Proposed to the DAO", { description: "Its members approve it next." });
    router.push(`/budgets/proposed/${o.budget.id}?dao=${o.dao.account}`);
  }

  /** After the hub has the Budget, this server registers it; the server refuses one it cannot find on chain. */
  async function register(o: { budget: OpenBudget; policy: BudgetDraft["policy"] }) {
    setBusy("submitting");
    try {
      const record = await api.createBudget({ budget: o.budget.json, policy: o.policy, label: f.label.trim() });
      await qc.invalidateQueries({ queryKey: qk.budgets });
      toast.success("Budget opened", { description: "Your server accepts Calls under it once it reads it on chain." });
      router.push(`/budgets/${record.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? `The Budget is open on chain, but your server did not register it: ${e.message}` : String(e));
      setBusy(null);
    }
  }

  if (info.isError) return <ErrorState error={info.error} onRetry={() => void info.refetch()} />;

  return (
    <>
      <PageHeader
        back={{ href: "/budgets", label: "Budgets" }}
        title="New budget"
        description="You open the Budget from your NEAR wallet and fund its escrow, or propose it to a DAO whose treasury will own it. The cap limits what the agent may spend; escrow is what is locked to pay for it."
      />
      <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "num flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                i < step ? "bg-positive-soft text-positive" : i === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn(i === step ? "font-medium" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-border sm:w-10" />}
          </li>
        ))}
      </ol>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!valid) return;
              setTouched(false);
              if (step < 2) setStep(step + 1);
              else void review();
            }}
            className="flex flex-col gap-5"
          >
            {step === 0 && (
              <>
                <OwnerChoice kind={f.ownerKind} dao={f.dao} onKind={(k) => set("ownerKind", k)} onDao={(v) => set("dao", v)} error={touched ? errors.dao : undefined} network={network} />
                <TextField required id="label" label="Name" value={f.label} onChange={(v) => set("label", v)} error={touched ? errors.label : undefined} placeholder="Treasury Agent - Q4 research" />
                <TextField required id="agent" label="Agent key" value={f.agent} onChange={(v) => set("agent", v)} error={touched ? errors.agent : undefined} placeholder="ed25519:..." mono hint="The public key from payminto-agent keygen. The agent signs vouchers with it and holds no funds." />
                <div className="grid gap-5 sm:grid-cols-3">
                  <TextField required id="cap" label="Cap" unit={token.symbol} value={f.cap} onChange={(v) => set("cap", v)} error={touched ? errors.cap : undefined} inputMode="decimal" hint="Gross spending limit, enforced on chain." />
                  <TextField optional id="deposit" label="First deposit" unit={token.symbol} value={f.deposit} onChange={(v) => set("deposit", v)} error={touched ? errors.deposit : undefined} inputMode="decimal" hint="Escrow. Add more later; it never raises the cap." />
                  <TextField required id="validDays" label="Valid for" unit="days" value={f.validDays} onChange={(v) => set("validDays", v)} error={touched ? errors.validDays : undefined} inputMode="numeric" />
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="grid gap-5 sm:grid-cols-3">
                  <TextField required id="perCallCap" label="Limit per Call" unit={token.symbol} value={f.perCallCap} onChange={(v) => set("perCallCap", v)} error={touched ? errors.perCallCap : undefined} inputMode="decimal" />
                  <TextField required id="dailyCap" label="Daily limit" unit={token.symbol} value={f.dailyCap} onChange={(v) => set("dailyCap", v)} error={touched ? errors.dailyCap : undefined} inputMode="decimal" />
                  <TextField required id="rpm" label="Calls per minute" unit="per min" value={f.maxCallsPerMinute} onChange={(v) => set("maxCallsPerMinute", v)} error={touched ? errors.maxCallsPerMinute : undefined} inputMode="numeric" />
                </div>
                <TextField required id="purpose" label="Purpose" value={f.purpose} onChange={(v) => set("purpose", v)} error={touched ? errors.purpose : undefined} placeholder="Research agent for the Q4 market report" />
                <AllowedPayeesField
                  providers={providers.data}
                  ticked={f.payees}
                  onTicked={(next) => set("payees", next)}
                  typed={f.extraPayees}
                  onTyped={(text) => set("extraPayees", text)}
                  typedError={touched ? errors.extraPayees : undefined}
                  payees={payeeChecks}
                  error={touched ? errors.payees : undefined}
                />
              </>
            )}
            {step === 2 && (
              <>
                {viaDao ? (
                  <div className="flex items-start gap-3 rounded-xl border bg-rail p-4 text-sm">
                    <Vote aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="font-medium">You propose it from your NEAR wallet</p>
                      <p className="mt-0.5 text-muted-foreground">
                        The DAO becomes the owner once its members approve. Your wallet attaches the DAO&apos;s bond to each proposal
                        {daoPolicy.data ? ` (${bondText(daoPolicy.data.proposal_bond)})` : ""}; the DAO pays the Budget&apos;s storage, about 0.05 NEAR, and the first deposit from its own balance. You see each proposal, and the
                        call inside it, before your wallet asks.
                      </p>
                      <p className="mt-1.5 text-muted-foreground">The validity counts from now, not from the day the DAO approves, so leave room for the vote.</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3 rounded-xl border bg-rail p-4 text-sm">
                    <Wallet aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="font-medium">You open it from your NEAR wallet</p>
                      <p className="mt-0.5 text-muted-foreground">
                        The account you connect becomes the owner. It pays the Budget&apos;s storage, about 0.05 NEAR, and the first deposit. You see both transactions before your wallet asks.
                      </p>
                    </div>
                  </div>
                )}
                {MOCK_MODE && <p className="text-xs text-muted-foreground">Demo data: a demo wallet signs, and nothing reaches a chain.</p>}
                {error && (
                  <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
                    {error}
                  </p>
                )}
              </>
            )}
            {step < 2 && (
              <p className="-mt-2 text-xs text-muted-foreground">
                <span aria-hidden>* </span>Required
              </p>
            )}
            <div className="flex items-center justify-between gap-3 border-t pt-5">
              {step > 0 ? (
                <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} disabled={Boolean(busy)}>
                  Back
                </Button>
              ) : (
                <Button asChild variant="ghost">
                  <Link href="/budgets">Cancel</Link>
                </Button>
              )}
              <Button type="submit" className="h-11 rounded-xl sm:h-9 sm:rounded-md" disabled={Boolean(busy) || !info.data || (step === 1 && payeeChecks.waiting.length > 0)}>
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                {step < 2 ? "Continue" : busy === "connecting" ? "Connecting your wallet" : busy === "submitting" ? "Registering with your server" : viaDao ? "Review and propose" : "Review and open"}
              </Button>
            </div>
          </form>
        </Panel>

        <Panel title="What the owner opens" description="The terms the hub hashes into the Budget id" className="h-fit">
          <Fields className="gap-y-2.5">
            <Field label="Network">{info.data ? info.data.network.name : "-"}</Field>
            <Field label="Hub"><AddressView address={info.data?.hub} showName={false} /></Field>
            <Field label="Owner">{viaDao ? daoAccount ? <AccountId value={daoAccount} name="DAO treasury" mode="wrap" /> : <span className="text-subtle">DAO not set</span> : "The wallet you connect"}</Field>
            <Field label="Agent">{isAgentKey(f.agent.trim()) ? <AddressView address={f.agent.trim()} showName={false} explorer={false} /> : <span className="text-subtle">Not set</span>}</Field>
            <Field label="Cap">{amount(f.cap, token.decimals) ? <Money atomic={amount(f.cap, token.decimals)!} /> : "-"}</Field>
            <Field label="First deposit">{f.deposit.trim() === "" ? <Money atomic="0" /> : amount(f.deposit, token.decimals) !== null ? <Money atomic={amount(f.deposit, token.decimals)!} /> : "-"}</Field>
            <Field label="Per Call">{amount(f.perCallCap, token.decimals) ? <Money atomic={amount(f.perCallCap, token.decimals)!} /> : "-"}</Field>
            <Field label="Daily">{amount(f.dailyCap, token.decimals) ? <Money atomic={amount(f.dailyCap, token.decimals)!} /> : "-"}</Field>
            <Field label="Rate">{f.maxCallsPerMinute === "0" ? "No limit" : `${formatInt(Number(f.maxCallsPerMinute) || 0)} Calls per minute`}</Field>
            <Field label="Expires">{Number(f.validDays) > 0 ? `in ${f.validDays} days` : "-"}</Field>
            <Field label="Payees">{allPayees.length === 0 ? "Any Payee" : `${allPayees.length} allowed`}</Field>
          </Fields>
          <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
            The cap, validity and Payees are enforced by the hub on chain. The limit per Call, daily limit and rate limit are enforced by this server and committed on chain as a policy hash, so the
            agreed rules are provable. {words.escrowFull} Gross spending never exceeds{" "}
            {amount(f.cap, token.decimals) ? `${formatMoney(amount(f.cap, token.decimals)!, token.decimals)} ${token.symbol}` : "the cap"}, and money only leaves escrow for your net debit at settlement.
          </p>
        </Panel>
      </div>
      {open && (
        <TxFlow
          plan={open.plan}
          open
          onOpenChange={(o) => {
            if (!o && busy !== "submitting") setOpen(null);
          }}
          onFinal={() => (open.dao ? follow({ ...open, dao: open.dao }) : void register(open))}
        />
      )}
    </>
  );
}

function TextField({
  id,
  required = false,
  optional = false,
  label,
  value,
  onChange,
  error,
  hint,
  unit,
  mono,
  placeholder,
  inputMode,
  type = "text",
}: {
  id: string;
  /** Marked in the label and announced as required, before anyone presses Continue. */
  required?: boolean;
  /** Marked "optional" in the label, for the one field that may stay empty. */
  optional?: boolean;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  unit?: string;
  mono?: boolean;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
  type?: string;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="font-normal text-muted-foreground">
            <span aria-hidden> *</span>
            <span className="sr-only"> (required)</span>
          </span>
        )}
        {optional && <span className="font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-required={required || undefined}
          aria-describedby={describedBy}
          placeholder={placeholder}
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          className={cn(mono && "hash", unit && "num pr-16")}
        />
        {unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-negative">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export default function NewBudgetPage() {
  return (
    <RequirePermission permission={"agents.manage"}>
      <NewBudgetPagePage />
    </RequirePermission>
  );
}
