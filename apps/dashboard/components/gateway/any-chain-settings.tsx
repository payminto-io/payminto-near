"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Circle, CircleAlert, CircleHelp, Globe, Info, LoaderCircle, PenLine, RotateCw, Wallet, XCircle } from "lucide-react";
import { intentsPayoutProofRequest, isAccountId, type AccountId } from "@payminto/protocol";
import { CHECKOUT_ORIGINS } from "@payminto/near-addons/intents";
import { useApi, useCan } from "@/lib/session";
import { gk } from "@/lib/gateway-queries";
import { ok } from "@/lib/operator-queries";
import { ApiError } from "@/lib/http";
import {
  destinationVerifyNote,
  enableErrorText,
  evmPayoutMessage,
  isEvmAddress,
  isNearDestination,
  mainnetTxUrl,
  payoutChecklist,
  receiveOptions,
  shortAddress,
  type CheckState,
} from "@/lib/intents";
import { evmWalletErrorMessage, personalSign, requestEvmAccounts } from "@/lib/evm-wallet";
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
import type { IntentsDestinationOption, IntentsPayout } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
export async function signPayoutProof(o: {
  live: boolean;
  merchantId: string;
  account: AccountId;
  timestamp: number;
  scope: { settlementNetwork: string; hub: AccountId };
  /** The mainnet wallet is already connected as `account` (its own click did it), so this click only signs. */
  connected?: boolean;
}): Promise<Nep413Proof> {
  const req = intentsPayoutProofRequest(o.merchantId, o.account, o.timestamp, o.scope);
  if (!o.live) return signMessage(req.message, req.recipient, o.account, req.nonce);
  if (!o.connected) await connectMainnet(o.account);
  return signMessageOnMainnet(req.message, req.recipient, o.account, req.nonce);
}

/** How long the page waits for a wallet window before it says so; a blocked or closed window never answers. */
export const WALLET_TIMEOUT_MS = 120_000;

class WalletSilent extends Error {}

function withinTime<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new WalletSilent()), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });
}

const SILENT_TEXT =
  "Your wallet did not answer. Look for its window (it may be behind this one, or your browser may have blocked the pop-up for this site), then try again.";

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
  // "Receive as": where the money goes now, until the business picks another destination to set up.
  const [receive, setReceive] = useState(isNearDestination(p.destination) ? "near" : p.destination!.chain);
  const choices = receiveOptions(p.destinations);
  const chosen = choices.find((d) => d.chain === receive) ?? choices[0]!;
  const nearChosen = chosen.chain === "near";
  // The account is set but the money goes elsewhere now: going back to NEAR is proven again.
  const nearActive = isNearDestination(p.destination);
  const saved = (next: IntentsPayout) => {
    qc.setQueryData(payoutKey, next);
    // The save answers with the checks it ran; read them all again so none shows as not read.
    void qc.invalidateQueries({ queryKey: payoutKey });
    setEditing(false);
    setToggleError(null);
  };
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
      description="Customers pay with USDC, USDT or ETH from Base, Ethereum, Arbitrum, Solana or Polygon. They pay the swap cost, and the full amount arrives in your own account: USDC on NEAR, or the chain you choose below."
      actions={p.mode !== "off" && <IntentsLabel mode={p.mode} label={p.label ?? undefined} />}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg border p-3 sm:p-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="m-oneclick-any" className="text-sm font-medium">
              Accept any chain (NEAR Intents)
            </label>
            <p className="text-xs text-muted-foreground">{p.enabled ? "On: the checkout shows an Any chain tab next to the NEAR wallet." : p.verified ? "Where you receive passed every check. Turn this on to show it at checkout." : "Set up where you receive below first."}</p>
          </div>
          <Switch id="m-oneclick-any" checked={p.enabled} disabled={!canToggle || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-describedby={toggleError ? "m-oneclick-error" : undefined} />
        </div>
        {toggleError && (
          <p id="m-oneclick-error" role="alert" className="-mt-3 flex items-start gap-2 text-sm text-negative">
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {toggleError}
          </p>
        )}

        <DefaultOriginField p={p} onSaved={(next) => qc.setQueryData(payoutKey, next)} disabled={!canToggle} />

        <ReceiveAs p={p} value={chosen.chain} onChange={setReceive} disabled={!canPayout} />

        {nearChosen ? (
          <>
            {live && <MainnetConnection />}

            <section aria-labelledby="any-account" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="any-account" className="text-sm font-medium">
                  Your {network} account
                </h3>
                {p.account && canPayout && !editing && nearActive && (
                  <Button size="sm" variant="outline" className="h-11 md:h-8" onClick={() => setEditing(true)}>
                    Change account
                  </Button>
                )}
              </div>
              {!nearActive && p.destination && (
                <p className="text-sm text-muted-foreground">
                  Payments now arrive as {p.destination.symbol} on {p.destination.chain_name}. Sign with your NEAR account to receive USDC on NEAR again.
                </p>
              )}
              {p.account && !editing && nearActive ? (
                <Address address={p.account} showName={false} explorer={false} className="text-sm" />
              ) : canPayout ? (
                <AccountForm p={p} merchantId={merchantId} onSaved={saved} onCancel={p.account && nearActive ? () => setEditing(false) : null} />
              ) : (
                <p className="text-sm text-muted-foreground">Not set. Someone with permission to change payouts sets it.</p>
              )}
            </section>

            <section aria-labelledby="any-checks" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="any-checks" className="text-sm font-medium">
                  Checks
                </h3>
                <Button size="sm" variant="ghost" className="h-11 md:h-8" onClick={refetch} disabled={refreshing || !p.account}>
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
          </>
        ) : (
          <EvmDestination key={chosen.chain} p={p} merchantId={merchantId} destination={chosen} canPayout={canPayout} onSaved={saved} />
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
            "No mainnet wallet is connected yet; connect it below, then sign. The rest of this dashboard keeps its own wallet."
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
export function AccountForm({
  p,
  merchantId,
  onSaved,
  onCancel,
  walletTimeoutMs = WALLET_TIMEOUT_MS,
}: {
  p: IntentsPayout;
  merchantId: string;
  onSaved: (p: IntentsPayout) => void;
  onCancel: (() => void) | null;
  walletTimeoutMs?: number;
}) {
  const api = useApi();
  // Live: the NEAR mainnet account the wallet already shared with this page. Connecting and signing are two clicks, so
  // each wallet window opens from a click; a browser blocks a second window opened after the first one returns.
  const [mainnet, setMainnet] = useState<AccountId | null>(null);
  useEffect(() => {
    if (p.mode !== "live") return;
    let on = true;
    void mainnetAccount().then((a) => on && setMainnet(a));
    const off = subscribeMainnet((a) => on && setMainnet(a));
    return () => {
      on = false;
      off();
    };
  }, [p.mode]);
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
  const needsConnect = live && target !== null && mainnet !== target;
  async function connect() {
    setError(null);
    if (!target) return;
    setBusy(true);
    try {
      setMainnet(await withinTime(connectMainnet(target), walletTimeoutMs));
    } catch (e) {
      setError(e instanceof WalletSilent ? SILENT_TEXT : walletErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function sign() {
    setError(null);
    if (!target) return;
    setBusy(true);
    try {
      const timestamp = unixNow();
      setStamp(timestamp);
      const signed = await withinTime(signPayoutProof({ live, merchantId, account: target, timestamp, scope, connected: live }), walletTimeoutMs);
      setProof({ account: target, timestamp, public_key: signed.publicKey, signature: signed.signature });
    } catch (e) {
      setError(e instanceof WalletSilent ? SILENT_TEXT : walletErrorMessage(e));
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
        {!proof && needsConnect ? (
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void connect()} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Wallet aria-hidden />}
            {`Connect ${target}`}
          </Button>
        ) : !proof ? (
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void sign()} disabled={busy || !target}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
            {live ? "Sign the message" : "Sign with this account"}
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

// ---------------------------------------------------------------------------
// The token customers see first
// ---------------------------------------------------------------------------

const NO_DEFAULT = "none";

/** "Token customers see first": the origin the checkout opens with, saved at once (`PATCH`). */
export function DefaultOriginField({ p, onSaved, disabled = false }: { p: IntentsPayout; onSaved: (next: IntentsPayout) => void; disabled?: boolean }) {
  const api = useApi();
  const save = useMutation({
    mutationFn: (value: string | null) => api.gateway.setIntentsDefaultOrigin(value),
    onSuccess: (next) => {
      const o = CHECKOUT_ORIGINS.find((x) => x.assetId === next.default_origin);
      toast.success(o ? `Customers see ${o.symbol} on ${o.chainName} first.` : "Customers see the tokens in the usual order.");
      onSaved(next);
    },
    onError: (e) => toast.error(e.message),
  });
  const value = (save.isPending ? save.variables : p.default_origin) ?? NO_DEFAULT;
  return (
    <FormRow id="any-default-origin" label="Token customers see first" hint="The checkout opens with it selected, when a payment can be paid with it. Customers can still pick another.">
      <Select value={value} onValueChange={(v) => save.mutate(v === NO_DEFAULT ? null : v)} disabled={disabled || save.isPending}>
        <SelectTrigger id="any-default-origin" className="h-11 w-full sm:max-w-xs md:h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT}>No preference</SelectItem>
          {CHECKOUT_ORIGINS.map((o) => (
            <SelectItem key={o.assetId} value={o.assetId}>
              {`${o.symbol} on ${o.chainName}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormRow>
  );
}

// ---------------------------------------------------------------------------
// Receive as
// ---------------------------------------------------------------------------

/** "Receive as": USDC on NEAR first, then the EVM chains the server delivers to, each saying how it is confirmed. */
export function ReceiveAs({ p, value, onChange, disabled = false }: { p: IntentsPayout; value: string; onChange: (chain: string) => void; disabled?: boolean }) {
  const choices = receiveOptions(p.destinations);
  const current = isNearDestination(p.destination) ? "near" : p.destination!.chain;
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">Receive as</legend>
      <p className="mt-0.5 text-xs text-muted-foreground">Where the money of a payment from another chain arrives. You prove the account or address is yours before it is used.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {choices.map((d) => {
          const name = `${d.symbol} on ${d.chain_name}`;
          const note = destinationVerifyNote(d);
          const hintId = `any-receive-${d.chain}-hint`;
          return (
            <label
              key={d.chain}
              className={cn(
                "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-sm transition-colors duration-150 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
                value === d.chain ? "border-primary bg-info-soft" : "hover:bg-muted/40",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input type="radio" name="any-receive" value={d.chain} checked={value === d.chain} disabled={disabled} onChange={() => onChange(d.chain)} aria-label={name} aria-describedby={hintId} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 font-medium">
                  {name}
                  {current === d.chain && <span className="text-xs font-normal text-muted-foreground">Now</span>}
                </span>
                <span id={hintId} className="mt-0.5 block text-xs text-pretty text-muted-foreground">
                  {d.chain === "near" ? "Delivered to your NEAR account and read on NEAR by this server." : (note ?? `Delivered to your address on ${d.chain_name} and read there by this server.`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** An EVM destination: the saved address and its proof, or the form that sets it. */
function EvmDestination({ p, merchantId, destination, canPayout, onSaved }: { p: IntentsPayout; merchantId: string; destination: IntentsDestinationOption; canPayout: boolean; onSaved: (next: IntentsPayout) => void }) {
  const current = p.destination && p.destination.chain === destination.chain ? p.destination : null;
  const [editing, setEditing] = useState(current === null);
  const note = destinationVerifyNote(destination);
  return (
    <section aria-labelledby="any-evm" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="any-evm" className="text-sm font-medium">
          Your address on {destination.chain_name}
        </h3>
        {current && canPayout && !editing && (
          <Button size="sm" variant="outline" className="h-11 md:h-8" onClick={() => setEditing(true)}>
            Change address
          </Button>
        )}
      </div>
      {current && !editing ? (
        <>
          <p className="hash text-sm [overflow-wrap:anywhere]">{current.address}</p>
          <p className="flex items-start gap-2 text-sm">
            {current.proven ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />}
            <span>
              {current.proven ? "Proven yours with a signed message." : "Not proven yet. Sign the message to use it."}{" "}
              <span className="text-muted-foreground">
                Payments arrive as {current.symbol} on {current.chain_name}.
              </span>
            </span>
          </p>
          {note && <VerifyNote text={note} />}
        </>
      ) : canPayout ? (
        <EvmPayoutForm
          p={p}
          merchantId={merchantId}
          destination={destination}
          onSaved={(next) => {
            setEditing(false);
            onSaved(next);
          }}
          onCancel={current ? () => setEditing(false) : null}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Not set. Someone with permission to change payouts sets it.</p>
      )}
    </section>
  );
}

function VerifyNote({ text }: { text: string }) {
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
      <Info className="mt-px size-3.5 shrink-0" aria-hidden /> {text}
    </p>
  );
}

/**
 * An EVM payout address and its EIP-191 proof, then the save (with a fresh password check). Connecting and signing are
 * two clicks, so each wallet window opens from a click of its own.
 */
export function EvmPayoutForm({
  p,
  merchantId,
  destination,
  onSaved,
  onCancel,
  walletTimeoutMs = WALLET_TIMEOUT_MS,
}: {
  p: IntentsPayout;
  merchantId: string;
  destination: IntentsDestinationOption;
  onSaved: (p: IntentsPayout) => void;
  onCancel: (() => void) | null;
  walletTimeoutMs?: number;
}) {
  const api = useApi();
  const [address, setAddress] = useState("");
  const [connected, setConnected] = useState<string | null>(null);
  const [proof, setProof] = useState<{ address: string; timestamp: number; signature: string } | null>(null);
  const [stamp, setStamp] = useState(unixNow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = isEvmAddress(address) ? address.trim().toLowerCase() : null;
  const hub = p.proof_scope.hub;
  const message = evmPayoutMessage(merchantId, target ?? "{address}", proof?.timestamp ?? stamp, destination.chain, hub);
  const note = destinationVerifyNote(destination);
  const save = useMutation({
    mutationFn: () => api.gateway.setIntentsPayout({ destination_chain: destination.chain, address: proof!.address, proof: { type: "eip191", timestamp: proof!.timestamp, signature: proof!.signature } }),
    onSuccess: (next) => {
      toast.success(`Payments from other chains now arrive as ${destination.symbol} on ${destination.chain_name}.`);
      onSaved(next);
    },
    onError: (e) => setError(e.message),
  });

  const fail = (e: unknown) => setError(e instanceof WalletSilent ? SILENT_TEXT : evmWalletErrorMessage(e));
  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const accounts = await withinTime(requestEvmAccounts(), walletTimeoutMs);
      if (accounts.length === 0) throw new Error("Your wallet shared no address with this page.");
      if (!target) {
        // Nothing typed yet: the wallet's address is the one to prove.
        setAddress(accounts[0]!);
        setConnected(accounts[0]!);
      } else if (accounts.includes(target)) {
        setConnected(target);
      } else {
        setError(`Your wallet is connected as ${shortAddress(accounts[0]!)}, not ${shortAddress(target)}. Switch to that address in your wallet, then connect again.`);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function sign() {
    setError(null);
    if (!target) return;
    setBusy(true);
    try {
      const timestamp = unixNow();
      setStamp(timestamp);
      const text = evmPayoutMessage(merchantId, target, timestamp, destination.chain, hub);
      if (!text) throw new Error(`${destination.chain_name} is not an EVM chain this page can sign for.`);
      const signature = await withinTime(personalSign(text, target), walletTimeoutMs);
      setProof({ address: target, timestamp, signature });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const ready = target !== null && connected === target;
  return (
    <div className="flex flex-col gap-3">
      <FormRow
        id="any-evm-address"
        label={`Your address on ${destination.chain_name}`}
        hint={`An address your browser wallet holds. ${destination.symbol} arrives there on ${destination.chain_name}.`}
        error={address && !target ? "Enter an address: 0x followed by 40 characters, 0 to 9 and a to f." : null}
      >
        <Input
          id="any-evm-address"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setConnected(null);
            setProof(null);
            setError(null);
          }}
          placeholder="0x..."
          className="hash h-11 text-base md:h-9 md:text-[0.8125rem]"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
        />
      </FormRow>
      {note && <VerifyNote text={note} />}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-xs font-medium text-muted-foreground">Message the address signs (EIP-191, for this server only)</p>
        <p className="hash mt-1 text-[0.8125rem] [overflow-wrap:anywhere]">{message}</p>
      </div>
      {proof ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-positive" role="status">
          <CheckCircle2 className="size-4" aria-hidden /> Signed by <span className="hash text-foreground [overflow-wrap:anywhere]">{proof.address}</span>
        </p>
      ) : connected ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status">
          <Wallet className="size-4" aria-hidden /> Connected as <span className="hash text-foreground">{shortAddress(connected)}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!proof && !ready ? (
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void connect()} disabled={busy || (address.trim() !== "" && !target)}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Wallet aria-hidden />}
            Connect wallet
          </Button>
        ) : !proof ? (
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void sign()} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
            Sign the message
          </Button>
        ) : (
          <Button type="button" className="h-11 md:h-9" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
            Save address
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
