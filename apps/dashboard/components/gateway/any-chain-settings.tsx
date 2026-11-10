"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Circle, CircleAlert, CircleHelp, Globe, LoaderCircle, PenLine, RotateCw, XCircle } from "lucide-react";
import { intentsPayoutProofRequest, isAccountId, type AccountId } from "@payminto/protocol";
import { useApi, useCan } from "@/lib/session";
import { gk } from "@/lib/gateway-queries";
import { ok } from "@/lib/operator-queries";
import { ApiError } from "@/lib/http";
import { enableErrorText, mainnetTxUrl, payoutChecklist, type CheckState } from "@/lib/intents";
import {
  connectMainnet,
  disconnectMainnet,
  MAINNET_LABEL,
  mainnetAccount,
  sendOnMainnet,
  signMessage,
  signMessageOnMainnet,
  subscribeMainnet,
  walletErrorMessage,
  type Nep413Proof,
} from "@/lib/wallet";
import type { IntentsPayout } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Address, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { TxFlowProvider, useTxFlow, type TxPlan } from "@/components/ds/tx-flow";
import { IntentsLabel } from "@/components/checkout/intents";
import { FormRow } from "./kit";

const payoutKey = [...gk.all, "intents-payout"] as const;
const unixNow = () => Math.floor(Date.now() / 1000);

/**
 * Signs the any-chain payout proof. Live (the USDC lands on NEAR mainnet): with the separate NEAR mainnet connection,
 * opened for this account only. Simulated: with the dashboard's own wallet, where the local chain stands in for mainnet.
 */
export async function signPayoutProof(o: { live: boolean; merchantId: string; account: AccountId; timestamp: number; scope: { settlementNetwork: string; hub: AccountId } }): Promise<Nep413Proof> {
  const req = intentsPayoutProofRequest(o.merchantId, o.account, o.timestamp, o.scope);
  if (!o.live) return signMessage(req.message, req.recipient, o.account, req.nonce);
  await connectMainnet(o.account);
  return signMessageOnMainnet(req.message, req.recipient, o.account, req.nonce);
}

/**
 * The storage deposit as a reviewed transaction: the exact call, its deposit and gas, and who signs it, before any
 * wallet opens. Live, it goes through the NEAR mainnet connection and links to NearBlocks.
 */
export function storagePlan(p: IntentsPayout, account: AccountId): TxPlan {
  const step = p.storage_step!;
  const live = p.mode === "live";
  return {
    title: `Register ${account} with USDC`,
    description: live
      ? `${step.why} It is sent on ${MAINNET_LABEL} from your own wallet; the rest of this dashboard keeps its own connection.`
      : step.why,
    summary: [{ label: "Deposit", value: <span className="num">{step.deposit_near} NEAR, once</span> }],
    txs: [step.transaction],
    confirmLabel: live ? `Open my ${MAINNET_LABEL} wallet` : "Send the storage deposit",
    signer: account,
    finalNote: `${account} is registered with USDC. The checks are read again now.`,
    ...(live
      ? {
          wallet: {
            label: MAINNET_LABEL,
            connect: (signer?: AccountId) => connectMainnet(signer ?? account),
            send: async (txs) => [await sendOnMainnet(txs[0]!, account)],
            explorerTx: mainnetTxUrl,
          },
        }
      : {}),
  };
}

/**
 * Settings > Payment methods: "Accept any chain (NEAR Intents)". The USDC of an any-chain payment lands straight in the
 * business's own NEAR account, so that account is set first and passes three checks the server reads now: it exists,
 * it is registered with USDC, and it signed a message bound to this server (NEP-413, like a payout change). Then the
 * method can be turned on; the server refuses it until then, and the page says why.
 */
export function AnyChainSettings({ merchantId }: { merchantId: string }) {
  const api = useApi();
  const can = useCan();
  const q = useQuery({ queryKey: payoutKey, queryFn: () => api.gateway.intentsPayout(), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1 });
  if (q.isPending) return <BlockSkeleton className="mt-5 h-72" />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.code === "INTENTS_CHECKOUT_OFF") {
      return (
        <Panel className="mt-5" title="Accept any chain (NEAR Intents)" description="Customers pay from another chain and USDC arrives in your NEAR account.">
          <p className="text-sm text-muted-foreground">This Payminto server does not run the any-chain checkout. The operator turns it on with INTENTS_CHECKOUT.</p>
        </Panel>
      );
    }
    return <ErrorState className="mt-5" error={q.error} onRetry={() => void q.refetch()} />;
  }
  // The storage deposit's flow lives here, so its outcome stays on screen after the step it came from is gone.
  return (
    <TxFlowProvider>
      <Settings merchantId={merchantId} p={q.data} refetch={() => void q.refetch()} refreshing={q.isFetching} canPayout={can("payout.change")} canToggle={can("business.update")} />
    </TxFlowProvider>
  );
}

function Settings({ merchantId, p, refetch, refreshing, canPayout, canToggle }: { merchantId: string; p: IntentsPayout; refetch: () => void; refreshing: boolean; canPayout: boolean; canToggle: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(p.account === null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const live = p.mode === "live";
  const network = live ? "NEAR mainnet" : "NEAR (simulated mainnet)";
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.operator.setMethodsEnabled(merchantId, [{ method: "oneclick", enabled }]),
    onSuccess: (_rows, enabled) => {
      setToggleError(null);
      toast.success(enabled ? "Customers can now pay from other chains." : "Payments from other chains are off. Open deposit addresses still finish.");
      void qc.invalidateQueries({ queryKey: payoutKey });
      void qc.invalidateQueries({ queryKey: ok.methods(merchantId) });
    },
    onError: (e) => setToggleError(e instanceof ApiError ? enableErrorText(e.code, e.message) : e.message),
  });
  const checks = payoutChecklist(p);
  return (
    <Panel
      className="mt-5"
      title="Accept any chain (NEAR Intents)"
      description="Customers pay with USDC, USDT or ETH from Base, Ethereum, Arbitrum, Solana or Polygon. They pay the swap cost, and the full amount arrives as USDC in your own NEAR account."
      actions={p.mode !== "off" && <IntentsLabel mode={p.mode} label={p.label ?? undefined} />}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg border p-3 sm:p-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="m-oneclick-any" className="text-sm font-medium">
              Accept any chain (NEAR Intents)
            </label>
            <p className="text-xs text-muted-foreground">{p.enabled ? "On: the checkout shows an Any chain tab next to the NEAR wallet." : p.verified ? "Your account passed every check. Turn this on to show it at checkout." : "Set up your NEAR account below first."}</p>
          </div>
          <Switch id="m-oneclick-any" checked={p.enabled} disabled={!canToggle || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-describedby={toggleError ? "m-oneclick-error" : undefined} />
        </div>
        {toggleError && (
          <p id="m-oneclick-error" role="alert" className="-mt-3 flex items-start gap-2 text-sm text-negative">
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {toggleError}
          </p>
        )}

        {live && <MainnetConnection />}

        <section aria-labelledby="any-account" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="any-account" className="text-sm font-medium">
              Your {network} account
            </h3>
            {p.account && canPayout && !editing && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Change account
              </Button>
            )}
          </div>
          {p.account && !editing ? (
            <Address address={p.account} showName={false} explorer={false} className="text-sm" />
          ) : canPayout ? (
            <AccountForm
              p={p}
              merchantId={merchantId}
              onSaved={(next) => {
                qc.setQueryData(payoutKey, next);
                // The save answers with the checks it ran; read all three again so none shows as not read.
                void qc.invalidateQueries({ queryKey: payoutKey });
                setEditing(false);
                setToggleError(null);
              }}
              onCancel={p.account ? () => setEditing(false) : null}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Not set. Someone with permission to change payouts sets it.</p>
          )}
        </section>

        <section aria-labelledby="any-checks" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="any-checks" className="text-sm font-medium">
              Checks
            </h3>
            <Button size="sm" variant="ghost" onClick={refetch} disabled={refreshing || !p.account}>
              <RotateCw className={cn(refreshing && "animate-spin")} aria-hidden /> Check again
            </Button>
          </div>
          <ul className="divide-y rounded-lg border">
            {checks.map((c) => (
              <li key={c.key} className="flex items-start gap-3 px-3 py-2.5">
                <CheckIcon state={c.state} />
                <span className="min-w-0">
                  <span className="block text-sm">{c.label}</span>
                  <span className="block text-xs text-muted-foreground">{c.hint}</span>
                </span>
                <span className="sr-only">{c.state === "done" ? "passed" : c.state === "failed" ? "failed" : c.state === "unknown" ? "not read" : "to do"}</span>
              </li>
            ))}
          </ul>
        </section>

        {p.storage_step && p.account && (
          <StorageStep
            p={p}
            account={p.account}
            onDone={() => {
              setToggleError(null);
              refetch();
            }}
          />
        )}
      </div>
    </Panel>
  );
}

/**
 * Live mode only: the second wallet connection, on NEAR mainnet, said plainly. It signs two things on this page (the
 * proof and the storage deposit) and nothing else; the dashboard's own connection stays as it is.
 */
export function MainnetConnection() {
  const [account, setAccount] = useState<AccountId | null>(null);
  useEffect(() => {
    let live = true;
    void mainnetAccount().then((a) => live && setAccount(a));
    // Signing on this page connects it; the note follows.
    const off = subscribeMainnet((a) => live && setAccount(a));
    return () => {
      live = false;
      off();
    };
  }, []);
  return (
    <div role="note" aria-label={`${MAINNET_LABEL} wallet`} className="flex flex-col gap-2 rounded-lg border bg-info-soft/50 p-3 sm:flex-row sm:items-start sm:gap-3 sm:p-4">
      <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs font-medium">
        <Globe className="size-3.5" aria-hidden /> {MAINNET_LABEL}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p>Real money. Signing here opens a separate {MAINNET_LABEL} wallet connection, for two steps only: the message that proves the account is yours, and its USDC storage deposit.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {account ? (
            <>
              Connected on {MAINNET_LABEL} as <span className="hash text-foreground">{account}</span>.{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void disconnectMainnet()}>
                Disconnect
              </button>
            </>
          ) : (
            "No mainnet wallet is connected yet; it opens when you sign. The rest of this dashboard keeps its own wallet."
          )}
        </p>
      </div>
    </div>
  );
}

function CheckIcon({ state }: { state: CheckState }) {
  const cls = "mt-0.5 size-4 shrink-0";
  if (state === "done") return <CheckCircle2 className={cn(cls, "text-positive")} aria-hidden />;
  if (state === "failed") return <CircleAlert className={cn(cls, "text-warning")} aria-hidden />;
  if (state === "unknown") return <CircleHelp className={cn(cls, "text-muted-foreground")} aria-hidden />;
  return <Circle className={cn(cls, "text-subtle")} aria-hidden />;
}

/** The account and the NEP-413 message it signs for this server, then the save (with a fresh password check). */
function AccountForm({ p, merchantId, onSaved, onCancel }: { p: IntentsPayout; merchantId: string; onSaved: (p: IntentsPayout) => void; onCancel: (() => void) | null }) {
  const api = useApi();
  const [account, setAccount] = useState("");
  const [proof, setProof] = useState<{ account: AccountId; timestamp: number; public_key: string; signature: string } | null>(null);
  const [stamp, setStamp] = useState(unixNow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = isAccountId(account.trim()) ? (account.trim() as AccountId) : null;
  const scope = { settlementNetwork: p.proof_scope.settlement_network, hub: p.proof_scope.hub };
  const message = intentsPayoutProofRequest(merchantId, target ?? ("{account}" as AccountId), proof?.timestamp ?? stamp, scope).message;
  const save = useMutation({
    mutationFn: () => api.gateway.setIntentsPayout({ account: proof!.account, proof: { timestamp: proof!.timestamp, public_key: proof!.public_key, signature: proof!.signature } }),
    onSuccess: (next) => {
      toast.success(next.verified ? `${next.account} passed every check.` : `${next.account} is saved. ${next.checks.usdc_registered === false ? "One step is left: register it with USDC." : "Check the list below."}`);
      onSaved(next);
    },
    onError: (e) => setError(e.message),
  });

  const live = p.mode === "live";
  async function sign() {
    setError(null);
    if (!target) return;
    setBusy(true);
    try {
      const timestamp = unixNow();
      setStamp(timestamp);
      const signed = await signPayoutProof({ live, merchantId, account: target, timestamp, scope });
      setProof({ account: target, timestamp, public_key: signed.publicKey, signature: signed.signature });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FormRow
        id="any-account-input"
        label="NEAR account"
        hint={p.mode === "live" ? "A NEAR mainnet account you control, for example northwind.near. Your wallet must hold it on mainnet." : "On this simulated setup the local chain stands in for NEAR mainnet."}
        error={account && !target ? "Enter a NEAR account, such as northwind.near." : null}
      >
        <Input
          id="any-account-input"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setProof(null);
            setError(null);
          }}
          placeholder="business.near"
          className="hash h-11 text-base md:h-9 md:text-[0.8125rem]"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
        />
      </FormRow>
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-xs font-medium text-muted-foreground">Message the account signs{live ? ` on ${MAINNET_LABEL}` : ""} (NEP-413, for this server only)</p>
        <p className="hash mt-1 text-[0.8125rem] [overflow-wrap:anywhere]">{message}</p>
      </div>
      {proof ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-positive" role="status">
          <CheckCircle2 className="size-4" aria-hidden /> Signed by <span className="hash text-foreground">{proof.account}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!proof ? (
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void sign()} disabled={busy || !target}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
            {live ? `Sign with a ${MAINNET_LABEL} wallet` : "Sign with this account"}
          </Button>
        ) : (
          <Button type="button" className="h-11 md:h-9" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
            Save and check account
          </Button>
        )}
        {onCancel && (
          <Button type="button" variant="ghost" className="h-11 md:h-9" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-negative">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}

/**
 * The one human step when the account is not registered with USDC: a storage_deposit it sends itself, reviewed in full
 * before the wallet opens.
 */
export function StorageStep({ p, account, onDone }: { p: IntentsPayout; account: AccountId; onDone: () => void }) {
  const step = p.storage_step!;
  const call = step.transaction.actions[0]!;
  const live = p.mode === "live";
  const { open, flow } = useTxFlow();
  return (
    <section aria-labelledby="any-storage" className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning-soft/40 p-3 sm:p-4">
      <h3 id="any-storage" className="text-sm font-medium">
        One step left: register {account} with USDC
      </h3>
      <p className="text-sm text-muted-foreground">{step.why}</p>
      <dl className="grid gap-1.5 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
        {live && (
          <>
            <dt className="text-muted-foreground">Network</dt>
            <dd className="font-medium">{MAINNET_LABEL}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Sent from</dt>
        <dd className="hash min-w-0 [overflow-wrap:anywhere]">{account}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="hash min-w-0 [overflow-wrap:anywhere]">{step.transaction.receiverId}</dd>
        <dt className="text-muted-foreground">Call</dt>
        <dd className="hash">{call.params.methodName}</dd>
        <dt className="text-muted-foreground">Deposit</dt>
        <dd className="num">{step.deposit_near} NEAR, once</dd>
      </dl>
      <div>
        <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => open(storagePlan(p, account), () => onDone())}>
          Review the storage deposit
        </Button>
      </div>
      {flow}
    </section>
  );
}
