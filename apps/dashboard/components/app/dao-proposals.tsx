"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, RotateCw, ShieldQuestion, Users, Vote, Wallet, X } from "lucide-react";
import type { AccountId as NearAccount, Id32 } from "@payminto/protocol";
import { MOCK_MODE } from "@/lib/config";
import { networkIdOf, qk, useInfo, useToken } from "@/lib/queries";
import { approvalsNeeded, budgetProposals, daoFailureText, innerTx, voteOptions, type DaoAbility, type ProposalState, type ProposalView } from "@/lib/dao";
import { PROPOSAL_PAGE, daoKey, daoReadErrorText, useDaoAddon, useDaoMembership, useDaoPolicy, useDaoProposals } from "@/lib/use-dao";
import { useWallet } from "@/lib/use-wallet";
import { walletErrorMessage, isWalletRejection } from "@/lib/wallet";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AccountId, AccountSentence, AccountText } from "@/components/ds/account-id";
import { useTxFlow } from "@/components/ds/tx-flow";
import { Chip } from "./status";
import { EmptyState, RowsSkeleton } from "./states";
import { Panel } from "./primitives";
import { TimeAgo, useNow } from "./time-ago";

const STATE: Record<ProposalState, { tone: "positive" | "warning" | "negative" | "neutral"; label: string }> = {
  pending: { tone: "warning", label: "Waiting for votes" },
  voting_closed: { tone: "neutral", label: "Voting closed" },
  approved: { tone: "positive", label: "Approved" },
  rejected: { tone: "negative", label: "Rejected" },
  failed: { tone: "negative", label: "Approved, call failed" },
  expired: { tone: "neutral", label: "Expired" },
  removed: { tone: "neutral", label: "Removed" },
};

/** What the connected account may do in this DAO, in one plain sentence. */
export function abilityText(account: NearAccount | null, a: DaoAbility | null): string {
  if (!account) return "Connect a wallet to see whether your account may propose or vote in this DAO.";
  if (!a) return "Reading the DAO's policy.";
  const maybe = a.uncertain ? " Roles that depend on staked tokens were not checked." : "";
  const canVote = a.canApprove || a.canReject;
  if (a.canPropose && canVote) return `${account} can propose and vote in this DAO.${maybe}`;
  if (a.canPropose) return `${account} can propose in this DAO, but cannot vote. A member with a vote must approve.${maybe}`;
  if (canVote) return `${account} can vote in this DAO, but cannot add proposals.${maybe}`;
  return `${account} cannot propose or vote in this DAO. Connect a member's account to act, or ask a member.${maybe}`;
}

/**
 * The owner DAO's proposals that concern one Budget: each decoded into plain words, with the votes so far, and Approve
 * and Reject for a member who may vote. A call the add-on's audit does not recognize is shown as such and can never be
 * approved from here.
 */
export function DaoProposalsPanel({ dao, budgetId, className }: { dao: NearAccount; budgetId: Id32; className?: string }) {
  const info = useInfo();
  const t = useToken();
  const now = useNow();
  const qc = useQueryClient();
  const addon = useDaoAddon();
  const policy = useDaoPolicy(dao);
  const proposals = useDaoProposals(dao);
  const { account, ability } = useDaoMembership(dao, policy.data);
  const wallet = useWallet();
  const { open: openFlow, flow } = useTxFlow();
  const [connectError, setConnectError] = useState<string | null>(null);

  // Voting periods are days long, so a minute's resolution is plenty and keeps the list from re-sorting every second.
  const minute = Math.floor(now / 60_000) * 60_000;
  const views = useMemo(() => {
    if (!addon.data || !policy.data || !proposals.data || !info.data) return null;
    const c = { hub: info.data.hub, token: info.data.token.address, network: networkIdOf(info.data), dao, budgetId, symbol: t.symbol, decimals: t.decimals };
    return budgetProposals(addon.data, proposals.data.proposals, policy.data, c, account, minute);
  }, [addon.data, policy.data, proposals.data, info.data, dao, budgetId, t.symbol, t.decimals, account, minute]);
  const needed = useMemo(() => (policy.data ? approvalsNeeded(policy.data) : []), [policy.data]);

  const error = addon.isError ? "The DAO add-on could not load, so proposals cannot be decoded. Check your connection." : policy.isError ? daoReadErrorText(policy.error, dao) : proposals.isError ? daoReadErrorText(proposals.error, dao) : null;
  const retry = () => {
    if (addon.isError) void addon.refetch();
    if (policy.isError) void policy.refetch();
    if (proposals.isError) void proposals.refetch();
  };

  function vote(v: ProposalView, action: "VoteApprove" | "VoteReject") {
    if (!addon.data || !v.meaning.kind) return;
    const approve = action === "VoteApprove";
    const kind = v.meaning.kind;
    const what = v.meaning.recognized ? v.meaning.text : "Unrecognized call";
    const allowed = approve ? ability?.canApprove : ability?.canReject;
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: daoKey(dao) });
      void qc.invalidateQueries({ queryKey: qk.budgets });
    };
    openFlow({
      title: approve ? "Approve this proposal" : "Reject this proposal",
      description: approve
        ? "Your approval is recorded on the DAO. If it is the one that reaches the threshold, the DAO runs the call below in the same transaction."
        : "Your rejection is recorded on the DAO. If enough members reject, the proposal is closed and nothing runs.",
      summary: [
        { label: "Proposal", value: <span className="font-medium">{`#${v.id} ${what}`}</span> },
        { label: "DAO", value: <AccountId value={dao} mode="wrap" explorer={false} /> },
        { label: "Votes so far", value: <span className="num">{`${v.approvals.length} to approve, ${v.rejections.length} to reject`}</span> },
      ],
      txs: [addon.data.voteTx(dao, v.id, kind, action)],
      inner: { heading: approve ? "What the DAO runs once enough members approve" : "The call this proposal would have run", txs: [innerTx(addon.data, kind)] },
      confirmLabel: approve ? "Approve proposal" : "Reject proposal",
      finalNote: "Your vote is recorded on the DAO. This page now reads the proposal again to show where it stands.",
      blocked: account && ability && !allowed ? `${account} may not ${approve ? "approve" : "reject"} proposals in this DAO. Connect a member's account to vote.` : undefined,
      explainFailure: daoFailureText,
    }, refresh);
  }

  return (
    <Panel
      className={className}
      title="Proposals"
      description="The owner is a DAO, so each owner action waits here for its members. Standard Sputnik DAO proposals, read from NEAR."
      bodyClassName="p-0 sm:p-0"
    >
      <div className="flex flex-col gap-2 border-b px-4 py-3 text-sm sm:px-5">
        <p className="flex items-start gap-2 text-muted-foreground">
          <Users aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            <AccountSentence>{abilityText(account, ability)}</AccountSentence>
            {needed.map((n) => (
              <span key={n.role}>{` ${n.needed} of ${n.of} ${n.role} approvals run a proposal.`}</span>
            ))}
          </span>
        </p>
        {!account && (
          <div className="flex flex-col items-start gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-11 rounded-xl sm:h-8 sm:rounded-md"
              disabled={wallet.status === "connecting" || wallet.status === "restoring"}
              onClick={() => {
                setConnectError(null);
                wallet.connect().catch((e: unknown) => setConnectError(isWalletRejection(e) ? null : walletErrorMessage(e)));
              }}
            >
              {wallet.status === "connecting" ? <Loader2 aria-hidden className="animate-spin" /> : <Wallet aria-hidden />} Connect wallet
            </Button>
            {connectError && (
              <p role="alert" className="text-xs text-negative">
                {connectError}
              </p>
            )}
          </div>
        )}
        {MOCK_MODE && <DemoMemberSwitch dao={dao} />}
      </div>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3 px-4 py-5 text-sm sm:flex-row sm:items-center sm:px-5">
          <p className="min-w-0 flex-1 text-muted-foreground">
            <span className="font-medium text-foreground">The proposals could not be read.</span> <AccountSentence>{error}</AccountSentence>
          </p>
          <Button variant="outline" size="sm" className="h-11 rounded-xl sm:h-8 sm:rounded-md" onClick={retry}>
            <RotateCw aria-hidden /> Read again
          </Button>
        </div>
      ) : !views ? (
        <RowsSkeleton className="px-4 sm:px-5" rows={3} />
      ) : views.length === 0 ? (
        <EmptyState className="py-8" icon={<Vote className="size-4" />} title="No proposals for this Budget">
          Owner actions you propose, such as a deposit or a revoke, appear here for the DAO&apos;s members to approve.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {views.map((v) => (
            <ProposalRow key={v.id} v={v} ability={ability} needed={needed[0] ?? null} onVote={vote} />
          ))}
        </ul>
      )}
      {proposals.data && proposals.data.total > PROPOSAL_PAGE && (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">Only the DAO&apos;s newest {PROPOSAL_PAGE} proposals are read. Older ones are on the DAO itself.</p>
      )}
      {flow}
    </Panel>
  );
}

function Voters({ label, accounts }: { label: string; accounts: string[] }) {
  if (accounts.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="shrink-0">{label}</span>
      {accounts.map((a, i) => (
        <span key={a} className="inline-flex min-w-0 max-w-full items-center">
          <AccountText value={a} className="text-xs text-foreground" />
          {i < accounts.length - 1 && <span aria-hidden>,</span>}
        </span>
      ))}
    </span>
  );
}

function ProposalRow({ v, ability, needed, onVote }: { v: ProposalView; ability: DaoAbility | null; needed: { needed: number; of: number; role: string } | null; onVote: (v: ProposalView, action: "VoteApprove" | "VoteReject") => void }) {
  const s = STATE[v.state];
  const options = ability ? voteOptions(v, ability) : { approve: false, reject: false, why: null };
  const closes = formatDateTime(new Date(v.closesAtMs).toISOString());
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-56">
          {v.meaning.recognized ? (
            <p className="text-sm font-medium text-pretty">{v.meaning.text}</p>
          ) : (
            <p className="flex items-start gap-1.5 text-sm font-medium">
              <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-negative" />
              Unrecognized call, review on chain
            </p>
          )}
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="num shrink-0">#{v.id}</span>
            <span className="shrink-0">proposed by</span>
            <AccountText value={v.proposer} className="text-xs" />
            <TimeAgo iso={new Date(v.submittedAtMs).toISOString()} className="shrink-0" />
          </p>
        </div>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>

      {!v.meaning.recognized && (
        <div className="rounded-lg border bg-rail px-3 py-2 text-xs text-muted-foreground">
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="shrink-0">Calls</span>
            {v.meaning.method ? <code className="font-mono text-foreground">{v.meaning.method}</code> : <span>an unreadable method</span>}
            <span className="shrink-0">on</span>
            <AccountId value={v.meaning.receiver} idClassName="text-xs" />
          </p>
          <p className="mt-1">This is not one of the Budget actions Payminto builds, so it cannot be approved from this page. Read the full proposal on the DAO before anyone approves it.</p>
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        <span className="num">
          {v.approvals.length} {v.approvals.length === 1 ? "approval" : "approvals"}
          {needed && v.state === "pending" ? ` of ${needed.needed} needed` : ""}, {v.rejections.length} {v.rejections.length === 1 ? "rejection" : "rejections"}
        </span>
        <Voters label="Approved by" accounts={v.approvals} />
        <Voters label="Rejected by" accounts={v.rejections} />
        {v.state === "pending" && <span>Voting closes {closes}.</span>}
        {v.state === "voting_closed" && <span>Voting closed {closes} without enough votes, so this can no longer pass. Propose it again if it is still wanted.</span>}
        {v.state === "failed" && <span>The DAO approved this and the call then failed on its target. Nothing changed for this Budget. Propose it again once the cause is fixed.</span>}
        {v.state === "pending" && v.myVote && <span className="text-foreground">You voted to {v.myVote.toLowerCase()} this proposal. It needs other members now.</span>}
        {v.state === "pending" && !v.myVote && options.why && <span>{options.why}</span>}
      </div>

      {(options.approve || options.reject) && (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-start">
          {options.approve && (
            <Button size="sm" className="h-11 rounded-xl sm:h-8 sm:rounded-md" onClick={() => onVote(v, "VoteApprove")}>
              <Check aria-hidden /> Approve
            </Button>
          )}
          {options.reject && (
            <Button size="sm" variant="outline" className={cn("h-11 rounded-xl sm:h-8 sm:rounded-md", !options.approve && "col-span-2")} onClick={() => onVote(v, "VoteReject")}>
              <X aria-hidden /> Reject
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Mock mode only: lets the demo wallet act as another member, so a second approval, or an account with no vote, can be
 * played without a second browser. It changes nothing but which demo account signs.
 */
function DemoMemberSwitch({ dao }: { dao: NearAccount }) {
  const { account } = useWallet();
  const [members, setMembers] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void import("@/lib/mock/dao").then((m) => {
      if (live && dao === m.DEMO_DAO) setMembers([...m.DEMO_DAO_COUNCIL, m.DEMO_OUTSIDER]);
    });
    return () => {
      live = false;
    };
  }, [dao]);
  if (members.length === 0) return null;
  return (
    <label className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <span className="shrink-0">Demo only. The demo wallet acts as</span>
      <select
        className="h-11 w-full min-w-0 rounded-md border bg-background px-2 font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-7 sm:w-auto"
        value={account ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          if (next) void import("@/lib/mock/install-wallet").then((m) => m.demoWallet()?.switchAccount(next));
        }}
      >
        {!account && <option value="">not connected</option>}
        {members.map((m, i) => (
          <option key={m} value={m}>
            {m}
            {i === members.length - 1 ? " (not a member)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
