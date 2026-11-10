"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, FileQuestion, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { isId32 } from "@payminto/protocol";
import { useApi, useCan } from "@/lib/session";
import { networkIdOf, qk, useBudgets, useInfo } from "@/lib/queries";
import { isDaoAccount } from "@/lib/dao";
import { removeDaoDraft, useDaoDrafts, type DaoBudgetDraft } from "@/lib/dao-drafts";
import { readErrorText } from "@/lib/near-reader";
import { formatDateTime } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-title";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BlockSkeleton, EmptyState, RequirePermission } from "@/components/app/states";
import { Chip } from "@/components/app/status";
import { DaoProposalsPanel } from "@/components/app/dao-proposals";
import { AccountId } from "@/components/ds/account-id";
import { TxFlowProvider } from "@/components/ds/tx-flow";

const BACK = { href: "/budgets", label: "Budgets" };

/**
 * A Budget proposed to a DAO, between "proposed" and "open on the hub". The DAO's members approve it here (or in any
 * Sputnik DAO interface); this page reads the hub until it holds the Budget, then registers it with the server from
 * the terms and rules kept in this browser, and moves on to the Budget's own page.
 */
function ProposedBudgetPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const api = useApi();
  const qc = useQueryClient();
  const can = useCan();
  const info = useInfo();
  const budgets = useBudgets();
  const drafts = useDaoDrafts();
  const draft = drafts.find((d) => d.id === id) ?? null;
  const network = info.data ? networkIdOf(info.data) : null;
  const linkedDao = params.get("dao");
  const dao = draft?.dao ?? (linkedDao && network && isDaoAccount(linkedDao, network) ? linkedDao : null);
  const registered = budgets.data?.find((b) => b.id === id) ?? null;
  useDocumentTitle(draft?.label ?? "Proposed Budget");

  const source = useMemo(() => (info.data ? api.nearReader(info.data) : null), [api, info.data]);
  const hub = info.data?.hub ?? null;
  const onHub = useQuery({
    queryKey: ["hub-budget", id, hub, source?.reader.rpcUrl ?? "none"],
    enabled: Boolean(source && hub && isId32(id) && dao),
    queryFn: async () => (await source!.reader.view<unknown>(hub!, "budget", { budget_id: id })).value !== null,
    // Keep reading until the hub holds it; an approval elsewhere shows up here without a reload.
    refetchInterval: (q) => (q.state.data === true ? false : 6000),
    retry: false,
  });
  const open = onHub.data === true;

  const register = useMutation({
    mutationFn: (d: DaoBudgetDraft) => api.createBudget({ budget: d.budget, policy: d.policy, label: d.label }),
    onSuccess: async () => {
      // The draft stays until the person leaves this page, so the steps below can show how it ended.
      await qc.invalidateQueries({ queryKey: qk.budgets });
      toast.success("Budget opened by the DAO", { description: "Your server registered it and accepts Calls under it." });
    },
  });
  const manage = can("agents.manage");
  const started = useRef(false);
  const { mutate } = register;
  useEffect(() => {
    // Once the hub holds the Budget, register it without another click. A failure leaves a button to try again.
    if (open && draft && manage && !registered && !started.current) {
      started.current = true;
      mutate(draft);
    }
  }, [open, draft, manage, registered, mutate]);
  // Once the server holds the Budget it is active. The kept draft is cleared by the Budgets list, not here, so this
  // page can still show the terms and how each step ended.
  const active = Boolean(registered);

  if (info.isPending || budgets.isPending) {
    return (
      <>
        <PageHeader back={BACK} title={<span className="inline-block h-8 w-72 max-w-full animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-40" />
      </>
    );
  }
  if (!isId32(id) || !dao) {
    return (
      <>
        <PageHeader back={BACK} title="Proposed Budget" />
        <Panel>
          <EmptyState
            icon={<FileQuestion className="size-4" />}
            title="This browser has no proposed Budget with that id"
            action={
              <Button asChild>
                <Link href="/budgets">Back to Budgets</Link>
              </Button>
            }
          >
            A Budget proposed to a DAO is kept in the browser that proposed it until the DAO approves. Open this page there, or use a link that names the DAO to read its proposals and vote.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const steps: Array<{ title: string; body: React.ReactNode; state: "done" | "now" | "later" }> = [
    {
      title: "The DAO's members approve opening the Budget",
      body: open || active ? "The hub holds the Budget, with the DAO as its owner." : "Under Proposals below. The approval that reaches the DAO's threshold opens the Budget on the hub in the same transaction.",
      state: open || active ? "done" : "now",
    },
    {
      title: "Your server registers it",
      body: active
        ? "Registered. The Budget is active and your server accepts Calls under it."
        : !open
        ? "Automatic, from this page, as soon as the hub holds the Budget. The server only registers a Budget it can read on chain."
        : !draft
          ? "This browser did not propose the Budget, so it does not hold its rules; only their hash is on chain. Open this page in the browser that proposed it and it registers there."
          : !manage
            ? "Your role cannot register Budgets. Ask someone who manages agents to open this page."
            : register.isError
              ? register.error instanceof ApiError
                ? `The server did not register it: ${register.error.message}`
                : "The server did not register it."
              : "Registering with your server now.",
      state: active ? "done" : open ? "now" : "later",
    },
  ];
  if (draft && BigInt(draft.deposit) > 0n) {
    steps.push({
      title: "The members approve the first deposit",
      body: (
        <>
          <Money atomic={draft.deposit} /> from the DAO&apos;s own balance into escrow. It shows on the Budget&apos;s page, and can be approved before or after the server registers the Budget.
        </>
      ),
      state: "later",
    });
  }

  return (
    <TxFlowProvider>
      <PageHeader
        back={BACK}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {draft?.label ?? registered?.label ?? "Proposed Budget"} <Chip tone={open || active ? "positive" : "warning"}>{active ? "Active" : open ? "Open on the hub" : "Waiting for the DAO"}</Chip>
          </span>
        }
        description={draft?.policy.purpose ?? registered?.policy.purpose ?? "A Budget proposed to a DAO. Its members approve it here."}
        actions={
          active && (
            <Button asChild>
              <Link href={`/budgets/${id}`}>
                Open the Budget <ArrowRight aria-hidden />
              </Link>
            </Button>
          )
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="What happens next" description="Nothing is spendable until the hub holds the Budget" bodyClassName="p-0 sm:p-0">
            <ol className="divide-y">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-3 px-4 py-3.5 sm:px-5">
                  <span
                    aria-hidden
                    className={cn(
                      "num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      s.state === "done" ? "bg-positive-soft text-positive" : s.state === "now" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {s.state === "done" ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {s.title}
                      <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "now" ? " (current step)" : ""}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{s.body}</p>
                    {i === 1 && open && !active && draft && manage && (register.isPending || register.isError) && (
                      <Button variant="outline" size="sm" className="mt-2 h-11 rounded-xl sm:h-8 sm:rounded-md" disabled={register.isPending} onClick={() => register.mutate(draft)}>
                        {register.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />} {register.isPending ? "Registering" : "Register again"}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {onHub.isError && (
              <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
                <span>The hub could not be read, so this page does not know yet whether the Budget is open. {readErrorText(onHub.error)}</span>
                <button type="button" onClick={() => void onHub.refetch()} className="inline-flex items-center gap-1 rounded font-medium text-foreground underline underline-offset-2 focus-visible:outline-2">
                  <RotateCw aria-hidden className="size-3" /> Read again
                </button>
              </p>
            )}
          </Panel>
          <DaoProposalsPanel dao={dao} budgetId={id} />
        </div>

        <Panel title="Proposed terms" description={draft ? "As written into the proposal; the hub hashes them into the Budget id" : "Kept only in the browser that proposed it"} className="h-fit">
          <Fields>
            <Field label="Owner">
              <AccountId value={dao} name="DAO treasury" mode="wrap" />
            </Field>
            <Field label="Budget id">
              <Hash value={id} />
            </Field>
            {draft && (
              <>
                <Field label="Agent key">
                  <AccountId value={draft.budget.agentPk} mode="wrap" />
                </Field>
                <Field label="Cap">
                  <Money atomic={draft.budget.cap} />
                </Field>
                <Field label="First deposit">
                  <Money atomic={draft.deposit} />
                </Field>
                <Field label="Valid until">{formatDateTime(new Date(Number(draft.budget.validUntil)).toISOString())}</Field>
                <Field label="Proposed by">
                  <AccountId value={draft.proposedBy} mode="wrap" />
                </Field>
                <Field label="Proposed">{formatDateTime(draft.proposedAt)}</Field>
              </>
            )}
          </Fields>
          {active ? (
            <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">The Budget is registered with your server. Deposits, the revoke and the reclaim are proposed from its own page.</p>
          ) : draft ? (
            <div className="mt-4 flex flex-col items-start gap-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                The rules and the name are kept in this browser until the server registers the Budget. If the DAO rejects the proposal, or you no longer want it, stop following it here; the proposal itself stays on the DAO.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-11 rounded-xl sm:h-8 sm:rounded-md"
                disabled={register.isPending}
                onClick={() => {
                  removeDaoDraft(id);
                  toast.success("No longer following this proposed Budget");
                  router.push("/budgets");
                }}
              >
                Stop following
              </Button>
            </div>
          ) : (
            <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">You can read the proposals and vote from here. The Budget&apos;s rules are held by the browser that proposed it, which also registers it with the server.</p>
          )}
        </Panel>
      </div>
    </TxFlowProvider>
  );
}

export default function ProposedBudget() {
  return (
    <RequirePermission permission={"agents.read"}>
      <ProposedBudgetPage />
    </RequirePermission>
  );
}
