"use client";

import { useId, useState } from "react";
import { Loader2, RotateCw, Wallet } from "lucide-react";
import type { Network } from "@payminto/protocol";
import { approvalsNeeded, bondText, daoFactory, isDaoAccount } from "@/lib/dao";
import { daoReadErrorText, useDaoMembership, useDaoPolicy } from "@/lib/use-dao";
import { useWallet } from "@/lib/use-wallet";
import { isWalletRejection, walletErrorMessage } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountSentence } from "@/components/ds/account-id";
import { abilityText } from "./dao-proposals";

export type OwnerKind = "self" | "dao";

/**
 * Who will own a new Budget: the account that connects, or a Sputnik DAO the person is a member of. Choosing a DAO
 * reads its policy at once and says, before anything is filled in, whether the connected account may propose there
 * and what bond each proposal carries.
 */
export function OwnerChoice({ kind, dao, onKind, onDao, error, network }: { kind: OwnerKind; dao: string; onKind: (k: OwnerKind) => void; onDao: (v: string) => void; error?: string; network: Network | null }) {
  const name = useId();
  const factory = network ? daoFactory(network) : null;
  const daoOff = network !== null && !factory;
  const options: Array<{ value: OwnerKind; title: string; body: string; disabled?: boolean }> = [
    { value: "self", title: "Owner: my account", body: "The wallet you connect opens the Budget and becomes its owner." },
    {
      value: "dao",
      title: "Owner: a DAO I am a member of",
      body: daoOff ? "Not available on this network: it has no Sputnik DAO factory." : "You propose the Budget, the DAO's members approve it, and the DAO's treasury owns and funds it.",
      disabled: daoOff,
    },
  ];
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">Owner</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-sm transition-colors duration-150 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              kind === o.value ? "border-primary bg-info-soft" : "hover:bg-muted/40",
              o.disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <input type="radio" name={name} value={o.value} checked={kind === o.value} disabled={o.disabled} onChange={() => onKind(o.value)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
            <span className="min-w-0">
              <span className="block font-medium">{o.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{o.body}</span>
            </span>
          </label>
        ))}
      </div>
      {kind === "dao" && factory && network && (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="dao-account">
            DAO account
            <span className="font-normal text-muted-foreground">
              <span aria-hidden> *</span>
              <span className="sr-only"> (required)</span>
            </span>
          </Label>
          <Input
            id="dao-account"
            value={dao}
            onChange={(e) => onDao(e.target.value.trim().toLowerCase())}
            placeholder={`my-team.${factory}`}
            aria-invalid={Boolean(error)}
            aria-required
            aria-describedby="dao-account-status"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="hash"
          />
          <div id="dao-account-status" className="text-xs">
            {error ? <p className="text-negative">{error}</p> : isDaoAccount(dao, network) ? <DaoOwnerStatus dao={dao} /> : <p className="text-muted-foreground">Sputnik DAO v2. On this network a DAO is named like my-team.{factory}.</p>}
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** What the DAO's policy says about proposing a Budget: the bond, the approvals needed, and whether this account may propose. */
function DaoOwnerStatus({ dao }: { dao: string }) {
  const policy = useDaoPolicy(dao);
  const { account, ability } = useDaoMembership(dao, policy.data);
  const wallet = useWallet();
  const [connectError, setConnectError] = useState<string | null>(null);
  if (policy.isPending) {
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 aria-hidden className="size-3 animate-spin" /> Reading the DAO&apos;s policy from NEAR.
      </p>
    );
  }
  if (policy.isError) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-negative">
        <span>
          <AccountSentence>{daoReadErrorText(policy.error, dao)}</AccountSentence>
        </span>
        <button type="button" onClick={() => void policy.refetch()} className="inline-flex items-center gap-1 rounded font-medium underline underline-offset-2 focus-visible:outline-2">
          <RotateCw aria-hidden className="size-3" /> Read again
        </button>
      </p>
    );
  }
  const needed = approvalsNeeded(policy.data);
  const blocked = account !== null && ability !== null && !ability.canPropose;
  return (
    <div className="flex flex-col items-start gap-1.5 text-muted-foreground">
      <p>
        Each proposal carries a bond of {bondText(policy.data.proposal_bond)} from your wallet, which the DAO returns when the proposal is approved or rejected.
        {needed.map((n) => ` ${n.needed} of ${n.of} ${n.role} approvals run a proposal.`).join("")}
      </p>
      <p className={cn(blocked && "text-negative")}>
        <AccountSentence>{abilityText(account, ability)}</AccountSentence>
      </p>
      {!account && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 rounded-xl sm:h-8 sm:rounded-md"
            disabled={wallet.status === "connecting" || wallet.status === "restoring"}
            onClick={() => {
              setConnectError(null);
              wallet.connect().catch((e: unknown) => setConnectError(isWalletRejection(e) ? null : walletErrorMessage(e)));
            }}
          >
            {wallet.status === "connecting" ? <Loader2 aria-hidden className="animate-spin" /> : <Wallet aria-hidden />} Connect wallet to check
          </Button>
          {connectError && (
            <p role="alert" className="text-negative">
              {connectError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
