"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import type { AccountId } from "@payminto/protocol";
import type { LocalAccount, PickRequest } from "@/lib/wallet-local";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const YOCTO_PER_NEAR = 10n ** 24n;

/** Whole NEAR with two decimals, enough to see that an account can pay for gas. */
export function nearText(yocto: string): string {
  const v = BigInt(yocto);
  const cents = (v * 100n) / YOCTO_PER_NEAR;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")} NEAR`;
}

/**
 * The account picker of `pnpm local`, shown in place of a wallet's own window. DEVELOPMENT ONLY: the accounts live on a
 * NEAR node on this machine, and a local signer signs for them. It is never loaded on testnet or mainnet.
 * Below 640px it is a bottom sheet, like every other decision in this dashboard.
 */
export function LocalAccountPicker({ accounts, expected, current, onPick }: PickRequest & { onPick: (account: AccountId | null) => void }) {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState(false);
  // The account the screen needs comes first, so it is the first thing a person reaches.
  const ordered = expected ? [...accounts].sort((a, b) => Number(b.accountId === expected) - Number(a.accountId === expected)) : accounts;

  function choose(account: AccountId | null) {
    if (picked) return;
    setPicked(true);
    setOpen(false);
    onPick(account);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && choose(null)}>
      <DialogContent sheetOnMobile className="gap-0 p-0 sm:max-w-lg max-sm:p-0">
        <DialogHeader className="border-b px-4 py-4 text-left sm:px-6">
          <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-[0.9375rem] leading-[1.375rem]">
            Local test accounts
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
              <FlaskConical aria-hidden className="size-3" /> Development only
            </span>
          </DialogTitle>
          <DialogDescription className="text-[0.8125rem]">
            {expected ? (
              <>
                This step must be signed by <span className="font-mono text-foreground">{expected}</span>. Choose it to continue.
              </>
            ) : (
              "Choose the account that signs. This takes the place of your wallet's own window."
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60dvh] divide-y overflow-y-auto" aria-label="Local test accounts">
          {ordered.map((a) => (
            <li key={a.accountId}>
              <AccountRow account={a} needed={a.accountId === expected} isCurrent={a.accountId === current} dimmed={Boolean(expected) && a.accountId !== expected} onChoose={() => choose(a.accountId)} />
            </li>
          ))}
        </ul>
        <p className="border-t bg-rail px-4 py-3 text-xs text-muted-foreground sm:px-6 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          These accounts exist only on the NEAR node on this machine, and their USDC is a mock token. A local signer signs for them and refuses every other network. On testnet or mainnet you sign with your own NEAR wallet.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account, needed, isCurrent, dimmed, onChoose }: { account: LocalAccount; needed: boolean; isCurrent: boolean; dimmed: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 px-4 py-3 text-left transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-6",
        needed && "bg-info-soft/60",
        dimmed && "opacity-70",
      )}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-mono text-sm font-medium [overflow-wrap:anywhere]">{account.accountId}</span>
        <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">{account.role}</span>
        {needed && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">Needed here</span>}
        {isCurrent && !needed && <span className="text-xs text-muted-foreground">Last used</span>}
      </span>
      <span className="text-[0.8125rem] text-muted-foreground">{account.does}</span>
      <span className="num text-xs text-muted-foreground">
        {formatMoney(account.balances.usdc)} USDC (mock) and {nearText(account.balances.near)}
      </span>
    </button>
  );
}
